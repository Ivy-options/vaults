# Authoritative cash settlement pricing

Status: **revised and authorized on 2026-09-09: deploy for physical delivery with no settlement publisher; enable new cash positions later by granting the Hub publisher role**. The Hub owns settlement prices and publication authority; an EOA or optional helper contract may publish. This is the Task 3 deliverable in [the stakeholder plan](stakeholder-feedback-task-plan.md). It does not itself authorize a production source, operator or deployment. The policies below define the implementation; production identities and market-data methodology remain deployment-specific choices.

## Physical-only launch and later cash activation

The Hub constructor has no settlement-publisher argument and grants no publisher membership. A fresh Hub exposes `settlementPublisherCount() == 0` and `cashSettlementEnabled() == false`. Physical vault creation, exercise, expiration and claims require no settlement publisher or settlement methodology. The optional indicative activation feed remains independent.

Derive `cashSettlementEnabled()` solely from whether the publisher count is positive; do not maintain a separate feature flag. The existing Hub administrator enables new cash positions by granting `SETTLEMENT_PRICE_PUBLISHER_ROLE` to a nonzero EOA or optional helper contract. Track actual membership changes through the role grant/revoke hooks, including self-renunciation. Duplicate grants, revocation of absent members and changes to other roles must not alter the publisher count. Multiple publishers are supported; removing one disables cash only if it was the last member.

When no publisher remains, reject creation of both Cash and Either vaults. Independently reject cash bid activation, including in previously created auctions. Physical bid activation remains available, including for existing Either vaults. Existing physical-only vault terms cannot be loosened to permit cash when a publisher is later granted. No cash guard is added to deposits, tightening or auction cancellation; existing admission, phase and timing rules still apply.

Publisher availability gates new positions only. Removing the last publisher must not gate exercise, expiration, claims or agreed unwind for existing live positions. Stored exercise observations remain subject to their existing freshness and validity limits; finalized expiry prices remain usable. Missing reports keep obligations locked until an administrator restores a publisher and the required report is supplied. Neither last-member revocation nor renunciation erases a buyer obligation or converts a cash position to physical delivery.

The count records authorization, not operational health: an offline EOA or a helper unable to submit reports still holds its role until revoked or renounced. Approve the cash methodology before granting the first production publisher; that grant enables new cash admissions immediately.

## Payment authority and routing

Retain both American and European cash options. Keep indicative activation pricing separate from the Hub’s authoritative settlement-price registry. An indicative price may constrain the winning strike; it must never authorize a cash payment.

| Action | Required price |
| --- | --- |
| Activation with indicative checks enabled | Fresh `priceFeed.spot(underlying, quote)` under existing activation rules |
| American cash exercise strictly before expiry | Fresh, unexpired authoritative exercise observation |
| American or European cash exercise at or after expiry | Final authoritative price bound to the exact vault expiry |
| Cash expiration | The same final authoritative expiry price, for all remaining notional |
| Physical exercise or expiration | No settlement-price requirement |

There is no fallback from an authoritative report to the indicative feed. Exact expiry is the boundary: even a still-fresh exercise observation cannot pay a cash exercise at that timestamp. Existing authorization, partial-exercise policy, intrinsic-value arithmetic and payout denomination remain unchanged.

## Minimal public interface

The Hub exposes the following publication and read APIs, with its existing OpenZeppelin AccessControl authority. No standalone settlement feed or read-side source interface is required. The Hub owns report storage, and its settlement library reads that storage directly through storage references passed by the Hub. There are no calls to an external settlement source or back to a Hub read interface during settlement.

```solidity
bytes32 public constant SETTLEMENT_PRICE_PUBLISHER_ROLE;
uint256 public settlementPublisherCount;

function cashSettlementEnabled() public view returns (bool);

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

The existing Hub `DEFAULT_ADMIN_ROLE` controls publisher membership after deployment. No separate settlement administrator exists. Both publication functions require current publisher membership at transaction execution. Each report requires nonzero, distinct token addresses and a strictly positive price. Emit publication events with the complete observation or expiry binding. Standard role events expose authorization changes.

Remove `settlementPriceFeed` from vault terms. Retain `maxSettlementPriceAge`, positive for any vault permitting cash settlement and immutable across tightening. Existing `priceFeed` and `maxPriceAge` retain their separate optional activation-check meaning and tightening rules. A physical-only vault may use zero for settlement age and omit the indicative feed.

### Interchangeable publishers

An EOA with the Hub role can submit either publication transaction directly. An optional helper contract can hold the exact same role and call the Hub’s publication functions using a minimal write-side interface. The helper may obtain or calculate prices according to its own approved policy; the Hub does not call it, require a reader interface from it, or store it as a vault dependency.

Provide an access-controlled helper example and tests demonstrating EOA and contract publication. An unprivileged caller must not be able to make a trusted helper publish arbitrary reports. The helper is optional and absent from the default deployment sequence. Granting the Hub role to an EOA must be sufficient to complete activation, exercise and expiration without deploying any settlement feed or helper.

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

Before enabling production cash admissions, publish a methodology record for each supported pair containing those choices, the responsible operator identity, report evidence retention location and the selected maximum age. Reference that approved methodology artifact in cash-vault preparation and publication requests so operators can recover the exact approved source set and calculation procedure. This is an operational cash-launch prerequisite, not a new on-chain source registry. Physical-only deployment requires no such record. Local tests may use explicit synthetic observations; they do not constitute approval of a production market source.

## Governance, rotation and trust

The Hub admin manages publication authority. In production it should be a multisig; the designated publisher can be an EOA, a multisig or an optional helper contract. Standard AccessControl permits multiple publisher accounts; any one can publish. It does not implement a threshold across role holders. A signing threshold, if required, belongs to the publisher multisig.

The Hub administrator can grant and revoke publisher authority, affecting all cash vaults on that Hub. Granting a replacement and revoking the previous publisher is the recovery procedure; role rotation does not rewrite vault terms. Revocation prevents future publication transactions, including queued ones that execute after revocation. Because there are no signed settlement messages, there are no outstanding settlement signatures to invalidate. Ordinary transaction chain and destination binding applies; a transaction on another chain/Hub does not populate this Hub’s state.

Stored exercise observations survive revocation and remain usable until their age or validity limit expires, or a newer observation replaces them. Stored final prices survive permanently. Revocation is not a retroactive data veto. Publisher identity remains mutable: depositors trust the Hub administrator and every authorized publisher throughout the position. Losing all admin keys prevents governance recovery; losing all publishers with a functioning admin permits rotation.

## Failure and incident procedure

Missing, stale or invalid exercise observations cause cash early exercise to revert. Missing final expiry reports cause cash exercise at/after expiry and cash expiration to revert atomically. Neither condition settles the vault for zero, advances exercised notional, releases collateral to LPs or discards the buyer's outstanding obligation. Independent earned-premium claims remain available under existing rules.

For unavailable publishers, the admin rotates authority and the replacement publishes valid observations or the required historical expiry report. While awaiting recovery, preserve the live position and locked collateral. Existing admission pause does not halt report publication, exercise, expiration, claims or agreed unwind, and it does not extend deadlines. Agreed unwind remains available only under its existing unanimous-consent and separately funded-refund rules; it is not an automatic oracle fallback.

For an erroneous exercise observation, publish a strictly later valid observation after verification; already completed exercises remain final. For an erroneous finalized expiry report, record the incident and stop new affected admissions as appropriate. No administrator can correct that report within this design. Any off-chain negotiated remedy is outside protocol accounting and cannot seize existing claimant balances.

## Compatibility and operator tooling

Removing the publisher constructor argument changes the deployment ABI. Deploy a new immutable hub and associated modules/libraries using updated artifacts; existing immutable hubs and vaults keep their original pricing behavior. The earlier removal of the per-vault settlement source also changed `VaultTerms`. Do not represent deployment as an in-place upgrade or silently migrate existing positions. Update fixture constructors, deployment manifests, binding checks, operator JSON and examples together.

Default deployment contains no settlement publisher, automatic role grant or required settlement methodology. Remove the publisher from deployment configuration/plans; any methodology metadata retained there is optional. Retain the separate indicative signer configuration. Use manifest version 5 and reject obsolete plans rather than silently adopting their old constructor. Deployment recovery verifies constructor/module bindings and Hub administration without requiring a publisher or assuming the publisher count remains zero after later role management.

Operators must see the Hub target, ordered pair, units and expiry before publication. Existing indicative signing commands may remain, but must be clearly labeled and must not imply that publishing to the old feed supplies prices to cash vaults. Direct settlement publication and role commands target the Hub. Default request examples prepare physical vaults without settlement configuration. Cash preparation and report publication still require a methodology reference. The clean rehearsal must first complete a physical lifecycle with no publisher, then explicitly grant an EOA the publisher role and demonstrate cash publication, missing-report recovery, expiration and payout claim. Optional helper tests must prove publication and revocation through the same Hub role.

## Public API test seams and acceptance

Test publication, authorization, reads, routing and accounting through public Hub and vault APIs; test optional helper access control through its public API.

- Availability: initial zero count/disabled state, no constructor publisher argument, unauthorized grants, zero-address rejection, duplicate grant/revoke, renunciation, multiple members and unrelated roles; Cash/Either creation and cash activation blocked at zero, physical lifecycle available, first grant enables and last removal disables new cash, existing physical terms remain fixed.
- Publication: unauthorized sender, grant/revoke, replacement publisher, queued-call revocation semantics, invalid token pair, zero price, future/non-increasing observations, expired submission and stored-observation validity after publication.
- Routing: different indicative and authoritative prices; correct selected quote pair; American exercise immediately before expiry versus exactly at expiry; European pre-expiry rejection; no cross-pair, cross-expiry or different-Hub report consumption.
- Finality: pre-expiry publication rejection, duplicate finalization rejection, late historical recovery, indefinite final-price reads, no indicative update influence, and stored exercise/final observations after role revocation; EOA and contract publishers and unauthorized helper callers.
- Accounting: stored prices still authorize existing cash exercise/expiration and claims at zero publishers; missing reports revert without releasing buyer obligations and regrant/report recovery completes payment; partial exercise followed by expiration cannot pay twice; premium, treasury fees and buyer reserves remain isolated; physical behavior remains unchanged.
- Integration: deployment role bindings, clean local rehearsal, unauthorized tooling publication, missing-report recovery, examples matching ABI; compile, typecheck, full contract tests, deployed-size checks and docs checks.

## Production configuration still required

The implementation retains American exercise support, direct role publication, immediate irreversible expiry finality, shared mutable publisher authority, observation-survival policy and locked-obligation recovery. Production readiness separately requires named admin/operator accounts and the approved per-pair methodology and freshness configuration. Local implementation and tests do not authorize production deployment or price publication.
