import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { getCreateAddress } from "ethers"
import hre, { artifacts, type network } from "hardhat"

import { RULE_KIND, encodePairLimits, encodePremiumFloor, encodeSpotBand } from "../../scripts/encoding.ts"

export type Connection = Awaited<ReturnType<typeof network.create>>

export const EXERCISE_WINDOW = 3600n
export const AUCTION_TIMEOUT = 3n * 24n * 3600n
export const EXPIRY_PRICE_PUBLICATION_WINDOW = 3600n
export const THIRTY_DAYS = 30n * 24n * 3600n
export const WETH_UNIT = 10n ** 18n
export const USDC_UNIT = 10n ** 6n
export const MAX_UINT = (1n << 256n) - 1n
/** EIP-170 cap on deployed runtime bytecode. */
export const MAX_RUNTIME_SIZE = 24_576

/** `amount` whole WETH in wei. */
export const weth = (amount: bigint | number) => BigInt(amount) * WETH_UNIT
/** `amount` whole USDC in base units. */
export const usdc = (amount: bigint | number) => BigInt(amount) * USDC_UNIT

export const ExerciseStyle = { European: 0, American: 1 } as const
export const ExercisePolicy = { European: 0, American: 1, Either: 2 } as const
export const SettlementType = { Physical: 0, Cash: 1 } as const
export const SettlementPolicy = { Physical: 0, Cash: 1, Either: 2 } as const
export const SettlementRoute = {
	Physical: 0,
	Cash: 1,
	AwaitingExpiryPrice: 2,
	PhysicalFallback: 3,
	FallbackExpired: 4,
	Inactive: 5,
} as const
export const Phase = { Open: 0, Auction: 1, Live: 2, Settled: 3 } as const
export const OptionKind = { CoveredCall: 0, CashSecuredPut: 1 } as const
/** Mirrors PayoutReceiver.Mode. */
export const PayoutReceiverMode = { Acknowledge: 0, WrongMagic: 1, Revert: 2, Reenter: 3, BurnGas: 4 } as const

export interface VaultTermsInput {
	underlying: string
	collateral: string
	allowPartialExercise: boolean
	publicDeposits: boolean
	allowedExercise: number
	allowedSettlement: number
	expiry: bigint
	auctionStartsAt: bigint
	minCollateral: bigint
	maxSettlementPriceAge: number
}

export interface PairConfigInput {
	quoteToken: string
	premiumToken: string
}

export interface BidRuleInput {
	validator: string
	kind: string
	data: string
}

export interface PairLimitInput {
	quoteToken: string
	strikeLimit: bigint
	minPremium: bigint
}

export const RuleKind = RULE_KIND

/** Deploys peers and grants trading roles. Cash scenarios explicitly grant a publisher and enable admissions. */
export async function deployIvy(connection: Connection, { enableCashSettlement = true, transfersEnabled = false } = {}) {
	const { ethers, networkHelpers } = connection
	const [admin, bidMaster, marketMaker, alice, bob, carol] = await ethers.getSigners()

	const weth = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18])
	const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6])
	const dai = await ethers.deployContract("MockERC20", ["Dai", "DAI", 18])
	const feed = await ethers.deployContract("MockPriceFeed")
	const bidRules = await ethers.deployContract("IvyBidRules")
	const vaultImpl = await ethers.deployContract("IvyVault")
	const vaultImplAddress = await vaultImpl.getAddress()
	const rules = await new ethers.ContractFactory([], (await artifacts.readArtifact("IvyVaultRules")).bytecode, admin).deploy()
	const settlement = await new ethers.ContractFactory([], (await artifacts.readArtifact("IvyOptionSettlement")).bytecode, admin).deploy()
	const libraries = { IvyVaultRules: await rules.getAddress(), IvyOptionSettlement: await settlement.getAddress() }
	const nonce = await admin.getNonce()
	const [hubAddress, sharesAddress, premiumsAddress, unwindAddress] = [0, 1, 2, 3].map(i =>
		getCreateAddress({ from: admin.address, nonce: nonce + i }),
	)
	const hub = await ethers.deployContract(
		"IvyVaultsHub",
		[
			admin.address,
			vaultImplAddress,
			sharesAddress,
			premiumsAddress,
			unwindAddress,
			EXERCISE_WINDOW,
			AUCTION_TIMEOUT,
			EXPIRY_PRICE_PUBLICATION_WINDOW,
		],
		{ libraries },
	)
	const shares = await ethers.deployContract("IvyShares", [hubAddress, premiumsAddress, unwindAddress, "ipfs://ivy/{id}.json"])
	const premiums = await ethers.deployContract("IvyPremiums", [hubAddress, sharesAddress])
	const unwind = await ethers.deployContract("IvyUnwind", [hubAddress, sharesAddress])
	const defaultExpiry = BigInt(await networkHelpers.time.latest()) + THIRTY_DAYS

	await (await hub.grantRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).wait()
	await (await hub.grantRole(await hub.MARKET_MAKER_ROLE(), marketMaker.address)).wait()
	if (enableCashSettlement) {
		await (await hub.grantRole(await hub.SETTLEMENT_PRICE_PUBLISHER_ROLE(), admin.address)).wait()
		await (await hub.setCashSettlementEnabled(true)).wait()
	}
	if (transfersEnabled) await (await hub.setTransfersEnabled(true)).wait()

	return {
		libraries,
		rules,
		settlement,
		connection,
		ethers,
		networkHelpers,
		hub,
		hubAddress,
		premiums,
		unwind,
		defaultExpiry,
		shares,
		sharesAddress,
		vaultImpl,
		vaultImplAddress,
		weth,
		usdc,
		dai,
		feed,
		bidRules,
		bidRulesAddress: await bidRules.getAddress(),
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
	}
}

export type IvyContext = Awaited<ReturnType<typeof deployIvy>>

type Snapshot = Awaited<ReturnType<Connection["networkHelpers"]["takeSnapshot"]>>

interface Chain {
	connection: Connection
	/** State at the first fixture load; every root fixture builds from here. */
	genesis?: Snapshot
	/** Fixtures whose snapshots are still valid, oldest first. */
	live: Array<() => Promise<unknown>>
}

const chains = new WeakMap<Connection, Chain>()

export interface Fixture<T> {
	(): Promise<T>
	readonly chain: Chain
}

/** The value a fixture (or any loader) resolves to. */
export type Loaded<F extends () => Promise<unknown>> = Awaited<ReturnType<F>>

/**
 * Returns a loader for `build`. The first call builds and snapshots; later calls revert to that
 * snapshot, so tests share setup but never state. Pass a connection to build from the chain's
 * genesis, or another fixture to build on top of its state.
 */
export function fixture<T>(connection: Connection, build: () => Promise<T>): Fixture<T>
export function fixture<P, T>(parent: Fixture<P>, build: (parent: P) => Promise<T>): Fixture<T>
export function fixture<P, T>(source: Connection | Fixture<P>, build: (parent?: P) => Promise<T>): Fixture<T> {
	const chain = typeof source === "function" ? source.chain : chainOf(source)
	let snapshot: Snapshot
	let data: T
	const load = async (): Promise<T> => {
		const depth = chain.live.indexOf(load)
		if (depth >= 0) {
			await snapshot.restore()
			// Reverting discards every snapshot taken after this one.
			chain.live.length = depth + 1
			return data
		}
		data = typeof source === "function" ? await build(await source()) : await resetThenBuild(chain, build)
		snapshot = await chain.connection.networkHelpers.takeSnapshot()
		chain.live.push(load)
		return data
	}
	return Object.assign(load, { chain })
}

function chainOf(connection: Connection): Chain {
	let chain = chains.get(connection)
	if (chain === undefined) chains.set(connection, (chain = { connection, live: [] }))
	return chain
}

async function resetThenBuild<T>(chain: Chain, build: () => Promise<T>): Promise<T> {
	if (chain.genesis === undefined) chain.genesis = await chain.connection.networkHelpers.takeSnapshot()
	else await chain.genesis.restore()
	chain.live.length = 0
	return build()
}

/**
 * Skips the enclosing suite under `hardhat test --coverage`. Instrumented bytecode outgrows EIP-170,
 * and deployment plans refuse contracts over that limit by design.
 */
export function skipUnderCoverage() {
	before(function () {
		if (hre.globalOptions.coverage) this.skip()
	})
}

/** Covered call on WETH, quoted in USDC, physical only, no feed. */
export function callTerms(ctx: IvyContext, o: Partial<VaultTermsInput> = {}): VaultTermsInput {
	return {
		underlying: ctx.wethAddress,
		collateral: ctx.wethAddress,
		allowPartialExercise: true,
		publicDeposits: true,
		allowedExercise: ExercisePolicy.Either,
		allowedSettlement: SettlementPolicy.Physical,
		expiry: ctx.defaultExpiry,
		auctionStartsAt: 0n,
		minCollateral: 0n,
		maxSettlementPriceAge: 0,
		...o,
	}
}

/** Cash-secured put on WETH, collateral USDC. */
export function putTerms(ctx: IvyContext, o: Partial<VaultTermsInput> = {}): VaultTermsInput {
	return callTerms(ctx, { collateral: ctx.usdcAddress, ...o })
}

export function callPairs(ctx: IvyContext): PairConfigInput[] {
	return [{ quoteToken: ctx.usdcAddress, premiumToken: ctx.usdcAddress }]
}

export function putPairs(ctx: IvyContext): PairConfigInput[] {
	return [{ quoteToken: ctx.usdcAddress, premiumToken: ctx.usdcAddress }]
}

/** Today's call default: no strike floor and no premium floor. */
export function callLimits(ctx: IvyContext, o: Partial<PairLimitInput> = {}): PairLimitInput[] {
	return [{ quoteToken: ctx.usdcAddress, strikeLimit: 0n, minPremium: 0n, ...o }]
}

/** Today's put default: no ceiling (max uint) and no premium floor. */
export function putLimits(ctx: IvyContext, o: Partial<PairLimitInput> = {}): PairLimitInput[] {
	return [{ quoteToken: ctx.usdcAddress, strikeLimit: MAX_UINT, minPremium: 0n, ...o }]
}

export function pairLimitsRule(ctx: IvyContext, limits: PairLimitInput[]): BidRuleInput {
	return {
		validator: ctx.bidRulesAddress,
		kind: RuleKind.PairLimits,
		data: encodePairLimits(limits.map(l => [l.quoteToken, l.strikeLimit, l.minPremium])),
	}
}

export function spotBandRule(ctx: IvyContext, o: { priceFeed?: string; maxPriceAge: number; maxInTheMoneyBps: number }): BidRuleInput {
	return {
		validator: ctx.bidRulesAddress,
		kind: RuleKind.SpotBand,
		data: encodeSpotBand(o.priceFeed ?? ctx.feedAddress, o.maxPriceAge, o.maxInTheMoneyBps),
	}
}

export function premiumFloorRule(ctx: IvyContext, o: { priceFeed?: string; maxPriceAge: number; minPremiumBps: number }): BidRuleInput {
	return {
		validator: ctx.bidRulesAddress,
		kind: RuleKind.PremiumFloor,
		data: encodePremiumFloor(o.priceFeed ?? ctx.feedAddress, o.maxPriceAge, o.minPremiumBps),
	}
}

export async function createVaultAs(
	ctx: IvyContext,
	signer: HardhatEthersSigner,
	terms: VaultTermsInput,
	pairs: PairConfigInput[],
	rules: BidRuleInput[] = [],
) {
	await (await ctx.hub.connect(signer).createVault(terms, pairs, rules)).wait()
	const vaultId = await ctx.hub.vaultCount()
	const vaultAddress = await ctx.hub.vaultOf(vaultId)
	const vault = await ctx.ethers.getContractAt("IvyVault", vaultAddress)
	return { vaultId, vault, vaultAddress }
}

export type CreatedVault = Awaited<ReturnType<typeof createVaultAs>>

/** Mints `amount` to `holder` and approves `spender` for exactly `amount`. */
export async function fund(ctx: IvyContext, token: IvyContext["weth"], holder: HardhatEthersSigner, spender: string, amount: bigint) {
	await (await token.mint(holder.address, amount)).wait()
	await (await token.connect(holder).approve(spender, amount)).wait()
}
