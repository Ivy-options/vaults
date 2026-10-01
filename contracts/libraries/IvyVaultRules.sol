// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyBidValidator } from "../interfaces/IIvyBidValidator.sol";
import { IIvyVaultsHubEvents } from "../interfaces/IIvyVaultsHubEvents.sol";
import "../types/IvyTypes.sol";
import { IvyMath } from "./IvyMath.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Validates vault creation and bids against hub checks and creator rules.
/// @dev Runs in Hub storage by DELEGATECALL. Validator calls use STATICCALL; reverts propagate.
///      The hub places no limit on expiry beyond "in the future"; creators bound it with an expiry rule.
library IvyVaultRules {
	bytes32 private constant BID_VALIDATOR_ROLE = keccak256("BID_VALIDATOR_ROLE");
	bytes4 private constant EXPIRY_DATES = bytes4(keccak256("ExpiryDates"));
	bytes4 private constant EXPIRY_TENOR = bytes4(keccak256("ExpiryTenor"));
	bytes4 private constant PREMIUM_MIN = bytes4(keccak256("PremiumMin"));
	bytes4 private constant STRIKE_RANGE = bytes4(keccak256("StrikeRange"));

	/// @dev Expiry is unknown until activation, so an auction exits only by pause or timeout.
	function checkWithdrawal(VaultState storage state, bool paused) external view {
		if (state.phase == Phase.Open) return;
		if (state.phase == Phase.Auction && (paused || block.timestamp >= uint256(state.auctionOpenedAt) + state.auctionTimeout)) return;
		revert WrongPhase(Phase.Open, state.phase);
	}

	function checkAuctionCancellation(VaultState storage state, bool paused, bool bidMaster) external view {
		if (state.phase != Phase.Auction) revert WrongPhase(Phase.Auction, state.phase);
		if (bidMaster) return;
		bool cancellable = paused || block.timestamp >= uint256(state.auctionOpenedAt) + state.auctionTimeout;
		if (!cancellable && msg.sender != state.owner) revert NotVaultOwner();
		if (!cancellable) revert AuctionTimeoutNotReached();
	}

	/// @dev Validates and stores each rule before deposits are possible. Returns the terms hash signed bids must carry.
	///      Requires a StrikeRange, a PremiumMin and an expiry rule (ExpiryTenor or ExpiryDates), matched by kind; their values are the validator's.
	function adoptRules(
		BidRule[] storage stored,
		VaultTerms calldata terms,
		PairConfig[] calldata pairs,
		BidRule[] calldata rules
	) external returns (bytes32) {
		bool hasStrikeRange;
		bool hasPremiumMin;
		bool hasExpiryRule;
		for (uint256 i = 0; i < rules.length; ++i) {
			BidRule calldata rule = rules[i];
			if (!IAccessControl(address(this)).hasRole(BID_VALIDATOR_ROLE, rule.validator) || rule.validator.code.length == 0) {
				revert InvalidValidator();
			}
			bytes4 ok = IIvyBidValidator(rule.validator).validateConfig(rule.kind, terms, pairs, rule.data);
			if (ok != IIvyBidValidator.validateConfig.selector) revert InvalidValidator();
			BidRule storage slot = stored.push();
			slot.validator = rule.validator;
			slot.kind = rule.kind;
			slot.data = rule.data;
			if (rule.kind == STRIKE_RANGE) hasStrikeRange = true;
			if (rule.kind == PREMIUM_MIN) hasPremiumMin = true;
			if (rule.kind == EXPIRY_TENOR || rule.kind == EXPIRY_DATES) hasExpiryRule = true;
		}
		if (!hasStrikeRange) revert MissingStrikeRange();
		if (!hasPremiumMin) revert MissingPremiumMin();
		if (!hasExpiryRule) revert MissingExpiryRule();
		return _termsHash(terms, pairs, rules);
	}

	function validateTerms(VaultTerms calldata terms, PairConfig[] calldata pairs, bool cashEnabled, uint64 exerciseWindow) external pure {
		if (terms.underlying == address(0) || terms.collateral == address(0)) revert ZeroAddress();
		bool isCall = terms.collateral == terms.underlying;
		if (terms.allowedSettlement != SettlementPolicy.Physical && !cashEnabled) revert CashSettlementDisabled();
		if (exerciseWindow == 0 && (terms.allowedSettlement != SettlementPolicy.Physical || terms.allowedExercise != ExercisePolicy.American)) {
			revert InvalidSettlementWindow();
		}
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
	///      Each data array is empty or holds one slot per rule. Emits RuleDataProvided when either is non-empty.
	function checkBid(
		VaultState storage state,
		VaultTerms storage terms,
		BidRule[] storage rules,
		address premiumToken,
		bytes32 expectedTermsHash,
		Bid calldata bid,
		uint256 supply,
		bytes[] calldata marketMakerData,
		bytes[] calldata bidMasterData
	) external returns (uint256 totalNotional) {
		if (premiumToken == address(0)) revert PairUnknown(bid.quoteToken);
		if (bid.strike == 0) revert InvalidPrice();
		if (terms.allowedExercise != ExercisePolicy.Either && uint8(terms.allowedExercise) != uint8(bid.style)) revert StyleNotAllowed();
		if (terms.allowedSettlement != SettlementPolicy.Either && uint8(terms.allowedSettlement) != uint8(bid.settlement)) {
			revert SettlementNotAllowed();
		}
		if (bid.expiry <= block.timestamp) revert ExpiryInPast();
		if (
			bid.auctionId != state.auctionId ||
			bid.collateralAmount != supply ||
			bid.termsHash != expectedTermsHash ||
			bid.marketMakerDataHash != keccak256(abi.encode(marketMakerData))
		) {
			revert CommitmentMismatch();
		}
		if (bid.recipient == address(0)) revert ZeroAddress();
		totalNotional = IvyMath.notionalOf(state.isCall, supply, state.underlyingUnit, bid.strike);
		if (totalNotional == 0) revert EmptyNotional();
		if (IvyMath.premiumTotal(bid.premiumPerUnit, totalNotional, state.underlyingUnit) == 0) revert PremiumTooLow();
		_checkSlots(rules.length, marketMakerData.length);
		_checkSlots(rules.length, bidMasterData.length);
		_runRules(state, terms, rules, premiumToken, bid, supply, totalNotional, marketMakerData, bidMasterData);
		if (marketMakerData.length != 0 || bidMasterData.length != 0) {
			emit IIvyVaultsHubEvents.RuleDataProvided(bid.vaultId, marketMakerData, bidMasterData);
		}
	}

	/// @dev Each rule gets only its own slot, so adding a rule never changes what another validator reads.
	function _runRules(
		VaultState storage state,
		VaultTerms storage terms,
		BidRule[] storage rules,
		address premiumToken,
		Bid calldata bid,
		uint256 supply,
		uint256 totalNotional,
		bytes[] calldata marketMakerData,
		bytes[] calldata bidMasterData
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
			bytes4 ok = IIvyBidValidator(rule.validator).validateBid(
				rule.kind,
				context,
				bid,
				rule.data,
				_slot(marketMakerData, i),
				_slot(bidMasterData, i)
			);
			if (ok != IIvyBidValidator.validateBid.selector) revert InvalidValidator();
		}
	}

	function _checkSlots(uint256 ruleCount, uint256 slotCount) private pure {
		if (slotCount != 0 && slotCount != ruleCount) revert RuleDataLengthMismatch(ruleCount, slotCount);
	}

	/// @dev An empty array means no data for any rule.
	function _slot(bytes[] calldata data, uint256 index) private pure returns (bytes calldata) {
		return data.length == 0 ? msg.data[0:0] : data[index];
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
					terms.minCollateral,
					terms.maxSettlementPriceAge,
					keccak256(abi.encode(pairs)),
					keccak256(abi.encode(rules))
				)
			);
	}
}
