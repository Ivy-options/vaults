import { expect } from "chai"
import { Interface, ZeroAddress } from "ethers"
import { network } from "hardhat"

import { PREMIUM_TOTAL, activate, at, goLive, openVault, publishExpiryPrice, setExercisePrice, type LiveVault } from "../helpers/scenarios.js"
import {
	EXERCISE_WINDOW,
	ExerciseStyle,
	Phase,
	SettlementPolicy,
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

// A 3300 spot against the 3000 strike pays 4 WETH × 300 / 3300 in WETH.
const CASH_CALL_PAYOUT_FOUR = 363_636_363_636_363_636n

const exerciseStyles = [
	{ name: "American", style: ExerciseStyle.American },
	{ name: "European", style: ExerciseStyle.European },
]
const settlementTypes = [
	{ name: "physical", settlement: SettlementType.Physical },
	{ name: "cash", settlement: SettlementType.Cash },
]
const optionKinds = [
	{ name: "put", isCall: false },
	{ name: "call", isCall: true },
]
const optionScenarios = exerciseStyles.flatMap(({ name: styleName, style }) =>
	settlementTypes.flatMap(({ name: settlementName, settlement }) =>
		optionKinds.map(({ name: kindName, isCall }) => ({
			name: `${styleName} ${settlementName} ${kindName}`,
			style,
			settlement,
			isCall,
		})),
	),
)
const partialPolicies = [
	{ name: "when partial exercise is forbidden", allowPartialExercise: false },
	{ name: "when partial exercise is allowed", allowPartialExercise: true },
]

const deployed = fixture(connection, () => deployIvy(connection))
const physicalCall = fixture(deployed, async c => ({ c, v: await goLive(c) }))
const physicalEuropeanCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, {}, { style: ExerciseStyle.European }),
}))
const physicalCallWithDaiPremium = fixture(deployed, async c => {
	const opened = await openVault(c, { premiumToken: c.daiAddress })
	await fund(c, c.dai, c.marketMaker, opened.vaultAddress, PREMIUM_TOTAL)
	return { c, v: { ...opened, ...(await activate(c, opened.vaultId, opened.vaultAddress)) } }
})
const physicalPut = fixture(deployed, async c => ({ c, v: await goLive(c, { isCall: false }) }))
const delegatedPhysicalCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, {}, { executor: c.bob.address, recipient: c.carol.address }),
}))
const cashCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash }),
}))
const cashPut = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash }),
}))
const cashEuropeanCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European }),
}))
const cashOnlyCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { terms: { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 3600 } }, { settlement: SettlementType.Cash }),
}))

describe("exercise", () => {
	let c: IvyContext
	let v: LiveVault

	context("physical American call", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
			// The full 10 WETH at the 3000 strike.
			await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(30_000))
		})

		it("pays the strike in quote and receives the exercised collateral", async () => {
			const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			await expect(tx).to.emit(c.hub, "Exercised").withArgs(v.vaultId, weth(4), usdc(12_000), weth(4))
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.marketMaker, v.vaultAddress], [weth(4), -weth(4)])
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.marketMaker, v.vaultAddress], [-usdc(12_000), usdc(12_000)])
		})

		it("keeps the vault live with the unexercised notional after a partial exercise", async () => {
			await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(6))
			expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
		})

		it("rounds the quote payment up", async () => {
			// 1 wei of WETH at 3000 USDC owes a fraction of a USDC unit, rounded up to 1.
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, 1n)).to.emit(c.hub, "Exercised").withArgs(v.vaultId, 1n, 1n, 1n)
		})

		it("settles the vault on a full exercise", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10)))
				.to.emit(c.hub, "Settled")
				.withArgs(v.vaultId, weth(10), weth(10), 0n)
			expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Settled)
			expect(await c.hub.remainingNotional(v.vaultId)).to.equal(0n)
		})

		it("reverts with ExceedsRemaining above the remaining notional", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(11)))
				.to.be.revertedWithCustomError(c.hub, "ExceedsRemaining")
				.withArgs(weth(10))
		})

		it("rejects a caller who is neither the market maker nor the executor", async () => {
			await expect(c.hub.connect(c.alice).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "NotExecutor")
		})

		it("reverts on a zero amount", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
		})

		it("reverts when the quote arrives short", async () => {
			await c.usdc.setFeeBps(100n)
			// A 1% transfer fee leaves the vault 11,880 of the 12,000 USDC paid.
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4)))
				.to.be.revertedWithCustomError(v.vault, "ShortReceived")
				.withArgs(usdc(12_000), usdc(11_880))
		})

		it("exercises in the last second of the exercise window", async () => {
			await at(c, v.bid.expiry + EXERCISE_WINDOW - 1n)
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).not.to.be.revert(ethers)
		})

		it("reverts with ExerciseWindowClosed once the window closes", async () => {
			await at(c, v.bid.expiry + EXERCISE_WINDOW)
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ExerciseWindowClosed")
		})

		context("once fully exercised", () => {
			beforeEach(async () => {
				await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
			})

			it("reverts with WrongPhase", async () => {
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, 1n))
					.to.be.revertedWithCustomError(c.hub, "WrongPhase")
					.withArgs(Phase.Live, Phase.Settled)
			})
		})
	})

	context("physical European call", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalEuropeanCall())
			await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(30_000))
		})

		it("reverts with ExerciseNotOpenYet before expiry", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ExerciseNotOpenYet")
		})

		it("exercises from the expiry second", async () => {
			await at(c, v.bid.expiry)
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).not.to.be.revert(ethers)
		})

		it("reverts with ExerciseWindowClosed once the window closes", async () => {
			await at(c, v.bid.expiry + EXERCISE_WINDOW)
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ExerciseWindowClosed")
		})
	})

	context("physical American call with its premium in DAI", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCallWithDaiPremium())
		})

		it("pays the strike in the quote token, not the premium token", async () => {
			const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.marketMaker, v.vaultAddress], [-usdc(12_000), usdc(12_000)])
			await expect(tx).to.changeTokenBalances(ethers, c.dai, [c.marketMaker, v.vaultAddress], [0n, 0n])
		})
	})

	context("physical put", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalPut())
			await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(4))
		})

		it("delivers the underlying and receives the strike in quote", async () => {
			const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			await expect(tx).to.emit(c.hub, "Exercised").withArgs(v.vaultId, weth(4), weth(4), usdc(12_000))
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.marketMaker, v.vaultAddress], [-weth(4), weth(4)])
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.marketMaker, v.vaultAddress], [usdc(12_000), -usdc(12_000)])
		})

		it("keeps the unexercised notional", async () => {
			await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(6))
		})
	})

	context("physical call with a delegated executor", () => {
		beforeEach(async () => {
			;({ c, v } = await delegatedPhysicalCall())
		})

		it("reverts when the executor has not approved the strike", async () => {
			await expect(c.hub.connect(c.bob).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.usdc, "ERC20InsufficientAllowance")
		})

		it("lets the executor exercise and delivers the collateral to the recipient", async () => {
			await fund(c, c.usdc, c.bob, v.vaultAddress, usdc(3000))
			await c.hub.connect(c.bob).exercise(v.vaultId, weth(1))
			expect(await c.weth.balanceOf(c.carol.address)).to.equal(weth(1))
			expect(await c.weth.balanceOf(c.bob.address)).to.equal(0n)
		})
	})

	context("cash American call", () => {
		beforeEach(async () => {
			;({ c, v } = await cashCall())
		})

		context("in the money", () => {
			beforeEach(async () => {
				await setExercisePrice(c, v.vaultId, usdc(3300))
			})

			it("pays the intrinsic value in the underlying without taking quote", async () => {
				const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
				await expect(tx).to.emit(c.hub, "Exercised").withArgs(v.vaultId, weth(4), 0n, CASH_CALL_PAYOUT_FOUR)
				await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.marketMaker, v.vaultAddress], [CASH_CALL_PAYOUT_FOUR, -CASH_CALL_PAYOUT_FOUR])
			})

			it("keeps the unexercised notional", async () => {
				await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
				expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(6))
			})
		})

		it("reverts with NothingToExercise out of the money", async () => {
			await setExercisePrice(c, v.vaultId, usdc(2900))
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "NothingToExercise")
		})

		it("reverts with StalePrice on an observation past the maximum age", async () => {
			// Published already 3601 seconds old, so past the 3600-second limit by the time exercise runs.
			await setExercisePrice(c, v.vaultId, usdc(3300), 3601n)
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "StalePrice")
		})

		context("with a spot observation just before expiry", () => {
			beforeEach(async () => {
				await networkHelpers.time.increaseTo(v.bid.expiry - 3n)
				await setExercisePrice(c, v.vaultId, usdc(3300))
			})

			it("exercises at the spot one second before expiry", async () => {
				await at(c, v.bid.expiry - 1n)
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).not.to.be.revert(ethers)
			})

			it("reverts with ReportUnavailable from the expiry second without an expiry report", async () => {
				await at(c, v.bid.expiry)
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
			})
		})
	})

	context("cash American put", () => {
		beforeEach(async () => {
			;({ c, v } = await cashPut())
			await setExercisePrice(c, v.vaultId, usdc(2700))
		})

		it("pays the intrinsic value in quote", async () => {
			const tx = c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
			// 4 WETH × (3000 − 2700)
			await expect(tx).to.emit(c.hub, "Exercised").withArgs(v.vaultId, weth(4), 0n, usdc(1200))
			await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.marketMaker, v.vaultAddress], [usdc(1200), -usdc(1200)])
		})
	})

	context("cash European call", () => {
		beforeEach(async () => {
			;({ c, v } = await cashEuropeanCall())
			await setExercisePrice(c, v.vaultId, usdc(3300))
		})

		it("reverts with ExerciseNotOpenYet before expiry", async () => {
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ExerciseNotOpenYet")
		})

		it("reverts with ReportUnavailable at expiry without an expiry report", async () => {
			await at(c, v.bid.expiry)
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
		})
	})

	context("cash American call with an observation still valid at expiry", () => {
		beforeEach(async () => {
			;({ c, v } = await cashOnlyCall())
			await at(c, v.bid.expiry - 2n)
			await c.hub.publishExercisePrice(v.vaultId, usdc(4000), v.bid.expiry - 2n, v.bid.expiry + 100n)
		})

		it("pays at the observation one second before expiry", async () => {
			await at(c, v.bid.expiry - 1n)
			// 1 WETH × (4000 − 3000) / 4000
			await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 4n)
		})

		context("after exercising one unit before expiry", () => {
			beforeEach(async () => {
				await at(c, v.bid.expiry - 1n)
				await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
			})

			it("rejects exercise at the expiry second until the expiry report arrives", async () => {
				await at(c, v.bid.expiry)
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
				expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(9))
			})

			context("once the expiry report is published", () => {
				beforeEach(async () => {
					await at(c, v.bid.expiry)
					await c.hub.publishExpiry(v.vaultId, usdc(6000), v.bid.expiry + 100n)
				})

				it("pays at the expiry report instead of the observation", async () => {
					// 1 WETH × (6000 − 3000) / 6000
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 2n)
				})

				it("reserves the remainder at the expiry report when settled at expiry", async () => {
					await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
					await c.hub.settleAtExpiry(v.vaultId)
					// The last 8 WETH × (6000 − 3000) / 6000
					expect(await v.vault.buyerReserved(c.wethAddress)).to.equal(weth(4))
				})
			})
		})
	})

	for (const { name, style } of exerciseStyles) {
		const delegatedCashPut = fixture(deployed, async c => ({
			c,
			v: await goLive(
				c,
				{ isCall: false, withFeed: true },
				{ style, settlement: SettlementType.Cash, executor: c.bob.address, recipient: c.carol.address },
			),
		}))

		context(`cash ${name} put with a delegated executor at the expiry report`, () => {
			beforeEach(async () => {
				;({ c, v } = await delegatedCashPut())
				// The spot would pay nothing; the expiry report pays 300 USDC per WETH.
				await setExercisePrice(c, v.vaultId, usdc(3300))
				await publishExpiryPrice(c, v.vaultId, usdc(2700))
			})

			it("pays only the chosen units to the recipient", async () => {
				await expect(c.hub.connect(c.bob).exercise(v.vaultId, weth(4))).to.changeTokenBalances(
					ethers,
					c.usdc,
					[c.carol, v.vaultAddress],
					[usdc(1200), -usdc(1200)],
				)
			})

			context("after the executor exercises part", () => {
				beforeEach(async () => {
					await c.hub.connect(c.bob).exercise(v.vaultId, weth(4))
				})

				it("rejects exercise from an LP", async () => {
					await expect(c.hub.connect(c.alice).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "NotExecutor")
				})

				it("reserves the payout on the rest when anyone settles the vault at expiry", async () => {
					await c.hub.connect(c.alice).settleAtExpiry(v.vaultId)
					// The remaining 6 WETH × 300 USDC
					expect((await c.hub.stateOf(v.vaultId)).pendingPayout).to.equal(usdc(1800))
				})

				context("after expiry and a full LP claim", () => {
					beforeEach(async () => {
						await c.hub.connect(c.alice).settleAtExpiry(v.vaultId)
						await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
					})

					it("keeps the rest of the payout reserved for the buyer", async () => {
						expect(await v.vault.buyerReserved(c.usdcAddress)).to.equal(usdc(1800))
					})

					it("pays the reserved payout to the recipient", async () => {
						await expect(c.hub.connect(c.bob).claimPayout(v.vaultId)).to.changeTokenBalances(
							ethers,
							c.usdc,
							[c.carol, v.vaultAddress],
							[usdc(1800), -usdc(1800)],
						)
					})

					it("rejects further exercise", async () => {
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1)))
							.to.be.revertedWithCustomError(c.hub, "WrongPhase")
							.withArgs(Phase.Live, Phase.Settled)
					})

					it("rejects a second payout claim", async () => {
						await c.hub.connect(c.bob).claimPayout(v.vaultId)
						await expect(c.hub.connect(c.bob).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NothingToClaim")
					})
				})
			})
		})
	}

	describe("partial exercise policy", () => {
		for (const { name, allowPartialExercise } of partialPolicies) {
			const created = fixture(deployed, async c => {
				const { vaultId } = await createVaultAs(c, c.alice, callTerms(c, { allowPartialExercise }), callPairs(c))
				return { c, vaultId }
			})

			context(name, () => {
				context("before activation", () => {
					let vaultId: bigint

					beforeEach(async () => {
						;({ c, vaultId } = await created())
					})

					it("keeps the policy in the vault terms", async () => {
						expect((await c.hub.termsOf(vaultId)).allowPartialExercise).to.equal(allowPartialExercise)
					})

					it("exposes no entrypoint to tighten the terms", () => {
						expect(new Interface(c.hub.interface.fragments).getFunction("tightenVaultTerms")).to.equal(null)
					})

					it("exposes no manual settle entrypoint", () => {
						expect(new Interface(c.hub.interface.fragments).getFunction("settle(uint256)")).to.equal(null)
					})
				})

				for (const scenario of optionScenarios) {
					const live = fixture(deployed, async c => ({
						c,
						v: await goLive(
							c,
							{
								isCall: scenario.isCall,
								withFeed: scenario.settlement === SettlementType.Cash,
								terms: { allowPartialExercise },
							},
							{ style: scenario.style, settlement: scenario.settlement },
						),
					}))

					context(scenario.name, () => {
						beforeEach(async () => {
							;({ c, v } = await live())
							if (scenario.settlement === SettlementType.Physical) {
								// The full strike payment: 10 WETH × 3000 USDC for a call, 10 WETH for a put.
								await fund(c, scenario.isCall ? c.usdc : c.weth, c.marketMaker, v.vaultAddress, scenario.isCall ? usdc(30_000) : weth(10))
								// The first exercise lands on the expiry second, where the European window opens.
								if (scenario.style === ExerciseStyle.European) await at(c, v.bid.expiry)
							} else {
								// 300 USDC in the money either way.
								const price = scenario.isCall ? usdc(3300) : usdc(2700)
								await setExercisePrice(c, v.vaultId, price)
								if (scenario.style === ExerciseStyle.European) await publishExpiryPrice(c, v.vaultId, price)
							}
						})

						it("keeps the policy in the vault terms", async () => {
							expect((await c.hub.termsOf(v.vaultId)).allowPartialExercise).to.equal(allowPartialExercise)
						})

						if (allowPartialExercise) {
							it("keeps the vault live after a partial exercise", async () => {
								await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
								expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(6))
								expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
							})
						} else {
							it("rejects a partial exercise without consuming notional", async () => {
								await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))).to.be.revertedWithCustomError(
									c.hub,
									"PartialExerciseNotAllowed",
								)
								expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(10))
							})
						}

						context("once the whole notional is exercised", () => {
							beforeEach(async () => {
								if (allowPartialExercise) {
									await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
									await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(6))
								} else {
									await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
								}
							})

							it("settles the vault", async () => {
								expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Settled)
							})

							it("rejects settleAtExpiry on the settled vault", async () => {
								await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "WrongPhase").withArgs(Phase.Live, Phase.Settled)
							})
						})
					})
				}
			})
		}
	})
})

describe("setExecution", () => {
	let c: IvyContext
	let v: LiveVault

	context("with a delegated executor", () => {
		beforeEach(async () => {
			;({ c, v } = await delegatedPhysicalCall())
		})

		it("rejects a redirect by the executor", async () => {
			await expect(c.hub.connect(c.bob).setExecution(v.vaultId, c.bob.address, c.bob.address)).to.be.revertedWithCustomError(c.hub, "NotMarketMaker")
		})

		it("rejects a zero recipient", async () => {
			await expect(c.hub.connect(c.marketMaker).setExecution(v.vaultId, c.bob.address, ZeroAddress)).to.be.revertedWithCustomError(
				c.hub,
				"ZeroAddress",
			)
		})

		it("emits ExecutionUpdated with the new executor and recipient", async () => {
			await expect(c.hub.connect(c.marketMaker).setExecution(v.vaultId, c.alice.address, c.marketMaker.address))
				.to.emit(c.hub, "ExecutionUpdated")
				.withArgs(v.vaultId, c.alice.address, c.marketMaker.address)
		})

		context("after the market maker revokes the executor", () => {
			beforeEach(async () => {
				await c.hub.connect(c.marketMaker).setExecution(v.vaultId, ZeroAddress, c.marketMaker.address)
			})

			it("rejects exercise from the former executor", async () => {
				await expect(c.hub.connect(c.bob).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "NotExecutor")
			})
		})
	})
})
