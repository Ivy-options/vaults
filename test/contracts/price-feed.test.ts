import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { REPORT_TYPES } from "../../scripts/encoding.ts";
import { deployIvy, fixture, usdc, type IvyContext } from "../helpers/setup.js";
import { at } from "../helpers/scenarios.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

interface SpotReport {
  underlying: string;
  quote: string;
  price: bigint;
  observedAt: bigint;
  validUntil: bigint;
}

const deployed = fixture(connection, async () => {
  const c = await deployIvy(connection);
  return { c, priceFeed: await ethers.deployContract("IvyPriceFeed", [c.admin.address]) };
});
const signedByContract = fixture(deployed, async ({ c }) => {
  const wallet = await ethers.deployContract("Mock1271", [c.admin.address]);
  return { c, priceFeed: await ethers.deployContract("IvyPriceFeed", [await wallet.getAddress()]) };
});

type PriceFeed = Awaited<ReturnType<typeof deployed>>["priceFeed"];

const spotArgs = (r: SpotReport) => [r.underlying, r.quote, r.price, r.observedAt, r.validUntil] as const;

/** Signs `report` under `feed`'s EIP-712 domain. */
async function sign(feed: PriceFeed, report: SpotReport, signer: HardhatEthersSigner) {
  const domain = {
    name: "IvyPriceFeed",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await feed.getAddress(),
  };
  return signer.signTypedData(domain, REPORT_TYPES, report);
}

describe("IvyPriceFeed", () => {
  let c: IvyContext;
  let priceFeed: PriceFeed;
  let now: bigint;
  let report: SpotReport;

  /** A WETH/USDC report observed at `now`. */
  const wethSpot = (price: bigint, validFor: bigint): SpotReport => ({
    underlying: c.wethAddress,
    quote: c.usdcAddress,
    price,
    observedAt: now,
    validUntil: now + validFor,
  });

  describe("constructor", () => {
    beforeEach(async () => {
      await deployed();
    });

    it("rejects a zero signer", async () => {
      const factory = await ethers.getContractFactory("IvyPriceFeed");
      await expect(factory.deploy(ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("publishSpot", () => {
    context("with an EOA signer", () => {
      beforeEach(async () => {
        ({ c, priceFeed } = await deployed());
        now = BigInt(await networkHelpers.time.latest());
        report = wethSpot(usdc(3300), 3600n);
      });

      it("reports no spot before the first report", async () => {
        expect(await priceFeed.spot(c.wethAddress, c.usdcAddress)).to.deep.equal([0n, 0n]);
      });

      it("stores a signed report relayed by anyone", async () => {
        await priceFeed.connect(c.bob).publishSpot(...spotArgs(report), await sign(priceFeed, report, c.admin));
        expect(await priceFeed.spot(c.wethAddress, c.usdcAddress)).to.deep.equal([usdc(3300), now]);
      });

      it("emits SpotPublished with the pair, price and observation time", async () => {
        await expect(priceFeed.publishSpot(...spotArgs(report), await sign(priceFeed, report, c.admin)))
          .to.emit(priceFeed, "SpotPublished")
          .withArgs(c.wethAddress, c.usdcAddress, usdc(3300), now);
      });

      it("stores an observation dated the second it is published", async () => {
        const current = { ...report, observedAt: now + 1n };
        const signature = await sign(priceFeed, current, c.admin);
        await at(c, current.observedAt);
        await priceFeed.publishSpot(...spotArgs(current), signature);
        expect(await priceFeed.spot(c.wethAddress, c.usdcAddress)).to.deep.equal([usdc(3300), current.observedAt]);
      });

      it("rejects an observation dated one second after it is published", async () => {
        const future = { ...report, observedAt: now + 2n };
        const signature = await sign(priceFeed, future, c.admin);
        await at(c, now + 1n);
        await expect(priceFeed.publishSpot(...spotArgs(future), signature)).to.be.revertedWithCustomError(
          priceFeed,
          "InvalidPrice",
        );
      });

      it("rejects a report signed by anyone but the feed signer", async () => {
        await expect(
          priceFeed.publishSpot(...spotArgs(report), await sign(priceFeed, report, c.bob)),
        ).to.be.revertedWithCustomError(priceFeed, "BadSignature");
      });

      it("rejects a signature made for another feed", async () => {
        const other = await ethers.deployContract("IvyPriceFeed", [c.admin.address]);
        await expect(
          other.publishSpot(...spotArgs(report), await sign(priceFeed, report, c.admin)),
        ).to.be.revertedWithCustomError(other, "BadSignature");
      });

      it("rejects a zero price", async () => {
        await expect(priceFeed.publishSpot(...spotArgs({ ...report, price: 0n }), "0x")).to.be.revertedWithCustomError(
          priceFeed,
          "InvalidPrice",
        );
      });

      it("rejects a zero underlying", async () => {
        const zeroUnderlying = { ...report, underlying: ZeroAddress };
        await expect(
          priceFeed.publishSpot(...spotArgs(zeroUnderlying), await sign(priceFeed, zeroUnderlying, c.admin)),
        ).to.be.revertedWithCustomError(priceFeed, "InvalidPrice");
      });

      it("rejects a zero quote", async () => {
        const zeroQuote = { ...report, quote: ZeroAddress };
        await expect(
          priceFeed.publishSpot(...spotArgs(zeroQuote), await sign(priceFeed, zeroQuote, c.admin)),
        ).to.be.revertedWithCustomError(priceFeed, "InvalidPrice");
      });

      it("rejects a report whose underlying and quote are the same token", async () => {
        const sameToken = { ...report, quote: report.underlying };
        await expect(
          priceFeed.publishSpot(...spotArgs(sameToken), await sign(priceFeed, sameToken, c.admin)),
        ).to.be.revertedWithCustomError(priceFeed, "InvalidPrice");
      });

      context("after a first report", () => {
        beforeEach(async () => {
          await priceFeed.connect(c.bob).publishSpot(...spotArgs(report), await sign(priceFeed, report, c.admin));
        });

        it("stores a newer observation", async () => {
          await networkHelpers.time.increase(10);
          const newer = { ...report, price: usdc(3500), observedAt: BigInt(await networkHelpers.time.latest()) };
          await priceFeed.publishSpot(...spotArgs(newer), await sign(priceFeed, newer, c.admin));
          expect(await priceFeed.spot(c.wethAddress, c.usdcAddress)).to.deep.equal([usdc(3500), newer.observedAt]);
        });
      });

      context("with a report valid for 100 seconds", () => {
        beforeEach(() => {
          report = wethSpot(usdc(3300), 100n);
        });

        it("stores the report in its validUntil second", async () => {
          const signature = await sign(priceFeed, report, c.admin);
          await at(c, report.validUntil);
          await priceFeed.publishSpot(...spotArgs(report), signature);
          expect(await priceFeed.spot(c.wethAddress, c.usdcAddress)).to.deep.equal([usdc(3300), now]);
        });

        it("rejects the report one second after validUntil", async () => {
          const signature = await sign(priceFeed, report, c.admin);
          await at(c, report.validUntil + 1n);
          await expect(priceFeed.publishSpot(...spotArgs(report), signature)).to.be.revertedWithCustomError(
            priceFeed,
            "BidExpired",
          );
        });
      });
    });

    context("with a contract signer", () => {
      let signature: string;

      beforeEach(async () => {
        ({ c, priceFeed } = await signedByContract());
        now = BigInt(await networkHelpers.time.latest());
        report = wethSpot(usdc(3000), 1000n);
        signature = await sign(priceFeed, report, c.admin);
      });

      it("stores a report the contract validates", async () => {
        await priceFeed.publishSpot(...spotArgs(report), signature);
        expect((await priceFeed.spot(c.wethAddress, c.usdcAddress))[0]).to.equal(usdc(3000));
      });

      context("after a first report", () => {
        beforeEach(async () => {
          await priceFeed.publishSpot(...spotArgs(report), signature);
        });

        it("rejects a replay of the same observation", async () => {
          await expect(priceFeed.publishSpot(...spotArgs(report), signature)).to.be.revertedWithCustomError(
            priceFeed,
            "InvalidPrice",
          );
        });
      });
    });
  });
});
