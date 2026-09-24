import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import { fixture, type Loaded } from "../helpers/setup.js";

const connection = await network.create();
const { ethers } = connection;

const VAULT_ID = 1n;

// Signers stand in for the hub and the shares contract so their entrypoints can be called directly.
const deployed = fixture(connection, async () => {
  const [hub, shares, vault, alice, bob] = await ethers.getSigners();
  const premiums = await ethers.deployContract("IvyPremiums", [hub.address, shares.address]);
  return { hub, shares, vault, alice, bob, premiums };
});
// One share is worth 3⅓ units and two shares 6⅔.
const tenOverThree = fixture(deployed, async (c) => {
  await c.premiums.connect(c.hub).activate(VAULT_ID, c.vault.address, 10n, 3n);
  return c;
});
const oneOverTwo = fixture(deployed, async (c) => {
  await c.premiums.connect(c.hub).activate(VAULT_ID, c.vault.address, 1n, 2n);
  return c;
});

describe("IvyPremiums", () => {
  let c: Loaded<typeof deployed>;

  describe("constructor", () => {
    beforeEach(async () => {
      c = await deployed();
    });

    it("binds the hub and shares peers", async () => {
      expect(await c.premiums.hub()).to.equal(c.hub.address);
      expect(await c.premiums.shares()).to.equal(c.shares.address);
    });

    it("rejects a zero hub", async () => {
      const factory = await ethers.getContractFactory("IvyPremiums");
      await expect(factory.deploy(ZeroAddress, c.shares.address)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects a zero shares contract", async () => {
      const factory = await ethers.getContractFactory("IvyPremiums");
      await expect(factory.deploy(c.hub.address, ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("activate", () => {
    context("before a pool exists", () => {
      beforeEach(async () => {
        c = await deployed();
      });

      it("records the vault, amount and supply", async () => {
        await c.premiums.connect(c.hub).activate(VAULT_ID, c.vault.address, 10n, 3n);
        const pool = await c.premiums.pools(VAULT_ID);
        expect(pool.vault).to.equal(c.vault.address);
        expect(pool.amount).to.equal(10n);
        expect(pool.supply).to.equal(3n);
      });

      it("rejects a zero supply", async () => {
        await expect(
          c.premiums.connect(c.hub).activate(VAULT_ID, c.vault.address, 10n, 0n),
        ).to.be.revertedWithCustomError(c.premiums, "ZeroAmount");
      });
    });

    context("once a pool is active", () => {
      beforeEach(async () => {
        c = await tenOverThree();
      });

      it("rejects a second activation", async () => {
        await expect(
          c.premiums.connect(c.hub).activate(VAULT_ID, c.vault.address, 10n, 3n),
        ).to.be.revertedWithCustomError(c.premiums, "AlreadyInitialized");
      });
    });
  });

  describe("claimable", () => {
    context("before a pool exists", () => {
      beforeEach(async () => {
        c = await deployed();
      });

      it("is zero", async () => {
        expect(await c.premiums.claimable(VAULT_ID, c.alice.address)).to.equal(0n);
      });
    });
  });

  describe("beforeShareUpdate", () => {
    context("with ten units pooled over three shares", () => {
      beforeEach(async () => {
        c = await tenOverThree();
      });

      context("after alice burns her one share and bob his two", () => {
        beforeEach(async () => {
          await c.premiums.connect(c.shares).beforeShareUpdate(VAULT_ID, c.alice.address, ZeroAddress, 1n, 1n, 0n);
          await c.premiums.connect(c.shares).beforeShareUpdate(VAULT_ID, c.bob.address, ZeroAddress, 2n, 2n, 0n);
        });

        it("floors each credit so together they stay within the pool", async () => {
          expect(await c.premiums.claimable(VAULT_ID, c.alice.address)).to.equal(3n);
          expect(await c.premiums.claimable(VAULT_ID, c.bob.address)).to.equal(6n);
        });

        // With no shares left, a zero amount equals alice's balance, the case that moves a whole credit.
        it("leaves both credits in place on a zero-amount update from alice to bob", async () => {
          await c.premiums.connect(c.shares).beforeShareUpdate(VAULT_ID, c.alice.address, c.bob.address, 0n, 0n, 0n);
          expect(await c.premiums.claimable(VAULT_ID, c.alice.address)).to.equal(3n);
          expect(await c.premiums.claimable(VAULT_ID, c.bob.address)).to.equal(6n);
        });
      });
    });

    context("with one unit pooled over two shares held by alice", () => {
      beforeEach(async () => {
        c = await oneOverTwo();
      });

      // Half of alice's one-unit credit floors to zero.
      it("keeps the rounding dust with alice when she sends one share to bob", async () => {
        await c.premiums.connect(c.shares).beforeShareUpdate(VAULT_ID, c.alice.address, c.bob.address, 1n, 2n, 0n);
        expect(await c.premiums.claimable(VAULT_ID, c.alice.address)).to.equal(1n);
        expect(await c.premiums.claimable(VAULT_ID, c.bob.address)).to.equal(0n);
      });
    });
  });
});
