import { expect } from "chai"
import { network } from "hardhat"

import { STRIKE } from "../helpers/scenarios.js"
import { WETH_UNIT, usdc, weth } from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

const deployHarness = () => ethers.deployContract("IvyMathHarness")

describe("IvyMath", () => {
	let math: Awaited<ReturnType<typeof deployHarness>>

	before(async () => {
		math = await deployHarness()
	})

	describe("notionalOf", () => {
		context("for a call", () => {
			it("equals the collateral", async () => {
				expect(await math.notionalOf(true, weth(10), WETH_UNIT, STRIKE)).to.equal(weth(10))
			})

			it("ignores the strike", async () => {
				expect(await math.notionalOf(true, weth(10), WETH_UNIT, 0n)).to.equal(weth(10))
			})
		})

		context("for a put", () => {
			it("divides the collateral by the strike", async () => {
				expect(await math.notionalOf(false, usdc(30_000), WETH_UNIT, STRIKE)).to.equal(weth(10))
			})

			it("rounds down", async () => {
				// 30,001 / 3000 = 10.000333… WETH, floored to the wei.
				expect(await math.notionalOf(false, usdc(30_001), WETH_UNIT, STRIKE)).to.equal(10_000_333_333_333_333_333n)
			})

			it("is zero at a zero strike", async () => {
				expect(await math.notionalOf(false, usdc(30_000), WETH_UNIT, 0n)).to.equal(0n)
			})
		})
	})

	describe("premiumTotal", () => {
		it("charges the per-unit premium on the whole notional", async () => {
			expect(await math.premiumTotal(usdc(100), weth(10), WETH_UNIT)).to.equal(usdc(1000))
		})

		it("rounds down", async () => {
			expect(await math.premiumTotal(1n, 1n, WETH_UNIT)).to.equal(0n)
		})
	})

	describe("strikeValueRoundedUp", () => {
		it("rounds a single wei of notional up to one quote unit", async () => {
			expect(await math.strikeValueRoundedUp(1n, STRIKE, WETH_UNIT)).to.equal(1n)
		})

		it("prices whole units at the strike", async () => {
			expect(await math.strikeValueRoundedUp(weth(4), STRIKE, WETH_UNIT)).to.equal(usdc(12_000))
		})
	})

	describe("strikeValueRoundedDown", () => {
		it("rounds a single wei of notional down to zero", async () => {
			expect(await math.strikeValueRoundedDown(1n, STRIKE, WETH_UNIT)).to.equal(0n)
		})

		it("prices whole units at the strike", async () => {
			expect(await math.strikeValueRoundedDown(weth(4), STRIKE, WETH_UNIT)).to.equal(usdc(12_000))
		})
	})

	describe("callIntrinsic", () => {
		it("pays the in-the-money value in the underlying", async () => {
			// 4 WETH × (3300 − 3000) / 3300, floored to the wei.
			expect(await math.callIntrinsic(weth(4), STRIKE, usdc(3300))).to.equal(363_636_363_636_363_636n)
		})

		const worthless = [
			{ name: "at the money", spot: STRIKE },
			{ name: "out of the money", spot: usdc(2000) },
		]
		for (const { name, spot } of worthless) {
			it(`is zero ${name}`, async () => {
				expect(await math.callIntrinsic(weth(4), STRIKE, spot)).to.equal(0n)
			})
		}

		it("is zero at a zero strike and zero spot without dividing by the spot", async () => {
			expect(await math.callIntrinsic(weth(4), 0n, 0n)).to.equal(0n)
		})
	})

	describe("putIntrinsic", () => {
		it("pays the in-the-money value in the quote token", async () => {
			expect(await math.putIntrinsic(weth(4), STRIKE, usdc(2700), WETH_UNIT)).to.equal(usdc(1200))
		})

		const worthless = [
			{ name: "at the money", spot: STRIKE },
			{ name: "out of the money", spot: usdc(4000) },
		]
		for (const { name, spot } of worthless) {
			it(`is zero ${name}`, async () => {
				expect(await math.putIntrinsic(weth(4), STRIKE, spot, WETH_UNIT)).to.equal(0n)
			})
		}
	})

	describe("spotBound", () => {
		// 1000 bps is a 10% band around a 3000 USDC spot.
		it("sits below the spot for a call", async () => {
			expect(await math.spotBound(true, usdc(3000), 1000)).to.equal(usdc(2700))
		})

		it("sits above the spot for a put", async () => {
			expect(await math.spotBound(false, usdc(3000), 1000)).to.equal(usdc(3300))
		})

		it("equals the spot with a zero band", async () => {
			expect(await math.spotBound(true, usdc(3000), 0)).to.equal(usdc(3000))
		})

		// One base unit over 3000 USDC leaves a remainder: 90% is 2700.0000009 and 110% is 3300.0000011.
		it("rounds the call bound down", async () => {
			expect(await math.spotBound(true, usdc(3000) + 1n, 1000)).to.equal(usdc(2700))
		})

		it("rounds the put bound down", async () => {
			expect(await math.spotBound(false, usdc(3000) + 1n, 1000)).to.equal(usdc(3300) + 1n)
		})
	})
})
