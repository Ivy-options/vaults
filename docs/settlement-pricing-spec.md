# Authoritative cash settlement pricing

Status: **revised and authorized on 2026-09-09: every vault receives its own price-setting transactions, and an explicit feature flag controls new cash admissions**. This supersedes shared pair/expiry reports and the publisher-count mechanism. The Hub owns prices and publisher authority; an EOA or optional helper can publish. This implements [the stakeholder plan](stakeholder-feedback-task-plan.md). Production operator identities and market-data methodology remain deployment-specific choices.

## Physical-only launch and later cash activation

The Hub constructor has no settlement-publisher argument, grants no publisher membership and leaves `cashSettlementEnabled` false. Physical vault creation, exercise, expiration and claims require no settlement publisher or settlement methodology. The optional indicative activation feed remains independent.

Use a stored boolean with `setCashSettlementEnabled(bool)` restricted to `DEFAULT_ADMIN_ROLE`, emitting `CashSettlementEnabledUpdated(bool enabled)`. Remove the publisher count and all membership-counting hooks. Grants, revocations and self-renunciation never modify the flag automatically. Publisher authorization remains AccessControl; zero-address publisher grants are rejected.

When the flag is false, reject creation of both Cash and Either vaults and cash bid activation, including in previously created auctions. Physical bid activation remains available, including for existing Either vaults. Existing physical-only vault terms cannot be loosened to cash after enablement. Deposits, tightening and auction cancellation retain their existing admission, phase and timing rules.

The flag gates new positions only. Disabling it must not block publication, exercise, expiration, claims or agreed unwind for existing live cash positions. Stored exercise observations retain their freshness and validity limits; finalized expiry prices remain usable. Revocation blocks that publisher's future submissions but does not erase reports or change the flag. Missing reports keep obligations locked until an authorized publisher supplies the missing vault-specific report. Neither flag changes nor role changes convert settlement types or discard obligations.

Before enabling cash, the admin must arrange an approved methodology and grant the publisher role to a responsible EOA or helper. The contract setter intentionally does not count or discover publishers and can be called independently of membership. The operator command verifies a nominated publisher's current role before preparing enablement; this is a preflight check, not a stored publisher binding or proof of availability. Roles may change after preflight, so the administrator remains responsible for publication coverage. Disabling requires no publisher nomination.

## Payment authority and routing

Retain both American and European cash options. Keep indicative activation pricing separate from the Hub’s authoritative settlement-price registry. An indicative price may constrain the winning strike; it must never authorize a cash payment.

| Action | Required price |
| --- | --- |
| Activation with indicative checks enabled | Fresh `priceFeed.spot(underlying, quote)` under existing activation rules |
| American cash exercise strictly before expiry | That vault's fresh, unexpired exercise observation |
| American or European cash exercise at or after expiry | That vault's finalized price for its fixed expiry |
| Cash expiration | The same vault-specific final price, for all remaining notional |
| Physical exercise or expiration | No settlement-price requirement |

There is no fallback from an authoritative report to the indicative feed. Exact expiry is the boundary: even a still-fresh exercise observation cannot pay a cash exercise at that timestamp. Existing authorization, partial-exercise policy, intrinsic-value arithmetic and payout denomination remain unchanged.

## Minimal public interface

The Hub stores one exercise observation and one final expiry value per vault ID. Its linked settlement library reads that vault's storage reference directly. No shared pair keys, external settlement source or Hub self-call is required. The same numeric vault ID on another Hub refers to independent storage.

```solidity
bytes32 public constant SETTLEMENT_PRICE_PUBLISHER_ROLE;
bool public cashSettlementEnabled;

function setCashSettlementEnabled(bool enabled) external;

function publishExercisePrice(
    uint256 vaultId, uint256 price,
    uint64 observedAt, uint64 validUntil
) external;

function exercisePrice(uint256 vaultId)
    external view returns (uint256 price, uint256 observedAt, uint256 validUntil);

function publishExpiry(uint256 vaultId, uint256 price, uint64 validUntil) external;

function settlementPrice(uint256 vaultId)
    external view returns (uint256 price);
```

The existing Hub `DEFAULT_ADMIN_ROLE` controls publisher membership after deployment. Both publication functions require current publisher membership and an existing Live vault whose activated settlement type is Cash. Reject unknown, pre-activation, physical and finalized positions. Activation fixes the selected quote and expiry; derive the underlying, quote and expiry from terms/state instead of accepting them from the publisher. Require positive prices. Events include the vault ID and relevant derived pair/expiry metadata. Read APIs reject unknown vault IDs; known vaults without an exercise observation return zeros, while missing final prices revert.

Matching vaults need independent price-setting transactions even when underlying, quote and expiry are identical. Each may receive a different price. Publishing or finalizing one vault cannot populate, replace or block another vault's report. This permits independent approval; it does not assert that different prices represent a common market methodology.

Remove `settlementPriceFeed` from vault terms. Retain `maxSettlementPriceAge`, positive for any vault permitting cash settlement and immutable across tightening. Existing `priceFeed` and `maxPriceAge` retain their separate optional activation-check meaning and tightening rules. A physical-only vault may use zero for settlement age and omit the indicative feed.

### Interchangeable publishers

An EOA with the Hub role can submit either publication transaction directly, specifying the vault ID. An optional helper can hold the same role and call those vault-specific APIs through a minimal write-side interface. The helper may calculate prices under its own approved policy; the Hub never reads prices from it or stores it as a vault dependency.

Provide an access-controlled helper example and tests demonstrating EOA and contract publication. Unprivileged callers must not be able to publish through a trusted helper. The helper remains absent from default deployment. After explicit feature enablement, granting an EOA the role is sufficient for publication without deploying a settlement feed or helper.

## Exercise observations

Store the latest `(price, observedAt, validUntil)` for each vault. Require `0 < observedAt <= block.timestamp <= validUntil`, and strictly increasing `observedAt` for that vault. Reject expired submissions and non-increasing observations, including equal timestamps with different prices. Different vaults can accept the same observation timestamp.

At consumption require a present positive price, a nonfuture observation, `block.timestamp - observedAt <= maxSettlementPriceAge`, and `block.timestamp <= validUntil`. Age and validity boundaries are inclusive and are checked during exercise. No other vault's report is usable. Publication after expiry cannot make an exercise observation usable in place of the final expiry price.

A newly published observation affects subsequent eligible exercise transactions only. It cannot change a payment already executed. Publishers must choose observation validity durations compatible with the supported vault freshness limits; a long validity deadline does not bypass a vault's age check.

## Exact expiry and finality

Key final prices by vault ID and derive expiry from that vault's activated state. Require `block.timestamp >= expiry`. Accept publication through its `validUntil` deadline inclusively. Once a positive price is stored, reject every second publication for that vault, including identical values. A different vault needs its own finalization. Final prices remain readable indefinitely, including after settlement; submission deadlines do not expire finalized values.

Use immediate write-once finality, without a challenge period. Review the calculation before submitting the transaction. There is no administrative correction or deletion and no retroactive change to completed payouts. A mistaken final report remains the contractual price; incident response cannot promise an on-chain reversal. This irreversible trust choice is part of the accepted implementation policy.

Late historical publication remains possible while the cash position is Live, without an arbitrary cutoff. Reconstruct that vault's approved calculation for its original expiry and submit with a current submission deadline. Never substitute a current market price, another vault's report or a different expiry.

## Price methodology and operational approval

Prices use integer quote-token units per one whole underlying token. For WETH/USDC, 2,500 USDC per WETH is `2500000000`. This differs from premium-token units and from a generic 18-decimal price convention.

Preserve the existing proposed expiry methodology: a 30-minute average ending at the exact expiry. The production methodology must additionally name the approved data source(s), sampling frequency, weighting, rounding, missing-sample policy and source outage handling. These details are **not currently approved** and must not be invented by deployment tooling. Exercise observations likewise require an approved current-price source and deterministic calculation, timestamp and validity policy. The contracts attest publisher responsibility; they do not prove source accuracy or compute either methodology.

Before enabling production cash admissions, record approved methodology, responsible operators, evidence location and freshness configuration. Bind each vault's preparation/publication requests to its intended methodology artifact and retain its calculation evidence. Vaults may share an approved method but still need independent publication. This is an operational prerequisite, not a new on-chain source registry. Physical-only deployment needs no such record; synthetic tests do not approve production sources.

## Governance, rotation and trust

The Hub admin manages the flag and publication authority. In production it should be a multisig; publishers may be EOAs, multisigs or authenticated helpers. Any role holder can publish for any eligible cash vault; there is no new per-vault publisher ACL. Multiple holders do not create an on-chain quorum. A signing threshold belongs to a publisher multisig.

The Hub administrator can grant and revoke publisher authority, affecting all cash vaults on that Hub. Granting a replacement and revoking the previous publisher is the recovery procedure; role rotation does not rewrite vault terms. Revocation prevents future publication transactions, including queued ones that execute after revocation. Because there are no signed settlement messages, there are no outstanding settlement signatures to invalidate. Ordinary transaction chain and destination binding applies; a transaction on another chain/Hub does not populate this Hub’s state.

Stored exercise observations survive revocation and remain usable until their age or validity limit expires, or a newer observation replaces them. Stored final prices survive permanently. Revocation is not a retroactive data veto. Publisher identity remains mutable: depositors trust the Hub administrator and every authorized publisher throughout the position. Losing all admin keys prevents governance recovery; losing all publishers with a functioning admin permits rotation.

## Failure and incident procedure

Missing, stale or invalid exercise observations cause cash early exercise to revert. Missing final expiry reports cause cash exercise at/after expiry and cash expiration to revert atomically. Neither condition settles the vault for zero, advances exercised notional, releases collateral to LPs or discards the buyer's outstanding obligation. Independent earned-premium claims remain available under existing rules.

If publication coverage is lost, explicitly disable new cash admissions as appropriate and rotate authority. The replacement publishes each missing vault-specific report. Recovery publication and existing-position settlement remain available while the flag is false. Preserve locked obligations while awaiting reports. Existing admission pause also leaves publication, exercise, expiration, claims and agreed unwind available and never moves deadlines. Unwind retains unanimous-consent and separately funded-refund requirements; it is not an automatic price fallback.

For an erroneous exercise observation, publish a strictly later valid observation after verification; already completed exercises remain final. For an erroneous finalized expiry report, record the incident and stop new affected admissions as appropriate. No administrator can correct that report within this design. Any off-chain negotiated remedy is outside protocol accounting and cannot seize existing claimant balances.

## Compatibility and operator tooling

The publication/read/helper APIs and price storage layout change. Use a new immutable deployment with matching artifacts, libraries and helpers. Existing deployments retain their behavior; this is not an in-place upgrade or migration of live positions. The seven-argument Hub constructor remains free of settlement inputs.

Default deployment contains no publisher, automatic enablement or required cash methodology. Indicative signer configuration stays separate; deployment methodology metadata is optional. Use manifest version 6 and reject obsolete plans. Recovery verifies immutable bindings and Hub administration without imposing a particular flag or publisher membership state after deployment.

Add `set-cash-settlement-enabled` to the CLI. Require boolean `enabled`; for true require a nonzero nominated `publisher` with the Hub role. False needs no publisher. Preview current/requested flag state and the checked publisher; the contract receives only the boolean. Role commands remain separate and must not imply automatic enablement.

Publication requests identify `hub`, `vaultId`, `settlementMethodology` and a report containing `price`, `validUntil` and, for exercise observations, `observedAt`. Preview derived underlying, selected quote, vault expiry, units and vault ID. Keep these shapes separate from indicative spot typed reports. Default examples remain physical; cash examples show grant, explicit enable, creation/activation and then independent publication for each vault. Cash preparation and publication still require methodology references.

The clean rehearsal completes physical delivery with cash disabled, grants a publisher without enabling cash, explicitly enables through the CLI and publishes vault-specific reports. It also disables the flag and verifies publication/recovery, expiration and claims for existing cash positions. Continue testing unauthorized submissions, optional helper authentication and stale-plan rejection.

## Public API test seams and acceptance

Test publication, authorization, reads, routing and accounting through public Hub and vault APIs; test optional helper access control through its public API.

- Feature flag: default false, admin-only toggles/events, grants/revokes/renunciation never toggle it, count API removed, disabled Cash/Either creation and cash activation including pending auctions, physical lifecycle and fixed physical-only terms preserved.
- Publication: EOA/helper current role, helper authentication, unknown/non-Live/physical vault rejection, zero price, nonfuture/increasing observations, inclusive deadlines and vault-derived metadata.
- Isolation: matching cash vaults need independent reports, accept equal timestamps/different prices and finalize separately; another Hub's same ID cannot supply a report.
- Routing/finality: no indicative/other-vault fallback, exact-expiry switch, European pre-expiry rejection, early/duplicate finalization rejection, late recovery, indefinite final reads and stored reports after revocation.
- Accounting: flag-off publication/existing exercise/expiration/claims/unwind remain available; missing reports preserve obligations; partial exercise plus expiration cannot double-pay; premium/fee/buyer reserves stay separate.
- Integration: boolean and nominated-publisher enable preflight, disabling during outage, role/flag independence, per-vault preview/calldata, rehearsal, matching examples and manifest recovery; compile, typecheck, focused tests during work, final full suite, size and docs checks.

## Production configuration still required

The implementation retains American exercise support, direct role publication, immediate irreversible expiry finality, shared mutable publisher authority, observation-survival policy and locked-obligation recovery. Production readiness separately requires named admin/operator accounts and the approved per-pair methodology and freshness configuration. Local implementation and tests do not authorize production deployment or price publication.
