import { expect } from "chai";
import { network } from "hardhat";
import { callTerms, callPairs, createVaultAs, deployIvy, SettlementType, WETH_UNIT as W, USDC_UNIT as U } from "./helpers/setup.js";
import { goLive, openVault, at } from "./helpers/scenarios.js";

describe("Hub settlement authority", function () {
  it("requires current publisher authority and retains finalized prices after rotation", async function () {
    const c = await deployIvy(await network.create());
    const hub = c.hub;
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    await c.networkHelpers.time.increaseTo(v.bid.expiry);
    const role = await hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    const now = BigInt(await c.networkHelpers.time.latest());
    await expect(hub.connect(c.bob).publishExpiry(v.vaultId, 3000, now + 100n))
      .revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await hub.publishExpiry(v.vaultId, 3000, now + 100n);
    await expect(hub.connect(c.bob).grantRole(role, c.bob.address)).revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await hub.grantRole(role, c.bob.address);
    await hub.revokeRole(role, c.admin.address);
    await expect(hub.publishExercisePrice(v.vaultId, 4000, now, now + 100n))
      .revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await expect(hub.connect(c.bob).publishExpiry(v.vaultId, 4000, now + 100n))
      .revertedWithCustomError(hub, "ReportFinalized");
    await c.networkHelpers.time.increase(1000);
    expect(await hub.settlementPrice(v.vaultId)).equal(3000);
  });

  it("requires and preserves a cash observation age limit without a source-contract binding", async function () {
    const c = await deployIvy(await network.create());
    await expect(c.hub.createVault(callTerms(c, { allowedSettlement: 1 }), callPairs(c)))
      .revertedWithCustomError(c.hub, "CashSettlementNeedsMaxPriceAge");
    await c.hub.connect(c.alice).createVault(callTerms(c, { allowedSettlement: 2, maxSettlementPriceAge: 60 }), callPairs(c));
    await c.hub.connect(c.alice).tightenVaultTerms(1, { allowedExercise: 1, allowedSettlement: 1, minCollateral: 0, maxInTheMoneyBps: 0, maxPriceAge: 0 });
    expect((await c.hub.termsOf(1)).maxSettlementPriceAge).equal(60);
  });

  it("enforces age and report-validity boundaries independently of indicative prices", async function () {
    const c = await deployIvy(await network.create());
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    let now = BigInt(await c.networkHelpers.time.latest());
    await c.feed.set(c.wethAddress, c.usdcAddress, 9000n * U, now);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "InvalidPrice");
    await c.hub.publishExercisePrice(v.vaultId, 4000n * U, now - 4000n, now + 1000n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "StalePrice");
    expect(await c.hub.remainingNotional(v.vaultId)).equal(10n * W);

    // At max age exactly, an otherwise valid report can authorize payment; one second later cannot.
    now = BigInt(await c.networkHelpers.time.latest());
    const ageBoundary = now + 2n;
    await c.hub.publishExercisePrice(v.vaultId, 4000n * U, ageBoundary - 3600n, ageBoundary + 100n);
    await at(c, ageBoundary);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 4n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "StalePrice");

    // Independently, a fresh observation stops authorizing payment immediately after validUntil.
    now = BigInt(await c.networkHelpers.time.latest());
    const validityBoundary = now + 2n;
    await c.hub.publishExercisePrice(v.vaultId, 4000n * U, now, validityBoundary);
    await at(c, validityBoundary);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 4n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "StalePrice");
  });

  it("locks missing expiry obligations until late recovery while keeping premium, fee and buyer reserves separate", async function () {
    const c = await deployIvy(await network.create());
    await c.hub.setPlatformFeeBps(200);
    const v = await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash });
    await c.feed.setSettlementPrice(c.wethAddress, c.usdcAddress, v.bid.expiry, 1);
    await at(c, v.bid.expiry);
    await expect(c.hub.expire(v.vaultId)).revertedWithCustomError(c.hub, "ReportUnavailable");
    expect(await c.hub.remainingNotional(v.vaultId)).equal(10n * W);
    expect((await c.hub.stateOf(v.vaultId)).phase).equal(2);
    await expect(c.hub.connect(c.alice).claim(v.vaultId, 30_000n * U)).revertedWithCustomError(c.hub, "WrongPhase");
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await v.vault.claimPlatformFee();
    await c.networkHelpers.time.increase(10000);
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await c.hub.grantRole(role, c.carol.address);
    await c.hub.revokeRole(role, c.admin.address);
    const now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.connect(c.carol).publishExpiry(v.vaultId, 2700n * U, now + 100n);
    await c.hub.expire(v.vaultId);
    expect(await v.vault.buyerReserved(c.usdcAddress)).equal(3000n * U);
    await c.hub.connect(c.alice).claim(v.vaultId, 30_000n * U);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers, c.usdc, c.marketMaker, 3000n * U);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).revertedWithCustomError(c.hub, "NothingToClaim");
  });

  it("validates per-vault reports and finalizes once at the inclusive publication boundary", async function () {
    const c = await deployIvy(await network.create());
    const hub = c.hub;
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    let now = BigInt(await c.networkHelpers.time.latest());
    await expect(hub.publishExercisePrice(v.vaultId, 0, now, now + 1000n)).revertedWithCustomError(hub, "InvalidPrice");
    await expect(hub.publishExpiry(v.vaultId, 0, now + 1000n)).revertedWithCustomError(hub, "InvalidPrice");
    await expect(hub.publishExercisePrice(v.vaultId, 1, 0, now + 1000n)).revertedWithCustomError(hub, "InvalidPrice");
    await expect(hub.publishExercisePrice(v.vaultId, 1, now + 1000n, now + 2000n)).revertedWithCustomError(hub, "InvalidPrice");
    await expect(hub.publishExpiry(v.vaultId, 1, v.bid.expiry + 2000n)).revertedWithCustomError(hub, "ExpirationNotReached");
    now = BigInt(await c.networkHelpers.time.latest());
    const publicationBoundary = now + 1n;
    await at(c, publicationBoundary);
    await expect(hub.publishExercisePrice(v.vaultId, 4000, publicationBoundary, publicationBoundary))
      .emit(hub, "ExercisePricePublished").withArgs(v.vaultId, c.wethAddress, c.usdcAddress, 4000, publicationBoundary, publicationBoundary);
    await expect(hub.publishExercisePrice(v.vaultId, 5000, publicationBoundary, now + 100n)).revertedWithCustomError(hub, "InvalidPrice");
    await expect(hub.publishExercisePrice(v.vaultId, 5000, now, now + 100n)).revertedWithCustomError(hub, "InvalidPrice");
    await expect(hub.publishExercisePrice(v.vaultId, 5000, now + 1n, now)).revertedWithCustomError(hub, "BidExpired");
    await expect(hub.publishExpiry(v.vaultId, 5000, now)).revertedWithCustomError(hub, "BidExpired");
    await expect(hub.settlementPrice(v.vaultId)).revertedWithCustomError(hub, "ReportUnavailable");
    await at(c, v.bid.expiry);
    await expect(hub.publishExpiry(v.vaultId, 3000, v.bid.expiry))
      .emit(hub, "ExpiryPublished").withArgs(v.vaultId, c.wethAddress, c.usdcAddress, v.bid.expiry, 3000, v.bid.expiry);
    await expect(hub.publishExpiry(v.vaultId, 4000, v.bid.expiry + 100n)).revertedWithCustomError(hub, "ReportFinalized");
  });

  it("retains completed early payments after publisher rotation", async function () {
    const c = await deployIvy(await network.create());
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    let now = BigInt(await c.networkHelpers.time.latest());
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "InvalidPrice");
    now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.publishExercisePrice(v.vaultId, 4000n * U, now, now + 100n);
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await c.hub.revokeRole(role, c.admin.address);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 4n);
    await c.hub.grantRole(role, c.carol.address);
    now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.connect(c.carol).publishExercisePrice(v.vaultId, 6000n * U, now, now + 100n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 2n);
    expect(await c.weth.balanceOf(c.marketMaker.address)).equal(3n * W / 4n);
    expect(await c.hub.remainingNotional(v.vaultId)).equal(8n * W);
  });

  it("rejects unknown, unactivated, physical and finalized vault publication", async function () {
    const c = await deployIvy(await network.create());
    const now = BigInt(await c.networkHelpers.time.latest());
    for (const vaultId of [0n, 999n]) {
      await expect(c.hub.publishExercisePrice(vaultId, 4000, now, now + 1000n)).revertedWithCustomError(c.hub, "UnknownVault");
      await expect(c.hub.publishExpiry(vaultId, 4000, now + 1000n)).revertedWithCustomError(c.hub, "UnknownVault");
      await expect(c.hub.exercisePrice(vaultId)).revertedWithCustomError(c.hub, "UnknownVault");
      await expect(c.hub.settlementPrice(vaultId)).revertedWithCustomError(c.hub, "UnknownVault");
    }
    const opened = await createVaultAs(c, c.alice, callTerms(c, { allowedSettlement: SettlementType.Cash, maxSettlementPriceAge: 3600 }), callPairs(c));
    const auction = await openVault(c, { withFeed: true });
    const physical = await goLive(c);
    for (const v of [opened, auction, physical]) {
      const error = v === physical ? "SettlementNotAllowed" : "WrongPhase";
      await expect(c.hub.publishExercisePrice(v.vaultId, 4000, now, now + 1000n)).revertedWithCustomError(c.hub, error);
      await expect(c.hub.publishExpiry(v.vaultId, 4000, now + 1000n)).revertedWithCustomError(c.hub, error);
    }
    const cash = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const latest = BigInt(await c.networkHelpers.time.latest());
    await c.hub.publishExercisePrice(cash.vaultId, 6000n * U, latest, latest + 100n);
    await c.hub.connect(c.marketMaker).exercise(cash.vaultId, 10n * W);
    await expect(c.hub.publishExercisePrice(cash.vaultId, 4000, latest + 1n, latest + 100n)).revertedWithCustomError(c.hub, "WrongPhase");
    await expect(c.hub.publishExpiry(cash.vaultId, 4000, latest + 100n)).revertedWithCustomError(c.hub, "WrongPhase");
  });

  it("switches from a still-valid American observation to the exact expiry report at the expiry second", async function () {
    const c = await deployIvy(await network.create());
    const v = await goLive(c, { terms: { allowedSettlement: SettlementType.Cash, maxSettlementPriceAge: 3600 } }, { settlement: SettlementType.Cash });
    await at(c, v.bid.expiry - 2n);
    await c.hub.publishExercisePrice(v.vaultId, 4000n * U, v.bid.expiry - 2n, v.bid.expiry + 100n);
    await at(c, v.bid.expiry - 1n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 4n);
    await at(c, v.bid.expiry);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "ReportUnavailable");
    expect(await c.hub.remainingNotional(v.vaultId)).equal(9n * W);
    await c.hub.publishExpiry(v.vaultId, 6000n * U, v.bid.expiry + 100n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 2n);
    await c.hub.expire(v.vaultId);
    expect(await v.vault.buyerReserved(c.wethAddress)).equal(4n * W);
  });
});
