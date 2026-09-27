import { Contract, ContractFactory, Interface, ZeroAddress, getAddress, getCreateAddress, id, keccak256, parseUnits } from "ethers"

import { buildDeploymentPlan, currentCode, json, planHash, rpc, verifyBindings, verifyCreation } from "../deployment.ts"
import type { Artifact, Artifacts, DeploymentPlan, DeploymentStep } from "../deployment.ts"
import { RELEASE_FORMAT, releaseHash } from "../releases.ts"
import type { ReleaseBundle } from "../releases.ts"
import type { Transactions } from "./transactions.ts"

export const TOKENS = [
	{ symbol: "fUSDC", name: "Fake USD Coin", decimals: 6 },
	{ symbol: "fETH", name: "Fake Ether", decimals: 18 },
	{ symbol: "fBTC", name: "Fake Bitcoin", decimals: 8 },
] as const

export interface Config {
	chainId: string
	reportSigner: string
	bidMaster: string
	marketMaker: string
	settlementPublisher: string
	recipient: string
	exerciseWindow: string
	expiryPricePublicationWindow: string
	auctionTimeout: string
	cashSettlement: boolean
	transfersEnabled: boolean
	uri: string
	balances: Record<string, string>
}
export interface Plan {
	format: 1
	config: Config
	core: DeploymentPlan
	artifacts: Artifacts
	tokenArtifact: Artifact
	registryArtifact: Artifact
	steps: DeploymentStep[]
	addresses: Record<string, string>
}

export function validateConfig(config: Config) {
	if (!/^[1-9]\d*$/.test(config.chainId)) throw new Error("Invalid chainId")
	for (const key of ["reportSigner", "bidMaster", "marketMaker", "settlementPublisher", "recipient"] as const) {
		if (getAddress(config[key]) === ZeroAddress) throw new Error(`Zero ${key}`)
	}
	for (const key of ["exerciseWindow", "expiryPricePublicationWindow", "auctionTimeout"] as const) {
		if (!/^\d+$/.test(config[key]) || BigInt(config[key]) === 0n || BigInt(config[key]) >= 2n ** 64n) throw new Error(`Invalid ${key}`)
	}
	if (typeof config.cashSettlement !== "boolean" || typeof config.transfersEnabled !== "boolean" || typeof config.uri !== "string")
		throw new Error("Invalid configuration")
	for (const token of TOKENS) {
		const amount = parseUnits(config.balances[token.symbol], token.decimals)
		if (amount <= 0n || amount >= 2n ** 256n) throw new Error(`Invalid ${token.symbol} balance`)
	}
}

export async function buildPlan(
	config: Config,
	artifacts: Artifacts,
	tokenArtifact: Artifact,
	registryArtifact: Artifact,
	deployer: string,
	startNonce: number,
	genesisHash: string,
): Promise<Plan> {
	validateConfig(config)
	const core = await buildDeploymentPlan({
		...config,
		artifacts,
		deployer,
		startNonce,
		genesisHash,
		admin: deployer,
		settlementMethodology: config.cashSettlement ? "Manual test publisher; fake tokens only" : undefined,
	})
	const steps = [...core.steps]
	const addresses = { ...core.addresses }
	for (const [name, artifact, args] of [
		["IvyVaultsRegistry", registryArtifact, [deployer]],
		...TOKENS.map(t => [t.symbol, tokenArtifact, [t.name, t.symbol, t.decimals]]),
	] as [string, Artifact, unknown[]][]) {
		const nonce = startNonce + steps.length
		const address = getCreateAddress({ from: deployer, nonce })
		const data = (await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args)).data
		const deployedSize = (artifact.deployedBytecode.length - 2) / 2
		if (deployedSize > 24576) throw new Error(`${name} exceeds EIP-170`)
		steps.push({ name, nonce, address, data, deployedSize, abi: artifact.abi, libraryLinks: [] })
		addresses[name] = address
	}
	return { format: 1, config, core, artifacts, tokenArtifact, registryArtifact, steps, addresses }
}

export async function validatePlan(plan: Plan) {
	if (plan.format !== 1) throw new Error("Unsupported Test environment plan format")
	const rebuilt = await buildPlan(
		plan.config,
		plan.artifacts,
		plan.tokenArtifact,
		plan.registryArtifact,
		plan.core.deployer,
		plan.core.startNonce,
		plan.core.genesisHash!,
	)
	if (json(plan) !== json(rebuilt)) throw new Error("Plan does not match preserved artifacts and settings")
}

export async function executePlan(plan: Plan, runner: Transactions, saveRelease: (bundle: ReleaseBundle) => Promise<void>) {
	await validatePlan(plan)
	await runner.checkIdentity(plan)
	const provider = rpc(runner.signer.provider)
	const journal: ReleaseBundle["journal"] = { planHash: planHash(plan.core), steps: {}, complete: true }
	for (const step of plan.steps) {
		const receipt = await runner.run(`deploy:${step.name}`, { data: step.data, nonce: step.nonce })
		const runtimeHash = await verifyCreation(provider, plan.core, step, receipt.hash)
		if (plan.core.steps.some(s => s.name === step.name)) journal.steps![step.name] = { hash: receipt.hash, runtimeHash }
	}
	await verifyBindings(provider, plan.core)
	const bundle: ReleaseBundle = { format: 1, interfaceFormat: RELEASE_FORMAT, manifest: plan.core, journal, artifacts: plan.artifacts }
	await saveRelease(bundle)
	const hub = new Contract(plan.addresses.IvyVaultsHub, plan.artifacts.IvyVaultsHub.abi, provider)
	for (const [role, account] of [
		["BID_MASTER_ROLE", plan.config.bidMaster],
		["MARKET_MAKER_ROLE", plan.config.marketMaker],
		...(plan.config.cashSettlement ? [["SETTLEMENT_PRICE_PUBLISHER_ROLE", plan.config.settlementPublisher]] : []),
	]) {
		await runner.run(`role:${role}`, { to: plan.addresses.IvyVaultsHub, data: hub.interface.encodeFunctionData("grantRole", [id(role), account]) })
	}
	for (const [method, enabled] of [
		["setCashSettlementEnabled", plan.config.cashSettlement],
		["setTransfersEnabled", plan.config.transfersEnabled],
	] as const) {
		await runner.run(method, { to: plan.addresses.IvyVaultsHub, data: hub.interface.encodeFunctionData(method, [enabled]) })
	}
	for (const token of TOKENS) {
		const iface = new Interface(plan.tokenArtifact.abi)
		await runner.run(`mint:${token.symbol}`, {
			to: plan.addresses[token.symbol],
			data: iface.encodeFunctionData("mint", [plan.config.recipient, parseUnits(plan.config.balances[token.symbol], token.decimals)]),
		})
	}
	const registry = new Interface(plan.registryArtifact.abi)
	await runner.run("register", {
		to: plan.addresses.IvyVaultsRegistry,
		data: registry.encodeFunctionData("registerVersion", [1, plan.addresses.IvyVaultsHub, releaseHash(bundle)]),
	})
	await runner.run("recommend", { to: plan.addresses.IvyVaultsRegistry, data: registry.encodeFunctionData("setRecommendedVersion", [1]) })
	await verifySetup(plan, provider, bundle)
	return bundle
}

export async function verifySetup(plan: Plan, provider: ReturnType<typeof rpc>, bundle: ReleaseBundle) {
	await verifyBindings(provider, plan.core)
	const hub = new Contract(plan.addresses.IvyVaultsHub, plan.artifacts.IvyVaultsHub.abi, provider)
	for (const [role, account] of [
		["BID_MASTER_ROLE", plan.config.bidMaster],
		["MARKET_MAKER_ROLE", plan.config.marketMaker],
		...(plan.config.cashSettlement ? [["SETTLEMENT_PRICE_PUBLISHER_ROLE", plan.config.settlementPublisher]] : []),
	]) {
		if (!(await hub.hasRole(id(role), account))) throw new Error(`Missing ${role}`)
	}
	if ((await hub.cashSettlementEnabled()) !== plan.config.cashSettlement || (await hub.transfersEnabled()) !== plan.config.transfersEnabled)
		throw new Error("Hub settings changed")
	for (const token of TOKENS) {
		const contract = new Contract(plan.addresses[token.symbol], plan.tokenArtifact.abi, provider)
		if ((await contract.symbol()) !== token.symbol || Number(await contract.decimals()) !== token.decimals)
			throw new Error(`Token mismatch: ${token.symbol}`)
	}
	const registry = new Contract(plan.addresses.IvyVaultsRegistry, plan.registryArtifact.abi, provider)
	if (
		getAddress(await registry.hubOf(1)) !== getAddress(plan.addresses.IvyVaultsHub) ||
		(await registry.manifestHashOf(1)) !== releaseHash(bundle) ||
		(await registry.recommendedVersion()) !== 1n
	)
		throw new Error("Registry mismatch")
	for (const step of plan.core.steps) {
		if (keccak256(await currentCode(provider, step.address)) !== bundle.journal.steps![step.name].runtimeHash)
			throw new Error(`Code changed: ${step.name}`)
	}
}
