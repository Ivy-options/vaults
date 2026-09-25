// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test token with configurable decimals and an optional burn-on-transfer fee.
contract MockERC20 is ERC20 {
	uint8 private immutable _decimals;

	uint256 public feeBps;
	mapping(address => bool) public blockedRecipients;

	error RecipientBlocked();

	constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
		_decimals = decimals_;
	}

	function mint(address to, uint256 amount) external {
		_mint(to, amount);
	}

	function setFeeBps(uint256 bps) external {
		feeBps = bps;
	}

	function setBlockedRecipient(address recipient, bool blocked) external {
		blockedRecipients[recipient] = blocked;
	}

	function decimals() public view override returns (uint8) {
		return _decimals;
	}

	function _update(address from, address to, uint256 value) internal override {
		if (blockedRecipients[to]) {
			revert RecipientBlocked();
		}
		if (feeBps != 0 && from != address(0) && to != address(0)) {
			uint256 fee = (value * feeBps) / 10_000;
			super._update(from, address(0), fee);
			value -= fee;
		}
		super._update(from, to, value);
	}
}
