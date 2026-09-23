import { expect } from "chai";
import { network } from "hardhat";
import { AbiCoder, ZeroAddress, id } from "ethers";
import {
  ExerciseStyle, RuleKind, SettlementType, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, fund, premiumFloorRule, putPairs, putTerms,
} from "./helpers/setup.js";
import { signBid } from "./helpers/bids.js";
import { CALL_DEPOSIT, STRIKE, activate, makeBid, openVault, setSpot } from "./helpers/scenarios.js";

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

describe("bid rules at activation", function () {
  const { networkHelpers } = connection;
  const fixture = () => deployIvy(connection);

  it("PairLimits and SpotBand reproduce the previous acceptance conditions", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const call = await openVault(ctx, { pair: { strikeLimit: 3100n * USDC_UNIT, minPremium: 50n * USDC_UNIT }, withFeed: true });
    await expect(activate(ctx, call.vaultId, call.vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "StrikeBelowLimit");
    await expect(activate(ctx, call.vaultId, call.vaultAddress, { strike: 3100n * USDC_UNIT, premium: 49n * USDC_UNIT })).to.be.revertedWithCustomError(ctx.hub, "PremiumTooLow");
    await setSpot(ctx, 4000n * USDC_UNIT);
    await expect(activate(ctx, call.vaultId, call.vaultAddress, { strike: 3100n * USDC_UNIT })).to.be.revertedWithCustomError(ctx.hub, "StrikeOutsideSpotBand");
    await setSpot(ctx, STRIKE);
    await activate(ctx, call.vaultId, call.vaultAddress, { strike: 3100n * USDC_UNIT });
  });

  it("an empty rule list accepts any well-formed bid and still guards a zero strike", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress } = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx), []);
    await fund(ctx, ctx.weth, ctx.alice, vaultAddress, CALL_DEPOSIT);
    await ctx.hub.connect(ctx.alice).deposit(vaultId, CALL_DEPOSIT);
    await ctx.hub.connect(ctx.alice).openAuction(vaultId);
    await activate(ctx, vaultId, vaultAddress, { strike: 1n, premium: 0n });
    const put = await createVaultAs(ctx, ctx.alice, putTerms(ctx), putPairs(ctx), []);
    await fund(ctx, ctx.usdc, ctx.alice, put.vaultAddress, 30_000n * USDC_UNIT);
    await ctx.hub.connect(ctx.alice).deposit(put.vaultId, 30_000n * USDC_UNIT);
    await ctx.hub.connect(ctx.alice).openAuction(put.vaultId);
    await expect(activate(ctx, put.vaultId, put.vaultAddress, { strike: 0n })).to.be.revertedWithCustomError(ctx.hub, "EmptyNotional");
  });

  it("every rule must approve, in order, and the same validator may appear twice", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const reject = await ctx.ethers.deployContract("RejectAllValidator");
    const approve = await ctx.ethers.deployContract("ApproveAllValidator");
    const rule = (v: string) => ({ validator: v, kind: RuleKind.PairLimits, data: "0x" });
    const a = await openVault(ctx, { rules: [rule(await approve.getAddress()), rule(await reject.getAddress())] });
    await expect(activate(ctx, a.vaultId, a.vaultAddress)).to.be.revertedWithCustomError(reject, "Rejected");
    const b = await openVault(ctx, { pair: { strikeLimit: 3100n * USDC_UNIT, minPremium: 0n }, rules: [premiumFloorRule(ctx, { maxPriceAge: 3600, minPremiumBps: 500 })] });
    await setSpot(ctx, STRIKE);
    expect((await ctx.hub.rulesOf(b.vaultId)).map((r: any) => r.validator)).to.deep.equal([ctx.bidRulesAddress, ctx.bidRulesAddress]);
    await expect(activate(ctx, b.vaultId, b.vaultAddress, { premium: 150n * USDC_UNIT })).to.be.revertedWithCustomError(ctx.hub, "StrikeBelowLimit");
    await expect(activate(ctx, b.vaultId, b.vaultAddress, { strike: 3100n * USDC_UNIT, premium: 149n * USDC_UNIT })).to.be.revertedWithCustomError(ctx.hub, "PremiumTooLow");
    await activate(ctx, b.vaultId, b.vaultAddress, { strike: 3100n * USDC_UNIT, premium: 150n * USDC_UNIT });
  });

  it("a bid signed for one vault is rejected on a twin by vault id, never by termsHash", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const expiry = BigInt(await networkHelpers.time.latest()) + 7n * 24n * 3600n;
    const a = await openVault(ctx, { terms: { expiry }, pair: { minPremium: 1n } });
    const b = await openVault(ctx, { terms: { expiry, auctionStartsAt: 1_900_000_000n }, pair: { minPremium: 1n } });
    expect(await ctx.hub.termsHashOf(a.vaultId)).to.equal(await ctx.hub.termsHashOf(b.vaultId));
    const bid = await makeBid(ctx, a.vaultId);
    await fund(ctx, ctx.usdc, ctx.marketMaker, b.vaultAddress, 1000n * USDC_UNIT);
    await expect(ctx.hub.connect(ctx.bidMaster).activate(b.vaultId, bid, await signBid(ctx.marketMaker, ctx.hubAddress, bid))).to.be.revertedWithCustomError(ctx.hub, "BidVaultMismatch");
  });

  it("an approving validator cannot bypass the mandatory checks", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const approve = await ctx.ethers.deployContract("ApproveAllValidator");
    const rules = [{ validator: await approve.getAddress(), kind: "0x00000000", data: "0x" }];
    const v = await openVault(ctx, { terms: { allowedExercise: 0 }, rules });
    await expect(activate(ctx, v.vaultId, v.vaultAddress, { style: ExerciseStyle.American })).to.be.revertedWithCustomError(ctx.hub, "StyleNotAllowed");
    await expect(activate(ctx, v.vaultId, v.vaultAddress, { style: ExerciseStyle.European, settlement: SettlementType.Cash })).to.be.revertedWithCustomError(ctx.hub, "SettlementNotAllowed");
    await expect(activate(ctx, v.vaultId, v.vaultAddress, { style: ExerciseStyle.European, quoteToken: ctx.daiAddress })).to.be.revertedWithCustomError(ctx.hub, "PairUnknown");
    const bid = { ...(await makeBid(ctx, v.vaultId, { style: ExerciseStyle.European })), collateralAmount: 1n };
    await fund(ctx, ctx.usdc, ctx.marketMaker, v.vaultAddress, 1000n * USDC_UNIT);
    await expect(ctx.hub.connect(ctx.bidMaster).activate(v.vaultId, bid, await signBid(ctx.marketMaker, ctx.hubAddress, bid))).to.be.revertedWithCustomError(ctx.hub, "CommitmentMismatch");
  });

  it("a validator that writes state fails activation, and the auction stays cancellable", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const writer = await ctx.ethers.deployContract("StateWritingValidator");
    const v = await openVault(ctx, { rules: [{ validator: await writer.getAddress(), kind: "0x00000000", data: "0x" }] });
    await expect(activate(ctx, v.vaultId, v.vaultAddress)).to.be.revert(ethers);
    expect(await writer.calls()).to.equal(0n);
    await ctx.hub.connect(ctx.bidMaster).cancelAuction(v.vaultId);
    await ctx.hub.connect(ctx.alice).withdraw(v.vaultId, CALL_DEPOSIT);
  });

  it("the context carries the resolved premium token, notional and auction timing", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const asserting = await ctx.ethers.deployContract("ContextAssertingValidator", [ctx.usdcAddress, CALL_DEPOSIT, 600]);
    const v = await openVault(ctx, { rules: [{ validator: await asserting.getAddress(), kind: "0x00000000", data: "0x" }] });
    await expect(activate(ctx, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(asserting, "TooEarly");
    await networkHelpers.time.increase(600n);
    await activate(ctx, v.vaultId, v.vaultAddress);
    const wrong = await ctx.ethers.deployContract("ContextAssertingValidator", [ctx.daiAddress, CALL_DEPOSIT, 0]);
    const w = await openVault(ctx, { rules: [{ validator: await wrong.getAddress(), kind: "0x00000000", data: "0x" }] });
    await expect(activate(ctx, w.vaultId, w.vaultAddress)).to.be.revertedWithCustomError(wrong, "ContextMismatch");
  });

  it("PremiumFloor prices the premium in the underlying without a feed", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const pairs = [{ quoteToken: ctx.usdcAddress, premiumToken: ctx.wethAddress }];
    const rules = [premiumFloorRule(ctx, { priceFeed: ZeroAddress, maxPriceAge: 0, minPremiumBps: 100 })];
    const { vaultId, vaultAddress } = await createVaultAs(ctx, ctx.alice, callTerms(ctx), pairs, rules);
    await fund(ctx, ctx.weth, ctx.alice, vaultAddress, CALL_DEPOSIT);
    await ctx.hub.connect(ctx.alice).deposit(vaultId, CALL_DEPOSIT);
    await ctx.hub.connect(ctx.alice).openAuction(vaultId);
    const tooLow = await makeBid(ctx, vaultId, { premium: WETH_UNIT / 100n - 1n });
    await fund(ctx, ctx.weth, ctx.marketMaker, vaultAddress, WETH_UNIT);
    await expect(ctx.hub.connect(ctx.bidMaster).activate(vaultId, tooLow, await signBid(ctx.marketMaker, ctx.hubAddress, tooLow))).to.be.revertedWithCustomError(ctx.hub, "PremiumTooLow");
    const enough = await makeBid(ctx, vaultId, { premium: WETH_UNIT / 100n });
    await ctx.hub.connect(ctx.bidMaster).activate(vaultId, enough, await signBid(ctx.marketMaker, ctx.hubAddress, enough));
    expect((await ctx.hub.stateOf(vaultId)).premiumToken).to.equal(ctx.wethAddress);
  });
});
