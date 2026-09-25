// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { BidHash } from "../libraries/BidHash.sol";
import { Bid } from "../types/IvyTypes.sol";

contract BidHashHarness {
	function typehash() external pure returns (bytes32) {
		return BidHash.BID_TYPEHASH;
	}

	function hash(Bid calldata bid) external pure returns (bytes32) {
		return BidHash.hash(bid);
	}
}
