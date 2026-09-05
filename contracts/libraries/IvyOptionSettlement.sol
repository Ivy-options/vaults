// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import {IIvyShares} from "../interfaces/IIvyShares.sol";
import {IIvyPriceFeed} from "../interfaces/IIvyPriceFeed.sol";
import {IvyMath} from "./IvyMath.sol";
import "../types/IvyTypes.sol";

/// @notice Fixed linked exercise, settlement and residual-claim implementation.
/// @dev Only reached through phase-checked, nonReentrant hub entrypoints. DELEGATECALL preserves
///      hub storage, msg.sender and custody authority. This library has no independent payment route.
library IvyOptionSettlement {
    function exercise(VaultState storage s, VaultTerms storage t, uint256 amount)
        external returns (uint256 paid, uint256 got)
    {
        if (msg.sender != s.marketMaker && msg.sender != s.executor) revert NotExecutor();
        if (amount == 0) revert ZeroAmount();
        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (amount > remaining) revert ExceedsRemaining(remaining);
        _checkExerciseWindow(s);

        s.exercisedNotional += amount;

        IIvyVault vault = IIvyVault(s.vault);
        if (s.settlement == SettlementType.Physical) {
            if (s.isCall) {
                paid = IvyMath.quoteDueCeil(amount, s.strike, s.underlyingUnit);
                uint256 received = vault.pull(s.quoteToken, msg.sender, paid);
                if (received < paid) revert ShortReceived(paid, received);
                got = amount;
            } else {
                paid = amount;
                uint256 received = vault.pull(t.underlying, msg.sender, amount);
                if (received < amount) revert ShortReceived(amount, received);
                got = IvyMath.quoteOutFloor(amount, s.strike, s.underlyingUnit);
            }
        } else {
            uint256 spot = _readSpot(t, s.quoteToken);
            got = s.isCall
                ? IvyMath.callIntrinsic(amount, s.strike, spot)
                : IvyMath.putIntrinsic(amount, s.strike, spot, s.underlyingUnit);
            if (got == 0) revert NothingToExercise();
        }
        vault.push(t.collateral, s.recipient, got);
    }

    function _checkExerciseWindow(VaultState storage s) private view {
        uint256 ts = block.timestamp;
        if (s.settlement == SettlementType.Cash) {
            if (s.style == ExerciseStyle.European) revert ExerciseNotAvailable();
            if (ts >= s.expiry) revert ExerciseWindowClosed();
        } else {
            if (ts >= uint256(s.expiry) + s.exerciseWindow) revert ExerciseWindowClosed();
            if (s.style == ExerciseStyle.European && ts < s.expiry) revert ExerciseNotOpenYet();
        }
    }

    function settle(VaultState storage s, VaultTerms storage t) external {
        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (s.settlement == SettlementType.Cash && remaining > 0) {
            uint256 spot = IIvyPriceFeed(t.priceFeed).settlementPrice(t.underlying, s.quoteToken, s.expiry);
            if (spot == 0) revert ReportUnavailable();
            uint256 payout = s.isCall
                ? IvyMath.callIntrinsic(remaining, s.strike, spot)
                : IvyMath.putIntrinsic(remaining, s.strike, spot, s.underlyingUnit);
            s.pendingPayout += payout;
            IIvyVault(s.vault).reserveBuyer(t.collateral, payout);
            s.exercisedNotional = s.totalNotional;
        }
    }

    function claim(VaultState storage s, VaultTerms storage t, IIvyShares shareToken, uint256 vaultId, uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        if (shareToken.balanceOf(msg.sender, vaultId) < shares) revert InsufficientShares();
        uint256 supply = shareToken.totalSupply(vaultId);

        address[3] memory tokens = [t.collateral, s.premiumToken, s.isCall ? s.quoteToken : t.underlying];
        uint256[3] memory amounts;
        for (uint256 i = 0; i < 3; ++i) {
            if (_seenBefore(tokens, i)) continue;
            uint256 available = IERC20(tokens[i]).balanceOf(s.vault);
            available -= IIvyVault(s.vault).reserved(tokens[i]);
            amounts[i] = (available * shares) / supply;
        }

        shareToken.burn(msg.sender, vaultId, shares);
        IIvyVault vault = IIvyVault(s.vault);
        for (uint256 i = 0; i < 3; ++i) {
            if (amounts[i] > 0) vault.push(tokens[i], msg.sender, amounts[i]);
        }
    }

    function _seenBefore(address[3] memory tokens, uint256 i) private pure returns (bool) {
        for (uint256 j = 0; j < i; ++j) {
            if (tokens[j] == tokens[i]) return true;
        }
        return false;
    }

    function _readSpot(VaultTerms storage t, address quoteToken) private view returns (uint256) {
        (uint256 price, uint256 updatedAt) = IIvyPriceFeed(t.priceFeed).spot(t.underlying, quoteToken);
        if (price == 0 || updatedAt > block.timestamp) revert InvalidPrice();
        if (block.timestamp - updatedAt > t.maxPriceAge) revert StalePrice();
        return price;
    }
}
