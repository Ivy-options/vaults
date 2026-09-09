import { rejects } from "node:assert/strict";
import { expect } from "chai";
import { network } from "hardhat";
import { Contract, ZeroAddress } from "ethers";
import { loadArtifacts, REPORT_TYPES, prepareOperation, prepareVault } from "../scripts/operator.mjs";
import { buildDeploymentPlan, resumeDeployment, verifyBindings, CONTRACTS, json } from "../scripts/deployment.mjs";
import { deployIvy, WETH_UNIT as W, USDC_UNIT as U } from "./helpers/setup.js";
import { goLive, at } from "./helpers/scenarios.js";
const expiryArgs = (r: any) => [r.underlying,r.quote,r.expiry,r.price,r.validUntil] as const;
const spotArgs = (r: any) => [r.underlying,r.quote,r.price,r.observedAt,r.validUntil] as const;
const connection=await network.create();
const {ethers,networkHelpers}=connection;

describe("signed expiry reports",function(){
  async function fixture(){const c=await deployIvy(connection);const feed=await ethers.deployContract('IvyPriceFeed',[c.admin.address]);return {...c,realFeed:feed};}
  async function signed(c:any, feed:any, kind:string, value:any, signer=c.admin) {
    const type=kind==='spot'?'SpotReport':'ExpiryReport';
    return signer.signTypedData({name:'IvyPriceFeed',version:'1',chainId:(await signer.provider.getNetwork()).chainId,verifyingContract:await feed.getAddress()},{[type]:REPORT_TYPES[type]},value);
  }
  it("pins expiry prices, rejects early reports, and ignores later spot moves",async()=>{
    const c=await networkHelpers.loadFixture(fixture), f=c.realFeed;
    const now=BigInt(await networkHelpers.time.latest()), expiry=now+100n;
    const report={underlying:c.wethAddress,quote:c.usdcAddress,expiry,price:3300n*U,validUntil:expiry+3600n};
    const sig=await signed(c,f,'expiry',report);
    await expect(f.publishExpiry(...expiryArgs(report),sig)).revertedWithCustomError(f,'ExpirationNotReached');
    await networkHelpers.time.increaseTo(expiry);
    await f.publishExpiry(...expiryArgs(report),sig);
    await expect(f.publishExpiry(...expiryArgs(report),sig)).revertedWithCustomError(f,'ReportFinalized');
    const spot={underlying:c.wethAddress,quote:c.usdcAddress,price:5000n*U,observedAt:expiry,validUntil:expiry+3600n};
    await f.publishSpot(...spotArgs(spot),await signed(c,f,'spot',spot));
    await networkHelpers.time.increaseTo(expiry+86400n);
    expect(await f.settlementPrice(c.wethAddress,c.usdcAddress,expiry)).eq(3300n*U);
    await expect(f.settlementPrice(c.wethAddress,c.usdcAddress,expiry+1n)).revertedWithCustomError(f,'ReportUnavailable');
  });
  it("rejects bad signatures, wrong feed domains, invalid prices and expired submissions",async()=>{
    const c=await networkHelpers.loadFixture(fixture), f=c.realFeed;
    const now=BigInt(await networkHelpers.time.latest());
    const r={underlying:c.wethAddress,quote:c.usdcAddress,expiry:now,price:3300n*U,validUntil:now+100n};
    await expect(f.publishExpiry(...expiryArgs(r),await signed(c,f,'expiry',r,c.bob))).revertedWithCustomError(f,'BadSignature');
    const other=await ethers.deployContract('IvyPriceFeed',[c.admin.address]);
    await expect(other.publishExpiry(...expiryArgs(r),await signed(c,f,'expiry',r))).revertedWithCustomError(other,'BadSignature');
    const zero={...r,price:0n};await expect(f.publishExpiry(...expiryArgs(zero),'0x')).revertedWithCustomError(f,'InvalidPrice');
    await networkHelpers.time.increaseTo(now+101n);
    await expect(f.publishExpiry(...expiryArgs(r),await signed(c,f,'expiry',r))).revertedWithCustomError(f,'BidExpired');
  });
  it("supports contract signers and strictly advancing fresh spot observations",async()=>{
    const c=await networkHelpers.loadFixture(fixture);
    const wallet=await ethers.deployContract('Mock1271',[c.admin.address]);
    const f=await ethers.deployContract('IvyPriceFeed',[await wallet.getAddress()]);
    const now=BigInt(await networkHelpers.time.latest());
    const r={underlying:c.wethAddress,quote:c.usdcAddress,price:3000n*U,observedAt:now,validUntil:now+1000n};
    const sig=await signed(c,f,'spot',r);await f.publishSpot(...spotArgs(r),sig);
    expect((await f.spot(c.wethAddress,c.usdcAddress))[0]).eq(3000n*U);
    await expect(f.publishSpot(...spotArgs(r),sig)).revertedWithCustomError(f,'InvalidPrice');
    const future={...r,observedAt:now+100n};await expect(f.publishSpot(...spotArgs(future),await signed(c,f,'spot',future))).revertedWithCustomError(f,'InvalidPrice');
  });
});

describe("journaled immutable deployment and manual tooling",function(){
  async function fixture(){const [admin]=await ethers.getSigners();const artifacts=await loadArtifacts();const plan=await buildDeploymentPlan({artifacts,chainId:(await admin.provider!.getNetwork()).chainId,genesisHash:(await admin.provider!.getBlock(0))!.hash,deployer:admin.address,startNonce:await admin.getNonce(),admin:admin.address,reportSigner:admin.address});return {admin,artifacts,plan};}
  it("keeps every production contract under EIP-170",async()=>{
    const {artifacts}=await fixture();for(const name of CONTRACTS) expect((artifacts[name].deployedBytecode.length-2)/2,name).at.most(24576);
  });
  it("recovers an interrupted constructor sequence, verifies evidence, and never redeploys completed steps",async()=>{
    const {admin,plan}=await networkHelpers.loadFixture(fixture);const journal:any={};let stopped=false;
    await rejects(resumeDeployment(admin,plan,journal,async(j:any)=>{if(j.steps.IvyShares?.runtimeHash&&!stopped){stopped=true;throw new Error('simulated interruption');}}), new RegExp('simulated interruption'));
    // Simulate a lost submission record; discovery must find and verify the creation transaction.
    delete journal.steps.IvyShares.hash;
    const done=await resumeDeployment(admin,plan,journal);
    expect(done.complete).eq(true);await verifyBindings(admin.provider,plan);
    const before=await admin.getNonce();await resumeDeployment(admin,plan,journal);expect(await admin.getNonce()).eq(before);
    journal.steps.IvyVault.runtimeHash='0x'+'00'.repeat(32);
    await rejects(resumeDeployment(admin,plan,journal), new RegExp('Runtime hash changed'));
  });
  it("deploys physical-only without cash configuration and verifies bindings after later opt-in",async()=>{
    const {admin,plan}=await networkHelpers.loadFixture(fixture);
    expect(plan.version).eq(6);
    expect(plan).not.have.property('settlementPublisher');
    expect(plan.settlementMethodology).eq(undefined);
    const journal=await resumeDeployment(admin,plan);
    const hub=await ethers.getContractAt('IvyVaultsHub',plan.addresses.IvyVaultsHub);
    expect(await hub.cashSettlementEnabled()).eq(false);
    const [,publisher]=await ethers.getSigners();
    await hub.grantRole(await hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(),publisher.address);
    expect(await hub.cashSettlementEnabled()).eq(false);
    await hub.setCashSettlementEnabled(true);
    expect(await hub.cashSettlementEnabled()).eq(true);
    await verifyBindings(admin.provider,plan);
    await resumeDeployment(admin,plan,journal);
    await rejects(verifyBindings(admin.provider,{...plan,admin:publisher.address}), /Admin role missing/);
  });
  it("rejects nonce drift without starting a deployment",async()=>{
    const {admin,plan}=await networkHelpers.loadFixture(fixture);
    await admin.sendTransaction({to:admin.address,value:0});
    await rejects(resumeDeployment(admin,plan,{}), new RegExp('Nonce drift'));
    expect(await admin.provider!.getCode(plan.addresses.IvyVault)).eq('0x');
  });
  it("rejects obsolete or cross-chain plans and journals from other plans",async()=>{
    const {admin,plan}=await networkHelpers.loadFixture(fixture);
    await rejects(resumeDeployment(admin,{...plan,version:5},{}), /Unsupported deployment plan version/);
    await rejects(resumeDeployment(admin,{...plan,chainId:'1'},{}), new RegExp('Wrong chain'));
    await rejects(resumeDeployment(admin,plan,{planHash:'wrong'}), new RegExp('another plan'));
  });
  it("requires explicit USD minimum, computes a call floor, and prepares only simulated calldata",async()=>{
    const c=await deployIvy(connection), artifacts=await loadArtifacts();
    await c.weth.mint(c.alice.address,10n*W);
    const request:any={sender:c.alice.address,hub:c.hubAddress,collateralAmount:(10n*W).toString(),collateralPriceUsdE6:(3000n*U).toString(),minTradeUsdE6:(10000n*U).toString(),supportedTokens:[c.wethAddress,c.usdcAddress],marketQuotes:{[c.usdcAddress.toLowerCase()]:{spot:(3000n*U).toString(),outOfTheMoneyBps:2000}},terms:{allowPartialExercise:false,underlying:c.wethAddress,collateral:c.wethAddress,allowedExercise:1,allowedSettlement:0,expiry:c.defaultExpiry,auctionStartsAt:0,minCollateral:0,priceFeed:ZeroAddress,maxSettlementPriceAge:0,maxInTheMoneyBps:0,maxPriceAge:0},pairs:[{quoteToken:c.usdcAddress,terms:{premiumToken:c.usdcAddress,strikeLimit:0,minPremium:0,enabled:true}}]};
    const cash={...request,terms:{...request.terms,allowedSettlement:1,maxSettlementPriceAge:3600}};
    await rejects(prepareVault(c.admin.provider,{...cash,terms:{...cash.terms,maxSettlementPriceAge:0}}), /positive maxSettlementPriceAge/);
    await rejects(prepareVault(c.admin.provider,cash), /Missing settlementMethodology/);
    const prepared=await prepareVault(c.admin.provider,request);
    expect(prepared.terms.allowPartialExercise).eq(false);
    await rejects(prepareVault(c.admin.provider,{...request,terms:{...request.terms,allowPartialExercise:undefined}}), /Missing allowPartialExercise/);
    await rejects(prepareVault(c.admin.provider,{...request,terms:{...request.terms,allowPartialExercise:"false"}}), /must be boolean/);
    expect(prepared.terms.publicDeposits).eq(false);expect(prepared.pairs[0].terms.strikeLimit).eq(3600n*U);
    const tx=await prepareOperation(c.admin.provider,artifacts,'prepare-vault',request);
    expect(tx.method).eq('createVault');expect(await c.hub.vaultCount()).eq(0n);
    const missing={...request};delete missing.minTradeUsdE6;
    await rejects(prepareVault(c.admin.provider,missing), new RegExp('Missing minTradeUsdE6'));
    await rejects(prepareVault(c.admin.provider,{...request,minTradeUsdE6:(40000n*U).toString()}), new RegExp('Below launch USD minimum'));
  });
});
