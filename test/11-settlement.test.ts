import { expect } from "chai";
import { network } from "hardhat";
import {
  EXERCISE_WINDOW, ExerciseStyle, Phase, SETTLEMENT_GRACE, SettlementType, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, fund,
} from "./helpers/setup.js";
import { at, goLive, setSpot } from "./helpers/scenarios.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

const CALL_PAYOUT_ALL = 909_090_909_090_909_090n;   // 10 WETH × (3300 − 3000) / 3300
const CALL_PAYOUT_SIX = 545_454_545_454_545_454n;   // 6 WETH × (3300 − 3000) / 3300

describe("settle", function () {
  const fixture = () => deployIvy(connection);

  it("physical: not before expiry + window; afterwards leftovers stay for the LPs", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress, bid } = await goLive(ctx);
    expect(await ctx.hub.settlementTimeOf(vaultId)).to.equal(bid.expiry + EXERCISE_WINDOW);
    await expect(ctx.hub.settle(vaultId)).to.be.revertedWithCustomError(ctx.hub, "SettlementNotReached");
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await expect(ctx.hub.connect(ctx.bob).settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 0n, 10n * WETH_UNIT, 0n);
    expect((await ctx.hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);
    expect(await ctx.weth.balanceOf(vaultAddress)).to.equal(10n * WETH_UNIT);
    expect(await ctx.usdc.balanceOf(vaultAddress)).to.equal(1000n * USDC_UNIT);
  });

  it("physical: partially exercised then settled", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress, bid } = await goLive(ctx);
    await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 12_000n * USDC_UNIT);
    await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 4n * WETH_UNIT, 10n * WETH_UNIT, 0n);
  });

  it("cash European call: settles at expiry and reserves the payout for the market maker", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, marketMaker, bob, alice } = ctx;
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    expect(await hub.settlementTimeOf(vaultId)).to.equal(bid.expiry);
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await ctx.feed.setSettlementPrice(ctx.wethAddress, ctx.usdcAddress, bid.expiry, 3300n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(hub.connect(alice).settle(vaultId)).to.emit(hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, CALL_PAYOUT_ALL);
    expect((await hub.stateOf(vaultId)).pendingPayout).to.equal(CALL_PAYOUT_ALL);

    await expect(hub.connect(bob).claimPayout(vaultId)).to.be.revertedWithCustomError(hub, "NotExecutor");
    const tx = hub.connect(marketMaker).claimPayout(vaultId);
    await expect(tx).to.emit(hub, "PayoutClaimed").withArgs(vaultId, marketMaker.address, CALL_PAYOUT_ALL);
    await expect(tx).to.changeTokenBalances(ethers, weth, [marketMaker], [CALL_PAYOUT_ALL]);
    expect((await hub.stateOf(vaultId)).pendingPayout).to.equal(0n);
    await expect(hub.connect(marketMaker).claimPayout(vaultId)).to.be.revertedWithCustomError(hub, "NothingToClaim");
  });

  it("cash put: reserves the payout in quote", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await ctx.feed.setSettlementPrice(ctx.wethAddress, ctx.usdcAddress, bid.expiry, 2700n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 3000n * USDC_UNIT);
    await expect(ctx.hub.connect(ctx.marketMaker).claimPayout(vaultId)).to.changeTokenBalances(ethers, ctx.usdc, [ctx.marketMaker], [3000n * USDC_UNIT]);
  });

  it("cash: out of the money reserves nothing", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await ctx.feed.setSettlementPrice(ctx.wethAddress, ctx.usdcAddress, bid.expiry, 2900n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 0n);
    await expect(ctx.hub.connect(ctx.marketMaker).claimPayout(vaultId)).to.be.revertedWithCustomError(ctx.hub, "NothingToClaim");
  });

  it("cash: no expiry report remains pending even after the former grace period", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await networkHelpers.time.increaseTo(bid.expiry + 30n * 86400n);
    await expect(ctx.hub.settle(vaultId)).revertedWithCustomError(ctx.hub, "ReportUnavailable");
    expect((await ctx.hub.stateOf(vaultId)).phase).eq(Phase.Live);
    await ctx.feed.setSettlementPrice(ctx.wethAddress, ctx.usdcAddress, bid.expiry, 3300n * USDC_UNIT);
    await setSpot(ctx, 5000n * USDC_UNIT);
    await ctx.hub.settle(vaultId);
    expect((await ctx.hub.stateOf(vaultId)).pendingPayout).eq(CALL_PAYOUT_ALL);
  });

  it("cash American: the unexercised remainder auto-settles at expiry", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.American });
    await ctx.feed.setSettlementPrice(ctx.wethAddress, ctx.usdcAddress, bid.expiry, 3300n * USDC_UNIT);
    await setSpot(ctx, 3300n * USDC_UNIT);
    await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await ctx.feed.setSettlementPrice(ctx.wethAddress, ctx.usdcAddress, bid.expiry, 3300n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, CALL_PAYOUT_SIX);
  });

  it("settle only works in the Live phase", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const open = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    await expect(ctx.hub.settle(open.vaultId)).to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Live, Phase.Open);
    const { vaultId, bid } = await goLive(ctx);
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await ctx.hub.settle(vaultId);
    await expect(ctx.hub.settle(vaultId)).to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Live, Phase.Settled);
  });
});
