# Authoritative cash settlement pricing

Status: **accepted for implementation on 2026-09-09 following the user’s instruction to continue with this specification**. This is the Task 3 deliverable in [the stakeholder plan](stakeholder-feedback-task-plan.md). It does not itself authorize a production source, operator or deployment. The policies below define the implementation; production identities and market-data methodology remain deployment-specific choices.

## Payment authority and routing

Retain both American and European cash options. Separate the indicative activation feed from an authoritative cash settlement feed. An indicative price may constrain the winning strike; it must never authorize a cash payment.

| Action | Required price |
| --- | --- |
| Activation with indicative checks enabled | Fresh `priceFeed.spot(underlying, quote)` under existing activation rules |
| American cash exercise strictly before expiry | Fresh, unexpired authoritative exercise observation |
| American or European cash exercise at or after expiry | Final authoritative price bound to the exact vault expiry |
| Cash expiration | The same final authoritative expiry price, for all remaining notional |
| Physical exercise or expiration | No settlement feed requirement |

There is no fallback from an authoritative report to the indicative feed. Exact expiry is the boundary: even a still-fresh exercise observation cannot pay a cash exercise at that timestamp. Existing authorization, partial-exercise policy, intrinsic-value arithmetic and payout denomination remain unchanged.

## Minimal public interface

Introduce `IvySettlementPriceFeed` and its read interface separately from `IvyPriceFeed`. Use OpenZeppelin AccessControl and direct publisher transactions, with no new settlement EIP-712 message or permissionless signed-report relay.

```solidity
constructor(address admin, address publisher);
bytes32 public constant SETTLEMENT_PRICE_PUBLISHER_ROLE;

function publishExercisePrice(
    address underlying, address quote, uint256 price,
    uint64 observedAt, uint64 validUntil
) external;

function exercisePrice(address underlying, address quote)
    external view returns (uint256 price, uint256 observedAt, uint256 validUntil);

function publishExpiry(
    address underlying, address quote, uint64 expiry,
    uint256 price, uint64 validUntil
) external;

function settlementPrice(address underlying, address quote, uint64 expiry)
    external view returns (uint256 price);
```

Both publication functions require the publisher role at transaction execution. Constructor identities must be nonzero. Each report requires nonzero, distinct token addresses and a strictly positive price. Emit publication events with the complete observation or expiry binding. Standard role events expose authorization changes.

Add `settlementPriceFeed` and `maxSettlementPriceAge` to vault terms. Any vault permitting cash settlement requires a contract feed address and positive freshness limit. Fix both terms at creation, including across tightening; neither the owner nor governance can redirect an existing vault to another settlement feed. Existing `priceFeed` and `maxPriceAge` retain their separate activation-check meaning and existing tightening rules. A physical-only vault may omit both feeds.

## Exercise observations

Store the latest `(price, observedAt, validUntil)` for each ordered underlying/quote pair. Require `0 < observedAt <= block.timestamp <= validUntil`, and strictly increasing `observedAt` for that pair. Reject an expired submission and any non-increasing observation, including one with the same timestamp and different price.

At consumption require a present, positive price, a nonfuture observation, `block.timestamp - observedAt <= maxSettlementPriceAge`, and `block.timestamp <= validUntil`. The exact freshness and validity boundaries are inclusive. Validity must remain stored and checked during exercise, rather than only at publication. No price selected for another pair is usable.

A newly published observation affects subsequent eligible exercise transactions only. It cannot change a payment already executed. Publishers must choose observation validity durations compatible with the supported vault freshness limits; a long validity deadline does not bypass a vault's age check.

## Exact expiry and finality

Key final prices by `(underlying, quote, expiry)`. Require nonzero expiry and `block.timestamp >= expiry`. A publication is accepted only through its `validUntil` submission deadline, inclusively. Once a positive price is stored, reject every second publication for that key, including identical values and administrator submissions. Final prices remain readable indefinitely; the publication deadline does not expire a finalized price.

Use immediate write-once finality, without a challenge period. Review the calculation before submitting the transaction. There is no administrative correction or deletion and no retroactive change to completed payouts. A mistaken final report remains the contractual price; incident response cannot promise an on-chain reversal. This irreversible trust choice is part of the accepted implementation policy.

Late historical publication is permitted without an arbitrary settlement cutoff: reconstruct the agreed historical calculation for the original expiry and submit a new transaction with a current submission deadline. Never substitute the current market price or change the expiry to make publication possible.

## Price methodology and operational approval

Prices use integer quote-token units per one whole underlying token. For WETH/USDC, 2,500 USDC per WETH is `2500000000`. This differs from premium-token units and from a generic 18-decimal price convention.

Preserve the existing proposed expiry methodology: a 30-minute average ending at the exact expiry. The production methodology must additionally name the approved data source(s), sampling frequency, weighting, rounding, missing-sample policy and source outage handling. These details are **not currently approved** and must not be invented by deployment tooling. Exercise observations likewise require an approved current-price source and deterministic calculation, timestamp and validity policy. The contracts attest publisher responsibility; they do not prove source accuracy or compute either methodology.

Before admitting production cash vaults, publish a methodology record for each supported pair containing those choices, the responsible operator identity, report evidence retention location and the selected maximum age. Reference that approved methodology artifact in the deployment runbook/configuration so operators can recover the exact approved source set and calculation procedure. This is an operational launch prerequisite, not a new on-chain source registry. Local tests may use explicit synthetic observations; they do not constitute approval of a production market source.

## Governance, rotation and trust

Recommend a multisig as `DEFAULT_ADMIN_ROLE` holder and a designated settlement operator, preferably a multisig, as publisher. Standard AccessControl permits multiple publisher accounts; any one can publish. It does not implement a threshold across role holders. A signing threshold, if required, belongs to the publisher multisig.

The administrator can grant and revoke publisher authority on this feed, affecting all vaults using it. Granting a replacement and revoking the previous publisher is the recovery procedure; role rotation does not rewrite vault terms. Revocation prevents future publication transactions, including queued ones that execute after revocation. Because there are no signed settlement messages, there are no outstanding settlement signatures to invalidate. Ordinary transaction chain and destination binding applies; a transaction on another chain/feed does not populate this feed's state.

Stored exercise observations survive revocation and remain usable until their age or validity limit expires, or a newer observation replaces them. Stored final prices survive permanently. Revocation is not a retroactive data veto. The immutable feed address therefore does **not** imply immutable publisher identity: depositors trust this feed's administrator and every authorized publisher throughout the position. Losing all admin keys prevents governance recovery; losing all publishers with a functioning admin permits rotation.

## Failure and incident procedure

Missing, stale or invalid exercise observations cause cash early exercise to revert. Missing final expiry reports cause cash exercise at/after expiry and cash expiration to revert atomically. Neither condition settles the vault for zero, advances exercised notional, releases collateral to LPs or discards the buyer's outstanding obligation. Independent earned-premium claims remain available under existing rules.

For unavailable publishers, the admin rotates authority and the replacement publishes valid observations or the required historical expiry report. While awaiting recovery, preserve the live position and locked collateral. Existing admission pause does not halt report publication, exercise, expiration, claims or agreed unwind, and it does not extend deadlines. Agreed unwind remains available only under its existing unanimous-consent and separately funded-refund rules; it is not an automatic oracle fallback.

For an erroneous exercise observation, publish a strictly later valid observation after verification; already completed exercises remain final. For an erroneous finalized expiry report, record the incident and stop new affected admissions as appropriate. No administrator can correct that report within this design. Any off-chain negotiated remedy is outside protocol accounting and cannot seize existing claimant balances.

## Compatibility and operator tooling

Changing `VaultTerms` changes the vault-creation ABI. Deploy a new immutable hub, associated modules/libraries and authoritative feed using updated artifacts; existing immutable hubs and vaults keep their original pricing behavior. Do not represent deployment as an in-place upgrade or silently migrate existing positions. Update fixture constructors, deployment manifests, binding checks, operator JSON and examples together.

Deployment configuration must specify and verify settlement admin and publisher separately from the indicative feed signer. Operators must see the authority target, ordered pair, units and expiry before publication. Existing indicative signing commands may remain, but must be clearly labeled and must not imply that publishing to the old feed supplies prices to new cash vaults. Provide direct settlement publication commands and a rehearsal from role configuration through expiry publication, permissionless expiration and buyer payout claim.

## Public API test seams and acceptance

Test authorization and read behavior through public feed APIs; test routing and accounting through the public hub and vault APIs.

- Publication: unauthorized sender, constructor identities, grant/revoke, replacement publisher, queued-call revocation semantics, invalid token pair, zero price, future/non-increasing observations, expired submission and stored-observation validity after publication.
- Routing: different indicative and authoritative prices; correct selected quote pair; American exercise immediately before expiry versus exactly at expiry; European pre-expiry rejection; no cross-pair, cross-expiry or different-feed report consumption.
- Finality: pre-expiry publication rejection, duplicate finalization rejection, late historical recovery, indefinite final-price reads, no indicative update influence, and stored exercise/final observations after role revocation.
- Accounting: missing report reverts without releasing buyer obligations; recovery completes payment; partial exercise followed by expiration cannot pay twice; premium, treasury fees and buyer reserves remain isolated; physical behavior remains unchanged.
- Integration: deployment role bindings, clean local rehearsal, unauthorized tooling publication, missing-report recovery, examples matching ABI; compile, typecheck, full contract tests, deployed-size checks and docs checks.

## Production configuration still required

The implementation retains American exercise support, direct role publication, immediate irreversible expiry finality, shared mutable publisher authority, observation-survival policy and locked-obligation recovery. Production readiness separately requires named admin/operator accounts and the approved per-pair methodology and freshness configuration. Local implementation and tests do not authorize production deployment or price publication.
