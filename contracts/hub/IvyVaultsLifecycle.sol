// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IvyVaultRules} from "../libraries/IvyVaultRules.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IvyVaultsHubStorage} from "./IvyVaultsHubStorage.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import {IIvyVaultsHub} from "../interfaces/IIvyVaultsHub.sol";
import "../types/IvyTypes.sol";

/// @dev Vault creation, deposits, withdrawals, owner controls and the auction phase (spec §4.2, §6.1, §6.2, §8).
abstract contract IvyVaultsLifecycle is IvyVaultsHubStorage, IIvyVaultsHub {
    // ------------------------------------------------------------ creation (spec §4.2)

    /// @notice Create a vault. Kind is derived: `collateral == underlying` is a covered call, anything else a put.
    function createVault(VaultTerms calldata terms, PairInput[] calldata pairs)
        external nonReentrant returns (uint256 vaultId, address vault)
    {
        _admission(0);
        if (terms.allowedSettlement != SettlementPolicy.Physical) _requireCashSettlementEnabled();
        if (shareToken.hub() != address(this) || premiums.hub() != address(this) || unwind.hub() != address(this)
            || shareToken.premiums() != address(premiums) || shareToken.unwind() != address(unwind)
            || premiums.shares() != address(shareToken) || unwind.shares() != address(shareToken)) revert BindingMismatch();
        IvyVaultRules.validateTerms(terms, pairs);
        bool isCall = terms.collateral == terms.underlying;

        vaultId = ++vaultCount;
        vault = Clones.clone(vaultImplementation);
        IIvyVault(vault).initialize(address(this), vaultId, terms.collateral, address(premiums));

        _terms[vaultId] = terms;
        vaultPlatformFeeBps[vaultId] = platformFeeBps;
        VaultState storage s = _state[vaultId];
        s.vault = vault;
        s.owner = msg.sender;
        s.expiry = terms.expiry;
        s.exerciseWindow = exerciseWindow;
        s.auctionTimeout = auctionTimeout;
        s.isCall = isCall;
        s.phase = Phase.Open;
        s.underlyingUnit = 10 ** IERC20Metadata(terms.underlying).decimals();

        for (uint256 i = 0; i < pairs.length; ++i) {
            _pairTerms[vaultId][pairs[i].quoteToken] = pairs[i].terms;
            _quoteTokens[vaultId].push(pairs[i].quoteToken);
        }

        emit VaultCreated(
            vaultId,
            vault,
            msg.sender,
            isCall ? OptionKind.CoveredCall : OptionKind.CashSecuredPut,
            terms.underlying,
            terms.collateral
        );
        if (terms.auctionStartsAt != 0) emit AuctionScheduled(vaultId, terms.auctionStartsAt);
    }


    // ------------------------------------------------------------ deposits (spec §6.1)

    /// @notice Deposit through the hub. The caller must have approved the vault address.
    function deposit(uint256 vaultId, uint256 amount) external nonReentrant {
        _checkDeposit(vaultId, msg.sender, amount);
        uint256 received = IIvyVault(_state[vaultId].vault).pull(_terms[vaultId].collateral, msg.sender, amount);
        _credit(vaultId, msg.sender, received);
    }

    /// @inheritdoc IIvyVaultsHub
    function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external nonReentrant {
        if (vaultId == 0 || vaultId > vaultCount || msg.sender != _state[vaultId].vault) revert NotVault();
        _checkDeposit(vaultId, depositor, amount);
        _credit(vaultId, depositor, amount);
    }

    /// @notice Burn shares and take collateral back. Only while the vault is Open.
    function withdraw(uint256 vaultId, uint256 shares) external nonReentrant {
        _requirePhase(vaultId, Phase.Open);
        if (shares == 0) revert ZeroAmount();
        shareToken.burn(msg.sender, vaultId, shares);
        IIvyVault(_state[vaultId].vault).push(_terms[vaultId].collateral, msg.sender, shares);
        emit Withdrawn(vaultId, msg.sender, shares);
    }

    function _checkDeposit(uint256 vaultId, address depositor, uint256 amount) internal view {
        _admission(vaultId);
        _requirePhase(vaultId, Phase.Open);
        if (amount == 0) revert ZeroAmount();
        if (!_terms[vaultId].publicDeposits && depositor != _state[vaultId].owner) revert DepositsNotPublic();
    }

    function _credit(uint256 vaultId, address depositor, uint256 received) internal {
        if (received == 0) revert ZeroAmount();
        shareToken.mint(depositor, vaultId, received);
        emit Deposited(vaultId, depositor, received);
    }

    // ------------------------------------------------------------ owner controls (spec §8)

    /// @notice Tighten vault-level terms. Every field must be equal or more LP-favourable than today.
    function tightenVaultTerms(uint256 vaultId, TightenableTerms calldata n) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        IvyVaultRules.tightenVaultTerms(_terms[vaultId], n);
        emit VaultTermsTightened(vaultId);
    }

    /// @notice Tighten one quote token's terms. Premium token is fixed; a disabled pair stays disabled.
    function tightenPairTerms(uint256 vaultId, address quoteToken, PairTerms calldata n) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        IvyVaultRules.tightenPairTerms(_pairTerms[vaultId][quoteToken], _state[vaultId].isCall, quoteToken, n);
        emit PairTermsTightened(vaultId, quoteToken);
    }

    /// @notice Set or clear the time from which anyone may open the auction. Operational, not economic.
    function scheduleAuction(uint256 vaultId, uint64 auctionStartsAt) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        _terms[vaultId].auctionStartsAt = auctionStartsAt;
        emit AuctionScheduled(vaultId, auctionStartsAt);
    }

    function transferVaultOwnership(uint256 vaultId, address newOwner) external onlyVaultOwner(vaultId) {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = _state[vaultId].owner;
        _state[vaultId].owner = newOwner;
        emit VaultOwnershipTransferred(vaultId, previous, newOwner);
    }

    // ------------------------------------------------------------ auction (spec §6.1, §6.2)

    /// @notice Freeze deposits and start the off-chain auction. Owner any time; anyone once `auctionStartsAt` passed.
    function openAuction(uint256 vaultId) external {
        _requirePhase(vaultId, Phase.Open);
        _admission(vaultId);
        VaultState storage s = _state[vaultId];
        VaultTerms storage t = _terms[vaultId];
        if (block.timestamp >= t.expiry) revert ExpiryInPast();
        bool scheduled = t.auctionStartsAt != 0 && block.timestamp >= t.auctionStartsAt;
        if (msg.sender != s.owner && !scheduled) revert AuctionNotStartable();
        uint256 collateral = shareToken.totalSupply(vaultId);
        if (collateral == 0) revert ZeroAmount();
        if (collateral < t.minCollateral) revert BelowMinCollateral(collateral, t.minCollateral);
        ++s.auctionId;
        emit AuctionIdentity(vaultId, s.auctionId);
        s.phase = Phase.Auction;
        s.auctionOpenedAt = uint64(block.timestamp);
        emit AuctionOpened(vaultId, collateral);
    }

    /// @notice Bid master any time; owner after timeout, at expiry, or during admission pause. Clears the schedule.
    function cancelAuction(uint256 vaultId) external {
        _requirePhase(vaultId, Phase.Auction);
        VaultState storage s = _state[vaultId];
        if (!hasRole(BID_MASTER_ROLE, msg.sender)) {
            if (msg.sender != s.owner) revert NotVaultOwner();
            if (!paused && !vaultPaused[vaultId] && block.timestamp < s.expiry && block.timestamp < uint256(s.auctionOpenedAt) + s.auctionTimeout) revert AuctionTimeoutNotReached();
        }
        s.phase = Phase.Open;
        s.auctionOpenedAt = 0;
        _terms[vaultId].auctionStartsAt = 0;
        emit AuctionCancelled(vaultId);
    }
}
