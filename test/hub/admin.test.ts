import { expect } from "chai"
import { ZeroAddress, getCreateAddress, type Interface } from "ethers"
import { network } from "hardhat"

import { signBid } from "../helpers/bids.js"
import { CASH_TERMS, activate, goLive, makeBid, openVault, type LiveVault, type OpenedVault } from "../helpers/scenarios.js"
import {
	AUCTION_TIMEOUT,
	EXERCISE_WINDOW,
	EXPIRY_PRICE_PUBLICATION_WINDOW,
	SettlementPolicy,
	callPairs,
	callTerms,
	createVaultAs,
	deployIvy,
	fixture,
	fund,
	spotBandRule,
	usdc,
	weth,
	type IvyContext,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers } = connection

interface HubArgs {
	admin?: string
	vaultImplementation?: string
	shares?: string
	premiums?: string
	unwind?: string
	exerciseWindow?: bigint
	auctionTimeout?: bigint
	publicationWindow?: bigint
}

/**
 * Deploys another hub on `c`'s shares, premiums and unwind modules, which are already bound to `c.hub`.
 * `o` overrides any constructor argument.
 */
async function deployHub(c: IvyContext, o: HubArgs = {}) {
	return ethers.deployContract(
		"IvyVaultsHub",
		[
			o.admin ?? c.admin.address,
			o.vaultImplementation ?? c.vaultImplAddress,
			o.shares ?? c.sharesAddress,
			o.premiums ?? (await c.premiums.getAddress()),
			o.unwind ?? (await c.unwind.getAddress()),
			o.exerciseWindow ?? 1n,
			o.auctionTimeout ?? 1n,
			o.publicationWindow ?? 1n,
		],
		{ libraries: c.libraries },
	)
}

interface PeerBindings {
	sharesHub?: string
	sharesPremiums?: string
	sharesUnwind?: string
	premiumsHub?: string
	premiumsShares?: string
	unwindHub?: string
	unwindShares?: string
}

/** Deploys another hub with fresh shares, premiums and unwind modules bound to it. `o` points any binding elsewhere. */
async function deployHubWithOwnPeers(c: IvyContext, o: PeerBindings = {}) {
	const nonce = await c.admin.getNonce()
	const [hub, shares, premiums, unwind] = [0, 1, 2, 3].map(i => getCreateAddress({ from: c.admin.address, nonce: nonce + i }))
	const ownHub = await deployHub(c, { shares, premiums, unwind })
	await ethers.deployContract("IvyShares", [o.sharesHub ?? hub, o.sharesPremiums ?? premiums, o.sharesUnwind ?? unwind, "ipfs://ivy/{id}.json"])
	await ethers.deployContract("IvyPremiums", [o.premiumsHub ?? hub, o.premiumsShares ?? shares])
	await ethers.deployContract("IvyUnwind", [o.unwindHub ?? hub, o.unwindShares ?? shares])
	return ownHub
}

/** Each case points one binding of an otherwise consistent peer set at the first deployment. */
const MISBOUND_PEERS: Array<{ name: string; bind: (c: IvyContext) => Promise<PeerBindings> }> = [
	{ name: "shares answering to another hub", bind: async c => ({ sharesHub: c.hubAddress }) },
	{ name: "premiums answering to another hub", bind: async c => ({ premiumsHub: c.hubAddress }) },
	{ name: "unwind answering to another hub", bind: async c => ({ unwindHub: c.hubAddress }) },
	{
		name: "shares naming another premiums module",
		bind: async c => ({ sharesPremiums: await c.premiums.getAddress() }),
	},
	{
		name: "shares naming another unwind module",
		bind: async c => ({ sharesUnwind: await c.unwind.getAddress() }),
	},
	{ name: "premiums naming another share token", bind: async c => ({ premiumsShares: c.sharesAddress }) },
	{ name: "unwind naming another share token", bind: async c => ({ unwindShares: c.sharesAddress }) },
]

const deployed = fixture(connection, () => deployIvy(connection))
const hubOnOwnPeers = fixture(deployed, async c => ({ c, hub: await deployHubWithOwnPeers(c) }))
const vaultsAroundNewSettings = fixture(deployed, async c => {
	const earlier = await createVaultAs(c, c.alice, callTerms(c), callPairs(c))
	await c.hub.setSettings(1n, 2n, 3n)
	const later = await createVaultAs(c, c.alice, callTerms(c), callPairs(c))
	return { c, earlier: earlier.vaultId, later: later.vaultId }
})
const liveAndAuctioning = fixture(deployed, async c => {
	const v = await goLive(c)
	const auctioning = await openVault(c)
	return { c, v, auctioning }
})
const twoAuctions = fixture(deployed, async c => {
	const first = await openVault(c)
	const second = await openVault(c)
	return { c, first, second }
})

describe("hub administration", () => {
	describe("deployment", () => {
		let c: IvyContext

		beforeEach(async () => {
			c = await deployed()
		})

		it("binds the hub to the vault implementation", async () => {
			expect(await c.hub.vaultImplementation()).to.equal(c.vaultImplAddress)
		})

		it("binds shares to the hub and to the premiums and unwind modules", async () => {
			expect(await c.shares.hub()).to.equal(c.hubAddress)
			expect(await c.shares.premiums()).to.equal(await c.premiums.getAddress())
			expect(await c.shares.unwind()).to.equal(await c.unwind.getAddress())
		})

		it("binds the premiums and unwind modules to shares", async () => {
			expect(await c.premiums.shares()).to.equal(c.sharesAddress)
			expect(await c.unwind.shares()).to.equal(c.sharesAddress)
		})

		it("issues shares as ERC-1155 tokens", async () => {
			expect(await c.shares.supportsInterface("0xd9b67a26")).to.equal(true)
		})

		it("signs bids under EIP-712 domain version 3", async () => {
			expect((await c.hub.eip712Domain()).version).to.equal("3")
		})

		it("reports version 3", async () => {
			expect(await c.hub.version()).to.equal("3")
		})

		for (const { name } of [{ name: "upgradeToAndCall" }, { name: "initialize" }, { name: "setShares" }, { name: "setVaultImplementation" }]) {
			it(`has no ${name} entrypoint`, async () => {
				const hubInterface: Interface = c.hub.interface
				expect(hubInterface.getFunction(name)).to.equal(null)
			})
		}

		it("rejects a zero expiry price publication window", async () => {
			await expect(deployHub(c, { exerciseWindow: 3600n, auctionTimeout: 3600n, publicationWindow: 0n })).to.be.revertedWithCustomError(
				c.hub,
				"InvalidSettlementWindow",
			)
		})

		for (const { name, arg } of [
			{ name: "admin", arg: "admin" },
			{ name: "vault implementation", arg: "vaultImplementation" },
			{ name: "shares", arg: "shares" },
			{ name: "premiums", arg: "premiums" },
			{ name: "unwind", arg: "unwind" },
		] as const) {
			it(`rejects a zero ${name} address`, async () => {
				await expect(deployHub(c, { [arg]: ZeroAddress })).to.be.revertedWithCustomError(c.hub, "ZeroAddress")
			})
		}
	})

	describe("binding checks", () => {
		let c: IvyContext

		context("with the standard peers", () => {
			beforeEach(async () => {
				c = await deployed()
			})

			it("rejects deploying a hub whose vault implementation has no code", async () => {
				await expect(deployHub(c, { vaultImplementation: c.alice.address })).to.be.revertedWithCustomError(c.hub, "BindingMismatch")
			})

			it("rejects creating a vault whose spot band price feed has no code", async () => {
				const rule = spotBandRule(c, { priceFeed: c.alice.address, maxPriceAge: 100, maxInTheMoneyBps: 0 })
				await expect(c.hub.createVault(callTerms(c), callPairs(c), [rule])).to.be.revertedWithCustomError(c.hub, "BindingMismatch")
			})
		})

		context("with a second hub on its own consistently bound peers", () => {
			let ownHub: IvyContext["hub"]

			beforeEach(async () => {
				;({ c, hub: ownHub } = await hubOnOwnPeers())
			})

			it("accepts creating a vault", async () => {
				await expect(ownHub.createVault(callTerms(c), callPairs(c), [])).not.to.be.revert(ethers)
			})
		})

		for (const { name, bind } of MISBOUND_PEERS) {
			const misbound = fixture(deployed, async c => ({ c, hub: await deployHubWithOwnPeers(c, await bind(c)) }))

			context(`with a second hub on its own peers but ${name}`, () => {
				let ownHub: IvyContext["hub"]

				beforeEach(async () => {
					;({ c, hub: ownHub } = await misbound())
				})

				it("rejects creating a vault", async () => {
					await expect(ownHub.createVault(callTerms(c), callPairs(c), [])).to.be.revertedWithCustomError(ownHub, "BindingMismatch")
				})
			})
		}
	})

	describe("setSettings", () => {
		let c: IvyContext
		let earlier: bigint
		let later: bigint

		context("with the deployment defaults", () => {
			beforeEach(async () => {
				c = await deployed()
			})

			it("rejects a caller without the admin role", async () => {
				await expect(c.hub.connect(c.alice).setSettings(1n, 2n, 3n))
					.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
					.withArgs(c.alice.address, await c.hub.DEFAULT_ADMIN_ROLE())
			})

			it("rejects a zero expiry price publication window", async () => {
				await expect(c.hub.setSettings(20n, AUCTION_TIMEOUT, 0n)).to.be.revertedWithCustomError(c.hub, "InvalidSettlementWindow")
			})

			it("emits SettingsUpdated with the new windows and auction timeout", async () => {
				await expect(c.hub.setSettings(1n, 2n, 3n))
					.to.emit(c.hub, "SettingsUpdated")
					.withArgs(1n, 2n, 3n)
			})
		})

		context("with vaults created before and after new defaults", () => {
			beforeEach(async () => {
				;({ c, earlier, later } = await vaultsAroundNewSettings())
			})

			it("keeps the earlier vault's windows and auction timeout", async () => {
				const state = await c.hub.stateOf(earlier)
				expect(state.exerciseWindow).to.equal(EXERCISE_WINDOW)
				expect(state.auctionTimeout).to.equal(AUCTION_TIMEOUT)
				expect(state.expiryPricePublicationWindow).to.equal(EXPIRY_PRICE_PUBLICATION_WINDOW)
			})

			it("gives the later vault the new windows and auction timeout", async () => {
				const state = await c.hub.stateOf(later)
				expect(state.exerciseWindow).to.equal(1n)
				expect(state.auctionTimeout).to.equal(2n)
				expect(state.expiryPricePublicationWindow).to.equal(3n)
			})
		})

		context("with a zero exercise window", () => {
			beforeEach(async () => {
				c = await deployed()
				await c.hub.setSettings(0n, AUCTION_TIMEOUT, EXPIRY_PRICE_PUBLICATION_WINDOW)
			})

			for (const { name, allowedSettlement } of [
				{ name: "cash", allowedSettlement: SettlementPolicy.Cash },
				{ name: "either physical or cash", allowedSettlement: SettlementPolicy.Either },
			]) {
				it(`rejects a vault that allows ${name} settlement`, async () => {
					await expect(c.hub.createVault(callTerms(c, { ...CASH_TERMS, allowedSettlement }), callPairs(c), [])).to.be.revertedWithCustomError(
						c.hub,
						"InvalidSettlementWindow",
					)
				})
			}

			it("still accepts a physical-only vault", async () => {
				await expect(c.hub.createVault(callTerms(c), callPairs(c), [])).not.to.be.revert(ethers)
			})
		})
	})

	describe("setURI", () => {
		let c: IvyContext

		beforeEach(async () => {
			c = await deployed()
		})

		it("rejects a caller without the admin role", async () => {
			await expect(c.hub.connect(c.alice).setURI("x"))
				.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
				.withArgs(c.alice.address, await c.hub.DEFAULT_ADMIN_ROLE())
		})

		it("changes the share metadata URI", async () => {
			await c.hub.setURI("new")
			expect(await c.shares.uri(1n)).to.equal("new")
		})
	})

	describe("setAdmissionPause", () => {
		let c: IvyContext

		context("with a live vault and a vault in auction", () => {
			let v: LiveVault
			let auctioning: OpenedVault

			beforeEach(async () => {
				;({ c, v, auctioning } = await liveAndAuctioning())
			})

			it("rejects a caller without the guardian role", async () => {
				await expect(c.hub.connect(c.bob).setAdmissionPause(0n, true))
					.to.be.revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
					.withArgs(c.bob.address, await c.hub.GUARDIAN_ROLE())
			})

			it("rejects pausing an unknown vault", async () => {
				await expect(c.hub.setAdmissionPause(99n, true)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
			})

			it("emits AdmissionPauseUpdated with vault id zero for a global pause", async () => {
				await expect(c.hub.setAdmissionPause(0n, true)).to.emit(c.hub, "AdmissionPauseUpdated").withArgs(0n, true)
			})

			it("emits AdmissionPauseUpdated with the vault id for one vault's pause", async () => {
				await expect(c.hub.setAdmissionPause(auctioning.vaultId, true)).to.emit(c.hub, "AdmissionPauseUpdated").withArgs(auctioning.vaultId, true)
			})

			context("when admissions are paused globally", () => {
				beforeEach(async () => {
					await c.hub.setAdmissionPause(0n, true)
				})

				it("rejects activating the auction", async () => {
					await expect(activate(c, auctioning.vaultId, auctioning.vaultAddress)).to.be.revertedWithCustomError(c.hub, "AdmissionPaused")
				})

				it("lets the owner cancel the auction immediately", async () => {
					await expect(c.hub.connect(c.alice).cancelAuction(auctioning.vaultId)).not.to.be.revert(ethers)
				})

				it("lets LPs claim the live vault's premium", async () => {
					await expect(c.hub.connect(c.alice).claimPremium(v.vaultId)).not.to.be.revert(ethers)
				})

				it("lets the market maker exercise the live vault", async () => {
					await expect(c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))).not.to.be.revert(ethers)
				})

				context("after the auction is cancelled", () => {
					beforeEach(async () => {
						await c.hub.connect(c.alice).cancelAuction(auctioning.vaultId)
					})

					it("lets the owner withdraw the collateral", async () => {
						await expect(c.hub.connect(c.alice).withdraw(auctioning.vaultId, weth(10))).not.to.be.revert(ethers)
					})

					it("rejects depositing again after withdrawing", async () => {
						await c.hub.connect(c.alice).withdraw(auctioning.vaultId, weth(10))
						await expect(c.hub.connect(c.alice).deposit(auctioning.vaultId, 1n)).to.be.revertedWithCustomError(c.hub, "AdmissionPaused")
					})
				})

				context("after the live vault is exercised in full", () => {
					beforeEach(async () => {
						await c.hub.connect(c.marketMaker).exercise(v.vaultId, weth(10))
					})

					it("lets LPs claim the exercise proceeds", async () => {
						await expect(c.hub.connect(c.alice).claim(v.vaultId, weth(10))).not.to.be.revert(ethers)
					})
				})
			})
		})

		context("when one of two vaults in auction is paused", () => {
			let paused: OpenedVault
			let other: OpenedVault

			beforeEach(async () => {
				;({ c, first: paused, second: other } = await twoAuctions())
				await c.hub.setAdmissionPause(paused.vaultId, true)
			})

			it("lets the owner cancel the paused auction immediately", async () => {
				await expect(c.hub.connect(c.alice).cancelAuction(paused.vaultId)).not.to.be.revert(ethers)
			})

			it("still lets the other vault's auction activate", async () => {
				const bid = await makeBid(c, other.vaultId)
				await fund(c, c.usdc, c.marketMaker, other.vaultAddress, usdc(1000))
				const signature = await signBid(c.marketMaker, c.hubAddress, bid)
				await expect(c.hub.connect(c.bidMaster).activate(other.vaultId, bid, signature)).not.to.be.revert(ethers)
			})

			context("after the paused auction is cancelled", () => {
				beforeEach(async () => {
					await c.hub.connect(c.alice).cancelAuction(paused.vaultId)
				})

				it("rejects reopening the auction", async () => {
					await expect(c.hub.connect(c.alice).openAuction(paused.vaultId)).to.be.revertedWithCustomError(c.hub, "AdmissionPaused")
				})

				it("rejects a deposit made directly on the vault", async () => {
					await fund(c, c.weth, c.alice, paused.vaultAddress, weth(1))
					await expect(paused.vault.connect(c.alice).deposit(weth(1))).to.be.revertedWithCustomError(c.hub, "AdmissionPaused")
				})

				context("when admissions are also paused globally", () => {
					beforeEach(async () => {
						await c.hub.setAdmissionPause(0n, true)
					})

					it("rejects creating a vault", async () => {
						await expect(c.hub.connect(c.alice).createVault(callTerms(c), callPairs(c), [])).to.be.revertedWithCustomError(c.hub, "AdmissionPaused")
					})

					it("lets the owner withdraw the collateral", async () => {
						await expect(c.hub.connect(c.alice).withdraw(paused.vaultId, weth(10))).not.to.be.revert(ethers)
					})
				})
			})
		})
	})

	describe("peer entrypoint guards", () => {
		let c: IvyContext

		beforeEach(async () => {
			c = await deployed()
		})

		describe("IvyShares", () => {
			it("rejects minting from anyone but the hub", async () => {
				await expect(c.shares.mint(c.alice.address, 1n, 1n)).to.be.revertedWithCustomError(c.shares, "NotHub")
			})

			it("rejects burning from anyone but the hub", async () => {
				await expect(c.shares.burn(c.alice.address, 1n, 1n)).to.be.revertedWithCustomError(c.shares, "NotHub")
			})
		})

		describe("IvyPremiums", () => {
			it("rejects claiming for a holder from anyone but the hub", async () => {
				await expect(c.premiums.claimFor(1n, c.alice.address)).to.be.revertedWithCustomError(c.premiums, "NotHub")
			})

			it("rejects share update hooks from anyone but shares", async () => {
				await expect(c.premiums.beforeShareUpdate(1n, c.alice.address, c.bob.address, 100n, 100n, 0n)).to.be.revertedWithCustomError(
					c.premiums,
					"NotShares",
				)
			})
		})

		describe("IvyUnwind", () => {
			it("rejects share update hooks from anyone but shares", async () => {
				await expect(c.unwind.beforeShareUpdate(1n, c.alice.address)).to.be.revertedWithCustomError(c.unwind, "NotShares")
			})
		})
	})

	describe("stateOf", () => {
		let c: IvyContext

		beforeEach(async () => {
			c = await deployed()
		})

		it("reverts for an unknown vault", async () => {
			await expect(c.hub.stateOf(99n)).to.be.revertedWithCustomError(c.hub, "UnknownVault")
		})
	})
})
