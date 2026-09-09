import { rejects } from 'node:assert/strict';
import { expect } from 'chai';
import { network } from 'hardhat';
import { Contract, ZeroAddress } from 'ethers';
import { loadArtifacts, prepareOperation } from '../scripts/operator.mjs';
import { buildDeploymentPlan, resumeDeployment } from '../scripts/deployment.mjs';

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const W = 10n ** 18n, U = 10n ** 6n;

describe('local operator rehearsal', function () {
  it('settles physical options with cash disabled, then explicitly enables cash settlement and rehearses recovery', async function () {
    const [admin, owner, buyer, lp, sponsor] = await ethers.getSigners();
    const provider = admin.provider!;
    const weth = await ethers.deployContract('MockERC20', ['Wrapped Ether', 'WETH', 18]);
    const usdc = await ethers.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);
    const w = await weth.getAddress(), u = await usdc.getAddress();
    const artifacts = await loadArtifacts();
    const plan = await buildDeploymentPlan({ artifacts, chainId: (await provider.getNetwork()).chainId,
      genesisHash: (await provider.getBlock(0))!.hash, deployer: admin.address, startNonce: await admin.getNonce(),
      admin: admin.address, reportSigner: admin.address });
    expect(plan.version).eq(6);
    expect(plan.steps).length(8);
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
          allowedExercise: cash ? 0 : 1, allowedSettlement: cash ? 1 : 0, expiry, auctionStartsAt: 0, priceFeed: cash ? plan.addresses.IvyPriceFeed : ZeroAddress,
          maxSettlementPriceAge: cash ? 3600 : 0, maxInTheMoneyBps: cash ? 1000 : 0, maxPriceAge: cash ? 3600 : 0 },
        pairs: [{ quoteToken: u, terms: { premiumToken: u, minPremium: 100n * U, enabled: true } }],
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
    await op('propose-unwind', buyer, { vaultId: put, deadline: expiry, refund: 100n * U });
    const agreement = await typed('typed-unwind', buyer, { vaultId: put });
    for (const signer of [owner, lp]) await op('approve-unwind', signer, { vaultId: put, nonce: agreement.value.nonce });
    await op('approve-token', sponsor, { vaultId: put, token: u, amount: 100n * U });
    await op('execute-unwind', sponsor, { vaultId: put, nonce: agreement.value.nonce, signature: agreement.signature });
    await op('claim-payout', buyer, { vaultId: put });
    for (const [signer, amount] of [[owner, 18000n * U], [lp, 12000n * U]] as any[]) {
      await op('claim', signer, { vaultId: put, amount });
      await op('claim-premium', signer, { vaultId: put });
    }
    await networkHelpers.time.increaseTo(expiry + 86400n);
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
