// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Library and validator errors included in the Hub ABI for revert decoding.
interface IIvyVaultsHubErrors {
	error AuctionTimeoutNotReached();
	error CashSettlementDisabled();
	error CashSettlementNeedsMaxPriceAge();
	error CommitmentMismatch();
	error DeviationTooLarge();
	error DuplicatePair(address quoteToken);
	error EmptyNotional();
	error ExceedsRemaining(uint256 remaining);
	error ExerciseNotOpenYet();
	error ExerciseWindowClosed();
	error ExpirationNotReached();
	error ExpiryInPast();
	error ExpiryOutsideWindow();
	error ExpiryPricePublicationClosed();
	error FeedNeedsMaxPriceAge();
	error InsufficientShares();
	error InvalidExpiryWindow();
	error InvalidPremiumFloor();
	error InvalidPrice();
	error InvalidStrikeLimit();
	error InvalidTenorRange();
	error InvalidValidator();
	error InvalidVolFloor();
	error MissingAttestation();
	error MissingBidLimits();
	error MissingExpiryBounds();
	error NoPairs();
	error NotExecutor();
	error NothingToClaim();
	error NothingToExercise();
	error PairUnknown(address quoteToken);
	error PartialExerciseNotAllowed();
	error PayoutHookOutOfGas();
	error PhysicalFallbackUnavailable();
	error PremiumTooLow();
	error PutPairMustBeCollateral();
	error PutRequiresSinglePair();
	error QuoteIsUnderlying();
	error ReportFinalized();
	error ReportUnavailable();
	error RuleDataLengthMismatch(uint256 expected, uint256 actual);
	error RuleMissingPair(address quoteToken);
	error SettlementNotAllowed();
	error ShortReceived(uint256 expected, uint256 received);
	error StalePrice();
	error StrikeAboveLimit();
	error StrikeBelowLimit();
	error StrikeOutsideSpotBand();
	error StyleNotAllowed();
	error TenorOutOfRange();
	error TooEarlyToSettle();
	error UnknownRuleKind(bytes4 kind);
	error VolTooLow();
}
