# Operator request examples

These files are templates. Replace uppercase address/timestamp/amount placeholders and the RPC URL before using them. They contain no keys. Use [the runbook](../../docs/operations.md) for actor permissions and execution order.

- `deployment.json`: read-only `prepare-deployment` input. Save its output as deployment-plan.json. It predicts eight deployments, including the two linked libraries before the hub and the indicative feed. The Hub itself owns the settlement registry; specify its initial settlement publisher separately from the Hub admin; settlementMethodology references the approved per-pair methodology artifact.
- `deployment-run.json`: explicit deployment/resume input. Keep its journal between attempts.
- `vault.json`: private physical covered-call preparation, 10 WETH, 20% OTM, illustrative configurable $10,000 minimum. Token and price inputs must be reviewed for the target chain.
- `bid.json`: `typed-bid` input. Copy its complete output `value` into an activation request's `bid` and obtain the buyer signature; `activation.json` shows the envelope.
- `expiry-report.json`: legacy `IvyPriceFeed` `typed-report` input. Add `signature` to relay with `publish-expiry`. These legacy reports do not authorize payments in new cash vaults.
- `settlement-exercise.json`: `publish-settlement-exercise` input targeting `hub` for a direct authorized publisher transaction. Its `validUntil` remains enforced at exercise, alongside the vault’s maximum observation age.
- `settlement-expiry.json`: `publish-settlement-expiry` input targeting `hub` for the exact expiry historical calculation. Publication is irreversible.
- `settlement-role.json`: `grant-settlement-publisher` or `revoke-settlement-publisher` input targeting the Hub, sent by its admin.
- `transaction.json`: common request envelope. Add `amount` for deposit/withdraw/exercise/claim, or run expire/claim-premium/claim-payout without it.
- `unwind-proposal.json`: owner/buyer proposal. After proposing, use the common envelope with `typed-unwind`, sign its output as buyer and collect holder `approve-unwind` transactions with the returned nonce. `unwind-execution.json` is the sponsor's execution request, after premium-token approval.

Use `node scripts/operator.mjs <command> file.json > prepared.json` when capturing JSON to disk. `npm run operator -- ...` also works interactively but adds npm's banner to stdout. No template is submitted unless the operator explicitly uses `--send`.

Set `terms.allowPartialExercise` explicitly in `vault.json`: false requires full exercise, true permits partial exercise. The choice is fixed before deposits and cannot be changed later.

For cash-enabled vaults, choose a positive `terms.maxSettlementPriceAge`, and include `settlementMethodology` in the request. The freshness limit is fixed at creation; every cash price is read from the Hub registry. `priceFeed` and `maxPriceAge` only govern optional activation checks; publishing signed spot or expiry reports there cannot resolve a missing authoritative report.

Before production cash admission, the referenced approved methodology must specify each pair's source, sampling, weighting, rounding, missing-sample/outage handling, observation validity, expiry calculation, responsible operator and evidence location. The tooling retains the reference; it does not attest or approve the source. Local synthetic observations are only test data.

The clean local rehearsal in `test/17-local-rehearsal.test.ts` deploys the Hub registry and indicative feed, publishes a synthetic exercise observation, attempts expiration with a missing report, rotates the publisher, rejects the revoked publisher, publishes a late historical expiry report, expires permissionlessly and claims the buyer payout. Run `npx hardhat test test/17-local-rehearsal.test.ts` after compilation. For an operational recovery, grant the replacement with `settlement-role.json`, revoke the old publisher, prepare and verify `settlement-expiry.json` for the original expiry, publish it, then use `transaction.json` to `expire` and `claim-payout` as the buyer. Report and role commands preflight without submission unless `--send` is supplied. Existing finalized prices remain final across rotation.

Deployment resume verifies the initial admin and publisher bindings recorded in the plan. After an intentional publisher rotation, resume against that original plan can fail its initial-role check; use the settlement role commands for recovery rather than replaying deployment. Existing hub and vault deployments are immutable; the new ABI requires a new deployment, and existing positions retain their original behavior.

Deployment manifests use version 4 and eight creation transactions. Generate a new plan for this build; do not reuse the earlier standalone-feed plan. The default publisher may be an EOA or an existing operator contract; no settlement helper is deployed.
