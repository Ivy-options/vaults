import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import { deployIvy, fixture, type IvyContext } from "../helpers/setup.js";

const connection = await network.create();
const { ethers } = connection;

const deployed = fixture(connection, () => deployIvy(connection));

describe("ExampleSettlementPublisher", () => {
  let c: IvyContext;

  describe("constructor", () => {
    beforeEach(async () => {
      c = await deployed();
    });

    it("binds the hub and owner", async () => {
      const publisher = await ethers.deployContract("ExampleSettlementPublisher", [c.hubAddress, c.bob.address]);
      expect(await publisher.hub()).to.equal(c.hubAddress);
      expect(await publisher.owner()).to.equal(c.bob.address);
    });

    it("rejects a zero hub", async () => {
      const factory = await ethers.getContractFactory("ExampleSettlementPublisher");
      await expect(factory.deploy(ZeroAddress, c.bob.address)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects a hub address without code", async () => {
      const factory = await ethers.getContractFactory("ExampleSettlementPublisher");
      await expect(factory.deploy(c.carol.address, c.bob.address)).to.be.revertedWithCustomError(
        factory,
        "BindingMismatch",
      );
    });
  });
});
