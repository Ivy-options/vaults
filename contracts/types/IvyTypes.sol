// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @dev Shared enums, structs and custom errors for Ivy Vaults.

/// Derived from `collateral == underlying`; never an input.
enum OptionKind {
    CoveredCall,
    CashSecuredPut
}

enum ExerciseStyle {
    European,
    American
}

/// European/American values line up with ExerciseStyle so uint8 comparison works.
enum ExercisePolicy {
    European,
    American,
    Either
}

enum SettlementType {
    Physical,
    Cash
}

/// @notice Effective route for a live position; settlement in VaultState remains the original agreement.
enum SettlementRoute {
    Physical,
    Cash,
    AwaitingExpiryPrice,
    PhysicalFallback,
    FallbackExpired,
    Inactive
}

/// Physical/Cash values line up with SettlementType so uint8 comparison works.
enum SettlementPolicy {
    Physical,
    Cash,
    Either
}

enum Phase {
    Open,
    Auction,
    Live,
    Settled
}

struct VaultTerms {
    address underlying; // token being optioned
    address collateral; // == underlying for a covered call; a quote token for a cash-secured put
    bool allowPartialExercise; // fixed at creation; false requires exercising all remaining notional
    bool publicDeposits; // false = only the vault owner may deposit
    ExercisePolicy allowedExercise;
    SettlementPolicy allowedSettlement; // not Physical requires maxSettlementPriceAge > 0
    uint64 expiry; // fixed absolute Unix timestamp, future at creation
    uint64 auctionStartsAt; // 0 = manual only; else anyone may open the auction from this time. Mutable; outside termsHash.
    uint256 minCollateral; // shares required to open the auction
    uint32 maxSettlementPriceAge; // immutable exercise observation age limit
}

/// @dev Hub-owned authoritative observations scoped to one activated cash vault.
struct ExercisePriceObservation {
    uint256 price;
    uint64 observedAt;
    uint64 validUntil;
}

struct SettlementPrices {
    ExercisePriceObservation exercise;
    uint256 expiry;
}

/// @notice Which tokens a pair moves. Acceptance conditions live in bid rules.
struct PairConfig {
    address quoteToken;
    address premiumToken; // token the market maker pays premium in
}

/// @notice One creator-supplied acceptance condition. Frozen at creation and covered by termsHash.
struct BidRule {
    address validator;
    bytes4 kind; // meaningful only to the validator; lets one contract serve several rule types
    bytes data;
}

/// @notice What a validator learns about the vault beyond the bid itself. Built once per activation.
struct BidContext {
    uint256 vaultId;
    bool isCall;
    address underlying;
    address collateral;
    address premiumToken; // resolved by the hub from the bid's quote token
    uint256 underlyingUnit; // 10 ** underlying decimals
    uint256 collateralAmount; // share supply at activation; equals bid.collateralAmount
    uint256 totalNotional; // underlying units, computed by the hub from supply and strike
    uint64 auctionOpenedAt;
}

struct Bid {
    uint256 vaultId;
    address marketMaker;
    address quoteToken;
    uint256 strike;
    uint256 premium;
    ExerciseStyle style;
    SettlementType settlement;
    uint64 expiry; // absolute unix timestamp
    uint64 validUntil; // signature deadline
    uint256 nonce; // free-form, consumed on activation
    uint256 auctionId;
    uint256 collateralAmount;
    bytes32 termsHash; // creator inputs: terms, pairs, rules; excludes auctionStartsAt
    address executor;
    address recipient;
}

struct VaultState {
    address vault;
    address owner;
    bool isCall;
    Phase phase;
    uint64 auctionOpenedAt;
    uint64 exerciseWindow;
    uint64 auctionTimeout;
    uint256 auctionId;
    address executor;
    address recipient;
    uint256 underlyingUnit;
    // set at activation
    address marketMaker;
    address quoteToken;
    address premiumToken;
    uint256 strike;
    uint256 premium;
    ExerciseStyle style;
    SettlementType settlement;
    uint64 expiry;
    uint256 totalNotional; // underlying units
    uint256 exercisedNotional; // underlying units
    uint256 pendingPayout; // collateral units reserved for the market maker
    uint64 expiryPricePublicationWindow; // fixed at creation; physical fallback uses exerciseWindow
}

struct UnwindAgreement {
    uint256 vaultId;
    uint256 nonce;
    uint64 deadline;
    uint256 exercisedNotional;
    uint256 supply;
    uint256 refund;
}

// Errors

error AdmissionPaused();
error AgreementInvalid();
error AlreadyInitialized();
error AuctionNotStartable();
error AuctionTimeoutNotReached();
error BadSignature();
error BelowMinCollateral(uint256 have, uint256 need);
error BidExpired();
error BidVaultMismatch();
error BindingMismatch();
error CashSettlementDisabled();
error CashSettlementNeedsMaxPriceAge();
error CommitmentMismatch();
error ConsentMissing();
error DepositsNotPublic();
error DeviationTooLarge();
error DuplicatePair(address quoteToken);
error EmptyNotional();
error ExceedsRemaining(uint256 remaining);
error ExerciseNotOpenYet();
error ExerciseWindowClosed();
error ExpirationNotReached();
error ExpiryInPast();
error ExpiryPricePublicationClosed();
error FeedNeedsMaxPriceAge();
error InsufficientAvailable();
error InsufficientShares();
error InvalidPremiumFloor();
error InvalidPrice();
error InvalidSettlementWindow();
error InvalidStrikeLimit();
error InvalidValidator();
error NonceUsed();
error NoPairs();
error NotExecutor();
error NothingToClaim();
error NothingToExercise();
error NotHub();
error NotMarketMaker();
error NotPremiumModule();
error NotShares();
error NotVault();
error NotVaultOwner();
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
error RuleMissingPair(address quoteToken);
error SettlementNotAllowed();
error ShortReceived(uint256 expected, uint256 received);
error StalePrice();
error StrikeAboveLimit();
error StrikeBelowLimit();
error StrikeOutsideSpotBand();
error StyleNotAllowed();
error UnknownRuleKind(bytes4 kind);
error UnknownVault();
error WrongPhase(Phase expected, Phase actual);
error ZeroAddress();
error ZeroAmount();
