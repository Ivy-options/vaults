# Ivy Vaults

Single-use covered-call and cash-secured-put vaults with optional pooling and gated ERC-1155 share transfers. An off-chain auction selects a signed buyer bid; activation collects the premium atomically. LPs can claim their net premium immediately, and current shareholders claim the remaining pool after settlement or a unanimous unwind.

The deployment is immutable. There is no hub proxy, upgrade entrypoint, implementation setter, or module rewiring. This build creates a fresh deployment; it cannot upgrade an older hub.

| Contract                      | Responsibility                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `IvyVaultsHub`                | Lifecycle, bids, delegation and guarded public entrypoints                      |
| `IvyVault`                    | Clone custody, token reserves, separate premium and buyer payment budgets       |
| `IvyShares`                   | ERC-1155 shares and pre-update module notifications                             |
| `IvyPremiums`                 | Activation entitlements and restricted premium payments                         |
| `IvyUnwind`                   | One active agreement and current-shareholder consent                            |
| `IvyPriceFeed`                | Ivy-signed fresh spot and write-once expiry reports, including ERC-1271 signers |
| `IvyVaultRules` library       | Creation validation and owner-authorized term tightening                        |
| `IvyOptionSettlement` library | Exercise, cash settlement and residual LP claim implementation                  |

The hub links to two separately deployed Solidity libraries. Their addresses are embedded in hub bytecode and cannot be changed. Calls execute against hub storage under its existing authorization and reentrancy guards. The deployment journal verifies the fixed library links along with constructor bindings.

Approve the **vault address**, never the hub. A share represents one raw unit of credited collateral. Share transfers are disabled by default; the Hub admin can enable them globally. Transfers move the residual pool claim and a proportional portion of the sender’s unclaimed premium. Claimed premium never moves; burning shares preserves unpaid credit.

The Hub’s global `platformFeeBps` starts at zero and is managed by `PLATFORM_FEE_MANAGER_ROLE`. Activation deducts this fee from gross MM premium; LPs immediately claim the net amount. Each vault freezes the current rate as its maximum at creation, rejecting activation above that cap. Fees are reserved separately and anyone can call the vault’s `claimPlatformFee()` to pay its activation-snapshotted treasury. Treasury defaults to the admin and future recipients are admin-configurable. Fees are not refunded on settlement or unwind.

The three token roles are **asset/underlying, quote and premium**. Collateral is the backing token: underlying for a call, quote for a put. Cash payouts use that collateral too. See [token roles and worked examples](docs/operations.md#token-roles-and-collateral).

Follow the [unwind lifecycle and examples](docs/operations.md#prepare-and-execute-a-unanimous-unwind), [premium treatment on cancellation and pause](docs/operations.md#premium-treatment-and-emergency-boundaries), and [fee formula and administration](docs/operations.md#platform-fee-and-share-transfer-administration).

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
npm run operator -- expire expiration.json
```

`--send` explicitly submits through the configured RPC's signer. No automated market-data collection, pricing, bidding, or trading UI is included.

Cash settlement needs the finalized report for the exact expiry. If Ivy's signer becomes unavailable before publication, funds stay locked until a valid report arrives or the buyer and all current shareholders consent to an unwind. There is no timeout that erases the buyer's obligation. Premium rounding dust stays reserved permanently.

See the [operator runbook](docs/operations.md) and [public guide](docs/site/index.html).

## Documentation

Open [the protocol guide](docs/site/index.html) directly in a browser, or serve the repository root with `python3 -m http.server 8000` and visit `/docs/site/`. Serve the whole repository so the operator runbook and request-example links remain available.

The guide uses local fonts and assets in `docs/site/assets/`. After editing it, run `npm run docs:check` to check links, anchors, assets and calculator examples.

`exercise(vaultId, amount)` uses the buyer’s option right and pays the configured recipient. `expire(vaultId)` permissionlessly processes expiration and unlocks residual assets; cash expiration reserves the remaining payout for `claimPayout`. Cash exercise at/after expiry, including European exercise, uses the finalized expiry price. American cash early exercise uses fresh spot. Physical exercise exchanges assets at strike within its exercise window.

Every vault fixes `allowPartialExercise` at creation, before deposits. True permits any valid positive amount up to remaining notional; false requires all remaining notional. The term cannot be tightened or changed later. Operator creation requests must specify it explicitly. Full exercise finalizes automatically; partial exercise leaves the remainder open.
