import { expect } from "chai";
import { network } from "hardhat";
import { deployIvy, fixture, SettlementType } from "./helpers/setup.js";
import type { IvyContext } from "./helpers/setup.js";
import { goLive, at } from "./helpers/scenarios.js";

const connection = await network.create();
const load = fixture(connection, () => deployIvy(connection));
// Two Hubs share a chain here, so this deployment gets its own: snapshots on one chain are stacked.
const twoHubChain = await network.create();
const loadTwoHubs = fixture(twoHubChain, async () => ({
  c: await deployIvy(twoHubChain),
  other: await deployIvy(twoHubChain),
}));

describe("Hub-owned settlement prices", () => {
  let c: IvyContext;
  beforeEach(async () => {
    c = await load();
  });

  it("accepts a direct EOA publisher without a settlement feed contract", async () => {
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    expect(await c.hub.hasRole(role, c.admin.address)).equal(true);
    const now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.publishExercisePrice(v.vaultId, 4000, now, now + 100n);
    expect(await c.hub.exercisePrice(v.vaultId)).deep.equal([4000n, now, now + 100n]);
  });

  it("accepts an authorized helper contract, protects its upstream caller, and revokes either publisher kind", async () => {
    const v = await goLive(c, { withFeed: true }, { settlement: SettlementType.Cash });
    const helper = await c.ethers.deployContract("ExampleSettlementPublisher", [c.hubAddress, c.bob.address]);
    const role = await c.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    const helperAddress = await helper.getAddress();
    let now = BigInt(await c.networkHelpers.time.latest());
    await expect(helper.connect(c.bob).publishExercisePrice(v.vaultId, 4000, now, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
      .withArgs(helperAddress, role);
    await c.hub.grantRole(role, helperAddress);
    await expect(
      helper.connect(c.carol).publishExercisePrice(v.vaultId, 4000, now, now + 100n),
    ).revertedWithCustomError(helper, "OwnableUnauthorizedAccount");
    await expect(helper.connect(c.carol).publishExpiry(v.vaultId, 4000, now + 100n)).revertedWithCustomError(
      helper,
      "OwnableUnauthorizedAccount",
    );
    await helper.connect(c.bob).publishExercisePrice(v.vaultId, 4000, now, now + 100n);
    expect(await c.hub.exercisePrice(v.vaultId)).deep.equal([4000n, now, now + 100n]);
    await at(c, v.bid.expiry);
    now = v.bid.expiry;
    await helper.connect(c.bob).publishExpiry(v.vaultId, 3000, now + 100n);

    await c.hub.revokeRole(role, helperAddress);
    await expect(helper.connect(c.bob).publishExpiry(v.vaultId, 5000, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
      .withArgs(helperAddress, role);
    await expect(helper.connect(c.bob).publishExercisePrice(v.vaultId, 5000, now + 1n, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
      .withArgs(helperAddress, role);
    expect(await c.hub.settlementPrice(v.vaultId)).equal(3000);
    await c.hub.grantRole(role, c.carol.address);
    now = BigInt(await c.networkHelpers.time.latest());
    await c.hub.connect(c.carol).publishExercisePrice(v.vaultId, 6000, now, now + 100n);
    await c.hub.revokeRole(role, c.carol.address);
    await expect(c.hub.connect(c.carol).publishExercisePrice(v.vaultId, 7000, now + 1n, now + 100n))
      .revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount")
      .withArgs(c.carol.address, role);
    expect(await c.hub.exercisePrice(v.vaultId)).deep.equal([6000n, now, now + 100n]);
  });
});

describe("Hub-owned settlement prices across Hubs", () => {
  it("grants publisher permissions separately from administration and isolates the same vault id between Hubs", async () => {
    const { c, other } = await loadTwoHubs();
    const terms = { allowedSettlement: SettlementType.Cash, maxSettlementPriceAge: 3600, expiry: other.defaultExpiry };
    const first = await goLive(c, { terms }, { settlement: SettlementType.Cash });
    const second = await goLive(other, { terms }, { settlement: SettlementType.Cash });
    expect(first.vaultId).equal(second.vaultId);
    const role = await other.hub.SETTLEMENT_PRICE_PUBLISHER_ROLE();
    await other.hub.revokeRole(role, other.admin.address);
    await other.hub.grantRole(role, other.bob.address);
    expect(await other.hub.hasRole(role, other.bob.address)).equal(true);
    expect(await other.hub.hasRole(role, other.admin.address)).equal(false);
    expect(await other.hub.hasRole(await other.hub.DEFAULT_ADMIN_ROLE(), other.bob.address)).equal(false);
    await expect(other.hub.connect(other.bob).grantRole(role, other.carol.address)).revertedWithCustomError(
      other.hub,
      "AccessControlUnauthorizedAccount",
    );
    await at(c, terms.expiry);
    await c.hub.publishExpiry(first.vaultId, 5000, terms.expiry + 100n);
    await expect(other.hub.settlementPrice(second.vaultId)).revertedWithCustomError(other.hub, "ReportUnavailable");
    await other.hub.connect(other.bob).publishExpiry(second.vaultId, 3000, terms.expiry + 100n);
    expect(await other.hub.settlementPrice(second.vaultId)).equal(3000);
    expect(await c.hub.settlementPrice(first.vaultId)).equal(5000);
  });
});
