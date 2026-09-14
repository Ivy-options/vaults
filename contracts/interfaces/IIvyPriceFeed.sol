// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Indicative spot-price source for optional vault activation checks.
interface IIvyPriceFeed {
    /// @notice Spot price of `underlying` denominated in `quote`,
    ///         expressed in quote-token decimals per 1 whole underlying.
    /// @return price     the price (must be > 0 to be usable)
    /// @return updatedAt unix timestamp of the last update
    function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt);
}
