import { expect } from "chai";
import { network } from "hardhat";
import {
  ExercisePolicy,
  ExerciseStyle,
  Phase,
  SettlementType,
  THIRTY_DAYS,
  USDC_UNIT,
  WETH_UNIT,
  callPairs,
  callTerms,
  createVaultAs,
  deployIvy,
  fixture,
  fund,
  putPairs,
  putTerms,
} from "./helpers/setup.js";
import type { IvyContext } from "./helpers/setup.js";
import { signBid } from "./helpers/bids.js";
import {
  CALL_DEPOSIT,
  PREMIUM,
  PUT_DEPOSIT,
  STRIKE,
  activate,
  makeBid,
  openVault,
  setSpot,
} from "./helpers/scenarios.js";

const connection = await network.create();
const { networkHelpers } = connection;
const load = fixture(connection, () => deployIvy(connection));

describe("activate", () => {
  let c: IvyContext;
  beforeEach(async () => {
    c = await load();
  });

  it("activates a physical American call and pulls the premium into the vault", async () => {
    const { hub, usdc, usdcAddress, bidMaster, marketMaker, hubAddress } = c;
    const { vaultId, vaultAddress } = await openVault(c);
    const bid = await makeBid(c, vaultId);
    await fund(c, usdc, marketMaker, vaultAddress, 1000n * USDC_UNIT);
    const signature = await signBid(marketMaker, hubAddress, bid);
    await expect(hub.connect(bidMaster).activate(vaultId, bid, signature))
      .to.emit(hub, "Activated")
      .withArgs(
        vaultId,
        marketMaker.address,
        usdcAddress,
        usdcAddress,
        STRIKE,
        PREMIUM,
        ExerciseStyle.American,
        SettlementType.Physical,
        bid.expiry,
        CALL_DEPOSIT,
        1000n * USDC_UNIT,
      );
    expect(await usdc.balanceOf(vaultAddress)).to.equal(1000n * USDC_UNIT);
    expect(await usdc.balanceOf(marketMaker.address)).to.equal(0n);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Live);
    expect(s.marketMaker).to.equal(marketMaker.address);
    expect(s.quoteToken).to.equal(usdcAddress);
    expect(s.premiumToken).to.equal(usdcAddress);
    expect(s.strike).to.equal(STRIKE);
    expect(s.premium).to.equal(PREMIUM);
    expect(s.style).to.equal(ExerciseStyle.American);
    expect(s.settlement).to.equal(SettlementType.Physical);
    expect(s.expiry).to.equal(bid.expiry);
    expect(s.totalNotional).to.equal(CALL_DEPOSIT);
    expect(s.exercisedNotional).to.equal(0n);
    expect(await hub.remainingNotional(vaultId)).to.equal(CALL_DEPOSIT);
    expect(await hub.usedBidNonces(marketMaker.address, bid.nonce)).to.equal(true);
  });

  it("activates a put: notional derives from the strike, premium is paid in the quote token", async () => {
    const { vaultId, vaultAddress } = await openVault(c, { isCall: false });
    await activate(c, vaultId, vaultAddress);
    const s = await c.hub.stateOf(vaultId);
    expect(s.totalNotional).to.equal(10n * WETH_UNIT);
    expect(await c.usdc.balanceOf(vaultAddress)).to.equal(PUT_DEPOSIT + 1000n * USDC_UNIT);
  });

  it("accepts cash settlement only where the vault allows it", async () => {
    const a = await openVault(c, { withFeed: true });
    await activate(c, a.vaultId, a.vaultAddress, { settlement: SettlementType.Cash });
    expect((await c.hub.stateOf(a.vaultId)).settlement).to.equal(SettlementType.Cash);
    const b = await openVault(c);
    await expect(
      activate(c, b.vaultId, b.vaultAddress, { settlement: SettlementType.Cash }),
    ).to.be.revertedWithCustomError(c.hub, "SettlementNotAllowed");
  });

  it("applies the oracle band in both directions", async () => {
    const call = await openVault(c, { withFeed: true });
    await expect(
      activate(c, call.vaultId, call.vaultAddress, { strike: 2699n * USDC_UNIT }),
    ).to.be.revertedWithCustomError(c.hub, "StrikeOutsideSpotBand");
    await activate(c, call.vaultId, call.vaultAddress, { strike: 2700n * USDC_UNIT });

    const put = await openVault(c, { isCall: false, withFeed: true });
    await expect(
      activate(c, put.vaultId, put.vaultAddress, { strike: 3301n * USDC_UNIT }),
    ).to.be.revertedWithCustomError(c.hub, "StrikeOutsideSpotBand");
    await activate(c, put.vaultId, put.vaultAddress, { strike: 3300n * USDC_UNIT });
  });

  it("rejects stale, zero and future-dated prices", async () => {
    const { vaultId, vaultAddress } = await openVault(c, { withFeed: true });
    await setSpot(c, STRIKE, 3601n);
    await expect(activate(c, vaultId, vaultAddress)).to.be.revertedWithCustomError(c.hub, "StalePrice");
    await setSpot(c, 0n);
    await expect(activate(c, vaultId, vaultAddress)).to.be.revertedWithCustomError(c.hub, "InvalidPrice");
    const future = BigInt(await networkHelpers.time.latest()) + 1000n;
    await c.feed.set(c.wethAddress, c.usdcAddress, STRIKE, future);
    await expect(activate(c, vaultId, vaultAddress)).to.be.revertedWithCustomError(c.hub, "InvalidPrice");
  });

  it("lets a market maker cancel a nonce", async () => {
    const { hub, marketMaker } = c;
    await expect(hub.connect(marketMaker).cancelBid(77n))
      .to.emit(hub, "BidCancelled")
      .withArgs(marketMaker.address, 77n);
    expect(await hub.usedBidNonces(marketMaker.address, 77n)).to.equal(true);
    await expect(hub.connect(marketMaker).cancelBid(77n)).to.be.revertedWithCustomError(hub, "NonceUsed");
  });

  describe("rejections", () => {
    it("caller must be the bid master", async () => {
      const { vaultId } = await openVault(c);
      const bid = await makeBid(c, vaultId);
      const signature = await signBid(c.marketMaker, c.hubAddress, bid);
      await expect(c.hub.connect(c.alice).activate(vaultId, bid, signature)).to.be.revertedWithCustomError(
        c.hub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("vault must be in the Auction phase", async () => {
      const { vaultId, vaultAddress } = await createVaultAs(c, c.alice, callTerms(c), callPairs(c));
      await expect(activate(c, vaultId, vaultAddress))
        .to.be.revertedWithCustomError(c.hub, "WrongPhase")
        .withArgs(Phase.Auction, Phase.Open);
    });

    it("bid must reference the vault", async () => {
      const { vaultId, vaultAddress } = await openVault(c);
      await expect(activate(c, vaultId, vaultAddress, { vaultId: vaultId + 1n })).to.be.revertedWithCustomError(
        c.hub,
        "BidVaultMismatch",
      );
    });

    it("market maker must hold the role", async () => {
      const { vaultId } = await openVault(c);
      const bid = await makeBid(c, vaultId, { marketMaker: c.bob.address });
      const signature = await signBid(c.bob, c.hubAddress, bid);
      await expect(c.hub.connect(c.bidMaster).activate(vaultId, bid, signature)).to.be.revertedWithCustomError(
        c.hub,
        "NotMarketMaker",
      );
    });

    it("bid must not be expired", async () => {
      const { vaultId } = await openVault(c);
      const bid = await makeBid(c, vaultId, { validFor: 10n });
      const signature = await signBid(c.marketMaker, c.hubAddress, bid);
      await networkHelpers.time.increase(11n);
      await expect(c.hub.connect(c.bidMaster).activate(vaultId, bid, signature)).to.be.revertedWithCustomError(
        c.hub,
        "BidExpired",
      );
    });

    it("a nonce cannot be reused or activated after cancellation", async () => {
      const first = await openVault(c);
      await activate(c, first.vaultId, first.vaultAddress, { nonce: 500n });
      const second = await openVault(c);
      await expect(activate(c, second.vaultId, second.vaultAddress, { nonce: 500n })).to.be.revertedWithCustomError(
        c.hub,
        "NonceUsed",
      );
      await c.hub.connect(c.marketMaker).cancelBid(501n);
      await expect(activate(c, second.vaultId, second.vaultAddress, { nonce: 501n })).to.be.revertedWithCustomError(
        c.hub,
        "NonceUsed",
      );
    });

    it("signature must come from the market maker", async () => {
      const { vaultId } = await openVault(c);
      const bid = await makeBid(c, vaultId);
      const forged = await signBid(c.bob, c.hubAddress, bid);
      await expect(c.hub.connect(c.bidMaster).activate(vaultId, bid, forged)).to.be.revertedWithCustomError(
        c.hub,
        "BadSignature",
      );
    });

    it("pair must exist", async () => {
      const a = await openVault(c);
      await expect(activate(c, a.vaultId, a.vaultAddress, { quoteToken: c.daiAddress }))
        .to.be.revertedWithCustomError(c.hub, "PairUnknown")
        .withArgs(c.daiAddress);
    });

    it("termsHash must match the vault", async () => {
      const { vaultId, vaultAddress } = await openVault(c);
      const bid = { ...(await makeBid(c, vaultId)), termsHash: "0x" + "22".repeat(32) };
      await fund(c, c.usdc, c.marketMaker, vaultAddress, 1000n * USDC_UNIT);
      const signature = await signBid(c.marketMaker, c.hubAddress, bid);
      await expect(c.hub.connect(c.bidMaster).activate(vaultId, bid, signature)).to.be.revertedWithCustomError(
        c.hub,
        "CommitmentMismatch",
      );
    });

    it("style must be allowed by the vault", async () => {
      const { vaultId, vaultAddress } = await openVault(c, { terms: { allowedExercise: ExercisePolicy.European } });
      await expect(activate(c, vaultId, vaultAddress, { style: ExerciseStyle.American })).to.be.revertedWithCustomError(
        c.hub,
        "StyleNotAllowed",
      );
      await activate(c, vaultId, vaultAddress, { style: ExerciseStyle.European });
    });

    it("expiry must be in the future and match the LP commitment", async () => {
      const { vaultId, vaultAddress } = await openVault(c);
      const now = BigInt(await networkHelpers.time.latest());
      await expect(activate(c, vaultId, vaultAddress, { expiry: now })).to.be.revertedWithCustomError(
        c.hub,
        "ExpiryInPast",
      );
      await expect(activate(c, vaultId, vaultAddress, { tenor: THIRTY_DAYS + 60n })).to.be.revertedWithCustomError(
        c.hub,
        "CommitmentMismatch",
      );
    });

    it("strike must respect the configured limit", async () => {
      const call = await openVault(c, { pair: { strikeLimit: 3100n * USDC_UNIT } });
      await expect(activate(c, call.vaultId, call.vaultAddress)).to.be.revertedWithCustomError(
        c.hub,
        "StrikeBelowLimit",
      );
      const put = await openVault(c, { isCall: false, pair: { strikeLimit: 2900n * USDC_UNIT } });
      await expect(activate(c, put.vaultId, put.vaultAddress)).to.be.revertedWithCustomError(c.hub, "StrikeAboveLimit");
    });

    it("premium must reach the floor", async () => {
      const { vaultId, vaultAddress } = await openVault(c, { pair: { minPremium: 200n * USDC_UNIT } });
      await expect(activate(c, vaultId, vaultAddress)).to.be.revertedWithCustomError(c.hub, "PremiumTooLow");
    });

    it("rejects a bid whose notional rounds to zero", async () => {
      const six = await c.ethers.deployContract("MockERC20", ["Six", "SIX", 6]);
      const terms = putTerms(c, { underlying: await six.getAddress() });
      const { vaultId, vaultAddress } = await createVaultAs(c, c.alice, terms, putPairs(c));
      await fund(c, c.usdc, c.alice, vaultAddress, 1n);
      await c.hub.connect(c.alice).deposit(vaultId, 1n);
      await c.hub.connect(c.alice).openAuction(vaultId);
      await expect(activate(c, vaultId, vaultAddress)).to.be.revertedWithCustomError(c.hub, "EmptyNotional");
    });

    it("premium must arrive in full", async () => {
      const { vaultId, vaultAddress } = await openVault(c);
      await c.usdc.setFeeBps(100n);
      await expect(activate(c, vaultId, vaultAddress))
        .to.be.revertedWithCustomError(await c.ethers.getContractAt("IvyVault", vaultAddress), "ShortReceived")
        .withArgs(1000n * USDC_UNIT, 990n * USDC_UNIT);
    });
  });
});
