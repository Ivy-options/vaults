// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IvyVaultsActivation} from "./IvyVaultsActivation.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import {IIvyPriceFeed} from "../interfaces/IIvyPriceFeed.sol";
import {IvyMath} from "../libraries/IvyMath.sol";
import "../types/IvyTypes.sol";

/// @dev Exercise, settlement and claims (spec §9, §10).
abstract contract IvyVaultsSettlement is IvyVaultsActivation {
    // ------------------------------------------------------------ exercise (spec §9.1)

    /// @notice Market maker exercises `amount` underlying units. Partial exercise is allowed; the vault settles
    ///         automatically once everything is exercised.
    function exercise(uint256 vaultId, uint256 amount) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker) revert NotMarketMaker();
        if (amount == 0) revert ZeroAmount();
        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (amount > remaining) revert ExceedsRemaining(remaining);
        _checkExerciseWindow(s);

        s.exercisedNotional += amount;

        VaultTerms storage t = _terms[vaultId];
        IIvyVault vault = IIvyVault(s.vault);
        uint256 paid;
        uint256 got;
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
        vault.push(t.collateral, msg.sender, got);

        emit Exercised(vaultId, amount, paid, got);
        if (s.exercisedNotional == s.totalNotional) _finalize(vaultId, s);
    }

    /// @dev Spec §9.1 timing table. Cash European never exercises (it auto-settles).
    function _checkExerciseWindow(VaultState storage s) internal view {
        uint256 ts = block.timestamp;
        if (s.settlement == SettlementType.Cash) {
            if (s.style == ExerciseStyle.European) revert ExerciseNotAvailable();
            if (ts >= s.expiry) revert ExerciseWindowClosed();
        } else {
            if (ts > uint256(s.expiry) + exerciseWindow) revert ExerciseWindowClosed();
            if (s.style == ExerciseStyle.European && ts < s.expiry) revert ExerciseNotOpenYet();
        }
    }

    function _finalize(uint256 vaultId, VaultState storage s) internal {
        s.phase = Phase.Settled;
        emit Settled(vaultId, s.exercisedNotional, s.totalNotional, s.pendingPayout);
    }
}
