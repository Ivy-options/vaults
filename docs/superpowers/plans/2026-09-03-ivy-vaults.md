# Ivy Vaults implementation acceptance record

The earlier plan at this path is superseded by the stakeholder-approved immutable architecture. The [current design](../specs/2026-09-03-ivy-vaults-design.md) defines contract behaviour; the [operator runbook](../../operations.md) defines deployment and launch steps.

| Milestone | Delivered implementation | Acceptance evidence |
| --- | --- | --- |
| Fixed linked libraries | IvyVaultRules owns validation/tightening; IvyOptionSettlement owns exercise, cash settlement and residual claims; hub retains guarded entrypoints | Same lifecycle and callback suite; direct-call and link/runtime-tampering tests |
| Custody/module separation | Token-keyed clone reserves, independent premium cap, fixed premium/unwind modules, no UUPS or wiring setters | Contract size check; immutable binding and payment-authority tests |
| Activation income and shares | Lazy activation checkpoints, guarded immediate claims, permanent dust, duplicate/self/zero batch handling | Premium tests; token callback and transfer/burn tests |
| Terms and lifecycle | Exact expiry, auction identifiers, collateral/pair commitments, snapshots, admission pause, delegated funding/recipient | Bid, auction, timing, pause and exercise suites |
| Fixed expiry pricing | Immutable EOA/ERC-1271 feed, fresh spot and write-once historical reports, no fallback | Report signature, time and replay tests; real-feed local rehearsal |
| Unanimous unwind | Current nonce, explicit balance-weighted votes, transfer invalidation, sponsor refund, pull buyer claim | Replacement/revocation/state-race and callback tests; pooled-put rehearsal |
| Launch operations | Predicted constructor sequence, journal recovery, preflight/calldata commands, external typed-data signing | Interrupted deployment/nonce drift tests and operator lifecycle rehearsal |
| Accounting | Reserve segregation during claims and callbacks across call/put and cash/physical paths | Four deterministic stateful transfer/claim lifecycles, independent payment-cap tests |
| Documentation | Current README, design, public guide, manual runbook and JSON examples | Independent documentation review and source/link checks |

Run the acceptance commands from the repository root:

```sh
npm run compile
npm run typecheck
npm run check:size
npm test -- --no-compile
```

The optimizer remains enabled with 200 runs and viaIR. No unlimited-size network setting is used. Size is checked from the compiled production artifacts and again by the deployment planner. Tests use an ephemeral local EVM; no live deployment or transaction is part of this implementation.

Residual operating constraints are intentional: cash vaults depend on a signed expiry report or unanimous unwind, finalized prices cannot be corrected, premium dust has no sweep, and outgoing/rebasing token behaviour must match reviewed asset assumptions. On-chain averaging, market data gathering, pricing, automated bidding, trading UI and external execution adapters remain outside scope.

Local acceptance on 2026-09-05: compilation, TypeScript and all 156 tests passed, including the operator rehearsal, accounting lifecycles and cross-contract callback regressions. Independent contract review confirmed the refund-callback correction and found no extraction regression in the linked library paths; independent documentation review found no remaining material issue after corrections. The public guide was checked in a browser.

| Production contract or library | Deployed bytes | EIP-170 headroom |
| --- | ---: | ---: |
| IvyVaultRules | 1,979 | 22,597 |
| IvyOptionSettlement | 3,457 | 21,119 |
| IvyVault | 2,816 | 21,760 |
| IvyVaultsHub | 21,346 | 3,230 |
| IvyShares | 6,212 | 18,364 |
| IvyPremiums | 2,160 | 22,416 |
| IvyUnwind | 4,125 | 20,451 |
| IvyPriceFeed | 3,468 | 21,108 |

Extracting the two linked libraries reduces the hub from 24,363 to 21,346 bytes, saving 3,017 bytes and leaving 3,230 bytes below EIP-170. Every `npm run compile` runs the size gate for all eight deployment artifacts through `postcompile`. The deployment planner links libraries from compiler references and records their runtime offsets for verification.
