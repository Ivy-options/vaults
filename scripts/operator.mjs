#!/usr/bin/env node
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AbiCoder, Contract, JsonRpcProvider, VoidSigner, ZeroAddress, id } from 'ethers';
import { CONTRACTS, artifactPath, buildDeploymentPlan, resumeDeployment, json } from './deployment.mjs';
import { buildRegistryDeploymentPlan, resumeRegistryDeployment } from './registry-deployment.mjs';
import { REGISTRY_ABI, RELEASE_FORMAT, verifyRelease, resolveRelease } from './releases.mjs';
export const BID_TYPES = {Bid:[['vaultId','uint256'],['marketMaker','address'],['quoteToken','address'],['strike','uint256'],['premium','uint256'],['style','uint8'],['settlement','uint8'],['expiry','uint64'],['validUntil','uint64'],['nonce','uint256'],['auctionId','uint256'],['collateralAmount','uint256'],['termsHash','bytes32'],['executor','address'],['recipient','address']].map(([name,type])=>({name,type}))};
export const UNWIND_TYPES = {UnwindAgreement:[['vaultId','uint256'],['nonce','uint256'],['deadline','uint64'],['exercisedNotional','uint256'],['supply','uint256'],['refund','uint256']].map(([name,type])=>({name,type}))};
export const REPORT_TYPES = {
  SpotReport:[['underlying','address'],['quote','address'],['price','uint256'],['observedAt','uint64'],['validUntil','uint64']].map(([name,type])=>({name,type})),
};
export const RULE_KIND = { PairLimits: id('PairLimits').slice(0, 10), SpotBand: id('SpotBand').slice(0, 10), PremiumFloor: id('PremiumFloor').slice(0, 10) };
const coder = AbiCoder.defaultAbiCoder();
/** IvyBidRules data layouts. `data` is opaque bytes on-chain, so these are the only off-chain definitions. */
export const encodePairLimits = limits => coder.encode(['tuple(address quoteToken,uint256 strikeLimit,uint256 minPremium)[]'],[limits]);
export const encodeSpotBand = (priceFeed,maxPriceAge,maxInTheMoneyBps) => coder.encode(['tuple(address priceFeed,uint32 maxPriceAge,uint16 maxInTheMoneyBps)'],[[priceFeed,maxPriceAge,maxInTheMoneyBps]]);
export const encodePremiumFloor = (priceFeed,maxPriceAge,minPremiumBps) => coder.encode(['tuple(address priceFeed,uint32 maxPriceAge,uint16 minPremiumBps)'],[[priceFeed,maxPriceAge,minPremiumBps]]);
export async function loadArtifacts() {
  return Object.fromEntries(await Promise.all(CONTRACTS.map(async name=>[name,JSON.parse(await readFile(new URL(artifactPath(name),import.meta.url),'utf8'))])));
}
/** Mirrors IvyMath.notionalOf: a put covers nothing at a zero strike, so the hub's own EmptyNotional check decides. */
const notionalOf = (isCall,amount,unit,strike) => isCall?amount:strike===0n?0n:amount*unit/strike;
const required = (o,key) => {if(o[key]===undefined) throw new Error(`Missing ${key}`); return o[key];};
const fields = (type,value) => Object.fromEntries(type.map(f=>[f.name,required(value,f.name)]));
const fallbackTerms = (expiry, publicationWindow, exerciseWindow) => ({
  expiryPricePublicationWindow:BigInt(publicationWindow),exerciseWindow:BigInt(exerciseWindow),
  publicationDeadline:BigInt(expiry)+BigInt(publicationWindow),
  fallbackDeadline:BigInt(expiry)+BigInt(publicationWindow)+BigInt(exerciseWindow),
  boundaryRule:'Final price before publicationDeadline; explicit physical exercise from publicationDeadline until fallbackDeadline; permissionless expiration from fallbackDeadline if no final price.',
});

/** Preview through public views, including before any fallback transaction has occurred. */
async function inspectSettlement(provider, hub, request) {
  const vaultId=required(request,'vaultId');
  const [state,terms,status,expirationTime,block]=await Promise.all([hub.stateOf(vaultId),hub.termsOf(vaultId),hub.settlementStatus(vaultId),hub.expirationTimeOf(vaultId),provider.getBlock('latest')]);
  const remaining=state.totalNotional-state.exercisedNotional;
  const amount=request.amount===undefined?remaining:BigInt(request.amount);
  if(amount<0n||amount>remaining) throw new Error('Exercise amount exceeds remaining notional');
  let payment;
  if(state.quoteToken!==ZeroAddress) {
    const tokenAddress=state.isCall?state.quoteToken:terms.underlying;
    const token=new Contract(tokenAddress,['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)'],provider);
    const due=state.isCall?(amount*state.strike+state.underlyingUnit-1n)/state.underlyingUnit:amount;
    const [balance,allowance]=await Promise.all([token.balanceOf(request.sender),token.allowance(request.sender,state.vault)]);
    payment={token:tokenAddress,amount:due,payer:request.sender,spender:state.vault,balance,allowance,sufficientBalance:balance>=due,sufficientAllowance:allowance>=due};
  }
  const now=BigInt(block.timestamp), route=Number(status.route);
  const physicalExerciseAvailable=route===3||(route===0&&now<BigInt(state.expiry)+state.exerciseWindow&&(Number(state.style)===1||now>=state.expiry));
  return {vaultId,originalSettlement:Number(state.settlement)===1?'Cash':'Physical',
    route:['Physical','Cash','AwaitingExpiryPrice','PhysicalFallback','FallbackExpired','Inactive'][Number(status.route)],
    publicationDeadline:status.publicationDeadline,fallbackDeadline:status.fallbackDeadline,canExpire:status.canExpire,expirationTime,
    remainingNotional:remaining,amount,allowPartialExercise:terms.allowPartialExercise,recipient:state.recipient,
    authorizedExerciser:request.sender.toLowerCase()===state.marketMaker.toLowerCase()||request.sender.toLowerCase()===state.executor.toLowerCase(),
    physicalExercisePreview:payment?{available:physicalExerciseAvailable,payment,delivery:{token:terms.collateral,amount:state.isCall?amount:amount*state.strike/state.underlyingUnit}}:undefined};
}

/** Read-only preflight. USD values use six decimals; token quantities use raw token units. */
export async function prepareVault(provider, request, release) {
  const r=request, t={...required(r,'terms'),publicDeposits:r.terms.publicDeposits??false};
  for(const key of ['priceFeed','maxPriceAge','maxInTheMoneyBps']) if(t[key]!==undefined) throw new Error(`terms.${key} is no longer a vault term; add a spotBand block to request a SpotBand rule`);
  required(t,'maxSettlementPriceAge');
  if (Number(t.allowedSettlement) !== 0) {
    if (BigInt(t.maxSettlementPriceAge) <= 0n) throw new Error('Cash settlement requires positive maxSettlementPriceAge');
    if (typeof r.settlementMethodology !== 'string' || !r.settlementMethodology.trim()) throw new Error('Missing settlementMethodology artifact reference');
  }
  if(typeof required(t,'allowPartialExercise')!=='boolean') throw new Error('allowPartialExercise must be boolean');
  const pairs=required(r,'pairs').map(p=>{if(p.terms!==undefined) throw new Error('pairs[].terms is no longer accepted; give pairs[].premiumToken and pairs[].minPremium'); return {quoteToken:required(p,'quoteToken'),premiumToken:required(p,'premiumToken')};});
  const allowed=new Set(required(r,'supportedTokens').map(a=>a.toLowerCase()));
  for(const token of [t.underlying,t.collateral,...pairs.flatMap(p=>[p.quoteToken,p.premiumToken])]) if(!allowed.has(token.toLowerCase())) throw new Error(`Unsupported token ${token}`);
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
  const validator=r.bidRules??release?.addresses?.IvyBidRules;
  if(!validator) throw new Error('Missing bidRules validator address');
  const call=t.collateral.toLowerCase()===t.underlying.toLowerCase();
  const limits=r.pairs.map(p=>{
    const market=required(r,'marketQuotes')[p.quoteToken.toLowerCase()];
    if(!market) throw new Error('Missing market quote for pair');
    const spot=BigInt(required(market,'spot')), bps=BigInt(required(market,'outOfTheMoneyBps'));
    if(spot<=0n||bps<0n||(!call&&bps>=10000n)) throw new Error('Invalid strike inputs');
    return [p.quoteToken, call?(spot*(10000n+bps)+9999n)/10000n:spot*(10000n-bps)/10000n, BigInt(p.minPremium??0)];
  });
  const rules=[{validator,kind:RULE_KIND.PairLimits,data:encodePairLimits(limits)}];
  if(r.spotBand) {
    const b=r.spotBand;
    rules.push({validator,kind:RULE_KIND.SpotBand,data:encodeSpotBand(required(b,'priceFeed'),required(b,'maxPriceAge'),required(b,'maxInTheMoneyBps'))});
  }
  return {terms:t,pairs,rules,valueUsdE6,settlementMethodology:r.settlementMethodology};
}

/** @returns {Promise<any>} Prepared calldata or typed data; never sends a transaction. */
export async function prepareOperation(provider, artifacts, command, r) {
  let release;
  if (r.registry && !['register-version','recommend-version'].includes(command)) {
    release=await resolveRelease(provider,r,artifacts,{allowRecommended:command==='prepare-vault'});
    r={...r,hub:release.hub}; artifacts=release.artifacts;
  }
  const chainId=String((await provider.getNetwork()).chainId);
  const runner=new VoidSigner(required(r,'sender'),provider);
  const hub=r.hub?new Contract(r.hub,artifacts.IvyVaultsHub.abi,runner):null;
  const domain=(name,version,address)=>({name,version,chainId,verifyingContract:address});
  if(command==='inspect-settlement') return {chainId,...await inspectSettlement(provider,hub,r),...(release?{release:{registry:release.registry,releaseId:release.releaseId,hub:release.hub,manifestHash:release.manifestHash}}:{})};
  if(command==='typed-report') {
    if(r.kind!=='spot') throw new Error('Report kind must be spot');
    return {pricingAuthority:'indicative activation only; does not supply cash vault settlement prices',domain:domain('IvyPriceFeed','1',required(r,'feed')),types:REPORT_TYPES,value:fields(REPORT_TYPES.SpotReport,r.report)};
  }
  if(command==='typed-bid') {
    const [s,collateralAmount,termsHash]=await Promise.all([hub.stateOf(r.vaultId),hub.totalShares(r.vaultId),hub.termsHashOf(r.vaultId)]);
    const value={...r.bid,vaultId:r.vaultId,expiry:s.expiry,auctionId:s.auctionId,collateralAmount,termsHash,executor:r.bid.executor??ZeroAddress,recipient:r.bid.recipient??r.bid.marketMaker};
    return {domain:domain('IvyVaultsHub','3',r.hub),types:BID_TYPES,value:fields(BID_TYPES.Bid,value),
      ...(Number(r.bid.settlement)===1?{fallbackTerms:fallbackTerms(s.expiry,s.expiryPricePublicationWindow,s.exerciseWindow)}:{})};
  }
  if(command==='typed-unwind') {
    const address=await hub.unwind(), module=new Contract(address,artifacts.IvyUnwind.abi,provider), a=await module.agreements(r.vaultId);
    return {domain:domain('IvyUnwind','1',address),types:UNWIND_TYPES,value:fields(UNWIND_TYPES.UnwindAgreement,a)};
  }
  if(command==='typed-unwind-proposal') {
    const address=await hub.unwind();
    const [agreement,digest]=await hub.previewUnwind(required(r,'vaultId'),required(r,'deadline'),required(r,'refund'));
    return {domain:domain('IvyUnwind','1',address),types:UNWIND_TYPES,value:fields(UNWIND_TYPES.UnwindAgreement,agreement),digest};
  }
  let target=hub, method, args, detail;
  if(command==='register-version'||command==='recommend-version') {
    target=new Contract(required(r,'registry'),REGISTRY_ABI,runner);
    if(command==='register-version') {
      const verified=await verifyRelease(provider,required(r,'releaseBundle'),artifacts);
      if(r.hub && r.hub.toLowerCase()!==verified.hub.toLowerCase()) throw new Error('Hub and release mismatch');
      method='registerVersion';args=[required(r,'releaseId'),verified.hub,verified.manifestHash];
      detail={hub:verified.hub,manifestHash:verified.manifestHash,releaseId:r.releaseId};
    } else { method='setRecommendedVersion';args=[required(r,'releaseId')];detail={hub:await target.hubOf(r.releaseId),releaseId:r.releaseId}; }
  } else if(command==='prepare-vault') {
    detail=await prepareVault(provider,r,release); method='createVault';args=[detail.terms,detail.pairs,detail.rules];
    if(Number(detail.terms.allowedSettlement)!==0) detail.fallbackTerms=fallbackTerms(detail.terms.expiry,...await Promise.all([hub.expiryPricePublicationWindow(),hub.exerciseWindow()]));
  } else if(command==='inspect-bid'||command==='activate') {
    method='activate';args=[r.vaultId,r.bid,r.signature];
    const minimum=BigInt(required(r,'minTradeUsdE6')), price=BigInt(required(r,'collateralPriceUsdE6'));
    if(minimum<=0n||price<=0n) throw new Error('Explicit positive launch valuation and minimum required');
    const [s,t,amount,platformFeeBps]=await Promise.all([hub.stateOf(r.vaultId),hub.termsOf(r.vaultId),hub.totalShares(r.vaultId),hub.vaultPlatformFeeBps(r.vaultId)]);
    const token=new Contract(t.collateral,['function decimals() view returns(uint8)'],provider);
    const valueUsdE6=amount*price/(10n**BigInt(await token.decimals()));
    if(valueUsdE6<minimum) throw new Error('Below launch USD minimum at activation');
    const notional=notionalOf(s.isCall,amount,s.underlyingUnit,BigInt(r.bid.strike));
    const totalPremium=BigInt(r.bid.premium)*notional/s.underlyingUnit;
    const platformFee=totalPremium*platformFeeBps/10000n;
    detail={allowPartialExercise:t.allowPartialExercise,valueUsdE6,notional,totalPremium,platformFeeBps,platformFee,lpPremium:totalPremium-platformFee,
      ...(Number(r.bid.settlement)===1?{fallbackTerms:fallbackTerms(s.expiry,s.expiryPricePublicationWindow,s.exerciseWindow)}:{})};
  } else if(command==='exercise-fallback') {
    required(r,'amount');
    detail=await inspectSettlement(provider,hub,r);
    method='exercisePhysicalFallback';args=[r.vaultId,r.amount];
  } else if(command==='expire') {
    detail=await inspectSettlement(provider,hub,r);
    detail.expirationOutcome=detail.route==='FallbackExpired'?'PhysicalFallbackExpired':detail.originalSettlement==='Cash'?'CashExpiry':'PhysicalExpiry';
    method='expire';args=[r.vaultId];
  } else if(command==='publish-settlement-exercise'||command==='publish-settlement-expiry') {
    required(r,'hub'); target=hub;
    const vaultId=required(r,'vaultId');
    const exercise=command==='publish-settlement-exercise';
    const names=exercise?['price','observedAt','validUntil']:['price','validUntil'];
    const report=Object.fromEntries(names.map(name=>[name,required(r.report,name)]));
    const [terms,state]=await Promise.all([hub.termsOf(vaultId),hub.stateOf(vaultId)]);
    method=exercise?'publishExercisePrice':'publishExpiry';args=[vaultId,...names.map(name=>report[name])];
    if (typeof r.settlementMethodology !== 'string' || !r.settlementMethodology.trim()) throw new Error('Missing settlementMethodology artifact reference');
    detail={pricingAuthority:'authoritative cash settlement',hub:r.hub,vaultId,underlying:terms.underlying,quote:state.quoteToken,expiry:state.expiry,report,units:'integer quote-token units per whole underlying token',settlementMethodology:r.settlementMethodology};
  } else if(command==='set-cash-settlement-enabled') {
    required(r,'hub');
    const enabled=required(r,'enabled');
    if(typeof enabled!=='boolean') throw new Error('enabled must be boolean');
    const currentEnabled=await hub.cashSettlementEnabled();
    let publisherCheck;
    if(enabled) {
      const publisher=required(r,'publisher');
      if(publisher.toLowerCase()===ZeroAddress.toLowerCase()) throw new Error('Publisher must be nonzero');
      if(!await hub.hasRole(await hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(),publisher)) throw new Error('Nominated publisher lacks settlement publisher role');
      publisherCheck={publisher,authorized:true};
    }
    method='setCashSettlementEnabled';args=[enabled];
    detail={currentEnabled,proposedEnabled:enabled,publisherCheck};
  } else if(command==='grant-settlement-publisher'||command==='revoke-settlement-publisher') {
    required(r,'hub'); target=hub;
    method=command==='grant-settlement-publisher'?'grantRole':'revokeRole';
    args=[await target.SETTLEMENT_PRICE_PUBLISHER_ROLE(),required(r,'account')];
    detail={pricingAuthority:'authoritative cash settlement',account:r.account};
  } else if(command==='propose-unwind') {
    method='proposeUnwind';args=[required(r,'vaultId'),required(r,'deadline'),required(r,'refund'),required(r,'buyerSignature')];
  } else if(command==='publish-spot') {
    target=new Contract(required(r,'feed'),artifacts.IvyPriceFeed.abi,runner);
    detail={pricingAuthority:'indicative activation only; does not supply cash vault settlement prices'};
    method='publishSpot';args=[...REPORT_TYPES.SpotReport.map(f=>required(r.report,f.name)),r.signature];
  } else {
    const actions={'set-platform-fee':['setPlatformFeeBps',[r.rateBps]],'set-platform-treasury':['setPlatformTreasury',[r.recipient]],'set-transfers':['setTransfersEnabled',[r.enabled]],deposit:['deposit',[r.vaultId,r.amount]],withdraw:['withdraw',[r.vaultId,r.amount]],'open-auction':['openAuction',[r.vaultId]],'cancel-auction':['cancelAuction',[r.vaultId]],expire:['expire',[r.vaultId]],exercise:['exercise',[r.vaultId,r.amount]],'claim-premium':['claimPremium',[r.vaultId]],claim:['claim',[r.vaultId,r.amount]],'claim-payout':['claimPayout',[r.vaultId]],'set-execution':['setExecution',[r.vaultId,r.executor,r.recipient]],'approve-unwind':['approveUnwind',[r.vaultId,r.nonce]],'revoke-unwind':['revokeUnwind',[r.vaultId]],'fund-unwind':['fundUnwind',[r.vaultId,r.nonce,r.amount]],'withdraw-unwind-contribution':['withdrawUnwindContribution',[r.vaultId,r.nonce]],'execute-unwind':['executeUnwind',[r.vaultId,r.nonce,r.signature]],pause:['setAdmissionPause',[r.vaultId,r.paused]],'grant-role':['grantRole',[r.role?id(r.role):undefined,r.account]]};
    if(command==='claim-platform-fee') {
      target=new Contract(await hub.vaultOf(r.vaultId),artifacts.IvyVault.abi,runner);method='claimPlatformFee';args=[];
    } else if(command==='approve-token') {
      target=new Contract(r.token,['function approve(address,uint256) returns(bool)'],runner);
      method='approve';args=[await hub.vaultOf(r.vaultId),r.amount];
    } else {
      if(!actions[command]) throw new Error(`Unknown command ${command}`);
      [method,args]=actions[command];
    }
  }
  await target[method].staticCall(...args);
  const data=target.interface.encodeFunctionData(method,args);
  return {chainId,from:r.sender,to:await target.getAddress(),data,value:'0',method,detail,...(release?{release:{registry:release.registry,releaseId:release.releaseId,hub:release.hub,manifestHash:release.manifestHash}}:{})};
}

async function readJournal(file) {
  try {return JSON.parse(await readFile(file,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e; return {};}
}
const persistTo = file => async j=>{await writeFile(file+'.tmp',json(j));await rename(file+'.tmp',file);};

async function main() {
  const [command,file,...flags]=process.argv.slice(2);
  if(!command||!file) throw new Error('Usage: npm run operator -- <command> request.json [--send]. Default: preflight and calldata only.');
  const r=JSON.parse(await readFile(file,'utf8'));
  const provider=new JsonRpcProvider(required(r,'rpc'));
  const artifacts=await loadArtifacts();
  if(r.releaseBundleFile) r.releaseBundle=JSON.parse(await readFile(r.releaseBundleFile,'utf8'));
  if(command==='prepare-release-bundle') {
    const manifest=JSON.parse(await readFile(r.planFile,'utf8'));
    const journal=JSON.parse(await readFile(r.journalFile,'utf8'));
    const bundle={format:1,interfaceFormat:RELEASE_FORMAT,manifest,journal,artifacts};
    await verifyRelease(provider,bundle,artifacts);console.log(json(bundle));return;
  }
  if(command==='prepare-registry-deployment'||command==='deploy-registry') {
    const artifact=JSON.parse(await readFile(new URL('../artifacts/contracts/IvyVaultsRegistry.sol/IvyVaultsRegistry.json',import.meta.url),'utf8'));
    if(command==='prepare-registry-deployment') {
      console.log(json(await buildRegistryDeploymentPlan({...r,artifact,chainId:(await provider.getNetwork()).chainId,genesisHash:(await provider.getBlock(0)).hash,startNonce:await provider.getTransactionCount(r.deployer,'pending')})));return;
    }
    if(!flags.includes('--send')) throw new Error('Registry deployment requires --send');
    const plan=JSON.parse(await readFile(r.planFile,'utf8'));
    console.log(json(await resumeRegistryDeployment(await provider.getSigner(plan.deployer),plan,artifact,await readJournal(r.journalFile),persistTo(r.journalFile))));return;
  }
  if(command==='prepare-deployment') {
    const plan=await buildDeploymentPlan({...r,artifacts,chainId:(await provider.getNetwork()).chainId,genesisHash:(await provider.getBlock(0)).hash,startNonce:await provider.getTransactionCount(r.deployer,'pending')});
    console.log(json(plan));return;
  }
  if(command==='deploy') {
    if(!flags.includes('--send')) throw new Error('Deploy requires --send; prepare-deployment is read-only');
    const plan=JSON.parse(await readFile(r.planFile,'utf8'));
    // Rebuild constructor transactions from this checkout before trusting a saved plan.
    const rebuilt=await buildDeploymentPlan({...plan,artifacts});
    if(json(rebuilt)!==json(plan)) throw new Error('Saved deployment plan does not match this build');
    const signer=await provider.getSigner(plan.deployer);
    console.log(json(await resumeDeployment(signer,plan,await readJournal(r.journalFile),persistTo(r.journalFile))));return;
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
