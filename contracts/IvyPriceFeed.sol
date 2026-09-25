// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyPriceFeed } from "./interfaces/IIvyPriceFeed.sol";
import "./types/IvyTypes.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Signed off-chain spot observations for optional vault activation checks.
contract IvyPriceFeed is IIvyPriceFeed, EIP712 {
	struct Observation {
		uint256 price;
		uint64 observedAt;
	}

	bytes32 public constant SPOT_TYPEHASH = keccak256(
		"SpotReport(address underlying,address quote,uint256 price,uint64 observedAt,uint64 validUntil)"
	);

	address public immutable signer;

	mapping(bytes32 => Observation) private _spots;

	event SpotPublished(address indexed underlying, address indexed quote, uint256 price, uint64 observedAt);

	constructor(address signer_) EIP712("IvyPriceFeed", "1") {
		if (signer_ == address(0)) {
			revert ZeroAddress();
		}
		signer = signer_;
	}

	function publishSpot(address underlying, address quote, uint256 price, uint64 observedAt, uint64 validUntil, bytes calldata signature) external {
		_validate(underlying, quote, price, validUntil);
		bytes32 key = keccak256(abi.encode(underlying, quote));
		if (observedAt == 0 || observedAt > block.timestamp || observedAt <= _spots[key].observedAt) {
			revert InvalidPrice();
		}
		_verify(keccak256(abi.encode(SPOT_TYPEHASH, underlying, quote, price, observedAt, validUntil)), signature);
		_spots[key] = Observation(price, observedAt);
		emit SpotPublished(underlying, quote, price, observedAt);
	}

	function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt) {
		Observation memory o = _spots[keccak256(abi.encode(underlying, quote))];
		return (o.price, o.observedAt);
	}

	function _validate(address underlying, address quote, uint256 price, uint64 deadline) private view {
		if (underlying == address(0) || quote == address(0) || underlying == quote || price == 0) {
			revert InvalidPrice();
		}
		if (block.timestamp > deadline) {
			revert BidExpired();
		}
	}

	function _verify(bytes32 hash, bytes calldata signature) private view {
		if (!SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(hash), signature)) {
			revert BadSignature();
		}
	}
}
