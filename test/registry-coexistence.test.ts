import { expect } from 'chai';
import { id } from 'ethers';
import { network } from 'hardhat';
import { deployIvy, Phase, USDC_UNIT, WETH_UNIT } from './helpers/setup.js';
import { goLive } from './helpers/scenarios.js';

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe('immutable releases coexist', function () {
  it('settles and pays old positions after recommending another Hub with the same local vault ID', async function () {
    const first = await deployIvy(connection, { enableCashSettlement: false });
    const oldPosition = await goLive(first);
    const secondDeployment = await deployIvy(connection, { enableCashSettlement: false });
    // Use the same assets and LP wallet on both releases: only the deployment
    // identity distinguishes ownership, collateral and claims for vault ID 1.
    const second = {
      ...secondDeployment,
      weth: first.weth, wethAddress: first.wethAddress,
      usdc: first.usdc, usdcAddress: first.usdcAddress,
    };
    const newPosition = await goLive(second);
    expect(oldPosition.vaultId).eq(1n);
    expect(newPosition.vaultId).eq(1n);
    expect(oldPosition.vaultAddress).not.eq(newPosition.vaultAddress);

    const registry = await ethers.deployContract('IvyVaultsRegistry', [first.carol.address]);
    const curator = registry.connect(first.carol);
    await curator.registerVersion(1, first.hubAddress, id('first deployment evidence'));
    await curator.setRecommendedVersion(1);
    const originalTerms = await first.hub.termsOf(1);
    const originalState = await first.hub.stateOf(1);
    await curator.registerVersion(2, second.hubAddress, id('second deployment evidence'));
    await curator.setRecommendedVersion(2);

    expect(await registry.hubOf(1)).eq(first.hubAddress);
    expect(await registry.hubOf(2)).eq(second.hubAddress);
    expect(await first.hub.termsOf(1)).deep.eq(originalTerms);
    expect(await first.hub.stateOf(1)).deep.eq(originalState);
    expect(await oldPosition.vault.hub()).eq(first.hubAddress);
    expect(await newPosition.vault.hub()).eq(second.hubAddress);
    expect(await first.hub.shareToken()).eq(first.sharesAddress);
    expect(await second.hub.shareToken()).eq(second.sharesAddress);
    expect(await first.hub.paused()).eq(false);
    expect(await second.hub.paused()).eq(false);
    expect(await first.hub.hasRole(await first.hub.DEFAULT_ADMIN_ROLE(), await registry.getAddress())).eq(false);
    expect(await first.hub.hasRole(await first.hub.DEFAULT_ADMIN_ROLE(), first.carol.address)).eq(false);

    await expect(first.hub.connect(first.marketMaker).exercise(1, 4n * WETH_UNIT))
      .to.changeTokenBalances(ethers, first.weth, [first.marketMaker, oldPosition.vaultAddress], [4n * WETH_UNIT, -4n * WETH_UNIT]);
    expect(await first.usdc.balanceOf(oldPosition.vaultAddress)).eq(13_000n * USDC_UNIT);
    expect(await first.weth.balanceOf(newPosition.vaultAddress)).eq(10n * WETH_UNIT);
    expect(await first.usdc.balanceOf(newPosition.vaultAddress)).eq(1_000n * USDC_UNIT);
    expect(await second.hub.remainingNotional(1)).eq(10n * WETH_UNIT);

    await networkHelpers.time.increaseTo(await first.hub.expirationTimeOf(1));
    await first.hub.connect(first.bob).expire(1);
    const claim = first.hub.connect(first.alice).claim(1, 10n * WETH_UNIT);
    await expect(claim).to.changeTokenBalances(ethers, first.weth, [first.alice, oldPosition.vaultAddress], [6n * WETH_UNIT, -6n * WETH_UNIT]);
    await expect(claim).to.changeTokenBalances(ethers, first.usdc, [first.alice, oldPosition.vaultAddress], [12_000n * USDC_UNIT, -12_000n * USDC_UNIT]);
    await expect(first.hub.connect(first.alice).claimPremium(1))
      .to.changeTokenBalances(ethers, first.usdc, [first.alice, oldPosition.vaultAddress], [1_000n * USDC_UNIT, -1_000n * USDC_UNIT]);
    expect(await first.shares.balanceOf(first.alice.address, 1)).eq(0n);
    expect(await second.shares.balanceOf(first.alice.address, 1)).eq(10n * WETH_UNIT);
    expect((await second.hub.stateOf(1)).phase).eq(Phase.Live);

    await networkHelpers.time.increaseTo(await second.hub.expirationTimeOf(1));
    await second.hub.connect(second.bob).expire(1);
    await expect(second.hub.connect(second.alice).claim(1, 10n * WETH_UNIT))
      .to.changeTokenBalances(ethers, second.weth, [second.alice, newPosition.vaultAddress], [10n * WETH_UNIT, -10n * WETH_UNIT]);
    await second.hub.connect(second.alice).claimPremium(1);
    expect(await first.usdc.balanceOf(oldPosition.vaultAddress)).eq(0n);
    expect(await first.usdc.balanceOf(newPosition.vaultAddress)).eq(0n);
    expect(await first.hub.totalShares(1)).eq(0n);
    expect(await second.hub.totalShares(1)).eq(0n);
  });
});
