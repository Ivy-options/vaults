// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

library IvyMath {
	uint256 internal constant BPS = 10_000;

	/// @dev Covered calls use collateral as notional. Puts divide collateral by strike; zero strike yields zero.
	function notionalOf(bool isCall, uint256 collateralAmount, uint256 underlyingUnit, uint256 strike) internal pure returns (uint256) {
		if (isCall) {
			return collateralAmount;
		}
		if (strike == 0) {
			return 0;
		}
		return (collateralAmount * underlyingUnit) / strike;
	}

	/// @dev `premiumPerUnit` is priced per whole underlying token.
	function premiumTotal(uint256 premiumPerUnit, uint256 notional, uint256 underlyingUnit) internal pure returns (uint256) {
		return (premiumPerUnit * notional) / underlyingUnit;
	}

	/// @dev Quote owed by the market maker, rounded up.
	function quoteDueCeil(uint256 amount, uint256 strike, uint256 underlyingUnit) internal pure returns (uint256) {
		return Math.ceilDiv(amount * strike, underlyingUnit);
	}

	/// @dev Quote received by the market maker, rounded down.
	function quoteOutFloor(uint256 amount, uint256 strike, uint256 underlyingUnit) internal pure returns (uint256) {
		return (amount * strike) / underlyingUnit;
	}

	/// @dev Cash call payout in underlying units, always less than `amount`.
	function callIntrinsic(uint256 amount, uint256 strike, uint256 spot) internal pure returns (uint256) {
		if (spot <= strike) {
			return 0;
		}
		return (amount * (spot - strike)) / spot;
	}

	/// @dev Cash put payout in quote units, below the quote locked for `amount`.
	function putIntrinsic(uint256 amount, uint256 strike, uint256 spot, uint256 underlyingUnit) internal pure returns (uint256) {
		if (strike <= spot) {
			return 0;
		}
		return (amount * (strike - spot)) / underlyingUnit;
	}

	/// @dev Oracle-relative strike bound. Calls: a floor below spot. Puts: a ceiling above spot.
	function spotBound(bool isCall, uint256 spot, uint16 deviationBps) internal pure returns (uint256) {
		if (isCall) {
			return (spot * (BPS - deviationBps)) / BPS;
		}
		return (spot * (BPS + deviationBps)) / BPS;
	}
}
