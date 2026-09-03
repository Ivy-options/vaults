// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIvyVault} from "./interfaces/IIvyVault.sol";
import {IIvyVaultsHub} from "./interfaces/IIvyVaultsHub.sol";
import {NotHub, AlreadyInitialized, ZeroAddress} from "./types/IvyTypes.sol";

/// @title IvyVault
/// @notice A logic-free token box. Cloned per vault by IvyVaultsHub; moves tokens only on the hub's instruction.
///         Users approve this address (never the hub) for deposits, premium and settlement.
contract IvyVault is IIvyVault {
    using SafeERC20 for IERC20;

    address public hub;
    uint256 public vaultId;
    address public collateral;

    modifier onlyHub() {
        if (msg.sender != hub) revert NotHub();
        _;
    }

    /// @dev Locks the implementation itself; clones start with empty storage and can be initialized.
    constructor() {
        hub = address(0xdead);
    }

    function initialize(address hub_, uint256 vaultId_, address collateral_) external {
        if (hub != address(0)) revert AlreadyInitialized();
        if (hub_ == address(0) || collateral_ == address(0)) revert ZeroAddress();
        hub = hub_;
        vaultId = vaultId_;
        collateral = collateral_;
    }

    function deposit(uint256 amount) external {
        uint256 received = _pull(collateral, msg.sender, amount);
        IIvyVaultsHub(hub).onVaultDeposit(vaultId, msg.sender, received);
    }

    function pull(address token, address from, uint256 amount) external onlyHub returns (uint256 received) {
        return _pull(token, from, amount);
    }

    function push(address token, address to, uint256 amount) external onlyHub {
        IERC20(token).safeTransfer(to, amount);
    }

    function _pull(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
    }
}
