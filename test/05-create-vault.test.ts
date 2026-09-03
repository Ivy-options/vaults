import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import {
  OptionKind, Phase, SettlementPolicy, THIRTY_DAYS, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, putPairs, putTerms,
  type IvyContext, type PairInput, type VaultTermsInput,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("createVault", function () {
  const fixture = () => deployIvy(connection);

  it("creates a covered call vault with a derived kind and a working clone", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, wethAddress, usdcAddress, hubAddress } = ctx;
    await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx)))
      .to.emit(hub, "VaultCreated")
      .withArgs(1n, anyValue, alice.address, OptionKind.CoveredCall, wethAddress, wethAddress);
    expect(await hub.vaultCount()).to.equal(1n);
    expect(await hub.kindOf(1n)).to.equal(OptionKind.CoveredCall);
    const state = await hub.stateOf(1n);
    expect(state.owner).to.equal(alice.address);
    expect(state.phase).to.equal(Phase.Open);
    expect(state.isCall).to.equal(true);
    expect(state.underlyingUnit).to.equal(WETH_UNIT);
    const vault = await ctx.ethers.getContractAt("IvyVault", state.vault);
    expect(await vault.hub()).to.equal(hubAddress);
    expect(await vault.vaultId()).to.equal(1n);
    expect(await vault.collateral()).to.equal(wethAddress);
    expect(await hub.quoteTokensOf(1n)).to.deep.equal([usdcAddress]);
    const pair = await hub.pairTermsOf(1n, usdcAddress);
    expect(pair.premiumToken).to.equal(usdcAddress);
    expect(pair.enabled).to.equal(true);
    expect((await hub.termsOf(1n)).maxTenor).to.equal(THIRTY_DAYS);
  });

  it("creates a cash-secured put vault", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, wethAddress, usdcAddress } = ctx;
    await expect(hub.connect(alice).createVault(putTerms(ctx), putPairs(ctx)))
      .to.emit(hub, "VaultCreated")
      .withArgs(1n, anyValue, alice.address, OptionKind.CashSecuredPut, wethAddress, usdcAddress);
    const state = await hub.stateOf(1n);
    expect(state.isCall).to.equal(false);
    expect(state.underlyingUnit).to.equal(WETH_UNIT);
    expect(await hub.kindOf(1n)).to.equal(OptionKind.CashSecuredPut);
    const vault = await ctx.ethers.getContractAt("IvyVault", state.vault);
    expect(await vault.collateral()).to.equal(usdcAddress);
  });

  it("emits AuctionScheduled when a start time is given", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    await expect(ctx.hub.connect(ctx.alice).createVault(callTerms(ctx, { auctionStartsAt: 1_900_000_000n }), callPairs(ctx)))
      .to.emit(ctx.hub, "AuctionScheduled")
      .withArgs(1n, 1_900_000_000n);
  });

  it("gives every vault its own id and clone", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const a = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    const b = await createVaultAs(ctx, ctx.bob, putTerms(ctx), putPairs(ctx));
    expect(a.vaultId).to.equal(1n);
    expect(b.vaultId).to.equal(2n);
    expect(a.vaultAddress).to.not.equal(b.vaultAddress);
    expect((await ctx.hub.stateOf(2n)).owner).to.equal(ctx.bob.address);
  });

  it("accepts a call vault with several quote tokens", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const pairs: PairInput[] = [
      ...callPairs(ctx),
      { quoteToken: ctx.daiAddress, terms: { premiumToken: ctx.daiAddress, strikeLimit: 0n, minPremium: 0n, enabled: true } },
    ];
    await createVaultAs(ctx, ctx.alice, callTerms(ctx), pairs);
    expect(await ctx.hub.quoteTokensOf(1n)).to.deep.equal([ctx.usdcAddress, ctx.daiAddress]);
  });

  describe("validation", function () {
    type Case = { name: string; error: string; build: (c: IvyContext) => [VaultTermsInput, PairInput[]] };
    const cases: Case[] = [
      { name: "zero underlying", error: "ZeroAddress", build: (c) => [callTerms(c, { underlying: ZeroAddress }), callPairs(c)] },
      { name: "zero collateral", error: "ZeroAddress", build: (c) => [callTerms(c, { collateral: ZeroAddress }), callPairs(c)] },
      { name: "zero maxTenor", error: "InvalidTenor", build: (c) => [callTerms(c, { maxTenor: 0n }), callPairs(c)] },
      { name: "cash allowed without a feed", error: "CashSettlementNeedsFeed", build: (c) => [callTerms(c, { allowedSettlement: SettlementPolicy.Cash }), callPairs(c)] },
      { name: "either settlement without a feed", error: "CashSettlementNeedsFeed", build: (c) => [callTerms(c, { allowedSettlement: SettlementPolicy.Either }), callPairs(c)] },
      { name: "feed without maxPriceAge", error: "FeedNeedsMaxPriceAge", build: (c) => [callTerms(c, { priceFeed: c.feedAddress, maxPriceAge: 0 }), callPairs(c)] },
      { name: "call deviation above 100%", error: "DeviationTooLarge", build: (c) => [callTerms(c, { priceFeed: c.feedAddress, maxPriceAge: 60, maxSpotDeviationBps: 10_001 }), callPairs(c)] },
      { name: "no pairs", error: "NoPairs", build: (c) => [callTerms(c), []] },
      { name: "put with two pairs", error: "PutRequiresSinglePair", build: (c) => [putTerms(c), [...putPairs(c), { quoteToken: c.daiAddress, terms: putPairs(c)[0].terms }]] },
      { name: "put pair that is not the collateral", error: "PutPairMustBeCollateral", build: (c) => [putTerms(c), [{ quoteToken: c.daiAddress, terms: putPairs(c)[0].terms }]] },
      { name: "call quote equal to the underlying", error: "QuoteIsUnderlying", build: (c) => [callTerms(c), [{ quoteToken: c.wethAddress, terms: callPairs(c)[0].terms }]] },
      { name: "disabled pair at creation", error: "PairMustBeEnabled", build: (c) => [callTerms(c), callPairs(c, { enabled: false })] },
      { name: "put strike limit of zero", error: "InvalidStrikeLimit", build: (c) => [putTerms(c), putPairs(c, { strikeLimit: 0n })] },
      { name: "zero premium token", error: "ZeroAddress", build: (c) => [callTerms(c), callPairs(c, { premiumToken: ZeroAddress })] },
      { name: "duplicate quote token", error: "DuplicatePair", build: (c) => [callTerms(c), [...callPairs(c), ...callPairs(c)]] },
    ];

    for (const tc of cases) {
      it(`rejects ${tc.name}`, async function () {
        const ctx = await networkHelpers.loadFixture(fixture);
        const [terms, pairs] = tc.build(ctx);
        await expect(ctx.hub.connect(ctx.alice).createVault(terms, pairs)).to.be.revertedWithCustomError(ctx.hub, tc.error);
      });
    }

    it("allows a put deviation above 100%", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      await createVaultAs(ctx, ctx.alice, putTerms(ctx, { priceFeed: ctx.feedAddress, maxPriceAge: 60, maxSpotDeviationBps: 20_000 }), putPairs(ctx));
      expect(await ctx.hub.vaultCount()).to.equal(1n);
    });
  });
});
