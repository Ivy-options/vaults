import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import type {} from "chai-as-promised"
import { AbiCoder, id } from "ethers"
import { network } from "hardhat"

import {
	LIBRARIES,
	buildDeploymentPlan,
	linkBytecode,
	loadArtifacts,
	resumeDeployment,
	verifyBindings,
	type Artifacts,
	type DeploymentPlan,
	type Journal,
} from "../../scripts/deployment.ts"
import { EXERCISE_WINDOW, EXPIRY_PRICE_PUBLICATION_WINDOW, fixture, MAX_RUNTIME_SIZE, skipUnderCoverage } from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

const deployed = fixture(connection, async () => {
	const [admin] = await ethers.getSigners()
	const artifacts = await loadArtifacts()
	const plan = await buildDeploymentPlan({
		artifacts,
		chainId: (await ethers.provider.getNetwork()).chainId,
		genesisHash: (await ethers.provider.getBlock(0))!.hash,
		deployer: admin.address,
		startNonce: await admin.getNonce(),
		admin: admin.address,
		exerciseWindow: EXERCISE_WINDOW,
		expiryPricePublicationWindow: EXPIRY_PRICE_PUBLICATION_WINDOW,
		reportSigner: admin.address,
		settlementMethodology: "synthetic local test observations",
	})
	const journal = await resumeDeployment(admin, plan)
	return { admin, artifacts, plan, journal }
})

const stepOf = (plan: DeploymentPlan, name: string) => plan.steps.find(s => s.name === name)!

const TERMS_TUPLE = "tuple(address,address,bool,bool,uint8,uint8,uint64,uint64,uint256,uint32)"

// Solidity library selectors use named storage types. These bodies would succeed on zeroed storage
// without the compiler's direct-call guard, so their rejection tests that guard. The values are just
// plausible passing inputs: an expiry just past with its hour-long publication window still open,
// observations just made and valid for an hour, and terms expiring an hour out.
const directCalls = [
	{
		name: "IvyOptionSettlement.expire",
		library: "IvyOptionSettlement",
		signature: "expire(VaultState storage,VaultTerms storage,SettlementPrices storage,uint256)",
		types: ["uint256", "uint256", "uint256", "uint256"],
		values: (): unknown[] => [0, 1, 2, 1],
	},
	{
		name: "IvyOptionSettlement.publishExpiry",
		library: "IvyOptionSettlement",
		signature: "publishExpiry(SettlementPrices storage,uint256,address,address,uint64,uint64,uint256,uint64)",
		types: ["uint256", "uint256", "address", "address", "uint64", "uint64", "uint256", "uint64"],
		values: (admin: string, now: bigint): unknown[] => [0, 1, admin, admin, now - 1n, 3600, 1, now + 3600n],
	},
	{
		name: "IvyOptionSettlement.publishExercisePrice",
		library: "IvyOptionSettlement",
		signature: "publishExercisePrice(SettlementPrices storage,uint256,address,address,uint256,uint64,uint64)",
		types: ["uint256", "uint256", "address", "address", "uint256", "uint64", "uint64"],
		values: (admin: string, now: bigint): unknown[] => [0, 1, admin, admin, 1, now - 1n, now + 3600n],
	},
	{
		name: "IvyVaultRules.adoptRules",
		library: "IvyVaultRules",
		signature: "adoptRules(BidRule[] storage,VaultTerms,PairConfig[],BidRule[])",
		types: ["uint256", TERMS_TUPLE, "tuple(address,address)[]", "tuple(address,bytes4,bytes)[]"],
		values: (admin: string, now: bigint): unknown[] => [0, [admin, admin, false, false, 0, 0, now + 3600n, 0, 0, 0], [], []],
	},
]

describe("linked libraries", () => {
	skipUnderCoverage()

	let admin: HardhatEthersSigner
	let artifacts: Artifacts
	let plan: DeploymentPlan
	let journal: Journal

	beforeEach(async () => {
		;({ admin, artifacts, plan, journal } = await deployed())
	})

	describe("deployment", () => {
		it("deploys both libraries before anything else", () => {
			expect(plan.steps.slice(0, 2).map(s => s.name)).to.deep.equal(LIBRARIES)
		})

		it("links the hub to both libraries", () => {
			const hub = stepOf(plan, "IvyVaultsHub")
			expect(new Set(hub.libraryLinks.map(l => l.name))).to.deep.equal(new Set(LIBRARIES))
		})

		it("embeds each library address at its link offset in the hub runtime", async () => {
			const hub = stepOf(plan, "IvyVaultsHub")
			const code = await ethers.provider.getCode(hub.address)
			for (const link of hub.libraryLinks) {
				const embedded = "0x" + code.slice(2 + link.start * 2, 2 + (link.start + link.length) * 2)
				expect(embedded).to.equal(link.address.toLowerCase())
			}
		})

		it("keeps the linked hub under the EIP-170 size limit", () => {
			expect(stepOf(plan, "IvyVaultsHub").deployedSize).to.be.at.most(MAX_RUNTIME_SIZE)
		})

		it("deploys the shipped validator as its own unlinked step", async () => {
			const step = stepOf(plan, "IvyBidRules")
			expect(step.libraryLinks).to.deep.equal([])
			expect((await ethers.provider.getCode(step.address)).length).to.be.greaterThan(2)
		})
	})

	describe("linkBytecode", () => {
		it("rejects a library it has no address for", () => {
			expect(() => linkBytecode(artifacts.IvyVaultsHub, {})).to.throw(/Unknown library/)
		})

		it("rejects bytecode with an unresolved placeholder", () => {
			expect(() => linkBytecode({ bytecode: "0x__$unresolved$__", linkReferences: {} }, {})).to.throw(/Unresolved bytecode/)
		})

		it("rejects a link reference that is not 20 bytes long", () => {
			const bytecode = { bytecode: "0x00", linkReferences: { source: { IvyVaultRules: [{ start: 0, length: 19 }] } } }
			expect(() => linkBytecode(bytecode, plan.addresses)).to.throw(/Invalid link length/)
		})
	})

	describe("verifyBindings", () => {
		it("accepts the deployed links", async () => {
			await expect(verifyBindings(ethers.provider, plan)).to.be.fulfilled
		})

		it("rejects a tampered hub link even when the getters still match", async () => {
			const hub = stepOf(plan, "IvyVaultsHub")
			const link = hub.libraryLinks[0]
			const code = await ethers.provider.getCode(hub.address)
			const offset = 2 + link.start * 2
			await networkHelpers.setCode(hub.address, code.slice(0, offset) + admin.address.slice(2) + code.slice(offset + 40))
			await expect(verifyBindings(ethers.provider, plan)).to.be.rejectedWith(/Library binding mismatch/)
		})

		it("rejects a library with no code", async () => {
			await networkHelpers.setCode(plan.addresses.IvyOptionSettlement, "0x")
			await expect(verifyBindings(ethers.provider, plan)).to.be.rejectedWith(/Library code missing/)
		})
	})

	describe("resumeDeployment", () => {
		it("rejects a library whose runtime changed since it was journaled", async () => {
			const address = plan.addresses.IvyOptionSettlement
			const code = await ethers.provider.getCode(address)
			// Flip the final byte: same size, different runtime hash.
			await networkHelpers.setCode(address, code.slice(0, -2) + (code.endsWith("00") ? "01" : "00"))
			await expect(resumeDeployment(admin, plan, journal)).to.be.rejectedWith(/Runtime hash changed/)
		})
	})

	describe("direct calls", () => {
		for (const call of directCalls) {
			it(`rejects a direct ${call.name} call`, async () => {
				const to = plan.addresses[call.library]
				const selector = id(call.signature).slice(0, 10)
				const now = BigInt(await networkHelpers.time.latest())
				const data = AbiCoder.defaultAbiCoder().encode(call.types, call.values(admin.address, now)).slice(2)
				// A mistyped signature would also revert with empty data, so prove the selector is dispatched (PUSH4).
				expect(await ethers.provider.getCode(to)).to.include("63" + selector.slice(2))
				await expect(ethers.provider.call({ from: admin.address, to, data: selector + data })).to.be.revertedWithoutReason(ethers)
			})
		}
	})
})
