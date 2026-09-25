// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyBidValidator } from "../interfaces/IIvyBidValidator.sol";
import "../types/IvyTypes.sol";
import { IvyMath } from "./IvyMath.sol";

/// @notice Validates vault creation and bids against hub checks and creator rules.
/// @dev Runs in Hub storage by DELEGATECALL. Validator calls use STATICCALL; reverts propagate.
library IvyVaultRules {
	/// @dev Validates and stores each rule before deposits are possible. Returns the terms hash signed bids must carry.
	function adoptRules(
		BidRule[] storage stored,
		VaultTerms calldata terms,
		PairConfig[] calldata pairs,
		BidRule[] calldata rules
	) external returns (bytes32) {
		for (uint256 i = 0; i < rules.length; ++i) {
			BidRule calldata rule = rules[i];
			if (rule.validator == address(0) || rule.validator.code.length == 0) revert InvalidValidator();
			bytes4 ok = IIvyBidValidator(rule.validator).validateConfig(rule.kind, terms, pairs, rule.data);
			if (ok != IIvyBidValidator.validateConfig.selector) revert InvalidValidator();
			BidRule storage slot = stored.push();
			slot.validator = rule.validator;
			slot.kind = rule.kind;
			slot.data = rule.data;
		}
		return _termsHash(terms, pairs, rules);
	}

	function validateTerms(VaultTerms calldata terms, PairConfig[] calldata pairs) external view {
		if (terms.underlying == address(0) || terms.collateral == address(0)) revert ZeroAddress();
		if (terms.expiry <= block.timestamp) revert ExpiryInPast();
		bool isCall = terms.collateral == terms.underlying;
		if (terms.allowedSettlement != SettlementPolicy.Physical && terms.maxSettlementPriceAge == 0) revert CashSettlementNeedsMaxPriceAge();
		if (pairs.length == 0) revert NoPairs();
		if (!isCall) {
			if (pairs.length != 1) revert PutRequiresSinglePair();
			if (pairs[0].quoteToken != terms.collateral) revert PutPairMustBeCollateral();
		}
		for (uint256 i = 0; i < pairs.length; ++i) {
			PairConfig calldata pair = pairs[i];
			if (pair.quoteToken == address(0) || pair.premiumToken == address(0)) revert ZeroAddress();
			if (isCall && pair.quoteToken == terms.underlying) revert QuoteIsUnderlying();
			for (uint256 j = 0; j < i; ++j) {
				if (pairs[j].quoteToken == pair.quoteToken) revert DuplicatePair(pair.quoteToken);
			}
		}
	}

	/// @dev The Hub checks caller and signature first. Mandatory checks run before creator rules, in order.
	function checkBid(
		VaultState storage state,
		VaultTerms storage terms,
		BidRule[] storage rules,
		address premiumToken,
		bytes32 expectedTermsHash,
		Bid calldata bid,
		uint256 supply
	) external view returns (uint256 totalNotional) {
		if (premiumToken == address(0)) revert PairUnknown(bid.quoteToken);
		if (terms.allowedExercise != ExercisePolicy.Either && uint8(terms.allowedExercise) != uint8(bid.style)) revert StyleNotAllowed();
		if (terms.allowedSettlement != SettlementPolicy.Either && uint8(terms.allowedSettlement) != uint8(bid.settlement)) {
			revert SettlementNotAllowed();
		}
		if (bid.expiry <= block.timestamp) revert ExpiryInPast();
		if (bid.expiry != terms.expiry || bid.auctionId != state.auctionId || bid.collateralAmount != supply || bid.termsHash != expectedTermsHash) {
			revert CommitmentMismatch();
		}
		if (bid.recipient == address(0)) revert ZeroAddress();
		totalNotional = IvyMath.notionalOf(state.isCall, supply, state.underlyingUnit, bid.strike);
		if (totalNotional == 0) revert EmptyNotional();
		_runRules(state, terms, rules, premiumToken, bid, supply, totalNotional);
	}

	function _runRules(
		VaultState storage state,
		VaultTerms storage terms,
		BidRule[] storage rules,
		address premiumToken,
		Bid calldata bid,
		uint256 supply,
		uint256 totalNotional
	) private view {
		BidContext memory context = BidContext({
			vaultId: bid.vaultId,
			isCall: state.isCall,
			underlying: terms.underlying,
			collateral: terms.collateral,
			premiumToken: premiumToken,
			underlyingUnit: state.underlyingUnit,
			collateralAmount: supply,
			totalNotional: totalNotional,
			auctionOpenedAt: state.auctionOpenedAt
		});
		for (uint256 i = 0; i < rules.length; ++i) {
			BidRule storage rule = rules[i];
			bytes4 ok = IIvyBidValidator(rule.validator).validateBid(rule.kind, context, bid, rule.data);
			if (ok != IIvyBidValidator.validateBid.selector) revert InvalidValidator();
		}
	}

	/// @dev Hashes creator terms, pairs, and rules. `auctionStartsAt` is mutable and excluded.
	function _termsHash(VaultTerms calldata terms, PairConfig[] calldata pairs, BidRule[] calldata rules) private pure returns (bytes32) {
		return
			keccak256(
				abi.encode(
					terms.underlying,
					terms.collateral,
					terms.allowPartialExercise,
					terms.publicDeposits,
					terms.allowedExercise,
					terms.allowedSettlement,
					terms.expiry,
					terms.minCollateral,
					terms.maxSettlementPriceAge,
					keccak256(abi.encode(pairs)),
					keccak256(abi.encode(rules))
				)
			);
	}
}
