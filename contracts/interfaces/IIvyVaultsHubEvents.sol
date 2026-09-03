// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {OptionKind, ExerciseStyle, SettlementType} from "../types/IvyTypes.sol";

interface IIvyVaultsHubEvents {
    event VaultCreated(uint256 indexed vaultId, address indexed vault, address indexed owner, OptionKind kind, address underlying, address collateral);
    event Deposited(uint256 indexed vaultId, address indexed depositor, uint256 amount);
    event Withdrawn(uint256 indexed vaultId, address indexed holder, uint256 shares);
    event VaultTermsTightened(uint256 indexed vaultId);
    event PairTermsTightened(uint256 indexed vaultId, address indexed quoteToken);
    event AuctionScheduled(uint256 indexed vaultId, uint64 auctionStartsAt);
    event AuctionOpened(uint256 indexed vaultId, uint256 collateral);
    event AuctionCancelled(uint256 indexed vaultId);
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
    event Exercised(uint256 indexed vaultId, uint256 amount, uint256 paidByMarketMaker, uint256 receivedByMarketMaker);
    event Settled(uint256 indexed vaultId, uint256 exercisedNotional, uint256 totalNotional, uint256 pendingPayout);
    event Claimed(uint256 indexed vaultId, address indexed holder, uint256 shares);
    event PayoutClaimed(uint256 indexed vaultId, address indexed marketMaker, uint256 amount);
    event BidCancelled(address indexed marketMaker, uint256 nonce);
    event VaultOwnershipTransferred(uint256 indexed vaultId, address indexed previousOwner, address indexed newOwner);
    event SettingsUpdated(uint64 exerciseWindow, uint64 auctionTimeout, uint64 settlementGracePeriod);
    event VaultImplementationUpdated(address implementation);
}
