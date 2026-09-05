import { expect } from "chai";
import { network } from "hardhat";
import { TypedDataEncoder, id as keccakOfString } from "ethers";
import { BID_TYPES, type Bid } from "./helpers/bids.js";

const { ethers } = await network.create();

const sample: Bid = {
  vaultId: 7n,
  marketMaker: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222",
  strike: 3000n * 10n ** 6n,
  premium: 100n * 10n ** 6n,
  style: 1,
  settlement: 0,
  expiry: 1_800_000_000n,
  validUntil: 1_700_000_000n,
  nonce: 42n,
  auctionId: 1n, collateralAmount: 100n, pairHash: "0x" + "11".repeat(32),
  executor: "0x3333333333333333333333333333333333333333", recipient: "0x1111111111111111111111111111111111111111",
};

describe("BidHash", function () {
  it("uses the EIP-712 typehash of the Bid struct", async function () {
    const h = await ethers.deployContract("BidHashHarness");
    const encodedType = TypedDataEncoder.from(BID_TYPES).encodeType("Bid");
    expect(await h.typehash()).to.equal(keccakOfString(encodedType));
  });

  it("struct hash matches ethers' TypedDataEncoder", async function () {
    const h = await ethers.deployContract("BidHashHarness");
    expect(await h.hash(sample)).to.equal(TypedDataEncoder.hashStruct("Bid", BID_TYPES, sample));
  });

  it("changing any field changes the hash", async function () {
    const h = await ethers.deployContract("BidHashHarness");
    const base = await h.hash(sample);
    expect(await h.hash({ ...sample, nonce: 43n })).to.not.equal(base);
    expect(await h.hash({ ...sample, style: 0 })).to.not.equal(base);
  });
});
