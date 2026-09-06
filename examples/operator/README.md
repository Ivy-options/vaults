# Operator request examples

These files are templates. Replace uppercase address/timestamp/amount placeholders and the RPC URL before using them. They contain no keys. Use [the runbook](../../docs/operations.md) for actor permissions and execution order.

- `deployment.json`: read-only `prepare-deployment` input. Save its output as deployment-plan.json. It predicts eight deployments, including the two linked libraries before the hub.
- `deployment-run.json`: explicit deployment/resume input. Keep its journal between attempts.
- `vault.json`: private physical covered-call preparation, 10 WETH, 20% OTM, illustrative configurable $10,000 minimum. Token and price inputs must be reviewed for the target chain.
- `bid.json`: `typed-bid` input. Copy its complete output `value` into an activation request's `bid` and obtain the buyer signature; `activation.json` shows the envelope.
- `expiry-report.json`: `typed-report` input using an externally calculated historical price. Add `signature` to this file to relay with `publish-expiry`.
- `transaction.json`: common request envelope. Add `amount` for deposit/withdraw/exercise/claim, or run expire/claim-premium/claim-payout without it.
- `unwind-proposal.json`: owner/buyer proposal. After proposing, use the common envelope with `typed-unwind`, sign its output as buyer and collect holder `approve-unwind` transactions with the returned nonce. `unwind-execution.json` is the sponsor's execution request, after premium-token approval.

Use `node scripts/operator.mjs <command> file.json > prepared.json` when capturing JSON to disk. `npm run operator -- ...` also works interactively but adds npm's banner to stdout. No template is submitted unless the operator explicitly uses `--send`.

Set `terms.allowPartialExercise` explicitly in `vault.json`: false requires full exercise, true permits partial exercise. The choice is fixed before deposits and cannot be changed later.
