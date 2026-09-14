# Ivy Vaults

**License: Business Source License 1.1 (BUSL-1.1).** Copying, modification,
redistribution, and non-production use are permitted under the [license](LICENSE.md).
Production use requires a separate commercial license until the change to
GPL-2.0-or-later on September 14, 2030, or the fourth anniversary of this version's
first public distribution under BUSL-1.1, whichever comes first. No Additional Use
Grant is provided. Third-party material retains its own licenses.

Single-use covered-call and cash-secured-put vaults with optional pooling and gated ERC-1155 share transfers. An off-chain auction selects a signed buyer bid; activation collects the premium atomically. LPs can claim their net premium immediately, and current shareholders claim the remaining pool after settlement or a unanimous unwind.

The deployment is immutable. There is no hub proxy, upgrade entrypoint, implementation setter, or module rewiring. This build creates a fresh deployment; it cannot upgrade an older hub.

`IvyVaultsRegistry` provides a permanent discovery address for multiple immutable releases. Its administrator can add a release and recommend it for new vaults; registered Hub addresses and manifest hashes cannot be replaced or removed. Transactions continue to target the selected Hub directly. Older vaults keep their original Hub, modules and claim paths. See [release operations and frontend integration](docs/version-registry.md).

| Contract                      | Responsibility                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `IvyVaultsHub`                | Lifecycle, bids, delegation, guarded entrypoints and role-authorized settlement prices |
| `IvyVault`                    | Clone custody, token reserves, separate premium and buyer payment budgets       |
| `IvyShares`                   | ERC-1155 shares and pre-update module notifications                             |
| `IvyPremiums`                 | Activation entitlements and restricted premium payments                         |
| `IvyUnwind`                   | One active agreement and current-shareholder consent                            |
| `IvyPriceFeed`                | Signed spot prices for optional activation checks                               |
| `IvyVaultRules` library       | Creation validation and owner-authorized term tightening                        |
| `IvyOptionSettlement` library | Exercise, cash settlement and residual LP claim implementation                  |
| `IvyVaultsRegistry`           | Separately deployed release directory with permanent registrations and an admin-selected recommendation |

The hub links to two separately deployed Solidity libraries. Their addresses are embedded in hub bytecode and cannot be changed. Calls execute against hub storage under its existing authorization and reentrancy guards. The deployment journal verifies the fixed library links along with constructor bindings.

Approve the **vault address**, never the hub. A share represents one raw unit of credited collateral. Share transfers are disabled by default; the Hub admin can enable them globally. Transfers move the residual pool claim and a proportional portion of the sender’s unclaimed premium. Claimed premium never moves; burning shares preserves unpaid credit.

The Hub’s global `platformFeeBps` starts at zero and is managed by `PLATFORM_FEE_MANAGER_ROLE`. Activation deducts this fee from gross MM premium; LPs immediately claim the net amount. Each vault freezes the current rate as its maximum at creation, rejecting activation above that cap. Fees are reserved separately and anyone can call the vault’s `claimPlatformFee()` to pay its activation-snapshotted treasury. Treasury defaults to the admin and future recipients are admin-configurable. Fees are not refunded on settlement or unwind. Agreed unwind refunds are separately funded by each current LP in proportion to shares, even after premium has been claimed; unsuccessful contributions and rounding surplus remain recoverable by their funders.

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

Solidity 0.8.34 uses optimizer runs 200 and viaIR. The default compiler target is Osaka; deploy only to a chain supporting the emitted opcodes, including transient storage. Tests enforce the 24,576-byte deployed-code limit without unlimited-size settings. `test/17-local-rehearsal.test.ts` rehearses physical-only deployment and delivery, explicit cash enablement and settlement, and a pooled unanimous unwind on an ephemeral local EVM using the operator transaction builder.

## Manual operations

Read the [operator runbook](docs/operations.md) and copy the [request examples](examples/operator/). Commands simulate and print calldata by default:

```sh
npm run operator -- prepare-vault request.json
npm run operator -- inspect-bid activation.json
npm run operator -- expire expiration.json
```

`--send` explicitly submits through the configured RPC's signer. No automated market-data collection, pricing, bidding, or trading UI is included.

The Hub deploys for physical delivery with no settlement publisher and `cashSettlementEnabled` false. To enable future cash positions, the admin grants a responsible EOA or helper the publisher role, then explicitly calls `setCashSettlementEnabled(true)`. Role changes do not toggle the flag. While the flag is false, Cash/Either vault creation and cash bid activation revert; physical vaults remain usable and cannot be converted to cash later. The CLI checks a nominated publisher before preparing enablement; the contract flag setter leaves publication coverage to the admin.

Each cash vault needs its own price-setting transactions. The Hub stores exercise observations and a write-once final price by `vaultId`, deriving the selected pair and expiry from the live cash position. Even matching vaults have independent prices. Cash vaults fix `maxSettlementPriceAge` at creation. Disabling the flag stops new cash positions while publication, exercise, expiration, claims and agreed unwind for existing positions remain available. Revocation prevents that publisher's future reports without erasing stored prices. Missing reports keep funds locked until an authorized publisher supplies that vault's price or the parties agree to an unwind. Premium rounding dust stays reserved permanently.

See the [operator runbook](docs/operations.md) and [public guide](docs/site/index.html).

## Documentation

Open [the protocol guide](docs/site/index.html) directly in a browser, or serve the repository root with `python3 -m http.server 8000` and visit `/docs/site/`. The operator runbook, specifications, release guide and request examples have linked HTML pages. The site includes local downloads for request templates and referenced Solidity examples, so `docs/site/` can also be served on its own.

The guide uses local fonts and assets in `docs/site/assets/`. After editing a reference document or request template, run `npm run docs:build` to regenerate its HTML page or local download. Run `npm run docs:check` to verify generated pages, HTML-only document links, cross-page anchors, assets and calculator examples.

`exercise(vaultId, amount)` uses the buyer’s option right and pays the configured recipient. `expire(vaultId)` permissionlessly processes expiration and unlocks residual assets; cash expiration reserves the remaining payout for `claimPayout`. Cash exercise at/after expiry, including European exercise, uses the finalized expiry price. American cash early exercise uses a fresh, unexpired observation stored in the Hub. Indicative prices never authorize cash payouts. Physical exercise exchanges assets at strike within its exercise window.

Every vault fixes `allowPartialExercise` at creation, before deposits. True permits any valid positive amount up to remaining notional; false requires all remaining notional. The term cannot be tightened or changed later. Operator creation requests must specify it explicitly. Full exercise finalizes automatically; partial exercise leaves the remainder open.

See the [accepted pricing specification](docs/settlement-pricing-spec.md) for publisher governance, observation validity, finality and production methodology requirements. Per-vault publication/read APIs and storage require a fresh immutable deployment. Existing vaults retain their original behavior; the constructor still takes no settlement publisher.

An EOA with `SETTLEMENT_PRICE_PUBLISHER_ROLE` can publish directly to the Hub. No standalone settlement-price contract is deployed or configured. An optional helper may hold the same role and submit reports; the Hub never reads prices back from that helper.
