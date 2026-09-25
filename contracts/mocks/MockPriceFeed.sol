// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyPriceFeed } from "../interfaces/IIvyPriceFeed.sol";

contract MockPriceFeed is IIvyPriceFeed {
	struct Quote {
		uint256 price;
		uint256 updatedAt;
	}

	mapping(address => mapping(address => Quote)) public quotes;
	bool public shouldRevert;

	function set(address underlying, address quote, uint256 price, uint256 updatedAt) external {
		quotes[underlying][quote] = Quote(price, updatedAt);
	}

	function setRevert(bool value) external {
		shouldRevert = value;
	}

	function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt) {
		require(!shouldRevert, "feed down");
		Quote memory stored = quotes[underlying][quote];
		return (stored.price, stored.updatedAt);
	}
}
