import { rejects, throws } from 'node:assert/strict';
import { expect } from 'chai';
import { network } from 'hardhat';
import { AbiCoder, id } from 'ethers';
import { loadArtifacts } from '../scripts/operator.mjs';
import { buildDeploymentPlan, resumeDeployment, verifyBindings, linkBytecode, LIBRARIES } from '../scripts/deployment.mjs';

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe('fixed linked libraries', function () {
  async function fixture() {
    const [admin] = await ethers.getSigners();
    const artifacts = await loadArtifacts();
    const plan = await buildDeploymentPlan({ artifacts, chainId: (await admin.provider!.getNetwork()).chainId,
      genesisHash: (await admin.provider!.getBlock(0))!.hash, deployer: admin.address,
      startNonce: await admin.getNonce(), admin: admin.address, exerciseWindow: 3600, expiryPricePublicationWindow: 3600, reportSigner: admin.address, settlementMethodology: "synthetic local test observations" });
    const journal = await resumeDeployment(admin, plan);
    return { admin, artifacts, plan, journal };
  }
  it('deploys both libraries first and verifies every embedded hub link', async function () {
    const { admin, plan } = await networkHelpers.loadFixture(fixture);
    expect(plan.steps.slice(0, 2).map(s => s.name)).deep.eq(LIBRARIES);
    const hub = plan.steps.find(s => s.name === 'IvyVaultsHub')!;
    expect(new Set(hub.libraryLinks.map(l => l.name))).deep.eq(new Set(LIBRARIES));
    const code = await admin.provider!.getCode(hub.address);
    for (const link of hub.libraryLinks) {
      expect('0x' + code.slice(2 + link.start * 2, 2 + (link.start + link.length) * 2)).eq(link.address.toLowerCase());
    }
    await verifyBindings(admin.provider, plan);
    expect(hub.deployedSize).at.most(24_576);
  });
  it('rejects unresolved or unsupported compiler link references', async function () {
    const { artifacts, plan } = await networkHelpers.loadFixture(fixture);
    throws(() => linkBytecode(artifacts.IvyVaultsHub, {}), /Unknown library/);
    throws(() => linkBytecode({ bytecode: '0x__$unresolved$__', linkReferences: {} }, {}), /Unresolved bytecode/);
    throws(() => linkBytecode({ bytecode: '0x00', linkReferences: { source: { IvyVaultRules: [{ start: 0, length: 19 }] } } }, plan.addresses), /Invalid link length/);
  });
  it('detects runtime link tampering even when getters still match', async function () {
    const { admin, plan } = await networkHelpers.loadFixture(fixture);
    const hub = plan.steps.find(s => s.name === 'IvyVaultsHub')!;
    const link = hub.libraryLinks[0];
    const code = await admin.provider!.getCode(hub.address);
    const offset = 2 + link.start * 2;
    const tampered = code.slice(0, offset) + admin.address.slice(2) + code.slice(offset + 40);
    await ethers.provider.send('hardhat_setCode', [hub.address, tampered]);
    await rejects(verifyBindings(admin.provider, plan), /Library binding mismatch/);
  });
  it('refuses missing library code and changed library runtime during recovery', async function () {
    const { admin, plan, journal } = await networkHelpers.loadFixture(fixture);
    const address = plan.addresses.IvyOptionSettlement;
    const code = await admin.provider!.getCode(address);
    await ethers.provider.send('hardhat_setCode', [address, '0x']);
    await rejects(verifyBindings(admin.provider, plan), /Library code missing/);
    const last = code.endsWith('00') ? '01' : '00';
    await ethers.provider.send('hardhat_setCode', [address, code.slice(0, -2) + last]);
    await rejects(resumeDeployment(admin, plan, journal), /Runtime hash changed/);
  });
  it('does not expose direct state-changing library calls', async function () {
    const { admin, plan } = await networkHelpers.loadFixture(fixture);
    const coder = AbiCoder.defaultAbiCoder();
    // Solidity library selectors use named storage types. These bodies would succeed on zeroed
    // storage without the compiler's direct-call guard, so their rejection tests that guard.
    const expire = id('expire(VaultState storage,VaultTerms storage,SettlementPrices storage,uint256)').slice(0, 10) + coder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [0, 1, 2, 1]).slice(2);
    for (const [to, data] of [[plan.addresses.IvyOptionSettlement, expire]]) {
      await rejects(admin.provider!.call({ from: admin.address, to, data }), (error: any) => error.data === '0x');
    }
  });
  it('deploys the shipped validator as its own step', async function () {
    const { admin, plan } = await networkHelpers.loadFixture(fixture);
    const step = plan.steps.find(s => s.name === 'IvyBidRules')!;
    expect(step.libraryLinks).deep.equal([]);
    expect((await admin.provider!.getCode(step.address)).length).greaterThan(2);
  });
});
