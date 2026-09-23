import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("scaffold", function () {
  it("deploys MockERC20 with custom decimals and mints", async function () {
    const [alice] = await ethers.getSigners();
    const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    expect(await usdc.decimals()).to.equal(6n);
    await usdc.mint(alice.address, 1_000_000n);
    expect(await usdc.balanceOf(alice.address)).to.equal(1_000_000n);
  });

  it("applies a burn-on-transfer fee when configured", async function () {
    const [alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockERC20", ["Fee", "FEE", 18]);
    await token.mint(alice.address, 1000n);
    await token.setFeeBps(100n); // 1%
    await token.transfer(bob.address, 1000n);
    expect(await token.balanceOf(bob.address)).to.equal(990n);
    expect(await token.totalSupply()).to.equal(990n);
  });

  it("has the ERC1967Proxy artifact available", async function () {
    const artifact = await ethers.getContractFactory("ERC1967Proxy");
    expect(artifact.interface.deploy.inputs.length).to.equal(2);
  });
});
