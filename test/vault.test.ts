import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const UNIT = 10n ** 18n;

describe("IvyVault", function () {
  async function fixture() {
    const [, alice, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
    const tokenAddress = await token.getAddress();
    const impl = await ethers.deployContract("IvyVault");
    const mockHub = await ethers.deployContract("MockHub");
    const mockHubAddress = await mockHub.getAddress();
    await (await mockHub.createClone(await impl.getAddress(), 1n, tokenAddress)).wait();
    const vaultAddress = await mockHub.lastClone();
    const vault = await ethers.getContractAt("IvyVault", vaultAddress);
    return { alice, stranger, token, tokenAddress, impl, mockHub, mockHubAddress, vault, vaultAddress };
  }

  it("locks the implementation so it cannot be initialized", async function () {
    const { impl, mockHubAddress, tokenAddress } = await networkHelpers.loadFixture(fixture);
    await expect(impl.initialize(mockHubAddress, 1n, tokenAddress, mockHubAddress)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
  });

  it("initializes a clone exactly once", async function () {
    const { vault, mockHubAddress, tokenAddress } = await networkHelpers.loadFixture(fixture);
    expect(await vault.hub()).to.equal(mockHubAddress);
    expect(await vault.vaultId()).to.equal(1n);
    expect(await vault.collateral()).to.equal(tokenAddress);
    await expect(vault.initialize(mockHubAddress, 2n, tokenAddress, mockHubAddress)).to.be.revertedWithCustomError(vault, "AlreadyInitialized");
  });

  it("direct deposit pulls collateral and notifies the hub with the received amount", async function () {
    const { vault, vaultAddress, token, alice, mockHub } = await networkHelpers.loadFixture(fixture);
    await token.mint(alice.address, 5n * UNIT);
    await token.connect(alice).approve(vaultAddress, 5n * UNIT);
    await vault.connect(alice).deposit(5n * UNIT);
    expect(await token.balanceOf(vaultAddress)).to.equal(5n * UNIT);
    expect(await mockHub.lastVaultId()).to.equal(1n);
    expect(await mockHub.lastDepositor()).to.equal(alice.address);
    expect(await mockHub.lastAmount()).to.equal(5n * UNIT);
    expect(await mockHub.calls()).to.equal(1n);
  });

  it("reports the balance delta for fee-on-transfer tokens", async function () {
    const { vault, vaultAddress, token, alice, mockHub } = await networkHelpers.loadFixture(fixture);
    await token.mint(alice.address, 1000n);
    await token.connect(alice).approve(vaultAddress, 1000n);
    await token.setFeeBps(100n);
    await vault.connect(alice).deposit(1000n);
    expect(await mockHub.lastAmount()).to.equal(990n);
  });

  it("pull and push are hub-only", async function () {
    const { vault, tokenAddress, alice, stranger } = await networkHelpers.loadFixture(fixture);
    await expect(vault.connect(stranger).pull(tokenAddress, alice.address, 1n)).to.be.revertedWithCustomError(vault, "NotHub");
    await expect(vault.connect(stranger).push(tokenAddress, stranger.address, 1n)).to.be.revertedWithCustomError(vault, "NotHub");
  });

  it("the hub can pull and push", async function () {
    const { vault, vaultAddress, token, tokenAddress, alice, stranger, mockHub } = await networkHelpers.loadFixture(fixture);
    await token.mint(alice.address, 2n * UNIT);
    await token.connect(alice).approve(vaultAddress, 2n * UNIT);
    await mockHub.pull(vaultAddress, tokenAddress, alice.address, 2n * UNIT);
    expect(await token.balanceOf(vaultAddress)).to.equal(2n * UNIT);
    await mockHub.push(vaultAddress, tokenAddress, stranger.address, UNIT);
    expect(await token.balanceOf(stranger.address)).to.equal(UNIT);
    expect(await token.balanceOf(vaultAddress)).to.equal(UNIT);
    void vault;
  });

  it("rejects native ether", async function () {
    const { vaultAddress, alice } = await networkHelpers.loadFixture(fixture);
    await expect(alice.sendTransaction({ to: vaultAddress, value: 1n })).to.be.revert(ethers);
  });
});
