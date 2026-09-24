import { expect } from "chai"
import { network } from "hardhat"

import { activate, openVault, PREMIUM_TOTAL, type OpenedVault } from "../helpers/scenarios.js"
import { Phase, callPairs, callTerms, createVaultAs, deployIvy, fixture, usdc, weth, type IvyContext } from "../helpers/setup.js"
import { proposeUnwind } from "../helpers/unwind.js"

const connection = await network.create()
const { ethers, networkHelpers } = connection

const deployed = fixture(connection, () => deployIvy(connection, { transfersEnabled: true }))

/** alice's funded covered call in auction, premium paid in CallbackToken that the market maker holds and approved. */
const callbackPremium = fixture(deployed, async c => {
	const token = await ethers.deployContract("CallbackToken")
	const tokenAddress = await token.getAddress()
	const v = await openVault(c, { premiumToken: tokenAddress })
	await token.mint(c.marketMaker.address, PREMIUM_TOTAL)
	await token.connect(c.marketMaker).approve(v.vaultAddress, PREMIUM_TOTAL)
	return { c, v, token, tokenAddress }
})

/** Live, with a 100-token unwind refund proposed, approved by alice, and funded to her; the token may move her shares. */
const unwindApproved = fixture(callbackPremium, async ({ c, v, token, tokenAddress }) => {
	await activate(c, v.vaultId, v.vaultAddress)
	const deadline = BigInt(await networkHelpers.time.latest()) + 24n * 3600n // one day
	const { agreement, signature } = await proposeUnwind(c, v.vaultId, deadline, usdc(100))
	await c.hub.connect(c.alice).approveUnwind(v.vaultId, agreement.nonce)
	await token.mint(c.alice.address, agreement.refund)
	await token.connect(c.alice).approve(v.vaultAddress, agreement.refund)
	await c.shares.connect(c.alice).setApprovalForAll(tokenAddress, true)
	return { c, v, token, tokenAddress, agreement, signature }
})

/** Still in auction; the token's next transfer moves all of alice's shares to carol. */
const collectionMovesShares = fixture(callbackPremium, async ({ c, v, token, tokenAddress }) => {
	await c.shares.connect(c.alice).setApprovalForAll(tokenAddress, true)
	await token.arm(
		c.sharesAddress,
		c.shares.interface.encodeFunctionData("safeTransferFrom", [c.alice.address, c.carol.address, v.vaultId, weth(10), "0x"]),
	)
	return { c, v, token }
})

/** A covered call whose collateral is CallbackToken: alice holds 100 units, the token itself 10. */
const callbackCollateral = fixture(deployed, async c => {
	const token = await ethers.deployContract("CallbackToken")
	const tokenAddress = await token.getAddress()
	const v = await createVaultAs(c, c.alice, callTerms(c, { underlying: tokenAddress, collateral: tokenAddress }), callPairs(c))
	await token.mint(c.alice.address, 100n)
	await token.mint(tokenAddress, 10n)
	await token.connect(c.alice).approve(v.vaultAddress, 100n)
	await token.approveSelf(v.vaultAddress, 10n)
	return { c, v, token }
})

/**
 * A USDC vault cloned by MockHub, which acts as both hub and premium module: it holds 1000 units of free
 * collateral, collects 100 units of premium from alice and reserves 200 for the buyer.
 */
const sameTokenReserves = fixture(deployed, async c => {
	const mockHub = await ethers.deployContract("MockHub")
	await mockHub.createClone(c.vaultImplAddress, 1n, c.usdcAddress)
	const vaultAddress = await mockHub.lastClone()
	const vault = await ethers.getContractAt("IvyVault", vaultAddress)
	await c.usdc.mint(vaultAddress, 1000n)
	await c.usdc.mint(c.alice.address, 100n)
	await c.usdc.connect(c.alice).approve(vaultAddress, 100n)
	await mockHub.collectPremium(vaultAddress, c.usdcAddress, c.alice.address, 100n)
	await mockHub.reserveBuyer(vaultAddress, c.usdcAddress, 200n)
	return { c, mockHub, vault, vaultAddress }
})

type CallbackToken = Awaited<ReturnType<typeof callbackPremium>>["token"]

describe("cross-module callbacks", () => {
	describe("fundUnwind", () => {
		let c: IvyContext
		let v: OpenedVault
		let token: CallbackToken
		let tokenAddress: string
		let agreement: Awaited<ReturnType<typeof unwindApproved>>["agreement"]
		let signature: string

		context("with an approved unwind refunded in a callback token", () => {
			beforeEach(async () => {
				;({ c, v, token, tokenAddress, agreement, signature } = await unwindApproved())
			})

			context("when the token's transfer callback moves one of alice's shares to carol", () => {
				beforeEach(async () => {
					await token.arm(
						c.sharesAddress,
						c.shares.interface.encodeFunctionData("safeTransferFrom", [c.alice.address, c.carol.address, v.vaultId, weth(1), "0x"]),
					)
				})

				it("reverts with AgreementInvalid and rolls back both the funding and the share transfer", async () => {
					await expect(c.hub.connect(c.alice).fundUnwind(v.vaultId, agreement.nonce, agreement.refund)).to.be.revertedWithCustomError(
						c.unwind,
						"AgreementInvalid",
					)
					expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Live)
					expect(await c.shares.balanceOf(c.carol.address, v.vaultId)).to.equal(0n)
					expect(await token.balanceOf(c.alice.address)).to.equal(agreement.refund)
					expect(await v.vault.reserved(tokenAddress)).to.equal(PREMIUM_TOTAL)
				})
			})

			context("when the token's transfer callback round-trips one of alice's shares", () => {
				beforeEach(async () => {
					await token.arm(tokenAddress, token.interface.encodeFunctionData("roundTrip", [c.sharesAddress, c.alice.address, v.vaultId, weth(1)]))
				})

				it("reverts with AgreementInvalid and leaves alice holding every share", async () => {
					await expect(c.hub.connect(c.alice).fundUnwind(v.vaultId, agreement.nonce, agreement.refund)).to.be.revertedWithCustomError(
						c.unwind,
						"AgreementInvalid",
					)
					expect(await c.shares.balanceOf(c.alice.address, v.vaultId)).to.equal(weth(10))
				})
			})

			context("after alice moves a share to carol outside any callback and both approve", () => {
				beforeEach(async () => {
					await c.shares.connect(c.alice).safeTransferFrom(c.alice.address, c.carol.address, v.vaultId, weth(1), "0x")
					for (const holder of [c.alice, c.carol]) await c.hub.connect(holder).approveUnwind(v.vaultId, agreement.nonce)
					await token.mint(c.carol.address, usdc(10))
					await token.connect(c.carol).approve(v.vaultAddress, usdc(10))
				})

				it("executes once alice and carol fund their parts of the refund", async () => {
					// The 100 refund splits by shares: 9 of 10 for alice, 1 of 10 for carol.
					await c.hub.connect(c.alice).fundUnwind(v.vaultId, agreement.nonce, usdc(90))
					await c.hub.connect(c.carol).fundUnwind(v.vaultId, agreement.nonce, usdc(10))
					await c.hub.connect(c.alice).executeUnwind(v.vaultId, agreement.nonce, signature)
					expect((await c.hub.stateOf(v.vaultId)).phase).to.equal(Phase.Settled)
				})
			})
		})
	})

	describe("activate", () => {
		let c: IvyContext
		let v: OpenedVault
		let token: CallbackToken

		context("when the premium token's transfer callback moves all of alice's shares to carol", () => {
			beforeEach(async () => {
				;({ c, v, token } = await collectionMovesShares())
				await activate(c, v.vaultId, v.vaultAddress)
			})

			it("lets the share transfer go through during premium collection", async () => {
				expect(await token.callbackSucceeded()).to.equal(true)
				expect(await c.shares.balanceOf(c.carol.address, v.vaultId)).to.equal(weth(10))
			})

			it("credits the whole premium to carol and none to alice", async () => {
				expect(await c.premiums.claimable(v.vaultId, c.alice.address)).to.equal(0n)
				expect(await c.premiums.claimable(v.vaultId, c.carol.address)).to.equal(PREMIUM_TOTAL)
			})
		})
	})

	describe("claimPremium", () => {
		let c: IvyContext
		let v: OpenedVault
		let token: CallbackToken

		context("when the premium token's transfer callback re-enters claimPremium", () => {
			beforeEach(async () => {
				;({ c, v, token } = await collectionMovesShares())
				await activate(c, v.vaultId, v.vaultAddress)
				await token.arm(c.hubAddress, c.hub.interface.encodeFunctionData("claimPremium", [v.vaultId]))
			})

			it("fails the nested claim and pays carol the premium once", async () => {
				await c.hub.connect(c.carol).claimPremium(v.vaultId)
				expect(await token.callbackSucceeded()).to.equal(false)
				expect(await token.balanceOf(c.carol.address)).to.equal(PREMIUM_TOTAL)
			})
		})
	})

	describe("IvyVault", () => {
		describe("deposit", () => {
			let c: IvyContext
			let v: Awaited<ReturnType<typeof callbackCollateral>>["v"]
			let token: CallbackToken

			context("when the collateral's transfer callback nests a hub deposit from the token", () => {
				beforeEach(async () => {
					;({ c, v, token } = await callbackCollateral())
					await token.arm(c.hubAddress, c.hub.interface.encodeFunctionData("deposit", [v.vaultId, 10n]))
				})

				it("fails the nested deposit so it cannot inflate the balance-delta credit", async () => {
					await v.vault.connect(c.alice).deposit(100n)
					expect(await token.callbackSucceeded()).to.equal(false)
					expect(await token.balanceOf(v.vaultAddress)).to.equal(100n)
					expect(await c.hub.totalShares(v.vaultId)).to.equal(100n)
				})
			})
		})

		context("with premium and collateral in the same token", () => {
			let c: IvyContext
			let mockHub: Awaited<ReturnType<typeof sameTokenReserves>>["mockHub"]
			let vault: Awaited<ReturnType<typeof sameTokenReserves>>["vault"]
			let vaultAddress: string

			beforeEach(async () => {
				;({ c, mockHub, vault, vaultAddress } = await sameTokenReserves())
			})

			it("reserves the premium and the buyer payout side by side", async () => {
				expect(await vault.reserved(c.usdcAddress)).to.equal(300n) // 100 premium + 200 buyer
			})

			it("rejects a premium payout from anyone but the premium module", async () => {
				await expect(vault.payPremium(c.alice.address, 1n)).to.be.revertedWithCustomError(vault, "NotPremiumModule")
			})

			it("rejects a premium payout above the collected premium though more of the token is free", async () => {
				await expect(mockHub.payPremium(vaultAddress, c.alice.address, 101n)).to.be.revertedWithCustomError(vault, "InsufficientAvailable")
			})

			it("rejects a collateral push above the balance left after both reservations", async () => {
				// 1100 held − 300 reserved leaves 800.
				await expect(mockHub.push(vaultAddress, c.usdcAddress, c.alice.address, 801n)).to.be.revertedWithCustomError(vault, "InsufficientAvailable")
			})

			it("rejects a second premium collection", async () => {
				await expect(mockHub.collectPremium(vaultAddress, c.usdcAddress, c.alice.address, 0n)).to.be.revertedWithCustomError(
					vault,
					"AlreadyInitialized",
				)
			})

			context("after the buyer is paid", () => {
				beforeEach(async () => {
					await mockHub.payBuyer(vaultAddress, c.usdcAddress, c.bob.address)
				})

				it("keeps only the premium reserved", async () => {
					expect(await vault.reserved(c.usdcAddress)).to.equal(100n)
				})

				it("lets the premium and the free collateral drain the vault", async () => {
					await mockHub.payPremium(vaultAddress, c.alice.address, 100n)
					await mockHub.push(vaultAddress, c.usdcAddress, c.alice.address, 800n)
					expect(await c.usdc.balanceOf(vaultAddress)).to.equal(0n)
				})
			})
		})
	})
})
