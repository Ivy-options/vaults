# Stakeholder feedback action plan

Updated: 2026-09-07. Implemented and reviewed. Standards and Spec review found no
actionable issues. Final validation: 185 tests passing; compilation, typecheck,
documentation checks, and bytecode-size checks passed. Hub runtime: 21,746 bytes.

## 1. Gate share transfers and transfer unclaimed premium with shares

Add a share-transfer feature flag, disabled for initial launches. Cover single,
batch, and approved-operator transfers while allowing protocol mint and burn
operations. Use one global Hub flag, controlled by DEFAULT_ADMIN_ROLE.

Confirmed ownership rule: the recipient of transferred shares receives the
corresponding portion of the sender's remaining, unclaimed premium entitlement.
Already-claimed premium stays with its claimant and cannot be claimed again.
Immediate premium claims remain enabled; the feature flag controls share
transfers, not premium claims.

For a partial transfer, move unclaimed entitlement proportionally to the shares
transferred out of the sender's pre-transfer balance. For example, a sender with
100 shares and 80 units of unclaimed premium transfers 25 shares: 20 units of
entitlement move to the recipient and 60 remain with the sender. A full transfer
moves all remaining entitlement. A sender who has claimed everything transfers
no premium entitlement. Recipient credits are additive, including when they
already hold shares or have previously claimed premium.

Replace the current activation-holder checkpoint behavior with explicit
accounting for these entitlement transfers. Do not redistribute the entire
remaining premium pool using current share balances: holders may have claimed
different amounts already. Specify rounding so a full transfer leaves no stranded
sender credit, and cover self-transfers, zero amounts, and duplicate IDs in batch
transfers. Redemption burns must preserve unpaid premium for separate claiming;
they must not discard it or redistribute it to other holders.

## 2. Add a platform fee on premium

Confirmed requirements: a portion of the MM-funded premium is collected as the
platform fee. Store one global fee rate in the Hub, used for all vaults, and
define a dedicated role authorized to set it. This is a planned contract change.

Proposed implementation:

- Expose platformFeeBps in the Hub, expressed in basis points (100 bps = 1%).
  Use PLATFORM_FEE_MANAGER_ROLE for setPlatformFeeBps, with role membership
  managed by DEFAULT_ADMIN_ROLE and initially granted to the deployment admin.
  Emit the old and new rate on updates. Start at zero and reject rates above
  10,000 bps.
- Apply the global rate once at successful activation to the total gross
  premium already calculated from the winning bid. The MM pays that gross
  premium; the fee is a deduction, not an additional MM charge. Compute
  platformFee = floor(grossPremium * platformFeeBps / 10,000) using mulDiv,
  and lpPremium = grossPremium - platformFee. Charge in the premium token.
- Record the applied rate and fee amount for each activation. Future rate
  changes apply to subsequent activations across all vaults, subject to each
  vault's creation-time cap; they do not recalculate previously allocated premium.
- Allocate only lpPremium to the LP premium pool. LPs may claim it immediately
  after activation. Segregate the platform allocation from collateral, buyer
  reserves, LP claims, and final share redemption; collect it exactly once.
- Retain the current separately funded unwind refund model. Proposed policy:
  the platform fee is earned at activation and is not automatically refunded
  on exercise, expiry, or an agreed unwind.

Implementation defaults (selected to proceed; not additional stakeholder-confirmed
requirements): treasury initially equals the deployment admin and is configurable
by DEFAULT_ADMIN_ROLE. Snapshot the treasury at activation, reserve its fee, and
allow collection to that recipient separately from LP claims. Treasury changes
affect future activations only. Reject invalid treasury addresses and ensure a
vault cannot allocate its fee to itself. minPremium remains a gross threshold.

Snapshot the current global fee rate as an immutable cap when each vault is
created. At activation, apply the latest global rate only if it does not exceed
that cap. A later fee increase above the cap blocks activation of that vault;
the rate must be reduced or a new vault created. Existing auction cancellation
and Open-phase withdrawals remain available under their existing rules. This
protects depositors against fee increases without changing already-funded
premium or silently applying different fee rates to simultaneously activated
vaults. Deployment must configure the intended fee before creating vaults.

## Implementation verification

Preserve coverage of upfront funding failure, immediate Live claims, partial
exercise, expiry finalization, separately funded unwind refunds, and absence of
double claims. Do not introduce tests requiring premium to remain locked until
settlement.
Cover premium/collateral token overlap, partial redemptions, rounding, and share
burns. Verify transfer restrictions for single/batch/operator paths, and ownership
after transfers if enabled. For platform fees, verify role authorization, rate
bounds, zero and nonzero fees, rounding, gross = fee + LP allocation, immediate
net LP claims, failed funding atomicity, rate changes across activations, reserve
isolation when tokens overlap, no duplicate collection, and unwind accounting.
Keep existing settlement tests, then run compilation,
the relevant/full test suite, type checking, bytecode size, and documentation checks.
