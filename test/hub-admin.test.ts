import { expect } from "chai";
import { network } from "hardhat";
import {
  AUCTION_TIMEOUT,
  EXERCISE_WINDOW,
  callPairs,
  callTerms,
  createVaultAs,
  deployIvy,
  fixture,
  spotBandRule,
} from "./helpers/setup.js";
import type { IvyContext } from "./helpers/setup.js";
const connection = await network.create();
const { ethers } = connection;
const load = fixture(connection, () => deployIvy(connection));
describe("immutable hub", () => {
  let c: IvyContext;
  beforeEach(async () => {
    c = await load();
  });
  it("binds every peer and has no upgrade or rewiring entrypoint", async () => {
    expect(await c.hub.vaultImplementation()).eq(c.vaultImplAddress);
    expect(await c.shares.hub()).eq(c.hubAddress);
    expect(await c.shares.premiums()).eq(await c.premiums.getAddress());
    expect(await c.shares.unwind()).eq(await c.unwind.getAddress());
    expect(await c.premiums.shares()).eq(c.sharesAddress);
    expect(await c.unwind.shares()).eq(c.sharesAddress);
    for (const name of ["upgradeToAndCall", "initialize", "setShares", "setVaultImplementation"])
      expect(c.hub.interface.getFunction(name as any)).eq(null);
    expect((await c.hub.eip712Domain()).version).eq("3");
  });
  it("only admin changes defaults; existing vault timing stays fixed", async () => {
    const a = await createVaultAs(c, c.alice, callTerms(c), callPairs(c));
    await expect(c.hub.connect(c.alice).setSettings(1n, 2n, 3n)).revertedWithCustomError(
      c.hub,
      "AccessControlUnauthorizedAccount",
    );
    await c.hub.setSettings(1n, 2n, 3n);
    const b = await createVaultAs(c, c.alice, callTerms(c), callPairs(c));
    expect((await c.hub.stateOf(a.vaultId)).exerciseWindow).eq(EXERCISE_WINDOW);
    expect((await c.hub.stateOf(a.vaultId)).auctionTimeout).eq(AUCTION_TIMEOUT);
    expect((await c.hub.stateOf(b.vaultId)).exerciseWindow).eq(1n);
    await expect(c.hub.connect(c.alice).setURI("x")).revertedWithCustomError(c.hub, "AccessControlUnauthorizedAccount");
    await c.hub.setURI("new");
    expect(await c.shares.uri(1n)).eq("new");
  });
  it("rejects a hub referencing peers bound to another hub", async () => {
    const h = await ethers.deployContract(
      "IvyVaultsHub",
      [
        c.admin.address,
        c.vaultImplAddress,
        c.sharesAddress,
        await c.premiums.getAddress(),
        await c.unwind.getAddress(),
        1,
        1,
        1,
      ],
      { libraries: c.libraries },
    );
    await expect(h.createVault(callTerms(c), callPairs(c), [])).revertedWithCustomError(h, "BindingMismatch");
  });
  it("rejects missing implementation and price-feed code", async () => {
    await expect(
      ethers.deployContract(
        "IvyVaultsHub",
        [
          c.admin.address,
          c.alice.address,
          c.sharesAddress,
          await c.premiums.getAddress(),
          await c.unwind.getAddress(),
          1,
          1,
          1,
        ],
        { libraries: c.libraries },
      ),
    ).revertedWithCustomError(c.hub, "BindingMismatch");
    await expect(
      c.hub.createVault(callTerms(c), callPairs(c), [
        spotBandRule(c, { priceFeed: c.alice.address, maxPriceAge: 100, maxInTheMoneyBps: 0 }),
      ]),
    ).revertedWithCustomError(c.hub, "BindingMismatch");
  });
  it("rejects a zero publication window at deployment", async () => {
    await expect(
      ethers.deployContract(
        "IvyVaultsHub",
        [
          c.admin.address,
          c.vaultImplAddress,
          c.sharesAddress,
          await c.premiums.getAddress(),
          await c.unwind.getAddress(),
          3600,
          3600,
          0,
        ],
        { libraries: c.libraries },
      ),
    ).revertedWithCustomError(c.hub, "InvalidSettlementWindow");
  });
  it("protects minting, burning and module payment entrypoints", async () => {
    await expect(c.shares.mint(c.alice.address, 1, 1)).revertedWithCustomError(c.shares, "NotHub");
    await expect(c.shares.burn(c.alice.address, 1, 1)).revertedWithCustomError(c.shares, "NotHub");
    await expect(c.premiums.claimFor(1, c.alice.address)).revertedWithCustomError(c.premiums, "NotHub");
    await expect(c.premiums.beforeShareUpdate(1, c.alice.address, c.bob.address, 100, 100, 0)).revertedWithCustomError(
      c.premiums,
      "NotShares",
    );
    await expect(c.unwind.beforeShareUpdate(1, c.alice.address)).revertedWithCustomError(c.unwind, "NotShares");
    await expect(c.hub.stateOf(99)).revertedWithCustomError(c.hub, "UnknownVault");
    expect(await c.shares.supportsInterface("0xd9b67a26")).eq(true);
  });
});
