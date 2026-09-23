import type { IvyContext } from "./setup.js";
import { UNWIND_TYPES } from "../../scripts/encoding.mjs";

export async function signUnwindProposal(c: IvyContext, vaultId: bigint, deadline: bigint, refund: bigint) {
  const [a, digest] = await c.hub.previewUnwind(vaultId, deadline, refund);
  const agreement = { vaultId: a.vaultId, nonce: a.nonce, deadline: a.deadline, exercisedNotional: a.exercisedNotional, supply: a.supply, refund: a.refund };
  const domain = { name: "IvyUnwind", version: "1", chainId: (await c.marketMaker.provider!.getNetwork()).chainId, verifyingContract: await c.unwind.getAddress() };
  const signature = await c.marketMaker.signTypedData(domain, UNWIND_TYPES, agreement);
  return { agreement, digest, domain, signature };
}

export async function proposeUnwind(c: IvyContext, vaultId: bigint, deadline: bigint, refund: bigint) {
  const proposal = await signUnwindProposal(c, vaultId, deadline, refund);
  await c.hub.connect(c.alice).proposeUnwind(vaultId, deadline, refund, proposal.signature);
  return proposal;
}
