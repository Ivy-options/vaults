// Every id a reader could have bookmarked on the old site. Each must resolve to a node through IvyMap.ALIASES or be a node id.
export const REQUIRED = [
  // index.html
  "overview", "participants", "execution-permissions", "lifecycle", "admission-pause", "platform-fees", "premium-treatment",
  "outcomes", "makers", "exercise-and-expiration", "exercise-windows", "cash-settlement", "cash-availability", "expiry-price",
  "cash-exercise-windows", "cash-outcomes", "cash-missing-reports", "terms", "vault-token-choices", "partial-exercise",
  "early-exit", "unwind-recovery",
  // operations.html (map ids still shared with the timeline stations)
  "token-roles-and-collateral", "prepare-fund-and-activate",
  "reports-exercise-and-expiration", "enable-cash-after-physical-launch",
  "admission-pause-and-stalled-auctions", "premium-treatment-and-emergency-boundaries", "prepare-and-execute-a-unanimous-unwind", "worked-unwind-scenarios",
  "platform-fee-and-share-transfer-administration",
  // settlement-pricing.html
  "authoritative-cash-settlement-pricing", "physical-only-launch-and-later-cash-activation", "payment-authority-and-routing", "public-interface", "interchangeable-publishers",
  "exercise-observations", "exact-expiry-and-finality", "price-methodology-and-operational-approval", "governance-rotation-and-trust", "failure-and-incident-procedure",
  "deployment-and-tooling-notes", "what-production-still-needs",
];
