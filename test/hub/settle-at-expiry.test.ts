import { expect } from "chai"
import { network } from "hardhat"

import { goLive, publishExpiryPrice, setExercisePrice, type LiveVault } from "../helpers/scenarios.js"
import {
	EXERCISE_WINDOW,
	EXPIRY_PRICE_PUBLICATION_WINDOW,
	ExerciseStyle,
	Phase,
	SettlementType,
	callPairs,
	callTerms,
	createVaultAs,
	deployIvy,
	fixture,
	fund,
	usdc,
	weth,
	type IvyContext,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

// A 3300 expiry price against the 3000 strike pays notional × 300 / 3300 WETH.
const CALL_PAYOUT_ALL = 909_090_909_090_909_090n // on 10 WETH
const CALL_PAYOUT_SIX = 545_454_545_454_545_454n // on the 6 WETH left after exercising 4

const deployed = fixture(connection, () => deployIvy(connection))
const physicalCall = fixture(deployed, async c => ({ c, v: await goLive(c) }))
const cashEuropeanCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European }),
}))
const cashEuropeanPut = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European }),
}))
const cashAmericanCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash }),
}))
const fullOnlyCashCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true, terms: { allowPartialExercise: false } }, { settlement: SettlementType.Cash }),
}))
const fullOnlyCashCallPayingCarol = fixture(deployed, async c => ({
	c,
	v: await goLive(
		c,
		{ withFeed: true, terms: { allowPartialExercise: false } },
		{ settlement: SettlementType.Cash, style: ExerciseStyle.European, recipient: c.carol.address },
	),
}))

describe("settleAtExpiry", () => {
	let c: IvyContext
	let v: LiveVault

	context("before activation", () => {
		beforeEach(async () => {
			c = await deployed()
		})

		it("reverts with WrongPhase", async () => {
			const { vaultId } = await createVaultAs(c, c.alice, callTerms(c), callPairs(c))
			await expect(c.hub.settleAtExpiry(vaultId)).to.be.revertedWithCustomError(c.hub, "WrongPhase").withArgs(Phase.Live, Phase.Open)
		})
	})

	context("physical call", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
		})

		it("opens once the exercise window after expiry closes", async () => {
			expect(await c.hub.settleAtExpiryTimeOf(v.vaultId)).to.equal(v.bid.expiry + EXERCISE_WINDOW)
		})

		it("reverts with TooEarlyToSettle before it opens", async () => {
			await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "TooEarlyToSettle")
		})

		context("after the exercise window", () => {
			beforeEach(async () => {
				await networkHelpers.time.increaseTo(v.bid.expiry + EXERCISE_WINDOW + 1n)
			})

			it("lets anyone settle and leaves the collateral and premium to the LPs", async () => {
				await expect(c.hub.connect(c.bob).settleAtExpiry(v.vaultId)).to.emit(c.hub, "Settled").withArgs(v.vaultId, 0n, weth(10), 0n)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Settled)
				expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(weth(10))
				expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(1000))
			})

			it("does not report a physical fallback lapse", async () => {
				await expect(c.hub.settleAtExpiry(v.vaultId)).to.not.emit(c.hub, "PhysicalFallbackExpired")
			})

			it("reverts with WrongPhase once settled", async () => {
				await c.hub.settleAtExpiry(v.vaultId)
				await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "WrongPhase").withArgs(Phase.Live, Phase.Settled)
			})
		})

		context("after a partial exercise", () => {
			beforeEach(async () => {
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(12_000))
				await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
				await networkHelpers.time.increaseTo(v.bid.expiry + EXERCISE_WINDOW + 1n)
			})

			it("settles with the exercised notional", async () => {
				await expect(c.hub.settleAtExpiry(v.vaultId)).to.emit(c.hub, "Settled").withArgs(v.vaultId, weth(4), weth(10), 0n)
			})
		})
	})

	context("cash European call", () => {
		beforeEach(async () => {
			;({ c, v } = await cashEuropeanCall())
		})

		it("waits for the publication and exercise windows while no expiry report exists", async () => {
			expect(await c.hub.settleAtExpiryTimeOf(v.vaultId)).to.equal(v.bid.expiry + EXPIRY_PRICE_PUBLICATION_WINDOW + EXERCISE_WINDOW)
		})

		context("with an in-the-money expiry report", () => {
			beforeEach(async () => {
				await networkHelpers.time.increaseTo(v.bid.expiry - 2n)
				await publishExpiryPrice(c, v.vaultId, usdc(3300))
			})

			it("opens at the option expiry", async () => {
				expect(await c.hub.settleAtExpiryTimeOf(v.vaultId)).to.equal(v.bid.expiry)
			})

			it("lets anyone settle and reserves the payout for the market maker", async () => {
				await expect(c.hub.connect(c.alice).settleAtExpiry(v.vaultId))
					.to.emit(c.hub, "Settled")
					.withArgs(v.vaultId, weth(10), weth(10), CALL_PAYOUT_ALL)
				expect((await c.hub.stateOf(v.vaultId)).pendingPayout).to.equal(CALL_PAYOUT_ALL)
			})

			context("once settled", () => {
				beforeEach(async () => {
					await c.hub.settleAtExpiry(v.vaultId)
				})

				it("pays the reserved payout to the market maker", async () => {
					const tx = c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
					await expect(tx).to.emit(c.hub, "PayoutClaimed").withArgs(v.vaultId, c.marketMaker.address, CALL_PAYOUT_ALL, 0n)
					await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.marketMaker], [CALL_PAYOUT_ALL])
					expect((await c.hub.stateOf(v.vaultId)).pendingPayout).to.equal(0n)
				})

				it("rejects a payout claim from anyone but the executor", async () => {
					await expect(c.hub.connect(c.bob).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NotExecutor")
				})

				it("rejects a second payout claim", async () => {
					await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
					await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NothingToClaim")
				})
			})
		})

		context("with an out-of-the-money expiry report", () => {
			beforeEach(async () => {
				await networkHelpers.time.increaseTo(v.bid.expiry - 2n)
				await publishExpiryPrice(c, v.vaultId, usdc(2900))
			})

			it("settles without reserving a payout", async () => {
				await expect(c.hub.settleAtExpiry(v.vaultId)).to.emit(c.hub, "Settled").withArgs(v.vaultId, weth(10), weth(10), 0n)
			})

			it("leaves the market maker nothing to claim", async () => {
				await c.hub.settleAtExpiry(v.vaultId)
				await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NothingToClaim")
			})
		})

		context("when no expiry report arrives", () => {
			beforeEach(async () => {
				await networkHelpers.time.increaseTo(v.bid.expiry + 30n * 24n * 3600n)
			})

			it("rejects a late expiry report", async () => {
				await expect(publishExpiryPrice(c, v.vaultId, usdc(3300))).to.be.revertedWithCustomError(c.hub, "ExpiryPricePublicationClosed")
			})

			it("lets anyone release the collateral once the physical fallback lapses", async () => {
				await expect(c.hub.settleAtExpiry(v.vaultId)).to.emit(c.hub, "PhysicalFallbackExpired").withArgs(v.vaultId, weth(10))
				const state = await c.hub.stateOf(v.vaultId)
				expect(state.phase).to.equal(Phase.Settled)
				expect(state.pendingPayout).to.equal(0n)
			})
		})
	})

	context("cash European put", () => {
		beforeEach(async () => {
			;({ c, v } = await cashEuropeanPut())
			await networkHelpers.time.increaseTo(v.bid.expiry - 2n)
			await publishExpiryPrice(c, v.vaultId, usdc(2700))
		})

		it("reserves the in-the-money payout in the quote token", async () => {
			await expect(c.hub.settleAtExpiry(v.vaultId)).to.emit(c.hub, "Settled").withArgs(v.vaultId, weth(10), weth(10), usdc(3000))
			await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalances(ethers, c.usdc, [c.marketMaker], [usdc(3000)])
		})
	})

	context("cash American call after a partial exercise", () => {
		beforeEach(async () => {
			;({ c, v } = await cashAmericanCall())
			await setExercisePrice(c, v.vaultId, usdc(3300))
			await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			await networkHelpers.time.increaseTo(v.bid.expiry - 2n)
			await publishExpiryPrice(c, v.vaultId, usdc(3300))
		})

		it("settles the unexercised remainder at the expiry report", async () => {
			await expect(c.hub.settleAtExpiry(v.vaultId)).to.emit(c.hub, "Settled").withArgs(v.vaultId, weth(10), weth(10), CALL_PAYOUT_SIX)
		})
	})

	context("full-only cash call out of the money", () => {
		beforeEach(async () => {
			;({ c, v } = await fullOnlyCashCall())
			await setExercisePrice(c, v.vaultId, usdc(2900))
		})

		it("stays live before expiry", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))).to.be.revertedWithCustomError(c.hub, "NothingToExercise")
			await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "TooEarlyToSettle")
		})

		it("lets anyone settle at the expiry report with no payout and releases the LPs", async () => {
			await publishExpiryPrice(c, v.vaultId, usdc(2900))
			await c.hub.connect(c.carol).settleAtExpiry(v.vaultId)
			expect((await c.hub.stateOf(v.vaultId)).pendingPayout).to.equal(0n)
			await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(10))).to.changeTokenBalance(ethers, c.weth, c.alice, weth(10))
		})
	})

	context("full-only cash call whose recipient is blocked", () => {
		const payout = (weth(10) * 300n) / 3300n

		beforeEach(async () => {
			;({ c, v } = await fullOnlyCashCallPayingCarol())
			await publishExpiryPrice(c, v.vaultId, usdc(3300))
			await c.weth.setBlockedRecipient(c.carol.address, true)
		})

		it("rejects exercise without consuming notional", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))).to.be.revertedWithCustomError(c.weth, "RecipientBlocked")
			expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(10))
		})

		it("still lets anyone settle and reserves the payout", async () => {
			await c.hub.connect(c.bob).settleAtExpiry(v.vaultId)
			expect(await v.vault.buyerReserved(c.wethAddress)).to.equal(payout)
		})

		it("keeps the payout reserved through LP claims until the market maker redirects it", async () => {
			await c.hub.connect(c.bob).settleAtExpiry(v.vaultId)
			await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.weth, "RecipientBlocked")
			await c.hub.connect(c.alice).claim(v.vaultId, weth(10))
			await c.hub.connect(c.marketMaker).setExecutorAndRecipient(v.vaultId, c.bob.address, c.bob.address)
			await expect(c.hub.connect(c.bob).claimPayout(v.vaultId)).to.changeTokenBalances(ethers, c.weth, [c.bob, v.vaultAddress], [payout, -payout])
		})
	})
})
