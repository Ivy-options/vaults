import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import type {} from "chai-as-promised"
import { ZeroHash } from "ethers"
import { network } from "hardhat"

import {
	CONTRACTS,
	buildDeploymentPlan,
	loadArtifacts,
	resumeDeployment,
	verifyBindings,
	type Artifacts,
	type DeploymentInput,
	type DeploymentPlan,
	type Journal,
} from "../../scripts/deployment.ts"
import { EXERCISE_WINDOW, EXPIRY_PRICE_PUBLICATION_WINDOW, fixture, MAX_RUNTIME_SIZE, skipUnderCoverage } from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

const planned = fixture(connection, async () => {
	const [admin, publisher] = await ethers.getSigners()
	/** Every input but the expiry price publication window. */
	const baseInput: DeploymentInput = {
		artifacts: await loadArtifacts(),
		chainId: (await ethers.provider.getNetwork()).chainId,
		genesisHash: (await ethers.provider.getBlock(0))!.hash,
		deployer: admin.address,
		startNonce: await admin.getNonce(),
		admin: admin.address,
		reportSigner: admin.address,
		exerciseWindow: EXERCISE_WINDOW,
	}
	const plan = await buildDeploymentPlan({
		...baseInput,
		expiryPricePublicationWindow: EXPIRY_PRICE_PUBLICATION_WINDOW,
	})
	return { admin, publisher, baseInput, plan }
})
const deployed = fixture(planned, async p => ({
	...p,
	journal: await resumeDeployment(p.admin, p.plan),
	hub: await ethers.getContractAt("IvyVaultsHub", p.plan.addresses.IvyVaultsHub),
}))

describe("hub deployment", () => {
	skipUnderCoverage()

	describe("buildDeploymentPlan", () => {
		let baseInput: DeploymentInput
		let plan: DeploymentPlan

		beforeEach(async () => {
			;({ baseInput, plan } = await planned())
		})

		it("rejects a missing expiry price publication window", async () => {
			await expect(buildDeploymentPlan(baseInput)).to.be.rejectedWith(/expiryPricePublicationWindow/)
		})

		it("rejects a zero expiry price publication window", async () => {
			await expect(buildDeploymentPlan({ ...baseInput, expiryPricePublicationWindow: 0 })).to.be.rejectedWith(/expiryPricePublicationWindow/)
		})

		it("plans version 7 without cash settlement configuration when none is given", () => {
			expect(plan.version).to.equal(7)
			expect(plan).to.not.have.property("settlementPublisher")
			expect(plan.settlementMethodology).to.equal(undefined)
		})
	})

	describe("production contracts", () => {
		let artifacts: Artifacts

		before(async () => {
			artifacts = await loadArtifacts()
		})

		for (const name of CONTRACTS) {
			it(`keeps ${name} under the EIP-170 size limit`, () => {
				expect((artifacts[name].deployedBytecode.length - 2) / 2).to.be.at.most(MAX_RUNTIME_SIZE)
			})
		}
	})

	describe("resumeDeployment", () => {
		let admin: HardhatEthersSigner
		let plan: DeploymentPlan

		context("with a fresh plan", () => {
			beforeEach(async () => {
				;({ admin, plan } = await planned())
			})

			it("rejects an obsolete plan version", async () => {
				await expect(resumeDeployment(admin, { ...plan, version: 6 }, {})).to.be.rejectedWith(/Unsupported deployment plan version/)
			})

			it("rejects a plan for another chain", async () => {
				await expect(resumeDeployment(admin, { ...plan, chainId: "1" }, {})).to.be.rejectedWith("Wrong chain")
			})

			it("rejects a journal from another plan", async () => {
				await expect(resumeDeployment(admin, plan, { planHash: "wrong" })).to.be.rejectedWith("another plan")
			})
		})

		context("when the deployer nonce drifted", () => {
			beforeEach(async () => {
				;({ admin, plan } = await planned())
				await admin.sendTransaction({ to: admin.address, value: 0 })
			})

			it("rejects the plan without deploying anything", async () => {
				await expect(resumeDeployment(admin, plan, {})).to.be.rejectedWith("Nonce drift")
				expect(await ethers.provider.getCode(plan.addresses.IvyVault)).to.equal("0x")
			})
		})

		context("after an interruption that lost the IvyShares submission hash", () => {
			let journal: Journal

			beforeEach(async () => {
				;({ admin, plan } = await planned())
				journal = {}
				await expect(
					resumeDeployment(admin, plan, journal, async j => {
						if (j.steps?.IvyShares?.runtimeHash) throw new Error("simulated interruption")
					}),
				).to.be.rejectedWith("simulated interruption")
				// Discovery must find and verify the mined creation transaction without its record.
				delete journal.steps!.IvyShares.hash
			})

			it("finds the mined creation and completes with verified bindings", async () => {
				const done = await resumeDeployment(admin, plan, journal)
				expect(done.complete).to.equal(true)
				await expect(verifyBindings(ethers.provider, plan)).to.be.fulfilled
			})

			context("once recovered", () => {
				beforeEach(async () => {
					await resumeDeployment(admin, plan, journal)
				})

				it("sends no transaction when resumed again", async () => {
					const before = await admin.getNonce()
					await resumeDeployment(admin, plan, journal)
					expect(await admin.getNonce()).to.equal(before)
				})

				it("rejects a journal whose recorded runtime hash differs", async () => {
					journal.steps!.IvyVault.runtimeHash = ZeroHash
					await expect(resumeDeployment(admin, plan, journal)).to.be.rejectedWith("Runtime hash changed")
				})
			})
		})
	})

	describe("physical-only deployment", () => {
		let admin: HardhatEthersSigner
		let publisher: HardhatEthersSigner
		let plan: DeploymentPlan
		let journal: Journal
		let hub: Awaited<ReturnType<typeof deployed>>["hub"]

		beforeEach(async () => {
			;({ admin, publisher, plan, journal, hub } = await deployed())
		})

		it("uses the planned expiry price publication window", async () => {
			expect(await hub.expiryPricePublicationWindow()).to.equal(EXPIRY_PRICE_PUBLICATION_WINDOW)
		})

		it("leaves cash settlement disabled", async () => {
			expect(await hub.cashSettlementEnabled()).to.equal(false)
		})

		context("after the admin grants a settlement price publisher", () => {
			beforeEach(async () => {
				await hub.grantRole(await hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), publisher.address)
			})

			it("still leaves cash settlement disabled", async () => {
				expect(await hub.cashSettlementEnabled()).to.equal(false)
			})

			context("after the admin also enables cash settlement", () => {
				beforeEach(async () => {
					await hub.setCashSettlementEnabled(true)
				})

				it("reports cash settlement as enabled", async () => {
					expect(await hub.cashSettlementEnabled()).to.equal(true)
				})

				it("still verifies the bindings", async () => {
					await expect(verifyBindings(ethers.provider, plan)).to.be.fulfilled
				})

				it("resumes the completed journal", async () => {
					await expect(resumeDeployment(admin, plan, journal)).to.be.fulfilled
				})

				it("rejects bindings that expect another admin", async () => {
					await expect(verifyBindings(ethers.provider, { ...plan, admin: publisher.address })).to.be.rejectedWith(/Admin role missing/)
				})
			})
		})
	})
})
