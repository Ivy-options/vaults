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

    // ------------------------------------------------------------ settlement (spec §9.2)

    /// @notice First moment `settle` may be called: expiry for cash, expiry + exerciseWindow for physical.
    function settlementTimeOf(uint256 vaultId) public view returns (uint256) {
        VaultState storage s = _state[vaultId];
        return s.settlement == SettlementType.Cash ? uint256(s.expiry) : uint256(s.expiry) + exerciseWindow;
    }

    /// @notice Permissionless. Physical: closes the vault. Cash: prices the remaining notional and reserves
    ///         the market maker's payout (collected via `claimPayout`).
    function settle(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (block.timestamp < settlementTimeOf(vaultId)) revert SettlementNotReached();

        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (s.settlement == SettlementType.Cash && remaining > 0) {
            VaultTerms storage t = _terms[vaultId];
            bool grace = block.timestamp >= uint256(s.expiry) + settlementGracePeriod;
            (bool ok, uint256 spot) = _trySpot(t, s.quoteToken, grace);
            if (!ok && !grace) revert StalePrice();
            uint256 payout;
            if (ok) {
                payout = s.isCall
                    ? IvyMath.callIntrinsic(remaining, s.strike, spot)
                    : IvyMath.putIntrinsic(remaining, s.strike, spot, s.underlyingUnit);
            }
            s.pendingPayout += payout;
            s.exercisedNotional = s.totalNotional;
        }
        _finalize(vaultId, s);
    }

    /// @notice Market maker collects what cash auto-settlement reserved. Pull-based so a failing transfer
    ///         can never block `settle`.
    function claimPayout(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Settled);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker) revert NotMarketMaker();
        uint256 amount = s.pendingPayout;
        if (amount == 0) revert NothingToClaim();
        s.pendingPayout = 0;
        IIvyVault(s.vault).push(_terms[vaultId].collateral, msg.sender, amount);
        emit PayoutClaimed(vaultId, msg.sender, amount);
    }

    /// @dev Non-reverting feed read. `allowStale` lets an old (but non-zero, non-future) price through.
    function _trySpot(VaultTerms storage t, address quoteToken, bool allowStale)
        internal view returns (bool ok, uint256 spot)
    {
        try IIvyPriceFeed(t.priceFeed).spot(t.underlying, quoteToken) returns (uint256 price, uint256 updatedAt) {
            if (price == 0 || updatedAt > block.timestamp) return (false, 0);
            if (!allowStale && block.timestamp - updatedAt > t.maxPriceAge) return (false, 0);
            return (true, price);
        } catch {
            return (false, 0);
        }
    }
}
