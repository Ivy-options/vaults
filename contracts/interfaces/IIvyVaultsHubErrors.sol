// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Errors propagated by linked libraries. Keep them in the hub ABI for clients and revert decoding.
interface IIvyVaultsHubErrors {
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
    error ExerciseNotAvailable();
    error ExceedsRemaining(uint256 remaining);
    error NothingToExercise();
    error InsufficientShares();
    error ReportUnavailable();
}
