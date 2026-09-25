// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyPayoutReceiver } from "../interfaces/IIvyPayoutReceiver.sol";

/// @dev Answers the payout hook with the right selector, but in `returnSize` bytes of return data.
contract OddSizePayoutReceiver {
	uint256 public immutable returnSize;
	uint256 public calls;

	constructor(uint256 returnSize_) {
		returnSize = returnSize_;
	}

	fallback() external {
		++calls;
		bytes4 selector = IIvyPayoutReceiver.onIvyPayout.selector;
		uint256 size = returnSize;
		assembly ("memory-safe") {
			mstore(0, selector)
			mstore(0x20, 0)
			return(0, size)
		}
	}
}
