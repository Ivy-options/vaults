// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev Mirror of the hub's `Bid` struct and EIP-712 type string, as of ivy-options/vaults @ 4edf8d5.
///      Kept as a copy on purpose: this contract must not depend on the hub's source tree.
///      If `ivy-options/vaults` changes the struct, the typehash below stops matching and every
///      bid is rejected — a loud failure, not a silent mispricing.
struct Bid {
    uint256 vaultId;
    address marketMaker;
    address quoteToken;
    uint256 strike;
    uint256 premiumPerUnit; // premium-token units per whole underlying (hub renamed it at cc91e60; same quantity)
    uint8 style; // 0 European, 1 American
    uint8 settlement; // 0 Physical, 1 Cash
    uint64 expiry;
    uint64 validUntil;
    uint256 nonce;
    uint256 auctionId;
    uint256 collateralAmount;
    bytes32 termsHash; // hub commitment to terms, pairs and bid rules (replaced pairHash at cc91e60)
    bytes32 marketMakerDataHash; // keccak256(abi.encode(marketMakerData)) passed to activate (added at 4edf8d5)
    address executor;
    address recipient;
}

bytes32 constant BID_TYPEHASH = keccak256(
    "Bid(uint256 vaultId,address marketMaker,address quoteToken,uint256 strike,uint256 premiumPerUnit,uint8 style,uint8 settlement,uint64 expiry,uint64 validUntil,uint256 nonce,uint256 auctionId,uint256 collateralAmount,bytes32 termsHash,bytes32 marketMakerDataHash,address executor,address recipient)"
);

/// @dev What the desk signs: a standing vol quote for one asset pair, good for any vault and any
///      expiry inside the grid until `validUntil`. The grid holds the **most** the desk pays, as bps of
///      `premiumBasis`, at each (moneyness, time-to-expiry) node; bilinear in between, refused outside.
///
///      Why this is a vol quote and not a price: with strike expressed as moneyness and premium as a
///      fraction of the collateral's own unit, the option price depends only on (moneyness, sigma^2 * tau).
///      So a fixed grid in those coordinates is a fixed vol surface — spot can move and time can pass
///      without the desk re-signing. Pick the basis that matches the vault:
///        0 SPOT   — covered call, premium in the quote token: bps of spot (collateral value per unit)
///        1 STRIKE — cash-secured put: bps of strike (collateral locked per unit)
///        2 UNIT   — premium in the underlying: bps of `premiumUnit` (e.g. 1e18 for WETH)
struct Surface {
    address underlying;
    address quoteToken;
    address premiumToken;
    uint64 validUntil;
    uint256 maxCollateral; // largest single vault this quote is good for, in collateral units
    uint8 premiumBasis; // 0 spot, 1 strike, 2 fixed unit
    uint256 premiumUnit; // used only when premiumBasis == 2
    uint8 allowedStyles; // bitmask: 1 = European, 2 = American
    uint8 allowedSettlements; // bitmask: 1 = Physical, 2 = Cash
    address executor; // must match Bid.executor
    address recipient; // must match Bid.recipient
    uint32[] moneynessBps; // strike / spot in bps, strictly ascending, at least two
    uint32[] tenors; // seconds to expiry, strictly ascending, at least two
    uint32[] premiumBps; // row-major: premiumBps[i * tenors.length + j] = moneyness i, tenor j
}

bytes32 constant SURFACE_TYPEHASH = keccak256(
    "Surface(address underlying,address quoteToken,address premiumToken,uint64 validUntil,uint256 maxCollateral,uint8 premiumBasis,uint256 premiumUnit,uint8 allowedStyles,uint8 allowedSettlements,address executor,address recipient,uint32[] moneynessBps,uint32[] tenors,uint32[] premiumBps)"
);

uint8 constant BASIS_SPOT = 0;
uint8 constant BASIS_STRIKE = 1;
uint8 constant BASIS_UNIT = 2;

/// @dev A spot observation the desk is willing to be priced against, for one asset pair.
struct SpotReport {
    address underlying;
    address quoteToken;
    uint256 spot; // quote-token units per whole underlying
    uint64 observedAt;
}

bytes32 constant SPOT_TYPEHASH =
    keccak256("SpotReport(address underlying,address quoteToken,uint256 spot,uint64 observedAt)");
