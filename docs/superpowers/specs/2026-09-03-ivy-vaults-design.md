# Ivy Vaults contract design

This document describes the fresh immutable implementation. It supersedes the earlier upgradeable design at this path. Read the [operator runbook](../../operations.md) for deployment and transaction preparation.

## Actors and lifecycle

A vault owner chooses collateral, accepted quote pairs, exact expiry and execution policies. With private deposits only the owner deposits; public pooling is optional. LPs receive transferable ERC-1155 shares, one raw unit per raw collateral unit received. The bid master activates a buyer's signed option bid. The buyer (called `marketMaker` in the ABI) pays premium and may exercise itself or appoint an executor. Anyone can settle when the option's window closes.

`Open → Auction → Live → Settled` is the normal lifecycle. Auction cancellation returns to Open and clears the schedule. Each new auction increments its identifier. Full exercise and a unanimous Live-phase unwind finalize directly into Settled. A settled vault is never reused.

While Open, holders can withdraw collateral 1:1. Deposits and withdrawals stop in Auction. Share transfers remain available in every phase. After finalization, shares claim the remaining unreserved assets proportionally. Premium income is a separate entitlement fixed at activation.

## Fixed deployment and authority

Eight deployment steps run in exact nonce order: IvyVaultRules library, IvyOptionSettlement library, vault implementation, hub, shares, premium module, unwind module, signed-price feed. The deployment plan predicts all addresses before submission and links hub creation bytecode using compiler-provided library references. Library addresses are embedded in runtime bytecode, with no replacement setter. The hub, shares and modules have immutable reciprocal bindings. The implementation is locked against initialization; each clone is initialized once, atomically on creation.

The hub constructor rejects an undeployed implementation. Vault creation checks reciprocal module bindings and rejects missing feed code when a feed is configured. Calls to undeployed peers cannot complete creation. There are no implementation or module setters, hub initializer, UUPS entrypoints, or replaceable hub proxy. The deployment journal verifies chain identity, deployer, nonce, exact creation transaction, receipt address, runtime size/hash and peer bindings before adopting an existing step. The final binding check also compares every compiler-reported runtime library address against the plan; full code provenance comes from the exact creation transaction checks, not just those embedded addresses. A lost transaction hash can be recovered by scanning from the persisted start block. Nonce drift stops execution.

The administrator manages roles, metadata URI and defaults for future vaults. The guardian controls admission pauses. The administrator initially holds guardian authority; bid-master and market-maker roles must be granted explicitly. Administrators cannot seize assets or alter an existing vault's expiry, oracle, timing snapshots or immutable bindings. Role management and admission are still administrative powers; immutable code does not remove those powers.

## Linked hub libraries

`IvyVaultRules` implements creation validation and vault/pair term tightening. Creation keeps its admission check in the hub; tightening keeps its owner and Open-phase checks there. `IvyOptionSettlement` implements exercise funding and payouts, cash-expiry reserve calculations and proportional residual claims. The hub retains public entrypoints, phase checks, the transient reentrancy guard, events and finalization. Buyer payout claims, premium claims and unwind orchestration remain in the hub.

Solidity calls these external library functions through fixed `DELEGATECALL` targets. Storage references point into the hub's own vault records, and `msg.sender` remains the original executing caller. Calls from the library implementation to vault custody therefore still originate from the hub. The libraries have no independent asset authority or mutable target selection; the compiler rejects direct state-changing calls to their deployed addresses. Read-only validation can be called directly but cannot modify a vault. Linked calls add delegatecall/encoding overhead in exchange for smaller hub bytecode.

The hub preserves propagated custom errors in its ABI through `IIvyVaultsHubErrors`; entrypoint signatures and event topics are unchanged by extraction. Tests run the same lifecycle, funding, callback and conservation paths through the linked implementation, and separately reject link tampering, missing library code, changed library runtime and direct state-changing calls.

## Custody and reserves

Every vault owns the authoritative `reserved[token]` map. For each token:

```
reserved[token] = unpaid premium budget for that token + buyerReserved[token]
available[token] = balanceOf(vault) - reserved[token]
```

Ordinary hub `push` transfers only available assets. One-time `collectPremium` pulls the required premium, verifies receipt and establishes both the fixed premium token and `premiumRemaining` budget. Only the premium module can call `payPremium`; it cannot select a token or increase the budget. Premium payments reduce both premiumRemaining and aggregate reserves before transfer. The hub separately records and pays buyer obligations; a buyer payment cannot consume premium reserves, even when premium equals collateral.

Settlement LP claims consider collateral, premium token and the option's settlement-proceeds token, deduplicating equal addresses. They burn shares and pay the same fraction of each token's available balance. Arbitrary unsolicited tokens outside that set have no rescue path.

Deposits credit the balance delta actually received. Premium, physical consideration and unwind refund funding must receive at least the required amount atomically. Launch only with reviewed tokens: rebasing balances and fee-charging outgoing transfers do not preserve the accounting assumptions. Deposits' balance-delta handling is not a promise of end-to-end fee-on-transfer support.

## Activation premium and share notifications

The premium module records total premium and activation supply before premium collection can trigger a token callback. Each activation holder owns:

```
floor(totalPremium × activationBalance / activationSupply)
```

`hub.claimPremium(vaultId)` authenticates the claimant under the hub's transient reentrancy guard. The module checkpoints if needed, zeroes the credit and calls the vault's restricted payment function. There is no public module payment route bypassing the hub. Entitlements survive transfers, burns, settlement and zero current share balance. A dormant holder can claim later without prior enumeration.

Before each ERC-1155 balance update, shares notify the premium and unwind modules once per distinct affected vault/account. They pass pre-update balances to the premium module and invalidate current unwind approvals. Duplicate batch IDs are deduplicated. Self-transfers and zero quantities do not change ownership and do not invalidate votes; zero addresses get no entitlements. Hooks use module-local state, never call the hub, never move tokens and complete before receiver callbacks.

Floor-rounding dust remains reserved permanently. There is no final-holder allocation or sweep authority. Deposits, vault asset movements and hub financial operations use transient guards, including the direct-vault deposit route.

## Terms, bids and auction identity

A call is derived from `collateral == underlying`; its notional is the committed collateral. A put has one quote pair equal to its collateral; its notional is `floor(collateral × underlyingUnit / strike)`. `underlyingUnit = 10 ** underlyingDecimals`. Strike and spot are raw quote-token units per whole underlying; premium is raw premium-token units per whole underlying.

Creation requires a future exact expiry. Opening or activating at or after expiry fails. Expiry cannot be tightened. Open-phase tightening can narrow exercise/settlement policies, raise minimum collateral or premium, improve absolute strike limits, reduce the in-the-money allowance and reduce maximum spot age. Quote pairs can only be disabled and premium tokens remain fixed.

A bid binds vaultId, buyer, quote token, strike, premium, style, settlement type, exact expiry, submission deadline, buyer nonce, auctionId, committed collateral, pairHash, executor and recipient. `pairHash = keccak256(abi.encode(PairTerms))` with tuple order `(address premiumToken, uint256 strikeLimit, uint256 minPremium, bool enabled)`. The EIP-712 domain is `IvyVaultsHub`, version `2`, chainId, deployed hub address. Signatures support EOA and ERC-1271 buyers. A successful bid consumes a buyer-wide nonce; buyers can also cancel their own nonces. Reopening an auction cannot revive its old bids.

Absolute strike limits and the fresh-spot band both apply. Calls require `strike ≥ floor(spot × (10000 - maxInTheMoneyBps) / 10000)`; puts require `strike ≤ floor(spot × (10000 + maxInTheMoneyBps) / 10000)`. The setting permits in-the-money strikes; it is not an out-of-the-money quote. Launch tooling separately translates an offered out-of-the-money percentage into an absolute strike limit. APR, USD valuation, minimum trade size and asset eligibility remain operator responsibilities.

## Timing, pause and delegated exercise

Each vault snapshots the hub's exercise-window and auction-timeout defaults and fixes its own feed address at creation. Defaults start at one hour and three days. Later changes affect future vaults only. Let `physicalDeadline = expiry + exerciseWindow`.

| Product | Manual exercise while Live | Normal settlement |
| --- | --- | --- |
| American physical | Activation ≤ time < physicalDeadline | time ≥ physicalDeadline |
| European physical | expiry ≤ time < physicalDeadline | time ≥ physicalDeadline |
| American cash | Activation ≤ time < expiry | time ≥ expiry, finalized expiry price |
| European cash | Unavailable | time ≥ expiry, finalized expiry price |

Full exercise finalizes immediately. Physical call exercise receives rounded-up quote consideration and delivers underlying; physical put exercise receives underlying and pays rounded-down strike value. The executing caller supplies physical consideration. Only the buyer can replace/revoke the executor or change the nonzero recipient; executors cannot redirect assets. Cash American exercise uses current fresh spot, rejects zero intrinsic value and consumes only the requested remaining notional.

Global and individual vault admission pauses block creation where applicable, deposits, auction opening and activation. They leave withdrawals, cancellation, transfers, exercise, report publication, settlement, claims and unwinds available and never extend deadlines. A bid master can always cancel an auction. An owner can cancel after its snapshotted timeout, immediately during an admission pause, or at/after expiry.

## Signed prices and final settlement

`IvyPriceFeed` fixes its signer in the constructor and supports EOA or ERC-1271 signatures. Anyone may relay a valid report. Both report types use domain `IvyPriceFeed`, version `1`, chainId and feed address:

- SpotReport: underlying, quote, positive price, observedAt, validUntil. Observations must advance strictly and cannot be future-dated. The hub additionally applies each vault's maxPriceAge on activation and American cash exercise.
- ExpiryReport: underlying, quote, expiry, positive price, validUntil. Publication is allowed at/after expiry and no later than validUntil. A finalized pair/expiry price cannot be replaced. Historical settlement reads have no freshness rejection.

Ivy's operators compute the 30-minute average ending at expiry and sign an externally prepared report. The contract verifies the signature and bindings; it does not collect observations or enforce averaging.

For remaining notional `r`, cash call payout is `floor(r × max(S-K,0) / S)` in underlying units; put payout is `floor(r × max(K-S,0) / underlyingUnit)` in quote units. The settlement price S is the finalized exact-expiry report. Settlement reserves the buyer payout, marks the vault Settled and leaves transfer to `claimPayout`. Late publication or late settlement cannot substitute current spot. Physical settlement needs no expiry report.

If Ivy's signer becomes unavailable before publication, cash-settled vaults remain locked until a valid report arrives or the buyer and all current shareholders approve an unwind. There is no stale-price fallback, zero-payout fallback or dead-feed exit deadline. An incorrect signed finalized price cannot be overwritten.

## Unanimous Live-phase unwind

The owner or buyer may propose or replace the one active agreement: vaultId, monotonically increasing nonce, deadline, exercisedNotional, outstanding supply and premium-token refund. EIP-712 domain `IvyUnwind`, version `1`, chainId and the immutable module address binds it to this deployment. Replacement resets the aggregate approval count without enumerating prior holders and does not freeze normal operations.

Shareholders approve the current nonce with their current balances and can revoke. Any real transfer invalidates both affected accounts' approvals; holders must approve again even if they later regain the same balance. Execution requires all outstanding shares, a valid buyer signature and matching Live phase, nonce, deadline, exercised amount and supply.

The executing caller funds the entire agreed refund. After that transfer, the module rechecks consent, so token callbacks cannot invalidate votes after validation. Any failure rolls the whole transaction back. The vault reserves the refund in its premium token for a pull-based buyer claim, then the hub finalizes Settled. Completed exercises, existing proceeds and unpaid premium entitlements survive; current holders claim the remaining pool normally. Normal exercise invalidates an old exercised-notional snapshot, and normal finalization makes an agreement unusable. Pre-activation exits use cancellation and withdrawal.

## Verification and scope

The suite covers immutable bindings and interrupted deployment recovery, exact timing and signature commitments, premium checkpoints and dust, overlapping reserves, delegated funding, agreement races, callback reentrancy and deterministic stateful conservation across call/put and cash/physical lifecycles. The operator rehearsal uses the production deployment planner and transaction builder on a local EVM with the real signed-price feed.

No live deployment is part of implementation. Market data collection, volatility pricing, automated bidding, a trading UI, CoW/NEAR adapters and arbitrary external calls are outside this repository's implementation scope.
