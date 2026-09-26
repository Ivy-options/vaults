import { expect } from "chai"
import { network } from "hardhat"

import { PREMIUM_TOTAL, at, goLive, type LiveVault } from "../helpers/scenarios.js"
import { EXERCISE_WINDOW, deployIvy, fixture, usdc, weth, type IvyContext } from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

// One USDC base unit of premium per wei of WETH.
const UNIT_PER_WEI = usdc(10n ** 12n)

/** alice deposits 1 wei and bob 2 wei, so a UNIT_PER_WEI premium totals 3 base units. */
const dustDeposits = (c: IvyContext) => ({ deposit: 1n, extraDeposits: [{ signer: c.bob, amount: 2n }] })

const deployed = fixture(connection, () => deployIvy(connection))
const liveCall = fixture(deployed, async c => ({ c, v: await goLive(c) }))
const transfersEnabled = fixture(deployed, async c => {
	await c.hub.setTransfersEnabled(true)
	return c
})
const sharedCall = fixture(transfersEnabled, async c => ({
	c,
	v: await goLive(c, { deposit: weth(6), extraDeposits: [{ signer: c.bob, amount: weth(4) }] }),
}))
// Half a unit per wei: the 1.5-unit premium floors to 1.
const flooredDustCall = fixture(transfersEnabled, async c => ({
	c,
	v: await goLive(c, dustDeposits(c), { premiumPerUnit: UNIT_PER_WEI / 2n }),
}))

describe("share transfers", () => {
	let c: IvyContext
	let v: LiveVault

	// Settles in the first second it is allowed.
	const settleVault = async () => {
		await at(c, v.bid.expiry + EXERCISE_WINDOW)
		await c.hub.settleAtExpiry(v.vaultId)
	}

	context("before transfers are enabled", () => {
		beforeEach(async () => {
			;({ c, v } = await liveCall())
		})

		it("reports transfers as disabled", async () => {
			expect(await c.hub.transfersEnabled()).to.equal(false)
		})

		it("rejects enabling transfers without the admin role", async () => {
			await expect(c.hub.connect(c.alice).setTransfersEnabled(true)).to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
		})

		it("emits TransfersEnabledUpdated when the admin enables transfers", async () => {
			await expect(c.hub.setTransfersEnabled(true)).to.emit(c.hub, "TransfersEnabledUpdated").withArgs(true)
		})

		it("rejects a transfer by an approved operator", async () => {
			await c.shares.connect(c.alice).setApprovalForAll(c.bob.address, true)
			await expect(
				c.shares.connect(c.bob).safeTransferFrom(c.alice.address, c.carol.address, v.vaultId, weth(1), "0x"),
			).to.be.revertedWithCustomError(c.shares, "TransfersDisabled")
		})

		it("rejects a batch transfer", async () => {
			await expect(
				c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address, c.bob.address, [v.vaultId], [weth(1)], "0x"),
			).to.be.revertedWithCustomError(c.shares, "TransfersDisabled")
		})

		it("still lets holders claim the premium", async () => {
			await expect(c.hub.connect(c.alice).claimPremium(v.vaultId))
				.to.emit(c.premiums, "PremiumClaimed")
				.withArgs(v.vaultId, c.alice.address, PREMIUM_TOTAL)
		})

		it("still burns shares when holders claim after expiry", async () => {
			await settleVault()
			await c.hub.connect(c.alice).claim(v.vaultId, weth(10))
			expect(await c.hub.totalShares(v.vaultId)).to.equal(0n)
		})
	})

	context("with transfers enabled and alice holding six of ten shares", () => {
		beforeEach(async () => {
			;({ c, v } = await sharedCall())
		})

		it("emits TransfersEnabledUpdated when the admin disables transfers", async () => {
			await expect(c.hub.setTransfersEnabled(false)).to.emit(c.hub, "TransfersEnabledUpdated").withArgs(false)
		})

		// 7 WETH, alone or summed across a batch, pro-rates to 700 USDC of alice's 600 USDC unclaimed credit,
		// so the balance check has to fire before the premium hook.
		it("rejects a transfer beyond the sender's balance", async () => {
			await expect(c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.carol.address, v.vaultId, weth(7), "0x"))
				.to.be.revertedWithCustomError(c.shares, "ERC1155InsufficientBalance")
				.withArgs(c.alice.address, weth(6), weth(7), v.vaultId)
		})

		it("rejects a batch that repeats the vault id beyond the sender's balance, naming the combined amount", async () => {
			await expect(
				c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address, c.carol.address, [v.vaultId, v.vaultId], [weth(4), weth(3)], "0x"),
			)
				.to.be.revertedWithCustomError(c.shares, "ERC1155InsufficientBalance")
				.withArgs(c.alice.address, weth(6), weth(7), v.vaultId)
		})

		it("rejects a batch whose ids and amounts differ in length", async () => {
			await expect(c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address, c.carol.address, [v.vaultId, v.vaultId], [weth(1)], "0x"))
				.to.be.revertedWithCustomError(c.shares, "ERC1155InvalidArrayLength")
				.withArgs(2n, 1n)
		})
	})

	describe("unclaimed premium", () => {
		context("after bob claims his premium and alice sends him half her shares", () => {
			beforeEach(async () => {
				;({ c, v } = await sharedCall())
				await c.hub.connect(c.bob).claimPremium(v.vaultId)
				await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.bob.address, v.vaultId, weth(3), "0x")
			})

			it("splits alice's unclaimed premium between them", async () => {
				expect(await c.premiums.claimable(v.vaultId, c.bob.address)).to.equal(usdc(300))
				expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(usdc(300))
			})

			context("after bob sends all seven shares to carol", () => {
				beforeEach(async () => {
					await c.shares.connect(c.bob).safeTransferFrom(c.bob.address, c.carol.address, v.vaultId, weth(7), "0x")
				})

				it("moves bob's remaining credit to carol", async () => {
					expect(await c.premiums.claimable(v.vaultId, c.bob.address)).to.equal(0n)
					expect(await c.premiums.claimable(v.vaultId, c.carol.address)).to.equal(usdc(300))
				})

				context("after expiry and a partial burn by alice", () => {
					beforeEach(async () => {
						await settleVault()
						await c.hub.connect(c.alice).claim(v.vaultId, weth(1))
					})

					it("keeps alice's whole credit through the burn", async () => {
						expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(usdc(300))
					})

					context("after alice sends her last two shares to carol", () => {
						beforeEach(async () => {
							await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.carol.address, v.vaultId, weth(2), "0x")
						})

						it("adds alice's whole credit to carol's", async () => {
							expect(await c.premiums.claimable(v.vaultId, c.carol.address)).to.equal(usdc(600))
						})

						it("rejects a second premium claim by carol", async () => {
							await c.hub.connect(c.carol).claimPremium(v.vaultId)
							await expect(c.hub.connect(c.carol).claimPremium(v.vaultId)).to.be.revertedWithCustomError(c.premiums, "NothingToClaim")
						})
					})
				})
			})
		})

		context("after alice sends all her shares to carol", () => {
			beforeEach(async () => {
				;({ c, v } = await sharedCall())
				await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.carol.address, v.vaultId, weth(6), "0x")
			})

			it("moves alice's unclaimed premium to carol", async () => {
				expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(0n)
				expect(await c.premiums.claimable(v.vaultId, c.carol.address)).to.equal(usdc(600))
			})

			it("pays carol the premium that followed alice's shares", async () => {
				await expect(c.hub.connect(c.carol).claimPremium(v.vaultId)).to.changeTokenBalances(
					ethers,
					c.usdc,
					[c.carol, v.vaultAddress],
					[usdc(600), -usdc(600)],
				)
			})

			it("emits PremiumClaimed with carol and the premium she inherited", async () => {
				await expect(c.hub.connect(c.carol).claimPremium(v.vaultId))
					.to.emit(c.premiums, "PremiumClaimed")
					.withArgs(v.vaultId, c.carol.address, usdc(600))
			})

			it("rejects alice's premium claim once carol collects", async () => {
				await c.hub.connect(c.carol).claimPremium(v.vaultId)
				await expect(c.hub.connect(c.alice).claimPremium(v.vaultId)).to.be.revertedWithCustomError(c.premiums, "NothingToClaim")
			})

			context("after carol collects, the vault settles and bob burns all his shares", () => {
				beforeEach(async () => {
					await c.hub.connect(c.carol).claimPremium(v.vaultId)
					await settleVault()
					await c.hub.connect(c.bob).claim(v.vaultId, weth(4))
				})

				it("keeps bob's unclaimed premium", async () => {
					expect(await c.premiums.claimable(v.vaultId, c.bob.address)).to.equal(usdc(400))
				})

				context("after carol burns her shares too", () => {
					beforeEach(async () => {
						await c.hub.connect(c.carol).claim(v.vaultId, weth(6))
					})

					it("holds exactly bob's unclaimed premium", async () => {
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(usdc(400))
					})

					it("empties the vault when bob collects", async () => {
						await c.hub.connect(c.bob).claimPremium(v.vaultId)
						expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
					})
				})
			})
		})

		context("after alice sends a single wei of shares to carol", () => {
			beforeEach(async () => {
				;({ c, v } = await sharedCall())
				await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.carol.address, v.vaultId, 1n, "0x")
			})

			// 600 USDC over 6 WETH of shares is 1e-10 base units per wei, so one wei carries none of it.
			it("keeps the rounding dust with alice", async () => {
				expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(usdc(600))
				expect(await c.premiums.claimable(v.vaultId, c.carol.address)).to.equal(0n)
			})
		})

		context("after alice batches one share and then two more to carol", () => {
			beforeEach(async () => {
				;({ c, v } = await sharedCall())
				await c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address, c.carol.address, [v.vaultId, v.vaultId], [weth(1), weth(2)], "0x")
			})

			it("moves half of alice's unclaimed premium to carol", async () => {
				expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(usdc(300))
				expect(await c.premiums.claimable(v.vaultId, c.carol.address)).to.equal(usdc(300))
			})
		})

		context("with a premium that floors to one unit on three wei of shares", () => {
			beforeEach(async () => {
				;({ c, v } = await flooredDustCall())
			})

			it("pools the floored premium", async () => {
				expect((await c.premiums.pools(v.vaultId)).amount).to.equal(1n)
			})

			it("rejects bob's premium claim since his two thirds of a unit floors to zero", async () => {
				await expect(c.hub.connect(c.bob).claimPremium(v.vaultId)).to.be.revertedWithCustomError(c.premiums, "NothingToClaim")
			})

			context("after expiry and every LP burns their shares", () => {
				beforeEach(async () => {
					await settleVault()
					await c.hub.connect(c.alice).claim(v.vaultId, 1n)
					await c.hub.connect(c.bob).claim(v.vaultId, 2n)
				})

				it("keeps the unclaimable floor dust reserved in the vault", async () => {
					expect(await v.vault.reserved(c.usdcAddress)).to.equal(1n)
					expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(1n)
				})
			})
		})
	})
})
