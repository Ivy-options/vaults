import { expect } from "chai";
import { network } from "hardhat";
import { WETH_UNIT, callPairs, callTerms, createVaultAs, deployIvy } from "./helpers/setup.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe("reentrancy via the ERC-1155 mint callback", function () {
  async function fixture() {
    const ctx = await deployIvy(connection);
    const { vaultId, vaultAddress } = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    const attacker = await ethers.deployContract("ReenteringDepositor", [ctx.hubAddress]);
    const attackerAddress = await attacker.getAddress();
    await ctx.weth.mint(attackerAddress, 10n * WETH_UNIT);
    await attacker.approveVault(ctx.wethAddress, vaultAddress, 10n * WETH_UNIT);
    return { ...ctx, vaultId, vaultAddress, attacker, attackerAddress };
  }

  it("a well-behaved contract depositor receives shares through the callback", async function () {
    const { hub, shares, attacker, attackerAddress, vaultId } = await networkHelpers.loadFixture(fixture);
    await attacker.setMode(0n);
    await attacker.deposit(vaultId, 2n * WETH_UNIT);
    expect(await attacker.callbacks()).to.equal(1n);
    expect(await shares.balanceOf(attackerAddress, vaultId)).to.equal(2n * WETH_UNIT);
    expect(await hub.totalShares(vaultId)).to.equal(2n * WETH_UNIT);
  });

  it("re-entering deposit from the callback reverts the whole deposit", async function () {
    const { hub, weth, shares, attacker, attackerAddress, vaultId, vaultAddress } = await networkHelpers.loadFixture(fixture);
    await attacker.setMode(1n);
    await expect(attacker.deposit(vaultId, 2n * WETH_UNIT)).to.be.revertedWithCustomError(hub, "ReentrancyGuardReentrantCall");
    expect(await shares.balanceOf(attackerAddress, vaultId)).to.equal(0n);
    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
    expect(await weth.balanceOf(attackerAddress)).to.equal(10n * WETH_UNIT);
  });

  it("re-entering withdraw from the callback reverts the whole deposit", async function () {
    const { hub, weth, shares, attacker, attackerAddress, vaultId, vaultAddress } = await networkHelpers.loadFixture(fixture);
    await attacker.setMode(2n);
    await expect(attacker.deposit(vaultId, 2n * WETH_UNIT)).to.be.revertedWithCustomError(hub, "ReentrancyGuardReentrantCall");
    expect(await shares.balanceOf(attackerAddress, vaultId)).to.equal(0n);
    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
  });
});
