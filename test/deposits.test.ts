import { expect } from "chai";
import { network } from "hardhat";
import { Phase, WETH_UNIT, callPairs, callTerms, createVaultAs, deployIvy, fixture, fund } from "./helpers/setup.js";

const connection = await network.create();
const load = fixture(connection, async () => {
  const c = await deployIvy(connection, { transfersEnabled: true });
  const v = await createVaultAs(c, c.alice, callTerms(c), callPairs(c));
  return { ...c, ...v };
});

describe("deposits and withdrawals", () => {
  let c: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    c = await load();
  });

  it("hub deposit pulls collateral into the vault and mints 1:1 shares", async () => {
    const { hub, shares, weth, alice, vaultId, vaultAddress } = c;
    await fund(c, weth, alice, vaultAddress, 5n * WETH_UNIT);
    await expect(hub.connect(alice).deposit(vaultId, 5n * WETH_UNIT))
      .to.emit(hub, "Deposited")
      .withArgs(vaultId, alice.address, 5n * WETH_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(5n * WETH_UNIT);
    expect(await shares.balanceOf(alice.address, vaultId)).to.equal(5n * WETH_UNIT);
    expect(await hub.totalShares(vaultId)).to.equal(5n * WETH_UNIT);
  });

  it("direct vault deposit credits the depositor through onVaultDeposit", async () => {
    const { hub, shares, weth, bob, vault, vaultId, vaultAddress } = c;
    await fund(c, weth, bob, vaultAddress, 2n * WETH_UNIT);
    await expect(vault.connect(bob).deposit(2n * WETH_UNIT))
      .to.emit(hub, "Deposited")
      .withArgs(vaultId, bob.address, 2n * WETH_UNIT);
    expect(await shares.balanceOf(bob.address, vaultId)).to.equal(2n * WETH_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(2n * WETH_UNIT);
  });

  it("credits only what actually arrived for fee-on-transfer collateral", async () => {
    const { hub, shares, weth, alice, vaultId, vaultAddress } = c;
    await fund(c, weth, alice, vaultAddress, 1000n);
    await weth.setFeeBps(100n);
    await hub.connect(alice).deposit(vaultId, 1000n);
    expect(await shares.balanceOf(alice.address, vaultId)).to.equal(990n);
  });

  it("owner-only vaults reject other depositors on both paths", async () => {
    const { hub, shares, weth, alice, bob } = c;
    const { vaultId, vault, vaultAddress } = await createVaultAs(
      c,
      alice,
      callTerms(c, { publicDeposits: false }),
      callPairs(c),
    );
    await fund(c, weth, bob, vaultAddress, WETH_UNIT);
    await expect(hub.connect(bob).deposit(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "DepositsNotPublic");
    await expect(vault.connect(bob).deposit(WETH_UNIT)).to.be.revertedWithCustomError(hub, "DepositsNotPublic");
    await fund(c, weth, alice, vaultAddress, WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, WETH_UNIT);
    expect(await shares.balanceOf(alice.address, vaultId)).to.equal(WETH_UNIT);
  });

  it("rejects zero amounts and unknown vaults", async () => {
    await expect(c.hub.connect(c.alice).deposit(c.vaultId, 0n)).to.be.revertedWithCustomError(c.hub, "ZeroAmount");
    await expect(c.hub.connect(c.alice).deposit(99n, 1n)).to.be.revertedWithCustomError(c.hub, "UnknownVault");
  });

  it("onVaultDeposit rejects callers that are not the vault", async () => {
    await expect(c.hub.connect(c.alice).onVaultDeposit(c.vaultId, c.alice.address, 1n)).to.be.revertedWithCustomError(
      c.hub,
      "NotVault",
    );
    await expect(c.hub.connect(c.alice).onVaultDeposit(99n, c.alice.address, 1n)).to.be.revertedWithCustomError(
      c.hub,
      "NotVault",
    );
  });

  it("withdraw burns shares and returns collateral", async () => {
    const { hub, shares, weth, ethers, alice, vaultId, vaultAddress } = c;
    await fund(c, weth, alice, vaultAddress, 5n * WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, 5n * WETH_UNIT);
    const tx = hub.connect(alice).withdraw(vaultId, 2n * WETH_UNIT);
    await expect(tx)
      .to.emit(hub, "Withdrawn")
      .withArgs(vaultId, alice.address, 2n * WETH_UNIT);
    await expect(tx).to.changeTokenBalances(ethers, weth, [alice, vaultAddress], [2n * WETH_UNIT, -2n * WETH_UNIT]);
    expect(await shares.balanceOf(alice.address, vaultId)).to.equal(3n * WETH_UNIT);
    await expect(hub.connect(alice).withdraw(vaultId, 0n)).to.be.revertedWithCustomError(hub, "ZeroAmount");
    await expect(hub.connect(alice).withdraw(vaultId, 4n * WETH_UNIT)).to.be.revertedWithCustomError(
      shares,
      "ERC1155InsufficientBalance",
    );
  });

  it("transferred shares can be withdrawn by the new holder", async () => {
    const { hub, shares, weth, ethers, alice, bob, vaultId, vaultAddress } = c;
    await fund(c, weth, alice, vaultAddress, 3n * WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, 3n * WETH_UNIT);
    await shares.connect(alice).safeTransferFrom(alice.address, bob.address, vaultId, WETH_UNIT, "0x");
    await expect(hub.connect(bob).withdraw(vaultId, WETH_UNIT)).to.changeTokenBalances(
      ethers,
      weth,
      [bob],
      [WETH_UNIT],
    );
    expect(await shares.balanceOf(bob.address, vaultId)).to.equal(0n);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Open);
  });
});
