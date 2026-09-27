import { formatEther, getAddress, keccak256, parseUnits } from "ethers"
import { artifacts as hardhatArtifacts, network } from "hardhat"
import { readFile } from "node:fs/promises"
import { resolve, join } from "node:path"

import { CONTRACTS, planHash } from "../deployment.ts"
import { buildPlan, executePlan, validatePlan } from "./deployment.ts"
import type { Config, Plan } from "./deployment.ts"
import { deploymentSigner } from "./signer.ts"
import { Transactions, atomicJson, readJson, withLock } from "./transactions.ts"
import type { State } from "./transactions.ts"

const positive = (name: string, fallback: number) => {
	const value = Number(process.env[name] || fallback)
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`)
	return value
}
export async function runDeployment(command: "plan" | "deploy" | "status" | "bump") {
	const connection = await network.create()
	const { ethers } = connection
	const provider = ethers.provider
	const directory = resolve(process.env.DEPLOY_DIR || `deployments/local/${connection.networkName}`)
	try {
		const chainId = String(BigInt(await provider.send("eth_chainId", [])))
		if (connection.networkConfig.chainId !== undefined && chainId !== String(connection.networkConfig.chainId))
			throw new Error("RPC chain ID does not match network configuration")
		if (command === "status") {
			const plan = await readJson<Plan>(join(directory, "plan.json"))
			await validatePlan(plan)
			if (plan.core.chainId !== chainId || plan.core.genesisHash !== (await provider.getBlock(0))?.hash) throw new Error("Wrong chain for saved plan")
			let state: State
			try {
				state = await readJson<State>(join(directory, "state.json"))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				state = { planHash: planHash(plan), entries: {} }
			}
			if (state.planHash !== planHash(plan)) throw new Error("State belongs to another plan")
			console.log(`Chain ${chainId}; deployer ${plan.core.deployer}; gas balance ${formatEther(await provider.getBalance(plan.core.deployer))}`)
			console.table(plan.addresses)
			for (const [name, entry] of Object.entries(state.entries)) {
				const statuses = await Promise.all(
					entry.attempts.map(async raw => {
						const hash = keccak256(raw),
							receipt = await provider.getTransactionReceipt(hash)
						return `${hash}: ${receipt ? (receipt.status === 1 ? `mined (${await receipt.confirmations()} confirmations)` : "REVERTED") : "pending or dropped"}`
					}),
				)
				console.log(name, statuses.join("\n  "))
			}
			return
		}
		const signer = await deploymentSigner(connection)
		await withLock(directory, async () => {
			const planPath = join(directory, "plan.json"),
				statePath = join(directory, "state.json")
			let exists = true
			try {
				await readFile(planPath)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				exists = false
			}
			if (command === "plan" || (command === "deploy" && !exists)) {
				try {
					await readFile(planPath)
					throw new Error("Plan already exists; use deploy.ts or choose a new DEPLOY_DIR")
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				}
				const artifacts = Object.fromEntries(await Promise.all(CONTRACTS.map(async name => [name, await hardhatArtifacts.readArtifact(name)])))
				const token = await hardhatArtifacts.readArtifact("FakeToken")
				const registry = await hardhatArtifacts.readArtifact("IvyVaultsRegistry")
				const addr = (name: string) => getAddress(process.env[name] || signer.address)
				const bool = (name: string, fallback: boolean) => {
					const value = process.env[name]
					if (value === undefined || value === "") return fallback
					if (!["true", "false"].includes(value)) throw new Error(`${name} must be true or false`)
					return value === "true"
				}
				const config: Config = {
					chainId,
					reportSigner: addr("DEPLOY_REPORT_SIGNER"),
					bidMaster: addr("DEPLOY_BID_MASTER"),
					marketMaker: addr("DEPLOY_MARKET_MAKER"),
					settlementPublisher: addr("DEPLOY_SETTLEMENT_PUBLISHER"),
					recipient: addr("DEPLOY_TOKEN_RECIPIENT"),
					exerciseWindow: process.env.DEPLOY_EXERCISE_WINDOW || "3600",
					expiryPricePublicationWindow: process.env.DEPLOY_PUBLICATION_WINDOW || "3600",
					auctionTimeout: process.env.DEPLOY_AUCTION_TIMEOUT || "3600",
					cashSettlement: bool("DEPLOY_CASH_SETTLEMENT", true),
					transfersEnabled: bool("DEPLOY_TRANSFERS_ENABLED", true),
					uri: process.env.DEPLOY_URI || "",
					balances: {
						fUSDC: process.env.DEPLOY_FUSDC_AMOUNT || "1000000",
						fETH: process.env.DEPLOY_FETH_AMOUNT || "1000",
						fBTC: process.env.DEPLOY_FBTC_AMOUNT || "100",
					},
				}
				const startNonce = Number(BigInt(await provider.send("eth_getTransactionCount", [signer.address, "latest"])))
				if (startNonce !== Number(BigInt(await provider.send("eth_getTransactionCount", [signer.address, "pending"]))))
					throw new Error("Deployer has pending transactions")
				const plan = await buildPlan(config, artifacts, token, registry, signer.address, startNonce, (await provider.getBlock(0))!.hash!)
				await atomicJson(planPath, plan)
				console.log(`Saved plan for ${plan.steps.length} deployments and setup in ${planPath}.`)
				console.table(plan.addresses)
				console.log(`Admin and treasury: ${signer.address}; recipient: ${config.recipient}`)
				if (command === "plan") return
			}
			const plan = await readJson<Plan>(planPath)
			let state: State
			try {
				state = await readJson<State>(statePath)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
				state = { planHash: planHash(plan), entries: {} }
			}
			const runner = new Transactions(signer, plan.core, state, value => atomicJson(statePath, value), {
				confirmations: positive("DEPLOY_CONFIRMATIONS", 1),
				timeoutMs: positive("DEPLOY_TX_TIMEOUT_MS", 120_000),
				maxFeePerGas: parseUnits(process.env.DEPLOY_MAX_FEE_GWEI || "500", "gwei"),
				maxPriorityFeePerGas: parseUnits(process.env.DEPLOY_MAX_PRIORITY_FEE_GWEI || "100", "gwei"),
				bump: command === "bump",
				log: console.log,
			})
			await executePlan(plan, runner, bundle => atomicJson(join(directory, "release.json"), bundle))
			await atomicJson(join(directory, "addresses.json"), { chainId, ...plan.addresses })
			console.log(`Deployment and setup verified. Addresses: ${join(directory, "addresses.json")}`)
		})
	} catch (error) {
		// RPC errors may contain authenticated URLs or raw transactions. Print a short message only.
		console.error(
			error instanceof Error
				? ((error as Error & { shortMessage?: string }).shortMessage || error.message).split("\n")[0].replace(/https?:\/\/[^\s)]+/g, "[RPC URL]")
				: "Deployment failed",
		)
		process.exitCode = 1
	} finally {
		await connection.close()
	}
}
