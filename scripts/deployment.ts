import { readFile } from 'node:fs/promises';
import { Contract, ContractFactory, getCreateAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import type { BigNumberish, InterfaceAbi, Provider, Signer } from 'ethers';

type LinkReferences = Record<string, Record<string, { start: number; length: number }[]>>;
export interface Artifact { abi: InterfaceAbi; bytecode: string; deployedBytecode: string; linkReferences?: LinkReferences; deployedLinkReferences?: LinkReferences }
export type Artifacts = Record<string, Artifact>;
/** Every executor reads raw RPC state, so it needs `send` beyond the ethers Provider interface. */
export type RpcProvider = Provider & { send(method: string, params: unknown[]): Promise<any> };
export function rpc(provider: Provider | null): RpcProvider {
  if (!provider || !('send' in provider)) throw new Error('A JSON-RPC provider is required');
  return provider as RpcProvider;
}
export interface LibraryLink { name: string; address: string; start: number; length: number }
export interface CreationStep { name: string; address: string; nonce: number; data: string; deployedSize: number }
export interface DeploymentStep extends CreationStep { abi: InterfaceAbi; libraryLinks: LibraryLink[] }
export interface PlanIdentity { chainId: string; genesisHash: string | null; deployer: string }
export interface DeploymentPlan extends PlanIdentity {
  version: number; startNonce: number; admin: string; reportSigner: string; settlementMethodology?: string;
  exerciseWindow: string; expiryPricePublicationWindow: string; auctionTimeout: string; uri: string;
  addresses: Record<string, string>; steps: DeploymentStep[];
}
export interface JournalEntry { hash?: string; runtimeHash?: string; intent?: { nonce: number; address: string } }
export interface Journal { planHash?: string; startBlock?: number; steps?: Record<string, JournalEntry>; complete?: boolean }
export type Persist = (journal: Journal) => Promise<void>;
export interface DeploymentInput {
  artifacts: Artifacts; chainId: BigNumberish; genesisHash: string | null; deployer: string; startNonce: number; admin: string; reportSigner: string;
  settlementMethodology?: string; exerciseWindow?: BigNumberish; expiryPricePublicationWindow?: BigNumberish; auctionTimeout?: BigNumberish; uri?: string;
}

export const LIBRARIES = ['IvyVaultRules', 'IvyOptionSettlement'];
export const CONTRACTS = [...LIBRARIES, 'IvyVault', 'IvyVaultsHub', 'IvyShares', 'IvyPremiums', 'IvyUnwind', 'IvyPriceFeed', 'IvyBidRules'];
export const artifactPath = (name: string) => `../artifacts/contracts/${LIBRARIES.includes(name) ? 'libraries/' : ''}${name}.sol/${name}.json`;
export async function loadArtifacts(): Promise<Artifacts> {
  return Object.fromEntries(await Promise.all(CONTRACTS.map(async name=>[name,JSON.parse(await readFile(new URL(artifactPath(name),import.meta.url),'utf8'))])));
}

/** Resolve every compiler-provided link reference; never guess placeholder positions. */
export function linkBytecode(artifact: Pick<Artifact, 'bytecode' | 'linkReferences'>, addresses: Record<string, string>) {
  let code = artifact.bytecode;
  for (const names of Object.values(artifact.linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(names)) {
      if (!LIBRARIES.includes(name) || !addresses[name]) throw new Error(`Unknown library ${name}`);
      const address = getAddress(addresses[name]).slice(2).toLowerCase();
      for (const { start, length } of refs) {
        if (length !== 20) throw new Error(`Invalid link length for ${name}`);
        const offset = 2 + start * 2;
        code = code.slice(0, offset) + address + code.slice(offset + length * 2);
      }
    }
  }
  if (!/^0x[0-9a-fA-F]*$/.test(code)) throw new Error('Unresolved bytecode links');
  return code;
}

function runtimeLinks(artifact: Artifact, addresses: Record<string, string>): LibraryLink[] {
  return Object.values(artifact.deployedLinkReferences ?? {}).flatMap(names =>
    Object.entries(names).flatMap(([name, refs]) => refs.map(({ start, length }) => {
      if (!LIBRARIES.includes(name) || length !== 20) throw new Error(`Invalid runtime link ${name}`);
      return { name, address: getAddress(addresses[name]), start, length };
    })));
}

export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export const planHash = (plan: unknown) => keccak256(toUtf8Bytes(json(plan)));

/** Build all constructor addresses before sending anything. Artifacts come from the local build. */
export async function buildDeploymentPlan({ artifacts, chainId, genesisHash, deployer, startNonce, admin, reportSigner, settlementMethodology, exerciseWindow, expiryPricePublicationWindow, auctionTimeout = 259200, uri = '' }: DeploymentInput): Promise<DeploymentPlan> {
  if (expiryPricePublicationWindow === undefined || BigInt(expiryPricePublicationWindow) <= 0n) throw new Error('Explicit positive expiryPricePublicationWindow required');
  if (exerciseWindow === undefined || BigInt(exerciseWindow) < 0n) throw new Error('Explicit nonnegative exerciseWindow required; cash-capable vaults require a positive value');
  const addresses = Object.fromEntries(CONTRACTS.map((name, i) => [name, getCreateAddress({from:deployer,nonce:startNonce+i})]));
  const a = addresses;
  const args = [[], [], [], [admin,a.IvyVault,a.IvyShares,a.IvyPremiums,a.IvyUnwind,exerciseWindow,auctionTimeout,expiryPricePublicationWindow],
    [a.IvyVaultsHub,a.IvyPremiums,a.IvyUnwind,uri], [a.IvyVaultsHub,a.IvyShares], [a.IvyVaultsHub,a.IvyShares], [reportSigner], []];
  const steps: DeploymentStep[] = [];
  for (let i = 0; i < CONTRACTS.length; ++i) {
    const name = CONTRACTS[i], artifact = artifacts[name];
    const size = (artifact.deployedBytecode.length-2)/2;
    if (size > 24576) throw new Error(`${name} exceeds EIP-170: ${size}`);
    // Library ABIs contain Solidity-only storage/enum types. They have no callable interface.
    const abi = LIBRARIES.includes(name) ? [] : artifact.abi;
    const tx = await new ContractFactory(abi,linkBytecode(artifact,a)).getDeployTransaction(...args[i]);
    steps.push({ name, address:a[name], nonce:startNonce+i, data:tx.data, abi, deployedSize:size, libraryLinks:runtimeLinks(artifact,a) });
  }
  return {version:7,chainId:String(chainId),genesisHash,deployer,startNonce,admin,reportSigner,settlementMethodology,exerciseWindow:String(exerciseWindow),expiryPricePublicationWindow:String(expiryPricePublicationWindow),auctionTimeout:String(auctionTimeout),uri,addresses,steps};
}

export async function findCreation(provider: RpcProvider, plan: PlanIdentity, step: CreationStep, startBlock: number | undefined) {
  // A mined creation may be newer than AbstractProvider's cached block height.
  const latest = Number(BigInt(await provider.send('eth_blockNumber', [])));
  if (startBlock === undefined || !Number.isSafeInteger(startBlock) || startBlock < 0 || startBlock > latest) throw new Error('Invalid creation scan start block');
  for(let n = startBlock; n <= latest; n++) {
    const block = await provider.getBlock(n,true);
    for(const tx of block?.prefetchedTransactions ?? []) {
      if(tx.from.toLowerCase() === plan.deployer.toLowerCase() && tx.nonce === step.nonce) return tx.hash;
    }
  }
  throw new Error(`Cannot verify creation transaction for ${step.name}; refusing to adopt existing code`);
}
/** Latest-state evidence must bypass AbstractProvider's short-lived getCode cache. */
export const currentCode = (provider: RpcProvider, address: string): Promise<string> => provider.send('eth_getCode', [address, 'latest']);

export async function verifyCreation(provider: RpcProvider, plan: PlanIdentity, step: CreationStep, hash: string) {
  const tx = await provider.getTransaction(hash);
  const receipt = await provider.getTransactionReceipt(hash);
  if(!tx || !receipt || receipt.status !== 1 || tx.to !== null || tx.from.toLowerCase() !== plan.deployer.toLowerCase()
     || tx.nonce !== step.nonce || tx.data !== step.data || tx.value !== 0n || tx.chainId.toString() !== plan.chainId
     || receipt.contractAddress?.toLowerCase() !== step.address.toLowerCase()) throw new Error(`Creation evidence mismatch: ${step.name}`);
  const code = await currentCode(provider, step.address);
  if(code === '0x' || (code.length-2)/2 !== step.deployedSize) throw new Error(`Runtime mismatch: ${step.name}`);
  return keccak256(code);
}

export async function verifyBindings(anyProvider: Provider | null, plan: DeploymentPlan, { requireInitialAdmin = true } = {}) {
  const provider = rpc(anyProvider), a = plan.addresses;
  const byName = Object.fromEntries(plan.steps.map(s => [s.name,new Contract(s.address,s.abi,provider)]));
  const checks = [
    ['IvyVaultsHub','vaultImplementation',a.IvyVault],['IvyVaultsHub','shareToken',a.IvyShares],
    ['IvyVaultsHub','premiums',a.IvyPremiums],['IvyVaultsHub','unwind',a.IvyUnwind],
    ['IvyShares','hub',a.IvyVaultsHub],['IvyShares','premiums',a.IvyPremiums],['IvyShares','unwind',a.IvyUnwind],
    ['IvyPremiums','hub',a.IvyVaultsHub],['IvyPremiums','shares',a.IvyShares],
    ['IvyUnwind','hub',a.IvyVaultsHub],['IvyUnwind','shares',a.IvyShares],['IvyPriceFeed','signer',plan.reportSigner],
  ];
  for(const [name,field,value] of checks) if((await byName[name].getFunction(field)()).toLowerCase() !== value.toLowerCase()) throw new Error(`Binding mismatch: ${name}.${field}`);
  for (const name of LIBRARIES) {
    if (await currentCode(provider, a[name]) === '0x') throw new Error(`Library code missing: ${name}`);
  }
  if (await currentCode(provider, a.IvyBidRules) === '0x') throw new Error('Validator code missing: IvyBidRules');
  for (const step of plan.steps) {
    if (!step.libraryLinks.length) continue;
    const code = await currentCode(provider, step.address);
    for (const link of step.libraryLinks) {
      const embedded = '0x' + code.slice(2 + link.start * 2, 2 + (link.start + link.length) * 2);
      if (embedded.toLowerCase() !== a[link.name].toLowerCase() || link.address.toLowerCase() !== a[link.name].toLowerCase()) {
        throw new Error(`Library binding mismatch: ${step.name}.${link.name}`);
      }
    }
  }
  const hub=byName.IvyVaultsHub;
  if(requireInitialAdmin && !(await hub.hasRole(await hub.DEFAULT_ADMIN_ROLE(),plan.admin))) throw new Error('Admin role missing');
}

/** Checks chain, deployer and plan identity, then binds the journal to this plan. Shared by every executor. */
export async function openJournal(signer: Signer, plan: PlanIdentity, journal: Journal): Promise<Required<Pick<Journal, 'startBlock' | 'steps'>>> {
  const provider = rpc(signer.provider);
  if(String((await provider.getNetwork()).chainId) !== plan.chainId || (await provider.getBlock(0))?.hash !== plan.genesisHash) throw new Error('Wrong chain');
  if((await signer.getAddress()).toLowerCase() !== plan.deployer.toLowerCase()) throw new Error('Wrong deployer');
  const digest = planHash(plan);
  if(journal.planHash && journal.planHash !== digest) throw new Error('Journal belongs to another plan');
  journal.planHash = digest;
  journal.startBlock ??= await provider.getBlockNumber();
  journal.steps ??= {};
  return { startBlock: journal.startBlock, steps: journal.steps };
}

/** Explicitly invoked executor. Persist before sending, after submission, and after verified inclusion. */
export async function resumeDeployment(signer: Signer, plan: DeploymentPlan, journal: Journal = {}, persist: Persist = async () => {}) {
  if (plan.version !== 7) throw new Error('Unsupported deployment plan version; prepare a new plan for this build');
  const provider = rpc(signer.provider);
  const { startBlock, steps } = await openJournal(signer, plan, journal);
  await persist(journal);
  for(const step of plan.steps) {
    const entry = steps[step.name] ??= {};
    const existing = await currentCode(provider, step.address);
    if(existing !== '0x') {
      entry.hash ??= await findCreation(provider,plan,step,startBlock);
      const runtimeHash = await verifyCreation(provider,plan,step,entry.hash);
      if(entry.runtimeHash && runtimeHash !== entry.runtimeHash) throw new Error(`Runtime hash changed: ${step.name}`);
      entry.runtimeHash = runtimeHash;
    } else {
      if(!entry.hash) {
        const nonce = Number(BigInt(await provider.send('eth_getTransactionCount',[plan.deployer,'pending'])));
        if(nonce !== step.nonce) throw new Error(`Nonce drift: expected ${step.nonce}, got ${nonce}`);
        entry.intent = {nonce:step.nonce,address:step.address}; await persist(journal);
        const tx = await signer.sendTransaction({data:step.data,nonce:step.nonce,value:0});
        entry.hash=tx.hash; await persist(journal);
        await tx.wait();
      } else {
        const tx = await provider.getTransaction(entry.hash);
        if(!tx) throw new Error(`Submitted transaction unavailable: ${step.name}`);
        await tx.wait();
      }
      entry.runtimeHash=await verifyCreation(provider,plan,step,entry.hash);
    }
    await persist(journal);
  }
  await verifyBindings(provider,plan);
  journal.complete=true; await persist(journal);
  return journal;
}
