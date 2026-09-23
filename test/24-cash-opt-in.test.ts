import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import {
  deployIvy, callTerms, callPairs, createVaultAs, fund,
  SettlementPolicy, SettlementType, Phase, WETH_UNIT as W, USDC_UNIT as U,
} from "./helpers/setup.js";
import { goLive, openVault, activate, makeBid, setExercisePrice, publishExpiryPrice, at } from "./helpers/scenarios.js";
import { signBid } from "./helpers/bids.js";

const defaultDeployment = async () => deployIvy(await network.create(), { enableCashSettlement: false });

describe("Cash settlement opt-in", function () {
  it("deploys with cash disabled and no settlement publishers", async function () {
    const c = await defaultDeployment();
    expect(await c.hub.cashSettlementEnabled()).equal(false);
    expect(await c.hub.hasRole(await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), c.admin.address)).equal(false);
    const now = BigInt(await c.networkHelpers.time.latest());
    await expect(c.hub.publishExercisePrice(1n, 4000n * U, now, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount");
    for (const policy of [SettlementPolicy.Cash, SettlementPolicy.Either]) {
      await expect(c.hub.createVault(callTerms(c, { allowedSettlement: policy, maxSettlementPriceAge: 3600 }), callPairs(c), []))
        .revertedWithCustomError(c.hub, "CashSettlementDisabled");
    }
    expect(await c.hub.vaultCount()).equal(0);
  });

  it("keeps publisher-role administration guarded and disallows a zero-address publisher", async function () {
    const c = await defaultDeployment();
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await expect(c.hub.connect(c.bob).grantRole(role, c.bob.address)).revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount");
    await expect(c.hub.grantRole(role, ZeroAddress)).revertedWithCustomError(c.hub, "ZeroAddress");
    await c.hub.grantRole(role, c.bob.address);
    await c.hub.grantRole(role, c.bob.address);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
    await expect(c.hub.connect(c.carol).renounceRole(role, c.bob.address)).revertedWithCustomError(c.hub, "AccessControlBadConfirmation");
    await c.hub.revokeRole(role, c.bob.address);
    await c.hub.revokeRole(role, c.bob.address);
    expect(await c.hub.hasRole(role, c.bob.address)).equal(false);
  });

  it("explicitly enables cash with an EOA or authenticated helper available and preserves physical-only terms", async function () {
    const c = await defaultDeployment();
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    const physical = await createVaultAs(c, c.alice, callTerms(c), callPairs(c), []);
    await c.hub.grantRole(role, c.bob.address);
    await c.hub.setCashSettlementEnabled(true);
    for (const policy of [SettlementPolicy.Cash, SettlementPolicy.Either]) {
      await c.hub.createVault(callTerms(c, { allowedSettlement: policy, maxSettlementPriceAge: 3600 }), callPairs(c), []);
      await expect(c.hub.createVault(callTerms(c, { allowedSettlement: policy }), callPairs(c), []))
        .revertedWithCustomError(c.hub, "CashSettlementNeedsMaxPriceAge");
    }
    await c.hub.revokeRole(role, c.bob.address);
    expect(await c.hub.cashSettlementEnabled()).equal(true);
    const helper = await c.ethers.deployContract("ExampleSettlementPublisher", [c.hubAddress, c.bob.address]);
    await c.hub.grantRole(role, await helper.getAddress());
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const now = BigInt(await c.networkHelpers.time.latest());
    await expect(helper.connect(c.carol).publishExercisePrice(v.vaultId, 4000n * U, now, now + 100n))
      .revertedWithCustomError(helper, "OwnableUnauthorizedAccount");
    await helper.connect(c.bob).publishExercisePrice(v.vaultId, 4000n * U, now, now + 100n);
    await c.hub.setCashSettlementEnabled(false);
    await c.hub.revokeRole(role, await helper.getAddress());
    expect(await c.hub.cashSettlementEnabled()).equal(false);
    await expect(c.hub.createVault(callTerms(c, { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 3600 }), callPairs(c), []))
      .revertedWithCustomError(c.hub, "CashSettlementDisabled");
  });

  it("rejects pending cash bids while the feature flag is disabled without consuming the bid, and accepts them after re-enabling", async function () {
    const c = await deployIvy(await network.create());
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    const v = await openVault(c, { terms: { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 3600 } });
    const bid = await makeBid(c, v.vaultId, { settlement: SettlementType.Cash });
    await fund(c, c.usdc, c.marketMaker, v.vaultAddress, 1000n * U);
    const signature = await signBid(c.marketMaker, c.hubAddress, bid);
    await c.hub.setCashSettlementEnabled(false);
    await c.hub.revokeRole(role, c.admin.address);
    await expect(c.hub.connect(c.bidMaster).activate(v.vaultId, bid, signature)).revertedWithCustomError(c.hub, "CashSettlementDisabled");
    expect((await c.hub.stateOf(v.vaultId)).phase).equal(Phase.Auction);
    expect(await c.hub.usedBidNonces(c.marketMaker.address, bid.nonce)).equal(false);
    expect(await c.usdc.balanceOf(v.vaultAddress)).equal(0);
    await c.hub.grantRole(role, c.bob.address);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
    await c.hub.setCashSettlementEnabled(true);
    await c.hub.connect(c.bidMaster).activate(v.vaultId, bid, signature);
    expect((await c.hub.stateOf(v.vaultId)).phase).equal(Phase.Live);
  });

  it("still activates physical bids in existing Either auctions while the feature flag is disabled", async function () {
    const c = await deployIvy(await network.create());
    const v = await openVault(c, { terms: { allowedSettlement: SettlementPolicy.Either, maxSettlementPriceAge: 3600 } });
    await c.hub.setCashSettlementEnabled(false);
    await c.hub.revokeRole(await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), c.admin.address);
    await activate(c, v.vaultId, v.vaultAddress, { settlement: SettlementType.Physical });
    expect((await c.hub.stateOf(v.vaultId)).settlement).equal(SettlementType.Physical);
    expect((await c.hub.stateOf(v.vaultId)).phase).equal(Phase.Live);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
  });

  for (const isCall of [true, false]) {
    it(`completes the physical ${isCall ? "call" : "put"} lifecycle without any settlement publisher or indicative feed`, async function () {
      const c = await defaultDeployment();
      const v = await goLive(c, { isCall });
      expect(await c.hub.rulesOf(v.vaultId)).deep.equal([]);
      await fund(c, isCall ? c.usdc : c.weth, c.marketMaker, v.vaultAddress, isCall ? 30_000n * U : 10n * W);
      await c.hub.connect(c.marketMaker).exercise(v.vaultId, 10n * W);
      await expect(c.hub.connect(c.alice).claim(v.vaultId, isCall ? 10n * W : 30_000n * U))
        .changeTokenBalance(c.ethers, isCall ? c.usdc : c.weth, c.alice, isCall ? 30_000n * U : 10n * W);
      await expect(c.hub.connect(c.alice).claimPremium(v.vaultId)).changeTokenBalance(c.ethers, c.usdc, c.alice, 1000n * U);
      expect(await c.hub.cashSettlementEnabled()).equal(false);
    });
  }

  it("preserves live cash publication, exercise, finalization and claims while admissions are disabled", async function () {
    const c = await deployIvy(await network.create());
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    const v = await goLive(c, { terms: { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 3600 } }, { settlement: SettlementType.Cash });
    await c.hub.setCashSettlementEnabled(false);
    await setExercisePrice(c, v.vaultId, 4000n * U);
    await c.hub.revokeRole(role, c.admin.address);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 4n);
    await c.hub.grantRole(role, c.admin.address);
    await publishExpiryPrice(c, v.vaultId, 6000n * U);
    await c.hub.setCashSettlementEnabled(false);
    await c.hub.revokeRole(role, c.admin.address);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W / 2n);
    await c.hub.expire(v.vaultId);
    expect(await v.vault.buyerReserved(c.wethAddress)).equal(4n * W);
    await c.hub.connect(c.alice).claim(v.vaultId, 10n * W);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers, c.weth, c.marketMaker, 4n * W);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
  });

  it("keeps cash reports pending while disabled and recovers through regrant before the publication deadline", async function () {
    const c = await deployIvy(await network.create());
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await c.hub.setPlatformFeeBps(200);
    const v = await goLive(c, { isCall: false, terms: { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 3600 } }, { settlement: SettlementType.Cash });
    await c.hub.setCashSettlementEnabled(false);
    await c.hub.revokeRole(role, c.admin.address);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "InvalidPrice");
    await at(c, v.bid.expiry);
    await expect(c.hub.expire(v.vaultId)).revertedWithCustomError(c.hub, "ExpirationNotReached");
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "ReportUnavailable");
    await expect(c.hub.connect(c.alice).claim(v.vaultId, 30_000n * U)).revertedWithCustomError(c.hub, "WrongPhase");
    expect(await c.hub.remainingNotional(v.vaultId)).equal(10n * W);
    expect((await c.hub.stateOf(v.vaultId)).phase).equal(Phase.Live);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await v.vault.claimPlatformFee();
    expect(await c.usdc.balanceOf(v.vaultAddress)).equal(30_000n * U);
    await c.networkHelpers.time.increase(1000);
    await c.hub.grantRole(role, c.bob.address);
    const now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.connect(c.bob).publishExpiry(v.vaultId, 2700n * U, now + 100n);
    await c.hub.connect(c.bob).renounceRole(role, c.bob.address);
    await c.hub.expire(v.vaultId);
    await c.hub.connect(c.alice).claim(v.vaultId, 30_000n * U);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers, c.usdc, c.marketMaker, 3000n * U);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
  });
});
