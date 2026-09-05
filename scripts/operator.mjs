#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AbiCoder, Contract, Interface, JsonRpcProvider, VoidSigner, ZeroAddress, id, keccak256 } from 'ethers';
import { CONTRACTS, artifactPath, buildDeploymentPlan, resumeDeployment, json } from './deployment.mjs';
export const BID_TYPES = {Bid:[['vaultId','uint256'],['marketMaker','address'],['quoteToken','address'],['strike','uint256'],['premium','uint256'],['style','uint8'],['settlement','uint8'],['expiry','uint64'],['validUntil','uint64'],['nonce','uint256'],['auctionId','uint256'],['collateralAmount','uint256'],['pairHash','bytes32'],['executor','address'],['recipient','address']].map(([name,type])=>({name,type}))};
export const UNWIND_TYPES = {UnwindAgreement:[['vaultId','uint256'],['nonce','uint256'],['deadline','uint64'],['exercisedNotional','uint256'],['supply','uint256'],['refund','uint256']].map(([name,type])=>({name,type}))};
export const REPORT_TYPES = {
  SpotReport:[['underlying','address'],['quote','address'],['price','uint256'],['observedAt','uint64'],['validUntil','uint64']].map(([name,type])=>({name,type})),
  ExpiryReport:[['underlying','address'],['quote','address'],['expiry','uint64'],['price','uint256'],['validUntil','uint64']].map(([name,type])=>({name,type})),
};
export async function loadArtifacts() {
  return Object.fromEntries(await Promise.all(CONTRACTS.map(async name=>[name,JSON.parse(await readFile(new URL(artifactPath(name),import.meta.url),'utf8'))])));
}
const required = (o,key) => {if(o[key]===undefined) throw new Error(`Missing ${key}`); return o[key];};
const fields = (type,value) => Object.fromEntries(type.map(f=>[f.name,required(value,f.name)]));

/** Read-only preflight. USD values use six decimals; token quantities use raw token units. */
export async function prepareVault(provider, request) {
  const r=request, t={...required(r,'terms'),publicDeposits:r.terms.publicDeposits??false};
  const pairs=required(r,'pairs').map(p=>({quoteToken:p.quoteToken,terms:{...p.terms}}));
  const allowed=new Set(required(r,'supportedTokens').map(a=>a.toLowerCase()));
  for(const token of [t.underlying,t.collateral,...pairs.flatMap(p=>[p.quoteToken,p.terms.premiumToken])]) if(!allowed.has(token.toLowerCase())) throw new Error(`Unsupported token ${token}`);
  const token=new Contract(t.collateral,['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)'],provider);
  const amount=BigInt(required(r,'collateralAmount'));
  const usdPrice=BigInt(required(r,'collateralPriceUsdE6'));
  const minimum=BigInt(required(r,'minTradeUsdE6'));
  if(amount<=0n||usdPrice<=0n||minimum<=0n) throw new Error('Amount, valuation and minimum must be positive');
  const decimals=Number(await token.decimals());
  const valueUsdE6=amount*usdPrice/(10n**BigInt(decimals));
  if(valueUsdE6<minimum) throw new Error('Below launch USD minimum');
  if(await token.balanceOf(required(r,'sender'))<amount) throw new Error('Insufficient wallet balance');
  t.minCollateral=amount;
  for(const pair of pairs) {
    const market=required(r,'marketQuotes')[pair.quoteToken.toLowerCase()];
    if(!market) throw new Error('Missing market quote for pair');
    const spot=BigInt(required(market,'spot')), bps=BigInt(required(market,'outOfTheMoneyBps'));
    const call=t.collateral.toLowerCase()===t.underlying.toLowerCase();
    if(spot<=0n||bps<0n||(!call&&bps>=10000n)) throw new Error('Invalid strike inputs');
    pair.terms.strikeLimit=call?(spot*(10000n+bps)+9999n)/10000n:spot*(10000n-bps)/10000n;
  }
  return {terms:t,pairs,valueUsdE6};
}

export async function prepareOperation(provider, artifacts, command, r) {
  const chainId=String((await provider.getNetwork()).chainId);
  const runner=new VoidSigner(required(r,'sender'),provider);
  const hub=r.hub?new Contract(r.hub,artifacts.IvyVaultsHub.abi,runner):null;
  const domain=(name,version,address)=>({name,version,chainId,verifyingContract:address});
  if(command==='typed-report') {
    if(!['spot','expiry'].includes(r.kind)) throw new Error('Report kind must be spot or expiry');
    const name=r.kind==='spot'?'SpotReport':'ExpiryReport';
    return {domain:domain('IvyPriceFeed','1',required(r,'feed')),types:{[name]:REPORT_TYPES[name]},value:fields(REPORT_TYPES[name],r.report)};
  }
  if(command==='typed-bid') {
    const s=await hub.stateOf(r.vaultId), p=await hub.pairTermsOf(r.vaultId,r.bid.quoteToken);
    const value={...r.bid,vaultId:r.vaultId,expiry:s.expiry,auctionId:s.auctionId,collateralAmount:await hub.totalShares(r.vaultId),pairHash:keccak256(AbiCoder.defaultAbiCoder().encode(['tuple(address,uint256,uint256,bool)'],[Array.from(p)])),executor:r.bid.executor??ZeroAddress,recipient:r.bid.recipient??r.bid.marketMaker};
    return {domain:domain('IvyVaultsHub','2',r.hub),types:BID_TYPES,value:fields(BID_TYPES.Bid,value)};
  }
  if(command==='typed-unwind') {
    const address=await hub.unwind(), module=new Contract(address,artifacts.IvyUnwind.abi,provider), a=await module.agreements(r.vaultId);
    return {domain:domain('IvyUnwind','1',address),types:UNWIND_TYPES,value:fields(UNWIND_TYPES.UnwindAgreement,a)};
  }
  let target=hub, method, args, detail;
  if(command==='prepare-vault') {
    detail=await prepareVault(provider,r); method='createVault';args=[detail.terms,detail.pairs];
  } else if(command==='inspect-bid'||command==='activate') {
    method='activate';args=[r.vaultId,r.bid,r.signature];
    const s=await hub.stateOf(r.vaultId), t=await hub.termsOf(r.vaultId);
    const token=new Contract(t.collateral,['function decimals() view returns(uint8)'],provider);
    const minimum=BigInt(required(r,'minTradeUsdE6')), price=BigInt(required(r,'collateralPriceUsdE6'));
    if(minimum<=0n||price<=0n) throw new Error('Explicit positive launch valuation and minimum required');
    const amount=await hub.totalShares(r.vaultId), valueUsdE6=amount*price/(10n**BigInt(await token.decimals()));
    if(valueUsdE6<minimum) throw new Error('Below launch USD minimum at activation');
    const notional=s.isCall?amount:amount*s.underlyingUnit/BigInt(r.bid.strike);
    detail={valueUsdE6,notional,totalPremium:BigInt(r.bid.premium)*notional/s.underlyingUnit};
  } else if(command==='publish-spot'||command==='publish-expiry') {
    target=new Contract(required(r,'feed'),artifacts.IvyPriceFeed.abi,runner);
    const spot=command==='publish-spot', type=spot?REPORT_TYPES.SpotReport:REPORT_TYPES.ExpiryReport;
    method=spot?'publishSpot':'publishExpiry';args=[...type.map(f=>required(r.report,f.name)),r.signature];
  } else {
    const actions={deposit:['deposit',[r.vaultId,r.amount]],withdraw:['withdraw',[r.vaultId,r.amount]],'open-auction':['openAuction',[r.vaultId]],'cancel-auction':['cancelAuction',[r.vaultId]],settle:['settle',[r.vaultId]],exercise:['exercise',[r.vaultId,r.amount]],'claim-premium':['claimPremium',[r.vaultId]],claim:['claim',[r.vaultId,r.amount]],'claim-payout':['claimPayout',[r.vaultId]],'set-execution':['setExecution',[r.vaultId,r.executor,r.recipient]],'propose-unwind':['proposeUnwind',[r.vaultId,r.deadline,r.refund]],'approve-unwind':['approveUnwind',[r.vaultId,r.nonce]],'revoke-unwind':['revokeUnwind',[r.vaultId]],'execute-unwind':['executeUnwind',[r.vaultId,r.nonce,r.signature]],pause:['setAdmissionPause',[r.vaultId,r.paused]],'grant-role':['grantRole',[r.role?id(r.role):undefined,r.account]]};
    if(command==='approve-token') {
      target=new Contract(r.token,['function approve(address,uint256) returns(bool)'],runner);
      method='approve';args=[await hub.vaultOf(r.vaultId),r.amount];
    } else {
      if(!actions[command]) throw new Error(`Unknown command ${command}`);
      [method,args]=actions[command];
    }
  }
  await target[method].staticCall(...args);
  const data=target.interface.encodeFunctionData(method,args);
  return {chainId,from:r.sender,to:await target.getAddress(),data,value:'0',method,detail};
}

async function main() {
  const [command,file,...flags]=process.argv.slice(2);
  if(!command||!file) throw new Error('Usage: npm run operator -- <command> request.json [--send]. Default: preflight and calldata only.');
  const r=JSON.parse(await readFile(file,'utf8'));
  const provider=new JsonRpcProvider(required(r,'rpc'));
  const artifacts=await loadArtifacts();
  if(command==='prepare-deployment') {
    const plan=await buildDeploymentPlan({...r,artifacts,chainId:(await provider.getNetwork()).chainId,genesisHash:(await provider.getBlock(0)).hash,startNonce:await provider.getTransactionCount(r.deployer,'pending')});
    console.log(json(plan));return;
  }
  if(command==='deploy') {
    if(!flags.includes('--send')) throw new Error('Deploy requires --send; prepare-deployment is read-only');
    const plan=JSON.parse(await readFile(r.planFile,'utf8'));
    let journal={};try {journal=JSON.parse(await readFile(r.journalFile,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e;}
    // Rebuild constructor transactions from this checkout before trusting a saved plan.
    const rebuilt=await buildDeploymentPlan({...plan,artifacts});
    if(json(rebuilt)!==json(plan)) throw new Error('Saved deployment plan does not match this build');
    const persist=async j=>{await writeFile(r.journalFile+'.tmp',json(j));await rename(r.journalFile+'.tmp',r.journalFile);};
    const signer=await provider.getSigner(plan.deployer);
    console.log(json(await resumeDeployment(signer,plan,journal,persist)));return;
  }
  const prepared=await prepareOperation(provider,artifacts,command,r);
  if(flags.includes('--send')) {
    if(!prepared.to||command==='inspect-bid') throw new Error('This command is read-only');
    const signer=await provider.getSigner(r.sender);
    const tx=await signer.sendTransaction({to:prepared.to,data:prepared.data,value:0});
    console.log(json({hash:tx.hash,receipt:await tx.wait()}));
  } else console.log(json(prepared));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
