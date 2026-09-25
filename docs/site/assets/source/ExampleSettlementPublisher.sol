// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvySettlementPricePublication } from "../interfaces/IIvySettlementPricePublication.sol";
import "../types/IvyTypes.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Example publisher that forwards owner-supplied prices to the Hub.
/// @dev Grant this contract the Hub publisher role. It does not verify a price source.
contract ExampleSettlementPublisher is Ownable {
	IIvySettlementPricePublication public immutable hub;

	constructor(address hub_, address owner_) Ownable(owner_) {
		if (hub_ == address(0)) revert ZeroAddress();
		if (hub_.code.length == 0) revert BindingMismatch();
		hub = IIvySettlementPricePublication(hub_);
	}

	function publishExercisePrice(uint256 vaultId, uint256 price, uint64 observedAt, uint64 validUntil) external onlyOwner {
		hub.publishExercisePrice(vaultId, price, observedAt, validUntil);
	}

	function publishExpiry(uint256 vaultId, uint256 price, uint64 validUntil) external onlyOwner {
		hub.publishExpiry(vaultId, price, validUntil);
	}
}
