# Ivy Vaults

Single-use option vaults for Ivy. LPs deposit collateral, an off-chain auction picks a market maker,
the market maker's signed bid is activated on-chain, and the vault settles by physical delivery or cash.

- `contracts/IvyVaultsHub.sol` — UUPS-upgradeable hub: factory, rules, ERC-1155 share ledger, roles.
- `contracts/IvyVault.sol` — minimal clone per vault; only moves tokens on the hub's instruction.
- `contracts/IvyShares.sol` — ERC-1155 LP share token owned by the hub (token id = vault id); minted/burned only by the hub.
- `contracts/interfaces/IIvyPriceFeed.sol` — price feed interface (implementation lands later).
- Design: `docs/superpowers/specs/2026-09-03-ivy-vaults-design.md`.

## Commands

    npm install
    npx hardhat compile
    npx hardhat test
    npx hardhat ignition deploy ignition/modules/IvyVaults.ts --network hardhatMainnet

Users approve the **vault** address, never the hub. Shares are ERC-1155 tokens on `IvyShares` whose id is the vault id.
