import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import type {} from "chai-as-promised"
import { BrowserProvider, ZeroAddress, ZeroHash, id, type JsonRpcSigner } from "ethers"
import { artifacts, network } from "hardhat"

import {
	buildDeploymentPlan,
	loadArtifacts,
	resumeDeployment,
	type Artifact,
	type Artifacts,
	type DeploymentPlan,
	type Journal,
} from "../../scripts/deployment.ts"
import { encodePairLimits } from "../../scripts/encoding.ts"
import { buildRegistryDeploymentPlan, resumeRegistryDeployment, type RegistryPlan } from "../../scripts/registry-deployment.ts"
import { RELEASE_FORMAT, releaseHash, resolveRelease, verifyRelease, type ReleaseBundle, type ReleaseRequest } from "../../scripts/releases.ts"
import { signBid, type Bid } from "../helpers/bids.js"
import { PREMIUM_PER_UNIT, STRIKE, goLive, type LiveVault } from "../helpers/scenarios.js"
import {
	EXERCISE_WINDOW,
	EXPIRY_PRICE_PUBLICATION_WINDOW,
	ExercisePolicy,
	ExerciseStyle,
	Phase,
	RuleKind,
	SettlementPolicy,
	SettlementType,
	deployIvy,
	fixture,
	usdc,
	weth,
	skipUnderCoverage,
	type IvyContext,
	type VaultTermsInput,
} from "../helpers/setup.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

const MANIFEST_HASH = id("verified manifest")

const registryDeployed = fixture(connection, async () => {
	const [admin, outsider] = await ethers.getSigners()
	const registry = await ethers.deployContract("IvyVaultsRegistry", [admin.address])
	// Registration only needs an address with code, so a second registry stands in for a hub.
	const hub = await (await ethers.deployContract("IvyVaultsRegistry", [admin.address])).getAddress()
	return { admin, outsider, registry, hub }
})
const versionOneRegistered = fixture(registryDeployed, async d => {
	await d.registry.registerVersion(1, d.hub, MANIFEST_HASH)
	return d
})

const released = fixture(connection, async () => {
	const [admin, outsider] = await ethers.getSigners()
	const supported = await loadArtifacts()
	const manifest = await buildDeploymentPlan({
		artifacts: supported,
		chainId: (await ethers.provider.getNetwork()).chainId,
		genesisHash: (await ethers.provider.getBlock(0))!.hash,
		deployer: admin.address,
		startNonce: await admin.getNonce(),
		admin: admin.address,
		reportSigner: outsider.address,
		exerciseWindow: EXERCISE_WINDOW,
		expiryPricePublicationWindow: EXPIRY_PRICE_PUBLICATION_WINDOW,
	})
	const journal = await resumeDeployment(admin, manifest)
	const bundle: ReleaseBundle = { format: 1, interfaceFormat: RELEASE_FORMAT, manifest, journal, artifacts: supported }
	const registry = await ethers.deployContract("IvyVaultsRegistry", [admin.address])
	return { admin, outsider, supported, bundle, registry }
})
const releaseSevenRegistered = fixture(released, async r => {
	await r.registry.registerVersion(7, r.bundle.manifest.addresses.IvyVaultsHub, releaseHash(r.bundle))
	return r
})
const releaseOneStaffed = fixture(released, async ({ admin, supported, bundle, registry }) => {
	await registry.registerVersion(1, bundle.manifest.addresses.IvyVaultsHub, releaseHash(bundle))
	const resolved = await resolveRelease(ethers.provider, { registry: await registry.getAddress(), releaseBundle: bundle, releaseId: 1 }, supported)
	const hub = await ethers.getContractAt("IvyVaultsHub", resolved.hub)
	const wethToken = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18])
	const usdcToken = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6])
	await hub.grantRole(await hub.BID_MASTER_ROLE(), admin.address)
	await hub.grantRole(await hub.MARKET_MAKER_ROLE(), admin.address)
	return { admin, resolved, hub, wethToken, usdcToken }
})

const registryPlanned = fixture(connection, async () => {
	const [admin] = await ethers.getSigners()
	const artifact = await artifacts.readArtifact("IvyVaultsRegistry")
	const plan = await buildRegistryDeploymentPlan({
		artifact,
		chainId: (await ethers.provider.getNetwork()).chainId,
		genesisHash: (await ethers.provider.getBlock(0))!.hash,
		deployer: admin.address,
		startNonce: await admin.getNonce(),
		admin: admin.address,
	})
	return { admin, artifact, plan }
})

const twoLiveReleases = fixture(connection, async () => {
	const first = await deployIvy(connection, { enableCashSettlement: false })
	const oldPosition = await goLive(first)
	// Both releases share the tokens and the LP wallet: only the deployment tells vault 1 apart.
	const second = {
		...(await deployIvy(connection, { enableCashSettlement: false })),
		weth: first.weth,
		wethAddress: first.wethAddress,
		usdc: first.usdc,
		usdcAddress: first.usdcAddress,
	}
	const newPosition = await goLive(second)
	return { first, second, oldPosition, newPosition }
})
const secondRecommended = fixture(twoLiveReleases, async s => {
	const registry = await ethers.deployContract("IvyVaultsRegistry", [s.first.carol.address])
	const curator = registry.connect(s.first.carol)
	await curator.registerVersion(1, s.first.hubAddress, id("first deployment evidence"))
	await curator.setRecommendedVersion(1)
	const originalTerms = await s.first.hub.termsOf(1)
	const originalState = await s.first.hub.stateOf(1)
	await curator.registerVersion(2, s.second.hubAddress, id("second deployment evidence"))
	await curator.setRecommendedVersion(2)
	return { ...s, registry, originalTerms, originalState }
})
const oldExercised = fixture(secondRecommended, async s => {
	await s.first.hub.connect(s.first.marketMaker).exercise(1, weth(4))
	return s
})
const oldSettled = fixture(oldExercised, async s => {
	await networkHelpers.time.increaseTo(await s.first.hub.settleAtExpiryTimeOf(1))
	await s.first.hub.connect(s.first.bob).settleAtExpiry(1)
	return s
})
const oldCashedOut = fixture(oldSettled, async s => {
	await s.first.hub.connect(s.first.alice).claim(1, weth(10))
	await s.first.hub.connect(s.first.alice).claimPremium(1)
	return s
})
const newSettled = fixture(oldCashedOut, async s => {
	await networkHelpers.time.increaseTo(await s.second.hub.settleAtExpiryTimeOf(1))
	await s.second.hub.connect(s.second.bob).settleAtExpiry(1)
	return s
})
const bothCashedOut = fixture(newSettled, async s => {
	await s.second.hub.connect(s.second.alice).claim(1, weth(10))
	await s.second.hub.connect(s.second.alice).claimPremium(1)
	return s
})

// BrowserProvider wraps the raw provider, so the caching tests get a chain of their own.
const cachingChain = await network.create()
const cachingPlans = fixture(cachingChain, async () => {
	const [deployer] = await cachingChain.ethers.getSigners()
	const registryArtifact = await artifacts.readArtifact("IvyVaultsRegistry")
	const identity = {
		chainId: (await cachingChain.ethers.provider.getNetwork()).chainId,
		genesisHash: (await cachingChain.ethers.provider.getBlock(0))!.hash,
		deployer: deployer.address,
		admin: deployer.address,
	}
	const registryPlan = await buildRegistryDeploymentPlan({ ...identity, artifact: registryArtifact, startNonce: 0 })
	const hubPlan = await buildDeploymentPlan({
		...identity,
		artifacts: await loadArtifacts(),
		reportSigner: deployer.address,
		startNonce: 1,
		exerciseWindow: EXERCISE_WINDOW,
		expiryPricePublicationWindow: EXPIRY_PRICE_PUBLICATION_WINDOW,
	})
	return { deployer, registryArtifact, registryPlan, hubPlan }
})
const cachingRegistryDeployed = fixture(cachingPlans, async p => {
	await resumeRegistryDeployment(p.deployer, p.registryPlan, p.registryArtifact)
	return p
})

const invalidRegistrations = [
	{ name: "version zero", args: (hub: string) => [0, hub, MANIFEST_HASH] as const },
	{ name: "a zero hub address", args: () => [1, ZeroAddress, MANIFEST_HASH] as const },
	{ name: "a hub without code", args: (_hub: string, eoa: string) => [1, eoa, MANIFEST_HASH] as const },
	{ name: "a zero manifest hash", args: (hub: string) => [1, hub, ZeroHash] as const },
]

describe("release registry", () => {
	describe("IvyVaultsRegistry", () => {
		let outsider: HardhatEthersSigner
		let registry: Awaited<ReturnType<typeof registryDeployed>>["registry"]
		let hub: string

		describe("constructor", () => {
			beforeEach(async () => {
				await registryDeployed()
			})

			it("rejects a zero admin", async () => {
				const factory = await ethers.getContractFactory("IvyVaultsRegistry")
				await expect(factory.deploy(ZeroAddress)).to.be.revertedWithCustomError(factory, "InvalidRegistration")
			})
		})

		context("before any registration", () => {
			beforeEach(async () => {
				;({ registry } = await registryDeployed())
			})

			it("recommends no version", async () => {
				expect(await registry.recommendedVersion()).to.equal(0n)
			})

			it("reverts a hub lookup for an unknown release", async () => {
				await expect(registry.hubOf(1)).to.be.revertedWithCustomError(registry, "UnknownRelease")
			})

			it("reverts a manifest hash lookup for an unknown release", async () => {
				await expect(registry.manifestHashOf(1)).to.be.revertedWithCustomError(registry, "UnknownRelease")
			})
		})

		describe("registerVersion", () => {
			context("before any registration", () => {
				beforeEach(async () => {
					;({ outsider, registry, hub } = await registryDeployed())
				})

				it("rejects an account without the admin role", async () => {
					await expect(registry.connect(outsider).registerVersion(1, hub, MANIFEST_HASH)).to.be.revertedWithCustomError(
						registry,
						"AccessControlUnauthorizedAccount",
					)
				})

				for (const invalid of invalidRegistrations) {
					it(`rejects ${invalid.name}`, async () => {
						await expect(registry.registerVersion(...invalid.args(hub, outsider.address))).to.be.revertedWithCustomError(
							registry,
							"InvalidRegistration",
						)
					})
				}

				it("registers a version and emits VersionRegistered", async () => {
					await expect(registry.registerVersion(1, hub, MANIFEST_HASH))
						.to.emit(registry, "VersionRegistered")
						.withArgs(1, hub, MANIFEST_HASH)
				})
			})

			context("after version 1 is registered", () => {
				beforeEach(async () => {
					;({ registry, hub } = await versionOneRegistered())
				})

				it("leaves the recommendation unset", async () => {
					expect(await registry.recommendedVersion()).to.equal(0n)
				})

				it("records the hub and manifest hash of the version", async () => {
					expect(await registry.hubOf(1)).to.equal(hub)
					expect(await registry.manifestHashOf(1)).to.equal(MANIFEST_HASH)
				})

				it("rejects another hub under the same version", async () => {
					await expect(registry.registerVersion(1, await registry.getAddress(), MANIFEST_HASH)).to.be.revertedWithCustomError(
						registry,
						"AlreadyRegistered",
					)
				})

				it("rejects the same hub under another version", async () => {
					await expect(registry.registerVersion(2, hub, MANIFEST_HASH)).to.be.revertedWithCustomError(registry, "AlreadyRegistered")
				})
			})
		})

		describe("setRecommendedVersion", () => {
			context("after version 1 is registered", () => {
				beforeEach(async () => {
					;({ outsider, registry, hub } = await versionOneRegistered())
				})

				it("rejects an unregistered version", async () => {
					await expect(registry.setRecommendedVersion(2)).to.be.revertedWithCustomError(registry, "UnknownRelease")
				})

				it("rejects an account without the admin role", async () => {
					await expect(registry.connect(outsider).setRecommendedVersion(1)).to.be.revertedWithCustomError(
						registry,
						"AccessControlUnauthorizedAccount",
					)
				})

				it("recommends a registered version", async () => {
					await expect(registry.setRecommendedVersion(1)).to.emit(registry, "RecommendedVersionUpdated").withArgs(0, 1)
				})

				context("once version 1 is recommended", () => {
					beforeEach(async () => {
						await registry.setRecommendedVersion(1)
					})

					it("keeps the hub and manifest hash of the version", async () => {
						expect(await registry.hubOf(1)).to.equal(hub)
						expect(await registry.manifestHashOf(1)).to.equal(MANIFEST_HASH)
					})
				})
			})
		})
	})

	describe("verifyRelease", () => {
		skipUnderCoverage()

		let supported: Artifacts
		let bundle: ReleaseBundle

		beforeEach(async () => {
			;({ supported, bundle } = await released())
		})

		it("rejects a manifest without the IvyBidRules validator", async () => {
			const noValidator = structuredClone(bundle)
			delete noValidator.manifest.addresses.IvyBidRules
			noValidator.manifest.steps = noValidator.manifest.steps.filter(s => s.name !== "IvyBidRules")
			await expect(verifyRelease(ethers.provider, noValidator, supported)).to.be.rejectedWith("lacks IvyBidRules")
		})

		it("rejects an unknown interface format", async () => {
			await expect(verifyRelease(ethers.provider, { ...bundle, interfaceFormat: "unknown" }, supported)).to.be.rejectedWith(
				"Unsupported release format",
			)
		})

		it("rejects a historical release that needs its preserved build", async () => {
			const historical = { ...bundle, interfaceFormat: "ivy-vaults-v2", manifest: { ...bundle.manifest, version: 6 } }
			await expect(verifyRelease(ethers.provider, historical, supported)).to.be.rejectedWith("historical releases require their preserved build")
		})

		it("rejects a release from another chain", async () => {
			await expect(verifyRelease(ethers.provider, { ...bundle, manifest: { ...bundle.manifest, chainId: "1" } }, supported)).to.be.rejectedWith(
				"Wrong chain",
			)
		})

		it("rejects creation data that does not match the saved artifacts", async () => {
			const corrupt = structuredClone(bundle)
			corrupt.manifest.steps[0].data = "0x00"
			await expect(verifyRelease(ethers.provider, corrupt, supported)).to.be.rejectedWith("does not match saved artifacts")
		})

		it("rejects an interface this build does not support", async () => {
			const corruptAbi = structuredClone(bundle)
			corruptAbi.artifacts.IvyVaultsHub.abi = []
			await expect(verifyRelease(ethers.provider, corruptAbi, supported)).to.be.rejectedWith("Unsupported release interface")
		})

		it("rejects a journal whose creation transaction does not match", async () => {
			const corruptReceipt = structuredClone(bundle)
			corruptReceipt.journal.steps!.IvyVaultsHub.hash = ZeroHash
			await expect(verifyRelease(ethers.provider, corruptReceipt, supported)).to.be.rejectedWith("Creation evidence mismatch")
		})
	})

	describe("resolveRelease", () => {
		skipUnderCoverage()

		let admin: HardhatEthersSigner
		let outsider: HardhatEthersSigner
		let supported: Artifacts
		let bundle: ReleaseBundle
		let registry: Awaited<ReturnType<typeof released>>["registry"]
		let request: ReleaseRequest

		context("with release 7 registered", () => {
			beforeEach(async () => {
				;({ admin, outsider, supported, bundle, registry } = await releaseSevenRegistered())
				request = { registry: await registry.getAddress(), releaseBundle: bundle, releaseId: 7 }
			})

			it("resolves the hub of an explicit release", async () => {
				const resolved = await resolveRelease(ethers.provider, request, supported)
				expect(resolved.hub).to.equal(bundle.manifest.addresses.IvyVaultsHub)
			})

			it("resolves the release's IvyBidRules validator", async () => {
				expect(bundle.manifest.addresses.IvyBidRules).to.match(/^0x[0-9a-fA-F]{40}$/)
				const resolved = await resolveRelease(ethers.provider, request, supported)
				expect(resolved.addresses.IvyBidRules).to.equal(bundle.manifest.addresses.IvyBidRules)
			})

			it("rejects a recommended lookup while nothing is recommended", async () => {
				await expect(resolveRelease(ethers.provider, { ...request, releaseId: undefined }, supported, { allowRecommended: true })).to.be.rejectedWith(
					"No recommended release",
				)
			})

			it("rejects a hub that does not belong to the release", async () => {
				await expect(resolveRelease(ethers.provider, { ...request, hub: admin.address }, supported)).to.be.rejectedWith("Hub and release mismatch")
			})

			it("still resolves after the hub admin hands its role to another account", async () => {
				const hub = await ethers.getContractAt("IvyVaultsHub", bundle.manifest.addresses.IvyVaultsHub)
				await hub.grantRole(ZeroHash, outsider.address)
				await hub.renounceRole(ZeroHash, admin.address)
				expect((await resolveRelease(ethers.provider, request, supported)).hub).to.equal(bundle.manifest.addresses.IvyVaultsHub)
			})

			context("once release 7 is recommended", () => {
				beforeEach(async () => {
					await registry.setRecommendedVersion(7)
				})

				it("resolves the recommendation when allowed", async () => {
					const resolved = await resolveRelease(ethers.provider, { ...request, releaseId: undefined }, supported, {
						allowRecommended: true,
					})
					expect(resolved.hub).to.equal(bundle.manifest.addresses.IvyVaultsHub)
				})

				it("still requires an explicit release id unless recommendations are allowed", async () => {
					await expect(resolveRelease(ethers.provider, { ...request, releaseId: undefined }, supported)).to.be.rejectedWith("Explicit releaseId")
				})
			})
		})
	})

	describe("release-resolved vault creation", () => {
		skipUnderCoverage()

		let staffed: Awaited<ReturnType<typeof releaseOneStaffed>>

		context("with release 1 resolved and one account holding the trading roles", () => {
			beforeEach(async () => {
				staffed = await releaseOneStaffed()
			})

			it("activates a vault gated by the release's validator from a bid signed for the resolved hub", async () => {
				const { admin, resolved, hub, wethToken, usdcToken } = staffed
				const [wethAddress, usdcAddress] = [await wethToken.getAddress(), await usdcToken.getAddress()]
				// Two hours out: any future expiry works, since the vault only has to activate before it.
				const expiry = BigInt(await networkHelpers.time.latest()) + 7200n
				const terms: VaultTermsInput = {
					underlying: wethAddress,
					collateral: wethAddress,
					allowPartialExercise: true,
					publicDeposits: false,
					allowedExercise: ExercisePolicy.Either,
					allowedSettlement: SettlementPolicy.Physical,
					expiry,
					auctionStartsAt: 0n,
					minCollateral: 0n,
					maxSettlementPriceAge: 0,
				}
				const rules = [
					{
						validator: resolved.addresses.IvyBidRules,
						kind: RuleKind.PairLimits,
						data: encodePairLimits([[usdcAddress, STRIKE, PREMIUM_PER_UNIT]]),
					},
				]
				await hub.createVault(terms, [{ quoteToken: usdcAddress, premiumToken: usdcAddress }], rules)
				const vaultId = await hub.vaultCount()
				const vault = await hub.vaultOf(vaultId)
				await wethToken.mint(admin.address, weth(1))
				await wethToken.approve(vault, weth(1))
				await hub.deposit(vaultId, weth(1))
				await hub.openAuction(vaultId)
				const bid: Bid = {
					vaultId,
					marketMaker: admin.address,
					quoteToken: usdcAddress,
					strike: STRIKE,
					premiumPerUnit: PREMIUM_PER_UNIT,
					style: ExerciseStyle.American,
					settlement: SettlementType.Physical,
					expiry,
					validUntil: expiry,
					nonce: 1n,
					auctionId: (await hub.stateOf(vaultId)).auctionId,
					collateralAmount: await hub.totalShares(vaultId),
					termsHash: await hub.termsHashOf(vaultId),
					executor: ZeroAddress,
					recipient: admin.address,
				}
				// Premium on 1 WETH of notional.
				await usdcToken.mint(admin.address, PREMIUM_PER_UNIT)
				await usdcToken.approve(vault, PREMIUM_PER_UNIT)
				await hub.activate(vaultId, bid, await signBid(admin, resolved.hub, bid))
				expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Live)
			})
		})
	})

	describe("resumeRegistryDeployment", () => {
		let admin: HardhatEthersSigner
		let artifact: Artifact
		let plan: RegistryPlan

		beforeEach(async () => {
			;({ admin, artifact, plan } = await registryPlanned())
		})

		it("rejects an unsupported plan version", async () => {
			await expect(resumeRegistryDeployment(admin, { ...plan, version: 99 }, artifact)).to.be.rejectedWith("Unsupported registry plan")
		})

		it("rejects a plan that does not match this build", async () => {
			await expect(resumeRegistryDeployment(admin, { ...plan, admin: ZeroAddress }, artifact)).to.be.rejectedWith("does not match")
		})

		context("after an interruption that lost the submitted hash", () => {
			let saved: Journal

			beforeEach(async () => {
				await expect(
					resumeRegistryDeployment(admin, plan, artifact, {}, async j => {
						saved = structuredClone(j)
						if (j.steps?.IvyVaultsRegistry?.hash) throw new Error("interrupted")
					}),
				).to.be.rejectedWith("interrupted")
				delete saved.steps!.IvyVaultsRegistry.hash
			})

			it("recovers the mined registry without consuming a second nonce", async () => {
				const recovered = await resumeRegistryDeployment(admin, plan, artifact, saved)
				expect(recovered.complete).to.equal(true)
				expect(await admin.getNonce()).to.equal(plan.startNonce + 1)
			})

			it("leaves the recovered registry without a recommendation", async () => {
				await resumeRegistryDeployment(admin, plan, artifact, saved)
				const registry = await ethers.getContractAt("IvyVaultsRegistry", plan.address)
				expect(await registry.recommendedVersion()).to.equal(0n)
			})
		})
	})

	describe("deployment through a caching RPC provider", () => {
		skipUnderCoverage()

		let provider: BrowserProvider
		let signer: JsonRpcSigner
		let registryArtifact: Artifact
		let registryPlan: RegistryPlan
		let hubPlan: DeploymentPlan

		beforeEach(() => {
			provider = new BrowserProvider(cachingChain.provider, undefined, { cacheTimeout: 2_000 })
		})

		afterEach(() => {
			provider.destroy()
		})

		context("before the registry is deployed", () => {
			beforeEach(async () => {
				;({ registryArtifact, registryPlan } = await cachingPlans())
				signer = await provider.getSigner()
			})

			it("verifies the freshly mined registry even when its empty code read is cached", async () => {
				expect(await provider.getCode(registryPlan.address)).to.equal("0x")
				let journal: Journal = {}
				await expect(
					resumeRegistryDeployment(signer, registryPlan, registryArtifact, {}, async j => {
						journal = structuredClone(j)
						if (j.steps?.IvyVaultsRegistry?.hash) throw new Error("lost registry hash")
					}),
				).to.be.rejectedWith("lost registry hash")
				delete journal.steps!.IvyVaultsRegistry.hash
				const recovered = await resumeRegistryDeployment(signer, registryPlan, registryArtifact, journal)
				expect(recovered.complete).to.equal(true)
			})
		})

		context("once the registry is deployed", () => {
			beforeEach(async () => {
				;({ hubPlan } = await cachingRegistryDeployed())
				signer = await provider.getSigner()
			})

			it("verifies the freshly mined hub steps even when their empty code reads are cached", async () => {
				for (const step of hubPlan.steps) expect(await provider.getCode(step.address)).to.equal("0x")
				let journal: Journal = {}
				await expect(
					resumeDeployment(signer, hubPlan, {}, async j => {
						journal = structuredClone(j)
						if (j.steps?.IvyVaultRules?.hash) throw new Error("lost library hash")
					}),
				).to.be.rejectedWith("lost library hash")
				delete journal.steps!.IvyVaultRules.hash
				expect((await resumeDeployment(signer, hubPlan, journal)).complete).to.equal(true)
				// One registry creation plus the nine planned hub steps.
				const sent = await provider.send("eth_getTransactionCount", [await signer.getAddress(), "latest"])
				expect(Number(BigInt(sent))).to.equal(10)
			})
		})
	})

	describe("coexisting releases", () => {
		let first: IvyContext
		let second: IvyContext
		let oldPosition: LiveVault
		let newPosition: LiveVault

		context("with vault 1 live on two hubs that share tokens and an LP", () => {
			beforeEach(async () => {
				;({ oldPosition, newPosition } = await twoLiveReleases())
			})

			it("assigns vault ID 1 on both hubs", () => {
				expect(oldPosition.vaultId).to.equal(1n)
				expect(newPosition.vaultId).to.equal(1n)
			})

			it("deploys each vault 1 at its own address", () => {
				expect(oldPosition.vaultAddress).to.not.equal(newPosition.vaultAddress)
			})
		})

		context("after the registry recommends the second hub", () => {
			let registry: Awaited<ReturnType<typeof secondRecommended>>["registry"]
			let originalTerms: Awaited<ReturnType<IvyContext["hub"]["termsOf"]>>
			let originalState: Awaited<ReturnType<IvyContext["hub"]["stateOf"]>>

			beforeEach(async () => {
				;({ first, second, oldPosition, newPosition, registry, originalTerms, originalState } = await secondRecommended())
			})

			it("records each hub under its own release", async () => {
				expect(await registry.hubOf(1)).to.equal(first.hubAddress)
				expect(await registry.hubOf(2)).to.equal(second.hubAddress)
			})

			it("leaves the first hub's vault terms and state unchanged", async () => {
				expect(await first.hub.termsOf(1)).to.deep.equal(originalTerms)
				expect(await first.hub.stateOf(1)).to.deep.equal(originalState)
			})

			it("keeps each vault bound to its own hub", async () => {
				expect(await oldPosition.vault.hub()).to.equal(first.hubAddress)
				expect(await newPosition.vault.hub()).to.equal(second.hubAddress)
			})

			it("keeps each hub on its own share token", async () => {
				expect(await first.hub.shareToken()).to.equal(first.sharesAddress)
				expect(await second.hub.shareToken()).to.equal(second.sharesAddress)
			})

			it("leaves both hubs unpaused", async () => {
				expect(await first.hub.globalPaused()).to.equal(false)
				expect(await second.hub.globalPaused()).to.equal(false)
			})

			it("gives neither the registry nor its curator admin over the first hub", async () => {
				const adminRole = await first.hub.DEFAULT_ADMIN_ROLE()
				expect(await first.hub.hasRole(adminRole, await registry.getAddress())).to.equal(false)
				expect(await first.hub.hasRole(adminRole, first.carol.address)).to.equal(false)
			})

			it("lets the market maker exercise the old position through the first hub", async () => {
				await expect(first.hub.connect(first.marketMaker).exercise(1, weth(4))).to.changeTokenBalances(
					ethers,
					first.weth,
					[first.marketMaker, oldPosition.vaultAddress],
					[weth(4), -weth(4)],
				)
				// 1,000 USDC premium plus 4 WETH × 3,000 USDC strike.
				expect(await first.usdc.balanceOf(oldPosition.vaultAddress)).to.equal(usdc(13_000))
			})
		})

		context("after the old position is partially exercised", () => {
			beforeEach(async () => {
				;({ first, second, newPosition } = await oldExercised())
			})

			it("leaves the new position's collateral, premium and notional untouched", async () => {
				expect(await first.weth.balanceOf(newPosition.vaultAddress)).to.equal(weth(10))
				expect(await first.usdc.balanceOf(newPosition.vaultAddress)).to.equal(usdc(1000))
				expect(await second.hub.remainingNotional(1)).to.equal(weth(10))
			})
		})

		context("once the first hub settles the old position at expiry", () => {
			beforeEach(async () => {
				;({ first, oldPosition } = await oldSettled())
			})

			it("pays the LP the unexercised collateral and the strike proceeds", async () => {
				const claim = first.hub.connect(first.alice).claim(1, weth(10))
				await expect(claim).to.changeTokenBalances(ethers, first.weth, [first.alice, oldPosition.vaultAddress], [weth(6), -weth(6)])
				await expect(claim).to.changeTokenBalances(ethers, first.usdc, [first.alice, oldPosition.vaultAddress], [usdc(12_000), -usdc(12_000)])
			})

			it("pays the LP the old premium after the claim", async () => {
				await first.hub.connect(first.alice).claim(1, weth(10))
				await expect(first.hub.connect(first.alice).claimPremium(1)).to.changeTokenBalances(
					ethers,
					first.usdc,
					[first.alice, oldPosition.vaultAddress],
					[usdc(1000), -usdc(1000)],
				)
			})
		})

		context("after the LP cashes out of the old position", () => {
			beforeEach(async () => {
				;({ first, second } = await oldCashedOut())
			})

			it("burns the LP's shares on the first hub only", async () => {
				expect(await first.shares.balanceOf(first.alice.address, 1)).to.equal(0n)
				expect(await second.shares.balanceOf(first.alice.address, 1)).to.equal(weth(10))
			})

			it("leaves the second hub's vault live", async () => {
				expect((await second.hub.stateOf(1)).phase).to.equal(Phase.Live)
			})
		})

		context("once the second hub settles the new position at expiry", () => {
			beforeEach(async () => {
				;({ second, newPosition } = await newSettled())
			})

			it("pays the LP the new position's full collateral", async () => {
				await expect(second.hub.connect(second.alice).claim(1, weth(10))).to.changeTokenBalances(
					ethers,
					second.weth,
					[second.alice, newPosition.vaultAddress],
					[weth(10), -weth(10)],
				)
			})
		})

		context("after the LP cashes out of both positions", () => {
			beforeEach(async () => {
				;({ first, second, oldPosition, newPosition } = await bothCashedOut())
			})

			it("leaves no quote tokens in either vault", async () => {
				expect(await first.usdc.balanceOf(oldPosition.vaultAddress)).to.equal(0n)
				expect(await first.usdc.balanceOf(newPosition.vaultAddress)).to.equal(0n)
			})

			it("leaves no shares on either hub", async () => {
				expect(await first.hub.totalShares(1)).to.equal(0n)
				expect(await second.hub.totalShares(1)).to.equal(0n)
			})
		})
	})
})
