// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Price source a vault owner may attach. Implemented later by Ivy; mocked in tests.
interface IIvyPriceFeed {
    /// @notice Spot price of `underlying` denominated in `quote`,
    ///         expressed in quote-token decimals per 1 whole underlying.
    /// @return price     the price (must be > 0 to be usable)
    /// @return updatedAt unix timestamp of the last update
    function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt);
}
