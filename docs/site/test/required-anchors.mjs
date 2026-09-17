// Every id a reader could have bookmarked on the old site. Each must resolve to a node through IvyMap.ALIASES or be a node id.
export const REQUIRED = [
  // index.html
  "overview", "participants", "execution-permissions", "lifecycle", "admission-pause", "platform-fees", "premium-treatment",
  "outcomes", "makers", "exercise-and-expiration", "exercise-windows", "cash-settlement", "cash-availability", "expiry-price",
  "cash-exercise-windows", "cash-outcomes", "cash-missing-reports", "terms", "vault-token-choices", "partial-exercise", "versions",
  "early-exit", "unwind-recovery",
  // operations.html
  "manual-ivy-vault-operations", "token-roles-and-collateral", "requests-and-submission", "deploy-and-recover", "prepare-fund-and-activate",
  "reports-exercise-and-expiration", "enable-cash-after-physical-launch", "eoa-and-optional-contract-publishers", "publisher-rotation-and-incidents",
  "admission-pause-and-stalled-auctions", "premium-treatment-and-emergency-boundaries", "prepare-and-execute-a-unanimous-unwind", "worked-unwind-scenarios",
  "command-reference", "platform-fee-and-share-transfer-administration",
  // operator-examples.html, project-setup.html
  "operator-request-examples", "ivy-vaults", "read-the-guide", "build-and-verify", "solidity-style", "edit-the-docs", "license",
  // registry-specification.html
  "immutable-release-registry", "objective", "registry-contract", "deployment-and-evidence", "resolution-and-integration", "coexistence-and-lifecycle-guarantees", "validation",
  // settlement-pricing.html
  "authoritative-cash-settlement-pricing", "physical-only-launch-and-later-cash-activation", "payment-authority-and-routing", "public-interface", "interchangeable-publishers",
  "exercise-observations", "exact-expiry-and-finality", "price-methodology-and-operational-approval", "governance-rotation-and-trust", "failure-and-incident-procedure",
  "deployment-and-tooling-notes", "what-production-still-needs",
  // releases.html
  "releases-and-the-permanent-registry", "what-remains-fixed", "deploy-the-registry-once", "register-and-recommend-a-release", "prepare-transactions-for-a-selected-release",
  "frontend-integration", "finding-vault-creation-in-the-source",
];
