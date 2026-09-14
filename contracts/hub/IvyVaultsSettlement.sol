// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IvyVaultsActivation} from "./IvyVaultsActivation.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import {IvyOptionSettlement} from "../libraries/IvyOptionSettlement.sol";
import "../types/IvyTypes.sol";

/// @dev Exercise, settlement and claims (spec §9, §10).
abstract contract IvyVaultsSettlement is IvyVaultsActivation {
    /// @notice The authorized EOA or contract publishes a strictly newer observation for one live cash vault.
    function publishExercisePrice(uint256 vaultId, uint256 price, uint64 observedAt, uint64 validUntil)
        external onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE)
    {
        _requireCashPublication(vaultId);
        IvyOptionSettlement.publishExercisePrice(_settlementPrices[vaultId], vaultId, _terms[vaultId].underlying, _state[vaultId].quoteToken, price, observedAt, validUntil);
    }

    /// @notice Finalize one live cash vault at or after its expiry. Stored prices cannot be replaced.
    function publishExpiry(uint256 vaultId, uint256 price, uint64 validUntil)
        external onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE)
    {
        _requireCashPublication(vaultId);
        VaultState storage s = _state[vaultId];
        IvyOptionSettlement.publishExpiry(_settlementPrices[vaultId], vaultId, _terms[vaultId].underlying, s.quoteToken, s.expiry, price, validUntil);
    }

    function _requireCashPublication(uint256 vaultId) private view {
        _requirePhase(vaultId, Phase.Live);
        if (_state[vaultId].settlement != SettlementType.Cash) revert SettlementNotAllowed();
    }

    function exercisePrice(uint256 vaultId) external view returns (uint256 price, uint256 observedAt, uint256 validUntil) {
        _requireExists(vaultId);
        ExercisePriceObservation storage observation = _settlementPrices[vaultId].exercise;
        return (observation.price, observation.observedAt, observation.validUntil);
    }

    function settlementPrice(uint256 vaultId) external view returns (uint256 price) {
        _requireExists(vaultId);
        price = _settlementPrices[vaultId].expiry;
        if (price == 0) revert ReportUnavailable();
    }

    // ------------------------------------------------------------ exercise (spec §9.1)

    /// @notice Market maker exercises `amount` underlying units. Partial exercise follows the immutable vault term; the vault finalizes
    ///         automatically once everything is exercised.
    function exercise(uint256 vaultId, uint256 amount) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        (uint256 paid, uint256 got) = IvyOptionSettlement.exercise(s, _terms[vaultId], _settlementPrices[vaultId], amount);
        emit Exercised(vaultId, amount, paid, got);
        if (s.exercisedNotional == s.totalNotional) _finalize(vaultId, s);
    }


    function _finalize(uint256 vaultId, VaultState storage s) internal {
        s.phase = Phase.Settled;
        emit Settled(vaultId, s.exercisedNotional, s.totalNotional, s.pendingPayout);
    }

    // ------------------------------------------------------------ settlement (spec §9.2)

    /// @notice First moment `expire` may be called: expiry for cash, expiry + exerciseWindow for physical.
    function expirationTimeOf(uint256 vaultId) public view returns (uint256) {
        VaultState storage s = _state[vaultId];
        return s.settlement == SettlementType.Cash ? uint256(s.expiry) : uint256(s.expiry) + s.exerciseWindow;
    }

    /// @notice Permissionless. Physical: closes the vault. Cash: prices the remaining notional and reserves
    ///         the market maker's payout (collected via `claimPayout`).
    function expire(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (block.timestamp < expirationTimeOf(vaultId)) revert ExpirationNotReached();
        IvyOptionSettlement.expire(s, _terms[vaultId], _settlementPrices[vaultId]);
        _finalize(vaultId, s);
    }

    /// @notice Buyer or executor collects a reserved cash payout or unwind refund for the configured recipient. A failing transfer
    ///         can never block `expire`.
    function claimPayout(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Settled);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker && msg.sender != s.executor) revert NotExecutor();
        IIvyVault vault = IIvyVault(s.vault);
        address collateral = _terms[vaultId].collateral;
        uint256 amount = vault.payBuyer(collateral, s.recipient);
        if (s.premiumToken != collateral) amount += vault.payBuyer(s.premiumToken, s.recipient);
        if (amount == 0) revert NothingToClaim();
        s.pendingPayout = 0;
        emit PayoutClaimed(vaultId, s.marketMaker, amount);
    }

    function claimPremium(uint256 vaultId) external nonReentrant {
        _requireExists(vaultId);
        premiums.claimFor(vaultId, msg.sender);
    }

    function setExecution(uint256 vaultId, address executor, address recipient) external nonReentrant {
        _requireExists(vaultId);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker) revert NotMarketMaker();
        if (recipient == address(0)) revert ZeroAddress();
        s.executor = executor;
        s.recipient = recipient;
        emit ExecutionUpdated(vaultId, executor, recipient);
    }

    function proposeUnwind(uint256 vaultId, uint64 deadline, uint256 refund) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.owner && msg.sender != s.marketMaker) revert NotVaultOwner();
        unwind.propose(vaultId, deadline, s.exercisedNotional, shareToken.totalSupply(vaultId), refund);
    }
    function approveUnwind(uint256 vaultId, uint256 nonce) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        unwind.approve(vaultId, nonce, msg.sender, shareToken.balanceOf(msg.sender, vaultId));
    }
    function revokeUnwind(uint256 vaultId) external nonReentrant { unwind.revoke(vaultId, msg.sender); }
    /// @notice Each current LP deposits premium tokens into this vault's segregated refund reserve.
    function fundUnwind(uint256 vaultId, uint256 nonce, uint256 amount) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (shareToken.balanceOf(msg.sender, vaultId) == 0) revert AgreementInvalid();
        uint256 revision = unwind.revisions(vaultId, msg.sender);
        uint256 received = IIvyVault(s.vault).fundUnwind(msg.sender, amount);
        // A token callback that transfers shares, even away and back, invalidates this funding attempt.
        unwind.fund(vaultId, nonce, msg.sender, received, s.exercisedNotional, revision);
    }
    function withdrawUnwindContribution(uint256 vaultId, uint256 nonce) external nonReentrant {
        _requireExists(vaultId);
        uint256 amount = unwind.withdraw(vaultId, nonce, msg.sender);
        IIvyVault(_state[vaultId].vault).returnUnwind(msg.sender, amount);
    }
    function executeUnwind(uint256 vaultId, uint256 nonce, bytes calldata buyerSignature) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        uint256 refund = unwind.consume(vaultId, nonce, s.exercisedNotional, shareToken.totalSupply(vaultId), s.marketMaker, buyerSignature);
        IIvyVault(s.vault).consumeUnwind(refund);
        _finalize(vaultId, s);
        emit Unwound(vaultId, nonce, refund);
    }

    // ------------------------------------------------------------ claims (spec §10)

    /// @notice Burn `shares` for proportional unreserved collateral and settlement proceeds.
    ///         Unpaid activation premium, premium dust and buyer obligations remain reserved.
    function claim(uint256 vaultId, uint256 shares) external nonReentrant {
        _requirePhase(vaultId, Phase.Settled);
        IvyOptionSettlement.claim(_state[vaultId], _terms[vaultId], shareToken, vaultId, shares);
        emit Claimed(vaultId, msg.sender, shares);
    }
}
