import { AbiCoder, keccak256, ZeroAddress } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import {
  ExerciseStyle, SettlementPolicy, SettlementType, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, fund, putPairs, putTerms,
  type IvyContext, type PairTermsInput, type VaultTermsInput,
} from "./setup.js";
import { signBid, type Bid } from "./bids.js";

export const STRIKE = 3000n * USDC_UNIT;        // 3000 USDC per WETH
export const PREMIUM = 100n * USDC_UNIT;        // 100 USDC per WETH
export const CALL_DEPOSIT = 10n * WETH_UNIT;    // 10 WETH → notional 10 WETH
export const PUT_DEPOSIT = 30_000n * USDC_UNIT; // 30,000 USDC → notional 10 WETH at strike 3000
export const TENOR = 7n * 24n * 3600n;
export const MM_BANKROLL = 1_000_000n * USDC_UNIT;

let nonceCounter = 1n;

/** Writes `price` into the mock feed, timestamped `ageSeconds` before the latest block. */
export async function setSpot(ctx: IvyContext, price: bigint, ageSeconds = 0n) {
  const now = BigInt(await ctx.networkHelpers.time.latest());
  await (await ctx.feed.set(ctx.wethAddress, ctx.usdcAddress, price, now - ageSeconds)).wait();
}

/** Makes the next mined block carry exactly `timestamp`. */
export async function at(ctx: IvyContext, timestamp: bigint) {
  await ctx.networkHelpers.time.setNextBlockTimestamp(timestamp);
}

export interface VaultOptions {
  isCall?: boolean;
  /** Attaches the mock feed: spot = STRIKE, 10% band, 1h max age, settlement Either. */
  withFeed?: boolean;
  /** alice's deposit. Defaults to CALL_DEPOSIT / PUT_DEPOSIT. */
  deposit?: bigint;
  extraDeposits?: Array<{ signer: HardhatEthersSigner; amount: bigint }>;
  terms?: Partial<VaultTermsInput>;
  pair?: Partial<PairTermsInput>;
}

/** alice creates a vault, funds it (plus any extra depositors) and opens the auction. */
export async function openVault(ctx: IvyContext, o: VaultOptions = {}) {
  const isCall = o.isCall ?? true;
  const feedTerms: Partial<VaultTermsInput> = o.withFeed
    ? { priceFeed: ctx.feedAddress, maxPriceAge: 3600, maxInTheMoneyBps: 1000, allowedSettlement: SettlementPolicy.Either }
    : {};
  const expiry = BigInt(await ctx.networkHelpers.time.latest()) + TENOR;
  const terms = isCall ? callTerms(ctx, { expiry, ...feedTerms, ...o.terms }) : putTerms(ctx, { expiry, ...feedTerms, ...o.terms });
  const pairs = isCall ? callPairs(ctx, o.pair) : putPairs(ctx, o.pair);
  const { vaultId, vault, vaultAddress } = await createVaultAs(ctx, ctx.alice, terms, pairs);

  const collateral = isCall ? ctx.weth : ctx.usdc;
  const deposit = o.deposit ?? (isCall ? CALL_DEPOSIT : PUT_DEPOSIT);
  await fund(ctx, collateral, ctx.alice, vaultAddress, deposit);
  await (await ctx.hub.connect(ctx.alice).deposit(vaultId, deposit)).wait();
  for (const extra of o.extraDeposits ?? []) {
    await fund(ctx, collateral, extra.signer, vaultAddress, extra.amount);
    await (await ctx.hub.connect(extra.signer).deposit(vaultId, extra.amount)).wait();
  }
  await (await ctx.hub.connect(ctx.alice).openAuction(vaultId)).wait();
  if (o.withFeed) await setSpot(ctx, STRIKE);
  return { vaultId, vault, vaultAddress, isCall, deposit };
}

export interface BidOptions {
  vaultId?: bigint;
  marketMaker?: string;
  quoteToken?: string;
  strike?: bigint;
  premium?: bigint;
  style?: number;
  settlement?: number;
  tenor?: bigint;
  expiry?: bigint;
  validFor?: bigint;
  nonce?: bigint;
  executor?: string;
  recipient?: string;
}

/** Physical American bid at STRIKE / PREMIUM expiring in TENOR, valid for one hour, fresh nonce. */
export async function makeBid(ctx: IvyContext, vaultId: bigint, o: BidOptions = {}): Promise<Bid> {
  const now = BigInt(await ctx.networkHelpers.time.latest());
  const state = await ctx.hub.stateOf(vaultId);
  const pair = await ctx.hub.pairTermsOf(vaultId, o.quoteToken ?? ctx.usdcAddress);
  return {
    vaultId: o.vaultId ?? vaultId,
    marketMaker: o.marketMaker ?? ctx.marketMaker.address,
    quoteToken: o.quoteToken ?? ctx.usdcAddress,
    strike: o.strike ?? STRIKE,
    premium: o.premium ?? PREMIUM,
    style: o.style ?? ExerciseStyle.American,
    settlement: o.settlement ?? SettlementType.Physical,
    expiry: o.expiry ?? (o.tenor ? now + o.tenor : state.expiry),
    validUntil: now + (o.validFor ?? 3600n),
    nonce: o.nonce ?? nonceCounter++,
    auctionId: state.auctionId,
    collateralAmount: await ctx.hub.totalShares(vaultId),
    pairHash: keccak256(AbiCoder.defaultAbiCoder().encode(["tuple(address premiumToken,uint256 strikeLimit,uint256 minPremium,bool enabled)"], [Array.from(pair)])),
    executor: o.executor ?? ZeroAddress,
    recipient: o.recipient ?? ctx.marketMaker.address,
  };
}

/** Funds the market maker with USDC (approved to the vault), signs as the market maker, activates as the bid master. */
export async function activate(ctx: IvyContext, vaultId: bigint, vaultAddress: string, o: BidOptions = {}) {
  const bid = await makeBid(ctx, vaultId, o);
  await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, MM_BANKROLL);
  const signature = await signBid(ctx.marketMaker, ctx.hubAddress, bid);
  await (await ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, signature)).wait();
  return { bid, signature };
}

/** create → fund → open auction → activate. */
export async function goLive(ctx: IvyContext, v: VaultOptions = {}, b: BidOptions = {}) {
  const opened = await openVault(ctx, v);
  const activated = await activate(ctx, opened.vaultId, opened.vaultAddress, b);
  return { ...opened, ...activated };
}
