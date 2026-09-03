import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { AUCTION_TIMEOUT, EXERCISE_WINDOW, SETTLEMENT_GRACE, deployIvy } from "./helpers/setup.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe("IvyVaultsHub admin", function () {
  const fixture = () => deployIvy(connection);

  it("initializes settings, roles, uri and the EIP-712 domain", async function () {
    const { hub, admin, bidMaster, marketMaker, vaultImplAddress } = await networkHelpers.loadFixture(fixture);
    expect(await hub.exerciseWindow()).to.equal(EXERCISE_WINDOW);
    expect(await hub.auctionTimeout()).to.equal(AUCTION_TIMEOUT);
    expect(await hub.settlementGracePeriod()).to.equal(SETTLEMENT_GRACE);
    expect(await hub.vaultImplementation()).to.equal(vaultImplAddress);
    expect(await hub.vaultCount()).to.equal(0n);
    expect(await hub.hasRole(await hub.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await hub.hasRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).to.equal(true);
    expect(await hub.hasRole(await hub.MARKET_MAKER_ROLE(), marketMaker.address)).to.equal(true);
    expect(await hub.uri(1n)).to.equal("ipfs://ivy/{id}.json");
    expect(await hub.version()).to.equal("1");
    const domain = await hub.eip712Domain();
    expect(domain.name).to.equal("IvyVaultsHub");
    expect(domain.version).to.equal("1");
  });

  it("cannot be initialized twice, and the implementation is locked", async function () {
    const { hub, hubImpl, admin, vaultImplAddress } = await networkHelpers.loadFixture(fixture);
    const args = [admin.address, vaultImplAddress, 1n, 1n, 1n, ""] as const;
    await expect(hub.initialize(...args)).to.be.revertedWithCustomError(hub, "InvalidInitialization");
    await expect(hubImpl.initialize(...args)).to.be.revertedWithCustomError(hubImpl, "InvalidInitialization");
  });

  it("only the admin can change settings, implementation and uri", async function () {
    const { hub, admin, alice } = await networkHelpers.loadFixture(fixture);
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
    expect(await hub.uri(5n)).to.equal("ipfs://new/{id}");
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
    const { hub } = await networkHelpers.loadFixture(fixture);
    expect(await hub.supportsInterface("0xd9b67a26")).to.equal(true); // ERC-1155
    expect(await hub.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
  });
});
