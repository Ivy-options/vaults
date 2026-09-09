import { Contract, ContractFactory, getCreateAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';
export const LIBRARIES = ['IvyVaultRules', 'IvyOptionSettlement'];
export const CONTRACTS = [...LIBRARIES, 'IvyVault', 'IvyVaultsHub', 'IvyShares', 'IvyPremiums', 'IvyUnwind', 'IvyPriceFeed'];
export const artifactPath = name => `../artifacts/contracts/${LIBRARIES.includes(name) ? 'libraries/' : ''}${name}.sol/${name}.json`;

/** Resolve every compiler-provided link reference; never guess placeholder positions. */
export function linkBytecode(artifact, addresses) {
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

function runtimeLinks(artifact, addresses) {
  return Object.values(artifact.deployedLinkReferences ?? {}).flatMap(names =>
    Object.entries(names).flatMap(([name, refs]) => refs.map(({ start, length }) => {
      if (!LIBRARIES.includes(name) || length !== 20) throw new Error(`Invalid runtime link ${name}`);
      return { name, address: getAddress(addresses[name]), start, length };
    })));
}

export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export const planHash = plan => keccak256(toUtf8Bytes(json(plan)));

/** Build all constructor addresses before sending anything. Artifacts come from the local build. */
export async function buildDeploymentPlan({ artifacts, chainId, genesisHash, deployer, startNonce, admin, reportSigner, settlementMethodology = /** @type {string | undefined} */ (undefined), exerciseWindow = 3600, auctionTimeout = 259200, uri = '' }) {
  const addresses = Object.fromEntries(CONTRACTS.map((name, i) => [name, getCreateAddress({from:deployer,nonce:startNonce+i})]));
  const a = addresses;
  const args = [[], [], [], [admin,a.IvyVault,a.IvyShares,a.IvyPremiums,a.IvyUnwind,exerciseWindow,auctionTimeout],
    [a.IvyVaultsHub,a.IvyPremiums,a.IvyUnwind,uri], [a.IvyVaultsHub,a.IvyShares], [a.IvyVaultsHub,a.IvyShares], [reportSigner]];
  const steps = [];
  for (let i = 0; i < CONTRACTS.length; ++i) {
    const name = CONTRACTS[i], artifact = artifacts[name];
    const size = (artifact.deployedBytecode.length-2)/2;
    if (size > 24576) throw new Error(`${name} exceeds EIP-170: ${size}`);
    // Library ABIs contain Solidity-only storage/enum types. They have no operator-callable interface.
    const abi = LIBRARIES.includes(name) ? [] : artifact.abi;
    const tx = await new ContractFactory(abi,linkBytecode(artifact,a)).getDeployTransaction(...args[i]);
    steps.push({ name, address:a[name], nonce:startNonce+i, data:tx.data, abi, deployedSize:size, libraryLinks:runtimeLinks(artifact,a) });
  }
  return {version:5,chainId:String(chainId),genesisHash,deployer,startNonce,admin,reportSigner,settlementMethodology,exerciseWindow:String(exerciseWindow),auctionTimeout:String(auctionTimeout),uri,addresses,steps};
}

async function findCreation(provider, plan, step, startBlock) {
  const latest = await provider.getBlockNumber();
  for(let n = startBlock; n <= latest; n++) {
    const block = await provider.getBlock(n,true);
    for(const tx of block.prefetchedTransactions) {
      if(tx.from.toLowerCase() === plan.deployer.toLowerCase() && tx.nonce === step.nonce) return tx.hash;
    }
  }
  throw new Error(`Cannot verify creation transaction for ${step.name}; refusing to adopt existing code`);
}
async function verifyCreation(provider, plan, step, hash) {
  const tx = await provider.getTransaction(hash);
  const receipt = await provider.getTransactionReceipt(hash);
  if(!tx || !receipt || receipt.status !== 1 || tx.to !== null || tx.from.toLowerCase() !== plan.deployer.toLowerCase()
     || tx.nonce !== step.nonce || tx.data !== step.data || tx.value !== 0n || tx.chainId.toString() !== plan.chainId
     || receipt.contractAddress?.toLowerCase() !== step.address.toLowerCase()) throw new Error(`Creation evidence mismatch: ${step.name}`);
  const code = await provider.getCode(step.address);
  if(code === '0x' || (code.length-2)/2 !== step.deployedSize) throw new Error(`Runtime mismatch: ${step.name}`);
  return keccak256(code);
}

export async function verifyBindings(provider, plan) {
  const a = plan.addresses;
  const byName = Object.fromEntries(plan.steps.map(s => [s.name,new Contract(s.address,s.abi,provider)]));
  const checks = [
    ['IvyVaultsHub','vaultImplementation',a.IvyVault],['IvyVaultsHub','shareToken',a.IvyShares],
    ['IvyVaultsHub','premiums',a.IvyPremiums],['IvyVaultsHub','unwind',a.IvyUnwind],
    ['IvyShares','hub',a.IvyVaultsHub],['IvyShares','premiums',a.IvyPremiums],['IvyShares','unwind',a.IvyUnwind],
    ['IvyPremiums','hub',a.IvyVaultsHub],['IvyPremiums','shares',a.IvyShares],
    ['IvyUnwind','hub',a.IvyVaultsHub],['IvyUnwind','shares',a.IvyShares],['IvyPriceFeed','signer',plan.reportSigner],
  ];
  for(const [name,field,value] of checks) if((await byName[name][field]()).toLowerCase() !== value.toLowerCase()) throw new Error(`Binding mismatch: ${name}.${field}`);
  for (const name of LIBRARIES) {
    if (await provider.getCode(a[name]) === '0x') throw new Error(`Library code missing: ${name}`);
  }
  for (const step of plan.steps) {
    if (!step.libraryLinks.length) continue;
    const code = await provider.getCode(step.address);
    for (const link of step.libraryLinks) {
      const embedded = '0x' + code.slice(2 + link.start * 2, 2 + (link.start + link.length) * 2);
      if (embedded.toLowerCase() !== a[link.name].toLowerCase() || link.address.toLowerCase() !== a[link.name].toLowerCase()) {
        throw new Error(`Library binding mismatch: ${step.name}.${link.name}`);
      }
    }
  }
  const hub=byName.IvyVaultsHub;
  if(!(await hub.hasRole(await hub.DEFAULT_ADMIN_ROLE(),plan.admin))) throw new Error('Admin role missing');
}

/** Explicitly invoked executor. Persist before sending, after submission, and after verified inclusion. */
export async function resumeDeployment(signer, plan, journal = /** @type {{planHash?: string, startBlock?: number, steps?: Record<string, any>, complete?: boolean}} */ ({}), persist = async (_journal) => {}) {
  if (plan.version !== 5) throw new Error('Unsupported deployment plan version; prepare a new plan for this build');
  const provider = signer.provider;
  if(String((await provider.getNetwork()).chainId) !== plan.chainId || (await provider.getBlock(0)).hash !== plan.genesisHash) throw new Error('Wrong chain');
  if((await signer.getAddress()).toLowerCase() !== plan.deployer.toLowerCase()) throw new Error('Wrong deployer');
  const digest = planHash(plan);
  if(journal.planHash && journal.planHash !== digest) throw new Error('Journal belongs to another plan');
  journal.planHash = digest;
  journal.startBlock ??= await provider.getBlockNumber();
  journal.steps ??= {};
  await persist(journal);
  for(const step of plan.steps) {
    const entry = journal.steps[step.name] ??= {};
    const existing = await provider.getCode(step.address);
    if(existing !== '0x') {
      entry.hash ??= await findCreation(provider,plan,step,journal.startBlock);
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
