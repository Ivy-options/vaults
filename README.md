# Ivy Vaults

Single-use covered-call and cash-secured-put vaults with optional pooling and transferable ERC-1155 shares. An off-chain auction selects a signed buyer bid; activation collects the premium atomically. Activation holders can claim that premium immediately, and current shareholders claim the remaining pool after settlement or a unanimous unwind.

The deployment is immutable. There is no hub proxy, upgrade entrypoint, implementation setter, or module rewiring. This build creates a fresh deployment; it cannot upgrade an older hub.

| Contract | Responsibility |
| --- | --- |
| `IvyVaultsHub` | Lifecycle, bids, delegation and guarded public entrypoints |
| `IvyVault` | Clone custody, token reserves, separate premium and buyer payment budgets |
| `IvyShares` | ERC-1155 shares and pre-update module notifications |
| `IvyPremiums` | Activation entitlements and restricted premium payments |
| `IvyUnwind` | One active agreement and current-shareholder consent |
| `IvyPriceFeed` | Ivy-signed fresh spot and write-once expiry reports, including ERC-1271 signers |
| `IvyVaultRules` library | Creation validation and owner-authorized term tightening |
| `IvyOptionSettlement` library | Exercise, cash settlement and residual LP claim implementation |

The hub links to two separately deployed Solidity libraries. Their addresses are embedded in hub bytecode and cannot be changed. Calls execute against hub storage under its existing authorization and reentrancy guards. The deployment journal verifies the fixed library links along with constructor bindings.

Approve the **vault address**, never the hub. A share represents one raw unit of credited collateral. Transferring shares transfers the residual pool claim; earned activation premium stays with its original holder.

## Build and verify

Use Node.js 22.13.0 or newer and the locked dependencies:

```sh
npm ci
npm run compile
npm run typecheck
npm run check:size
npm test -- --no-compile
```

Solidity 0.8.34 uses optimizer runs 200 and viaIR. The default compiler target is Osaka; deploy only to a chain supporting the emitted opcodes, including transient storage. Tests enforce the 24,576-byte deployed-code limit without unlimited-size settings. `test/17-local-rehearsal.test.ts` rehearses deployment, signed cash settlement and a pooled unanimous unwind on an ephemeral local EVM using the operator transaction builder.

## Manual operations

Read the [operator runbook](docs/operations.md) and copy the [request examples](examples/operator/). Commands simulate and print calldata by default:

```sh
npm run operator -- prepare-vault request.json
npm run operator -- inspect-bid activation.json
npm run operator -- settle settlement.json
```

`--send` explicitly submits through the configured RPC's signer. No automated market-data collection, pricing, bidding, or trading UI is included.

Cash settlement needs the finalized report for the exact expiry. If Ivy's signer becomes unavailable before publication, funds stay locked until a valid report arrives or the buyer and all current shareholders consent to an unwind. There is no timeout that erases the buyer's obligation. Premium rounding dust stays reserved permanently.

See the [operator runbook](docs/operations.md) and [public guide](docs/site/index.html).
