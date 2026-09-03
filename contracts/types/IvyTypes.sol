// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev Shared enums, structs and custom errors for Ivy Vaults.

/// Derived from `collateral == underlying`; never an input.
enum OptionKind { CoveredCall, CashSecuredPut }
enum ExerciseStyle { European, American }
/// European/American values line up with ExerciseStyle so uint8 comparison works.
enum ExercisePolicy { European, American, Either }
enum SettlementType { Physical, Cash }
/// Physical/Cash values line up with SettlementType so uint8 comparison works.
enum SettlementPolicy { Physical, Cash, Either }
enum Phase { Open, Auction, Live, Settled }

struct VaultTerms {
    address underlying;            // token being optioned
    address collateral;            // == underlying for a covered call; a quote token for a cash-secured put
    bool publicDeposits;           // false = only the vault owner may deposit
    ExercisePolicy allowedExercise;
    SettlementPolicy allowedSettlement; // Cash requires priceFeed != 0
    uint64 maxTenor;               // max seconds from activation to expiry, > 0
    uint64 auctionStartsAt;        // 0 = manual only; else anyone may open the auction from this time
    uint256 minCollateral;         // shares required to open the auction
    address priceFeed;             // 0 = no oracle checks
    uint16 maxSpotDeviationBps;    // calls: strike >= spot*(1-bps); puts: strike <= spot*(1+bps)
    uint32 maxPriceAge;            // seconds; > 0 when priceFeed != 0
}

struct PairTerms {
    address premiumToken;          // token the market maker pays premium in
    uint256 strikeLimit;           // calls: min strike (0 = none). puts: max strike (max uint = none, must be > 0)
    uint256 minPremium;            // premiumToken units per 1 whole underlying
    bool enabled;
}

struct PairInput {
    address quoteToken;
    PairTerms terms;
}

struct TightenableTerms {
    ExercisePolicy allowedExercise;
    SettlementPolicy allowedSettlement;
    uint64 maxTenor;
    uint256 minCollateral;
    uint16 maxSpotDeviationBps;
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
    uint64 expiry;                 // absolute unix timestamp
    uint64 validUntil;             // signature deadline
    uint256 nonce;                 // free-form, consumed on activation
}

struct VaultState {
    address vault;
    address owner;
    bool isCall;
    Phase phase;
    uint64 auctionOpenedAt;
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
    uint256 totalNotional;         // underlying units
    uint256 exercisedNotional;     // underlying units
    uint256 pendingPayout;         // collateral units reserved for the market maker
}

// ---------------------------------------------------------------- errors
error ZeroAddress();
error ZeroAmount();
error UnknownVault();
error WrongPhase(Phase expected, Phase actual);
error NotVaultOwner();
error NotVault();
error NotHub();
error AlreadyInitialized();
error DepositsNotPublic();
error NoPairs();
error DuplicatePair(address quoteToken);
error QuoteIsUnderlying();
error PutRequiresSinglePair();
error PutPairMustBeCollateral();
error PairMustBeEnabled();
error PairUnknown(address quoteToken);
error PairDisabled(address quoteToken);
error InvalidStrikeLimit();
error InvalidTenor();
error CashSettlementNeedsFeed();
error FeedNeedsMaxPriceAge();
error DeviationTooLarge();
error LoosensTerms();
error BelowMinCollateral(uint256 have, uint256 need);
error AuctionNotStartable();
error AuctionTimeoutNotReached();
error BidVaultMismatch();
error NotMarketMaker();
error BidExpired();
error NonceUsed();
error BadSignature();
error StyleNotAllowed();
error SettlementNotAllowed();
error ExpiryInPast();
error TenorTooLong();
error StrikeBelowLimit();
error StrikeAboveLimit();
error StrikeOutsideSpotBand();
error StalePrice();
error InvalidPrice();
error PremiumTooLow();
error EmptyNotional();
error ShortReceived(uint256 expected, uint256 received);
error ExerciseWindowClosed();
error ExerciseNotOpenYet();
error ExerciseNotAvailable();
error ExceedsRemaining(uint256 remaining);
error NothingToExercise();
error SettlementNotReached();
error NothingToClaim();
error InsufficientShares();
error SharesNotSet();
error SharesAlreadySet();
error SharesHubMismatch();
