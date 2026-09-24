import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs"
import { expect } from "chai"
import { AbiCoder, Interface, ZeroAddress, keccak256 } from "ethers"
import { network } from "hardhat"

import { at, AUCTION_START } from "../helpers/scenarios.js"
import {
	OptionKind,
	Phase,
	RuleKind,
	SettlementPolicy,
	callLimits,
	callPairs,
	callTerms,
	createVaultAs,
	deployIvy,
	fixture,
	pairLimitsRule,
	putPairs,
	putTerms,
	spotBandRule,
	weth,
	type IvyContext,
	type PairConfigInput,
	type VaultTermsInput,
	type CreatedVault,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

// A fixed start time far beyond the test chain's clock.

const deployed = fixture(connection, () => deployIvy(connection))
const coveredCall = fixture(deployed, async c => ({
	c,
	v: await createVaultAs(c, c.alice, callTerms(c), callPairs(c)),
}))
const cashSecuredPut = fixture(deployed, async c => ({
	c,
	v: await createVaultAs(c, c.alice, putTerms(c), putPairs(c)),
}))
const testValidators = fixture(deployed, async c => ({
	c,
	wrongSelector: await ethers.deployContract("WrongSelectorValidator"),
	configRevert: await ethers.deployContract("ConfigRevertValidator"),
}))
const withPairLimits = fixture(deployed, async c => ({
	c,
	v: await createVaultAs(c, c.alice, callTerms(c), callPairs(c), [pairLimitsRule(c, callLimits(c))]),
}))

type TestValidators = Awaited<ReturnType<typeof testValidators>>

describe("createVault", () => {
	let c: IvyContext
	let v: CreatedVault

	context("with no vaults yet", () => {
		beforeEach(async () => {
			c = await deployed()
		})

		it("emits VaultCreated for a covered call with WETH as underlying and collateral", async () => {
			await expect(c.hub.connect(c.alice).createVault(callTerms(c), callPairs(c), []))
				.to.emit(c.hub, "VaultCreated")
				.withArgs(1n, anyValue, c.alice.address, OptionKind.CoveredCall, c.wethAddress, c.wethAddress)
		})

		it("emits VaultCreated for a cash-secured put with USDC collateral", async () => {
			await expect(c.hub.connect(c.alice).createVault(putTerms(c), putPairs(c), []))
				.to.emit(c.hub, "VaultCreated")
				.withArgs(1n, anyValue, c.alice.address, OptionKind.CashSecuredPut, c.wethAddress, c.usdcAddress)
		})

		it("emits AuctionScheduled when a start time is given", async () => {
			await expect(c.hub.connect(c.alice).createVault(callTerms(c, { auctionStartsAt: AUCTION_START }), callPairs(c), []))
				.to.emit(c.hub, "AuctionScheduled")
				.withArgs(1n, AUCTION_START)
		})

		it("gives every vault its own id, clone and owner", async () => {
			const a = await createVaultAs(c, c.alice, callTerms(c), callPairs(c))
			const b = await createVaultAs(c, c.bob, putTerms(c), putPairs(c))
			expect(a.vaultId).to.equal(1n)
			expect(b.vaultId).to.equal(2n)
			expect(a.vaultAddress).to.not.equal(b.vaultAddress)
			expect((await c.hub.stateOf(b.vaultId)).owner).to.equal(c.bob.address)
		})

		it("rejects an expiry at exactly the creation time", async () => {
			const createdAt = BigInt(await networkHelpers.time.latest()) + 10n
			await at(c, createdAt)
			await expect(c.hub.connect(c.alice).createVault(callTerms(c, { expiry: createdAt }), callPairs(c), [])).to.be.revertedWithCustomError(
				c.hub,
				"ExpiryInPast",
			)
		})

		it("accepts an expiry one second after the creation time", async () => {
			const createdAt = BigInt(await networkHelpers.time.latest()) + 10n
			await at(c, createdAt)
			await expect(c.hub.connect(c.alice).createVault(callTerms(c, { expiry: createdAt + 1n }), callPairs(c), [])).not.to.be.revert(ethers)
		})

		it("accepts a call vault with several quote tokens", async () => {
			const pairs = [...callPairs(c), { quoteToken: c.daiAddress, premiumToken: c.daiAddress }]
			const { vaultId } = await createVaultAs(c, c.alice, callTerms(c), pairs)
			expect(await c.hub.quoteTokensOf(vaultId)).to.deep.equal([c.usdcAddress, c.daiAddress])
		})
	})

	context("after a covered call is created", () => {
		beforeEach(async () => {
			;({ c, v } = await coveredCall())
		})

		it("counts the vault", async () => {
			expect(await c.hub.vaultCount()).to.equal(1n)
		})

		it("derives the covered call kind", async () => {
			expect(await c.hub.kindOf(v.vaultId)).to.equal(OptionKind.CoveredCall)
		})

		it("records an open call vault owned by its creator and measured in whole WETH", async () => {
			const state = await c.hub.stateOf(v.vaultId)
			expect(state.owner).to.equal(c.alice.address)
			expect(state.phase).to.equal(Phase.Open)
			expect(state.isCall).to.equal(true)
			expect(state.underlyingUnit).to.equal(weth(1))
		})

		it("binds its clone to the hub, the vault id and the WETH collateral", async () => {
			const vault = await c.ethers.getContractAt("IvyVault", (await c.hub.stateOf(v.vaultId)).vault)
			expect(await vault.hub()).to.equal(c.hubAddress)
			expect(await vault.vaultId()).to.equal(1n)
			expect(await vault.collateral()).to.equal(c.wethAddress)
		})

		it("stores the USDC pair", async () => {
			expect(await c.hub.quoteTokensOf(v.vaultId)).to.deep.equal([c.usdcAddress])
			expect(await c.hub.pairOf(v.vaultId, c.usdcAddress)).to.equal(c.usdcAddress)
		})

		it("stores no rules", async () => {
			expect(await c.hub.rulesOf(v.vaultId)).to.deep.equal([])
		})

		it("stores the expiry", async () => {
			expect((await c.hub.termsOf(v.vaultId)).expiry).to.equal(c.defaultExpiry)
		})
	})

	context("after a cash-secured put is created", () => {
		beforeEach(async () => {
			;({ c, v } = await cashSecuredPut())
		})

		it("derives the cash-secured put kind", async () => {
			expect(await c.hub.kindOf(v.vaultId)).to.equal(OptionKind.CashSecuredPut)
		})

		it("records a put vault measured in whole WETH", async () => {
			const state = await c.hub.stateOf(v.vaultId)
			expect(state.isCall).to.equal(false)
			expect(state.underlyingUnit).to.equal(weth(1))
		})

		it("binds its clone to the USDC collateral", async () => {
			const vault = await c.ethers.getContractAt("IvyVault", (await c.hub.stateOf(v.vaultId)).vault)
			expect(await vault.collateral()).to.equal(c.usdcAddress)
		})
	})

	context("with invalid terms or pairs", () => {
		const cases: Array<{
			name: string
			error: string
			build: (c: IvyContext) => [VaultTermsInput, PairConfigInput[]]
		}> = [
			{
				name: "a zero underlying",
				error: "ZeroAddress",
				build: c => [callTerms(c, { underlying: ZeroAddress }), callPairs(c)],
			},
			{
				name: "a zero collateral",
				error: "ZeroAddress",
				build: c => [callTerms(c, { collateral: ZeroAddress }), callPairs(c)],
			},
			{ name: "an elapsed expiry", error: "ExpiryInPast", build: c => [callTerms(c, { expiry: 0n }), callPairs(c)] },
			{
				name: "cash settlement without an exercise price age limit",
				error: "CashSettlementNeedsMaxPriceAge",
				build: c => [callTerms(c, { allowedSettlement: SettlementPolicy.Cash }), callPairs(c)],
			},
			{
				name: "either settlement without an exercise price age limit",
				error: "CashSettlementNeedsMaxPriceAge",
				build: c => [callTerms(c, { allowedSettlement: SettlementPolicy.Either }), callPairs(c)],
			},
			{ name: "no pairs", error: "NoPairs", build: c => [callTerms(c), []] },
			{
				name: "a put with two pairs",
				error: "PutRequiresSinglePair",
				build: c => [putTerms(c), [...putPairs(c), { quoteToken: c.daiAddress, premiumToken: c.usdcAddress }]],
			},
			{
				name: "a put pair that is not the collateral",
				error: "PutPairMustBeCollateral",
				build: c => [putTerms(c), [{ quoteToken: c.daiAddress, premiumToken: c.daiAddress }]],
			},
			{
				name: "a call quote equal to the underlying",
				error: "QuoteIsUnderlying",
				build: c => [callTerms(c), [{ quoteToken: c.wethAddress, premiumToken: c.usdcAddress }]],
			},
			{
				name: "a zero premium token",
				error: "ZeroAddress",
				build: c => [callTerms(c), [{ quoteToken: c.usdcAddress, premiumToken: ZeroAddress }]],
			},
			{
				name: "a duplicate quote token",
				error: "DuplicatePair",
				build: c => [callTerms(c), [...callPairs(c), ...callPairs(c)]],
			},
		]

		beforeEach(async () => {
			c = await deployed()
		})

		for (const tc of cases) {
			it(`rejects ${tc.name}`, async () => {
				const [terms, pairs] = tc.build(c)
				await expect(c.hub.connect(c.alice).createVault(terms, pairs, [])).to.be.revertedWithCustomError(c.hub, tc.error)
			})
		}
	})

	context("with cash settlement and a price age limit", () => {
		beforeEach(async () => {
			c = await deployed()
		})

		it("stores the limit without binding a price source", async () => {
			const { vaultId } = await createVaultAs(
				c,
				c.alice,
				callTerms(c, { allowedSettlement: SettlementPolicy.Cash, maxSettlementPriceAge: 60 }),
				callPairs(c),
			)
			expect((await c.hub.termsOf(vaultId)).maxSettlementPriceAge).to.equal(60n)
			expect(await c.hub.rulesOf(vaultId)).to.deep.equal([])
		})
	})

	describe("rules", () => {
		let validators: TestValidators

		const rule = (validator: string, kind: string = RuleKind.PairLimits) => ({ validator, kind, data: "0x" })

		const invalidValidators: Array<{ name: string; address: (s: TestValidators) => Promise<string> | string }> = [
			{ name: "an account without code", address: s => s.c.alice.address },
			{ name: "the zero address", address: () => ZeroAddress },
			{ name: "a contract with the wrong selector", address: s => s.wrongSelector.getAddress() },
		]

		beforeEach(async () => {
			validators = await testValidators()
			;({ c } = validators)
		})

		for (const tc of invalidValidators) {
			it(`rejects ${tc.name} as validator`, async () => {
				const rules = [rule(await tc.address(validators))]
				await expect(c.hub.connect(c.alice).createVault(callTerms(c), callPairs(c), rules)).to.be.revertedWithCustomError(c.hub, "InvalidValidator")
			})
		}

		it("rejects a rule whose validator refuses the config", async () => {
			const { configRevert } = validators
			const rules = [rule(await configRevert.getAddress())]
			await expect(c.hub.connect(c.alice).createVault(callTerms(c), callPairs(c), rules)).to.be.revertedWithCustomError(configRevert, "BadConfig")
		})

		it("rejects an unknown rule kind", async () => {
			await expect(c.hub.connect(c.alice).createVault(callTerms(c), callPairs(c), [rule(c.bidRulesAddress, "0xdeadbeef")]))
				.to.be.revertedWithCustomError(c.hub, "UnknownRuleKind")
				.withArgs("0xdeadbeef")
		})

		it("stores the rules in the order given", async () => {
			const rules = [pairLimitsRule(c, callLimits(c, { minPremium: 5n })), spotBandRule(c, { maxPriceAge: 60, maxInTheMoneyBps: 500 })]
			const { vaultId } = await createVaultAs(c, c.alice, callTerms(c), callPairs(c), rules)
			const stored = await c.hub.rulesOf(vaultId)
			expect(stored.map(r => [r.validator, r.kind, r.data])).to.deep.equal(rules.map(r => [r.validator, r.kind, r.data]))
		})

		it("offers no function to tighten vault or pair terms afterwards", async () => {
			const abi = new Interface(c.hub.interface.fragments)
			expect(abi.getFunction("tightenVaultTerms")).to.equal(null)
			expect(abi.getFunction("tightenPairTerms")).to.equal(null)
		})
	})

	describe("termsHashOf", () => {
		let hash: string

		beforeEach(async () => {
			;({ c, v } = await withPairLimits())
			hash = await c.hub.termsHashOf(v.vaultId)
		})

		it("hashes the terms together with the pairs hash and the rules hash", async () => {
			const t = callTerms(c)
			const rules = [pairLimitsRule(c, callLimits(c))]
			const coder = AbiCoder.defaultAbiCoder()
			const pairsHash = keccak256(
				coder.encode(["tuple(address quoteToken,address premiumToken)[]"], [callPairs(c).map(p => [p.quoteToken, p.premiumToken])]),
			)
			const rulesHash = keccak256(
				coder.encode(["tuple(address validator,bytes4 kind,bytes data)[]"], [rules.map(r => [r.validator, r.kind, r.data])]),
			)
			const expected = keccak256(
				coder.encode(
					["address", "address", "bool", "bool", "uint8", "uint8", "uint64", "uint256", "uint32", "bytes32", "bytes32"],
					[
						t.underlying,
						t.collateral,
						t.allowPartialExercise,
						t.publicDeposits,
						t.allowedExercise,
						t.allowedSettlement,
						t.expiry,
						t.minCollateral,
						t.maxSettlementPriceAge,
						pairsHash,
						rulesHash,
					],
				),
			)
			expect(hash).to.equal(expected)
		})

		it("ignores the auction start time", async () => {
			const scheduled = await createVaultAs(c, c.alice, callTerms(c, { auctionStartsAt: AUCTION_START }), callPairs(c), [
				pairLimitsRule(c, callLimits(c)),
			])
			expect(await c.hub.termsHashOf(scheduled.vaultId)).to.equal(hash)
		})

		it("changes with the minimum collateral", async () => {
			const withMinimum = await createVaultAs(c, c.alice, callTerms(c, { minCollateral: 1n }), callPairs(c), [pairLimitsRule(c, callLimits(c))])
			expect(await c.hub.termsHashOf(withMinimum.vaultId)).to.not.equal(hash)
		})

		it("changes with public deposits", async () => {
			const ownerOnly = await createVaultAs(c, c.alice, callTerms(c, { publicDeposits: false }), callPairs(c), [pairLimitsRule(c, callLimits(c))])
			expect(await c.hub.termsHashOf(ownerOnly.vaultId)).to.not.equal(hash)
		})

		it("changes with the rules", async () => {
			const withoutRules = await createVaultAs(c, c.alice, callTerms(c), callPairs(c), [])
			expect(await c.hub.termsHashOf(withoutRules.vaultId)).to.not.equal(hash)
		})
	})
})
