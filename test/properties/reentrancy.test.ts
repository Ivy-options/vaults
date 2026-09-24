import { expect } from "chai"
import { network } from "hardhat"

import { callPairs, callTerms, createVaultAs, deployIvy, fixture, weth, type IvyContext } from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

/** What ReenteringDepositor does from inside its ERC-1155 receive hook. */
const DepositorMode = { Accept: 0n, ReenterDeposit: 1n, ReenterWithdraw: 2n } as const

const deployed = fixture(connection, () => deployIvy(connection))
const contractDepositor = fixture(deployed, async c => {
	const v = await createVaultAs(c, c.alice, callTerms(c), callPairs(c))
	const depositor = await ethers.deployContract("ReenteringDepositor", [c.hubAddress])
	const depositorAddress = await depositor.getAddress()
	await c.weth.mint(depositorAddress, weth(10))
	await depositor.approveVault(c.wethAddress, v.vaultAddress, weth(10))
	return { c, v, depositor, depositorAddress }
})

type Scenario = Awaited<ReturnType<typeof contractDepositor>>

describe("reentrancy through the share mint callback", () => {
	let c: IvyContext
	let v: Scenario["v"]
	let depositor: Scenario["depositor"]
	let depositorAddress: string

	beforeEach(async () => {
		;({ c, v, depositor, depositorAddress } = await contractDepositor())
	})

	context("with a contract depositor that accepts the shares", () => {
		beforeEach(async () => {
			await depositor.setMode(DepositorMode.Accept)
		})

		it("mints its shares through a single callback", async () => {
			await depositor.deposit(v.vaultId, weth(2))
			expect(await depositor.callbacks()).to.equal(1n)
			expect(await c.shares.balanceOf(depositorAddress, v.vaultId)).to.equal(weth(2))
			expect(await c.hub.totalShares(v.vaultId)).to.equal(weth(2))
		})
	})

	context("when the callback re-enters deposit", () => {
		beforeEach(async () => {
			await depositor.setMode(DepositorMode.ReenterDeposit)
		})

		it("reverts the whole deposit, minting no shares and leaving the collateral with the depositor", async () => {
			await expect(depositor.deposit(v.vaultId, weth(2))).to.be.revertedWithCustomError(c.hub, "ReentrancyGuardReentrantCall")
			expect(await c.shares.balanceOf(depositorAddress, v.vaultId)).to.equal(0n)
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(0n)
			expect(await c.weth.balanceOf(depositorAddress)).to.equal(weth(10))
		})
	})

	context("when the callback re-enters withdraw", () => {
		beforeEach(async () => {
			await depositor.setMode(DepositorMode.ReenterWithdraw)
		})

		it("reverts the whole deposit, minting no shares and moving no collateral", async () => {
			await expect(depositor.deposit(v.vaultId, weth(2))).to.be.revertedWithCustomError(c.hub, "ReentrancyGuardReentrantCall")
			expect(await c.shares.balanceOf(depositorAddress, v.vaultId)).to.equal(0n)
			expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(0n)
		})
	})
})
