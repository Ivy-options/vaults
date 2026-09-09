# Operator request examples

These files are templates. Replace uppercase address/timestamp/amount placeholders and the RPC URL before using them. They contain no keys. Use [the runbook](../../docs/operations.md) for actor permissions and execution order.

- `deployment.json`: read-only `prepare-deployment` input. Save its output as deployment-plan.json. It predicts eight deployments, including the two linked libraries before the hub and the indicative feed. Deployment starts physical-only with cashSettlementEnabled false and no settlement publishers. No publisher or settlement methodology is required to deploy; an optional settlementMethodology metadata reference may be saved in the plan.
- `deployment-run.json`: explicit deployment/resume input. Keep its journal between attempts.
- `vault.json`: private physical covered-call preparation, 10 WETH, 20% OTM, illustrative configurable $10,000 minimum. Token and price inputs must be reviewed for the target chain.
- `cash-vault.json`: optional cash covered-call preparation after explicit publisher grant and feature activation; includes the required methodology reference and positive observation age.
- `bid.json`: `typed-bid` input. Copy its complete output `value` into an activation request's `bid` and obtain the buyer signature; `activation.json` shows the envelope.
- `expiry-report.json`: legacy `IvyPriceFeed` `typed-report` input. Add `signature` to relay with `publish-expiry`. These legacy reports do not authorize payments in new cash vaults.
- `settlement-exercise.json`: `publish-settlement-exercise` input targeting `hub` for a direct authorized publisher transaction. Its `validUntil` remains enforced at exercise, alongside the vault’s maximum observation age.
- `settlement-expiry.json`: `publish-settlement-expiry` input targeting `hub` for the exact expiry historical calculation. Publication is irreversible.
- `settlement-role.json`: `grant-settlement-publisher` or `revoke-settlement-publisher` input targeting the Hub, sent by its admin. Role changes affect who may publish; they never toggle cash availability.
- `cash-feature.json`: `set-cash-settlement-enabled` input. To enable, nominate an already-authorized publisher for CLI preflight; the Hub transaction contains only the boolean. To disable during an outage, set `enabled: false`; no publisher is required.
- `transaction.json`: common request envelope. Add `amount` for deposit/withdraw/exercise/claim, or run expire/claim-premium/claim-payout without it.
- `unwind-proposal.json`: owner/buyer proposal. After proposing, use the common envelope with `typed-unwind`, sign its output as buyer and collect holder `approve-unwind` transactions with the returned nonce. `unwind-execution.json` is the sponsor's execution request, after premium-token approval.

Use `node scripts/operator.mjs <command> file.json > prepared.json` when capturing JSON to disk. `npm run operator -- ...` also works interactively but adds npm's banner to stdout. No template is submitted unless the operator explicitly uses `--send`.

Set `terms.allowPartialExercise` explicitly in `vault.json`: false requires full exercise, true permits partial exercise. The choice is fixed before deposits and cannot be changed later.

To opt into cash, first have the Hub admin prepare and submit `grant-settlement-publisher` with `settlement-role.json`, naming an EOA or an existing authenticated helper. Next prepare and submit `set-cash-settlement-enabled` with `cash-feature.json`. The CLI verifies the nominated publisher holds the role before preparing enablement; this nomination is not a persistent Hub binding. Verify `cashSettlementEnabled()` is true, then use `cash-vault.json`. No deployment step grants the role automatically.

For cash-enabled vaults, choose a positive `terms.maxSettlementPriceAge`, and include `settlementMethodology` in the request. The freshness limit is fixed at creation; every cash price is read from the Hub registry. `priceFeed` and `maxPriceAge` only govern optional activation checks; publishing signed spot or expiry reports there cannot resolve a missing authoritative report.

Before production cash admission, the referenced approved methodology must specify each pair's source, sampling, weighting, rounding, missing-sample/outage handling, observation validity, expiry calculation, responsible operator and evidence location. The tooling retains the reference; it does not attest or approve the source. Local synthetic observations are only test data.

The clean local rehearsal in `test/17-local-rehearsal.test.ts` deploys with no publisher, completes a physical exercise and LP claims, explicitly grants a publisher and enables cash, then publishes a synthetic exercise observation, attempts expiration with a missing report, rotates the publisher, rejects the revoked publisher, publishes a late historical expiry report, expires permissionlessly and claims the buyer payout. Run `npx hardhat test test/17-local-rehearsal.test.ts` after compilation. For an operational recovery, grant the replacement with `settlement-role.json`, revoke the old publisher, prepare and verify `settlement-expiry.json` for the original expiry, publish it, then use `transaction.json` to `expire` and `claim-payout` as the buyer. Report and role commands preflight without submission unless `--send` is supplied. Each publication targets one Live cash vault by top-level `vaultId`; the Hub derives its pair and expiry from the activated terms. Publish separately for every vault, including vaults sharing a pair and expiry. Existing finalized prices remain final across rotation.

Deployment resume verifies immutable peers, library links and the Hub admin. Later publisher activation or rotation does not invalidate deployment verification. Use role commands to manage publishers; replaying deployment does not enable cash. Existing hub and vault deployments are immutable; the new ABI requires a new deployment, and existing positions retain their original behavior.

Deployment manifests use version 6 and eight creation transactions. Generate a new plan for this build; do not reuse the earlier standalone-feed plan. There is no default publisher and no settlement helper is deployed. The default `vault.json` is physical-only and requires no settlement methodology.

Disabling the cash feature stops new Cash/Either vault creation and cash bid activation. Existing cash options retain publication, exercise, expiration, unwind and claim rights under normal rules. Removing every publisher does not toggle the flag, but missing reports still require publisher recovery or the existing unanimous unwind. Physical vaults remain available.
