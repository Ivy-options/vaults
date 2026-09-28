import { expect } from "chai"
import { Contract, ContractFactory, Transaction, Wallet, keccak256, parseUnits } from "ethers"
import { artifacts, network } from "hardhat"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TOKENS, buildPlan, executePlan } from "../../scripts/deploy/deployment.ts"
import type { Config } from "../../scripts/deploy/deployment.ts"
import { Transactions, atomicJson, readJson, withLock } from "../../scripts/deploy/transactions.ts"
import type { RunOptions, State } from "../../scripts/deploy/transactions.ts"
import { verificationTargets, verifyAllContracts } from "../../scripts/deploy/verification.ts"
import { linkBytecode, loadArtifacts, planHash } from "../../scripts/deployment.ts"
import { verifyRelease } from "../../scripts/releases.ts"
import type { ReleaseBundle } from "../../scripts/releases.ts"
import { skipUnderCoverage } from "../helpers/setup.ts"

const connection = await network.create()
const provider = connection.ethers.provider
const options: RunOptions = {
	confirmations: 1,
	timeoutMs: 2000,
	maxFeePerGas: parseUnits("500", "gwei"),
	maxPriorityFeePerGas: parseUnits("100", "gwei"),
}

async function context() {
	const wallet = Wallet.createRandom().connect(provider)
	await provider.send("hardhat_setBalance", [wallet.address, "0x56BC75E2D63100000"])
	const config: Config = {
		chainId: "31337",
		reportSigner: wallet.address,
		bidMaster: wallet.address,
		marketMaker: wallet.address,
		settlementPublisher: wallet.address,
		recipient: wallet.address,
		exerciseWindow: "3600",
		expiryPricePublicationWindow: "3600",
		auctionTimeout: "3600",
		cashSettlement: true,
		transfersEnabled: true,
		uri: "",
		balances: { fUSDC: "1000000", fETH: "1000", fBTC: "100" },
	}
	const plan = await buildPlan(
		config,
		await loadArtifacts(),
		await artifacts.readArtifact("FakeToken"),
		await artifacts.readArtifact("IvyVaultsRegistry"),
		wallet.address,
		0,
		(await provider.getBlock(0))!.hash!,
	)
	const state: State = { planHash: planHash(plan), entries: {} }
	const runner = new Transactions(wallet, plan.core, state, async () => {}, options)
	return { wallet, plan, state, runner }
}

function interceptProvider(method: string, replacement: (...args: any[]) => any) {
	const original = (provider as any)[method]
	;(provider as any)[method] = replacement
	return () => {
		;(provider as any)[method] = original
	}
}

describe("Test environment resumable deployment", function () {
	this.timeout(120_000)
	skipUnderCoverage()

	it("deploys, configures, registers a verifiable release, and resumes without reminting", async () => {
		const { plan, runner, wallet, state } = await context()
		let bundle: ReleaseBundle
		await executePlan(plan, runner, async value => {
			bundle = value
		})
		await verifyRelease(provider, bundle!, plan.artifacts)
		const nonce = await provider.send("eth_getTransactionCount", [wallet.address, "latest"])
		await executePlan(plan, runner, async () => {})
		expect(await provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal(nonce)
		expect(Object.keys(state.entries)).to.have.length(22)
		for (const token of TOKENS) {
			const contract = new Contract(plan.addresses[token.symbol], plan.tokenArtifact.abi, provider)
			expect(await contract.balanceOf(wallet.address)).to.equal(parseUnits(plan.config.balances[token.symbol], token.decimals))
		}
	})

	it("recovers from a process loss after mining but before saving the receipt", async () => {
		const { plan, state, wallet } = await context()
		let saved = structuredClone(state)
		const interrupted = new Transactions(
			wallet,
			plan.core,
			state,
			async value => {
				if (Object.values(value.entries).some(entry => entry.hash)) throw new Error("simulated disk failure")
				saved = structuredClone(value)
			},
			options,
		)
		await expect(executePlan(plan, interrupted, async () => {})).to.be.rejectedWith("simulated disk failure")
		expect(saved.entries["deploy:IvyVaultRules"].attempts).to.have.length(1)
		expect(saved.entries["deploy:IvyVaultRules"].hash).to.equal(undefined)
		const resumed = new Transactions(wallet, plan.core, saved, async () => {}, options)
		await executePlan(plan, resumed, async () => {})
		expect(await provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x16")
	})

	it("does not mint twice when the process stops before recording a successful mint", async () => {
		const { plan, state, wallet } = await context()
		let saved = structuredClone(state)
		const interrupted = new Transactions(
			wallet,
			plan.core,
			state,
			async value => {
				if (value.entries["mint:fUSDC"]?.hash) throw new Error("process stopped after mint")
				saved = structuredClone(value)
			},
			options,
		)
		await expect(executePlan(plan, interrupted, async () => {})).to.be.rejectedWith("process stopped after mint")
		const resumed = new Transactions(wallet, plan.core, saved, async () => {}, options)
		await executePlan(plan, resumed, async () => {})
		const token = new Contract(plan.addresses.fUSDC, plan.tokenArtifact.abi, provider)
		expect(await token.totalSupply()).to.equal(parseUnits("1000000", 6))
	})

	it("rebroadcasts the identical signed transaction after a pre-broadcast connection failure", async () => {
		const { runner, state, wallet } = await context()
		const intent = { to: wallet.address, data: "0x" }
		const restore = interceptProvider("broadcastTransaction", async () => {
			throw new Error("offline")
		})
		try {
			await expect(runner.run("one", intent)).to.be.rejectedWith("offline")
		} finally {
			restore()
		}
		const raw = state.entries.one.attempts[0]
		expect(raw).to.be.a("string")
		const receipt = await runner.run("one", intent)
		expect(receipt.hash).to.equal(keccak256(raw))
		expect(state.entries.one.attempts).to.have.length(1)
	})

	it("recovers a broadcast accepted by the node when its response is lost", async () => {
		const { runner, wallet, state } = await context()
		const original = provider.broadcastTransaction.bind(provider)
		const restore = interceptProvider("broadcastTransaction", async raw => {
			await original(raw)
			throw new Error("response lost")
		})
		try {
			await runner.run("one", { to: wallet.address, data: "0x" })
		} finally {
			restore()
		}
		expect(state.entries.one.hash).to.equal(keccak256(state.entries.one.attempts[0]))
	})

	it("never broadcasts if the durable journal write fails", async () => {
		const { wallet, plan, state } = await context()
		const runner = new Transactions(
			wallet,
			plan.core,
			state,
			async () => {
				throw new Error("disk full")
			},
			options,
		)
		await expect(runner.run("one", { to: wallet.address, data: "0x" })).to.be.rejectedWith("disk full")
		expect(await provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x0")
	})

	it("resumes a dropped pending transaction with the same nonce and hash", async () => {
		const { wallet, runner, state } = await context()
		await provider.send("evm_setAutomine", [false])
		try {
			await expect(runner.run("one", { to: wallet.address, data: "0x" })).to.be.rejected
			const raw = state.entries.one.attempts[0]
			await provider.send("hardhat_dropTransaction", [keccak256(raw)])
			await provider.send("evm_setAutomine", [true])
			expect((await runner.run("one", { to: wallet.address, data: "0x" })).hash).to.equal(keccak256(raw))
		} finally {
			await provider.send("evm_setAutomine", [true])
		}
	})

	it("replaces a pending transaction with higher fees while preserving its nonce and intent", async () => {
		const { wallet, plan, state, runner } = await context()
		const intent = { to: wallet.address, data: "0x" }
		await provider.send("evm_setAutomine", [false])
		try {
			await expect(runner.run("one", intent)).to.be.rejected
			const previous = Transaction.from(state.entries.one.attempts[0])
			const broadcast = provider.broadcastTransaction.bind(provider)
			const restore = interceptProvider("broadcastTransaction", async raw => {
				const tx = await broadcast(raw)
				await provider.send("evm_mine", [])
				return tx
			})
			const bumped = new Transactions(wallet, plan.core, state, async () => {}, { ...options, bump: true })
			const receipt = await bumped.run("one", intent).finally(restore)
			const replacement = Transaction.from(state.entries.one.attempts[1])
			expect(replacement.nonce).to.equal(previous.nonce)
			expect(replacement.data).to.equal(previous.data)
			expect(replacement.maxFeePerGas!).to.be.greaterThan(previous.maxFeePerGas!)
			expect(receipt.hash).to.equal(replacement.hash)
		} finally {
			await provider.send("evm_setAutomine", [true])
		}
	})

	it("rejects changed plans, wrong signers, wrong chains, nonce drift, and excessive fees", async () => {
		const { wallet, plan, state, runner } = await context()
		await expect(runner.checkIdentity({ ...plan, format: 2 })).to.be.rejectedWith("another plan")
		const other = new Transactions(Wallet.createRandom().connect(provider), plan.core, state, async () => {}, options)
		await expect(other.checkIdentity(plan)).to.be.rejectedWith("Wrong deployer")
		const wrongChain = new Transactions(wallet, { ...plan.core, chainId: "137" }, state, async () => {}, options)
		await expect(wrongChain.checkIdentity(plan)).to.be.rejectedWith("Wrong chain")
		await expect(runner.run("nonce", { to: wallet.address, data: "0x", nonce: 3 })).to.be.rejectedWith("Nonce conflict")
		const lowCap = new Transactions(wallet, plan.core, state, async () => {}, { ...options, maxFeePerGas: 1n })
		await expect(lowCap.run("cap", { to: wallet.address, data: "0x" })).to.be.rejectedWith("exceeds configured cap")
	})

	it("reports the fee quote, configured caps, and blocked step", async () => {
		const { wallet, runner } = await context()
		const restore = interceptProvider("getFeeData", async () => ({
			maxFeePerGas: parseUnits("800", "gwei"),
			maxPriorityFeePerGas: parseUnits("150", "gwei"),
		}))
		try {
			await expect(runner.run("deploy:IvyShares", { data: "0x", nonce: 0 })).to.be.rejectedWith(
				"deploy:IvyShares exceeds configured cap: max 800.0 gwei (cap 500.0), priority 150.0 gwei (cap 100.0)",
			)
		} finally {
			restore()
		}
	})

	it("continues after a confirmed transaction when the RPC latest nonce lags behind pending", async () => {
		const { wallet, plan, runner, state } = await context()
		const intent = { to: wallet.address, data: "0x" }
		await runner.run("first", intent)
		const resumed = new Transactions(wallet, plan.core, state, async () => {}, options)
		await resumed.run("first", intent)
		const original = provider.send.bind(provider)
		const restore = interceptProvider("send", async (method, params) => {
			if (method === "eth_getTransactionCount" && params[0] === wallet.address) return params[1] === "latest" ? "0x0" : "0x1"
			return original(method, params)
		})
		try {
			await resumed.run("second", intent)
		} finally {
			restore()
		}
		expect(Transaction.from(state.entries.second.attempts[0]).nonce).to.equal(1)
	})

	it("rejects a pending nonce without a confirmed journal predecessor", async () => {
		const { wallet, runner } = await context()
		const original = provider.send.bind(provider)
		const restore = interceptProvider("send", async (method, params) => {
			if (method === "eth_getTransactionCount" && params[0] === wallet.address) return params[1] === "latest" ? "0x0" : "0x1"
			return original(method, params)
		})
		try {
			await expect(runner.run("unrecorded", { to: wallet.address, data: "0x" })).to.be.rejectedWith(
				"Nonce conflict: unrecorded, expected 0, latest 0, pending 1",
			)
		} finally {
			restore()
		}
	})

	it("prepares and attempts source verification for all twelve creations", async () => {
		const { plan, state } = await context()
		for (const step of plan.steps)
			state.entries[`deploy:${step.name}`] = { intent: { data: step.data, nonce: step.nonce }, attempts: [], hash: `0x${"ab".repeat(32)}` }
		const targets = verificationTargets(plan, state)
		expect(targets).to.have.length(12)
		for (const [index, step] of plan.steps.entries()) {
			const target = targets[index]
			const name = step.name in plan.artifacts ? step.name : step.name === "IvyVaultsRegistry" ? step.name : "FakeToken"
			const artifact = name === "IvyVaultsRegistry" ? plan.registryArtifact : name === "FakeToken" ? plan.tokenArtifact : plan.artifacts[name]
			const local = await artifacts.readArtifact(name)
			expect(target.contract).to.equal(`${local.sourceName}:${local.contractName}`)
			const deployment = await new ContractFactory(step.abi, linkBytecode(artifact, plan.addresses)).getDeployTransaction(
				...(target.constructorArgs ?? []),
			)
			expect(deployment.data).to.equal(step.data)
		}
		expect(targets.find(target => target.name === "IvyVaultsHub")?.constructorArgs).to.deep.equal([
			plan.core.admin,
			plan.addresses.IvyVault,
			plan.addresses.IvyShares,
			plan.addresses.IvyPremiums,
			plan.addresses.IvyStandardBidRules,
			plan.core.exerciseWindow,
			plan.core.auctionTimeout,
			plan.core.expiryPricePublicationWindow,
		])
		expect(targets.find(target => target.name === "fBTC")?.contract).to.equal("contracts/mocks/FakeToken.sol:FakeToken")
		const seen: string[] = []
		await verifyAllContracts(
			plan,
			state,
			async target => {
				seen.push(target.address)
				return true
			},
			() => {},
		)
		expect(seen).to.deep.equal(plan.steps.map(step => step.address))
	})

	it("reports every source verification failure after trying the remaining contracts", async () => {
		const { plan, state } = await context()
		for (const step of plan.steps)
			state.entries[`deploy:${step.name}`] = { intent: { data: step.data, nonce: step.nonce }, attempts: [], hash: `0x${"ab".repeat(32)}` }
		const seen: string[] = []
		await expect(
			verifyAllContracts(
				plan,
				state,
				async target => {
					seen.push(target.address)
					if ([plan.addresses.fUSDC, plan.addresses.fETH].includes(target.address)) throw new Error("Explorer unavailable")
					return true
				},
				() => {},
			),
		).to.be.rejectedWith("Source verification incomplete for fUSDC, fETH")
		expect(seen).to.have.length(12)
	})

	it("stops on a mined revert instead of changing the nonce and duplicating later steps", async () => {
		const { wallet, plan, state, runner } = await context()
		// This creation always reverts. Sign it directly to represent an already-submitted failure.
		const intent = { data: "0x60006000fd", nonce: 0 }
		const raw = await wallet.signTransaction({
			...intent,
			chainId: 31337,
			gasLimit: 100000,
			type: 2,
			maxFeePerGas: parseUnits("10", "gwei"),
			maxPriorityFeePerGas: parseUnits("1", "gwei"),
		})
		state.entries.bad = { intent, attempts: [raw] }
		try {
			await provider.broadcastTransaction(raw)
		} catch {
			/* Hardhat may surface the mined revert at submission. */
		}
		await expect(runner.run("bad", intent)).to.be.rejectedWith("Transaction reverted")
		expect(state.entries.bad.attempts).to.have.length(1)
	})

	it("faucet minting is public and preserves decimals", async () => {
		const { wallet, plan } = await context()
		const token = await connection.ethers.deployContract("FakeToken", ["Fake Bitcoin", "fBTC", 8])
		await (await token.connect(wallet).getFunction("mint")(wallet.address, parseUnits("2.5", 8))).wait()
		expect(await token.balanceOf(wallet.address)).to.equal(250000000n)
		expect(await token.decimals()).to.equal(8n)
	})

	it("writes complete state files and excludes concurrent deployment processes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ivy-deploy-"))
		try {
			await atomicJson(join(directory, "state.json"), { counter: 1 })
			await atomicJson(join(directory, "state.json"), { counter: 2 })
			expect(await readJson(join(directory, "state.json"))).to.deep.equal({ counter: 2 })
			await withLock(directory, async () => {
				await expect(withLock(directory, async () => {})).to.be.rejectedWith("already running")
			})
			await withLock(directory, async () => {})
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
