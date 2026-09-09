# Stakeholder feedback: developer task plan

Date: 2026-09-08. Implementation authorized 2026-09-09. The accepted pricing decisions are recorded in [settlement-pricing-spec.md](settlement-pricing-spec.md).

Scope: feedback points 1, 2, 4, 5 and 6. Point 3 (`marketMaker` naming) is explicitly excluded. Point 7 was blank. This plan records responsibilities and acceptance criteria; the linked pricing specification governs the subsequent contract changes.

## Per-vault prices and explicit cash flag — 2026-09-09

The user requested a separate price-setting transaction for every vault and an explicit cash feature flag instead of tracking publisher membership counts. Review this revision from `faef1c4`. The current policy is [settlement-pricing-spec.md](settlement-pricing-spec.md).

Acceptance criteria:

- Store exercise and final expiry prices by vault ID; matching pairs/expiries have independent reports and may receive different prices.
- Publication targets an existing Live cash vault and derives its pair/expiry from the activated position. Preserve role authorization, observation freshness, write-once finality and locked missing-report obligations.
- Keep cash disabled at deployment and introduce an admin-controlled boolean setter/event. Remove the count and automatic grant/revoke/renounce effects on availability.
- Operators grant a responsible publisher before explicitly enabling cash. The CLI checks a nominated publisher during enable preparation; the on-chain flag remains independent of role membership. Disabling needs no publisher.
- Gate new Cash/Either creation and cash activation using the flag; preserve publication and all existing settlement/claim/unwind paths while disabled.
- Update helper interfaces, operator report inputs/previews, manifest version 6, examples and docs. Test per-vault isolation, role/flag independence and recovery; review and fix feedback before final validation.

Completed in `a9ffd7a`. Matching cash vaults now receive separate exercise and final-price transactions. The admin explicitly controls cash admissions through a boolean flag; role changes do not toggle it, and the member counter is removed. Existing positions can publish and settle while cash admissions are disabled.

Validation: all 209 tests passed, together with compilation, type checking, deployed-size and documentation checks. The Hub is 23,126 bytes, below the 24,576-byte limit. Independent Standards and Spec reviewers each returned zero actionable findings and were satisfied; no further code-fix round was needed. The changed price storage and publication/read/helper APIs require a fresh immutable deployment.

## Earlier physical-only deployment revision — 2026-09-09

The user confirmed that the first launch uses physical delivery, with cash support retained for later use. This revision removes the constructor obligation introduced by the Hub-owned pricing implementation. Review this revision from `94aee27`; the accepted policy is recorded in [settlement-pricing-spec.md](settlement-pricing-spec.md#physical-only-launch-and-later-cash-activation).

Acceptance criteria:

- Deploy with no publisher constructor input, no publisher membership and cash disabled; physical operation requires no settlement methodology.
- Derive cash availability from actual publisher-role membership. Count grants, revocations and renunciations correctly; reject the zero address and avoid duplicate or unrelated-role count changes.
- Block Cash/Either creation and cash bid activation at zero publishers. Preserve physical activation and fixed physical-only terms.
- Granting an EOA or optional helper the role enables new cash positions; removing the last member disables new cash positions while preserving existing reports, payments, reserves and recovery rights.
- Update deployment plans to version 5, default examples to physical delivery and the runbook to explicit later cash activation. Preserve interrupted-deployment verification and require methodology only for cash operations.
- Test through existing public Hub/vault/helper and operator seams, review Standards and Spec independently, fix actionable feedback, then run compilation, typecheck, full regression tests, size and docs checks.

Completed in `b4d059a`. Deployment starts with zero publishers; first-member grants and last-member removals control new cash admissions while existing positions retain their rights. The updated operator rehearsal completes physical delivery before explicitly enabling cash.

Validation: all 207 tests passed, together with compilation, type checking, deployed-size and documentation checks. The Hub is 23,131 bytes, below the 24,576-byte limit. The launch guide was visually checked. Independent Standards and Spec reviewers each returned zero actionable findings and were satisfied; no further code-fix round was needed. This constructor ABI change requires a fresh deployment.

## Earlier Hub-owned pricing revision — 2026-09-09

The user subsequently replaced the standalone settlement-feed design with Hub-owned storage and publication authority. This revision supersedes the earlier architecture while retaining its price-validation, finality and accounting policies. The current source of truth is [settlement-pricing-spec.md](settlement-pricing-spec.md).

Revision acceptance criteria:

- An EOA with the Hub publisher role can publish and complete cash exercise/expiration without any settlement feed or helper contract.
- An optional access-controlled helper can hold the same role and publish through the Hub’s write-side interface. The Hub never reads prices from it.
- Remove the standalone settlement feed, its read interface, its deployment, separate settlement administrator and per-vault source address. Retain immutable cash observation age.
- Preserve exact pair/expiry finality, early-exercise freshness/validity, publisher rotation, locked obligations, premium/fee isolation and indicative-price independence.
- Update deployment/tooling/examples/docs and review the diff from `f369556`; verify EOA/helper authorization, regressions and deployed Hub size.

Revision completed in `214b23a`. The Hub owns publisher roles and prices; settlement reads its storage directly. An authorized EOA can publish without a settlement contract, and the optional authenticated helper uses the same role. Default deployment now contains eight contracts and uses manifest version 4.

Validation: all 197 tests passed, including EOA/helper authorization, exact-expiry routing, shared Hub prices and operator recovery. Compilation, type checking, documentation checks and deployed-size checks passed; the Hub is 22,842 bytes against the 24,576-byte limit. Independent Standards and Spec reviewers each returned zero findings and were satisfied with the candidate. The constructor and vault-term ABI changes require a fresh deployment.

## Earlier completion record — 2026-09-09

Tasks 1–7 are implemented, with point 3’s naming change excluded as requested. The implementation retains admission-only pause and separately funded unwind refunds. The accepted pricing specification covers the decisions required by Task 3; new contracts, tooling and examples implement Tasks 4 and 5.

Validation: 192 tests passed, along with compilation, type checking, deployed-size and documentation checks. Independent Standards and Spec reviews each returned zero findings. The updated pricing, vault-term and fee sections were visually checked. The implementation requires a fresh deployment; production operator identities and per-pair market-data methodology remain deployment prerequisites.

## Baseline before this work

- Unwind and platform fees already exist in contracts and `docs/operations.md`. The website has an early-exit explanation and brief fee coverage. Improve visibility and completeness rather than reimplementing those features.
- Premium is collected at activation, net of the platform fee. LP premium can be claimed immediately. An unwind refund is separately funded by its executing sponsor; earned premium and fees are not clawed back.
- Pause is admission-only. Existing exercise, expiration, claims and agreed unwind remain available, and deadlines do not move.
- `IvyPriceFeed` has separate spot and finalized expiry reports, but both use one immutable signer. American cash exercise before expiry uses spot, so spot currently also controls payments.
- Underlying, quote and premium are token roles. Collateral is the backing token: underlying for calls, quote for puts. Token roles may share an address.

## Task 1 — Make unwind discoverable and explain the lifecycle

Owner: documentation/frontend developer. Dependency: none; coordinate policy wording with Task 2.

Files: `docs/site/index.html`, `docs/operations.md`, `README.md`, and relevant examples under `examples/operator/`.

Work:

- Add an explicit navigation entry and a lifecycle link to unwind.
- Explain Live-only proposals by owner or buyer, unanimous current-shareholder approvals, buyer signature, deadline, nonce and separately funded refund.
- Explain revocation, replacement, transfer-driven vote invalidation and the need for a fresh agreement after exercise changes the snapshot.
- Show execution followed by separate buyer-refund, residual-pool and unpaid-premium claims. Distinguish an agreed close from pre-activation auction cancellation.

Acceptance criteria:

- A reader can find unwind directly from navigation and follow proposal through claims without reading Solidity.
- Include zero-refund and funded-refund examples, plus an expired/replaced proposal example.
- State that proposals do not halt exercise or expiration, and unwind does not undo completed exercises.
- Commands and claims match `IvyVaultsSettlement.sol` and `IvyUnwind.sol`.

## Task 2 — Specify premium treatment and pause boundaries

Owner: protocol/product lead for policy; documentation developer for publication. Dependency: none for documenting current behavior.

Files: `docs/operations.md`, `docs/site/index.html`; use `contracts/IvyPremiums.sol`, `contracts/hub/IvyVaultsSettlement.sol` and `contracts/IvyVault.sol` as implementation references.

Work:

- Publish a treatment table covering auction cancellation before activation, expired/revoked unwind consent, executed unwind, admission pause and normal exercise/expiration.
- State who retains earned premium, who funds a negotiated refund, the refund token and how the buyer claims it.
- Explain why immediate premium claims mean an automatic refund cannot assume the original premium remains available.
- Record the recommended policy: retain activation-earned premium and fees; negotiate and separately fund unwind refunds.
- Ask the protocol lead to resolve whether “emergency pause” means existing admission pause or a new full execution freeze. Do not implement a full freeze implicitly.

Acceptance criteria:

- Pre-activation cancellation has no collected premium to refund; proposal expiry/revocation does not alter premium entitlements.
- Admission pause leaves earned premium, claims and deadlines unchanged.
- Any proposed full freeze is a separate specification addressing permissions, affected actions, deadlines, resumption and outstanding payment obligations.
- Any changed refund policy explicitly specifies funding/escrow and fee treatment before contract work starts.

## Task 3 — Decide authoritative cash-pricing policy (feedback point 4)

Owner: protocol technical lead with product/operations. Dependency: none. This is the prerequisite for Tasks 4 and 5.

Deliverable: a reviewed pricing specification recording decisions, trust assumptions and failure behavior.

Decisions to resolve:

- Separate indicative/activation pricing from prices that authorize cash payments. Identify all affected paths, including American exercise before expiry.
- Choose direct role-authorized publication or signed reports from an authorized role with permissionless relaying. Define role administrator, grant/revoke/rotation, and whether authority is fixed per vault or shared and mutable.
- Define the responsible settlement operator, preferably a multisig, and whether one publisher or a threshold is required.
- Specify price units, approved data sources, observation window and calculation procedure. Current operations describe a 30-minute expiry average computed off-chain; the contract does not verify that calculation.
- Define exact pair/time bindings and submission deadlines. Decide how late historical reports work without substituting current spot.
- For American cash exercise, choose an authoritative exercise-time report mechanism or restrict supported cash options to European exercise. Specify effects on existing product combinations.
- Define unavailable-publisher handling and recovery authority. Preserve payment obligations; missing prices must not silently erase them.
- Decide whether publication is immediately final or has a review/challenge stage. No correction may retroactively alter completed payouts.

Acceptance criteria:

- Every cash-payment path has a specified authoritative price, responsible publisher and finalization rule.
- Grant/revoke and signer rotation semantics are explicit, including outstanding signed reports and existing vaults.
- Operators have a deterministic procedure for missing, late and incorrect reports.
- The specification identifies any contract/API/deployment compatibility changes and is accepted before implementation.

## Task 4 — Implement approved settlement authority and price routing

Owner: contracts developer. Dependency: Task 3 accepted.

Likely files: `contracts/IvyPriceFeed.sol`, `contracts/interfaces/IIvyPriceFeed.sol`, `contracts/types/IvyTypes.sol`, `contracts/libraries/IvyVaultRules.sol`, `contracts/libraries/IvyOptionSettlement.sol`, and deployment/test fixtures. Final scope depends on Task 3.

Work:

- Implement the selected authorization and report-finalization model.
- Route activation checks and each cash-payment path to their specified source; do not leave American cash exercise on an indicative feed.
- Bind reports to the required pair, time and signature domain; retain replay protection and reject invalid/unavailable prices according to the approved policy.
- Preserve buyer reserves and LP premium/fee isolation through expiration and claims.
- Document migration/new-deployment requirements. Existing immutable deployments cannot be assumed to accept an in-place upgrade.

Acceptance criteria:

- Tests cover unauthorized publication, grant/revoke behavior, rotation if supported, wrong pair/time/domain, invalid prices, duplicate finalization and late/missing reports.
- Tests cover European expiry and every retained American cash exercise path, including exact expiry boundaries.
- Indicative-price updates cannot change a finalized settlement payout.
- Regression tests show no double payment, no loss of buyer obligations, and unchanged physical settlement behavior.
- Compilation, type checking, full contract tests and deployed-size checks pass.

## Task 5 — Update settlement operations and end-to-end examples

Owner: integrations/operations developer. Dependencies: Task 3; finalize against Task 4 interfaces.

Files: `scripts/operator.mjs`, `scripts/deployment.mjs`, `examples/operator/`, `docs/operations.md`, `docs/site/index.html`, and `test/17-local-rehearsal.test.ts`.

Work:

- Update deployment configuration and authority setup for the approved model.
- Update report preparation/publication commands and signature domains if needed.
- Explain which source is indicative and which source authorizes payment, with responsible operator and incident procedure.
- Add a complete local example from authority configuration to finalized report, expiration and payout claim.

Acceptance criteria:

- A clean deployment rehearsal configures authority and completes a cash payout with the new tooling.
- Unauthorized publication fails and missing-report recovery matches the approved specification.
- Examples contain no obsolete fields, role instructions or signing domains.

## Task 6 — Explain the three token roles (feedback point 5)

Owner: documentation developer. Dependency: none.

Files: `docs/site/index.html`, `docs/operations.md`, `README.md`.

Work:

- Introduce asset/underlying, quote and premium before introducing collateral as the backing role.
- Add WETH/USDC call and put examples, identifying what LPs deposit and what moves during physical exercise.
- Explain that cash payouts use collateral: underlying for calls and quote for puts. “Cash settlement” does not imply every payout is in the quote token.
- Explain overlapping token addresses and separate accounting budgets. Retain existing contract field names.

Acceptance criteria:

- The docs do not imply a fourth independent collateral token.
- Examples show call collateral equals underlying and put collateral equals quote.
- Explain that calls may offer multiple quote pairs before activation; the winning bid selects one.
- All examples use correct units and distinguish premium from collateral and settlement proceeds.

## Task 7 — Give platform fees a complete documentation section (feedback point 6)

Owner: documentation/frontend developer. Dependency: coordinate refund wording with Task 2; no new fee implementation required.

Files: `docs/site/index.html`, `docs/operations.md`, `README.md`, `docs/feedback-action-plan.md`.

Work:

- Add a discoverable fee section with the formula and a worked gross/net example.
- Explain global rate administration, zero default, creation-time cap, activation-time rate and treasury snapshot, and separate fee claiming.
- Explain that raising the global rate above a vault's cap blocks activation, rather than silently applying the cap.
- State that minPremium is gross and fees remain earned after unwind; refund funding is separate.
- Mark implemented fee work in the older action plan so it is not mistaken for an unimplemented requirement.
- Keep the calculator's zero-fee assumption explicit unless fee-aware calculation is separately requested.

Acceptance criteria:

- Example: 1,000 premium units at 200 bps gives 20 treasury units and 980 LP units.
- Explain integer rounding, fee/premium reserve separation and that anyone may trigger payment only to the snapshotted treasury.
- Website and operations guide describe the same implemented policy and link to it directly.

## Execution order and review

1. Start Tasks 1, 2, 6 and 7 as one coordinated documentation workstream to avoid conflicting edits to the same page.
2. Run Task 3 independently with the protocol lead; document unresolved decisions rather than selecting governance policy silently.
3. After Task 3 acceptance, implement Task 4 and prepare Task 5 against its agreed interfaces.
4. Have the technical lead review pricing authorization and all cash-payment paths; reconcile final docs with the resulting implementation.

Documentation validation: run `npm run docs:check`, verify new links, and visually inspect navigation, tables and worked examples. Do not add contract tests solely for prose changes.

Contract/integration validation after implementation: run `npm run compile`, `npm run typecheck`, `npm test`, and verify the deployed-size check (also run by postcompile). Extend the existing oracle, exercise, settlement, unwind, admission, fee and rehearsal suites for changed behavior rather than duplicating them.

Completion means each task's acceptance criteria are met, approved pricing decisions are reflected consistently in contracts/tooling/docs, and the excluded naming change has not been bundled into the work.
