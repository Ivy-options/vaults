// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Hub interface for settlement price publishers.
/// @dev The caller needs the Hub publisher role. Prices use quote-token units per whole underlying token.
///      Publishing is write-only; no price-reader interface is required.
interface IIvySettlementPricePublication {
	function publishExercisePrice(uint256 vaultId, uint256 price, uint64 observedAt, uint64 validUntil) external;

	function publishExpiryPrice(uint256 vaultId, uint256 price, uint64 validUntil) external;
}
