// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IIvySettlementPricePublication} from "../interfaces/IIvySettlementPricePublication.sol";
import "../types/IvyTypes.sol";

/// @notice Optional example: its owner supplies prices and this contract submits them to the Hub.
/// @dev Grant this contract the Hub publisher role. A production adapter can replace owner-supplied
///      observations with authenticated source logic; the Hub never calls back into the publisher.
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
