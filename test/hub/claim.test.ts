import { expect } from "chai"
import { network } from "hardhat"

import { goLive, publishExpiryPrice, type LiveVault } from "../helpers/scenarios.js"
import { EXERCISE_WINDOW, ExerciseStyle, Phase, SettlementType, deployIvy, fixture, fund, usdc, weth, type IvyContext } from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

// A 3300 expiry price against the 3000 strike pays 10 WETH × 300 / 3300.
const CALL_PAYOUT_ALL = 909_090_909_090_909_090n

const deployed = fixture(connection, () => deployIvy(connection, { transfersEnabled: true }))
const sharedCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { deposit: weth(6), extraDeposits: [{ signer: c.bob, amount: weth(4) }] }),
}))
const expiredCall = fixture(sharedCall, async ({ c, v }) => {
	await networkHelpers.time.increaseTo(v.bid.expiry + EXERCISE_WINDOW + 1n)
	await c.hub.expire(v.vaultId)
	return { c, v }
})
const exercisedCall = fixture(sharedCall, async ({ c, v }) => {
	await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(30_000))
	await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
	return { c, v }
})
const partlyExercisedPut = fixture(deployed, async c => {
	const v = await goLive(c, {
		isCall: false,
		deposit: usdc(18_000),
		extraDeposits: [{ signer: c.bob, amount: usdc(12_000) }],
	})
	await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(4))
	await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
	await networkHelpers.time.increaseTo(v.bid.expiry + EXERCISE_WINDOW + 1n)
	await c.hub.expire(v.vaultId)
	return { c, v }
})
const settledCashCall = fixture(deployed, async c => {
	const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European })
	await networkHelpers.time.increaseTo(v.bid.expiry - 2n)
	await publishExpiryPrice(c, v.vaultId, usdc(3300))
	await c.hub.expire(v.vaultId)
	return { c, v }
})
const settledCashPut = fixture(deployed, async c => {
	const v = await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European })
	await publishExpiryPrice(c, v.vaultId, usdc(2700))
	await c.hub.expire(v.vaultId)
	return { c, v }
})

describe("claim", () => {
	let c: IvyContext
	let v: LiveVault

	context("while the vault is live", () => {
		beforeEach(async () => {
			;({ c, v } = await sharedCall())
		})

		it("reverts with WrongPhase", async () => {
			await expect(c.hub.connect(c.alice).claim(v.vaultId, 1n)).to.be.revertedWithCustomError(c.hub, "WrongPhase").withArgs(Phase.Settled, Phase.Live)
		})
	})

	context("physical call expired unexercised", () => {
		beforeEach(async () => {
			;({ c, v } = await expiredCall())
		})

		it("emits Claimed with the burned shares", async () => {
			await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(6)))
				.to.emit(c.hub, "Claimed")
				.withArgs(v.vaultId, c.alice.address, weth(6))
		})

		for (const { name, shares } of [
			{ name: "alice", shares: weth(6) },
			{ name: "bob", shares: weth(4) },
		] as const) {
			it(`pays ${name} their collateral and none of the unpaid premium`, async () => {
				const holder = c[name]
				const tx = c.hub.connect(holder).claim(v.vaultId, shares)
				await expect(tx).to.changeTokenBalances(ethers, c.weth, [holder], [shares])
				await expect(tx).to.changeTokenBalances(ethers, c.usdc, [holder], [0n])
			})
		}

		it("leaves only the unpaid premium once every LP has claimed", async () => {
			await c.hub.connect(c.alice).claim(v.vaultId, weth(6))
			await c.hub.connect(c.bob).claim(v.vaultId, weth(4))
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(0n)
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(1000))
			expect(await c.hub.totalShares(v.vaultId)).to.equal(0n)
		})

		it("makes no premium token transfer while the whole premium stays reserved", async () => {
			await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(6))).not.to.emit(c.usdc, "Transfer")
		})

		it("pays a holder of transferred shares", async () => {
			await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.carol.address, v.vaultId, weth(2), "0x")
			const tx = c.hub.connect(c.carol).claim(v.vaultId, weth(2))
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.carol], [weth(2)])
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.carol], [0n])
		})

		it("pays a partial claim proportionally", async () => {
			const tx = c.hub.connect(c.alice).claim(v.vaultId, weth(3))
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.alice], [weth(3)])
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.alice], [0n])
		})

		it("reverts with ZeroAmount for zero shares", async () => {
			await expect(c.hub.connect(c.alice).claim(v.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
		})

		it("reverts with InsufficientShares for a caller without shares", async () => {
			await expect(c.hub.connect(c.carol).claim(v.vaultId, 1n)).to.be.revertedWithCustomError(c.hub, "InsufficientShares")
		})

		it("reverts with InsufficientShares for more shares than the caller holds", async () => {
			await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(7))).to.be.revertedWithCustomError(c.hub, "InsufficientShares")
		})

		context("after a partial claim", () => {
			beforeEach(async () => {
				await c.hub.connect(c.alice).claim(v.vaultId, weth(3))
			})

			it("pays the rest proportionally and burns every remaining share", async () => {
				const tx = c.hub.connect(c.alice).claim(v.vaultId, weth(3))
				await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.alice], [weth(3)])
				await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.alice], [0n])
				expect(await c.shares.balanceOf(c.alice.address, v.vaultId)).to.equal(0n)
			})
		})
	})

	context("physical call fully exercised", () => {
		beforeEach(async () => {
			;({ c, v } = await exercisedCall())
		})

		it("is settled by the full exercise", async () => {
			expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Settled)
		})

		for (const { name, shares, proceeds } of [
			{ name: "alice", shares: weth(6), proceeds: usdc(18_000) },
			{ name: "bob", shares: weth(4), proceeds: usdc(12_000) },
		] as const) {
			it(`pays ${name} their share of the strike proceeds and no collateral`, async () => {
				const holder = c[name]
				const tx = c.hub.connect(holder).claim(v.vaultId, shares)
				await expect(tx).to.changeTokenBalances(ethers, c.usdc, [holder], [proceeds])
				await expect(tx).to.changeTokenBalances(ethers, c.weth, [holder], [0n])
			})
		}

		it("leaves the unpaid premium in the vault once every LP has claimed", async () => {
			await c.hub.connect(c.alice).claim(v.vaultId, weth(6))
			await c.hub.connect(c.bob).claim(v.vaultId, weth(4))
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(1000))
		})
	})

	context("put partially exercised then expired", () => {
		beforeEach(async () => {
			;({ c, v } = await partlyExercisedPut())
		})

		it("holds the unexercised collateral with the premium and the delivered underlying", async () => {
			// 30,000 deposited − 12,000 paid for 4 WETH + 1,000 premium.
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(19_000))
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(weth(4))
		})

		// The LPs split 18,000 USDC and 4 WETH 60/40; the 1,000 USDC premium stays reserved.
		it("pays alice a proportional mix of collateral and underlying", async () => {
			const tx = c.hub.connect(c.alice).claim(v.vaultId, usdc(18_000))
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.alice], [usdc(10_800)])
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.alice], [weth(24) / 10n])
		})

		context("after alice claims", () => {
			beforeEach(async () => {
				await c.hub.connect(c.alice).claim(v.vaultId, usdc(18_000))
			})

			it("pays bob a proportional mix of what remains", async () => {
				const tx = c.hub.connect(c.bob).claim(v.vaultId, usdc(12_000))
				await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.bob], [usdc(7_200)])
				await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.bob], [weth(16) / 10n])
			})
		})
	})

	context("cash European call settled in the money", () => {
		beforeEach(async () => {
			;({ c, v } = await settledCashCall())
		})

		it("pays the LP the collateral minus the market maker's pending payout", async () => {
			const tx = c.hub.connect(c.alice).claim(v.vaultId, weth(10))
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.alice], [weth(10) - CALL_PAYOUT_ALL])
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.alice], [0n])
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(CALL_PAYOUT_ALL)
		})
	})

	context("cash European put settled in the money", () => {
		beforeEach(async () => {
			;({ c, v } = await settledCashPut())
		})

		it("reserves the payout and the unpaid premium together in the collateral token", async () => {
			// 3,000 USDC payout (10 WETH × (3000 − 2700)) + 1,000 USDC premium.
			expect(await v.vault.reserved(c.usdcAddress)).to.equal(usdc(4000))
		})

		it("leaves the reserved payout and premium behind when the LP claims", async () => {
			await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(4000))
		})
	})
})

describe("claimPayout", () => {
	let c: IvyContext
	let v: LiveVault

	context("while the vault is live", () => {
		beforeEach(async () => {
			;({ c, v } = await sharedCall())
		})

		it("reverts with WrongPhase for the market maker", async () => {
			await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Settled, Phase.Live)
		})
	})

	context("cash European call after the LP claims", () => {
		beforeEach(async () => {
			;({ c, v } = await settledCashCall())
			await c.hub.connect(c.alice).claim(v.vaultId, weth(10))
		})

		it("pays the market maker the reserved payout and empties the vault", async () => {
			await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalances(ethers, c.weth, [c.marketMaker], [CALL_PAYOUT_ALL])
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(0n)
		})
	})

	context("cash European put after the LP claims", () => {
		beforeEach(async () => {
			;({ c, v } = await settledCashPut())
			await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
		})

		it("empties the vault together with the LP's premium claim", async () => {
			await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
			await c.hub.connect(c.alice).claimPremium(v.vaultId)
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
		})
	})
})

describe("claimPremium", () => {
	let c: IvyContext
	let v: LiveVault

	context("with an unknown vault id", () => {
		beforeEach(async () => {
			;({ c, v } = await expiredCall())
		})

		it("reverts with UnknownVault for vault id zero", async () => {
			await expect(c.hub.connect(c.alice).claimPremium(0n)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
		})

		it("reverts with UnknownVault one past the last vault", async () => {
			await expect(c.hub.connect(c.alice).claimPremium(v.vaultId + 1n)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
		})
	})
})
