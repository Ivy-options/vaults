import { Contract, ContractFactory, getCreateAddress, ZeroHash } from 'ethers';
import type { BigNumberish, Signer } from 'ethers';
import { currentCode, findCreation, openJournal, rpc, verifyCreation, json } from './deployment.ts';
import type { Artifact, CreationStep, Journal, Persist, PlanIdentity } from './deployment.ts';

export interface RegistryDeploymentInput { artifact: Artifact; chainId: BigNumberish; genesisHash: string | null; deployer: string; startNonce: number; admin: string }
export interface RegistryPlan extends PlanIdentity { version: number; kind: string; startNonce: number; admin: string; address: string; steps: CreationStep[] }

export async function buildRegistryDeploymentPlan({ artifact, chainId, genesisHash, deployer, startNonce, admin }: RegistryDeploymentInput): Promise<RegistryPlan> {
  const address = getCreateAddress({ from: deployer, nonce: startNonce });
  const tx = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(admin);
  return { version: 1, kind: 'ivy-registry', chainId: String(chainId), genesisHash, deployer, startNonce, admin, address,
    steps: [{ name: 'IvyVaultsRegistry', address, nonce: startNonce, data: tx.data, deployedSize: (artifact.deployedBytecode.length - 2) / 2 }] };
}

/** Independent nonce sequence and journal, validated against the local registry artifact on every resume. */
export async function resumeRegistryDeployment(signer: Signer, plan: RegistryPlan, artifact: Artifact, journal: Journal = {}, persist: Persist = async () => {}) {
  if (plan.version !== 1 || plan.kind !== 'ivy-registry') throw new Error('Unsupported registry plan');
  if (json(await buildRegistryDeploymentPlan({ ...plan, artifact })) !== json(plan)) throw new Error('Registry plan does not match this build');
  const provider = rpc(signer.provider);
  const { startBlock, steps } = await openJournal(signer, plan, journal);
  const step = plan.steps[0], entry = steps.IvyVaultsRegistry ??= {};
  await persist(journal);
  if (await currentCode(provider, plan.address) !== '0x') entry.hash ??= await findCreation(provider, plan, step, startBlock);
  if (!entry.hash) {
    const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [plan.deployer, 'pending'])));
    if (nonce !== plan.startNonce) throw new Error('Registry nonce drift');
    entry.intent = { nonce, address: plan.address }; await persist(journal);
    const tx = await signer.sendTransaction({ data: step.data, nonce, value: 0 });
    entry.hash = tx.hash; await persist(journal); await tx.wait();
  } else {
    const tx = await provider.getTransaction(entry.hash);
    if (!tx) throw new Error('Registry creation transaction unavailable');
    await tx.wait();
  }
  const hash = await verifyCreation(provider, plan, step, entry.hash);
  if (entry.runtimeHash && entry.runtimeHash !== hash) throw new Error('Registry runtime changed');
  entry.runtimeHash = hash;
  const registry = new Contract(plan.address, artifact.abi, provider);
  if (!await registry.hasRole(ZeroHash, plan.admin)) throw new Error('Registry admin role missing');
  journal.complete = true; await persist(journal); return journal;
}
