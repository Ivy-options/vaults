import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { proposeUnwind, signUnwindProposal } from "./helpers/unwind.js";
import { callTerms, callPairs, deployIvy, fixture, fund, WETH_UNIT as W, USDC_UNIT as U } from "./helpers/setup.js";
import type { IvyContext } from "./helpers/setup.js";
import { at, openVault, goLive, makeBid } from "./helpers/scenarios.js";
import { signBid } from "./helpers/bids.js";
const connection = await network.create();
const { ethers, networkHelpers } = connection;
const load = fixture(connection, () => deployIvy(connection));

describe("contract buyers and admission boundaries", () => {
  let c: IvyContext;
  beforeEach(async () => {
    c = await load();
  });
  it("accepts ERC-1271 bids and unwind consent, including recipient updates from the contract buyer", async () => {
    const wallet = await ethers.deployContract("Mock1271", [c.marketMaker.address]);
    const buyer = await wallet.getAddress();
    await c.hub.grantRole(await c.hub.MARKET_MAKER_ROLE(), buyer);
    const v = await openVault(c);
    await c.usdc.mint(buyer, 1000n * U);
    await wallet
      .connect(c.marketMaker)
      .execute(c.usdcAddress, c.usdc.interface.encodeFunctionData("approve", [v.vaultAddress, 1000n * U]));
    const bid = await makeBid(c, v.vaultId, {
      marketMaker: buyer,
      recipient: c.carol.address,
      executor: c.bob.address,
    });
    await c.hub.connect(c.bidMaster).activate(v.vaultId, bid, await signBid(c.marketMaker, c.hubAddress, bid));
    await wallet
      .connect(c.marketMaker)
      .execute(
        c.hubAddress,
        c.hub.interface.encodeFunctionData("setExecution", [v.vaultId, ZeroAddress, c.carol.address]),
      );
    expect((await c.hub.stateOf(v.vaultId)).executor).eq(ZeroAddress);
    const deadline = BigInt(await networkHelpers.time.latest()) + 1000n;
    const { agreement: a, signature } = await signUnwindProposal(c, v.vaultId, deadline, 100n * U);
    await wallet.connect(c.marketMaker).setSignaturesEnabled(false);
    await expect(
      c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, a.refund, signature),
    ).revertedWithCustomError(c.unwind, "BadSignature");
    await wallet.connect(c.marketMaker).setSignaturesEnabled(true);
    await c.hub.connect(c.alice).proposeUnwind(v.vaultId, deadline, a.refund, signature);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId, 1);
    await fund(c, c.usdc, c.alice, v.vaultAddress, a.refund);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, a.refund);
    await wallet.connect(c.marketMaker).setSignaturesEnabled(false);
    await expect(c.hub.connect(c.carol).executeUnwind(v.vaultId, a.nonce, signature)).revertedWithCustomError(
      c.unwind,
      "BadSignature",
    );
    await expect(c.hub.connect(c.alice).withdrawUnwindContribution(v.vaultId, a.nonce)).changeTokenBalance(
      c.ethers,
      c.usdc,
      c.alice,
      a.refund,
    );
    await wallet.connect(c.marketMaker).setSignaturesEnabled(true);
    await c.usdc.connect(c.alice).approve(v.vaultAddress, a.refund);
    await c.hub.connect(c.alice).fundUnwind(v.vaultId, a.nonce, a.refund);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId, a.nonce);
    await c.hub.connect(c.carol).executeUnwind(v.vaultId, a.nonce, signature);
    await wallet
      .connect(c.marketMaker)
      .execute(c.hubAddress, c.hub.interface.encodeFunctionData("claimPayout", [v.vaultId]));
    expect(await c.usdc.balanceOf(c.carol.address)).eq(a.refund);
    await c.hub.connect(c.alice).claim(v.vaultId, 10n * W);
    await c.hub.connect(c.alice).claimPremium(v.vaultId);
    expect(await c.usdc.balanceOf(v.vaultAddress)).eq(0n);
    expect(await c.weth.balanceOf(v.vaultAddress)).eq(0n);
  });
  it("applies global admission to creation and per-vault admission without blocking another vault", async () => {
    const a = await openVault(c),
      b = await openVault(c);
    await c.hub.setAdmissionPause(a.vaultId, true);
    await c.hub.connect(c.alice).cancelAuction(a.vaultId);
    await expect(c.hub.connect(c.alice).openAuction(a.vaultId)).revertedWithCustomError(c.hub, "AdmissionPaused");
    await fund(c, c.weth, c.alice, a.vaultAddress, W);
    await expect(a.vault.connect(c.alice).deposit(W)).revertedWithCustomError(c.hub, "AdmissionPaused");
    const bid = await makeBid(c, b.vaultId);
    await fund(c, c.usdc, c.marketMaker, b.vaultAddress, 1000n * U);
    await c.hub.connect(c.bidMaster).activate(b.vaultId, bid, await signBid(c.marketMaker, c.hubAddress, bid));
    await c.hub.setAdmissionPause(0, true);
    await expect(c.hub.connect(c.alice).createVault(callTerms(c), callPairs(c), [])).revertedWithCustomError(
      c.hub,
      "AdmissionPaused",
    );
    await c.hub.connect(c.alice).withdraw(a.vaultId, 10n * W);
  });
  it("invalidates an agreement when normal settlement wins the race, without consuming the sponsor refund", async () => {
    const v = await goLive(c);
    await proposeUnwind(c, v.vaultId, v.bid.expiry + 7200n, 100n * U);
    await c.hub.connect(c.alice).approveUnwind(v.vaultId, 1);
    await fund(c, c.usdc, c.carol, v.vaultAddress, 100n * U);
    await at(c, v.bid.expiry + 3600n);
    await c.hub.expire(v.vaultId);
    const before = await c.usdc.balanceOf(c.carol.address);
    await expect(c.hub.connect(c.carol).executeUnwind(v.vaultId, 1, "0x")).revertedWithCustomError(c.hub, "WrongPhase");
    expect(await c.usdc.balanceOf(c.carol.address)).eq(before);
    expect(await v.vault.buyerReserved(c.usdcAddress)).eq(0n);
  });
});
