// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IIvyPriceFeed} from "./interfaces/IIvyPriceFeed.sol";
import "./types/IvyTypes.sol";

/// @notice Ivy attests off-chain observations. Final expiry prices are write-once.
contract IvyPriceFeed is IIvyPriceFeed, EIP712 {
    address public immutable signer;
    bytes32 public constant SPOT_TYPEHASH = keccak256("SpotReport(address underlying,address quote,uint256 price,uint64 observedAt,uint64 validUntil)");
    bytes32 public constant EXPIRY_TYPEHASH = keccak256("ExpiryReport(address underlying,address quote,uint64 expiry,uint256 price,uint64 validUntil)");
    struct Observation { uint256 price; uint64 observedAt; }
    mapping(bytes32 => Observation) private _spots;
    mapping(bytes32 => uint256) private _final;
    event SpotPublished(address indexed underlying, address indexed quote, uint256 price, uint64 observedAt);
    event ExpiryPublished(address indexed underlying, address indexed quote, uint64 indexed expiry, uint256 price);
    constructor(address signer_) EIP712("IvyPriceFeed", "1") {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
    }
    function publishSpot(address underlying, address quote, uint256 price, uint64 observedAt, uint64 validUntil, bytes calldata signature) external {
        _validate(underlying, quote, price, validUntil);
        bytes32 key = keccak256(abi.encode(underlying, quote));
        if (observedAt == 0 || observedAt > block.timestamp || observedAt <= _spots[key].observedAt) revert InvalidPrice();
        _verify(keccak256(abi.encode(SPOT_TYPEHASH, underlying, quote, price, observedAt, validUntil)), signature);
        _spots[key] = Observation(price, observedAt);
        emit SpotPublished(underlying, quote, price, observedAt);
    }
    function publishExpiry(address underlying, address quote, uint64 expiry, uint256 price, uint64 validUntil, bytes calldata signature) external {
        _validate(underlying, quote, price, validUntil);
        if (expiry == 0 || block.timestamp < expiry) revert SettlementNotReached();
        bytes32 key = keccak256(abi.encode(underlying, quote, expiry));
        if (_final[key] != 0) revert ReportFinalized();
        _verify(keccak256(abi.encode(EXPIRY_TYPEHASH, underlying, quote, expiry, price, validUntil)), signature);
        _final[key] = price;
        emit ExpiryPublished(underlying, quote, expiry, price);
    }
    function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt) {
        Observation memory o = _spots[keccak256(abi.encode(underlying, quote))];
        return (o.price, o.observedAt);
    }
    function settlementPrice(address underlying, address quote, uint64 expiry) external view returns (uint256) {
        uint256 price = _final[keccak256(abi.encode(underlying, quote, expiry))];
        if (price == 0) revert ReportUnavailable();
        return price;
    }
    function _validate(address underlying, address quote, uint256 price, uint64 deadline) private view {
        if (underlying == address(0) || quote == address(0) || underlying == quote || price == 0) revert InvalidPrice();
        if (block.timestamp > deadline) revert BidExpired();
    }
    function _verify(bytes32 hash, bytes calldata signature) private view {
        if (!SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(hash), signature)) revert BadSignature();
    }
}
