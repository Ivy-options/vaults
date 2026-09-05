import { expect } from "chai";
import { network } from "hardhat";
import {
  ExercisePolicy, ExerciseStyle, Phase, SettlementType, THIRTY_DAYS, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, fund, putPairs, putTerms,
} from "./helpers/setup.js";
import { signBid } from "./helpers/bids.js";
import { CALL_DEPOSIT, PREMIUM, PUT_DEPOSIT, STRIKE, activate, makeBid, openVault, setSpot } from "./helpers/scenarios.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("activate", function () {
  const fixture = () => deployIvy(connection);

  it("activates a physical American call and pulls the premium into the vault", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, usdc, usdcAddress, bidMaster, marketMaker, hubAddress } = ctx;
    const { vaultId, vaultAddress } = await openVault(ctx);
    const bid = await makeBid(ctx, vaultId);
    await fund(ctx, usdc, marketMaker, vaultAddress, 1000n * USDC_UNIT);
    const signature = await signBid(marketMaker, hubAddress, bid);
    await expect(hub.connect(bidMaster).activate(vaultId, bid, signature))
      .to.emit(hub, "Activated")
      .withArgs(
        vaultId, marketMaker.address, usdcAddress, usdcAddress, STRIKE, PREMIUM,
        ExerciseStyle.American, SettlementType.Physical, bid.expiry, CALL_DEPOSIT, 1000n * USDC_UNIT,
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

  it("activates a put: notional derives from the strike, premium is paid in the quote token", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress } = await openVault(ctx, { isCall: false });
    await activate(ctx, vaultId, vaultAddress);
    const s = await ctx.hub.stateOf(vaultId);
    expect(s.totalNotional).to.equal(10n * WETH_UNIT);
    expect(await ctx.usdc.balanceOf(vaultAddress)).to.equal(PUT_DEPOSIT + 1000n * USDC_UNIT);
  });

  it("accepts cash settlement only where the vault allows it", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const a = await openVault(ctx, { withFeed: true });
    await activate(ctx, a.vaultId, a.vaultAddress, { settlement: SettlementType.Cash });
    expect((await ctx.hub.stateOf(a.vaultId)).settlement).to.equal(SettlementType.Cash);
    const b = await openVault(ctx);
    await expect(activate(ctx, b.vaultId, b.vaultAddress, { settlement: SettlementType.Cash }))
      .to.be.revertedWithCustomError(ctx.hub, "SettlementNotAllowed");
  });

  it("applies the oracle band in both directions", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const call = await openVault(ctx, { withFeed: true });
    await expect(activate(ctx, call.vaultId, call.vaultAddress, { strike: 2699n * USDC_UNIT }))
      .to.be.revertedWithCustomError(ctx.hub, "StrikeOutsideSpotBand");
    await activate(ctx, call.vaultId, call.vaultAddress, { strike: 2700n * USDC_UNIT });

    const put = await openVault(ctx, { isCall: false, withFeed: true });
    await expect(activate(ctx, put.vaultId, put.vaultAddress, { strike: 3301n * USDC_UNIT }))
      .to.be.revertedWithCustomError(ctx.hub, "StrikeOutsideSpotBand");
    await activate(ctx, put.vaultId, put.vaultAddress, { strike: 3300n * USDC_UNIT });
  });

  it("rejects stale, zero and future-dated prices", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress } = await openVault(ctx, { withFeed: true });
    await setSpot(ctx, STRIKE, 3601n);
    await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "StalePrice");
    await setSpot(ctx, 0n);
    await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "InvalidPrice");
    const future = BigInt(await networkHelpers.time.latest()) + 1000n;
    await ctx.feed.set(ctx.wethAddress, ctx.usdcAddress, STRIKE, future);
    await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "InvalidPrice");
  });

  it("lets a market maker cancel a nonce", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, marketMaker } = ctx;
    await expect(hub.connect(marketMaker).cancelBid(77n)).to.emit(hub, "BidCancelled").withArgs(marketMaker.address, 77n);
    expect(await hub.usedBidNonces(marketMaker.address, 77n)).to.equal(true);
    await expect(hub.connect(marketMaker).cancelBid(77n)).to.be.revertedWithCustomError(hub, "NonceUsed");
  });

  describe("rejections", function () {
    it("caller must be the bid master", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId);
      const signature = await signBid(ctx.marketMaker, ctx.hubAddress, bid);
      await expect(ctx.hub.connect(ctx.alice).activate(vaultId, bid, signature))
        .to.be.revertedWithCustomError(ctx.hub, "AccessControlUnauthorizedAccount");
    });

    it("vault must be in the Auction phase", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
      await expect(activate(ctx, vaultId, vaultAddress))
        .to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Auction, Phase.Open);
    });

    it("bid must reference the vault", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx);
      await expect(activate(ctx, vaultId, vaultAddress, { vaultId: vaultId + 1n }))
        .to.be.revertedWithCustomError(ctx.hub, "BidVaultMismatch");
    });

    it("market maker must hold the role", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId, { marketMaker: ctx.bob.address });
      const signature = await signBid(ctx.bob, ctx.hubAddress, bid);
      await expect(ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, signature))
        .to.be.revertedWithCustomError(ctx.hub, "NotMarketMaker");
    });

    it("bid must not be expired", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId, { validFor: 10n });
      const signature = await signBid(ctx.marketMaker, ctx.hubAddress, bid);
      await networkHelpers.time.increase(11n);
      await expect(ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, signature))
        .to.be.revertedWithCustomError(ctx.hub, "BidExpired");
    });

    it("a nonce cannot be reused or activated after cancellation", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const first = await openVault(ctx);
      await activate(ctx, first.vaultId, first.vaultAddress, { nonce: 500n });
      const second = await openVault(ctx);
      await expect(activate(ctx, second.vaultId, second.vaultAddress, { nonce: 500n }))
        .to.be.revertedWithCustomError(ctx.hub, "NonceUsed");
      await ctx.hub.connect(ctx.marketMaker).cancelBid(501n);
      await expect(activate(ctx, second.vaultId, second.vaultAddress, { nonce: 501n }))
        .to.be.revertedWithCustomError(ctx.hub, "NonceUsed");
    });

    it("signature must come from the market maker", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId);
      const forged = await signBid(ctx.bob, ctx.hubAddress, bid);
      await expect(ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, forged))
        .to.be.revertedWithCustomError(ctx.hub, "BadSignature");
    });

    it("pair must exist and be enabled", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, alice, usdcAddress, daiAddress, weth } = ctx;
      const a = await openVault(ctx);
      await expect(activate(ctx, a.vaultId, a.vaultAddress, { quoteToken: daiAddress }))
        .to.be.revertedWithCustomError(hub, "PairUnknown").withArgs(daiAddress);

      const b = await createVaultAs(ctx, alice, callTerms(ctx), callPairs(ctx));
      await hub.connect(alice).tightenPairTerms(b.vaultId, usdcAddress, { premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: false });
      await fund(ctx, weth, alice, b.vaultAddress, CALL_DEPOSIT);
      await hub.connect(alice).deposit(b.vaultId, CALL_DEPOSIT);
      await hub.connect(alice).openAuction(b.vaultId);
      await expect(activate(ctx, b.vaultId, b.vaultAddress))
        .to.be.revertedWithCustomError(hub, "PairDisabled").withArgs(usdcAddress);
    });

    it("style must be allowed by the vault", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx, { terms: { allowedExercise: ExercisePolicy.European } });
      await expect(activate(ctx, vaultId, vaultAddress, { style: ExerciseStyle.American }))
        .to.be.revertedWithCustomError(ctx.hub, "StyleNotAllowed");
      await activate(ctx, vaultId, vaultAddress, { style: ExerciseStyle.European });
    });

    it("expiry must be in the future and match the LP commitment", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx);
      const now = BigInt(await networkHelpers.time.latest());
      await expect(activate(ctx, vaultId, vaultAddress, { expiry: now })).to.be.revertedWithCustomError(ctx.hub, "ExpiryInPast");
      await expect(activate(ctx, vaultId, vaultAddress, { tenor: THIRTY_DAYS + 60n })).to.be.revertedWithCustomError(ctx.hub, "CommitmentMismatch");
    });

    it("strike must respect the configured limit", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const call = await openVault(ctx, { pair: { strikeLimit: 3100n * USDC_UNIT } });
      await expect(activate(ctx, call.vaultId, call.vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "StrikeBelowLimit");
      const put = await openVault(ctx, { isCall: false, pair: { strikeLimit: 2900n * USDC_UNIT } });
      await expect(activate(ctx, put.vaultId, put.vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "StrikeAboveLimit");
    });

    it("premium must reach the floor", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx, { pair: { minPremium: 200n * USDC_UNIT } });
      await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "PremiumTooLow");
    });

    it("rejects a bid whose notional rounds to zero", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const six = await ctx.ethers.deployContract("MockERC20", ["Six", "SIX", 6]);
      const terms = putTerms(ctx, { underlying: await six.getAddress() });
      const { vaultId, vaultAddress } = await createVaultAs(ctx, ctx.alice, terms, putPairs(ctx));
      await fund(ctx, ctx.usdc, ctx.alice, vaultAddress, 1n);
      await ctx.hub.connect(ctx.alice).deposit(vaultId, 1n);
      await ctx.hub.connect(ctx.alice).openAuction(vaultId);
      await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "EmptyNotional");
    });

    it("premium must arrive in full", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx);
      await ctx.usdc.setFeeBps(100n);
      await expect(activate(ctx, vaultId, vaultAddress))
        .to.be.revertedWithCustomError(ctx.hub, "ShortReceived").withArgs(1000n * USDC_UNIT, 990n * USDC_UNIT);
    });
  });
});
