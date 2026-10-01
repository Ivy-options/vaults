// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { Bid, BidContext, PairConfig, VaultTerms } from "../types/IvyTypes.sol";

/// @notice Creator-selected bid rule validator.
/// @dev The Hub calls through STATICCALL. Each method must return its own selector; reverts propagate.
interface IIvyBidValidator {
	/// @notice Check rule configuration at vault creation.
	/// @return IIvyBidValidator.validateConfig.selector
	function validateConfig(bytes4 kind, VaultTerms calldata terms, PairConfig[] calldata pairs, bytes calldata data) external view returns (bytes4);

	/// @notice Check a bid after the Hub's mandatory checks.
	/// @dev Each input is this rule's own slot; a validator never sees another rule's data. Empty means none was supplied.
	/// @param config The creator's rule data, frozen at creation.
	/// @param marketMakerData Signed by the market maker through `bid.marketMakerDataHash`. A counterparty claim, not a market fact.
	/// @param bidMasterData Supplied unsigned by the bid master at activation. Trust it only as far as you trust the bid master.
	/// @return IIvyBidValidator.validateBid.selector
	function validateBid(
		bytes4 kind,
		BidContext calldata context,
		Bid calldata bid,
		bytes calldata config,
		bytes calldata marketMakerData,
		bytes calldata bidMasterData
	) external view returns (bytes4);
}
