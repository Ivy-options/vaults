import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { network } from "hardhat";
import { fixture, weth, type Loaded } from "../helpers/setup.js";

const connection = await network.create();
const { ethers } = connection;

/** Deploys an uninitialized EIP-1167 clone of `implementation`. */
async function deployClone(implementation: string) {
  const [deployer] = await ethers.getSigners();
  const creationCode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const receipt = await (await deployer.sendTransaction({ data: creationCode })).wait();
  return ethers.getContractAt("IvyVault", receipt!.contractAddress!);
}

const cloned = fixture(connection, async () => {
  const [, alice, stranger, hubSigner, treasury] = await ethers.getSigners();
  const token = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
  const tokenAddress = await token.getAddress();
  const impl = await ethers.deployContract("IvyVault");
  const mockHub = await ethers.deployContract("MockHub");
  await (await mockHub.createClone(await impl.getAddress(), 1n, tokenAddress)).wait();
  const vaultAddress = await mockHub.lastClone();
  return {
    alice,
    stranger,
    hubSigner,
    treasury,
    token,
    tokenAddress,
    impl,
    mockHub,
    mockHubAddress: await mockHub.getAddress(),
    vault: await ethers.getContractAt("IvyVault", vaultAddress),
    vaultAddress,
  };
});
// Swaps in a clone nobody has initialized yet.
const uninitialized = fixture(cloned, async (c) => {
  const vault = await deployClone(await c.impl.getAddress());
  return { ...c, vault, vaultAddress: await vault.getAddress() };
});
// Swaps in a clone whose hub and premium module are a plain signer, for the hub-only calls MockHub does not expose.
const signerHub = fixture(cloned, async (c) => {
  const vault = await deployClone(await c.impl.getAddress());
  await (await vault.initialize(c.hubSigner.address, 1n, c.tokenAddress, c.hubSigner.address)).wait();
  return { ...c, vault, vaultAddress: await vault.getAddress() };
});
// Collecting a zero premium binds the vault's premium token without moving any.
const premiumTokenBound = fixture(signerHub, async (c) => {
  await (
    await c.vault.connect(c.hubSigner).collectPremium(c.tokenAddress, c.alice.address, 0n, 0n, c.treasury.address)
  ).wait();
  return c;
});
// A 4 WETH premium with a 1 WETH platform fee leaves 3 WETH for the LPs.
const premiumCollected = fixture(signerHub, async (c) => {
  await (await c.token.mint(c.alice.address, weth(4))).wait();
  await (await c.token.connect(c.alice).approve(c.vaultAddress, weth(4))).wait();
  await (
    await c.vault
      .connect(c.hubSigner)
      .collectPremium(c.tokenAddress, c.alice.address, weth(4), weth(1), c.treasury.address)
  ).wait();
  return c;
});

type Context = Loaded<typeof cloned>;

const zeroBindings: Array<{ name: string; args: (c: Context) => [string, bigint, string, string] }> = [
  { name: "hub", args: (c) => [ZeroAddress, 1n, c.tokenAddress, c.mockHubAddress] },
  { name: "collateral", args: (c) => [c.mockHubAddress, 1n, ZeroAddress, c.mockHubAddress] },
  { name: "premium module", args: (c) => [c.mockHubAddress, 1n, c.tokenAddress, ZeroAddress] },
];

describe("IvyVault", () => {
  let c: Context;

  /** Mints `amount` to alice and approves the vault under test for it. */
  async function approveVault(amount: bigint) {
    await c.token.mint(c.alice.address, amount);
    await c.token.connect(c.alice).approve(c.vaultAddress, amount);
  }

  describe("initialize", () => {
    context("once MockHub has cloned the vault", () => {
      beforeEach(async () => {
        c = await cloned();
      });

      it("reverts on the implementation, which is locked at construction", async () => {
        await expect(
          c.impl.initialize(c.mockHubAddress, 1n, c.tokenAddress, c.mockHubAddress),
        ).to.be.revertedWithCustomError(c.impl, "AlreadyInitialized");
      });

      it("binds a clone to its hub, vault id and collateral", async () => {
        expect(await c.vault.hub()).to.equal(c.mockHubAddress);
        expect(await c.vault.vaultId()).to.equal(1n);
        expect(await c.vault.collateral()).to.equal(c.tokenAddress);
      });

      it("reverts a second initialization of a clone", async () => {
        await expect(
          c.vault.initialize(c.mockHubAddress, 2n, c.tokenAddress, c.mockHubAddress),
        ).to.be.revertedWithCustomError(c.vault, "AlreadyInitialized");
      });
    });

    context("on an uninitialized clone", () => {
      beforeEach(async () => {
        c = await uninitialized();
      });

      for (const { name, args } of zeroBindings) {
        it(`rejects a zero ${name}`, async () => {
          await expect(c.vault.initialize(...args(c))).to.be.revertedWithCustomError(c.vault, "ZeroAddress");
        });
      }
    });
  });

  describe("deposit", () => {
    context("with 5 WETH approved", () => {
      beforeEach(async () => {
        c = await cloned();
        await approveVault(weth(5));
      });

      it("pulls the collateral into the vault", async () => {
        await c.vault.connect(c.alice).deposit(weth(5));
        expect(await c.token.balanceOf(c.vaultAddress)).to.equal(weth(5));
      });

      it("notifies the hub once with the vault id, depositor and amount", async () => {
        await c.vault.connect(c.alice).deposit(weth(5));
        expect(await c.mockHub.lastVaultId()).to.equal(1n);
        expect(await c.mockHub.lastDepositor()).to.equal(c.alice.address);
        expect(await c.mockHub.lastAmount()).to.equal(weth(5));
        expect(await c.mockHub.calls()).to.equal(1n);
      });
    });

    context("when the token burns a 1% fee on transfer", () => {
      beforeEach(async () => {
        c = await cloned();
        await approveVault(1000n);
        await c.token.setFeeBps(100n);
      });

      it("notifies the hub with the amount the vault received", async () => {
        await c.vault.connect(c.alice).deposit(1000n);
        expect(await c.mockHub.lastAmount()).to.equal(990n); // 1000 less the 1% fee
      });
    });
  });

  describe("pull", () => {
    beforeEach(async () => {
      c = await cloned();
    });

    it("reverts for anyone but the hub", async () => {
      await expect(
        c.vault.connect(c.stranger).pull(c.tokenAddress, c.alice.address, 1n),
      ).to.be.revertedWithCustomError(c.vault, "NotHub");
    });

    it("moves approved tokens into the vault for the hub", async () => {
      await approveVault(weth(2));
      await c.mockHub.pull(c.vaultAddress, c.tokenAddress, c.alice.address, weth(2));
      expect(await c.token.balanceOf(c.vaultAddress)).to.equal(weth(2));
    });
  });

  describe("push", () => {
    context("after the hub pulls in 2 WETH", () => {
      beforeEach(async () => {
        c = await cloned();
        await approveVault(weth(2));
        await c.mockHub.pull(c.vaultAddress, c.tokenAddress, c.alice.address, weth(2));
      });

      it("reverts for anyone but the hub", async () => {
        await expect(
          c.vault.connect(c.stranger).push(c.tokenAddress, c.stranger.address, 1n),
        ).to.be.revertedWithCustomError(c.vault, "NotHub");
      });

      it("sends tokens out of the vault for the hub", async () => {
        await c.mockHub.push(c.vaultAddress, c.tokenAddress, c.stranger.address, weth(1));
        expect(await c.token.balanceOf(c.stranger.address)).to.equal(weth(1));
        expect(await c.token.balanceOf(c.vaultAddress)).to.equal(weth(1));
      });
    });
  });

  describe("collectPremium", () => {
    context("before any premium is collected", () => {
      beforeEach(async () => {
        c = await signerHub();
      });

      it("rejects a zero treasury", async () => {
        await expect(
          c.vault.connect(c.hubSigner).collectPremium(c.tokenAddress, c.alice.address, weth(1), 0n, ZeroAddress),
        ).to.be.revertedWithCustomError(c.vault, "ZeroAddress");
      });

      it("rejects the vault itself as treasury", async () => {
        await expect(
          c.vault.connect(c.hubSigner).collectPremium(c.tokenAddress, c.alice.address, weth(1), 0n, c.vaultAddress),
        ).to.be.revertedWithCustomError(c.vault, "InvalidPlatformFee");
      });

      it("rejects a fee one wei above the premium", async () => {
        await expect(
          c.vault
            .connect(c.hubSigner)
            .collectPremium(c.tokenAddress, c.alice.address, weth(1), weth(1) + 1n, c.treasury.address),
        ).to.be.revertedWithCustomError(c.vault, "InvalidPlatformFee");
      });

      it("accepts a fee equal to the premium and leaves the LPs nothing", async () => {
        await approveVault(weth(1));
        await c.vault
          .connect(c.hubSigner)
          .collectPremium(c.tokenAddress, c.alice.address, weth(1), weth(1), c.treasury.address);
        expect(await c.vault.platformFeeRemaining()).to.equal(weth(1));
        expect(await c.vault.premiumRemaining()).to.equal(0n);
      });

      it("moves no tokens for a zero premium", async () => {
        await expect(
          c.vault.connect(c.hubSigner).collectPremium(c.tokenAddress, c.alice.address, 0n, 0n, c.treasury.address),
        ).not.to.emit(c.token, "Transfer");
      });
    });
  });

  describe("claimPlatformFee", () => {
    context("after collecting a 4 WETH premium with a 1 WETH fee", () => {
      beforeEach(async () => {
        c = await premiumCollected();
      });

      it("lets anyone send the fee to the treasury", async () => {
        await expect(c.vault.connect(c.stranger).claimPlatformFee()).to.changeTokenBalances(
          ethers,
          c.token,
          [c.treasury, c.vaultAddress],
          [weth(1), -weth(1)],
        );
      });

      it("emits PlatformFeeClaimed with the treasury and fee", async () => {
        await expect(c.vault.connect(c.stranger).claimPlatformFee())
          .to.emit(c.vault, "PlatformFeeClaimed")
          .withArgs(c.treasury.address, weth(1));
      });
    });
  });

  describe("payPremium", () => {
    context("after collecting a 4 WETH premium with a 1 WETH fee", () => {
      beforeEach(async () => {
        c = await premiumCollected();
      });

      it("deducts a payment from the premium left for the LPs", async () => {
        await c.vault.connect(c.hubSigner).payPremium(c.alice.address, weth(2));
        expect(await c.vault.premiumRemaining()).to.equal(weth(1));
      });

      it("moves no tokens for a zero payment", async () => {
        await expect(c.vault.connect(c.hubSigner).payPremium(c.alice.address, 0n)).not.to.emit(c.token, "Transfer");
      });
    });
  });

  describe("fundUnwind", () => {
    context("when the premium token burns a 1% fee on transfer", () => {
      beforeEach(async () => {
        c = await premiumTokenBound();
        await approveVault(1000n);
        await c.token.setFeeBps(100n);
      });

      it("reverts with ShortReceived for the amount the vault received", async () => {
        await expect(c.vault.connect(c.hubSigner).fundUnwind(c.alice.address, 1000n))
          .to.be.revertedWithCustomError(c.vault, "ShortReceived")
          .withArgs(1000n, 990n);
      });
    });
  });

  describe("returnUnwind", () => {
    context("with the premium token bound", () => {
      beforeEach(async () => {
        c = await premiumTokenBound();
      });

      it("moves no tokens for a zero amount", async () => {
        await expect(c.vault.connect(c.hubSigner).returnUnwind(c.alice.address, 0n)).not.to.emit(c.token, "Transfer");
      });
    });
  });

  describe("payBuyer", () => {
    context("with nothing reserved for the buyer", () => {
      beforeEach(async () => {
        c = await cloned();
      });

      it("moves no tokens", async () => {
        await expect(c.mockHub.payBuyer(c.vaultAddress, c.tokenAddress, c.alice.address)).not.to.emit(
          c.token,
          "Transfer",
        );
      });
    });
  });

  describe("native ether", () => {
    beforeEach(async () => {
      c = await cloned();
    });

    it("rejects a plain transfer", async () => {
      await expect(c.alice.sendTransaction({ to: c.vaultAddress, value: 1n })).to.be.revert(ethers);
    });
  });
});
