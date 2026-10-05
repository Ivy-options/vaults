// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Bid} from "./IvyBidTypes.sol";

/// @dev Mirrors of the hub's validator ABI types, as of ivy-options/vaults @ 4edf8d5. Enums travel as
///      uint8, so these produce the same function selectors as their `IIvyBidValidator` — the hub checks
///      the returned selector, so a layout drift on their side fails loudly at vault creation.
struct HubVaultTerms {
    address underlying;
    address collateral;
    bool allowPartialExercise;
    bool publicDeposits;
    uint8 allowedExercise;
    uint8 allowedSettlement;
    uint64 auctionStartsAt; // VaultTerms.expiry was removed at 4edf8d5: the bid picks its expiry
    uint256 minCollateral;
    uint32 maxSettlementPriceAge;
}

struct HubPairConfig {
    address quoteToken;
    address premiumToken;
}

struct HubBidContext {
    uint256 vaultId;
    bool isCall;
    address underlying;
    address collateral;
    address premiumToken;
    uint256 underlyingUnit;
    uint256 collateralAmount;
    uint256 totalNotional;
    uint64 auctionOpenedAt;
}

interface ISpotFeed {
    function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt);
}

interface IFeeView {
    function vaultPlatformFeeBps(uint256 vaultId) external view returns (uint16);
}

/// @title IvyAprFloorRule (rule kind `PremiumNetAprFloor`)
/// @notice A depositor's floor in the unit depositors already think in: annualised premium over the
///         collateral they lock. "At least 12% APR" is checked at activation as
///
///             premium received  >=  12% x (expiry - now) / 365 days x collateral value
///
///         so the floor follows each vault's own tenor instead of being one number for every expiry,
///         and it is measured **after** the platform fee, because that is what the depositor gets.
///
///         Premium as a fraction of collateral is the scale-free form: it needs no price when premium
///         and collateral are the same token (cash-secured puts paid in USDC, covered calls paid in the
///         underlying). A covered call paid in the quote token must value the collateral, so it reads
///         the one feed this contract was deployed with — the same trust their `PremiumSpotFloor` takes.
///         The standalone form of `PremiumNetAprFloor`: usable on a hub as deployed with one role grant.
contract IvyAprFloorRule {
    bytes4 public constant PREMIUM_NET_APR_FLOOR = bytes4(keccak256("PremiumNetAprFloor"));

    /// @param minAprBps   annualised floor, bps of collateral value (1200 = 12%)
    /// @param maxPriceAge seconds; only read when the vault needs a price
    struct PremiumNetAprFloorRule {
        uint16 minAprBps;
        uint32 maxPriceAge;
    }

    address public immutable trustedPriceFeed;

    error UnknownRuleKind(bytes4 kind);
    error InvalidAprFloor();
    error UnsupportedPair(address quoteToken, address premiumToken);
    error StalePrice();
    error AprBelowFloor(uint256 netPremium, uint256 required);

    constructor(address trustedPriceFeed_) {
        trustedPriceFeed = trustedPriceFeed_;
    }

    function validateConfig(bytes4 kind, HubVaultTerms calldata terms, HubPairConfig[] calldata pairs, bytes calldata data)
        external
        view
        returns (bytes4)
    {
        if (kind != PREMIUM_NET_APR_FLOOR) revert UnknownRuleKind(kind);
        PremiumNetAprFloorRule memory rule = abi.decode(data, (PremiumNetAprFloorRule));
        if (rule.minAprBps == 0) revert InvalidAprFloor();
        for (uint256 i = 0; i < pairs.length; ++i) {
            if (pairs[i].premiumToken == terms.collateral) continue; // same token: no price needed
            // The only other shape we value: a covered call paid in its quote token.
            bool callPaidInQuote = terms.collateral == terms.underlying && pairs[i].premiumToken == pairs[i].quoteToken;
            if (!callPaidInQuote || trustedPriceFeed.code.length == 0 || rule.maxPriceAge == 0) {
                revert UnsupportedPair(pairs[i].quoteToken, pairs[i].premiumToken);
            }
        }
        return this.validateConfig.selector;
    }

    /// @dev Called by the hub through STATICCALL after its own checks, so msg.sender is the hub.
    /// @dev Reads only its frozen `config`; the bidder's and the bid master's slots are ignored, so the
    ///      floor never depends on anything supplied at activation.
    function validateBid(
        bytes4 kind,
        HubBidContext calldata c,
        Bid calldata bid,
        bytes calldata config,
        bytes calldata, /* marketMakerData */
        bytes calldata /* bidMasterData */
    ) external view returns (bytes4) {
        if (kind != PREMIUM_NET_APR_FLOOR) revert UnknownRuleKind(kind);
        PremiumNetAprFloorRule memory rule = abi.decode(config, (PremiumNetAprFloorRule));

        // what the vault will pull from the bidder, then what the depositors keep after the fee
        uint256 gross = (bid.premiumPerUnit * c.totalNotional) / c.underlyingUnit;
        uint256 net = gross - Math.mulDiv(gross, IFeeView(msg.sender).vaultPlatformFeeBps(c.vaultId), 10_000);

        uint256 collateralValue = c.premiumToken == c.collateral
            ? c.collateralAmount
            : (c.collateralAmount * _spot(rule, c.underlying, c.premiumToken)) / c.underlyingUnit;

        uint256 tau = uint256(bid.expiry) - block.timestamp; // the bid's own expiry; the hub refused expiry <= now
        uint256 required =
            Math.mulDiv(collateralValue * rule.minAprBps, tau, 365 days * 10_000, Math.Rounding.Ceil);
        if (net < required) revert AprBelowFloor(net, required);
        return this.validateBid.selector;
    }

    function _spot(PremiumNetAprFloorRule memory rule, address underlying, address quote) private view returns (uint256) {
        (uint256 price, uint256 updatedAt) = ISpotFeed(trustedPriceFeed).spot(underlying, quote);
        if (price == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > rule.maxPriceAge) {
            revert StalePrice();
        }
        return price;
    }
}
