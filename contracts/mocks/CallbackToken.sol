// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Models a callback after transfer, including a sender hook able to transfer approved shares.
contract CallbackToken is ERC20 {
    address public callbackTarget;
    bytes public data;
    bool public enabled;
    bool public callbackSucceeded;

    constructor() ERC20("Callback", "CB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function approveSelf(address spender, uint256 amount) external {
        _approve(address(this), spender, amount);
    }

    function arm(address target_, bytes calldata data_) external {
        callbackTarget = target_;
        data = data_;
        enabled = true;
        callbackSucceeded = false;
    }

    function roundTrip(address shares, address holder, uint256 id, uint256 amount) external {
        IERC1155(shares).safeTransferFrom(holder, address(this), id, amount, "");
        IERC1155(shares).safeTransferFrom(address(this), holder, id, amount, "");
    }

    function disarm() external {
        enabled = false;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (enabled && from != address(0)) {
            enabled = false;
            (callbackSucceeded,) = callbackTarget.call(data);
        }
    }
}
