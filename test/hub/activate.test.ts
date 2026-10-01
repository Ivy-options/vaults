import { expect } from "chai"
import { AbiCoder, ZeroAddress, id } from "ethers"
import { network } from "hardhat"

import { encodeImpliedVolAttestation, hashMarketMakerData } from "../../scripts/encoding.ts"
import { signBid, type Bid } from "../helpers/bids.js"
import {
	CALL_DEPOSIT,
	PREMIUM_PER_UNIT,
	PUT_DEPOSIT,
	STRIKE,
	TENOR,
	activate,
	at,
	makeBid,
	openVault,
	setSpot,
	PREMIUM_TOTAL,
	type OpenedVault,
} from "../helpers/scenarios.js"
import {
	ExercisePolicy,
	ExerciseStyle,
	Phase,
	RuleKind,
	SettlementType,
	WETH_UNIT,
	callPairs,
	callTerms,
	createVaultAs,
	deployIvy,
	expiryWindowRule,
	fixture,
	fund,
	minImpliedVolRule,
	premiumFloorRule,
	putPairs,
	putTerms,
	tenorRangeRule,
	usdc,
	weth,
	type IvyContext,
	type Loaded,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

/** A rule whose kind and data only the given validator interprets. */
const customRule = (validator: string, kind = "0x00000000") => ({ validator, kind, data: "0x" })
const allowValidator = (c: IvyContext, validator: string) => c.hub.grantRole(id("BID_VALIDATOR_ROLE"), validator)

const DAY = 24n * 3600n

/** The bid master submits `bid` on `vaultId`, signed by `signer`, with any per-rule data slots. */
async function submit(
	c: IvyContext,
	vaultId: bigint,
	bid: Bid,
	signer = c.marketMaker,
	data: { marketMakerData?: string[]; bidMasterData?: string[] } = {},
) {
	const signature = await signBid(signer, c.hubAddress, bid)
	return c.hub.connect(c.bidMaster).activate(vaultId, bid, data.marketMakerData ?? [], signature, data.bidMasterData ?? [])
}

/** SlotEchoValidator config: the only market-maker and bid-master slots it accepts. */
const echoes = (marketMakerData: string, bidMasterData: string) =>
	AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [marketMakerData, bidMasterData])

const deployed = fixture(connection, () => deployIvy(connection))
const physicalCall = fixture(deployed, async c => ({ c, v: await openVault(c) }))
const physicalPut = fixture(deployed, async c => ({ c, v: await openVault(c, { isCall: false }) }))
const livePhysicalPut = fixture(physicalPut, async ({ c, v }) => {
	await activate(c, v.vaultId, v.vaultAddress)
	return { c, v }
})
const callWithFeed = fixture(deployed, async c => ({ c, v: await openVault(c, { withFeed: true }) }))
const putWithFeed = fixture(deployed, async c => ({
	c,
	v: await openVault(c, { isCall: false, withFeed: true, pair: { maxStrike: usdc(10_000) } }),
}))
const europeanOnlyCall = fixture(deployed, async c => ({
	c,
	v: await openVault(c, { terms: { allowedExercise: ExercisePolicy.European } }),
}))
const callAfterNonce500 = fixture(deployed, async c => {
	const first = await openVault(c)
	await activate(c, first.vaultId, first.vaultAddress, { nonce: 500n })
	return { c, v: await openVault(c) }
})
const dustPut = fixture(deployed, async c => {
	const six = await c.ethers.deployContract("MockERC20", ["Six", "SIX", 6])
	const terms = putTerms(c, { underlying: await six.getAddress() })
	const vault = await createVaultAs(c, c.alice, terms, putPairs(c))
	await fund(c, c.usdc, c.alice, vault.vaultAddress, 1n)
	await c.hub.connect(c.alice).deposit(vault.vaultId, 1n)
	await c.hub.connect(c.alice).openAuction(vault.vaultId)
	return { c, v: { ...vault, isCall: false, deposit: 1n } }
})

const callWithStrikeLimit = fixture(deployed, async c => ({
	c,
	v: await openVault(c, { pair: { minStrike: usdc(3100) } }),
}))
const putWithStrikeLimit = fixture(deployed, async c => ({
	c,
	v: await openVault(c, { isCall: false, pair: { maxStrike: usdc(2900) } }),
}))
const callWithMinPremium = fixture(deployed, async c => ({
	c,
	v: await openVault(c, { pair: { minPremiumPerUnit: usdc(200) } }),
}))
const callWithLimitsAndBand = fixture(deployed, async c => ({
	c,
	v: await openVault(c, { pair: { minStrike: usdc(3100), minPremiumPerUnit: usdc(50) }, withFeed: true }),
}))
const approveThenReject = fixture(deployed, async c => {
	const reject = await c.ethers.deployContract("RejectAllValidator")
	const approve = await c.ethers.deployContract("ApproveAllValidator")
	await allowValidator(c, await reject.getAddress())
	await allowValidator(c, await approve.getAddress())
	const rules = [customRule(await approve.getAddress(), RuleKind.PairLimits), customRule(await reject.getAddress(), RuleKind.PairLimits)]
	return { c, v: await openVault(c, { rules }), reject }
})
const limitsThenPremiumFloor = fixture(deployed, async c => {
	const v = await openVault(c, {
		pair: { minStrike: usdc(3100), minPremiumPerUnit: 1n },
		rules: [premiumFloorRule(c, { maxPriceAge: 3600, minPremiumBps: 500 })],
	})
	await setSpot(c, STRIKE)
	return { c, v }
})
const twinCalls = fixture(deployed, async c => {
	const v = await openVault(c, { pair: { minPremiumPerUnit: 1n } })
	// The terms hash excludes the auction schedule, so only this start time differs.
	const twin = await openVault(c, { terms: { auctionStartsAt: 1_900_000_000n }, pair: { minPremiumPerUnit: 1n } })
	return { c, v, twin }
})
const tenorCall = fixture(deployed, async c => ({ c, v: await openVault(c, { expiryRules: [tenorRangeRule(c, 10n * DAY, 30n * DAY)] }) }))
/** A window from 20 to 40 days out, and a 10 to 30 day tenor: together, 20 to 30 days. */
const windowedTenorCall = fixture(deployed, async c => {
	const now = BigInt(await c.networkHelpers.time.latest())
	const window = { notBefore: now + 20n * DAY, notAfter: now + 40n * DAY }
	const v = await openVault(c, { expiryRules: [tenorRangeRule(c, 10n * DAY, 30n * DAY), expiryWindowRule(c, window.notBefore, window.notAfter)] })
	return { c, v, window }
})
/** Rules 0 and 1 are PairLimits and TenorRange; rules 2 and 3 each accept only their own slots. */
const echoCall = fixture(deployed, async c => {
	const echo = await c.ethers.deployContract("SlotEchoValidator")
	const address = await echo.getAddress()
	await allowValidator(c, address)
	const rules = [
		{ validator: address, kind: "0x00000000", data: echoes("0xaa02", "0xbb02") },
		{ validator: address, kind: "0x00000000", data: echoes("0xaa03", "0xbb03") },
	]
	return { c, v: await openVault(c, { rules }), echo }
})
/** Rule 2 accepts only empty slots. */
const emptyEchoCall = fixture(deployed, async c => {
	const echo = await c.ethers.deployContract("SlotEchoValidator")
	await allowValidator(c, await echo.getAddress())
	return { c, v: await openVault(c, { rules: [{ validator: await echo.getAddress(), kind: "0x00000000", data: echoes("0x", "0x") }] }) }
})
/** Rule 2 is MinImpliedVol at 60%. */
const volCall = fixture(deployed, async c => ({ c, v: await openVault(c, { rules: [minImpliedVolRule(c, 6000)] }) }))
const approvedEuropeanOnlyCall = fixture(deployed, async c => {
	const approve = await c.ethers.deployContract("ApproveAllValidator")
	await allowValidator(c, await approve.getAddress())
	return {
		c,
		v: await openVault(c, {
			terms: { allowedExercise: ExercisePolicy.European },
			rules: [customRule(await approve.getAddress())],
		}),
	}
})
const stateWritingRule = fixture(deployed, async c => {
	const writer = await c.ethers.deployContract("StateWritingValidator")
	await allowValidator(c, await writer.getAddress())
	return { c, v: await openVault(c, { rules: [customRule(await writer.getAddress())] }), writer }
})
const auctionAgeRule = fixture(deployed, async c => {
	const validator = await c.ethers.deployContract("ContextAssertingValidator", [c.usdcAddress, CALL_DEPOSIT, 600])
	await allowValidator(c, await validator.getAddress())
	return { c, v: await openVault(c, { rules: [customRule(await validator.getAddress())] }), validator }
})
const wrongPremiumTokenRule = fixture(deployed, async c => {
	const validator = await c.ethers.deployContract("ContextAssertingValidator", [c.daiAddress, CALL_DEPOSIT, 0])
	await allowValidator(c, await validator.getAddress())
	return { c, v: await openVault(c, { rules: [customRule(await validator.getAddress())] }), validator }
})
const putContextRule = fixture(deployed, async c => {
	const validator = await c.ethers.deployContract("ContextAssertingValidator", [c.usdcAddress, weth(10), 0])
	await allowValidator(c, await validator.getAddress())
	return { c, v: await openVault(c, { isCall: false, rules: [customRule(await validator.getAddress())] }) }
})
const wrongBidSelectorRule = fixture(deployed, async c => {
	const validator = await c.ethers.deployContract("WrongBidSelectorValidator")
	await allowValidator(c, await validator.getAddress())
	return { c, v: await openVault(c, { rules: [customRule(await validator.getAddress())] }) }
})
const wethPremiumFloor = fixture(deployed, async c => {
	const rules = [premiumFloorRule(c, { priceFeed: ZeroAddress, maxPriceAge: 0, minPremiumBps: 100 })]
	return { c, v: await openVault(c, { premiumToken: c.wethAddress, rules }) }
})

const contractBuyer = fixture(deployed, async c => {
	const wallet = await c.ethers.deployContract("Mock1271", [c.marketMaker.address])
	const buyer = await wallet.getAddress()
	await c.hub.grantRole(await c.hub.MARKET_MAKER_ROLE(), buyer)
	const v = await openVault(c)
	await c.usdc.mint(buyer, PREMIUM_TOTAL)
	await wallet.connect(c.marketMaker).execute(c.usdcAddress, c.usdc.interface.encodeFunctionData("approve", [v.vaultAddress, PREMIUM_TOTAL]))
	const bid = await makeBid(c, v.vaultId, { marketMaker: buyer, recipient: c.carol.address, executor: c.bob.address })
	return { c, v, wallet, bid }
})
const liveContractBuyer = fixture(contractBuyer, async s => {
	await submit(s.c, s.v.vaultId, s.bid)
	return s
})
describe("activate", () => {
	let c: IvyContext
	let v: OpenedVault

	context("before the auction opens", () => {
		beforeEach(async () => {
			c = await deployed()
		})

		it("reverts with WrongPhase", async () => {
			const { vaultId, vaultAddress } = await createVaultAs(c, c.alice, callTerms(c), callPairs(c))
			await expect(activate(c, vaultId, vaultAddress))
				.to.be.revertedWithCustomError(c.hub, "WrongPhase")
				.withArgs(Phase.Auction, Phase.Open)
		})
	})

	context("physical call", () => {
		beforeEach(async () => {
			;({ c, v } = await physicalCall())
		})

		context("with a funded bid", () => {
			let bid: Bid

			beforeEach(async () => {
				bid = await makeBid(c, v.vaultId)
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
			})

			it("emits Activated with the bid terms, the notional and the premium", async () => {
				await expect(submit(c, v.vaultId, bid))
					.to.emit(c.hub, "Activated")
					.withArgs(
						v.vaultId,
						c.marketMaker.address,
						c.usdcAddress,
						c.usdcAddress,
						STRIKE,
						PREMIUM_PER_UNIT,
						ExerciseStyle.American,
						SettlementType.Physical,
						bid.expiry,
						CALL_DEPOSIT,
						PREMIUM_TOTAL,
					)
			})

			it("pulls the premium from the market maker into the vault", async () => {
				await submit(c, v.vaultId, bid)
				expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(PREMIUM_TOTAL)
				expect(await c.usdc.balanceOf(c.marketMaker.address)).to.equal(0n)
			})

			it("records the option and makes the vault live", async () => {
				await submit(c, v.vaultId, bid)
				const s = await c.hub.stateOf(v.vaultId)
				expect(s.phase).to.equal(Phase.Live)
				expect(s.marketMaker).to.equal(c.marketMaker.address)
				expect(s.quoteToken).to.equal(c.usdcAddress)
				expect(s.premiumToken).to.equal(c.usdcAddress)
				expect(s.strike).to.equal(STRIKE)
				expect(s.premiumPerUnit).to.equal(PREMIUM_PER_UNIT)
				expect(s.style).to.equal(ExerciseStyle.American)
				expect(s.settlement).to.equal(SettlementType.Physical)
				expect(s.expiry).to.equal(bid.expiry)
				expect(s.totalNotional).to.equal(CALL_DEPOSIT)
				expect(s.exercisedNotional).to.equal(0n)
				expect(await c.hub.remainingNotional(v.vaultId)).to.equal(CALL_DEPOSIT)
			})

			it("marks the bid nonce used", async () => {
				await submit(c, v.vaultId, bid)
				expect(await c.hub.usedBidNonces(c.marketMaker.address, bid.nonce)).to.equal(true)
			})

			it("rejects a caller without the bid master role", async () => {
				const signature = await signBid(c.marketMaker, c.hubAddress, bid)
				await expect(c.hub.connect(c.alice).activate(v.vaultId, bid, [], signature, [])).to.be.revertedWithCustomError(
					c.hub,
					"AccessControlUnauthorizedAccount",
				)
			})

			it("rejects a signature from anyone but the market maker", async () => {
				await expect(submit(c, v.vaultId, bid, c.bob)).to.be.revertedWithCustomError(c.hub, "BadSignature")
			})

			it("accepts the bid in its validUntil second", async () => {
				await at(c, bid.validUntil)
				await submit(c, v.vaultId, bid)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("rejects the bid one second after validUntil", async () => {
				await at(c, bid.validUntil + 1n)
				await expect(submit(c, v.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "BidExpired")
			})

			const commitments = [
				{
					name: "one more unit of collateral",
					change: (b: Bid) => ({ ...b, collateralAmount: b.collateralAmount + 1n }),
				},
				{ name: "a zero terms hash", change: (b: Bid) => ({ ...b, termsHash: "0x" + "00".repeat(32) }) },
				{ name: "another terms hash", change: (b: Bid) => ({ ...b, termsHash: "0x" + "22".repeat(32) }) },
				{ name: "market-maker data it does not carry", change: (b: Bid) => ({ ...b, marketMakerDataHash: hashMarketMakerData(["0x01"]) }) },
			]
			for (const { name, change } of commitments) {
				it(`rejects a bid committing to ${name}`, async () => {
					await expect(submit(c, v.vaultId, change(bid))).to.be.revertedWithCustomError(c.hub, "CommitmentMismatch")
				})
			}
		})

		it("rejects a bid for another vault", async () => {
			await expect(activate(c, v.vaultId, v.vaultAddress, { vaultId: v.vaultId + 1n })).to.be.revertedWithCustomError(c.hub, "BidVaultMismatch")
		})

		it("rejects a market maker without the role", async () => {
			const bid = await makeBid(c, v.vaultId, { marketMaker: c.bob.address })
			await expect(submit(c, v.vaultId, bid, c.bob)).to.be.revertedWithCustomError(c.hub, "NotMarketMaker")
		})

		it("rejects a bid paying a zero recipient", async () => {
			await expect(activate(c, v.vaultId, v.vaultAddress, { recipient: ZeroAddress })).to.be.revertedWithCustomError(c.hub, "ZeroAddress")
		})

		it("rejects an unknown pair", async () => {
			await expect(activate(c, v.vaultId, v.vaultAddress, { quoteToken: c.daiAddress }))
				.to.be.revertedWithCustomError(c.hub, "PairUnknown")
				.withArgs(c.daiAddress)
		})

		it("rejects an expiry that has already passed", async () => {
			const now = BigInt(await networkHelpers.time.latest())
			await expect(activate(c, v.vaultId, v.vaultAddress, { expiry: now })).to.be.revertedWithCustomError(c.hub, "ExpiryInPast")
		})

		context("with a funded bid valid past the option expiry", () => {
			let bid: Bid

			beforeEach(async () => {
				bid = await makeBid(c, v.vaultId, { validFor: TENOR })
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
			})

			it("accepts the bid one second before the expiry", async () => {
				await at(c, bid.expiry - 1n)
				await submit(c, v.vaultId, bid)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("rejects the bid in the expiry second", async () => {
				await at(c, bid.expiry)
				await expect(submit(c, v.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "ExpiryInPast")
			})
		})

		it("rejects cash settlement when the vault allows only physical", async () => {
			await expect(activate(c, v.vaultId, v.vaultAddress, { settlement: SettlementType.Cash })).to.be.revertedWithCustomError(
				c.hub,
				"SettlementNotAllowed",
			)
		})

		it("rejects a premium that arrives short", async () => {
			await c.usdc.setFeeBps(100n)
			await expect(activate(c, v.vaultId, v.vaultAddress))
				.to.be.revertedWithCustomError(v.vault, "ShortReceived")
				.withArgs(PREMIUM_TOTAL, usdc(990))
		})

		context("after the auction is cancelled and reopened unchanged", () => {
			let bid: Bid

			beforeEach(async () => {
				bid = await makeBid(c, v.vaultId)
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, usdc(10_000))
				await c.hub.connect(c.bidMaster).cancelAuction(v.vaultId)
				await c.hub.connect(c.alice).openAuction(v.vaultId)
			})

			it("rejects a bid signed for the earlier auction", async () => {
				await expect(submit(c, v.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "CommitmentMismatch")
			})
		})
	})

	context("physical put once activated", () => {
		beforeEach(async () => {
			;({ c, v } = await livePhysicalPut())
		})

		it("derives the notional from the strike", async () => {
			expect((await c.hub.stateOf(v.vaultId)).totalNotional).to.equal(weth(10))
		})

		it("adds the premium to the quote-token collateral", async () => {
			expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(PUT_DEPOSIT + PREMIUM_TOTAL)
		})
	})

	context("call allowing either settlement", () => {
		beforeEach(async () => {
			;({ c, v } = await callWithFeed())
		})

		it("accepts cash settlement", async () => {
			await activate(c, v.vaultId, v.vaultAddress, { settlement: SettlementType.Cash })
			expect((await c.hub.stateOf(v.vaultId)).settlement).to.equal(SettlementType.Cash)
		})
	})

	context("European-only call", () => {
		beforeEach(async () => {
			;({ c, v } = await europeanOnlyCall())
		})

		it("rejects an American bid", async () => {
			await expect(activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.American })).to.be.revertedWithCustomError(c.hub, "StyleNotAllowed")
		})

		it("accepts a European bid", async () => {
			await activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.European })
			expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
		})
	})

	context("after nonce 500 activated another vault", () => {
		beforeEach(async () => {
			;({ c, v } = await callAfterNonce500())
		})

		it("rejects a bid reusing that nonce", async () => {
			await expect(activate(c, v.vaultId, v.vaultAddress, { nonce: 500n })).to.be.revertedWithCustomError(c.hub, "NonceUsed")
		})

		it("rejects a bid with a nonce the market maker cancelled", async () => {
			await c.hub.connect(c.marketMaker).cancelBid(501n)
			await expect(activate(c, v.vaultId, v.vaultAddress, { nonce: 501n })).to.be.revertedWithCustomError(c.hub, "NonceUsed")
		})
	})

	context("put on a six-decimal underlying with one unit of collateral", () => {
		beforeEach(async () => {
			;({ c, v } = await dustPut())
		})

		it("rejects a bid whose notional rounds to zero", async () => {
			await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "EmptyNotional")
		})
	})

	describe("bid rules", () => {
		context("call with a 3100 USDC strike limit", () => {
			beforeEach(async () => {
				;({ c, v } = await callWithStrikeLimit())
			})

			it("rejects a lower strike", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "StrikeBelowLimit")
			})
		})

		context("put with a 2900 USDC strike limit", () => {
			beforeEach(async () => {
				;({ c, v } = await putWithStrikeLimit())
			})

			it("rejects a higher strike", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "StrikeAboveLimit")
			})

			it("accepts a strike on the limit", async () => {
				await activate(c, v.vaultId, v.vaultAddress, { strike: usdc(2900) })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})
		})

		context("call with a 200 USDC minimum premium", () => {
			beforeEach(async () => {
				;({ c, v } = await callWithMinPremium())
			})

			it("rejects a lower premium", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "PremiumTooLow")
			})
		})

		context("call with a 10% spot band", () => {
			beforeEach(async () => {
				;({ c, v } = await callWithFeed())
			})

			it("rejects a strike below the band", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: usdc(2699) })).to.be.revertedWithCustomError(c.hub, "StrikeOutsideSpotBand")
			})

			it("accepts a strike on the lower band edge", async () => {
				// 10% below the 3000 spot.
				await activate(c, v.vaultId, v.vaultAddress, { strike: usdc(2700) })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("rejects a zero spot price", async () => {
				await setSpot(c, 0n)
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			it("rejects a future-dated spot price", async () => {
				const future = BigInt(await networkHelpers.time.latest()) + 1000n
				await c.feed.set(c.wethAddress, c.usdcAddress, STRIKE, future)
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			context("with a funded bid and a spot observed now", () => {
				let bid: Bid
				let observedAt: bigint

				beforeEach(async () => {
					bid = await makeBid(c, v.vaultId, { validFor: 2n * 3600n })
					await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
					observedAt = BigInt(await networkHelpers.time.latest())
					await c.feed.set(c.wethAddress, c.usdcAddress, STRIKE, observedAt)
				})

				it("accepts the spot at exactly its one-hour age limit", async () => {
					await at(c, observedAt + 3600n)
					await submit(c, v.vaultId, bid)
					expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
				})

				it("rejects the spot one second past its one-hour age limit", async () => {
					await at(c, observedAt + 3601n)
					await expect(submit(c, v.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "StalePrice")
				})
			})
		})

		context("put with a 10% spot band", () => {
			beforeEach(async () => {
				;({ c, v } = await putWithFeed())
			})

			it("rejects a strike above the band", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: usdc(3301) })).to.be.revertedWithCustomError(c.hub, "StrikeOutsideSpotBand")
			})

			it("accepts a strike on the upper band edge", async () => {
				// 10% above the 3000 spot.
				await activate(c, v.vaultId, v.vaultAddress, { strike: usdc(3300) })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})
		})

		context("call with pair limits and a spot band", () => {
			beforeEach(async () => {
				;({ c, v } = await callWithLimitsAndBand())
			})

			it("rejects a strike below the 3100 USDC limit", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "StrikeBelowLimit")
			})

			it("rejects a premium below the 50 USDC minimum", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: usdc(3100), premiumPerUnit: usdc(49) })).to.be.revertedWithCustomError(
					c.hub,
					"PremiumTooLow",
				)
			})

			it("rejects a strike outside the band once spot moves to 4000", async () => {
				await setSpot(c, usdc(4000))
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: usdc(3100) })).to.be.revertedWithCustomError(c.hub, "StrikeOutsideSpotBand")
			})

			it("accepts a bid that meets the limits within the band", async () => {
				await activate(c, v.vaultId, v.vaultAddress, { strike: usdc(3100) })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})
		})

		context("call mandatory checks", () => {
			beforeEach(async () => {
				;({ c, v } = await physicalCall())
			})

			it("rejects a zero strike", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: 0n })).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			it("rejects a zero total premium", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { premiumPerUnit: 0n })).to.be.revertedWithCustomError(c.hub, "PremiumTooLow")
			})
		})

		context("put mandatory checks and limits", () => {
			beforeEach(async () => {
				;({ c, v } = await physicalPut())
			})

			it("rejects a zero strike, whose notional is empty", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: 0n })).to.be.revertedWithCustomError(c.hub, "InvalidPrice")
			})

			it("rejects a huge strike whose one-wei notional rounds the premium to zero", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: 3n * 10n ** 28n, premiumPerUnit: 1n })).to.be.revertedWithCustomError(
					c.hub,
					"PremiumTooLow",
				)
			})

			it("rejects the huge strike even when its one-wei notional produces a nonzero premium", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: 3n * 10n ** 28n, premiumPerUnit: WETH_UNIT })).to.be.revertedWithCustomError(
					c.hub,
					"StrikeAboveLimit",
				)
			})
		})

		context("with an approving validator followed by a rejecting one", () => {
			let reject: Loaded<typeof approveThenReject>["reject"]

			beforeEach(async () => {
				;({ c, v, reject } = await approveThenReject())
			})

			it("reverts with the rejecting validator's error", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(reject, "Rejected")
			})
		})

		context("with PairLimits and PremiumFloor from the same validator", () => {
			beforeEach(async () => {
				;({ c, v } = await limitsThenPremiumFloor())
			})

			it("lists the validator once per rule", async () => {
				expect((await c.hub.rulesOf(v.vaultId)).map(r => r.validator)).to.deep.equal([c.bidRulesAddress, c.bidRulesAddress, c.bidRulesAddress])
			})

			it("rejects a strike below the limit even with a premium on the floor", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { premiumPerUnit: usdc(150) })).to.be.revertedWithCustomError(c.hub, "StrikeBelowLimit")
			})

			it("rejects a premium below the floor", async () => {
				// 5% of the 3000 spot is 150 USDC.
				await expect(activate(c, v.vaultId, v.vaultAddress, { strike: usdc(3100), premiumPerUnit: usdc(149) })).to.be.revertedWithCustomError(
					c.hub,
					"PremiumTooLow",
				)
			})

			it("accepts a bid that satisfies both rules", async () => {
				await activate(c, v.vaultId, v.vaultAddress, { strike: usdc(3100), premiumPerUnit: usdc(150) })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})
		})

		context("with twin vaults that share their terms", () => {
			let twin: OpenedVault

			beforeEach(async () => {
				;({ c, v, twin } = await twinCalls())
			})

			it("gives both the same terms hash", async () => {
				expect(await c.hub.termsHashOf(v.vaultId)).to.equal(await c.hub.termsHashOf(twin.vaultId))
			})

			it("rejects a bid for one twin on the other by vault id", async () => {
				const bid = await makeBid(c, v.vaultId)
				await fund(c, c.usdc, c.marketMaker, twin.vaultAddress, PREMIUM_TOTAL)
				await expect(submit(c, twin.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "BidVaultMismatch")
			})
		})

		context("with an approve-all validator on a European-only call", () => {
			beforeEach(async () => {
				;({ c, v } = await approvedEuropeanOnlyCall())
			})

			it("rejects a disallowed style", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.American })).to.be.revertedWithCustomError(
					c.hub,
					"StyleNotAllowed",
				)
			})

			it("rejects a disallowed settlement", async () => {
				await expect(
					activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.European, settlement: SettlementType.Cash }),
				).to.be.revertedWithCustomError(c.hub, "SettlementNotAllowed")
			})

			it("rejects an unknown pair", async () => {
				await expect(
					activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.European, quoteToken: c.daiAddress }),
				).to.be.revertedWithCustomError(c.hub, "PairUnknown")
			})

			it("rejects a mismatched collateral commitment", async () => {
				const bid = { ...(await makeBid(c, v.vaultId, { style: ExerciseStyle.European })), collateralAmount: 1n }
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
				await expect(submit(c, v.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "CommitmentMismatch")
			})
		})

		context("with a validator that writes state", () => {
			let writer: Loaded<typeof stateWritingRule>["writer"]

			beforeEach(async () => {
				;({ c, v, writer } = await stateWritingRule())
			})

			it("reverts without recording the call", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revert(ethers)
				expect(await writer.calls()).to.equal(0n)
			})

			it("leaves the auction cancellable and the deposit withdrawable", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revert(ethers)
				await c.hub.connect(c.bidMaster).cancelAuction(v.vaultId)
				await expect(c.hub.connect(c.alice).withdraw(v.vaultId, CALL_DEPOSIT)).to.changeTokenBalance(ethers, c.weth, c.alice, CALL_DEPOSIT)
			})
		})

		context("with a validator that requires a 600-second-old auction", () => {
			let validator: Loaded<typeof auctionAgeRule>["validator"]

			beforeEach(async () => {
				;({ c, v, validator } = await auctionAgeRule())
			})

			it("rejects a bid before then", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(validator, "TooEarly")
			})

			it("accepts a bid afterwards, given the premium token and notional it expects", async () => {
				await networkHelpers.time.increase(600n)
				await activate(c, v.vaultId, v.vaultAddress)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})
		})

		context("with a validator that expects another premium token", () => {
			let validator: Loaded<typeof wrongPremiumTokenRule>["validator"]

			beforeEach(async () => {
				;({ c, v, validator } = await wrongPremiumTokenRule())
			})

			it("reverts with the validator's ContextMismatch", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(validator, "ContextMismatch")
			})
		})

		context("put with a validator that checks the context it is handed", () => {
			beforeEach(async () => {
				;({ c, v } = await putContextRule())
			})

			it("hands the validator the USDC share supply and the 10 WETH notional", async () => {
				await activate(c, v.vaultId, v.vaultAddress)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})
		})

		context("with a validator that answers with another function's selector", () => {
			beforeEach(async () => {
				;({ c, v } = await wrongBidSelectorRule())
			})

			it("rejects the bid with InvalidValidator", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "InvalidValidator")
			})
		})

		context("with a 1% PremiumFloor on a call paying premium in WETH", () => {
			beforeEach(async () => {
				;({ c, v } = await wethPremiumFloor())
				await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(1))
			})

			it("rejects a premium just under 1% of the underlying, without a feed", async () => {
				const bid = await makeBid(c, v.vaultId, { premiumPerUnit: weth(1) / 100n - 1n })
				await expect(submit(c, v.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "PremiumTooLow")
			})

			it("accepts a 1% premium and records WETH as the premium token", async () => {
				await submit(c, v.vaultId, await makeBid(c, v.vaultId, { premiumPerUnit: weth(1) / 100n }))
				expect((await c.hub.stateOf(v.vaultId)).premiumToken).to.equal(c.wethAddress)
			})
		})
	})

	context("with an ERC-1271 contract market maker", () => {
		let wallet: Loaded<typeof contractBuyer>["wallet"]

		context("during the auction", () => {
			let bid: Bid

			beforeEach(async () => {
				;({ c, v, bid } = await contractBuyer())
			})

			it("accepts a bid the wallet validates for its owner", async () => {
				await submit(c, v.vaultId, bid)
				expect((await c.hub.stateOf(v.vaultId)).marketMaker).to.equal(bid.marketMaker)
			})
		})

		context("once live", () => {
			beforeEach(async () => {
				;({ c, v, wallet } = await liveContractBuyer())
			})

			it("lets the contract buyer clear its executor through the wallet", async () => {
				await wallet
					.connect(c.marketMaker)
					.execute(c.hubAddress, c.hub.interface.encodeFunctionData("setExecutorAndRecipient", [v.vaultId, ZeroAddress, c.carol.address]))
				expect((await c.hub.stateOf(v.vaultId)).executor).to.equal(ZeroAddress)
			})
		})
	})

	describe("expiry rules", () => {
		context("call with a 10 to 30 day tenor", () => {
			beforeEach(async () => {
				;({ c, v } = await tenorCall())
			})

			it("takes the expiry from the winning bid", async () => {
				const { bid } = await activate(c, v.vaultId, v.vaultAddress, { tenor: 20n * DAY })
				expect((await c.hub.stateOf(v.vaultId)).expiry).to.equal(bid.expiry)
			})

			it("leaves the expiry unset until activation", async () => {
				expect((await c.hub.stateOf(v.vaultId)).expiry).to.equal(0n)
			})

			it("rejects a tenor shorter than 10 days", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { tenor: 9n * DAY })).to.be.revertedWithCustomError(c.hub, "TenorOutOfRange")
			})

			it("rejects a tenor longer than 30 days", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { tenor: 31n * DAY })).to.be.revertedWithCustomError(c.hub, "TenorOutOfRange")
			})

			context("with a 30-day bid signed now", () => {
				let bid: Bid

				beforeEach(async () => {
					bid = await makeBid(c, v.vaultId, { tenor: 30n * DAY, validFor: DAY })
					await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
				})

				it("measures the tenor from activation, so the same expiry fits a day later", async () => {
					await networkHelpers.time.increase(DAY - 10n)
					await submit(c, v.vaultId, bid)
					expect((await c.hub.stateOf(v.vaultId)).expiry).to.equal(bid.expiry)
				})
			})

			context("with a 10-day bid valid for a day", () => {
				let bid: Bid

				beforeEach(async () => {
					bid = await makeBid(c, v.vaultId, { tenor: 10n * DAY, validFor: DAY })
					await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
				})

				it("rejects it once its remaining tenor falls under 10 days", async () => {
					await networkHelpers.time.increase(60n)
					await expect(submit(c, v.vaultId, bid)).to.be.revertedWithCustomError(c.hub, "TenorOutOfRange")
				})
			})
		})

		context("call with both a tenor range and an absolute window", () => {
			let window: Loaded<typeof windowedTenorCall>["window"]

			beforeEach(async () => {
				;({ c, v, window } = await windowedTenorCall())
			})

			it("accepts an expiry both rules allow", async () => {
				await activate(c, v.vaultId, v.vaultAddress, { expiry: window.notBefore + DAY })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("rejects an expiry inside the tenor range but before the window", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { tenor: 15n * DAY })).to.be.revertedWithCustomError(c.hub, "ExpiryOutsideWindow")
			})

			it("rejects an expiry inside the window but past the tenor range", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { expiry: window.notAfter })).to.be.revertedWithCustomError(c.hub, "TenorOutOfRange")
			})
		})
	})

	describe("rule data", () => {
		context("with two rules that each accept only their own slots", () => {
			const marketMakerData = ["0x", "0x", "0xaa02", "0xaa03"]
			const bidMasterData = ["0x", "0x", "0xbb02", "0xbb03"]
			let echo: Loaded<typeof echoCall>["echo"]

			beforeEach(async () => {
				;({ c, v, echo } = await echoCall())
			})

			it("hands each rule the slot at its own index", async () => {
				await activate(c, v.vaultId, v.vaultAddress, { marketMakerData, bidMasterData })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("emits both arrays for anyone auditing the bid master's input", async () => {
				const bid = await makeBid(c, v.vaultId, { marketMakerData })
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
				await expect(submit(c, v.vaultId, bid, c.marketMaker, { marketMakerData, bidMasterData }))
					.to.emit(c.hub, "RuleDataProvided")
					.withArgs(v.vaultId, marketMakerData, bidMasterData)
			})

			it("rejects bid-master slots in the wrong order", async () => {
				const swapped = ["0x", "0x", "0xbb03", "0xbb02"]
				await expect(activate(c, v.vaultId, v.vaultAddress, { marketMakerData, bidMasterData: swapped }))
					.to.be.revertedWithCustomError(echo, "UnexpectedSlot")
					.withArgs("0xaa02", "0xbb03")
			})

			it("rejects a bid-master array with one slot missing", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { marketMakerData, bidMasterData: bidMasterData.slice(0, 3) }))
					.to.be.revertedWithCustomError(c.hub, "RuleDataLengthMismatch")
					.withArgs(4, 3)
			})

			it("rejects a market-maker array with an extra slot", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { marketMakerData: [...marketMakerData, "0x"], bidMasterData }))
					.to.be.revertedWithCustomError(c.hub, "RuleDataLengthMismatch")
					.withArgs(4, 5)
			})

			context("with a bid signed over the market maker's slots", () => {
				let bid: Bid

				beforeEach(async () => {
					bid = await makeBid(c, v.vaultId, { marketMakerData })
					await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
				})

				it("rejects the bid master substituting other market-maker slots", async () => {
					const substituted = ["0x", "0x", "0xaa02", "0xcc03"]
					await expect(submit(c, v.vaultId, bid, c.marketMaker, { marketMakerData: substituted, bidMasterData })).to.be.revertedWithCustomError(
						c.hub,
						"CommitmentMismatch",
					)
				})

				it("rejects the bid master dropping the market maker's slots", async () => {
					await expect(submit(c, v.vaultId, bid, c.marketMaker, { bidMasterData })).to.be.revertedWithCustomError(c.hub, "CommitmentMismatch")
				})
			})
		})

		context("with a rule that accepts only empty slots", () => {
			beforeEach(async () => {
				;({ c, v } = await emptyEchoCall())
			})

			it("treats empty arrays as an empty slot for every rule", async () => {
				await activate(c, v.vaultId, v.vaultAddress)
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("emits no RuleDataProvided when neither party supplies data", async () => {
				const bid = await makeBid(c, v.vaultId)
				await fund(c, c.usdc, c.marketMaker, v.vaultAddress, PREMIUM_TOTAL)
				await expect(submit(c, v.vaultId, bid)).to.not.emit(c.hub, "RuleDataProvided")
			})
		})

		context("call requiring a 60% implied volatility", () => {
			const attest = (volBps: number) => ["0x", "0x", encodeImpliedVolAttestation(volBps)]

			beforeEach(async () => {
				;({ c, v } = await volCall())
			})

			it("accepts a bid the bid master attests at 65%", async () => {
				await activate(c, v.vaultId, v.vaultAddress, { bidMasterData: attest(6500) })
				expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
			})

			it("rejects a bid the bid master attests at 50%", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { bidMasterData: attest(5000) })).to.be.revertedWithCustomError(c.hub, "VolTooLow")
			})

			it("rejects a bid without an attestation", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(c.hub, "MissingAttestation")
			})

			it("does not take the market maker's word for it", async () => {
				await expect(activate(c, v.vaultId, v.vaultAddress, { marketMakerData: attest(9000) })).to.be.revertedWithCustomError(
					c.hub,
					"MissingAttestation",
				)
			})
		})
	})
})

describe("cancelBid", () => {
	let c: IvyContext

	beforeEach(async () => {
		c = await deployed()
	})

	it("emits BidCancelled and marks the nonce used", async () => {
		await expect(c.hub.connect(c.marketMaker).cancelBid(77n)).to.emit(c.hub, "BidCancelled").withArgs(c.marketMaker.address, 77n)
		expect(await c.hub.usedBidNonces(c.marketMaker.address, 77n)).to.equal(true)
	})

	it("rejects a nonce that is already used", async () => {
		await c.hub.connect(c.marketMaker).cancelBid(77n)
		await expect(c.hub.connect(c.marketMaker).cancelBid(77n)).to.be.revertedWithCustomError(c.hub, "NonceUsed")
	})
})
