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

1. Choose a dedicated deployer, administrator and immutable report signer. A contract report signer must implement ERC-1271. Compile the exact build you intend to deploy. Use the same build when resuming.
2. Fill `deployment.json` with RPC, deployer, admin and reportSigner. Defaults are exerciseWindow 3600 seconds and auctionTimeout 259200 seconds. Generate the plan using `node` directly so redirected JSON has no npm command banner:

   ```sh
   node scripts/operator.mjs prepare-deployment deployment.json > deployment-plan.json
   ```

3. Inspect `addresses`, `steps`, chainId, genesisHash and starting nonce. The fixed order is IvyVaultRules, IvyOptionSettlement, IvyVault, IvyVaultsHub, IvyShares, IvyPremiums, IvyUnwind, IvyPriceFeed. The two libraries must be deployed first; the plan links their predicted addresses into hub bytecode and records every runtime link offset. Do not use the deployer for unrelated transactions during the sequence.
4. Fill `deployment-run.json` with RPC, `planFile` and `journalFile`. Explicit execution, when approved for the target network, is:

   ```sh
   node scripts/operator.mjs deploy deployment-run.json --send
   ```

5. Keep the plan and journal. On interruption, rerun the same command with the same files and build. The journal is persisted before submission, after the hash is obtained and after verified inclusion. Existing steps require matching creation data, sender, nonce, receipt, runtime evidence and peer bindings, including all embedded hub library links. Missing submission hashes are recoverable from chain history starting at the journal's start block. Nonce drift, wrong-chain evidence or unknown/replaced pending transactions stop recovery; investigate that transaction instead of deleting the journal or guessing a new sequence.

Plans for the earlier six-step build cannot be reused with this linked build. Generate a fresh plan for an unexecuted deployment. An interrupted deployment must be recovered using its original build and plan; do not swap builds halfway through the sequence.

The final journal has `complete: true` only after all constructor bindings verify. The administrator receives DEFAULT_ADMIN_ROLE and GUARDIAN_ROLE initially. Grant `BID_MASTER_ROLE` to the auction operator and `MARKET_MAKER_ROLE` to each accepted buyer before trading, using `grant-role` requests with `role` and `account`. Role strings are hashed by the CLI; manage DEFAULT_ADMIN_ROLE through its exact zero bytes32 using the contract ABI, not the string-hashing command. There are no wiring, library replacement or upgrade transactions after deployment. Library calls preserve hub storage and authority; operators continue calling the same hub entrypoints.

## Prepare, fund and activate

1. Verify supported token addresses, decimals and transfer behaviour, owner balance, commitment size, exact expiry, acceptable option policies and configured feed. Set `terms.allowPartialExercise` explicitly to a boolean before creating the vault: true permits partial exercise; false requires all remaining notional. This term is immutable, including through tightening. Launch vaults default to private deposits; set `terms.publicDeposits: true` explicitly for pooling. The token list in the request is an operational allowlist, not a global on-chain whitelist.
2. Set an explicit positive `minTradeUsdE6` appropriate to the offered product. The examples use a configurable illustration, not a protocol minimum. Supply a reviewed collateral USD price and a market quote for every accepted quote token. `prepare-vault` checks the wallet balance and minimum, sets minCollateral to the owner's prepared amount, and translates outOfTheMoneyBps to an absolute strike: rounded up for calls, down for puts. For a pooled offering, this is the opening floor; total committed supply may be larger. Review APR separately using the agreed premium, commitment value and exact duration; the CLI does not price APR or volatility.
3. Prepare `prepare-vault`, submit the resulting createVault call and read the vault ID/address from its receipt or hub getters. For each depositor run `approve-token` with the collateral token and amount, then `deposit` with that raw amount. Approval must target the clone, never the hub. Direct `vault.deposit(amount)` is also supported, with the same admission rules.
4. The owner runs `open-auction`. At a nonzero auctionStartsAt, anyone may open it after the scheduled time. Read the auctionId and totalShares after opening. Both become signed commitments. No deposits or withdrawals are available in Auction; transfers remain possible when enabled by the admin.
5. If the vault uses a feed, publish a fresh signed spot report before activation. Prepare `typed-bid` with vaultId and the buyer's proposed bid fields. The tool reads exact expiry, current auctionId, collateral amount and accepted pairHash; executor defaults to zero and recipient to the buyer. The buyer reviews all output and signs domain `IvyVaultsHub`, version `2`, chainId and the deployed hub.
6. The buyer approves the clone for the full premium: `floor(premium × totalNotional / underlyingUnit)`. For puts, notional is `floor(collateral × underlyingUnit / strike)`. `inspect-bid` requires the actual signature, explicit USD minimum and collateral valuation, and simulates activation from the bid master. This verifies current role, signature, policy, oracle and premium-funding conditions. Future physical exercise funding is a separate obligation of the executing caller.
7. Submit `activate` using that same signed bid. LP activation entitlements become immediately available through `claim-premium`. When transfers are enabled, recipients acquire the proportional unclaimed premium; already-claimed premium stays paid. Keep the signed bid and activation receipt with the launch record.

A buyer can invalidate its unused nonce with `cancelBid(nonce)` through the ABI. Cancelled or reopened auctions require a new typed bid for the new auctionId, even if size and terms are unchanged.

## Reports, exercise and expiration

Use externally prepared report files. A spot report contains `underlying`, `quote`, `price`, `observedAt`, `validUntil`; an expiry report contains `underlying`, `quote`, `expiry`, `price`, `validUntil`. `typed-report` takes `kind: "spot"` or `"expiry"` and returns domain `IvyPriceFeed`, version `1`, chainId and feed address. Have Ivy's configured signer sign it, then place the signature alongside the report and relay with `publish-spot` or `publish-expiry`. Any account can relay.

Ivy operators calculate the 30-minute average ending at the exact expiry. The feed verifies the result's signature and bindings; it does not compute or check that average. Publish expiry reports at/after expiry and no later than their submission deadline. A valid price is positive and write-once for the pair/expiry. If publication is late, sign a new valid submission deadline with the same agreed historical price. Delayed settlement reads the finalized price indefinitely; it does not use a fresh spot replacement.

For physical options, the deadline is `expiry + stateOf(vaultId).exerciseWindow`. American holders may exercise from activation; European holders start at expiry. Both must execute strictly before the deadline. The buyer or its current executor submits `exercise` with underlying amount. The caller must fund and approve the clone: quote tokens for calls, underlying for puts. All output goes to the configured recipient. Only the buyer can use `set-execution` to replace/revoke executor or update recipient; use the zero address to revoke the executor.

American cash exercise uses fresh spot before expiry. At/after expiry, both American and European cash exercise use the finalized report for the exact expiry; a zero payout reverts. Cash `expire` processes expiration, including automatic cash exercise where applicable, reserving the remaining buyer payout for `claim-payout`. Anyone can expire physical options at/after their deadline and cash options at/after expiry. Full exercise finalizes immediately. Expiration requires an on-chain transaction; reaching the deadline alone does not execute it. Cash expiration requires the finalized expiry report.

After settlement, holders use `claim` with a share amount. This burns shares for proportional unreserved balances. Unpaid premium, permanent premium dust and buyer payouts/refunds stay reserved. `claim-premium` remains available to holders with unpaid credit after burning every share. The buyer or executor calls `claim-payout`; payment goes to the buyer's current recipient. Read `vault.reserved(token)`, `vault.buyerReserved(token)` and premium-module `claimable(vaultId, holder)` to distinguish obligations; hub `pendingPayout` only tracks collateral cash settlement, not unwind refunds.

If Ivy's signer cannot publish, cash vaults remain Live and locked until a valid report or unanimous unwind. A stale or missing feed never settles an obligation to zero. There is no signer replacement or finalized-price correction function.

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

The existing emergency control is admission-only. Whether to add a full execution freeze remains a protocol-lead decision. Such a freeze needs a separate specification for permissions, affected actions, deadlines, resumption and outstanding payment obligations; it is not implemented by admission pause.

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
| prepare-deployment | deployer, admin, reportSigner; optional exerciseWindow, auctionTimeout, uri |
| deploy | planFile, journalFile; sender/hub unnecessary; requires --send |
| prepare-vault | terms, pairs, supportedTokens, collateralAmount, collateralPriceUsdE6, minTradeUsdE6, marketQuotes |
| typed-bid | bid: marketMaker, quoteToken, strike, premium, style, settlement, validUntil, nonce; optional executor, recipient |
| inspect-bid / activate | complete bid, signature, collateralPriceUsdE6, minTradeUsdE6 |
| typed-report | feed, kind, report |
| publish-spot / publish-expiry | feed, report, signature; hub unnecessary |
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
