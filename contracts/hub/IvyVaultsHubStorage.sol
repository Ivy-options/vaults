// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IIvyVaultsHubErrors} from "../interfaces/IIvyVaultsHubErrors.sol";
import {IIvyVaultsHubEvents} from "../interfaces/IIvyVaultsHubEvents.sol";
import {IIvyShares} from "../interfaces/IIvyShares.sol";
import {IvyPremiums} from "../IvyPremiums.sol";
import {IvyUnwind} from "../IvyUnwind.sol";
import "../types/IvyTypes.sol";

/// @dev Storage layout, roles, settings, views and shared guards for the immutable hub.
abstract contract IvyVaultsHubStorage is
    IIvyVaultsHubEvents,
    IIvyVaultsHubErrors,
    AccessControl,
    EIP712,
    ReentrancyGuardTransient
{
    bytes32 public constant BID_MASTER_ROLE = keccak256("BID_MASTER_ROLE");
    bytes32 public constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");

    address public immutable vaultImplementation;
    IvyPremiums public immutable premiums;
    IvyUnwind public immutable unwind;
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant PLATFORM_FEE_MANAGER_ROLE = keccak256("PLATFORM_FEE_MANAGER_ROLE");
    uint16 public platformFeeBps;
    address public platformTreasury;
    mapping(uint256 => uint16) public maxPlatformFeeBps;
    struct PlatformFee { uint16 rateBps; address recipient; uint256 amount; }
    mapping(uint256 => PlatformFee) public platformFees;
    event PlatformFeeBpsUpdated(uint16 oldRate, uint16 newRate);
    event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);
    event PlatformFeeAllocated(uint256 indexed vaultId, address indexed recipient, uint16 rateBps, uint256 amount);
    error InvalidPlatformFee();
    error PlatformFeeAboveCap();
    bool public paused;
    bool public transfersEnabled;
    event TransfersEnabledUpdated(bool enabled);
    mapping(uint256 => bool) public vaultPaused;
    uint64 public exerciseWindow;
    uint64 public auctionTimeout;
    uint256 public vaultCount;

    mapping(uint256 vaultId => VaultTerms) internal _terms;
    mapping(uint256 vaultId => VaultState) internal _state;
    mapping(uint256 vaultId => mapping(address quoteToken => PairTerms)) internal _pairTerms;
    mapping(uint256 vaultId => address[]) internal _quoteTokens;
    mapping(address marketMaker => mapping(uint256 nonce => bool)) public usedBidNonces;
    IIvyShares public immutable shareToken;

    constructor(address admin, address implementation, address shares_, address premiums_, address unwind_, uint64 window_, uint64 timeout_)
        EIP712("IvyVaultsHub", "2")
    {
        if (admin == address(0) || implementation == address(0) || shares_ == address(0) || premiums_ == address(0) || unwind_ == address(0)) revert ZeroAddress();
        if (implementation.code.length == 0) revert BindingMismatch();
        vaultImplementation = implementation;
        shareToken = IIvyShares(shares_);
        premiums = IvyPremiums(premiums_);
        unwind = IvyUnwind(unwind_);
        exerciseWindow = window_;
        auctionTimeout = timeout_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        _grantRole(PLATFORM_FEE_MANAGER_ROLE, admin);
        platformTreasury = admin;
    }

    function _admission(uint256 vaultId) internal view {
        if (paused || vaultPaused[vaultId]) revert AdmissionPaused();
    }


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

}
