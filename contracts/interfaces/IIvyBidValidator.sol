// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {Bid, BidContext, PairConfig, VaultTerms} from "../types/IvyTypes.sol";

/// @notice A creator-chosen judge of bids. The hub reaches both functions through STATICCALL and
///         treats any return other than the function's own selector as rejection. Reverts bubble up.
interface IIvyBidValidator {
    /// @notice Reject an unknown kind or malformed rule data for this vault. Called once, at creation.
    /// @return IIvyBidValidator.validateConfig.selector
    function validateConfig(bytes4 kind, VaultTerms calldata terms, PairConfig[] calldata pairs, bytes calldata data)
        external
        view
        returns (bytes4);

    /// @notice Reject an unacceptable bid. Called once per activation attempt, after every mandatory hub check.
    /// @return IIvyBidValidator.validateBid.selector
    function validateBid(bytes4 kind, BidContext calldata context, Bid calldata bid, bytes calldata data)
        external
        view
        returns (bytes4);
}
