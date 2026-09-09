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
  it('deploys, signs and settles a private cash call, then unwinds a pooled put through prepared operator transactions', async function () {
    const [admin, owner, buyer, lp, sponsor] = await ethers.getSigners();
    const provider = admin.provider!;
    const weth = await ethers.deployContract('MockERC20', ['Wrapped Ether', 'WETH', 18]);
    const usdc = await ethers.deployContract('MockERC20', ['USD Coin', 'USDC', 6]);
    const w = await weth.getAddress(), u = await usdc.getAddress();
    const artifacts = await loadArtifacts();
    const plan = await buildDeploymentPlan({ artifacts, chainId: (await provider.getNetwork()).chainId,
      genesisHash: (await provider.getBlock(0))!.hash, deployer: admin.address, startNonce: await admin.getNonce(),
      admin: admin.address, reportSigner: admin.address, settlementAdmin: admin.address, settlementPublisher: owner.address,
      settlementMethodology: 'synthetic local rehearsal observations' });
    expect((await resumeDeployment(admin, plan)).complete).eq(true);
    const hub: any = new Contract(plan.addresses.IvyVaultsHub, artifacts.IvyVaultsHub.abi, provider);
    const premiums: any = new Contract(plan.addresses.IvyPremiums, artifacts.IvyPremiums.abi, provider);
    async function op(command: string, signer: any, values: any = {}) {
      const prepared: any = await prepareOperation(provider, artifacts, command,
        { sender: signer.address, hub: plan.addresses.IvyVaultsHub, ...values });
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
    async function create(isCall: boolean) {
      await op('prepare-vault', owner, {
        settlementMethodology: plan.settlementMethodology,
        terms: { allowPartialExercise: false, underlying: w, collateral: isCall ? w : u, ...(isCall ? {} : { publicDeposits: true }),
          allowedExercise: 0, allowedSettlement: 1, expiry, auctionStartsAt: 0, priceFeed: plan.addresses.IvyPriceFeed,
          settlementPriceFeed: plan.addresses.IvySettlementPriceFeed, maxSettlementPriceAge: 3600, maxInTheMoneyBps: 1000, maxPriceAge: 3600 },
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
        strike: 3000n * U, premium: 100n * U, style: 0, settlement: 1, validUntil: expiry, nonce: vaultId,
        executor: ZeroAddress, recipient: buyer.address } });
      const activate = { vaultId, bid: bid.value, signature: bid.signature, minTradeUsdE6: 10000n * U,
        collateralPriceUsdE6: isCall ? 3000n * U : U };
      await prepareOperation(provider, artifacts, 'inspect-bid', { sender: admin.address, hub: plan.addresses.IvyVaultsHub, ...activate });
      await op('activate', admin, activate);
      return vaultId;
    }
    const spot = { underlying: w, quote: u, price: 3000n * U, observedAt: BigInt(await networkHelpers.time.latest()), validUntil: expiry };
    await op('publish-spot', sponsor, { feed: plan.addresses.IvyPriceFeed, report: spot,
      signature: (await typed('typed-report', admin, { kind: 'spot', feed: plan.addresses.IvyPriceFeed, report: spot })).signature });
    const call = await create(true), put = await create(false);
    const exerciseReport = { ...spot, observedAt: BigInt(await networkHelpers.time.latest()) };
    const exerciseRequest = { settlementFeed: plan.addresses.IvySettlementPriceFeed, report: exerciseReport,
      settlementMethodology: plan.settlementMethodology };
    await rejects(op('publish-settlement-exercise', sponsor, exerciseRequest));
    await op('publish-settlement-exercise', owner, exerciseRequest);
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
    const report = { underlying: w, quote: u, expiry, price: 4000n * U, validUntil: expiry + 90000n };
    const before = await hub.stateOf(call);
    const callAddress = await hub.vaultOf(call);
    await rejects(op('expire', sponsor, { vaultId: call }));
    expect((await hub.stateOf(call)).exercisedNotional).eq(before.exercisedNotional);
    expect(await weth.balanceOf(callAddress)).eq(10n * W);
    const settlementRequest = { settlementFeed: plan.addresses.IvySettlementPriceFeed, report,
      settlementMethodology: plan.settlementMethodology };
    await rejects(op('publish-settlement-expiry', sponsor, settlementRequest));
    await op('grant-settlement-publisher', admin, { settlementFeed: plan.addresses.IvySettlementPriceFeed, account: sponsor.address });
    await op('revoke-settlement-publisher', admin, { settlementFeed: plan.addresses.IvySettlementPriceFeed, account: owner.address });
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
