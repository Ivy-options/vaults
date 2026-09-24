import { expect } from "chai";
import { network } from "hardhat";
import { WETH_UNIT, callPairs, callTerms, createVaultAs, deployIvy, fixture } from "./helpers/setup.js";

const connection = await network.create();
const { ethers } = connection;

const load = fixture(connection, async () => {
  const c = await deployIvy(connection);
  const { vaultId, vaultAddress } = await createVaultAs(c, c.alice, callTerms(c), callPairs(c));
  const attacker = await ethers.deployContract("ReenteringDepositor", [c.hubAddress]);
  const attackerAddress = await attacker.getAddress();
  await c.weth.mint(attackerAddress, 10n * WETH_UNIT);
  await attacker.approveVault(c.wethAddress, vaultAddress, 10n * WETH_UNIT);
  return { ...c, vaultId, vaultAddress, attacker, attackerAddress };
});

describe("reentrancy via the ERC-1155 mint callback", () => {
  let c: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    c = await load();
  });

  it("a well-behaved contract depositor receives shares through the callback", async () => {
    const { hub, shares, attacker, attackerAddress, vaultId } = c;
    await attacker.setMode(0n);
    await attacker.deposit(vaultId, 2n * WETH_UNIT);
    expect(await attacker.callbacks()).to.equal(1n);
    expect(await shares.balanceOf(attackerAddress, vaultId)).to.equal(2n * WETH_UNIT);
    expect(await hub.totalShares(vaultId)).to.equal(2n * WETH_UNIT);
  });

  it("re-entering deposit from the callback reverts the whole deposit", async () => {
    const { hub, weth, shares, attacker, attackerAddress, vaultId, vaultAddress } = c;
    await attacker.setMode(1n);
    await expect(attacker.deposit(vaultId, 2n * WETH_UNIT)).to.be.revertedWithCustomError(
      hub,
      "ReentrancyGuardReentrantCall",
    );
    expect(await shares.balanceOf(attackerAddress, vaultId)).to.equal(0n);
    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
    expect(await weth.balanceOf(attackerAddress)).to.equal(10n * WETH_UNIT);
  });

  it("re-entering withdraw from the callback reverts the whole deposit", async () => {
    const { hub, weth, shares, attacker, attackerAddress, vaultId, vaultAddress } = c;
    await attacker.setMode(2n);
    await expect(attacker.deposit(vaultId, 2n * WETH_UNIT)).to.be.revertedWithCustomError(
      hub,
      "ReentrancyGuardReentrantCall",
    );
    expect(await shares.balanceOf(attackerAddress, vaultId)).to.equal(0n);
    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
  });
});
