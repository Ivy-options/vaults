import { expect } from "chai";
import type {} from "chai-as-promised";
import { BrowserProvider } from "ethers";
import { artifacts, network } from "hardhat";
import { buildDeploymentPlan, resumeDeployment, loadArtifacts } from "../scripts/deployment.ts";
import { RULE_KIND, encodePairLimits } from "../scripts/encoding.ts";
import { buildRegistryDeploymentPlan, resumeRegistryDeployment } from "../scripts/registry-deployment.ts";
import { RELEASE_FORMAT, releaseHash, resolveRelease, verifyRelease } from "../scripts/releases.ts";
import { signBid } from "./helpers/bids.js";
import { fixture } from "./helpers/setup.js";

const connection = await network.create();
const { ethers } = connection;
const load = fixture(connection, async () => {
  const [admin, outsider] = await ethers.getSigners();
  const artifacts = await loadArtifacts();
  const manifest = await buildDeploymentPlan({
    artifacts,
    chainId: (await ethers.provider.getNetwork()).chainId,
    genesisHash: (await ethers.provider.getBlock(0))!.hash,
    deployer: admin.address,
    startNonce: await admin.getNonce(),
    admin: admin.address,
    reportSigner: outsider.address,
    exerciseWindow: 3600,
    expiryPricePublicationWindow: 3600,
  });
  const journal = await resumeDeployment(admin, manifest);
  const bundle = { format: 1, interfaceFormat: RELEASE_FORMAT, manifest, journal, artifacts };
  const registry = await (await ethers.getContractFactory("IvyVaultsRegistry")).deploy(admin.address);
  return { ...connection, admin, outsider, artifacts, bundle, registry };
});

describe("Immutable release registry", () => {
  it("keeps registrations permanent and recommendations explicitly administered", async () => {
    const [admin, outsider] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("IvyVaultsRegistry");
    await expect(factory.deploy(ethers.ZeroAddress)).revertedWithCustomError(factory, "InvalidRegistration");
    const registry = await factory.deploy(admin.address);
    const other = await factory.deploy(admin.address);
    const hub = await other.getAddress(),
      hash = ethers.id("verified manifest");
    expect(await registry.recommendedVersion()).equal(0n);
    await expect(registry.hubOf(1)).revertedWithCustomError(registry, "UnknownRelease");
    await expect(registry.manifestHashOf(1)).revertedWithCustomError(registry, "UnknownRelease");
    await expect(registry.connect(outsider).registerVersion(1, hub, hash)).revertedWithCustomError(
      registry,
      "AccessControlUnauthorizedAccount",
    );
    for (const args of [
      [0, hub, hash],
      [1, ethers.ZeroAddress, hash],
      [1, outsider.address, hash],
      [1, hub, ethers.ZeroHash],
    ] as const) {
      await expect(registry.registerVersion(args[0], args[1], args[2])).revertedWithCustomError(
        registry,
        "InvalidRegistration",
      );
    }
    await expect(registry.registerVersion(1, hub, hash))
      .emit(registry, "VersionRegistered")
      .withArgs(1, hub, hash);
    expect(await registry.recommendedVersion()).equal(0n);
    await expect(registry.registerVersion(1, await registry.getAddress(), hash)).revertedWithCustomError(
      registry,
      "AlreadyRegistered",
    );
    await expect(registry.registerVersion(2, hub, hash)).revertedWithCustomError(registry, "AlreadyRegistered");
    await expect(registry.setRecommendedVersion(2)).revertedWithCustomError(registry, "UnknownRelease");
    await expect(registry.connect(outsider).setRecommendedVersion(1)).revertedWithCustomError(
      registry,
      "AccessControlUnauthorizedAccount",
    );
    await expect(registry.setRecommendedVersion(1)).emit(registry, "RecommendedVersionUpdated").withArgs(0, 1);
    expect(await registry.hubOf(1)).equal(hub);
    expect(await registry.manifestHashOf(1)).equal(hash);
  });
});

describe("Verified release resolution", () => {
  let c: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    c = await load();
  });

  it("resolves an explicit release and checks its provenance", async () => {
    const { ethers, registry, bundle, artifacts, admin } = c;
    const request = {
      registry: await registry.getAddress(),
      releaseBundle: bundle,
      releaseId: 7,
      sender: admin.address,
      rateBps: 10,
    };
    await registry.registerVersion(7, bundle.manifest.addresses.IvyVaultsHub, releaseHash(bundle));
    const resolved = await resolveRelease(ethers.provider, request, artifacts);
    expect(resolved.hub).equal(bundle.manifest.addresses.IvyVaultsHub);
    expect(bundle.manifest.addresses.IvyBidRules).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(resolved.addresses.IvyBidRules).equal(bundle.manifest.addresses.IvyBidRules);
    const noValidator = structuredClone(bundle);
    delete noValidator.manifest.addresses.IvyBidRules;
    noValidator.manifest.steps = noValidator.manifest.steps.filter((s: any) => s.name !== "IvyBidRules");
    await expect(verifyRelease(ethers.provider, noValidator, artifacts)).rejectedWith("lacks IvyBidRules");
    await expect(
      resolveRelease(ethers.provider, { ...request, releaseId: undefined }, artifacts, { allowRecommended: true }),
    ).rejectedWith("No recommended release");
    await registry.setRecommendedVersion(7);
    expect(
      (
        await resolveRelease(ethers.provider, { ...request, releaseId: undefined }, artifacts, {
          allowRecommended: true,
        })
      ).hub,
    ).equal(resolved.hub);
    await expect(resolveRelease(ethers.provider, { ...request, releaseId: undefined }, artifacts)).rejectedWith(
      "Explicit releaseId",
    );
    await expect(resolveRelease(ethers.provider, { ...request, hub: admin.address }, artifacts)).rejectedWith(
      "Hub and release mismatch",
    );
    await expect(verifyRelease(ethers.provider, { ...bundle, interfaceFormat: "unknown" }, artifacts)).rejectedWith(
      "Unsupported release format",
    );
    await expect(
      verifyRelease(
        ethers.provider,
        { ...bundle, interfaceFormat: "ivy-vaults-v2", manifest: { ...bundle.manifest, version: 6 } },
        artifacts,
      ),
    ).rejectedWith("historical releases require their preserved build");
    await expect(
      verifyRelease(ethers.provider, { ...bundle, manifest: { ...bundle.manifest, chainId: "1" } }, artifacts),
    ).rejectedWith("Wrong chain");
    const corrupt = structuredClone(bundle);
    corrupt.manifest.steps[0].data = "0x00";
    await expect(verifyRelease(ethers.provider, corrupt, artifacts)).rejectedWith("does not match saved artifacts");
    const corruptAbi = structuredClone(bundle);
    corruptAbi.artifacts.IvyVaultsHub.abi = [];
    await expect(verifyRelease(ethers.provider, corruptAbi, artifacts)).rejectedWith("Unsupported release interface");
    const corruptReceipt = structuredClone(bundle);
    corruptReceipt.journal.steps!.IvyVaultsHub.hash = ethers.ZeroHash;
    await expect(verifyRelease(ethers.provider, corruptReceipt, artifacts)).rejectedWith("Creation evidence mismatch");
    const hub = await ethers.getContractAt("IvyVaultsHub", resolved.hub);
    await hub.grantRole(ethers.ZeroHash, c.outsider.address);
    await hub.renounceRole(ethers.ZeroHash, admin.address);
    expect((await resolveRelease(ethers.provider, request, artifacts)).hub).equal(resolved.hub);
  });
});

describe("Release-resolved vault creation", () => {
  let c: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    c = await load();
  });

  it("creates a vault with the manifest's validator, signs with termsHash and activates", async () => {
    const { ethers, registry, bundle, artifacts, admin } = c;
    await registry.registerVersion(1, bundle.manifest.addresses.IvyVaultsHub, releaseHash(bundle));
    const resolved = await resolveRelease(
      ethers.provider,
      { registry: await registry.getAddress(), releaseBundle: bundle, releaseId: 1 },
      artifacts,
    );
    const hub = await ethers.getContractAt("IvyVaultsHub", resolved.hub);
    const weth = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
    const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    const [w, u] = [await weth.getAddress(), await usdc.getAddress()];
    await hub.grantRole(await hub.BID_MASTER_ROLE(), admin.address);
    await hub.grantRole(await hub.MARKET_MAKER_ROLE(), admin.address);
    const expiry = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 7200n;
    await weth.mint(admin.address, 10n ** 18n);
    const terms = {
      underlying: w,
      collateral: w,
      allowPartialExercise: true,
      publicDeposits: false,
      allowedExercise: 2,
      allowedSettlement: 0,
      expiry,
      auctionStartsAt: 0,
      minCollateral: 0,
      maxSettlementPriceAge: 0,
    };
    const rules = [
      {
        validator: resolved.addresses.IvyBidRules,
        kind: RULE_KIND.PairLimits,
        data: encodePairLimits([[u, 3000n * 10n ** 6n, 100n * 10n ** 6n]]),
      },
    ];
    await hub.createVault(terms, [{ quoteToken: u, premiumToken: u }], rules);
    const vaultId = await hub.vaultCount();
    const vault = await hub.vaultOf(vaultId);
    await weth.approve(vault, 10n ** 18n);
    await hub.deposit(vaultId, 10n ** 18n);
    await hub.openAuction(vaultId);
    const state = await hub.stateOf(vaultId);
    const bid = {
      vaultId,
      marketMaker: admin.address,
      quoteToken: u,
      strike: 3000n * 10n ** 6n,
      premium: 100n * 10n ** 6n,
      style: 1,
      settlement: 0,
      expiry,
      validUntil: expiry,
      nonce: 1n,
      auctionId: state.auctionId,
      collateralAmount: await hub.totalShares(vaultId),
      termsHash: await hub.termsHashOf(vaultId),
      executor: ethers.ZeroAddress,
      recipient: admin.address,
    };
    await usdc.mint(admin.address, 100n * 10n ** 6n);
    await usdc.approve(vault, 100n * 10n ** 6n);
    await hub.activate(vaultId, bid, await signBid(admin, resolved.hub, bid));
    expect((await hub.stateOf(vaultId)).phase).equal(2);
  });
});

describe("Separate registry deployment", () => {
  it("recovers a mined creation after interruption without consuming a second nonce", async () => {
    const [admin] = await ethers.getSigners();
    const artifact = await artifacts.readArtifact("IvyVaultsRegistry");
    const plan = await buildRegistryDeploymentPlan({
      artifact,
      chainId: (await ethers.provider.getNetwork()).chainId,
      genesisHash: (await ethers.provider.getBlock(0))!.hash,
      deployer: admin.address,
      startNonce: await admin.getNonce(),
      admin: admin.address,
    });
    let saved: any;
    let interrupted = false;
    await expect(
      resumeRegistryDeployment(admin, plan, artifact, {}, async (j) => {
        saved = structuredClone(j);
        if (j.steps?.IvyVaultsRegistry?.hash && !interrupted) {
          interrupted = true;
          throw new Error("interrupted");
        }
      }),
    ).rejectedWith("interrupted");
    delete saved.steps.IvyVaultsRegistry.hash;
    const recovered = await resumeRegistryDeployment(admin, plan, artifact, saved);
    expect(recovered.complete).equal(true);
    expect(await admin.getNonce()).equal(plan.startNonce + 1);
    expect(await (await ethers.getContractAt("IvyVaultsRegistry", plan.address)).recommendedVersion()).equal(0n);
    await expect(resumeRegistryDeployment(admin, { ...plan, version: 99 }, artifact)).rejectedWith(
      "Unsupported registry plan",
    );
    await expect(resumeRegistryDeployment(admin, { ...plan, admin: ethers.ZeroAddress }, artifact)).rejectedWith(
      "does not match",
    );
  });
});

describe("Deployment through a caching RPC provider", () => {
  it("verifies freshly mined registry and Hub code even when an earlier latest-code read is cached", async () => {
    // Own chain: the plans hardcode deployer nonces 0 and 1 and the final count of 10.
    const connection = await network.create();
    const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: 2_000 });
    try {
      const signer = await provider.getSigner();
      const deployer = await signer.getAddress();
      const registryArtifact = await artifacts.readArtifact("IvyVaultsRegistry");
      const context = {
        chainId: (await provider.getNetwork()).chainId,
        genesisHash: (await provider.getBlock(0))!.hash,
        deployer,
        admin: deployer,
      };
      const registryPlan = await buildRegistryDeploymentPlan({ ...context, artifact: registryArtifact, startNonce: 0 });
      expect(await provider.getCode(registryPlan.address)).equal("0x");
      let registryJournal: any;
      await expect(
        resumeRegistryDeployment(signer, registryPlan, registryArtifact, {}, async (journal) => {
          registryJournal = structuredClone(journal);
          if (journal.steps?.IvyVaultsRegistry?.hash) throw new Error("lost registry hash");
        }),
      ).rejectedWith("lost registry hash");
      delete registryJournal.steps.IvyVaultsRegistry.hash;
      expect((await resumeRegistryDeployment(signer, registryPlan, registryArtifact, registryJournal)).complete).equal(
        true,
      );
      const hubPlan = await buildDeploymentPlan({
        ...context,
        artifacts: await loadArtifacts(),
        reportSigner: deployer,
        startNonce: 1,
        exerciseWindow: 3600,
        expiryPricePublicationWindow: 3600,
      });
      for (const step of hubPlan.steps) expect(await provider.getCode(step.address)).equal("0x");
      let hubJournal: any;
      await expect(
        resumeDeployment(signer, hubPlan, {}, async (journal) => {
          hubJournal = structuredClone(journal);
          if (journal.steps?.IvyVaultRules?.hash) throw new Error("lost library hash");
        }),
      ).rejectedWith("lost library hash");
      delete hubJournal.steps.IvyVaultRules.hash;
      expect((await resumeDeployment(signer, hubPlan, hubJournal)).complete).equal(true);
      expect(Number(BigInt(await provider.send("eth_getTransactionCount", [deployer, "latest"])))).equal(10);
    } finally {
      provider.destroy();
    }
  });
});
