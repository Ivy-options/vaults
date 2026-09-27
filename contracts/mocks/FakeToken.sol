// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Public faucet token for testing. Anyone can mint; tokens have no backing.
contract FakeToken is ERC20 {
	uint8 private immutable tokenDecimals;

	constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
		tokenDecimals = decimals_;
	}

	function mint(address recipient, uint256 amount) external {
		_mint(recipient, amount);
	}

	function decimals() public view override returns (uint8) {
		return tokenDecimals;
	}
}
