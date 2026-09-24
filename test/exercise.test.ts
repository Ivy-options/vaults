import { expect } from "chai";
import { network } from "hardhat";
import {
  EXERCISE_WINDOW,
  ExerciseStyle,
  Phase,
  SettlementType,
  USDC_UNIT,
  WETH_UNIT,
  deployIvy,
  fixture,
  fund,
} from "./helpers/setup.js";
import type { IvyContext } from "./helpers/setup.js";
import { at, goLive, setExercisePrice } from "./helpers/scenarios.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const load = fixture(connection, () => deployIvy(connection));

describe("exercise", () => {
  let c: IvyContext;
  beforeEach(async () => {
    c = await load();
  });

  describe("physical call", () => {
    it("partial exercise pulls quote (rounded up) and pushes collateral; the vault stays Live", async () => {
      const { hub, weth, usdc, marketMaker } = c;
      const { vaultId, vaultAddress } = await goLive(c);
      await fund(c, usdc, marketMaker, vaultAddress, 12_000n * USDC_UNIT);
      const tx = hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx)
        .to.emit(hub, "Exercised")
        .withArgs(vaultId, 4n * WETH_UNIT, 12_000n * USDC_UNIT, 4n * WETH_UNIT);
      await expect(tx).to.changeTokenBalances(
        ethers,
        weth,
        [marketMaker, vaultAddress],
        [4n * WETH_UNIT, -4n * WETH_UNIT],
      );
      await expect(tx).to.changeTokenBalances(
        ethers,
        usdc,
        [marketMaker, vaultAddress],
        [-12_000n * USDC_UNIT, 12_000n * USDC_UNIT],
      );
      expect(await hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
      expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Live);
    });

    it("rounds the quote due up", async () => {
      const { vaultId, vaultAddress } = await goLive(c);
      await fund(c, c.usdc, c.marketMaker, vaultAddress, USDC_UNIT);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 1n))
        .to.emit(c.hub, "Exercised")
        .withArgs(vaultId, 1n, 1n, 1n);
    });

    it("a full exercise settles the vault", async () => {
      const { vaultId, vaultAddress } = await goLive(c);
      await fund(c, c.usdc, c.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 10n * WETH_UNIT))
        .to.emit(c.hub, "Settled")
        .withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 0n);
      expect((await c.hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);
      expect(await c.hub.remainingNotional(vaultId)).to.equal(0n);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 1n))
        .to.be.revertedWithCustomError(c.hub, "WrongPhase")
        .withArgs(Phase.Live, Phase.Settled);
    });

    it("cannot exceed the remaining notional; only the market maker; never zero", async () => {
      const { vaultId, vaultAddress } = await goLive(c);
      await fund(c, c.usdc, c.marketMaker, vaultAddress, 40_000n * USDC_UNIT);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 11n * WETH_UNIT))
        .to.be.revertedWithCustomError(c.hub, "ExceedsRemaining")
        .withArgs(10n * WETH_UNIT);
      await expect(c.hub.connect(c.alice).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "NotExecutor",
      );
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 0n)).to.be.revertedWithCustomError(
        c.hub,
        "ZeroAmount",
      );
    });

    it("American: open before the physical deadline, closed at the deadline", async () => {
      const { vaultId, vaultAddress, bid } = await goLive(c);
      await fund(c, c.usdc, c.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await at(c, bid.expiry + EXERCISE_WINDOW - 1n);
      await c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(c, bid.expiry + EXERCISE_WINDOW);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "ExerciseWindowClosed",
      );
    });

    it("European: closed before expiry, open inside the window", async () => {
      const { vaultId, vaultAddress, bid } = await goLive(c, {}, { style: ExerciseStyle.European });
      await fund(c, c.usdc, c.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "ExerciseNotOpenYet",
      );
      await at(c, bid.expiry);
      await c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(c, bid.expiry + EXERCISE_WINDOW);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "ExerciseWindowClosed",
      );
    });

    it("fails if the quote does not arrive in full", async () => {
      const { vaultId, vaultAddress, vault } = await goLive(c);
      await fund(c, c.usdc, c.marketMaker, vaultAddress, 12_000n * USDC_UNIT);
      await c.usdc.setFeeBps(100n);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 4n * WETH_UNIT))
        .to.be.revertedWithCustomError(vault, "ShortReceived")
        .withArgs(12_000n * USDC_UNIT, 11_880n * USDC_UNIT);
    });
  });

  describe("physical put", () => {
    it("pulls underlying and pushes quote (rounded down)", async () => {
      const { hub, weth, usdc, marketMaker } = c;
      const { vaultId, vaultAddress } = await goLive(c, { isCall: false });
      await fund(c, weth, marketMaker, vaultAddress, 4n * WETH_UNIT);
      const tx = hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx)
        .to.emit(hub, "Exercised")
        .withArgs(vaultId, 4n * WETH_UNIT, 4n * WETH_UNIT, 12_000n * USDC_UNIT);
      await expect(tx).to.changeTokenBalances(
        ethers,
        weth,
        [marketMaker, vaultAddress],
        [-4n * WETH_UNIT, 4n * WETH_UNIT],
      );
      await expect(tx).to.changeTokenBalances(
        ethers,
        usdc,
        [marketMaker, vaultAddress],
        [12_000n * USDC_UNIT, -12_000n * USDC_UNIT],
      );
      expect(await hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
    });
  });

  describe("cash", () => {
    it("call pays the intrinsic value in underlying at the current spot", async () => {
      const { vaultId, vaultAddress } = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
      await setExercisePrice(c, vaultId, 3300n * USDC_UNIT);
      const tx = c.hub.connect(c.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx)
        .to.emit(c.hub, "Exercised")
        .withArgs(vaultId, 4n * WETH_UNIT, 0n, 363_636_363_636_363_636n);
      await expect(tx).to.changeTokenBalances(
        ethers,
        c.weth,
        [c.marketMaker, vaultAddress],
        [363_636_363_636_363_636n, -363_636_363_636_363_636n],
      );
      expect(await c.hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
    });

    it("put pays the intrinsic value in quote", async () => {
      const { vaultId, vaultAddress } = await goLive(
        c,
        { isCall: false, withFeed: true },
        { settlement: SettlementType.Cash },
      );
      await setExercisePrice(c, vaultId, 2700n * USDC_UNIT);
      const tx = c.hub.connect(c.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx)
        .to.emit(c.hub, "Exercised")
        .withArgs(vaultId, 4n * WETH_UNIT, 0n, 1200n * USDC_UNIT);
      await expect(tx).to.changeTokenBalances(
        ethers,
        c.usdc,
        [c.marketMaker, vaultAddress],
        [1200n * USDC_UNIT, -1200n * USDC_UNIT],
      );
    });

    it("out of the money reverts", async () => {
      const { vaultId } = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
      await setExercisePrice(c, vaultId, 2900n * USDC_UNIT);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "NothingToExercise",
      );
    });

    it("American cash switches from spot to required expiry reports at expiry", async () => {
      const { vaultId, bid } = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
      await networkHelpers.time.increaseTo(bid.expiry - 3n);
      await setExercisePrice(c, vaultId, 3300n * USDC_UNIT);
      await at(c, bid.expiry - 1n);
      await c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(c, bid.expiry);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "ReportUnavailable",
      );
    });

    it("European cash opens at expiry and requires the expiry report", async () => {
      const { vaultId, bid } = await goLive(
        c,
        { withFeed: true },
        { settlement: SettlementType.Cash, style: ExerciseStyle.European },
      );
      await setExercisePrice(c, vaultId, 3300n * USDC_UNIT);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "ExerciseNotOpenYet",
      );
      await at(c, bid.expiry);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "ReportUnavailable",
      );
    });

    it("a stale price reverts", async () => {
      const { vaultId } = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
      await setExercisePrice(c, vaultId, 3300n * USDC_UNIT, 3601n);
      await expect(c.hub.connect(c.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(
        c.hub,
        "StalePrice",
      );
    });
  });
});
