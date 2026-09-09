// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IIvySettlementPriceFeed} from "./interfaces/IIvySettlementPriceFeed.sol";
import "./types/IvyTypes.sol";

/// @notice Role-authorized payment observations. Revocation prevents new reports, not use of stored reports.
contract IvySettlementPriceFeed is IIvySettlementPriceFeed, AccessControl {
    bytes32 public constant SETTLEMENT_PRICE_PUBLISHER_ROLE = keccak256("SETTLEMENT_PRICE_PUBLISHER_ROLE");
    struct Observation { uint256 price; uint64 observedAt; uint64 validUntil; }
    mapping(bytes32 => Observation) private _exercise;
    mapping(bytes32 => uint256) private _final;
    event ExercisePricePublished(address indexed underlying, address indexed quote, uint256 price, uint64 observedAt, uint64 validUntil);
    event ExpiryPublished(address indexed underlying, address indexed quote, uint64 indexed expiry, uint256 price, uint64 validUntil);

    constructor(address admin, address publisher) {
        if (admin == address(0) || publisher == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SETTLEMENT_PRICE_PUBLISHER_ROLE, publisher);
    }

    function publishExercisePrice(address underlying, address quote, uint256 price, uint64 observedAt, uint64 validUntil)
        external onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE)
    {
        _validate(underlying, quote, price, validUntil);
        bytes32 key = keccak256(abi.encode(underlying, quote));
        if (observedAt == 0 || observedAt > block.timestamp || observedAt <= _exercise[key].observedAt) revert InvalidPrice();
        _exercise[key] = Observation(price, observedAt, validUntil);
        emit ExercisePricePublished(underlying, quote, price, observedAt, validUntil);
    }

    function publishExpiry(address underlying, address quote, uint64 expiry, uint256 price, uint64 validUntil)
        external onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE)
    {
        _validate(underlying, quote, price, validUntil);
        if (expiry == 0 || block.timestamp < expiry) revert ExpirationNotReached();
        bytes32 key = keccak256(abi.encode(underlying, quote, expiry));
        if (_final[key] != 0) revert ReportFinalized();
        _final[key] = price;
        emit ExpiryPublished(underlying, quote, expiry, price, validUntil);
    }

    function exercisePrice(address underlying, address quote) external view returns (uint256 price, uint256 observedAt, uint256 validUntil) {
        Observation memory o = _exercise[keccak256(abi.encode(underlying, quote))];
        return (o.price, o.observedAt, o.validUntil);
    }

    function settlementPrice(address underlying, address quote, uint64 expiry) external view returns (uint256 price) {
        price = _final[keccak256(abi.encode(underlying, quote, expiry))];
        if (price == 0) revert ReportUnavailable();
    }

    function _validate(address underlying, address quote, uint256 price, uint64 validUntil) private view {
        if (underlying == address(0) || quote == address(0) || underlying == quote || price == 0) revert InvalidPrice();
        if (block.timestamp > validUntil) revert BidExpired();
    }
}
