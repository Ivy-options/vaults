import { expect } from "chai";
import { network } from "hardhat";
import { AbiCoder, ZeroAddress, id } from "ethers";

const connection = await network.create();
const { ethers } = connection;
const coder = AbiCoder.defaultAbiCoder();
const kind = (name: string) => id(name).slice(0, 10);
const A = "0x1000000000000000000000000000000000000001";
const B = "0x2000000000000000000000000000000000000002";

const terms = (underlying: string, collateral: string) => ({
  underlying, collateral, allowPartialExercise: true, publicDeposits: true, allowedExercise: 2, allowedSettlement: 0,
  expiry: 4_000_000_000n, auctionStartsAt: 0n, minCollateral: 0n, maxSettlementPriceAge: 0,
});
const pairLimits = (entries: Array<[string, bigint, bigint]>) =>
  coder.encode(["tuple(address quoteToken,uint256 strikeLimit,uint256 minPremium)[]"], [entries]);
const spotBand = (priceFeed: string, maxPriceAge: number, bps: number) =>
  coder.encode(["tuple(address priceFeed,uint32 maxPriceAge,uint16 maxInTheMoneyBps)"], [[priceFeed, maxPriceAge, bps]]);
const premiumFloor = (priceFeed: string, maxPriceAge: number, bps: number) =>
  coder.encode(["tuple(address priceFeed,uint32 maxPriceAge,uint16 minPremiumBps)"], [[priceFeed, maxPriceAge, bps]]);

describe("IvyBidRules config", function () {
  async function fixture() {
    const rules = await ethers.deployContract("IvyBidRules");
    const feed = await ethers.deployContract("MockPriceFeed");
    return { rules, feedAddress: await feed.getAddress(), ok: rules.interface.getFunction("validateConfig")!.selector };
  }

  it("exposes named kinds", async function () {
    const { rules } = await fixture();
    expect(await rules.PAIR_LIMITS()).to.equal(kind("PairLimits"));
    expect(await rules.SPOT_BAND()).to.equal(kind("SpotBand"));
    expect(await rules.PREMIUM_FLOOR()).to.equal(kind("PremiumFloor"));
  });

  it("rejects an unknown kind", async function () {
    const { rules } = await fixture();
    await expect(rules.validateConfig(kind("Nope"), terms(A, A), [{ quoteToken: B, premiumToken: B }], "0x"))
      .to.be.revertedWithCustomError(rules, "UnknownRuleKind").withArgs(kind("Nope"));
  });

  it("PairLimits needs exactly one entry per pair", async function () {
    const { rules, ok } = await fixture();
    const pairs = [{ quoteToken: B, premiumToken: B }];
    expect(await rules.validateConfig(kind("PairLimits"), terms(A, A), pairs, pairLimits([[B, 0n, 0n]]))).to.equal(ok);
    await expect(rules.validateConfig(kind("PairLimits"), terms(A, A), pairs, pairLimits([])))
      .to.be.revertedWithCustomError(rules, "RuleMissingPair").withArgs(B);
    await expect(rules.validateConfig(kind("PairLimits"), terms(A, A), pairs, pairLimits([[B, 0n, 0n], [A, 0n, 0n]])))
      .to.be.revertedWithCustomError(rules, "PairUnknown").withArgs(A);
    await expect(rules.validateConfig(kind("PairLimits"), terms(A, A), pairs, pairLimits([[B, 0n, 0n], [B, 1n, 0n]])))
      .to.be.revertedWithCustomError(rules, "DuplicatePair").withArgs(B);
    await expect(rules.validateConfig(kind("PairLimits"), terms(A, B), pairs, pairLimits([[B, 0n, 0n]])))
      .to.be.revertedWithCustomError(rules, "InvalidStrikeLimit");
  });

  it("SpotBand needs a live feed, a positive age and a call band within 100%", async function () {
    const { rules, feedAddress, ok } = await fixture();
    const pairs = [{ quoteToken: B, premiumToken: B }];
    expect(await rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(feedAddress, 60, 1000))).to.equal(ok);
    await expect(rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(A, 60, 1000)))
      .to.be.revertedWithCustomError(rules, "BindingMismatch");
    await expect(rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(feedAddress, 0, 1000)))
      .to.be.revertedWithCustomError(rules, "FeedNeedsMaxPriceAge");
    await expect(rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(feedAddress, 60, 10_001)))
      .to.be.revertedWithCustomError(rules, "DeviationTooLarge");
    expect(await rules.validateConfig(kind("SpotBand"), terms(A, B), pairs, spotBand(feedAddress, 60, 20_000))).to.equal(ok);
  });

  it("PremiumFloor needs a feed only when some pair pays premium in another token", async function () {
    const { rules, feedAddress, ok } = await fixture();
    const inUnderlying = [{ quoteToken: B, premiumToken: A }];
    const inQuote = [{ quoteToken: B, premiumToken: B }];
    expect(await rules.validateConfig(kind("PremiumFloor"), terms(A, A), inUnderlying, premiumFloor(ZeroAddress, 0, 500))).to.equal(ok);
    await expect(rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(ZeroAddress, 0, 500)))
      .to.be.revertedWithCustomError(rules, "BindingMismatch");
    expect(await rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(feedAddress, 60, 500))).to.equal(ok);
    await expect(rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(feedAddress, 60, 0)))
      .to.be.revertedWithCustomError(rules, "InvalidPremiumFloor");
    await expect(rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(feedAddress, 60, 10_001)))
      .to.be.revertedWithCustomError(rules, "InvalidPremiumFloor");
  });
});
