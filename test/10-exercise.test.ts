import { expect } from "chai";
import { network } from "hardhat";
import { EXERCISE_WINDOW, ExerciseStyle, Phase, SettlementType, USDC_UNIT, WETH_UNIT, deployIvy, fund } from "./helpers/setup.js";
import { at, goLive, setExercisePrice } from "./helpers/scenarios.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe("exercise", function () {
  const fixture = () => deployIvy(connection);

  describe("physical call", function () {
    it("partial exercise pulls quote (rounded up) and pushes collateral; the vault stays Live", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, weth, usdc, marketMaker } = ctx;
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, usdc, marketMaker, vaultAddress, 12_000n * USDC_UNIT);
      const tx = hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 12_000n * USDC_UNIT, 4n * WETH_UNIT);
      await expect(tx).to.changeTokenBalances(ethers, weth, [marketMaker, vaultAddress], [4n * WETH_UNIT, -4n * WETH_UNIT]);
      await expect(tx).to.changeTokenBalances(ethers, usdc, [marketMaker, vaultAddress], [-12_000n * USDC_UNIT, 12_000n * USDC_UNIT]);
      expect(await hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
      expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Live);
    });

    it("rounds the quote due up", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 1n))
        .to.emit(ctx.hub, "Exercised").withArgs(vaultId, 1n, 1n, 1n);
    });

    it("a full exercise settles the vault", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 10n * WETH_UNIT))
        .to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 0n);
      expect((await ctx.hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);
      expect(await ctx.hub.remainingNotional(vaultId)).to.equal(0n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 1n))
        .to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Live, Phase.Settled);
    });

    it("cannot exceed the remaining notional; only the market maker; never zero", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 40_000n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 11n * WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExceedsRemaining").withArgs(10n * WETH_UNIT);
      await expect(ctx.hub.connect(ctx.alice).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "NotExecutor");
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 0n)).to.be.revertedWithCustomError(ctx.hub, "ZeroAmount");
    });

    it("American: open before the physical deadline, closed at the deadline", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress, bid } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await at(ctx, bid.expiry + EXERCISE_WINDOW - 1n);
      await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(ctx, bid.expiry + EXERCISE_WINDOW);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExerciseWindowClosed");
    });

    it("European: closed before expiry, open inside the window", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress, bid } = await goLive(ctx, {}, { style: ExerciseStyle.European });
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExerciseNotOpenYet");
      await at(ctx, bid.expiry);
      await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(ctx, bid.expiry + EXERCISE_WINDOW);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExerciseWindowClosed");
    });

    it("fails if the quote does not arrive in full", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 12_000n * USDC_UNIT);
      await ctx.usdc.setFeeBps(100n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ShortReceived").withArgs(12_000n * USDC_UNIT, 11_880n * USDC_UNIT);
    });
  });

  describe("physical put", function () {
    it("pulls underlying and pushes quote (rounded down)", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, weth, usdc, marketMaker } = ctx;
      const { vaultId, vaultAddress } = await goLive(ctx, { isCall: false });
      await fund(ctx, weth, marketMaker, vaultAddress, 4n * WETH_UNIT);
      const tx = hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 4n * WETH_UNIT, 12_000n * USDC_UNIT);
      await expect(tx).to.changeTokenBalances(ethers, weth, [marketMaker, vaultAddress], [-4n * WETH_UNIT, 4n * WETH_UNIT]);
      await expect(tx).to.changeTokenBalances(ethers, usdc, [marketMaker, vaultAddress], [12_000n * USDC_UNIT, -12_000n * USDC_UNIT]);
      expect(await hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
    });
  });

  describe("cash", function () {
    it("call pays the intrinsic value in underlying at the current spot", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await setExercisePrice(ctx, 3300n * USDC_UNIT);
      const tx = ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(ctx.hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 0n, 363_636_363_636_363_636n);
      await expect(tx).to.changeTokenBalances(ethers, ctx.weth, [ctx.marketMaker, vaultAddress], [363_636_363_636_363_636n, -363_636_363_636_363_636n]);
      expect(await ctx.hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
    });

    it("put pays the intrinsic value in quote", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash });
      await setExercisePrice(ctx, 2700n * USDC_UNIT);
      const tx = ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(ctx.hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 0n, 1200n * USDC_UNIT);
      await expect(tx).to.changeTokenBalances(ethers, ctx.usdc, [ctx.marketMaker, vaultAddress], [1200n * USDC_UNIT, -1200n * USDC_UNIT]);
    });

    it("out of the money reverts", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await setExercisePrice(ctx, 2900n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "NothingToExercise");
    });

    it("American cash switches from spot to required expiry reports at expiry", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await networkHelpers.time.increaseTo(bid.expiry - 3n);
      await setExercisePrice(ctx, 3300n * USDC_UNIT);
      await at(ctx, bid.expiry - 1n);
      await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(ctx, bid.expiry);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "ReportUnavailable");
    });

    it("European cash opens at expiry and requires the expiry report", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
      await setExercisePrice(ctx, 3300n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "ExerciseNotOpenYet");
      await at(ctx, bid.expiry);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "ReportUnavailable");
    });

    it("a stale price reverts", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await setExercisePrice(ctx, 3300n * USDC_UNIT, 3601n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "StalePrice");
    });
  });
});
