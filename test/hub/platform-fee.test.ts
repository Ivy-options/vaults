import { expect } from "chai"
import { ZeroAddress } from "ethers"
import { network } from "hardhat"

import { signBid, type Bid } from "../helpers/bids.js"
import { PREMIUM_TOTAL, activate, at, goLive, makeBid, openVault, type LiveVault, type OpenedVault } from "../helpers/scenarios.js"
import {
	EXERCISE_WINDOW,
	Phase,
	callPairs,
	callTerms,
	createVaultAs,
	deployIvy,
	fixture,
	fund,
	usdc,
	weth,
	type CreatedVault,
	type IvyContext,
} from "../helpers/setup.js"
import { proposeUnwind } from "../helpers/unwind.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

/** Fee on the 1000 USDC gross premium is set by the creation rate, whatever the rate at activation. */
const RATE_CHANGES = [
	{ name: "created at 0 bps and activated at 200 bps", creationRate: 0, activationRate: 200, fee: 0n },
	{ name: "created at 200 bps and activated at 500 bps", creationRate: 200, activationRate: 500, fee: usdc(20) },
	{ name: "created at 500 bps and activated at 100 bps", creationRate: 500, activationRate: 100, fee: usdc(50) },
	{ name: "created at 500 bps and activated at 0 bps", creationRate: 500, activationRate: 0, fee: usdc(50) },
	{ name: "created at 10000 bps and activated at 0 bps", creationRate: 10_000, activationRate: 0, fee: usdc(1000) },
	{ name: "created at 0 bps and activated at 10000 bps", creationRate: 0, activationRate: 10_000, fee: 0n },
]

/** alice opens a call vault while the global rate is `rate` bps. */
async function openAtRate(c: IvyContext, rate: number) {
	await c.hub.setPlatformFeeBps(rate)
	return openVault(c)
}

/** The market maker signs a bid for `o` and funds exactly its gross premium. */
async function signFundedBid(c: IvyContext, o: OpenedVault) {
	const bid = await makeBid(c, o.vaultId)
	const signature = await signBid(c.marketMaker, c.hubAddress, bid)
	await fund(c, c.usdc, c.marketMaker, o.vaultAddress, PREMIUM_TOTAL)
	return { bid, signature }
}

const deployed = fixture(connection, () => deployIvy(connection))
const signedAt200 = fixture(deployed, async c => {
	const o = await openAtRate(c, 200)
	return { c, o, ...(await signFundedBid(c, o)) }
})
const createdAt200 = fixture(deployed, async c => {
	await c.hub.setPlatformFeeBps(200)
	return { c, created: await createVaultAs(c, c.alice, callTerms(c), callPairs(c)) }
})
const reopenedAt200 = fixture(deployed, async c => {
	const o = await openAtRate(c, 200)
	await c.hub.connect(c.bidMaster).cancelAuction(o.vaultId)
	await c.hub.setPlatformFeeBps(500)
	await c.hub.connect(c.alice).openAuction(o.vaultId)
	return { c, o }
})
// One USDC base unit of premium per wei of WETH, so 3 wei of collateral earn a 3-unit premium.
const dustPremiumAt3333 = fixture(deployed, async c => {
	await c.hub.setPlatformFeeBps(3333)
	return { c, v: await goLive(c, { deposit: 3n }, { premiumPerUnit: usdc(10n ** 12n) }) }
})
const liveAtFullRate = fixture(deployed, async c => {
	await c.hub.setPlatformFeeBps(10_000)
	return { c, v: await goLive(c) }
})
const putPayingCarol = fixture(deployed, async c => {
	await c.hub.setPlatformFeeBps(200)
	await c.hub.setPlatformTreasury(c.carol.address)
	return { c, v: await goLive(c, { isCall: false }) }
})
const unwoundPutWithRefund = fixture(deployed, async c => {
	await c.hub.setPlatformFeeBps(200)
	const v = await goLive(c, { isCall: false })
	const deadline = BigInt(await networkHelpers.time.latest()) + 86_400n
	const { agreement, signature } = await proposeUnwind(c, v.vaultId, deadline, usdc(100))
	await c.hub.connect(c.alice).approveUnwind(v.vaultId, agreement.nonce)
	await fund(c, c.usdc, c.alice, v.vaultAddress, agreement.refund)
	await c.hub.connect(c.alice).fundUnwind(v.vaultId, agreement.nonce, agreement.refund)
	await c.hub.connect(c.carol).executeUnwind(v.vaultId, agreement.nonce, signature)
	return { c, v }
})

describe("platform fee", () => {
	describe("setPlatformFeeBps", () => {
		let c: IvyContext

		beforeEach(async () => {
			c = await deployed()
		})

		it("starts at zero", async () => {
			expect(await c.hub.platformFeeBps()).to.equal(0n)
		})

		it("rejects a caller without the platform fee manager role", async () => {
			await expect(c.hub.connect(c.alice).setPlatformFeeBps(100))
				.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
				.withArgs(c.alice.address, await c.hub.PLATFORM_FEE_MANAGER_ROLE())
		})

		it("rejects a rate above 10000 bps", async () => {
			await expect(c.hub.setPlatformFeeBps(10_001)).to.be.revertedWithCustomError(c.hub, "InvalidPlatformFee")
		})

		it("emits PlatformFeeBpsUpdated with the previous and new rates", async () => {
			await c.hub.setPlatformFeeBps(200)
			await expect(c.hub.setPlatformFeeBps(500)).to.emit(c.hub, "PlatformFeeBpsUpdated").withArgs(200n, 500n)
		})
	})

	describe("setPlatformTreasury", () => {
		let c: IvyContext

		beforeEach(async () => {
			c = await deployed()
		})

		it("rejects the zero address", async () => {
			await expect(c.hub.setPlatformTreasury(ZeroAddress)).to.be.revertedWithCustomError(c.hub, "ZeroAddress")
		})

		it("emits PlatformTreasuryUpdated with the previous and new treasuries", async () => {
			await expect(c.hub.setPlatformTreasury(c.carol.address)).to.emit(c.hub, "PlatformTreasuryUpdated").withArgs(c.admin.address, c.carol.address)
		})
	})

	describe("per-vault fee", () => {
		let c: IvyContext
		let v: LiveVault
		let o: OpenedVault
		let bid: Bid
		let signature: string

		const activateBid = () => c.hub.connect(c.bidMaster).activate(o.vaultId, bid, signature)

		describe("rate", () => {
			for (const { name, creationRate, activationRate, fee } of RATE_CHANGES) {
				const created = fixture(deployed, async c => ({ c, o: await openAtRate(c, creationRate) }))

				context(`vault ${name}`, () => {
					beforeEach(async () => {
						;({ c, o } = await created())
					})

					it("records the creation rate on the vault", async () => {
						expect(await c.hub.vaultPlatformFeeBps(o.vaultId)).to.equal(creationRate)
					})

					context("with a funded bid signed before the global rate moves", () => {
						beforeEach(async () => {
							;({ bid, signature } = await signFundedBid(c, o))
							await c.hub.setPlatformFeeBps(activationRate)
						})

						it("collects the gross premium into the vault's reserve", async () => {
							await expect(activateBid()).to.changeTokenBalances(ethers, c.usdc, [c.marketMaker, o.vault], [-PREMIUM_TOTAL, PREMIUM_TOTAL])
							expect(await o.vault.reserved(c.usdcAddress)).to.equal(PREMIUM_TOTAL)
						})

						it("allocates the fee at the creation rate", async () => {
							await activateBid()
							const allocated = await c.hub.platformFees(o.vaultId)
							expect(allocated.rateBps).to.equal(creationRate)
							expect(allocated.amount).to.equal(fee)
							expect(await o.vault.platformFeeRemaining()).to.equal(fee)
						})

						it("emits PlatformFeeAllocated with the treasury, creation rate and fee", async () => {
							await expect(activateBid()).to.emit(c.hub, "PlatformFeeAllocated").withArgs(o.vaultId, c.admin.address, creationRate, fee)
						})

						it("credits the LPs the premium net of the fee", async () => {
							await activateBid()
							expect(await o.vault.premiumRemaining()).to.equal(PREMIUM_TOTAL - fee)
							expect(await c.premiums.claimable(o.vaultId, c.alice.address)).to.equal(PREMIUM_TOTAL - fee)
						})
					})
				})
			}

			context("with a vault created at 200 bps before the global rate rises to 500 bps", () => {
				let created: CreatedVault

				beforeEach(async () => {
					;({ c, created } = await createdAt200())
					await c.hub.setPlatformFeeBps(500)
				})

				it("keeps the rate fixed before any deposit", async () => {
					expect(await c.hub.vaultPlatformFeeBps(created.vaultId)).to.equal(200n)
				})

				it("charges a newly created vault the new rate", async () => {
					v = await goLive(c)
					expect(await c.hub.vaultPlatformFeeBps(v.vaultId)).to.equal(500n)
					expect(await v.vault.platformFeeRemaining()).to.equal(usdc(50))
				})

				context("after the global rate drops to zero", () => {
					beforeEach(async () => {
						await c.hub.setPlatformFeeBps(0)
					})

					it("charges a newly created vault nothing", async () => {
						v = await goLive(c)
						expect(await c.hub.vaultPlatformFeeBps(v.vaultId)).to.equal(0n)
						expect(await v.vault.platformFeeRemaining()).to.equal(0n)
					})

					it("still charges the earlier vault its creation rate when funded and activated", async () => {
						await fund(c, c.weth, c.alice, created.vaultAddress, weth(10))
						await c.hub.connect(c.alice).deposit(created.vaultId, weth(10))
						await c.hub.connect(c.alice).openAuction(created.vaultId)
						await activate(c, created.vaultId, created.vaultAddress)
						expect((await c.hub.platformFees(created.vaultId)).rateBps).to.equal(200n)
						expect(await created.vault.platformFeeRemaining()).to.equal(usdc(20))
						expect(await c.premiums.claimable(created.vaultId, c.alice.address)).to.equal(usdc(980))
					})
				})
			})

			context("after a vault created at 200 bps reopens its auction at 500 bps", () => {
				beforeEach(async () => {
					;({ c, o } = await reopenedAt200())
				})

				it("starts a second auction without changing the vault's rate", async () => {
					expect((await c.hub.stateOf(o.vaultId)).auctionId).to.equal(2n)
					expect(await c.hub.vaultPlatformFeeBps(o.vaultId)).to.equal(200n)
				})

				it("charges the creation rate on activation", async () => {
					await activate(c, o.vaultId, o.vaultAddress)
					expect(await o.vault.platformFeeRemaining()).to.equal(usdc(20))
					expect(await c.premiums.claimable(o.vaultId, c.alice.address)).to.equal(usdc(980))
				})
			})

			context("with a bid signed at 200 bps before the rate moves to 500 bps and the treasury to carol", () => {
				beforeEach(async () => {
					;({ c, o, bid, signature } = await signedAt200())
					await c.hub.setPlatformFeeBps(500)
					await c.hub.setPlatformTreasury(c.carol.address)
				})

				it("leaves the premium uncollected until activation", async () => {
					expect(await o.vault.premiumCollected()).to.equal(false)
				})

				context("activated after the rate drops to zero and the treasury moves to bob", () => {
					beforeEach(async () => {
						await c.hub.setPlatformFeeBps(0)
						await c.hub.setPlatformTreasury(c.bob.address)
						await activateBid()
					})

					it("charges the creation rate", async () => {
						expect((await c.hub.platformFees(o.vaultId)).rateBps).to.equal(200n)
						expect(await o.vault.platformFeeRemaining()).to.equal(usdc(20))
						expect(await c.premiums.claimable(o.vaultId, c.alice.address)).to.equal(usdc(980))
					})

					it("records the treasury set at activation as the fee recipient", async () => {
						expect((await c.hub.platformFees(o.vaultId)).recipient).to.equal(c.bob.address)
					})
				})
			})
		})

		describe("allocation", () => {
			context("at 3333 bps on a three-unit premium", () => {
				beforeEach(async () => {
					;({ c, v } = await dustPremiumAt3333())
				})

				it("rounds the fee down to zero and credits the LP the whole premium", async () => {
					expect(await v.vault.platformFeeRemaining()).to.equal(0n)
					expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(3n)
				})
			})

			context("at the full 10000 bps rate", () => {
				beforeEach(async () => {
					;({ c, v } = await liveAtFullRate())
				})

				it("allocates the whole premium to the fee", async () => {
					expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(0n)
					expect(await v.vault.platformFeeRemaining()).to.equal(usdc(1000))
				})

				it("lets the whole-premium fee be claimed", async () => {
					await expect(v.vault.claimPlatformFee()).to.not.be.revert(ethers)
				})
			})

			context("when the premium token skims a transfer fee on a bid signed at 200 bps", () => {
				beforeEach(async () => {
					;({ c, o, bid, signature } = await signedAt200())
					await c.hub.setPlatformFeeBps(500)
					await c.usdc.setFeeBps(100)
				})

				it("reverts activation with ShortReceived", async () => {
					// The 1% skim leaves 990 of the 1000 USDC gross premium.
					await expect(activateBid()).to.be.revertedWithCustomError(o.vault, "ShortReceived").withArgs(usdc(1000), usdc(990))
				})

				context("after the activation reverts", () => {
					beforeEach(async () => {
						await activateBid().catch(() => {})
					})

					it("leaves the bid nonce unused", async () => {
						expect(await c.hub.usedBidNonces(c.marketMaker.address, bid.nonce)).to.equal(false)
					})

					it("leaves the premium uncollected and no fee allocated", async () => {
						expect(await o.vault.premiumCollected()).to.equal(false)
						expect((await c.hub.platformFees(o.vaultId)).amount).to.equal(0n)
						expect((await c.premiums.pools(o.vaultId)).supply).to.equal(0n)
					})

					it("keeps the vault in its auction at the creation rate", async () => {
						expect((await c.hub.stateOf(o.vaultId)).phase).to.equal(Phase.Auction)
						expect(await c.hub.vaultPlatformFeeBps(o.vaultId)).to.equal(200n)
					})

					it("accepts the same bid at the creation rate once the token stops skimming", async () => {
						await c.hub.setPlatformFeeBps(0)
						await c.usdc.setFeeBps(0)
						await activateBid()
						expect(await o.vault.platformFeeRemaining()).to.equal(usdc(20))
					})
				})
			})
		})

		describe("reservation", () => {
			context("put vault charged 200 bps with carol as treasury", () => {
				beforeEach(async () => {
					;({ c, v } = await putPayingCarol())
				})

				it("allocates the fee and credits the LP the net premium", async () => {
					const allocated = await c.hub.platformFees(v.vaultId)
					expect(allocated.rateBps).to.equal(200n)
					expect(allocated.amount).to.equal(usdc(20))
					expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(usdc(980))
				})

				context("after the rate and treasury change and the LP claims the premium", () => {
					beforeEach(async () => {
						await c.hub.setPlatformFeeBps(500)
						await c.hub.setPlatformTreasury(c.bob.address)
						await c.hub.connect(c.alice).claimPremium(v.vaultId)
					})

					it("keeps only the fee reserved in the collateral token", async () => {
						expect(await v.vault.reserved(c.usdcAddress)).to.equal(usdc(20))
					})

					context("once settled and the LP claims all collateral", () => {
						beforeEach(async () => {
							// Settles in the first second it is allowed.
							await at(c, v.bid.expiry + EXERCISE_WINDOW)
							await c.hub.settleAtExpiry(v.vaultId)
							await c.hub.connect(c.alice).claim(v.vaultId, usdc(10_000))
							await c.hub.connect(c.alice).claim(v.vaultId, usdc(20_000))
						})

						it("leaves exactly the fee in the vault", async () => {
							expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(20))
						})

						it("lets anyone send the fee to the treasury recorded at activation", async () => {
							await expect(v.vault.connect(c.bob).claimPlatformFee()).to.changeTokenBalances(ethers, c.usdc, [c.carol], [usdc(20)])
						})

						context("after the fee is claimed", () => {
							beforeEach(async () => {
								await v.vault.connect(c.bob).claimPlatformFee()
							})

							it("rejects a second fee claim", async () => {
								await expect(v.vault.claimPlatformFee()).to.be.revertedWithCustomError(v.vault, "NothingToClaim")
							})

							it("releases the fee reservation", async () => {
								expect(await v.vault.reserved(c.usdcAddress)).to.equal(0n)
							})
						})
					})
				})
			})

			context("put vault charged 200 bps and unwound with a funded refund", () => {
				beforeEach(async () => {
					;({ c, v } = await unwoundPutWithRefund())
				})

				it("reserves the fee alongside the net premium and the refund", async () => {
					// 980 net premium + 20 fee + 100 refund.
					expect(await v.vault.reserved(c.usdcAddress)).to.equal(usdc(1100))
				})

				context("after the LP, premium and payout claims", () => {
					beforeEach(async () => {
						await c.hub.connect(c.alice).claim(v.vaultId, usdc(30_000))
						await c.hub.connect(c.alice).claimPremium(v.vaultId)
						await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
					})

					it("leaves exactly the fee in the vault", async () => {
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(20))
					})

					it("empties the vault once the fee is claimed", async () => {
						await v.vault.claimPlatformFee()
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
					})
				})
			})
		})
	})
})
