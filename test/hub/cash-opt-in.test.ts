import { expect } from "chai"
import { ZeroAddress } from "ethers"
import { network } from "hardhat"

import { signBid, type Bid } from "../helpers/bids.js"
import {
	activate,
	at,
	goLive,
	makeBid,
	openVault,
	publishExpiryPrice,
	setExercisePrice,
	CASH_TERMS,
	type LiveVault,
	type OpenedVault,
} from "../helpers/scenarios.js"
import {
	Phase,
	SettlementPolicy,
	SettlementType,
	callPairs,
	callTerms,
	deployIvy,
	fixture,
	fund,
	usdc,
	weth,
	type IvyContext,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

const cashPolicies = [
	{ name: "Cash", policy: SettlementPolicy.Cash },
	{ name: "Either", policy: SettlementPolicy.Either },
]

const cashDisabled = fixture(connection, () => deployIvy(connection, { enableCashSettlement: false }))
const helperPublisher = fixture(cashDisabled, async c => {
	const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
	await c.hub.grantRole(role, c.bob.address)
	await c.hub.setCashSettlementEnabled(true)
	await c.hub.revokeRole(role, c.bob.address)
	const helper = await ethers.deployContract("ExampleSettlementPublisher", [c.hubAddress, c.bob.address])
	await c.hub.grantRole(role, await helper.getAddress())
	return { c, helper, v: await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash }) }
})
// The market maker delivers 30,000 USDC at the strike (call) or the 10 WETH underlying (put), which the LP then claims.
const physicalLifecycles = [
	{
		name: "call",
		load: fixture(cashDisabled, async c => ({ c, v: await goLive(c, { isCall: true }) })),
		delivered: (c: IvyContext) => c.usdc,
		delivery: usdc(30_000),
		shares: weth(10),
	},
	{
		name: "put",
		load: fixture(cashDisabled, async c => ({ c, v: await goLive(c, { isCall: false }) })),
		delivered: (c: IvyContext) => c.weth,
		delivery: weth(10),
		shares: usdc(30_000),
	},
]

const cashEnabled = fixture(connection, () => deployIvy(connection))
const pendingCashBid = fixture(cashEnabled, async c => {
	const v = await openVault(c, { terms: CASH_TERMS })
	const bid = await makeBid(c, v.vaultId, { settlement: SettlementType.Cash })
	await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(1000))
	return { c, v, bid, signature: await signBid(c.marketMaker, c.hubAddress, bid) }
})
const eitherAuction = fixture(cashEnabled, async c => ({
	c,
	v: await openVault(c, { terms: { allowedSettlement: SettlementPolicy.Either, maxSettlementPriceAge: 3600 } }),
}))
const liveCashCall = fixture(cashEnabled, async c => ({
	c,
	v: await goLive(c, { terms: CASH_TERMS }, { settlement: SettlementType.Cash }),
}))
const liveCashPutWithFee = fixture(cashEnabled, async c => {
	await c.hub.setPlatformFeeBps(200)
	return { c, v: await goLive(c, { isCall: false, terms: CASH_TERMS }, { settlement: SettlementType.Cash }) }
})

type Helper = Awaited<ReturnType<typeof helperPublisher>>["helper"]

const latest = async () => BigInt(await networkHelpers.time.latest())

describe("cash settlement opt-in", () => {
	describe("setCashSettlementEnabled", () => {
		let c: IvyContext
		let role: string

		context("when deployed with cash disabled", () => {
			beforeEach(async () => {
				c = await cashDisabled()
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
			})

			it("starts disabled", async () => {
				expect(await c.hub.cashSettlementEnabled()).to.equal(false)
			})

			context("with bob granted the publisher role", () => {
				beforeEach(async () => {
					await c.hub.grantRole(role, c.bob.address)
				})

				it("keeps cash disabled", async () => {
					expect(await c.hub.cashSettlementEnabled()).to.equal(false)
				})

				it("rejects the toggle from the publisher", async () => {
					await expect(c.hub.connect(c.bob).setCashSettlementEnabled(true)).to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
				})

				it("lets the admin enable cash", async () => {
					await expect(c.hub.setCashSettlementEnabled(true)).to.emit(c.hub, "CashSettlementEnabledUpdated").withArgs(true)
				})

				context("after the admin enables cash", () => {
					beforeEach(async () => {
						await c.hub.setCashSettlementEnabled(true)
					})

					it("stays enabled when the publisher is revoked", async () => {
						await c.hub.revokeRole(role, c.bob.address)
						expect(await c.hub.cashSettlementEnabled()).to.equal(true)
					})

					it("stays enabled when the last publisher renounces", async () => {
						await c.hub.revokeRole(role, c.bob.address)
						await c.hub.grantRole(role, c.carol.address)
						await c.hub.connect(c.carol).renounceRole(role, c.carol.address)
						expect(await c.hub.cashSettlementEnabled()).to.equal(true)
					})

					it("lets the admin disable cash", async () => {
						await expect(c.hub.setCashSettlementEnabled(false)).to.emit(c.hub, "CashSettlementEnabledUpdated").withArgs(false)
						expect(await c.hub.cashSettlementEnabled()).to.equal(false)
					})
				})
			})
		})

		context("after disabling cash on a hub deployed with it enabled", () => {
			beforeEach(async () => {
				c = await cashEnabled()
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
				await c.hub.setCashSettlementEnabled(false)
				await c.hub.revokeRole(role, c.admin.address)
			})

			it("stays disabled when a new publisher is granted", async () => {
				await c.hub.grantRole(role, c.bob.address)
				expect(await c.hub.cashSettlementEnabled()).to.equal(false)
			})
		})
	})

	describe("settlement price publisher role", () => {
		let c: IvyContext
		let role: string

		context("when deployed with cash disabled", () => {
			beforeEach(async () => {
				c = await cashDisabled()
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
			})

			it("is not held by the admin", async () => {
				expect(await c.hub.hasRole(role, c.admin.address)).to.equal(false)
			})

			it("rejects exercise prices", async () => {
				const now = await latest()
				await expect(c.hub.publishExercisePrice(1n, usdc(4000), now, now + 100n)).to.be.revertedWithCustomError(
					c.hub,
					"AccessControlUnauthorizedAccount",
				)
			})

			it("rejects a grant from an account without the admin role", async () => {
				await expect(c.hub.connect(c.bob).grantRole(role, c.bob.address)).to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
			})

			it("rejects the zero address", async () => {
				await expect(c.hub.grantRole(role, ZeroAddress)).to.be.revertedWithCustomError(c.hub, "ZeroAddress")
			})

			it("accepts a repeated grant and leaves cash disabled", async () => {
				await c.hub.grantRole(role, c.bob.address)
				await expect(c.hub.grantRole(role, c.bob.address)).not.to.be.revert(ethers)
				expect(await c.hub.cashSettlementEnabled()).to.equal(false)
			})

			context("with bob granted the role", () => {
				beforeEach(async () => {
					await c.hub.grantRole(role, c.bob.address)
				})

				it("rejects renouncing it on bob's behalf", async () => {
					await expect(c.hub.connect(c.carol).renounceRole(role, c.bob.address)).to.be.revertedWithCustomError(c.hub, "AccessControlBadConfirmation")
				})

				it("accepts a repeated revoke", async () => {
					await c.hub.revokeRole(role, c.bob.address)
					await expect(c.hub.revokeRole(role, c.bob.address)).not.to.be.revert(ethers)
					expect(await c.hub.hasRole(role, c.bob.address)).to.equal(false)
				})
			})
		})

		context("held only by an example publisher contract after cash is enabled", () => {
			let helper: Helper
			let v: LiveVault
			let now: bigint

			beforeEach(async () => {
				;({ c, helper, v } = await helperPublisher())
				now = await latest()
			})

			it("rejects an exercise price from anyone but the contract's owner", async () => {
				await expect(helper.connect(c.carol).publishExercisePrice(v.vaultId, usdc(4000), now, now + 100n)).to.be.revertedWithCustomError(
					helper,
					"OwnableUnauthorizedAccount",
				)
			})

			it("publishes the owner's exercise price", async () => {
				await expect(helper.connect(c.bob).publishExercisePrice(v.vaultId, usdc(4000), now, now + 100n)).not.to.be.revert(ethers)
			})
		})
	})

	describe("createVault", () => {
		let c: IvyContext

		context("when cash is disabled", () => {
			beforeEach(async () => {
				c = await cashDisabled()
			})

			for (const { name, policy } of cashPolicies) {
				it(`rejects the ${name} settlement policy without creating a vault`, async () => {
					await expect(
						c.hub.createVault(callTerms(c, { allowedSettlement: policy, maxSettlementPriceAge: 3600 }), callPairs(c), []),
					).to.be.revertedWithCustomError(c.hub, "CashSettlementDisabled")
					expect(await c.hub.vaultCount()).to.equal(0n)
				})
			}

			it("creates a physical-only vault", async () => {
				await expect(c.hub.connect(c.alice).createVault(callTerms(c), callPairs(c), [])).not.to.be.revert(ethers)
			})
		})

		context("after the admin enables cash", () => {
			let role: string

			beforeEach(async () => {
				c = await cashDisabled()
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
				await c.hub.grantRole(role, c.bob.address)
				await c.hub.setCashSettlementEnabled(true)
			})

			for (const { name, policy } of cashPolicies) {
				it(`accepts the ${name} settlement policy with a price age limit`, async () => {
					await expect(
						c.hub.createVault(callTerms(c, { allowedSettlement: policy, maxSettlementPriceAge: 3600 }), callPairs(c), []),
					).not.to.be.revert(ethers)
				})

				it(`rejects the ${name} settlement policy without a price age limit`, async () => {
					await expect(c.hub.createVault(callTerms(c, { allowedSettlement: policy }), callPairs(c), [])).to.be.revertedWithCustomError(
						c.hub,
						"CashSettlementNeedsMaxPriceAge",
					)
				})
			}

			context("and disables it again", () => {
				beforeEach(async () => {
					await c.hub.revokeRole(role, c.bob.address)
					await c.hub.setCashSettlementEnabled(false)
				})

				it("rejects the Cash settlement policy", async () => {
					await expect(c.hub.createVault(callTerms(c, CASH_TERMS), callPairs(c), [])).to.be.revertedWithCustomError(c.hub, "CashSettlementDisabled")
				})
			})
		})
	})

	describe("physical settlement", () => {
		let c: IvyContext
		let v: LiveVault

		context("when cash is disabled", () => {
			for (const { name, load, delivered, delivery, shares } of physicalLifecycles) {
				context(`physical ${name}`, () => {
					beforeEach(async () => {
						;({ c, v } = await load())
					})

					it("goes live without bid rules", async () => {
						expect(await c.hub.rulesOf(v.vaultId)).to.deep.equal([])
					})

					context("after full exercise", () => {
						beforeEach(async () => {
							await fund(c, delivered(c), c.marketMaker, v.vaultAddress, delivery)
							await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
						})

						it("pays the LP the market maker's delivery", async () => {
							await expect(c.hub.connect(c.alice).claim(v.vaultId, shares)).to.changeTokenBalance(ethers, delivered(c), c.alice, delivery)
						})

						it("pays the LP the premium", async () => {
							await c.hub.connect(c.alice).claim(v.vaultId, shares)
							await expect(c.hub.connect(c.alice).claimPremium(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.alice, usdc(1000))
						})

						it("leaves cash disabled after the LP claims", async () => {
							await c.hub.connect(c.alice).claim(v.vaultId, shares)
							await c.hub.connect(c.alice).claimPremium(v.vaultId)
							expect(await c.hub.cashSettlementEnabled()).to.equal(false)
						})
					})
				})
			}
		})
	})

	describe("activate", () => {
		let c: IvyContext
		let v: OpenedVault
		let role: string

		context("with a signed cash bid pending when cash is disabled", () => {
			let bid: Bid
			let signature: string

			beforeEach(async () => {
				;({ c, v, bid, signature } = await pendingCashBid())
				role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
				await c.hub.setCashSettlementEnabled(false)
				await c.hub.revokeRole(role, c.admin.address)
			})

			it("rejects the bid without consuming it", async () => {
				await expect(c.hub.connect(c.bidMaster).activate(v.vaultId, bid, signature)).to.be.revertedWithCustomError(c.hub, "CashSettlementDisabled")
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Auction)
				expect(await c.hub.usedBidNonces(c.marketMaker.address, bid.nonce)).to.equal(false)
				expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
			})

			it("accepts the same bid once a publisher is granted and cash is re-enabled", async () => {
				await c.hub.grantRole(role, c.bob.address)
				await c.hub.setCashSettlementEnabled(true)
				await c.hub.connect(c.bidMaster).activate(v.vaultId, bid, signature)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})
		})

		context("with an Either auction when cash is disabled", () => {
			beforeEach(async () => {
				;({ c, v } = await eitherAuction())
				await c.hub.setCashSettlementEnabled(false)
				await c.hub.revokeRole(await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), c.admin.address)
			})

			it("still activates a physical bid", async () => {
				await activate(c, v.vaultId, v.vaultAddress, { settlement: SettlementType.Physical })
				const state = await c.hub.stateOf(v.vaultId)
				expect(state.settlement).to.equal(SettlementType.Physical)
				expect(state.phase).to.equal(Phase.Live)
				expect(await c.hub.cashSettlementEnabled()).to.equal(false)
			})
		})
	})

	describe("cash settlement", () => {
		let c: IvyContext
		let v: LiveVault
		let role: string

		context("when cash is disabled after activation", () => {
			context("cash call priced after cash is disabled, then its publisher revoked", () => {
				beforeEach(async () => {
					;({ c, v } = await liveCashCall())
					role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
					await c.hub.setCashSettlementEnabled(false)
					await setExercisePrice(c, v.vaultId, usdc(4000))
					await c.hub.revokeRole(role, c.admin.address)
				})

				it("keeps cash disabled after a price is published", async () => {
					expect(await c.hub.cashSettlementEnabled()).to.equal(false)
				})

				it("pays an exercise at the published price", async () => {
					// 1 WETH × (4000 − 3000) / 4000.
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 4n)
				})

				context("after one exercise and an expiry report from a regranted publisher", () => {
					beforeEach(async () => {
						await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
						await c.hub.grantRole(role, c.admin.address)
						await publishExpiryPrice(c, v.vaultId, usdc(6000))
						await c.hub.setCashSettlementEnabled(false)
						await c.hub.revokeRole(role, c.admin.address)
					})

					it("pays an exercise at the expiry price", async () => {
						// 1 WETH × (6000 − 3000) / 6000.
						await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(1) / 2n)
					})

					context("once settled", () => {
						beforeEach(async () => {
							await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))
							await c.hub.settleAtExpiry(v.vaultId)
						})

						it("reserves the payout on the unexercised notional", async () => {
							// 8 WETH left × (6000 − 3000) / 6000.
							expect(await v.vault.buyerReserved(c.wethAddress)).to.equal(weth(4))
						})

						it("pays the market maker after the LPs claim", async () => {
							await c.hub.connect(c.alice).claim(v.vaultId, weth(10))
							await c.hub.connect(c.alice).claimPremium(v.vaultId)
							await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalance(ethers, c.weth, c.marketMaker, weth(4))
						})

						it("leaves cash disabled after the LPs and the market maker claim", async () => {
							await c.hub.connect(c.alice).claim(v.vaultId, weth(10))
							await c.hub.connect(c.alice).claimPremium(v.vaultId)
							await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
							expect(await c.hub.cashSettlementEnabled()).to.equal(false)
						})
					})
				})
			})

			context("cash put with a platform fee and no publisher", () => {
				beforeEach(async () => {
					;({ c, v } = await liveCashPutWithFee())
					role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE()
					await c.hub.setCashSettlementEnabled(false)
					await c.hub.revokeRole(role, c.admin.address)
				})

				it("rejects exercise before any price is published", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
				})

				it("keeps the vault live at the expiry second", async () => {
					await at(c, v.bid.expiry)
					await expect(c.hub.settleAtExpiry(v.vaultId)).to.be.revertedWithCustomError(c.hub, "TooEarlyToSettle")
					expect(await c.hub.remainingNotional(v.vaultId)).to.equal(weth(10))
					expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
				})

				it("rejects exercise at the expiry second before an expiry report", async () => {
					await at(c, v.bid.expiry)
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "ReportUnavailable")
				})

				it("rejects LP claims at the expiry second", async () => {
					await at(c, v.bid.expiry)
					await expect(c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))).to.be.revertedWithCustomError(c.hub, "WrongPhase")
				})

				context("after expiry", () => {
					beforeEach(async () => {
						await networkHelpers.time.increaseTo(v.bid.expiry)
					})

					it("leaves only the collateral once the premium and fee are claimed", async () => {
						await c.hub.connect(c.alice).claimPremium(v.vaultId)
						await v.vault.claimPlatformFee()
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(30_000))
					})

					context("once a regranted publisher reports within the window", () => {
						beforeEach(async () => {
							await c.hub.connect(c.alice).claimPremium(v.vaultId)
							await v.vault.claimPlatformFee()
							await networkHelpers.time.increase(1000)
							await c.hub.grantRole(role, c.bob.address)
							await c.hub.connect(c.bob).publishExpiry(v.vaultId, usdc(2700), (await latest()) + 100n)
							await c.hub.connect(c.bob).renounceRole(role, c.bob.address)
						})

						it("settles and pays the market maker after the LPs claim", async () => {
							await c.hub.settleAtExpiry(v.vaultId)
							await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
							// 10 WETH × (3000 − 2700) USDC.
							await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).to.changeTokenBalance(ethers, c.usdc, c.marketMaker, usdc(3000))
						})

						it("leaves cash disabled after settlement and claims", async () => {
							await c.hub.settleAtExpiry(v.vaultId)
							await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
							await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
							expect(await c.hub.cashSettlementEnabled()).to.equal(false)
						})
					})
				})
			})
		})
	})
})
