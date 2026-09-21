// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IvyPremiums} from "./IvyPremiums.sol";
import {IvyUnwind} from "./IvyUnwind.sol";
import {IIvyShares} from "./interfaces/IIvyShares.sol";
import {IIvyVault} from "./interfaces/IIvyVault.sol";
import {IIvyVaultsHub} from "./interfaces/IIvyVaultsHub.sol";
import {IIvyVaultsHubErrors} from "./interfaces/IIvyVaultsHubErrors.sol";
import {IIvyVaultsHubEvents} from "./interfaces/IIvyVaultsHubEvents.sol";
import {BidHash} from "./libraries/BidHash.sol";
import {IvyMath} from "./libraries/IvyMath.sol";
import {IvyOptionSettlement} from "./libraries/IvyOptionSettlement.sol";
import {IvyVaultRules} from "./libraries/IvyVaultRules.sol";
import "./types/IvyTypes.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Immutable factory and rule engine for individual option vaults.
/// @dev Owns lifecycle state and permissions. Vaults own custody, Shares owns balances,
///      Premiums owns premium credits, and Unwind owns consent and contributions.
///      Fixed linked libraries execute in Hub storage under its entrypoint guards.
contract IvyVaultsHub is
    IIvyVaultsHubEvents,
    IIvyVaultsHubErrors,
    AccessControl,
    EIP712,
    ReentrancyGuardTransient,
    IIvyVaultsHub
{
    // Types

    struct PlatformFee {
        uint16 rateBps;
        address recipient;
        uint256 amount;
    }

    // Constants

    bytes32 public constant BID_MASTER_ROLE = keccak256("BID_MASTER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");
    bytes32 public constant PLATFORM_FEE_MANAGER_ROLE = keccak256("PLATFORM_FEE_MANAGER_ROLE");
    bytes32 public constant SETTLEMENT_PRICE_PUBLISHER_ROLE = keccak256("SETTLEMENT_PRICE_PUBLISHER_ROLE");

    // Immutables

    address public immutable vaultImplementation;
    IvyPremiums public immutable premiums;
    IvyUnwind public immutable unwind;
    IIvyShares public immutable shareToken;

    // Storage

    bool public cashSettlementEnabled;
    mapping(uint256 vaultId => SettlementPrices) internal _settlementPrices;

    /// @notice Default premium fee rate for subsequently created vaults.
    uint16 public platformFeeBps;
    address public platformTreasury;
    mapping(uint256 => PlatformFee) public platformFees;
    bool public paused;
    bool public transfersEnabled;
    mapping(uint256 => bool) public vaultPaused;
    uint64 public exerciseWindow;
    uint64 public auctionTimeout;
    uint256 public vaultCount;
    mapping(uint256 vaultId => VaultTerms) internal _terms;
    mapping(uint256 vaultId => VaultState) internal _state;
    mapping(uint256 vaultId => mapping(address quoteToken => PairTerms)) internal _pairTerms;
    mapping(uint256 vaultId => address[]) internal _quoteTokens;
    mapping(address marketMaker => mapping(uint256 nonce => bool)) public usedBidNonces;

    /// @notice Premium fee rate fixed at vault creation, including a zero rate.
    mapping(uint256 vaultId => uint16) public vaultPlatformFeeBps;

    // Events

    event PlatformFeeAllocated(uint256 indexed vaultId, address indexed recipient, uint16 rateBps, uint256 amount);
    event PlatformFeeBpsUpdated(uint16 oldRate, uint16 newRate);
    event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);
    event TransfersEnabledUpdated(bool enabled);

    // Errors

    error InvalidPlatformFee();

    // Modifiers

    modifier onlyVaultOwner(uint256 vaultId) {
        _requireExists(vaultId);
        if (msg.sender != _state[vaultId].owner) {
            revert NotVaultOwner();
        }
        _;
    }

    // Constructor

    constructor(
        address admin,
        address implementation,
        address shares_,
        address premiums_,
        address unwind_,
        uint64 window_,
        uint64 timeout_
    ) EIP712("IvyVaultsHub", "2") {
        if (
            admin == address(0) || implementation == address(0) || shares_ == address(0) || premiums_ == address(0)
                || unwind_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (implementation.code.length == 0) {
            revert BindingMismatch();
        }
        vaultImplementation = implementation;
        shareToken = IIvyShares(shares_);
        premiums = IvyPremiums(premiums_);
        unwind = IvyUnwind(unwind_);
        exerciseWindow = window_;
        auctionTimeout = timeout_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        _grantRole(PLATFORM_FEE_MANAGER_ROLE, admin);
        platformTreasury = admin;
    }

    // Administration

    function setPlatformFeeBps(uint16 rate) external onlyRole(PLATFORM_FEE_MANAGER_ROLE) {
        if (rate > 10_000) {
            revert InvalidPlatformFee();
        }
        emit PlatformFeeBpsUpdated(platformFeeBps, rate);
        platformFeeBps = rate;
    }

    function setPlatformTreasury(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(0)) {
            revert ZeroAddress();
        }
        emit PlatformTreasuryUpdated(platformTreasury, recipient);
        platformTreasury = recipient;
    }

    function setTransfersEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        transfersEnabled = enabled;
        emit TransfersEnabledUpdated(enabled);
    }

    /// @notice Controls new cash admissions. Admins must arrange publisher authority before enabling.
    /// @dev Existing positions and publisher membership are independent of this flag.
    function setCashSettlementEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        cashSettlementEnabled = enabled;
        emit CashSettlementEnabledUpdated(enabled);
    }

    function setSettings(uint64 window_, uint64 timeout_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        exerciseWindow = window_;
        auctionTimeout = timeout_;
        emit SettingsUpdated(window_, timeout_);
    }

    /// @param vaultId Zero pauses admission globally; other ids pause one vault.
    function setAdmissionPause(uint256 vaultId, bool value) external onlyRole(GUARDIAN_ROLE) {
        if (vaultId == 0) {
            paused = value;
        } else {
            _requireExists(vaultId);
            vaultPaused[vaultId] = value;
        }
        emit AdmissionPauseUpdated(vaultId, value);
    }

    function setURI(string calldata uri_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        shareToken.setURI(uri_);
    }

    // Vault creation (spec 4.2)

    /// @notice Create a vault. Kind is derived: `collateral == underlying` is a covered call, anything else a put.
    function createVault(VaultTerms calldata terms, PairInput[] calldata pairs)
        external
        nonReentrant
        returns (uint256 vaultId, address vault)
    {
        _admission(0);
        if (terms.allowedSettlement != SettlementPolicy.Physical) {
            _requireCashSettlementEnabled();
        }
        if (
            shareToken.hub() != address(this) || premiums.hub() != address(this) || unwind.hub() != address(this)
                || shareToken.premiums() != address(premiums) || shareToken.unwind() != address(unwind)
                || premiums.shares() != address(shareToken) || unwind.shares() != address(shareToken)
        ) {
            revert BindingMismatch();
        }
        IvyVaultRules.validateTerms(terms, pairs);
        bool isCall = terms.collateral == terms.underlying;

        vaultId = ++vaultCount;
        vault = Clones.clone(vaultImplementation);
        IIvyVault(vault).initialize(address(this), vaultId, terms.collateral, address(premiums));

        _terms[vaultId] = terms;
        vaultPlatformFeeBps[vaultId] = platformFeeBps;
        VaultState storage s = _state[vaultId];
        s.vault = vault;
        s.owner = msg.sender;
        s.expiry = terms.expiry;
        s.exerciseWindow = exerciseWindow;
        s.auctionTimeout = auctionTimeout;
        s.isCall = isCall;
        s.phase = Phase.Open;
        s.underlyingUnit = 10 ** IERC20Metadata(terms.underlying).decimals();

        for (uint256 i = 0; i < pairs.length; ++i) {
            _pairTerms[vaultId][pairs[i].quoteToken] = pairs[i].terms;
            _quoteTokens[vaultId].push(pairs[i].quoteToken);
        }

        emit VaultCreated(
            vaultId,
            vault,
            msg.sender,
            isCall ? OptionKind.CoveredCall : OptionKind.CashSecuredPut,
            terms.underlying,
            terms.collateral
        );
        if (terms.auctionStartsAt != 0) {
            emit AuctionScheduled(vaultId, terms.auctionStartsAt);
        }
    }

    // Deposits and withdrawals (spec 6.1)

    /// @notice Deposit through the hub. The caller must have approved the vault address.
    function deposit(uint256 vaultId, uint256 amount) external nonReentrant {
        _checkDeposit(vaultId, msg.sender, amount);
        uint256 received = IIvyVault(_state[vaultId].vault).pull(_terms[vaultId].collateral, msg.sender, amount);
        _credit(vaultId, msg.sender, received);
    }

    /// @inheritdoc IIvyVaultsHub
    function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external nonReentrant {
        if (vaultId == 0 || vaultId > vaultCount || msg.sender != _state[vaultId].vault) {
            revert NotVault();
        }
        _checkDeposit(vaultId, depositor, amount);
        _credit(vaultId, depositor, amount);
    }

    /// @notice Burn shares and take collateral back. Only while the vault is Open.
    function withdraw(uint256 vaultId, uint256 shares) external nonReentrant {
        _requirePhase(vaultId, Phase.Open);
        if (shares == 0) {
            revert ZeroAmount();
        }
        shareToken.burn(msg.sender, vaultId, shares);
        IIvyVault(_state[vaultId].vault).push(_terms[vaultId].collateral, msg.sender, shares);
        emit Withdrawn(vaultId, msg.sender, shares);
    }

    // Owner controls (spec 8)

    /// @notice Tighten vault-level terms. Every field must be equal or more LP-favourable than today.
    function tightenVaultTerms(uint256 vaultId, TightenableTerms calldata n) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        IvyVaultRules.tightenVaultTerms(_terms[vaultId], n);
        emit VaultTermsTightened(vaultId);
    }

    /// @notice Tighten one quote token's terms. Premium token is fixed; a disabled pair stays disabled.
    function tightenPairTerms(uint256 vaultId, address quoteToken, PairTerms calldata n)
        external
        onlyVaultOwner(vaultId)
    {
        _requirePhase(vaultId, Phase.Open);
        IvyVaultRules.tightenPairTerms(_pairTerms[vaultId][quoteToken], _state[vaultId].isCall, quoteToken, n);
        emit PairTermsTightened(vaultId, quoteToken);
    }

    /// @notice Set or clear the time from which anyone may open the auction. Operational, not economic.
    function scheduleAuction(uint256 vaultId, uint64 auctionStartsAt) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        _terms[vaultId].auctionStartsAt = auctionStartsAt;
        emit AuctionScheduled(vaultId, auctionStartsAt);
    }

    function transferVaultOwnership(uint256 vaultId, address newOwner) external onlyVaultOwner(vaultId) {
        if (newOwner == address(0)) {
            revert ZeroAddress();
        }
        address previous = _state[vaultId].owner;
        _state[vaultId].owner = newOwner;
        emit VaultOwnershipTransferred(vaultId, previous, newOwner);
    }

    // Auctions (spec 6.1, 6.2)

    /// @notice Freeze deposits and start the off-chain auction. Owner any time; anyone once `auctionStartsAt` passed.
    function openAuction(uint256 vaultId) external {
        _requirePhase(vaultId, Phase.Open);
        _admission(vaultId);
        VaultState storage s = _state[vaultId];
        VaultTerms storage t = _terms[vaultId];
        if (block.timestamp >= t.expiry) {
            revert ExpiryInPast();
        }
        bool scheduled = t.auctionStartsAt != 0 && block.timestamp >= t.auctionStartsAt;
        if (msg.sender != s.owner && !scheduled) {
            revert AuctionNotStartable();
        }
        uint256 collateral = shareToken.totalSupply(vaultId);
        if (collateral == 0) {
            revert ZeroAmount();
        }
        if (collateral < t.minCollateral) {
            revert BelowMinCollateral(collateral, t.minCollateral);
        }
        ++s.auctionId;
        emit AuctionIdentity(vaultId, s.auctionId);
        s.phase = Phase.Auction;
        s.auctionOpenedAt = uint64(block.timestamp);
        emit AuctionOpened(vaultId, collateral);
    }

    /// @notice Bid master any time; owner after timeout, at expiry, or during admission pause. Clears the schedule.
    function cancelAuction(uint256 vaultId) external {
        _requirePhase(vaultId, Phase.Auction);
        VaultState storage s = _state[vaultId];
        if (!hasRole(BID_MASTER_ROLE, msg.sender)) {
            if (msg.sender != s.owner) {
                revert NotVaultOwner();
            }
            if (
                !paused && !vaultPaused[vaultId] && block.timestamp < s.expiry
                    && block.timestamp < uint256(s.auctionOpenedAt) + s.auctionTimeout
            ) {
                revert AuctionTimeoutNotReached();
            }
        }
        s.phase = Phase.Open;
        s.auctionOpenedAt = 0;
        _terms[vaultId].auctionStartsAt = 0;
        emit AuctionCancelled(vaultId);
    }

    // Activation

    /// @notice Bid master submits the winning bid, signed by the market maker. Checks run in spec §7.2 order.
    function activate(uint256 vaultId, Bid calldata bid, bytes calldata signature)
        external
        nonReentrant
        onlyRole(BID_MASTER_ROLE)
    {
        _admission(vaultId);
        _requirePhase(vaultId, Phase.Auction);
        if (bid.settlement == SettlementType.Cash) {
            _requireCashSettlementEnabled();
        }
        if (bid.vaultId != vaultId) {
            revert BidVaultMismatch();
        }
        if (!hasRole(MARKET_MAKER_ROLE, bid.marketMaker)) {
            revert NotMarketMaker();
        }
        if (block.timestamp > bid.validUntil) {
            revert BidExpired();
        }
        if (usedBidNonces[bid.marketMaker][bid.nonce]) {
            revert NonceUsed();
        }
        usedBidNonces[bid.marketMaker][bid.nonce] = true;
        bytes32 digest = _hashTypedDataV4(BidHash.hash(bid));
        if (!SignatureChecker.isValidSignatureNow(bid.marketMaker, digest, signature)) {
            revert BadSignature();
        }

        VaultState storage s = _state[vaultId];
        VaultTerms storage t = _terms[vaultId];
        PairTerms storage p = _pairTerms[vaultId][bid.quoteToken];
        uint256 supply = shareToken.totalSupply(vaultId);
        IvyVaultRules.validateBid(s, t, p, bid, supply);

        uint256 totalNotional = IvyMath.notionalOf(s.isCall, supply, s.underlyingUnit, bid.strike);
        if (totalNotional == 0) {
            revert EmptyNotional();
        }
        uint256 totalPremium = IvyMath.premiumTotal(bid.premium, totalNotional, s.underlyingUnit);

        s.marketMaker = bid.marketMaker;
        s.executor = bid.executor;
        s.recipient = bid.recipient;
        s.quoteToken = bid.quoteToken;
        s.premiumToken = p.premiumToken;
        s.strike = bid.strike;
        s.premium = bid.premium;
        s.style = bid.style;
        s.settlement = bid.settlement;
        s.expiry = bid.expiry;
        s.totalNotional = totalNotional;
        s.phase = Phase.Live;

        uint16 feeRate = vaultPlatformFeeBps[vaultId];
        address treasury = platformTreasury;
        uint256 fee = Math.mulDiv(totalPremium, feeRate, 10_000);
        platformFees[vaultId] = PlatformFee(feeRate, treasury, fee);
        premiums.activate(vaultId, s.vault, totalPremium - fee, supply);
        IIvyVault(s.vault).collectPremium(p.premiumToken, bid.marketMaker, totalPremium, fee, treasury);
        emit PlatformFeeAllocated(vaultId, treasury, feeRate, fee);

        emit Activated(
            vaultId,
            bid.marketMaker,
            bid.quoteToken,
            p.premiumToken,
            bid.strike,
            bid.premium,
            bid.style,
            bid.settlement,
            bid.expiry,
            totalNotional,
            totalPremium
        );
    }

    /// @notice Burn one of your own bid nonces so a bid signed with it can never be activated.
    function cancelBid(uint256 nonce) external {
        if (usedBidNonces[msg.sender][nonce]) {
            revert NonceUsed();
        }
        usedBidNonces[msg.sender][nonce] = true;
        emit BidCancelled(msg.sender, nonce);
    }

    // Settlement price publication

    /// @notice The authorized EOA or contract publishes a strictly newer observation for one live cash vault.
    function publishExercisePrice(uint256 vaultId, uint256 price, uint64 observedAt, uint64 validUntil)
        external
        onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE)
    {
        _requireCashPublication(vaultId);
        IvyOptionSettlement.publishExercisePrice(
            _settlementPrices[vaultId],
            vaultId,
            _terms[vaultId].underlying,
            _state[vaultId].quoteToken,
            price,
            observedAt,
            validUntil
        );
    }

    /// @notice Finalize one live cash vault at or after its expiry. Stored prices cannot be replaced.
    function publishExpiry(uint256 vaultId, uint256 price, uint64 validUntil)
        external
        onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE)
    {
        _requireCashPublication(vaultId);
        VaultState storage s = _state[vaultId];
        IvyOptionSettlement.publishExpiry(
            _settlementPrices[vaultId], vaultId, _terms[vaultId].underlying, s.quoteToken, s.expiry, price, validUntil
        );
    }

    // Exercise

    /// @notice Market maker exercises `amount` underlying units. Partial exercise follows the immutable vault term; the vault finalizes
    ///         automatically once everything is exercised.
    function exercise(uint256 vaultId, uint256 amount) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        (uint256 paid, uint256 got) =
            IvyOptionSettlement.exercise(s, _terms[vaultId], _settlementPrices[vaultId], amount);
        emit Exercised(vaultId, amount, paid, got);
        if (s.exercisedNotional == s.totalNotional) {
            _finalize(vaultId, s);
        }
    }

    // Settlement and payouts

    /// @notice Permissionless. Physical: closes the vault. Cash: prices the remaining notional and reserves
    ///         the market maker's payout (collected via `claimPayout`).
    function expire(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (block.timestamp < expirationTimeOf(vaultId)) {
            revert ExpirationNotReached();
        }
        IvyOptionSettlement.expire(s, _terms[vaultId], _settlementPrices[vaultId]);
        _finalize(vaultId, s);
    }

    /// @notice Buyer or executor collects a reserved cash payout or unwind refund for the configured recipient. A failing transfer
    ///         can never block `expire`.
    function claimPayout(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Settled);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker && msg.sender != s.executor) {
            revert NotExecutor();
        }
        IIvyVault vault = IIvyVault(s.vault);
        address collateral = _terms[vaultId].collateral;
        uint256 amount = vault.payBuyer(collateral, s.recipient);
        if (s.premiumToken != collateral) {
            amount += vault.payBuyer(s.premiumToken, s.recipient);
        }
        if (amount == 0) {
            revert NothingToClaim();
        }
        s.pendingPayout = 0;
        emit PayoutClaimed(vaultId, s.marketMaker, amount);
    }

    function claimPremium(uint256 vaultId) external nonReentrant {
        _requireExists(vaultId);
        premiums.claimFor(vaultId, msg.sender);
    }

    function setExecution(uint256 vaultId, address executor, address recipient) external nonReentrant {
        _requireExists(vaultId);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker) {
            revert NotMarketMaker();
        }
        if (recipient == address(0)) {
            revert ZeroAddress();
        }
        s.executor = executor;
        s.recipient = recipient;
        emit ExecutionUpdated(vaultId, executor, recipient);
    }

    // Unwind

    function proposeUnwind(uint256 vaultId, uint64 deadline, uint256 refund, bytes calldata buyerSignature)
        external
        nonReentrant
    {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.owner && msg.sender != s.marketMaker) {
            revert NotVaultOwner();
        }
        unwind.propose(
            vaultId,
            deadline,
            s.exercisedNotional,
            shareToken.totalSupply(vaultId),
            refund,
            s.marketMaker,
            buyerSignature
        );
    }

    function approveUnwind(uint256 vaultId, uint256 nonce) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        unwind.approve(vaultId, nonce, msg.sender, shareToken.balanceOf(msg.sender, vaultId));
    }

    function revokeUnwind(uint256 vaultId) external nonReentrant {
        unwind.revoke(vaultId, msg.sender);
    }

    /// @notice Each current LP deposits premium tokens into this vault's segregated refund reserve.
    function fundUnwind(uint256 vaultId, uint256 nonce, uint256 amount) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (shareToken.balanceOf(msg.sender, vaultId) == 0) {
            revert AgreementInvalid();
        }
        uint256 revision = unwind.revisions(vaultId, msg.sender);
        uint256 received = IIvyVault(s.vault).fundUnwind(msg.sender, amount);
        // A token callback that transfers shares, even away and back, invalidates this funding attempt.
        unwind.fund(vaultId, nonce, msg.sender, received, s.exercisedNotional, revision);
    }

    function withdrawUnwindContribution(uint256 vaultId, uint256 nonce) external nonReentrant {
        _requireExists(vaultId);
        uint256 amount = unwind.withdraw(vaultId, nonce, msg.sender);
        IIvyVault(_state[vaultId].vault).returnUnwind(msg.sender, amount);
    }

    function executeUnwind(uint256 vaultId, uint256 nonce, bytes calldata buyerSignature) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        uint256 refund = unwind.consume(
            vaultId, nonce, s.exercisedNotional, shareToken.totalSupply(vaultId), s.marketMaker, buyerSignature
        );
        IIvyVault(s.vault).consumeUnwind(refund);
        _finalize(vaultId, s);
        emit Unwound(vaultId, nonce, refund);
    }

    // Claims (spec 10)

    /// @notice Burn `shares` for proportional unreserved collateral and settlement proceeds.
    ///         Unpaid activation premium, premium dust and buyer obligations remain reserved.
    function claim(uint256 vaultId, uint256 shares) external nonReentrant {
        _requirePhase(vaultId, Phase.Settled);
        IvyOptionSettlement.claim(_state[vaultId], _terms[vaultId], shareToken, vaultId, shares);
        emit Claimed(vaultId, msg.sender, shares);
    }

    // External views

    /// @notice Preview the next buyer agreement. Intervening proposals or exercises make its signature stale.
    function previewUnwind(uint256 vaultId, uint64 deadline, uint256 refund)
        external
        view
        returns (UnwindAgreement memory agreement, bytes32 digest)
    {
        _requirePhase(vaultId, Phase.Live);
        return
            unwind.preview(
                vaultId, deadline, _state[vaultId].exercisedNotional, shareToken.totalSupply(vaultId), refund
            );
    }

    function exercisePrice(uint256 vaultId)
        external
        view
        returns (uint256 price, uint256 observedAt, uint256 validUntil)
    {
        _requireExists(vaultId);
        ExercisePriceObservation storage observation = _settlementPrices[vaultId].exercise;
        return (observation.price, observation.observedAt, observation.validUntil);
    }

    function settlementPrice(uint256 vaultId) external view returns (uint256 price) {
        _requireExists(vaultId);
        price = _settlementPrices[vaultId].expiry;
        if (price == 0) {
            revert ReportUnavailable();
        }
    }

    function termsOf(uint256 vaultId) external view returns (VaultTerms memory) {
        _requireExists(vaultId);
        return _terms[vaultId];
    }

    function stateOf(uint256 vaultId) external view returns (VaultState memory) {
        _requireExists(vaultId);
        return _state[vaultId];
    }

    function pairTermsOf(uint256 vaultId, address quoteToken) external view returns (PairTerms memory) {
        _requireExists(vaultId);
        return _pairTerms[vaultId][quoteToken];
    }

    function quoteTokensOf(uint256 vaultId) external view returns (address[] memory) {
        _requireExists(vaultId);
        return _quoteTokens[vaultId];
    }

    function vaultOf(uint256 vaultId) external view returns (address) {
        _requireExists(vaultId);
        return _state[vaultId].vault;
    }

    function kindOf(uint256 vaultId) external view returns (OptionKind) {
        _requireExists(vaultId);
        return _state[vaultId].isCall ? OptionKind.CoveredCall : OptionKind.CashSecuredPut;
    }

    // Version

    function version() external pure returns (string memory) {
        return "2";
    }

    // Public views

    /// @notice First moment `expire` may be called: expiry for cash, expiry + exerciseWindow for physical.
    function expirationTimeOf(uint256 vaultId) public view returns (uint256) {
        VaultState storage s = _state[vaultId];
        return s.settlement == SettlementType.Cash ? uint256(s.expiry) : uint256(s.expiry) + s.exerciseWindow;
    }

    /// @notice Shares outstanding for a vault (== credited collateral), read from the share token.
    function totalShares(uint256 vaultId) public view returns (uint256) {
        return shareToken.totalSupply(vaultId);
    }

    function remainingNotional(uint256 vaultId) public view returns (uint256) {
        VaultState storage s = _state[vaultId];
        return s.totalNotional - s.exercisedNotional;
    }

    // Internal helpers

    function _credit(uint256 vaultId, address depositor, uint256 received) internal {
        if (received == 0) {
            revert ZeroAmount();
        }
        shareToken.mint(depositor, vaultId, received);
        emit Deposited(vaultId, depositor, received);
    }

    function _finalize(uint256 vaultId, VaultState storage s) internal {
        s.phase = Phase.Settled;
        emit Settled(vaultId, s.exercisedNotional, s.totalNotional, s.pendingPayout);
    }

    function _grantRole(bytes32 role, address account) internal override returns (bool changed) {
        if (role == SETTLEMENT_PRICE_PUBLISHER_ROLE && account == address(0)) {
            revert ZeroAddress();
        }
        return super._grantRole(role, account);
    }

    // Internal guards

    function _checkDeposit(uint256 vaultId, address depositor, uint256 amount) internal view {
        _admission(vaultId);
        _requirePhase(vaultId, Phase.Open);
        if (amount == 0) {
            revert ZeroAmount();
        }
        if (!_terms[vaultId].publicDeposits && depositor != _state[vaultId].owner) {
            revert DepositsNotPublic();
        }
    }

    function _requireCashSettlementEnabled() internal view {
        if (!cashSettlementEnabled) {
            revert CashSettlementDisabled();
        }
    }

    function _admission(uint256 vaultId) internal view {
        if (paused || vaultPaused[vaultId]) {
            revert AdmissionPaused();
        }
    }

    function _requireExists(uint256 vaultId) internal view {
        if (vaultId == 0 || vaultId > vaultCount) {
            revert UnknownVault();
        }
    }

    function _requirePhase(uint256 vaultId, Phase expected) internal view {
        _requireExists(vaultId);
        Phase actual = _state[vaultId].phase;
        if (actual != expected) {
            revert WrongPhase(expected, actual);
        }
    }

    // Private guards

    function _requireCashPublication(uint256 vaultId) private view {
        _requirePhase(vaultId, Phase.Live);
        if (_state[vaultId].settlement != SettlementType.Cash) {
            revert SettlementNotAllowed();
        }
    }
}
