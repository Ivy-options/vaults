import { expect } from "chai";
import { network } from "hardhat";
import { EXERCISE_WINDOW, ExerciseStyle, Phase, SettlementType, USDC_UNIT, WETH_UNIT, deployIvy, fund, type IvyContext } from "./helpers/setup.js";
import { at, goLive, setSpot } from "./helpers/scenarios.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

const CALL_PAYOUT_ALL = 909_090_909_090_909_090n;

describe("claim", function () {
  const fixture = async () => { const c = await deployIvy(connection); await c.hub.setTransfersEnabled(true); return c; };

  /** alice 6 WETH + bob 4 WETH, physical American call, expires unexercised. */
  async function expiredCall(ctx: IvyContext) {
    const live = await goLive(ctx, { deposit: 6n * WETH_UNIT, extraDeposits: [{ signer: ctx.bob, amount: 4n * WETH_UNIT }] });
    await at(ctx, live.bid.expiry + EXERCISE_WINDOW + 1n);
    await ctx.hub.expire(live.vaultId);
    return live;
  }

  it("expired physical call: collateral splits while unpaid premium stays reserved", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, bob } = ctx;
    const { vaultId, vaultAddress } = await expiredCall(ctx);

    const txA = hub.connect(alice).claim(vaultId, 6n * WETH_UNIT);
    await expect(txA).to.emit(hub, "Claimed").withArgs(vaultId, alice.address, 6n * WETH_UNIT);
    await expect(txA).to.changeTokenBalances(ethers, weth, [alice], [6n * WETH_UNIT]);
    await expect(txA).to.changeTokenBalances(ethers, usdc, [alice], [0n]);

    const txB = hub.connect(bob).claim(vaultId, 4n * WETH_UNIT);
    await expect(txB).to.changeTokenBalances(ethers, weth, [bob], [4n * WETH_UNIT]);
    await expect(txB).to.changeTokenBalances(ethers, usdc, [bob], [0n]);

    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
    expect(await usdc.balanceOf(vaultAddress)).to.equal(1000n * USDC_UNIT);
    expect(await hub.totalShares(vaultId)).to.equal(0n);
  });

  it("fully exercised physical call: LPs receive quote, premium remains separately claimable", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, bob, marketMaker } = ctx;
    const { vaultId, vaultAddress } = await goLive(ctx, { deposit: 6n * WETH_UNIT, extraDeposits: [{ signer: bob, amount: 4n * WETH_UNIT }] });
    await fund(ctx, usdc, marketMaker, vaultAddress, 30_000n * USDC_UNIT);
    await hub.connect(marketMaker).exercise(vaultId, 10n * WETH_UNIT);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);

    const txA = hub.connect(alice).claim(vaultId, 6n * WETH_UNIT);
    await expect(txA).to.changeTokenBalances(ethers, usdc, [alice], [18_000n * USDC_UNIT]);
    await expect(txA).to.changeTokenBalances(ethers, weth, [alice], [0n]);
    await expect(hub.connect(bob).claim(vaultId, 4n * WETH_UNIT)).to.changeTokenBalances(ethers, usdc, [bob], [12_000n * USDC_UNIT]);
    expect(await usdc.balanceOf(vaultAddress)).to.equal(1000n * USDC_UNIT);
  });

  it("partially exercised put: LPs receive a mixed pot", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, bob, marketMaker } = ctx;
    const { vaultId, vaultAddress, bid } = await goLive(ctx, {
      isCall: false,
      deposit: 18_000n * USDC_UNIT,
      extraDeposits: [{ signer: bob, amount: 12_000n * USDC_UNIT }],
    });
    await fund(ctx, weth, marketMaker, vaultAddress, 4n * WETH_UNIT);
    await hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await hub.expire(vaultId);
    expect(await usdc.balanceOf(vaultAddress)).to.equal(19_000n * USDC_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(4n * WETH_UNIT);

    const txA = hub.connect(alice).claim(vaultId, 18_000n * USDC_UNIT);
    await expect(txA).to.changeTokenBalances(ethers, usdc, [alice], [10_800n * USDC_UNIT]);
    await expect(txA).to.changeTokenBalances(ethers, weth, [alice], [24n * WETH_UNIT / 10n]);
    const txB = hub.connect(bob).claim(vaultId, 12_000n * USDC_UNIT);
    await expect(txB).to.changeTokenBalances(ethers, usdc, [bob], [7_200n * USDC_UNIT]);
    await expect(txB).to.changeTokenBalances(ethers, weth, [bob], [16n * WETH_UNIT / 10n]);
  });

  it("cash settlement excludes the market maker's pending payout", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, marketMaker } = ctx;
    const { vaultId, vaultAddress, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await ctx.settlementFeed.setSettlementPrice(ctx.wethAddress, ctx.usdcAddress, bid.expiry, 3300n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await hub.expire(vaultId);

    const tx = hub.connect(alice).claim(vaultId, 10n * WETH_UNIT);
    await expect(tx).to.changeTokenBalances(ethers, weth, [alice], [10n * WETH_UNIT - CALL_PAYOUT_ALL]);
    await expect(tx).to.changeTokenBalances(ethers, usdc, [alice], [0n]);
    expect(await weth.balanceOf(vaultAddress)).to.equal(CALL_PAYOUT_ALL);
    await expect(hub.connect(marketMaker).claimPayout(vaultId)).to.changeTokenBalances(ethers, weth, [marketMaker], [CALL_PAYOUT_ALL]);
    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
  });

  it("transferred shares can claim", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, shares, weth, usdc, alice, carol } = ctx;
    const { vaultId } = await expiredCall(ctx);
    await shares.connect(alice).safeTransferFrom(alice.address, carol.address, vaultId, 2n * WETH_UNIT, "0x");
    const tx = hub.connect(carol).claim(vaultId, 2n * WETH_UNIT);
    await expect(tx).to.changeTokenBalances(ethers, weth, [carol], [2n * WETH_UNIT]);
    await expect(tx).to.changeTokenBalances(ethers, usdc, [carol], [0n]);
  });

  it("partial claims stay proportional", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, shares, weth, usdc, alice } = ctx;
    const { vaultId } = await expiredCall(ctx);
    const first = hub.connect(alice).claim(vaultId, 3n * WETH_UNIT);
    await expect(first).to.changeTokenBalances(ethers, weth, [alice], [3n * WETH_UNIT]);
    await expect(first).to.changeTokenBalances(ethers, usdc, [alice], [0n]);
    const second = hub.connect(alice).claim(vaultId, 3n * WETH_UNIT);
    await expect(second).to.changeTokenBalances(ethers, weth, [alice], [3n * WETH_UNIT]);
    await expect(second).to.changeTokenBalances(ethers, usdc, [alice], [0n]);
    expect(await shares.balanceOf(alice.address, vaultId)).to.equal(0n);
  });

  it("rejects zero, too many shares and the wrong phase", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, carol } = ctx;
    const { vaultId } = await expiredCall(ctx);
    await expect(hub.connect(alice).claim(vaultId, 0n)).to.be.revertedWithCustomError(hub, "ZeroAmount");
    await expect(hub.connect(carol).claim(vaultId, 1n)).to.be.revertedWithCustomError(hub, "InsufficientShares");
    await expect(hub.connect(alice).claim(vaultId, 7n * WETH_UNIT)).to.be.revertedWithCustomError(hub, "InsufficientShares");
    const live = await goLive(ctx);
    await expect(hub.connect(alice).claim(live.vaultId, 1n)).to.be.revertedWithCustomError(hub, "WrongPhase").withArgs(Phase.Settled, Phase.Live);
  });
});
