// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
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
        _validateTerms(terms, pairs);
        bool isCall = terms.collateral == terms.underlying;

        vaultId = ++vaultCount;
        vault = Clones.clone(vaultImplementation);
        IIvyVault(vault).initialize(address(this), vaultId, terms.collateral);

        _terms[vaultId] = terms;
        VaultState storage s = _state[vaultId];
        s.vault = vault;
        s.owner = msg.sender;
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

    function _validateTerms(VaultTerms calldata t, PairInput[] calldata pairs) internal pure {
        if (t.underlying == address(0) || t.collateral == address(0)) revert ZeroAddress();
        if (t.maxTenor == 0) revert InvalidTenor();
        bool isCall = t.collateral == t.underlying;
        if (t.allowedSettlement != SettlementPolicy.Physical && t.priceFeed == address(0)) revert CashSettlementNeedsFeed();
        if (t.priceFeed != address(0)) {
            if (t.maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
            if (isCall && t.maxSpotDeviationBps > 10_000) revert DeviationTooLarge();
        }
        if (pairs.length == 0) revert NoPairs();
        if (!isCall) {
            if (pairs.length != 1) revert PutRequiresSinglePair();
            if (pairs[0].quoteToken != t.collateral) revert PutPairMustBeCollateral();
        }
        for (uint256 i = 0; i < pairs.length; ++i) {
            PairInput calldata p = pairs[i];
            if (p.quoteToken == address(0) || p.terms.premiumToken == address(0)) revert ZeroAddress();
            if (isCall && p.quoteToken == t.underlying) revert QuoteIsUnderlying();
            if (!p.terms.enabled) revert PairMustBeEnabled();
            if (!isCall && p.terms.strikeLimit == 0) revert InvalidStrikeLimit();
            for (uint256 j = 0; j < i; ++j) {
                if (pairs[j].quoteToken == p.quoteToken) revert DuplicatePair(p.quoteToken);
            }
        }
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
        _burn(msg.sender, vaultId, shares);
        IIvyVault(_state[vaultId].vault).push(_terms[vaultId].collateral, msg.sender, shares);
        emit Withdrawn(vaultId, msg.sender, shares);
    }

    function _checkDeposit(uint256 vaultId, address depositor, uint256 amount) internal view {
        _requirePhase(vaultId, Phase.Open);
        if (amount == 0) revert ZeroAmount();
        if (!_terms[vaultId].publicDeposits && depositor != _state[vaultId].owner) revert DepositsNotPublic();
    }

    function _credit(uint256 vaultId, address depositor, uint256 received) internal {
        if (received == 0) revert ZeroAmount();
        _mint(depositor, vaultId, received, "");
        emit Deposited(vaultId, depositor, received);
    }

    // ------------------------------------------------------------ owner controls (spec §8)

    /// @notice Tighten vault-level terms. Every field must be equal or more LP-favourable than today.
    function tightenVaultTerms(uint256 vaultId, TightenableTerms calldata n) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        VaultTerms storage t = _terms[vaultId];
        if (!(t.allowedExercise == n.allowedExercise || t.allowedExercise == ExercisePolicy.Either)) revert LoosensTerms();
        if (!(t.allowedSettlement == n.allowedSettlement || t.allowedSettlement == SettlementPolicy.Either)) revert LoosensTerms();
        if (n.maxTenor == 0) revert InvalidTenor();
        if (n.maxTenor > t.maxTenor) revert LoosensTerms();
        if (n.minCollateral < t.minCollateral) revert LoosensTerms();
        if (t.priceFeed != address(0)) {
            if (n.maxSpotDeviationBps > t.maxSpotDeviationBps) revert LoosensTerms();
            if (n.maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
            if (n.maxPriceAge > t.maxPriceAge) revert LoosensTerms();
            t.maxSpotDeviationBps = n.maxSpotDeviationBps;
            t.maxPriceAge = n.maxPriceAge;
        }
        t.allowedExercise = n.allowedExercise;
        t.allowedSettlement = n.allowedSettlement;
        t.maxTenor = n.maxTenor;
        t.minCollateral = n.minCollateral;
        emit VaultTermsTightened(vaultId);
    }

    /// @notice Tighten one quote token's terms. Premium token is fixed; a disabled pair stays disabled.
    function tightenPairTerms(uint256 vaultId, address quoteToken, PairTerms calldata n) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        PairTerms storage p = _pairTerms[vaultId][quoteToken];
        if (p.premiumToken == address(0)) revert PairUnknown(quoteToken);
        if (n.premiumToken != p.premiumToken) revert LoosensTerms();
        bool isCall = _state[vaultId].isCall;
        if (isCall ? n.strikeLimit < p.strikeLimit : n.strikeLimit > p.strikeLimit) revert LoosensTerms();
        if (!isCall && n.strikeLimit == 0) revert InvalidStrikeLimit();
        if (n.minPremium < p.minPremium) revert LoosensTerms();
        if (n.enabled && !p.enabled) revert LoosensTerms();
        p.strikeLimit = n.strikeLimit;
        p.minPremium = n.minPremium;
        p.enabled = n.enabled;
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
        VaultState storage s = _state[vaultId];
        VaultTerms storage t = _terms[vaultId];
        bool scheduled = t.auctionStartsAt != 0 && block.timestamp >= t.auctionStartsAt;
        if (msg.sender != s.owner && !scheduled) revert AuctionNotStartable();
        uint256 collateral = totalSupply(vaultId);
        if (collateral == 0) revert ZeroAmount();
        if (collateral < t.minCollateral) revert BelowMinCollateral(collateral, t.minCollateral);
        s.phase = Phase.Auction;
        s.auctionOpenedAt = uint64(block.timestamp);
        emit AuctionOpened(vaultId, collateral);
    }

    /// @notice Bid master any time; owner once `auctionTimeout` has elapsed. Clears the schedule.
    function cancelAuction(uint256 vaultId) external {
        _requirePhase(vaultId, Phase.Auction);
        VaultState storage s = _state[vaultId];
        if (!hasRole(BID_MASTER_ROLE, msg.sender)) {
            if (msg.sender != s.owner) revert NotVaultOwner();
            if (block.timestamp < uint256(s.auctionOpenedAt) + auctionTimeout) revert AuctionTimeoutNotReached();
        }
        s.phase = Phase.Open;
        s.auctionOpenedAt = 0;
        _terms[vaultId].auctionStartsAt = 0;
        emit AuctionCancelled(vaultId);
    }
}
