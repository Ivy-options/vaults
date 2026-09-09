import { expect } from "chai";
import { network } from "hardhat";
import { deployIvy } from "./helpers/setup.js";

describe("Hub-owned settlement prices", function () {
  it("accepts a direct EOA publisher without a settlement feed contract", async function () {
    const c = await deployIvy(await network.create());
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    expect(await c.hub.hasRole(role, c.admin.address)).equal(true);
    const now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.publishExercisePrice(c.wethAddress, c.usdcAddress, 4000, now, now + 100n);
    expect(await c.hub.exercisePrice(c.wethAddress, c.usdcAddress)).deep.equal([4000n, now, now + 100n]);
  });

  it("accepts an authorized helper contract, protects its upstream caller, and revokes either publisher kind", async function () {
    const c = await deployIvy(await network.create());
    const helper = await c.ethers.deployContract("ExampleSettlementPublisher", [c.hubAddress, c.bob.address]);
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    const helperAddress = await helper.getAddress();
    let now = BigInt(await c.networkHelpers.time.latest());
    await expect(helper.connect(c.bob).publishExercisePrice(c.wethAddress, c.usdcAddress, 4000, now, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount").withArgs(helperAddress, role);
    await c.hub.grantRole(role, helperAddress);
    await expect(helper.connect(c.carol).publishExercisePrice(c.wethAddress, c.usdcAddress, 4000, now, now + 100n))
      .revertedWithCustomError(helper, "OwnableUnauthorizedAccount");
    await expect(helper.connect(c.carol).publishExpiry(c.wethAddress, c.usdcAddress, now, 4000, now + 100n))
      .revertedWithCustomError(helper, "OwnableUnauthorizedAccount");
    await helper.connect(c.bob).publishExercisePrice(c.wethAddress, c.usdcAddress, 4000, now, now + 100n);
    expect(await c.hub.exercisePrice(c.wethAddress, c.usdcAddress)).deep.equal([4000n, now, now + 100n]);
    await helper.connect(c.bob).publishExpiry(c.wethAddress, c.usdcAddress, now, 3000, now + 100n);

    await c.hub.revokeRole(role, helperAddress);
    await expect(helper.connect(c.bob).publishExpiry(c.wethAddress, c.usdcAddress, now + 1n, 5000, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount").withArgs(helperAddress, role);
    await expect(helper.connect(c.bob).publishExercisePrice(c.wethAddress, c.usdcAddress, 5000, now + 1n, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount").withArgs(helperAddress, role);
    expect(await c.hub.settlementPrice(c.wethAddress, c.usdcAddress, now)).equal(3000);
    await c.hub.grantRole(role, c.carol.address);
    now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.connect(c.carol).publishExercisePrice(c.wethAddress, c.usdcAddress, 6000, now, now + 100n);
    await c.hub.revokeRole(role, c.carol.address);
    await expect(c.hub.connect(c.carol).publishExercisePrice(c.wethAddress, c.usdcAddress, 7000, now + 1n, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount").withArgs(c.carol.address, role);
    expect(await c.hub.exercisePrice(c.wethAddress, c.usdcAddress)).deep.equal([6000n, now, now + 100n]);
  });

  it("grants publisher permissions separately from Hub administration and isolates prices between Hubs", async function () {
    const c = await deployIvy(await network.create());
    const args = [c.admin.address, c.vaultImplAddress, c.sharesAddress, await c.premiums.getAddress(), await c.unwind.getAddress(), 1, 1] as const;
    const hub = await c.ethers.deployContract("IvyVaultsHub", [...args], { libraries: c.libraries });
    const role = await hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    expect(await hub.hasRole(role, c.bob.address)).equal(false);
    await hub.grantRole(role, c.bob.address);
    expect(await hub.hasRole(role, c.bob.address)).equal(true);
    expect(await hub.hasRole(role, c.admin.address)).equal(false);
    expect(await hub.hasRole(await hub.DEFAULT_ADMIN_ROLE(), c.bob.address)).equal(false);
    await expect(hub.connect(c.bob).grantRole(role, c.carol.address)).revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    const now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.publishExpiry(c.wethAddress, c.usdcAddress, now, 5000, now + 100n);
    await expect(hub.settlementPrice(c.wethAddress, c.usdcAddress, now)).revertedWithCustomError(hub, "ReportUnavailable");
    await hub.connect(c.bob).publishExpiry(c.wethAddress, c.usdcAddress, now, 3000, now + 100n);
    expect(await hub.settlementPrice(c.wethAddress, c.usdcAddress, now)).equal(3000);
    expect(await c.hub.settlementPrice(c.wethAddress, c.usdcAddress, now)).equal(5000);
  });
});
