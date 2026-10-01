import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { getCreateAddress } from "ethers"
import hre, { artifacts, type network } from "hardhat"

import {
	RULE_KIND,
	encodeExpiryDates,
	encodePremiumVolFloor,
	encodePremiumMin,
	encodePremiumSpotFloor,
	encodeStrikeRange,
	encodeStrikeSpotBand,
	encodeExpiryTenor,
	encodePremiumYieldFloor,
} from "../../scripts/encoding.ts"

export type Connection = Awaited<ReturnType<typeof network.create>>

export const EXERCISE_WINDOW = 3600n
export const AUCTION_TIMEOUT = 3n * 24n * 3600n
export const EXPIRY_PRICE_PUBLICATION_WINDOW = 3600n
export const THIRTY_DAYS = 30n * 24n * 3600n
/** Upper tenor bound of the default ExpiryTenor rule: loose enough that only expiry tests meet it. */
export const DEFAULT_MAX_TENOR = 365n * 24n * 3600n
/** StrikeSpotBand out-of-the-money bound that never binds: no ceiling for calls, no floor for puts. */
export const NO_OTM_LIMIT = 2 ** 32 - 1
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

/** One pair's StrikeRange and PremiumMin values, which tests usually set together. */
export interface PairBoundsInput {
	quoteToken: string
	minStrike: bigint
	maxStrike: bigint
	minPremiumPerUnit: bigint
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
	const bidRules = await ethers.deployContract("IvyStandardBidRules", [await feed.getAddress()])
	const vaultImpl = await ethers.deployContract("IvyVault")
	const vaultImplAddress = await vaultImpl.getAddress()
	const rules = await new ethers.ContractFactory([], (await artifacts.readArtifact("IvyVaultRules")).bytecode, admin).deploy()
	const settlement = await new ethers.ContractFactory([], (await artifacts.readArtifact("IvyOptionSettlement")).bytecode, admin).deploy()
	const libraries = { IvyVaultRules: await rules.getAddress(), IvyOptionSettlement: await settlement.getAddress() }
	const nonce = await admin.getNonce()
	const [hubAddress, sharesAddress, premiumsAddress] = [0, 1, 2].map(i => getCreateAddress({ from: admin.address, nonce: nonce + i }))
	const hub = await ethers.deployContract(
		"IvyVaultsHub",
		[
			admin.address,
			vaultImplAddress,
			sharesAddress,
			premiumsAddress,
			await bidRules.getAddress(),
			EXERCISE_WINDOW,
			AUCTION_TIMEOUT,
			EXPIRY_PRICE_PUBLICATION_WINDOW,
		],
		{ libraries },
	)
	const shares = await ethers.deployContract("IvyShares", [hubAddress, premiumsAddress, "ipfs://ivy/{id}.json"])
	const premiums = await ethers.deployContract("IvyPremiums", [hubAddress, sharesAddress])
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

/** Test default: explicit one-raw-unit call strike and premium floors, no strike ceiling. */
export function callBounds(ctx: IvyContext, o: Partial<PairBoundsInput> = {}): PairBoundsInput[] {
	return [{ quoteToken: ctx.usdcAddress, minStrike: 1n, maxStrike: MAX_UINT, minPremiumPerUnit: 1n, ...o }]
}

/** Test default: explicit 3,000 USDC put ceiling and one-raw-unit strike and premium floors. */
export function putBounds(ctx: IvyContext, o: Partial<PairBoundsInput> = {}): PairBoundsInput[] {
	return [{ quoteToken: ctx.usdcAddress, minStrike: 1n, maxStrike: 3000n * USDC_UNIT, minPremiumPerUnit: 1n, ...o }]
}

export function strikeRangeRule(ctx: IvyContext, bounds: PairBoundsInput[]): BidRuleInput {
	return {
		validator: ctx.bidRulesAddress,
		kind: RuleKind.StrikeRange,
		data: encodeStrikeRange(bounds.map(b => [b.quoteToken, b.minStrike, b.maxStrike])),
	}
}

export function premiumMinRule(ctx: IvyContext, bounds: PairBoundsInput[]): BidRuleInput {
	return { validator: ctx.bidRulesAddress, kind: RuleKind.PremiumMin, data: encodePremiumMin(bounds.map(b => [b.quoteToken, b.minPremiumPerUnit])) }
}

/** The two required per-pair rules: StrikeRange then PremiumMin. */
export function pairBoundsRules(ctx: IvyContext, bounds: PairBoundsInput[]): BidRuleInput[] {
	return [strikeRangeRule(ctx, bounds), premiumMinRule(ctx, bounds)]
}

export function strikeSpotBandRule(
	ctx: IvyContext,
	o: { priceFeed?: string; maxPriceAge: number; maxInTheMoneyBps: number; maxOutOfTheMoneyBps?: number },
): BidRuleInput {
	return {
		validator: ctx.bidRulesAddress,
		kind: RuleKind.StrikeSpotBand,
		data: encodeStrikeSpotBand(o.priceFeed ?? ctx.feedAddress, o.maxPriceAge, o.maxInTheMoneyBps, o.maxOutOfTheMoneyBps ?? NO_OTM_LIMIT),
	}
}

export function premiumYieldFloorRule(ctx: IvyContext, o: { priceFeed?: string; maxPriceAge: number; minAprBps: number }): BidRuleInput {
	return {
		validator: ctx.bidRulesAddress,
		kind: RuleKind.PremiumYieldFloor,
		data: encodePremiumYieldFloor(o.priceFeed ?? ctx.feedAddress, o.maxPriceAge, o.minAprBps),
	}
}

export function expiryTenorRule(ctx: IvyContext, minTenor = 0n, maxTenor = DEFAULT_MAX_TENOR): BidRuleInput {
	return { validator: ctx.bidRulesAddress, kind: RuleKind.ExpiryTenor, data: encodeExpiryTenor(minTenor, maxTenor) }
}

export function expiryDatesRule(ctx: IvyContext, notBefore: bigint, notAfter: bigint): BidRuleInput {
	return { validator: ctx.bidRulesAddress, kind: RuleKind.ExpiryDates, data: encodeExpiryDates(notBefore, notAfter) }
}

export function premiumVolFloorRule(ctx: IvyContext, minVolBps: number): BidRuleInput {
	return { validator: ctx.bidRulesAddress, kind: RuleKind.PremiumVolFloor, data: encodePremiumVolFloor(minVolBps) }
}

export function premiumSpotFloorRule(ctx: IvyContext, o: { priceFeed?: string; maxPriceAge: number; minPremiumBps: number }): BidRuleInput {
	return {
		validator: ctx.bidRulesAddress,
		kind: RuleKind.PremiumSpotFloor,
		data: encodePremiumSpotFloor(o.priceFeed ?? ctx.feedAddress, o.maxPriceAge, o.minPremiumBps),
	}
}

export async function createVaultAs(
	ctx: IvyContext,
	signer: HardhatEthersSigner,
	terms: VaultTermsInput,
	pairs: PairConfigInput[],
	rules?: BidRuleInput[],
) {
	const bidRules = rules ?? [...pairBoundsRules(ctx, terms.collateral === terms.underlying ? callBounds(ctx) : putBounds(ctx)), expiryTenorRule(ctx)]
	await (await ctx.hub.connect(signer).createVault(terms, pairs, bidRules)).wait()
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
