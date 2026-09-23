import { Contract, getAddress, keccak256 } from 'ethers';
import { CONTRACTS, buildDeploymentPlan, json, planHash, verifyCreation, verifyBindings } from './deployment.mjs';

export const REGISTRY_ABI = [
  'function hubOf(uint256) view returns(address)',
  'function manifestHashOf(uint256) view returns(bytes32)',
  'function recommendedVersion() view returns(uint256)',
  'function registerVersion(uint256,address,bytes32)',
  'function setRecommendedVersion(uint256)',
  'function hasRole(bytes32,address) view returns(bool)',
];
export const RELEASE_FORMAT = 'ivy-vaults-v4';

/** JSON bundle commitment includes preserved interfaces, constructor evidence and runtime hashes. */
export const releaseHash = bundle => planHash(bundle);

/** Read-only verifier. The caller supplies its supported ABI adapter, never one asserted by a manifest. */
export async function verifyRelease(provider, bundle, supportedArtifacts) {
  if (bundle.format !== 1 || bundle.interfaceFormat !== RELEASE_FORMAT || bundle.manifest?.version !== 7) throw new Error('Unsupported release format; historical releases require their preserved operator build');
  const { manifest, journal, artifacts } = bundle;
  if (!manifest.addresses?.IvyBidRules || !manifest.steps?.some(s => s.name === 'IvyBidRules')) throw new Error('Release manifest lacks IvyBidRules');
  if (String((await provider.getNetwork()).chainId) !== manifest.chainId || (await provider.getBlock(0)).hash !== manifest.genesisHash) throw new Error('Wrong chain');
  for (const name of CONTRACTS) {
    if (!artifacts?.[name] || !supportedArtifacts?.[name] || json(artifacts[name].abi) !== json(supportedArtifacts[name].abi)) throw new Error(`Unsupported release interface: ${name}`);
  }
  const rebuilt = await buildDeploymentPlan({ ...manifest, artifacts });
  if (json(rebuilt) !== json(manifest)) throw new Error('Release manifest does not match saved artifacts');
  if (journal?.planHash !== planHash(manifest)) throw new Error('Release journal does not match manifest');
  for (const step of manifest.steps) {
    const entry = journal.steps?.[step.name];
    if (!entry?.hash) throw new Error(`Missing creation evidence: ${step.name}`);
    const hash = await verifyCreation(provider, manifest, step, entry.hash);
    const receipt = await provider.getTransactionReceipt(entry.hash);
    const historical = await provider.getCode(step.address, receipt.blockNumber);
    if (keccak256(historical) !== hash || entry.runtimeHash !== hash) throw new Error(`Runtime history mismatch: ${step.name}`);
  }
  await verifyBindings(provider, manifest, { requireInitialAdmin: false });
  for (const [contractName, name, version] of [['IvyVaultsHub','IvyVaultsHub','3'],['IvyUnwind','IvyUnwind','1'],['IvyPriceFeed','IvyPriceFeed','1']]) {
    const address=manifest.addresses[contractName];
    const contract=new Contract(address,['function eip712Domain() view returns(bytes1,string,string,uint256,address,bytes32,uint256[])'],provider);
    const domain=await contract.eip712Domain();
    if(domain[0]!=='0x0f'||domain[1]!==name||domain[2]!==version||String(domain[3])!==manifest.chainId||getAddress(domain[4])!==getAddress(address)||domain[6].length!==0) throw new Error(`Unsupported signing domain: ${contractName}`);
  }
  return { hub: getAddress(manifest.addresses.IvyVaultsHub), addresses: manifest.addresses, chainId: manifest.chainId, artifacts, manifestHash: releaseHash(bundle) };
}

/** Resolve once. Existing-position callers must pass releaseId, never a moving recommendation. */
export async function resolveRelease(provider, request, supportedArtifacts, { allowRecommended = false } = {}) {
  const registry = new Contract(request.registry, REGISTRY_ABI, provider);
  let releaseId = request.releaseId;
  if (releaseId === undefined) {
    if (!allowRecommended) throw new Error('Explicit releaseId required for existing positions');
    releaseId = await registry.recommendedVersion();
    if (BigInt(releaseId) === 0n) throw new Error('No recommended release');
  }
  const hub = getAddress(await registry.hubOf(releaseId));
  if (request.hub && getAddress(request.hub) !== hub) throw new Error('Hub and release mismatch');
  const bundle = request.releaseBundle;
  if (!bundle) throw new Error('Missing releaseBundle');
  if (await registry.manifestHashOf(releaseId) !== releaseHash(bundle)) throw new Error('Registered manifest hash mismatch');
  const verified = await verifyRelease(provider, bundle, supportedArtifacts);
  if (verified.hub !== hub) throw new Error('Release bundle Hub mismatch');
  return { ...verified, registry: getAddress(request.registry), releaseId: String(releaseId) };
}
