import { expect } from "chai"
import { network } from "hardhat"

import { STRIKE, at, goLive, publishExpiryPrice, PREMIUM_TOTAL, type LiveVault } from "../helpers/scenarios.js"
import { EXERCISE_WINDOW, ExerciseStyle, SettlementType, deployIvy, fixture, fund, usdc, weth, type IvyContext } from "../helpers/setup.js"

const connection = await network.create()

interface Walk {
	/** Shares held by alice, bob and carol, in that order. */
	balances: bigint[]
	/** Premium claimed so far. */
	premiumClaimed: bigint
}

const holders = (c: IvyContext) => [c.alice, c.bob, c.carol]

/**
 * Thirty pseudo-random transfers, each moving a third of one holder's shares to another. A Lehmer
 * generator seeded at 19 picks the holders; alice claims her premium at step 8 and bob at step 17.
 * `afterStep` runs after every transfer.
 */
async function walkShares(c: IvyContext, v: LiveVault, start: bigint[], afterStep?: (walk: Walk) => Promise<void>) {
	const walk: Walk = { balances: [...start], premiumClaimed: 0n }
	const { balances } = walk
	const signers = holders(c)
	let seed = 19
	for (let step = 0; step < 30; step++) {
		seed = (seed * 48271) % 2147483647
		const from = seed % 3
		const to = (from + 1 + (seed % 2)) % 3
		const amount = balances[from] / 3n
		await c.shares.connect(signers[from]).safeTransferFrom(signers[from].address, signers[to].address, v.vaultId, amount, "0x")
		balances[from] -= amount
		balances[to] += amount
		if (step === 8 || step === 17) {
			const claimer = step === 8 ? c.alice : c.bob
			const due = await c.premiums.claimable(v.vaultId, claimer.address)
			await c.hub.connect(claimer).claimPremium(v.vaultId)
			walk.premiumClaimed += due
		}
		if (afterStep) await afterStep(walk)
	}
	return walk
}

/** The invariant the walk must keep: unclaimed premium stays reserved and supply equals the holders' shares. */
async function expectPremiumReserveAndSupplyConserved(c: IvyContext, v: LiveVault, walk: Walk) {
	expect(await v.vault.reserved(c.usdcAddress)).to.equal(PREMIUM_TOTAL - walk.premiumClaimed)
	expect(await c.hub.totalShares(v.vaultId)).to.equal(walk.balances.reduce((a, b) => a + b))
}

/** Every holder claims their collateral and any premium left; the market maker claims a cash payout. */
async function claimEverything(c: IvyContext, v: LiveVault, walk: Walk, cash: boolean) {
	const signers = holders(c)
	for (let i = 0; i < signers.length; i++) {
		if (walk.balances[i] > 0n) await c.hub.connect(signers[i]).claim(v.vaultId, walk.balances[i])
		if ((await c.premiums.claimable(v.vaultId, signers[i].address)) > 0n) await c.hub.connect(signers[i]).claimPremium(v.vaultId)
	}
	if (cash) await c.hub.connect(c.marketMaker).claimPayout(v.vaultId)
}

interface SettlementCase {
	name: string
	type: number
	settle: (c: IvyContext, v: LiveVault) => Promise<void>
	/** USDC alice, bob and carol end up with, premium claims included. */
	holdersUsdc: bigint
}

const cashExpiry = (price: bigint) => async (c: IvyContext, v: LiveVault) => {
	await publishExpiryPrice(c, v.vaultId, price)
	await c.hub.expire(v.vaultId)
}

const exerciseFourThenExpire =
	({ deliverWeth }: { deliverWeth: boolean }) =>
	async (c: IvyContext, v: LiveVault) => {
		if (deliverWeth) await fund(c, c.weth, c.marketMaker, v.vaultAddress, weth(4))
		await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(4))
		await at(c, v.bid.expiry + EXERCISE_WINDOW)
		await c.hub.expire(v.vaultId)
	}

const optionKinds: Array<{ name: string; isCall: boolean; unit: bigint; settlements: SettlementCase[] }> = [
	{
		name: "covered call",
		isCall: true,
		unit: weth(1),
		settlements: [
			{
				name: "cash settlement",
				type: SettlementType.Cash,
				settle: cashExpiry(usdc(3300)),
				// The payout leaves in WETH, so the holders keep only the premium.
				holdersUsdc: PREMIUM_TOTAL,
			},
			{
				name: "physical settlement",
				type: SettlementType.Physical,
				settle: exerciseFourThenExpire({ deliverWeth: false }),
				// Premium plus 4 WETH bought at the strike.
				holdersUsdc: PREMIUM_TOTAL + 4n * STRIKE,
			},
		],
	},
	{
		name: "cash-secured put",
		isCall: false,
		// Collateral backing 1 WETH of notional.
		unit: STRIKE,
		settlements: [
			{
				name: "cash settlement",
				type: SettlementType.Cash,
				settle: cashExpiry(usdc(2700)),
				// Collateral on 10 WETH of notional plus premium, less the 10 WETH × (3000 strike − 2700) payout.
				holdersUsdc: 10n * STRIKE + PREMIUM_TOTAL - usdc(3000),
			},
			{
				name: "physical settlement",
				type: SettlementType.Physical,
				settle: exerciseFourThenExpire({ deliverWeth: true }),
				// Collateral on 10 WETH of notional plus premium, less 4 WETH sold to the vault at the strike.
				holdersUsdc: 10n * STRIKE + PREMIUM_TOTAL - 4n * STRIKE,
			},
		],
	},
]

const deployed = fixture(connection, () => deployIvy(connection, { transfersEnabled: true }))

describe("stateful conservation", () => {
	let c: IvyContext
	let v: LiveVault

	for (const kind of optionKinds) {
		context(kind.name, () => {
			// alice holds 6 of the 10 WETH of notional, bob 4, carol none.
			const start = [6n * kind.unit, 4n * kind.unit, 0n]

			for (const settlement of kind.settlements) {
				const cash = settlement.type === SettlementType.Cash
				const live = fixture(deployed, async c => ({
					c,
					v: await goLive(
						c,
						{
							isCall: kind.isCall,
							withFeed: cash,
							deposit: start[0],
							extraDeposits: [{ signer: c.bob, amount: start[1] }],
						},
						{ settlement: settlement.type, style: ExerciseStyle.American },
					),
				}))
				const walked = fixture(live, async ({ c, v }) => ({ c, v, walk: await walkShares(c, v, start) }))

				context(`with ${settlement.name}`, () => {
					context("during a random walk of share transfers and premium claims", () => {
						beforeEach(async () => {
							;({ c, v } = await live())
						})

						it("keeps the premium reserve and share supply matched to the holders after every step", async () => {
							await walkShares(c, v, start, walk => expectPremiumReserveAndSupplyConserved(c, v, walk))
						})
					})

					context("after the walk, settlement and every claim", () => {
						beforeEach(async () => {
							const scenario = await walked()
							;({ c, v } = scenario)
							await settlement.settle(c, v)
							await claimEverything(c, v, scenario.walk, cash)
						})

						it("burns every share and leaves the vault empty", async () => {
							expect(await c.hub.totalShares(v.vaultId)).to.equal(0n)
							expect(await c.weth.balanceOf(v.vaultAddress)).to.equal(0n)
							expect(await c.usdc.balanceOf(v.vaultAddress)).to.equal(0n)
						})

						it("pays the holders exactly the USDC they are owed", async () => {
							const [alice, bob, carol] = await Promise.all(holders(c).map(holder => c.usdc.balanceOf(holder.address)))
							expect(alice + bob + carol).to.equal(settlement.holdersUsdc)
						})
					})
				})
			}
		})
	}
})
