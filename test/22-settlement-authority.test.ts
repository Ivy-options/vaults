import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";

describe("Authoritative settlement feed", function () {
  it("requires current publisher authority and retains finalized prices after rotation", async function () {
    const c = await network.create();
    const [admin, publisher, replacement, underlying, quote] = await c.ethers.getSigners();
    const feed = await c.ethers.deployContract("IvySettlementPriceFeed", [admin.address, publisher.address]);
    const role = await feed.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    const now = BigInt(await c.networkHelpers.time.latest());
    await expect(feed.publishExpiry(underlying.address, quote.address, now, 3000, now + 100n)).revertedWithCustomError(feed, "AccessControlUnauthorizedAccount");
    await feed.connect(publisher).publishExpiry(underlying.address, quote.address, now, 3000, now + 100n);
    await feed.grantRole(role, replacement.address);
    await feed.revokeRole(role, publisher.address);
    await expect(feed.connect(publisher).publishExercisePrice(underlying.address, quote.address, 4000, now, now + 100n)).revertedWithCustomError(feed, "AccessControlUnauthorizedAccount");
    await expect(feed.connect(replacement).publishExpiry(underlying.address, quote.address, now, 4000, now + 100n)).revertedWithCustomError(feed, "ReportFinalized");
    await c.networkHelpers.time.increase(1000);
    expect(await feed.settlementPrice(underlying.address, quote.address, now)).equal(3000);
    await expect(c.ethers.deployContract("IvySettlementPriceFeed", [ZeroAddress, publisher.address])).revertedWithCustomError(feed,"ZeroAddress");
  });
});

import { callTerms, callPairs, deployIvy, SettlementType, WETH_UNIT as W, USDC_UNIT as U } from "./helpers/setup.js";
import { goLive, at } from "./helpers/scenarios.js";

describe("Authoritative cash routing", function () {
  it("rejects missing/invalid authority configuration and preserves it across tightening", async function () {
    const c = await deployIvy(await network.create());
    await expect(c.hub.createVault(callTerms(c,{allowedSettlement:1}),callPairs(c))).revertedWithCustomError(c.hub,"CashSettlementNeedsFeed");
    await expect(c.hub.createVault(callTerms(c,{allowedSettlement:1,settlementPriceFeed:c.alice.address,maxSettlementPriceAge:60}),callPairs(c))).revertedWithCustomError(c.hub,"BindingMismatch");
    await expect(c.hub.createVault(callTerms(c,{allowedSettlement:1,settlementPriceFeed:c.settlementFeedAddress}),callPairs(c))).revertedWithCustomError(c.hub,"FeedNeedsMaxPriceAge");
    const terms=callTerms(c,{allowedSettlement:2,settlementPriceFeed:c.settlementFeedAddress,maxSettlementPriceAge:60});
    await c.hub.connect(c.alice).createVault(terms,callPairs(c));
    await c.hub.connect(c.alice).tightenVaultTerms(1,{allowedExercise:1,allowedSettlement:1,minCollateral:0,maxInTheMoneyBps:0,maxPriceAge:0});
    const saved=await c.hub.termsOf(1);
    expect(saved.settlementPriceFeed).equal(c.settlementFeedAddress);
    expect(saved.maxSettlementPriceAge).equal(60);
  });

  it("validates stored observation timestamps, validity and freshness independently of indicative prices", async function () {
    const c=await deployIvy(await network.create());
    const v=await goLive(c,{withFeed:true},{settlement:SettlementType.Cash});
    const now=BigInt(await c.networkHelpers.time.latest());
    await c.feed.set(c.wethAddress,c.usdcAddress,9000n*U,now);
    for(const [observed,until,error] of [[0n,now+1000n,"InvalidPrice"],[now+1000n,now+2000n,"InvalidPrice"],[now-4000n,now+1000n,"StalePrice"],[now,now,"StalePrice"]] as const){
      await c.settlementFeed.set(c.wethAddress,c.usdcAddress,4000n*U,observed,until);
      await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId,W)).revertedWithCustomError(c.hub,error);
      expect(await c.hub.remainingNotional(v.vaultId)).equal(10n*W);
    }
    const ts=BigInt(await c.networkHelpers.time.latest())+2n;
    await c.settlementFeed.set(c.wethAddress,c.usdcAddress,4000n*U,ts-3600n,ts);
    await at(c,ts);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId,W)).changeTokenBalance(c.ethers,c.weth,c.marketMaker,W/4n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId,W)).revertedWithCustomError(c.hub,"StalePrice");
  });

  it("keeps missing expiry obligations locked until publisher rotation and late recovery, isolating premium and fee reserves", async function () {
    const c=await deployIvy(await network.create());
    const authority=await c.ethers.deployContract("IvySettlementPriceFeed",[c.admin.address,c.bob.address]);
    await c.hub.setPlatformFeeBps(200);
    const v=await goLive(c,{isCall:false,withFeed:true,terms:{settlementPriceFeed:await authority.getAddress()}},{settlement:1});
    await c.feed.setSettlementPrice(c.wethAddress,c.usdcAddress,v.bid.expiry,1);
    await at(c,v.bid.expiry);
    await expect(c.hub.expire(v.vaultId)).revertedWithCustomError(c.hub,"ReportUnavailable");
    expect(await c.hub.remainingNotional(v.vaultId)).equal(10n*W);
    expect((await c.hub.stateOf(v.vaultId)).phase).equal(2);
    await expect(c.hub.connect(c.alice).claim(v.vaultId,30_000n*U)).revertedWithCustomError(c.hub,"WrongPhase");
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    await v.vault.claimPlatformFee();
    await c.networkHelpers.time.increase(10000);
    const role=await authority.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await authority.grantRole(role,c.carol.address);
    await authority.revokeRole(role,c.bob.address);
    const now=BigInt(await c.networkHelpers.time.latest());
    await authority.connect(c.carol).publishExpiry(c.wethAddress,c.usdcAddress,v.bid.expiry,2700n*U,now+100n);
    await c.hub.expire(v.vaultId);
    expect(await v.vault.buyerReserved(c.usdcAddress)).equal(3000n*U);
    await c.hub.connect(c.alice).claim(v.vaultId,30_000n*U);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).changeTokenBalance(c.ethers,c.usdc,c.marketMaker,3000n*U);
    await expect(c.hub.connect(c.marketMaker).claimPayout(v.vaultId)).revertedWithCustomError(c.hub,"NothingToClaim");
  });
});

describe("Settlement publication boundaries", function () {
  it("rejects invalid bindings and non-increasing observations, preserves validity, and finalizes each exact pair/expiry once", async function () {
    const c=await network.create();
    const [admin,publisher,underlying,quote,other]=await c.ethers.getSigners();
    const f=await c.ethers.deployContract("IvySettlementPriceFeed",[admin.address,publisher.address]);
    await expect(c.ethers.deployContract("IvySettlementPriceFeed",[admin.address,ZeroAddress])).revertedWithCustomError(f,"ZeroAddress");
    let now=BigInt(await c.networkHelpers.time.latest());
    for(const [u,q,p] of [[ZeroAddress,quote.address,1],[underlying.address,ZeroAddress,1],[underlying.address,underlying.address,1],[underlying.address,quote.address,0]] as const)
      await expect(f.connect(publisher).publishExercisePrice(u,q,p,now,now+1000n)).revertedWithCustomError(f,"InvalidPrice");
    await expect(f.connect(publisher).publishExercisePrice(underlying.address,quote.address,1,0,now+1000n)).revertedWithCustomError(f,"InvalidPrice");
    await expect(f.connect(publisher).publishExercisePrice(underlying.address,quote.address,1,now+1000n,now+2000n)).revertedWithCustomError(f,"InvalidPrice");
    await expect(f.connect(publisher).publishExpiry(underlying.address,quote.address,now+1000n,1,now+2000n)).revertedWithCustomError(f,"ExpirationNotReached");
    await expect(f.connect(publisher).publishExpiry(underlying.address,quote.address,0,1,now+2000n)).revertedWithCustomError(f,"ExpirationNotReached");
    now=BigInt(await c.networkHelpers.time.latest());
    await f.connect(publisher).publishExercisePrice(underlying.address,quote.address,4000,now,now+100n);
    await expect(f.connect(publisher).publishExercisePrice(underlying.address,quote.address,5000,now,now+100n)).revertedWithCustomError(f,"InvalidPrice");
    await expect(f.connect(publisher).publishExercisePrice(underlying.address,quote.address,5000,now+1n,now)).revertedWithCustomError(f,"BidExpired");
    await f.revokeRole(await f.SETTLEMENT_PRICE_PUBLISHER_ROLE(),publisher.address);
    expect(await f.exercisePrice(underlying.address,quote.address)).deep.equal([4000n,now,now+100n]);
    expect(await f.exercisePrice(underlying.address,other.address)).deep.equal([0n,0n,0n]);
    await f.grantRole(await f.SETTLEMENT_PRICE_PUBLISHER_ROLE(),publisher.address);
    const boundary=BigInt(await c.networkHelpers.time.latest())+1n;
    await c.networkHelpers.time.setNextBlockTimestamp(boundary);
    await f.connect(publisher).publishExpiry(underlying.address,quote.address,boundary,3000,boundary);
    await expect(f.settlementPrice(underlying.address,other.address,boundary)).revertedWithCustomError(f,"ReportUnavailable");
    await expect(f.settlementPrice(underlying.address,quote.address,boundary+1n)).revertedWithCustomError(f,"ReportUnavailable");
    const different=await c.ethers.deployContract("IvySettlementPriceFeed",[admin.address,publisher.address]);
    await expect(different.settlementPrice(underlying.address,quote.address,boundary)).revertedWithCustomError(different,"ReportUnavailable");
  });
});

describe("Exercise authority survives rotation within validity", function () {
  it("uses the selected pair only and keeps completed early payments final", async function () {
    const c=await deployIvy(await network.create());
    const f=await c.ethers.deployContract("IvySettlementPriceFeed",[c.admin.address,c.bob.address]);
    const v=await goLive(c,{withFeed:true,terms:{settlementPriceFeed:await f.getAddress()}},{settlement:1});
    let now=BigInt(await c.networkHelpers.time.latest());
    await f.connect(c.bob).publishExercisePrice(c.wethAddress,c.daiAddress,6000n*U,now,now+100n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId,W)).revertedWithCustomError(c.hub,"InvalidPrice");
    now=BigInt(await c.networkHelpers.time.latest());
    await f.connect(c.bob).publishExercisePrice(c.wethAddress,c.usdcAddress,4000n*U,now,now+100n);
    const role=await f.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await f.revokeRole(role,c.bob.address);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId,W)).changeTokenBalance(c.ethers,c.weth,c.marketMaker,W/4n);
    await f.grantRole(role,c.carol.address);
    now=BigInt(await c.networkHelpers.time.latest());
    await f.connect(c.carol).publishExercisePrice(c.wethAddress,c.usdcAddress,6000n*U,now,now+100n);
    await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId,W)).changeTokenBalance(c.ethers,c.weth,c.marketMaker,W/2n);
    expect(await c.weth.balanceOf(c.marketMaker.address)).equal(3n*W/4n);
    expect(await c.hub.remainingNotional(v.vaultId)).equal(8n*W);
  });
});
