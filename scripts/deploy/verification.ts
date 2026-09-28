import type { VerifyContractArgs } from "@nomicfoundation/hardhat-verify/verify"

import type { Artifact } from "../deployment.ts"
import type { Plan } from "./deployment.ts"
import { TOKENS } from "./deployment.ts"
import type { State } from "./transactions.ts"

export interface VerificationTarget extends VerifyContractArgs {
	name: string
}

export function verificationTargets(plan: Plan, state: State): VerificationTarget[] {
	const a = plan.addresses
	const c = plan.core
	const args: Record<string, unknown[]> = {
		IvyVaultRules: [],
		IvyOptionSettlement: [],
		IvyVault: [],
		IvyPriceFeed: [c.reportSigner],
		IvyStandardBidRules: [a.IvyPriceFeed],
		IvyVaultsHub: [
			c.admin,
			a.IvyVault,
			a.IvyShares,
			a.IvyPremiums,
			a.IvyStandardBidRules,
			c.exerciseWindow,
			c.auctionTimeout,
			c.expiryPricePublicationWindow,
		],
		IvyShares: [a.IvyVaultsHub, a.IvyPremiums, c.uri],
		IvyPremiums: [a.IvyVaultsHub, a.IvyShares],
		IvyVaultsRegistry: [c.deployer],
	}
	for (const token of TOKENS) args[token.symbol] = [token.name, token.symbol, token.decimals]
	return plan.steps.map(step => {
		const artifact: Artifact = plan.artifacts[step.name] ?? (step.name === "IvyVaultsRegistry" ? plan.registryArtifact : plan.tokenArtifact)
		const libraries = Object.values(artifact.linkReferences ?? {}).flatMap(names => Object.keys(names))
		const source =
			step.name === "IvyVaultsRegistry"
				? "contracts/IvyVaultsRegistry.sol"
				: step.name in plan.artifacts
					? `contracts/${["IvyVaultRules", "IvyOptionSettlement"].includes(step.name) ? "libraries/" : ""}${step.name}.sol`
					: "contracts/mocks/FakeToken.sol"
		const contractName = step.name in plan.artifacts || step.name === "IvyVaultsRegistry" ? step.name : "FakeToken"
		const hash = state.entries[`deploy:${step.name}`]?.hash
		if (!hash) throw new Error(`Missing confirmed creation: ${step.name}`)
		return {
			name: step.name,
			address: step.address,
			contract: `${source}:${contractName}`,
			constructorArgs: args[step.name],
			libraries: Object.fromEntries(libraries.map(name => [name, a[name]])),
			creationTxHash: hash,
			provider: "sourcify",
		}
	})
}

export async function verifyAllContracts(
	plan: Plan,
	state: State,
	verify: (target: VerifyContractArgs) => Promise<boolean>,
	log: (message: string) => void = console.log,
) {
	const failures: string[] = []
	for (const { name, ...target } of verificationTargets(plan, state)) {
		try {
			if (!(await verify(target))) throw new Error("Verifier returned false")
			log(`verify:${name}: confirmed on Sourcify`)
		} catch (error) {
			failures.push(name)
			log(`verify:${name}: failed: ${error instanceof Error ? error.message.split("\n")[0] : "Unknown error"}`)
		}
	}
	if (failures.length) throw new Error(`Source verification incomplete for ${failures.join(", ")}; rerun deploy.ts to retry`)
}
