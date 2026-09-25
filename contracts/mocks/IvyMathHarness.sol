// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IvyMath } from "../libraries/IvyMath.sol";

contract IvyMathHarness {
	function notionalOf(bool isCall, uint256 collateralAmount, uint256 unit, uint256 strike) external pure returns (uint256) {
		return IvyMath.notionalOf(isCall, collateralAmount, unit, strike);
	}

	function premiumTotal(uint256 premiumPerUnit, uint256 notional, uint256 unit) external pure returns (uint256) {
		return IvyMath.premiumTotal(premiumPerUnit, notional, unit);
	}

	function quoteDueCeil(uint256 amount, uint256 strike, uint256 unit) external pure returns (uint256) {
		return IvyMath.quoteDueCeil(amount, strike, unit);
	}

	function quoteOutFloor(uint256 amount, uint256 strike, uint256 unit) external pure returns (uint256) {
		return IvyMath.quoteOutFloor(amount, strike, unit);
	}

	function callIntrinsic(uint256 amount, uint256 strike, uint256 spot) external pure returns (uint256) {
		return IvyMath.callIntrinsic(amount, strike, spot);
	}

	function putIntrinsic(uint256 amount, uint256 strike, uint256 spot, uint256 unit) external pure returns (uint256) {
		return IvyMath.putIntrinsic(amount, strike, spot, unit);
	}

	function spotBound(bool isCall, uint256 spot, uint16 bps) external pure returns (uint256) {
		return IvyMath.spotBound(isCall, spot, bps);
	}
}
