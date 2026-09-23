import { expect } from "chai";
import { network } from "hardhat";
import { AbiCoder, Interface, ZeroAddress, keccak256 } from "ethers";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import {
  OptionKind, Phase, RuleKind, SettlementPolicy, WETH_UNIT,
  callLimits, callPairs, callTerms, createVaultAs, deployIvy, pairLimitsRule, putPairs, putTerms, spotBandRule,
  type IvyContext, type PairConfigInput, type VaultTermsInput,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("createVault", function () {
  const fixture = () => deployIvy(connection);

  it("creates a covered call vault with a derived kind and a working clone", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, wethAddress, usdcAddress, hubAddress } = ctx;
    await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx), []))
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
    expect(await hub.pairOf(1n, usdcAddress)).to.equal(usdcAddress);
    expect(await hub.rulesOf(1n)).to.deep.equal([]);
    expect((await hub.termsOf(1n)).expiry).to.equal(ctx.defaultExpiry);
  });

  it("creates a cash-secured put vault", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, wethAddress, usdcAddress } = ctx;
    await expect(hub.connect(alice).createVault(putTerms(ctx), putPairs(ctx), []))
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
    await expect(ctx.hub.connect(ctx.alice).createVault(callTerms(ctx, { auctionStartsAt: 1_900_000_000n }), callPairs(ctx), []))
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
    const pairs: PairConfigInput[] = [
      ...callPairs(ctx),
      { quoteToken: ctx.daiAddress, premiumToken: ctx.daiAddress },
    ];
    await createVaultAs(ctx, ctx.alice, callTerms(ctx), pairs);
    expect(await ctx.hub.quoteTokensOf(1n)).to.deep.equal([ctx.usdcAddress, ctx.daiAddress]);
  });

  describe("validation", function () {
    type Case = { name: string; error: string; build: (c: IvyContext) => [VaultTermsInput, PairConfigInput[]] };
    const cases: Case[] = [
      { name: "zero underlying", error: "ZeroAddress", build: (c) => [callTerms(c, { underlying: ZeroAddress }), callPairs(c)] },
      { name: "zero collateral", error: "ZeroAddress", build: (c) => [callTerms(c, { collateral: ZeroAddress }), callPairs(c)] },
      { name: "elapsed expiry", error: "ExpiryInPast", build: (c) => [callTerms(c, { expiry: 0n }), callPairs(c)] },
      { name: "cash allowed without an exercise price age limit", error: "CashSettlementNeedsMaxPriceAge", build: (c) => [callTerms(c, { allowedSettlement: SettlementPolicy.Cash }), callPairs(c)] },
      { name: "either settlement without an exercise price age limit", error: "CashSettlementNeedsMaxPriceAge", build: (c) => [callTerms(c, { allowedSettlement: SettlementPolicy.Either }), callPairs(c)] },
      { name: "no pairs", error: "NoPairs", build: (c) => [callTerms(c), []] },
      { name: "put with two pairs", error: "PutRequiresSinglePair", build: (c) => [putTerms(c), [...putPairs(c), { quoteToken: c.daiAddress, premiumToken: c.usdcAddress }]] },
      { name: "put pair that is not the collateral", error: "PutPairMustBeCollateral", build: (c) => [putTerms(c), [{ quoteToken: c.daiAddress, premiumToken: c.daiAddress }]] },
      { name: "call quote equal to the underlying", error: "QuoteIsUnderlying", build: (c) => [callTerms(c), [{ quoteToken: c.wethAddress, premiumToken: c.usdcAddress }]] },
      { name: "zero premium token", error: "ZeroAddress", build: (c) => [callTerms(c), [{ quoteToken: c.usdcAddress, premiumToken: ZeroAddress }]] },
      { name: "duplicate quote token", error: "DuplicatePair", build: (c) => [callTerms(c), [...callPairs(c), ...callPairs(c)]] },
    ];

    for (const tc of cases) {
      it(`rejects ${tc.name}`, async function () {
        const ctx = await networkHelpers.loadFixture(fixture);
        const [terms, pairs] = tc.build(ctx);
        await expect(ctx.hub.connect(ctx.alice).createVault(terms, pairs, [])).to.be.revertedWithCustomError(ctx.hub, tc.error);
      });
    }

  });

  describe("rules", function () {
    it("rejects a validator without code, a wrong selector, a config revert and an unknown kind", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, alice } = ctx;
      const rule = (validator: string, kind = RuleKind.PairLimits, data = "0x") => ({ validator, kind, data });
      await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx), [rule(alice.address)])).to.be.revertedWithCustomError(hub, "InvalidValidator");
      await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx), [rule(ZeroAddress)])).to.be.revertedWithCustomError(hub, "InvalidValidator");
      const wrong = await ctx.ethers.deployContract("WrongSelectorValidator");
      await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx), [rule(await wrong.getAddress())])).to.be.revertedWithCustomError(hub, "InvalidValidator");
      const bad = await ctx.ethers.deployContract("ConfigRevertValidator");
      await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx), [rule(await bad.getAddress())])).to.be.revertedWithCustomError(bad, "BadConfig");
      await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx), [rule(ctx.bidRulesAddress, "0xdeadbeef")])).to.be.revertedWithCustomError(hub, "UnknownRuleKind").withArgs("0xdeadbeef");
    });

    it("stores rules in order and freezes them", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const rules = [pairLimitsRule(ctx, callLimits(ctx, { minPremium: 5n })), spotBandRule(ctx, { maxPriceAge: 60, maxInTheMoneyBps: 500 })];
      const { vaultId } = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx), rules);
      const stored = await ctx.hub.rulesOf(vaultId);
      expect(stored.map((r: any) => [r.validator, r.kind, r.data])).to.deep.equal(rules.map(r => [r.validator, r.kind, r.data]));
      const abi = new Interface(ctx.hub.interface.fragments);
      expect(abi.getFunction("tightenVaultTerms")).to.equal(null);
      expect(abi.getFunction("tightenPairTerms")).to.equal(null);
    });

    it("termsHash covers terms, pairs and rules but not auction scheduling", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const rules = [pairLimitsRule(ctx, callLimits(ctx))];
      const a = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx), rules);
      const b = await createVaultAs(ctx, ctx.alice, callTerms(ctx, { auctionStartsAt: 1_900_000_000n }), callPairs(ctx), rules);
      const c = await createVaultAs(ctx, ctx.alice, callTerms(ctx, { minCollateral: 1n }), callPairs(ctx), rules);
      const d = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx), []);
      const ha = await ctx.hub.termsHashOf(a.vaultId);
      expect(await ctx.hub.termsHashOf(b.vaultId)).to.equal(ha);
      expect(await ctx.hub.termsHashOf(c.vaultId)).to.not.equal(ha);
      expect(await ctx.hub.termsHashOf(d.vaultId)).to.not.equal(ha);
      const t = callTerms(ctx);
      const coder = AbiCoder.defaultAbiCoder();
      const expected = keccak256(coder.encode(
        ["address", "address", "bool", "bool", "uint8", "uint8", "uint64", "uint256", "uint32", "bytes32", "bytes32"],
        [t.underlying, t.collateral, t.allowPartialExercise, t.publicDeposits, t.allowedExercise, t.allowedSettlement, t.expiry, t.minCollateral, t.maxSettlementPriceAge,
          keccak256(coder.encode(["tuple(address quoteToken,address premiumToken)[]"], [callPairs(ctx).map(p => [p.quoteToken, p.premiumToken])])),
          keccak256(coder.encode(["tuple(address validator,bytes4 kind,bytes data)[]"], [rules.map(r => [r.validator, r.kind, r.data])]))],
      ));
      expect(ha).to.equal(expected);
    });

    it("only the owner may schedule or transfer; scheduling survives ownership transfer", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, alice, bob } = ctx;
      const { vaultId } = await createVaultAs(ctx, alice, callTerms(ctx), callPairs(ctx));
      await expect(hub.connect(bob).scheduleAuction(vaultId, 1n)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
      await expect(hub.connect(bob).transferVaultOwnership(vaultId, bob.address)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
      await expect(hub.connect(alice).scheduleAuction(vaultId, 1_900_000_000n)).to.emit(hub, "AuctionScheduled").withArgs(vaultId, 1_900_000_000n);
      expect((await hub.termsOf(vaultId)).auctionStartsAt).to.equal(1_900_000_000n);
      await expect(hub.connect(alice).transferVaultOwnership(vaultId, ZeroAddress)).to.be.revertedWithCustomError(hub, "ZeroAddress");
      await expect(hub.connect(alice).transferVaultOwnership(vaultId, bob.address)).to.emit(hub, "VaultOwnershipTransferred").withArgs(vaultId, alice.address, bob.address);
      await expect(hub.connect(alice).scheduleAuction(vaultId, 0n)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
      await hub.connect(bob).scheduleAuction(vaultId, 0n);
      expect((await hub.termsOf(vaultId)).auctionStartsAt).to.equal(0n);
    });
  });
});
