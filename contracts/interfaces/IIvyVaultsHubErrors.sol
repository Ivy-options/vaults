// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Errors propagated by linked libraries. Keep them in the hub ABI for clients and revert decoding.
interface IIvyVaultsHubErrors {
    error PairUnknown(address quoteToken);
    error PairDisabled(address quoteToken);
    error StyleNotAllowed();
    error SettlementNotAllowed();
    error CommitmentMismatch();
    error StrikeBelowLimit();
    error StrikeAboveLimit();
    error StrikeOutsideSpotBand();
    error PremiumTooLow();
    error InvalidPrice();
    error StalePrice();
    error NoPairs();
    error DuplicatePair(address quoteToken);
    error QuoteIsUnderlying();
    error PutRequiresSinglePair();
    error PutPairMustBeCollateral();
    error PairMustBeEnabled();
    error InvalidStrikeLimit();
    error CashSettlementNeedsFeed();
    error FeedNeedsMaxPriceAge();
    error DeviationTooLarge();
    error LoosensTerms();
    error ExerciseWindowClosed();
    error ExerciseNotOpenYet();
    error PartialExerciseNotAllowed();
    error ExceedsRemaining(uint256 remaining);
    error NothingToExercise();
    error InsufficientShares();
    error ReportUnavailable();
}
