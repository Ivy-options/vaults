import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { AUCTION_TIMEOUT, EXERCISE_WINDOW, SETTLEMENT_GRACE, callPairs, callTerms, deployIvy } from "./helpers/setup.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe("IvyVaultsHub admin", function () {
  const fixture = () => deployIvy(connection);

  it("initializes settings, roles, uri and the EIP-712 domain", async function () {
    const { hub, admin, bidMaster, marketMaker, vaultImplAddress, shares, sharesAddress, hubAddress } =
      await networkHelpers.loadFixture(fixture);
    expect(await hub.exerciseWindow()).to.equal(EXERCISE_WINDOW);
    expect(await hub.auctionTimeout()).to.equal(AUCTION_TIMEOUT);
    expect(await hub.settlementGracePeriod()).to.equal(SETTLEMENT_GRACE);
    expect(await hub.vaultImplementation()).to.equal(vaultImplAddress);
    expect(await hub.vaultCount()).to.equal(0n);
    expect(await hub.hasRole(await hub.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await hub.hasRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).to.equal(true);
    expect(await hub.hasRole(await hub.MARKET_MAKER_ROLE(), marketMaker.address)).to.equal(true);
    expect(await shares.uri(1n)).to.equal("ipfs://ivy/{id}.json");
    expect(await hub.shareToken()).to.equal(sharesAddress);
    expect(await shares.hub()).to.equal(hubAddress);
    expect(await hub.version()).to.equal("1");
    const domain = await hub.eip712Domain();
    expect(domain.name).to.equal("IvyVaultsHub");
    expect(domain.version).to.equal("1");
  });

  it("cannot be initialized twice, and the implementation is locked", async function () {
    const { hub, hubImpl, admin, vaultImplAddress } = await networkHelpers.loadFixture(fixture);
    const args = [admin.address, vaultImplAddress, 1n, 1n, 1n] as const;
    await expect(hub.initialize(...args)).to.be.revertedWithCustomError(hub, "InvalidInitialization");
    await expect(hubImpl.initialize(...args)).to.be.revertedWithCustomError(hubImpl, "InvalidInitialization");
  });

  it("only the admin can change settings, implementation and uri", async function () {
    const { hub, admin, alice, shares } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(alice).setSettings(1n, 2n, 3n)).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await expect(hub.connect(alice).setVaultImplementation(alice.address)).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await expect(hub.connect(alice).setURI("x")).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");

    await expect(hub.connect(admin).setSettings(1n, 2n, 3n)).to.emit(hub, "SettingsUpdated").withArgs(1n, 2n, 3n);
    expect(await hub.exerciseWindow()).to.equal(1n);
    expect(await hub.auctionTimeout()).to.equal(2n);
    expect(await hub.settlementGracePeriod()).to.equal(3n);

    await expect(hub.connect(admin).setVaultImplementation(ZeroAddress)).to.be.revertedWithCustomError(hub, "ZeroAddress");
    await expect(hub.connect(admin).setVaultImplementation(alice.address)).to.emit(hub, "VaultImplementationUpdated").withArgs(alice.address);
    expect(await hub.vaultImplementation()).to.equal(alice.address);

    await hub.connect(admin).setURI("ipfs://new/{id}");
    expect(await shares.uri(5n)).to.equal("ipfs://new/{id}");
  });

  it("admin can upgrade and storage survives", async function () {
    const { hub, admin, alice, bidMaster } = await networkHelpers.loadFixture(fixture);
    const v2 = await ethers.deployContract("IvyVaultsHubV2");
    const v2Address = await v2.getAddress();
    await expect(hub.connect(alice).upgradeToAndCall(v2Address, "0x")).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await hub.connect(admin).upgradeToAndCall(v2Address, "0x");
    expect(await hub.version()).to.equal("2");
    expect(await hub.exerciseWindow()).to.equal(EXERCISE_WINDOW);
    expect(await hub.hasRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).to.equal(true);
  });

  it("views reject unknown vault ids", async function () {
    const { hub, usdcAddress } = await networkHelpers.loadFixture(fixture);
    await expect(hub.termsOf(0n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.stateOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.vaultOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.kindOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.quoteTokensOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.pairTermsOf(1n, usdcAddress)).to.be.revertedWithCustomError(hub, "UnknownVault");
  });

  it("reports ERC-1155 and AccessControl interface support", async function () {
    const { hub, shares } = await networkHelpers.loadFixture(fixture);
    expect(await shares.supportsInterface("0xd9b67a26")).to.equal(true); // ERC-1155
    expect(await hub.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
    expect(await hub.supportsInterface("0xd9b67a26")).to.equal(false); // ERC-1155 lives on IvyShares, not the hub
  });

  it("wires the share token exactly once and only to a token that names this hub", async function () {
    const ctxLike = await networkHelpers.loadFixture(fixture);
    const { hub, admin, alice, sharesAddress, vaultImplAddress } = ctxLike;
    await expect(hub.connect(alice).setShares(sharesAddress)).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await expect(hub.connect(admin).setShares(sharesAddress)).to.be.revertedWithCustomError(hub, "SharesAlreadySet");

    // a second hub without a token yet
    const hubImpl2 = await ethers.deployContract("IvyVaultsHub");
    const init = hubImpl2.interface.encodeFunctionData("initialize", [admin.address, vaultImplAddress, 1n, 1n, 1n]);
    const proxy2 = await ethers.deployContract("ERC1967Proxy", [await hubImpl2.getAddress(), init]);
    const hub2 = await ethers.getContractAt("IvyVaultsHub", await proxy2.getAddress());
    await expect(hub2.connect(admin).setShares(ZeroAddress)).to.be.revertedWithCustomError(hub2, "ZeroAddress");
    await expect(hub2.connect(admin).setShares(sharesAddress)).to.be.revertedWithCustomError(hub2, "SharesHubMismatch"); // token names the first hub

    await expect(
      hub2.connect(admin).createVault(callTerms(ctxLike), callPairs(ctxLike)),
    ).to.be.revertedWithCustomError(hub2, "SharesNotSet");

    const shares2 = await ethers.deployContract("IvyShares", [await hub2.getAddress(), ""]);
    await expect(hub2.connect(admin).setShares(await shares2.getAddress())).to.emit(hub2, "SharesSet").withArgs(await shares2.getAddress());
    expect(await hub2.shareToken()).to.equal(await shares2.getAddress());
  });

  it("share token mint, burn and setURI are hub-only", async function () {
    const { shares, alice } = await networkHelpers.loadFixture(fixture);
    await expect(shares.connect(alice).mint(alice.address, 1n, 1n)).to.be.revertedWithCustomError(shares, "NotHub");
    await expect(shares.connect(alice).burn(alice.address, 1n, 1n)).to.be.revertedWithCustomError(shares, "NotHub");
    await expect(shares.connect(alice).setURI("x")).to.be.revertedWithCustomError(shares, "NotHub");
    await expect(ethers.deployContract("IvyShares", [ZeroAddress, ""])).to.be.revertedWithCustomError(shares, "ZeroAddress");
  });
});
