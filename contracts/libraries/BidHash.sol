// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { Bid } from "../types/IvyTypes.sol";

/// @dev EIP-712 hashing for market-maker bids. Keep the type string in sync with test/helpers/bids.ts.
library BidHash {
	bytes32 internal constant BID_TYPEHASH = keccak256(
		"Bid(uint256 vaultId,address marketMaker,address quoteToken,uint256 strike,uint256 premium,uint8 style,uint8 settlement,uint64 expiry,uint64 validUntil,uint256 nonce,uint256 auctionId,uint256 collateralAmount,bytes32 termsHash,address executor,address recipient)"
	);

	function hash(Bid calldata bid) internal pure returns (bytes32) {
		return keccak256(abi.encode(BID_TYPEHASH, bid));
	}
}
