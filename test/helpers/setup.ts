import { ZeroAddress } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import type { network } from "hardhat";

export type Connection = Awaited<ReturnType<typeof network.create>>;

export const EXERCISE_WINDOW = 6n * 3600n;
export const AUCTION_TIMEOUT = 3n * 24n * 3600n;
export const SETTLEMENT_GRACE = 7n * 24n * 3600n;
export const THIRTY_DAYS = 30n * 24n * 3600n;
export const WETH_UNIT = 10n ** 18n;
export const USDC_UNIT = 10n ** 6n;
export const MAX_UINT = (1n << 256n) - 1n;

export const ExerciseStyle = { European: 0, American: 1 } as const;
export const ExercisePolicy = { European: 0, American: 1, Either: 2 } as const;
export const SettlementType = { Physical: 0, Cash: 1 } as const;
export const SettlementPolicy = { Physical: 0, Cash: 1, Either: 2 } as const;
export const Phase = { Open: 0, Auction: 1, Live: 2, Settled: 3 } as const;
export const OptionKind = { CoveredCall: 0, CashSecuredPut: 1 } as const;

export interface VaultTermsInput {
  underlying: string;
  collateral: string;
  publicDeposits: boolean;
  allowedExercise: number;
  allowedSettlement: number;
  maxTenor: bigint;
  auctionStartsAt: bigint;
  minCollateral: bigint;
  priceFeed: string;
  maxSpotDeviationBps: number;
  maxPriceAge: number;
}

export interface PairTermsInput {
  premiumToken: string;
  strikeLimit: bigint;
  minPremium: bigint;
  enabled: boolean;
}

export interface PairInput {
  quoteToken: string;
  terms: PairTermsInput;
}

/** Deploys tokens, feed, vault implementation, hub implementation and the ERC1967 proxy; grants roles. */
export async function deployIvy(connection: Connection) {
  const { ethers, networkHelpers } = connection;
  const [admin, bidMaster, marketMaker, alice, bob, carol] = await ethers.getSigners();

  const weth = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
  const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
  const dai = await ethers.deployContract("MockERC20", ["Dai", "DAI", 18]);
  const feed = await ethers.deployContract("MockPriceFeed");
  const vaultImpl = await ethers.deployContract("IvyVault");
  const hubImpl = await ethers.deployContract("IvyVaultsHub");

  const vaultImplAddress = await vaultImpl.getAddress();
  const initData = hubImpl.interface.encodeFunctionData("initialize", [
    admin.address,
    vaultImplAddress,
    EXERCISE_WINDOW,
    AUCTION_TIMEOUT,
    SETTLEMENT_GRACE,
    "ipfs://ivy/{id}.json",
  ]);
  const proxy = await ethers.deployContract("ERC1967Proxy", [await hubImpl.getAddress(), initData]);
  const hubAddress = await proxy.getAddress();
  const hub = await ethers.getContractAt("IvyVaultsHub", hubAddress);

  await (await hub.grantRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).wait();
  await (await hub.grantRole(await hub.MARKET_MAKER_ROLE(), marketMaker.address)).wait();

  return {
    connection,
    ethers,
    networkHelpers,
    hub,
    hubAddress,
    hubImpl,
    vaultImpl,
    vaultImplAddress,
    weth,
    usdc,
    dai,
    feed,
    wethAddress: await weth.getAddress(),
    usdcAddress: await usdc.getAddress(),
    daiAddress: await dai.getAddress(),
    feedAddress: await feed.getAddress(),
    admin,
    bidMaster,
    marketMaker,
    alice,
    bob,
    carol,
  };
}

export type IvyContext = Awaited<ReturnType<typeof deployIvy>>;

/** Covered call on WETH, quoted in USDC, physical only, no feed. */
export function callTerms(ctx: IvyContext, o: Partial<VaultTermsInput> = {}): VaultTermsInput {
  return {
    underlying: ctx.wethAddress,
    collateral: ctx.wethAddress,
    publicDeposits: true,
    allowedExercise: ExercisePolicy.Either,
    allowedSettlement: SettlementPolicy.Physical,
    maxTenor: THIRTY_DAYS,
    auctionStartsAt: 0n,
    minCollateral: 0n,
    priceFeed: ZeroAddress,
    maxSpotDeviationBps: 0,
    maxPriceAge: 0,
    ...o,
  };
}

/** Cash-secured put on WETH, collateral USDC. */
export function putTerms(ctx: IvyContext, o: Partial<VaultTermsInput> = {}): VaultTermsInput {
  return callTerms(ctx, { collateral: ctx.usdcAddress, ...o });
}

export function callPairs(ctx: IvyContext, o: Partial<PairTermsInput> = {}): PairInput[] {
  return [
    {
      quoteToken: ctx.usdcAddress,
      terms: { premiumToken: ctx.usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true, ...o },
    },
  ];
}

export function putPairs(ctx: IvyContext, o: Partial<PairTermsInput> = {}): PairInput[] {
  return [
    {
      quoteToken: ctx.usdcAddress,
      terms: { premiumToken: ctx.usdcAddress, strikeLimit: MAX_UINT, minPremium: 0n, enabled: true, ...o },
    },
  ];
}

export async function createVaultAs(
  ctx: IvyContext,
  signer: HardhatEthersSigner,
  terms: VaultTermsInput,
  pairs: PairInput[],
) {
  await (await ctx.hub.connect(signer).createVault(terms, pairs)).wait();
  const vaultId = await ctx.hub.vaultCount();
  const vaultAddress = await ctx.hub.vaultOf(vaultId);
  const vault = await ctx.ethers.getContractAt("IvyVault", vaultAddress);
  return { vaultId, vault, vaultAddress };
}

/** Mints `amount` to `holder` and approves `spender` for exactly `amount`. */
export async function fund(
  ctx: IvyContext,
  token: IvyContext["weth"],
  holder: HardhatEthersSigner,
  spender: string,
  amount: bigint,
) {
  void ctx;
  await (await token.mint(holder.address, amount)).wait();
  await (await token.connect(holder).approve(spender, amount)).wait();
}
