import { rejects } from "node:assert/strict";
import { expect } from "chai";
import { network } from "hardhat";
import { REPORT_TYPES } from "../scripts/encoding.mjs";
import { buildDeploymentPlan, resumeDeployment, verifyBindings, loadArtifacts, CONTRACTS } from "../scripts/deployment.mjs";
import { deployIvy, USDC_UNIT as U } from "./helpers/setup.js";
const spotArgs = (r: any) => [r.underlying,r.quote,r.price,r.observedAt,r.validUntil] as const;
const connection=await network.create();
const {ethers,networkHelpers}=connection;

describe("signed activation spot reports",function(){
  async function fixture(){const c=await deployIvy(connection);const feed=await ethers.deployContract('IvyPriceFeed',[c.admin.address]);return {...c,realFeed:feed};}
  async function signed(c:any, feed:any, value:any, signer=c.admin) {
    return signer.signTypedData({name:'IvyPriceFeed',version:'1',chainId:(await signer.provider.getNetwork()).chainId,verifyingContract:await feed.getAddress()},REPORT_TYPES,value);
  }
  it("accepts signed spot reports from any relayer and stores newer observations",async()=>{
    const c=await networkHelpers.loadFixture(fixture), f=c.realFeed;
    const now=BigInt(await networkHelpers.time.latest());
    const report={underlying:c.wethAddress,quote:c.usdcAddress,price:3300n*U,observedAt:now,validUntil:now+3600n};
    expect(await f.spot(c.wethAddress,c.usdcAddress)).deep.equal([0n,0n]);
    await f.connect(c.bob).publishSpot(...spotArgs(report),await signed(c,f,report));
    expect(await f.spot(c.wethAddress,c.usdcAddress)).deep.equal([report.price,now]);
    await networkHelpers.time.increase(10);
    const newer={...report,price:3500n*U,observedAt:BigInt(await networkHelpers.time.latest())};
    await f.publishSpot(...spotArgs(newer),await signed(c,f,newer));
    expect(await f.spot(c.wethAddress,c.usdcAddress)).deep.equal([newer.price,newer.observedAt]);
  });
  it("rejects bad signatures, wrong feed domains, invalid prices and expired submissions",async()=>{
    const c=await networkHelpers.loadFixture(fixture), f=c.realFeed;
    const now=BigInt(await networkHelpers.time.latest());
    const r={underlying:c.wethAddress,quote:c.usdcAddress,observedAt:now,price:3300n*U,validUntil:now+100n};
    await expect(f.publishSpot(...spotArgs(r),await signed(c,f,r,c.bob))).revertedWithCustomError(f,'BadSignature');
    const other=await ethers.deployContract('IvyPriceFeed',[c.admin.address]);
    await expect(other.publishSpot(...spotArgs(r),await signed(c,f,r))).revertedWithCustomError(other,'BadSignature');
    const zero={...r,price:0n};await expect(f.publishSpot(...spotArgs(zero),'0x')).revertedWithCustomError(f,'InvalidPrice');
    await networkHelpers.time.increaseTo(now+101n);
    await expect(f.publishSpot(...spotArgs(r),await signed(c,f,r))).revertedWithCustomError(f,'BidExpired');
  });
  it("supports contract signers and strictly advancing fresh spot observations",async()=>{
    const c=await networkHelpers.loadFixture(fixture);
    const wallet=await ethers.deployContract('Mock1271',[c.admin.address]);
    const f=await ethers.deployContract('IvyPriceFeed',[await wallet.getAddress()]);
    const now=BigInt(await networkHelpers.time.latest());
    const r={underlying:c.wethAddress,quote:c.usdcAddress,price:3000n*U,observedAt:now,validUntil:now+1000n};
    const sig=await signed(c,f,r);await f.publishSpot(...spotArgs(r),sig);
    expect((await f.spot(c.wethAddress,c.usdcAddress))[0]).eq(3000n*U);
    await expect(f.publishSpot(...spotArgs(r),sig)).revertedWithCustomError(f,'InvalidPrice');
    const future={...r,observedAt:now+100n};await expect(f.publishSpot(...spotArgs(future),await signed(c,f,future))).revertedWithCustomError(f,'InvalidPrice');
  });
});

describe("journaled immutable deployment",function(){
  it("requires an explicit positive expiry price publication window before planning deployment",async()=>{
    const [admin]=await ethers.getSigners(), artifacts=await loadArtifacts();
    const input={artifacts,chainId:(await admin.provider!.getNetwork()).chainId,genesisHash:(await admin.provider!.getBlock(0))!.hash,deployer:admin.address,startNonce:await admin.getNonce(),admin:admin.address,reportSigner:admin.address,exerciseWindow:3600};
    await rejects(buildDeploymentPlan(input), /expiryPricePublicationWindow/);
    await rejects(buildDeploymentPlan({...input,expiryPricePublicationWindow:0}), /expiryPricePublicationWindow/);
  });
  async function fixture(){const [admin]=await ethers.getSigners();const artifacts=await loadArtifacts();const plan=await buildDeploymentPlan({artifacts,chainId:(await admin.provider!.getNetwork()).chainId,genesisHash:(await admin.provider!.getBlock(0))!.hash,deployer:admin.address,startNonce:await admin.getNonce(),admin:admin.address,reportSigner:admin.address,exerciseWindow:3600,expiryPricePublicationWindow:3600});return {admin,artifacts,plan};}
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
    expect(plan.version).eq(7);
    expect(plan).not.have.property('settlementPublisher');
    expect(plan.settlementMethodology).eq(undefined);
    const journal=await resumeDeployment(admin,plan);
    const hub=await ethers.getContractAt('IvyVaultsHub',plan.addresses.IvyVaultsHub);
    expect(await hub.expiryPricePublicationWindow()).eq(3600n);
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
    await rejects(resumeDeployment(admin,{...plan,version:6},{}), /Unsupported deployment plan version/);
    await rejects(resumeDeployment(admin,{...plan,chainId:'1'},{}), new RegExp('Wrong chain'));
    await rejects(resumeDeployment(admin,plan,{planHash:'wrong'}), new RegExp('another plan'));
  });
});
