import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import { UNWIND_TYPES } from "../../scripts/encoding.ts";
import { fixture, usdc, weth, type Loaded } from "../helpers/setup.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

const VAULT_ID = 1n;
const SUPPLY = weth(3);
const REFUND = usdc(100);

// Plain signers stand in for the hub and share token, so each hook can be called directly.
const deployed = fixture(connection, async () => {
  const [hub, shares, buyer, holder, stranger] = await ethers.getSigners();
  const unwind = await ethers.deployContract("IvyUnwind", [hub.address, shares.address]);
  return { hub, shares, buyer, holder, stranger, unwind };
});
// The hub records a buyer-signed agreement refunding 100 USDC on a 3 WETH supply.
const proposed = fixture(deployed, async (d) => {
  const deadline = BigInt(await networkHelpers.time.latest()) + 3600n;
  const agreement = {
    vaultId: VAULT_ID,
    nonce: 1n,
    deadline,
    exercisedNotional: 0n,
    supply: SUPPLY,
    refund: REFUND,
  };
  const domain = {
    name: "IvyUnwind",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await d.unwind.getAddress(),
  };
  const signature = await d.buyer.signTypedData(domain, UNWIND_TYPES, agreement);
  await d.unwind.connect(d.hub).propose(VAULT_ID, deadline, 0n, SUPPLY, REFUND, d.buyer.address, signature);
  return { ...d, signature };
});
// The holder of the whole supply approved and funded the entire refund.
const funded = fixture(proposed, async (p) => {
  await p.unwind.connect(p.hub).approve(VAULT_ID, 1n, p.holder.address, SUPPLY);
  const revision = await p.unwind.revisions(VAULT_ID, p.holder.address);
  await p.unwind.connect(p.hub).fund(VAULT_ID, 1n, p.holder.address, REFUND, 0n, revision);
  return p;
});

describe("IvyUnwind", () => {
  let c: Loaded<typeof deployed>;

  describe("constructor", () => {
    beforeEach(async () => {
      c = await deployed();
    });

    it("rejects a zero hub", async () => {
      const factory = await ethers.getContractFactory("IvyUnwind");
      await expect(factory.deploy(ZeroAddress, c.shares.address)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("rejects a zero share token", async () => {
      const factory = await ethers.getContractFactory("IvyUnwind");
      await expect(factory.deploy(c.hub.address, ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });
  });

  describe("propose", () => {
    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("rejects proposing from anyone but the hub", async () => {
        await expect(
          c.unwind.connect(c.stranger).propose(VAULT_ID, 0n, 0n, 0n, 0n, ZeroAddress, "0x"),
        ).to.be.revertedWithCustomError(c.unwind, "NotHub");
      });
    });
  });

  describe("approve", () => {
    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("rejects approving from anyone but the hub", async () => {
        await expect(
          c.unwind.connect(c.stranger).approve(VAULT_ID, 1n, c.holder.address, 1n),
        ).to.be.revertedWithCustomError(c.unwind, "NotHub");
      });

      it("rejects a holder with a zero balance", async () => {
        await expect(c.unwind.connect(c.hub).approve(VAULT_ID, 1n, c.holder.address, 0n)).to.be.revertedWithCustomError(
          c.unwind,
          "AgreementInvalid",
        );
      });
    });
  });

  describe("revoke", () => {
    context("before any proposal", () => {
      beforeEach(async () => {
        c = await deployed();
      });

      it("reports no approval change for a holder who never approved", async () => {
        await expect(c.unwind.connect(c.hub).revoke(VAULT_ID, c.holder.address)).not.to.emit(
          c.unwind,
          "ApprovalUpdated",
        );
      });
    });

    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("rejects revoking from anyone but the hub", async () => {
        await expect(c.unwind.connect(c.stranger).revoke(VAULT_ID, c.holder.address)).to.be.revertedWithCustomError(
          c.unwind,
          "NotHub",
        );
      });
    });
  });

  describe("fund", () => {
    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("rejects funding from anyone but the hub", async () => {
        await expect(
          c.unwind.connect(c.stranger).fund(VAULT_ID, 1n, c.holder.address, 1n, 0n, 0n),
        ).to.be.revertedWithCustomError(c.unwind, "NotHub");
      });
    });
  });

  describe("withdraw", () => {
    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("rejects withdrawing from anyone but the hub", async () => {
        await expect(
          c.unwind.connect(c.stranger).withdraw(VAULT_ID, 1n, c.holder.address),
        ).to.be.revertedWithCustomError(c.unwind, "NotHub");
      });
    });
  });

  describe("consume", () => {
    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("rejects consuming from anyone but the hub", async () => {
        await expect(
          c.unwind.connect(c.stranger).consume(VAULT_ID, 1n, 0n, 0n, ZeroAddress, "0x"),
        ).to.be.revertedWithCustomError(c.unwind, "NotHub");
      });
    });

    context("after the hub consumes a funded agreement", () => {
      let p: Loaded<typeof funded>;

      beforeEach(async () => {
        p = await funded();
        await p.unwind.connect(p.hub).consume(VAULT_ID, 1n, 0n, SUPPLY, p.buyer.address, p.signature);
      });

      it("rejects consuming it again", async () => {
        await expect(
          p.unwind.connect(p.hub).consume(VAULT_ID, 1n, 0n, SUPPLY, p.buyer.address, p.signature),
        ).to.be.revertedWithCustomError(p.unwind, "AgreementInvalid");
      });
    });
  });

  describe("requiredContribution", () => {
    context("before any proposal", () => {
      beforeEach(async () => {
        c = await deployed();
      });

      it("reverts with AgreementInvalid", async () => {
        await expect(c.unwind.requiredContribution(VAULT_ID, weth(1))).to.be.revertedWithCustomError(
          c.unwind,
          "AgreementInvalid",
        );
      });
    });

    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("rounds a holder's share of the refund up", async () => {
        // 1 of 3 WETH owes 100 USDC / 3 = 33.333333… USDC.
        expect(await c.unwind.requiredContribution(VAULT_ID, weth(1))).to.equal(33_333_334n);
      });
    });
  });

  describe("refundOf", () => {
    context("before any proposal", () => {
      beforeEach(async () => {
        c = await deployed();
      });

      it("returns zero", async () => {
        expect(await c.unwind.refundOf(VAULT_ID)).to.equal(0n);
      });
    });

    context("with a recorded proposal", () => {
      beforeEach(async () => {
        c = await proposed();
      });

      it("returns the proposed refund", async () => {
        expect(await c.unwind.refundOf(VAULT_ID)).to.equal(REFUND);
      });
    });
  });
});
