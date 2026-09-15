// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {ExerciseStyle, OptionKind, SettlementType} from "../types/IvyTypes.sol";

interface IIvyVaultsHubEvents {
    event Activated(
        uint256 indexed vaultId,
        address indexed marketMaker,
        address quoteToken,
        address premiumToken,
        uint256 strike,
        uint256 premium,
        ExerciseStyle style,
        SettlementType settlement,
        uint64 expiry,
        uint256 totalNotional,
        uint256 totalPremium
    );
    event AdmissionPauseUpdated(uint256 indexed vaultId, bool paused);
    event AuctionCancelled(uint256 indexed vaultId);
    event AuctionIdentity(uint256 indexed vaultId, uint256 auctionId);
    event AuctionOpened(uint256 indexed vaultId, uint256 collateral);
    event AuctionScheduled(uint256 indexed vaultId, uint64 auctionStartsAt);
    event BidCancelled(address indexed marketMaker, uint256 nonce);
    event CashSettlementEnabledUpdated(bool enabled);
    event Claimed(uint256 indexed vaultId, address indexed holder, uint256 shares);
    event Deposited(uint256 indexed vaultId, address indexed depositor, uint256 amount);
    event ExecutionUpdated(uint256 indexed vaultId, address executor, address recipient);
    event Exercised(uint256 indexed vaultId, uint256 amount, uint256 paidByMarketMaker, uint256 receivedByMarketMaker);
    event ExercisePricePublished(
        uint256 indexed vaultId,
        address indexed underlying,
        address indexed quote,
        uint256 price,
        uint64 observedAt,
        uint64 validUntil
    );
    event ExpiryPublished(
        uint256 indexed vaultId,
        address indexed underlying,
        address indexed quote,
        uint64 expiry,
        uint256 price,
        uint64 validUntil
    );
    event PairTermsTightened(uint256 indexed vaultId, address indexed quoteToken);
    event PayoutClaimed(uint256 indexed vaultId, address indexed marketMaker, uint256 amount);
    event SettingsUpdated(uint64 exerciseWindow, uint64 auctionTimeout);
    event Settled(uint256 indexed vaultId, uint256 exercisedNotional, uint256 totalNotional, uint256 pendingPayout);
    event Unwound(uint256 indexed vaultId, uint256 nonce, uint256 refund);
    event VaultCreated(
        uint256 indexed vaultId,
        address indexed vault,
        address indexed owner,
        OptionKind kind,
        address underlying,
        address collateral
    );
    event VaultOwnershipTransferred(uint256 indexed vaultId, address indexed previousOwner, address indexed newOwner);
    event VaultTermsTightened(uint256 indexed vaultId);
    event Withdrawn(uint256 indexed vaultId, address indexed holder, uint256 shares);
}
