# Immutable release registry

Status: accepted for implementation on 2026-09-09. Source: the stakeholder discussion and six-step implementation plan accepted in this task. Review baseline: `f055ca471ae0356d8a8a3f98b6ff4eb664500d69`.

## Objective

Add one permanent discovery address per chain so future Hub releases can coexist with existing vaults. Each deployed Hub, vault implementation and supporting module retains its original code and bindings. The registry does not execute vault transactions or acquire authority over funds. New features are published in new deployments; existing positions stay with their original deployment.

## Registry contract

Deploy a non-upgradeable `IvyVaultsRegistry` with an explicit nonzero administrator. Its minimal public interface is:

```solidity
registerVersion(uint256 releaseId, address hub, bytes32 manifestHash)
setRecommendedVersion(uint256 releaseId)
hubOf(uint256 releaseId)
manifestHashOf(uint256 releaseId)
recommendedVersion()
```

Only the administrator can register releases or change the recommendation. Reject zero release IDs, zero or non-contract Hub addresses, empty manifest hashes and duplicate release IDs or Hub registrations. Existing registrations cannot be replaced or deleted. Reject selecting an unregistered release. Start without a recommendation; registering a release must not implicitly recommend it. Emit registration and recommendation-change events. Unknown release reads must fail clearly. Registry authority is separate from Hub authority.

The release ID identifies a deployment. It is independent of `IvyVaultsHub.version()`, EIP-712 domain versions and deployment-manifest format versions. Registering contract code is not an on-chain proof that the code is immutable or audited: release verification is an explicit operator responsibility.

## Deployment and evidence

Deploy the registry separately, preserving the existing eight-contract Hub deployment order, manifest-v6 plans and recovery workflow. Add preparation, explicit execution and interruption-safe recovery for the registry deployment. Never insert it into an existing Hub nonce sequence.

Before preparing registration, verify the intended chain, Hub deployment evidence, runtime code and module/library bindings against the saved deployment artifacts and manifest. Commit the verified release manifest with the on-chain hash. Preserve the matching artifacts and interfaces for older releases. Unsupported manifest/interface formats must fail explicitly; never silently encode an older or unknown release with the current build's ABI or signing rules. Registration and recommendation are separate prepared administrative operations, with simulation and explicit execution following existing operator conventions.

## Resolution and integration

Provide a reusable release-resolution function and integrate it into operator transaction preparation. Resolve a selected registry release to a concrete Hub address and verified matching artifacts. A recommendation may provide the default when preparing creation of a new vault. Operations on an existing position must identify its specific release or original Hub; they must never follow the current recommendation implicitly.

Prepared transactions and typed signatures bind the selected Hub and chain. A recommendation change after preparation must not redirect them. If a request supplies both a Hub address and registry release, reject a mismatch. Keep explicit-Hub operations available for existing workflows and direct access. Resolve token approvals to the actual vault on that Hub. Identify positions by `(chainId, hubAddress, vaultId)`; local vault IDs may overlap across releases.

The transaction frontend is not present in this repository. Deliver the reusable resolution interface, examples and integration documentation here: the frontend uses the registry as a discovery address, retains the concrete deployment identity in position URLs and state, and sends transactions directly to the resolved Hub. Do not add a transaction router or a new wallet application to the documentation website.

## Coexistence and lifecycle guarantees

Changing the recommendation affects future default selection only. It must not update or pause a Hub, change a vault's owner or terms, migrate assets, invalidate bids, remove old claims or replace module bindings. All existing lifecycle, pause, fee, publisher and share-transfer controls retain their behavior. Operators keep the artifacts, indexing and operational support necessary for older positions.

An older Hub remains directly callable, including for new vault creation under its existing admission rules. A registry recommendation is not an on-chain admission restriction. Live code cannot be patched in place; ordinary settlement or consensual unwind remains governed by each original deployment.

## Validation

The accepted test seams are the registry's public contract interface, deployment preparation/recovery, release resolution and operator preparation, and two independent Hub suites through their public vault lifecycle interfaces. Use incremental failing tests and implementation at these seams.

Cover unauthorized administration, permanent registrations, duplicate/invalid inputs, missing recommendations and unknown releases. Cover chain/manifest/artifact/Hub mismatches, preserved explicit-Hub requests, unsupported release formats, registry deployment recovery, and transactions/signatures prepared before a recommendation change. Demonstrate overlapping vault IDs on two Hub suites, then exercise, expire and claim old positions after registering and recommending the new release. Verify users' balances and deployment bindings, not only registry state.

Run focused tests and typechecking during implementation. Run the full suite, compilation/contract-size checks and documentation checks before delivery. Review the committed diff against this specification and repository conventions on separate Standards and Spec axes, fix findings and repeat until both have no unresolved findings.
