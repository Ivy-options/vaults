// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Errors propagated by linked libraries. Keep them in the hub ABI for clients and revert decoding.
interface IIvyVaultsHubErrors {
    error CashSettlementDisabled();
    error CashSettlementNeedsMaxPriceAge();
    error CommitmentMismatch();
    error DeviationTooLarge();
    error DuplicatePair(address quoteToken);
    error ExceedsRemaining(uint256 remaining);
    error ExerciseNotOpenYet();
    error ExerciseWindowClosed();
    error FeedNeedsMaxPriceAge();
    error InsufficientShares();
    error InvalidPrice();
    error InvalidStrikeLimit();
    error LoosensTerms();
    error NoPairs();
    error NotExecutor();
    error NothingToClaim();
    error NothingToExercise();
    error PairDisabled(address quoteToken);
    error PairMustBeEnabled();
    error PairUnknown(address quoteToken);
    error PartialExerciseNotAllowed();
    error PayoutHookOutOfGas();
    error PremiumTooLow();
    error PutPairMustBeCollateral();
    error PutRequiresSinglePair();
    error QuoteIsUnderlying();
    error ReportFinalized();
    error ReportUnavailable();
    error SettlementNotAllowed();
    error StalePrice();
    error StrikeAboveLimit();
    error StrikeBelowLimit();
    error StrikeOutsideSpotBand();
    error StyleNotAllowed();
}
