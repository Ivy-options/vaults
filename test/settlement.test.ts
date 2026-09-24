import { expect } from "chai";
import { network } from "hardhat";
import {
  EXERCISE_WINDOW,
  EXPIRY_PRICE_PUBLICATION_WINDOW,
  ExerciseStyle,
  Phase,
  SettlementType,
  USDC_UNIT,
  WETH_UNIT,
  callPairs,
  callTerms,
  createVaultAs,
  deployIvy,
  fixture,
  fund,
} from "./helpers/setup.js";
import type { IvyContext } from "./helpers/setup.js";
import { at, goLive, setExercisePrice, publishExpiryPrice } from "./helpers/scenarios.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const load = fixture(connection, () => deployIvy(connection));

const CALL_PAYOUT_ALL = 909_090_909_090_909_090n; // 10 WETH × (3300 − 3000) / 3300
const CALL_PAYOUT_SIX = 545_454_545_454_545_454n; // 6 WETH × (3300 − 3000) / 3300

describe("expire", () => {
  let c: IvyContext;
  beforeEach(async () => {
    c = await load();
  });

  it("physical: not before expiry + window; afterwards leftovers stay for the LPs", async () => {
    const { vaultId, vaultAddress, bid } = await goLive(c);
    expect(await c.hub.expirationTimeOf(vaultId)).to.equal(bid.expiry + EXERCISE_WINDOW);
    await expect(c.hub.expire(vaultId)).to.be.revertedWithCustomError(c.hub, "ExpirationNotReached");
    await at(c, bid.expiry + EXERCISE_WINDOW + 1n);
    await expect(c.hub.connect(c.bob).expire(vaultId))
      .to.emit(c.hub, "Settled")
      .withArgs(vaultId, 0n, 10n * WETH_UNIT, 0n);
    expect((await c.hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);
    expect(await c.weth.balanceOf(vaultAddress)).to.equal(10n * WETH_UNIT);
    expect(await c.usdc.balanceOf(vaultAddress)).to.equal(1000n * USDC_UNIT);
  });

  it("physical: partially exercised then settled", async () => {
    const { vaultId, vaultAddress, bid } = await goLive(c);
    await fund(c, c.usdc, c.marketMaker, vaultAddress, 12_000n * USDC_UNIT);
    await c.hub.connect(c.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await at(c, bid.expiry + EXERCISE_WINDOW + 1n);
    await expect(c.hub.expire(vaultId))
      .to.emit(c.hub, "Settled")
      .withArgs(vaultId, 4n * WETH_UNIT, 10n * WETH_UNIT, 0n);
  });

  it("cash European call: settles at expiry and reserves the payout for the market maker", async () => {
    const { hub, weth, marketMaker, bob, alice } = c;
    const { vaultId, bid } = await goLive(
      c,
      { withFeed: true },
      { settlement: SettlementType.Cash, style: ExerciseStyle.European },
    );
    expect(await hub.expirationTimeOf(vaultId)).to.equal(
      bid.expiry + EXPIRY_PRICE_PUBLICATION_WINDOW + EXERCISE_WINDOW,
    );
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await publishExpiryPrice(c, vaultId, 3300n * USDC_UNIT);
    expect(await hub.expirationTimeOf(vaultId)).to.equal(bid.expiry);
    await expect(hub.connect(alice).expire(vaultId))
      .to.emit(hub, "Settled")
      .withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, CALL_PAYOUT_ALL);
    expect((await hub.stateOf(vaultId)).pendingPayout).to.equal(CALL_PAYOUT_ALL);

    await expect(hub.connect(bob).claimPayout(vaultId)).to.be.revertedWithCustomError(hub, "NotExecutor");
    const tx = hub.connect(marketMaker).claimPayout(vaultId);
    await expect(tx).to.emit(hub, "PayoutClaimed").withArgs(vaultId, marketMaker.address, CALL_PAYOUT_ALL);
    await expect(tx).to.changeTokenBalances(ethers, weth, [marketMaker], [CALL_PAYOUT_ALL]);
    expect((await hub.stateOf(vaultId)).pendingPayout).to.equal(0n);
    await expect(hub.connect(marketMaker).claimPayout(vaultId)).to.be.revertedWithCustomError(hub, "NothingToClaim");
  });

  it("cash put: reserves the payout in quote", async () => {
    const { vaultId, bid } = await goLive(
      c,
      { isCall: false, withFeed: true },
      { settlement: SettlementType.Cash, style: ExerciseStyle.European },
    );
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await publishExpiryPrice(c, vaultId, 2700n * USDC_UNIT);
    await expect(c.hub.expire(vaultId))
      .to.emit(c.hub, "Settled")
      .withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 3000n * USDC_UNIT);
    await expect(c.hub.connect(c.marketMaker).claimPayout(vaultId)).to.changeTokenBalances(
      ethers,
      c.usdc,
      [c.marketMaker],
      [3000n * USDC_UNIT],
    );
  });

  it("cash: out of the money reserves nothing", async () => {
    const { vaultId, bid } = await goLive(
      c,
      { withFeed: true },
      { settlement: SettlementType.Cash, style: ExerciseStyle.European },
    );
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await publishExpiryPrice(c, vaultId, 2900n * USDC_UNIT);
    await expect(c.hub.expire(vaultId))
      .to.emit(c.hub, "Settled")
      .withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 0n);
    await expect(c.hub.connect(c.marketMaker).claimPayout(vaultId)).to.be.revertedWithCustomError(
      c.hub,
      "NothingToClaim",
    );
  });

  it("cash: a missing report allows permissionless recovery after the physical fallback window", async () => {
    const { vaultId, bid } = await goLive(
      c,
      { withFeed: true },
      { settlement: SettlementType.Cash, style: ExerciseStyle.European },
    );
    await networkHelpers.time.increaseTo(bid.expiry + 30n * 86400n);
    await expect(publishExpiryPrice(c, vaultId, 3300n * USDC_UNIT)).revertedWithCustomError(
      c.hub,
      "ExpiryPricePublicationClosed",
    );
    await expect(c.hub.expire(vaultId))
      .emit(c.hub, "PhysicalFallbackExpired")
      .withArgs(vaultId, 10n * WETH_UNIT);
    expect((await c.hub.stateOf(vaultId)).phase).eq(Phase.Settled);
    expect((await c.hub.stateOf(vaultId)).pendingPayout).eq(0n);
  });

  it("cash American: the unexercised remainder auto-settles at expiry", async () => {
    const { vaultId, bid } = await goLive(
      c,
      { withFeed: true },
      { settlement: SettlementType.Cash, style: ExerciseStyle.American },
    );
    await setExercisePrice(c, vaultId, 3300n * USDC_UNIT);
    await c.hub.connect(c.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await publishExpiryPrice(c, vaultId, 3300n * USDC_UNIT);
    await expect(c.hub.expire(vaultId))
      .to.emit(c.hub, "Settled")
      .withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, CALL_PAYOUT_SIX);
  });

  it("expire only works in the Live phase", async () => {
    const open = await createVaultAs(c, c.alice, callTerms(c), callPairs(c));
    await expect(c.hub.expire(open.vaultId))
      .to.be.revertedWithCustomError(c.hub, "WrongPhase")
      .withArgs(Phase.Live, Phase.Open);
    const { vaultId, bid } = await goLive(c);
    await at(c, bid.expiry + EXERCISE_WINDOW + 1n);
    await c.hub.expire(vaultId);
    await expect(c.hub.expire(vaultId))
      .to.be.revertedWithCustomError(c.hub, "WrongPhase")
      .withArgs(Phase.Live, Phase.Settled);
  });
});
