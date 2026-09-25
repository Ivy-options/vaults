import { expect } from "chai"
import { ZeroAddress, ZeroHash, id } from "ethers"
import { network } from "hardhat"

import { encodePairLimits, encodePremiumFloor, encodeSpotBand } from "../../scripts/encoding.ts"
import type { Bid } from "../helpers/bids.js"
import {
	ExercisePolicy,
	ExerciseStyle,
	RuleKind,
	SettlementPolicy,
	SettlementType,
	WETH_UNIT,
	fixture,
	usdc,
	weth,
	type Loaded,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

/** A rule kind is the first four bytes of the keccak hash of its name. */
const kind = (name: string) => id(name).slice(0, 10)

// Placeholder tokens: the validator only compares addresses, and none has code.
const UNDERLYING = "0x1000000000000000000000000000000000000001"
const QUOTE = "0x2000000000000000000000000000000000000002"
const OTHER_QUOTE = "0x3000000000000000000000000000000000000003"

/** The validator treats a vault as a call when its collateral is the underlying. */
const termsWithCollateral = (collateral: string) => ({
	underlying: UNDERLYING,
	collateral,
	allowPartialExercise: true,
	publicDeposits: true,
	allowedExercise: ExercisePolicy.Either,
	allowedSettlement: SettlementPolicy.Physical,
	expiry: 4_000_000_000n,
	auctionStartsAt: 0n,
	minCollateral: 0n,
	maxSettlementPriceAge: 0,
})
const CALL = termsWithCollateral(UNDERLYING)
const PUT = termsWithCollateral(QUOTE)
const PREMIUM_IN_QUOTE = [{ quoteToken: QUOTE, premiumToken: QUOTE }]
const PREMIUM_IN_UNDERLYING = [{ quoteToken: QUOTE, premiumToken: UNDERLYING }]

/** What the hub hands a validator for a 10-unit call paying premium in the quote token. */
const CALL_CONTEXT = {
	vaultId: 1n,
	isCall: true,
	underlying: UNDERLYING,
	collateral: UNDERLYING,
	premiumToken: QUOTE,
	underlyingUnit: WETH_UNIT,
	collateralAmount: weth(10),
	totalNotional: weth(10),
	auctionOpenedAt: 0n,
}
const BID: Bid = {
	vaultId: 1n,
	marketMaker: ZeroAddress,
	quoteToken: QUOTE,
	strike: usdc(3000),
	premiumPerUnit: usdc(100),
	style: ExerciseStyle.American,
	settlement: SettlementType.Physical,
	expiry: 4_000_000_000n,
	validUntil: 4_000_000_000n,
	nonce: 1n,
	auctionId: 1n,
	collateralAmount: CALL_CONTEXT.collateralAmount,
	termsHash: ZeroHash,
	executor: ZeroAddress,
	recipient: ZeroAddress,
}

const deployed = fixture(connection, async () => {
	const rules = await ethers.deployContract("IvyBidRules")
	const feed = await ethers.deployContract("MockPriceFeed")
	return { rules, feed, feedAddress: await feed.getAddress() }
})

describe("IvyBidRules", () => {
	let rules: Loaded<typeof deployed>["rules"]
	let feed: Loaded<typeof deployed>["feed"]
	let feedAddress: string
	let configAccepted: string
	let bidAccepted: string

	beforeEach(async () => {
		;({ rules, feed, feedAddress } = await deployed())
		configAccepted = rules.interface.getFunction("validateConfig").selector
		bidAccepted = rules.interface.getFunction("validateBid").selector
	})

	it("names each rule kind by the first four bytes of its name hash", async () => {
		expect(await rules.PAIR_LIMITS()).to.equal(kind("PairLimits"))
		expect(await rules.SPOT_BAND()).to.equal(kind("SpotBand"))
		expect(await rules.PREMIUM_FLOOR()).to.equal(kind("PremiumFloor"))
	})

	describe("validateConfig", () => {
		it("rejects an unknown kind", async () => {
			await expect(rules.validateConfig(kind("Nope"), CALL, PREMIUM_IN_QUOTE, "0x"))
				.to.be.revertedWithCustomError(rules, "UnknownRuleKind")
				.withArgs(kind("Nope"))
		})

		describe("PairLimits", () => {
			it("accepts exactly one entry per pair", async () => {
				expect(await rules.validateConfig(RuleKind.PairLimits, CALL, PREMIUM_IN_QUOTE, encodePairLimits([[QUOTE, 0n, 0n]]))).to.equal(configAccepted)
			})

			it("rejects a pair without an entry", async () => {
				await expect(rules.validateConfig(RuleKind.PairLimits, CALL, PREMIUM_IN_QUOTE, encodePairLimits([])))
					.to.be.revertedWithCustomError(rules, "RuleMissingPair")
					.withArgs(QUOTE)
			})

			it("rejects an entry for a quote token the vault does not list", async () => {
				const limits = encodePairLimits([
					[QUOTE, 0n, 0n],
					[UNDERLYING, 0n, 0n],
				])
				await expect(rules.validateConfig(RuleKind.PairLimits, CALL, PREMIUM_IN_QUOTE, limits))
					.to.be.revertedWithCustomError(rules, "PairUnknown")
					.withArgs(UNDERLYING)
			})

			it("rejects a second entry for the same pair", async () => {
				const limits = encodePairLimits([
					[QUOTE, 0n, 0n],
					[QUOTE, 1n, 0n],
				])
				await expect(rules.validateConfig(RuleKind.PairLimits, CALL, PREMIUM_IN_QUOTE, limits))
					.to.be.revertedWithCustomError(rules, "DuplicatePair")
					.withArgs(QUOTE)
			})

			it("rejects a zero strike ceiling on a put", async () => {
				await expect(
					rules.validateConfig(RuleKind.PairLimits, PUT, PREMIUM_IN_QUOTE, encodePairLimits([[QUOTE, 0n, 0n]])),
				).to.be.revertedWithCustomError(rules, "InvalidStrikeLimit")
			})
		})

		describe("SpotBand", () => {
			it("accepts a deployed feed, a positive max age and a call band within 100%", async () => {
				expect(await rules.validateConfig(RuleKind.SpotBand, CALL, PREMIUM_IN_QUOTE, encodeSpotBand(feedAddress, 60, 1000))).to.equal(configAccepted)
			})

			it("rejects a feed address without code", async () => {
				await expect(
					rules.validateConfig(RuleKind.SpotBand, CALL, PREMIUM_IN_QUOTE, encodeSpotBand(UNDERLYING, 60, 1000)),
				).to.be.revertedWithCustomError(rules, "BindingMismatch")
			})

			it("rejects a zero max price age", async () => {
				await expect(
					rules.validateConfig(RuleKind.SpotBand, CALL, PREMIUM_IN_QUOTE, encodeSpotBand(feedAddress, 0, 1000)),
				).to.be.revertedWithCustomError(rules, "FeedNeedsMaxPriceAge")
			})

			it("accepts a call band of exactly 100%", async () => {
				expect(await rules.validateConfig(RuleKind.SpotBand, CALL, PREMIUM_IN_QUOTE, encodeSpotBand(feedAddress, 60, 10_000))).to.equal(
					configAccepted,
				)
			})

			it("rejects a call band above 100%", async () => {
				await expect(
					rules.validateConfig(RuleKind.SpotBand, CALL, PREMIUM_IN_QUOTE, encodeSpotBand(feedAddress, 60, 10_001)),
				).to.be.revertedWithCustomError(rules, "DeviationTooLarge")
			})

			it("accepts a put band above 100%", async () => {
				expect(await rules.validateConfig(RuleKind.SpotBand, PUT, PREMIUM_IN_QUOTE, encodeSpotBand(feedAddress, 60, 20_000))).to.equal(configAccepted)
			})
		})

		describe("PremiumFloor", () => {
			context("when every pair pays the premium in the underlying", () => {
				it("accepts a floor without a feed on a call", async () => {
					expect(await rules.validateConfig(RuleKind.PremiumFloor, CALL, PREMIUM_IN_UNDERLYING, encodePremiumFloor(ZeroAddress, 0, 500))).to.equal(
						configAccepted,
					)
				})

				it("accepts a floor without a feed on a put", async () => {
					expect(await rules.validateConfig(RuleKind.PremiumFloor, PUT, PREMIUM_IN_UNDERLYING, encodePremiumFloor(ZeroAddress, 0, 500))).to.equal(
						configAccepted,
					)
				})
			})

			context("when a pair pays the premium in the quote token", () => {
				it("rejects a floor without a feed on a call", async () => {
					await expect(
						rules.validateConfig(RuleKind.PremiumFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumFloor(ZeroAddress, 0, 500)),
					).to.be.revertedWithCustomError(rules, "BindingMismatch")
				})

				it("rejects a floor without a feed on a put, whose collateral is that quote token", async () => {
					await expect(
						rules.validateConfig(RuleKind.PremiumFloor, PUT, PREMIUM_IN_QUOTE, encodePremiumFloor(ZeroAddress, 0, 500)),
					).to.be.revertedWithCustomError(rules, "BindingMismatch")
				})

				it("accepts a floor with a deployed feed", async () => {
					expect(await rules.validateConfig(RuleKind.PremiumFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumFloor(feedAddress, 60, 500))).to.equal(
						configAccepted,
					)
				})

				it("accepts a floor of exactly 100%", async () => {
					expect(await rules.validateConfig(RuleKind.PremiumFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumFloor(feedAddress, 60, 10_000))).to.equal(
						configAccepted,
					)
				})

				const invalidFloors = [
					{ name: "a zero floor", bps: 0 },
					{ name: "a floor above 100%", bps: 10_001 },
				]
				for (const floor of invalidFloors) {
					it(`rejects ${floor.name}`, async () => {
						await expect(
							rules.validateConfig(RuleKind.PremiumFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumFloor(feedAddress, 60, floor.bps)),
						).to.be.revertedWithCustomError(rules, "InvalidPremiumFloor")
					})
				}
			})
		})
	})

	describe("validateBid", () => {
		it("rejects an unknown kind", async () => {
			await expect(rules.validateBid(kind("Nope"), CALL_CONTEXT, BID, "0x"))
				.to.be.revertedWithCustomError(rules, "UnknownRuleKind")
				.withArgs(kind("Nope"))
		})

		describe("PairLimits", () => {
			it("rejects a bid quoted in a token without an entry", async () => {
				const bid = { ...BID, quoteToken: OTHER_QUOTE }
				await expect(rules.validateBid(RuleKind.PairLimits, CALL_CONTEXT, bid, encodePairLimits([[QUOTE, 0n, 0n]])))
					.to.be.revertedWithCustomError(rules, "PairUnknown")
					.withArgs(OTHER_QUOTE)
			})
		})

		// A view call runs at the latest block's timestamp, which is the second `feed.set` mines in.
		describe("SpotBand", () => {
			context("with a spot dated the latest block", () => {
				beforeEach(async () => {
					const now = BigInt(await networkHelpers.time.latest()) + 1n
					await networkHelpers.time.setNextBlockTimestamp(now)
					await feed.set(UNDERLYING, QUOTE, usdc(3000), now)
				})

				it("accepts the spot in the second it is dated", async () => {
					expect(await rules.validateBid(RuleKind.SpotBand, CALL_CONTEXT, BID, encodeSpotBand(feedAddress, 60, 1000))).to.equal(bidAccepted)
				})
			})

			context("with a spot dated one second after the latest block", () => {
				beforeEach(async () => {
					const now = BigInt(await networkHelpers.time.latest()) + 1n
					await networkHelpers.time.setNextBlockTimestamp(now)
					await feed.set(UNDERLYING, QUOTE, usdc(3000), now + 1n)
				})

				it("rejects a spot dated one second after the latest block", async () => {
					await expect(rules.validateBid(RuleKind.SpotBand, CALL_CONTEXT, BID, encodeSpotBand(feedAddress, 60, 1000))).to.be.revertedWithCustomError(
						rules,
						"InvalidPrice",
					)
				})
			})
		})
	})
})
