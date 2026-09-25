import { expect } from "chai"
import { TypedDataEncoder, id as keccakOfString } from "ethers"
import { network } from "hardhat"

import { BID_TYPES, type Bid } from "../helpers/bids.js"
import { PREMIUM_PER_UNIT, STRIKE } from "../helpers/scenarios.js"
import { ExerciseStyle, SettlementType } from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

const deployHarness = () => ethers.deployContract("BidHashHarness")

const sample: Bid = {
	vaultId: 7n,
	marketMaker: "0x1111111111111111111111111111111111111111",
	quoteToken: "0x2222222222222222222222222222222222222222",
	strike: STRIKE,
	premiumPerUnit: PREMIUM_PER_UNIT,
	style: ExerciseStyle.American,
	settlement: SettlementType.Physical,
	expiry: 1_800_000_000n,
	validUntil: 1_700_000_000n,
	nonce: 42n,
	auctionId: 1n,
	collateralAmount: 100n,
	termsHash: "0x" + "11".repeat(32),
	executor: "0x3333333333333333333333333333333333333333",
	recipient: "0x1111111111111111111111111111111111111111",
}

describe("BidHash", () => {
	let harness: Awaited<ReturnType<typeof deployHarness>>

	before(async () => {
		harness = await deployHarness()
	})

	it("uses the EIP-712 typehash of the Bid struct", async () => {
		const encodedType = TypedDataEncoder.from(BID_TYPES).encodeType("Bid")
		expect(await harness.typehash()).to.equal(keccakOfString(encodedType))
	})

	it("matches the struct hash from ethers' TypedDataEncoder", async () => {
		expect(await harness.hash(sample)).to.equal(TypedDataEncoder.hashStruct("Bid", BID_TYPES, sample))
	})

	const changes = [
		{ name: "nonce", bid: { ...sample, nonce: 43n } },
		{ name: "style", bid: { ...sample, style: ExerciseStyle.European } },
	]
	for (const change of changes) {
		it(`changes when the ${change.name} changes`, async () => {
			expect(await harness.hash(change.bid)).to.not.equal(await harness.hash(sample))
		})
	}
})
