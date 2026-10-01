import { expect } from "chai"
import { ZeroAddress, ZeroHash, id } from "ethers"
import { network } from "hardhat"

import {
	encodeExpiryDates,
	encodeImpliedVolAttestation,
	encodePremiumVolFloor,
	encodePremiumMin,
	encodeStrikeRange,
	encodePremiumSpotFloor,
	encodeStrikeSpotBand,
	encodeExpiryTenor,
	encodePremiumYieldFloor,
	hashMarketMakerData,
} from "../../scripts/encoding.ts"
import type { Bid } from "../helpers/bids.js"
import {
	ExercisePolicy,
	ExerciseStyle,
	MAX_UINT,
	NO_OTM_LIMIT,
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
const YEAR = 365n * 24n * 3600n
const DAY = 24n * 3600n

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
	auctionStartsAt: 0n,
	minCollateral: 0n,
	maxSettlementPriceAge: 0,
})
const CALL = termsWithCollateral(UNDERLYING)
const PUT = termsWithCollateral(QUOTE)
const PREMIUM_IN_QUOTE = [{ quoteToken: QUOTE, premiumToken: QUOTE }]
const PREMIUM_IN_UNDERLYING = [{ quoteToken: QUOTE, premiumToken: UNDERLYING }]

/** What the hub hands a validator for a 10-unit put paying premium in the quote token. */
const PUT_CONTEXT = {
	vaultId: 1n,
	isCall: false,
	underlying: UNDERLYING,
	collateral: QUOTE,
	premiumToken: QUOTE,
	underlyingUnit: WETH_UNIT,
	collateralAmount: usdc(30_000),
	totalNotional: weth(10),
	auctionOpenedAt: 0n,
}

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
	marketMakerDataHash: hashMarketMakerData([]),
	executor: ZeroAddress,
	recipient: ZeroAddress,
}

const deployed = fixture(connection, async () => {
	const feed = await ethers.deployContract("MockPriceFeed")
	const rules = await ethers.deployContract("IvyStandardBidRules", [await feed.getAddress()])
	return { rules, feed, feedAddress: await feed.getAddress() }
})

describe("IvyStandardBidRules", () => {
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

	/** Asks the validator about `bid` on a call, with empty data slots unless given. */
	const check = (
		ruleKind: string,
		config: string,
		o: { bid?: Partial<Bid>; context?: typeof CALL_CONTEXT; marketMakerData?: string; bidMasterData?: string } = {},
	) => rules.validateBid(ruleKind, o.context ?? CALL_CONTEXT, { ...BID, ...o.bid }, config, o.marketMakerData ?? "0x", o.bidMasterData ?? "0x")

	/** The timestamp a view call runs at: the latest block's. */
	const latest = async () => BigInt(await networkHelpers.time.latest())

	/** Dates `price` for UNDERLYING/QUOTE in a freshly mined block, which later view calls run at. */
	const setSpot = async (price: bigint) => {
		const now = (await latest()) + 1n
		await networkHelpers.time.setNextBlockTimestamp(now)
		await feed.set(UNDERLYING, QUOTE, price, now)
		return now
	}

	describe("constructor", () => {
		it("rejects a trusted price feed without code", async () => {
			const [signer] = await ethers.getSigners()
			await expect(ethers.deployContract("IvyStandardBidRules", [signer.address])).to.be.revertedWithCustomError(
				{ interface: (await ethers.getContractFactory("IvyStandardBidRules")).interface },
				"BindingMismatch",
			)
		})
	})

	it("names each rule kind by the first four bytes of its name hash", async () => {
		expect(await rules.STRIKE_RANGE()).to.equal(kind("StrikeRange"))
		expect(await rules.STRIKE_SPOT_BAND()).to.equal(kind("StrikeSpotBand"))
		expect(await rules.PREMIUM_MIN()).to.equal(kind("PremiumMin"))
		expect(await rules.PREMIUM_SPOT_FLOOR()).to.equal(kind("PremiumSpotFloor"))
		expect(await rules.PREMIUM_YIELD_FLOOR()).to.equal(kind("PremiumYieldFloor"))
		expect(await rules.PREMIUM_VOL_FLOOR()).to.equal(kind("PremiumVolFloor"))
		expect(await rules.EXPIRY_TENOR()).to.equal(kind("ExpiryTenor"))
		expect(await rules.EXPIRY_DATES()).to.equal(kind("ExpiryDates"))
	})

	describe("validateConfig", () => {
		it("rejects an unknown kind", async () => {
			await expect(rules.validateConfig(kind("Nope"), CALL, PREMIUM_IN_QUOTE, "0x"))
				.to.be.revertedWithCustomError(rules, "UnknownRuleKind")
				.withArgs(kind("Nope"))
		})

		const perPairKinds = [
			{ name: "StrikeRange", kind: RuleKind.StrikeRange, encode: (quotes: string[]) => encodeStrikeRange(quotes.map(q => [q, 1n, 1n])) },
			{ name: "PremiumMin", kind: RuleKind.PremiumMin, encode: (quotes: string[]) => encodePremiumMin(quotes.map(q => [q, 1n])) },
		]
		for (const rule of perPairKinds) {
			describe(`${rule.name} pair coverage`, () => {
				it("accepts exactly one entry per pair", async () => {
					expect(await rules.validateConfig(rule.kind, CALL, PREMIUM_IN_QUOTE, rule.encode([QUOTE]))).to.equal(configAccepted)
				})

				it("rejects a pair without an entry", async () => {
					await expect(rules.validateConfig(rule.kind, CALL, PREMIUM_IN_QUOTE, rule.encode([])))
						.to.be.revertedWithCustomError(rules, "RuleMissingPair")
						.withArgs(QUOTE)
				})

				it("rejects an entry for a quote token the vault does not list", async () => {
					await expect(rules.validateConfig(rule.kind, CALL, PREMIUM_IN_QUOTE, rule.encode([QUOTE, UNDERLYING])))
						.to.be.revertedWithCustomError(rules, "PairUnknown")
						.withArgs(UNDERLYING)
				})

				it("rejects a second entry for the same pair", async () => {
					await expect(rules.validateConfig(rule.kind, CALL, PREMIUM_IN_QUOTE, rule.encode([QUOTE, QUOTE])))
						.to.be.revertedWithCustomError(rules, "DuplicatePair")
						.withArgs(QUOTE)
				})
			})
		}

		describe("StrikeRange", () => {
			it("accepts an open-ended ceiling", async () => {
				expect(await rules.validateConfig(RuleKind.StrikeRange, CALL, PREMIUM_IN_QUOTE, encodeStrikeRange([[QUOTE, 1n, MAX_UINT]]))).to.equal(
					configAccepted,
				)
			})

			it("accepts a range of one strike", async () => {
				expect(
					await rules.validateConfig(RuleKind.StrikeRange, PUT, PREMIUM_IN_QUOTE, encodeStrikeRange([[QUOTE, usdc(3000), usdc(3000)]])),
				).to.equal(configAccepted)
			})

			const invalidRanges = [
				{ name: "a zero strike floor", min: 0n, max: usdc(3000) },
				{ name: "a zero strike ceiling", min: 0n, max: 0n },
				{ name: "a floor above the ceiling", min: usdc(3001), max: usdc(3000) },
			]
			for (const range of invalidRanges) {
				it(`rejects ${range.name}`, async () => {
					await expect(
						rules.validateConfig(RuleKind.StrikeRange, PUT, PREMIUM_IN_QUOTE, encodeStrikeRange([[QUOTE, range.min, range.max]])),
					).to.be.revertedWithCustomError(rules, "InvalidStrikeRange")
				})
			}
		})

		describe("PremiumMin", () => {
			it("rejects a zero minimum", async () => {
				await expect(
					rules.validateConfig(RuleKind.PremiumMin, CALL, PREMIUM_IN_QUOTE, encodePremiumMin([[QUOTE, 0n]])),
				).to.be.revertedWithCustomError(rules, "PremiumTooLow")
			})
		})

		describe("StrikeSpotBand", () => {
			it("accepts a deployed feed, a positive max age and a call band within 100%", async () => {
				expect(
					await rules.validateConfig(RuleKind.StrikeSpotBand, CALL, PREMIUM_IN_QUOTE, encodeStrikeSpotBand(feedAddress, 60, 1000, NO_OTM_LIMIT)),
				).to.equal(configAccepted)
			})

			it("rejects a feed address without code", async () => {
				await expect(
					rules.validateConfig(RuleKind.StrikeSpotBand, CALL, PREMIUM_IN_QUOTE, encodeStrikeSpotBand(UNDERLYING, 60, 1000, NO_OTM_LIMIT)),
				).to.be.revertedWithCustomError(rules, "BindingMismatch")
			})

			it("rejects a deployed feed other than the release's trusted feed", async () => {
				const other = await ethers.deployContract("MockPriceFeed")
				await expect(
					rules.validateConfig(
						RuleKind.StrikeSpotBand,
						CALL,
						PREMIUM_IN_QUOTE,
						encodeStrikeSpotBand(await other.getAddress(), 60, 1000, NO_OTM_LIMIT),
					),
				).to.be.revertedWithCustomError(rules, "BindingMismatch")
			})

			it("rejects a zero max price age", async () => {
				await expect(
					rules.validateConfig(RuleKind.StrikeSpotBand, CALL, PREMIUM_IN_QUOTE, encodeStrikeSpotBand(feedAddress, 0, 1000, NO_OTM_LIMIT)),
				).to.be.revertedWithCustomError(rules, "FeedNeedsMaxPriceAge")
			})

			it("accepts a call band of exactly 100%", async () => {
				expect(
					await rules.validateConfig(RuleKind.StrikeSpotBand, CALL, PREMIUM_IN_QUOTE, encodeStrikeSpotBand(feedAddress, 60, 10_000, NO_OTM_LIMIT)),
				).to.equal(configAccepted)
			})

			it("rejects a call band above 100%", async () => {
				await expect(
					rules.validateConfig(RuleKind.StrikeSpotBand, CALL, PREMIUM_IN_QUOTE, encodeStrikeSpotBand(feedAddress, 60, 10_001, NO_OTM_LIMIT)),
				).to.be.revertedWithCustomError(rules, "DeviationTooLarge")
			})

			it("accepts a put band above 100%", async () => {
				expect(
					await rules.validateConfig(RuleKind.StrikeSpotBand, PUT, PREMIUM_IN_QUOTE, encodeStrikeSpotBand(feedAddress, 60, 20_000, NO_OTM_LIMIT)),
				).to.equal(configAccepted)
			})
		})

		describe("PremiumSpotFloor", () => {
			context("when every pair pays the premium in the underlying", () => {
				it("accepts a floor without a feed on a call", async () => {
					expect(
						await rules.validateConfig(RuleKind.PremiumSpotFloor, CALL, PREMIUM_IN_UNDERLYING, encodePremiumSpotFloor(ZeroAddress, 0, 500)),
					).to.equal(configAccepted)
				})

				it("accepts a floor without a feed on a put", async () => {
					expect(
						await rules.validateConfig(RuleKind.PremiumSpotFloor, PUT, PREMIUM_IN_UNDERLYING, encodePremiumSpotFloor(ZeroAddress, 0, 500)),
					).to.equal(configAccepted)
				})
			})

			context("when a pair pays the premium in the quote token", () => {
				it("rejects a floor without a feed on a call", async () => {
					await expect(
						rules.validateConfig(RuleKind.PremiumSpotFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumSpotFloor(ZeroAddress, 0, 500)),
					).to.be.revertedWithCustomError(rules, "BindingMismatch")
				})

				it("rejects a floor without a feed on a put, whose collateral is that quote token", async () => {
					await expect(
						rules.validateConfig(RuleKind.PremiumSpotFloor, PUT, PREMIUM_IN_QUOTE, encodePremiumSpotFloor(ZeroAddress, 0, 500)),
					).to.be.revertedWithCustomError(rules, "BindingMismatch")
				})

				it("accepts a floor with a deployed feed", async () => {
					expect(
						await rules.validateConfig(RuleKind.PremiumSpotFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumSpotFloor(feedAddress, 60, 500)),
					).to.equal(configAccepted)
				})

				it("accepts a floor of exactly 100%", async () => {
					expect(
						await rules.validateConfig(RuleKind.PremiumSpotFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumSpotFloor(feedAddress, 60, 10_000)),
					).to.equal(configAccepted)
				})

				const invalidFloors = [
					{ name: "a zero floor", bps: 0 },
					{ name: "a floor above 100%", bps: 10_001 },
				]
				for (const floor of invalidFloors) {
					it(`rejects ${floor.name}`, async () => {
						await expect(
							rules.validateConfig(RuleKind.PremiumSpotFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumSpotFloor(feedAddress, 60, floor.bps)),
						).to.be.revertedWithCustomError(rules, "InvalidPremiumFloor")
					})
				}
			})
		})

		describe("PremiumYieldFloor", () => {
			it("accepts a floor without a feed when every pair pays the premium in the underlying", async () => {
				expect(
					await rules.validateConfig(RuleKind.PremiumYieldFloor, CALL, PREMIUM_IN_UNDERLYING, encodePremiumYieldFloor(ZeroAddress, 0, 500)),
				).to.equal(configAccepted)
			})

			it("accepts an annual rate above 100%", async () => {
				expect(
					await rules.validateConfig(RuleKind.PremiumYieldFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumYieldFloor(feedAddress, 60, 15_000)),
				).to.equal(configAccepted)
			})

			it("rejects a floor without a feed when a pair pays the premium in the quote token", async () => {
				await expect(
					rules.validateConfig(RuleKind.PremiumYieldFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumYieldFloor(ZeroAddress, 0, 500)),
				).to.be.revertedWithCustomError(rules, "BindingMismatch")
			})

			it("rejects a zero annual rate", async () => {
				await expect(
					rules.validateConfig(RuleKind.PremiumYieldFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumYieldFloor(feedAddress, 60, 0)),
				).to.be.revertedWithCustomError(rules, "InvalidPremiumFloor")
			})
		})

		describe("ExpiryTenor", () => {
			const validRanges = [
				{ name: "a range", min: 10n * DAY, max: 30n * DAY },
				{ name: "a single tenor", min: 7n * DAY, max: 7n * DAY },
				{ name: "a range with no minimum", min: 0n, max: 30n * DAY },
			]
			for (const range of validRanges) {
				it(`accepts ${range.name}`, async () => {
					expect(await rules.validateConfig(RuleKind.ExpiryTenor, CALL, PREMIUM_IN_QUOTE, encodeExpiryTenor(range.min, range.max))).to.equal(
						configAccepted,
					)
				})
			}

			const invalidRanges = [
				{ name: "a zero maximum", min: 0n, max: 0n },
				{ name: "a minimum above the maximum", min: 30n * DAY, max: 10n * DAY },
			]
			for (const range of invalidRanges) {
				it(`rejects ${range.name}`, async () => {
					await expect(
						rules.validateConfig(RuleKind.ExpiryTenor, CALL, PREMIUM_IN_QUOTE, encodeExpiryTenor(range.min, range.max)),
					).to.be.revertedWithCustomError(rules, "InvalidExpiryTenor")
				})
			}
		})

		describe("ExpiryDates", () => {
			it("accepts a window that ends after the latest block", async () => {
				const now = await latest()
				expect(await rules.validateConfig(RuleKind.ExpiryDates, CALL, PREMIUM_IN_QUOTE, encodeExpiryDates(now, now + 1n))).to.equal(configAccepted)
			})

			it("rejects a window that ends at the latest block", async () => {
				const now = await latest()
				await expect(
					rules.validateConfig(RuleKind.ExpiryDates, CALL, PREMIUM_IN_QUOTE, encodeExpiryDates(now - DAY, now)),
				).to.be.revertedWithCustomError(rules, "InvalidExpiryDates")
			})

			it("rejects a window that starts after it ends", async () => {
				const now = await latest()
				await expect(
					rules.validateConfig(RuleKind.ExpiryDates, CALL, PREMIUM_IN_QUOTE, encodeExpiryDates(now + 2n * DAY, now + DAY)),
				).to.be.revertedWithCustomError(rules, "InvalidExpiryDates")
			})
		})

		describe("PremiumVolFloor", () => {
			it("accepts a positive minimum", async () => {
				expect(await rules.validateConfig(RuleKind.PremiumVolFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumVolFloor(6000))).to.equal(configAccepted)
			})

			it("rejects a zero minimum", async () => {
				await expect(rules.validateConfig(RuleKind.PremiumVolFloor, CALL, PREMIUM_IN_QUOTE, encodePremiumVolFloor(0))).to.be.revertedWithCustomError(
					rules,
					"InvalidVolFloor",
				)
			})
		})
	})

	describe("validateBid", () => {
		it("rejects an unknown kind", async () => {
			await expect(check(kind("Nope"), "0x"))
				.to.be.revertedWithCustomError(rules, "UnknownRuleKind")
				.withArgs(kind("Nope"))
		})

		describe("StrikeRange", () => {
			const range = encodeStrikeRange([[QUOTE, usdc(2900), usdc(3100)]])

			it("rejects a bid quoted in a token without an entry", async () => {
				await expect(check(RuleKind.StrikeRange, encodeStrikeRange([[QUOTE, 1n, 1n]]), { bid: { quoteToken: OTHER_QUOTE } }))
					.to.be.revertedWithCustomError(rules, "PairUnknown")
					.withArgs(OTHER_QUOTE)
			})

			const kinds = [
				{ name: "call", context: CALL_CONTEXT },
				{ name: "put", context: PUT_CONTEXT },
			]
			for (const { name, context: vault } of kinds) {
				context(`on a ${name}`, () => {
					it("accepts a strike at either end of the range", async () => {
						expect(await check(RuleKind.StrikeRange, range, { context: vault, bid: { strike: usdc(2900) } })).to.equal(bidAccepted)
						expect(await check(RuleKind.StrikeRange, range, { context: vault, bid: { strike: usdc(3100) } })).to.equal(bidAccepted)
					})

					it("rejects a strike below the range", async () => {
						await expect(check(RuleKind.StrikeRange, range, { context: vault, bid: { strike: usdc(2900) - 1n } })).to.be.revertedWithCustomError(
							rules,
							"StrikeBelowRange",
						)
					})

					it("rejects a strike above the range", async () => {
						await expect(check(RuleKind.StrikeRange, range, { context: vault, bid: { strike: usdc(3100) + 1n } })).to.be.revertedWithCustomError(
							rules,
							"StrikeAboveRange",
						)
					})
				})
			}
		})

		describe("PremiumMin", () => {
			const min = encodePremiumMin([[QUOTE, usdc(50)]])

			it("rejects a bid quoted in a token without an entry", async () => {
				await expect(check(RuleKind.PremiumMin, min, { bid: { quoteToken: OTHER_QUOTE } }))
					.to.be.revertedWithCustomError(rules, "PairUnknown")
					.withArgs(OTHER_QUOTE)
			})

			it("accepts a premium at the pair's minimum", async () => {
				expect(await check(RuleKind.PremiumMin, min, { bid: { premiumPerUnit: usdc(50) } })).to.equal(bidAccepted)
			})

			it("rejects a premium below the pair's minimum", async () => {
				await expect(check(RuleKind.PremiumMin, min, { bid: { premiumPerUnit: usdc(50) - 1n } })).to.be.revertedWithCustomError(
					rules,
					"PremiumTooLow",
				)
			})
		})

		// A view call runs at the latest block's timestamp, which is the second `feed.set` mines in.
		describe("StrikeSpotBand", () => {
			context("with a spot dated the latest block", () => {
				beforeEach(async () => {
					const now = BigInt(await networkHelpers.time.latest()) + 1n
					await networkHelpers.time.setNextBlockTimestamp(now)
					await feed.set(UNDERLYING, QUOTE, usdc(3000), now)
				})

				it("accepts the spot in the second it is dated", async () => {
					expect(await check(RuleKind.StrikeSpotBand, encodeStrikeSpotBand(feedAddress, 60, 1000, NO_OTM_LIMIT))).to.equal(bidAccepted)
				})

				// Spot 3000 with a 10% out-of-the-money limit: calls up to 3300, puts down to 2700.
				const band = () => encodeStrikeSpotBand(feedAddress, 60, 1000, 1000)

				it("accepts a call strike at the out-of-the-money ceiling", async () => {
					expect(await check(RuleKind.StrikeSpotBand, band(), { bid: { strike: usdc(3300) } })).to.equal(bidAccepted)
				})

				it("rejects a call strike above the out-of-the-money ceiling", async () => {
					await expect(check(RuleKind.StrikeSpotBand, band(), { bid: { strike: usdc(3300) + 1n } })).to.be.revertedWithCustomError(
						rules,
						"StrikeOutsideSpotBand",
					)
				})

				it("accepts a put strike at the out-of-the-money floor", async () => {
					expect(await check(RuleKind.StrikeSpotBand, band(), { context: PUT_CONTEXT, bid: { strike: usdc(2700) } })).to.equal(bidAccepted)
				})

				it("rejects a put strike below the out-of-the-money floor", async () => {
					await expect(
						check(RuleKind.StrikeSpotBand, band(), { context: PUT_CONTEXT, bid: { strike: usdc(2700) - 1n } }),
					).to.be.revertedWithCustomError(rules, "StrikeOutsideSpotBand")
				})

				it("sets no put floor from a 100% out-of-the-money limit", async () => {
					const noFloor = encodeStrikeSpotBand(feedAddress, 60, 1000, 10_000)
					expect(await check(RuleKind.StrikeSpotBand, noFloor, { context: PUT_CONTEXT, bid: { strike: 1n } })).to.equal(bidAccepted)
				})
			})

			context("with a spot dated one second after the latest block", () => {
				beforeEach(async () => {
					const now = BigInt(await networkHelpers.time.latest()) + 1n
					await networkHelpers.time.setNextBlockTimestamp(now)
					await feed.set(UNDERLYING, QUOTE, usdc(3000), now + 1n)
				})

				it("rejects a spot dated one second after the latest block", async () => {
					await expect(check(RuleKind.StrikeSpotBand, encodeStrikeSpotBand(feedAddress, 60, 1000, NO_OTM_LIMIT))).to.be.revertedWithCustomError(
						rules,
						"InvalidPrice",
					)
				})
			})
		})

		describe("PremiumYieldFloor", () => {
			// Spot 3000 at a 10% annual rate: a tenth of a year needs 30 USDC per unit.
			const floor = () => encodePremiumYieldFloor(feedAddress, 60, 1000)
			let now: bigint

			beforeEach(async () => {
				now = await setSpot(usdc(3000))
			})

			it("accepts a premium at the floor for its tenor", async () => {
				expect(await check(RuleKind.PremiumYieldFloor, floor(), { bid: { expiry: now + YEAR / 10n, premiumPerUnit: usdc(30) } })).to.equal(
					bidAccepted,
				)
			})

			it("rejects a premium just below the floor for its tenor", async () => {
				await expect(
					check(RuleKind.PremiumYieldFloor, floor(), { bid: { expiry: now + YEAR / 10n, premiumPerUnit: usdc(30) - 1n } }),
				).to.be.revertedWithCustomError(rules, "PremiumTooLow")
			})

			it("asks twice the premium for twice the tenor", async () => {
				await expect(
					check(RuleKind.PremiumYieldFloor, floor(), { bid: { expiry: now + YEAR / 5n, premiumPerUnit: usdc(30) } }),
				).to.be.revertedWithCustomError(rules, "PremiumTooLow")
				expect(await check(RuleKind.PremiumYieldFloor, floor(), { bid: { expiry: now + YEAR / 5n, premiumPerUnit: usdc(60) } })).to.equal(bidAccepted)
			})

			it("prices a premium paid in the underlying without the feed", async () => {
				const context = { ...CALL_CONTEXT, premiumToken: UNDERLYING }
				const noFeed = encodePremiumYieldFloor(ZeroAddress, 0, 1000)
				// One whole underlying at 10% for a tenth of a year: 0.01 underlying.
				const bid = { expiry: now + YEAR / 10n, premiumPerUnit: WETH_UNIT / 100n }
				expect(await check(RuleKind.PremiumYieldFloor, noFeed, { context, bid })).to.equal(bidAccepted)
				await expect(
					check(RuleKind.PremiumYieldFloor, noFeed, { context, bid: { ...bid, premiumPerUnit: bid.premiumPerUnit - 1n } }),
				).to.be.revertedWithCustomError(rules, "PremiumTooLow")
			})
		})

		describe("ExpiryTenor", () => {
			const range = encodeExpiryTenor(10n * DAY, 30n * DAY)
			let now: bigint

			beforeEach(async () => {
				now = await latest()
			})

			it("accepts an expiry at either end of the range", async () => {
				expect(await check(RuleKind.ExpiryTenor, range, { bid: { expiry: now + 10n * DAY } })).to.equal(bidAccepted)
				expect(await check(RuleKind.ExpiryTenor, range, { bid: { expiry: now + 30n * DAY } })).to.equal(bidAccepted)
			})

			it("rejects an expiry one second short of the minimum tenor", async () => {
				await expect(check(RuleKind.ExpiryTenor, range, { bid: { expiry: now + 10n * DAY - 1n } })).to.be.revertedWithCustomError(
					rules,
					"ExpiryOutsideTenor",
				)
			})

			it("rejects an expiry one second past the maximum tenor", async () => {
				await expect(check(RuleKind.ExpiryTenor, range, { bid: { expiry: now + 30n * DAY + 1n } })).to.be.revertedWithCustomError(
					rules,
					"ExpiryOutsideTenor",
				)
			})
		})

		describe("ExpiryDates", () => {
			const window = encodeExpiryDates(4_000_000_000n, 4_100_000_000n)

			it("accepts an expiry at either end of the window", async () => {
				expect(await check(RuleKind.ExpiryDates, window, { bid: { expiry: 4_000_000_000n } })).to.equal(bidAccepted)
				expect(await check(RuleKind.ExpiryDates, window, { bid: { expiry: 4_100_000_000n } })).to.equal(bidAccepted)
			})

			it("rejects an expiry before the window", async () => {
				await expect(check(RuleKind.ExpiryDates, window, { bid: { expiry: 4_000_000_000n - 1n } })).to.be.revertedWithCustomError(
					rules,
					"ExpiryOutsideDates",
				)
			})

			it("rejects an expiry after the window", async () => {
				await expect(check(RuleKind.ExpiryDates, window, { bid: { expiry: 4_100_000_000n + 1n } })).to.be.revertedWithCustomError(
					rules,
					"ExpiryOutsideDates",
				)
			})
		})

		describe("PremiumVolFloor", () => {
			const minimum = encodePremiumVolFloor(6000)

			it("accepts a bid the bid master attests at the minimum", async () => {
				expect(await check(RuleKind.PremiumVolFloor, minimum, { bidMasterData: encodeImpliedVolAttestation(6000) })).to.equal(bidAccepted)
			})

			it("rejects a bid the bid master attests below the minimum", async () => {
				await expect(check(RuleKind.PremiumVolFloor, minimum, { bidMasterData: encodeImpliedVolAttestation(5999) })).to.be.revertedWithCustomError(
					rules,
					"VolTooLow",
				)
			})

			it("rejects a bid without an attestation", async () => {
				await expect(check(RuleKind.PremiumVolFloor, minimum)).to.be.revertedWithCustomError(rules, "MissingAttestation")
			})

			it("rejects an attestation of the wrong length", async () => {
				await expect(check(RuleKind.PremiumVolFloor, minimum, { bidMasterData: "0x1770" })).to.be.revertedWithCustomError(rules, "MissingAttestation")
			})

			it("ignores the market maker's claim of its own volatility", async () => {
				await expect(check(RuleKind.PremiumVolFloor, minimum, { marketMakerData: encodeImpliedVolAttestation(9000) })).to.be.revertedWithCustomError(
					rules,
					"MissingAttestation",
				)
			})
		})
	})
})
