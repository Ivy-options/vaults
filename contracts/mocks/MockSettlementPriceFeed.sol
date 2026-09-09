// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;
import {IIvySettlementPriceFeed} from "../interfaces/IIvySettlementPriceFeed.sol";

/// @notice Deliberately unrestricted observations for consumer-validation tests.
contract MockSettlementPriceFeed is IIvySettlementPriceFeed {
    struct Observation { uint256 price; uint256 observedAt; uint256 validUntil; }
    mapping(bytes32 => Observation) private _exercise;
    mapping(bytes32 => uint256) private _final;
    function set(address underlying, address quote, uint256 price, uint256 observedAt, uint256 validUntil) external {
        _exercise[keccak256(abi.encode(underlying, quote))] = Observation(price, observedAt, validUntil);
    }
    function exercisePrice(address underlying, address quote) external view returns (uint256, uint256, uint256) {
        Observation memory o = _exercise[keccak256(abi.encode(underlying, quote))];
        return (o.price, o.observedAt, o.validUntil);
    }
    function setSettlementPrice(address underlying, address quote, uint64 expiry, uint256 price) external {
        _final[keccak256(abi.encode(underlying, quote, expiry))] = price;
    }
    function settlementPrice(address underlying, address quote, uint64 expiry) external view returns (uint256) {
        return _final[keccak256(abi.encode(underlying, quote, expiry))];
    }
}
