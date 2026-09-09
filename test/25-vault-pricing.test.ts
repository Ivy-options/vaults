import { expect } from "chai";
import { network } from "hardhat";
import { deployIvy, SettlementType, WETH_UNIT as W, USDC_UNIT as U } from "./helpers/setup.js";
import { goLive, at } from "./helpers/scenarios.js";

describe("Explicit cash feature flag", function () {
  it("requires an explicit administrator toggle independently of publisher membership", async function () {
    const c = await deployIvy(await network.create(), { enableCashSettlement: false });
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await c.hub.grantRole(role, c.bob.address);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
    await expect(c.hub.connect(c.bob).setCashSettlementEnabled(true)).revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount");
    await expect(c.hub.setCashSettlementEnabled(true)).emit(c.hub, "CashSettlementEnabledUpdated").withArgs(true);
    await c.hub.revokeRole(role, c.bob.address);
    expect(await c.hub.cashSettlementEnabled()).equal(true);
    await c.hub.grantRole(role, c.carol.address);
    await c.hub.connect(c.carol).renounceRole(role, c.carol.address);
    expect(await c.hub.cashSettlementEnabled()).equal(true);
    await expect(c.hub.setCashSettlementEnabled(false)).emit(c.hub, "CashSettlementEnabledUpdated").withArgs(false);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
  });
});

describe("Per-vault settlement prices", function () {
  it("isolates exercise and final prices for matching vaults with separate publication transactions", async function () {
    const c = await deployIvy(await network.create(), { enableCashSettlement: false });
    await c.hub.grantRole(await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), c.admin.address);
    // The explicit flag is configured separately from the publisher role.
    await c.hub.setCashSettlementEnabled(true);
    const terms = { allowedSettlement: SettlementType.Cash, maxSettlementPriceAge: 3600, expiry: c.defaultExpiry };
    const first = await goLive(c, { terms }, { settlement: SettlementType.Cash });
    const second = await goLive(c, { terms }, { settlement: SettlementType.Cash });
    const now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.publishExercisePrice(first.vaultId, 4000n * U, now, now + 100n);
    expect(await c.hub.exercisePrice(second.vaultId)).deep.equal([0n, 0n, 0n]);
    await expect(c.hub.connect(c.marketMaker).exercise(second.vaultId, W)).revertedWithCustomError(c.hub, "InvalidPrice");
    await c.hub.publishExercisePrice(second.vaultId, 6000n * U, now, now + 100n);
    await expect(c.hub.connect(c.marketMaker).exercise(first.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 4n);
    await expect(c.hub.connect(c.marketMaker).exercise(second.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 2n);
    await at(c, c.defaultExpiry);
    await c.hub.publishExpiry(first.vaultId, 6000n * U, c.defaultExpiry + 100n);
    await expect(c.hub.expire(second.vaultId)).revertedWithCustomError(c.hub, "ReportUnavailable");
    await c.hub.publishExpiry(second.vaultId, 4000n * U, c.defaultExpiry + 100n);
    await expect(c.hub.publishExpiry(first.vaultId, 7000n * U, c.defaultExpiry + 100n)).revertedWithCustomError(c.hub, "ReportFinalized");
    await c.hub.expire(first.vaultId);
    await c.hub.expire(second.vaultId);
    expect((await c.hub.stateOf(first.vaultId)).pendingPayout).equal(9n * W / 2n);
    expect((await c.hub.stateOf(second.vaultId)).pendingPayout).equal(9n * W / 4n);
    expect(await c.hub.settlementPrice(first.vaultId)).equal(6000n * U);
    expect(await c.hub.settlementPrice(second.vaultId)).equal(4000n * U);
  });
});
