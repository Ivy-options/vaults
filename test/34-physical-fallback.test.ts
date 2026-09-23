import { expect } from "chai";
import { network } from "hardhat";
import {
  EXERCISE_WINDOW, AUCTION_TIMEOUT, ExerciseStyle, SettlementPolicy, SettlementType, Phase,
  WETH_UNIT as W, USDC_UNIT as U, callTerms, callPairs, createVaultAs, deployIvy, fund,
} from "./helpers/setup.js";
import { at, goLive, publishExpiryPrice, setExercisePrice } from "./helpers/scenarios.js";
import { proposeUnwind } from "./helpers/unwind.js";

const connection = await network.create();
const { networkHelpers } = connection;
const P = 3600n;
const Route = { Physical: 0, Cash: 1, AwaitingExpiryPrice: 2, PhysicalFallback: 3, FallbackExpired: 4, Inactive: 5 };

describe("cash settlement physical fallback", function () {
  const fixture = () => deployIvy(connection);

  it("fixes publication and physical windows before participation and rejects unusable cash timings", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const terms = callTerms(c, { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 3600 });
    const first = await createVaultAs(c, c.alice, terms, callPairs(c));
    await c.hub.setSettings(20n, AUCTION_TIMEOUT, 10n);
    const second = await createVaultAs(c, c.alice, terms, callPairs(c));
    expect((await c.hub.stateOf(first.vaultId)).exerciseWindow).eq(EXERCISE_WINDOW);
    expect((await c.hub.stateOf(first.vaultId)).expiryPricePublicationWindow).eq(P);
    expect((await c.hub.stateOf(second.vaultId)).expiryPricePublicationWindow).eq(10n);
    expect((await c.hub.stateOf(second.vaultId)).exerciseWindow).eq(20n);
    await expect(c.hub.setSettings(20n, AUCTION_TIMEOUT, 0n)).revertedWithCustomError(c.hub, "InvalidSettlementWindow");
    await c.hub.setSettings(0n, AUCTION_TIMEOUT, P);
    for (const allowedSettlement of [SettlementPolicy.Cash, SettlementPolicy.Either]) {
      await expect(c.hub.createVault({ ...terms, allowedSettlement }, callPairs(c)))
        .revertedWithCustomError(c.hub, "InvalidSettlementWindow");
    }
    await c.hub.createVault(callTerms(c), callPairs(c));
  });

  it("lets an unrelated caller release LP collateral after an entirely unattended publisher outage", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    await at(c, v.bid.expiry + P + EXERCISE_WINDOW + 86400n);
    await expect(c.hub.connect(c.carol).expire(v.vaultId))
      .emit(c.hub, "Settled").withArgs(v.vaultId, 0n, 10n * W, 0n);
    expect(await v.vault.buyerReserved(c.wethAddress)).eq(0n);
    await expect(c.hub.connect(c.alice).claim(v.vaultId, 10n * W))
      .changeTokenBalance(c.ethers, c.weth, c.alice, 10n * W);
    expect(await c.hub.totalShares(v.vaultId)).eq(0n);
  });

  it("opens explicit physical call exercise at the fixed deadline and closes late publication", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const deadline = v.bid.expiry + P;
    await at(c, deadline - 1n);
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W))
      .revertedWithCustomError(c.hub, "PhysicalFallbackUnavailable");
    await at(c, deadline);
    const tx = c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W);
    await expect(tx).emit(c.hub, "PhysicalFallbackExercised").withArgs(v.vaultId, W, 3000n * U, W);
    await expect(tx).changeTokenBalance(c.ethers, c.weth, c.marketMaker, W);
    await expect(tx).changeTokenBalance(c.ethers, c.usdc, c.marketMaker, -3000n * U);
    expect((await c.hub.stateOf(v.vaultId)).settlement).eq(SettlementType.Cash);
    await expect(c.hub.publishExpiry(v.vaultId, 6000n * U, deadline + 100n))
      .revertedWithCustomError(c.hub, "ExpiryPricePublicationClosed");
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W))
      .revertedWithCustomError(c.hub, "ReportUnavailable");
    expect(await c.hub.remainingNotional(v.vaultId)).eq(9n * W);
  });

  it("reports effective routes and fixed deadlines without a fallback activation transaction", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const d = v.bid.expiry + P;
    const f = d + EXERCISE_WINDOW;
    expect(await c.hub.settlementStatus(v.vaultId)).deep.eq([BigInt(Route.Cash), d, f, false]);
    expect(await c.hub.expirationTimeOf(v.vaultId)).eq(f);
    for (const [time, route, canExpire] of [
      [v.bid.expiry, Route.AwaitingExpiryPrice, false],
      [d - 1n, Route.AwaitingExpiryPrice, false],
      [d, Route.PhysicalFallback, false],
      [f - 1n, Route.PhysicalFallback, false],
      [f, Route.FallbackExpired, true],
    ] as const) {
      await networkHelpers.time.increaseTo(time);
      expect(await c.hub.settlementStatus(v.vaultId)).deep.eq([BigInt(route), d, f, canExpire]);
    }
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback.staticCall(v.vaultId, W))
      .revertedWithCustomError(c.hub, "ExerciseWindowClosed");
    await expect(c.hub.expire(v.vaultId)).emit(c.hub, "PhysicalFallbackExpired").withArgs(v.vaultId, 10n * W);
    expect((await c.hub.settlementStatus(v.vaultId)).route).eq(Route.Inactive);
    await expect(c.hub.settlementStatus(999)).revertedWithCustomError(c.hub, "UnknownVault");
  });

  for (const style of [ExerciseStyle.American, ExerciseStyle.European]) {
    for (const isCall of [true, false]) {
      const label = `${style === ExerciseStyle.American ? "American" : "European"} ${isCall ? "call" : "put"}`;

      it(`${label}: partial exercise at F - 1 and permissionless lapse at F preserve LP proceeds`, async function () {
        const c = await networkHelpers.loadFixture(fixture);
        const v = await goLive(c, { isCall, withFeed: true }, { settlement: SettlementType.Cash, style });
        const f = v.bid.expiry + P + EXERCISE_WINDOW;
        if (!isCall) await fund(c, c.weth, c.marketMaker, v.vaultAddress, 4n * W);
        await at(c, f - 1n);
        const tx = c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, 4n * W);
        await expect(tx).emit(c.hub, "PhysicalFallbackExercised")
          .withArgs(v.vaultId, 4n * W, isCall ? 12000n * U : 4n * W, isCall ? 4n * W : 12000n * U);
        await expect(tx).changeTokenBalance(c.ethers, isCall ? c.weth : c.usdc, c.marketMaker, isCall ? 4n * W : 12000n * U);
        await at(c, f);
        await expect(c.hub.connect(c.carol).expire(v.vaultId))
          .emit(c.hub, "PhysicalFallbackExpired").withArgs(v.vaultId, 6n * W)
          .and.emit(c.hub, "Settled").withArgs(v.vaultId, 4n * W, 10n * W, 0n);
        const claim = c.hub.connect(c.alice).claim(v.vaultId, isCall ? 10n * W : 30000n * U);
        await expect(claim).changeTokenBalance(c.ethers, c.weth, c.alice, isCall ? 6n * W : 4n * W);
        await expect(claim).changeTokenBalance(c.ethers, c.usdc, c.alice, isCall ? 12000n * U : 18000n * U);
        expect(await c.usdc.balanceOf(v.vaultAddress)).eq(1000n * U);
        await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).revertedWithCustomError(c.hub, "NothingToClaim");
      });

      for (const inTheMoney of [true, false]) {
        it(`${label}: a timely ${inTheMoney ? "ITM" : "OTM"} final price stays authoritative after F`, async function () {
          const c = await networkHelpers.loadFixture(fixture);
          const v = await goLive(c, { isCall, withFeed: true }, { settlement: SettlementType.Cash, style });
          const d = v.bid.expiry + P;
          const f = d + EXERCISE_WINDOW;
          const price = isCall === inTheMoney ? 6000n * U : 1500n * U;
          await at(c, d - 1n);
          await c.hub.publishExpiry(v.vaultId, price, d - 1n);
          await networkHelpers.time.increaseTo(f + 86400n);
          expect(await c.hub.expirationTimeOf(v.vaultId)).eq(v.bid.expiry);
          expect(await c.hub.settlementStatus(v.vaultId)).deep.eq([BigInt(Route.Cash), d, f, true]);
          await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W))
            .revertedWithCustomError(c.hub, "PhysicalFallbackUnavailable");
          const payout = inTheMoney ? (isCall ? 5n * W : 15000n * U) : 0n;
          await expect(c.hub.expire(v.vaultId)).emit(c.hub, "Settled").withArgs(v.vaultId, 10n * W, 10n * W, payout);
          expect(await v.vault.buyerReserved(isCall ? c.wethAddress : c.usdcAddress)).eq(payout);
        });
      }
    }
  }

  it("rejects final publication at D even when publication is the first interaction", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const d = v.bid.expiry + P;
    await at(c, d);
    await expect(c.hub.publishExpiry(v.vaultId, 6000n * U, d + 100n))
      .revertedWithCustomError(c.hub, "ExpiryPricePublicationClosed");
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W))
      .emit(c.hub, "PhysicalFallbackExercised");
    await expect(c.hub.settlementPrice(v.vaultId)).revertedWithCustomError(c.hub, "ReportUnavailable");
  });

  for (const publishFirst of [true, false]) {
    it(`publication and fallback mined together at D are exclusive, ${publishFirst ? "publication" : "fallback"} first`, async function () {
      const c = await networkHelpers.loadFixture(fixture);
      const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
      const d = v.bid.expiry + P;
      await c.ethers.provider.send("evm_setAutomine", [false]);
      try {
        const publish = () => c.hub.publishExpiry(v.vaultId, 6000n * U, d + 100n, { gasLimit: 500000 });
        const exercise = () => c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W, { gasLimit: 500000 });
        const first = await (publishFirst ? publish() : exercise());
        const second = await (publishFirst ? exercise() : publish());
        await at(c, d);
        await c.ethers.provider.send("evm_mine", []);
        const [a, b] = await Promise.all([
          c.ethers.provider.getTransactionReceipt(first.hash),
          c.ethers.provider.getTransactionReceipt(second.hash),
        ]);
        expect([a!.status, b!.status]).deep.eq(publishFirst ? [0, 1] : [1, 0]);
        expect(a!.blockNumber).eq(b!.blockNumber);
        expect((await c.ethers.provider.getBlock(a!.blockNumber))!.timestamp).eq(Number(d));
        expect(await c.hub.remainingNotional(v.vaultId)).eq(9n * W);
        await expect(c.hub.settlementPrice(v.vaultId)).revertedWithCustomError(c.hub, "ReportUnavailable");
      } finally {
        await c.ethers.provider.send("evm_setAutomine", [true]);
      }
    });
  }

  it("never enables early fallback for missing or stale American observations or early European exercise", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const american = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    await expect(c.hub.connect(c.marketMaker).exercise(american.vaultId, W)).revertedWithCustomError(c.hub, "InvalidPrice");
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(american.vaultId, W))
      .revertedWithCustomError(c.hub, "PhysicalFallbackUnavailable");
    await setExercisePrice(c, american.vaultId, 6000n * U, 4000n);
    await expect(c.hub.connect(c.marketMaker).exercise(american.vaultId, W)).revertedWithCustomError(c.hub, "StalePrice");
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(american.vaultId, W))
      .revertedWithCustomError(c.hub, "PhysicalFallbackUnavailable");
    const european = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await expect(c.hub.connect(c.marketMaker).exercise(european.vaultId, W)).revertedWithCustomError(c.hub, "ExerciseNotOpenYet");
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(european.vaultId, W))
      .revertedWithCustomError(c.hub, "PhysicalFallbackUnavailable");
    await at(c, american.bid.expiry);
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(american.vaultId, W))
      .revertedWithCustomError(c.hub, "PhysicalFallbackUnavailable");
    await expect(c.hub.expire(american.vaultId)).revertedWithCustomError(c.hub, "ExpirationNotReached");
  });

  it("uses only the remainder after American cash exercise and finalizes immediately on full fallback", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    await setExercisePrice(c, v.vaultId, 6000n * U);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, 4n * W))
      .changeTokenBalance(c.ethers, c.weth, c.marketMaker, 2n * W);
    await at(c, v.bid.expiry + P);
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, 7n * W))
      .revertedWithCustomError(c.hub, "ExceedsRemaining").withArgs(6n * W);
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, 6n * W))
      .emit(c.hub, "Settled").withArgs(v.vaultId, 10n * W, 10n * W, 0n);
    const claim = c.hub.connect(c.alice).claim(v.vaultId, 10n * W);
    await expect(claim).changeTokenBalance(c.ethers, c.weth, c.alice, 2n * W);
    await expect(claim).changeTokenBalance(c.ethers, c.usdc, c.alice, 18000n * U);
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W)).revertedWithCustomError(c.hub, "WrongPhase");
    await expect(c.hub.expire(v.vaultId)).revertedWithCustomError(c.hub, "WrongPhase");
  });

  it("honors all-or-nothing exercise and existing executor and recipient authorization", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { isCall: false, withFeed: true, terms: { allowPartialExercise: false } }, { settlement: SettlementType.Cash });
    await c.hub.connect(c.marketMaker).setExecution(v.vaultId, c.bob.address, c.carol.address);
    await fund(c, c.weth, c.bob, v.vaultAddress, 10n * W);
    await at(c, v.bid.expiry + P);
    await expect(c.hub.connect(c.alice).exercisePhysicalFallback(v.vaultId, 10n * W)).revertedWithCustomError(c.hub, "NotExecutor");
    await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, W)).revertedWithCustomError(c.hub, "PartialExerciseNotAllowed");
    await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, 0)).revertedWithCustomError(c.hub, "ZeroAmount");
    const tx = c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, 10n * W);
    await expect(tx).changeTokenBalance(c.ethers, c.weth, c.bob, -10n * W);
    await expect(tx).changeTokenBalance(c.ethers, c.usdc, c.carol, 30000n * U);
    expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Settled);
  });

  it("keeps windows and settlement available through paused admissions, settings changes and publisher removal", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const d = v.bid.expiry + P;
    const f = d + EXERCISE_WINDOW;
    await c.hub.setAdmissionPause(0, true);
    await c.hub.setAdmissionPause(v.vaultId, true);
    await c.hub.setCashSettlementEnabled(false);
    await c.hub.setSettings(0, 1, 1);
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await c.hub.revokeRole(role, c.admin.address);
    await c.hub.grantRole(role, c.bob.address);
    await at(c, d);
    await expect(c.hub.connect(c.bob).publishExpiry(v.vaultId, 6000n * U, f))
      .revertedWithCustomError(c.hub, "ExpiryPricePublicationClosed");
    await c.hub.connect(c.bob).publishExercisePrice(v.vaultId, 6000n * U, v.bid.expiry, f);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "ReportUnavailable");
    await c.hub.revokeRole(role, c.bob.address);
    expect((await c.hub.settlementStatus(v.vaultId)).fallbackDeadline).eq(f);
    await c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W);
    await at(c, f);
    await c.hub.connect(c.carol).expire(v.vaultId);
    await expect(c.hub.connect(c.alice).claim(v.vaultId, 10n * W)).changeTokenBalance(c.ethers, c.weth, c.alice, 9n * W);
  });

  for (const isCall of [true, false]) {
    it(`${isCall ? "call" : "put"}: failed physical transfers preserve funds, notional and reserves atomically`, async function () {
      const c = await networkHelpers.loadFixture(fixture);
      const v = await goLive(c, { isCall, withFeed: true }, {
        settlement: SettlementType.Cash, executor: c.bob.address, recipient: c.carol.address,
      });
      const payment = isCall ? c.usdc : c.weth;
      const collateral = isCall ? c.weth : c.usdc;
      const needed = isCall ? 3000n * U : W;
      await at(c, v.bid.expiry + P);
      await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, W))
        .revertedWithCustomError(payment, "ERC20InsufficientAllowance");
      await payment.connect(c.bob).approve(v.vaultAddress, needed);
      await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, W))
        .revertedWithCustomError(payment, "ERC20InsufficientBalance");
      await payment.mint(c.bob.address, needed);
      await collateral.setBlockedRecipient(c.carol.address, true);
      await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, W))
        .revertedWithCustomError(collateral, "RecipientBlocked");
      expect(await payment.balanceOf(c.bob.address)).eq(needed);
      expect(await payment.allowance(c.bob.address, v.vaultAddress)).eq(needed);
      await collateral.setBlockedRecipient(c.carol.address, false);
      await payment.setFeeBps(1000);
      await expect(c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, W))
        .revertedWithCustomError(c.hub, "ShortReceived").withArgs(needed, needed * 9n / 10n);
      expect(await payment.balanceOf(c.bob.address)).eq(needed);
      expect(await c.hub.remainingNotional(v.vaultId)).eq(10n * W);
      expect((await c.hub.stateOf(v.vaultId)).pendingPayout).eq(0n);
      expect(await v.vault.buyerReserved(isCall ? c.wethAddress : c.usdcAddress)).eq(0n);
      await payment.setFeeBps(0);
      await c.hub.connect(c.bob).exercisePhysicalFallback(v.vaultId, W);
      expect(await c.hub.remainingNotional(v.vaultId)).eq(9n * W);
    });

    it(`${isCall ? "call" : "put"}: preserves strike rounding across 18-decimal underlying and 6-decimal quote`, async function () {
      const c = await networkHelpers.loadFixture(fixture);
      const v = await goLive(c, { isCall, withFeed: true }, { settlement: SettlementType.Cash });
      // 333,333,334 wei at 3,000 USDC per WETH is 1.000000002 quote units: call pays 2, put receives 1.
      if (!isCall) await fund(c, c.weth, c.marketMaker, v.vaultAddress, 333333334n);
      await at(c, v.bid.expiry + P);
      await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, 333333334n))
        .emit(c.hub, "PhysicalFallbackExercised").withArgs(v.vaultId, 333333334n, isCall ? 2n : 333333334n, isCall ? 333333334n : 1n);
    });

    it(`${isCall ? "call" : "put"}: mixed LP claims exclude premiums, fees and recoverable unwind contributions`, async function () {
      const c = await networkHelpers.loadFixture(fixture);
      await c.hub.setPlatformFeeBps(200);
      const aliceShares = isCall ? 6n * W : 18000n * U;
      const bobShares = isCall ? 4n * W : 12000n * U;
      const v = await goLive(c, { isCall, withFeed: true, deposit: aliceShares, extraDeposits: [{ signer: c.bob, amount: bobShares }] }, { settlement: SettlementType.Cash });
      const f = v.bid.expiry + P + EXERCISE_WINDOW;
      const { agreement } = await proposeUnwind(c, v.vaultId, f + 1000n, 100n * U);
      await fund(c, c.usdc, c.alice, v.vaultAddress, 60n * U);
      await c.hub.connect(c.alice).fundUnwind(v.vaultId, agreement.nonce, 60n * U);
      if (!isCall) await fund(c, c.weth, c.marketMaker, v.vaultAddress, 4n * W);
      await at(c, v.bid.expiry + P);
      await c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, 4n * W);
      await at(c, f);
      await c.hub.connect(c.carol).expire(v.vaultId);
      const aliceClaim = c.hub.connect(c.alice).claim(v.vaultId, aliceShares);
      await expect(aliceClaim).changeTokenBalance(c.ethers, c.usdc, c.alice, isCall ? 7200n * U : 10800n * U);
      await expect(aliceClaim).changeTokenBalance(c.ethers, c.weth, c.alice, isCall ? 3600000000000000000n : 2400000000000000000n);
      await c.hub.connect(c.bob).claim(v.vaultId, bobShares);
      expect(await c.usdc.balanceOf(v.vaultAddress)).eq(1060n * U);
      expect(await c.weth.balanceOf(v.vaultAddress)).eq(0n);
      expect(await v.vault.buyerReserved(c.usdcAddress)).eq(0n);
      await expect(c.hub.connect(c.alice).claimPremium(v.vaultId)).changeTokenBalance(c.ethers, c.usdc, c.alice, 588n * U);
      await expect(c.hub.connect(c.bob).claimPremium(v.vaultId)).changeTokenBalance(c.ethers, c.usdc, c.bob, 392n * U);
      await expect(v.vault.claimPlatformFee()).changeTokenBalance(c.ethers, c.usdc, c.admin, 20n * U);
      await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, agreement.nonce))
        .changeTokenBalance(c.ethers, c.usdc, c.alice, 60n * U);
      expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
      await expect(c.hub.connect(c.alice).claim(v.vaultId, aliceShares)).revertedWithCustomError(c.hub, "InsufficientShares");
    });
  }

  it("delivers a full fallback payout and finalizes before notifying the chosen recipient", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const receiver = await c.ethers.deployContract("PayoutReceiver", [c.hubAddress]);
    const receiverAddress = await receiver.getAddress();
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, recipient: receiverAddress });
    await at(c, v.bid.expiry + P);
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, 10n * W))
      .emit(c.hub, "PayoutNotified").withArgs(v.vaultId, receiverAddress, c.wethAddress, 10n * W, true);
    expect(await receiver.phaseSeen()).eq(Phase.Settled);
    expect(await receiver.balanceSeen()).eq(10n * W);
    expect(await receiver.calls()).eq(1n);
  });

  it("finalizes at F without calling an unresponsive recipient", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const receiver = await c.ethers.deployContract("PayoutReceiver", [c.hubAddress]);
    await receiver.setMode(4);
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash, recipient: await receiver.getAddress() });
    await at(c, v.bid.expiry + P + EXERCISE_WINDOW);
    await expect(c.hub.connect(c.carol).expire(v.vaultId, { gasLimit: 300000 })).not.emit(c.hub, "PayoutNotified");
    expect(await receiver.calls()).eq(0n);
    await expect(c.hub.connect(c.alice).claim(v.vaultId, 10n * W)).changeTokenBalance(c.ethers, c.weth, c.alice, 10n * W);
  });

  for (const finalization of ["cash exercise", "unwind"] as const) {
    it(`cannot revive a position finalized by ${finalization}`, async function () {
      const c = await networkHelpers.loadFixture(fixture);
      const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
      if (finalization === "cash exercise") {
        await setExercisePrice(c, v.vaultId, 6000n * U);
        await c.hub.connect(c.marketMaker).exercise(v.vaultId, 10n * W);
      } else {
        const { agreement, signature } = await proposeUnwind(c, v.vaultId, v.bid.expiry, 0n);
        await c.hub.connect(c.alice).approveUnwind(v.vaultId, agreement.nonce);
        await c.hub.executeUnwind(v.vaultId, agreement.nonce, signature);
      }
      await networkHelpers.time.increaseTo(v.bid.expiry + P);
      expect((await c.hub.settlementStatus(v.vaultId)).route).eq(Route.Inactive);
      await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W)).revertedWithCustomError(c.hub, "WrongPhase");
      await expect(c.hub.expire(v.vaultId)).revertedWithCustomError(c.hub, "WrongPhase");
      await c.hub.connect(c.alice).claim(v.vaultId, 10n * W);
      await expect(c.hub.connect(c.alice).claim(v.vaultId, 10n * W)).revertedWithCustomError(c.hub, "InsufficientShares");
    });
  }

  it("retains original physical timing and rejects the cash-specific fallback entrypoint", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c);
    expect(await c.hub.expirationTimeOf(v.vaultId)).eq(v.bid.expiry + EXERCISE_WINDOW);
    await networkHelpers.time.increaseTo(v.bid.expiry);
    expect((await c.hub.settlementStatus(v.vaultId)).route).eq(Route.Physical);
    await expect(c.hub.connect(c.marketMaker).exercisePhysicalFallback(v.vaultId, W))
      .revertedWithCustomError(c.hub, "PhysicalFallbackUnavailable");
    await c.hub.connect(c.marketMaker).exercise(v.vaultId, W);
    await at(c, v.bid.expiry + EXERCISE_WINDOW);
    await c.hub.expire(v.vaultId);
  });
});
