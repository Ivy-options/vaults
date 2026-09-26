import { expect } from "chai"
import { TypedDataEncoder } from "ethers"
import { network } from "hardhat"

import { UNWIND_TYPES } from "../../scripts/encoding.ts"
import { at, goLive, type LiveVault } from "../helpers/scenarios.js"
import { EXERCISE_WINDOW, Phase, SettlementPolicy, SettlementType, deployIvy, fixture, fund, usdc, weth, type IvyContext } from "../helpers/setup.js"
import { proposeUnwind, signUnwindProposal, contribute, proposeUnwindForADay } from "../helpers/unwind.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

type Proposal = Awaited<ReturnType<typeof signUnwindProposal>>

/** The timestamp `seconds` after the latest block. */
async function secondsFromNow(seconds: bigint) {
	return BigInt(await networkHelpers.time.latest()) + seconds
}

const agreementFields = [
	{ name: "vault id", field: "vaultId" },
	{ name: "nonce", field: "nonce" },
	{ name: "deadline", field: "deadline" },
	{ name: "exercised notional", field: "exercisedNotional" },
	{ name: "supply", field: "supply" },
	{ name: "refund", field: "refund" },
] as const

const forgeries: Array<{ name: string; sign: (c: IvyContext, p: Proposal) => Promise<string> }> = [
	{ name: "an empty signature", sign: async () => "0x" },
	...agreementFields.map(({ name, field }) => ({
		name: `a buyer signature over a different ${name}`,
		sign: (c: IvyContext, p: Proposal) => c.marketMaker.signTypedData(p.domain, UNWIND_TYPES, { ...p.agreement, [field]: p.agreement[field] + 1n }),
	})),
	{
		name: "a buyer signature for another chain",
		sign: (c, p) => c.marketMaker.signTypedData({ ...p.domain, chainId: p.domain.chainId + 1n }, UNWIND_TYPES, p.agreement),
	},
	{
		name: "a buyer signature for another verifying contract",
		sign: (c, p) => c.marketMaker.signTypedData({ ...p.domain, verifyingContract: c.hubAddress }, UNWIND_TYPES, p.agreement),
	},
]

const proposers = [
	{ name: "the owner", signer: (c: IvyContext) => c.alice },
	{ name: "the buyer", signer: (c: IvyContext) => c.marketMaker },
]

const deployed = fixture(connection, () => deployIvy(connection, { transfersEnabled: true }))
const physicalCall = fixture(deployed, async c => ({ c, v: await goLive(c) }))
const splitCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { deposit: weth(6), extraDeposits: [{ signer: c.bob, amount: weth(4) }] }),
}))
// alice (6 of 10 WETH) and bob (4) approved a 100 USDC refund that neither has funded.
const splitCallApproved = fixture(splitCall, async ({ c, v }) => {
	const p = await proposeUnwindForADay(c, v.vaultId, usdc(100))
	for (const lp of [c.alice, c.bob]) await c.hub.connect(lp).approveUnwind(v.vaultId, p.agreement.nonce)
	return { c, v, p }
})
const splitPut = fixture(deployed, async c => ({
	c,
	v: await goLive(c, {
		isCall: false,
		deposit: usdc(18_000),
		extraDeposits: [{ signer: c.bob, amount: usdc(12_000) }],
	}),
}))
const cashCallWithoutPublisher = fixture(deployed, async c => {
	const v = await goLive(c, { terms: { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 3600 } }, { settlement: SettlementType.Cash })
	await c.hub.setCashSettlementEnabled(false)
	await c.hub.revokeRole(await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), c.admin.address)
	return { c, v }
})

describe("previewUnwind", () => {
	let c: IvyContext
	let v: LiveVault

	context("physical call", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
		})

		it("returns the next agreement and its EIP-712 digest", async () => {
			const deadline = await secondsFromNow(1000n)
			const p = await signUnwindProposal(c, v.vaultId, deadline, 0n)
			expect(p.digest).to.equal(TypedDataEncoder.hash(p.domain, UNWIND_TYPES, p.agreement))
			expect(p.agreement).to.deep.equal({
				vaultId: v.vaultId,
				nonce: 1n,
				deadline,
				exercisedNotional: 0n,
				supply: weth(10),
				refund: 0n,
			})
		})
	})
})

describe("proposeUnwind", () => {
	let c: IvyContext
	let v: LiveVault
	let deadline: bigint
	let p: Proposal

	context("with a fresh buyer signature", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			deadline = await secondsFromNow(1000n)
			p = await signUnwindProposal(c, v.vaultId, deadline, 0n)
		})

		it("emits Proposed with the nonce, digest and signed terms", async () => {
			await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature))
				.to.emit(c.unwind, "Proposed")
				.withArgs(v.vaultId, p.agreement.nonce, p.digest, deadline, 0n, weth(10), 0n)
		})

		it("rejects an outsider even with a valid buyer signature", async () => {
			await expect(c.hub.connect(c.bob).proposeUnwind(v.vaultId, deadline, 0n, p.signature)).to.be.revertedWithCustomError(c.hub, "NotVaultOwner")
		})

		it("rejects the proposal at its signed deadline", async () => {
			await at(c, deadline)
			await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature)).to.be.revertedWithCustomError(
				c.unwind,
				"AgreementInvalid",
			)
		})

		it("rejects a signature from someone other than the buyer", async () => {
			const outsiderSignature = await c.bob.signTypedData(p.domain, UNWIND_TYPES, p.agreement)
			await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, outsiderSignature)).to.be.revertedWithCustomError(
				c.unwind,
				"BadSignature",
			)
		})

		for (const proposer of proposers) {
			context(`from ${proposer.name}`, () => {
				for (const forgery of forgeries) {
					it(`rejects ${forgery.name}`, async () => {
						const signature = await forgery.sign(c, p)
						await expect(c.hub.connect(proposer.signer(c)).proposeUnwind(v.vaultId, deadline, 0n, signature)).to.be.revertedWithCustomError(
							c.unwind,
							"BadSignature",
						)
					})
				}
			})
		}

		context("after the owner records it", () => {
			let next: Proposal

			beforeEach(async () => {
				await c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature)
				next = await signUnwindProposal(c, v.vaultId, deadline, 0n)
			})

			it("records the buyer's replacement under the next nonce", async () => {
				await c.hub.connect(c.marketMaker).proposeUnwind(v.vaultId, deadline, 0n, next.signature)
				expect((await c.unwind.agreements(v.vaultId)).nonce).to.equal(2n)
			})
		})

		context("after the buyer records it", () => {
			beforeEach(async () => {
				await c.hub.connect(c.marketMaker).proposeUnwind(v.vaultId, deadline, 0n, p.signature)
			})

			it("rejects a replay of the same signature", async () => {
				await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature)).to.be.revertedWithCustomError(
					c.unwind,
					"BadSignature",
				)
			})
		})

		context("after a partial exercise since the buyer signed", () => {
			beforeEach(async () => {
				await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
			})

			it("rejects the stale signature", async () => {
				await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature)).to.be.revertedWithCustomError(
					c.unwind,
					"BadSignature",
				)
			})

			it("records a fresh agreement with the exercised notional", async () => {
				await proposeUnwind(c, v.vaultId, deadline, 0n)
				expect((await c.unwind.agreements(v.vaultId)).exercisedNotional).to.equal(weth(1))
			})
		})
	})

	context("after the current proposal expires", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			deadline = await secondsFromNow(1000n)
			await proposeUnwind(c, v.vaultId, deadline, 0n)
			await networkHelpers.time.increaseTo(deadline + 1n)
		})

		it("rejects a replacement without a buyer signature", async () => {
			await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline + 1000n, 0n, "0x")).to.be.revertedWithCustomError(
				c.unwind,
				"BadSignature",
			)
		})

		it("records a signed replacement under the next nonce", async () => {
			const fresh = await proposeUnwind(c, v.vaultId, deadline + 1000n, 0n)
			expect(fresh.agreement.nonce).to.equal(2n)
		})
	})

	context("with both LPs approved", () => {
		beforeEach(async () => {
			;({ c, v, p } = await splitCallApproved())
		})

		it("clears every approval and its refund obligation under the next nonce", async () => {
			await proposeUnwindForADay(c, v.vaultId, 0n)
			expect((await c.unwind.agreements(v.vaultId)).nonce).to.equal(p.agreement.nonce + 1n)
			expect(await c.unwind.approvedShares(v.vaultId)).to.equal(0n)
			expect(await c.unwind.approvedRequired(v.vaultId)).to.equal(0n)
		})
	})

	context("with a funded proposal whose owner holds no shares", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.bob.address, v.vaultId, weth(10), "0x")
			deadline = await secondsFromNow(1000n)
			p = await proposeUnwind(c, v.vaultId, deadline, usdc(100))
			await c.hub.connect(c.bob).approveUnwind(v.vaultId, p.agreement.nonce)
			await contribute(c, v, c.bob, p.agreement.nonce, p.agreement.refund)
		})

		it("rejects the owner's replacement without a buyer signature", async () => {
			await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, "0x")).to.be.revertedWithCustomError(c.unwind, "BadSignature")
		})
	})
})

describe("approveUnwind", () => {
	let c: IvyContext
	let v: LiveVault
	let p: Proposal

	context("with a recorded proposal", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			p = await proposeUnwindForADay(c, v.vaultId, 0n)
		})

		it("approves at exactly the signed deadline", async () => {
			await at(c, p.agreement.deadline)
			await expect(c.hub.connect(c.alice).approveUnwind(v.vaultId, p.agreement.nonce))
				.to.emit(c.unwind, "ApprovalUpdated")
				.withArgs(v.vaultId, c.alice.address, p.agreement.nonce, weth(10))
		})

		it("rejects approval one second after the signed deadline", async () => {
			await at(c, p.agreement.deadline + 1n)
			await expect(c.hub.connect(c.alice).approveUnwind(v.vaultId, p.agreement.nonce)).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
		})

		it("rejects approval from an account holding no shares", async () => {
			await expect(c.hub.connect(c.carol).approveUnwind(v.vaultId, p.agreement.nonce)).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
		})

		it("rejects approving a replaced agreement", async () => {
			await proposeUnwindForADay(c, v.vaultId, 0n)
			await expect(c.hub.connect(c.alice).approveUnwind(v.vaultId, p.agreement.nonce)).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
		})
	})

	context("after the vault settles at expiry with a proposal still open", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			// The deadline outlives the exercise window, so only the phase stops approval.
			p = await proposeUnwind(c, v.vaultId, v.bid.expiry + 2n * EXERCISE_WINDOW, 0n)
			await at(c, v.bid.expiry + EXERCISE_WINDOW)
			await c.hub.settleAtExpiry(v.vaultId)
		})

		it("rejects approval with WrongPhase", async () => {
			await expect(c.hub.connect(c.alice).approveUnwind(v.vaultId, p.agreement.nonce))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Live, Phase.Settled)
		})
	})

	context("with both LPs approved", () => {
		beforeEach(async () => {
			;({ c, v, p } = await splitCallApproved())
		})

		it("keeps approvals through a self transfer and a zero transfer", async () => {
			await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.alice.address, v.vaultId, weth(1), "0x")
			await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.bob.address, v.vaultId, 0n, "0x")
			expect(await c.unwind.approvedShares(v.vaultId)).to.equal(weth(10))
		})

		it("drops the approvals on both sides of a real transfer", async () => {
			await c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address, c.bob.address, [v.vaultId, v.vaultId], [weth(1), weth(1)], "0x")
			expect(await c.unwind.approvedShares(v.vaultId)).to.equal(0n)
		})
	})
})

describe("revokeUnwind", () => {
	let c: IvyContext
	let v: LiveVault
	let p: Proposal

	context("with both LPs approved", () => {
		beforeEach(async () => {
			;({ c, v, p } = await splitCallApproved())
		})

		it("emits ApprovalUpdated with a zero balance for the revoking LP", async () => {
			await expect(c.hub.connect(c.bob).revokeUnwind(v.vaultId))
				.to.emit(c.unwind, "ApprovalUpdated")
				.withArgs(v.vaultId, c.bob.address, p.agreement.nonce, 0n)
		})
	})

	context("after both LPs re-approve following a transfer", () => {
		beforeEach(async () => {
			;({ c, v, p } = await splitCallApproved())
			// alice moves 2 of her 6 WETH shares to bob: alice 4, bob 6.
			await c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address, c.bob.address, [v.vaultId, v.vaultId], [weth(1), weth(1)], "0x")
			for (const lp of [c.alice, c.bob]) await c.hub.connect(lp).approveUnwind(v.vaultId, p.agreement.nonce)
		})

		it("removes only the revoking LP's shares", async () => {
			await c.hub.connect(c.bob).revokeUnwind(v.vaultId)
			expect(await c.unwind.approvedShares(v.vaultId)).to.equal(weth(4))
		})
	})
})

describe("executeUnwind", () => {
	let c: IvyContext
	let v: LiveVault
	let p: Proposal

	context("with an approved zero-refund proposal", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			p = await proposeUnwindForADay(c, v.vaultId, 0n)
			await c.hub.connect(c.alice).approveUnwind(v.vaultId, p.agreement.nonce)
		})

		it("rejects an invalid buyer signature", async () => {
			await expect(c.hub.executeUnwind(v.vaultId, p.agreement.nonce, "0x")).to.be.revertedWithCustomError(c.unwind, "BadSignature")
		})

		it("rejects a nonce that was never proposed", async () => {
			await expect(c.hub.executeUnwind(v.vaultId, p.agreement.nonce + 1n, p.signature)).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
		})

		it("executes at exactly the signed deadline", async () => {
			await at(c, p.agreement.deadline)
			await expect(c.hub.executeUnwind(v.vaultId, p.agreement.nonce, p.signature))
				.to.emit(c.hub, "Unwound")
				.withArgs(v.vaultId, p.agreement.nonce, 0n)
		})

		context("after the deadline", () => {
			beforeEach(async () => {
				await networkHelpers.time.increaseTo(p.agreement.deadline + 1n)
			})

			it("reverts with AgreementInvalid", async () => {
				await expect(c.hub.executeUnwind(v.vaultId, p.agreement.nonce, p.signature)).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
			})
		})

		context("after a partial exercise", () => {
			beforeEach(async () => {
				await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
			})

			it("reverts with AgreementInvalid", async () => {
				await expect(c.hub.executeUnwind(v.vaultId, p.agreement.nonce, p.signature)).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
			})

			context("with an approved replacement", () => {
				let replacement: Proposal

				beforeEach(async () => {
					replacement = await proposeUnwindForADay(c, v.vaultId, 0n)
					await c.hub.connect(c.alice).approveUnwind(v.vaultId, replacement.agreement.nonce)
				})

				it("emits Unwound with the replacement nonce and no refund", async () => {
					await expect(c.hub.executeUnwind(v.vaultId, replacement.agreement.nonce, replacement.signature))
						.to.emit(c.hub, "Unwound")
						.withArgs(v.vaultId, replacement.agreement.nonce, 0n)
				})

				it("emits Settled with the exercised notional and no pending payout", async () => {
					await expect(c.hub.executeUnwind(v.vaultId, replacement.agreement.nonce, replacement.signature))
						.to.emit(c.hub, "Settled")
						.withArgs(v.vaultId, weth(1), weth(10), 0n)
				})

				it("leaves the exercise proceeds with the LP", async () => {
					await c.hub.executeUnwind(v.vaultId, replacement.agreement.nonce, replacement.signature)
					await c.hub.connect(c.alice).claim(v.vaultId, weth(10))
					expect(await c.usdc.balanceOf(c.alice.address)).to.equal(usdc(3000))
					expect(await c.weth.balanceOf(c.alice.address)).to.equal(weth(9))
				})
			})
		})
	})

	context("after an approving LP transfers shares", () => {
		beforeEach(async () => {
			;({ c, v, p } = await splitCallApproved())
			await c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address, c.bob.address, [v.vaultId, v.vaultId], [weth(1), weth(1)], "0x")
		})

		it("reverts with ConsentMissing", async () => {
			await expect(c.hub.executeUnwind(v.vaultId, p.agreement.nonce, p.signature)).to.be.revertedWithCustomError(c.unwind, "ConsentMissing")
		})
	})

	context("put split 60/40 after the larger LP claims premium", () => {
		beforeEach(async () => {
			;({ c, v } = await splitPut())
			await c.hub.connect(c.alice).claimPremium(v.vaultId)
			p = await proposeUnwindForADay(c, v.vaultId, usdc(100))
		})

		context("when only one LP approved", () => {
			beforeEach(async () => {
				await c.hub.connect(c.alice).approveUnwind(v.vaultId, p.agreement.nonce)
			})

			it("reverts with ConsentMissing", async () => {
				await expect(c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)).to.be.revertedWithCustomError(
					c.unwind,
					"ConsentMissing",
				)
			})
		})

		context("when every LP approved", () => {
			beforeEach(async () => {
				for (const lp of [c.alice, c.bob]) await c.hub.connect(lp).approveUnwind(v.vaultId, p.agreement.nonce)
			})

			it("reverts with FundingMissing and stays live", async () => {
				await expect(c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)).to.be.revertedWithCustomError(
					c.unwind,
					"FundingMissing",
				)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			context("after both LPs fund their shares", () => {
				// bob's unclaimed 40% of the 1000 USDC premium.
				const bobPremium = usdc(400)

				beforeEach(async () => {
					await contribute(c, v, c.alice, p.agreement.nonce, usdc(60))
					await contribute(c, v, c.bob, p.agreement.nonce, usdc(40))
				})

				it("reserves the refund beside the unclaimed premium", async () => {
					await c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)
					expect(await v.vault.reserved(c.usdcAddress)).to.equal(bobPremium + p.agreement.refund)
				})

				it("keeps the premium and refund in the vault through the LP claims", async () => {
					await c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)
					await c.hub.connect(c.alice).claim(v.vaultId, usdc(18_000))
					await c.hub.connect(c.bob).claim(v.vaultId, usdc(12_000))
					expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(bobPremium + p.agreement.refund)
				})

				it("empties the vault once the buyer and the last LP collect", async () => {
					await c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)
					await c.hub.connect(c.alice).claim(v.vaultId, usdc(18_000))
					await c.hub.connect(c.bob).claim(v.vaultId, usdc(12_000))
					await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
					await c.hub.connect(c.bob).claimPremium(v.vaultId)
					expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
				})

				it("rejects a second execution", async () => {
					await c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)
					await expect(c.hub.executeUnwind(v.vaultId, p.agreement.nonce, p.signature))
						.to.be.revertedWithCustomError(c.hub, "WrongPhase")
						.withArgs(Phase.Live, Phase.Settled)
				})
			})
		})
	})

	context("cash call after cash settlement is switched off and the last publisher leaves", () => {
		beforeEach(async () => {
			;({ c, v } = await cashCallWithoutPublisher())
			p = await proposeUnwindForADay(c, v.vaultId, usdc(100))
			await c.hub.connect(c.alice).approveUnwind(v.vaultId, p.agreement.nonce)
			await contribute(c, v, c.alice, p.agreement.nonce, p.agreement.refund)
		})

		it("settles the vault without a price report", async () => {
			await c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)
			expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Settled)
			expect(await c.hub.cashSettlementEnabled()).to.equal(false)
		})

		it("pays the refund to the buyer after the LP claims", async () => {
			await c.hub.connect(c.carol).executeUnwind(v.vaultId, p.agreement.nonce, p.signature)
			await c.hub.connect(c.alice).claim(v.vaultId, weth(10))
			await c.hub.connect(c.alice).claimPremium(v.vaultId)
			await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.marketMaker, usdc(100))
		})
	})

	context("after the vault settles at expiry first", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			// The deadline outlives the exercise window, so only the phase stops execution.
			await proposeUnwind(c, v.vaultId, v.bid.expiry + 2n * EXERCISE_WINDOW, usdc(100))
			await c.hub.connect(c.alice).approveUnwind(v.vaultId, 1n)
			await fund(c, c.usdc, c.carol, v.vaultAddress, usdc(100))
			await at(c, v.bid.expiry + EXERCISE_WINDOW)
			await c.hub.settleAtExpiry(v.vaultId)
		})

		it("reverts with WrongPhase without taking the sponsor's refund", async () => {
			const before = await c.usdc.balanceOf(c.carol.address)
			await expect(c.hub.connect(c.carol).executeUnwind(v.vaultId, 1n, "0x"))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Live, Phase.Settled)
			expect(await c.usdc.balanceOf(c.carol.address)).to.equal(before)
			expect(await v.vault.buyerReserved(c.usdcAddress)).to.equal(0n)
		})
	})
})
