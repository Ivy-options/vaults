import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { deployIvy, fund, WETH_UNIT as W, USDC_UNIT as U, Phase, SettlementType, ExerciseStyle, type IvyContext } from "./helpers/setup.js";
import { goLive, openVault, makeBid, activate, at, publishExpiryPrice } from "./helpers/scenarios.js";
import { signBid } from "./helpers/bids.js";

const connection = await network.create();
const { networkHelpers } = connection;
const unwindTypes = { UnwindAgreement: [
  {name:"vaultId",type:"uint256"},{name:"nonce",type:"uint256"},{name:"deadline",type:"uint64"},
  {name:"exercisedNotional",type:"uint256"},{name:"supply",type:"uint256"},{name:"refund",type:"uint256"},
] };
async function propose(c: IvyContext, id: bigint, refund = 100n * U) {
  const deadline = BigInt(await c.networkHelpers.time.latest()) + 86400n;
  await c.hub.connect(c.alice).proposeUnwind(id,deadline,refund);
  const a = await c.unwind.agreements(id);
  const agreement = {vaultId:a.vaultId,nonce:a.nonce,deadline:a.deadline,exercisedNotional:a.exercisedNotional,supply:a.supply,refund:a.refund};
  const signature = await c.marketMaker.signTypedData({name:"IvyUnwind",version:"1",chainId:(await c.marketMaker.provider!.getNetwork()).chainId,verifyingContract:await c.unwind.getAddress()},unwindTypes,agreement);
  return {agreement,signature};
}

describe("activation premium and unanimous unwinds", function () {
  const fixture = async () => { const c = await deployIvy(connection); await c.hub.setTransfersEnabled(true); return c; };
  it("allows unanimous cash unwind after the last publisher leaves without requiring a price report", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c, { terms: { allowedSettlement: SettlementType.Cash, maxSettlementPriceAge: 3600 } }, { settlement: SettlementType.Cash });
    await c.hub.setCashSettlementEnabled(false);
    await c.hub.revokeRole(await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), c.admin.address);
    const { agreement, signature } = await propose(c, v.vaultId);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId, agreement.nonce);
    await fund(c, c.usdc, c.alice, v.vaultAddress, agreement.refund);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId, agreement.nonce, agreement.refund);
    await c.hub.connect(c.carol).executeUnwind(v.vaultId, agreement.nonce, signature);
    await c.hub.connect(c.alice).claim(v.vaultId, 10n * W);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers, c.usdc, c.marketMaker, 100n * U);
    expect(await c.hub.cashSettlementEnabled()).equal(false);
    expect((await c.hub.stateOf(v.vaultId)).phase).equal(Phase.Settled);
  });
  it("moves unclaimed income with shares and preserves it after burning", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{deposit:6n*W,extraDeposits:[{signer:c.bob,amount:4n*W}]});
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.carol.address,v.vaultId,6n*W,"0x");
    expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(0n);
    expect(await c.premiums.claimable(v.vaultId,c.carol.address)).eq(600n*U);
    await c.hub.connect(c.carol).claimPremium(v.vaultId);
    await expect(c.hub.connect(c.alice).claimPremium(v.vaultId)).revertedWithCustomError(c.premiums,"NothingToClaim");
    await at(c,v.bid.expiry+3600n); await c.hub.expire(v.vaultId);
    await c.hub.connect(c.bob).claim(v.vaultId,4n*W);
    expect(await c.premiums.claimable(v.vaultId,c.bob.address)).eq(400n*U);
    await c.hub.connect(c.carol).claim(v.vaultId,6n*W);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(400n*U);
    await c.hub.connect(c.bob).claimPremium(v.vaultId);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
  });
  it("checkpoints duplicate-id batch transfers once and keeps floor dust reserved", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{deposit:1n,extraDeposits:[{signer:c.bob,amount:2n}]},{premium:W});
    // Three smallest collateral units, three premium units. Change to a nondivisible premium below in a second vault.
    await c.shares.connect(c.bob).safeBatchTransferFrom(c.bob.address,c.carol.address,[v.vaultId,v.vaultId],[1n,1n],"0x");
    expect(await c.premiums.claimable(v.vaultId,c.bob.address)).eq(0n);
    expect(await c.premiums.claimable(v.vaultId,c.carol.address)).eq(2n);
    const d = await goLive(c,{deposit:1n,extraDeposits:[{signer:c.bob,amount:2n}]},{premium:W/2n});
    expect((await c.premiums.pools(d.vaultId)).amount).eq(1n);
    await at(c,d.bid.expiry+3600n); await c.hub.expire(d.vaultId);
    await c.hub.connect(c.alice).claim(d.vaultId,1n); await c.hub.connect(c.bob).claim(d.vaultId,2n);
    expect(await d.vault.reserved(c.usdcAddress)).eq(1n);
    expect(await c.usdc.balanceOf(d.vaultAddress)).eq(1n);
  });
  it("rejects unapproved, stale and unfunded unwind; preserves premium and funds a pull refund", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{isCall:false,deposit:18_000n*U,extraDeposits:[{signer:c.bob,amount:12_000n*U}]});
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    const {agreement:a,signature} = await propose(c,v.vaultId);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce);
    await expect(c.hub.connect(c.carol).executeUnwind(v.vaultId,a.nonce,signature)).revertedWithCustomError(c.unwind,"ConsentMissing");
    await c.hub.connect(c.bob).approveUnwind(v.vaultId,a.nonce);
    await expect(c.hub.connect(c.carol).executeUnwind(v.vaultId,a.nonce,signature)).revertedWithCustomError(c.unwind,"FundingMissing");
    expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Live);
    for (const [holder, amount] of [[c.alice,60n*U],[c.bob,40n*U]] as const) {
      await fund(c,c.usdc,holder,v.vaultAddress,amount);
      await c.hub.connect(holder).fundUnwind(v.vaultId,a.nonce,amount);
    }
    await c.hub.connect(c.carol).executeUnwind(v.vaultId,a.nonce,signature);
    expect(await v.vault.reserved(c.usdcAddress)).eq(400n*U+a.refund);
    await c.hub.connect(c.alice).claim(v.vaultId,18_000n*U);
    await c.hub.connect(c.bob).claim(v.vaultId,12_000n*U);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(400n*U+a.refund);
    await c.hub.connect(c.marketMaker).claimPayout(v.vaultId);
    await c.hub.connect(c.bob).claimPremium(v.vaultId);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,signature)).revertedWithCustomError(c.hub,"WrongPhase");
  });
  it("invalidates sender and receiver approvals on real transfers, but not zero or self transfers", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{deposit:6n*W,extraDeposits:[{signer:c.bob,amount:4n*W}]});
    const {agreement:a,signature} = await propose(c,v.vaultId,0n);
    for(const s of [c.alice,c.bob]) await c.hub.connect(s).approveUnwind(v.vaultId,a.nonce);
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.alice.address,v.vaultId,W,"0x");
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.bob.address,v.vaultId,0,"0x");
    expect(await c.unwind.approvedShares(v.vaultId)).eq(10n*W);
    await c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address,c.bob.address,[v.vaultId,v.vaultId],[W,W],"0x");
    expect(await c.unwind.approvedShares(v.vaultId)).eq(0n);
    await expect(c.hub.executeUnwind(v.vaultId,a.nonce,signature)).revertedWithCustomError(c.unwind,"ConsentMissing");
    for(const s of [c.alice,c.bob]) await c.hub.connect(s).approveUnwind(v.vaultId,a.nonce);
    await c.hub.connect(c.bob).revokeUnwind(v.vaultId);
    expect(await c.unwind.approvedShares(v.vaultId)).eq(4n*W);
    const newer = await propose(c,v.vaultId,0n);
    expect(newer.agreement.nonce).eq(a.nonce+1n);
    expect(await c.unwind.approvedShares(v.vaultId)).eq(0n);
    await expect(c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce)).revertedWithCustomError(c.unwind,"AgreementInvalid");
  });
  it("partial exercise invalidates the signed snapshot; replacement preserves executed assets", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c);
    const old = await propose(c,v.vaultId,0n);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,old.agreement.nonce);
    await c.hub.connect(c.marketMaker).exercise(v.vaultId,W);
    await expect(c.hub.executeUnwind(v.vaultId,old.agreement.nonce,old.signature)).revertedWithCustomError(c.unwind,"AgreementInvalid");
    const n = await propose(c,v.vaultId,0n);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,n.agreement.nonce);
    await c.hub.executeUnwind(v.vaultId,n.agreement.nonce,n.signature);
    await c.hub.connect(c.alice).claim(v.vaultId,10n*W);
    expect(await c.usdc.balanceOf(c.alice.address)).eq(3000n*U);
    expect(await c.weth.balanceOf(c.alice.address)).eq(9n*W);
  });
  it("only the owner or buyer proposes; bad signatures and expired agreements cannot unwind", async function () {
    const c = await networkHelpers.loadFixture(fixture); const v = await goLive(c);
    await expect(c.hub.connect(c.bob).proposeUnwind(v.vaultId,v.bid.expiry,0)).revertedWithCustomError(c.hub,"NotVaultOwner");
    const a = await propose(c,v.vaultId,0n);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.agreement.nonce);
    await expect(c.hub.executeUnwind(v.vaultId,a.agreement.nonce,"0x")).revertedWithCustomError(c.unwind,"BadSignature");
    await networkHelpers.time.increaseTo(a.agreement.deadline+1n);
    await expect(c.hub.executeUnwind(v.vaultId,a.agreement.nonce,a.signature)).revertedWithCustomError(c.unwind,"AgreementInvalid");
  });
});

describe("admission and delegated execution", function () {
  const fixture = async () => { const c = await deployIvy(connection); await c.hub.setTransfersEnabled(true); return c; };
  it("paused auctions cancel immediately and live options and premium claims remain usable", async function () {
    const c = await networkHelpers.loadFixture(fixture); const v = await goLive(c); const o = await openVault(c);
    await expect(c.hub.connect(c.bob).setAdmissionPause(0,true)).revertedWithCustomError(c.hub,"AccessControlUnauthorizedAccount");
    await c.hub.setAdmissionPause(0,true);
    await expect(activate(c,o.vaultId,o.vaultAddress)).revertedWithCustomError(c.hub,"AdmissionPaused");
    await c.hub.connect(c.alice).cancelAuction(o.vaultId);
    await c.hub.connect(c.alice).withdraw(o.vaultId,10n*W);
    await expect(c.hub.connect(c.alice).deposit(o.vaultId,1)).revertedWithCustomError(c.hub,"AdmissionPaused");
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await c.hub.connect(c.marketMaker).exercise(v.vaultId,10n*W);
    await c.hub.connect(c.alice).claim(v.vaultId,10n*W);
  });
  it("delegates fund exercise, cannot redirect, and lose access after revocation", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{}, {executor:c.bob.address,recipient:c.carol.address});
    await expect(c.hub.connect(c.bob).exercise(v.vaultId,W)).revertedWithCustomError(c.usdc,"ERC20InsufficientAllowance");
    await fund(c,c.usdc,c.bob,v.vaultAddress,3000n*U);
    await c.hub.connect(c.bob).exercise(v.vaultId,W);
    expect(await c.weth.balanceOf(c.carol.address)).eq(W);
    expect(await c.weth.balanceOf(c.bob.address)).eq(0n);
    await expect(c.hub.connect(c.bob).setExecution(v.vaultId,c.bob.address,c.bob.address)).revertedWithCustomError(c.hub,"NotMarketMaker");
    await c.hub.connect(c.marketMaker).setExecution(v.vaultId,ZeroAddress,c.marketMaker.address);
    await expect(c.hub.connect(c.bob).exercise(v.vaultId,W)).revertedWithCustomError(c.hub,"NotExecutor");
  });
  it("binds the collateral, pair and auction identity, even after unchanged reopening", async function () {
    const c = await networkHelpers.loadFixture(fixture); const o = await openVault(c);
    const b = await makeBid(c,o.vaultId);
    await fund(c,c.usdc,c.marketMaker,o.vaultAddress,10000n*U);
    for(const bad of [{...b,collateralAmount:b.collateralAmount+1n},{...b,pairHash:"0x"+"00".repeat(32)}]) {
      await expect(c.hub.connect(c.bidMaster).activate(o.vaultId,bad,await signBid(c.marketMaker,c.hubAddress,bad))).revertedWithCustomError(c.hub,"CommitmentMismatch");
    }
    await c.hub.connect(c.bidMaster).cancelAuction(o.vaultId); await c.hub.connect(c.alice).openAuction(o.vaultId);
    await expect(c.hub.connect(c.bidMaster).activate(o.vaultId,b,await signBid(c.marketMaker,c.hubAddress,b))).revertedWithCustomError(c.hub,"CommitmentMismatch");
  });
  it("expired auctions cancel immediately but cannot reopen", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const expiry = BigInt(await networkHelpers.time.latest())+100n;
    const v = await openVault(c,{terms:{expiry}});
    await networkHelpers.time.increaseTo(expiry);
    await c.hub.connect(c.alice).cancelAuction(v.vaultId);
    await expect(c.hub.connect(c.alice).openAuction(v.vaultId)).revertedWithCustomError(c.hub,"ExpiryInPast");
    await c.hub.connect(c.alice).withdraw(v.vaultId,10n*W);
  });
  it("premium plus buyer payout reserves coexist in put collateral", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c,{isCall:false,withFeed:true},{settlement:SettlementType.Cash,style:ExerciseStyle.European});
    await publishExpiryPrice(c, v.vaultId, 2700n*U); await c.hub.expire(v.vaultId);
    expect(await v.vault.reserved(c.usdcAddress)).eq(4000n*U);
    await c.hub.connect(c.alice).claim(v.vaultId,30000n*U);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(4000n*U);
    await c.hub.connect(c.marketMaker).claimPayout(v.vaultId);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
  });
});
