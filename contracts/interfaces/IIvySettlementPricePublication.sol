// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Hub write interface for optional publisher contracts. The Hub grants the caller its publisher role.
/// @dev Prices use quote-token units per whole underlying token. No price-reader implementation is required.
interface IIvySettlementPricePublication {
    function publishExercisePrice(uint256 vaultId, uint256 price, uint64 observedAt, uint64 validUntil) external;
    function publishExpiry(uint256 vaultId, uint256 price, uint64 validUntil) external;
}
