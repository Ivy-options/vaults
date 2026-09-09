import { Contract, ContractFactory, getCreateAddress, ZeroHash } from 'ethers';
import { findCreation, verifyCreation, json, planHash } from './deployment.mjs';

export async function buildRegistryDeploymentPlan({ artifact, chainId, genesisHash, deployer, startNonce, admin }) {
  const address = getCreateAddress({ from: deployer, nonce: startNonce });
  const tx = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(admin);
  return { version: 1, kind: 'ivy-registry', chainId: String(chainId), genesisHash, deployer, startNonce, admin, address,
    steps: [{ name: 'IvyVaultsRegistry', address, nonce: startNonce, data: tx.data, deployedSize: (artifact.deployedBytecode.length - 2) / 2 }] };
}

/** Independent nonce sequence and journal, validated against the local registry artifact on every resume. */
export async function resumeRegistryDeployment(signer, plan, artifact, journal = /** @type {any} */ ({}), persist = async (_journal) => {}) {
  if (plan.version !== 1 || plan.kind !== 'ivy-registry') throw new Error('Unsupported registry plan');
  if (json(await buildRegistryDeploymentPlan({ ...plan, artifact })) !== json(plan)) throw new Error('Registry plan does not match this build');
  const provider = signer.provider;
  if (String((await provider.getNetwork()).chainId) !== plan.chainId || (await provider.getBlock(0)).hash !== plan.genesisHash) throw new Error('Wrong chain');
  if ((await signer.getAddress()).toLowerCase() !== plan.deployer.toLowerCase()) throw new Error('Wrong deployer');
  const digest = planHash(plan);
  if (journal.planHash && journal.planHash !== digest) throw new Error('Journal belongs to another plan');
  journal.planHash = digest; journal.startBlock ??= await provider.getBlockNumber(); journal.steps ??= {};
  const step = plan.steps[0], entry = journal.steps.IvyVaultsRegistry ??= {};
  await persist(journal);
  if (await provider.getCode(plan.address) !== '0x') entry.hash ??= await findCreation(provider, plan, step, journal.startBlock);
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
