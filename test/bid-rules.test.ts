import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress, id } from "ethers";
import {
  ExercisePolicy,
  ExerciseStyle,
  RuleKind,
  SettlementPolicy,
  SettlementType,
  USDC_UNIT,
  WETH_UNIT,
  deployIvy,
  fixture,
  fund,
  premiumFloorRule,
} from "./helpers/setup.js";
import type { IvyContext } from "./helpers/setup.js";
import { signBid } from "./helpers/bids.js";
import { CALL_DEPOSIT, STRIKE, activate, makeBid, openVault, setSpot } from "./helpers/scenarios.js";
import {
  encodePairLimits as pairLimits,
  encodePremiumFloor as premiumFloor,
  encodeSpotBand as spotBand,
} from "../scripts/encoding.ts";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const kind = (name: string) => id(name).slice(0, 10);
const A = "0x1000000000000000000000000000000000000001";
const B = "0x2000000000000000000000000000000000000002";

const terms = (underlying: string, collateral: string) => ({
  underlying,
  collateral,
  allowPartialExercise: true,
  publicDeposits: true,
  allowedExercise: ExercisePolicy.Either,
  allowedSettlement: SettlementPolicy.Physical,
  expiry: 4_000_000_000n,
  auctionStartsAt: 0n,
  minCollateral: 0n,
  maxSettlementPriceAge: 0,
});

// The standalone validator gets its own chain: snapshots on one chain are stacked.
const rulesChain = await network.create();
const loadRules = fixture(rulesChain, async () => {
  const rules = await rulesChain.ethers.deployContract("IvyBidRules");
  const feed = await rulesChain.ethers.deployContract("MockPriceFeed");
  return { rules, feedAddress: await feed.getAddress(), ok: rules.interface.getFunction("validateConfig")!.selector };
});
const load = fixture(connection, () => deployIvy(connection));

describe("IvyBidRules config", () => {
  let c: Awaited<ReturnType<typeof loadRules>>;
  beforeEach(async () => {
    c = await loadRules();
  });

  it("exposes named kinds", async () => {
    const { rules } = c;
    expect(await rules.PAIR_LIMITS()).to.equal(kind("PairLimits"));
    expect(await rules.SPOT_BAND()).to.equal(kind("SpotBand"));
    expect(await rules.PREMIUM_FLOOR()).to.equal(kind("PremiumFloor"));
  });

  it("rejects an unknown kind", async () => {
    const { rules } = c;
    await expect(rules.validateConfig(kind("Nope"), terms(A, A), [{ quoteToken: B, premiumToken: B }], "0x"))
      .to.be.revertedWithCustomError(rules, "UnknownRuleKind")
      .withArgs(kind("Nope"));
  });

  it("PairLimits needs exactly one entry per pair", async () => {
    const { rules, ok } = c;
    const pairs = [{ quoteToken: B, premiumToken: B }];
    expect(await rules.validateConfig(kind("PairLimits"), terms(A, A), pairs, pairLimits([[B, 0n, 0n]]))).to.equal(ok);
    await expect(rules.validateConfig(kind("PairLimits"), terms(A, A), pairs, pairLimits([])))
      .to.be.revertedWithCustomError(rules, "RuleMissingPair")
      .withArgs(B);
    await expect(
      rules.validateConfig(
        kind("PairLimits"),
        terms(A, A),
        pairs,
        pairLimits([
          [B, 0n, 0n],
          [A, 0n, 0n],
        ]),
      ),
    )
      .to.be.revertedWithCustomError(rules, "PairUnknown")
      .withArgs(A);
    await expect(
      rules.validateConfig(
        kind("PairLimits"),
        terms(A, A),
        pairs,
        pairLimits([
          [B, 0n, 0n],
          [B, 1n, 0n],
        ]),
      ),
    )
      .to.be.revertedWithCustomError(rules, "DuplicatePair")
      .withArgs(B);
    await expect(
      rules.validateConfig(kind("PairLimits"), terms(A, B), pairs, pairLimits([[B, 0n, 0n]])),
    ).to.be.revertedWithCustomError(rules, "InvalidStrikeLimit");
  });

  it("SpotBand needs a live feed, a positive age and a call band within 100%", async () => {
    const { rules, feedAddress, ok } = c;
    const pairs = [{ quoteToken: B, premiumToken: B }];
    expect(await rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(feedAddress, 60, 1000))).to.equal(
      ok,
    );
    await expect(
      rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(A, 60, 1000)),
    ).to.be.revertedWithCustomError(rules, "BindingMismatch");
    await expect(
      rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(feedAddress, 0, 1000)),
    ).to.be.revertedWithCustomError(rules, "FeedNeedsMaxPriceAge");
    await expect(
      rules.validateConfig(kind("SpotBand"), terms(A, A), pairs, spotBand(feedAddress, 60, 10_001)),
    ).to.be.revertedWithCustomError(rules, "DeviationTooLarge");
    expect(
      await rules.validateConfig(kind("SpotBand"), terms(A, B), pairs, spotBand(feedAddress, 60, 20_000)),
    ).to.equal(ok);
  });

  it("PremiumFloor needs a feed only when some pair pays premium in another token", async () => {
    const { rules, feedAddress, ok } = c;
    const inUnderlying = [{ quoteToken: B, premiumToken: A }];
    const inQuote = [{ quoteToken: B, premiumToken: B }];
    expect(
      await rules.validateConfig(kind("PremiumFloor"), terms(A, A), inUnderlying, premiumFloor(ZeroAddress, 0, 500)),
    ).to.equal(ok);
    await expect(
      rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(ZeroAddress, 0, 500)),
    ).to.be.revertedWithCustomError(rules, "BindingMismatch");
    expect(
      await rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(feedAddress, 60, 500)),
    ).to.equal(ok);
    await expect(
      rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(feedAddress, 60, 0)),
    ).to.be.revertedWithCustomError(rules, "InvalidPremiumFloor");
    await expect(
      rules.validateConfig(kind("PremiumFloor"), terms(A, A), inQuote, premiumFloor(feedAddress, 60, 10_001)),
    ).to.be.revertedWithCustomError(rules, "InvalidPremiumFloor");
  });
});

describe("bid rules at activation", () => {
  let c: IvyContext;
  beforeEach(async () => {
    c = await load();
  });

  it("PairLimits and SpotBand reproduce the previous acceptance conditions", async () => {
    const call = await openVault(c, {
      pair: { strikeLimit: 3100n * USDC_UNIT, minPremium: 50n * USDC_UNIT },
      withFeed: true,
    });
    await expect(activate(c, call.vaultId, call.vaultAddress)).to.be.revertedWithCustomError(c.hub, "StrikeBelowLimit");
    await expect(
      activate(c, call.vaultId, call.vaultAddress, { strike: 3100n * USDC_UNIT, premium: 49n * USDC_UNIT }),
    ).to.be.revertedWithCustomError(c.hub, "PremiumTooLow");
    await setSpot(c, 4000n * USDC_UNIT);
    await expect(
      activate(c, call.vaultId, call.vaultAddress, { strike: 3100n * USDC_UNIT }),
    ).to.be.revertedWithCustomError(c.hub, "StrikeOutsideSpotBand");
    await setSpot(c, STRIKE);
    await activate(c, call.vaultId, call.vaultAddress, { strike: 3100n * USDC_UNIT });
  });

  it("an empty rule list accepts any well-formed bid and still guards a zero strike", async () => {
    const call = await openVault(c);
    await activate(c, call.vaultId, call.vaultAddress, { strike: 0n, premium: 0n });
    const put = await openVault(c, { isCall: false });
    await expect(activate(c, put.vaultId, put.vaultAddress, { strike: 0n })).to.be.revertedWithCustomError(
      c.hub,
      "EmptyNotional",
    );
  });

  it("every rule must approve, in order, and the same validator may appear twice", async () => {
    const reject = await c.ethers.deployContract("RejectAllValidator");
    const approve = await c.ethers.deployContract("ApproveAllValidator");
    const rule = (v: string) => ({ validator: v, kind: RuleKind.PairLimits, data: "0x" });
    const a = await openVault(c, { rules: [rule(await approve.getAddress()), rule(await reject.getAddress())] });
    await expect(activate(c, a.vaultId, a.vaultAddress)).to.be.revertedWithCustomError(reject, "Rejected");
    const b = await openVault(c, {
      pair: { strikeLimit: 3100n * USDC_UNIT, minPremium: 0n },
      rules: [premiumFloorRule(c, { maxPriceAge: 3600, minPremiumBps: 500 })],
    });
    await setSpot(c, STRIKE);
    expect((await c.hub.rulesOf(b.vaultId)).map((r: any) => r.validator)).to.deep.equal([
      c.bidRulesAddress,
      c.bidRulesAddress,
    ]);
    await expect(activate(c, b.vaultId, b.vaultAddress, { premium: 150n * USDC_UNIT })).to.be.revertedWithCustomError(
      c.hub,
      "StrikeBelowLimit",
    );
    await expect(
      activate(c, b.vaultId, b.vaultAddress, { strike: 3100n * USDC_UNIT, premium: 149n * USDC_UNIT }),
    ).to.be.revertedWithCustomError(c.hub, "PremiumTooLow");
    await activate(c, b.vaultId, b.vaultAddress, { strike: 3100n * USDC_UNIT, premium: 150n * USDC_UNIT });
  });

  it("a bid signed for one vault is rejected on a twin by vault id, never by termsHash", async () => {
    const expiry = BigInt(await networkHelpers.time.latest()) + 7n * 24n * 3600n;
    const a = await openVault(c, { terms: { expiry }, pair: { minPremium: 1n } });
    const b = await openVault(c, { terms: { expiry, auctionStartsAt: 1_900_000_000n }, pair: { minPremium: 1n } });
    expect(await c.hub.termsHashOf(a.vaultId)).to.equal(await c.hub.termsHashOf(b.vaultId));
    const bid = await makeBid(c, a.vaultId);
    await fund(c, c.usdc, c.marketMaker, b.vaultAddress, 1000n * USDC_UNIT);
    await expect(
      c.hub.connect(c.bidMaster).activate(b.vaultId, bid, await signBid(c.marketMaker, c.hubAddress, bid)),
    ).to.be.revertedWithCustomError(c.hub, "BidVaultMismatch");
  });

  it("an approving validator cannot bypass the mandatory checks", async () => {
    const approve = await c.ethers.deployContract("ApproveAllValidator");
    const rules = [{ validator: await approve.getAddress(), kind: "0x00000000", data: "0x" }];
    const v = await openVault(c, { terms: { allowedExercise: 0 }, rules });
    await expect(
      activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.American }),
    ).to.be.revertedWithCustomError(c.hub, "StyleNotAllowed");
    await expect(
      activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.European, settlement: SettlementType.Cash }),
    ).to.be.revertedWithCustomError(c.hub, "SettlementNotAllowed");
    await expect(
      activate(c, v.vaultId, v.vaultAddress, { style: ExerciseStyle.European, quoteToken: c.daiAddress }),
    ).to.be.revertedWithCustomError(c.hub, "PairUnknown");
    const bid = { ...(await makeBid(c, v.vaultId, { style: ExerciseStyle.European })), collateralAmount: 1n };
    await fund(c, c.usdc, c.marketMaker, v.vaultAddress, 1000n * USDC_UNIT);
    await expect(
      c.hub.connect(c.bidMaster).activate(v.vaultId, bid, await signBid(c.marketMaker, c.hubAddress, bid)),
    ).to.be.revertedWithCustomError(c.hub, "CommitmentMismatch");
  });

  it("a validator that writes state fails activation, and the auction stays cancellable", async () => {
    const writer = await c.ethers.deployContract("StateWritingValidator");
    const v = await openVault(c, { rules: [{ validator: await writer.getAddress(), kind: "0x00000000", data: "0x" }] });
    await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revert(ethers);
    expect(await writer.calls()).to.equal(0n);
    await c.hub.connect(c.bidMaster).cancelAuction(v.vaultId);
    await c.hub.connect(c.alice).withdraw(v.vaultId, CALL_DEPOSIT);
  });

  it("the context carries the resolved premium token, notional and auction timing", async () => {
    const asserting = await c.ethers.deployContract("ContextAssertingValidator", [c.usdcAddress, CALL_DEPOSIT, 600]);
    const v = await openVault(c, {
      rules: [{ validator: await asserting.getAddress(), kind: "0x00000000", data: "0x" }],
    });
    await expect(activate(c, v.vaultId, v.vaultAddress)).to.be.revertedWithCustomError(asserting, "TooEarly");
    await networkHelpers.time.increase(600n);
    await activate(c, v.vaultId, v.vaultAddress);
    const wrong = await c.ethers.deployContract("ContextAssertingValidator", [c.daiAddress, CALL_DEPOSIT, 0]);
    const w = await openVault(c, { rules: [{ validator: await wrong.getAddress(), kind: "0x00000000", data: "0x" }] });
    await expect(activate(c, w.vaultId, w.vaultAddress)).to.be.revertedWithCustomError(wrong, "ContextMismatch");
  });

  it("PremiumFloor prices the premium in the underlying without a feed", async () => {
    const rules = [premiumFloorRule(c, { priceFeed: ZeroAddress, maxPriceAge: 0, minPremiumBps: 100 })];
    const { vaultId, vaultAddress } = await openVault(c, { premiumToken: c.wethAddress, rules });
    const tooLow = await makeBid(c, vaultId, { premium: WETH_UNIT / 100n - 1n });
    await fund(c, c.weth, c.marketMaker, vaultAddress, WETH_UNIT);
    await expect(
      c.hub.connect(c.bidMaster).activate(vaultId, tooLow, await signBid(c.marketMaker, c.hubAddress, tooLow)),
    ).to.be.revertedWithCustomError(c.hub, "PremiumTooLow");
    const enough = await makeBid(c, vaultId, { premium: WETH_UNIT / 100n });
    await c.hub.connect(c.bidMaster).activate(vaultId, enough, await signBid(c.marketMaker, c.hubAddress, enough));
    expect((await c.hub.stateOf(vaultId)).premiumToken).to.equal(c.wethAddress);
  });
});
