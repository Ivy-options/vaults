import { expect } from "chai";
import { network } from "hardhat";
import { Interface } from "ethers";
import { ExerciseStyle, SettlementType, Phase, WETH_UNIT as W, USDC_UNIT as U, deployIvy, fund, callTerms, callPairs, createVaultAs } from "./helpers/setup.js";
import { at, goLive, setExercisePrice, publishExpiryPrice } from "./helpers/scenarios.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const fixture = () => deployIvy(connection);

describe("exercise policy and expiration", function () {
  for (const allowPartialExercise of [false, true]) {
    for (const style of [ExerciseStyle.American, ExerciseStyle.European]) {
      for (const settlement of [SettlementType.Physical, SettlementType.Cash]) {
        for (const isCall of [false, true]) {
          it(`enforces partial=${allowPartialExercise}, style=${style}, settlement=${settlement}, call=${isCall}`, async function () {
            const c = await networkHelpers.loadFixture(fixture);
            const v = await goLive(c, { isCall, withFeed: settlement === SettlementType.Cash, terms: { allowPartialExercise } }, { style, settlement });
            expect((await c.hub.termsOf(v.vaultId)).allowPartialExercise).eq(allowPartialExercise);
            if (settlement === SettlementType.Physical) await fund(c, isCall ? c.usdc : c.weth, c.marketMaker, v.vaultAddress, isCall ? 30_000n * U : 10n * W);
            else {
              const price = (isCall ? 3300n : 2700n) * U;
              await setExercisePrice(c, v.vaultId, price);
              if (style === ExerciseStyle.European) await publishExpiryPrice(c, v.vaultId, price);
            }
            if (style === ExerciseStyle.European && settlement === SettlementType.Physical) await at(c, v.bid.expiry);
            if (!allowPartialExercise) {
              await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, 4n * W)).revertedWithCustomError(c.hub, "PartialExerciseNotAllowed");
              expect(await c.hub.remainingNotional(v.vaultId)).eq(10n * W);
            } else {
              await c.hub.connect(c.marketMaker).exercise(v.vaultId, 4n * W);
              expect(await c.hub.remainingNotional(v.vaultId)).eq(6n * W);
              expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Live);
            }
            await c.hub.connect(c.marketMaker).exercise(v.vaultId, allowPartialExercise ? 6n * W : 10n * W);
            expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Settled);
            await expect(c.hub.expire(v.vaultId)).revertedWithCustomError(c.hub, "WrongPhase");
          });
        }
      }
    }
  }

  for (const allowPartialExercise of [false, true]) it(`keeps partial policy ${allowPartialExercise} and exposes no tightening`, async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await createVaultAs(c, c.alice, callTerms(c, { allowPartialExercise }), callPairs(c));
    expect((await c.hub.termsOf(v.vaultId)).allowPartialExercise).eq(allowPartialExercise);
    expect(new Interface(c.hub.interface.fragments).getFunction("tightenVaultTerms")).eq(null);
    expect(new Interface(c.hub.interface.fragments).getFunction("settle(uint256)")).eq(null);
  });

  for (const style of [ExerciseStyle.American, ExerciseStyle.European]) it(`cash style ${style}: expiry exercise pays only chosen units, expiration reserves the rest`, async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { isCall: false, withFeed: true }, { style, settlement: SettlementType.Cash, executor: c.bob.address, recipient: c.carol.address });
    // Spot would produce no payout; the exact historical expiry report pays 300 USDC per ETH.
    await setExercisePrice(c, v.vaultId, 3300n * U);
    await publishExpiryPrice(c, v.vaultId, 2700n * U);
    await expect(c.hub.connect(c.bob).exercise(v.vaultId, 4n * W)).changeTokenBalances(ethers, c.usdc, [c.carol, v.vaultAddress], [1200n * U, -1200n * U]);
    await expect(c.hub.connect(c.alice).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "NotExecutor");
    await c.hub.connect(c.alice).expire(v.vaultId);
    expect((await c.hub.stateOf(v.vaultId)).pendingPayout).eq(1800n * U);
    await c.hub.connect(c.alice).claim(v.vaultId, 30_000n * U);
    expect(await v.vault.buyerReserved(c.usdcAddress)).eq(1800n * U);
    await expect(c.hub.connect(c.bob).claimPayout(v.vaultId)).changeTokenBalances(ethers, c.usdc, [c.carol, v.vaultAddress], [1800n * U, -1800n * U]);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, W)).revertedWithCustomError(c.hub, "WrongPhase");
    await expect(c.hub.connect(c.bob).claimPayout(v.vaultId)).revertedWithCustomError(c.hub, "NothingToClaim");
  });

  it("full-only out-of-money cash stays live before expiry and permissionlessly expires with no payout", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true, terms: { allowPartialExercise: false } }, { settlement: SettlementType.Cash });
    await setExercisePrice(c, v.vaultId, 2900n * U);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, 10n * W)).revertedWithCustomError(c.hub, "NothingToExercise");
    await expect(c.hub.expire(v.vaultId)).revertedWithCustomError(c.hub, "ExpirationNotReached");
    await publishExpiryPrice(c, v.vaultId, 2900n * U);
    await c.hub.connect(c.carol).expire(v.vaultId);
    expect((await c.hub.stateOf(v.vaultId)).pendingPayout).eq(0n);
    await c.hub.connect(c.alice).claim(v.vaultId, 10n * W);
  });
  it("a blocked cash recipient cannot stop expiration or erase their payout", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { withFeed: true, terms: { allowPartialExercise: false } }, { style: ExerciseStyle.European, settlement: SettlementType.Cash, recipient: c.carol.address });
    await publishExpiryPrice(c, v.vaultId, 3300n * U);
    await c.weth.setBlockedRecipient(c.carol.address, true);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, 10n * W)).revertedWithCustomError(c.weth, "RecipientBlocked");
    expect(await c.hub.remainingNotional(v.vaultId)).eq(10n * W);
    await c.hub.connect(c.bob).expire(v.vaultId);
    const payout = 10n * W * 300n / 3300n;
    expect(await v.vault.buyerReserved(c.wethAddress)).eq(payout);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).revertedWithCustomError(c.weth, "RecipientBlocked");
    await c.hub.connect(c.alice).claim(v.vaultId, 10n * W);
    await c.hub.connect(c.marketMaker).setExecution(v.vaultId, c.bob.address, c.bob.address);
    await expect(c.hub.connect(c.bob).claimPayout(v.vaultId)).changeTokenBalances(ethers, c.weth, [c.bob, v.vaultAddress], [payout, -payout]);
  });

});
