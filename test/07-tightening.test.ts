import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import {
  ExercisePolicy, SettlementPolicy, THIRTY_DAYS, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, putPairs, putTerms,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

const SEVEN_DAYS = 7n * 24n * 3600n;

describe("tightening", function () {
  async function fixture() {
    const ctx = await deployIvy(connection);
    const call = await createVaultAs(
      ctx,
      ctx.alice,
      callTerms(ctx, {
        priceFeed: ctx.feedAddress,
        maxPriceAge: 3600,
        maxSpotDeviationBps: 1000,
        allowedSettlement: SettlementPolicy.Either,
        allowedExercise: ExercisePolicy.Either,
        minCollateral: WETH_UNIT,
      }),
      callPairs(ctx),
    );
    const put = await createVaultAs(ctx, ctx.alice, putTerms(ctx), putPairs(ctx, { strikeLimit: 3500n * USDC_UNIT }));
    const plain = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    return { ...ctx, callId: call.vaultId, putId: put.vaultId, plainId: plain.vaultId };
  }

  const base = {
    allowedExercise: ExercisePolicy.Either,
    allowedSettlement: SettlementPolicy.Either,
    maxTenor: THIRTY_DAYS,
    minCollateral: WETH_UNIT,
    maxSpotDeviationBps: 1000,
    maxPriceAge: 3600,
  };

  it("accepts every LP-favourable change and an unchanged submission", async function () {
    const { hub, alice, callId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(alice).tightenVaultTerms(callId, base)).to.emit(hub, "VaultTermsTightened").withArgs(callId);
    const tighter = {
      allowedExercise: ExercisePolicy.European,
      allowedSettlement: SettlementPolicy.Physical,
      maxTenor: SEVEN_DAYS,
      minCollateral: 2n * WETH_UNIT,
      maxSpotDeviationBps: 500,
      maxPriceAge: 600,
    };
    await hub.connect(alice).tightenVaultTerms(callId, tighter);
    const t = await hub.termsOf(callId);
    expect(t.allowedExercise).to.equal(ExercisePolicy.European);
    expect(t.allowedSettlement).to.equal(SettlementPolicy.Physical);
    expect(t.maxTenor).to.equal(SEVEN_DAYS);
    expect(t.minCollateral).to.equal(2n * WETH_UNIT);
    expect(t.maxSpotDeviationBps).to.equal(500n);
    expect(t.maxPriceAge).to.equal(600n);
  });

  it("rejects every loosening of vault terms", async function () {
    const { hub, alice, callId } = await networkHelpers.loadFixture(fixture);
    const narrowed = { ...base, allowedExercise: ExercisePolicy.European, allowedSettlement: SettlementPolicy.Physical };
    await hub.connect(alice).tightenVaultTerms(callId, narrowed);
    const attempts: Array<[string, Partial<typeof base>, string]> = [
      ["widening exercise back to Either", { allowedExercise: ExercisePolicy.Either }, "LoosensTerms"],
      ["switching exercise style", { allowedExercise: ExercisePolicy.American }, "LoosensTerms"],
      ["widening settlement back to Either", { allowedSettlement: SettlementPolicy.Either }, "LoosensTerms"],
      ["switching settlement type", { allowedSettlement: SettlementPolicy.Cash }, "LoosensTerms"],
      ["raising maxTenor", { maxTenor: THIRTY_DAYS + 1n }, "LoosensTerms"],
      ["zero maxTenor", { maxTenor: 0n }, "InvalidTenor"],
      ["lowering minCollateral", { minCollateral: WETH_UNIT - 1n }, "LoosensTerms"],
      ["raising spot deviation", { maxSpotDeviationBps: 1001 }, "LoosensTerms"],
      ["raising maxPriceAge", { maxPriceAge: 3601 }, "LoosensTerms"],
      ["zero maxPriceAge", { maxPriceAge: 0 }, "FeedNeedsMaxPriceAge"],
    ];
    for (const [label, patch, error] of attempts) {
      await expect(hub.connect(alice).tightenVaultTerms(callId, { ...narrowed, ...patch }), label).to.be.revertedWithCustomError(hub, error);
    }
  });

  it("ignores oracle fields when the vault has no feed", async function () {
    const { hub, alice, plainId } = await networkHelpers.loadFixture(fixture);
    await hub.connect(alice).tightenVaultTerms(plainId, {
      allowedExercise: ExercisePolicy.Either,
      allowedSettlement: SettlementPolicy.Physical,
      maxTenor: THIRTY_DAYS,
      minCollateral: 0n,
      maxSpotDeviationBps: 5000,
      maxPriceAge: 0,
    });
    const t = await hub.termsOf(plainId);
    expect(t.maxSpotDeviationBps).to.equal(0n);
    expect(t.maxPriceAge).to.equal(0n);
  });

  it("pair terms can raise floors and disable, but never loosen", async function () {
    const { hub, alice, callId, usdcAddress, daiAddress } = await networkHelpers.loadFixture(fixture);
    const pair = (o: Partial<{ premiumToken: string; strikeLimit: bigint; minPremium: bigint; enabled: boolean }>) => ({
      premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true, ...o,
    });
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, pair({ strikeLimit: 3100n * USDC_UNIT, minPremium: 50n * USDC_UNIT })))
      .to.emit(hub, "PairTermsTightened").withArgs(callId, usdcAddress);
    const p = await hub.pairTermsOf(callId, usdcAddress);
    expect(p.strikeLimit).to.equal(3100n * USDC_UNIT);
    expect(p.minPremium).to.equal(50n * USDC_UNIT);

    const current = pair({ strikeLimit: 3100n * USDC_UNIT, minPremium: 50n * USDC_UNIT });
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, strikeLimit: 3000n * USDC_UNIT })).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, minPremium: 40n * USDC_UNIT })).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, premiumToken: daiAddress })).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(callId, daiAddress, current)).to.be.revertedWithCustomError(hub, "PairUnknown").withArgs(daiAddress);

    await hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, enabled: false });
    expect((await hub.pairTermsOf(callId, usdcAddress)).enabled).to.equal(false);
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, enabled: true })).to.be.revertedWithCustomError(hub, "LoosensTerms");
  });

  it("put strike limit may only go down and never to zero", async function () {
    const { hub, alice, putId, usdcAddress } = await networkHelpers.loadFixture(fixture);
    const pair = (strikeLimit: bigint) => ({ premiumToken: usdcAddress, strikeLimit, minPremium: 0n, enabled: true });
    await hub.connect(alice).tightenPairTerms(putId, usdcAddress, pair(3200n * USDC_UNIT));
    await expect(hub.connect(alice).tightenPairTerms(putId, usdcAddress, pair(3300n * USDC_UNIT))).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(putId, usdcAddress, pair(0n))).to.be.revertedWithCustomError(hub, "InvalidStrikeLimit");
  });

  it("only the owner may tighten, schedule or transfer", async function () {
    const { hub, alice, bob, callId, usdcAddress } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(bob).tightenVaultTerms(callId, base)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(bob).tightenPairTerms(callId, usdcAddress, { premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true })).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(bob).scheduleAuction(callId, 1n)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(bob).transferVaultOwnership(callId, bob.address)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(alice).tightenVaultTerms(99n, base)).to.be.revertedWithCustomError(hub, "UnknownVault");
  });

  it("schedules the auction and transfers ownership", async function () {
    const { hub, alice, bob, callId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(alice).scheduleAuction(callId, 1_900_000_000n)).to.emit(hub, "AuctionScheduled").withArgs(callId, 1_900_000_000n);
    expect((await hub.termsOf(callId)).auctionStartsAt).to.equal(1_900_000_000n);

    await expect(hub.connect(alice).transferVaultOwnership(callId, ZeroAddress)).to.be.revertedWithCustomError(hub, "ZeroAddress");
    await expect(hub.connect(alice).transferVaultOwnership(callId, bob.address))
      .to.emit(hub, "VaultOwnershipTransferred").withArgs(callId, alice.address, bob.address);
    expect((await hub.stateOf(callId)).owner).to.equal(bob.address);
    await expect(hub.connect(alice).scheduleAuction(callId, 0n)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await hub.connect(bob).scheduleAuction(callId, 0n);
    expect((await hub.termsOf(callId)).auctionStartsAt).to.equal(0n);
  });
});
