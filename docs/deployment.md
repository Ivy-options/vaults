# Resumable deployment

The deployment scripts use the network and accounts selected by Hardhat. Configure networks in `hardhat.config.ts`, then run:

```sh
npx hardhat run scripts/deploy.ts --network polygon
```

Rerun the same command to resume. On the first run it saves a deployment plan, then deploys and configures Ivy, its release registry, and fUSDC, fETH, and fBTC. Subsequent runs recover recorded transactions and continue without repeating deployments or initial mints.

## Configuration

The config includes a `polygon` network using `POLYGON_RPC_URL` and `DEPLOYER_PRIVATE_KEY`. Set them in your environment, Hardhat keystore, or `.env`. `hardhat.config.ts` loads `.env` when present. `.env.example` lists the deployment settings; Git ignores `.env`.

For another chain, add its network entry and pass its name to `--network`. There is no chain allowlist in the scripts. The configured `chainId`, when present, must match the RPC. The compiler targets Cancun; the selected chain must support those opcodes, including the transient storage used by the contracts. The network must accept EIP-1559 transactions, and its RPC must return positive maximum and priority fee estimates.

Deployment uses the first private-key account or first mnemonic-derived account in the selected network configuration. Node-managed `accounts: "remote"` is unsupported because the runner must sign and save the raw transaction before broadcasting. Fund that account with the network's native gas token. Use a persistent HTTP network; for local tests, run a Hardhat node and configure an HTTP connection to it.

The default directory is `deployments/local/<network name>`. Set `DEPLOY_DIR` for a separate deployment on the same network. Keep one directory per deployment, and do not use the deploying account for unrelated transactions until setup completes. Core constructor addresses depend on its sequential nonces.

Defaults:

| Setting | Default |
| --- | --- |
| Admin and treasury | Deployer |
| Report signer, bid master, market maker, settlement publisher | Deployer, each overridable with `DEPLOY_*` variables |
| Initial token recipient | Deployer, overridable with `DEPLOY_TOKEN_RECIPIENT` |
| fUSDC | 6 decimals; 1,000,000 tokens |
| fETH | 18 decimals; 1,000 tokens |
| fBTC | 8 decimals; 100 tokens |
| Exercise, publication, and auction windows | 3,600 seconds each |
| Cash settlement and share transfers | Enabled |
| Confirmations | 1, configurable with `DEPLOY_CONFIRMATIONS` |

These are public faucet tokens: anyone can call `mint(address,uint256)`. They have no backing. Mint amounts in `.env` are whole-token quantities; contract calls use smallest units. Cash settlement uses the configured test publisher; the script does not deploy a live price service or create trading vaults.

Planning freezes the bytecode, constructor settings, role addresses, and initial mint quantities. Later environment changes do not alter that plan. Network credentials, confirmation count, timeout, and fee caps are read on each invocation. Existing plans use their saved artifacts even if Hardhat recompiles the project.

## Commands

```sh
# Optional: prepare and inspect a plan without sending transactions
npx hardhat run scripts/deploy-plan.ts --network polygon

# Deploy or resume the saved plan
npx hardhat run scripts/deploy.ts --network polygon

# Read recorded transaction status
npx hardhat run scripts/deploy-status.ts --network polygon

# Raise a pending transaction's fees at the same nonce, then continue
npx hardhat run scripts/deploy-bump.ts --network polygon
```

Replace `polygon` with any configured network name. Standard Hardhat options such as `--no-compile` also work. The default setup sends 12 creation transactions and 10 configuration, mint, and registration transactions.

## Recovery and outputs

Each signed transaction is flushed to `state.json` before broadcast. After an RPC outage, timeout, dropped transaction, or lost response, rerun `deploy.ts`. It checks receipts and can rebroadcast the exact saved transaction. The fee-bump script keeps all replacement hashes and raises fees by at least 25%, subject to `DEPLOY_MAX_FEE_GWEI` and `DEPLOY_MAX_PRIORITY_FEE_GWEI`. Raising those caps alone does not change an already-signed transaction.

If a process is killed and leaves `.lock`, confirm that no runner remains active, remove only that lock from the deployment directory, and rerun. Insufficient gas balance can be resolved by funding the same deployer. Nonce conflicts, mismatched identities, missing confirmed receipts, and mined reverts stop execution for inspection. A reverted creation consumes its nonce and can invalidate remaining predicted addresses; it may require a new plan in a new directory.

Keep `plan.json` and `state.json` intact and backed up. State contains signed transactions but no private key. Do not delete it to retry. The lock protects a single directory; it does not coordinate separate deployments using the same account.

After setup verification, `addresses.json` contains deployed addresses. Predicted addresses in `plan.json` are not evidence of deployment. `release.json` contains the core ABIs and deployment evidence used by the release resolver; registry release `1` is registered and recommended. Token and registry ABIs are in `plan.json`, under `tokenArtifact.abi` and `registryArtifact.abi`. The release bundle is written after core verification, before registry setup finishes.

## Verification

```sh
npm run compile
npm run typecheck
npx hardhat test --no-compile test/deployment/resumable-deployment.test.ts
```

The tests cover deployment and release verification, interrupted submissions, dropped transactions, fee replacement, persistence failures, identity and nonce checks, mined reverts, and duplicate-mint prevention. Use Node.js 22.18 or newer on an even-numbered release.
