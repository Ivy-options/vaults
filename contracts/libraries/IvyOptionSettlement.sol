// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IIvyShares} from "../interfaces/IIvyShares.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import {IIvyVaultsHubEvents} from "../interfaces/IIvyVaultsHubEvents.sol";
import "../types/IvyTypes.sol";
import {IvyMath} from "./IvyMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fixed linked exercise, settlement and residual-claim implementation.
/// @dev Payments use phase-checked, nonReentrant Hub entrypoints; publication uses publisher-role guards.
///      DELEGATECALL preserves Hub storage, msg.sender and custody authority. No independent payment route.
library IvyOptionSettlement {
    /// @dev Hub checks publisher authority before delegating here. Observations live in Hub storage.
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
        if (observedAt == 0 || observedAt > block.timestamp || observedAt <= prices.exercise.observedAt) {
            revert InvalidPrice();
        }
        prices.exercise = ExercisePriceObservation(price, observedAt, validUntil);
        emit IIvyVaultsHubEvents.ExercisePricePublished(vaultId, underlying, quote, price, observedAt, validUntil);
    }

    /// @dev Hub checks publisher authority. Revocation does not alter previously finalized prices.
    function publishExpiry(
        SettlementPrices storage prices,
        uint256 vaultId,
        address underlying,
        address quote,
        uint64 expiry,
        uint256 price,
        uint64 validUntil
    ) external {
        _validateReport(price, validUntil);
        if (expiry == 0 || block.timestamp < expiry) {
            revert ExpirationNotReached();
        }
        if (prices.expiry != 0) {
            revert ReportFinalized();
        }
        prices.expiry = price;
        emit IIvyVaultsHubEvents.ExpiryPublished(vaultId, underlying, quote, expiry, price, validUntil);
    }

    function exercise(VaultState storage s, VaultTerms storage t, SettlementPrices storage prices, uint256 amount)
        external
        returns (uint256 paid, uint256 got)
    {
        if (msg.sender != s.marketMaker && msg.sender != s.executor) {
            revert NotExecutor();
        }
        if (amount == 0) {
            revert ZeroAmount();
        }
        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (amount > remaining) {
            revert ExceedsRemaining(remaining);
        }
        if (!t.allowPartialExercise && amount != remaining) {
            revert PartialExerciseNotAllowed();
        }
        _checkExerciseWindow(s);

        s.exercisedNotional += amount;

        IIvyVault vault = IIvyVault(s.vault);
        if (s.settlement == SettlementType.Physical) {
            if (s.isCall) {
                paid = IvyMath.quoteDueCeil(amount, s.strike, s.underlyingUnit);
                uint256 received = vault.pull(s.quoteToken, msg.sender, paid);
                if (received < paid) {
                    revert ShortReceived(paid, received);
                }
                got = amount;
            } else {
                paid = amount;
                uint256 received = vault.pull(t.underlying, msg.sender, amount);
                if (received < amount) {
                    revert ShortReceived(amount, received);
                }
                got = IvyMath.quoteOutFloor(amount, s.strike, s.underlyingUnit);
            }
        } else {
            uint256 spot = block.timestamp < s.expiry ? _readExercisePrice(t, prices) : _readExpiryPrice(prices);
            got = s.isCall
                ? IvyMath.callIntrinsic(amount, s.strike, spot)
                : IvyMath.putIntrinsic(amount, s.strike, spot, s.underlyingUnit);
            if (got == 0) {
                revert NothingToExercise();
            }
        }
        vault.push(t.collateral, s.recipient, got);
    }

    function expire(VaultState storage s, VaultTerms storage t, SettlementPrices storage prices) external {
        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (s.settlement == SettlementType.Cash && remaining > 0) {
            uint256 spot = _readExpiryPrice(prices);
            uint256 payout = s.isCall
                ? IvyMath.callIntrinsic(remaining, s.strike, spot)
                : IvyMath.putIntrinsic(remaining, s.strike, spot, s.underlyingUnit);
            s.pendingPayout += payout;
            IIvyVault(s.vault).reserveBuyer(t.collateral, payout);
            s.exercisedNotional = s.totalNotional;
        }
    }

    function claim(VaultState storage s, VaultTerms storage t, IIvyShares shareToken, uint256 vaultId, uint256 shares)
        external
    {
        if (shares == 0) {
            revert ZeroAmount();
        }
        if (shareToken.balanceOf(msg.sender, vaultId) < shares) {
            revert InsufficientShares();
        }
        uint256 supply = shareToken.totalSupply(vaultId);

        address[3] memory tokens = [t.collateral, s.premiumToken, s.isCall ? s.quoteToken : t.underlying];
        uint256[3] memory amounts;
        for (uint256 i = 0; i < 3; ++i) {
            if (_seenBefore(tokens, i)) {
                continue;
            }
            uint256 available = IERC20(tokens[i]).balanceOf(s.vault);
            available -= IIvyVault(s.vault).reserved(tokens[i]);
            amounts[i] = (available * shares) / supply;
        }

        shareToken.burn(msg.sender, vaultId, shares);
        IIvyVault vault = IIvyVault(s.vault);
        for (uint256 i = 0; i < 3; ++i) {
            if (amounts[i] > 0) {
                vault.push(tokens[i], msg.sender, amounts[i]);
            }
        }
    }

    function _validateReport(uint256 price, uint64 validUntil) private view {
        if (price == 0) {
            revert InvalidPrice();
        }
        if (block.timestamp > validUntil) {
            revert BidExpired();
        }
    }

    function _checkExerciseWindow(VaultState storage s) private view {
        uint256 ts = block.timestamp;
        if (s.settlement == SettlementType.Cash) {
            if (s.style == ExerciseStyle.European && ts < s.expiry) {
                revert ExerciseNotOpenYet();
            }
        } else {
            if (ts >= uint256(s.expiry) + s.exerciseWindow) {
                revert ExerciseWindowClosed();
            }
            if (s.style == ExerciseStyle.European && ts < s.expiry) {
                revert ExerciseNotOpenYet();
            }
        }
    }

    function _readExpiryPrice(SettlementPrices storage prices) private view returns (uint256 price) {
        price = prices.expiry;
        if (price == 0) {
            revert ReportUnavailable();
        }
    }

    function _readExercisePrice(VaultTerms storage t, SettlementPrices storage prices) private view returns (uint256) {
        ExercisePriceObservation storage observation = prices.exercise;
        if (observation.price == 0) {
            revert InvalidPrice();
        }
        if (
            block.timestamp - observation.observedAt > t.maxSettlementPriceAge
                || block.timestamp > observation.validUntil
        ) {
            revert StalePrice();
        }
        return observation.price;
    }

    function _seenBefore(address[3] memory tokens, uint256 i) private pure returns (bool) {
        for (uint256 j = 0; j < i; ++j) {
            if (tokens[j] == tokens[i]) {
                return true;
            }
        }
        return false;
    }
}
