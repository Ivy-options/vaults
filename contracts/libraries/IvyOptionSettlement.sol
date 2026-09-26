// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyPayoutReceiver } from "../interfaces/IIvyPayoutReceiver.sol";
import { IIvyShares } from "../interfaces/IIvyShares.sol";
import { IIvyVault } from "../interfaces/IIvyVault.sol";
import { IIvyVaultsHubEvents } from "../interfaces/IIvyVaultsHubEvents.sol";
import "../types/IvyTypes.sol";
import { IvyMath } from "./IvyMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Exercise, expiry settlement, and LP claims for the Hub.
/// @dev Runs by DELEGATECALL in Hub storage. The Hub checks phases, guards payments against reentrancy,
///      and restricts price writes to publishers.
library IvyOptionSettlement {
	/// @dev Stores per-vault observations in Hub storage.
	function publishExercisePrice(
		SettlementPrices storage prices,
		uint256 vaultId,
		address underlying,
		address quote,
		uint256 price,
		uint64 observedAt,
		uint64 validUntil
	) external {
		_validateReport(price, validUntil);
		if (observedAt == 0 || observedAt > block.timestamp || observedAt <= prices.exercise.observedAt) revert InvalidPrice();
		prices.exercise = ExercisePriceObservation(price, observedAt, validUntil);
		emit IIvyVaultsHubEvents.ExercisePricePublished(vaultId, underlying, quote, price, observedAt, validUntil);
	}

	/// @dev Once stored, an expiry price cannot be replaced, even if publisher roles change.
	function publishExpiry(
		SettlementPrices storage prices,
		uint256 vaultId,
		address underlying,
		address quote,
		uint64 expiry,
		uint64 publicationWindow,
		uint256 price,
		uint64 validUntil
	) external {
		_validateReport(price, validUntil);
		if (expiry == 0 || block.timestamp < expiry) revert ExpirationNotReached();
		if (block.timestamp >= uint256(expiry) + publicationWindow) revert ExpiryPricePublicationClosed();
		if (prices.expiry != 0) revert ReportFinalized();
		prices.expiry = price;
		emit IIvyVaultsHubEvents.ExpiryPublished(vaultId, underlying, quote, expiry, price, validUntil);
	}

	function exercise(
		VaultState storage state,
		VaultTerms storage terms,
		SettlementPrices storage prices,
		uint256 vaultId,
		uint256 amount,
		bool physicalFallback
	) external {
		if (msg.sender != state.marketMaker && msg.sender != state.executor) revert NotExecutor();
		if (amount == 0) revert ZeroAmount();
		uint256 remaining = state.totalNotional - state.exercisedNotional;
		if (amount > remaining) revert ExceedsRemaining(remaining);
		if (!terms.allowPartialExercise && amount != remaining) revert PartialExerciseNotAllowed();
		if (physicalFallback) {
			uint256 deadline = uint256(state.expiry) + state.expiryPricePublicationWindow;
			if (state.settlement != SettlementType.Cash || prices.expiry != 0 || block.timestamp < deadline) revert PhysicalFallbackUnavailable();
			if (block.timestamp >= deadline + state.exerciseWindow) revert ExerciseWindowClosed();
		} else {
			_checkExerciseWindow(state);
		}

		state.exercisedNotional += amount;

		IIvyVault vault = IIvyVault(state.vault);
		uint256 paid;
		uint256 got;
		if (state.settlement == SettlementType.Physical || physicalFallback) {
			(address payToken, uint256 payAmount) = state.isCall
				? (state.quoteToken, IvyMath.strikeValueRoundedUp(amount, state.strike, state.underlyingUnit))
				: (terms.underlying, amount);
			uint256 received = vault.pull(payToken, msg.sender, payAmount);
			if (received < payAmount) revert ShortReceived(payAmount, received);
			paid = payAmount;
			got = state.isCall ? amount : IvyMath.strikeValueRoundedDown(amount, state.strike, state.underlyingUnit);
		} else {
			uint256 spot = block.timestamp < state.expiry ? _readExercisePrice(terms, prices) : _readExpiryPrice(prices);
			got =
				state.isCall
					? IvyMath.callIntrinsic(amount, state.strike, spot)
					: IvyMath.putIntrinsic(amount, state.strike, spot, state.underlyingUnit);
			if (got == 0) revert NothingToExercise();
		}
		address recipient = state.recipient;
		vault.push(terms.collateral, recipient, got);
		emit IIvyVaultsHubEvents.Exercised(vaultId, amount, paid, got);
		if (physicalFallback) emit IIvyVaultsHubEvents.PhysicalFallbackExercised(vaultId, amount, paid, got);
		if (amount == remaining) _finalize(state, vaultId);
		_notifyRecipient(vaultId, recipient, terms.collateral, got);
	}

	function settleAtExpiry(VaultState storage state, VaultTerms storage terms, SettlementPrices storage prices, uint256 vaultId) external {
		if (block.timestamp < settleAtExpiryTime(state, prices)) revert TooEarlyToSettle();
		uint256 remaining = state.totalNotional - state.exercisedNotional;
		if (state.settlement == SettlementType.Cash && prices.expiry == 0) emit IIvyVaultsHubEvents.PhysicalFallbackExpired(vaultId, remaining);
		if (state.settlement == SettlementType.Cash && remaining > 0 && prices.expiry != 0) {
			uint256 spot = _readExpiryPrice(prices);
			uint256 payout =
				state.isCall
					? IvyMath.callIntrinsic(remaining, state.strike, spot)
					: IvyMath.putIntrinsic(remaining, state.strike, spot, state.underlyingUnit);
			state.pendingPayout += payout;
			IIvyVault(state.vault).reserveBuyer(terms.collateral, payout);
			state.exercisedNotional = state.totalNotional;
		}
		_finalize(state, vaultId);
	}

	/// @dev Pays reserved collateral and premium tokens, then notifies the recipient for each token delivered.
	function claimPayout(VaultState storage state, VaultTerms storage terms, uint256 vaultId) external {
		if (msg.sender != state.marketMaker && msg.sender != state.executor) revert NotExecutor();
		IIvyVault vault = IIvyVault(state.vault);
		address recipient = state.recipient;
		address collateral = terms.collateral;
		address premiumToken = state.premiumToken;
		uint256 collateralAmount = vault.payBuyer(collateral, recipient);
		uint256 premiumAmount = premiumToken == collateral ? 0 : vault.payBuyer(premiumToken, recipient);
		uint256 amount = collateralAmount + premiumAmount;
		if (amount == 0) revert NothingToClaim();
		state.pendingPayout = 0;
		emit IIvyVaultsHubEvents.PayoutClaimed(vaultId, state.marketMaker, amount);
		_notifyRecipient(vaultId, recipient, collateral, collateralAmount);
		_notifyRecipient(vaultId, recipient, premiumToken, premiumAmount);
	}

	function claim(VaultState storage state, VaultTerms storage terms, IIvyShares shareToken, uint256 vaultId, uint256 shares) external {
		if (shares == 0) revert ZeroAmount();
		if (shareToken.balanceOf(msg.sender, vaultId) < shares) revert InsufficientShares();
		uint256 supply = shareToken.totalSupply(vaultId);

		IIvyVault vault = IIvyVault(state.vault);
		address[3] memory tokens = [terms.collateral, state.premiumToken, state.isCall ? state.quoteToken : terms.underlying];
		uint256[3] memory amounts;
		for (uint256 i = 0; i < 3; ++i) {
			if (_seenBefore(tokens, i)) continue;
			uint256 available = IERC20(tokens[i]).balanceOf(address(vault)) - vault.reserved(tokens[i]);
			amounts[i] = (available * shares) / supply;
		}

		shareToken.burn(msg.sender, vaultId, shares);
		for (uint256 i = 0; i < 3; ++i) {
			if (amounts[i] > 0) vault.push(tokens[i], msg.sender, amounts[i]);
		}
	}

	/// @notice Availability is derived from immutable deadlines, even if no fallback transaction has occurred.
	function settlementStatus(
		VaultState storage state,
		SettlementPrices storage prices
	) external view returns (SettlementRoute route, uint256 publicationDeadline, uint256 fallbackDeadline, bool canSettleAtExpiry) {
		publicationDeadline = uint256(state.expiry) + state.expiryPricePublicationWindow;
		fallbackDeadline = publicationDeadline + state.exerciseWindow;
		if (state.phase != Phase.Live) return (SettlementRoute.Inactive, publicationDeadline, fallbackDeadline, false);
		canSettleAtExpiry = block.timestamp >= settleAtExpiryTime(state, prices);
		if (state.settlement == SettlementType.Physical) {
			route = SettlementRoute.Physical;
		} else if (prices.expiry != 0 || block.timestamp < state.expiry) {
			route = SettlementRoute.Cash;
		} else if (block.timestamp < publicationDeadline) {
			route = SettlementRoute.AwaitingExpiryPrice;
		} else {
			route = canSettleAtExpiry ? SettlementRoute.FallbackExpired : SettlementRoute.PhysicalFallback;
		}
	}

	function settleAtExpiryTime(VaultState storage state, SettlementPrices storage prices) public view returns (uint256) {
		if (state.settlement == SettlementType.Cash) {
			return prices.expiry != 0 ? uint256(state.expiry) : uint256(state.expiry) + state.expiryPricePublicationWindow + state.exerciseWindow;
		}
		return uint256(state.expiry) + state.exerciseWindow;
	}

	function _finalize(VaultState storage state, uint256 vaultId) private {
		state.phase = Phase.Settled;
		emit IIvyVaultsHubEvents.Settled(vaultId, state.exercisedNotional, state.totalNotional, state.pendingPayout);
	}

	/// @dev Ignores missing hooks and ordinary reverts; gas exhaustion reverts to avoid silently starving the hook.
	function _notifyRecipient(uint256 vaultId, address recipient, address token, uint256 amount) private {
		if (amount == 0 || recipient.code.length == 0) return;
		bytes memory data = abi.encodeCall(IIvyPayoutReceiver.onIvyPayout, (vaultId, token, amount));
		bytes4 expected = IIvyPayoutReceiver.onIvyPayout.selector;
		uint256 gasBefore = gasleft();
		bool ok;
		bool acknowledged;
		// Copies at most one word of return data so a recipient cannot inflate the caller's memory.
		assembly ("memory-safe") {
			mstore(0, 0)
			ok := call(gas(), recipient, 0, add(data, 0x20), mload(data), 0, 0x20)
			acknowledged := and(ok, and(eq(returndatasize(), 0x20), eq(mload(0), expected)))
		}
		if (!ok && gasleft() < gasBefore / 64) revert PayoutHookOutOfGas();
		emit IIvyVaultsHubEvents.PayoutNotified(vaultId, recipient, token, amount, acknowledged);
	}

	function _validateReport(uint256 price, uint64 validUntil) private view {
		if (price == 0) revert InvalidPrice();
		if (block.timestamp > validUntil) revert BidExpired();
	}

	function _checkExerciseWindow(VaultState storage state) private view {
		uint256 ts = block.timestamp;
		if (state.settlement != SettlementType.Cash && ts >= uint256(state.expiry) + state.exerciseWindow) revert ExerciseWindowClosed();
		if (state.style == ExerciseStyle.European && ts < state.expiry) revert ExerciseNotOpenYet();
	}

	function _readExpiryPrice(SettlementPrices storage prices) private view returns (uint256 price) {
		price = prices.expiry;
		if (price == 0) revert ReportUnavailable();
	}

	function _readExercisePrice(VaultTerms storage terms, SettlementPrices storage prices) private view returns (uint256) {
		ExercisePriceObservation storage observation = prices.exercise;
		if (observation.price == 0) revert InvalidPrice();
		if (block.timestamp - observation.observedAt > terms.maxSettlementPriceAge || block.timestamp > observation.validUntil) revert StalePrice();
		return observation.price;
	}

	function _seenBefore(address[3] memory tokens, uint256 i) private pure returns (bool) {
		for (uint256 j = 0; j < i; ++j) {
			if (tokens[j] == tokens[i]) return true;
		}
		return false;
	}
}
