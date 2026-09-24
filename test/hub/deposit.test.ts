import { expect } from "chai"
import { network } from "hardhat"

import {
	Phase,
	callPairs,
	callTerms,
	createVaultAs,
	deployIvy,
	fixture,
	fund,
	putPairs,
	putTerms,
	usdc,
	weth,
	type IvyContext,
	type CreatedVault,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

const deployed = fixture(connection, () => deployIvy(connection, { transfersEnabled: true }))
const publicVault = fixture(deployed, async c => ({
	c,
	v: await createVaultAs(c, c.alice, callTerms(c), callPairs(c)),
}))
const ownerOnlyVault = fixture(deployed, async c => ({
	c,
	v: await createVaultAs(c, c.alice, callTerms(c, { publicDeposits: false }), callPairs(c)),
}))
const fiveDeposited = fixture(publicVault, async ({ c, v }) => {
	await fund(c, c.weth, c.alice, v.vaultAddress, weth(5))
	await c.hub.connect(c.alice).deposit(v.vaultId, weth(5))
	return { c, v }
})
const putDeposited = fixture(deployed, async c => {
	const v = await createVaultAs(c, c.alice, putTerms(c), putPairs(c))
	await fund(c, c.usdc, c.alice, v.vaultAddress, usdc(3000))
	await c.hub.connect(c.alice).deposit(v.vaultId, usdc(3000))
	return { c, v }
})

describe("deposit", () => {
	let c: IvyContext
	let v: CreatedVault

	context("with public deposits", () => {
		beforeEach(async () => {
			;({ c, v } = await publicVault())
		})

		it("pulls the collateral into the vault and mints shares one to one", async () => {
			await fund(c, c.weth, c.alice, v.vaultAddress, weth(5))
			await expect(c.hub.connect(c.alice).deposit(v.vaultId, weth(5)))
				.to.emit(c.hub, "Deposited")
				.withArgs(v.vaultId, c.alice.address, weth(5))
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(weth(5))
			expect(await c.shares.balanceOf(c.alice.address, v.vaultId)).to.equal(weth(5))
			expect(await c.hub.totalShares(v.vaultId)).to.equal(weth(5))
		})

		it("credits only what arrives for fee-on-transfer collateral", async () => {
			await fund(c, c.weth, c.alice, v.vaultAddress, 1000n)
			await c.weth.setFeeBps(100n)
			await c.hub.connect(c.alice).deposit(v.vaultId, 1000n)
			// A 1% fee keeps 10 of the 1000 units.
			expect(await c.shares.balanceOf(c.alice.address, v.vaultId)).to.equal(990n)
		})

		it("rejects a deposit whose transfer fee burns the whole amount", async () => {
			await fund(c, c.weth, c.alice, v.vaultAddress, 1000n)
			await c.weth.setFeeBps(10_000n)
			await expect(c.hub.connect(c.alice).deposit(v.vaultId, 1000n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
		})

		it("rejects a zero amount", async () => {
			await expect(c.hub.connect(c.alice).deposit(v.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
		})

		it("rejects an unknown vault", async () => {
			await expect(c.hub.connect(c.alice).deposit(99n, 1n)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
		})
	})

	context("with owner-only deposits", () => {
		beforeEach(async () => {
			;({ c, v } = await ownerOnlyVault())
		})

		it("rejects anyone but the owner", async () => {
			await fund(c, c.weth, c.bob, v.vaultAddress, weth(1))
			await expect(c.hub.connect(c.bob).deposit(v.vaultId, weth(1))).to.be.revertedWithCustomError(c.hub, "DepositsNotPublic")
		})

		it("accepts the owner", async () => {
			await fund(c, c.weth, c.alice, v.vaultAddress, weth(1))
			await c.hub.connect(c.alice).deposit(v.vaultId, weth(1))
			expect(await c.shares.balanceOf(c.alice.address, v.vaultId)).to.equal(weth(1))
		})

		it("rejects a zero amount from a non-owner before checking who may deposit", async () => {
			await expect(c.hub.connect(c.bob).deposit(v.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
		})
	})
})

describe("onVaultDeposit", () => {
	let c: IvyContext
	let v: CreatedVault

	context("with public deposits", () => {
		beforeEach(async () => {
			;({ c, v } = await publicVault())
		})

		it("credits the depositor of a direct vault deposit", async () => {
			await fund(c, c.weth, c.bob, v.vaultAddress, weth(2))
			await expect(v.vault.connect(c.bob).deposit(weth(2)))
				.to.emit(c.hub, "Deposited")
				.withArgs(v.vaultId, c.bob.address, weth(2))
			expect(await c.shares.balanceOf(c.bob.address, v.vaultId)).to.equal(weth(2))
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(weth(2))
		})

		it("rejects a caller that is not the vault", async () => {
			await expect(c.hub.connect(c.alice).onVaultDeposit(v.vaultId, c.alice.address, 1n)).to.be.revertedWithCustomError(c.hub, "NotVault")
		})

		it("rejects an unknown vault", async () => {
			await expect(c.hub.connect(c.alice).onVaultDeposit(99n, c.alice.address, 1n)).to.be.revertedWithCustomError(c.hub, "NotVault")
		})
	})

	context("with owner-only deposits", () => {
		beforeEach(async () => {
			;({ c, v } = await ownerOnlyVault())
		})

		it("rejects a direct vault deposit from anyone but the owner", async () => {
			await fund(c, c.weth, c.bob, v.vaultAddress, weth(1))
			await expect(v.vault.connect(c.bob).deposit(weth(1))).to.be.revertedWithCustomError(c.hub, "DepositsNotPublic")
		})

		it("credits the owner's direct vault deposit", async () => {
			await fund(c, c.weth, c.alice, v.vaultAddress, weth(1))
			await expect(v.vault.connect(c.alice).deposit(weth(1)))
				.to.emit(c.hub, "Deposited")
				.withArgs(v.vaultId, c.alice.address, weth(1))
		})
	})
})

describe("withdraw", () => {
	let c: IvyContext
	let v: CreatedVault

	context("after a 5 WETH deposit", () => {
		beforeEach(async () => {
			;({ c, v } = await fiveDeposited())
		})

		it("burns the shares and returns the collateral", async () => {
			const tx = c.hub.connect(c.alice).withdraw(v.vaultId, weth(2))
			await expect(tx).to.emit(c.hub, "Withdrawn").withArgs(v.vaultId, c.alice.address, weth(2))
			await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.alice, v.vaultAddress], [weth(2), -weth(2)])
			expect(await c.shares.balanceOf(c.alice.address, v.vaultId)).to.equal(weth(3))
		})

		it("rejects a zero amount", async () => {
			await expect(c.hub.connect(c.alice).withdraw(v.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount")
		})

		context("and a 2 WETH withdrawal", () => {
			beforeEach(async () => {
				await c.hub.connect(c.alice).withdraw(v.vaultId, weth(2))
			})

			it("rejects more than the remaining shares", async () => {
				await expect(c.hub.connect(c.alice).withdraw(v.vaultId, weth(4))).to.be.revertedWithCustomError(c.shares, "ERC1155InsufficientBalance")
			})
		})
	})

	context("after a 3,000 USDC deposit into a put vault", () => {
		beforeEach(async () => {
			;({ c, v } = await putDeposited())
		})

		it("returns the USDC collateral", async () => {
			await expect(c.hub.connect(c.alice).withdraw(v.vaultId, usdc(1000))).to.changeTokenBalances(
				ethers,
				c.usdc,
				[c.alice, v.vaultAddress],
				[usdc(1000), -usdc(1000)],
			)
		})
	})

	context("after shares are transferred", () => {
		beforeEach(async () => {
			;({ c, v } = await publicVault())
			await fund(c, c.weth, c.alice, v.vaultAddress, weth(3))
			await c.hub.connect(c.alice).deposit(v.vaultId, weth(3))
			await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.bob.address, v.vaultId, weth(1), "0x")
		})

		it("lets the new holder withdraw them while the vault stays open", async () => {
			await expect(c.hub.connect(c.bob).withdraw(v.vaultId, weth(1))).to.changeTokenBalances(ethers, c.weth, [c.bob], [weth(1)])
			expect(await c.shares.balanceOf(c.bob.address, v.vaultId)).to.equal(0n)
			expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Open)
		})
	})
})
