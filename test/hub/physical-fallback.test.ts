import { expect } from "chai"
import type { ContractTransactionResponse, TransactionReceipt } from "ethers"
import { network } from "hardhat"

import { at, goLive, setExercisePrice, type LiveVault } from "../helpers/scenarios.js"
import {
	AUCTION_TIMEOUT,
	EXERCISE_WINDOW,
	EXPIRY_PRICE_PUBLICATION_WINDOW,
	ExerciseStyle,
	Phase,
	SettlementRoute,
	SettlementType,
	deployIvy,
	fixture,
	fund,
	usdc,
	weth,
	PayoutReceiverMode,
	type IvyContext,
} from "../helpers/setup.js"
import { proposeUnwind } from "../helpers/unwind.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

const ONE_DAY = 24n * 3600n

/** Without an expiry price by this time, the physical fallback opens. */
const publicationDeadline = (v: LiveVault) => v.bid.expiry + EXPIRY_PRICE_PUBLICATION_WINDOW
/** The physical fallback closes here and the unexercised remainder may lapse. */
const fallbackDeadline = (v: LiveVault) => publicationDeadline(v) + EXERCISE_WINDOW

const deployed = fixture(connection, () => deployIvy(connection))
const physicalCall = fixture(deployed, async c => ({ c, v: await goLive(c) }))
const cashCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash }),
}))
const cashPut = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash }),
}))
/** Twice the exercise window, so neither window can stand in for the other. */
const TWO_HOUR_PUBLICATION_WINDOW = 2n * EXERCISE_WINDOW
const cashCallWithTwoHourPublication = fixture(deployed, async c => {
	await c.hub.setVaultWindowDefaults(EXERCISE_WINDOW, AUCTION_TIMEOUT, TWO_HOUR_PUBLICATION_WINDOW)
	return { c, v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash }) }
})
const cashEuropeanCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European }),
}))
const cashEuropeanPut = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European }),
}))
const fullOnlyCashPut = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { isCall: false, withFeed: true, terms: { allowPartialExercise: false } }, { settlement: SettlementType.Cash }),
}))
const cashCallPayingReceiver = fixture(deployed, async c => {
	const receiver = await ethers.deployContract("PayoutReceiver", [c.hubAddress])
	const receiverAddress = await receiver.getAddress()
	return {
		c,
		receiver,
		receiverAddress,
		v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, recipient: receiverAddress }),
	}
})
type PayoutReceiver = Awaited<ReturnType<typeof cashCallPayingReceiver>>["receiver"]

const cashVaults = [
	{ name: "American call", isCall: true, load: cashCall },
	{ name: "American put", isCall: false, load: cashPut },
	{ name: "European call", isCall: true, load: cashEuropeanCall },
	{ name: "European put", isCall: false, load: cashEuropeanPut },
]

// 333,333,334 wei at 3,000 USDC per WETH is 1.000000002 quote units: a call pays 2, a put receives 1.
const SUB_UNIT_AMOUNT = 333_333_334n
const subUnitExercises = [
	{ name: "call", isCall: true, load: cashCall, rounding: "rounds the strike paid up", paid: 2n, got: SUB_UNIT_AMOUNT },
	{
		name: "put",
		isCall: false,
		load: cashPut,
		rounding: "rounds the strike received down",
		paid: SUB_UNIT_AMOUNT,
		got: 1n,
	},
]

const delegatedCashVaults = [
	// One WETH of notional costs the strike on a call and the underlying itself on a put.
	{ name: "call", isCall: true, needed: usdc(3000) },
	{ name: "put", isCall: false, needed: weth(1) },
].map(vault => ({
	...vault,
	load: fixture(deployed, async c => ({
		c,
		v: await goLive(
			c,
			{ isCall: vault.isCall, withFeed: true },
			{ settlement: SettlementType.Cash, executor: c.bob.address, recipient: c.carol.address },
		),
	})),
}))

const finalizedCashCalls = [
	{
		name: "cash exercise",
		load: fixture(cashCall, async ({ c, v }) => {
			await setExercisePrice(c, v.vaultId, usdc(6000))
			await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
			return { c, v }
		}),
	},
	{
		name: "unwind",
		load: fixture(cashCall, async ({ c, v }) => {
			const { agreement, signature } = await proposeUnwind(c, v.vaultId, v.bid.expiry, 0n)
			await c.hub.connect(c.alice).approveUnwind(v.vaultId, agreement.nonce)
			await c.hub.executeUnwind(v.vaultId, agreement.nonce, signature)
			return { c, v }
		}),
	},
]

const routeTimeline = [
	{ name: "at expiry", time: (v: LiveVault) => v.bid.expiry, route: "AwaitingExpiryPrice", canSettleAtExpiry: false },
	{
		name: "one second before the publication deadline",
		time: (v: LiveVault) => publicationDeadline(v) - 1n,
		route: "AwaitingExpiryPrice",
		canSettleAtExpiry: false,
	},
	{ name: "at the publication deadline", time: publicationDeadline, route: "PhysicalFallback", canSettleAtExpiry: false },
	{
		name: "one second before the fallback deadline",
		time: (v: LiveVault) => fallbackDeadline(v) - 1n,
		route: "PhysicalFallback",
		canSettleAtExpiry: false,
	},
	{ name: "at the fallback deadline", time: fallbackDeadline, route: "FallbackExpired", canSettleAtExpiry: true },
] as const

const expiryPrices = [
	{ name: "an in-the-money", inTheMoney: true },
	{ name: "an out-of-the-money", inTheMoney: false },
]

const sameBlockOrders = [
	{ name: "the expiry price", publishFirst: true },
	{ name: "the fallback exercise", publishFirst: false },
]

// After 4 of 10 WETH go through the fallback, the LPs split 6 WETH + 12,000 USDC on a call and
// 4 WETH + 18,000 USDC on a put. alice holds 60% of the shares.
const twoLpCashVaults = [
	{
		name: "call",
		isCall: true,
		aliceShares: weth(6),
		bobShares: weth(4),
		aliceQuote: usdc(7200),
		aliceUnderlying: weth(36) / 10n,
	},
	{
		name: "put",
		isCall: false,
		aliceShares: usdc(18_000),
		bobShares: usdc(12_000),
		aliceQuote: usdc(10_800),
		aliceUnderlying: weth(24) / 10n,
	},
].map(vault => ({
	...vault,
	load: fixture(deployed, async c => {
		await c.hub.setPlatformFeeBps(200)
		return {
			c,
			v: await goLive(
				c,
				{
					isCall: vault.isCall,
					withFeed: true,
					deposit: vault.aliceShares,
					extraDeposits: [{ signer: c.bob, amount: vault.bobShares }],
				},
				{ settlement: SettlementType.Cash },
			),
		}
	}),
}))

describe("physical fallback", () => {
	describe("exercisePhysicalFallback", () => {
		let c: IvyContext
		let v: LiveVault

		context("cash American call", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
			})

			it("reverts at expiry", async () => {
				await at(c, v.bid.expiry)
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PhysicalFallbackUnavailable",
				)
			})

			it("reverts one second before the publication deadline", async () => {
				await at(c, publicationDeadline(v) - 1n)
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PhysicalFallbackUnavailable",
				)
			})

			it("exchanges the strike for the underlying at the publication deadline", async () => {
				await at(c, publicationDeadline(v))
				const tx = c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))
				await expect(tx).to.emit(c.hub, "PhysicalFallbackExercised").withArgs(v.vaultId, weth(1), usdc(3000), weth(1))
				await expect(tx).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1))
				await expect(tx).to.changeTokenBalance(ethers, c.usdc, c.marketMaker, -usdc(3000))
			})

			it("reverts at the fallback deadline", async () => {
				await at(c, fallbackDeadline(v))
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"ExerciseWindowClosed",
				)
			})

			it("reverts when cash exercise fails for want of an exercise price", async () => {
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PhysicalFallbackUnavailable",
				)
			})

			context("with a stale exercise price", () => {
				beforeEach(async () => {
					// Observed 4000 seconds ago against the vault's 3600-second maximum age.
					await setExercisePrice(c, v.vaultId, usdc(6000), 4000n)
				})

				it("reverts when cash exercise fails on the stale price", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "StalePrice")
					await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
						c.hub,
						"PhysicalFallbackUnavailable",
					)
				})
			})

			context("after a fallback exercise at the publication deadline", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(publicationDeadline(v))
					await c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))
				})

				it("keeps the cash settlement type", async () => {
					expect((await c.hub.stateOf(v.vaultId)).settlement).to.equal(SettlementType.Cash)
				})

				it("leaves the rest of the notional", async () => {
					expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(9))
				})

				it("rejects a late expiry price", async () => {
					await expect(c.hub.publishExpiry(v.vaultId, usdc(6000), publicationDeadline(v) + 100n)).to.be.revertedWithCustomError(
						c.hub,
						"ExpiryPricePublicationClosed",
					)
				})

				it("rejects cash exercise without an expiry price", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
				})
			})

			context("with an in-the-money exercise price", () => {
				beforeEach(async () => {
					await setExercisePrice(c, v.vaultId, usdc(6000))
				})

				it("pays a partial cash exercise in the underlying", async () => {
					// 4 WETH × (6000 − 3000) / 6000
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(2))
				})

				context("after a partial cash exercise, at the publication deadline", () => {
					beforeEach(async () => {
						await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
						await networkHelpers.time.increaseTo(publicationDeadline(v))
					})

					it("rejects more than the remaining notional", async () => {
						await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(7)))
							.to.be.revertedWithCustomError(c.hub, "ExceedsRemaining")
							.withArgs(weth(6))
					})

					it("settles on exercising the whole remainder", async () => {
						await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(6)))
							.to.emit(c.hub, "Settled")
							.withArgs(v.vaultId, weth(10), weth(10), 0n)
					})

					context("once the remainder is exercised", () => {
						beforeEach(async () => {
							await c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(6))
						})

						it("pays the LP the remaining collateral and the strike proceeds", async () => {
							// 10 WETH less 2 paid in cash and 6 delivered, plus 6 × 3000 USDC of strike.
							const claim = c.hub.connect(c.alice).claim(v.vaultId, weth(10))
							await expect(claim).to.changeTokenBalance(ethers, c.weth, c.alice, weth(2))
							await expect(claim).to.changeTokenBalance(ethers, c.usdc, c.alice, usdc(18_000))
						})

						it("reverts with WrongPhase", async () => {
							await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
								c.hub,
								"WrongPhase",
							)
						})

						it("rejects settleAtExpiry", async () => {
							await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "WrongPhase")
						})
					})
				})
			})
		})

		context("cash American call with a two-hour publication window", () => {
			const twoHourPublicationDeadline = (v: LiveVault) => v.bid.expiry + TWO_HOUR_PUBLICATION_WINDOW

			beforeEach(async () => {
				;({ c, v } = await cashCallWithTwoHourPublication())
			})

			it("reverts one second before the two-hour publication deadline", async () => {
				await at(c, twoHourPublicationDeadline(v) - 1n)
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PhysicalFallbackUnavailable",
				)
			})

			it("exercises at the two-hour publication deadline", async () => {
				await at(c, twoHourPublicationDeadline(v))
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1)))
					.to.emit(c.hub, "PhysicalFallbackExercised")
					.withArgs(v.vaultId, weth(1), usdc(3000), weth(1))
			})

			it("exercises in the last second of the exercise window after the publication deadline", async () => {
				await at(c, twoHourPublicationDeadline(v) + EXERCISE_WINDOW - 1n)
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1)))
					.to.emit(c.hub, "PhysicalFallbackExercised")
					.withArgs(v.vaultId, weth(1), usdc(3000), weth(1))
			})

			it("reverts with ExerciseWindowClosed one exercise window after the publication deadline", async () => {
				await at(c, twoHourPublicationDeadline(v) + EXERCISE_WINDOW)
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"ExerciseWindowClosed",
				)
			})
		})

		context("cash European call before expiry", () => {
			beforeEach(async () => {
				;({ c, v } = await cashEuropeanCall())
			})

			it("reverts while European cash exercise has not opened", async () => {
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ExerciseNotOpenYet")
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PhysicalFallbackUnavailable",
				)
			})
		})

		for (const { name, isCall, load } of cashVaults) {
			context(`cash ${name} in the last second of the fallback window`, () => {
				beforeEach(async () => {
					;({ c, v } = await load())
					if (!isCall) await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(4))
				})

				it("exercises part of the notional and pays the market maker", async () => {
					// 4 WETH of notional at the 3000 strike is 12,000 USDC.
					const [paid, got] = isCall ? [usdc(12_000), weth(4)] : [weth(4), usdc(12_000)]
					await at(c, fallbackDeadline(v) - 1n)
					const tx = c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(4))
					await expect(tx).to.emit(c.hub, "PhysicalFallbackExercised").withArgs(v.vaultId, weth(4), paid, got)
					await expect(tx).to.changeTokenBalance(ethers, isCall ? c.weth : c.usdc, c.marketMaker, got)
				})
			})
		}

		for (const { name, isCall, load, rounding, paid, got } of subUnitExercises) {
			context(`cash American ${name} exercising a sub-unit amount`, () => {
				beforeEach(async () => {
					;({ c, v } = await load())
					if (!isCall) await fund(c, c.weth, c.marketMaker, v.vaultAddress, SUB_UNIT_AMOUNT)
					await networkHelpers.time.increaseTo(publicationDeadline(v))
				})

				it(`${rounding} across 18-decimal underlying and 6-decimal quote`, async () => {
					await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, SUB_UNIT_AMOUNT))
						.to.emit(c.hub, "PhysicalFallbackExercised")
						.withArgs(v.vaultId, SUB_UNIT_AMOUNT, paid, got)
				})
			})
		}

		context("full-only cash put with a delegated executor and recipient", () => {
			beforeEach(async () => {
				;({ c, v } = await fullOnlyCashPut())
				await c.hub.connect(c.marketMaker).setExecution(v.vaultId, c.bob.address, c.carol.address)
				await fund(c, c.weth, c.bob, v.vaultAddress, weth(10))
				await networkHelpers.time.increaseTo(publicationDeadline(v))
			})

			it("rejects a caller other than the market maker or executor", async () => {
				await expect(c.hub.connect(c.alice).exercisePhysicalFallback(v.vaultId, weth(10))).to.be.revertedWithCustomError(c.hub, "NotExecutor")
			})

			it("rejects a partial exercise", async () => {
				await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PartialExerciseNotAllowed",
				)
			})

			it("rejects a zero amount", async () => {
				await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
			})

			it("takes the underlying from the executor, pays the strike to the recipient and settles", async () => {
				const tx = c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, weth(10))
				await expect(tx).to.changeTokenBalance(ethers, c.weth, c.bob, -weth(10))
				await expect(tx).to.changeTokenBalance(ethers, c.usdc, c.carol, usdc(30_000))
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Settled)
			})
		})

		for (const { name, isCall, needed, load } of delegatedCashVaults) {
			context(`cash ${name} with a delegated executor and recipient, at the publication deadline`, () => {
				let payment: IvyContext["usdc"]
				let collateral: IvyContext["usdc"]

				beforeEach(async () => {
					;({ c, v } = await load())
					;[payment, collateral] = isCall ? [c.usdc, c.weth] : [c.weth, c.usdc]
					await networkHelpers.time.increaseTo(publicationDeadline(v))
				})

				it("reverts without an allowance from the executor", async () => {
					await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
						payment,
						"ERC20InsufficientAllowance",
					)
				})

				context("with an allowance but no balance", () => {
					beforeEach(async () => {
						await payment.connect(c.bob).approve(v.vaultAddress, needed)
					})

					it("reverts for want of a balance", async () => {
						await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
							payment,
							"ERC20InsufficientBalance",
						)
					})
				})

				context("with an approved balance", () => {
					beforeEach(async () => {
						await fund(c, payment, c.bob, v.vaultAddress, needed)
					})

					it("exercises one unit of notional", async () => {
						await c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, weth(1))
						expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(9))
					})

					context("when the recipient is blocked", () => {
						beforeEach(async () => {
							await collateral.setBlockedRecipient(c.carol.address, true)
						})

						it("reverts and leaves the executor's balance and allowance untouched", async () => {
							await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
								collateral,
								"RecipientBlocked",
							)
							expect(await payment.balanceOf(c.bob.address)).to.equal(needed)
							expect(await payment.allowance(c.bob.address, v.vaultAddress)).to.equal(needed)
						})
					})

					context("when the payment token takes a 10% transfer fee", () => {
						beforeEach(async () => {
							await payment.setFeeBps(1000)
						})

						it("reverts on the short receipt and leaves funds, notional and reserves untouched", async () => {
							await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, weth(1)))
								.to.be.revertedWithCustomError(c.hub, "ShortReceived")
								.withArgs(needed, (needed * 9n) / 10n)
							expect(await payment.balanceOf(c.bob.address)).to.equal(needed)
							expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(10))
							expect((await c.hub.stateOf(v.vaultId)).pendingPayout).to.equal(0n)
							expect(await v.vault.buyerReserved(await collateral.getAddress())).to.equal(0n)
						})
					})
				})
			})
		}

		context("cash American call paying a contract recipient", () => {
			let receiver: PayoutReceiver
			let receiverAddress: string

			beforeEach(async () => {
				;({ c, v, receiver, receiverAddress } = await cashCallPayingReceiver())
				await networkHelpers.time.increaseTo(publicationDeadline(v))
			})

			it("settles before notifying the recipient of the full payout", async () => {
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(10)))
					.to.emit(c.hub, "PayoutNotified")
					.withArgs(v.vaultId, receiverAddress, c.wethAddress, weth(10), true)
				expect(await receiver.phaseSeen()).to.equal(Phase.Settled)
				expect(await receiver.balanceSeen()).to.equal(weth(10))
				expect(await receiver.calls()).to.equal(1n)
			})
		})

		context("cash American call after admissions pause, a settings change and a new publisher", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
				await c.hub.setAdmissionPause(0, true)
				await c.hub.setAdmissionPause(v.vaultId, true)
				await c.hub.setCashSettlementEnabled(false)
				await c.hub.setVaultWindowDefaults(0, 1, 1)
				const publisher = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
				await c.hub.revokeRole(publisher, c.admin.address)
				await c.hub.grantRole(publisher, c.bob.address)
			})

			it("rejects the new publisher's expiry price at the publication deadline", async () => {
				await at(c, publicationDeadline(v))
				await expect(c.hub.connect(c.bob).publishExpiry(v.vaultId, usdc(6000), fallbackDeadline(v))).to.be.revertedWithCustomError(
					c.hub,
					"ExpiryPricePublicationClosed",
				)
			})

			context("once the new publisher prices an exercise after the publication deadline", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(publicationDeadline(v))
					await c.hub.connect(c.bob).publishExercisePrice(v.vaultId, usdc(6000), v.bid.expiry, fallbackDeadline(v))
				})

				it("rejects cash exercise despite the fresh exercise price", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
				})

				context("once the new publisher is removed too", () => {
					beforeEach(async () => {
						await c.hub.revokeRole(await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), c.bob.address)
					})

					it("keeps the fixed fallback deadline", async () => {
						expect((await c.hub.settlementStatus(v.vaultId)).fallbackDeadline).to.equal(fallbackDeadline(v))
					})

					it("still exercises after the publication deadline", async () => {
						await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).not.to.be.revert(ethers)
					})

					context("after a fallback exercise", () => {
						beforeEach(async () => {
							await c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))
						})

						it("lets anyone settle at the fallback deadline", async () => {
							await at(c, fallbackDeadline(v))
							await expect(c.hub.connect(c.carol).settleAtExpiry(v.vaultId)).not.to.be.revert(ethers)
						})

						it("returns the unexercised collateral to the LPs once settled", async () => {
							await networkHelpers.time.increaseTo(fallbackDeadline(v))
							await c.hub.connect(c.carol).settleAtExpiry(v.vaultId)
							await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(10))).to.changeTokenBalance(ethers, c.weth, c.alice, weth(9))
						})
					})
				})
			})
		})

		for (const { name, load } of finalizedCashCalls) {
			context(`cash American call finalized by ${name}, at the publication deadline`, () => {
				beforeEach(async () => {
					;({ c, v } = await load())
					await networkHelpers.time.increaseTo(publicationDeadline(v))
				})

				it("reports the Inactive route", async () => {
					expect((await c.hub.settlementStatus(v.vaultId)).route).to.equal(SettlementRoute.Inactive)
				})

				it("reverts with WrongPhase", async () => {
					await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "WrongPhase")
				})

				it("rejects settleAtExpiry", async () => {
					await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "WrongPhase")
				})

				it("lets the LP claim only once", async () => {
					await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(10))).not.to.be.revert(ethers)
					await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(10))).to.be.revertedWithCustomError(c.hub, "InsufficientShares")
				})
			})
		}

		context("physical call at expiry", () => {
			beforeEach(async () => {
				;({ c, v } = await physicalCall())
				await networkHelpers.time.increaseTo(v.bid.expiry)
			})

			it("reverts while regular physical exercise stays open", async () => {
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PhysicalFallbackUnavailable",
				)
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).not.to.be.revert(ethers)
			})
		})

		context("physical call once its exercise window closes", () => {
			beforeEach(async () => {
				;({ c, v } = await physicalCall())
				await networkHelpers.time.increaseTo(v.bid.expiry + EXERCISE_WINDOW)
			})

			it("reverts with PhysicalFallbackUnavailable although no expiry price exists", async () => {
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
					c.hub,
					"PhysicalFallbackUnavailable",
				)
			})
		})
	})

	describe("settlementStatus", () => {
		let c: IvyContext
		let v: LiveVault

		context("cash American call", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
			})

			it("reports the cash route and the fixed deadlines before expiry", async () => {
				expect(await c.hub.settlementStatus(v.vaultId)).to.deep.equal([
					BigInt(SettlementRoute.Cash),
					publicationDeadline(v),
					fallbackDeadline(v),
					false,
				])
			})

			for (const step of routeTimeline) {
				it(`reports the ${step.route} route ${step.name}`, async () => {
					await networkHelpers.time.increaseTo(step.time(v))
					expect(await c.hub.settlementStatus(v.vaultId)).to.deep.equal([
						BigInt(SettlementRoute[step.route]),
						publicationDeadline(v),
						fallbackDeadline(v),
						step.canSettleAtExpiry,
					])
				})
			}

			it("reverts for an unknown vault", async () => {
				await expect(c.hub.settlementStatus(999)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
			})

			context("after lapsing at the fallback deadline", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(fallbackDeadline(v))
					await c.hub.settleAtExpiry(v.vaultId)
				})

				it("reports the Inactive route", async () => {
					expect((await c.hub.settlementStatus(v.vaultId)).route).to.equal(SettlementRoute.Inactive)
				})
			})
		})

		context("physical call at expiry", () => {
			beforeEach(async () => {
				;({ c, v } = await physicalCall())
				await networkHelpers.time.increaseTo(v.bid.expiry)
			})

			it("reports the Physical route", async () => {
				expect((await c.hub.settlementStatus(v.vaultId)).route).to.equal(SettlementRoute.Physical)
			})
		})
	})

	describe("publishExpiry", () => {
		let c: IvyContext
		let v: LiveVault

		context("cash American call at the publication deadline", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
			})

			it("rejects the expiry price even as the first interaction, leaving the fallback open", async () => {
				await at(c, publicationDeadline(v))
				await expect(c.hub.publishExpiry(v.vaultId, usdc(6000), publicationDeadline(v) + 100n)).to.be.revertedWithCustomError(
					c.hub,
					"ExpiryPricePublicationClosed",
				)
				await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.emit(c.hub, "PhysicalFallbackExercised")
				await expect(c.hub.settlementPrice(v.vaultId)).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
			})

			for (const { name, publishFirst } of sameBlockOrders) {
				context(`in one block with a fallback exercise, ${name} sent first`, () => {
					let publication: TransactionReceipt
					let fallbackExercise: TransactionReceipt

					beforeEach(async () => {
						await ethers.provider.send("evm_setAutomine", [false])
						// Explicit gas limits skip estimation, which would run before the deadline and reject the fallback.
						const sendPublication = () => c.hub.publishExpiry(v.vaultId, usdc(6000), publicationDeadline(v) + 100n, { gasLimit: 500_000 })
						const sendExercise = () => c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1), { gasLimit: 500_000 })
						let publishTx: ContractTransactionResponse
						let exerciseTx: ContractTransactionResponse
						if (publishFirst) {
							publishTx = await sendPublication()
							exerciseTx = await sendExercise()
						} else {
							exerciseTx = await sendExercise()
							publishTx = await sendPublication()
						}
						await at(c, publicationDeadline(v))
						await ethers.provider.send("evm_mine", [])
						publication = (await ethers.provider.getTransactionReceipt(publishTx.hash))!
						fallbackExercise = (await ethers.provider.getTransactionReceipt(exerciseTx.hash))!
					})

					afterEach(async () => {
						await ethers.provider.send("evm_setAutomine", [true])
					})

					it("mines both in the block at the publication deadline", async () => {
						expect(publication.blockNumber).to.equal(fallbackExercise.blockNumber)
						expect((await ethers.provider.getBlock(publication.blockNumber))!.timestamp).to.equal(Number(publicationDeadline(v)))
					})

					it("rejects the expiry price and accepts the fallback exercise", () => {
						expect(publication.status).to.equal(0)
						expect(fallbackExercise.status).to.equal(1)
					})

					it("records the fallback exercise", async () => {
						expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(9))
					})

					it("stores no expiry price", async () => {
						await expect(c.hub.settlementPrice(v.vaultId)).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
					})
				})
			}
		})
	})

	describe("settleAtExpiry", () => {
		let c: IvyContext
		let v: LiveVault

		context("cash American call without an expiry price", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
			})

			it("opens at the fallback deadline", async () => {
				expect(await c.hub.settleAtExpiryTimeOf(v.vaultId)).to.equal(fallbackDeadline(v))
			})

			it("reverts at expiry", async () => {
				await at(c, v.bid.expiry)
				await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "TooEarlyToSettle")
			})

			context("at the fallback deadline", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(fallbackDeadline(v))
				})

				it("lapses the unexercised notional", async () => {
					await expect(c.hub.settleAtExpiry(v.vaultId)).to.emit(c.hub, "PhysicalFallbackExpired").withArgs(v.vaultId, weth(10))
				})
			})

			context("a day after the fallback deadline", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(fallbackDeadline(v) + ONE_DAY)
				})

				it("lets an unrelated caller settle with nothing exercised or reserved", async () => {
					await expect(c.hub.connect(c.carol).settleAtExpiry(v.vaultId)).to.emit(c.hub, "Settled").withArgs(v.vaultId, 0n, weth(10), 0n)
					expect(await v.vault.buyerReserved(c.wethAddress)).to.equal(0n)
				})

				context("once settled", () => {
					beforeEach(async () => {
						await c.hub.connect(c.carol).settleAtExpiry(v.vaultId)
					})

					it("returns all collateral to the LPs", async () => {
						await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(10))).to.changeTokenBalance(ethers, c.weth, c.alice, weth(10))
						expect(await c.hub.totalShares(v.vaultId)).to.equal(0n)
					})
				})
			})
		})

		for (const { name, isCall, load } of cashVaults) {
			context(`cash ${name}`, () => {
				context("after a partial fallback exercise in the last second of the window", () => {
					beforeEach(async () => {
						;({ c, v } = await load())
						if (!isCall) await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(4))
						await at(c, fallbackDeadline(v) - 1n)
						await c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(4))
					})

					it("lets anyone lapse the remainder at the fallback deadline", async () => {
						await at(c, fallbackDeadline(v))
						await expect(c.hub.connect(c.carol).settleAtExpiry(v.vaultId))
							.to.emit(c.hub, "PhysicalFallbackExpired")
							.withArgs(v.vaultId, weth(6))
							.and.to.emit(c.hub, "Settled")
							.withArgs(v.vaultId, weth(4), weth(10), 0n)
					})

					context("once lapsed", () => {
						beforeEach(async () => {
							await networkHelpers.time.increaseTo(fallbackDeadline(v))
							await c.hub.connect(c.carol).settleAtExpiry(v.vaultId)
						})

						it("pays the LP the unexercised collateral and the strike proceeds, keeping the premium back", async () => {
							// A call keeps 6 WETH and receives 12,000 USDC; a put keeps 18,000 USDC and receives 4 WETH.
							const claim = c.hub.connect(c.alice).claim(v.vaultId, v.deposit)
							await expect(claim).to.changeTokenBalance(ethers, c.weth, c.alice, isCall ? weth(6) : weth(4))
							await expect(claim).to.changeTokenBalance(ethers, c.usdc, c.alice, isCall ? usdc(12_000) : usdc(18_000))
							// The 1,000 USDC premium stays in the vault for claimPremium.
							expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(1000))
						})

						it("leaves the market maker nothing to claim", async () => {
							await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NothingToClaim")
						})
					})
				})

				for (const { name: priceName, inTheMoney } of expiryPrices) {
					context(`with ${priceName} expiry price published in time, a day after the fallback deadline`, () => {
						const price = isCall === inTheMoney ? usdc(6000) : usdc(1500)
						// In the money, a call pays 10 WETH × (6000 − 3000) / 6000 and a put 10 × (3000 − 1500) USDC.
						const payout = inTheMoney ? (isCall ? weth(5) : usdc(15_000)) : 0n

						beforeEach(async () => {
							;({ c, v } = await load())
							await at(c, publicationDeadline(v) - 1n)
							await c.hub.publishExpiry(v.vaultId, price, publicationDeadline(v) - 1n)
							await networkHelpers.time.increaseTo(fallbackDeadline(v) + ONE_DAY)
						})

						it("still opens at the option expiry", async () => {
							expect(await c.hub.settleAtExpiryTimeOf(v.vaultId)).to.equal(v.bid.expiry)
						})

						it("keeps the cash route and allows settling", async () => {
							expect(await c.hub.settlementStatus(v.vaultId)).to.deep.equal([
								BigInt(SettlementRoute.Cash),
								publicationDeadline(v),
								fallbackDeadline(v),
								true,
							])
						})

						it("rejects a physical fallback exercise", async () => {
							await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(1))).to.be.revertedWithCustomError(
								c.hub,
								"PhysicalFallbackUnavailable",
							)
						})

						it("settles at the expiry price and reserves its payout", async () => {
							await expect(c.hub.settleAtExpiry(v.vaultId)).to.emit(c.hub, "Settled").withArgs(v.vaultId, weth(10), weth(10), payout)
							expect(await v.vault.buyerReserved(isCall ? c.wethAddress : c.usdcAddress)).to.equal(payout)
						})
					})
				}
			})
		}

		context("cash American call paying an unresponsive contract recipient", () => {
			let receiver: PayoutReceiver

			beforeEach(async () => {
				;({ c, v, receiver } = await cashCallPayingReceiver())
				await receiver.setMode(PayoutReceiverMode.BurnGas)
			})

			it("lapses at the fallback deadline without calling the recipient", async () => {
				await at(c, fallbackDeadline(v))
				// A bounded limit: any call into the gas-burning recipient would exhaust it and revert the expiry.
				await expect(c.hub.connect(c.carol).settleAtExpiry(v.vaultId, { gasLimit: 300_000 })).to.not.emit(c.hub, "PayoutNotified")
				expect(await receiver.calls()).to.equal(0n)
			})

			context("once lapsed", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(fallbackDeadline(v))
					await c.hub.connect(c.carol).settleAtExpiry(v.vaultId)
				})

				it("returns all collateral to the LPs", async () => {
					await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(10))).to.changeTokenBalance(ethers, c.weth, c.alice, weth(10))
				})
			})
		})

		context("physical call", () => {
			beforeEach(async () => {
				;({ c, v } = await physicalCall())
			})

			it("opens one exercise window after expiry", async () => {
				expect(await c.hub.settleAtExpiryTimeOf(v.vaultId)).to.equal(v.bid.expiry + EXERCISE_WINDOW)
			})

			context("after a physical exercise at expiry", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(v.bid.expiry)
					await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
				})

				it("settles at the end of the exercise window", async () => {
					await at(c, v.bid.expiry + EXERCISE_WINDOW)
					await expect(c.hub.settleAtExpiry(v.vaultId)).not.to.be.revert(ethers)
				})
			})
		})
	})

	describe("claim", () => {
		let c: IvyContext
		let v: LiveVault

		for (const { name, isCall, aliceShares, bobShares, aliceQuote, aliceUnderlying, load } of twoLpCashVaults) {
			context(`cash ${name} shared by two LPs, with a 2% platform fee and a funded unwind, after a partial fallback lapses`, () => {
				let unwindNonce: bigint

				beforeEach(async () => {
					;({ c, v } = await load())
					// An unwind still open past F that only alice funds, with her 60% of its 100 USDC refund, so it
					// never executes.
					const { agreement } = await proposeUnwind(c, v.vaultId, fallbackDeadline(v) + 1000n, usdc(100))
					unwindNonce = agreement.nonce
					await fund(c, c.usdc, c.alice, v.vaultAddress, usdc(60))
					await c.hub.connect(c.alice).fundUnwind(v.vaultId, unwindNonce, usdc(60))
					if (!isCall) await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(4))
					await networkHelpers.time.increaseTo(publicationDeadline(v))
					await c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, weth(4))
					await networkHelpers.time.increaseTo(fallbackDeadline(v))
					await c.hub.connect(c.carol).settleAtExpiry(v.vaultId)
				})

				it("pays an LP their share of the collateral and strike proceeds only", async () => {
					const claim = c.hub.connect(c.alice).claim(v.vaultId, aliceShares)
					await expect(claim).to.changeTokenBalance(ethers, c.usdc, c.alice, aliceQuote)
					await expect(claim).to.changeTokenBalance(ethers, c.weth, c.alice, aliceUnderlying)
				})

				context("once both LPs claim", () => {
					beforeEach(async () => {
						await c.hub.connect(c.alice).claim(v.vaultId, aliceShares)
						await c.hub.connect(c.bob).claim(v.vaultId, bobShares)
					})

					it("leaves only the premium, platform fee and unwind contribution in the vault", async () => {
						// 1,000 USDC premium (980 for the LPs, 20 platform fee) plus the 60 USDC unwind contribution.
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(1060))
						expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(0n)
						expect(await v.vault.buyerReserved(c.usdcAddress)).to.equal(0n)
					})

					it("pays the premium to the LPs pro rata", async () => {
						await expect(c.hub.connect(c.alice).claimPremium(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.alice, usdc(588))
						await expect(c.hub.connect(c.bob).claimPremium(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.bob, usdc(392))
					})

					it("pays the platform fee to the admin", async () => {
						await expect(v.vault.claimPlatformFee()).to.changeTokenBalance(ethers, c.usdc, c.admin, usdc(20))
					})

					it("returns the unwind contribution", async () => {
						await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, unwindNonce)).to.changeTokenBalance(
							ethers,
							c.usdc,
							c.alice,
							usdc(60),
						)
					})

					it("empties the vault once the premium, fee and contribution are collected", async () => {
						await c.hub.connect(c.alice).claimPremium(v.vaultId)
						await c.hub.connect(c.bob).claimPremium(v.vaultId)
						await v.vault.claimPlatformFee()
						await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, unwindNonce)
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
					})

					it("rejects a second claim", async () => {
						await expect(c.hub.connect(c.alice).claim(v.vaultId, aliceShares)).to.be.revertedWithCustomError(c.hub, "InsufficientShares")
					})
				})
			})
		}
	})
})
