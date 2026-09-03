// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IIvyVaultsHubEvents} from "../interfaces/IIvyVaultsHubEvents.sol";
import {IIvyPriceFeed} from "../interfaces/IIvyPriceFeed.sol";
import {IIvyShares} from "../interfaces/IIvyShares.sol";
import "../types/IvyTypes.sol";

/// @dev Storage layout, roles, settings, views and shared guards for the hub. Append-only storage.
abstract contract IvyVaultsHubStorage is
    IIvyVaultsHubEvents,
    AccessControlUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    bytes32 public constant BID_MASTER_ROLE = keccak256("BID_MASTER_ROLE");
    bytes32 public constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");

    address public vaultImplementation;
    uint64 public exerciseWindow;
    uint64 public auctionTimeout;
    uint64 public settlementGracePeriod;
    uint256 public vaultCount;

    mapping(uint256 vaultId => VaultTerms) internal _terms;
    mapping(uint256 vaultId => VaultState) internal _state;
    mapping(uint256 vaultId => mapping(address quoteToken => PairTerms)) internal _pairTerms;
    mapping(uint256 vaultId => address[]) internal _quoteTokens;
    mapping(address marketMaker => mapping(uint256 nonce => bool)) public usedBidNonces;
    IIvyShares public shareToken;

    uint256[39] private __gap;

    // ------------------------------------------------------------ views

    function termsOf(uint256 vaultId) external view returns (VaultTerms memory) {
        _requireExists(vaultId);
        return _terms[vaultId];
    }

    function stateOf(uint256 vaultId) external view returns (VaultState memory) {
        _requireExists(vaultId);
        return _state[vaultId];
    }

    function pairTermsOf(uint256 vaultId, address quoteToken) external view returns (PairTerms memory) {
        _requireExists(vaultId);
        return _pairTerms[vaultId][quoteToken];
    }

    function quoteTokensOf(uint256 vaultId) external view returns (address[] memory) {
        _requireExists(vaultId);
        return _quoteTokens[vaultId];
    }

    function vaultOf(uint256 vaultId) external view returns (address) {
        _requireExists(vaultId);
        return _state[vaultId].vault;
    }

    function kindOf(uint256 vaultId) external view returns (OptionKind) {
        _requireExists(vaultId);
        return _state[vaultId].isCall ? OptionKind.CoveredCall : OptionKind.CashSecuredPut;
    }

    /// @notice Shares outstanding for a vault (== credited collateral), read from the share token.
    function totalShares(uint256 vaultId) public view returns (uint256) {
        return shareToken.totalSupply(vaultId);
    }

    function remainingNotional(uint256 vaultId) public view returns (uint256) {
        VaultState storage s = _state[vaultId];
        return s.totalNotional - s.exercisedNotional;
    }

    // ------------------------------------------------------------ guards

    modifier onlyVaultOwner(uint256 vaultId) {
        _requireExists(vaultId);
        if (msg.sender != _state[vaultId].owner) revert NotVaultOwner();
        _;
    }

    function _requireExists(uint256 vaultId) internal view {
        if (vaultId == 0 || vaultId > vaultCount) revert UnknownVault();
    }

    function _requirePhase(uint256 vaultId, Phase expected) internal view {
        _requireExists(vaultId);
        Phase actual = _state[vaultId].phase;
        if (actual != expected) revert WrongPhase(expected, actual);
    }

    /// @dev Fresh spot from the vault's feed. Reverts on zero, future-dated or stale prices.
    function _readSpot(VaultTerms storage t, address quoteToken) internal view returns (uint256) {
        (uint256 price, uint256 updatedAt) = IIvyPriceFeed(t.priceFeed).spot(t.underlying, quoteToken);
        if (price == 0 || updatedAt > block.timestamp) revert InvalidPrice();
        if (block.timestamp - updatedAt > t.maxPriceAge) revert StalePrice();
        return price;
    }
}
