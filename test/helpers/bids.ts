import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"

import { BID_TYPES } from "../../scripts/encoding.ts"

export { BID_TYPES }

export interface Bid {
	vaultId: bigint
	marketMaker: string
	quoteToken: string
	strike: bigint
	premium: bigint
	style: number
	settlement: number
	expiry: bigint
	validUntil: bigint
	nonce: bigint
	auctionId: bigint
	collateralAmount: bigint
	termsHash: string
	executor: string
	recipient: string
}

export async function signBid(signer: HardhatEthersSigner, hubAddress: string, bid: Bid): Promise<string> {
	const { chainId } = await signer.provider!.getNetwork()
	const domain = { name: "IvyVaultsHub", version: "3", chainId, verifyingContract: hubAddress }
	return signer.signTypedData(domain, BID_TYPES, bid)
}
