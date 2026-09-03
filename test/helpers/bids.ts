import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

export const BID_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Bid: [
    { name: "vaultId", type: "uint256" },
    { name: "marketMaker", type: "address" },
    { name: "quoteToken", type: "address" },
    { name: "strike", type: "uint256" },
    { name: "premium", type: "uint256" },
    { name: "style", type: "uint8" },
    { name: "settlement", type: "uint8" },
    { name: "expiry", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

export interface Bid {
  vaultId: bigint;
  marketMaker: string;
  quoteToken: string;
  strike: bigint;
  premium: bigint;
  style: number;
  settlement: number;
  expiry: bigint;
  validUntil: bigint;
  nonce: bigint;
}

export async function signBid(signer: HardhatEthersSigner, hubAddress: string, bid: Bid): Promise<string> {
  const { chainId } = await signer.provider!.getNetwork();
  const domain = { name: "IvyVaultsHub", version: "1", chainId, verifyingContract: hubAddress };
  return signer.signTypedData(domain, BID_TYPES, bid);
}
