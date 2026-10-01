// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyBidValidator } from "./interfaces/IIvyBidValidator.sol";
import { IIvyPriceFeed } from "./interfaces/IIvyPriceFeed.sol";
import { IvyMath } from "./libraries/IvyMath.sol";
import "./types/IvyTypes.sol";

/// @notice Stateless validator for the standard bid rule kinds.
/// @dev Each kind is named for the bid field it bounds. Strike: StrikeRange, StrikeSpotBand.
///      Premium: PremiumMin, PremiumSpotFloor, PremiumYieldFloor, PremiumVolFloor. Expiry: ExpiryTenor, ExpiryDates.
///      PremiumVolFloor trusts the bid master's attestation. No kind reads market-maker data.
contract IvyStandardBidRules is IIvyBidValidator {
	address public immutable trustedPriceFeed;

	struct StrikeRange {
		address quoteToken;
		uint256 minStrike; // quote units per whole underlying; 0 < minStrike <= maxStrike
		uint256 maxStrike;
	}

	struct PremiumMin {
		address quoteToken;
		uint256 minPremiumPerUnit; // premium-token units per 1 whole underlying, > 0
	}

	struct StrikeSpotBandRule {
		address priceFeed;
		uint32 maxPriceAge; // seconds, > 0
		uint16 maxInTheMoneyBps; // calls: strike >= spot * (1 - bps); puts: strike <= spot * (1 + bps)
		uint32 maxOutOfTheMoneyBps; // calls: strike <= spot * (1 + bps); puts: strike >= spot * (1 - bps), no floor from 10_000
	}

	struct PremiumSpotFloorRule {
		address priceFeed; // may be zero when every pair pays premium in the underlying
		uint32 maxPriceAge;
		uint16 minPremiumBps; // premiumPerUnit >= spot * minPremiumBps / 10_000, in (0, 10_000]
	}

	struct PremiumYieldFloorRule {
		address priceFeed; // may be zero when every pair pays premium in the underlying
		uint32 maxPriceAge;
		uint16 minAprBps; // premiumPerUnit >= spot * minAprBps / 10_000 * tenor / 365 days, > 0
	}

	struct ExpiryTenorRule {
		uint64 minTenor; // seconds from activation to expiry
		uint64 maxTenor; // > 0 and >= minTenor
	}

	struct ExpiryDatesRule {
		uint64 notBefore; // absolute Unix time
		uint64 notAfter; // absolute Unix time, >= notBefore and in the future at creation
	}

	bytes4 public constant EXPIRY_DATES = bytes4(keccak256("ExpiryDates"));
	bytes4 public constant EXPIRY_TENOR = bytes4(keccak256("ExpiryTenor"));
	bytes4 public constant PREMIUM_MIN = bytes4(keccak256("PremiumMin"));
	bytes4 public constant PREMIUM_SPOT_FLOOR = bytes4(keccak256("PremiumSpotFloor"));
	bytes4 public constant PREMIUM_VOL_FLOOR = bytes4(keccak256("PremiumVolFloor"));
	bytes4 public constant PREMIUM_YIELD_FLOOR = bytes4(keccak256("PremiumYieldFloor"));
	bytes4 public constant STRIKE_RANGE = bytes4(keccak256("StrikeRange"));
	bytes4 public constant STRIKE_SPOT_BAND = bytes4(keccak256("StrikeSpotBand"));
	uint256 private constant YEAR = 365 days;

	constructor(address trustedPriceFeed_) {
		if (trustedPriceFeed_.code.length == 0) revert BindingMismatch();
		trustedPriceFeed = trustedPriceFeed_;
	}

	/// @inheritdoc IIvyBidValidator
	function validateConfig(bytes4 kind, VaultTerms calldata terms, PairConfig[] calldata pairs, bytes calldata data) external view returns (bytes4) {
		bool isCall = terms.collateral == terms.underlying;
		if (kind == STRIKE_RANGE) {
			StrikeRange[] memory ranges = abi.decode(data, (StrikeRange[]));
			address[] memory quoteTokens = new address[](ranges.length);
			for (uint256 i = 0; i < ranges.length; ++i) {
				if (ranges[i].minStrike == 0 || ranges[i].minStrike > ranges[i].maxStrike) revert InvalidStrikeRange();
				quoteTokens[i] = ranges[i].quoteToken;
			}
			_checkCoversPairs(pairs, quoteTokens);
		} else if (kind == PREMIUM_MIN) {
			PremiumMin[] memory mins = abi.decode(data, (PremiumMin[]));
			address[] memory quoteTokens = new address[](mins.length);
			for (uint256 i = 0; i < mins.length; ++i) {
				if (mins[i].minPremiumPerUnit == 0) revert PremiumTooLow();
				quoteTokens[i] = mins[i].quoteToken;
			}
			_checkCoversPairs(pairs, quoteTokens);
		} else if (kind == STRIKE_SPOT_BAND) {
			StrikeSpotBandRule memory rule = abi.decode(data, (StrikeSpotBandRule));
			_checkFeed(rule.priceFeed, rule.maxPriceAge);
			if (isCall && rule.maxInTheMoneyBps > IvyMath.BPS) revert DeviationTooLarge();
		} else if (kind == PREMIUM_SPOT_FLOOR) {
			PremiumSpotFloorRule memory rule = abi.decode(data, (PremiumSpotFloorRule));
			if (rule.minPremiumBps == 0 || rule.minPremiumBps > IvyMath.BPS) revert InvalidPremiumFloor();
			_checkPremiumFeed(terms, pairs, rule.priceFeed, rule.maxPriceAge);
		} else if (kind == PREMIUM_YIELD_FLOOR) {
			PremiumYieldFloorRule memory rule = abi.decode(data, (PremiumYieldFloorRule));
			if (rule.minAprBps == 0) revert InvalidPremiumFloor();
			_checkPremiumFeed(terms, pairs, rule.priceFeed, rule.maxPriceAge);
		} else if (kind == EXPIRY_TENOR) {
			ExpiryTenorRule memory rule = abi.decode(data, (ExpiryTenorRule));
			if (rule.maxTenor == 0 || rule.minTenor > rule.maxTenor) revert InvalidExpiryTenor();
		} else if (kind == EXPIRY_DATES) {
			ExpiryDatesRule memory rule = abi.decode(data, (ExpiryDatesRule));
			if (rule.notBefore > rule.notAfter || rule.notAfter <= block.timestamp) revert InvalidExpiryDates();
		} else if (kind == PREMIUM_VOL_FLOOR) {
			if (abi.decode(data, (uint32)) == 0) revert InvalidVolFloor();
		} else {
			revert UnknownRuleKind(kind);
		}
		return IIvyBidValidator.validateConfig.selector;
	}

	/// @inheritdoc IIvyBidValidator
	function validateBid(
		bytes4 kind,
		BidContext calldata context,
		Bid calldata bid,
		bytes calldata config,
		bytes calldata,
		bytes calldata bidMasterData
	) external view returns (bytes4) {
		if (kind == STRIKE_RANGE) {
			StrikeRange memory range = _strikeRangeFor(abi.decode(config, (StrikeRange[])), bid.quoteToken);
			if (bid.strike < range.minStrike) revert StrikeBelowRange();
			if (bid.strike > range.maxStrike) revert StrikeAboveRange();
		} else if (kind == PREMIUM_MIN) {
			if (bid.premiumPerUnit < _premiumMinFor(abi.decode(config, (PremiumMin[])), bid.quoteToken)) revert PremiumTooLow();
		} else if (kind == STRIKE_SPOT_BAND) {
			_checkStrikeSpotBand(context, bid, abi.decode(config, (StrikeSpotBandRule)));
		} else if (kind == PREMIUM_SPOT_FLOOR) {
			PremiumSpotFloorRule memory rule = abi.decode(config, (PremiumSpotFloorRule));
			uint256 spot = _premiumSpot(context, rule.priceFeed, rule.maxPriceAge);
			if (bid.premiumPerUnit * IvyMath.BPS < spot * rule.minPremiumBps) revert PremiumTooLow();
		} else if (kind == PREMIUM_YIELD_FLOOR) {
			PremiumYieldFloorRule memory rule = abi.decode(config, (PremiumYieldFloorRule));
			uint256 spot = _premiumSpot(context, rule.priceFeed, rule.maxPriceAge);
			// The Hub has already required expiry > block.timestamp.
			uint256 tenor = bid.expiry - block.timestamp;
			if (bid.premiumPerUnit * IvyMath.BPS * YEAR < spot * rule.minAprBps * tenor) revert PremiumTooLow();
		} else if (kind == EXPIRY_TENOR) {
			ExpiryTenorRule memory rule = abi.decode(config, (ExpiryTenorRule));
			if (bid.expiry < block.timestamp + rule.minTenor || bid.expiry > block.timestamp + rule.maxTenor) revert ExpiryOutsideTenor();
		} else if (kind == EXPIRY_DATES) {
			ExpiryDatesRule memory rule = abi.decode(config, (ExpiryDatesRule));
			if (bid.expiry < rule.notBefore || bid.expiry > rule.notAfter) revert ExpiryOutsideDates();
		} else if (kind == PREMIUM_VOL_FLOOR) {
			// The bid master attests the bid's annualized implied volatility; this rule trusts it.
			if (bidMasterData.length != 32) revert MissingAttestation();
			if (abi.decode(bidMasterData, (uint32)) < abi.decode(config, (uint32))) revert VolTooLow();
		} else {
			revert UnknownRuleKind(kind);
		}
		return IIvyBidValidator.validateBid.selector;
	}

	function _checkFeed(address priceFeed, uint32 maxPriceAge) private view {
		if (priceFeed != trustedPriceFeed) revert BindingMismatch();
		if (maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
	}

	/// @dev A feed is needed only when some pair pays premium in a token other than the underlying.
	function _checkPremiumFeed(VaultTerms calldata terms, PairConfig[] calldata pairs, address priceFeed, uint32 maxPriceAge) private view {
		for (uint256 i = 0; i < pairs.length; ++i) {
			if (pairs[i].premiumToken != terms.underlying) {
				_checkFeed(priceFeed, maxPriceAge);
				return;
			}
		}
	}

	function _checkStrikeSpotBand(BidContext calldata context, Bid calldata bid, StrikeSpotBandRule memory rule) private view {
		uint256 spot = _readSpot(rule.priceFeed, rule.maxPriceAge, context.underlying, bid.quoteToken);
		uint256 inner = IvyMath.spotBound(context.isCall, spot, rule.maxInTheMoneyBps);
		if (context.isCall ? bid.strike < inner : bid.strike > inner) revert StrikeOutsideSpotBand();
		if (context.isCall) {
			if (bid.strike > (spot * (IvyMath.BPS + rule.maxOutOfTheMoneyBps)) / IvyMath.BPS) revert StrikeOutsideSpotBand();
		} else if (rule.maxOutOfTheMoneyBps < IvyMath.BPS) {
			if (bid.strike < (spot * (IvyMath.BPS - rule.maxOutOfTheMoneyBps)) / IvyMath.BPS) revert StrikeOutsideSpotBand();
		}
	}

	/// @dev Same-token premium needs no feed: one whole underlying equals `underlyingUnit`.
	function _premiumSpot(BidContext calldata context, address priceFeed, uint32 maxPriceAge) private view returns (uint256) {
		if (context.premiumToken == context.underlying) return context.underlyingUnit;
		return _readSpot(priceFeed, maxPriceAge, context.underlying, context.premiumToken);
	}

	function _readSpot(address priceFeed, uint32 maxPriceAge, address underlying, address quote) private view returns (uint256) {
		(uint256 price, uint256 updatedAt) = IIvyPriceFeed(priceFeed).spot(underlying, quote);
		if (price == 0 || updatedAt > block.timestamp) revert InvalidPrice();
		if (block.timestamp - updatedAt > maxPriceAge) revert StalePrice();
		return price;
	}

	/// @dev Requires exactly one entry per vault pair, so a per-pair rule can never leave a pair unbounded.
	function _checkCoversPairs(PairConfig[] calldata pairs, address[] memory quoteTokens) private pure {
		for (uint256 i = 0; i < pairs.length; ++i) {
			bool found = false;
			for (uint256 j = 0; j < quoteTokens.length; ++j) {
				if (quoteTokens[j] == pairs[i].quoteToken) {
					found = true;
					break;
				}
			}
			if (!found) revert RuleMissingPair(pairs[i].quoteToken);
		}
		for (uint256 i = 0; i < quoteTokens.length; ++i) {
			bool known = false;
			for (uint256 j = 0; j < pairs.length; ++j) {
				if (pairs[j].quoteToken == quoteTokens[i]) {
					known = true;
					break;
				}
			}
			if (!known) revert PairUnknown(quoteTokens[i]);
			for (uint256 j = 0; j < i; ++j) {
				if (quoteTokens[j] == quoteTokens[i]) revert DuplicatePair(quoteTokens[i]);
			}
		}
	}

	function _strikeRangeFor(StrikeRange[] memory ranges, address quoteToken) private pure returns (StrikeRange memory) {
		for (uint256 i = 0; i < ranges.length; ++i) {
			if (ranges[i].quoteToken == quoteToken) return ranges[i];
		}
		revert PairUnknown(quoteToken);
	}

	function _premiumMinFor(PremiumMin[] memory mins, address quoteToken) private pure returns (uint256) {
		for (uint256 i = 0; i < mins.length; ++i) {
			if (mins[i].quoteToken == quoteToken) return mins[i].minPremiumPerUnit;
		}
		revert PairUnknown(quoteToken);
	}
}
