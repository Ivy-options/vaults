import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { deployIvy, callTerms, callPairs, createVaultAs, fund, Phase, WETH_UNIT as W, USDC_UNIT as U } from "./helpers/setup.js";
import { signBid } from "./helpers/bids.js";
import { loadArtifacts, prepareOperation } from "../scripts/operator.mjs";
import { proposeUnwind } from "./helpers/unwind.js";
import { goLive, openVault, activate, makeBid, at } from "./helpers/scenarios.js";
const connection = await network.create();
const { networkHelpers } = connection;

describe("platform fees and transferable unpaid premium", function () {
  const fixture = () => deployIvy(connection);
  it("disables every transfer path initially while permitting deposits, claims and burns", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await goLive(c);
    expect(await c.hub.transfersEnabled()).eq(false);
    await expect(c.hub.connect(c.alice).setTransfersEnabled(true)).revertedWithCustomError(c.hub,"AccessControlUnauthorizedAccount");
    await c.shares.connect(c.alice).setApprovalForAll(c.bob.address,true);
    await expect(c.shares.connect(c.bob).safeTransferFrom(c.alice.address,c.carol.address,v.vaultId,W,"0x")).revertedWithCustomError(c.shares,"TransfersDisabled");
    await expect(c.shares.connect(c.alice).safeBatchTransferFrom(c.alice.address,c.bob.address,[v.vaultId],[W],"0x")).revertedWithCustomError(c.shares,"TransfersDisabled");
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await at(c,v.bid.expiry+3600n); await c.hub.expire(v.vaultId);
    await c.hub.connect(c.alice).claim(v.vaultId,10n*W);
    expect(await c.hub.totalShares(v.vaultId)).eq(0);
  });
  it("moves additive remaining credit proportionally, including after claims and partial burns", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setTransfersEnabled(true);
    const v = await goLive(c,{deposit:6n*W,extraDeposits:[{signer:c.bob,amount:4n*W}]});
    await c.hub.connect(c.bob).claimPremium(v.vaultId);
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.bob.address,v.vaultId,3n*W,"0x");
    expect(await c.premiums.claimable(v.vaultId,c.bob.address)).eq(300n*U);
    expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(300n*U);
    await c.shares.connect(c.bob).safeTransferFrom(c.bob.address,c.carol.address,v.vaultId,7n*W,"0x");
    expect(await c.premiums.claimable(v.vaultId,c.bob.address)).eq(0);
    expect(await c.premiums.claimable(v.vaultId,c.carol.address)).eq(300n*U);
    await at(c,v.bid.expiry+3600n);await c.hub.expire(v.vaultId);
    await c.hub.connect(c.alice).claim(v.vaultId,W);
    expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(300n*U);
    await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.carol.address,v.vaultId,2n*W,"0x");
    expect(await c.premiums.claimable(v.vaultId,c.carol.address)).eq(600n*U);
    await c.hub.connect(c.carol).claimPremium(v.vaultId);
    await expect(c.hub.connect(c.carol).claimPremium(v.vaultId)).revertedWithCustomError(c.premiums,"NothingToClaim");
  });
  it("authorizes the global rate and keeps the fee within the gross premium", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    expect(await c.hub.platformFeeBps()).eq(0);
    await expect(c.hub.connect(c.alice).setPlatformFeeBps(100)).revertedWithCustomError(c.hub,"AccessControlUnauthorizedAccount");
    await expect(c.hub.setPlatformFeeBps(10001)).revertedWithCustomError(c.hub,"InvalidPlatformFee");
    await expect(c.hub.setPlatformTreasury(ZeroAddress)).revertedWithCustomError(c.hub,"ZeroAddress");
  });
  for (const [creationRate, activationRate, feeUnits] of [[0,200,0],[200,500,20],[500,100,50],[500,0,50],[10000,0,1000],[0,10000,0]]) {
    it(`keeps the creation rate after the global rate changes from ${creationRate} to ${activationRate} bps`, async function () {
      const c = await networkHelpers.loadFixture(fixture);
      await c.hub.setPlatformFeeBps(creationRate);
      const v = await openVault(c);
      expect(await c.hub.vaultPlatformFeeBps(v.vaultId)).eq(creationRate);
      const bid = await makeBid(c,v.vaultId);
      const signature = await signBid(c.marketMaker,c.hubAddress,bid);
      const gross = 1000n*U, fee = BigInt(feeUnits)*U;
      await c.usdc.mint(c.marketMaker.address,gross);
      await c.usdc.connect(c.marketMaker).approve(v.vaultAddress,gross);
      await c.hub.setPlatformFeeBps(activationRate);
      await expect(c.hub.connect(c.bidMaster).activate(v.vaultId,bid,signature))
        .changeTokenBalances(connection.ethers,c.usdc,[c.marketMaker,v.vault],[-gross,gross]);
      const allocated = await c.hub.platformFees(v.vaultId);
      expect(allocated.rateBps).eq(creationRate);
      expect(await c.hub.vaultPlatformFeeBps(v.vaultId)).eq(creationRate);
      expect(allocated.amount).eq(fee);
      expect(await v.vault.platformFeeRemaining()).eq(fee);
      expect(await v.vault.premiumRemaining()).eq(gross-fee);
      expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(gross-fee);
      expect(await v.vault.reserved(c.usdcAddress)).eq(gross);
    });
  }
  it("fixes the rate before deposits and applies new defaults only to new vaults", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setPlatformFeeBps(200);
    const original = await createVaultAs(c,c.alice,callTerms(c),callPairs(c));
    expect(await c.hub.vaultPlatformFeeBps(original.vaultId)).eq(200);
    await c.hub.setPlatformFeeBps(500);
    const higher = await goLive(c);
    expect(await c.hub.vaultPlatformFeeBps(higher.vaultId)).eq(500);
    expect(await higher.vault.platformFeeRemaining()).eq(50n*U);
    await c.hub.setPlatformFeeBps(0);
    const free = await goLive(c);
    expect(await c.hub.vaultPlatformFeeBps(free.vaultId)).eq(0);
    expect(await free.vault.platformFeeRemaining()).eq(0);
    await fund(c,c.weth,c.alice,original.vaultAddress,10n*W);
    await c.hub.connect(c.alice).deposit(original.vaultId,10n*W);
    await c.hub.connect(c.alice).openAuction(original.vaultId);
    await activate(c,original.vaultId,original.vaultAddress);
    expect((await c.hub.platformFees(original.vaultId)).rateBps).eq(200);
    expect(await original.vault.platformFeeRemaining()).eq(20n*U);
    expect(await c.premiums.claimable(original.vaultId,c.alice.address)).eq(980n*U);
  });
  it("retains the creation rate through a cancelled and reopened auction", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setPlatformFeeBps(200);
    const v = await openVault(c);
    await c.hub.connect(c.bidMaster).cancelAuction(v.vaultId);
    await c.hub.setPlatformFeeBps(500);
    await c.hub.connect(c.alice).openAuction(v.vaultId);
    expect((await c.hub.stateOf(v.vaultId)).auctionId).eq(2);
    expect(await c.hub.vaultPlatformFeeBps(v.vaultId)).eq(200);
    await activate(c,v.vaultId,v.vaultAddress);
    expect(await v.vault.platformFeeRemaining()).eq(20n*U);
    expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(980n*U);
  });
  it("preflight reports a zero-strike put as the hub's EmptyNotional, not a local division error", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    const v = await openVault(c, { isCall: false });
    const bid = await makeBid(c, v.vaultId, { strike: 0n });
    const signature = await signBid(c.marketMaker, c.hubAddress, bid);
    const error: any = await prepareOperation(c.admin.provider, await loadArtifacts(), "inspect-bid", {
      sender: c.bidMaster.address, hub: c.hubAddress, vaultId: v.vaultId, bid, signature,
      minTradeUsdE6: 10000n * U, collateralPriceUsdE6: U,
    }).catch(e => e);
    expect(error).to.be.instanceOf(Error);
    expect(error.data).eq(c.hub.interface.getError("EmptyNotional")!.selector);
  });
  it("preflights and submits the fixed vault fee despite later global rate changes", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setPlatformFeeBps(200);
    const v = await openVault(c);
    const bid = await makeBid(c,v.vaultId);
    const signature = await signBid(c.marketMaker,c.hubAddress,bid);
    await c.usdc.mint(c.marketMaker.address,1000n*U);
    await c.usdc.connect(c.marketMaker).approve(v.vaultAddress,1000n*U);
    await c.hub.setPlatformFeeBps(500);
    await c.hub.setPlatformTreasury(c.carol.address);
    const prepared = await prepareOperation(c.admin.provider,await loadArtifacts(),"inspect-bid",{
      sender:c.bidMaster.address,hub:c.hubAddress,vaultId:v.vaultId,bid,signature,
      minTradeUsdE6:10000n*U,collateralPriceUsdE6:3000n*U,
    });
    expect(prepared.detail.platformFeeBps).eq(200n);
    expect(prepared.detail.platformFee).eq(20n*U);
    expect(prepared.detail.lpPremium).eq(980n*U);
    expect(await v.vault.premiumCollected()).eq(false);
    await c.hub.setPlatformFeeBps(0);
    await c.hub.setPlatformTreasury(c.bob.address);
    await c.bidMaster.sendTransaction({to:prepared.to,data:prepared.data});
    const allocated = await c.hub.platformFees(v.vaultId);
    expect(allocated.rateBps).eq(200);
    expect(allocated.recipient).eq(c.bob.address);
    expect(await v.vault.platformFeeRemaining()).eq(prepared.detail.platformFee);
    expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(prepared.detail.lpPremium);
  });
  it("segregates fees from overlapping collateral and net LP premium, and snapshots the recipient", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setPlatformFeeBps(200);
    await c.hub.setPlatformTreasury(c.carol.address);
    const v = await goLive(c,{isCall:false,deposit:30_000n*U});
    expect((await c.hub.platformFees(v.vaultId)).rateBps).eq(200);
    expect((await c.hub.platformFees(v.vaultId)).amount).eq(20n*U);
    expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(980n*U);
    await c.hub.setPlatformFeeBps(500);
    await c.hub.setPlatformTreasury(c.bob.address);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    expect(await v.vault.reserved(c.usdcAddress)).eq(20n*U);
    await at(c,v.bid.expiry+3600n);await c.hub.expire(v.vaultId);
    await c.hub.connect(c.alice).claim(v.vaultId,10_000n*U);
    await c.hub.connect(c.alice).claim(v.vaultId,20_000n*U);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(20n*U);
    await expect(v.vault.connect(c.bob).claimPlatformFee()).changeTokenBalances(connection.ethers,c.usdc,[c.carol],[20n*U]);
    await expect(v.vault.claimPlatformFee()).revertedWithCustomError(v.vault,"NothingToClaim");
    expect(await v.vault.reserved(c.usdcAddress)).eq(0);
  });
  it("rounds the fee down and permits the full-rate boundary", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setPlatformFeeBps(3333);
    const v = await goLive(c,{deposit:3n},{premium:W});
    expect(await v.vault.platformFeeRemaining()).eq(0);
    expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(3);
    await c.hub.setPlatformFeeBps(10000);
    const x = await goLive(c);
    expect(await c.premiums.claimable(x.vaultId,c.alice.address)).eq(0);
    expect(await x.vault.platformFeeRemaining()).eq(1000n*U);
    await x.vault.claimPlatformFee();
  });
  it("rolls back fee allocation, nonce and premium on short funding", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setPlatformFeeBps(200);
    const v = await openVault(c);
    const bid = await makeBid(c,v.vaultId);
    const signature = await signBid(c.marketMaker,c.hubAddress,bid);
    await c.usdc.mint(c.marketMaker.address,1000n*U);
    await c.usdc.connect(c.marketMaker).approve(v.vaultAddress,1000n*U);
    await c.hub.setPlatformFeeBps(500);
    await c.usdc.setFeeBps(100);
    await expect(c.hub.connect(c.bidMaster).activate(v.vaultId,bid,signature)).revertedWithCustomError(v.vault,"ShortReceived");
    expect(await c.hub.usedBidNonces(c.marketMaker.address,bid.nonce)).eq(false);
    expect(await v.vault.premiumCollected()).eq(false);
    expect((await c.hub.platformFees(v.vaultId)).amount).eq(0);
    expect((await c.premiums.pools(v.vaultId)).supply).eq(0);
    expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Auction);
    expect(await c.hub.vaultPlatformFeeBps(v.vaultId)).eq(200);
    await c.hub.setPlatformFeeBps(0);
    await c.usdc.setFeeBps(0);
    await c.hub.connect(c.bidMaster).activate(v.vaultId,bid,signature);
    expect(await v.vault.platformFeeRemaining()).eq(20n*U);
  });
  it("retains platform fees through separately funded unwind with buyer reserves", async function () {
    const c = await networkHelpers.loadFixture(fixture);
    await c.hub.setPlatformFeeBps(200);
    const v = await goLive(c,{isCall:false,deposit:30000n*U});
    const deadline = BigInt(await networkHelpers.time.latest())+86400n;
    const {agreement:a,signature} = await proposeUnwind(c,v.vaultId,deadline,100n*U);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce);
    await c.usdc.mint(c.alice.address,a.refund);await c.usdc.connect(c.alice).approve(v.vaultAddress,a.refund);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId,a.nonce,a.refund);
    await c.hub.connect(c.carol).executeUnwind(v.vaultId,a.nonce,signature);
    expect(await v.vault.reserved(c.usdcAddress)).eq(1100n*U);
    await c.hub.connect(c.alice).claim(v.vaultId,30000n*U);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await c.hub.connect(c.marketMaker).claimPayout(v.vaultId);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(20n*U);
    await v.vault.claimPlatformFee();
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0);
  });

});
