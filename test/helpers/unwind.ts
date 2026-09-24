import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"

import { UNWIND_TYPES } from "../../scripts/encoding.ts"
import { fund, type IvyContext } from "./setup.js"

export async function signUnwindProposal(c: IvyContext, vaultId: bigint, deadline: bigint, refund: bigint) {
	const [a, digest] = await c.hub.previewUnwind(vaultId, deadline, refund)
	const agreement = {
		vaultId: a.vaultId,
		nonce: a.nonce,
		deadline: a.deadline,
		exercisedNotional: a.exercisedNotional,
		supply: a.supply,
		refund: a.refund,
	}
	const domain = {
		name: "IvyUnwind",
		version: "1",
		chainId: (await c.marketMaker.provider!.getNetwork()).chainId,
		verifyingContract: await c.unwind.getAddress(),
	}
	const signature = await c.marketMaker.signTypedData(domain, UNWIND_TYPES, agreement)
	return { agreement, digest, domain, signature }
}

export async function proposeUnwind(c: IvyContext, vaultId: bigint, deadline: bigint, refund: bigint) {
	const proposal = await signUnwindProposal(c, vaultId, deadline, refund)
	await c.hub.connect(c.alice).proposeUnwind(vaultId, deadline, refund, proposal.signature)
	return proposal
}

/** Mints `amount` USDC to `lp` and funds unwind `nonce` with it. */
export async function contribute(
	c: IvyContext,
	v: { vaultId: bigint; vaultAddress: string },
	lp: HardhatEthersSigner,
	nonce: bigint,
	amount: bigint,
) {
	await fund(c, c.usdc, lp, v.vaultAddress, amount)
	await c.hub.connect(lp).fundUnwind(v.vaultId, nonce, amount)
}

/** alice records a buyer-signed unwind that stays valid for a day. */
export async function proposeUnwindForADay(c: IvyContext, vaultId: bigint, refund: bigint) {
	const deadline = BigInt(await c.networkHelpers.time.latest()) + 24n * 3600n
	return proposeUnwind(c, vaultId, deadline, refund)
}
