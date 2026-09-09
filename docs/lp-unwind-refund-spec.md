# LP-funded unwind refunds

## Scope and source

Implements the user's agreed cancellation/admission model and follow-up request to replace a single executing sponsor with individual LP refund contributions. Review baseline: `3fc87d60f8f4eecebf03514e0a21c4ceba8ec7b1`.

## Requirements

1. Activation premium remains immediately claimable, net of existing IVY fees. Claiming premium does not waive the current shareholder's agreed refund contribution. Existing premium and fee entitlements are not clawed back automatically.
2. A live unwind keeps the optional negotiated premium-token refund, including zero, unanimous current-shareholder consent, and the buyer's signature over the exact agreement.
3. Current shareholders fund the agreed refund proportionally to their current shares. Funding comes from individual LP wallets rather than requiring the executing wallet to fund the entire refund. The refund obligation follows current ownership, even if a previous holder claimed premium.
4. Execution requires the complete agreed buyer refund to be funded and valid current consent. It must not take funds from collateral, premium or fee reserves to fill a funding shortfall. Any permitted integer rounding and excess recovery must be explicit and tested.
5. Contributions remain attributable to their funder and recoverable when consent is revoked, the proposal is replaced or expires, exercise invalidates its snapshot, or normal settlement wins the race. No stranded contributions or duplicate withdrawal/payment.
6. Share transfers reconcile funding and invalidate affected consent safely. A previous holder's deposit must not silently become another holder's contribution or be consumed without valid consent. Token callbacks must not bypass final consent/funding validation.
7. Successful unwind preserves completed exercises, reserves the agreed refund for the buyer's existing payout claim, and keeps residual shareholder claims and unpaid premium claims usable. Recoverable contributions must stay separate from these reserves and residual assets, including overlapping token addresses.
8. Update operator commands, examples, documentation and relevant tests to explain funding, execution, recovery and rounding.
9. Keep auction cancellation, admission-only pause, Hub registry/release behavior, and existing proposer authority unchanged. Admin-proposed cancellation and execution freezes are outside scope.

## Validation and review

Use focused behavioral tests for funded unwind, incomplete funding, zero refund, claimed premium, transfers, revocation/replacement/expiry/exercise/settlement, callback behavior and token reserve overlap. Run compilation, deployed bytecode-size checks, typechecking, relevant tooling/documentation checks and the full suite. Review Standards and Spec separately and fix actionable findings before delivery.
