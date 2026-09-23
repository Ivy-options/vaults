import { rejects } from 'node:assert/strict';
import { expect } from 'chai';
import { network } from 'hardhat';
import { Contract, ZeroAddress } from 'ethers';
import { loadArtifacts, prepareOperation } from '../scripts/operator.mjs';
import { buildDeploymentPlan, resumeDeployment } from '../scripts/deployment.mjs';
import { deployIvy, SettlementType } from './helpers/setup.js';
import { goLive } from './helpers/scenarios.js';

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const W = 10n ** 18n, U = 10n ** 6n;

describe('local operator rehearsal', function () {
  it('shows fixed fallback terms in bids and inspects required payment before explicit physical exercise', async function () {
    const c=await deployIvy(connection), artifacts=await loadArtifacts();
    const live=await goLive(c,{withFeed:true},{settlement:SettlementType.Cash});
    const request={hub:c.hubAddress,sender:c.marketMaker.address,vaultId:live.vaultId};
    const typed=await prepareOperation(c.admin.provider,artifacts,'typed-bid',{...request,bid:live.bid});
    expect(typed.fallbackTerms.publicationDeadline).eq(live.bid.expiry+3600n);
    expect(typed.fallbackTerms.fallbackDeadline).eq(live.bid.expiry+7200n);
    const status=await prepareOperation(c.admin.provider,artifacts,'inspect-settlement',request);
    expect(status.originalSettlement).eq('Cash');
    expect(status.route).eq('Cash');
    expect(status.publicationDeadline).eq(live.bid.expiry+3600n);
    expect(status.fallbackDeadline).eq(live.bid.expiry+7200n);
    expect(status.physicalExercisePreview.available).eq(false);
    expect(status.physicalExercisePreview.payment.token).eq(c.usdcAddress);
    expect(status.physicalExercisePreview.payment.amount).eq(30000n*U);
    expect(status.physicalExercisePreview.payment.spender).eq(live.vaultAddress);
    expect(status.physicalExercisePreview.payment.sufficientAllowance).eq(true);
    expect(status).not.have.property('to');
    await networkHelpers.time.increaseTo(status.publicationDeadline);
    const fallback=await prepareOperation(c.admin.provider,artifacts,'inspect-settlement',request);
    expect(fallback.route).eq('PhysicalFallback');
    expect(fallback.canExpire).eq(false);
    expect(fallback.physicalExercisePreview.available).eq(true);
    await rejects(prepareOperation(c.admin.provider,artifacts,'exercise',{...request,amount:10n*W}));
    const exercise=await prepareOperation(c.admin.provider,artifacts,'exercise-fallback',{...request,amount:10n*W});
    expect(exercise.method).eq('exercisePhysicalFallback');
    expect(exercise.detail.physicalExercisePreview.payment.amount).eq(30000n*U);
    await c.marketMaker.sendTransaction({to:exercise.to,data:exercise.data});
    expect(await c.weth.balanceOf(c.marketMaker.address)).eq(10n*W);
    expect((await c.hub.stateOf(live.vaultId)).settlement).eq(SettlementType.Cash);
  });
  it('reports unfunded put fallback and permits LP recovery on the first transaction after its deadline', async function () {
    const c=await deployIvy(connection), artifacts=await loadArtifacts();
    const live=await goLive(c,{isCall:false,withFeed:true},{settlement:SettlementType.Cash});
    const request={hub:c.hubAddress,sender:c.marketMaker.address,vaultId:live.vaultId};
    await networkHelpers.time.increaseTo(live.bid.expiry+3600n);
    const status=await prepareOperation(c.admin.provider,artifacts,'inspect-settlement',request);
    expect(status.route).eq('PhysicalFallback');
    expect(status.physicalExercisePreview.payment.token).eq(c.wethAddress);
    expect(status.physicalExercisePreview.payment.amount).eq(10n*W);
    expect(status.physicalExercisePreview.payment.sufficientAllowance).eq(false);
    expect(status.physicalExercisePreview.payment.sufficientBalance).eq(false);
    expect(status.physicalExercisePreview.delivery).deep.eq({token:c.usdcAddress,amount:30000n*U});
    await networkHelpers.time.increaseTo(status.fallbackDeadline+100n);
    const expired=await prepareOperation(c.admin.provider,artifacts,'inspect-settlement',request);
    expect(expired.route).eq('FallbackExpired');
    expect(expired.canExpire).eq(true);
    expect(expired.physicalExercisePreview.available).eq(false);
    const expire=await prepareOperation(c.admin.provider,artifacts,'expire',{...request,sender:c.bob.address});
    expect(expire.detail.expirationOutcome).eq('PhysicalFallbackExpired');
    expect(expire.detail.remainingNotional).eq(10n*W);
    await c.bob.sendTransaction({to:expire.to,data:expire.data});
    await c.hub.connect(c.alice).claim(live.vaultId,30000n*U);
    expect(await c.usdc.balanceOf(c.alice.address)).eq(30000n*U);
  });
  it('settles physical options with cash disabled, then explicitly enables cash settlement and rehearses recovery', async function () {
    const [admin, owner, buyer, lp, sponsor] = await ethers.getSigners();
    const provider = admin.provider!;
    const weth = await ethers.deployContract('MockERC20', ['Wrapped Ether', 'WETH', 18]);
    const usdc = await ethers.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);
    const w = await weth.getAddress(), u = await usdc.getAddress();
    const artifacts = await loadArtifacts();
    const plan = await buildDeploymentPlan({ artifacts, chainId: (await provider.getNetwork()).chainId,
      genesisHash: (await provider.getBlock(0))!.hash, deployer: admin.address, startNonce: await admin.getNonce(),
      admin: admin.address, reportSigner: admin.address, exerciseWindow:3600, expiryPricePublicationWindow:3600 });
    expect(plan.version).eq(7);
    expect(plan.steps).length(9);
    expect(plan.addresses).not.have.property('IvySettlementPriceFeed');
    expect((await resumeDeployment(admin, plan)).complete).eq(true);
    const hub: any = new Contract(plan.addresses.IvyVaultsHub, artifacts.IvyVaultsHub.abi, provider);
    expect(await hub.cashSettlementEnabled()).eq(false);
    const methodology = 'synthetic local rehearsal observations';
    const premiums: any = new Contract(plan.addresses.IvyPremiums, artifacts.IvyPremiums.abi, provider);
    async function op(command: string, signer: any, values: any = {}) {
      const prepared: any = await prepareOperation(provider, artifacts, command,
        { sender: signer.address, hub: plan.addresses.IvyVaultsHub, ...values });
      if (command.includes('settlement')) expect(prepared.to).eq(plan.addresses.IvyVaultsHub);
      if(command==='set-cash-settlement-enabled') {
        expect(prepared.detail.currentEnabled).eq(await hub.cashSettlementEnabled());
        expect(prepared.detail.proposedEnabled).eq(values.enabled);
        if(values.enabled) expect(prepared.detail.publisherCheck).deep.eq({publisher:values.publisher,authorized:true});
      }
      if(command.startsWith('publish-settlement')) {
        expect(prepared.detail.vaultId).eq(values.vaultId);
        expect(prepared.detail.underlying).eq(w);
        expect(prepared.detail.quote).eq(u);
        expect(prepared.detail.expiry).eq(expiry);
      }
      if(command==='prepare-vault'&&values.terms.allowedSettlement===1) {
        expect(prepared.detail.fallbackTerms.publicationDeadline).eq(expiry+3600n);
        expect(prepared.detail.fallbackTerms.fallbackDeadline).eq(expiry+7200n);
      }
      await (await signer.sendTransaction({ to: prepared.to, data: prepared.data })).wait();
    }
    async function typed(command: string, signer: any, values: any) {
      const payload: any = await prepareOperation(provider, artifacts, command,
        { sender: signer.address, hub: plan.addresses.IvyVaultsHub, ...values });
      return { value: payload.value, signature: await signer.signTypedData(payload.domain, payload.types, payload.value) };
    }
    await op('grant-role', admin, { role: 'BID_MASTER_ROLE', account: admin.address });
    await op('grant-role', admin, { role: 'MARKET_MAKER_ROLE', account: buyer.address });
    await weth.mint(owner.address, 10n * W);
    await usdc.mint(owner.address, 18000n * U);
    await usdc.mint(lp.address, 12000n * U);
    await usdc.mint(buyer.address, 2000n * U);
    await usdc.mint(sponsor.address, 100n * U);
    const expiry = BigInt(await networkHelpers.time.latest()) + 7200n;
    async function create(isCall: boolean, cash = true) {
      await op('prepare-vault', owner, {
        ...(cash ? { settlementMethodology: methodology } : {}),
        terms: { allowPartialExercise: false, underlying: w, collateral: isCall ? w : u, ...(isCall ? {} : { publicDeposits: true }),
          allowedExercise: cash ? 0 : 1, allowedSettlement: cash ? 1 : 0, expiry, auctionStartsAt: 0, maxSettlementPriceAge: cash ? 3600 : 0 },
        pairs: [{ quoteToken: u, premiumToken: u, minPremium: 100n * U }],
        bidRules: plan.addresses.IvyBidRules,
        ...(cash ? { spotBand: { priceFeed: plan.addresses.IvyPriceFeed, maxPriceAge: 3600, maxInTheMoneyBps: 1000 } } : {}),
        collateralAmount: isCall ? 10n * W : 18000n * U, collateralPriceUsdE6: isCall ? 3000n * U : U,
        minTradeUsdE6: 10000n * U, supportedTokens: [w, u], marketQuotes: { [u.toLowerCase()]: { spot: 3000n * U, outOfTheMoneyBps: 0 } }
      });
      const vaultId = await hub.vaultCount();
      for (const [signer, amount] of (isCall ? [[owner, 10n * W]] : [[owner, 18000n * U], [lp, 12000n * U]]) as any[]) {
        await op('approve-token', signer, { vaultId, token: isCall ? w : u, amount });
        await op('deposit', signer, { vaultId, amount });
      }
      await op('open-auction', owner, { vaultId });
      await op('approve-token', buyer, { vaultId, token: u, amount: 1000n * U });
      const bid = await typed('typed-bid', buyer, { vaultId, bid: { marketMaker: buyer.address, quoteToken: u,
        strike: 3000n * U, premium: 100n * U, style: cash ? 0 : 1, settlement: cash ? 1 : 0, validUntil: expiry, nonce: vaultId,
        executor: ZeroAddress, recipient: buyer.address } });
      const activate = { vaultId, bid: bid.value, signature: bid.signature, minTradeUsdE6: 10000n * U,
        collateralPriceUsdE6: isCall ? 3000n * U : U };
      await prepareOperation(provider, artifacts, 'inspect-bid', { sender: admin.address, hub: plan.addresses.IvyVaultsHub, ...activate });
      await op('activate', admin, activate);
      return vaultId;
    }
    const physical = await create(true, false);
    await usdc.mint(buyer.address, 30000n * U);
    await op('approve-token', buyer, { vaultId: physical, token: u, amount: 30000n * U });
    await op('exercise', buyer, { vaultId: physical, amount: 10n * W });
    await op('claim-premium', owner, { vaultId: physical });
    await op('claim', owner, { vaultId: physical, amount: 10n * W });
    expect(await hub.totalShares(physical)).eq(0n);
    expect(await weth.balanceOf(buyer.address)).eq(10n * W);
    expect(await hub.cashSettlementEnabled()).eq(false);
    // Reset the exercised asset balance and fund the subsequent cash examples explicitly.
    await weth.connect(buyer).transfer(owner.address, 10n * W);
    await usdc.mint(buyer.address, 1000n * U);
    await rejects(op('set-cash-settlement-enabled', admin, { enabled: true }), /Missing publisher/);
    await rejects(op('set-cash-settlement-enabled', admin, { enabled: 'true' }), /enabled must be boolean/);
    await rejects(op('set-cash-settlement-enabled', admin, { enabled: true, publisher: ZeroAddress }), /Publisher must be nonzero/);
    await rejects(op('set-cash-settlement-enabled', admin, { enabled: true, publisher: owner.address }), /lacks settlement publisher role/);
    await op('grant-settlement-publisher', admin, { account: owner.address });
    expect(await hub.cashSettlementEnabled()).eq(false);
    await rejects(op('set-cash-settlement-enabled', sponsor, { enabled: true, publisher: owner.address }));
    await op('set-cash-settlement-enabled', admin, { enabled: true, publisher: owner.address });
    expect(await hub.cashSettlementEnabled()).eq(true);
    const spot = { underlying: w, quote: u, price: 3000n * U, observedAt: BigInt(await networkHelpers.time.latest()), validUntil: expiry };
    await op('publish-spot', sponsor, { feed: plan.addresses.IvyPriceFeed, report: spot,
      signature: (await typed('typed-report', admin, { kind: 'spot', feed: plan.addresses.IvyPriceFeed, report: spot })).signature });
    const call = await create(true), put = await create(false);
    const exerciseReport = { price: spot.price, validUntil: spot.validUntil, observedAt: BigInt(await networkHelpers.time.latest()) };
    const exerciseRequest = { vaultId: call, report: exerciseReport,
      settlementMethodology: methodology };
    await rejects(op('publish-settlement-exercise', sponsor, exerciseRequest));
    await op('publish-settlement-exercise', owner, exerciseRequest);
    expect(await hub.exercisePrice(call)).deep.eq([exerciseReport.price,exerciseReport.observedAt,exerciseReport.validUntil]);
    expect(await hub.exercisePrice(put)).deep.eq([0n,0n,0n]);
    await op('set-cash-settlement-enabled', admin, { enabled: false });
    expect(await hub.cashSettlementEnabled()).eq(false);
    expect((await hub.termsOf(call)).publicDeposits).eq(false);
    await op('claim-premium', owner, { vaultId: call });
    expect(await premiums.claimable(call, owner.address)).eq(0n);
    const agreement = await typed('typed-unwind-proposal', buyer, { vaultId: put, deadline: expiry, refund: 100n * U });
    await rejects(op('propose-unwind', buyer, { vaultId: put, deadline: expiry, refund: 100n * U }), /Missing buyerSignature/);
    await op('propose-unwind', buyer, { vaultId: put, deadline: expiry, refund: 100n * U, buyerSignature: agreement.signature });
    await rejects(op('propose-unwind', owner, { vaultId: put, deadline: expiry, refund: 100n * U, buyerSignature: agreement.signature }));
    const stored = await typed('typed-unwind', buyer, { vaultId: put });
    expect(stored.value).deep.eq(agreement.value);
    for (const signer of [owner, lp]) await op('approve-unwind', signer, { vaultId: put, nonce: agreement.value.nonce });
    for (const [signer, amount] of [[owner,60n*U],[lp,40n*U]] as const) {
      await usdc.mint(signer.address,amount);
      await op('approve-token', signer, { vaultId: put, token: u, amount });
      await op('fund-unwind', signer, { vaultId: put, nonce: agreement.value.nonce, amount });
    }
    await op('execute-unwind', sponsor, { vaultId: put, nonce: agreement.value.nonce, signature: agreement.signature });
    await op('claim-payout', buyer, { vaultId: put });
    for (const [signer, amount] of [[owner, 18000n * U], [lp, 12000n * U]] as any[]) {
      await op('claim', signer, { vaultId: put, amount });
      await op('claim-premium', signer, { vaultId: put });
    }
    await networkHelpers.time.increaseTo(expiry + 60n);
    const report = { price: 4000n * U, validUntil: expiry + 90000n };
    const before = await hub.stateOf(call);
    const callAddress = await hub.vaultOf(call);
    await rejects(op('expire', sponsor, { vaultId: call }));
    expect((await hub.stateOf(call)).exercisedNotional).eq(before.exercisedNotional);
    expect(await weth.balanceOf(callAddress)).eq(10n * W);
    const settlementRequest = { vaultId: call, report,
      settlementMethodology: methodology };
    await rejects(op('publish-settlement-expiry', sponsor, settlementRequest));
    await op('grant-settlement-publisher', admin, { account: sponsor.address });
    await op('revoke-settlement-publisher', admin, { account: owner.address });
    expect(await hub.cashSettlementEnabled()).eq(false);
    await rejects(op('publish-settlement-expiry', owner, settlementRequest));
    await op('publish-settlement-expiry', sponsor, settlementRequest);
    await networkHelpers.time.increaseTo(expiry+7200n);
    const timely=await prepareOperation(provider,artifacts,'inspect-settlement',{sender:buyer.address,hub:plan.addresses.IvyVaultsHub,vaultId:call});
    expect(timely.route).eq('Cash');
    expect(timely.canExpire).eq(true);
    expect(timely.expirationTime).eq(expiry);
    expect(timely.physicalExercisePreview.available).eq(false);
    await op('expire', sponsor, { vaultId: call });
    await op('claim', owner, { vaultId: call, amount: 10n * W });
    await op('claim-payout', buyer, { vaultId: call });
    expect(await weth.balanceOf(buyer.address)).eq(25n * W / 10n);
    expect(await weth.balanceOf(owner.address)).eq(75n * W / 10n);
    for (const vaultId of [call, put]) {
      const address = await hub.vaultOf(vaultId);
      expect(await weth.balanceOf(address)).eq(0n);
      expect(await usdc.balanceOf(address)).eq(0n);
      expect(await hub.totalShares(vaultId)).eq(0n);
    }
  });
});
