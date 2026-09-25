// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyBidValidator } from "../interfaces/IIvyBidValidator.sol";
import { Bid, BidContext, PairConfig, VaultTerms } from "../types/IvyTypes.sol";

contract ApproveAllValidator is IIvyBidValidator {
	function validateConfig(bytes4, VaultTerms calldata, PairConfig[] calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateConfig.selector;
	}

	function validateBid(bytes4, BidContext calldata, Bid calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateBid.selector;
	}
}

contract RejectAllValidator is IIvyBidValidator {
	error Rejected();

	function validateConfig(bytes4, VaultTerms calldata, PairConfig[] calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateConfig.selector;
	}

	function validateBid(bytes4, BidContext calldata, Bid calldata, bytes calldata) external pure returns (bytes4) {
		revert Rejected();
	}
}

contract WrongSelectorValidator is IIvyBidValidator {
	function validateConfig(bytes4, VaultTerms calldata, PairConfig[] calldata, bytes calldata) external pure returns (bytes4) {
		return 0x00000000;
	}

	function validateBid(bytes4, BidContext calldata, Bid calldata, bytes calldata) external pure returns (bytes4) {
		return 0x00000000;
	}
}

contract ConfigRevertValidator is IIvyBidValidator {
	error BadConfig();

	function validateConfig(bytes4, VaultTerms calldata, PairConfig[] calldata, bytes calldata) external pure returns (bytes4) {
		revert BadConfig();
	}

	function validateBid(bytes4, BidContext calldata, Bid calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateBid.selector;
	}
}

/// @dev Same selectors as the interface, but validateBid writes state. Under STATICCALL that reverts.
contract StateWritingValidator {
	uint256 public calls;

	function validateBid(bytes4, BidContext calldata, Bid calldata, bytes calldata) external returns (bytes4) {
		++calls;
		return IIvyBidValidator.validateBid.selector;
	}

	function validateConfig(bytes4, VaultTerms calldata, PairConfig[] calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateConfig.selector;
	}
}

/// @dev Pins the context the hub builds and doubles as a "no bids in the first N seconds" rule.
contract ContextAssertingValidator is IIvyBidValidator {
	address public immutable expectedPremiumToken;
	uint256 public immutable expectedTotalNotional;
	uint64 public immutable minAuctionAge;

	error ContextMismatch();
	error TooEarly();

	constructor(address premiumToken_, uint256 totalNotional_, uint64 minAuctionAge_) {
		expectedPremiumToken = premiumToken_;
		expectedTotalNotional = totalNotional_;
		minAuctionAge = minAuctionAge_;
	}

	function validateConfig(bytes4, VaultTerms calldata, PairConfig[] calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateConfig.selector;
	}

	function validateBid(bytes4, BidContext calldata context, Bid calldata bid, bytes calldata) external view returns (bytes4) {
		if (
			context.premiumToken != expectedPremiumToken ||
			context.totalNotional != expectedTotalNotional ||
			context.vaultId != bid.vaultId ||
			context.collateralAmount != bid.collateralAmount ||
			context.underlyingUnit == 0
		) {
			revert ContextMismatch();
		}
		if (block.timestamp < uint256(context.auctionOpenedAt) + minAuctionAge) revert TooEarly();
		return IIvyBidValidator.validateBid.selector;
	}
}

/// @dev Accepts every config but answers validateBid with another function's selector.
contract WrongBidSelectorValidator is IIvyBidValidator {
	function validateConfig(bytes4, VaultTerms calldata, PairConfig[] calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateConfig.selector;
	}

	function validateBid(bytes4, BidContext calldata, Bid calldata, bytes calldata) external pure returns (bytes4) {
		return IIvyBidValidator.validateConfig.selector;
	}
}
