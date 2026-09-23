# Physical fallback for cash settlement at expiry

Status: implementation specification. Timing values are explicit deployment settings rather than hardcoded production defaults. The implementation reuses the existing physical exercise window and snapshots both durations for each vault.

Review baseline: `df17d1dd6d95cd6beef80d316b36a64dc5b32397` on `main`. Review the implementation against this fixed commit and this specification, preserving unrelated local files.

## Objective

Allow LPs to recover their remaining vault assets within a bounded time when the settlement publisher fails to supply the final expiry price for a cash-settled option. Offer the buyer a fixed opportunity to exercise physically before the remaining position expires.

The buyer accepts publisher availability risk. The fallback does not guarantee the cash payoff that would have been calculated at expiry, compensate for an outage, or require the buyer's further consent to release LP assets after the exercise window.

## Scope and current behavior

- Apply the same expiry fallback to American and European cash-settled calls and puts.
- American exercise before expiry continues to require a valid cash exercise observation. A missing or stale observation before expiry does not enable physical fallback.
- Only the remaining, unexercised notional enters fallback. Earlier completed exercises remain final.
- A final price accepted on time remains authoritative. Wrong or disputed published prices are outside this task.
- Options activated with physical settlement retain their existing lifecycle.
- This change targets a newly deployed contract suite. The current Hub and its linked libraries are immutable; this task cannot retrofit existing deployed vaults.

At the review baseline, `IvyOptionSettlement` requires a stored final price for cash exercise at or after expiry and for cash expiration with remaining notional. A missing price reverts with `ReportUnavailable`, leaving the vault Live indefinitely. Publication has no final deadline. Physical exercise already exchanges assets at the agreed strike without reading a price: calls exchange quote for underlying, and puts exchange underlying for quote.

## Timing and settlement rules

For each applicable vault define:

- `T`: the original option expiry.
- `P`: a positive expiry price publication window, fixed for the vault before deposits and bidding.
- `W`: a positive physical fallback exercise window, fixed for the vault before deposits and bidding.
- `D = T + P`: the final-price publication deadline and fallback start.
- `F = D + W`: the fallback exercise deadline and permissionless expiration time.

Use non-overlapping boundaries:

| Condition | Permitted behavior |
| --- | --- |
| `now < T` | Existing exercise rules. No physical fallback. |
| `T <= now < D`, final price missing | Publisher can submit the final price. Cash exercise and expiration remain blocked until publication. |
| Final price accepted during `T <= now < D` | Normal cash exercise and expiration using that price, including after `D` and `F`. No physical fallback. |
| `D <= now < F`, final price missing | Physical exercise is available for the remaining notional. Final-price publication is closed. |
| `now >= F`, final price missing | Physical exercise is closed. Anyone can expire the remaining position and make LP claims available. |

Eligibility is derived from the fixed deadlines and whether a final price was accepted. It must not depend on somebody first submitting a fallback activation transaction. A first interaction after `F` must be able to finalize directly. Delayed transactions cannot reset or extend either deadline.

Final publication at exactly `D` is rejected; physical exercise may start at `D`. Physical exercise at exactly `F` is rejected; expiration may execute at `F`. The publisher cannot restore cash settlement after the publication deadline by publishing a late price, changing its role, or supplying a backdated report. A previously stored exercise observation cannot substitute for the missing final expiry price.

## Physical exercise and finalization

1. Only the current buyer or its authorized executor may exercise, with delivery to the configured recipient, consistent with existing authorization.
2. The buyer must explicitly request physical exercise. An ordinary cash-exercise transaction must not unexpectedly start pulling the full strike payment or underlying because it is mined after the fallback boundary. The implementation may use a dedicated fallback exercise entry point or an explicit settlement expectation.
3. For a call, the exerciser delivers quote tokens equal to the strike value of the exercised amount, rounded up, and receives that amount of underlying.
4. For a put, the exerciser delivers the exercised amount of underlying and receives its strike value in quote tokens, rounded down.
5. Reuse the existing custody transfers, rounding, recipient notification, partial-exercise policy and remaining-notional checks. The exerciser must supply the required balance and allowance. Failed transfers revert the entire exercise.
6. No price or in-the-money check is required for physical exercise. Exercise is voluntary; the buyer decides whether to deliver the assets.
7. Full exercise finalizes the vault immediately. Partial exercise leaves the remainder available until `F` without extending the window.
8. At or after `F`, anyone may expire the vault without a publisher, admin, buyer signature, buyer funding or buyer callback. Any unexercised remainder lapses without a new buyer cash reserve. Expiration must not pretend that lapsed notional was physically exercised.
9. Once Settled, LPs claim their share of available assets through the existing claim mechanism, including unexercised collateral and strike-payment assets received during physical exercise. Preserve existing premium, fee, reserve and unwind accounting.
10. Publisher outages, publisher role changes, admission pauses and disabling new cash admissions must not block the fallback or its finalization. An unresponsive buyer must not prevent LP claims after `F` and a successful expiration transaction.

## Agreement and integration requirements

- Make the fallback and its timings part of the terms disclosed to depositors and buyers before participation. Fix them for each vault so subsequent settings changes cannot alter an existing position. `W` reuses the vault's existing snapshotted `exerciseWindow`; `P` uses a new `expiryPricePublicationWindow` setting snapshotted at the same point. Cash-capable vaults require both durations to be positive.
- A signed cash bid must unambiguously accept the vault's fixed fallback terms. Binding through the existing signed vault identity is sufficient if those terms cannot change; update the bid schema if the implementation introduces terms that need separate binding. `SettlementPolicy.Either` alone is not fallback consent.
- Preserve the originally agreed cash settlement type in inspection/history, and expose the effective settlement route plus `D` and `F`. A separate stored phase is not required if the route can be derived safely.
- Update time/availability views, including `expirationTimeOf`, so callers can distinguish normal cash expiration requiring a final report from expiration after an unused fallback window.
- Make exercised, expired and fallback outcomes distinguishable in events and operator output. Reads must show fallback eligibility even before any transaction records an event.
- Update operator previews and commands, request examples, deployment configuration and documentation for the new deadlines, explicit physical exercise, required assets/allowances and permissionless LP recovery.
- Replace documentation and tests that describe arbitrarily late final-price publication as the normal outage recovery path. Publisher replacement remains useful before `D`.
- Document ABI and signature compatibility implications for the new deployment. This implementation task does not include deploying, pushing or publishing the suite.

## Acceptance criteria

Verify through public contract and operator interfaces:

- American and European cash calls and puts follow identical post-expiry fallback rules.
- A missing or stale American exercise observation before `T` does not allow physical fallback, and European exercise remains unavailable before `T`.
- A valid final price accepted before `D` supports normal cash settlement even long after `F`, including zero payout for an out-of-the-money option. Such a vault never enters fallback.
- With no final price, test `T`, `D - 1`, `D`, `F - 1` and `F`, plus a first interaction long after `F`. Publication and physical exercise cannot both be eligible at `D`, regardless of transaction ordering at that timestamp.
- Late publication is rejected even if fallback has never been explicitly exercised or recorded. Exercise observations and role rotation cannot bypass the cutoff.
- Buyer inactivity throughout the outage does not block permissionless expiration at `F` and successful LP claims afterward. No intermediate fallback activation transaction is necessary.
- Calls and puts deliver the correct assets at the original strike. Cover differing token decimals, rounding, insufficient balances/allowances, unauthorized callers and atomic rollback on transfer failure.
- Cover partial exercise allowed/disallowed, full exercise before `F`, partially cash-exercised American options entering fallback for only the remainder, and prior full cash exercise leaving nothing to fall back on.
- Cash exercise transactions cannot silently execute physical transfers across the deadline. Failed exercise cannot consume notional or change reserves.
- After fallback finalization, LP claims correctly distribute retained collateral and received counter-assets; premiums, platform fees, buyer reserves and unwind recovery retain their intended accounting. Preserve reserve exclusion and token deduplication in claims.
- Admission pauses, disabling cash admissions and publisher removal do not prevent fallback exercise or expiration. Global settings changes do not alter existing vault deadlines.
- A completed consensual unwind or any other prior finalization prevents subsequent fallback exercise or double claims. Originally physical options retain their existing timing and transfers.
- Operator inspection accurately reports the current route, required exercise assets and the permissionless expiration time, including when no one has interacted since expiry.

During implementation run focused settlement and accounting tests, then the full contract suite, TypeScript checks, Solidity formatting checks, contract bytecode-size checks and documentation checks/tests. Task drafting alone does not require contract execution.

## Deployment timing configuration

- Supply the numerical expiry price publication window `P` explicitly in deployment configuration.
- Supply the numerical physical exercise window `W` through the existing `exerciseWindow` configuration.
- Test fixtures and sample requests may use clearly identified illustrative values; these do not select production policy.

Production deployment must choose both values. They bound publisher recovery time and buyer exercise time; with no accepted final report, LP expiration becomes available at `T + P + W` regardless of buyer or publisher cooperation. No production deployment is part of this task.
