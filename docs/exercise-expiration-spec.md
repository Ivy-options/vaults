# Exercise and expiration terms

Source: the user's approved design in this task. Implement on `develop`, based on `main`, retaining the pre-existing documentation changes.

## Public actions

- New Hubs launch with physical delivery only. The admin arranges a publisher and explicitly enables the cash feature flag. Role changes never toggle it automatically. Disabling the flag stops new cash admissions but preserves publication, exercise, expiration and claims for existing cash positions. Every cash vault needs its own exercise/expiry price transactions. See [cash availability](settlement-pricing-spec.md#physical-only-launch-and-later-cash-activation).
- `exercise(vaultId, amount)` uses the buyer's option right and executes the physical exchange or cash payout within the allowed period and the vault's partial-exercise policy.
- Replace the public `settle(vaultId)` action with `expire(vaultId)`. Expiration processes the entire remaining position after its deadline and makes residual assets claimable. Cash expiration first preserves any buyer payout owed using the finalized price for the exact expiry. It must not depend on buyer participation or successful buyer transfers.
- Physical American exercise remains available before expiry and through the configured grace window; physical European exercise is available from expiry until the end of that window. Physical expiration is available at expiry plus the exercise window.
- American cash early exercise uses a fresh, unexpired observation stored in the Hub before expiry, as specified in [settlement-pricing-spec.md](settlement-pricing-spec.md). At or after expiry, cash exercise uses the finalized expiry price, including for European cash options. Cash expiration is available at or after expiry. Finalized expiry reports remain required; current spot must not replace them.
- Exercise remains restricted to the buyer or their executor, with the configured recipient. Expiration remains permissionless.
- Full exercise finalizes the vault; partial exercise leaves the unexercised remainder open. Expiration finalizes the remaining position. Exercise and expiration must not pay or reserve the same notional twice.
- Being out of the money before the deadline does not permit premature expiration. Physical exercise continues to exchange assets at strike without introducing an oracle requirement. Cash exercise with no intrinsic payout may continue to reject; expiration handles the no-payout terminal outcome.

## Partial exercise

- Add an explicit vault-level term selecting whether partial exercise is allowed. Set it at vault creation, before deposits, and keep it immutable, including through any terms-tightening path.
- When allowed, exercise accepts any otherwise valid positive amount up to remaining notional.
- When disallowed, exercise must consume all remaining notional in one call.
- Apply the policy to every manual exercise path, regardless of exercise style or settlement type. Permissionless expiration always resolves the full remaining position.
- Make the term visible to depositors and bidding buyers through terms, docs, examples, and operator inputs as applicable.

## Integration and verification

- Update contracts, interfaces, operator tooling, examples, tests, README, and docs consistently. Retain settlement terminology for physical/cash payment methods and price-feed concepts.
- Preserve the existing changes in `docs/site` and `scripts/check-docs.mjs` while correcting and extending their explanations.
- Cover permissions, exact time boundaries, cash expiry pricing, payout preservation, no double payment, both partial-policy modes, immutable policy, and the absence of the old public settle action with meaningful tests.
- Run compilation and contract-size checks, typechecking, focused tests during implementation, and the full suite at completion, plus docs checks.
- Have blockTL coordinate Standards and Spec reviews against main, route findings to blockDev1, and repeat until no actionable findings remain. Commit the work on develop.
