// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIvyVault} from "./interfaces/IIvyVault.sol";
import {IIvyVaultsHub} from "./interfaces/IIvyVaultsHub.sol";
import "./types/IvyTypes.sol";

/// @notice Segregated custody. Premium and buyer reserves cannot fund ordinary hub transfers.
contract IvyVault is IIvyVault, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    address public hub;
    uint256 public vaultId;
    address public collateral;
    address public premiums;
    address public premiumToken;
    uint256 public premiumRemaining;
    uint256 public unwindReserved;
    bool public premiumCollected;
    uint256 public platformFeeRemaining;
    address public platformFeeRecipient;
    error InvalidPlatformFee();
    event PlatformFeeClaimed(address indexed recipient, uint256 amount);
    mapping(address => uint256) public reserved;
    mapping(address => uint256) public buyerReserved;
    modifier onlyHub() { if (msg.sender != hub) revert NotHub(); _; }
    constructor() { hub = address(0xdead); }
    function initialize(address hub_, uint256 id, address collateral_, address premiums_) external {
        if (hub != address(0)) revert AlreadyInitialized();
        if (hub_ == address(0) || collateral_ == address(0) || premiums_ == address(0)) revert ZeroAddress();
        hub = hub_; vaultId = id; collateral = collateral_; premiums = premiums_;
    }
    function deposit(uint256 amount) external nonReentrant {
        uint256 received = _pull(collateral, msg.sender, amount);
        IIvyVaultsHub(hub).onVaultDeposit(vaultId, msg.sender, received);
    }
    function pull(address token, address from, uint256 amount) external onlyHub nonReentrant returns (uint256) {
        return _pull(token, from, amount);
    }
    function push(address token, address to, uint256 amount) external onlyHub nonReentrant {
        _checkAvailable(token, amount);
        IERC20(token).safeTransfer(to, amount);
    }
    function collectPremium(address token, address from, uint256 amount, uint256 fee, address treasury) external onlyHub nonReentrant {
        if (premiumCollected) revert AlreadyInitialized();
        if (treasury == address(0)) revert ZeroAddress();
        if (fee > amount || treasury == address(this)) revert InvalidPlatformFee();
        platformFeeRemaining = fee;
        platformFeeRecipient = treasury;
        premiumCollected = true;
        premiumToken = token;
        if (amount > 0) {
            uint256 received = _pull(token, from, amount);
            if (received < amount) revert ShortReceived(amount, received);
        }
        premiumRemaining = amount - fee;
        reserved[token] += amount;
    }
    /// @notice Anyone may deliver the fee to its immutable activation recipient.
    function claimPlatformFee() external nonReentrant {
        uint256 amount = platformFeeRemaining;
        if (amount == 0) revert NothingToClaim();
        platformFeeRemaining = 0;
        reserved[premiumToken] -= amount;
        IERC20(premiumToken).safeTransfer(platformFeeRecipient, amount);
        emit PlatformFeeClaimed(platformFeeRecipient, amount);
    }
    function payPremium(address to, uint256 amount) external nonReentrant {
        if (msg.sender != premiums) revert NotPremiumModule();
        if (amount > premiumRemaining) revert InsufficientAvailable();
        premiumRemaining -= amount;
        reserved[premiumToken] -= amount;
        if (amount > 0) IERC20(premiumToken).safeTransfer(to, amount);
    }
    function fundUnwind(address from, uint256 amount) external onlyHub nonReentrant returns (uint256 received) {
        received = _pull(premiumToken, from, amount);
        if (received < amount) revert ShortReceived(amount, received);
        unwindReserved += received;
        reserved[premiumToken] += received;
    }
    function returnUnwind(address to, uint256 amount) external onlyHub nonReentrant {
        unwindReserved -= amount;
        reserved[premiumToken] -= amount;
        if (amount > 0) IERC20(premiumToken).safeTransfer(to, amount);
    }
    function consumeUnwind(uint256 amount) external onlyHub nonReentrant {
        unwindReserved -= amount;
        buyerReserved[premiumToken] += amount;
        // Both obligations are reserved: conversion must not expose funds to ordinary claims.
    }
    function reserveBuyer(address token, uint256 amount) external onlyHub nonReentrant {
        _checkAvailable(token, amount);
        buyerReserved[token] += amount;
        reserved[token] += amount;
    }
    function payBuyer(address token, address to) external onlyHub nonReentrant returns (uint256 amount) {
        amount = buyerReserved[token];
        buyerReserved[token] = 0;
        reserved[token] -= amount;
        if (amount > 0) IERC20(token).safeTransfer(to, amount);
    }
    function _checkAvailable(address token, uint256 amount) private view {
        if (amount > IERC20(token).balanceOf(address(this)) - reserved[token]) revert InsufficientAvailable();
    }
    function _pull(address token, address from, uint256 amount) private returns (uint256 received) {
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - beforeBalance;
    }
}
