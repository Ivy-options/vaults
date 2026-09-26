import { expect } from "chai"
import { network } from "hardhat"

import { goLive, publishExpiryPrice, setExercisePrice, type LiveVault } from "../helpers/scenarios.js"
import { ExerciseStyle, Phase, SettlementType, deployIvy, fixture, fund, usdc, weth, PayoutReceiverMode, type IvyContext } from "../helpers/setup.js"
import { proposeUnwind } from "../helpers/unwind.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

// A 3300 price against the 3000 strike pays 10 WETH × 300 / 3300.
const CASH_PAYOUT = (weth(10) * 300n) / 3300n

const deployed = fixture(connection, async () => {
	const c = await deployIvy(connection)
	const receiver = await ethers.deployContract("PayoutReceiver", [c.hubAddress])
	return { c, receiver, receiverAddress: await receiver.getAddress() }
})
type Receiver = Awaited<ReturnType<typeof deployed>>["receiver"]

const physicalCall = fixture(deployed, async d => ({ ...d, v: await goLive(d.c) }))
const physicalCallToReceiver = fixture(deployed, async d => ({
	...d,
	v: await goLive(d.c, {}, { recipient: d.receiverAddress }),
}))
const physicalCallToToken = fixture(deployed, async d => ({
	...d,
	v: await goLive(d.c, {}, { recipient: d.c.usdcAddress }),
}))
const oddSizeReceivers = [
	{ size: 4n, acknowledged: false },
	{ size: 32n, acknowledged: true },
	{ size: 64n, acknowledged: false },
].map(answer => ({
	...answer,
	load: fixture(deployed, async ({ c }) => {
		const receiver = await ethers.deployContract("OddSizePayoutReceiver", [answer.size])
		const receiverAddress = await receiver.getAddress()
		return { c, receiverAddress, v: await goLive(c, {}, { recipient: receiverAddress }) }
	}),
}))
const cashAmericanCallToReceiver = fixture(deployed, async d => ({
	...d,
	v: await goLive(d.c, { withFeed: true }, { settlement: SettlementType.Cash, recipient: d.receiverAddress }),
}))
const cashEuropeanCallToReceiverInTheMoney = fixture(deployed, async d => {
	const v = await goLive(d.c, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European, recipient: d.receiverAddress })
	await networkHelpers.time.increaseTo(v.bid.expiry - 2n)
	await publishExpiryPrice(d.c, v.vaultId, usdc(3300))
	return { ...d, v }
})

describe("payout callback", () => {
	let c: IvyContext
	let v: LiveVault
	let receiver: Receiver
	let receiverAddress: string

	context("physical call paying the market maker's own account", () => {
		beforeEach(async () => {
			;({ c, v, receiverAddress } = await physicalCall())
		})

		it("does not notify an externally owned recipient", async () => {
			await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(12_000))
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))).to.not.emit(c.hub, "PayoutNotified")
		})

		context("after the market maker redirects execution to bob and payouts to a receiver contract", () => {
			beforeEach(async () => {
				await c.hub.connect(c.marketMaker).setExecution(v.vaultId, c.bob.address, receiverAddress)
			})

			it("notifies the new recipient when bob exercises", async () => {
				await fund(c, c.usdc, c.bob, v.vaultAddress, usdc(3000))
				await expect(c.hub.connect(c.bob).exercise(v.vaultId, weth(1)))
					.to.emit(c.hub, "PayoutNotified")
					.withArgs(v.vaultId, receiverAddress, c.wethAddress, weth(1), true)
			})
		})
	})

	context("physical call paying a contract without the hook", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCallToToken())
		})

		it("pays and records the call as unacknowledged", async () => {
			await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(3000))
			const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
			await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(v.vaultId, c.usdcAddress, c.wethAddress, weth(1), false)
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.usdcAddress], [weth(1)])
		})
	})

	for (const { size, acknowledged, load } of oddSizeReceivers) {
		context(`physical call paying a contract that returns the hook selector in ${size} bytes`, () => {
			beforeEach(async () => {
				;({ c, v, receiverAddress } = await load())
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(3000))
			})

			it(`records the call as ${acknowledged ? "acknowledged" : "unacknowledged"}`, async () => {
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1)))
					.to.emit(c.hub, "PayoutNotified")
					.withArgs(v.vaultId, receiverAddress, c.wethAddress, weth(1), acknowledged)
			})
		})
	}

	context("physical call paying a receiver contract", () => {
		beforeEach(async () => {
			;({ c, v, receiver, receiverAddress } = await physicalCallToReceiver())
		})

		it("notifies the recipient after the tokens arrive", async () => {
			await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(12_000))
			const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(v.vaultId, receiverAddress, c.wethAddress, weth(4), true)
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [receiverAddress, v.vaultAddress], [weth(4), -weth(4)])
			expect(await receiver.calls()).to.equal(1n)
			expect(await receiver.lastCaller()).to.equal(c.hubAddress)
			expect(await receiver.lastVaultId()).to.equal(v.vaultId)
			expect(await receiver.lastToken()).to.equal(c.wethAddress)
			expect(await receiver.lastAmount()).to.equal(weth(4))
			expect(await receiver.balanceSeen()).to.equal(weth(4))
			expect(await receiver.phaseSeen()).to.equal(Phase.Live)
		})

		it("notifies after the last exercise settles the vault", async () => {
			await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(30_000))
			const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
			await expect(tx).to.emit(c.hub, "Settled")
			await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(v.vaultId, receiverAddress, c.wethAddress, weth(10), true)
			expect(await receiver.phaseSeen()).to.equal(Phase.Settled)
		})

		it("notifies at the estimated gas limit", async () => {
			await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(3000))
			const estimate = await c.hub.connect(c.marketMaker).exercise.estimateGas(v.vaultId, weth(1))
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1), { gasLimit: estimate }))
				.to.emit(c.hub, "PayoutNotified")
				.withArgs(v.vaultId, receiverAddress, c.wethAddress, weth(1), true)
		})

		for (const { name, mode } of [
			{ name: "reverts", mode: PayoutReceiverMode.Revert },
			{ name: "returns the wrong magic value", mode: PayoutReceiverMode.WrongMagic },
		]) {
			context(`when the hook ${name}`, () => {
				beforeEach(async () => {
					await receiver.setMode(mode)
				})

				it("still pays and records the call as unacknowledged", async () => {
					await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(3000))
					const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
					await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(v.vaultId, receiverAddress, c.wethAddress, weth(1), false)
					await expect(tx).to.changeTokenBalances(ethers, c.weth, [receiverAddress], [weth(1)])
					expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(9))
				})
			})
		}

		context("when the hook runs out of gas", () => {
			beforeEach(async () => {
				await receiver.setMode(PayoutReceiverMode.BurnGas)
			})

			it("reverts the exercise so gas estimates always cover the hook", async () => {
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(3000))
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1), { gasLimit: 1_000_000 })).to.be.revertedWithCustomError(
					c.hub,
					"PayoutHookOutOfGas",
				)
			})
		})

		context("after an unwind with a refund to the market maker", () => {
			beforeEach(async () => {
				const deadline = BigInt(await networkHelpers.time.latest()) + 86_400n
				const { agreement, signature } = await proposeUnwind(c, v.vaultId, deadline, usdc(100))
				await c.hub.connect(c.alice).approveUnwind(v.vaultId, agreement.nonce)
				await fund(c, c.usdc, c.alice, v.vaultAddress, usdc(100))
				await c.hub.connect(c.alice).fundUnwind(v.vaultId, agreement.nonce, usdc(100))
				await c.hub.executeUnwind(v.vaultId, agreement.nonce, signature)
			})

			it("notifies the refund claim in the premium token", async () => {
				const tx = c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
				await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(v.vaultId, receiverAddress, c.usdcAddress, usdc(100), true)
				await expect(tx).to.changeTokenBalances(ethers, c.usdc, [receiverAddress], [usdc(100)])
				expect(await receiver.calls()).to.equal(1n)
			})
		})
	})

	context("cash American call paying a receiver contract", () => {
		beforeEach(async () => {
			;({ c, v, receiver, receiverAddress } = await cashAmericanCallToReceiver())
			await setExercisePrice(c, v.vaultId, usdc(3300))
		})

		it("notifies an exercise payout in the collateral token", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10)))
				.to.emit(c.hub, "PayoutNotified")
				.withArgs(v.vaultId, receiverAddress, c.wethAddress, CASH_PAYOUT, true)
			expect(await receiver.balanceSeen()).to.equal(CASH_PAYOUT)
			expect(await receiver.phaseSeen()).to.equal(Phase.Settled)
		})
	})

	context("cash European call paying a receiver contract, in the money at expiry", () => {
		beforeEach(async () => {
			;({ c, v, receiver, receiverAddress } = await cashEuropeanCallToReceiverInTheMoney())
		})

		it("does not notify on settleAtExpiry", async () => {
			await expect(c.hub.settleAtExpiry(v.vaultId)).to.not.emit(c.hub, "PayoutNotified")
		})

		context("once settled", () => {
			beforeEach(async () => {
				await c.hub.settleAtExpiry(v.vaultId)
			})

			it("pays the claimed payout to the recipient", async () => {
				const tx = c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
				await expect(tx).to.emit(c.hub, "PayoutClaimed").withArgs(v.vaultId, c.marketMaker.address, CASH_PAYOUT)
				await expect(tx).to.changeTokenBalances(ethers, c.weth, [receiverAddress], [CASH_PAYOUT])
				expect((await c.hub.stateOf(v.vaultId)).pendingPayout).to.equal(0n)
			})

			it("notifies the recipient once when the payout is claimed", async () => {
				await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId))
					.to.emit(c.hub, "PayoutNotified")
					.withArgs(v.vaultId, receiverAddress, c.wethAddress, CASH_PAYOUT, true)
				expect(await receiver.calls()).to.equal(1n)
			})

			context("when the hook re-enters claimPayout", () => {
				beforeEach(async () => {
					await receiver.setMode(PayoutReceiverMode.Reenter)
				})

				it("still pays and records the call as unacknowledged", async () => {
					const tx = c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
					await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(v.vaultId, receiverAddress, c.wethAddress, CASH_PAYOUT, false)
					await expect(tx).to.changeTokenBalances(ethers, c.weth, [receiverAddress], [CASH_PAYOUT])
				})

				it("rejects a second payout claim", async () => {
					await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
					await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NothingToClaim")
				})
			})
		})
	})
})
