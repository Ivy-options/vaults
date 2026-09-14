// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IHubDeposits {
    function deposit(uint256 vaultId, uint256 amount) external;
    function withdraw(uint256 vaultId, uint256 shares) external;
}

/// @dev Test contract that deposits into the hub and, from inside the ERC-1155 mint callback,
///      tries to re-enter the hub. Mode 0: behave; 1: re-enter deposit; 2: re-enter withdraw.
contract ReenteringDepositor is IERC1155Receiver {
    IHubDeposits public immutable hub;
    uint256 public mode;
    uint256 public callbacks;

    constructor(address hub_) {
        hub = IHubDeposits(hub_);
    }

    function setMode(uint256 mode_) external {
        mode = mode_;
    }

    function approveVault(address token, address vault, uint256 amount) external {
        IERC20(token).approve(vault, amount);
    }

    function deposit(uint256 vaultId, uint256 amount) external {
        hub.deposit(vaultId, amount);
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata) external returns (bytes4) {
        callbacks++;
        if (mode == 1) hub.deposit(id, 1);
        if (mode == 2) hub.withdraw(id, 1);
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external pure returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
