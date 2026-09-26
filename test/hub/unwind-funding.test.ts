import { expect } from "chai"
import { network } from "hardhat"

import { PUT_DEPOSIT, at, goLive, type LiveVault } from "../helpers/scenarios.js"
import { EXERCISE_WINDOW, Phase, deployIvy, fixture, fund, usdc, weth, type IvyContext } from "../helpers/setup.js"
import { contribute, proposeUnwindForADay } from "../helpers/unwind.js"

const connection = await network.create()
const { ethers } = connection

type Proposal = Awaited<ReturnType<typeof proposal>>

/** A day-long proposal, flattened into the agreement fields plus its signature. */
async function proposal(c: IvyContext, vaultId: bigint, refund: bigint) {
	const { agreement, signature } = await proposeUnwindForADay(c, vaultId, refund)
	return { ...agreement, signature }
}

const deployed = fixture(connection, () => deployIvy(connection, { transfersEnabled: true }))
const physicalCall = fixture(deployed, async c => ({ c, v: await goLive(c) }))
const splitCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { deposit: weth(6), extraDeposits: [{ signer: c.bob, amount: weth(4) }] }),
}))
const physicalPut = fixture(deployed, async c => ({ c, v: await goLive(c, { isCall: false }) }))
// Three LPs with one wei of collateral each and no premium.
const dustCall = fixture(deployed, async c => ({
	c,
	v: await goLive(
		c,
		{
			deposit: 1n,
			extraDeposits: [
				{ signer: c.bob, amount: 1n },
				{ signer: c.carol, amount: 1n },
			],
		},
		{ premiumPerUnit: 0n },
	),
}))

/** Each one-wei LP funds one base unit of unwind `nonce` and approves it. */
async function fundOneUnitEach(c: IvyContext, v: LiveVault, nonce: bigint) {
	for (const lp of [c.alice, c.bob, c.carol]) {
		await contribute(c, v, lp, nonce, 1n)
		await c.hub.connect(lp).approveUnwind(v.vaultId, nonce)
	}
}

// The one-wei LPs fund and approve a `refund` unwind, which then executes.
const dustUnwound = (refund: bigint) =>
	fixture(dustCall, async ({ c, v }) => {
		const a = await proposal(c, v.vaultId, refund)
		await fundOneUnitEach(c, v, a.nonce)
		await c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)
		return { c, v, a }
	})
const dustUnwoundTwo = dustUnwound(2n)
const dustUnwoundOne = dustUnwound(1n)

// alice (6 of 10 WETH) claimed her premium, both LPs approved a 100 USDC refund and alice funded all of it.
const overfundedByOneLp = fixture(splitCall, async ({ c, v }) => {
	await c.hub.connect(c.alice).claimPremium(v.vaultId)
	const a = await proposal(c, v.vaultId, usdc(100))
	for (const lp of [c.alice, c.bob]) await c.hub.connect(lp).approveUnwind(v.vaultId, a.nonce)
	await contribute(c, v, c.alice, a.nonce, usdc(100))
	return { c, v, a }
})
// alice approved and funded the whole refund, claimed premium, then moved every share to bob, who approved.
const fundedThenTransferred = fixture(physicalCall, async ({ c, v }) => {
	const a = await proposal(c, v.vaultId, usdc(100))
	await c.hub.connect(c.alice).approveUnwind(v.vaultId, a.nonce)
	await contribute(c, v, c.alice, a.nonce, usdc(100))
	await c.hub.connect(c.alice).claimPremium(v.vaultId)
	await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.bob.address, v.vaultId, weth(10), "0x")
	await c.hub.connect(c.bob).approveUnwind(v.vaultId, a.nonce)
	return { c, v, a }
})
// alice left 60 USDC on a proposal that was replaced; both LPs approved the replacement.
const replaced = fixture(splitCall, async ({ c, v }) => {
	const old = await proposal(c, v.vaultId, usdc(100))
	await fund(c, c.usdc, c.alice, v.vaultAddress, usdc(160))
	await c.hub.connect(c.alice).fundUnwind(v.vaultId, old.nonce, usdc(60))
	const a = await proposal(c, v.vaultId, usdc(100))
	for (const lp of [c.alice, c.bob]) await c.hub.connect(lp).approveUnwind(v.vaultId, a.nonce)
	return { c, v, old, a }
})
// The LPs fund 60/40, then bob moves 2 of his 4 WETH shares to alice and both re-approve:
// alice now owes 80 USDC and bob 20.
const rebalanced = fixture(replaced, async ({ c, v, old, a }) => {
	await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(60))
	await contribute(c, v, c.bob, a.nonce, usdc(40))
	await c.shares.connect(c.bob).safeTransferFrom(c.bob.address, c.alice.address, v.vaultId, weth(2), "0x")
	for (const lp of [c.alice, c.bob]) await c.hub.connect(lp).approveUnwind(v.vaultId, a.nonce)
	return { c, v, old, a }
})

const invalidations: Array<{
	name: string
	invalidate: (c: IvyContext, v: LiveVault, a: Proposal) => Promise<unknown>
	/** The error executing the invalidated agreement reverts with, and the contract that raises it. */
	rejection: { from: "hub" | "unwind"; error: string; args?: unknown[] }
	burnsShares?: boolean
}> = [
	{
		name: "the LP revokes",
		invalidate: (c, v) => c.hub.connect(c.alice).revokeUnwind(v.vaultId),
		rejection: { from: "unwind", error: "ConsentMissing" },
	},
	{
		name: "a replacement proposal",
		invalidate: (c, v) => proposal(c, v.vaultId, usdc(100)),
		rejection: { from: "unwind", error: "AgreementInvalid" },
	},
	// The next transaction lands on the first second past the deadline.
	{
		name: "the deadline",
		invalidate: (c, _v, a) => at(c, a.deadline + 1n),
		rejection: { from: "unwind", error: "AgreementInvalid" },
	},
	{
		name: "a partial exercise",
		invalidate: async (c, v) => {
			await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(1))
			await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
		},
		rejection: { from: "unwind", error: "AgreementInvalid" },
	},
	{
		name: "settlement and burning every share",
		invalidate: async (c, v) => {
			await at(c, v.bid.expiry + EXERCISE_WINDOW)
			await c.hub.settleAtExpiry(v.vaultId)
			await c.hub.connect(c.alice).claim(v.vaultId, PUT_DEPOSIT)
			await c.hub.connect(c.alice).claimPremium(v.vaultId)
		},
		rejection: { from: "hub", error: "WrongPhase", args: [Phase.Live, Phase.Settled] },
		burnsShares: true,
	},
]

describe("fundUnwind", () => {
	let c: IvyContext
	let v: LiveVault
	let a: Proposal

	context("with an approved 100 USDC refund", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			a = await proposal(c, v.vaultId, usdc(100))
			await c.hub.connect(c.alice).approveUnwind(v.vaultId, a.nonce)
			await fund(c, c.usdc, c.alice, v.vaultAddress, usdc(100))
		})

		it("funds at exactly the signed deadline", async () => {
			await at(c, a.deadline)
			await expect(c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(100)))
				.to.emit(c.unwind, "ContributionFunded")
				.withArgs(v.vaultId, a.nonce, c.alice.address, usdc(100))
		})

		it("rejects funding one second after the signed deadline", async () => {
			await at(c, a.deadline + 1n)
			await expect(c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(100))).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
		})

		it("rejects funding from an account holding no shares", async () => {
			await fund(c, c.usdc, c.carol, v.vaultAddress, usdc(100))
			await expect(c.hub.connect(c.carol).fundUnwind(v.vaultId, a.nonce, usdc(100))).to.be.revertedWithCustomError(c.hub, "AgreementInvalid")
		})

		it("still executes after the LP tops up past their exact share", async () => {
			await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(100))
			await contribute(c, v, c.alice, a.nonce, usdc(1))
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature))
				.to.emit(c.hub, "Unwound")
				.withArgs(v.vaultId, a.nonce, usdc(100))
		})

		context("after a partial exercise", () => {
			beforeEach(async () => {
				await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
			})

			it("rejects funding the agreement signed before the exercise", async () => {
				await expect(c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(100))).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
			})
		})
	})

	context("when one LP funds the whole refund", () => {
		beforeEach(async () => {
			;({ c, v, a } = await overfundedByOneLp())
		})

		it("rejects execution until the other LP funds their share", async () => {
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)).to.be.revertedWithCustomError(c.unwind, "FundingMissing")
		})

		it("pays the buyer the signed refund once the other LP funds their share", async () => {
			await contribute(c, v, c.bob, a.nonce, usdc(40))
			await c.hub.connect(c.carol).executeUnwind(v.vaultId, a.nonce, a.signature)
			await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.marketMaker, usdc(100))
		})
	})

	context("after a funded LP transfers every share to a new holder", () => {
		beforeEach(async () => {
			;({ c, v, a } = await fundedThenTransferred())
		})

		it("rejects execution until the new holder funds their share", async () => {
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)).to.be.revertedWithCustomError(c.unwind, "FundingMissing")
		})
	})

	context("with three one-wei LPs and a refund of two USDC base units", () => {
		beforeEach(async () => {
			;({ c, v } = await dustCall())
			a = await proposal(c, v.vaultId, 2n)
		})

		it("rounds each LP's obligation up to the one base unit they fund", async () => {
			await fundOneUnitEach(c, v, a.nonce)
			expect(await c.unwind.approvedRequired(v.vaultId)).to.equal(3n)
			expect(await c.unwind.fundedShares(v.vaultId)).to.equal(3n)
		})
	})

	context("after a replacement proposal", () => {
		let old: Proposal

		beforeEach(async () => {
			;({ c, v, old, a } = await replaced())
		})

		it("rejects execution while neither LP has funded the replacement", async () => {
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)).to.be.revertedWithCustomError(c.unwind, "FundingMissing")
		})

		it("rejects funding the replaced agreement", async () => {
			await expect(c.hub.connect(c.alice).fundUnwind(v.vaultId, old.nonce, usdc(10))).to.be.revertedWithCustomError(c.unwind, "AgreementInvalid")
		})
	})

	context("after a partial share transfer between funded LPs", () => {
		beforeEach(async () => {
			;({ c, v, a } = await rebalanced())
		})

		it("rejects execution until the larger holder covers their new share", async () => {
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)).to.be.revertedWithCustomError(c.unwind, "FundingMissing")
		})

		it("rejects execution after only a partial top-up", async () => {
			await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(10))
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)).to.be.revertedWithCustomError(c.unwind, "FundingMissing")
		})

		it("executes once the top-ups reach exactly the new 80 USDC share", async () => {
			await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(10))
			await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(10))
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature))
				.to.emit(c.hub, "Unwound")
				.withArgs(v.vaultId, a.nonce, usdc(100))
		})
	})
})

describe("withdrawUnwindContribution", () => {
	let c: IvyContext
	let v: LiveVault
	let a: Proposal

	context("after an overfunded unwind executes and the buyer collects the refund", () => {
		beforeEach(async () => {
			;({ c, v, a } = await overfundedByOneLp())
			await contribute(c, v, c.bob, a.nonce, usdc(40))
			await c.hub.connect(c.carol).executeUnwind(v.vaultId, a.nonce, a.signature)
			await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
		})

		it("returns the overfunded surplus", async () => {
			const tx = c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
			await expect(tx).to.emit(c.unwind, "ContributionWithdrawn").withArgs(v.vaultId, a.nonce, c.alice.address, usdc(40))
			await expect(tx).to.changeTokenBalance(ethers, c.usdc, c.alice, usdc(40))
		})
	})

	context("with a funded put proposal", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalPut())
			a = await proposal(c, v.vaultId, usdc(100))
			await c.hub.connect(c.alice).approveUnwind(v.vaultId, a.nonce)
			await contribute(c, v, c.alice, a.nonce, usdc(100))
		})

		for (const { name, invalidate, rejection, burnsShares } of invalidations) {
			context(`after ${name}`, () => {
				beforeEach(async () => {
					await invalidate(c, v, a)
				})

				if (burnsShares) {
					it("holds only the contribution once every share is burned", async () => {
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(100))
					})
				}

				it(`rejects executing the invalidated agreement with ${rejection.error}`, async () => {
					await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature))
						.to.be.revertedWithCustomError(c[rejection.from], rejection.error)
						.withArgs(...(rejection.args ?? []))
				})

				it("returns the whole contribution", async () => {
					await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)).to.changeTokenBalance(
						ethers,
						c.usdc,
						c.alice,
						usdc(100),
					)
				})

				it("rejects a second withdrawal", async () => {
					await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
					await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)).to.be.revertedWithCustomError(
						c.unwind,
						"NothingToClaim",
					)
				})

				it("releases the unwind reserve", async () => {
					await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
					expect(await v.vault.unwindReserved()).to.equal(0n)
				})
			})
		}
	})

	context("after the new holder of every share funds and the unwind settles", () => {
		beforeEach(async () => {
			;({ c, v, a } = await fundedThenTransferred())
			await contribute(c, v, c.bob, a.nonce, usdc(100))
			await c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)
			await c.hub.connect(c.bob).claim(v.vaultId, weth(10))
			await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
		})

		it("returns the former holder's entire contribution and empties the vault", async () => {
			await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)).to.changeTokenBalance(ethers, c.usdc, c.alice, usdc(100))
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
		})
	})

	context("after a rounded-up unwind executes and every share is transferred or burned", () => {
		beforeEach(async () => {
			;({ c, v, a } = await dustUnwoundTwo())
			await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.bob.address, v.vaultId, 1n, "0x")
			await c.hub.connect(c.bob).claim(v.vaultId, 2n)
			await c.hub.connect(c.carol).claim(v.vaultId, 1n)
		})

		it("still pays the buyer exactly the signed refund", async () => {
			await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.marketMaker, 2n)
		})

		it("gives the rounding surplus to the last LP to withdraw", async () => {
			await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
			await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
			await c.hub.connect(c.bob).withdrawUnwindContribution(v.vaultId, a.nonce)
			await expect(c.hub.connect(c.carol).withdrawUnwindContribution(v.vaultId, a.nonce)).to.changeTokenBalance(ethers, c.usdc, c.carol, 1n)
		})

		it("leaves nothing reserved or held once every LP withdraws", async () => {
			await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
			for (const lp of [c.alice, c.bob, c.carol]) await c.hub.connect(lp).withdrawUnwindContribution(v.vaultId, a.nonce)
			expect(await v.vault.unwindReserved()).to.equal(0n)
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
		})
	})

	context("after a one-unit refund executes with three one-wei LPs", () => {
		beforeEach(async () => {
			;({ c, v, a } = await dustUnwoundOne())
		})

		// Each LP owes a rounded-up unit, leaving two units of surplus: alice's third floors to zero,
		// bob's half takes one, and one remains for carol.
		it("gives the last LP only the surplus the earlier withdrawals left", async () => {
			await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
			await c.hub.connect(c.bob).withdrawUnwindContribution(v.vaultId, a.nonce)
			await expect(c.hub.connect(c.carol).withdrawUnwindContribution(v.vaultId, a.nonce)).to.changeTokenBalance(ethers, c.usdc, c.carol, 1n)
		})
	})

	context("with an approved zero-refund proposal funded with 10 USDC", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			a = await proposal(c, v.vaultId, 0n)
			await contribute(c, v, c.alice, a.nonce, usdc(10))
			await c.hub.connect(c.alice).approveUnwind(v.vaultId, a.nonce)
		})

		it("revokes the LP's consent before execution", async () => {
			await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
			await expect(c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)).to.be.revertedWithCustomError(c.unwind, "ConsentMissing")
		})

		context("after the LP withdraws, funds again and re-approves", () => {
			beforeEach(async () => {
				await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
				await c.usdc.connect(c.alice).approve(v.vaultAddress, usdc(10))
				await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(10))
				await c.hub.connect(c.alice).approveUnwind(v.vaultId, a.nonce)
			})

			it("releases the reserve when the LP withdraws after execution", async () => {
				await c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)
				await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)
				expect(await v.vault.unwindReserved()).to.equal(0n)
			})
		})
	})

	context("after a replacement unwind executes", () => {
		let old: Proposal

		beforeEach(async () => {
			;({ c, v, old, a } = await rebalanced())
			await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(10))
			await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, usdc(10))
			await c.hub.executeUnwind(v.vaultId, a.nonce, a.signature)
		})

		it("returns the funding left on the replaced agreement", async () => {
			await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, old.nonce)).to.changeTokenBalance(ethers, c.usdc, c.alice, usdc(60))
		})

		it("returns the surplus freed when a transfer shrank an LP's share", async () => {
			await expect(c.hub.connect(c.bob).withdrawUnwindContribution(v.vaultId, a.nonce)).to.changeTokenBalance(ethers, c.usdc, c.bob, usdc(20))
		})

		it("releases the unwind reserve once both withdraw", async () => {
			await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, old.nonce)
			await c.hub.connect(c.bob).withdrawUnwindContribution(v.vaultId, a.nonce)
			expect(await v.vault.unwindReserved()).to.equal(0n)
		})
	})
})
