import { expect } from "chai";
import { network } from "hardhat";
import {
  ExerciseStyle,
  Phase,
  SettlementType,
  USDC_UNIT as U,
  WETH_UNIT as W,
  deployIvy,
  fixture,
  fund,
} from "./helpers/setup.js";
import { goLive, publishExpiryPrice, setExercisePrice } from "./helpers/scenarios.js";
import { proposeUnwind } from "./helpers/unwind.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const Mode = { Acknowledge: 0, WrongMagic: 1, Revert: 2, Reenter: 3, BurnGas: 4 } as const;
const load = fixture(connection, async () => {
  const c = await deployIvy(connection);
  const receiver = await ethers.deployContract("PayoutReceiver", [c.hubAddress]);
  return { ...c, receiver, receiverAddress: await receiver.getAddress() };
});
type Ctx = Awaited<ReturnType<typeof load>>;

describe("payout callback", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await load();
  });
  const physicalCall = (c: Ctx) => goLive(c, {}, { recipient: c.receiverAddress });

  it("does not notify an externally owned recipient", async () => {
    const { vaultId, vaultAddress } = await goLive(c);
    await fund(c, c.usdc, c.marketMaker, vaultAddress, 12_000n * U);
    await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 4n * W)).to.not.emit(c.hub, "PayoutNotified");
  });

  it("notifies a contract recipient after the tokens arrive", async () => {
    const { vaultId, vaultAddress } = await physicalCall(c);
    await fund(c, c.usdc, c.marketMaker, vaultAddress, 12_000n * U);
    const tx = c.hub.connect(c.marketMaker).exercise(vaultId, 4n * W);
    await expect(tx)
      .to.emit(c.hub, "PayoutNotified")
      .withArgs(vaultId, c.receiverAddress, c.wethAddress, 4n * W, true);
    await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.receiverAddress, vaultAddress], [4n * W, -4n * W]);
    expect(await c.receiver.calls()).to.equal(1n);
    expect(await c.receiver.lastCaller()).to.equal(c.hubAddress);
    expect(await c.receiver.lastVaultId()).to.equal(vaultId);
    expect(await c.receiver.lastToken()).to.equal(c.wethAddress);
    expect(await c.receiver.lastAmount()).to.equal(4n * W);
    expect(await c.receiver.balanceSeen()).to.equal(4n * W);
    expect(await c.receiver.phaseSeen()).to.equal(Phase.Live);
  });

  it("runs after the vault is finalized on the last exercise", async () => {
    const { vaultId, vaultAddress } = await physicalCall(c);
    await fund(c, c.usdc, c.marketMaker, vaultAddress, 30_000n * U);
    const tx = c.hub.connect(c.marketMaker).exercise(vaultId, 10n * W);
    await expect(tx).to.emit(c.hub, "Settled");
    await expect(tx)
      .to.emit(c.hub, "PayoutNotified")
      .withArgs(vaultId, c.receiverAddress, c.wethAddress, 10n * W, true);
    expect(await c.receiver.phaseSeen()).to.equal(Phase.Settled);
  });

  it("notifies the recipient chosen later through setExecution", async () => {
    const { vaultId, vaultAddress } = await goLive(c);
    await c.hub.connect(c.marketMaker).setExecution(vaultId, c.bob.address, c.receiverAddress);
    await fund(c, c.usdc, c.bob, vaultAddress, 3_000n * U);
    await expect(c.hub.connect(c.bob).exercise(vaultId, W))
      .to.emit(c.hub, "PayoutNotified")
      .withArgs(vaultId, c.receiverAddress, c.wethAddress, W, true);
  });

  it("records an unacknowledged call when the recipient lacks the hook", async () => {
    const { vaultId, vaultAddress } = await goLive(c, {}, { recipient: c.usdcAddress });
    await fund(c, c.usdc, c.marketMaker, vaultAddress, 3_000n * U);
    const tx = c.hub.connect(c.marketMaker).exercise(vaultId, W);
    await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(vaultId, c.usdcAddress, c.wethAddress, W, false);
    await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.usdcAddress], [W]);
  });

  for (const [label, mode] of [
    ["reverts", Mode.Revert],
    ["returns the wrong magic value", Mode.WrongMagic],
  ] as const) {
    it(`still pays when the recipient ${label}`, async () => {
      const { vaultId, vaultAddress } = await physicalCall(c);
      await c.receiver.setMode(mode);
      await fund(c, c.usdc, c.marketMaker, vaultAddress, 3_000n * U);
      const tx = c.hub.connect(c.marketMaker).exercise(vaultId, W);
      await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(vaultId, c.receiverAddress, c.wethAddress, W, false);
      await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.receiverAddress], [W]);
      expect(await c.hub.remainingNotional(vaultId)).to.equal(9n * W);
    });
  }

  it("reverts when the hook runs out of gas so estimates stay honest", async () => {
    const { vaultId, vaultAddress } = await physicalCall(c);
    await fund(c, c.usdc, c.marketMaker, vaultAddress, 3_000n * U);
    await c.receiver.setMode(Mode.BurnGas);
    await expect(
      c.hub.connect(c.marketMaker).exercise(vaultId, W, { gasLimit: 1_000_000 }),
    ).to.be.revertedWithCustomError(c.hub, "PayoutHookOutOfGas");
    await c.receiver.setMode(Mode.Acknowledge);
    const estimate = await c.hub.connect(c.marketMaker).exercise.estimateGas(vaultId, W);
    await expect(c.hub.connect(c.marketMaker).exercise(vaultId, W, { gasLimit: estimate }))
      .to.emit(c.hub, "PayoutNotified")
      .withArgs(vaultId, c.receiverAddress, c.wethAddress, W, true);
  });

  it("notifies a cash exercise payout in the collateral token", async () => {
    const { vaultId } = await goLive(
      c,
      { withFeed: true },
      { settlement: SettlementType.Cash, recipient: c.receiverAddress },
    );
    await setExercisePrice(c, vaultId, 3300n * U);
    const payout = (10n * W * 300n) / 3300n;
    await expect(c.hub.connect(c.marketMaker).exercise(vaultId, 10n * W))
      .to.emit(c.hub, "PayoutNotified")
      .withArgs(vaultId, c.receiverAddress, c.wethAddress, payout, true);
    expect(await c.receiver.balanceSeen()).to.equal(payout);
    expect(await c.receiver.phaseSeen()).to.equal(Phase.Settled);
  });

  it("notifies a claimed cash payout", async () => {
    const { vaultId, bid } = await goLive(
      c,
      { withFeed: true },
      { settlement: SettlementType.Cash, style: ExerciseStyle.European, recipient: c.receiverAddress },
    );
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await publishExpiryPrice(c, vaultId, 3300n * U);
    await expect(c.hub.expire(vaultId)).to.not.emit(c.hub, "PayoutNotified");
    const payout = (10n * W * 300n) / 3300n;
    const tx = c.hub.connect(c.marketMaker).claimPayout(vaultId);
    await expect(tx).to.emit(c.hub, "PayoutClaimed").withArgs(vaultId, c.marketMaker.address, payout);
    await expect(tx).to.emit(c.hub, "PayoutNotified").withArgs(vaultId, c.receiverAddress, c.wethAddress, payout, true);
    await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.receiverAddress], [payout]);
    expect(await c.receiver.calls()).to.equal(1n);
    expect((await c.hub.stateOf(vaultId)).pendingPayout).to.equal(0n);
  });

  it("notifies an unwind refund in the premium token", async () => {
    await c.hub.setTransfersEnabled(true);
    const { vaultId, vaultAddress } = await physicalCall(c);
    const { agreement, signature } = await proposeUnwind(
      c,
      vaultId,
      BigInt(await networkHelpers.time.latest()) + 86400n,
      100n * U,
    );
    await c.hub.connect(c.alice).approveUnwind(vaultId, agreement.nonce);
    await fund(c, c.usdc, c.alice, vaultAddress, 100n * U);
    await c.hub.connect(c.alice).fundUnwind(vaultId, agreement.nonce, 100n * U);
    await c.hub.executeUnwind(vaultId, agreement.nonce, signature);
    const tx = c.hub.connect(c.marketMaker).claimPayout(vaultId);
    await expect(tx)
      .to.emit(c.hub, "PayoutNotified")
      .withArgs(vaultId, c.receiverAddress, c.usdcAddress, 100n * U, true);
    await expect(tx).to.changeTokenBalances(ethers, c.usdc, [c.receiverAddress], [100n * U]);
    expect(await c.receiver.calls()).to.equal(1n);
  });

  it("blocks reentry from the hook and still completes the claim", async () => {
    const { vaultId, bid } = await goLive(
      c,
      { withFeed: true },
      { settlement: SettlementType.Cash, style: ExerciseStyle.European, recipient: c.receiverAddress },
    );
    await c.receiver.setMode(Mode.Reenter);
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await publishExpiryPrice(c, vaultId, 3300n * U);
    await c.hub.expire(vaultId);
    const payout = (10n * W * 300n) / 3300n;
    const tx = c.hub.connect(c.marketMaker).claimPayout(vaultId);
    await expect(tx)
      .to.emit(c.hub, "PayoutNotified")
      .withArgs(vaultId, c.receiverAddress, c.wethAddress, payout, false);
    await expect(tx).to.changeTokenBalances(ethers, c.weth, [c.receiverAddress], [payout]);
    await expect(c.hub.connect(c.marketMaker).claimPayout(vaultId)).to.be.revertedWithCustomError(
      c.hub,
      "NothingToClaim",
    );
  });
});
