# Buyer-authenticated unwind proposals

## Intent and scope

Implement the fix selected in the review conversation: require the current option buyer to sign an unwind agreement before the owner or buyer installs it. The owner currently can replace a proposal and clear LP consent even when the owner holds no shares. A rejected or unauthenticated replacement must leave an existing executable agreement intact.

Work on `main`; review all changes against the pulled baseline `a0e2b48615fa0e3c3da5a602d82f458967fcd293`. This document records the conversation's accepted fix task as the review specification. Existing deployments are immutable; this change applies to newly deployed suites.

## Contract requirements

1. Every proposal, including one submitted by the buyer, requires a valid current-buyer EIP-712 signature. Keep the existing owner-or-buyer caller restriction.
2. Bind authorization to the exact candidate agreement: vault ID, actual next nonce, deadline, current exercised notional, current total share supply, refund, chain ID and Unwind verifying contract. Preserve the existing `IvyUnwind` / version `1` agreement domain and type.
3. Expose a Live-vault preview returning the exact next agreement and digest, using the same construction as submission. Reject expired candidate deadlines and zero supply. A preview is a snapshot: intervening proposal replacement or exercise makes its signature unusable.
4. Verify the signature before storing the agreement or resetting approval/funding counters. Invalid proposals must leave nonce, current agreement, approvals, approved/funded weights, obligations and contributions unchanged.
5. Accept EOA and ERC-1271 buyers. Recheck buyer signature validity at execution, retaining the existing execution-time behavior for contract wallets.
6. Reuse the accepted proposal signature for execution. Do not store the signature on-chain or introduce a second authorization type without a demonstrated need.
7. Successful replacement retains current semantics: old approvals become ineffective, funding remains tied to the old nonce and original funder, and old funding remains recoverable. Preserve existing transfer invalidation, callback defenses, rounding, reserves and post-settlement recovery.
8. Keep the existing proposal digest event. Additional event fields are optional and should only be introduced if they provide necessary operator information.

## Operator and documentation requirements

1. Add `typed-unwind-proposal` to prepare the candidate before submission, including domain, types and value. Require the buyer signature in `propose-unwind` requests.
2. Preserve `typed-unwind` for inspection of the stored agreement. The actual operational sequence must be preview, buyer sign, submit authenticated proposal, LP approvals/funding, execute with the signature, claims/recovery.
3. Update request examples, generated documentation and the local operator rehearsal. Document stale signatures, replacement authorization and immutability/ABI compatibility implications. Keep generated assets synchronized with their source.
4. Do not deploy, publish, push or update an external registry as part of implementation.

## Verification and acceptance

Tests use the public Hub, share-token, custody and operator interfaces already identified in the accepted fix task. Cover:

- A zero-share owner cannot install or replace a proposal without valid buyer authorization; failed replacement preserves all live accounting and the original remains executable.
- Empty, invalid, replayed and stale signatures, wrong buyer, vault, refund, deadline, exercised amount, supply, chain and module domain cannot install a proposal.
- Correct owner and buyer proposals succeed; unauthorized third-party callers remain rejected even with a valid signature.
- Valid replacement invalidates old consent but old deposits remain recoverable. Expiration does not remove the authorization requirement. Test deadline boundary behavior.
- Intervening exercise or proposal replacement invalidates previewed signatures. An ordinary share transfer does not change the signed aggregate supply; current-holder consent and funding still govern execution.
- ERC-1271 buyers work at proposal and execution. Revocation after proposal prevents execution without losing contribution recovery.
- Zero-refund and funded-refund happy paths, unavailable cash-price publication, share transfers, token callbacks, rounding surplus and all prior recovery scenarios remain supported.
- Operator preview/sign/submit/execute follows the same on-chain agreement and catches stale authorization through contract validation.

Run focused tests during development, TypeScript checks regularly, the full test suite at completion, documentation checks and contract bytecode-size checks. Review the committed diff separately for Standards and Spec, fix actionable findings, and repeat review until both axes have no unresolved findings. Commit changes to `main`; do not include unrelated user files.
