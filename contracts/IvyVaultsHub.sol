// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IvyPremiums } from "./IvyPremiums.sol";
import { IvyUnwind } from "./IvyUnwind.sol";
import { IIvyShares } from "./interfaces/IIvyShares.sol";
import { IIvyVault } from "./interfaces/IIvyVault.sol";
import { IIvyVaultsHub } from "./interfaces/IIvyVaultsHub.sol";
import { IIvyVaultsHubErrors } from "./interfaces/IIvyVaultsHubErrors.sol";
import { IIvyVaultsHubEvents } from "./interfaces/IIvyVaultsHubEvents.sol";
import { BidHash } from "./libraries/BidHash.sol";
import { IvyMath } from "./libraries/IvyMath.sol";
import { IvyOptionSettlement } from "./libraries/IvyOptionSettlement.sol";
import { IvyVaultRules } from "./libraries/IvyVaultRules.sol";
import "./types/IvyTypes.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Creates option vaults and manages their lifecycle.
/// @dev Vaults hold tokens; Shares tracks LP balances; Premiums and Unwind track their respective claims.
///      Linked libraries run in Hub storage through guarded entrypoints.
contract IvyVaultsHub is IIvyVaultsHubEvents, IIvyVaultsHubErrors, AccessControl, EIP712, ReentrancyGuardTransient, IIvyVaultsHub {
	struct PlatformFee {
		uint16 rateBps;
		address recipient;
		uint256 amount;
	}

	bytes32 public constant BID_MASTER_ROLE = keccak256("BID_MASTER_ROLE");
	bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
	bytes32 public constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");
	bytes32 public constant PLATFORM_FEE_MANAGER_ROLE = keccak256("PLATFORM_FEE_MANAGER_ROLE");
	bytes32 public constant SETTLEMENT_PRICE_PUBLISHER_ROLE = keccak256("SETTLEMENT_PRICE_PUBLISHER_ROLE");

	address public immutable vaultImplementation;
	IvyPremiums public immutable premiums;
	IvyUnwind public immutable unwind;
	IIvyShares public immutable shareToken;

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
	uint64 public expiryPricePublicationWindow;
	uint256 public vaultCount;
	mapping(uint256 vaultId => VaultTerms) internal _terms;
	mapping(uint256 vaultId => VaultState) internal _state;
	mapping(uint256 vaultId => mapping(address quoteToken => address premiumToken)) internal _premiumTokens;
	mapping(uint256 vaultId => address[]) internal _quoteTokens;
	mapping(uint256 vaultId => BidRule[]) internal _rules;
	mapping(uint256 vaultId => bytes32) internal _termsHash;
	mapping(address marketMaker => mapping(uint256 nonce => bool)) public usedBidNonces;

	/// @notice Premium fee rate fixed at vault creation, including a zero rate.
	mapping(uint256 vaultId => uint16) public vaultPlatformFeeBps;

	event PlatformFeeAllocated(uint256 indexed vaultId, address indexed recipient, uint16 rateBps, uint256 amount);
	event PlatformFeeBpsUpdated(uint16 oldRate, uint16 newRate);
	event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);
	event TransfersEnabledUpdated(bool enabled);

	error InvalidPlatformFee();

	modifier onlyVaultOwner(uint256 vaultId) {
		_requireExists(vaultId);
		if (msg.sender != _state[vaultId].owner) {
			revert NotVaultOwner();
		}
		_;
	}

	constructor(
		address admin,
		address implementation,
		address shares_,
		address premiums_,
		address unwind_,
		uint64 window_,
		uint64 timeout_,
		uint64 publicationWindow_
	) EIP712("IvyVaultsHub", "3") {
		if (admin == address(0) || implementation == address(0) || shares_ == address(0) || premiums_ == address(0) || unwind_ == address(0)) {
			revert ZeroAddress();
		}
		if (implementation.code.length == 0) {
			revert BindingMismatch();
		}
		if (publicationWindow_ == 0) {
			revert InvalidSettlementWindow();
		}
		vaultImplementation = implementation;
		shareToken = IIvyShares(shares_);
		premiums = IvyPremiums(premiums_);
		unwind = IvyUnwind(unwind_);
		exerciseWindow = window_;
		auctionTimeout = timeout_;
		expiryPricePublicationWindow = publicationWindow_;
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(GUARDIAN_ROLE, admin);
		_grantRole(PLATFORM_FEE_MANAGER_ROLE, admin);
		platformTreasury = admin;
	}

	function setPlatformFeeBps(uint16 rate) external onlyRole(PLATFORM_FEE_MANAGER_ROLE) {
		if (rate > IvyMath.BPS) {
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

	/// @notice Gate new cash vaults and cash bid activations. Existing positions are unaffected.
	/// @dev Enabling this does not grant the publisher role.
	function setCashSettlementEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
		cashSettlementEnabled = enabled;
		emit CashSettlementEnabledUpdated(enabled);
	}

	function setSettings(uint64 window_, uint64 timeout_, uint64 publicationWindow_) external onlyRole(DEFAULT_ADMIN_ROLE) {
		if (publicationWindow_ == 0) {
			revert InvalidSettlementWindow();
		}
		exerciseWindow = window_;
		auctionTimeout = timeout_;
		expiryPricePublicationWindow = publicationWindow_;
		emit SettingsUpdated(window_, timeout_, publicationWindow_);
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

	/// @notice Create a vault with bid terms, token pairs, and rules.
	/// @dev `collateral == underlying` makes a covered call; otherwise the vault is a put.
	function createVault(
		VaultTerms calldata terms,
		PairConfig[] calldata pairs,
		BidRule[] calldata rules
	) external nonReentrant returns (uint256 vaultId, address vault) {
		_admission(0);
		if (terms.allowedSettlement != SettlementPolicy.Physical) {
			_requireCashSettlementEnabled();
			if (exerciseWindow == 0) {
				revert InvalidSettlementWindow();
			}
		}
		if (
			shareToken.hub() != address(this) ||
			premiums.hub() != address(this) ||
			unwind.hub() != address(this) ||
			shareToken.premiums() != address(premiums) ||
			shareToken.unwind() != address(unwind) ||
			premiums.shares() != address(shareToken) ||
			unwind.shares() != address(shareToken)
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
		s.expiryPricePublicationWindow = expiryPricePublicationWindow;
		s.isCall = isCall;
		s.phase = Phase.Open;
		s.underlyingUnit = 10 ** IERC20Metadata(terms.underlying).decimals();

		for (uint256 i = 0; i < pairs.length; ++i) {
			_premiumTokens[vaultId][pairs[i].quoteToken] = pairs[i].premiumToken;
			_quoteTokens[vaultId].push(pairs[i].quoteToken);
		}
		_termsHash[vaultId] = IvyVaultRules.adoptRules(_rules[vaultId], terms, pairs, rules);

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

	/// @notice Deposit collateral through the hub. Approve the vault address to spend it first.
	function deposit(uint256 vaultId, uint256 amount) external nonReentrant {
		_checkDeposit(vaultId, msg.sender, amount);
		uint256 received = IIvyVault(_state[vaultId].vault).pull(_terms[vaultId].collateral, msg.sender, amount);
		_credit(vaultId, msg.sender, received);
	}

	/// @inheritdoc IIvyVaultsHub
	function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external nonReentrant {
		if (msg.sender != _state[vaultId].vault) {
			revert NotVault();
		}
		_checkDeposit(vaultId, depositor, amount);
		_credit(vaultId, depositor, amount);
	}

	/// @notice Burn shares for collateral while the vault is Open.
	function withdraw(uint256 vaultId, uint256 shares) external nonReentrant {
		_requirePhase(vaultId, Phase.Open);
		if (shares == 0) {
			revert ZeroAmount();
		}
		shareToken.burn(msg.sender, vaultId, shares);
		IIvyVault(_state[vaultId].vault).push(_terms[vaultId].collateral, msg.sender, shares);
		emit Withdrawn(vaultId, msg.sender, shares);
	}

	/// @notice Set when anyone may open the auction; zero restricts opening to the owner.
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

	/// @notice Freeze deposits and open the auction. The owner can act any time; others wait for `auctionStartsAt`.
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

	/// @notice Cancel the auction and clear its schedule. The owner must wait for timeout, expiry, or a pause.
	/// @dev The bid master can cancel any time.
	function cancelAuction(uint256 vaultId) external {
		_requirePhase(vaultId, Phase.Auction);
		VaultState storage s = _state[vaultId];
		if (!hasRole(BID_MASTER_ROLE, msg.sender)) {
			if (msg.sender != s.owner) {
				revert NotVaultOwner();
			}
			if (!paused && !vaultPaused[vaultId] && block.timestamp < s.expiry && block.timestamp < uint256(s.auctionOpenedAt) + s.auctionTimeout) {
				revert AuctionTimeoutNotReached();
			}
		}
		s.phase = Phase.Open;
		s.auctionOpenedAt = 0;
		_terms[vaultId].auctionStartsAt = 0;
		emit AuctionCancelled(vaultId);
	}

	/// @notice Activate the market maker's signed bid. Only the bid master may submit it.
	function activate(uint256 vaultId, Bid calldata bid, bytes calldata signature) external nonReentrant onlyRole(BID_MASTER_ROLE) {
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
		address premiumToken = _premiumTokens[vaultId][bid.quoteToken];
		uint256 supply = shareToken.totalSupply(vaultId);
		uint256 totalNotional = IvyVaultRules.checkBid(s, t, _rules[vaultId], premiumToken, _termsHash[vaultId], bid, supply);
		uint256 totalPremium = IvyMath.premiumTotal(bid.premium, totalNotional, s.underlyingUnit);

		s.marketMaker = bid.marketMaker;
		s.executor = bid.executor;
		s.recipient = bid.recipient;
		s.quoteToken = bid.quoteToken;
		s.premiumToken = premiumToken;
		s.strike = bid.strike;
		s.premium = bid.premium;
		s.style = bid.style;
		s.settlement = bid.settlement;
		s.totalNotional = totalNotional;
		s.phase = Phase.Live;

		uint16 feeRate = vaultPlatformFeeBps[vaultId];
		address treasury = platformTreasury;
		uint256 fee = Math.mulDiv(totalPremium, feeRate, IvyMath.BPS);
		platformFees[vaultId] = PlatformFee(feeRate, treasury, fee);
		premiums.activate(vaultId, s.vault, totalPremium - fee, supply);
		IIvyVault(s.vault).collectPremium(premiumToken, bid.marketMaker, totalPremium, fee, treasury);
		emit PlatformFeeAllocated(vaultId, treasury, feeRate, fee);

		emit Activated(
			vaultId,
			bid.marketMaker,
			bid.quoteToken,
			premiumToken,
			bid.strike,
			bid.premium,
			bid.style,
			bid.settlement,
			bid.expiry,
			totalNotional,
			totalPremium
		);
	}

	/// @notice Invalidate one of your bid nonces.
	function cancelBid(uint256 nonce) external {
		if (usedBidNonces[msg.sender][nonce]) {
			revert NonceUsed();
		}
		usedBidNonces[msg.sender][nonce] = true;
		emit BidCancelled(msg.sender, nonce);
	}

	/// @notice Publish a newer exercise price for one live cash vault.
	function publishExercisePrice(
		uint256 vaultId,
		uint256 price,
		uint64 observedAt,
		uint64 validUntil
	) external onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE) {
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

	/// @notice Publish the final cash price during the vault's fixed publication window.
	/// @dev A finalized price cannot be replaced.
	function publishExpiry(uint256 vaultId, uint256 price, uint64 validUntil) external onlyRole(SETTLEMENT_PRICE_PUBLISHER_ROLE) {
		_requireCashPublication(vaultId);
		VaultState storage s = _state[vaultId];
		IvyOptionSettlement.publishExpiry(
			_settlementPrices[vaultId],
			vaultId,
			_terms[vaultId].underlying,
			s.quoteToken,
			s.expiry,
			s.expiryPricePublicationWindow,
			price,
			validUntil
		);
	}

	/// @notice Exercise `amount` underlying units. The market maker or executor may call this.
	/// @dev Partial exercise follows the vault term; exercising the remainder finalizes the vault.
	function exercise(uint256 vaultId, uint256 amount) external nonReentrant {
		_exercise(vaultId, amount, false);
	}

	/// @notice Exercise physically if a cash vault's price publication window closed without a final price.
	function exercisePhysicalFallback(uint256 vaultId, uint256 amount) external nonReentrant {
		_exercise(vaultId, amount, true);
	}

	/// @notice Finalize a live vault once its settlement deadline passes. Anyone may call.
	/// @dev A final cash price reserves the buyer payout; without one, remaining notional lapses after the fallback window.
	function expire(uint256 vaultId) external nonReentrant {
		_requirePhase(vaultId, Phase.Live);
		IvyOptionSettlement.expire(_state[vaultId], _terms[vaultId], _settlementPrices[vaultId], vaultId);
	}

	/// @notice Send a reserved cash payout or unwind refund to the buyer's chosen recipient.
	/// @dev Only the buyer or executor may call. Contract recipients receive a best-effort `IIvyPayoutReceiver` callback.
	function claimPayout(uint256 vaultId) external nonReentrant {
		_requirePhase(vaultId, Phase.Settled);
		IvyOptionSettlement.claimPayout(_state[vaultId], _terms[vaultId], vaultId);
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

	function proposeUnwind(uint256 vaultId, uint64 deadline, uint256 refund, bytes calldata buyerSignature) external nonReentrant {
		_requirePhase(vaultId, Phase.Live);
		VaultState storage s = _state[vaultId];
		if (msg.sender != s.owner && msg.sender != s.marketMaker) {
			revert NotVaultOwner();
		}
		unwind.propose(vaultId, deadline, s.exercisedNotional, shareToken.totalSupply(vaultId), refund, s.marketMaker, buyerSignature);
	}

	function approveUnwind(uint256 vaultId, uint256 nonce) external nonReentrant {
		_requirePhase(vaultId, Phase.Live);
		unwind.approve(vaultId, nonce, msg.sender, shareToken.balanceOf(msg.sender, vaultId));
	}

	function revokeUnwind(uint256 vaultId) external nonReentrant {
		unwind.revoke(vaultId, msg.sender);
	}

	/// @notice Fund this vault's unwind refund reserve with premium tokens.
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
		uint256 refund = unwind.consume(vaultId, nonce, s.exercisedNotional, shareToken.totalSupply(vaultId), s.marketMaker, buyerSignature);
		IIvyVault(s.vault).consumeUnwind(refund);
		_finalize(vaultId, s);
		emit Unwound(vaultId, nonce, refund);
	}

	/// @notice Burn shares for proportional unreserved collateral and settlement proceeds.
	/// @dev Unpaid premium, premium dust, and buyer obligations remain reserved.
	function claim(uint256 vaultId, uint256 shares) external nonReentrant {
		_requirePhase(vaultId, Phase.Settled);
		IvyOptionSettlement.claim(_state[vaultId], _terms[vaultId], shareToken, vaultId, shares);
		emit Claimed(vaultId, msg.sender, shares);
	}

	/// @notice Preview the next buyer agreement. A new proposal or exercise invalidates its signature.
	function previewUnwind(
		uint256 vaultId,
		uint64 deadline,
		uint256 refund
	) external view returns (UnwindAgreement memory agreement, bytes32 digest) {
		_requirePhase(vaultId, Phase.Live);
		return unwind.preview(vaultId, deadline, _state[vaultId].exercisedNotional, shareToken.totalSupply(vaultId), refund);
	}

	function exercisePrice(uint256 vaultId) external view returns (uint256 price, uint256 observedAt, uint256 validUntil) {
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

	function pairOf(uint256 vaultId, address quoteToken) external view returns (address premiumToken) {
		_requireExists(vaultId);
		return _premiumTokens[vaultId][quoteToken];
	}

	function rulesOf(uint256 vaultId) external view returns (BidRule[] memory) {
		_requireExists(vaultId);
		return _rules[vaultId];
	}

	function termsHashOf(uint256 vaultId) external view returns (bytes32) {
		_requireExists(vaultId);
		return _termsHash[vaultId];
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

	function version() external pure returns (string memory) {
		return "3";
	}

	/// @notice Current settlement route and fallback deadlines. `Inactive` means the vault is not Live.
	function settlementStatus(
		uint256 vaultId
	) external view returns (SettlementRoute route, uint256 publicationDeadline, uint256 fallbackDeadline, bool canExpire) {
		_requireExists(vaultId);
		return IvyOptionSettlement.settlementStatus(_state[vaultId], _settlementPrices[vaultId]);
	}

	/// @notice Cash with an accepted price expires at expiry; otherwise LP recovery waits for both fallback windows.
	function expirationTimeOf(uint256 vaultId) public view returns (uint256) {
		_requireExists(vaultId);
		return IvyOptionSettlement.expirationTime(_state[vaultId], _settlementPrices[vaultId]);
	}

	/// @notice Shares outstanding for a vault, equal to credited collateral units.
	function totalShares(uint256 vaultId) public view returns (uint256) {
		return shareToken.totalSupply(vaultId);
	}

	function remainingNotional(uint256 vaultId) public view returns (uint256) {
		VaultState storage s = _state[vaultId];
		return s.totalNotional - s.exercisedNotional;
	}

	function _exercise(uint256 vaultId, uint256 amount, bool physicalFallback) internal {
		_requirePhase(vaultId, Phase.Live);
		IvyOptionSettlement.exercise(_state[vaultId], _terms[vaultId], _settlementPrices[vaultId], vaultId, amount, physicalFallback);
	}

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

	function _requireCashPublication(uint256 vaultId) private view {
		_requirePhase(vaultId, Phase.Live);
		if (_state[vaultId].settlement != SettlementType.Cash) {
			revert SettlementNotAllowed();
		}
	}
}
