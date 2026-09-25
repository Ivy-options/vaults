// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Indicative spot-price source for optional vault activation checks.
interface IIvyPriceFeed {
	/// @notice Quote-token units per whole underlying token.
	/// @return price Must be positive to be usable.
	/// @return updatedAt Unix timestamp of the observation.
	function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt);
}
