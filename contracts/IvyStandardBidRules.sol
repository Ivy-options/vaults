// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyBidValidator } from "./interfaces/IIvyBidValidator.sol";
import { IIvyPriceFeed } from "./interfaces/IIvyPriceFeed.sol";
import { IvyMath } from "./libraries/IvyMath.sol";
import "./types/IvyTypes.sol";

/// @notice Stateless validator for the standard bid rule kinds.
/// @dev Strike and premium: PairLimits, SpotBand, PremiumFloor, YieldFloor. Expiry: TenorRange, ExpiryWindow.
///      MinImpliedVol trusts the bid master's attestation. No kind reads market-maker data.
contract IvyStandardBidRules is IIvyBidValidator {
	address public immutable trustedPriceFeed;

	struct PairLimit {
		address quoteToken;
		uint256 minStrike; // quote units per whole underlying; 0 < minStrike <= maxStrike
		uint256 maxStrike;
		uint256 minPremiumPerUnit; // premium-token units per 1 whole underlying
	}

	struct SpotBandRule {
		address priceFeed;
		uint32 maxPriceAge; // seconds, > 0
		uint16 maxInTheMoneyBps; // calls: strike >= spot * (1 - bps); puts: strike <= spot * (1 + bps)
		uint32 maxOutOfTheMoneyBps; // calls: strike <= spot * (1 + bps); puts: strike >= spot * (1 - bps), no floor from 10_000
	}

	struct PremiumFloorRule {
		address priceFeed; // may be zero when every pair pays premium in the underlying
		uint32 maxPriceAge;
		uint16 minPremiumBps; // premiumPerUnit >= spot * minPremiumBps / 10_000, in (0, 10_000]
	}

	struct YieldFloorRule {
		address priceFeed; // may be zero when every pair pays premium in the underlying
		uint32 maxPriceAge;
		uint16 minAprBps; // premiumPerUnit >= spot * minAprBps / 10_000 * tenor / 365 days, > 0
	}

	struct TenorRangeRule {
		uint64 minTenor; // seconds from activation to expiry
		uint64 maxTenor; // > 0 and >= minTenor
	}

	struct ExpiryWindowRule {
		uint64 notBefore; // absolute Unix time
		uint64 notAfter; // absolute Unix time, >= notBefore and in the future at creation
	}

	bytes4 public constant EXPIRY_WINDOW = bytes4(keccak256("ExpiryWindow"));
	bytes4 public constant MIN_IMPLIED_VOL = bytes4(keccak256("MinImpliedVol"));
	bytes4 public constant PAIR_LIMITS = bytes4(keccak256("PairLimits"));
	bytes4 public constant PREMIUM_FLOOR = bytes4(keccak256("PremiumFloor"));
	bytes4 public constant SPOT_BAND = bytes4(keccak256("SpotBand"));
	bytes4 public constant TENOR_RANGE = bytes4(keccak256("TenorRange"));
	bytes4 public constant YIELD_FLOOR = bytes4(keccak256("YieldFloor"));
	uint256 private constant YEAR = 365 days;

	constructor(address trustedPriceFeed_) {
		if (trustedPriceFeed_.code.length == 0) revert BindingMismatch();
		trustedPriceFeed = trustedPriceFeed_;
	}

	/// @inheritdoc IIvyBidValidator
	function validateConfig(bytes4 kind, VaultTerms calldata terms, PairConfig[] calldata pairs, bytes calldata data) external view returns (bytes4) {
		bool isCall = terms.collateral == terms.underlying;
		if (kind == PAIR_LIMITS) {
			_checkPairLimits(pairs, abi.decode(data, (PairLimit[])));
		} else if (kind == SPOT_BAND) {
			SpotBandRule memory rule = abi.decode(data, (SpotBandRule));
			_checkFeed(rule.priceFeed, rule.maxPriceAge);
			if (isCall && rule.maxInTheMoneyBps > IvyMath.BPS) revert DeviationTooLarge();
		} else if (kind == PREMIUM_FLOOR) {
			PremiumFloorRule memory rule = abi.decode(data, (PremiumFloorRule));
			if (rule.minPremiumBps == 0 || rule.minPremiumBps > IvyMath.BPS) revert InvalidPremiumFloor();
			_checkPremiumFeed(terms, pairs, rule.priceFeed, rule.maxPriceAge);
		} else if (kind == YIELD_FLOOR) {
			YieldFloorRule memory rule = abi.decode(data, (YieldFloorRule));
			if (rule.minAprBps == 0) revert InvalidPremiumFloor();
			_checkPremiumFeed(terms, pairs, rule.priceFeed, rule.maxPriceAge);
		} else if (kind == TENOR_RANGE) {
			TenorRangeRule memory rule = abi.decode(data, (TenorRangeRule));
			if (rule.maxTenor == 0 || rule.minTenor > rule.maxTenor) revert InvalidTenorRange();
		} else if (kind == EXPIRY_WINDOW) {
			ExpiryWindowRule memory rule = abi.decode(data, (ExpiryWindowRule));
			if (rule.notBefore > rule.notAfter || rule.notAfter <= block.timestamp) revert InvalidExpiryWindow();
		} else if (kind == MIN_IMPLIED_VOL) {
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
		if (kind == PAIR_LIMITS) {
			PairLimit memory limit = _limitFor(abi.decode(config, (PairLimit[])), bid.quoteToken);
			if (bid.strike < limit.minStrike) revert StrikeBelowLimit();
			if (bid.strike > limit.maxStrike) revert StrikeAboveLimit();
			if (bid.premiumPerUnit < limit.minPremiumPerUnit) revert PremiumTooLow();
		} else if (kind == SPOT_BAND) {
			_checkSpotBand(context, bid, abi.decode(config, (SpotBandRule)));
		} else if (kind == PREMIUM_FLOOR) {
			PremiumFloorRule memory rule = abi.decode(config, (PremiumFloorRule));
			uint256 spot = _premiumSpot(context, rule.priceFeed, rule.maxPriceAge);
			if (bid.premiumPerUnit * IvyMath.BPS < spot * rule.minPremiumBps) revert PremiumTooLow();
		} else if (kind == YIELD_FLOOR) {
			YieldFloorRule memory rule = abi.decode(config, (YieldFloorRule));
			uint256 spot = _premiumSpot(context, rule.priceFeed, rule.maxPriceAge);
			// The Hub has already required expiry > block.timestamp.
			uint256 tenor = bid.expiry - block.timestamp;
			if (bid.premiumPerUnit * IvyMath.BPS * YEAR < spot * rule.minAprBps * tenor) revert PremiumTooLow();
		} else if (kind == TENOR_RANGE) {
			TenorRangeRule memory rule = abi.decode(config, (TenorRangeRule));
			if (bid.expiry < block.timestamp + rule.minTenor || bid.expiry > block.timestamp + rule.maxTenor) revert TenorOutOfRange();
		} else if (kind == EXPIRY_WINDOW) {
			ExpiryWindowRule memory rule = abi.decode(config, (ExpiryWindowRule));
			if (bid.expiry < rule.notBefore || bid.expiry > rule.notAfter) revert ExpiryOutsideWindow();
		} else if (kind == MIN_IMPLIED_VOL) {
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

	function _checkSpotBand(BidContext calldata context, Bid calldata bid, SpotBandRule memory rule) private view {
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

	function _checkPairLimits(PairConfig[] calldata pairs, PairLimit[] memory limits) private pure {
		for (uint256 i = 0; i < pairs.length; ++i) {
			bool found = false;
			for (uint256 j = 0; j < limits.length; ++j) {
				if (limits[j].quoteToken == pairs[i].quoteToken) {
					found = true;
					break;
				}
			}
			if (!found) revert RuleMissingPair(pairs[i].quoteToken);
		}
		for (uint256 i = 0; i < limits.length; ++i) {
			bool known = false;
			for (uint256 j = 0; j < pairs.length; ++j) {
				if (pairs[j].quoteToken == limits[i].quoteToken) {
					known = true;
					break;
				}
			}
			if (!known) revert PairUnknown(limits[i].quoteToken);
			for (uint256 j = 0; j < i; ++j) {
				if (limits[j].quoteToken == limits[i].quoteToken) revert DuplicatePair(limits[i].quoteToken);
			}
			if (limits[i].minStrike == 0 || limits[i].minStrike > limits[i].maxStrike) revert InvalidStrikeLimit();
			if (limits[i].minPremiumPerUnit == 0) revert PremiumTooLow();
		}
	}

	function _limitFor(PairLimit[] memory limits, address quoteToken) private pure returns (PairLimit memory) {
		for (uint256 i = 0; i < limits.length; ++i) {
			if (limits[i].quoteToken == quoteToken) return limits[i];
		}
		revert PairUnknown(quoteToken);
	}
}
