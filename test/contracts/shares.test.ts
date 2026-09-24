import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import { fixture, type Loaded } from "../helpers/setup.js";

const connection = await network.create();
const { ethers } = connection;

const URI = "ipfs://ivy/{id}.json";

// Signers stand in for the hub and the peer modules.
const deployed = fixture(connection, async () => {
  const [hub, premiums, unwind] = await ethers.getSigners();
  const shares = await ethers.deployContract("IvyShares", [hub.address, premiums.address, unwind.address, URI]);
  return { hub, premiums, unwind, shares };
});

describe("IvyShares", () => {
  let c: Loaded<typeof deployed>;

  describe("constructor", () => {
    beforeEach(async () => {
      c = await deployed();
    });

    it("binds the hub, premiums and unwind peers", async () => {
      expect(await c.shares.hub()).to.equal(c.hub.address);
      expect(await c.shares.premiums()).to.equal(c.premiums.address);
      expect(await c.shares.unwind()).to.equal(c.unwind.address);
    });

    it("rejects a zero hub", async () => {
      const factory = await ethers.getContractFactory("IvyShares");
      await expect(
        factory.deploy(ZeroAddress, c.premiums.address, c.unwind.address, URI),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects a zero premiums module", async () => {
      const factory = await ethers.getContractFactory("IvyShares");
      await expect(factory.deploy(c.hub.address, ZeroAddress, c.unwind.address, URI)).to.be.revertedWithCustomError(
        factory,
        "ZeroAddress",
      );
    });

    it("rejects a zero unwind module", async () => {
      const factory = await ethers.getContractFactory("IvyShares");
      await expect(
        factory.deploy(c.hub.address, c.premiums.address, ZeroAddress, URI),
      ).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });
});
