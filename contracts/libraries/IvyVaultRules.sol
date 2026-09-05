// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "../types/IvyTypes.sol";

/// @notice Linked vault validation and tightening. Hub entrypoints enforce owner and phase authority.
/// @dev Storage references address the calling hub under DELEGATECALL. No configurable target or independent state.
library IvyVaultRules {
    function validateTerms(VaultTerms calldata t, PairInput[] calldata pairs) external view {
        if (t.underlying == address(0) || t.collateral == address(0)) revert ZeroAddress();
        if (t.expiry <= block.timestamp) revert ExpiryInPast();
        bool isCall = t.collateral == t.underlying;
        if (t.allowedSettlement != SettlementPolicy.Physical && t.priceFeed == address(0)) revert CashSettlementNeedsFeed();
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
