# Manual Ivy Vault operations

Use this runbook to prepare an immutable deployment and operate individual vaults. The CLI accepts JSON request files and prints either EIP-712 typed data or a simulated transaction's calldata. It never signs reports or bids. Wallets or multisigs sign the printed typed data separately.

Run `npm ci`, `npm run compile`, `npm run typecheck`, `npm run check:size` and `npm test -- --no-compile` first. Use a Node.js 22.13.0+ runtime and an RPC on a chain compatible with the compiler's Osaka target and transient storage. `npm test -- --no-compile test/17-local-rehearsal.test.ts` runs the complete rehearsal on an ephemeral local EVM; it does not use your configured live RPC or wallets.

Jump to [token roles](#token-roles-and-collateral), [unwind](#prepare-and-execute-a-unanimous-unwind), [premium treatment](#premium-treatment-and-emergency-boundaries), or [platform fees](#platform-fee-and-share-transfer-administration).

## Token roles and collateral

There are three token roles: **asset/underlying** is the option asset, **quote** measures the strike, and **premium** pays for the option. Collateral names the deposited backing token, not a fourth independent token.

| Product (strike 3,000 USDC per WETH) | LP deposit / collateral | Full physical exercise of 10 WETH |
| --- | --- | --- |
| Covered call | 10 WETH (underlying) | Caller pays 30,000 USDC; recipient receives 10 WETH. |
| Cash-secured put | 30,000 USDC (quote) | Caller delivers 10 WETH; recipient receives 30,000 USDC. |

Cash settlement pays intrinsic value in collateral: WETH for this call and USDC for this put. “Cash” does not require a quote-token payout. Calls may list multiple quote/premium pairs before activation; the winning bid chooses one. Puts accept one pair and require quote to equal collateral. Premium may share an address with either token or use another token; overlapping addresses still have separate premium, platform-fee and buyer-reserve budgets. Settlement proceeds belong to the residual pool after reserves, separately from earned premium.

## Requests and submission

Copy the [example files](../examples/operator/README.md), replace placeholder addresses and timestamps, and use strings for raw integer amounts. A request normally contains `rpc`, `sender`, `hub`, `vaultId` and the command's arguments. IDs and amounts must not be lossy JavaScript numbers. USDC amounts use six decimals: 100 USDC is `"100000000"`. Strike/spot use quote units per whole underlying; premium uses premium-token units per whole underlying.

```sh
npm run operator -- prepare-vault vault.json
npm run operator -- inspect-bid activation.json
npm run operator -- expire expiration.json
```

These commands only simulate and print calldata. Review the chain, sender, destination, arguments and simulation result. State can change between preflight and inclusion; contracts recheck their own conditions at execution. Operational USD checks use your supplied valuation and cannot prove that it is current or correct.

Append `--send` only when deliberately submitting. Submission uses `eth_sendTransaction` through an RPC-managed signer returned by `eth_accounts`; the RPC must expose the requested sender. The CLI does not load private keys or wallet secrets. For a hardware wallet or Safe, submit the printed transaction through that wallet's normal workflow. `inspect-bid` and `typed-*` commands cannot send transactions.

## Deploy and recover

1. Choose a dedicated deployer, Hub administrator, immutable indicative report signer and settlement publisher. The Hub administrator should be a multisig in production; a publisher may be an EOA, a multisig or an optional helper contract. A contract indicative signer must implement ERC-1271. Compile the exact build you intend to deploy. Use the same build when resuming.
2. Fill `deployment.json` with RPC, deployer, admin, reportSigner, settlementPublisher and settlementMethodology (the approved methodology artifact reference). Defaults are exerciseWindow 3600 seconds and auctionTimeout 259200 seconds. Generate the plan using `node` directly so redirected JSON has no npm command banner:

   ```sh
   node scripts/operator.mjs prepare-deployment deployment.json > deployment-plan.json
   ```

3. Inspect `addresses`, `steps`, chainId, genesisHash and starting nonce. The fixed order is IvyVaultRules, IvyOptionSettlement, IvyVault, IvyVaultsHub, IvyShares, IvyPremiums, IvyUnwind, IvyPriceFeed. The two libraries must be deployed first; the plan links their predicted addresses into hub bytecode and records every runtime link offset. Do not use the deployer for unrelated transactions during the sequence.
4. Fill `deployment-run.json` with RPC, `planFile` and `journalFile`. Explicit execution, when approved for the target network, is:

   ```sh
   node scripts/operator.mjs deploy deployment-run.json --send
   ```

5. Keep the plan and journal. On interruption, rerun the same command with the same files and build. The journal is persisted before submission, after the hash is obtained and after verified inclusion. Existing steps require matching creation data, sender, nonce, receipt, runtime evidence and peer bindings, including all embedded hub library links. Missing submission hashes are recoverable from chain history starting at the journal's start block. Nonce drift, wrong-chain evidence or unknown/replaced pending transactions stop recovery; investigate that transaction instead of deleting the journal or guessing a new sequence.

Plans from earlier builds cannot be reused with this eight-step manifest-v4 build, which changes the Hub constructor and vault-creation ABI. Generate a fresh plan for an unexecuted deployment. An interrupted deployment must be recovered using its original build and plan; do not swap builds halfway through the sequence.

The final journal has `complete: true` only after constructor bindings, library links and initial Hub admin/publisher roles verify. The Hub stores authoritative reports and grants the configured initial settlement publisher its role in the constructor; no settlement source contract is required. Plan/journal verification checks the initial deployment role bindings; after deliberate publisher rotation, use the role-management commands and inspect current memberships rather than rerunning deployment as incident recovery. The administrator receives DEFAULT_ADMIN_ROLE and GUARDIAN_ROLE initially. Grant `BID_MASTER_ROLE` to the auction operator and `MARKET_MAKER_ROLE` to each accepted buyer before trading, using `grant-role` requests with `role` and `account`. Role strings are hashed by the CLI; manage DEFAULT_ADMIN_ROLE through its exact zero bytes32 using the contract ABI, not the string-hashing command. There are no wiring, library replacement or upgrade transactions after deployment. Library calls preserve hub storage and authority; operators continue calling the same hub entrypoints.

## Prepare, fund and activate

1. Verify supported token addresses, decimals and transfer behaviour, owner balance, commitment size, exact expiry, acceptable option policies and the Hub’s settlement publisher membership. Cash-capable vaults require positive `terms.maxSettlementPriceAge`, fixed at creation even through tightening. `terms.priceFeed` and `terms.maxPriceAge` independently configure optional indicative activation checks; cash can omit that indicative feed. Supply `settlementMethodology` for cash preparation. Physical-only preparation explicitly supplies `maxSettlementPriceAge: 0` when no cash pricing is needed. Do not supply the removed `settlementPriceFeed` field. Set `terms.allowPartialExercise` explicitly to a boolean before creating the vault: true permits partial exercise; false requires all remaining notional. This term is immutable, including through tightening. Launch vaults default to private deposits; set `terms.publicDeposits: true` explicitly for pooling. The token list in the request is an operational allowlist, not a global on-chain whitelist.
2. Set an explicit positive `minTradeUsdE6` appropriate to the offered product. The examples use a configurable illustration, not a protocol minimum. Supply a reviewed collateral USD price and a market quote for every accepted quote token. `prepare-vault` checks the wallet balance and minimum, sets minCollateral to the owner's prepared amount, and translates outOfTheMoneyBps to an absolute strike: rounded up for calls, down for puts. For a pooled offering, this is the opening floor; total committed supply may be larger. Review APR separately using the agreed premium, commitment value and exact duration; the CLI does not price APR or volatility.
3. Prepare `prepare-vault`, submit the resulting createVault call and read the vault ID/address from its receipt or hub getters. For each depositor run `approve-token` with the collateral token and amount, then `deposit` with that raw amount. Approval must target the clone, never the hub. Direct `vault.deposit(amount)` is also supported, with the same admission rules.
4. The owner runs `open-auction`. At a nonzero auctionStartsAt, anyone may open it after the scheduled time. Read the auctionId and totalShares after opening. Both become signed commitments. No deposits or withdrawals are available in Auction; transfers remain possible when enabled by the admin.
5. If the vault uses an indicative feed, publish a fresh signed spot report before activation. Prepare `typed-bid` with vaultId and the buyer's proposed bid fields. The tool reads exact expiry, current auctionId, collateral amount and accepted pairHash; executor defaults to zero and recipient to the buyer. The buyer reviews all output and signs domain `IvyVaultsHub`, version `2`, chainId and the deployed hub.
6. The buyer approves the clone for the full premium: `floor(premium × totalNotional / underlyingUnit)`. For puts, notional is `floor(collateral × underlyingUnit / strike)`. `inspect-bid` requires the actual signature, explicit USD minimum and collateral valuation, and simulates activation from the bid master. This verifies current role, signature, policy, oracle and premium-funding conditions. Future physical exercise funding is a separate obligation of the executing caller.
7. Submit `activate` using that same signed bid. LP activation entitlements become immediately available through `claim-premium`. When transfers are enabled, recipients acquire the proportional unclaimed premium; already-claimed premium stays paid. Keep the signed bid and activation receipt with the launch record.

A buyer can invalidate its unused nonce with `cancelBid(nonce)` through the ABI. Cancelled or reopened auctions require a new typed bid for the new auctionId, even if size and terms are unchanged.

## Reports, exercise and expiration

Use externally prepared report files and verify the target Hub (or indicative feed for signed spot reports) before submission. Prices are raw quote-token units per whole underlying: WETH/USDC at 2,500 USDC per WETH is `2500000000`.

**Indicative activation reports:** `typed-report` with `kind: "spot"` produces domain `IvyPriceFeed`, version `1`, chainId and indicative feed address. Its immutable signer signs; anyone may relay with `publish-spot`. The legacy `kind: "expiry"` / `publish-expiry` signing path remains for the old feed API. It does not supply authoritative prices to new cash vaults.

**Authoritative exercise observations:** the settlement publisher uses `publish-settlement-exercise`, with `hub`, `settlementMethodology` and `report: { underlying, quote, price, observedAt, validUntil }`. This directly calls the Hub; there is no separate EIP-712 signature. Before expiry, American cash exercise checks both the vault’s immutable maximum age and the observation’s validity deadline. Observation timestamps must be positive, nonfuture and strictly increasing for that pair. Age and validity bounds are inclusive; a long validity deadline never bypasses the age limit.

**Authoritative expiry reports:** the publisher uses `publish-settlement-expiry`, with `hub`, `settlementMethodology` and `report: { underlying, quote, expiry, price, validUntil }`. Publish at/after the exact expiry and no later than `validUntil`. Positive prices are write-once for the ordered pair/expiry, with no administrator correction. Delayed settlement reads the finalized price indefinitely; it never uses current spot or another expiry. For late publication, submit the agreed historical price with a new valid submission deadline.

Before production cash admissions, approve a methodology artifact for each pair naming the responsible operator, source venues, sampling frequency, weighting, rounding, missing-data/outage rules, evidence retention and freshness configuration. The expiry methodology uses a 30-minute average ending at exact expiry; exercise observations need an approved current-price calculation and validity policy. Reference the artifact using `settlementMethodology` in deployment and cash-vault preparation. This records operational context; the contracts and CLI do not verify source accuracy or calculate that average. Synthetic examples are for local rehearsal only.

### EOA and optional contract publishers

For the direct EOA path, set `settlementPublisher` to the EOA in deployment configuration, or grant it the Hub’s publisher role later. That EOA submits `publish-settlement-exercise` and `publish-settlement-expiry` to the Hub. No settlement feed address, interface implementation or helper deployment is needed. Matching vaults on the Hub read the same report keyed by ordered pair and expiry.

For an optional contract publisher, grant the same Hub role to an access-controlled helper. The helper obtains or calculates the report under its own approved policy and calls the Hub’s publication functions. The Hub checks the helper’s address as caller; it never calls the helper to read a price. Helpers must authenticate upstream callers before forwarding values. Granting an unrestricted forwarding contract the role would let anyone publish through it. The optional [ExampleSettlementPublisher](../contracts/examples/ExampleSettlementPublisher.sol) uses owner access control to authenticate publication and the [write-side interface](../contracts/interfaces/IIvySettlementPricePublication.sol) to submit it. These examples and tests show this trust boundary; no production data source is implied.

### Publisher rotation and incidents

On the Hub, `DEFAULT_ADMIN_ROLE` controls `SETTLEMENT_PRICE_PUBLISHER_ROLE`. Use `grant-settlement-publisher` and `revoke-settlement-publisher` with `hub` and `account`; the role is checked when publication executes. Any authorized publisher may publish; multiple role holders do not create an on-chain quorum. A publisher multisig applies its own threshold.

If a publisher becomes unavailable, the Hub admin grants a replacement and revokes the old publisher. Verify the target Hub and resulting memberships. Already published exercise observations remain usable until age/validity limits expire or a newer observation replaces them. Finalized expiry prices survive permanently. Revocation stops future publications; it cannot undo completed payments. Missing reports preserve the buyer’s obligation and keep collateral locked until a valid report or agreed unwind. Admission pause leaves publication and existing position management available.

Verify calculations before final publication. An incorrect exercise observation can be superseded by a later verified observation; an incorrect finalized expiry price cannot be corrected. Record the incident and pause new affected admissions as appropriate. Never promise a reversal of completed payouts or substitute a current price for an unavailable historical report. Losing all Hub admin keys prevents publisher-governance recovery. These trust boundaries are detailed in the [pricing specification](settlement-pricing-spec.md).

For physical options, the deadline is `expiry + stateOf(vaultId).exerciseWindow`. American holders may exercise from activation; European holders start at expiry. Both must execute strictly before the deadline. The buyer or its current executor submits `exercise` with underlying amount. The caller must fund and approve the clone: quote tokens for calls, underlying for puts. All output goes to the configured recipient. Only the buyer can use `set-execution` to replace/revoke executor or update recipient; use the zero address to revoke the executor.

American cash exercise uses the authoritative exercise observation before expiry, never the indicative spot feed. At/after expiry, both American and European cash exercise use the finalized report for the exact expiry; a zero payout reverts. Cash `expire` processes expiration, including automatic cash exercise where applicable, reserving the remaining buyer payout for `claim-payout`. Anyone can expire physical options at/after their deadline and cash options at/after expiry. Full exercise finalizes immediately. Expiration requires an on-chain transaction; reaching the deadline alone does not execute it. Cash expiration requires the finalized expiry report.

After settlement, holders use `claim` with a share amount. This burns shares for proportional unreserved balances. Unpaid premium, permanent premium dust and buyer payouts/refunds stay reserved. `claim-premium` remains available to holders with unpaid credit after burning every share. The buyer or executor calls `claim-payout`; payment goes to the buyer's current recipient. Read `vault.reserved(token)`, `vault.buyerReserved(token)` and premium-module `claimable(vaultId, holder)` to distinguish obligations; hub `pendingPayout` only tracks collateral cash settlement, not unwind refunds.

If settlement reports are unavailable, cash vaults remain Live and locked until a valid report or unanimous unwind. A stale or missing feed never settles an obligation to zero. Publisher rotation is available to the Hub admin; finalized-price correction is not.

## Admission pause and stalled auctions

A guardian uses `pause` with `vaultId: "0"` for global admission or a specific ID for that vault. Creation, deposits, opening and activation are blocked as applicable. Existing withdrawals, transfers, exercise, reports, settlement, claims and agreed unwinds continue; deadlines do not change.

The owner may run `cancel-auction` immediately while admission is paused or once exact expiry has passed. Otherwise the owner waits for the snapshotted auction timeout; a bid master may cancel at any time. Cancellation returns to Open and clears the schedule. Holders can then withdraw. A paused vault must be unpaused to admit another deposit or auction, and an expired vault cannot reopen.

## Premium treatment and emergency boundaries

| Event | Premium and fees | Refund / continuation |
| --- | --- | --- |
| Auction cancelled before activation | Nothing collected. | No premium refund; vault returns to Open. |
| Unwind consent revoked or proposal expired/replaced | Earned LP premium and platform fees remain unchanged. | No refund funded; the Live position continues under its normal deadlines. |
| Unwind executed | Earned LP premium and platform fees are retained. | Executing sponsor separately funds the negotiated premium-token refund; buyer or executor claims it for the configured recipient. |
| Admission paused | Earned premium, fee and claim entitlements are unchanged. | Exercise, expiration, claims and agreed unwind continue; deadlines do not move. |
| Normal exercise or expiration | Earned premium and fees remain retained and claimable. | Settlement obligations are handled separately. |

The recommended policy is the implemented policy: premium and fees are earned at activation, and unwind refunds are negotiated and funded separately. LPs can already have claimed their premium, so an automatic refund cannot assume that money remains in custody. A changed refund policy needs an explicit escrow/funding design and fee treatment before implementation.

This implementation retains admission-only emergency control. Adding a full execution freeze would be a separate product change. Such a freeze needs a separate specification for permissions, affected actions, deadlines, resumption and outstanding payment obligations; it is not implemented by admission pause.

## Prepare and execute a unanimous unwind

Only Live vaults use this path. The owner or buyer calls `propose-unwind` with a future `deadline` and refund amount in raw **premium-token** units. Zero refund is allowed. Read the active agreement using `typed-unwind`; the output includes vaultId, nonce, deadline, exercisedNotional, supply and refund, with the chain and module-bound EIP-712 domain.

Every current shareholder reviews and explicitly submits `approve-unwind` with that nonce. Holders may use `revoke-unwind`. Nonzero transfers to another holder invalidate sender and recipient votes; they must approve again at their new balances. Replacing the proposal increments its nonce and supersedes all previous votes. Neither voting nor replacement blocks ordinary exercise or settlement.

The buyer signs the exact active typed agreement. The executing sponsor approves the clone for the refund premium token and submits `execute-unwind` with vaultId, nonce and signature. Execution pulls the full refund, rechecks the current exercise/supply state and unanimous consent after token callbacks, reserves the refund and finalizes. Failures revert funding atomically. Any intervening exercise requires a fresh proposal/signature/approvals because its snapshot changed; normal finalization makes the proposal unusable.

The buyer or its executor uses `claim-payout` for the funded refund, paid to the current configured recipient. Current holders use ordinary `claim` for remaining collateral and completed-exercise proceeds. Unpaid premium entitlements remain separately claimable; an unwind does not claw them back.

### Worked unwind scenarios

- **Zero refund:** while Live, propose `refund: "0"` with a future deadline. Read `typed-unwind`, collect every holder’s `approve-unwind` for its nonce and the buyer’s signature, then execute. No token approval or refund funding is needed. Holders separately run `claim` and, if owed, `claim-premium`; there is no unwind refund to claim.
- **Funded refund:** with USDC as premium token (six decimals), propose `refund: "100000000"` for 100 USDC. After consent and signature, the executing sponsor runs `approve-token` for USDC and that amount (spender: clone), then `execute-unwind`. The buyer or executor runs `claim-payout`; holders independently claim the residual pool and unpaid premium. Completed exercises are never reversed.
- **Expired/replaced proposal:** nonce 1 cannot execute after its deadline. While still Live, the owner or buyer proposes again with a future deadline, obtaining nonce 2. Replacing a still-valid proposal has the same nonce effect. Read fresh typed data, obtain a new buyer signature and all current-holder approvals; nonce 1 approvals/signature cannot execute nonce 2. Revoking consent removes that holder’s vote, not the option or anyone’s premium. Execution is permitted at the deadline itself, but not after it.

Use the [operator templates](../examples/operator/README.md) with the command fields below. An unwind is an agreed close of a funded Live option; `cancel-auction` only returns a pre-activation auction to Open.

## Command reference

All requests include `rpc` and `sender`; hub calls include `hub` and usually `vaultId`. Transaction commands simulate first; add `--send` only for explicit submission.

| Command | Additional request fields |
| --- | --- |
| prepare-deployment | deployer, admin, reportSigner, settlementPublisher, settlementMethodology; optional exerciseWindow, auctionTimeout, uri |
| deploy | planFile, journalFile; sender/hub unnecessary; requires --send |
| prepare-vault | terms, pairs, supportedTokens, collateralAmount, collateralPriceUsdE6, minTradeUsdE6, marketQuotes; cash also settlementMethodology |
| typed-bid | bid: marketMaker, quoteToken, strike, premium, style, settlement, validUntil, nonce; optional executor, recipient |
| inspect-bid / activate | complete bid, signature, collateralPriceUsdE6, minTradeUsdE6 |
| typed-report | feed, kind, report; indicative/legacy feed only |
| publish-spot / publish-expiry | feed, report, signature; indicative/legacy feed only |
| publish-settlement-exercise / publish-settlement-expiry | hub, settlementMethodology, report; authorized publisher sender, no report signature |
| grant-settlement-publisher / revoke-settlement-publisher | hub, account; Hub admin sender |
| approve-token | token, amount; clone spender is read from hub |
| deposit / withdraw / exercise / claim | amount (collateral, shares, underlying, shares respectively) |
| open-auction / cancel-auction / expire / claim-premium / claim-payout | no additional fields |
| set-execution | executor, recipient |
| propose-unwind | deadline, refund |
| typed-unwind / revoke-unwind | no additional fields |
| approve-unwind | nonce |
| execute-unwind | nonce, signature |
| pause | paused boolean |
| grant-role | role string, account; vaultId unnecessary |

Enums: exercise style 0 European / 1 American; exercise policy also 2 Either. Settlement type 0 Physical / 1 Cash; settlement policy also 2 Either. The contract ABI remains available for owner tightening, auction scheduling, ownership transfer, role revocation, metadata and future-default changes. These do not have dedicated CLI commands.


## Platform fee and share-transfer administration

Fresh deployments start with transfers disabled, zero platform fee and the admin
as treasury. DEFAULT_ADMIN_ROLE manages setTransfersEnabled(bool) and
setPlatformTreasury(address); PLATFORM_FEE_MANAGER_ROLE manages
setPlatformFeeBps(uint16), bounded by 10,000 bps. The admin initially holds that
role and controls its membership. Set launch fees before creating vaults.

Each vault snapshots the current rate in maxPlatformFeeBps(vaultId) at creation.
Activation uses the latest global rate only if it does not exceed this immutable
cap. A higher rate requires a new vault; reducing the global rate lets an existing
auction proceed. minPremium and Activated.totalPremium remain gross values.
Inspect platformFees(vaultId) for the applied rate, amount and recipient.

Fees are deducted in the premium token: floor(gross * rate / 10,000). For example, 1,000 USDC gross premium at 200 bps allocates 20 USDC to the treasury and 980 USDC to LPs. Calculate with raw token integers: rounding is down to the smallest premium-token unit, so any fractional fee unit remains in the net LP allocation. LP claims
remain immediate for the net allocation. The vault reserves both allocations;
platformFeeRemaining is independent of premiumRemaining and buyerReserved.
Anyone can call the vault's claimPlatformFee() to pay the snapshotted recipient,
once only. Updating the treasury does not redirect existing fees. A vault cannot
be its own treasury. Fees remain earned after exercise, expiry or unwind; unwind
refunds are separately funded.

Enabled share transfers move floor(unclaimed * amount / pre-transfer balance);
a full transfer moves all credit. Already-claimed amounts never move. Duplicate
batch IDs are aggregated before proportional accounting. Burns preserve unpaid
credit, including partial burns. Zero and self-transfers do not move entitlement
or invalidate unwind consent, but still require transfers enabled.

Operator commands: set-platform-fee (rateBps), set-platform-treasury (recipient),
set-transfers (enabled), and claim-platform-fee (vaultId). Each takes the usual
hub and sender fields and simulates before building calldata. Inspect-bid reports
the gross premium, applied global rate, creation cap, platform fee and net premium.
