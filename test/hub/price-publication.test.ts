import { expect } from "chai"
import { network } from "hardhat"

import { at, goLive, openVault, CASH_TERMS, type LiveVault } from "../helpers/scenarios.js"
import { Phase, SettlementType, callPairs, callTerms, createVaultAs, deployIvy, fixture, usdc, weth, type IvyContext } from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

const deployed = fixture(connection, () => deployIvy(connection))
const cashCall = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash }),
}))
const cashCallWithHelper = fixture(cashCall, async ({ c, v }) => ({
	c,
	v,
	helper: await ethers.deployContract("ExampleSettlementPublisher", [c.hubAddress, c.bob.address]),
}))
const cashPutWithFee = fixture(deployed, async c => {
	await c.hub.setPlatformFeeBps(200)
	return { c, v: await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash }) }
})
const fullyExercisedCashCall = fixture(cashCall, async ({ c, v }) => {
	const observedAt = BigInt(await networkHelpers.time.latest())
	await c.hub.publishExercisePrice(v.vaultId, usdc(6000), observedAt, observedAt + 100n)
	await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
	return { c, v, observedAt }
})
const openCashVault = fixture(deployed, async c => {
	const { vaultId } = await createVaultAs(c, c.alice, callTerms(c, CASH_TERMS), callPairs(c))
	return { c, vaultId }
})
const auctionVault = fixture(deployed, async c => ({ c, vaultId: (await openVault(c, { withFeed: true })).vaultId }))
const physicalVault = fixture(deployed, async c => ({ c, vaultId: (await goLive(c)).vaultId }))
const twoCashCalls = fixture(deployed, async c => {
	const terms = { ...CASH_TERMS, expiry: c.defaultExpiry }
	return {
		c,
		first: await goLive(c, { terms }, { settlement: SettlementType.Cash }),
		second: await goLive(c, { terms }, { settlement: SettlementType.Cash }),
	}
})
const twoHubs = fixture(connection, async () => {
	const c = await deployIvy(connection)
	const other = await deployIvy(connection)
	const terms = { ...CASH_TERMS, expiry: other.defaultExpiry }
	return {
		c,
		other,
		expiry: terms.expiry,
		first: await goLive(c, { terms }, { settlement: SettlementType.Cash }),
		second: await goLive(other, { terms }, { settlement: SettlementType.Cash }),
	}
})

type Helper = Awaited<ReturnType<typeof cashCallWithHelper>>["helper"]

const unknownVaults = [
	{ name: "vault id 0", vaultId: 0n },
	{ name: "a vault id never created", vaultId: 999n },
]
const ineligibleVaults = [
	{ name: "an open cash vault", load: openCashVault, error: "WrongPhase" },
	{ name: "a vault in auction", load: auctionVault, error: "WrongPhase" },
	{ name: "a live physical vault", load: physicalVault, error: "SettlementNotAllowed" },
]

const latest = async () => BigInt(await networkHelpers.time.latest())

describe("settlement prices", () => {
	describe("publishExercisePrice", () => {
		let c: IvyContext
		let v: LiveVault
		let now: bigint

		context("with an unknown vault id", () => {
			beforeEach(async () => {
				c = await deployed()
				now = await latest()
			})

			for (const { name, vaultId } of unknownVaults) {
				it(`reverts with UnknownVault for ${name}`, async () => {
					await expect(c.hub.publishExercisePrice(vaultId, 4000, now, now + 1000n)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
				})
			}
		})

		for (const { name, load, error } of ineligibleVaults) {
			context(`for ${name}`, () => {
				let vaultId: bigint

				beforeEach(async () => {
					;({ c, vaultId } = await load())
					now = await latest()
				})

				it(`reverts with ${error}`, async () => {
					await expect(c.hub.publishExercisePrice(vaultId, 4000, now, now + 1000n)).to.be.revertedWithCustomError(c.hub, error)
				})
			})
		}

		context("after a cash vault is fully exercised", () => {
			let observedAt: bigint

			beforeEach(async () => {
				;({ c, v, observedAt } = await fullyExercisedCashCall())
			})

			it("reverts with WrongPhase even for a newer observation", async () => {
				await expect(c.hub.publishExercisePrice(v.vaultId, 4000, observedAt + 1n, observedAt + 100n)).to.be.revertedWithCustomError(
					c.hub,
					"WrongPhase",
				)
			})
		})

		context("cash call", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
				now = await latest()
			})

			it("rejects a zero price", async () => {
				await expect(c.hub.publishExercisePrice(v.vaultId, 0, now, now + 1000n)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			it("rejects a zero observation time", async () => {
				await expect(c.hub.publishExercisePrice(v.vaultId, 1, 0, now + 1000n)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			it("rejects an observation from the future", async () => {
				await expect(c.hub.publishExercisePrice(v.vaultId, 1, now + 1000n, now + 2000n)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			it("accepts an observation made and valid until the current second", async () => {
				await at(c, now + 1n)
				await expect(c.hub.publishExercisePrice(v.vaultId, 4000, now + 1n, now + 1n))
					.to.emit(c.hub, "ExercisePricePublished")
					.withArgs(v.vaultId, c.wethAddress, c.usdcAddress, 4000, now + 1n, now + 1n)
			})

			context("after an observation at the current second", () => {
				beforeEach(async () => {
					await at(c, now + 1n)
					await c.hub.publishExercisePrice(v.vaultId, 4000, now + 1n, now + 1n)
				})

				it("rejects another observation from the same second", async () => {
					await expect(c.hub.publishExercisePrice(v.vaultId, 5000, now + 1n, now + 100n)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
				})

				it("rejects an older observation", async () => {
					await expect(c.hub.publishExercisePrice(v.vaultId, 5000, now, now + 100n)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
				})

				it("rejects a report whose validity has already ended", async () => {
					await expect(c.hub.publishExercisePrice(v.vaultId, 5000, now + 1n, now)).to.be.revertedWithCustomError(c.hub, "BidExpired")
				})
			})
		})
	})

	describe("publishExpiry", () => {
		let c: IvyContext
		let v: LiveVault
		let now: bigint

		context("with an unknown vault id", () => {
			beforeEach(async () => {
				c = await deployed()
				now = await latest()
			})

			for (const { name, vaultId } of unknownVaults) {
				it(`reverts with UnknownVault for ${name}`, async () => {
					await expect(c.hub.publishExpiry(vaultId, 4000, now + 1000n)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
				})
			}
		})

		for (const { name, load, error } of ineligibleVaults) {
			context(`for ${name}`, () => {
				let vaultId: bigint

				beforeEach(async () => {
					;({ c, vaultId } = await load())
					now = await latest()
				})

				it(`reverts with ${error}`, async () => {
					await expect(c.hub.publishExpiry(vaultId, 4000, now + 1000n)).to.be.revertedWithCustomError(c.hub, error)
				})
			})
		}

		context("after a cash vault is fully exercised", () => {
			let observedAt: bigint

			beforeEach(async () => {
				;({ c, v, observedAt } = await fullyExercisedCashCall())
			})

			it("reverts with WrongPhase", async () => {
				await expect(c.hub.publishExpiry(v.vaultId, 4000, observedAt + 100n)).to.be.revertedWithCustomError(c.hub, "WrongPhase")
			})
		})

		context("cash call", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
				now = await latest()
			})

			it("rejects a zero price", async () => {
				await expect(c.hub.publishExpiry(v.vaultId, 0, now + 1000n)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			it("reverts before the option expiry", async () => {
				await expect(c.hub.publishExpiry(v.vaultId, 1, v.bid.expiry + 2000n)).to.be.revertedWithCustomError(c.hub, "ExpirationNotReached")
			})

			it("rejects a report whose validity has already ended", async () => {
				await expect(c.hub.publishExpiry(v.vaultId, 5000, now)).to.be.revertedWithCustomError(c.hub, "BidExpired")
			})

			it("finalizes a report at the expiry second that is valid until then", async () => {
				await at(c, v.bid.expiry)
				await expect(c.hub.publishExpiry(v.vaultId, 3000, v.bid.expiry))
					.to.emit(c.hub, "ExpiryPublished")
					.withArgs(v.vaultId, c.wethAddress, c.usdcAddress, v.bid.expiry, 3000, v.bid.expiry)
			})

			context("after a report", () => {
				beforeEach(async () => {
					await at(c, v.bid.expiry)
					await c.hub.publishExpiry(v.vaultId, 3000, v.bid.expiry)
				})

				it("rejects a second report", async () => {
					await expect(c.hub.publishExpiry(v.vaultId, 4000, v.bid.expiry + 100n)).to.be.revertedWithCustomError(c.hub, "ReportFinalized")
				})
			})
		})

		context("cash put with a platform fee awaiting its expiry report", () => {
			beforeEach(async () => {
				;({ c, v } = await cashPutWithFee())
				await c.feed.set(c.wethAddress, c.usdcAddress, usdc(2700), v.bid.expiry)
			})

			it("keeps the vault live at the expiry second", async () => {
				await at(c, v.bid.expiry)
				await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "TooEarlyToSettle")
				expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(10))
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("rejects LP claims at the expiry second", async () => {
				await at(c, v.bid.expiry)
				await expect(c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))).to.be.revertedWithCustomError(c.hub, "WrongPhase")
			})

			context("after the premium and fee are claimed and a rotated publisher reports within the window", () => {
				beforeEach(async () => {
					await networkHelpers.time.increaseTo(v.bid.expiry)
					await c.hub.connect(c.alice).claimPremium(v.vaultId)
					await v.vault.claimPlatformFee()
					await networkHelpers.time.increase(1000)
					const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
					await c.hub.grantRole(role, c.carol.address)
					await c.hub.revokeRole(role, c.admin.address)
					await c.hub.connect(c.carol).publishExpiry(v.vaultId, usdc(2700), (await latest()) + 100n)
					await c.hub.settleAtExpiry(v.vaultId)
				})

				it("reserves only the market maker's payout", async () => {
					// 10 WETH × (3000 − 2700) USDC.
					expect(await v.vault.buyerReserved(c.usdcAddress)).to.equal(usdc(3000))
				})

				it("pays the market maker after the LPs claim", async () => {
					await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
					await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.marketMaker, usdc(3000))
				})

				it("rejects a second payout claim", async () => {
					await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
					await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
					await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NothingToClaim")
				})
			})
		})
	})

	describe("exercisePrice", () => {
		let c: IvyContext

		context("with an unknown vault id", () => {
			beforeEach(async () => {
				c = await deployed()
			})

			for (const { name, vaultId } of unknownVaults) {
				it(`reverts with UnknownVault for ${name}`, async () => {
					await expect(c.hub.exercisePrice(vaultId)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
				})
			}
		})
	})

	describe("settlementPrice", () => {
		let c: IvyContext
		let v: LiveVault

		context("with an unknown vault id", () => {
			beforeEach(async () => {
				c = await deployed()
			})

			for (const { name, vaultId } of unknownVaults) {
				it(`reverts with UnknownVault for ${name}`, async () => {
					await expect(c.hub.settlementPrice(vaultId)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
				})
			}
		})

		context("cash call with an exercise price but no expiry report", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
				const now = await latest()
				await c.hub.publishExercisePrice(v.vaultId, 4000, now, now + 1000n)
			})

			it("reverts with ReportUnavailable", async () => {
				await expect(c.hub.settlementPrice(v.vaultId)).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
			})
		})
	})

	describe("exercise", () => {
		let c: IvyContext
		let v: LiveVault
		let now: bigint

		context("cash American call", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
				now = await latest()
			})

			it("rejects exercise before any price is published", async () => {
				await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			context("with a fresh in-the-money indicative feed price", () => {
				beforeEach(async () => {
					await c.feed.set(c.wethAddress, c.usdcAddress, usdc(9000), now)
					// The feed update mined a block, so the boundaries below count from after it.
					now = await latest()
				})

				it("still rejects exercise before any price is published", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
				})

				context("and an observation older than the price age limit", () => {
					beforeEach(async () => {
						await c.hub.publishExercisePrice(v.vaultId, usdc(4000), now - 4000n, now + 1000n)
					})

					it("rejects exercise as stale without consuming notional", async () => {
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "StalePrice")
						expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(10))
					})
				})

				context("and an observation that reaches the price age limit", () => {
					let limit: bigint

					beforeEach(async () => {
						limit = now + 2n
						// The vault accepts observations up to 3600 seconds old.
						await c.hub.publishExercisePrice(v.vaultId, usdc(4000), limit - 3600n, limit + 100n)
					})

					it("pays at the published price at exactly the age limit", async () => {
						await at(c, limit)
						// 1 WETH × (4000 − 3000) / 4000.
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 4n)
					})

					it("rejects exercise one second past the age limit", async () => {
						await at(c, limit + 1n)
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "StalePrice")
					})
				})

				context("and a fresh observation whose validity ends two seconds from now", () => {
					let validUntil: bigint

					beforeEach(async () => {
						validUntil = now + 2n
						await c.hub.publishExercisePrice(v.vaultId, usdc(4000), now, validUntil)
					})

					it("pays at the published price at exactly the last valid second", async () => {
						await at(c, validUntil)
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 4n)
					})

					it("rejects exercise one second after its validity ends", async () => {
						await at(c, validUntil + 1n)
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "StalePrice")
					})
				})
			})

			context("after the publisher that priced it is revoked", () => {
				let role: string

				beforeEach(async () => {
					await c.hub.publishExercisePrice(v.vaultId, usdc(4000), now, now + 100n)
					role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
					await c.hub.revokeRole(role, c.admin.address)
				})

				it("still pays at the published price", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 4n)
				})

				context("and a new publisher reprices it after one exercise", () => {
					beforeEach(async () => {
						await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
						await c.hub.grantRole(role, c.carol.address)
						const repricedAt = await latest()
						await c.hub.connect(c.carol).publishExercisePrice(v.vaultId, usdc(6000), repricedAt, repricedAt + 100n)
					})

					it("pays the next exercise at the new price and keeps the earlier payment", async () => {
						// 1 WETH × (6000 − 3000) / 6000.
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 2n)
						expect(await c.weth.balanceOf(c.marketMaker.address)).to.equal(weth(1) / 4n + weth(1) / 2n)
						expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(8))
					})
				})
			})
		})
	})

	describe("settlement price publisher role", () => {
		let c: IvyContext
		let v: LiveVault
		let role: string

		context("cash call", () => {
			beforeEach(async () => {
				;({ c, v } = await cashCall())
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
			})

			it("lets the admin publish directly as an EOA", async () => {
				expect(await c.hub.hasRole(role, c.admin.address)).to.equal(true)
				const now = await latest()
				await c.hub.publishExercisePrice(v.vaultId, 4000, now, now + 100n)
				expect(await c.hub.exercisePrice(v.vaultId)).to.deep.equal([4000n, now, now + 100n])
			})

			it("rejects a role grant from an account without the admin role", async () => {
				await expect(c.hub.connect(c.bob).grantRole(role, c.bob.address)).to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
			})
		})

		context("cash call at expiry", () => {
			let now: bigint

			beforeEach(async () => {
				;({ c, v } = await cashCall())
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
				await networkHelpers.time.increaseTo(v.bid.expiry)
				now = await latest()
			})

			it("rejects an expiry price from an account without the role", async () => {
				await expect(c.hub.connect(c.bob).publishExpiry(v.vaultId, 3000, now + 100n)).to.be.revertedWithCustomError(
					c.hub,
					"AccessControlUnauthorizedAccount",
				)
			})

			context("after a report and a rotation to a new publisher", () => {
				beforeEach(async () => {
					await c.hub.publishExpiry(v.vaultId, 3000, now + 100n)
					await c.hub.grantRole(role, c.bob.address)
					await c.hub.revokeRole(role, c.admin.address)
				})

				it("rejects an exercise price from the revoked publisher", async () => {
					await expect(c.hub.publishExercisePrice(v.vaultId, 4000, now, now + 100n)).to.be.revertedWithCustomError(
						c.hub,
						"AccessControlUnauthorizedAccount",
					)
				})

				it("rejects a replacement report from the new publisher", async () => {
					await expect(c.hub.connect(c.bob).publishExpiry(v.vaultId, 4000, now + 100n)).to.be.revertedWithCustomError(c.hub, "ReportFinalized")
				})

				it("keeps the finalized price", async () => {
					await networkHelpers.time.increase(1000)
					expect(await c.hub.settlementPrice(v.vaultId)).to.equal(3000n)
				})
			})
		})

		context("with an example publisher contract owned by bob", () => {
			let helper: Helper
			let helperAddress: string
			let now: bigint

			beforeEach(async () => {
				;({ c, v, helper } = await cashCallWithHelper())
				helperAddress = await helper.getAddress()
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
				now = await latest()
			})

			it("rejects its publications until the hub grants it the role", async () => {
				await expect(helper.connect(c.bob).publishExercisePrice(v.vaultId, 4000, now, now + 100n))
					.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
					.withArgs(helperAddress, role)
			})

			context("once granted the role", () => {
				beforeEach(async () => {
					await c.hub.grantRole(role, helperAddress)
				})

				it("rejects an exercise price from anyone but its owner", async () => {
					await expect(helper.connect(c.carol).publishExercisePrice(v.vaultId, 4000, now, now + 100n)).to.be.revertedWithCustomError(
						helper,
						"OwnableUnauthorizedAccount",
					)
				})

				it("rejects an expiry price from anyone but its owner", async () => {
					await expect(helper.connect(c.carol).publishExpiry(v.vaultId, 4000, now + 100n)).to.be.revertedWithCustomError(
						helper,
						"OwnableUnauthorizedAccount",
					)
				})

				it("publishes its owner's exercise price", async () => {
					await helper.connect(c.bob).publishExercisePrice(v.vaultId, 4000, now, now + 100n)
					expect(await c.hub.exercisePrice(v.vaultId)).to.deep.equal([4000n, now, now + 100n])
				})

				context("after it finalizes an expiry price and loses the role", () => {
					beforeEach(async () => {
						await helper.connect(c.bob).publishExercisePrice(v.vaultId, 4000, now, now + 100n)
						await at(c, v.bid.expiry)
						await helper.connect(c.bob).publishExpiry(v.vaultId, 3000, v.bid.expiry + 100n)
						await c.hub.revokeRole(role, helperAddress)
					})

					it("rejects its next expiry price", async () => {
						await expect(helper.connect(c.bob).publishExpiry(v.vaultId, 5000, v.bid.expiry + 100n))
							.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
							.withArgs(helperAddress, role)
					})

					it("rejects its next exercise price", async () => {
						await expect(helper.connect(c.bob).publishExercisePrice(v.vaultId, 5000, v.bid.expiry + 1n, v.bid.expiry + 100n))
							.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
							.withArgs(helperAddress, role)
					})

					it("keeps the price it finalized", async () => {
						expect(await c.hub.settlementPrice(v.vaultId)).to.equal(3000n)
					})

					context("and an EOA publisher publishes and is revoked", () => {
						let observedAt: bigint

						beforeEach(async () => {
							await c.hub.grantRole(role, c.carol.address)
							observedAt = await latest()
							await c.hub.connect(c.carol).publishExercisePrice(v.vaultId, 6000, observedAt, observedAt + 100n)
							await c.hub.revokeRole(role, c.carol.address)
						})

						it("rejects its next exercise price", async () => {
							await expect(c.hub.connect(c.carol).publishExercisePrice(v.vaultId, 7000, observedAt + 1n, observedAt + 100n))
								.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
								.withArgs(c.carol.address, role)
						})

						it("keeps the exercise price it published", async () => {
							expect(await c.hub.exercisePrice(v.vaultId)).to.deep.equal([6000n, observedAt, observedAt + 100n])
						})
					})
				})
			})
		})
	})

	describe("per-vault settlement prices", () => {
		let c: IvyContext
		let first: LiveVault
		let second: LiveVault

		context("two matching cash vaults with only the first priced", () => {
			let now: bigint

			beforeEach(async () => {
				;({ c, first, second } = await twoCashCalls())
				now = await latest()
				await c.hub.publishExercisePrice(first.vaultId, usdc(4000), now, now + 100n)
			})

			it("leaves the second vault's exercise price empty", async () => {
				expect(await c.hub.exercisePrice(second.vaultId)).to.deep.equal([0n, 0n, 0n])
			})

			it("rejects exercising the second vault", async () => {
				await expect(c.hub.connect(c.marketMaker).exercise(second.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			context("after the second is priced with the same observation time", () => {
				beforeEach(async () => {
					await c.hub.publishExercisePrice(second.vaultId, usdc(6000), now, now + 100n)
				})

				it("pays the first vault at its own price", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(first.vaultId, weth(1))).to.changeTokenBalance(
						ethers,
						c.weth,
						c.marketMaker,
						weth(1) / 4n,
					)
				})

				it("pays the second vault at its own price", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(second.vaultId, weth(1))).to.changeTokenBalance(
						ethers,
						c.weth,
						c.marketMaker,
						weth(1) / 2n,
					)
				})

				context("after one exercise each and the first vault's expiry report", () => {
					beforeEach(async () => {
						await c.hub.connect(c.marketMaker).exercise(first.vaultId, weth(1))
						await c.hub.connect(c.marketMaker).exercise(second.vaultId, weth(1))
						await at(c, c.defaultExpiry)
						await c.hub.publishExpiry(first.vaultId, usdc(6000), c.defaultExpiry + 100n)
					})

					it("keeps the second vault from expiring until its own report", async () => {
						await expect(c.hub.settleAtExpiry(second.vaultId)).to.be.revertedWithCustomError(c.hub, "TooEarlyToSettle")
					})

					context("and the second vault's expiry report", () => {
						beforeEach(async () => {
							await c.hub.publishExpiry(second.vaultId, usdc(4000), c.defaultExpiry + 100n)
						})

						it("rejects a second report for the first vault", async () => {
							await expect(c.hub.publishExpiry(first.vaultId, usdc(7000), c.defaultExpiry + 100n)).to.be.revertedWithCustomError(
								c.hub,
								"ReportFinalized",
							)
						})

						it("settles each vault at its own expiry price", async () => {
							await c.hub.settleAtExpiry(first.vaultId)
							await c.hub.settleAtExpiry(second.vaultId)
							// 9 WETH left in each: × (6000 − 3000) / 6000 and × (4000 − 3000) / 4000.
							expect((await c.hub.stateOf(first.vaultId)).pendingPayout).to.equal(weth(9) / 2n)
							expect((await c.hub.stateOf(second.vaultId)).pendingPayout).to.equal(weth(9) / 4n)
							expect(await c.hub.settlementPrice(first.vaultId)).to.equal(usdc(6000))
							expect(await c.hub.settlementPrice(second.vaultId)).to.equal(usdc(4000))
						})
					})
				})
			})
		})

		context("the same vault id on two hubs", () => {
			let other: IvyContext
			let expiry: bigint
			let role: string

			beforeEach(async () => {
				;({ c, other, expiry, first, second } = await twoHubs())
				role = await other.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
				await other.hub.revokeRole(role, other.admin.address)
				await other.hub.grantRole(role, other.bob.address)
			})

			it("gives both vaults the same id", async () => {
				expect(first.vaultId).to.equal(second.vaultId)
			})

			it("moves the second hub's publisher role to bob without admin rights", async () => {
				expect(await other.hub.hasRole(role, other.bob.address)).to.equal(true)
				expect(await other.hub.hasRole(role, other.admin.address)).to.equal(false)
				expect(await other.hub.hasRole(await other.hub.DEFAULT_ADMIN_ROLE(), other.bob.address)).to.equal(false)
			})

			it("rejects a role grant from the second hub's publisher", async () => {
				await expect(other.hub.connect(other.bob).grantRole(role, other.carol.address)).to.be.revertedWithCustomError(
					other.hub,
					"AccessControlUnauthorizedAccount",
				)
			})

			context("after the first hub reports its expiry price", () => {
				beforeEach(async () => {
					await at(c, expiry)
					await c.hub.publishExpiry(first.vaultId, 5000, expiry + 100n)
				})

				it("leaves the second hub's vault unreported", async () => {
					await expect(other.hub.settlementPrice(second.vaultId)).to.be.revertedWithCustomError(other.hub, "ReportUnavailable")
				})

				it("keeps each hub's price separate", async () => {
					await other.hub.connect(other.bob).publishExpiry(second.vaultId, 3000, expiry + 100n)
					expect(await other.hub.settlementPrice(second.vaultId)).to.equal(3000n)
					expect(await c.hub.settlementPrice(first.vaultId)).to.equal(5000n)
				})
			})
		})
	})
})
