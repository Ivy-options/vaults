import { expect } from "chai";
import { network } from "hardhat";
import { deployIvy, fund, WETH_UNIT as W, USDC_UNIT as U } from "./helpers/setup.js";
import { goLive, at } from "./helpers/scenarios.js";
import { UNWIND_TYPES } from "../scripts/operator.mjs";
const connection = await network.create();
const { networkHelpers } = connection;
async function fixture() { const c = await deployIvy(connection); await c.hub.setTransfersEnabled(true); return c; }
async function proposal(c: Awaited<ReturnType<typeof fixture>>, id: bigint, refund: bigint) {
  await c.hub.connect(c.alice).proposeUnwind(id, BigInt(await networkHelpers.time.latest()) + 86400n, refund);
  const a = await c.unwind.agreements(id);
  const value = {vaultId:id,nonce:a.nonce,deadline:a.deadline,exercisedNotional:a.exercisedNotional,supply:a.supply,refund:a.refund};
  const signature = await c.marketMaker.signTypedData({name:"IvyUnwind",version:"1",chainId:(await c.marketMaker.provider!.getNetwork()).chainId,verifyingContract:await c.unwind.getAddress()},UNWIND_TYPES,value);
  return { ...value, signature };
}
describe("LP-funded unwind", function () {
  it("requires each current LP to fund their share even after claiming premium", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, {deposit:6n*W, extraDeposits:[{signer:c.bob,amount:4n*W}]});
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    const a = await proposal(c,v.vaultId,100n*U);
    for(const lp of [c.alice,c.bob]) await c.hub.connect(lp).approveUnwind(v.vaultId,a.nonce);
    await fund(c,c.usdc,c.alice,v.vaultAddress,100n*U);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,100n*U);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,a.signature)).revertedWithCustomError(c.unwind,"FundingMissing");
    await fund(c,c.usdc,c.bob,v.vaultAddress,40n*U);
    await c.hub.connect(c.bob).fundUnwind(v.vaultId,a.nonce,40n*U);
    await c.hub.connect(c.carol).executeUnwind(v.vaultId,a.nonce,a.signature);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers,c.usdc,c.marketMaker,100n*U);
    await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,a.nonce)).changeTokenBalance(c.ethers,c.usdc,c.alice,40n*U);
  });
  for (const invalidate of ["revoke", "replace", "deadline", "exercise", "settle"] as const) {
    it(`returns individually reserved funds after ${invalidate}, even after burning all shares`, async function () {
      const c = await networkHelpers.loadFixture(fixture);
      const v = await goLive(c, {isCall:false, deposit:30000n*U});
      const a = await proposal(c,v.vaultId,100n*U);
      await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce);
      await fund(c,c.usdc,c.alice,v.vaultAddress,100n*U);
      await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,100n*U);
      if(invalidate === "revoke") await c.hub.connect(c.alice).revokeUnwind(v.vaultId);
      if(invalidate === "replace") await proposal(c,v.vaultId,100n*U);
      if(invalidate === "deadline") await at(c,a.deadline+1n);
      if(invalidate === "exercise") { await fund(c,c.weth,c.marketMaker,v.vaultAddress,W); await c.hub.connect(c.marketMaker).exercise(v.vaultId,W); }
      if(invalidate === "settle") {
        await at(c,v.bid.expiry+3600n); await c.hub.expire(v.vaultId);
        await c.hub.connect(c.alice).claim(v.vaultId,30000n*U);
        await c.hub.connect(c.alice).claimPremium(v.vaultId);
        expect(await c.usdc.balanceOf(v.vaultAddress)).eq(100n*U);
      }
      await expect(c.hub.executeUnwind(v.vaultId,a.nonce,a.signature)).revert(c.ethers);
      await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,a.nonce)).changeTokenBalance(c.ethers,c.usdc,c.alice,100n*U);
      await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,a.nonce)).revertedWithCustomError(c.unwind,"NothingToClaim");
      expect(await v.vault.unwindReserved()).eq(0n);
    });
  }
  it("requires the new owner to fund and preserves the former holder's entire contribution", async function () {
    const c = await networkHelpers.loadFixture(fixture), v = await goLive(c);
    const a = await proposal(c,v.vaultId,100n*U);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce);
    await fund(c,c.usdc,c.alice,v.vaultAddress,100n*U);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,100n*U);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.bob.address,v.vaultId,10n*W,"0x");
    await c.hub.connect(c.bob).approveUnwind(v.vaultId,a.nonce);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,a.signature)).revertedWithCustomError(c.unwind,"FundingMissing");
    await fund(c,c.usdc,c.bob,v.vaultAddress,100n*U);
    await c.hub.connect(c.bob).fundUnwind(v.vaultId,a.nonce,100n*U);
    await c.hub.executeUnwind(v.vaultId,a.nonce,a.signature);
    await c.hub.connect(c.bob).claim(v.vaultId,10n*W);
    await c.hub.connect(c.marketMaker).claimPayout(v.vaultId);
    await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,a.nonce)).changeTokenBalance(c.ethers,c.usdc,c.alice,100n*U);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
  });
  it("recovers ceiling surplus without changing the signed refund, even after transfers and burns", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{deposit:1n,extraDeposits:[{signer:c.bob,amount:1n},{signer:c.carol,amount:1n}]},{premium:0n});
    const a = await proposal(c,v.vaultId,2n);
    for(const holder of [c.alice,c.bob,c.carol]) {
      expect(await c.unwind.requiredContribution(v.vaultId,1n)).eq(1n);
      await fund(c,c.usdc,holder,v.vaultAddress,1n);
      await c.hub.connect(holder).fundUnwind(v.vaultId,a.nonce,1n);
      await c.hub.connect(holder).approveUnwind(v.vaultId,a.nonce);
    }
    await c.hub.executeUnwind(v.vaultId,a.nonce,a.signature);
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.bob.address,v.vaultId,1n,"0x");
    await c.hub.connect(c.bob).claim(v.vaultId,2n); await c.hub.connect(c.carol).claim(v.vaultId,1n);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers,c.usdc,c.marketMaker,2n);
    await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,a.nonce);
    await c.hub.connect(c.bob).withdrawUnwindContribution(v.vaultId,a.nonce);
    await expect(c.hub.connect(c.carol).withdrawUnwindContribution(v.vaultId,a.nonce)).changeTokenBalance(c.ethers,c.usdc,c.carol,1n);
    expect(await v.vault.unwindReserved()).eq(0n);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
  });
  it("recovers deposits for zero-refund agreements and allows withdrawing active funding to revoke consent", async function () {
    const c = await networkHelpers.loadFixture(fixture), v = await goLive(c);
    const a = await proposal(c,v.vaultId,0n);
    await fund(c,c.usdc,c.alice,v.vaultAddress,10n*U);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,10n*U);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce);
    await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,a.nonce);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,a.signature)).revertedWithCustomError(c.unwind,"ConsentMissing");
    await c.usdc.connect(c.alice).approve(v.vaultAddress,10n*U);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,10n*U);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce);
    await c.hub.executeUnwind(v.vaultId,a.nonce,a.signature);
    await c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,a.nonce);
    expect(await v.vault.unwindReserved()).eq(0n);
  });

  it("keeps replacement funding separate and recalculates eligibility after partial transfers and topups", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{deposit:6n*W,extraDeposits:[{signer:c.bob,amount:4n*W}]});
    const old = await proposal(c,v.vaultId,100n*U);
    await fund(c,c.usdc,c.alice,v.vaultAddress,160n*U);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,old.nonce,60n*U);
    const a = await proposal(c,v.vaultId,100n*U);
    for(const holder of [c.alice,c.bob]) await c.hub.connect(holder).approveUnwind(v.vaultId,a.nonce);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,a.signature)).revertedWithCustomError(c.unwind,"FundingMissing");
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,60n*U);
    await fund(c,c.usdc,c.bob,v.vaultAddress,40n*U);
    await c.hub.connect(c.bob).fundUnwind(v.vaultId,a.nonce,40n*U);
    await c.shares.connect(c.bob).safeTransferFrom(c.bob.address,c.alice.address,v.vaultId,2n*W,"0x");
    for(const holder of [c.alice,c.bob]) await c.hub.connect(holder).approveUnwind(v.vaultId,a.nonce);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,a.signature)).revertedWithCustomError(c.unwind,"FundingMissing");
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,10n*U);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,a.signature)).revertedWithCustomError(c.unwind,"FundingMissing");
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,10n*U);
    await c.hub.executeUnwind(v.vaultId,a.nonce,a.signature);
    await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId,old.nonce)).changeTokenBalance(c.ethers,c.usdc,c.alice,60n*U);
    await expect(c.hub.connect(c.bob).withdrawUnwindContribution(v.vaultId,a.nonce)).changeTokenBalance(c.ethers,c.usdc,c.bob,20n*U);
    expect(await v.vault.unwindReserved()).eq(0n);
  });

});
