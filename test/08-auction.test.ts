import { expect } from "chai";
import { network } from "hardhat";
import {
  AUCTION_TIMEOUT, ExercisePolicy, Phase, SettlementPolicy, THIRTY_DAYS, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, fund,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("auction", function () {
  async function fixture() {
    const ctx = await deployIvy(connection);
    const v = await createVaultAs(ctx, ctx.alice, callTerms(ctx, { minCollateral: 5n * WETH_UNIT }), callPairs(ctx));
    await fund(ctx, ctx.weth, ctx.alice, v.vaultAddress, 6n * WETH_UNIT);
    await ctx.hub.connect(ctx.alice).deposit(v.vaultId, 6n * WETH_UNIT);
    return { ...ctx, ...v };
  }

  const anyTerms = {
    allowedExercise: ExercisePolicy.Either,
    allowedSettlement: SettlementPolicy.Physical,
    maxTenor: THIRTY_DAYS,
    minCollateral: 5n * WETH_UNIT,
    maxSpotDeviationBps: 0,
    maxPriceAge: 0,
  };

  it("owner opens the auction and the vault freezes", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, vault, vaultId, vaultAddress, weth, usdcAddress } = ctx;
    await expect(hub.connect(alice).openAuction(vaultId)).to.emit(hub, "AuctionOpened").withArgs(vaultId, 6n * WETH_UNIT);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Auction);
    expect(s.auctionOpenedAt).to.equal(BigInt(await networkHelpers.time.latest()));

    await fund(ctx, weth, alice, vaultAddress, WETH_UNIT);
    await expect(hub.connect(alice).deposit(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase").withArgs(Phase.Open, Phase.Auction);
    await expect(vault.connect(alice).deposit(WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).withdraw(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).tightenVaultTerms(vaultId, anyTerms)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).tightenPairTerms(vaultId, usdcAddress, { premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true })).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).scheduleAuction(vaultId, 1n)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "WrongPhase");
  });

  it("requires collateral above zero and above the minimum", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, weth } = ctx;
    const low = await createVaultAs(ctx, alice, callTerms(ctx, { minCollateral: 5n * WETH_UNIT }), callPairs(ctx));
    await fund(ctx, weth, alice, low.vaultAddress, 4n * WETH_UNIT);
    await hub.connect(alice).deposit(low.vaultId, 4n * WETH_UNIT);
    await expect(hub.connect(alice).openAuction(low.vaultId)).to.be.revertedWithCustomError(hub, "BelowMinCollateral").withArgs(4n * WETH_UNIT, 5n * WETH_UNIT);
    const empty = await createVaultAs(ctx, alice, callTerms(ctx), callPairs(ctx));
    await expect(hub.connect(alice).openAuction(empty.vaultId)).to.be.revertedWithCustomError(hub, "ZeroAmount");
  });

  it("strangers cannot open an unscheduled auction", async function () {
    const { hub, bob, vaultId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
  });

  it("anyone can open a scheduled auction once the time has come", async function () {
    const { hub, alice, bob, vaultId } = await networkHelpers.loadFixture(fixture);
    const startsAt = BigInt(await networkHelpers.time.latest()) + 1000n;
    await hub.connect(alice).scheduleAuction(vaultId, startsAt);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
    await networkHelpers.time.increaseTo(startsAt);
    await expect(hub.connect(bob).openAuction(vaultId)).to.emit(hub, "AuctionOpened");
  });

  it("bid master can cancel at any time and the owner can reopen", async function () {
    const { hub, alice, bidMaster, vaultId } = await networkHelpers.loadFixture(fixture);
    await hub.connect(alice).openAuction(vaultId);
    await expect(hub.connect(bidMaster).cancelAuction(vaultId)).to.emit(hub, "AuctionCancelled").withArgs(vaultId);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Open);
    expect(s.auctionOpenedAt).to.equal(0n);
    await hub.connect(alice).openAuction(vaultId);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Auction);
  });

  it("owner can cancel only after the timeout, and the schedule is cleared", async function () {
    const { hub, alice, bob, vaultId } = await networkHelpers.loadFixture(fixture);
    const startsAt = BigInt(await networkHelpers.time.latest()) + 10n;
    await hub.connect(alice).scheduleAuction(vaultId, startsAt);
    await hub.connect(alice).openAuction(vaultId);
    await expect(hub.connect(alice).cancelAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionTimeoutNotReached");
    await expect(hub.connect(bob).cancelAuction(vaultId)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await networkHelpers.time.increase(AUCTION_TIMEOUT);
    await hub.connect(alice).cancelAuction(vaultId);
    expect((await hub.termsOf(vaultId)).auctionStartsAt).to.equal(0n);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
  });

  it("cancel only works in the Auction phase", async function () {
    const { hub, bidMaster, vaultId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(bidMaster).cancelAuction(vaultId)).to.be.revertedWithCustomError(hub, "WrongPhase").withArgs(Phase.Auction, Phase.Open);
  });
});
