import { Transaction, formatUnits, getAddress, keccak256 } from "ethers"
import type { Signer, TransactionReceipt } from "ethers"
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join } from "node:path"

import { json, planHash, rpc } from "../deployment.ts"
import type { PlanIdentity } from "../deployment.ts"

export interface Intent {
	to?: string
	data: string
	nonce?: number
}
export interface Entry {
	intent: Intent
	attempts: string[]
	hash?: string
	blockNumber?: number
}
export interface State {
	planHash: string
	entries: Record<string, Entry>
}
export interface RunOptions {
	confirmations: number
	timeoutMs: number
	maxFeePerGas: bigint
	maxPriorityFeePerGas: bigint
	bump?: boolean
	log?: (message: string) => void
}

/** Flush both the replacement file and directory before a transaction may be broadcast. */
export async function atomicJson(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const temp = `${path}.${process.pid}.tmp`
	const file = await open(temp, "w", 0o600)
	try {
		await file.writeFile(json(value) + "\n")
		await file.sync()
	} finally {
		await file.close()
	}
	await rename(temp, path)
	const directory = await open(dirname(path), "r")
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

export async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8"))
}

export async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const path = join(directory, ".lock")
	let file
	try {
		file = await open(path, "wx", 0o600)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		const owner = await readJson<{ pid: number; host: string }>(path)
		if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`Deployment locked: ${path}`)
		try {
			process.kill(owner.pid, 0)
		} catch (probe) {
			if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
				throw new Error(`Stale deployment lock: ${path}. Confirm no runner is active, remove this lock, then resume.`)
			}
			throw probe
		}
		throw new Error(`Deployment already running in PID ${owner.pid}`)
	}
	try {
		await file.writeFile(json({ pid: process.pid, host: hostname() }))
		await file.sync()
		return await action()
	} finally {
		await file.close()
		await unlink(path)
	}
}

export class Transactions {
	readonly signer: Signer
	readonly identity: PlanIdentity
	readonly state: State
	readonly persist: (state: State) => Promise<void>
	readonly options: RunOptions
	private lastConfirmedNonce?: number

	constructor(signer: Signer, identity: PlanIdentity, state: State, persist: (state: State) => Promise<void>, options: RunOptions) {
		this.signer = signer
		this.identity = identity
		this.state = state
		this.persist = persist
		this.options = options
	}

	async checkIdentity(plan: unknown) {
		const provider = rpc(this.signer.provider)
		if (this.state.planHash !== planHash(plan)) throw new Error("State belongs to another plan")
		if ((await this.signer.getAddress()).toLowerCase() !== this.identity.deployer.toLowerCase()) throw new Error("Wrong deployer")
		if (
			String(BigInt(await provider.send("eth_chainId", []))) !== this.identity.chainId ||
			(await provider.getBlock(0))?.hash !== this.identity.genesisHash
		)
			throw new Error("Wrong chain")
	}

	async run(id: string, intent: Intent): Promise<TransactionReceipt> {
		const provider = rpc(this.signer.provider)
		let entry = this.state.entries[id]
		if (entry && json(entry.intent) !== json(intent)) throw new Error(`Intent changed: ${id}`)
		const validate = (raw: string) => {
			const tx = Transaction.from(raw)
			if (
				tx.from?.toLowerCase() !== this.identity.deployer.toLowerCase() ||
				tx.chainId.toString() !== this.identity.chainId ||
				tx.value !== 0n ||
				tx.data !== intent.data ||
				(tx.to ?? null) !== (intent.to ? getAddress(intent.to) : null) ||
				(intent.nonce !== undefined && tx.nonce !== intent.nonce) ||
				(entry?.attempts.length && tx.nonce !== Transaction.from(entry.attempts[0]).nonce) ||
				tx.type !== 2
			)
				throw new Error(`Signed transaction mismatch: ${id}`)
			return tx
		}
		const checkReceipt = async () => {
			for (const raw of entry?.attempts ?? []) {
				validate(raw)
				const receipt = await provider.getTransactionReceipt(keccak256(raw))
				if (receipt) return receipt
			}
			return null
		}
		const finish = async (receipt: TransactionReceipt) => {
			const confirmed = await provider.waitForTransaction(receipt.hash, this.options.confirmations, this.options.timeoutMs)
			if (!confirmed) throw new Error(`Confirmation timeout: ${id}; run resume again`)
			if (confirmed.status !== 1) throw new Error(`Transaction reverted: ${id} (${confirmed.hash}). Stop and inspect; its nonce was consumed.`)
			const confirmedRaw = entry.attempts.find(raw => keccak256(raw) === confirmed.hash)
			if (!confirmedRaw) throw new Error(`Confirmed transaction missing from journal: ${id}`)
			entry.hash = confirmed.hash
			entry.blockNumber = confirmed.blockNumber
			await this.persist(this.state)
			this.lastConfirmedNonce = Math.max(this.lastConfirmedNonce ?? -1, Transaction.from(confirmedRaw).nonce)
			this.options.log?.(`${id}: confirmed ${confirmed.hash}`)
			return confirmed
		}
		const mined = await checkReceipt()
		if (mined) return finish(mined)
		if (entry?.hash) throw new Error(`Confirmed receipt disappeared: ${id}; check the RPC or chain reorganization`)

		let raw = entry?.attempts.at(-1)
		if (!raw || this.options.bump) {
			const previous = raw ? validate(raw) : undefined
			const latest = Number(BigInt(await provider.send("eth_getTransactionCount", [this.identity.deployer, "latest"])))
			const pending = Number(BigInt(await provider.send("eth_getTransactionCount", [this.identity.deployer, "pending"])))
			const nonce = previous?.nonce ?? intent.nonce ?? (this.lastConfirmedNonce === undefined ? latest : this.lastConfirmedNonce + 1)
			// An RPC can expose a confirmed receipt before its "latest" account nonce catches up.
			const journalCoversLag = this.lastConfirmedNonce !== undefined && this.lastConfirmedNonce + 1 === nonce
			if (latest > nonce || (!previous && (pending !== nonce || (latest < nonce && !journalCoversLag))))
				throw new Error(`Nonce conflict: ${id}, expected ${nonce}, latest ${latest}, pending ${pending}`)
			const fees = await provider.getFeeData()
			const bump = (value: bigint) => (value * 125n + 99n) / 100n
			const maximum = (...values: bigint[]) => values.reduce((a, b) => (a > b ? a : b))
			const tip = maximum(fees.maxPriorityFeePerGas ?? 0n, previous ? bump(previous.maxPriorityFeePerGas!) : 0n)
			const fee = maximum(fees.maxFeePerGas ?? 0n, tip, previous ? bump(previous.maxFeePerGas!) : 0n)
			if (fee === 0n || tip === 0n) throw new Error("RPC did not return EIP-1559 fees")
			if (fee > this.options.maxFeePerGas || tip > this.options.maxPriorityFeePerGas)
				throw new Error(
					`Gas fee quote for ${id} exceeds configured cap: max ${formatUnits(fee, "gwei")} gwei (cap ${formatUnits(this.options.maxFeePerGas, "gwei")}), priority ${formatUnits(tip, "gwei")} gwei (cap ${formatUnits(this.options.maxPriorityFeePerGas, "gwei")}). Adjust DEPLOY_MAX_FEE_GWEI or DEPLOY_MAX_PRIORITY_FEE_GWEI and resume.`,
				)
			const request = {
				to: intent.to,
				data: intent.data,
				value: 0n,
				nonce,
				chainId: BigInt(this.identity.chainId),
				type: 2,
				maxFeePerGas: fee,
				maxPriorityFeePerGas: tip,
			}
			const estimate = await provider.estimateGas({ ...request, from: this.identity.deployer })
			const gasLimit = maximum((estimate * 120n + 99n) / 100n, previous?.gasLimit ?? 0n)
			if ((await provider.getBalance(this.identity.deployer)) < gasLimit * fee) throw new Error(`Insufficient native gas balance for ${id}`)
			raw = await this.signer.signTransaction({ ...request, gasLimit })
			validate(raw)
			entry ??= this.state.entries[id] = { intent, attempts: [] }
			entry.attempts.push(raw)
			// This write must succeed before broadcast, including for fee replacements.
			await this.persist(this.state)
		}
		validate(raw)
		const hash = keccak256(raw)
		this.options.log?.(`${id}: waiting for ${hash}`)
		try {
			await provider.broadcastTransaction(raw)
		} catch (error) {
			const recovered = await checkReceipt()
			if (recovered) return finish(recovered)
			// An "already known" response is harmless, but never infer acceptance from an error string.
			if (!(await provider.getTransaction(hash))) throw error
		}
		const receipt = await provider.waitForTransaction(hash, this.options.confirmations, this.options.timeoutMs)
		if (!receipt) throw new Error(`Transaction timeout: ${id}; run resume again`)
		return finish(receipt)
	}
}
