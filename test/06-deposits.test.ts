import { expect } from "chai";
import { network } from "hardhat";
import { Phase, WETH_UNIT, callPairs, callTerms, createVaultAs, deployIvy, fund } from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("deposits and withdrawals", function () {
  async function fixture() {
    const ctx = await deployIvy(connection);
    const v = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    return { ...ctx, ...v };
  }

  it("hub deposit pulls collateral into the vault and mints 1:1 shares", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 5n * WETH_UNIT);
    await expect(hub.connect(alice).deposit(vaultId, 5n * WETH_UNIT))
      .to.emit(hub, "Deposited")
      .withArgs(vaultId, alice.address, 5n * WETH_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(5n * WETH_UNIT);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(5n * WETH_UNIT);
    expect(await hub.totalShares(vaultId)).to.equal(5n * WETH_UNIT);
  });

  it("direct vault deposit credits the depositor through onVaultDeposit", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, bob, vault, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, bob, vaultAddress, 2n * WETH_UNIT);
    await expect(vault.connect(bob).deposit(2n * WETH_UNIT))
      .to.emit(hub, "Deposited")
      .withArgs(vaultId, bob.address, 2n * WETH_UNIT);
    expect(await hub.balanceOf(bob.address, vaultId)).to.equal(2n * WETH_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(2n * WETH_UNIT);
  });

  it("credits only what actually arrived for fee-on-transfer collateral", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 1000n);
    await weth.setFeeBps(100n);
    await hub.connect(alice).deposit(vaultId, 1000n);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(990n);
  });

  it("owner-only vaults reject other depositors on both paths", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, bob } = ctx;
    const { vaultId, vault, vaultAddress } = await createVaultAs(ctx, alice, callTerms(ctx, { publicDeposits: false }), callPairs(ctx));
    await fund(ctx, weth, bob, vaultAddress, WETH_UNIT);
    await expect(hub.connect(bob).deposit(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "DepositsNotPublic");
    await expect(vault.connect(bob).deposit(WETH_UNIT)).to.be.revertedWithCustomError(hub, "DepositsNotPublic");
    await fund(ctx, weth, alice, vaultAddress, WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, WETH_UNIT);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(WETH_UNIT);
  });

  it("rejects zero amounts and unknown vaults", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    await expect(ctx.hub.connect(ctx.alice).deposit(ctx.vaultId, 0n)).to.be.revertedWithCustomError(ctx.hub, "ZeroAmount");
    await expect(ctx.hub.connect(ctx.alice).deposit(99n, 1n)).to.be.revertedWithCustomError(ctx.hub, "UnknownVault");
  });

  it("onVaultDeposit rejects callers that are not the vault", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    await expect(ctx.hub.connect(ctx.alice).onVaultDeposit(ctx.vaultId, ctx.alice.address, 1n)).to.be.revertedWithCustomError(ctx.hub, "NotVault");
    await expect(ctx.hub.connect(ctx.alice).onVaultDeposit(99n, ctx.alice.address, 1n)).to.be.revertedWithCustomError(ctx.hub, "NotVault");
  });

  it("withdraw burns shares and returns collateral", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, ethers, alice, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 5n * WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, 5n * WETH_UNIT);
    const tx = hub.connect(alice).withdraw(vaultId, 2n * WETH_UNIT);
    await expect(tx).to.emit(hub, "Withdrawn").withArgs(vaultId, alice.address, 2n * WETH_UNIT);
    await expect(tx).to.changeTokenBalances(ethers, weth, [alice, vaultAddress], [2n * WETH_UNIT, -2n * WETH_UNIT]);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(3n * WETH_UNIT);
    await expect(hub.connect(alice).withdraw(vaultId, 0n)).to.be.revertedWithCustomError(hub, "ZeroAmount");
    await expect(hub.connect(alice).withdraw(vaultId, 4n * WETH_UNIT)).to.be.revertedWithCustomError(hub, "ERC1155InsufficientBalance");
  });

  it("transferred shares can be withdrawn by the new holder", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, ethers, alice, bob, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 3n * WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, 3n * WETH_UNIT);
    await hub.connect(alice).safeTransferFrom(alice.address, bob.address, vaultId, WETH_UNIT, "0x");
    await expect(hub.connect(bob).withdraw(vaultId, WETH_UNIT)).to.changeTokenBalances(ethers, weth, [bob], [WETH_UNIT]);
    expect(await hub.balanceOf(bob.address, vaultId)).to.equal(0n);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Open);
  });
});
