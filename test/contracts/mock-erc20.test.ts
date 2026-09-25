import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import { network } from "hardhat"

import { fixture, usdc } from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

const usdcDeployed = fixture(connection, () => ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]))
const feeTokenDeployed = fixture(connection, () => ethers.deployContract("MockERC20", ["Fee", "FEE", 18]))

describe("MockERC20", () => {
	let token: Awaited<ReturnType<typeof usdcDeployed>>
	let alice: HardhatEthersSigner
	let bob: HardhatEthersSigner

	before(async () => {
		;[alice, bob] = await ethers.getSigners()
	})

	context("with 6 decimals", () => {
		beforeEach(async () => {
			token = await usdcDeployed()
		})

		it("reports its custom decimals", async () => {
			expect(await token.decimals()).to.equal(6n)
		})

		it("credits minted tokens to the recipient", async () => {
			await token.mint(alice.address, usdc(1))
			expect(await token.balanceOf(alice.address)).to.equal(usdc(1))
		})
	})

	context("with a 1% burn-on-transfer fee", () => {
		beforeEach(async () => {
			token = await feeTokenDeployed()
			await token.mint(alice.address, 1000n)
			await token.setFeeBps(100n)
		})

		it("burns the fee out of each transfer", async () => {
			await token.connect(alice).transfer(bob.address, 1000n)
			expect(await token.balanceOf(bob.address)).to.equal(990n) // 1000 less the 1% fee
			expect(await token.totalSupply()).to.equal(990n)
		})
	})
})
