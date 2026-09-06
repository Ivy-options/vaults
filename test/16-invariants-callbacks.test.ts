import {expect} from 'chai';
import {network} from 'hardhat';
import {deployIvy,callTerms,callPairs,createVaultAs,fund,WETH_UNIT as W,USDC_UNIT as U,Phase,SettlementType,ExerciseStyle} from './helpers/setup.js';
import {openVault,activate,goLive,at} from './helpers/scenarios.js';
import {UNWIND_TYPES} from '../scripts/operator.mjs';
const connection=await network.create();const {ethers,networkHelpers}=connection;
describe('cross-module callbacks and reserve invariants',function(){
 const fixture=()=>deployIvy(connection);
 it('checks unanimous consent after refund-token callbacks and rolls back funding and share movement',async()=>{
  const c=await networkHelpers.loadFixture(fixture), token=await ethers.deployContract('CallbackToken');
  const v=await openVault(c,{pair:{premiumToken:await token.getAddress()}});
  await token.mint(c.marketMaker.address,1000n*U);await token.connect(c.marketMaker).approve(v.vaultAddress,1000n*U);
  await activate(c,v.vaultId,v.vaultAddress);
  await c.hub.connect(c.alice).proposeUnwind(v.vaultId,BigInt(await networkHelpers.time.latest())+86400n,100n*U);
  const a=await c.unwind.agreements(v.vaultId);
  const value={vaultId:a.vaultId,nonce:a.nonce,deadline:a.deadline,exercisedNotional:a.exercisedNotional,supply:a.supply,refund:a.refund};
  const sig=await c.marketMaker.signTypedData({name:'IvyUnwind',version:'1',chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:await c.unwind.getAddress()},UNWIND_TYPES,value);
  await c.hub.connect(c.alice).approveUnwind(v.vaultId,a.nonce);
  await token.mint(c.alice.address,a.refund);await token.connect(c.alice).approve(v.vaultAddress,a.refund);
  await c.shares.connect(c.alice).setApprovalForAll(await token.getAddress(),true);
  await token.arm(c.sharesAddress,c.shares.interface.encodeFunctionData('safeTransferFrom',[c.alice.address,c.carol.address,v.vaultId,W,'0x']));
  await expect(c.hub.connect(c.alice).executeUnwind(v.vaultId,a.nonce,sig)).revertedWithCustomError(c.unwind,'ConsentMissing');
  expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Live);
  expect(await c.shares.balanceOf(c.carol.address,v.vaultId)).eq(0n);
  expect(await token.balanceOf(c.alice.address)).eq(a.refund);
  expect(await v.vault.reserved(await token.getAddress())).eq(1000n*U);
  await token.disarm();await c.shares.connect(c.alice).safeTransferFrom(c.alice.address,c.carol.address,v.vaultId,W,'0x');
  for(const holder of [c.alice,c.carol])await c.hub.connect(holder).approveUnwind(v.vaultId,a.nonce);
  await c.hub.connect(c.alice).executeUnwind(v.vaultId,a.nonce,sig);
  expect((await c.hub.stateOf(v.vaultId)).phase).eq(Phase.Settled);
 });
 it('snapshots premium before collection callbacks can transfer shares',async()=>{
  const c=await networkHelpers.loadFixture(fixture), token=await ethers.deployContract('CallbackToken');
  const v=await openVault(c,{pair:{premiumToken:await token.getAddress()}});
  await token.mint(c.marketMaker.address,1000n*U);await token.connect(c.marketMaker).approve(v.vaultAddress,1000n*U);
  await c.shares.connect(c.alice).setApprovalForAll(await token.getAddress(),true);
  await token.arm(c.sharesAddress,c.shares.interface.encodeFunctionData('safeTransferFrom',[c.alice.address,c.carol.address,v.vaultId,10n*W,'0x']));
  await activate(c,v.vaultId,v.vaultAddress);
  expect(await token.callbackSucceeded()).eq(true);
  expect(await c.shares.balanceOf(c.carol.address,v.vaultId)).eq(10n*W);
  expect(await c.premiums.claimable(v.vaultId,c.alice.address)).eq(1000n*U);
  expect(await c.premiums.claimable(v.vaultId,c.carol.address)).eq(0n);
  await token.arm(c.hubAddress,c.hub.interface.encodeFunctionData('claimPremium',[v.vaultId]));
  await c.hub.connect(c.alice).claimPremium(v.vaultId);
  expect(await token.callbackSucceeded()).eq(false);
  expect(await token.balanceOf(c.alice.address)).eq(1000n*U);
 });
 it('guards direct vault deposits against nested transfers that would inflate balance-delta credit',async()=>{
  const c=await networkHelpers.loadFixture(fixture),token=await ethers.deployContract('CallbackToken'),address=await token.getAddress();
  const v=await createVaultAs(c,c.alice,callTerms(c,{underlying:address,collateral:address}),callPairs(c));
  await token.mint(c.alice.address,100);await token.mint(address,10);
  await token.connect(c.alice).approve(v.vaultAddress,100);await token.approveSelf(v.vaultAddress,10);
  await token.arm(c.hubAddress,c.hub.interface.encodeFunctionData('deposit',[v.vaultId,10]));
  await v.vault.connect(c.alice).deposit(100);
  expect(await token.callbackSucceeded()).eq(false);
  expect(await token.balanceOf(v.vaultAddress)).eq(100n);
  expect(await c.hub.totalShares(v.vaultId)).eq(100n);
 });
 it('enforces independent premium caps even when premium and collateral are the same token',async()=>{
  const c=await networkHelpers.loadFixture(fixture), mock=await ethers.deployContract('MockHub');
  await mock.createClone(c.vaultImplAddress,1,c.usdcAddress);const address=await mock.lastClone(),v=await ethers.getContractAt('IvyVault',address);
  await c.usdc.mint(address,1000);await c.usdc.mint(c.alice.address,100);await c.usdc.connect(c.alice).approve(address,100);
  await mock.collectPremium(address,c.usdcAddress,c.alice.address,100);await mock.reserveBuyer(address,c.usdcAddress,200);
  expect(await v.reserved(c.usdcAddress)).eq(300n);
  await expect(v.payPremium(c.alice.address,1)).revertedWithCustomError(v,'NotPremiumModule');
  await expect(mock.payPremium(address,c.alice.address,101)).revertedWithCustomError(v,'InsufficientAvailable');
  await expect(mock.push(address,c.usdcAddress,c.alice.address,801)).revertedWithCustomError(v,'InsufficientAvailable');
  await expect(mock.collectPremium(address,c.usdcAddress,c.alice.address,0)).revertedWithCustomError(v,'AlreadyInitialized');
  await mock.payBuyer(address,c.usdcAddress,c.bob.address);
  expect(await v.reserved(c.usdcAddress)).eq(100n);
  await mock.payPremium(address,c.alice.address,100);await mock.push(address,c.usdcAddress,c.alice.address,800);
  expect(await c.usdc.balanceOf(address)).eq(0n);
 });
 for(const isCall of [true,false]) for(const cash of [true,false]) it(`stateful conservation: ${isCall?'call':'put'}, ${cash?'cash':'physical'}`,async()=>{
  const c=await networkHelpers.loadFixture(fixture), unit=isCall?W:3000n*U;
  const v=await goLive(c,{isCall,withFeed:cash,deposit:6n*unit,extraDeposits:[{signer:c.bob,amount:4n*unit}]},{settlement:cash?SettlementType.Cash:SettlementType.Physical,style:ExerciseStyle.American});
  const holders=[c.alice,c.bob,c.carol],balances=[6n*unit,4n*unit,0n];let paid=0n, seed=19;
  for(let i=0;i<30;i++){
   seed=(seed*48271)%2147483647;const from=seed%3,to=(from+1+(seed%2))%3;
   const amount=balances[from]/3n;
   await c.shares.connect(holders[from]).safeTransferFrom(holders[from].address,holders[to].address,v.vaultId,amount,'0x');
   balances[from]-=amount;balances[to]+=amount;
   if(i===8||i===17){const h=i===8?c.alice:c.bob;const due=await c.premiums.claimable(v.vaultId,h.address);await c.hub.connect(h).claimPremium(v.vaultId);paid+=due;}
   expect(await v.vault.reserved(c.usdcAddress)).eq(1000n*U-paid);
   expect(await c.hub.totalShares(v.vaultId)).eq(balances.reduce((a,b)=>a+b));
  }
  if(cash){await c.feed.setSettlementPrice(c.wethAddress,c.usdcAddress,v.bid.expiry,isCall?3300n*U:2700n*U);await at(c,v.bid.expiry);await c.hub.expire(v.vaultId);}
  else {if(!isCall)await fund(c,c.weth,c.marketMaker,v.vaultAddress,4n*W);await c.hub.connect(c.marketMaker).exercise(v.vaultId,4n*W);await at(c,v.bid.expiry+3600n);await c.hub.expire(v.vaultId);}
  for(let i=0;i<3;i++)if(balances[i]>0n)await c.hub.connect(holders[i]).claim(v.vaultId,balances[i]);
  if(cash)await c.hub.connect(c.marketMaker).claimPayout(v.vaultId);
  expect(await c.hub.totalShares(v.vaultId)).eq(0n);
  expect(await c.weth.balanceOf(v.vaultAddress)).eq(0n);
  expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
  expect(await c.usdc.balanceOf(c.alice.address)+await c.usdc.balanceOf(c.bob.address)+await c.usdc.balanceOf(c.carol.address)+(cash&&!isCall?3000n*U:0n)).eq(isCall?(cash?1000n*U:13000n*U):cash?31000n*U:19000n*U);
 });
});
