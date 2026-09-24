import { expect } from "chai";
import { network } from "hardhat";
import {
  AUCTION_TIMEOUT,
  Phase,
  WETH_UNIT,
  callPairs,
  callTerms,
  createVaultAs,
  deployIvy,
  fixture,
  fund,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

const load = fixture(connection, async () => {
  const c = await deployIvy(connection);
  const v = await createVaultAs(c, c.alice, callTerms(c, { minCollateral: 5n * WETH_UNIT }), callPairs(c));
  await fund(c, c.weth, c.alice, v.vaultAddress, 6n * WETH_UNIT);
  await c.hub.connect(c.alice).deposit(v.vaultId, 6n * WETH_UNIT);
  return { ...c, ...v };
});

describe("auction", () => {
  let c: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    c = await load();
  });

  it("owner opens the auction and the vault freezes", async () => {
    const { hub, alice, vault, vaultId, vaultAddress, weth } = c;
    await expect(hub.connect(alice).openAuction(vaultId))
      .to.emit(hub, "AuctionOpened")
      .withArgs(vaultId, 6n * WETH_UNIT);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Auction);
    expect(s.auctionOpenedAt).to.equal(BigInt(await networkHelpers.time.latest()));

    await fund(c, weth, alice, vaultAddress, WETH_UNIT);
    await expect(hub.connect(alice).deposit(vaultId, WETH_UNIT))
      .to.be.revertedWithCustomError(hub, "WrongPhase")
      .withArgs(Phase.Open, Phase.Auction);
    await expect(vault.connect(alice).deposit(WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).withdraw(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).scheduleAuction(vaultId, 1n)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "WrongPhase");
  });

  it("requires collateral above zero and above the minimum", async () => {
    const { hub, alice, weth } = c;
    const low = await createVaultAs(c, alice, callTerms(c, { minCollateral: 5n * WETH_UNIT }), callPairs(c));
    await fund(c, weth, alice, low.vaultAddress, 4n * WETH_UNIT);
    await hub.connect(alice).deposit(low.vaultId, 4n * WETH_UNIT);
    await expect(hub.connect(alice).openAuction(low.vaultId))
      .to.be.revertedWithCustomError(hub, "BelowMinCollateral")
      .withArgs(4n * WETH_UNIT, 5n * WETH_UNIT);
    const empty = await createVaultAs(c, alice, callTerms(c), callPairs(c));
    await expect(hub.connect(alice).openAuction(empty.vaultId)).to.be.revertedWithCustomError(hub, "ZeroAmount");
  });

  it("strangers cannot open an unscheduled auction", async () => {
    const { hub, bob, vaultId } = c;
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
  });

  it("anyone can open a scheduled auction once the time has come", async () => {
    const { hub, alice, bob, vaultId } = c;
    const startsAt = BigInt(await networkHelpers.time.latest()) + 1000n;
    await hub.connect(alice).scheduleAuction(vaultId, startsAt);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
    await networkHelpers.time.increaseTo(startsAt);
    await expect(hub.connect(bob).openAuction(vaultId)).to.emit(hub, "AuctionOpened");
  });

  it("bid master can cancel at any time and the owner can reopen", async () => {
    const { hub, alice, bidMaster, vaultId } = c;
    await hub.connect(alice).openAuction(vaultId);
    await expect(hub.connect(bidMaster).cancelAuction(vaultId)).to.emit(hub, "AuctionCancelled").withArgs(vaultId);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Open);
    expect(s.auctionOpenedAt).to.equal(0n);
    await hub.connect(alice).openAuction(vaultId);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Auction);
  });

  it("owner can cancel only after the timeout, and the schedule is cleared", async () => {
    const { hub, alice, bob, vaultId } = c;
    const startsAt = BigInt(await networkHelpers.time.latest()) + 10n;
    await hub.connect(alice).scheduleAuction(vaultId, startsAt);
    await hub.connect(alice).openAuction(vaultId);
    await expect(hub.connect(alice).cancelAuction(vaultId)).to.be.revertedWithCustomError(
      hub,
      "AuctionTimeoutNotReached",
    );
    await expect(hub.connect(bob).cancelAuction(vaultId)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await networkHelpers.time.increase(AUCTION_TIMEOUT);
    await hub.connect(alice).cancelAuction(vaultId);
    expect((await hub.termsOf(vaultId)).auctionStartsAt).to.equal(0n);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
  });

  it("cancel only works in the Auction phase", async () => {
    const { hub, bidMaster, vaultId } = c;
    await expect(hub.connect(bidMaster).cancelAuction(vaultId))
      .to.be.revertedWithCustomError(hub, "WrongPhase")
      .withArgs(Phase.Auction, Phase.Open);
  });
});
