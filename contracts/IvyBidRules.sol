// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IIvyBidValidator} from "./interfaces/IIvyBidValidator.sol";
import {IIvyPriceFeed} from "./interfaces/IIvyPriceFeed.sol";
import {IvyMath} from "./libraries/IvyMath.sol";
import "./types/IvyTypes.sol";

/// @notice The shipped bid validator. Stateless and ownerless. One contract, three named kinds.
/// @dev Listing PairLimits and SpotBand reproduces the acceptance conditions of the previous release.
contract IvyBidRules is IIvyBidValidator {
    // Types

    struct PairLimit {
        address quoteToken;
        uint256 strikeLimit; // calls: minimum strike, 0 = none. puts: maximum strike, must be > 0
        uint256 minPremium; // premium-token units per 1 whole underlying
    }

    struct SpotBandRule {
        address priceFeed;
        uint32 maxPriceAge; // seconds, > 0
        uint16 maxInTheMoneyBps; // calls: strike >= spot * (1 - bps); puts: strike <= spot * (1 + bps)
    }

    struct PremiumFloorRule {
        address priceFeed; // may be zero when every pair pays premium in the underlying
        uint32 maxPriceAge;
        uint16 minPremiumBps; // premium >= spot * minPremiumBps / 10_000, in (0, 10_000]
    }

    // Constants

    bytes4 public constant PAIR_LIMITS = bytes4(keccak256("PairLimits"));
    bytes4 public constant PREMIUM_FLOOR = bytes4(keccak256("PremiumFloor"));
    bytes4 public constant SPOT_BAND = bytes4(keccak256("SpotBand"));

    // External functions

    /// @inheritdoc IIvyBidValidator
    function validateConfig(bytes4 kind, VaultTerms calldata terms, PairConfig[] calldata pairs, bytes calldata data)
        external
        view
        returns (bytes4)
    {
        bool isCall = terms.collateral == terms.underlying;
        if (kind == PAIR_LIMITS) {
            _checkPairLimits(isCall, pairs, abi.decode(data, (PairLimit[])));
        } else if (kind == SPOT_BAND) {
            SpotBandRule memory rule = abi.decode(data, (SpotBandRule));
            _checkFeed(rule.priceFeed, rule.maxPriceAge);
            if (isCall && rule.maxInTheMoneyBps > IvyMath.BPS) {
                revert DeviationTooLarge();
            }
        } else if (kind == PREMIUM_FLOOR) {
            PremiumFloorRule memory rule = abi.decode(data, (PremiumFloorRule));
            if (rule.minPremiumBps == 0 || rule.minPremiumBps > IvyMath.BPS) {
                revert InvalidPremiumFloor();
            }
            for (uint256 i = 0; i < pairs.length; ++i) {
                if (pairs[i].premiumToken != terms.underlying) {
                    _checkFeed(rule.priceFeed, rule.maxPriceAge);
                    break;
                }
            }
        } else {
            revert UnknownRuleKind(kind);
        }
        return IIvyBidValidator.validateConfig.selector;
    }

    /// @inheritdoc IIvyBidValidator
    function validateBid(bytes4 kind, BidContext calldata context, Bid calldata bid, bytes calldata data)
        external
        view
        returns (bytes4)
    {
        if (kind == PAIR_LIMITS) {
            PairLimit memory limit = _limitFor(abi.decode(data, (PairLimit[])), bid.quoteToken);
            if (context.isCall) {
                if (bid.strike < limit.strikeLimit) {
                    revert StrikeBelowLimit();
                }
            } else if (bid.strike > limit.strikeLimit) {
                revert StrikeAboveLimit();
            }
            if (bid.premium < limit.minPremium) {
                revert PremiumTooLow();
            }
        } else if (kind == SPOT_BAND) {
            SpotBandRule memory rule = abi.decode(data, (SpotBandRule));
            uint256 spot = _readSpot(rule.priceFeed, rule.maxPriceAge, context.underlying, bid.quoteToken);
            uint256 bound = IvyMath.spotBound(context.isCall, spot, rule.maxInTheMoneyBps);
            if (context.isCall ? bid.strike < bound : bid.strike > bound) {
                revert StrikeOutsideSpotBand();
            }
        } else if (kind == PREMIUM_FLOOR) {
            PremiumFloorRule memory rule = abi.decode(data, (PremiumFloorRule));
            // One whole underlying priced in itself is exactly one unit; the feed refuses same-token pairs.
            uint256 spot = context.premiumToken == context.underlying
                ? context.underlyingUnit
                : _readSpot(rule.priceFeed, rule.maxPriceAge, context.underlying, context.premiumToken);
            if (bid.premium * IvyMath.BPS < spot * rule.minPremiumBps) {
                revert PremiumTooLow();
            }
        } else {
            revert UnknownRuleKind(kind);
        }
        return IIvyBidValidator.validateBid.selector;
    }

    // Private functions

    function _checkFeed(address priceFeed, uint32 maxPriceAge) private view {
        if (priceFeed.code.length == 0) {
            revert BindingMismatch();
        }
        if (maxPriceAge == 0) {
            revert FeedNeedsMaxPriceAge();
        }
    }

    function _readSpot(address priceFeed, uint32 maxPriceAge, address underlying, address quote)
        private
        view
        returns (uint256)
    {
        (uint256 price, uint256 updatedAt) = IIvyPriceFeed(priceFeed).spot(underlying, quote);
        if (price == 0 || updatedAt > block.timestamp) {
            revert InvalidPrice();
        }
        if (block.timestamp - updatedAt > maxPriceAge) {
            revert StalePrice();
        }
        return price;
    }

    function _checkPairLimits(bool isCall, PairConfig[] calldata pairs, PairLimit[] memory limits) private pure {
        for (uint256 i = 0; i < pairs.length; ++i) {
            bool found = false;
            for (uint256 j = 0; j < limits.length; ++j) {
                if (limits[j].quoteToken == pairs[i].quoteToken) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                revert RuleMissingPair(pairs[i].quoteToken);
            }
        }
        for (uint256 i = 0; i < limits.length; ++i) {
            bool known = false;
            for (uint256 j = 0; j < pairs.length; ++j) {
                if (pairs[j].quoteToken == limits[i].quoteToken) {
                    known = true;
                    break;
                }
            }
            if (!known) {
                revert PairUnknown(limits[i].quoteToken);
            }
            for (uint256 j = 0; j < i; ++j) {
                if (limits[j].quoteToken == limits[i].quoteToken) {
                    revert DuplicatePair(limits[i].quoteToken);
                }
            }
            if (!isCall && limits[i].strikeLimit == 0) {
                revert InvalidStrikeLimit();
            }
        }
    }

    function _limitFor(PairLimit[] memory limits, address quoteToken) private pure returns (PairLimit memory) {
        for (uint256 i = 0; i < limits.length; ++i) {
            if (limits[i].quoteToken == quoteToken) {
                return limits[i];
            }
        }
        revert PairUnknown(quoteToken);
    }
}
