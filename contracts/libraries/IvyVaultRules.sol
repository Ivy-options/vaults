// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "../types/IvyTypes.sol";
import {IIvyPriceFeed} from "../interfaces/IIvyPriceFeed.sol";
import {IvyMath} from "./IvyMath.sol";

/// @notice Linked vault validation and tightening. Hub entrypoints enforce owner and phase authority.
/// @dev Storage references address the calling hub under DELEGATECALL. No configurable target or independent state.
library IvyVaultRules {
    /// @dev Bid signature and caller authorization are enforced by the hub.
    function validateBid(VaultState storage s, VaultTerms storage t, PairTerms storage p, Bid calldata bid, uint256 supply) external view {
        if (p.premiumToken == address(0)) revert PairUnknown(bid.quoteToken);
        if (!p.enabled) revert PairDisabled(bid.quoteToken);
        if (t.allowedExercise != ExercisePolicy.Either && uint8(t.allowedExercise) != uint8(bid.style)) {
            revert StyleNotAllowed();
        }
        if (t.allowedSettlement != SettlementPolicy.Either && uint8(t.allowedSettlement) != uint8(bid.settlement)) {
            revert SettlementNotAllowed();
        }
        if (bid.expiry <= block.timestamp) revert ExpiryInPast();
        if (bid.expiry != t.expiry || bid.auctionId != s.auctionId || bid.collateralAmount != supply
            || bid.pairHash != keccak256(abi.encode(p))) revert CommitmentMismatch();
        if (bid.recipient == address(0)) revert ZeroAddress();
        _checkStrike(s.isCall, t, p, bid.quoteToken, bid.strike);
        if (bid.premium < p.minPremium) revert PremiumTooLow();
    }
    /// @dev Spec §5.1: the configured limit and, when a feed is set, the oracle band. Both must pass.
    function _checkStrike(bool isCall, VaultTerms storage t, PairTerms storage p, address quoteToken, uint256 strike)
        private view
    {
        if (isCall) {
            if (strike < p.strikeLimit) revert StrikeBelowLimit();
        } else {
            if (strike > p.strikeLimit) revert StrikeAboveLimit();
        }
        if (t.priceFeed != address(0)) {
            uint256 bound = IvyMath.spotBound(isCall, _readSpot(t, quoteToken), t.maxInTheMoneyBps);
            if (isCall ? strike < bound : strike > bound) revert StrikeOutsideSpotBand();
        }
    }

    function _readSpot(VaultTerms storage t, address quoteToken) private view returns (uint256) {
        (uint256 price, uint256 updatedAt) = IIvyPriceFeed(t.priceFeed).spot(t.underlying, quoteToken);
        if (price == 0 || updatedAt > block.timestamp) revert InvalidPrice();
        if (block.timestamp - updatedAt > t.maxPriceAge) revert StalePrice();
        return price;
    }

    function validateTerms(VaultTerms calldata t, PairInput[] calldata pairs) external view {
        if (t.underlying == address(0) || t.collateral == address(0)) revert ZeroAddress();
        if (t.expiry <= block.timestamp) revert ExpiryInPast();
        bool isCall = t.collateral == t.underlying;
        if (t.allowedSettlement != SettlementPolicy.Physical && t.maxSettlementPriceAge == 0) revert CashSettlementNeedsMaxPriceAge();
        if (t.priceFeed != address(0)) {
            if (t.priceFeed.code.length == 0) revert BindingMismatch();
            if (t.maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
            if (isCall && t.maxInTheMoneyBps > 10_000) revert DeviationTooLarge();
        }
        if (pairs.length == 0) revert NoPairs();
        if (!isCall) {
            if (pairs.length != 1) revert PutRequiresSinglePair();
            if (pairs[0].quoteToken != t.collateral) revert PutPairMustBeCollateral();
        }
        for (uint256 i = 0; i < pairs.length; ++i) {
            PairInput calldata p = pairs[i];
            if (p.quoteToken == address(0) || p.terms.premiumToken == address(0)) revert ZeroAddress();
            if (isCall && p.quoteToken == t.underlying) revert QuoteIsUnderlying();
            if (!p.terms.enabled) revert PairMustBeEnabled();
            if (!isCall && p.terms.strikeLimit == 0) revert InvalidStrikeLimit();
            for (uint256 j = 0; j < i; ++j) {
                if (pairs[j].quoteToken == p.quoteToken) revert DuplicatePair(p.quoteToken);
            }
        }
    }

    function tightenVaultTerms(VaultTerms storage t, TightenableTerms calldata n) external {
        if (!(t.allowedExercise == n.allowedExercise || t.allowedExercise == ExercisePolicy.Either)) revert LoosensTerms();
        if (!(t.allowedSettlement == n.allowedSettlement || t.allowedSettlement == SettlementPolicy.Either)) revert LoosensTerms();
        if (n.minCollateral < t.minCollateral) revert LoosensTerms();
        if (t.priceFeed != address(0)) {
            if (n.maxInTheMoneyBps > t.maxInTheMoneyBps) revert LoosensTerms();
            if (n.maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
            if (n.maxPriceAge > t.maxPriceAge) revert LoosensTerms();
            t.maxInTheMoneyBps = n.maxInTheMoneyBps;
            t.maxPriceAge = n.maxPriceAge;
        }
        t.allowedExercise = n.allowedExercise;
        t.allowedSettlement = n.allowedSettlement;
        t.minCollateral = n.minCollateral;
    }

    function tightenPairTerms(PairTerms storage p, bool isCall, address quoteToken, PairTerms calldata n) external {
        if (p.premiumToken == address(0)) revert PairUnknown(quoteToken);
        if (n.premiumToken != p.premiumToken) revert LoosensTerms();
        if (isCall ? n.strikeLimit < p.strikeLimit : n.strikeLimit > p.strikeLimit) revert LoosensTerms();
        if (!isCall && n.strikeLimit == 0) revert InvalidStrikeLimit();
        if (n.minPremium < p.minPremium) revert LoosensTerms();
        if (n.enabled && !p.enabled) revert LoosensTerms();
        p.strikeLimit = n.strikeLimit;
        p.minPremium = n.minPremium;
        p.enabled = n.enabled;
    }
}
