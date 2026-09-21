# Frontend integration guide

This guide explains how a frontend uses one permanent `IvyVaultsRegistry` address while continuing to support vaults created by every immutable Hub release.

The central rule is:

- Use the registry recommendation when starting a **new vault**.
- Use the vault's stored **original Hub address** for every later action.

The registry is a discovery contract. It does not proxy transactions, hold vault state or forward calls to a Hub.

```text
New vault
  configured registry
    -> recommendedVersion()
    -> hubOf(releaseId)
    -> selected Hub.createVault(...)

Existing vault
  stored (chainId, hubAddress, vaultId)
    -> original Hub.deposit/exercise/expire/claim(...)
```

## Addresses and release assets

Configure one trusted registry address for each supported chain. Do not discover the registry through another mutable service without verifying the result against the application's chain configuration.

The on-chain registry provides the release ID, Hub address and manifest hash. It does not store an ABI or the release bundle itself. The frontend therefore also needs a release-bundle store containing the preserved bundle for every supported release. A bundle contains the deployment manifest, deployment evidence and matching contract artifacts.

For each supported release, verify:

1. The connected chain matches the release manifest.
2. `hubOf(releaseId)` matches the Hub recorded in the bundle.
3. `manifestHashOf(releaseId)` matches the bundle hash.
4. The interface format and ABIs are supported by the frontend.
5. The deployed code and immutable module bindings match the bundle.

The reusable `resolveRelease` function in `scripts/releases.mjs` performs these checks with an ethers `JsonRpcProvider` or `BrowserProvider`. A production frontend can package this resolver and load the JSON bundles from its static assets or a content-addressed release store.

## Stable identifiers

Vault IDs are local to one Hub. Release 1 and release 2 can both contain `vaultId == 1`, so `vaultId` alone is never a globally unique position identifier.

Persist at least:

```ts
export type IvyVaultReference = {
  chainId: bigint;
  registryAddress: string;
  releaseId: bigint;
  hubAddress: string;
  vaultId: bigint;
  vaultAddress: string;
};
```

Use `(chainId, hubAddress, vaultId)` as the canonical identity in URLs, database keys, caches and analytics. `releaseId` is useful metadata for finding the matching bundle and ABI. `vaultAddress` is the clone custody address and the ERC-20 approval target.

A suitable route is:

```text
/vaults/:chainId/:hubAddress/:vaultId
```

Do not build an existing-vault route containing only `vaultId`.

## Resolve the Hub for a new vault

Read the recommendation when the user begins a new-vault flow. Resolve and verify that release, then pin its Hub and release ID in the form state. Show both values in the final transaction review.

```ts
import { BrowserProvider, Contract } from "ethers";
import { resolveRelease } from "../scripts/releases.mjs";

const REGISTRY_ABI = [
  "function recommendedVersion() view returns (uint256)",
  "function hubOf(uint256) view returns (address)",
  "function manifestHashOf(uint256) view returns (bytes32)",
];

export async function resolveRecommendedHub(
  provider: BrowserProvider,
  registryAddress: string,
  releaseBundles: Record<string, unknown>,
  supportedArtifacts: Record<string, unknown>,
) {
  const registry = new Contract(registryAddress, REGISTRY_ABI, provider);
  const releaseId: bigint = await registry.recommendedVersion();

  if (releaseId === 0n) throw new Error("Ivy has no recommended release on this chain");

  const releaseBundle = releaseBundles[releaseId.toString()];
  if (!releaseBundle) throw new Error(`Unsupported Ivy release ${releaseId}`);

  return resolveRelease(
    provider,
    { registry: registryAddress, releaseId, releaseBundle },
    supportedArtifacts,
  );
}
```

`resolveRelease` returns the concrete Hub, chain, registry, release ID, verified manifest hash and preserved artifacts. Instantiate the Hub with the ABI returned for that release.

Once resolution completes, do not silently switch the form to another Hub if `RecommendedVersionUpdated` is emitted. A recommendation change should apply to the next new-vault flow. If the UI offers a “refresh release” action, make the user review any values that depend on the selected release again.

## Create and fund a vault

Call `createVault` directly on the selected Hub. Calling it on `IvyVaultsRegistry` will revert because the registry has no forwarding interface.

```ts
import { Contract } from "ethers";

export async function createVault(
  signer: any,
  resolvedRelease: any,
  terms: any,
  pairs: any[],
): Promise<IvyVaultReference> {
  const hub = new Contract(
    resolvedRelease.hub,
    resolvedRelease.artifacts.IvyVaultsHub.abi,
    signer,
  );

  // Surface validation errors before opening the wallet confirmation.
  await hub.createVault.staticCall(terms, pairs);

  const transaction = await hub.createVault(terms, pairs);
  const receipt = await transaction.wait();

  let created: any;
  for (const log of receipt.logs) {
    try {
      const event = hub.interface.parseLog(log);
      if (event?.name === "VaultCreated") {
        created = event;
        break;
      }
    } catch {
      // The receipt may contain logs emitted by other contracts.
    }
  }

  if (!created) throw new Error("VaultCreated event missing from receipt");

  return {
    chainId: BigInt(resolvedRelease.chainId),
    registryAddress: resolvedRelease.registry,
    releaseId: BigInt(resolvedRelease.releaseId),
    hubAddress: resolvedRelease.hub,
    vaultId: created.args.vaultId,
    vaultAddress: created.args.vault,
  };
}
```

Treat the mined `VaultCreated` event as the authoritative identity. A `staticCall` preview can become stale if another vault is created before the user's transaction is mined.

After creation, approve collateral to the emitted clone address and deposit through the original Hub:

```ts
const ERC20_ABI = ["function approve(address,uint256) returns (bool)"];
const collateralToken = new Contract(terms.collateral, ERC20_ABI, signer);

await (await collateralToken.approve(reference.vaultAddress, depositAmount)).wait();

const hub = new Contract(
  reference.hubAddress,
  resolvedRelease.artifacts.IvyVaultsHub.abi,
  signer,
);
await (await hub.deposit(reference.vaultId, depositAmount)).wait();
await (await hub.openAuction(reference.vaultId)).wait();
```

The spender is `vaultAddress`. Never approve the registry or Hub to spend collateral. A direct `IvyVault.deposit(amount)` is also supported, but the same clone approval is required.

## Open an existing vault

When opening an existing position, start from its stored reference. Do not call `recommendedVersion()` to select its Hub.

1. Confirm that the wallet is connected to `reference.chainId`.
2. Load the bundle and ABI for `reference.releaseId`.
3. Verify that the registry still returns `reference.hubAddress` for that release. Registrations are permanent, so a mismatch is an integration or configuration error.
4. Instantiate `IvyVaultsHub` at `reference.hubAddress`.
5. Read `stateOf(reference.vaultId)`, `termsOf(reference.vaultId)` and `vaultOf(reference.vaultId)`.
6. Send deposits, auction actions, exercise, expiration and claims to that original Hub.

The current recommendation may point to a newer Hub. That has no effect on the existing vault's terms, modules, balances or claim paths.

## Discover every historical vault

The registry does not expose an array of releases. Index its events instead:

1. Read `VersionRegistered(releaseId, hub, manifestHash)` from the registry deployment block onward.
2. Persist every registered release. Registrations cannot be removed or replaced.
3. For each Hub, read `VaultCreated(vaultId, vault, owner, kind, underlying, collateral)` from that release's deployment block onward.
4. Key the indexed record by `(chainId, hubAddress, vaultId)`.
5. Use `RecommendedVersionUpdated` to update the default shown in the new-vault flow.

The index may run in the browser for small deployments. A backend indexer or subgraph is preferable once event history grows. The indexer should handle chain reorganizations by waiting for the application's chosen confirmation depth and replaying a small block range when advancing its cursor.

For a user's portfolio, query ERC-1155 balances from the share-token contract belonging to each release. The share token ID is the Hub-local vault ID, so its contract address is also part of the balance identity.

## Transactions and signatures

Every wallet transaction must display and target the concrete contract that will execute it:

| Action | Transaction target |
| --- | --- |
| Discover recommended release | Registry read |
| Create, deposit, open auction, exercise, expire or claim | Original Hub |
| Approve collateral or premium | ERC-20 token, with the clone as spender |
| Direct deposit or platform-fee claim | Vault clone |
| Read or transfer shares | Release-specific `IvyShares` contract |

Typed signatures also bind to the concrete immutable deployment:

- Bid domain: `name = IvyVaultsHub`, `version = 2`, connected `chainId`, `verifyingContract = hubAddress`.
- Unwind domain: `name = IvyUnwind`, `version = 1`, connected `chainId`, `verifyingContract =` that Hub release's unwind-module address.

A registry release ID is not an EIP-712 version. Never rebuild an existing bid or unwind signature against the current recommendation.

## Recommendation changes

When the registry administrator recommends a new release:

- A newly opened creation flow resolves the new Hub.
- A creation form that already pinned a Hub keeps that selection through signing and confirmation.
- Existing vault pages keep their stored original Hub.
- Historical indexing continues to include every registered release.
- The frontend must have the new release bundle and interface adapter before presenting it as supported.

If the registry recommends an interface the frontend does not support, disable new-vault creation with a clear “frontend update required” message. Continue serving existing vaults through their preserved release adapters.

## Failure handling

Handle these cases explicitly:

- `recommendedVersion() == 0`: new-vault creation is unavailable on this chain.
- Missing bundle or unsupported interface format: do not guess an ABI or substitute the current ABI.
- Registry/bundle Hub mismatch: stop before transaction preparation.
- Wallet chain mismatch: request the correct network before reads, signatures or transactions.
- Recommendation changes during a prepared flow: keep the pinned Hub and show it in the confirmation screen.
- Unknown existing position: require its original Hub or release reference; do not search only the recommended Hub.
- RPC log limits: index releases and vault events in bounded block ranges.

## Integration checklist

- Configure one registry address per chain.
- Preserve every supported release bundle and ABI adapter.
- Resolve the recommendation only for new-vault creation.
- Persist `(chainId, hubAddress, vaultId)` after `VaultCreated`.
- Approve the vault clone, never the registry or Hub.
- Index all `VersionRegistered` and per-Hub `VaultCreated` events.
- Route existing actions and signatures to the original Hub release.
- Fail closed on missing bundles, mismatched hashes and unsupported interfaces.
- Show the selected release ID and Hub before the wallet signs.

See the [release deployment and registration guide](site/releases.html), [protocol Guide](site/index.html#execution-permissions), and [operator request examples](../examples/operator/README.md) for the administrative and transaction-preparation workflows.
