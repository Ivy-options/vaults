# Ivy Vaults — Design Spec

Date: 2026-09-03
Status: approved in brainstorming, pending written review

## 1. What we are building

A small on-chain system that lets liquidity providers (LPs) put collateral into a
single-use vault and sell one option on it to a market maker chosen through an
off-chain auction. Two contracts:

- **`IvyVaultsHub`** — one upgradeable contract that holds every rule, creates
  vaults, keeps the share ledger (ERC-1155), manages roles, and verifies bids.
- **`IvyVault`** — a minimal clone per vault that only holds tokens and moves
  them when the hub says so. Users approve the vault, never the hub.

Supported products: covered calls and cash-secured puts, European or American
exercise, physical or cash settlement, partial exercise, optional oracle-bounded
strikes.

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Vault lifetime | Single use. One vault, one option, then LPs claim and the vault is done. |
| Bid consent | Market maker signs the bid (EIP-712). Bid master submits it. |
| Shares | ERC-1155 on the hub. Token id = vault id, balance = shares. Transferable. |
| Upgradeability | Hub behind a UUPS proxy. Vaults are immutable EIP-1167 clones. |
| Price feed | Interface only for now (`IIvyPriceFeed`). Real feed comes later. |
| Partial exercise | Supported from day one. |
| Cash settlement | Supported, only on vaults that have a price feed. |
| Auction start | Owner opens it manually or schedules a start time at creation. |
| Naming | `maxTenor` (options term for time-to-expiry). |

## 3. Contracts

### 3.1 `IvyVaultsHub`

Inherits (OpenZeppelin upgradeable 5.x): `UUPSUpgradeable`,
`AccessControlUpgradeable`, `ERC1155SupplyUpgradeable`, `EIP712Upgradeable`,
`ReentrancyGuardUpgradeable`. `_authorizeUpgrade` is admin-only.

Responsibilities: vault creation, deposits/withdrawals, term tightening, auction
lifecycle, bid verification and activation, exercise, settlement, claims, hub
settings, roles.

### 3.2 `IvyVault`

Deployed as an EIP-1167 clone of a single implementation. Storage: `hub`,
`vaultId`, `collateral`. Initialized once by the hub.

```solidity
function initialize(address hub, uint256 vaultId, address collateral) external; // once
function deposit(uint256 amount) external;                                      // anyone
function pull(address token, address from, uint256 amount) external returns (uint256 received); // hub only
function push(address token, address to, uint256 amount) external;             // hub only
```

- `deposit` pulls `amount` of `collateral` from `msg.sender` into the vault
  (SafeERC20 `transferFrom`), measures the balance delta, and calls
  `hub.onVaultDeposit(vaultId, msg.sender, received)`. This is the
  "here is an address, send funds there" flow.
- `pull` returns the balance delta so the hub can credit exactly what arrived
  (fee-on-transfer safe).
- No `receive`/`fallback`; native ETH is rejected.

### 3.3 `IIvyPriceFeed`

```solidity
interface IIvyPriceFeed {
    /// @notice Spot price of `underlying` denominated in `quote`,
    ///         expressed in quote-token decimals per 1 whole underlying.
    /// @return price     the price (must be > 0 to be usable)
    /// @return updatedAt unix timestamp of the last update
    function spot(address underlying, address quote)
        external view returns (uint256 price, uint256 updatedAt);
}
```

The hub applies `maxPriceAge` and `price > 0` itself. One feed contract can
serve every quote token on a vault. A `MockPriceFeed` implements it for tests.

## 4. Data model

### 4.1 Enums

```solidity
enum OptionKind      { CoveredCall, CashSecuredPut }   // derived, never an input (see §4.2)
enum ExerciseStyle   { European, American }
enum ExercisePolicy  { European, American, Either }
enum SettlementType  { Physical, Cash }
enum SettlementPolicy{ Physical, Cash, Either }
enum Phase           { Open, Auction, Live, Settled }
```

### 4.2 Creation input

```solidity
struct VaultTerms {
    address          underlying;          // token being optioned (e.g. WETH)
    address          collateral;          // == underlying for a covered call; a quote token for a cash-secured put
    bool             publicDeposits;      // false = only the vault owner may deposit
    ExercisePolicy   allowedExercise;
    SettlementPolicy allowedSettlement;   // Cash requires priceFeed != 0
    uint64           maxTenor;            // max seconds from activation to expiry, > 0
    uint64           auctionStartsAt;     // 0 = manual only; else anyone may open the auction from this time
    uint256          minCollateral;       // collateral (== shares) required to open the auction
    address          priceFeed;           // 0 = no oracle checks
    uint16           maxSpotDeviationBps; // see §5.1; calls: <= 10000
    uint32           maxPriceAge;         // seconds; > 0 when priceFeed != 0
}

struct PairTerms {
    address premiumToken;  // token the market maker pays premium in
    uint256 strikeLimit;   // calls: min strike (0 = none). puts: max strike (type(uint256).max = none, must be > 0)
    uint256 minPremium;    // premiumToken units per 1 whole underlying
    bool    enabled;
}

struct PairInput { address quoteToken; PairTerms terms; }

function createVault(VaultTerms calldata terms, PairInput[] calldata pairs)
    external returns (uint256 vaultId, address vault);
```

The option kind is **derived, not declared**: `collateral == underlying` makes
the vault a covered call, anything else makes it a cash-secured put. The hub
stores `isCall` and branches on it everywhere (§5, §5.1, §9). `OptionKind` exists
only as a read-only view (`kindOf(vaultId)`) and in the `VaultCreated` event so
UIs and indexers get a human-readable classification. No inconsistent input is
possible.

Creation validation:

- `underlying`, `collateral`, every `quoteToken`, every `premiumToken` non-zero.
- Calls (`collateral == underlying`): at least one pair; every `quoteToken != underlying`; no duplicate quote tokens.
- Puts (`collateral != underlying`): exactly one pair and `pairs[0].quoteToken == collateral`; `strikeLimit > 0`.
- Every pair `enabled == true` at creation.
- `maxTenor > 0`.
- `allowedSettlement` includes `Cash` ⇒ `priceFeed != 0`.
- `priceFeed != 0` ⇒ `maxPriceAge > 0`; calls ⇒ `maxSpotDeviationBps <= 10000`.
- `underlyingUnit = 10 ** IERC20Metadata(underlying).decimals()` is read once and stored.

The caller becomes the vault owner. A clone is created and initialized. Phase = `Open`.

### 4.3 Per-vault storage (hub)

```solidity
struct VaultState {
    address        vault;
    address        owner;
    bool           isCall;             // derived at creation: collateral == underlying
    Phase          phase;
    uint64         auctionOpenedAt;
    uint256        underlyingUnit;
    // set at activation
    address        marketMaker;
    address        quoteToken;
    address        premiumToken;
    uint256        strike;             // quote units per 1 whole underlying
    uint256        premium;            // premiumToken units per 1 whole underlying
    ExerciseStyle  style;
    SettlementType settlement;
    uint64         expiry;
    uint256        totalNotional;      // underlying units
    uint256        exercisedNotional;  // underlying units
    uint256        pendingPayout;      // collateral units reserved for the market maker (cash auto-settle)
}
mapping(uint256 => VaultTerms)  terms;
mapping(uint256 => VaultState)  state;
mapping(uint256 => mapping(address => PairTerms)) pairTerms;   // vaultId => quoteToken => terms
mapping(uint256 => address[])   quoteTokens;                    // enumeration for UIs
mapping(address => mapping(uint256 => bool)) usedBidNonces;     // marketMaker => nonce => used
```

Hub settings: `vaultImplementation`, `exerciseWindow`, `auctionTimeout`,
`settlementGracePeriod` (all admin-settable), plus ERC-1155 `uri`.

## 5. Units and math

- **Shares.** 1 share = 1 smallest unit of collateral. Minted 1:1 on deposit,
  burned 1:1 on withdraw. `totalSupply(vaultId)` is the credited collateral.
- **Strike.** Quote-token units per 1 whole underlying. Example: `3000e6` USDC per WETH.
- **Premium.** Premium-token units per 1 whole underlying.
- **Notional** (underlying units):
  - Call: `totalNotional = totalSupply(vaultId)`.
  - Put: `totalNotional = totalSupply(vaultId) * underlyingUnit / strike` (floor).
- **Total premium** = `premium * totalNotional / underlyingUnit` (floor).
- **Physical call exercise of `amount`:** market maker pays
  `ceil(amount * strike / underlyingUnit)` quote, receives `amount` collateral.
- **Physical put exercise of `amount`:** market maker delivers `amount`
  underlying, receives `floor(amount * strike / underlyingUnit)` quote.
- **Cash call intrinsic of `amount`** (paid in underlying):
  `spot > strike ? amount * (spot - strike) / spot : 0`. Always `< amount`.
- **Cash put intrinsic of `amount`** (paid in quote):
  `strike > spot ? amount * (strike - spot) / underlyingUnit : 0`. Always below the locked quote.
- Rounding always favours the LPs. Dust stays in the vault and is distributed pro-rata at claim.

### 5.1 Strike bounds

Applied at activation. Both bounds must pass; the stricter one wins.

| | Covered call | Cash-secured put |
|---|---|---|
| `strikeLimit` | `strike >= strikeLimit` | `strike <= strikeLimit` |
| Oracle (if `priceFeed != 0`) | `strike >= spot * (10000 - bps) / 10000` | `strike <= spot * (10000 + bps) / 10000` |

`spot` comes from `priceFeed.spot(underlying, quoteToken)`; activation reverts if
`price == 0` or `block.timestamp - updatedAt > maxPriceAge`.

## 6. Lifecycle

```
Open ──openAuction──▶ Auction ──activate──▶ Live ──(fully exercised | settle)──▶ Settled
 ▲                       │
 └────cancelAuction──────┘
```

### 6.1 `Open`

- `deposit(vaultId, amount)` on the hub, or `IvyVault.deposit(amount)` directly.
  Both: vault pulls collateral from the depositor, hub mints `received` shares to
  the depositor. If `!publicDeposits`, depositor must be the owner. Deposits stay
  allowed until the auction is actually opened, even past `auctionStartsAt`.
- `withdraw(vaultId, shares)`: burn shares, vault pushes `shares` collateral to
  the caller. Any share holder may withdraw.
- `tightenVaultTerms`, `tightenPairTerms`, `scheduleAuction` (§8), owner only.
- `openAuction(vaultId)`: owner at any time; anyone once
  `auctionStartsAt != 0 && block.timestamp >= auctionStartsAt`. Requires
  `totalSupply(vaultId) >= minCollateral` and `> 0`. Sets `auctionOpenedAt`,
  phase → `Auction`.
- `transferVaultOwnership(vaultId, newOwner)`: owner, any phase.

### 6.2 `Auction`

Deposits, withdrawals and tightening are rejected.

- `activate(vaultId, bid, signature)`: `BID_MASTER_ROLE` only. See §7.
- `cancelAuction(vaultId)`: bid master at any time; owner once
  `block.timestamp >= auctionOpenedAt + auctionTimeout`. Phase → `Open`,
  `auctionStartsAt` reset to 0 (owner may reschedule).

### 6.3 `Live`

- `exercise(vaultId, amount)`: market maker only. §9.
- `settle(vaultId)`: anyone, once the settlement time is reached. §9.
- Share transfers remain allowed.

### 6.4 `Settled`

- `claim(vaultId, shares)`: burn shares, receive pro-rata of every token. §10.
- `claimPayout(vaultId)`: market maker collects `pendingPayout`. §9.

## 7. Bids and activation

### 7.1 Bid (EIP-712, signed by the market maker)

```solidity
struct Bid {
    uint256        vaultId;
    address        marketMaker;
    address        quoteToken;
    uint256        strike;
    uint256        premium;
    ExerciseStyle  style;
    SettlementType settlement;
    uint64         expiry;      // absolute unix timestamp
    uint64         validUntil;  // signature deadline
    uint256        nonce;       // free-form; consumed on activation
}
```

Domain: name `IvyVaultsHub`, version `1`, chain id, hub proxy address.
Signatures verified with `SignatureChecker.isValidSignatureNow` so contract
market makers (EIP-1271) work. Nonces are non-sequential: a market maker can sign
several competing bids and only the winner is consumed; the rest lapse via
`validUntil`. `cancelBid(nonce)` lets a market maker burn a nonce early.

### 7.2 Activation checks, in order

1. Phase is `Auction`; caller has `BID_MASTER_ROLE`; `bid.vaultId == vaultId`.
2. `bid.marketMaker` has `MARKET_MAKER_ROLE`.
3. `block.timestamp <= bid.validUntil`.
4. Nonce unused; mark it used.
5. Signature valid for `bid.marketMaker`.
6. Pair `bid.quoteToken` exists and is enabled.
7. `bid.style` allowed by `allowedExercise`; `bid.settlement` allowed by `allowedSettlement`.
8. `block.timestamp < bid.expiry` and `bid.expiry - block.timestamp <= maxTenor`.
9. Strike bounds (§5.1).
10. `bid.premium >= pair.minPremium`.
11. `totalNotional` computed (§5) and `> 0`.
12. Vault pulls `totalPremium` of `premiumToken` from the market maker;
    `received >= totalPremium` or revert.
13. Store activation fields, phase → `Live`, emit `Activated`.

The market maker must have approved the **vault address** for the premium
(and later for physical settlement).

## 8. Tightening (owner, `Open` only)

Every change must be equal or tighter for the LP. Anything else reverts.

`tightenVaultTerms(vaultId, {allowedExercise, allowedSettlement, maxTenor, minCollateral, maxSpotDeviationBps, maxPriceAge})`

| Field | Allowed direction |
|---|---|
| `allowedExercise` | `Either` → `European` or `American`; otherwise unchanged |
| `allowedSettlement` | `Either` → `Physical` or `Cash`; otherwise unchanged |
| `maxTenor` | lower |
| `minCollateral` | raise |
| `maxSpotDeviationBps` | lower (ignored when no feed) |
| `maxPriceAge` | lower, must stay `> 0` (ignored when no feed) |

`tightenPairTerms(vaultId, quoteToken, PairTerms)`

| Field | Allowed direction |
|---|---|
| `premiumToken` | must be unchanged |
| `strikeLimit` | calls: raise. puts: lower |
| `minPremium` | raise |
| `enabled` | `true` → `false` only |

Not changeable ever: `underlying`, `collateral` (and therefore the kind), `publicDeposits`,
`priceFeed`, adding pairs, re-enabling pairs.

`scheduleAuction(vaultId, auctionStartsAt)`: owner, `Open`, any value
(operational, not economic).

## 9. Exercise and settlement

Let `remaining = totalNotional - exercisedNotional`,
`settlementTime = settlement == Cash ? expiry : expiry + exerciseWindow`.

### 9.1 `exercise(vaultId, amount)` — market maker only, phase `Live`

Timing:

| | Physical | Cash |
|---|---|---|
| American | `block.timestamp <= expiry + exerciseWindow` | `block.timestamp < expiry` |
| European | `expiry <= block.timestamp <= expiry + exerciseWindow` | never (auto-settles) |

`0 < amount <= remaining`. Then, by kind and settlement (§5 for formulas):

- Physical call: vault pulls quote due from the market maker (`received >= due`), pushes `amount` collateral to them.
- Physical put: vault pulls `amount` underlying from the market maker, pushes quote out to them.
- Cash call/put: read fresh spot; intrinsic must be `> 0` or revert; vault pushes intrinsic to the market maker.

`exercisedNotional += amount`. If `exercisedNotional == totalNotional`, phase →
`Settled` and `Settled` is emitted.

### 9.2 `settle(vaultId)` — anyone, phase `Live`, `block.timestamp >= settlementTime`

- Physical: phase → `Settled`. Unexercised collateral simply stays for the LPs.
- Cash, `remaining > 0`: read spot; compute intrinsic on `remaining` (0 if
  out-of-the-money); `pendingPayout += intrinsic`; `exercisedNotional = totalNotional`;
  phase → `Settled`.
  - If the feed is stale or reverts, `settle` reverts and can be retried.
  - Escape hatch: once `block.timestamp >= expiry + settlementGracePeriod`,
    `settle` accepts a stale price, and if the feed call reverts it settles with
    zero intrinsic. This guarantees LPs can never be locked out by a dead feed.

`claimPayout(vaultId)`: market maker only, phase `Settled`, pushes
`pendingPayout` collateral to the market maker and zeroes it. Pull-based on
purpose: `settle` is permissionless, so a reverting transfer to the market maker
must not be able to block LPs.

Documented caveat: the cash settlement price is the feed's reading at the moment
`settle` is executed at or after expiry. Either side may call it, so neither has
exclusive timing control; the effect is bounded by the feed's update cadence. A
historical lookup can be added to `IIvyPriceFeed` later if a stricter rule is
wanted.

## 10. Claims

`claim(vaultId, shares)`, phase `Settled`, `shares > 0`, caller balance sufficient.

1. `supply = totalSupply(vaultId)` (before burning).
2. Token set = unique of `{collateral, premiumToken, settlementToken}` where
   `settlementToken` is `quoteToken` for calls and `underlying` for puts.
3. For each token: `available = balanceOf(vault) - (token == collateral ? pendingPayout : 0)`;
   `amount = available * shares / supply`; vault pushes `amount` to the caller.
4. Burn `shares` from the caller.

Because shares are burned in the same call, later claimers stay exactly
proportional. This is why premium is never distributed early: a one-shot payout is
safe under free share transfers.

## 11. Roles and settings

| Role | Powers |
|---|---|
| `DEFAULT_ADMIN_ROLE` | upgrade, set `vaultImplementation`, `exerciseWindow`, `auctionTimeout`, `settlementGracePeriod`, `uri`; grant/revoke roles |
| `BID_MASTER_ROLE` | `activate`, `cancelAuction` |
| `MARKET_MAKER_ROLE` | eligible to have signed bids accepted; `exercise`, `claimPayout` on own vaults; `cancelBid` |

Suggested initial settings: `exerciseWindow` 6 hours, `auctionTimeout` 3 days,
`settlementGracePeriod` 7 days. All are seconds and set in `initialize`.

## 12. Events and errors

Events: `VaultCreated`, `Deposited`, `Withdrawn`, `VaultTermsTightened`,
`PairTermsTightened`, `AuctionScheduled`, `AuctionOpened`, `AuctionCancelled`,
`Activated` (full bid), `Exercised(vaultId, amount, paid, received)`,
`Settled(vaultId, exercisedNotional, totalNotional, pendingPayout)`,
`Claimed`, `PayoutClaimed`, `BidCancelled`, `VaultOwnershipTransferred`,
`SettingsUpdated`.

Errors are custom errors, one per failure reason (e.g. `WrongPhase`, `NotOwner`,
`DepositsNotPublic`, `PairDisabled`, `StyleNotAllowed`, `SettlementNotAllowed`,
`TenorTooLong`, `StrikeBelowLimit`, `StrikeAboveLimit`, `StrikeOutsideSpotBand`,
`StalePrice`, `PremiumTooLow`, `BidExpired`, `NonceUsed`, `BadSignature`,
`NotMarketMaker`, `ExerciseWindowClosed`, `NothingToExercise`, `LoosensTerms`).

## 13. Security notes

- All token-moving hub entry points are `nonReentrant`; effects before interactions.
- ERC-1155 mint callbacks run inside guarded functions, so re-entering through
  `onERC1155Received` reverts. Contract depositors must implement the receiver.
- Fee-on-transfer tokens: deposits credit the measured delta; premium and
  settlement pulls require `received >= due`.
- The hub never holds tokens. Every approval targets a vault, limiting blast
  radius to that vault.
- Bid replay is prevented by nonce + `validUntil` + domain-bound signature.
- A dead feed cannot lock LP funds (grace-period escape hatch in §9.2).
- Upgrade authority is the admin; storage layout must be append-only.

## 14. Testing plan

TypeScript tests, Hardhat 3 + mocha + ethers, one file per concern:

1. `createVault` validation for both kinds, clone initialization, ownership.
2. Deposits (hub path, direct vault path, public vs owner-only, delta crediting) and withdrawals.
3. Tightening: every allowed direction succeeds, every loosening reverts, wrong phase reverts.
4. Auction: manual open, scheduled open by a stranger, collateral floor, cancel by bid master, cancel by owner only after timeout, reset of schedule.
5. Activation happy paths (call/put × physical/cash × European/American) and the rejection matrix for every check in §7.2.
6. Exercise: timing windows per style/settlement, partial exercise accounting, physical settlement math with rounding, cash intrinsic math, out-of-the-money reverts, auto-settle on full exercise.
7. Settlement: physical after window, cash at expiry with pending payout, stale-feed revert, grace-period fallback, `claimPayout`.
8. Claims: several LPs, transfers before claim, pending payout excluded, dust behaviour, multi-token pots.
9. Access control for every role and the UUPS upgrade smoke test (deploy V2, state preserved).

Mocks: `MockERC20` (configurable decimals, optional transfer fee), `MockPriceFeed`.

## 15. Tooling and layout

- Hardhat 3.15 with `@nomicfoundation/hardhat-toolbox-mocha-ethers`, TypeScript, ESM.
- Solidity latest 0.8.x supported by Hardhat 3, optimizer on, `viaIR` if the hub needs it.
- `@openzeppelin/contracts` and `@openzeppelin/contracts-upgradeable` 5.6.x.
- Proxy deployed as `ERC1967Proxy` directly (Ignition module and tests). The
  upgrades plugin can be added later for storage-layout validation.

```
contracts/
  IvyVaultsHub.sol
  IvyVault.sol
  types/IvyTypes.sol            # enums, structs, errors, events
  interfaces/IIvyPriceFeed.sol
  interfaces/IIvyVault.sol
  libraries/BidHash.sol         # EIP-712 typehash + struct hashing
  mocks/MockERC20.sol
  mocks/MockPriceFeed.sol
ignition/modules/IvyVaults.ts
test/*.test.ts
hardhat.config.ts
```

If `IvyVaultsHub.sol` grows past roughly 600 lines, split the settlement/claim
logic into an abstract parent (`IvyVaultsSettlement`) that the hub inherits.

## 16. Out of scope (for now)

Protocol fee on premium, pausing, bid-master-signature relay (permissionless
activation), `permit`-based deposits, multi-underlying put vaults, historical
settlement prices in the feed interface.
