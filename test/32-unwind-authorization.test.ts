import { expect } from "chai";
import { network } from "hardhat";
import { TypedDataEncoder } from "ethers";
import { UNWIND_TYPES } from "../scripts/operator.mjs";
import { deployIvy, fund, WETH_UNIT as W, USDC_UNIT as U, Phase } from "./helpers/setup.js";
import { goLive } from "./helpers/scenarios.js";
import { proposeUnwind, signUnwindProposal } from "./helpers/unwind.js";

const connection = await network.create();
const { networkHelpers } = connection;
async function fixture() { const c = await deployIvy(connection); await c.hub.setTransfersEnabled(true); return c; }

describe("buyer-authenticated unwind proposals", function () {
  it("preserves an executable proposal when a non-shareholding owner attempts an unauthorized replacement", async function () {
    const c = await networkHelpers.loadFixture(fixture), v = await goLive(c);
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.bob.address, v.vaultId, 10n * W, "0x");
    const deadline = BigInt(await networkHelpers.time.latest()) + 1000n;
    const { agreement: a, signature } = await proposeUnwind(c, v.vaultId, deadline, 100n * U);
    await c.hub.connect(c.bob).approveUnwind(v.vaultId, a.nonce);
    await fund(c, c.usdc, c.bob, v.vaultAddress, a.refund);
    await c.hub.connect(c.bob).fundUnwind(v.vaultId, a.nonce, a.refund);
    await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, "0x")).revertedWithCustomError(c.unwind, "BadSignature");
    expect((await c.unwind.agreements(v.vaultId)).nonce).eq(1n);
    expect(await c.unwind.approvedShares(v.vaultId)).eq(10n * W);
    expect(await c.unwind.fundedShares(v.vaultId)).eq(10n * W);
    expect(await c.unwind.approvedRequired(v.vaultId)).eq(100n * U);
    expect(await c.unwind.contributions(v.vaultId, a.nonce, c.bob.address)).eq(100n * U);
    await c.hub.connect(c.carol).executeUnwind(v.vaultId, a.nonce, signature);
    expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Settled);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers, c.usdc, c.marketMaker, 100n * U);
  });
  it("binds every agreement field and EIP-712 domain before accepting either authorized caller", async function () {
    const c = await networkHelpers.loadFixture(fixture), v = await goLive(c);
    const deadline = BigInt(await networkHelpers.time.latest()) + 1000n;
    const p = await signUnwindProposal(c, v.vaultId, deadline, 0n);
    expect(p.digest).eq(TypedDataEncoder.hash(p.domain, UNWIND_TYPES, p.agreement));
    expect(p.agreement).deep.eq({ vaultId: v.vaultId, nonce: 1n, deadline, exercisedNotional: 0n, supply: 10n * W, refund: 0n });
    for (const caller of [c.alice, c.marketMaker]) {
      await expect(c.hub.connect(caller).proposeUnwind(v.vaultId, deadline, 0n, "0x")).revertedWithCustomError(c.unwind, "BadSignature");
      for (const [field, value] of Object.entries(p.agreement)) {
        const signature = await c.marketMaker.signTypedData(p.domain, UNWIND_TYPES, { ...p.agreement, [field]: value + 1n });
        await expect(c.hub.connect(caller).proposeUnwind(v.vaultId, deadline, 0n, signature)).revertedWithCustomError(c.unwind, "BadSignature");
      }
      for (const domain of [{ ...p.domain, chainId: p.domain.chainId + 1n }, { ...p.domain, verifyingContract: c.hubAddress }]) {
        const signature = await c.marketMaker.signTypedData(domain, UNWIND_TYPES, p.agreement);
        await expect(c.hub.connect(caller).proposeUnwind(v.vaultId, deadline, 0n, signature)).revertedWithCustomError(c.unwind, "BadSignature");
      }
    }
    const outsiderSignature = await c.bob.signTypedData(p.domain, UNWIND_TYPES, p.agreement);
    await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, outsiderSignature)).revertedWithCustomError(c.unwind, "BadSignature");
    await c.hub.connect(c.marketMaker).proposeUnwind(v.vaultId, deadline, 0n, p.signature);
    await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature)).revertedWithCustomError(c.unwind, "BadSignature");
    await c.hub.connect(c.alice).approveUnwind(v.vaultId, 1n);
    await c.hub.executeUnwind(v.vaultId, 1n, p.signature);
  });

  it("requires a new signature after an intervening partial exercise", async function () {
    const c = await networkHelpers.loadFixture(fixture), v = await goLive(c);
    const deadline = BigInt(await networkHelpers.time.latest()) + 1000n;
    const p = await signUnwindProposal(c, v.vaultId, deadline, 0n);
    await c.hub.connect(c.marketMaker).exercise(v.vaultId, W);
    await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature)).revertedWithCustomError(c.unwind, "BadSignature");
    const fresh = await proposeUnwind(c, v.vaultId, deadline, 0n);
    expect(fresh.agreement.exercisedNotional).eq(W);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId, fresh.agreement.nonce);
    await c.hub.executeUnwind(v.vaultId, fresh.agreement.nonce, fresh.signature);
  });

  it("rejects creation at its exact deadline but permits execution at the signed deadline", async function () {
    const c = await networkHelpers.loadFixture(fixture), v = await goLive(c);
    const deadline = BigInt(await networkHelpers.time.latest()) + 1000n;
    const p = await signUnwindProposal(c, v.vaultId, deadline, 0n);
    await networkHelpers.time.setNextBlockTimestamp(deadline);
    await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, 0n, p.signature)).revertedWithCustomError(c.unwind, "AgreementInvalid");
    const fresh = await proposeUnwind(c, v.vaultId, deadline + 1000n, 0n);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId, fresh.agreement.nonce);
    await networkHelpers.time.setNextBlockTimestamp(fresh.agreement.deadline);
    await c.hub.executeUnwind(v.vaultId, fresh.agreement.nonce, fresh.signature);
  });

  it("requires buyer authorization even when replacing an expired proposal", async function () {
    const c = await networkHelpers.loadFixture(fixture), v = await goLive(c);
    const deadline = BigInt(await networkHelpers.time.latest()) + 1000n;
    await proposeUnwind(c, v.vaultId, deadline, 0n);
    await networkHelpers.time.increaseTo(deadline + 1n);
    await expect(c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline + 1000n, 0n, "0x")).revertedWithCustomError(c.unwind, "BadSignature");
    const fresh = await proposeUnwind(c, v.vaultId, deadline + 1000n, 0n);
    expect(fresh.agreement.nonce).eq(2n);
  });
});
