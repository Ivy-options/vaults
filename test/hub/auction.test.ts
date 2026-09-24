import { expect } from "chai"
import { ZeroAddress } from "ethers"
import { network } from "hardhat"

import { at, openVault, AUCTION_START } from "../helpers/scenarios.js"
import {
	AUCTION_TIMEOUT,
	Phase,
	callPairs,
	callTerms,
	createVaultAs,
	deployIvy,
	fixture,
	fund,
	weth,
	type IvyContext,
	type CreatedVault,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

// A fixed start time far beyond the test chain's clock.

const deployed = fixture(connection, () => deployIvy(connection))
const emptyVault = fixture(deployed, async c => ({
	c,
	v: await createVaultAs(c, c.alice, callTerms(c), callPairs(c)),
}))
/** A vault with a 5 WETH minimum holding alice's `amount` WETH. */
const depositedAgainstFiveMinimum = (amount: bigint) =>
	fixture(deployed, async c => {
		const v = await createVaultAs(c, c.alice, callTerms(c, { minCollateral: weth(5) }), callPairs(c))
		await fund(c, c.weth, c.alice, v.vaultAddress, amount)
		await c.hub.connect(c.alice).deposit(v.vaultId, amount)
		return { c, v }
	})
const sixDeposited = depositedAgainstFiveMinimum(weth(6))
const atMinimum = depositedAgainstFiveMinimum(weth(5))
const belowMinimum = depositedAgainstFiveMinimum(weth(4))
const auctionOpen = fixture(sixDeposited, async ({ c, v }) => {
	await c.hub.connect(c.alice).openAuction(v.vaultId)
	return { c, v }
})
const scheduledAuctionOpen = fixture(sixDeposited, async ({ c, v }) => {
	await c.hub.connect(c.alice).scheduleAuction(v.vaultId, BigInt(await networkHelpers.time.latest()) + 10n)
	await c.hub.connect(c.alice).openAuction(v.vaultId)
	return { c, v }
})
const auctionNearExpiry = fixture(deployed, async c => {
	const expiry = BigInt(await networkHelpers.time.latest()) + 100n
	return { c, v: await openVault(c, { terms: { expiry } }) }
})

describe("openAuction", () => {
	let c: IvyContext
	let v: CreatedVault

	context("with collateral above the minimum", () => {
		beforeEach(async () => {
			;({ c, v } = await sixDeposited())
		})

		it("lets the owner open it for the deposited collateral", async () => {
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).to.emit(c.hub, "AuctionOpened").withArgs(v.vaultId, weth(6))
			const state = await c.hub.stateOf(v.vaultId)
			expect(state.phase).to.equal(Phase.Auction)
			expect(state.auctionOpenedAt).to.equal(BigInt(await networkHelpers.time.latest()))
		})

		it("announces the new auction id", async () => {
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).to.emit(c.hub, "AuctionIdentity").withArgs(v.vaultId, 1n)
		})

		it("opens one second before the option expiry", async () => {
			await at(c, (await c.hub.termsOf(v.vaultId)).expiry - 1n)
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).to.emit(c.hub, "AuctionOpened").withArgs(v.vaultId, weth(6))
		})

		it("rejects opening at exactly the option expiry", async () => {
			await at(c, (await c.hub.termsOf(v.vaultId)).expiry)
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "ExpiryInPast")
		})

		it("rejects a stranger while no start time is set", async () => {
			await expect(c.hub.connect(c.bob).openAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "AuctionNotStartable")
		})

		context("when a start time is scheduled", () => {
			let startsAt: bigint

			beforeEach(async () => {
				startsAt = BigInt(await networkHelpers.time.latest()) + 1000n
				await c.hub.connect(c.alice).scheduleAuction(v.vaultId, startsAt)
			})

			it("rejects a stranger one second before the scheduled start", async () => {
				await at(c, startsAt - 1n)
				await expect(c.hub.connect(c.bob).openAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "AuctionNotStartable")
			})

			it("lets a stranger open it at exactly the scheduled start", async () => {
				await at(c, startsAt)
				await expect(c.hub.connect(c.bob).openAuction(v.vaultId)).to.emit(c.hub, "AuctionOpened").withArgs(v.vaultId, weth(6))
			})
		})
	})

	context("with collateral exactly at the minimum", () => {
		beforeEach(async () => {
			;({ c, v } = await atMinimum())
		})

		it("opens for the minimum collateral", async () => {
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).to.emit(c.hub, "AuctionOpened").withArgs(v.vaultId, weth(5))
		})
	})

	context("below the minimum collateral", () => {
		beforeEach(async () => {
			;({ c, v } = await belowMinimum())
		})

		it("reverts with BelowMinCollateral", async () => {
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId))
				.to.be.revertedWithCustomError(c.hub, "BelowMinCollateral")
				.withArgs(weth(4), weth(5))
		})
	})

	context("with no collateral", () => {
		beforeEach(async () => {
			;({ c, v } = await emptyVault())
		})

		it("reverts with ZeroAmount", async () => {
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
		})
	})

	context("once the auction is open", () => {
		beforeEach(async () => {
			;({ c, v } = await auctionOpen())
			await fund(c, c.weth, c.alice, v.vaultAddress, weth(1))
		})

		it("rejects a hub deposit", async () => {
			await expect(c.hub.connect(c.alice).deposit(v.vaultId, weth(1)))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Open, Phase.Auction)
		})

		it("rejects a direct vault deposit", async () => {
			await expect(v.vault.connect(c.alice).deposit(weth(1)))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Open, Phase.Auction)
		})

		it("rejects a withdrawal", async () => {
			await expect(c.hub.connect(c.alice).withdraw(v.vaultId, weth(1)))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Open, Phase.Auction)
		})

		it("rejects rescheduling", async () => {
			await expect(c.hub.connect(c.alice).scheduleAuction(v.vaultId, 1n))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Open, Phase.Auction)
		})

		it("rejects opening it again", async () => {
			await expect(c.hub.connect(c.alice).openAuction(v.vaultId))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Open, Phase.Auction)
		})
	})
})

describe("cancelAuction", () => {
	let c: IvyContext
	let v: CreatedVault

	context("before the auction opens", () => {
		beforeEach(async () => {
			;({ c, v } = await sixDeposited())
		})

		it("reverts with WrongPhase", async () => {
			await expect(c.hub.connect(c.bidMaster).cancelAuction(v.vaultId))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Auction, Phase.Open)
		})
	})

	context("while the auction is open", () => {
		beforeEach(async () => {
			;({ c, v } = await auctionOpen())
		})

		it("lets the bid master cancel at once and returns the vault to Open", async () => {
			await expect(c.hub.connect(c.bidMaster).cancelAuction(v.vaultId)).to.emit(c.hub, "AuctionCancelled").withArgs(v.vaultId)
			const state = await c.hub.stateOf(v.vaultId)
			expect(state.phase).to.equal(Phase.Open)
			expect(state.auctionOpenedAt).to.equal(0n)
		})

		it("lets the owner reopen it after a bid master cancel", async () => {
			await c.hub.connect(c.bidMaster).cancelAuction(v.vaultId)
			await c.hub.connect(c.alice).openAuction(v.vaultId)
			expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Auction)
		})
	})

	context("while a scheduled auction is open", () => {
		beforeEach(async () => {
			;({ c, v } = await scheduledAuctionOpen())
		})

		it("rejects the owner one second before the timeout", async () => {
			await at(c, (await c.hub.stateOf(v.vaultId)).auctionOpenedAt + AUCTION_TIMEOUT - 1n)
			await expect(c.hub.connect(c.alice).cancelAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "AuctionTimeoutNotReached")
		})

		it("lets the owner cancel at exactly the timeout", async () => {
			await at(c, (await c.hub.stateOf(v.vaultId)).auctionOpenedAt + AUCTION_TIMEOUT)
			await expect(c.hub.connect(c.alice).cancelAuction(v.vaultId)).to.emit(c.hub, "AuctionCancelled").withArgs(v.vaultId)
		})

		it("rejects anyone but the owner or the bid master", async () => {
			await expect(c.hub.connect(c.bob).cancelAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "NotVaultOwner")
		})

		context("after the timeout", () => {
			beforeEach(async () => {
				await networkHelpers.time.increase(AUCTION_TIMEOUT)
			})

			it("lets the owner cancel and clears the start time", async () => {
				await c.hub.connect(c.alice).cancelAuction(v.vaultId)
				expect((await c.hub.termsOf(v.vaultId)).auctionStartsAt).to.equal(0n)
			})

			it("leaves no schedule a stranger could reopen", async () => {
				await c.hub.connect(c.alice).cancelAuction(v.vaultId)
				await expect(c.hub.connect(c.bob).openAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "AuctionNotStartable")
			})
		})
	})

	context("while an auction is open shortly before the option expiry", () => {
		beforeEach(async () => {
			;({ c, v } = await auctionNearExpiry())
		})

		it("rejects the owner one second before the option expiry", async () => {
			await at(c, (await c.hub.stateOf(v.vaultId)).expiry - 1n)
			await expect(c.hub.connect(c.alice).cancelAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "AuctionTimeoutNotReached")
		})

		it("lets the owner cancel at exactly the option expiry", async () => {
			await at(c, (await c.hub.stateOf(v.vaultId)).expiry)
			await expect(c.hub.connect(c.alice).cancelAuction(v.vaultId)).to.emit(c.hub, "AuctionCancelled").withArgs(v.vaultId)
		})

		context("once the owner cancels at the option expiry", () => {
			beforeEach(async () => {
				await at(c, (await c.hub.stateOf(v.vaultId)).expiry)
				await c.hub.connect(c.alice).cancelAuction(v.vaultId)
			})

			it("rejects reopening the auction", async () => {
				await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).to.be.revertedWithCustomError(c.hub, "ExpiryInPast")
			})

			it("lets the owner withdraw the collateral", async () => {
				await expect(c.hub.connect(c.alice).withdraw(v.vaultId, weth(10))).to.changeTokenBalance(ethers, c.weth, c.alice, weth(10))
			})
		})
	})
})

describe("scheduleAuction", () => {
	let c: IvyContext
	let v: CreatedVault

	context("on an open vault", () => {
		beforeEach(async () => {
			;({ c, v } = await emptyVault())
		})

		it("lets the owner set the start time", async () => {
			await expect(c.hub.connect(c.alice).scheduleAuction(v.vaultId, AUCTION_START))
				.to.emit(c.hub, "AuctionScheduled")
				.withArgs(v.vaultId, AUCTION_START)
			expect((await c.hub.termsOf(v.vaultId)).auctionStartsAt).to.equal(AUCTION_START)
		})

		it("rejects anyone but the owner", async () => {
			await expect(c.hub.connect(c.bob).scheduleAuction(v.vaultId, 1n)).to.be.revertedWithCustomError(c.hub, "NotVaultOwner")
		})
	})

	context("after a scheduled vault changes owner", () => {
		beforeEach(async () => {
			;({ c, v } = await emptyVault())
			await c.hub.connect(c.alice).scheduleAuction(v.vaultId, AUCTION_START)
			await c.hub.connect(c.alice).transferVaultOwnership(v.vaultId, c.bob.address)
		})

		it("rejects the previous owner", async () => {
			await expect(c.hub.connect(c.alice).scheduleAuction(v.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "NotVaultOwner")
		})

		it("lets the new owner clear the start time", async () => {
			await c.hub.connect(c.bob).scheduleAuction(v.vaultId, 0n)
			expect((await c.hub.termsOf(v.vaultId)).auctionStartsAt).to.equal(0n)
		})
	})
})

describe("transferVaultOwnership", () => {
	let c: IvyContext
	let v: CreatedVault

	context("with a vault owned by alice", () => {
		beforeEach(async () => {
			;({ c, v } = await emptyVault())
		})

		it("hands the vault to the new owner", async () => {
			await expect(c.hub.connect(c.alice).transferVaultOwnership(v.vaultId, c.bob.address))
				.to.emit(c.hub, "VaultOwnershipTransferred")
				.withArgs(v.vaultId, c.alice.address, c.bob.address)
		})

		it("rejects anyone but the owner", async () => {
			await expect(c.hub.connect(c.bob).transferVaultOwnership(v.vaultId, c.bob.address)).to.be.revertedWithCustomError(c.hub, "NotVaultOwner")
		})

		it("rejects the zero address", async () => {
			await expect(c.hub.connect(c.alice).transferVaultOwnership(v.vaultId, ZeroAddress)).to.be.revertedWithCustomError(c.hub, "ZeroAddress")
		})
	})
})
