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
    SettlementPolicy allowedSettlement; // Cash requires maxSettlementPriceAge > 0
    uint64 expiry; // fixed absolute Unix timestamp, future at creation
    uint64 auctionStartsAt; // 0 = manual only; else anyone may open the auction from this time
    uint256 minCollateral; // shares required to open the auction
    address priceFeed; // 0 = no activation spot checks
    uint16 maxInTheMoneyBps; // calls: strike >= spot*(1-bps); puts: strike <= spot*(1+bps)
    uint32 maxPriceAge; // seconds; > 0 when priceFeed != 0
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

struct PairTerms {
    address premiumToken; // token the market maker pays premium in
    uint256 strikeLimit; // calls: min strike (0 = none). puts: max strike (max uint = none, must be > 0)
    uint256 minPremium; // premiumToken units per 1 whole underlying
    bool enabled;
}

struct PairInput {
    address quoteToken;
    PairTerms terms;
}

struct TightenableTerms {
    ExercisePolicy allowedExercise;
    SettlementPolicy allowedSettlement;
    uint256 minCollateral;
    uint16 maxInTheMoneyBps;
    uint32 maxPriceAge;
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
    bytes32 pairHash;
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
error FeedNeedsMaxPriceAge();
error InsufficientAvailable();
error InsufficientShares();
error InvalidPrice();
error InvalidStrikeLimit();
error LoosensTerms();
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
error PairDisabled(address quoteToken);
error PairMustBeEnabled();
error PairUnknown(address quoteToken);
error PartialExerciseNotAllowed();
error PremiumTooLow();
error PutPairMustBeCollateral();
error PutRequiresSinglePair();
error QuoteIsUnderlying();
error ReportFinalized();
error ReportUnavailable();
error SettlementNotAllowed();
error ShortReceived(uint256 expected, uint256 received);
error StalePrice();
error StrikeAboveLimit();
error StrikeBelowLimit();
error StrikeOutsideSpotBand();
error StyleNotAllowed();
error UnknownVault();
error WrongPhase(Phase expected, Phase actual);
error ZeroAddress();
error ZeroAmount();
