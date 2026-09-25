// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IvyMath } from "../libraries/IvyMath.sol";

contract IvyMathHarness {
	function notionalOf(bool isCall, uint256 c, uint256 unit, uint256 strike) external pure returns (uint256) {
		return IvyMath.notionalOf(isCall, c, unit, strike);
	}

	function premiumTotal(uint256 p, uint256 n, uint256 unit) external pure returns (uint256) {
		return IvyMath.premiumTotal(p, n, unit);
	}

	function quoteDueCeil(uint256 a, uint256 s, uint256 unit) external pure returns (uint256) {
		return IvyMath.quoteDueCeil(a, s, unit);
	}

	function quoteOutFloor(uint256 a, uint256 s, uint256 unit) external pure returns (uint256) {
		return IvyMath.quoteOutFloor(a, s, unit);
	}

	function callIntrinsic(uint256 a, uint256 s, uint256 spot) external pure returns (uint256) {
		return IvyMath.callIntrinsic(a, s, spot);
	}

	function putIntrinsic(uint256 a, uint256 s, uint256 spot, uint256 unit) external pure returns (uint256) {
		return IvyMath.putIntrinsic(a, s, spot, unit);
	}

	function spotBound(bool isCall, uint256 spot, uint16 bps) external pure returns (uint256) {
		return IvyMath.spotBound(isCall, spot, bps);
	}
}
