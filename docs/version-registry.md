# Releases and the permanent registry

Ivy publishes new functionality through independent immutable deployments. `IvyVaultsRegistry` gives integrations a permanent discovery address on a chain. It records a release ID, the release's Hub address and a hash committing to its release bundle: deployment manifest, journal evidence and preserved artifacts. The registry administrator may recommend a release for new vaults. Registration and recommendation are separate actions.

## What remains fixed

A registration cannot be overwritten or removed. The registry cannot replace Hub code, rewire modules, call vault operations or transfer assets. Each vault remains bound to the Hub that created it. Its deposits, exercise, expiration, premium and residual claims follow that original deployment. An older Hub remains directly usable under its own admission rules, including for new vault creation; changing the recommendation does not impose an on-chain admission restriction.

Release IDs identify deployments. They are distinct from the Hub's `version()` string, EIP-712 domain versions and deployment-plan format versions. Different releases can implement the same contract interface. A release ID has meaning only within a particular registry and chain.

The registry does not validate source code or audit quality on-chain. Its administrator remains responsible for the release being registered and recommended. Registration tooling verifies deployment evidence and bindings; operators must separately review the release's behavior before registration. The chosen registry address is itself part of the integration's trusted configuration.

Immutability prevents patching existing code in place. A defect may require a new release for future positions; existing positions retain their original settlement and consensual-unwind rules. The registry adds no emergency withdrawal or forced migration mechanism. Admission pauses, role management, transfer controls, fees and optional cash-price publication remain the administrative powers defined by each Hub.

## Deploy the registry once

Use the same Node and compiler setup as the [Hub deployment runbook](operations.md#deploy-and-recover). Run commands from the repository root. Choose the registry administrator independently of the Hub administrator; the registry receives no Hub role.

Prepare a request containing `rpc`, `deployer` and `admin`, then save the predicted registry deployment:

```sh
node scripts/operator.mjs prepare-registry-deployment registry-deployment.json > registry-plan.json
```

Inspect the chain, administrator, nonce, creation data and registry address. Prepare `registry-run.json` with `rpc`, `planFile: "registry-plan.json"` and `journalFile: "registry-journal.json"`. Explicit execution uses:

```sh
node scripts/operator.mjs deploy-registry registry-run.json --send
```

Keep the plan and journal. To resume after interruption, use the same command, files and registry artifact. Recovery verifies creation evidence before adopting existing code and does not create another registry. Registry deployment uses its own one-contract plan; complete it before preparing a Hub plan if sharing a deployer. Do not consume a nonce from an already prepared eight-contract Hub sequence.

## Register and recommend a release

Deploy a Hub suite using its normal manifest-v6 plan and recovery journal. Registry discovery does not change that plan, the seven-argument Hub constructor or its initial physical-only settings.

Prepare a bundle request containing `rpc`, `planFile` and `journalFile` for the completed Hub deployment. From the checkout with that release's matching artifacts, run:

```sh
node scripts/operator.mjs prepare-release-bundle release-bundle-request.json > release-bundle.json
```

The bundle has `format: 1`, `interfaceFormat: "ivy-vaults-v2"`, `manifest`, `journal` and `artifacts`. It preserves the contract interfaces and deployment evidence with the release. The verifier rebuilds the manifest from its artifacts, checks the chain and creation receipts, and checks runtime history and immutable module/library bindings. The RPC must provide the historical code and receipts used by these checks. Archive the bundle and the original build; treat them as part of the release, not temporary output.

Prepare `register-release.json` with `rpc`, `sender` (the registry administrator), `registry`, `releaseId` and `releaseBundleFile: "release-bundle.json"`. The file path is resolved from the command's working directory. Registration computes the bundle digest for `manifestHashOf(releaseId)`; the hash commits to the artifacts and evidence as well as the manifest. Do not edit the bundle after registration.

```sh
node scripts/operator.mjs register-version register-release.json
node scripts/operator.mjs register-version register-release.json --send
```

The first command verifies the bundle, simulates registration and prints the concrete transaction for review. The second explicitly submits. Verify the registered Hub and hash before recommending it. Recommendations use a separate request containing `rpc`, `sender`, `registry` and `releaseId`:

```sh
node scripts/operator.mjs recommend-version recommend-release.json
node scripts/operator.mjs recommend-version recommend-release.json --send
```

Only registered releases can be recommended. Registration alone leaves the recommendation unchanged; a newly deployed registry has no recommendation. The registry cannot edit an old registration to correct an error. A corrected deployment needs a new release registration. Recommendation changes do not pause, upgrade or migrate any Hub.

## Prepare transactions for a selected release

Existing operator requests may continue to name `hub` directly. To resolve a registry release, supply `registry`, `releaseId` and `releaseBundleFile` along with the command's usual sender, vault and token fields. If `hub` is also supplied, it must match that registration. The output remains a transaction addressed to the resolved Hub or the actual vault/token target appropriate to the operation.

Only `prepare-vault` may omit `releaseId` to use the current recommendation. Supply its matching bundle. Commands for existing vaults must specify the release or use their original explicit Hub; they never select a Hub using the moving recommendation. Missing, incompatible or mismatched release evidence fails before transaction encoding. A release's signing-domain version is verified separately from its registry release ID.

After preparing, retain the returned chain, destination and calldata (or full typed-signature payload). Send that prepared transaction through the wallet rather than preparing it again against a new recommendation. Each invocation of a CLI command, including `--send`, performs a new preparation against the state then available; pass the selected `releaseId` explicitly when repeating a command.

This build supports bundle format 1, Hub deployment manifests in format 6 and the `ivy-vaults-v2` interface. A future incompatible interface needs its own reviewed tooling adapter. It is rejected by this build rather than interpreted through a current ABI. An administrative role rotation does not change immutable release bindings; existing positions remain usable through their original Hub.

## Frontend integration

The transaction frontend is maintained outside this repository. The reusable resolver and operator transaction builder demonstrate the integration contract:

1. Configure a registry address for each supported chain. Resolve the recommended release only when starting a new position, or let the user select a registered release explicitly.
2. Load and verify that release's manifest and matching artifacts. An unknown interface format must produce an unsupported-release error rather than use another release's ABI or signing rules.
3. Show the selected Hub and release before the user commits. Prepare the transaction for that concrete Hub address. A later recommendation change cannot redirect an already prepared transaction.
4. Store positions and index events by `(chainId, hubAddress, vaultId)`. Keep that identity in position URLs, local state and backend records. Use the release's share-token address with its local token ID when reading LP balances.
5. Return to that exact Hub for an existing position. Do not resolve the current recommendation to decide where an old vault's deposit, exercise or claim belongs. Token approvals target its actual vault clone.
6. Keep older artifacts and interfaces available, along with their operational support. Users must retain direct contract access independently of whether a release is recommended in the UI.

The permanent registry address is used for discovery. Wallet transactions and signature verification remain bound to the selected deployment. No forwarding support, shared Hub storage or transaction router is introduced.

The filesystem-free `resolveRelease` export in `scripts/releases.mjs` accepts an ethers JSON-RPC-capable provider (such as `JsonRpcProvider` or `BrowserProvider`), a request containing the parsed `releaseBundle`, the supported artifacts, and an optional `{ allowRecommended: true }` for new-position discovery. The provider must support `send(method, params)` as well as historical code and receipt reads. Runtime verification uses an uncached `eth_getCode` request so a pre-deployment empty-code read cannot invalidate a newly mined deployment. Recovery also reads the latest block height without the provider cache when scanning for a transaction whose hash was lost during interruption. It returns the concrete Hub, chain, registry, release ID, bundle hash and saved artifacts. Browser integrations load the JSON bundle themselves; the CLI additionally supports `releaseBundleFile`. Use the returned saved interfaces for contract calls and preserve the Hub address when indexing the creation receipt.

## Finding vault creation in the source

`IvyVaultsHub` inherits `IvyVaultsSettlement`, which inherits `IvyVaultsActivation`, which inherits `IvyVaultsLifecycle`. Solidity compiles these abstract bases into the deployed Hub. The user calls `createVault(terms, pairs)` on the Hub address; the implementation lives in `contracts/hub/IvyVaultsLifecycle.sol`.

That function increments the local vault counter, calls `Clones.clone(vaultImplementation)` and initializes the new clone with the Hub address, vault ID, collateral and premium module in the same transaction. The implementation is deployed once per Hub suite; every clone has a separate address and storage. The registry does not participate in this creation path.

See the [accepted specification](version-registry-spec.md), [operator runbook](operations.md) and [request examples](../examples/operator/README.md).
