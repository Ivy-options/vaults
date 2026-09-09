// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Authoritative quote-token units per whole underlying; distinct from activation pricing.
interface IIvySettlementPriceFeed {
    function exercisePrice(address underlying, address quote) external view returns (uint256 price, uint256 observedAt, uint256 validUntil);
    function settlementPrice(address underlying, address quote, uint64 expiry) external view returns (uint256 price);
}
