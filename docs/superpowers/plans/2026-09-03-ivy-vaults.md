# Ivy Vaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `IvyVaultsHub` (UUPS-upgradeable, ERC-1155 share ledger, all option logic) plus minimal `IvyVault` clones, with a complete TypeScript test suite, in a fresh Hardhat 3 project.

**Architecture:** One proxied hub owns every rule and the share ledger; each vault is an EIP-1167 clone that only pulls/pushes tokens on the hub's instruction. The hub is an inheritance chain of focused abstract contracts (storage → lifecycle → activation → settlement) topped by a thin concrete contract holding `initialize`, admin setters and upgrade authorization. Pure math and EIP-712 hashing live in libraries with tiny test harnesses.

**Tech Stack:** Hardhat 3.15 (`hardhat-toolbox-mocha-ethers`, TypeScript, ESM), Solidity 0.8.34 (optimizer + viaIR), OpenZeppelin Contracts and Contracts-Upgradeable 5.6.x, ethers v6, chai 6, mocha 11.

**Spec:** `docs/superpowers/specs/2026-09-03-ivy-vaults-design.md` — read it first; every task below cites the section it implements.

## Global Constraints

- Versions: `hardhat ^3.15.0`, `@nomicfoundation/hardhat-toolbox-mocha-ethers ^3.0.7`, `@openzeppelin/contracts ^5.6.1`, `@openzeppelin/contracts-upgradeable ^5.6.1`, Solidity `0.8.34`, Node 24.
- Solidity settings in every profile: `optimizer { enabled: true, runs: 200 }`, `viaIR: true`.
- `package.json` has `"type": "module"`. Test files are ESM TypeScript; each starts with `const { ethers, networkHelpers } = await network.create();`. Relative imports between test files use the `.js` extension (tsx resolves it to `.ts`).
- OpenZeppelin 5.6 layout: `UUPSUpgradeable`, `Initializable`, `ReentrancyGuardTransient`, `Clones`, `SafeERC20`, `SignatureChecker`, `Math`, `ERC1967Proxy` come from `@openzeppelin/contracts/...`; `AccessControlUpgradeable`, `ERC1155Upgradeable`, `ERC1155SupplyUpgradeable`, `EIP712Upgradeable` come from `@openzeppelin/contracts-upgradeable/...`. There is no `ReentrancyGuardUpgradeable` in 5.6.
- Users approve the **vault** address, never the hub. The hub never holds tokens.
- Units: 1 share = 1 smallest unit of collateral. Strike = quote-token units per 1 whole underlying. Premium = premium-token units per 1 whole underlying. `underlyingUnit = 10 ** underlying.decimals()`.
- Rounding always favours LPs: market maker pays `ceil`, receives `floor`.
- Custom errors only (no revert strings), all declared file-level in `contracts/types/IvyTypes.sol`.
- Every token-moving hub entry point is `nonReentrant`; effects before interactions.
- Vault ids are 1-based and equal the ERC-1155 token id.
- Test hub settings: `exerciseWindow = 21600`, `auctionTimeout = 259200`, `settlementGracePeriod = 604800`.
- Every commit must leave `npx hardhat test` green. Never commit with failing tests.
- Timestamp boundaries: tests use `at(ctx, ts)` (`time.setNextBlockTimestamp`) to land a transaction on an exact second. If a boundary test flakes because gas estimation ran against a different pending timestamp, replace that `at(ctx, ts)` with `networkHelpers.time.increaseTo(ts - 1n)` for the success case and `increaseTo(ts)` for the failure case, keeping the assertions unchanged.
- `ERC1155SupplyUpgradeable` overloads `totalSupply`; from TypeScript always use the hub's `totalShares(vaultId)` view instead.

## File Structure

```
package.json, hardhat.config.ts, tsconfig.json, .gitignore, README.md
contracts/
  types/IvyTypes.sol                 enums, structs, custom errors (shared by everything)
  interfaces/IIvyPriceFeed.sol       spot(underlying, quote) → (price, updatedAt)
  interfaces/IIvyVault.sol           initialize / deposit / pull / push
  interfaces/IIvyVaultsHubEvents.sol every hub event
  interfaces/IIvyVaultsHub.sol       events + onVaultDeposit (what a vault calls)
  libraries/IvyMath.sol              pure notional / premium / settlement math
  libraries/BidHash.sol              EIP-712 typehash + struct hash for Bid
  IvyVault.sol                       minimal clone: token box
  hub/IvyVaultsHubStorage.sol        OZ bases, storage, roles, views, guards, _readSpot
  hub/IvyVaultsLifecycle.sol         createVault, deposits, withdraw, tightening, auction open/cancel
  hub/IvyVaultsActivation.sol        activate (bid verification), cancelBid
  hub/IvyVaultsSettlement.sol        exercise, settle, claim, claimPayout
  IvyVaultsHub.sol                   concrete: initialize, admin setters, _authorizeUpgrade
  mocks/MockERC20.sol                decimals + optional transfer fee
  mocks/MockPriceFeed.sol            settable price, can be made to revert
  mocks/MockHub.sol                  for IvyVault unit tests
  mocks/IvyMathHarness.sol           exposes IvyMath
  mocks/BidHashHarness.sol           exposes BidHash
  mocks/IvyVaultsHubV2.sol           upgrade smoke test target
  mocks/Imports.sol                  pulls ERC1967Proxy into compilation
ignition/modules/IvyVaults.ts        deploys vault impl, hub impl, ERC1967Proxy
test/helpers/setup.ts                deployIvy fixture, constants, term builders, fund()
test/helpers/bids.ts                 BID_TYPES, signBid
test/helpers/scenarios.ts            openVault / makeBid / activate / goLive / setSpot
test/00-scaffold.test.ts … test/12-claims.test.ts   one file per concern
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `hardhat.config.ts`, `tsconfig.json`, `.gitignore`
- Create: `contracts/mocks/MockERC20.sol`, `contracts/mocks/Imports.sol`
- Test: `test/00-scaffold.test.ts`

**Interfaces:**
- Produces: `MockERC20(name, symbol, decimals)` with `mint(to, amount)`, `setFeeBps(bps)`; artifact `ERC1967Proxy` available to `ethers.deployContract`.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "ivy-vaults",
  "private": true,
  "version": "0.1.0",
  "description": "Ivy option vaults: IvyVaultsHub + minimal IvyVault clones",
  "type": "module",
  "scripts": {
    "compile": "hardhat compile",
    "test": "hardhat test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@nomicfoundation/hardhat-ethers": "^4.0.15",
    "@nomicfoundation/hardhat-ignition": "^3.1.8",
    "@nomicfoundation/hardhat-toolbox-mocha-ethers": "^3.0.7",
    "@openzeppelin/contracts": "^5.6.1",
    "@openzeppelin/contracts-upgradeable": "^5.6.1",
    "@types/chai": "^5.2.3",
    "@types/chai-as-promised": "^8.0.1",
    "@types/mocha": ">=10.0.10",
    "@types/node": "^22.8.5",
    "chai": "^6.2.2",
    "ethers": "^6.14.0",
    "hardhat": "^3.15.0",
    "mocha": "^11.0.0",
    "typescript": "~6.0.3"
  }
}
```

- [ ] **Step 2: Write hardhat.config.ts**

```ts
import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

const solcSettings = {
  optimizer: { enabled: true, runs: 200 },
  viaIR: true,
};

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: { version: "0.8.34", settings: solcSettings },
      production: { version: "0.8.34", settings: solcSettings },
    },
  },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
  },
});
```

- [ ] **Step 3: Write tsconfig.json and .gitignore**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "lib": ["es2023"],
    "module": "node20",
    "target": "es2023",
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node", "mocha"],
    "verbatimModuleSyntax": true
  }
}
```

`.gitignore`:
```
/node_modules
/dist
/bundle
/artifacts
/cache
/types
.env
.env.*
!.env.example
/coverage
/.gas-snapshot
/snapshots
/ignition/deployments/chain-31337
```

- [ ] **Step 4: Write the mocks**

`contracts/mocks/MockERC20.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test token with configurable decimals and an optional burn-on-transfer fee.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;
    uint256 public feeBps;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feeBps != 0 && from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}
```

`contracts/mocks/Imports.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

// Pulls third-party contracts into the compilation so their artifacts exist for tests and Ignition.
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
```

- [ ] **Step 5: Install and compile**

Run: `npm install && npx hardhat compile`
Expected: dependencies install, `Compiled N Solidity files successfully`. Both `MockERC20` and `ERC1967Proxy` artifacts exist under `artifacts/`.

- [ ] **Step 6: Write the failing scaffold test**

`test/00-scaffold.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("scaffold", function () {
  it("deploys MockERC20 with custom decimals and mints", async function () {
    const [alice] = await ethers.getSigners();
    const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
    expect(await usdc.decimals()).to.equal(6n);
    await usdc.mint(alice.address, 1_000_000n);
    expect(await usdc.balanceOf(alice.address)).to.equal(1_000_000n);
  });

  it("applies a burn-on-transfer fee when configured", async function () {
    const [alice, bob] = await ethers.getSigners();
    const token = await ethers.deployContract("MockERC20", ["Fee", "FEE", 18]);
    await token.mint(alice.address, 1000n);
    await token.setFeeBps(100n); // 1%
    await token.transfer(bob.address, 1000n);
    expect(await token.balanceOf(bob.address)).to.equal(990n);
    expect(await token.totalSupply()).to.equal(990n);
  });

  it("has the ERC1967Proxy artifact available", async function () {
    const artifact = await ethers.getContractFactory("ERC1967Proxy");
    expect(artifact.interface.deploy.inputs.length).to.equal(2);
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npx hardhat test`
Expected: 3 passing.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json hardhat.config.ts tsconfig.json .gitignore contracts test
git commit -m "chore: scaffold Hardhat 3 project with mocks"
```

---

### Task 2: Shared types, interfaces and IvyMath

Implements spec §3.3, §4.1, §4.2 structs, §5 math.

**Files:**
- Create: `contracts/types/IvyTypes.sol`
- Create: `contracts/interfaces/IIvyPriceFeed.sol`, `contracts/interfaces/IIvyVault.sol`, `contracts/interfaces/IIvyVaultsHubEvents.sol`, `contracts/interfaces/IIvyVaultsHub.sol`
- Create: `contracts/libraries/IvyMath.sol`, `contracts/mocks/IvyMathHarness.sol`, `contracts/mocks/MockPriceFeed.sol`
- Test: `test/01-math.test.ts`

**Interfaces:**
- Produces: every enum/struct/error used by later tasks (copied verbatim below); `IvyMath.notionalOf`, `premiumTotal`, `quoteDueCeil`, `quoteOutFloor`, `callIntrinsic`, `putIntrinsic`, `spotBound`; `MockPriceFeed.set(underlying, quote, price, updatedAt)`, `setRevert(bool)`.

- [ ] **Step 1: Write IvyTypes.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev Shared enums, structs and custom errors for Ivy Vaults.

/// Derived from `collateral == underlying`; never an input.
enum OptionKind { CoveredCall, CashSecuredPut }
enum ExerciseStyle { European, American }
/// European/American values line up with ExerciseStyle so uint8 comparison works.
enum ExercisePolicy { European, American, Either }
enum SettlementType { Physical, Cash }
/// Physical/Cash values line up with SettlementType so uint8 comparison works.
enum SettlementPolicy { Physical, Cash, Either }
enum Phase { Open, Auction, Live, Settled }

struct VaultTerms {
    address underlying;            // token being optioned
    address collateral;            // == underlying for a covered call; a quote token for a cash-secured put
    bool publicDeposits;           // false = only the vault owner may deposit
    ExercisePolicy allowedExercise;
    SettlementPolicy allowedSettlement; // Cash requires priceFeed != 0
    uint64 maxTenor;               // max seconds from activation to expiry, > 0
    uint64 auctionStartsAt;        // 0 = manual only; else anyone may open the auction from this time
    uint256 minCollateral;         // shares required to open the auction
    address priceFeed;             // 0 = no oracle checks
    uint16 maxSpotDeviationBps;    // calls: strike >= spot*(1-bps); puts: strike <= spot*(1+bps)
    uint32 maxPriceAge;            // seconds; > 0 when priceFeed != 0
}

struct PairTerms {
    address premiumToken;          // token the market maker pays premium in
    uint256 strikeLimit;           // calls: min strike (0 = none). puts: max strike (max uint = none, must be > 0)
    uint256 minPremium;            // premiumToken units per 1 whole underlying
    bool enabled;
}

struct PairInput {
    address quoteToken;
    PairTerms terms;
}

struct TightenableTerms {
    ExercisePolicy allowedExercise;
    SettlementPolicy allowedSettlement;
    uint64 maxTenor;
    uint256 minCollateral;
    uint16 maxSpotDeviationBps;
    uint32 maxPriceAge;
}

struct Bid {
    uint256 vaultId;
    address marketMaker;
    address quoteToken;
    uint256 strike;
    uint256 premium;
    ExerciseStyle style;
    SettlementType settlement;
    uint64 expiry;                 // absolute unix timestamp
    uint64 validUntil;             // signature deadline
    uint256 nonce;                 // free-form, consumed on activation
}

struct VaultState {
    address vault;
    address owner;
    bool isCall;
    Phase phase;
    uint64 auctionOpenedAt;
    uint256 underlyingUnit;
    // set at activation
    address marketMaker;
    address quoteToken;
    address premiumToken;
    uint256 strike;
    uint256 premium;
    ExerciseStyle style;
    SettlementType settlement;
    uint64 expiry;
    uint256 totalNotional;         // underlying units
    uint256 exercisedNotional;     // underlying units
    uint256 pendingPayout;         // collateral units reserved for the market maker
}

// ---------------------------------------------------------------- errors
error ZeroAddress();
error ZeroAmount();
error UnknownVault();
error WrongPhase(Phase expected, Phase actual);
error NotVaultOwner();
error NotVault();
error NotHub();
error AlreadyInitialized();
error DepositsNotPublic();
error NoPairs();
error DuplicatePair(address quoteToken);
error QuoteIsUnderlying();
error PutRequiresSinglePair();
error PutPairMustBeCollateral();
error PairMustBeEnabled();
error PairUnknown(address quoteToken);
error PairDisabled(address quoteToken);
error InvalidStrikeLimit();
error InvalidTenor();
error CashSettlementNeedsFeed();
error FeedNeedsMaxPriceAge();
error DeviationTooLarge();
error LoosensTerms();
error BelowMinCollateral(uint256 have, uint256 need);
error AuctionNotStartable();
error AuctionTimeoutNotReached();
error BidVaultMismatch();
error NotMarketMaker();
error BidExpired();
error NonceUsed();
error BadSignature();
error StyleNotAllowed();
error SettlementNotAllowed();
error ExpiryInPast();
error TenorTooLong();
error StrikeBelowLimit();
error StrikeAboveLimit();
error StrikeOutsideSpotBand();
error StalePrice();
error InvalidPrice();
error PremiumTooLow();
error EmptyNotional();
error ShortReceived(uint256 expected, uint256 received);
error ExerciseWindowClosed();
error ExerciseNotOpenYet();
error ExerciseNotAvailable();
error ExceedsRemaining(uint256 remaining);
error NothingToExercise();
error SettlementNotReached();
error NothingToClaim();
error InsufficientShares();
```

- [ ] **Step 2: Write the interfaces**

`contracts/interfaces/IIvyPriceFeed.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice Price source a vault owner may attach. Implemented later by Ivy; mocked in tests.
interface IIvyPriceFeed {
    /// @notice Spot price of `underlying` denominated in `quote`,
    ///         expressed in quote-token decimals per 1 whole underlying.
    /// @return price     the price (must be > 0 to be usable)
    /// @return updatedAt unix timestamp of the last update
    function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt);
}
```

`contracts/interfaces/IIvyVault.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

interface IIvyVault {
    function hub() external view returns (address);
    function vaultId() external view returns (uint256);
    function collateral() external view returns (address);

    /// @notice One-time setup, called by the hub right after cloning.
    function initialize(address hub_, uint256 vaultId_, address collateral_) external;

    /// @notice Direct deposit: pulls `amount` of collateral from the caller and notifies the hub.
    function deposit(uint256 amount) external;

    /// @notice Hub only. Pulls `amount` of `token` from `from`; returns the balance delta actually received.
    function pull(address token, address from, uint256 amount) external returns (uint256 received);

    /// @notice Hub only. Sends `amount` of `token` to `to`.
    function push(address token, address to, uint256 amount) external;
}
```

`contracts/interfaces/IIvyVaultsHubEvents.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {OptionKind, ExerciseStyle, SettlementType} from "../types/IvyTypes.sol";

interface IIvyVaultsHubEvents {
    event VaultCreated(uint256 indexed vaultId, address indexed vault, address indexed owner, OptionKind kind, address underlying, address collateral);
    event Deposited(uint256 indexed vaultId, address indexed depositor, uint256 amount);
    event Withdrawn(uint256 indexed vaultId, address indexed holder, uint256 shares);
    event VaultTermsTightened(uint256 indexed vaultId);
    event PairTermsTightened(uint256 indexed vaultId, address indexed quoteToken);
    event AuctionScheduled(uint256 indexed vaultId, uint64 auctionStartsAt);
    event AuctionOpened(uint256 indexed vaultId, uint256 collateral);
    event AuctionCancelled(uint256 indexed vaultId);
    event Activated(
        uint256 indexed vaultId,
        address indexed marketMaker,
        address quoteToken,
        address premiumToken,
        uint256 strike,
        uint256 premium,
        ExerciseStyle style,
        SettlementType settlement,
        uint64 expiry,
        uint256 totalNotional,
        uint256 totalPremium
    );
    event Exercised(uint256 indexed vaultId, uint256 amount, uint256 paidByMarketMaker, uint256 receivedByMarketMaker);
    event Settled(uint256 indexed vaultId, uint256 exercisedNotional, uint256 totalNotional, uint256 pendingPayout);
    event Claimed(uint256 indexed vaultId, address indexed holder, uint256 shares);
    event PayoutClaimed(uint256 indexed vaultId, address indexed marketMaker, uint256 amount);
    event BidCancelled(address indexed marketMaker, uint256 nonce);
    event VaultOwnershipTransferred(uint256 indexed vaultId, address indexed previousOwner, address indexed newOwner);
    event SettingsUpdated(uint64 exerciseWindow, uint64 auctionTimeout, uint64 settlementGracePeriod);
    event VaultImplementationUpdated(address implementation);
}
```

`contracts/interfaces/IIvyVaultsHub.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IIvyVaultsHubEvents} from "./IIvyVaultsHubEvents.sol";

/// @notice The part of the hub a vault talks to.
interface IIvyVaultsHub is IIvyVaultsHubEvents {
    /// @notice Called by a vault after a direct deposit. `amount` is the balance delta the vault received.
    function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external;
}
```

- [ ] **Step 3: Write MockPriceFeed.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IIvyPriceFeed} from "../interfaces/IIvyPriceFeed.sol";

contract MockPriceFeed is IIvyPriceFeed {
    struct Quote { uint256 price; uint256 updatedAt; }

    mapping(address => mapping(address => Quote)) public quotes;
    bool public shouldRevert;

    function set(address underlying, address quote, uint256 price, uint256 updatedAt) external {
        quotes[underlying][quote] = Quote(price, updatedAt);
    }

    function setRevert(bool value) external {
        shouldRevert = value;
    }

    function spot(address underlying, address quote) external view returns (uint256 price, uint256 updatedAt) {
        require(!shouldRevert, "feed down");
        Quote memory q = quotes[underlying][quote];
        return (q.price, q.updatedAt);
    }
}
```

- [ ] **Step 4: Write the failing math test**

`test/01-math.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const UNIT = 10n ** 18n;      // WETH unit
const USDC = 10n ** 6n;
const STRIKE = 3000n * USDC;

describe("IvyMath", function () {
  async function harness() {
    return ethers.deployContract("IvyMathHarness");
  }

  it("call notional equals collateral", async function () {
    const m = await harness();
    expect(await m.notionalOf(true, 10n * UNIT, UNIT, STRIKE)).to.equal(10n * UNIT);
  });

  it("put notional divides collateral by strike, rounding down", async function () {
    const m = await harness();
    expect(await m.notionalOf(false, 30_000n * USDC, UNIT, STRIKE)).to.equal(10n * UNIT);
    expect(await m.notionalOf(false, 30_001n * USDC, UNIT, STRIKE)).to.equal(10_000_333_333_333_333_333n);
  });

  it("premium total floors", async function () {
    const m = await harness();
    expect(await m.premiumTotal(100n * USDC, 10n * UNIT, UNIT)).to.equal(1000n * USDC);
    expect(await m.premiumTotal(1n, 1n, UNIT)).to.equal(0n);
  });

  it("quote due rounds up, quote out rounds down", async function () {
    const m = await harness();
    expect(await m.quoteDueCeil(1n, STRIKE, UNIT)).to.equal(1n);
    expect(await m.quoteOutFloor(1n, STRIKE, UNIT)).to.equal(0n);
    expect(await m.quoteDueCeil(4n * UNIT, STRIKE, UNIT)).to.equal(12_000n * USDC);
    expect(await m.quoteOutFloor(4n * UNIT, STRIKE, UNIT)).to.equal(12_000n * USDC);
  });

  it("call intrinsic is paid in underlying and is zero out of the money", async function () {
    const m = await harness();
    expect(await m.callIntrinsic(4n * UNIT, STRIKE, 3300n * USDC)).to.equal(363_636_363_636_363_636n);
    expect(await m.callIntrinsic(4n * UNIT, STRIKE, STRIKE)).to.equal(0n);
    expect(await m.callIntrinsic(4n * UNIT, STRIKE, 2000n * USDC)).to.equal(0n);
  });

  it("put intrinsic is paid in quote and is zero out of the money", async function () {
    const m = await harness();
    expect(await m.putIntrinsic(4n * UNIT, STRIKE, 2700n * USDC, UNIT)).to.equal(1200n * USDC);
    expect(await m.putIntrinsic(4n * UNIT, STRIKE, STRIKE, UNIT)).to.equal(0n);
    expect(await m.putIntrinsic(4n * UNIT, STRIKE, 4000n * USDC, UNIT)).to.equal(0n);
  });

  it("spot bound flips direction by kind", async function () {
    const m = await harness();
    expect(await m.spotBound(true, STRIKE, 1000)).to.equal(2700n * USDC);
    expect(await m.spotBound(false, STRIKE, 1000)).to.equal(3300n * USDC);
    expect(await m.spotBound(true, STRIKE, 0)).to.equal(STRIKE);
  });
});
```

- [ ] **Step 5: Run the test to see it fail**

Run: `npx hardhat test test/01-math.test.ts`
Expected: compile error or `Artifact for contract "IvyMathHarness" not found`.

- [ ] **Step 6: Write IvyMath.sol and the harness**

`contracts/libraries/IvyMath.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @dev Pure option math. Every rounding favours the LPs.
library IvyMath {
    uint256 internal constant BPS = 10_000;

    /// @dev Underlying units the vault can cover. Calls: the collateral itself. Puts: collateral / strike.
    function notionalOf(bool isCall, uint256 collateralAmount, uint256 underlyingUnit, uint256 strike)
        internal pure returns (uint256)
    {
        if (isCall) return collateralAmount;
        return (collateralAmount * underlyingUnit) / strike;
    }

    /// @dev Total premium for `notional` at `premiumPerUnit` (per 1 whole underlying).
    function premiumTotal(uint256 premiumPerUnit, uint256 notional, uint256 underlyingUnit)
        internal pure returns (uint256)
    {
        return (premiumPerUnit * notional) / underlyingUnit;
    }

    /// @dev Quote the market maker must pay for `amount` underlying at `strike` (rounded up).
    function quoteDueCeil(uint256 amount, uint256 strike, uint256 underlyingUnit) internal pure returns (uint256) {
        return Math.ceilDiv(amount * strike, underlyingUnit);
    }

    /// @dev Quote the market maker receives for `amount` underlying at `strike` (rounded down).
    function quoteOutFloor(uint256 amount, uint256 strike, uint256 underlyingUnit) internal pure returns (uint256) {
        return (amount * strike) / underlyingUnit;
    }

    /// @dev Cash-settled call payout, in underlying. Always < amount.
    function callIntrinsic(uint256 amount, uint256 strike, uint256 spot) internal pure returns (uint256) {
        if (spot <= strike) return 0;
        return (amount * (spot - strike)) / spot;
    }

    /// @dev Cash-settled put payout, in quote. Always below the quote locked for `amount`.
    function putIntrinsic(uint256 amount, uint256 strike, uint256 spot, uint256 underlyingUnit)
        internal pure returns (uint256)
    {
        if (strike <= spot) return 0;
        return (amount * (strike - spot)) / underlyingUnit;
    }

    /// @dev Oracle-relative strike bound. Calls: a floor below spot. Puts: a ceiling above spot.
    function spotBound(bool isCall, uint256 spot, uint16 deviationBps) internal pure returns (uint256) {
        if (isCall) return (spot * (BPS - deviationBps)) / BPS;
        return (spot * (BPS + deviationBps)) / BPS;
    }
}
```

`contracts/mocks/IvyMathHarness.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IvyMath} from "../libraries/IvyMath.sol";

contract IvyMathHarness {
    function notionalOf(bool isCall, uint256 c, uint256 unit, uint256 strike) external pure returns (uint256) {
        return IvyMath.notionalOf(isCall, c, unit, strike);
    }
    function premiumTotal(uint256 p, uint256 n, uint256 unit) external pure returns (uint256) {
        return IvyMath.premiumTotal(p, n, unit);
    }
    function quoteDueCeil(uint256 a, uint256 s, uint256 unit) external pure returns (uint256) {
        return IvyMath.quoteDueCeil(a, s, unit);
    }
    function quoteOutFloor(uint256 a, uint256 s, uint256 unit) external pure returns (uint256) {
        return IvyMath.quoteOutFloor(a, s, unit);
    }
    function callIntrinsic(uint256 a, uint256 s, uint256 spot) external pure returns (uint256) {
        return IvyMath.callIntrinsic(a, s, spot);
    }
    function putIntrinsic(uint256 a, uint256 s, uint256 spot, uint256 unit) external pure returns (uint256) {
        return IvyMath.putIntrinsic(a, s, spot, unit);
    }
    function spotBound(bool isCall, uint256 spot, uint16 bps) external pure returns (uint256) {
        return IvyMath.spotBound(isCall, spot, bps);
    }
}
```

- [ ] **Step 7: Run tests**

Run: `npx hardhat test`
Expected: all passing (3 scaffold + 7 math).

- [ ] **Step 8: Commit**

```bash
git add contracts test
git commit -m "feat: add shared types, interfaces, IvyMath and price feed mock"
```

---

### Task 3: BidHash library and EIP-712 signing helper

Implements spec §7.1.

**Files:**
- Create: `contracts/libraries/BidHash.sol`, `contracts/mocks/BidHashHarness.sol`
- Create: `test/helpers/bids.ts`
- Test: `test/02-bid-hash.test.ts`

**Interfaces:**
- Produces: `BidHash.BID_TYPEHASH`, `BidHash.hash(Bid calldata) → bytes32`; TS `BID_TYPES`, `Bid` type, `signBid(signer, hubAddress, bid) → Promise<string>`.

- [ ] **Step 1: Write the TS helper**

`test/helpers/bids.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing test**

`test/02-bid-hash.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import { TypedDataEncoder, id as keccakOfString } from "ethers";
import { BID_TYPES, type Bid } from "./helpers/bids.js";

const { ethers } = await network.create();

const sample: Bid = {
  vaultId: 7n,
  marketMaker: "0x1111111111111111111111111111111111111111",
  quoteToken: "0x2222222222222222222222222222222222222222",
  strike: 3000n * 10n ** 6n,
  premium: 100n * 10n ** 6n,
  style: 1,
  settlement: 0,
  expiry: 1_800_000_000n,
  validUntil: 1_700_000_000n,
  nonce: 42n,
};

describe("BidHash", function () {
  it("uses the EIP-712 typehash of the Bid struct", async function () {
    const h = await ethers.deployContract("BidHashHarness");
    const encodedType = TypedDataEncoder.from(BID_TYPES).encodeType("Bid");
    expect(await h.typehash()).to.equal(keccakOfString(encodedType));
  });

  it("struct hash matches ethers' TypedDataEncoder", async function () {
    const h = await ethers.deployContract("BidHashHarness");
    expect(await h.hash(sample)).to.equal(TypedDataEncoder.hashStruct("Bid", BID_TYPES, sample));
  });

  it("changing any field changes the hash", async function () {
    const h = await ethers.deployContract("BidHashHarness");
    const base = await h.hash(sample);
    expect(await h.hash({ ...sample, nonce: 43n })).to.not.equal(base);
    expect(await h.hash({ ...sample, style: 0 })).to.not.equal(base);
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npx hardhat test test/02-bid-hash.test.ts`
Expected: fails, `BidHashHarness` artifact not found.

- [ ] **Step 4: Write BidHash.sol and the harness**

`contracts/libraries/BidHash.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Bid} from "../types/IvyTypes.sol";

/// @dev EIP-712 hashing for market-maker bids. Keep the type string in sync with test/helpers/bids.ts.
library BidHash {
    bytes32 internal constant BID_TYPEHASH = keccak256(
        "Bid(uint256 vaultId,address marketMaker,address quoteToken,uint256 strike,uint256 premium,uint8 style,uint8 settlement,uint64 expiry,uint64 validUntil,uint256 nonce)"
    );

    function hash(Bid calldata bid) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                BID_TYPEHASH,
                bid.vaultId,
                bid.marketMaker,
                bid.quoteToken,
                bid.strike,
                bid.premium,
                uint8(bid.style),
                uint8(bid.settlement),
                bid.expiry,
                bid.validUntil,
                bid.nonce
            )
        );
    }
}
```

`contracts/mocks/BidHashHarness.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {BidHash} from "../libraries/BidHash.sol";
import {Bid} from "../types/IvyTypes.sol";

contract BidHashHarness {
    function typehash() external pure returns (bytes32) {
        return BidHash.BID_TYPEHASH;
    }

    function hash(Bid calldata bid) external pure returns (bytes32) {
        return BidHash.hash(bid);
    }
}
```

- [ ] **Step 5: Run tests**

Run: `npx hardhat test`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add contracts test
git commit -m "feat: add BidHash library and EIP-712 signing helper"
```

---

### Task 4: IvyVault

Implements spec §3.2.

**Files:**
- Create: `contracts/IvyVault.sol`, `contracts/mocks/MockHub.sol`
- Test: `test/03-vault.test.ts`

**Interfaces:**
- Consumes: `IIvyVault`, `IIvyVaultsHub.onVaultDeposit`, errors `NotHub`, `AlreadyInitialized`, `ZeroAddress`.
- Produces: `IvyVault` implementation whose clones the hub creates; `MockHub.createClone(impl, id, collateral)`, `MockHub.lastClone()`.

- [ ] **Step 1: Write MockHub.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";

/// @dev Stand-in hub for IvyVault unit tests: clones vaults and records deposit callbacks.
contract MockHub {
    address public lastClone;
    uint256 public lastVaultId;
    address public lastDepositor;
    uint256 public lastAmount;
    uint256 public calls;

    function createClone(address implementation, uint256 id, address collateral) external returns (address clone) {
        clone = Clones.clone(implementation);
        IIvyVault(clone).initialize(address(this), id, collateral);
        lastClone = clone;
    }

    function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external {
        lastVaultId = vaultId;
        lastDepositor = depositor;
        lastAmount = amount;
        calls++;
    }

    function pull(address vault, address token, address from, uint256 amount) external returns (uint256) {
        return IIvyVault(vault).pull(token, from, amount);
    }

    function push(address vault, address token, address to, uint256 amount) external {
        IIvyVault(vault).push(token, to, amount);
    }
}
```

- [ ] **Step 2: Write the failing test**

`test/03-vault.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const UNIT = 10n ** 18n;

describe("IvyVault", function () {
  async function fixture() {
    const [, alice, stranger] = await ethers.getSigners();
    const token = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
    const tokenAddress = await token.getAddress();
    const impl = await ethers.deployContract("IvyVault");
    const mockHub = await ethers.deployContract("MockHub");
    const mockHubAddress = await mockHub.getAddress();
    await (await mockHub.createClone(await impl.getAddress(), 1n, tokenAddress)).wait();
    const vaultAddress = await mockHub.lastClone();
    const vault = await ethers.getContractAt("IvyVault", vaultAddress);
    return { alice, stranger, token, tokenAddress, impl, mockHub, mockHubAddress, vault, vaultAddress };
  }

  it("locks the implementation so it cannot be initialized", async function () {
    const { impl, mockHubAddress, tokenAddress } = await networkHelpers.loadFixture(fixture);
    await expect(impl.initialize(mockHubAddress, 1n, tokenAddress)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
  });

  it("initializes a clone exactly once", async function () {
    const { vault, mockHubAddress, tokenAddress } = await networkHelpers.loadFixture(fixture);
    expect(await vault.hub()).to.equal(mockHubAddress);
    expect(await vault.vaultId()).to.equal(1n);
    expect(await vault.collateral()).to.equal(tokenAddress);
    await expect(vault.initialize(mockHubAddress, 2n, tokenAddress)).to.be.revertedWithCustomError(vault, "AlreadyInitialized");
  });

  it("direct deposit pulls collateral and notifies the hub with the received amount", async function () {
    const { vault, vaultAddress, token, alice, mockHub } = await networkHelpers.loadFixture(fixture);
    await token.mint(alice.address, 5n * UNIT);
    await token.connect(alice).approve(vaultAddress, 5n * UNIT);
    await vault.connect(alice).deposit(5n * UNIT);
    expect(await token.balanceOf(vaultAddress)).to.equal(5n * UNIT);
    expect(await mockHub.lastVaultId()).to.equal(1n);
    expect(await mockHub.lastDepositor()).to.equal(alice.address);
    expect(await mockHub.lastAmount()).to.equal(5n * UNIT);
    expect(await mockHub.calls()).to.equal(1n);
  });

  it("reports the balance delta for fee-on-transfer tokens", async function () {
    const { vault, vaultAddress, token, alice, mockHub } = await networkHelpers.loadFixture(fixture);
    await token.mint(alice.address, 1000n);
    await token.connect(alice).approve(vaultAddress, 1000n);
    await token.setFeeBps(100n);
    await vault.connect(alice).deposit(1000n);
    expect(await mockHub.lastAmount()).to.equal(990n);
  });

  it("pull and push are hub-only", async function () {
    const { vault, tokenAddress, alice, stranger } = await networkHelpers.loadFixture(fixture);
    await expect(vault.connect(stranger).pull(tokenAddress, alice.address, 1n)).to.be.revertedWithCustomError(vault, "NotHub");
    await expect(vault.connect(stranger).push(tokenAddress, stranger.address, 1n)).to.be.revertedWithCustomError(vault, "NotHub");
  });

  it("the hub can pull and push", async function () {
    const { vault, vaultAddress, token, tokenAddress, alice, stranger, mockHub } = await networkHelpers.loadFixture(fixture);
    await token.mint(alice.address, 2n * UNIT);
    await token.connect(alice).approve(vaultAddress, 2n * UNIT);
    await mockHub.pull(vaultAddress, tokenAddress, alice.address, 2n * UNIT);
    expect(await token.balanceOf(vaultAddress)).to.equal(2n * UNIT);
    await mockHub.push(vaultAddress, tokenAddress, stranger.address, UNIT);
    expect(await token.balanceOf(stranger.address)).to.equal(UNIT);
    expect(await token.balanceOf(vaultAddress)).to.equal(UNIT);
    void vault;
  });

  it("rejects native ether", async function () {
    const { vaultAddress, alice } = await networkHelpers.loadFixture(fixture);
    await expect(alice.sendTransaction({ to: vaultAddress, value: 1n })).to.be.reverted;
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npx hardhat test test/03-vault.test.ts`
Expected: fails, `IvyVault` artifact not found.

- [ ] **Step 4: Write IvyVault.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIvyVault} from "./interfaces/IIvyVault.sol";
import {IIvyVaultsHub} from "./interfaces/IIvyVaultsHub.sol";
import {NotHub, AlreadyInitialized, ZeroAddress} from "./types/IvyTypes.sol";

/// @title IvyVault
/// @notice A logic-free token box. Cloned per vault by IvyVaultsHub; moves tokens only on the hub's instruction.
///         Users approve this address (never the hub) for deposits, premium and settlement.
contract IvyVault is IIvyVault {
    using SafeERC20 for IERC20;

    address public hub;
    uint256 public vaultId;
    address public collateral;

    modifier onlyHub() {
        if (msg.sender != hub) revert NotHub();
        _;
    }

    /// @dev Locks the implementation itself; clones start with empty storage and can be initialized.
    constructor() {
        hub = address(0xdead);
    }

    function initialize(address hub_, uint256 vaultId_, address collateral_) external {
        if (hub != address(0)) revert AlreadyInitialized();
        if (hub_ == address(0) || collateral_ == address(0)) revert ZeroAddress();
        hub = hub_;
        vaultId = vaultId_;
        collateral = collateral_;
    }

    function deposit(uint256 amount) external {
        uint256 received = _pull(collateral, msg.sender, amount);
        IIvyVaultsHub(hub).onVaultDeposit(vaultId, msg.sender, received);
    }

    function pull(address token, address from, uint256 amount) external onlyHub returns (uint256 received) {
        return _pull(token, from, amount);
    }

    function push(address token, address to, uint256 amount) external onlyHub {
        IERC20(token).safeTransfer(to, amount);
    }

    function _pull(address token, address from, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(from, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
    }
}
```

- [ ] **Step 5: Run tests**

Run: `npx hardhat test`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add contracts test
git commit -m "feat: add IvyVault minimal clone"
```

---

### Task 5: Hub skeleton — storage base, concrete hub, fixture, admin and upgrade tests

Implements spec §3.1, §4.3 storage, §11 roles/settings, upgrade smoke test from §14.

**Files:**
- Create: `contracts/hub/IvyVaultsHubStorage.sol`, `contracts/IvyVaultsHub.sol`, `contracts/mocks/IvyVaultsHubV2.sol`
- Create: `test/helpers/setup.ts`
- Test: `test/04-hub-admin.test.ts`

**Interfaces:**
- Consumes: `IvyTypes.sol`, `IIvyVaultsHubEvents`, `IIvyVault`, `IIvyPriceFeed`.
- Produces (used by every later task):
  - Storage: `vaultImplementation`, `exerciseWindow`, `auctionTimeout`, `settlementGracePeriod`, `vaultCount`, `_terms`, `_state`, `_pairTerms`, `_quoteTokens`, `usedBidNonces`.
  - Views: `termsOf`, `stateOf`, `pairTermsOf`, `quoteTokensOf`, `vaultOf`, `kindOf`, `totalShares`, `remainingNotional`.
  - Guards: `onlyVaultOwner(vaultId)`, `_requireExists(vaultId)`, `_requirePhase(vaultId, Phase)`, `_readSpot(VaultTerms storage, quoteToken) → uint256`.
  - Roles: `BID_MASTER_ROLE`, `MARKET_MAKER_ROLE`, `DEFAULT_ADMIN_ROLE`.
  - TS: `deployIvy(connection)`, `IvyContext`, constants, enum maps, `callTerms/putTerms/callPairs/putPairs`, `createVaultAs`, `fund`.

- [ ] **Step 1: Write IvyVaultsHubStorage.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {ERC1155SupplyUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IIvyVaultsHubEvents} from "../interfaces/IIvyVaultsHubEvents.sol";
import {IIvyPriceFeed} from "../interfaces/IIvyPriceFeed.sol";
import "../types/IvyTypes.sol";

/// @dev Storage layout, roles, settings, views and shared guards for the hub. Append-only storage.
abstract contract IvyVaultsHubStorage is
    IIvyVaultsHubEvents,
    AccessControlUpgradeable,
    ERC1155SupplyUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient
{
    bytes32 public constant BID_MASTER_ROLE = keccak256("BID_MASTER_ROLE");
    bytes32 public constant MARKET_MAKER_ROLE = keccak256("MARKET_MAKER_ROLE");

    address public vaultImplementation;
    uint64 public exerciseWindow;
    uint64 public auctionTimeout;
    uint64 public settlementGracePeriod;
    uint256 public vaultCount;

    mapping(uint256 vaultId => VaultTerms) internal _terms;
    mapping(uint256 vaultId => VaultState) internal _state;
    mapping(uint256 vaultId => mapping(address quoteToken => PairTerms)) internal _pairTerms;
    mapping(uint256 vaultId => address[]) internal _quoteTokens;
    mapping(address marketMaker => mapping(uint256 nonce => bool)) public usedBidNonces;

    uint256[40] private __gap;

    // ------------------------------------------------------------ views

    function termsOf(uint256 vaultId) external view returns (VaultTerms memory) {
        _requireExists(vaultId);
        return _terms[vaultId];
    }

    function stateOf(uint256 vaultId) external view returns (VaultState memory) {
        _requireExists(vaultId);
        return _state[vaultId];
    }

    function pairTermsOf(uint256 vaultId, address quoteToken) external view returns (PairTerms memory) {
        _requireExists(vaultId);
        return _pairTerms[vaultId][quoteToken];
    }

    function quoteTokensOf(uint256 vaultId) external view returns (address[] memory) {
        _requireExists(vaultId);
        return _quoteTokens[vaultId];
    }

    function vaultOf(uint256 vaultId) external view returns (address) {
        _requireExists(vaultId);
        return _state[vaultId].vault;
    }

    function kindOf(uint256 vaultId) external view returns (OptionKind) {
        _requireExists(vaultId);
        return _state[vaultId].isCall ? OptionKind.CoveredCall : OptionKind.CashSecuredPut;
    }

    /// @notice Shares outstanding for a vault (== credited collateral). Use this instead of the overloaded totalSupply.
    function totalShares(uint256 vaultId) public view returns (uint256) {
        return totalSupply(vaultId);
    }

    function remainingNotional(uint256 vaultId) public view returns (uint256) {
        VaultState storage s = _state[vaultId];
        return s.totalNotional - s.exercisedNotional;
    }

    // ------------------------------------------------------------ guards

    modifier onlyVaultOwner(uint256 vaultId) {
        _requireExists(vaultId);
        if (msg.sender != _state[vaultId].owner) revert NotVaultOwner();
        _;
    }

    function _requireExists(uint256 vaultId) internal view {
        if (vaultId == 0 || vaultId > vaultCount) revert UnknownVault();
    }

    function _requirePhase(uint256 vaultId, Phase expected) internal view {
        _requireExists(vaultId);
        Phase actual = _state[vaultId].phase;
        if (actual != expected) revert WrongPhase(expected, actual);
    }

    /// @dev Fresh spot from the vault's feed. Reverts on zero, future-dated or stale prices.
    function _readSpot(VaultTerms storage t, address quoteToken) internal view returns (uint256) {
        (uint256 price, uint256 updatedAt) = IIvyPriceFeed(t.priceFeed).spot(t.underlying, quoteToken);
        if (price == 0 || updatedAt > block.timestamp) revert InvalidPrice();
        if (block.timestamp - updatedAt > t.maxPriceAge) revert StalePrice();
        return price;
    }

    function supportsInterface(bytes4 interfaceId)
        public view virtual override(AccessControlUpgradeable, ERC1155Upgradeable) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
```

- [ ] **Step 2: Write IvyVaultsHub.sol (concrete, skeleton version)**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IvyVaultsHubStorage} from "./hub/IvyVaultsHubStorage.sol";
import "./types/IvyTypes.sol";

/// @title IvyVaultsHub
/// @notice Factory, rule engine and ERC-1155 share ledger for Ivy option vaults. UUPS upgradeable.
contract IvyVaultsHub is IvyVaultsHubStorage {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address vaultImplementation_,
        uint64 exerciseWindow_,
        uint64 auctionTimeout_,
        uint64 settlementGracePeriod_,
        string calldata uri_
    ) external initializer {
        if (admin == address(0) || vaultImplementation_ == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __ERC1155_init(uri_);
        __ERC1155Supply_init();
        __EIP712_init("IvyVaultsHub", "1");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        vaultImplementation = vaultImplementation_;
        exerciseWindow = exerciseWindow_;
        auctionTimeout = auctionTimeout_;
        settlementGracePeriod = settlementGracePeriod_;
        emit VaultImplementationUpdated(vaultImplementation_);
        emit SettingsUpdated(exerciseWindow_, auctionTimeout_, settlementGracePeriod_);
    }

    // ------------------------------------------------------------ admin

    function setSettings(uint64 exerciseWindow_, uint64 auctionTimeout_, uint64 settlementGracePeriod_)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        exerciseWindow = exerciseWindow_;
        auctionTimeout = auctionTimeout_;
        settlementGracePeriod = settlementGracePeriod_;
        emit SettingsUpdated(exerciseWindow_, auctionTimeout_, settlementGracePeriod_);
    }

    function setVaultImplementation(address implementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (implementation == address(0)) revert ZeroAddress();
        vaultImplementation = implementation;
        emit VaultImplementationUpdated(implementation);
    }

    function setURI(string calldata newUri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(newUri);
    }

    function version() external pure virtual returns (string memory) {
        return "1";
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
```

- [ ] **Step 3: Write IvyVaultsHubV2.sol**

`contracts/mocks/IvyVaultsHubV2.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IvyVaultsHub} from "../IvyVaultsHub.sol";

/// @dev Upgrade target for the UUPS smoke test.
contract IvyVaultsHubV2 is IvyVaultsHub {
    function version() external pure override returns (string memory) {
        return "2";
    }
}
```

- [ ] **Step 4: Compile**

Run: `npx hardhat compile`
Expected: success. If you get "Linearization of inheritance graph impossible", reorder the `is` list of `IvyVaultsHubStorage` so that `IIvyVaultsHubEvents` stays first and the OZ bases keep the order shown.

- [ ] **Step 5: Write test/helpers/setup.ts**

```ts
import { ZeroAddress } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import type { network } from "hardhat";

export type Connection = Awaited<ReturnType<typeof network.create>>;

export const EXERCISE_WINDOW = 6n * 3600n;
export const AUCTION_TIMEOUT = 3n * 24n * 3600n;
export const SETTLEMENT_GRACE = 7n * 24n * 3600n;
export const THIRTY_DAYS = 30n * 24n * 3600n;
export const WETH_UNIT = 10n ** 18n;
export const USDC_UNIT = 10n ** 6n;
export const MAX_UINT = (1n << 256n) - 1n;

export const ExerciseStyle = { European: 0, American: 1 } as const;
export const ExercisePolicy = { European: 0, American: 1, Either: 2 } as const;
export const SettlementType = { Physical: 0, Cash: 1 } as const;
export const SettlementPolicy = { Physical: 0, Cash: 1, Either: 2 } as const;
export const Phase = { Open: 0, Auction: 1, Live: 2, Settled: 3 } as const;
export const OptionKind = { CoveredCall: 0, CashSecuredPut: 1 } as const;

export interface VaultTermsInput {
  underlying: string;
  collateral: string;
  publicDeposits: boolean;
  allowedExercise: number;
  allowedSettlement: number;
  maxTenor: bigint;
  auctionStartsAt: bigint;
  minCollateral: bigint;
  priceFeed: string;
  maxSpotDeviationBps: number;
  maxPriceAge: number;
}

export interface PairTermsInput {
  premiumToken: string;
  strikeLimit: bigint;
  minPremium: bigint;
  enabled: boolean;
}

export interface PairInput {
  quoteToken: string;
  terms: PairTermsInput;
}

/** Deploys tokens, feed, vault implementation, hub implementation and the ERC1967 proxy; grants roles. */
export async function deployIvy(connection: Connection) {
  const { ethers, networkHelpers } = connection;
  const [admin, bidMaster, marketMaker, alice, bob, carol] = await ethers.getSigners();

  const weth = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
  const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
  const dai = await ethers.deployContract("MockERC20", ["Dai", "DAI", 18]);
  const feed = await ethers.deployContract("MockPriceFeed");
  const vaultImpl = await ethers.deployContract("IvyVault");
  const hubImpl = await ethers.deployContract("IvyVaultsHub");

  const vaultImplAddress = await vaultImpl.getAddress();
  const initData = hubImpl.interface.encodeFunctionData("initialize", [
    admin.address,
    vaultImplAddress,
    EXERCISE_WINDOW,
    AUCTION_TIMEOUT,
    SETTLEMENT_GRACE,
    "ipfs://ivy/{id}.json",
  ]);
  const proxy = await ethers.deployContract("ERC1967Proxy", [await hubImpl.getAddress(), initData]);
  const hubAddress = await proxy.getAddress();
  const hub = await ethers.getContractAt("IvyVaultsHub", hubAddress);

  await (await hub.grantRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).wait();
  await (await hub.grantRole(await hub.MARKET_MAKER_ROLE(), marketMaker.address)).wait();

  return {
    connection,
    ethers,
    networkHelpers,
    hub,
    hubAddress,
    hubImpl,
    vaultImpl,
    vaultImplAddress,
    weth,
    usdc,
    dai,
    feed,
    wethAddress: await weth.getAddress(),
    usdcAddress: await usdc.getAddress(),
    daiAddress: await dai.getAddress(),
    feedAddress: await feed.getAddress(),
    admin,
    bidMaster,
    marketMaker,
    alice,
    bob,
    carol,
  };
}

export type IvyContext = Awaited<ReturnType<typeof deployIvy>>;

/** Covered call on WETH, quoted in USDC, physical only, no feed. */
export function callTerms(ctx: IvyContext, o: Partial<VaultTermsInput> = {}): VaultTermsInput {
  return {
    underlying: ctx.wethAddress,
    collateral: ctx.wethAddress,
    publicDeposits: true,
    allowedExercise: ExercisePolicy.Either,
    allowedSettlement: SettlementPolicy.Physical,
    maxTenor: THIRTY_DAYS,
    auctionStartsAt: 0n,
    minCollateral: 0n,
    priceFeed: ZeroAddress,
    maxSpotDeviationBps: 0,
    maxPriceAge: 0,
    ...o,
  };
}

/** Cash-secured put on WETH, collateral USDC. */
export function putTerms(ctx: IvyContext, o: Partial<VaultTermsInput> = {}): VaultTermsInput {
  return callTerms(ctx, { collateral: ctx.usdcAddress, ...o });
}

export function callPairs(ctx: IvyContext, o: Partial<PairTermsInput> = {}): PairInput[] {
  return [
    {
      quoteToken: ctx.usdcAddress,
      terms: { premiumToken: ctx.usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true, ...o },
    },
  ];
}

export function putPairs(ctx: IvyContext, o: Partial<PairTermsInput> = {}): PairInput[] {
  return [
    {
      quoteToken: ctx.usdcAddress,
      terms: { premiumToken: ctx.usdcAddress, strikeLimit: MAX_UINT, minPremium: 0n, enabled: true, ...o },
    },
  ];
}

export async function createVaultAs(
  ctx: IvyContext,
  signer: HardhatEthersSigner,
  terms: VaultTermsInput,
  pairs: PairInput[],
) {
  await (await ctx.hub.connect(signer).createVault(terms, pairs)).wait();
  const vaultId = await ctx.hub.vaultCount();
  const vaultAddress = await ctx.hub.vaultOf(vaultId);
  const vault = await ctx.ethers.getContractAt("IvyVault", vaultAddress);
  return { vaultId, vault, vaultAddress };
}

/** Mints `amount` to `holder` and approves `spender` for exactly `amount`. */
export async function fund(
  ctx: IvyContext,
  token: IvyContext["weth"],
  holder: HardhatEthersSigner,
  spender: string,
  amount: bigint,
) {
  void ctx;
  await (await token.mint(holder.address, amount)).wait();
  await (await token.connect(holder).approve(spender, amount)).wait();
}
```

- [ ] **Step 6: Write the failing admin test**

`test/04-hub-admin.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { AUCTION_TIMEOUT, EXERCISE_WINDOW, SETTLEMENT_GRACE, deployIvy } from "./helpers/setup.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

describe("IvyVaultsHub admin", function () {
  const fixture = () => deployIvy(connection);

  it("initializes settings, roles, uri and the EIP-712 domain", async function () {
    const { hub, admin, bidMaster, marketMaker, vaultImplAddress } = await networkHelpers.loadFixture(fixture);
    expect(await hub.exerciseWindow()).to.equal(EXERCISE_WINDOW);
    expect(await hub.auctionTimeout()).to.equal(AUCTION_TIMEOUT);
    expect(await hub.settlementGracePeriod()).to.equal(SETTLEMENT_GRACE);
    expect(await hub.vaultImplementation()).to.equal(vaultImplAddress);
    expect(await hub.vaultCount()).to.equal(0n);
    expect(await hub.hasRole(await hub.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await hub.hasRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).to.equal(true);
    expect(await hub.hasRole(await hub.MARKET_MAKER_ROLE(), marketMaker.address)).to.equal(true);
    expect(await hub.uri(1n)).to.equal("ipfs://ivy/{id}.json");
    expect(await hub.version()).to.equal("1");
    const domain = await hub.eip712Domain();
    expect(domain.name).to.equal("IvyVaultsHub");
    expect(domain.version).to.equal("1");
  });

  it("cannot be initialized twice, and the implementation is locked", async function () {
    const { hub, hubImpl, admin, vaultImplAddress } = await networkHelpers.loadFixture(fixture);
    const args = [admin.address, vaultImplAddress, 1n, 1n, 1n, ""] as const;
    await expect(hub.initialize(...args)).to.be.revertedWithCustomError(hub, "InvalidInitialization");
    await expect(hubImpl.initialize(...args)).to.be.revertedWithCustomError(hubImpl, "InvalidInitialization");
  });

  it("only the admin can change settings, implementation and uri", async function () {
    const { hub, admin, alice } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(alice).setSettings(1n, 2n, 3n)).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await expect(hub.connect(alice).setVaultImplementation(alice.address)).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await expect(hub.connect(alice).setURI("x")).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");

    await expect(hub.connect(admin).setSettings(1n, 2n, 3n)).to.emit(hub, "SettingsUpdated").withArgs(1n, 2n, 3n);
    expect(await hub.exerciseWindow()).to.equal(1n);
    expect(await hub.auctionTimeout()).to.equal(2n);
    expect(await hub.settlementGracePeriod()).to.equal(3n);

    await expect(hub.connect(admin).setVaultImplementation(ZeroAddress)).to.be.revertedWithCustomError(hub, "ZeroAddress");
    await expect(hub.connect(admin).setVaultImplementation(alice.address)).to.emit(hub, "VaultImplementationUpdated").withArgs(alice.address);
    expect(await hub.vaultImplementation()).to.equal(alice.address);

    await hub.connect(admin).setURI("ipfs://new/{id}");
    expect(await hub.uri(5n)).to.equal("ipfs://new/{id}");
  });

  it("admin can upgrade and storage survives", async function () {
    const { hub, admin, alice, bidMaster } = await networkHelpers.loadFixture(fixture);
    const v2 = await ethers.deployContract("IvyVaultsHubV2");
    const v2Address = await v2.getAddress();
    await expect(hub.connect(alice).upgradeToAndCall(v2Address, "0x")).to.be.revertedWithCustomError(hub, "AccessControlUnauthorizedAccount");
    await hub.connect(admin).upgradeToAndCall(v2Address, "0x");
    expect(await hub.version()).to.equal("2");
    expect(await hub.exerciseWindow()).to.equal(EXERCISE_WINDOW);
    expect(await hub.hasRole(await hub.BID_MASTER_ROLE(), bidMaster.address)).to.equal(true);
  });

  it("views reject unknown vault ids", async function () {
    const { hub, usdcAddress } = await networkHelpers.loadFixture(fixture);
    await expect(hub.termsOf(0n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.stateOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.vaultOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.kindOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.quoteTokensOf(1n)).to.be.revertedWithCustomError(hub, "UnknownVault");
    await expect(hub.pairTermsOf(1n, usdcAddress)).to.be.revertedWithCustomError(hub, "UnknownVault");
  });

  it("reports ERC-1155 and AccessControl interface support", async function () {
    const { hub } = await networkHelpers.loadFixture(fixture);
    expect(await hub.supportsInterface("0xd9b67a26")).to.equal(true); // ERC-1155
    expect(await hub.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npx hardhat test`
Expected: all passing. If `eip712Domain()` field access fails, read it positionally: `domain[1]` is the name and `domain[2]` the version.

- [ ] **Step 8: Commit**

```bash
git add contracts test
git commit -m "feat: add IvyVaultsHub skeleton with storage, roles, settings and UUPS upgrade"
```

---

### Task 6: createVault and term validation

Implements spec §4.2 (creation input, derivation of kind, validation).

**Files:**
- Create: `contracts/hub/IvyVaultsLifecycle.sol`
- Modify: `contracts/IvyVaultsHub.sol` (inherit `IvyVaultsLifecycle` instead of `IvyVaultsHubStorage`)
- Test: `test/05-create-vault.test.ts`

**Interfaces:**
- Consumes: storage/guards from Task 5, `IIvyVault.initialize`, `Clones.clone`.
- Produces: `createVault(VaultTerms calldata, PairInput[] calldata) → (uint256 vaultId, address vault)`; `_validateTerms(VaultTerms calldata, PairInput[] calldata)`.

- [ ] **Step 1: Write the failing test**

`test/05-create-vault.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
import {
  OptionKind, Phase, SettlementPolicy, THIRTY_DAYS, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, putPairs, putTerms,
  type IvyContext, type PairInput, type VaultTermsInput,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("createVault", function () {
  const fixture = () => deployIvy(connection);

  it("creates a covered call vault with a derived kind and a working clone", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, wethAddress, usdcAddress, hubAddress } = ctx;
    await expect(hub.connect(alice).createVault(callTerms(ctx), callPairs(ctx)))
      .to.emit(hub, "VaultCreated")
      .withArgs(1n, anyValue, alice.address, OptionKind.CoveredCall, wethAddress, wethAddress);
    expect(await hub.vaultCount()).to.equal(1n);
    expect(await hub.kindOf(1n)).to.equal(OptionKind.CoveredCall);
    const state = await hub.stateOf(1n);
    expect(state.owner).to.equal(alice.address);
    expect(state.phase).to.equal(Phase.Open);
    expect(state.isCall).to.equal(true);
    expect(state.underlyingUnit).to.equal(WETH_UNIT);
    const vault = await ctx.ethers.getContractAt("IvyVault", state.vault);
    expect(await vault.hub()).to.equal(hubAddress);
    expect(await vault.vaultId()).to.equal(1n);
    expect(await vault.collateral()).to.equal(wethAddress);
    expect(await hub.quoteTokensOf(1n)).to.deep.equal([usdcAddress]);
    const pair = await hub.pairTermsOf(1n, usdcAddress);
    expect(pair.premiumToken).to.equal(usdcAddress);
    expect(pair.enabled).to.equal(true);
    expect((await hub.termsOf(1n)).maxTenor).to.equal(THIRTY_DAYS);
  });

  it("creates a cash-secured put vault", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, wethAddress, usdcAddress } = ctx;
    await expect(hub.connect(alice).createVault(putTerms(ctx), putPairs(ctx)))
      .to.emit(hub, "VaultCreated")
      .withArgs(1n, anyValue, alice.address, OptionKind.CashSecuredPut, wethAddress, usdcAddress);
    const state = await hub.stateOf(1n);
    expect(state.isCall).to.equal(false);
    expect(state.underlyingUnit).to.equal(WETH_UNIT);
    expect(await hub.kindOf(1n)).to.equal(OptionKind.CashSecuredPut);
    const vault = await ctx.ethers.getContractAt("IvyVault", state.vault);
    expect(await vault.collateral()).to.equal(usdcAddress);
  });

  it("emits AuctionScheduled when a start time is given", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    await expect(ctx.hub.connect(ctx.alice).createVault(callTerms(ctx, { auctionStartsAt: 1_900_000_000n }), callPairs(ctx)))
      .to.emit(ctx.hub, "AuctionScheduled")
      .withArgs(1n, 1_900_000_000n);
  });

  it("gives every vault its own id and clone", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const a = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    const b = await createVaultAs(ctx, ctx.bob, putTerms(ctx), putPairs(ctx));
    expect(a.vaultId).to.equal(1n);
    expect(b.vaultId).to.equal(2n);
    expect(a.vaultAddress).to.not.equal(b.vaultAddress);
    expect((await ctx.hub.stateOf(2n)).owner).to.equal(ctx.bob.address);
  });

  it("accepts a call vault with several quote tokens", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const pairs: PairInput[] = [
      ...callPairs(ctx),
      { quoteToken: ctx.daiAddress, terms: { premiumToken: ctx.daiAddress, strikeLimit: 0n, minPremium: 0n, enabled: true } },
    ];
    await createVaultAs(ctx, ctx.alice, callTerms(ctx), pairs);
    expect(await ctx.hub.quoteTokensOf(1n)).to.deep.equal([ctx.usdcAddress, ctx.daiAddress]);
  });

  describe("validation", function () {
    type Case = { name: string; error: string; build: (c: IvyContext) => [VaultTermsInput, PairInput[]] };
    const cases: Case[] = [
      { name: "zero underlying", error: "ZeroAddress", build: (c) => [callTerms(c, { underlying: ZeroAddress }), callPairs(c)] },
      { name: "zero collateral", error: "ZeroAddress", build: (c) => [callTerms(c, { collateral: ZeroAddress }), callPairs(c)] },
      { name: "zero maxTenor", error: "InvalidTenor", build: (c) => [callTerms(c, { maxTenor: 0n }), callPairs(c)] },
      { name: "cash allowed without a feed", error: "CashSettlementNeedsFeed", build: (c) => [callTerms(c, { allowedSettlement: SettlementPolicy.Cash }), callPairs(c)] },
      { name: "either settlement without a feed", error: "CashSettlementNeedsFeed", build: (c) => [callTerms(c, { allowedSettlement: SettlementPolicy.Either }), callPairs(c)] },
      { name: "feed without maxPriceAge", error: "FeedNeedsMaxPriceAge", build: (c) => [callTerms(c, { priceFeed: c.feedAddress, maxPriceAge: 0 }), callPairs(c)] },
      { name: "call deviation above 100%", error: "DeviationTooLarge", build: (c) => [callTerms(c, { priceFeed: c.feedAddress, maxPriceAge: 60, maxSpotDeviationBps: 10_001 }), callPairs(c)] },
      { name: "no pairs", error: "NoPairs", build: (c) => [callTerms(c), []] },
      { name: "put with two pairs", error: "PutRequiresSinglePair", build: (c) => [putTerms(c), [...putPairs(c), { quoteToken: c.daiAddress, terms: putPairs(c)[0].terms }]] },
      { name: "put pair that is not the collateral", error: "PutPairMustBeCollateral", build: (c) => [putTerms(c), [{ quoteToken: c.daiAddress, terms: putPairs(c)[0].terms }]] },
      { name: "call quote equal to the underlying", error: "QuoteIsUnderlying", build: (c) => [callTerms(c), [{ quoteToken: c.wethAddress, terms: callPairs(c)[0].terms }]] },
      { name: "disabled pair at creation", error: "PairMustBeEnabled", build: (c) => [callTerms(c), callPairs(c, { enabled: false })] },
      { name: "put strike limit of zero", error: "InvalidStrikeLimit", build: (c) => [putTerms(c), putPairs(c, { strikeLimit: 0n })] },
      { name: "zero premium token", error: "ZeroAddress", build: (c) => [callTerms(c), callPairs(c, { premiumToken: ZeroAddress })] },
      { name: "duplicate quote token", error: "DuplicatePair", build: (c) => [callTerms(c), [...callPairs(c), ...callPairs(c)]] },
    ];

    for (const tc of cases) {
      it(`rejects ${tc.name}`, async function () {
        const ctx = await networkHelpers.loadFixture(fixture);
        const [terms, pairs] = tc.build(ctx);
        await expect(ctx.hub.connect(ctx.alice).createVault(terms, pairs)).to.be.revertedWithCustomError(ctx.hub, tc.error);
      });
    }

    it("allows a put deviation above 100%", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      await createVaultAs(ctx, ctx.alice, putTerms(ctx, { priceFeed: ctx.feedAddress, maxPriceAge: 60, maxSpotDeviationBps: 20_000 }), putPairs(ctx));
      expect(await ctx.hub.vaultCount()).to.equal(1n);
    });
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx hardhat test test/05-create-vault.test.ts`
Expected: fails because `hub.createVault` is not a function.

- [ ] **Step 3: Write IvyVaultsLifecycle.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IvyVaultsHubStorage} from "./IvyVaultsHubStorage.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import "../types/IvyTypes.sol";

/// @dev Vault creation, deposits, withdrawals, owner controls and the auction phase (spec §4.2, §6.1, §6.2, §8).
abstract contract IvyVaultsLifecycle is IvyVaultsHubStorage {
    // ------------------------------------------------------------ creation (spec §4.2)

    /// @notice Create a vault. Kind is derived: `collateral == underlying` is a covered call, anything else a put.
    function createVault(VaultTerms calldata terms, PairInput[] calldata pairs)
        external nonReentrant returns (uint256 vaultId, address vault)
    {
        _validateTerms(terms, pairs);
        bool isCall = terms.collateral == terms.underlying;

        vaultId = ++vaultCount;
        vault = Clones.clone(vaultImplementation);
        IIvyVault(vault).initialize(address(this), vaultId, terms.collateral);

        _terms[vaultId] = terms;
        VaultState storage s = _state[vaultId];
        s.vault = vault;
        s.owner = msg.sender;
        s.isCall = isCall;
        s.phase = Phase.Open;
        s.underlyingUnit = 10 ** IERC20Metadata(terms.underlying).decimals();

        for (uint256 i = 0; i < pairs.length; ++i) {
            _pairTerms[vaultId][pairs[i].quoteToken] = pairs[i].terms;
            _quoteTokens[vaultId].push(pairs[i].quoteToken);
        }

        emit VaultCreated(
            vaultId,
            vault,
            msg.sender,
            isCall ? OptionKind.CoveredCall : OptionKind.CashSecuredPut,
            terms.underlying,
            terms.collateral
        );
        if (terms.auctionStartsAt != 0) emit AuctionScheduled(vaultId, terms.auctionStartsAt);
    }

    function _validateTerms(VaultTerms calldata t, PairInput[] calldata pairs) internal pure {
        if (t.underlying == address(0) || t.collateral == address(0)) revert ZeroAddress();
        if (t.maxTenor == 0) revert InvalidTenor();
        bool isCall = t.collateral == t.underlying;
        if (t.allowedSettlement != SettlementPolicy.Physical && t.priceFeed == address(0)) revert CashSettlementNeedsFeed();
        if (t.priceFeed != address(0)) {
            if (t.maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
            if (isCall && t.maxSpotDeviationBps > 10_000) revert DeviationTooLarge();
        }
        if (pairs.length == 0) revert NoPairs();
        if (!isCall) {
            if (pairs.length != 1) revert PutRequiresSinglePair();
            if (pairs[0].quoteToken != t.collateral) revert PutPairMustBeCollateral();
        }
        for (uint256 i = 0; i < pairs.length; ++i) {
            PairInput calldata p = pairs[i];
            if (p.quoteToken == address(0) || p.terms.premiumToken == address(0)) revert ZeroAddress();
            if (isCall && p.quoteToken == t.underlying) revert QuoteIsUnderlying();
            if (!p.terms.enabled) revert PairMustBeEnabled();
            if (!isCall && p.terms.strikeLimit == 0) revert InvalidStrikeLimit();
            for (uint256 j = 0; j < i; ++j) {
                if (pairs[j].quoteToken == p.quoteToken) revert DuplicatePair(p.quoteToken);
            }
        }
    }
}
```

- [ ] **Step 4: Point the concrete hub at the lifecycle layer**

In `contracts/IvyVaultsHub.sol` replace the import and inheritance:
```solidity
import {IvyVaultsLifecycle} from "./hub/IvyVaultsLifecycle.sol";
import "./types/IvyTypes.sol";

contract IvyVaultsHub is IvyVaultsLifecycle {
```
(Everything else in the file stays as written in Task 5.)

- [ ] **Step 5: Run tests**

Run: `npx hardhat test`
Expected: all passing, including the 15 validation cases.

- [ ] **Step 6: Commit**

```bash
git add contracts test
git commit -m "feat: vault creation with derived option kind and term validation"
```

---

### Task 7: Deposits and withdrawals

Implements spec §6.1 deposits (hub path and direct vault path), withdrawals, and §13 fee-on-transfer handling.

**Files:**
- Modify: `contracts/hub/IvyVaultsLifecycle.sol` (add `IIvyVaultsHub` to the `is` list and the functions below)
- Test: `test/06-deposits.test.ts`

**Interfaces:**
- Produces: `deposit(uint256 vaultId, uint256 amount)`, `onVaultDeposit(uint256, address, uint256)`, `withdraw(uint256 vaultId, uint256 shares)`, internal `_checkDeposit`, `_credit`.

- [ ] **Step 1: Write the failing test**

`test/06-deposits.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import { Phase, WETH_UNIT, callPairs, callTerms, createVaultAs, deployIvy, fund } from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("deposits and withdrawals", function () {
  async function fixture() {
    const ctx = await deployIvy(connection);
    const v = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    return { ...ctx, ...v };
  }

  it("hub deposit pulls collateral into the vault and mints 1:1 shares", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 5n * WETH_UNIT);
    await expect(hub.connect(alice).deposit(vaultId, 5n * WETH_UNIT))
      .to.emit(hub, "Deposited")
      .withArgs(vaultId, alice.address, 5n * WETH_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(5n * WETH_UNIT);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(5n * WETH_UNIT);
    expect(await hub.totalShares(vaultId)).to.equal(5n * WETH_UNIT);
  });

  it("direct vault deposit credits the depositor through onVaultDeposit", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, bob, vault, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, bob, vaultAddress, 2n * WETH_UNIT);
    await expect(vault.connect(bob).deposit(2n * WETH_UNIT))
      .to.emit(hub, "Deposited")
      .withArgs(vaultId, bob.address, 2n * WETH_UNIT);
    expect(await hub.balanceOf(bob.address, vaultId)).to.equal(2n * WETH_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(2n * WETH_UNIT);
  });

  it("credits only what actually arrived for fee-on-transfer collateral", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 1000n);
    await weth.setFeeBps(100n);
    await hub.connect(alice).deposit(vaultId, 1000n);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(990n);
  });

  it("owner-only vaults reject other depositors on both paths", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, bob } = ctx;
    const { vaultId, vault, vaultAddress } = await createVaultAs(ctx, alice, callTerms(ctx, { publicDeposits: false }), callPairs(ctx));
    await fund(ctx, weth, bob, vaultAddress, WETH_UNIT);
    await expect(hub.connect(bob).deposit(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "DepositsNotPublic");
    await expect(vault.connect(bob).deposit(WETH_UNIT)).to.be.revertedWithCustomError(hub, "DepositsNotPublic");
    await fund(ctx, weth, alice, vaultAddress, WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, WETH_UNIT);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(WETH_UNIT);
  });

  it("rejects zero amounts and unknown vaults", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    await expect(ctx.hub.connect(ctx.alice).deposit(ctx.vaultId, 0n)).to.be.revertedWithCustomError(ctx.hub, "ZeroAmount");
    await expect(ctx.hub.connect(ctx.alice).deposit(99n, 1n)).to.be.revertedWithCustomError(ctx.hub, "UnknownVault");
  });

  it("onVaultDeposit rejects callers that are not the vault", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    await expect(ctx.hub.connect(ctx.alice).onVaultDeposit(ctx.vaultId, ctx.alice.address, 1n)).to.be.revertedWithCustomError(ctx.hub, "NotVault");
    await expect(ctx.hub.connect(ctx.alice).onVaultDeposit(99n, ctx.alice.address, 1n)).to.be.revertedWithCustomError(ctx.hub, "NotVault");
  });

  it("withdraw burns shares and returns collateral", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 5n * WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, 5n * WETH_UNIT);
    const tx = hub.connect(alice).withdraw(vaultId, 2n * WETH_UNIT);
    await expect(tx).to.emit(hub, "Withdrawn").withArgs(vaultId, alice.address, 2n * WETH_UNIT);
    await expect(tx).to.changeTokenBalances(weth, [alice, vaultAddress], [2n * WETH_UNIT, -2n * WETH_UNIT]);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(3n * WETH_UNIT);
    await expect(hub.connect(alice).withdraw(vaultId, 0n)).to.be.revertedWithCustomError(hub, "ZeroAmount");
    await expect(hub.connect(alice).withdraw(vaultId, 4n * WETH_UNIT)).to.be.revertedWithCustomError(hub, "ERC1155InsufficientBalance");
  });

  it("transferred shares can be withdrawn by the new holder", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, alice, bob, vaultId, vaultAddress } = ctx;
    await fund(ctx, weth, alice, vaultAddress, 3n * WETH_UNIT);
    await hub.connect(alice).deposit(vaultId, 3n * WETH_UNIT);
    await hub.connect(alice).safeTransferFrom(alice.address, bob.address, vaultId, WETH_UNIT, "0x");
    await expect(hub.connect(bob).withdraw(vaultId, WETH_UNIT)).to.changeTokenBalances(weth, [bob], [WETH_UNIT]);
    expect(await hub.balanceOf(bob.address, vaultId)).to.equal(0n);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Open);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx hardhat test test/06-deposits.test.ts`
Expected: fails, `hub.connect(...).deposit is not a function`.

- [ ] **Step 3: Add the deposit functions to IvyVaultsLifecycle.sol**

Change the header of the contract to:
```solidity
import {IIvyVaultsHub} from "../interfaces/IIvyVaultsHub.sol";

abstract contract IvyVaultsLifecycle is IvyVaultsHubStorage, IIvyVaultsHub {
```
(Keep the other imports.) Then add after `_validateTerms`:

```solidity
    // ------------------------------------------------------------ deposits (spec §6.1)

    /// @notice Deposit through the hub. The caller must have approved the vault address.
    function deposit(uint256 vaultId, uint256 amount) external nonReentrant {
        _checkDeposit(vaultId, msg.sender, amount);
        uint256 received = IIvyVault(_state[vaultId].vault).pull(_terms[vaultId].collateral, msg.sender, amount);
        _credit(vaultId, msg.sender, received);
    }

    /// @inheritdoc IIvyVaultsHub
    function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external nonReentrant {
        if (vaultId == 0 || vaultId > vaultCount || msg.sender != _state[vaultId].vault) revert NotVault();
        _checkDeposit(vaultId, depositor, amount);
        _credit(vaultId, depositor, amount);
    }

    /// @notice Burn shares and take collateral back. Only while the vault is Open.
    function withdraw(uint256 vaultId, uint256 shares) external nonReentrant {
        _requirePhase(vaultId, Phase.Open);
        if (shares == 0) revert ZeroAmount();
        _burn(msg.sender, vaultId, shares);
        IIvyVault(_state[vaultId].vault).push(_terms[vaultId].collateral, msg.sender, shares);
        emit Withdrawn(vaultId, msg.sender, shares);
    }

    function _checkDeposit(uint256 vaultId, address depositor, uint256 amount) internal view {
        _requirePhase(vaultId, Phase.Open);
        if (amount == 0) revert ZeroAmount();
        if (!_terms[vaultId].publicDeposits && depositor != _state[vaultId].owner) revert DepositsNotPublic();
    }

    function _credit(uint256 vaultId, address depositor, uint256 received) internal {
        if (received == 0) revert ZeroAmount();
        _mint(depositor, vaultId, received, "");
        emit Deposited(vaultId, depositor, received);
    }
```

- [ ] **Step 4: Run tests**

Run: `npx hardhat test`
Expected: all passing. If the compiler complains about linearization, change the `is` list to `is IIvyVaultsHub, IvyVaultsHubStorage`.

- [ ] **Step 5: Commit**

```bash
git add contracts test
git commit -m "feat: deposits via hub or vault, withdrawals in Open phase"
```

---

### Task 8: Tightening, scheduling and ownership transfer

Implements spec §8.

**Files:**
- Modify: `contracts/hub/IvyVaultsLifecycle.sol`
- Test: `test/07-tightening.test.ts`

**Interfaces:**
- Produces: `tightenVaultTerms(uint256, TightenableTerms calldata)`, `tightenPairTerms(uint256, address, PairTerms calldata)`, `scheduleAuction(uint256, uint64)`, `transferVaultOwnership(uint256, address)`.

- [ ] **Step 1: Write the failing test**

`test/07-tightening.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import { ZeroAddress } from "ethers";
import {
  ExercisePolicy, SettlementPolicy, THIRTY_DAYS, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, putPairs, putTerms,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

const SEVEN_DAYS = 7n * 24n * 3600n;

describe("tightening", function () {
  async function fixture() {
    const ctx = await deployIvy(connection);
    const call = await createVaultAs(
      ctx,
      ctx.alice,
      callTerms(ctx, {
        priceFeed: ctx.feedAddress,
        maxPriceAge: 3600,
        maxSpotDeviationBps: 1000,
        allowedSettlement: SettlementPolicy.Either,
        allowedExercise: ExercisePolicy.Either,
        minCollateral: WETH_UNIT,
      }),
      callPairs(ctx),
    );
    const put = await createVaultAs(ctx, ctx.alice, putTerms(ctx), putPairs(ctx, { strikeLimit: 3500n * USDC_UNIT }));
    const plain = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    return { ...ctx, callId: call.vaultId, putId: put.vaultId, plainId: plain.vaultId };
  }

  const base = {
    allowedExercise: ExercisePolicy.Either,
    allowedSettlement: SettlementPolicy.Either,
    maxTenor: THIRTY_DAYS,
    minCollateral: WETH_UNIT,
    maxSpotDeviationBps: 1000,
    maxPriceAge: 3600,
  };

  it("accepts every LP-favourable change and an unchanged submission", async function () {
    const { hub, alice, callId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(alice).tightenVaultTerms(callId, base)).to.emit(hub, "VaultTermsTightened").withArgs(callId);
    const tighter = {
      allowedExercise: ExercisePolicy.European,
      allowedSettlement: SettlementPolicy.Physical,
      maxTenor: SEVEN_DAYS,
      minCollateral: 2n * WETH_UNIT,
      maxSpotDeviationBps: 500,
      maxPriceAge: 600,
    };
    await hub.connect(alice).tightenVaultTerms(callId, tighter);
    const t = await hub.termsOf(callId);
    expect(t.allowedExercise).to.equal(ExercisePolicy.European);
    expect(t.allowedSettlement).to.equal(SettlementPolicy.Physical);
    expect(t.maxTenor).to.equal(SEVEN_DAYS);
    expect(t.minCollateral).to.equal(2n * WETH_UNIT);
    expect(t.maxSpotDeviationBps).to.equal(500n);
    expect(t.maxPriceAge).to.equal(600n);
  });

  it("rejects every loosening of vault terms", async function () {
    const { hub, alice, callId } = await networkHelpers.loadFixture(fixture);
    const narrowed = { ...base, allowedExercise: ExercisePolicy.European, allowedSettlement: SettlementPolicy.Physical };
    await hub.connect(alice).tightenVaultTerms(callId, narrowed);
    const attempts: Array<[string, Partial<typeof base>, string]> = [
      ["widening exercise back to Either", { allowedExercise: ExercisePolicy.Either }, "LoosensTerms"],
      ["switching exercise style", { allowedExercise: ExercisePolicy.American }, "LoosensTerms"],
      ["widening settlement back to Either", { allowedSettlement: SettlementPolicy.Either }, "LoosensTerms"],
      ["switching settlement type", { allowedSettlement: SettlementPolicy.Cash }, "LoosensTerms"],
      ["raising maxTenor", { maxTenor: THIRTY_DAYS + 1n }, "LoosensTerms"],
      ["zero maxTenor", { maxTenor: 0n }, "InvalidTenor"],
      ["lowering minCollateral", { minCollateral: WETH_UNIT - 1n }, "LoosensTerms"],
      ["raising spot deviation", { maxSpotDeviationBps: 1001 }, "LoosensTerms"],
      ["raising maxPriceAge", { maxPriceAge: 3601 }, "LoosensTerms"],
      ["zero maxPriceAge", { maxPriceAge: 0 }, "FeedNeedsMaxPriceAge"],
    ];
    for (const [label, patch, error] of attempts) {
      await expect(hub.connect(alice).tightenVaultTerms(callId, { ...narrowed, ...patch }), label).to.be.revertedWithCustomError(hub, error);
    }
  });

  it("ignores oracle fields when the vault has no feed", async function () {
    const { hub, alice, plainId } = await networkHelpers.loadFixture(fixture);
    await hub.connect(alice).tightenVaultTerms(plainId, {
      allowedExercise: ExercisePolicy.Either,
      allowedSettlement: SettlementPolicy.Physical,
      maxTenor: THIRTY_DAYS,
      minCollateral: 0n,
      maxSpotDeviationBps: 5000,
      maxPriceAge: 0,
    });
    const t = await hub.termsOf(plainId);
    expect(t.maxSpotDeviationBps).to.equal(0n);
    expect(t.maxPriceAge).to.equal(0n);
  });

  it("pair terms can raise floors and disable, but never loosen", async function () {
    const { hub, alice, callId, usdcAddress, daiAddress } = await networkHelpers.loadFixture(fixture);
    const pair = (o: Partial<{ premiumToken: string; strikeLimit: bigint; minPremium: bigint; enabled: boolean }>) => ({
      premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true, ...o,
    });
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, pair({ strikeLimit: 3100n * USDC_UNIT, minPremium: 50n * USDC_UNIT })))
      .to.emit(hub, "PairTermsTightened").withArgs(callId, usdcAddress);
    const p = await hub.pairTermsOf(callId, usdcAddress);
    expect(p.strikeLimit).to.equal(3100n * USDC_UNIT);
    expect(p.minPremium).to.equal(50n * USDC_UNIT);

    const current = pair({ strikeLimit: 3100n * USDC_UNIT, minPremium: 50n * USDC_UNIT });
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, strikeLimit: 3000n * USDC_UNIT })).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, minPremium: 40n * USDC_UNIT })).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, premiumToken: daiAddress })).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(callId, daiAddress, current)).to.be.revertedWithCustomError(hub, "PairUnknown").withArgs(daiAddress);

    await hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, enabled: false });
    expect((await hub.pairTermsOf(callId, usdcAddress)).enabled).to.equal(false);
    await expect(hub.connect(alice).tightenPairTerms(callId, usdcAddress, { ...current, enabled: true })).to.be.revertedWithCustomError(hub, "LoosensTerms");
  });

  it("put strike limit may only go down and never to zero", async function () {
    const { hub, alice, putId, usdcAddress } = await networkHelpers.loadFixture(fixture);
    const pair = (strikeLimit: bigint) => ({ premiumToken: usdcAddress, strikeLimit, minPremium: 0n, enabled: true });
    await hub.connect(alice).tightenPairTerms(putId, usdcAddress, pair(3200n * USDC_UNIT));
    await expect(hub.connect(alice).tightenPairTerms(putId, usdcAddress, pair(3300n * USDC_UNIT))).to.be.revertedWithCustomError(hub, "LoosensTerms");
    await expect(hub.connect(alice).tightenPairTerms(putId, usdcAddress, pair(0n))).to.be.revertedWithCustomError(hub, "InvalidStrikeLimit");
  });

  it("only the owner may tighten, schedule or transfer", async function () {
    const { hub, alice, bob, callId, usdcAddress } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(bob).tightenVaultTerms(callId, base)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(bob).tightenPairTerms(callId, usdcAddress, { premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true })).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(bob).scheduleAuction(callId, 1n)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(bob).transferVaultOwnership(callId, bob.address)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await expect(hub.connect(alice).tightenVaultTerms(99n, base)).to.be.revertedWithCustomError(hub, "UnknownVault");
  });

  it("schedules the auction and transfers ownership", async function () {
    const { hub, alice, bob, callId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(alice).scheduleAuction(callId, 1_900_000_000n)).to.emit(hub, "AuctionScheduled").withArgs(callId, 1_900_000_000n);
    expect((await hub.termsOf(callId)).auctionStartsAt).to.equal(1_900_000_000n);

    await expect(hub.connect(alice).transferVaultOwnership(callId, ZeroAddress)).to.be.revertedWithCustomError(hub, "ZeroAddress");
    await expect(hub.connect(alice).transferVaultOwnership(callId, bob.address))
      .to.emit(hub, "VaultOwnershipTransferred").withArgs(callId, alice.address, bob.address);
    expect((await hub.stateOf(callId)).owner).to.equal(bob.address);
    await expect(hub.connect(alice).scheduleAuction(callId, 0n)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await hub.connect(bob).scheduleAuction(callId, 0n);
    expect((await hub.termsOf(callId)).auctionStartsAt).to.equal(0n);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx hardhat test test/07-tightening.test.ts`
Expected: fails, `tightenVaultTerms is not a function`.

- [ ] **Step 3: Add the owner controls to IvyVaultsLifecycle.sol**

Append inside the contract, after `_credit`:

```solidity
    // ------------------------------------------------------------ owner controls (spec §8)

    /// @notice Tighten vault-level terms. Every field must be equal or more LP-favourable than today.
    function tightenVaultTerms(uint256 vaultId, TightenableTerms calldata n) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        VaultTerms storage t = _terms[vaultId];
        if (!(t.allowedExercise == n.allowedExercise || t.allowedExercise == ExercisePolicy.Either)) revert LoosensTerms();
        if (!(t.allowedSettlement == n.allowedSettlement || t.allowedSettlement == SettlementPolicy.Either)) revert LoosensTerms();
        if (n.maxTenor == 0) revert InvalidTenor();
        if (n.maxTenor > t.maxTenor) revert LoosensTerms();
        if (n.minCollateral < t.minCollateral) revert LoosensTerms();
        if (t.priceFeed != address(0)) {
            if (n.maxSpotDeviationBps > t.maxSpotDeviationBps) revert LoosensTerms();
            if (n.maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
            if (n.maxPriceAge > t.maxPriceAge) revert LoosensTerms();
            t.maxSpotDeviationBps = n.maxSpotDeviationBps;
            t.maxPriceAge = n.maxPriceAge;
        }
        t.allowedExercise = n.allowedExercise;
        t.allowedSettlement = n.allowedSettlement;
        t.maxTenor = n.maxTenor;
        t.minCollateral = n.minCollateral;
        emit VaultTermsTightened(vaultId);
    }

    /// @notice Tighten one quote token's terms. Premium token is fixed; a disabled pair stays disabled.
    function tightenPairTerms(uint256 vaultId, address quoteToken, PairTerms calldata n) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        PairTerms storage p = _pairTerms[vaultId][quoteToken];
        if (p.premiumToken == address(0)) revert PairUnknown(quoteToken);
        if (n.premiumToken != p.premiumToken) revert LoosensTerms();
        bool isCall = _state[vaultId].isCall;
        if (isCall ? n.strikeLimit < p.strikeLimit : n.strikeLimit > p.strikeLimit) revert LoosensTerms();
        if (!isCall && n.strikeLimit == 0) revert InvalidStrikeLimit();
        if (n.minPremium < p.minPremium) revert LoosensTerms();
        if (n.enabled && !p.enabled) revert LoosensTerms();
        p.strikeLimit = n.strikeLimit;
        p.minPremium = n.minPremium;
        p.enabled = n.enabled;
        emit PairTermsTightened(vaultId, quoteToken);
    }

    /// @notice Set or clear the time from which anyone may open the auction. Operational, not economic.
    function scheduleAuction(uint256 vaultId, uint64 auctionStartsAt) external onlyVaultOwner(vaultId) {
        _requirePhase(vaultId, Phase.Open);
        _terms[vaultId].auctionStartsAt = auctionStartsAt;
        emit AuctionScheduled(vaultId, auctionStartsAt);
    }

    function transferVaultOwnership(uint256 vaultId, address newOwner) external onlyVaultOwner(vaultId) {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = _state[vaultId].owner;
        _state[vaultId].owner = newOwner;
        emit VaultOwnershipTransferred(vaultId, previous, newOwner);
    }
```

- [ ] **Step 4: Run tests**

Run: `npx hardhat test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add contracts test
git commit -m "feat: owner-only tightening, auction scheduling and ownership transfer"
```

---

### Task 9: Auction open and cancel

Implements spec §6.1 `openAuction`, §6.2 `cancelAuction`, and the phase freeze.

**Files:**
- Modify: `contracts/hub/IvyVaultsLifecycle.sol`
- Test: `test/08-auction.test.ts`

**Interfaces:**
- Produces: `openAuction(uint256)`, `cancelAuction(uint256)`.

- [ ] **Step 1: Write the failing test**

`test/08-auction.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import {
  AUCTION_TIMEOUT, ExercisePolicy, Phase, SettlementPolicy, THIRTY_DAYS, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, fund,
} from "./helpers/setup.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("auction", function () {
  async function fixture() {
    const ctx = await deployIvy(connection);
    const v = await createVaultAs(ctx, ctx.alice, callTerms(ctx, { minCollateral: 5n * WETH_UNIT }), callPairs(ctx));
    await fund(ctx, ctx.weth, ctx.alice, v.vaultAddress, 6n * WETH_UNIT);
    await ctx.hub.connect(ctx.alice).deposit(v.vaultId, 6n * WETH_UNIT);
    return { ...ctx, ...v };
  }

  const anyTerms = {
    allowedExercise: ExercisePolicy.Either,
    allowedSettlement: SettlementPolicy.Physical,
    maxTenor: THIRTY_DAYS,
    minCollateral: 5n * WETH_UNIT,
    maxSpotDeviationBps: 0,
    maxPriceAge: 0,
  };

  it("owner opens the auction and the vault freezes", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, vault, vaultId, vaultAddress, weth, usdcAddress } = ctx;
    await expect(hub.connect(alice).openAuction(vaultId)).to.emit(hub, "AuctionOpened").withArgs(vaultId, 6n * WETH_UNIT);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Auction);
    expect(s.auctionOpenedAt).to.equal(BigInt(await networkHelpers.time.latest()));

    await fund(ctx, weth, alice, vaultAddress, WETH_UNIT);
    await expect(hub.connect(alice).deposit(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase").withArgs(Phase.Open, Phase.Auction);
    await expect(vault.connect(alice).deposit(WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).withdraw(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).tightenVaultTerms(vaultId, anyTerms)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).tightenPairTerms(vaultId, usdcAddress, { premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: true })).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).scheduleAuction(vaultId, 1n)).to.be.revertedWithCustomError(hub, "WrongPhase");
    await expect(hub.connect(alice).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "WrongPhase");
  });

  it("requires collateral above zero and above the minimum", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, weth } = ctx;
    const low = await createVaultAs(ctx, alice, callTerms(ctx, { minCollateral: 5n * WETH_UNIT }), callPairs(ctx));
    await fund(ctx, weth, alice, low.vaultAddress, 4n * WETH_UNIT);
    await hub.connect(alice).deposit(low.vaultId, 4n * WETH_UNIT);
    await expect(hub.connect(alice).openAuction(low.vaultId)).to.be.revertedWithCustomError(hub, "BelowMinCollateral").withArgs(4n * WETH_UNIT, 5n * WETH_UNIT);
    const empty = await createVaultAs(ctx, alice, callTerms(ctx), callPairs(ctx));
    await expect(hub.connect(alice).openAuction(empty.vaultId)).to.be.revertedWithCustomError(hub, "ZeroAmount");
  });

  it("strangers cannot open an unscheduled auction", async function () {
    const { hub, bob, vaultId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
  });

  it("anyone can open a scheduled auction once the time has come", async function () {
    const { hub, alice, bob, vaultId } = await networkHelpers.loadFixture(fixture);
    const startsAt = BigInt(await networkHelpers.time.latest()) + 1000n;
    await hub.connect(alice).scheduleAuction(vaultId, startsAt);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
    await networkHelpers.time.increaseTo(startsAt);
    await expect(hub.connect(bob).openAuction(vaultId)).to.emit(hub, "AuctionOpened");
  });

  it("bid master can cancel at any time and the owner can reopen", async function () {
    const { hub, alice, bidMaster, vaultId } = await networkHelpers.loadFixture(fixture);
    await hub.connect(alice).openAuction(vaultId);
    await expect(hub.connect(bidMaster).cancelAuction(vaultId)).to.emit(hub, "AuctionCancelled").withArgs(vaultId);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Open);
    expect(s.auctionOpenedAt).to.equal(0n);
    await hub.connect(alice).openAuction(vaultId);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Auction);
  });

  it("owner can cancel only after the timeout, and the schedule is cleared", async function () {
    const { hub, alice, bob, vaultId } = await networkHelpers.loadFixture(fixture);
    const startsAt = BigInt(await networkHelpers.time.latest()) + 10n;
    await hub.connect(alice).scheduleAuction(vaultId, startsAt);
    await hub.connect(alice).openAuction(vaultId);
    await expect(hub.connect(alice).cancelAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionTimeoutNotReached");
    await expect(hub.connect(bob).cancelAuction(vaultId)).to.be.revertedWithCustomError(hub, "NotVaultOwner");
    await networkHelpers.time.increase(AUCTION_TIMEOUT);
    await hub.connect(alice).cancelAuction(vaultId);
    expect((await hub.termsOf(vaultId)).auctionStartsAt).to.equal(0n);
    await expect(hub.connect(bob).openAuction(vaultId)).to.be.revertedWithCustomError(hub, "AuctionNotStartable");
  });

  it("cancel only works in the Auction phase", async function () {
    const { hub, bidMaster, vaultId } = await networkHelpers.loadFixture(fixture);
    await expect(hub.connect(bidMaster).cancelAuction(vaultId)).to.be.revertedWithCustomError(hub, "WrongPhase").withArgs(Phase.Auction, Phase.Open);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx hardhat test test/08-auction.test.ts`
Expected: fails, `openAuction is not a function`.

- [ ] **Step 3: Add the auction functions to IvyVaultsLifecycle.sol**

Append inside the contract, after `transferVaultOwnership`:

```solidity
    // ------------------------------------------------------------ auction (spec §6.1, §6.2)

    /// @notice Freeze deposits and start the off-chain auction. Owner any time; anyone once `auctionStartsAt` passed.
    function openAuction(uint256 vaultId) external {
        _requirePhase(vaultId, Phase.Open);
        VaultState storage s = _state[vaultId];
        VaultTerms storage t = _terms[vaultId];
        bool scheduled = t.auctionStartsAt != 0 && block.timestamp >= t.auctionStartsAt;
        if (msg.sender != s.owner && !scheduled) revert AuctionNotStartable();
        uint256 collateral = totalSupply(vaultId);
        if (collateral == 0) revert ZeroAmount();
        if (collateral < t.minCollateral) revert BelowMinCollateral(collateral, t.minCollateral);
        s.phase = Phase.Auction;
        s.auctionOpenedAt = uint64(block.timestamp);
        emit AuctionOpened(vaultId, collateral);
    }

    /// @notice Bid master any time; owner once `auctionTimeout` has elapsed. Clears the schedule.
    function cancelAuction(uint256 vaultId) external {
        _requirePhase(vaultId, Phase.Auction);
        VaultState storage s = _state[vaultId];
        if (!hasRole(BID_MASTER_ROLE, msg.sender)) {
            if (msg.sender != s.owner) revert NotVaultOwner();
            if (block.timestamp < uint256(s.auctionOpenedAt) + auctionTimeout) revert AuctionTimeoutNotReached();
        }
        s.phase = Phase.Open;
        s.auctionOpenedAt = 0;
        _terms[vaultId].auctionStartsAt = 0;
        emit AuctionCancelled(vaultId);
    }
```

- [ ] **Step 4: Run tests**

Run: `npx hardhat test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add contracts test
git commit -m "feat: auction open (manual or scheduled) and cancel with owner timeout"
```

---

### Task 10: Activation — bid verification

Implements spec §7 (bid struct, activation checks in order, nonce handling, `cancelBid`) and §5.1 strike bounds.

**Files:**
- Create: `contracts/hub/IvyVaultsActivation.sol`
- Modify: `contracts/IvyVaultsHub.sol` (inherit `IvyVaultsActivation`)
- Create: `test/helpers/scenarios.ts`
- Test: `test/09-activation.test.ts`

**Interfaces:**
- Consumes: `BidHash.hash`, `IvyMath.notionalOf/premiumTotal/spotBound`, `_readSpot`, `SignatureChecker`, `EIP712Upgradeable._hashTypedDataV4`.
- Produces: `activate(uint256 vaultId, Bid calldata bid, bytes calldata signature)`, `cancelBid(uint256 nonce)`, internal `_checkStrike`. TS: `openVault`, `makeBid`, `activate`, `goLive`, `setSpot`, `at`, constants `STRIKE`, `PREMIUM`, `CALL_DEPOSIT`, `PUT_DEPOSIT`, `TENOR`, `MM_BANKROLL`.

- [ ] **Step 1: Write test/helpers/scenarios.ts**

```ts
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import {
  ExerciseStyle, SettlementPolicy, SettlementType, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, fund, putPairs, putTerms,
  type IvyContext, type PairTermsInput, type VaultTermsInput,
} from "./setup.js";
import { signBid, type Bid } from "./bids.js";

export const STRIKE = 3000n * USDC_UNIT;        // 3000 USDC per WETH
export const PREMIUM = 100n * USDC_UNIT;        // 100 USDC per WETH
export const CALL_DEPOSIT = 10n * WETH_UNIT;    // 10 WETH → notional 10 WETH
export const PUT_DEPOSIT = 30_000n * USDC_UNIT; // 30,000 USDC → notional 10 WETH at strike 3000
export const TENOR = 7n * 24n * 3600n;
export const MM_BANKROLL = 1_000_000n * USDC_UNIT;

let nonceCounter = 1n;

/** Writes `price` into the mock feed, timestamped `ageSeconds` before the latest block. */
export async function setSpot(ctx: IvyContext, price: bigint, ageSeconds = 0n) {
  const now = BigInt(await ctx.networkHelpers.time.latest());
  await (await ctx.feed.set(ctx.wethAddress, ctx.usdcAddress, price, now - ageSeconds)).wait();
}

/** Makes the next mined block carry exactly `timestamp`. */
export async function at(ctx: IvyContext, timestamp: bigint) {
  await ctx.networkHelpers.time.setNextBlockTimestamp(timestamp);
}

export interface VaultOptions {
  isCall?: boolean;
  /** Attaches the mock feed: spot = STRIKE, 10% band, 1h max age, settlement Either. */
  withFeed?: boolean;
  /** alice's deposit. Defaults to CALL_DEPOSIT / PUT_DEPOSIT. */
  deposit?: bigint;
  extraDeposits?: Array<{ signer: HardhatEthersSigner; amount: bigint }>;
  terms?: Partial<VaultTermsInput>;
  pair?: Partial<PairTermsInput>;
}

/** alice creates a vault, funds it (plus any extra depositors) and opens the auction. */
export async function openVault(ctx: IvyContext, o: VaultOptions = {}) {
  const isCall = o.isCall ?? true;
  const feedTerms: Partial<VaultTermsInput> = o.withFeed
    ? { priceFeed: ctx.feedAddress, maxPriceAge: 3600, maxSpotDeviationBps: 1000, allowedSettlement: SettlementPolicy.Either }
    : {};
  const terms = isCall ? callTerms(ctx, { ...feedTerms, ...o.terms }) : putTerms(ctx, { ...feedTerms, ...o.terms });
  const pairs = isCall ? callPairs(ctx, o.pair) : putPairs(ctx, o.pair);
  const { vaultId, vault, vaultAddress } = await createVaultAs(ctx, ctx.alice, terms, pairs);

  const collateral = isCall ? ctx.weth : ctx.usdc;
  const deposit = o.deposit ?? (isCall ? CALL_DEPOSIT : PUT_DEPOSIT);
  await fund(ctx, collateral, ctx.alice, vaultAddress, deposit);
  await (await ctx.hub.connect(ctx.alice).deposit(vaultId, deposit)).wait();
  for (const extra of o.extraDeposits ?? []) {
    await fund(ctx, collateral, extra.signer, vaultAddress, extra.amount);
    await (await ctx.hub.connect(extra.signer).deposit(vaultId, extra.amount)).wait();
  }
  await (await ctx.hub.connect(ctx.alice).openAuction(vaultId)).wait();
  if (o.withFeed) await setSpot(ctx, STRIKE);
  return { vaultId, vault, vaultAddress, isCall, deposit };
}

export interface BidOptions {
  vaultId?: bigint;
  marketMaker?: string;
  quoteToken?: string;
  strike?: bigint;
  premium?: bigint;
  style?: number;
  settlement?: number;
  tenor?: bigint;
  expiry?: bigint;
  validFor?: bigint;
  nonce?: bigint;
}

/** Physical American bid at STRIKE / PREMIUM expiring in TENOR, valid for one hour, fresh nonce. */
export async function makeBid(ctx: IvyContext, vaultId: bigint, o: BidOptions = {}): Promise<Bid> {
  const now = BigInt(await ctx.networkHelpers.time.latest());
  return {
    vaultId: o.vaultId ?? vaultId,
    marketMaker: o.marketMaker ?? ctx.marketMaker.address,
    quoteToken: o.quoteToken ?? ctx.usdcAddress,
    strike: o.strike ?? STRIKE,
    premium: o.premium ?? PREMIUM,
    style: o.style ?? ExerciseStyle.American,
    settlement: o.settlement ?? SettlementType.Physical,
    expiry: o.expiry ?? now + (o.tenor ?? TENOR),
    validUntil: now + (o.validFor ?? 3600n),
    nonce: o.nonce ?? nonceCounter++,
  };
}

/** Funds the market maker with USDC (approved to the vault), signs as the market maker, activates as the bid master. */
export async function activate(ctx: IvyContext, vaultId: bigint, vaultAddress: string, o: BidOptions = {}) {
  const bid = await makeBid(ctx, vaultId, o);
  await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, MM_BANKROLL);
  const signature = await signBid(ctx.marketMaker, ctx.hubAddress, bid);
  await (await ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, signature)).wait();
  return { bid, signature };
}

/** create → fund → open auction → activate. */
export async function goLive(ctx: IvyContext, v: VaultOptions = {}, b: BidOptions = {}) {
  const opened = await openVault(ctx, v);
  const activated = await activate(ctx, opened.vaultId, opened.vaultAddress, b);
  return { ...opened, ...activated };
}
```

- [ ] **Step 2: Write the failing test**

`test/09-activation.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import {
  ExercisePolicy, ExerciseStyle, Phase, SettlementType, THIRTY_DAYS, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, fund, putPairs, putTerms,
} from "./helpers/setup.js";
import { signBid } from "./helpers/bids.js";
import { CALL_DEPOSIT, PREMIUM, PUT_DEPOSIT, STRIKE, activate, makeBid, openVault, setSpot } from "./helpers/scenarios.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("activate", function () {
  const fixture = () => deployIvy(connection);

  it("activates a physical American call and pulls the premium into the vault", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, usdc, usdcAddress, bidMaster, marketMaker, hubAddress } = ctx;
    const { vaultId, vaultAddress } = await openVault(ctx);
    const bid = await makeBid(ctx, vaultId);
    await fund(ctx, usdc, marketMaker, vaultAddress, 1000n * USDC_UNIT);
    const signature = await signBid(marketMaker, hubAddress, bid);
    await expect(hub.connect(bidMaster).activate(vaultId, bid, signature))
      .to.emit(hub, "Activated")
      .withArgs(
        vaultId, marketMaker.address, usdcAddress, usdcAddress, STRIKE, PREMIUM,
        ExerciseStyle.American, SettlementType.Physical, bid.expiry, CALL_DEPOSIT, 1000n * USDC_UNIT,
      );
    expect(await usdc.balanceOf(vaultAddress)).to.equal(1000n * USDC_UNIT);
    expect(await usdc.balanceOf(marketMaker.address)).to.equal(0n);
    const s = await hub.stateOf(vaultId);
    expect(s.phase).to.equal(Phase.Live);
    expect(s.marketMaker).to.equal(marketMaker.address);
    expect(s.quoteToken).to.equal(usdcAddress);
    expect(s.premiumToken).to.equal(usdcAddress);
    expect(s.strike).to.equal(STRIKE);
    expect(s.premium).to.equal(PREMIUM);
    expect(s.style).to.equal(ExerciseStyle.American);
    expect(s.settlement).to.equal(SettlementType.Physical);
    expect(s.expiry).to.equal(bid.expiry);
    expect(s.totalNotional).to.equal(CALL_DEPOSIT);
    expect(s.exercisedNotional).to.equal(0n);
    expect(await hub.remainingNotional(vaultId)).to.equal(CALL_DEPOSIT);
    expect(await hub.usedBidNonces(marketMaker.address, bid.nonce)).to.equal(true);
  });

  it("activates a put: notional derives from the strike, premium is paid in the quote token", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress } = await openVault(ctx, { isCall: false });
    await activate(ctx, vaultId, vaultAddress);
    const s = await ctx.hub.stateOf(vaultId);
    expect(s.totalNotional).to.equal(10n * WETH_UNIT);
    expect(await ctx.usdc.balanceOf(vaultAddress)).to.equal(PUT_DEPOSIT + 1000n * USDC_UNIT);
  });

  it("accepts cash settlement only where the vault allows it", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const a = await openVault(ctx, { withFeed: true });
    await activate(ctx, a.vaultId, a.vaultAddress, { settlement: SettlementType.Cash });
    expect((await ctx.hub.stateOf(a.vaultId)).settlement).to.equal(SettlementType.Cash);
    const b = await openVault(ctx);
    await expect(activate(ctx, b.vaultId, b.vaultAddress, { settlement: SettlementType.Cash }))
      .to.be.revertedWithCustomError(ctx.hub, "SettlementNotAllowed");
  });

  it("applies the oracle band in both directions", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const call = await openVault(ctx, { withFeed: true });
    await expect(activate(ctx, call.vaultId, call.vaultAddress, { strike: 2699n * USDC_UNIT }))
      .to.be.revertedWithCustomError(ctx.hub, "StrikeOutsideSpotBand");
    await activate(ctx, call.vaultId, call.vaultAddress, { strike: 2700n * USDC_UNIT });

    const put = await openVault(ctx, { isCall: false, withFeed: true });
    await expect(activate(ctx, put.vaultId, put.vaultAddress, { strike: 3301n * USDC_UNIT }))
      .to.be.revertedWithCustomError(ctx.hub, "StrikeOutsideSpotBand");
    await activate(ctx, put.vaultId, put.vaultAddress, { strike: 3300n * USDC_UNIT });
  });

  it("rejects stale, zero and future-dated prices", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress } = await openVault(ctx, { withFeed: true });
    await setSpot(ctx, STRIKE, 3601n);
    await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "StalePrice");
    await setSpot(ctx, 0n);
    await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "InvalidPrice");
    const future = BigInt(await networkHelpers.time.latest()) + 1000n;
    await ctx.feed.set(ctx.wethAddress, ctx.usdcAddress, STRIKE, future);
    await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "InvalidPrice");
  });

  it("lets a market maker cancel a nonce", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, marketMaker } = ctx;
    await expect(hub.connect(marketMaker).cancelBid(77n)).to.emit(hub, "BidCancelled").withArgs(marketMaker.address, 77n);
    expect(await hub.usedBidNonces(marketMaker.address, 77n)).to.equal(true);
    await expect(hub.connect(marketMaker).cancelBid(77n)).to.be.revertedWithCustomError(hub, "NonceUsed");
  });

  describe("rejections", function () {
    it("caller must be the bid master", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId);
      const signature = await signBid(ctx.marketMaker, ctx.hubAddress, bid);
      await expect(ctx.hub.connect(ctx.alice).activate(vaultId, bid, signature))
        .to.be.revertedWithCustomError(ctx.hub, "AccessControlUnauthorizedAccount");
    });

    it("vault must be in the Auction phase", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
      await expect(activate(ctx, vaultId, vaultAddress))
        .to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Auction, Phase.Open);
    });

    it("bid must reference the vault", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx);
      await expect(activate(ctx, vaultId, vaultAddress, { vaultId: vaultId + 1n }))
        .to.be.revertedWithCustomError(ctx.hub, "BidVaultMismatch");
    });

    it("market maker must hold the role", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId, { marketMaker: ctx.bob.address });
      const signature = await signBid(ctx.bob, ctx.hubAddress, bid);
      await expect(ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, signature))
        .to.be.revertedWithCustomError(ctx.hub, "NotMarketMaker");
    });

    it("bid must not be expired", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId, { validFor: 10n });
      const signature = await signBid(ctx.marketMaker, ctx.hubAddress, bid);
      await networkHelpers.time.increase(11n);
      await expect(ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, signature))
        .to.be.revertedWithCustomError(ctx.hub, "BidExpired");
    });

    it("a nonce cannot be reused or activated after cancellation", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const first = await openVault(ctx);
      await activate(ctx, first.vaultId, first.vaultAddress, { nonce: 500n });
      const second = await openVault(ctx);
      await expect(activate(ctx, second.vaultId, second.vaultAddress, { nonce: 500n }))
        .to.be.revertedWithCustomError(ctx.hub, "NonceUsed");
      await ctx.hub.connect(ctx.marketMaker).cancelBid(501n);
      await expect(activate(ctx, second.vaultId, second.vaultAddress, { nonce: 501n }))
        .to.be.revertedWithCustomError(ctx.hub, "NonceUsed");
    });

    it("signature must come from the market maker", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await openVault(ctx);
      const bid = await makeBid(ctx, vaultId);
      const forged = await signBid(ctx.bob, ctx.hubAddress, bid);
      await expect(ctx.hub.connect(ctx.bidMaster).activate(vaultId, bid, forged))
        .to.be.revertedWithCustomError(ctx.hub, "BadSignature");
    });

    it("pair must exist and be enabled", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, alice, usdcAddress, daiAddress, weth } = ctx;
      const a = await openVault(ctx);
      await expect(activate(ctx, a.vaultId, a.vaultAddress, { quoteToken: daiAddress }))
        .to.be.revertedWithCustomError(hub, "PairUnknown").withArgs(daiAddress);

      const b = await createVaultAs(ctx, alice, callTerms(ctx), callPairs(ctx));
      await hub.connect(alice).tightenPairTerms(b.vaultId, usdcAddress, { premiumToken: usdcAddress, strikeLimit: 0n, minPremium: 0n, enabled: false });
      await fund(ctx, weth, alice, b.vaultAddress, CALL_DEPOSIT);
      await hub.connect(alice).deposit(b.vaultId, CALL_DEPOSIT);
      await hub.connect(alice).openAuction(b.vaultId);
      await expect(activate(ctx, b.vaultId, b.vaultAddress))
        .to.be.revertedWithCustomError(hub, "PairDisabled").withArgs(usdcAddress);
    });

    it("style must be allowed by the vault", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx, { terms: { allowedExercise: ExercisePolicy.European } });
      await expect(activate(ctx, vaultId, vaultAddress, { style: ExerciseStyle.American }))
        .to.be.revertedWithCustomError(ctx.hub, "StyleNotAllowed");
      await activate(ctx, vaultId, vaultAddress, { style: ExerciseStyle.European });
    });

    it("expiry must be in the future and within maxTenor", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx);
      const now = BigInt(await networkHelpers.time.latest());
      await expect(activate(ctx, vaultId, vaultAddress, { expiry: now })).to.be.revertedWithCustomError(ctx.hub, "ExpiryInPast");
      await expect(activate(ctx, vaultId, vaultAddress, { tenor: THIRTY_DAYS + 60n })).to.be.revertedWithCustomError(ctx.hub, "TenorTooLong");
    });

    it("strike must respect the configured limit", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const call = await openVault(ctx, { pair: { strikeLimit: 3100n * USDC_UNIT } });
      await expect(activate(ctx, call.vaultId, call.vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "StrikeBelowLimit");
      const put = await openVault(ctx, { isCall: false, pair: { strikeLimit: 2900n * USDC_UNIT } });
      await expect(activate(ctx, put.vaultId, put.vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "StrikeAboveLimit");
    });

    it("premium must reach the floor", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx, { pair: { minPremium: 200n * USDC_UNIT } });
      await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "PremiumTooLow");
    });

    it("rejects a bid whose notional rounds to zero", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const six = await ctx.ethers.deployContract("MockERC20", ["Six", "SIX", 6]);
      const terms = putTerms(ctx, { underlying: await six.getAddress() });
      const { vaultId, vaultAddress } = await createVaultAs(ctx, ctx.alice, terms, putPairs(ctx));
      await fund(ctx, ctx.usdc, ctx.alice, vaultAddress, 1n);
      await ctx.hub.connect(ctx.alice).deposit(vaultId, 1n);
      await ctx.hub.connect(ctx.alice).openAuction(vaultId);
      await expect(activate(ctx, vaultId, vaultAddress)).to.be.revertedWithCustomError(ctx.hub, "EmptyNotional");
    });

    it("premium must arrive in full", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await openVault(ctx);
      await ctx.usdc.setFeeBps(100n);
      await expect(activate(ctx, vaultId, vaultAddress))
        .to.be.revertedWithCustomError(ctx.hub, "ShortReceived").withArgs(1000n * USDC_UNIT, 990n * USDC_UNIT);
    });
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npx hardhat test test/09-activation.test.ts`
Expected: fails, `activate is not a function`.

- [ ] **Step 4: Write IvyVaultsActivation.sol**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IvyVaultsLifecycle} from "./IvyVaultsLifecycle.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import {BidHash} from "../libraries/BidHash.sol";
import {IvyMath} from "../libraries/IvyMath.sol";
import "../types/IvyTypes.sol";

/// @dev Bid verification and activation (spec §7).
abstract contract IvyVaultsActivation is IvyVaultsLifecycle {
    /// @notice Bid master submits the winning bid, signed by the market maker. Checks run in spec §7.2 order.
    function activate(uint256 vaultId, Bid calldata bid, bytes calldata signature)
        external nonReentrant onlyRole(BID_MASTER_ROLE)
    {
        _requirePhase(vaultId, Phase.Auction);
        if (bid.vaultId != vaultId) revert BidVaultMismatch();
        if (!hasRole(MARKET_MAKER_ROLE, bid.marketMaker)) revert NotMarketMaker();
        if (block.timestamp > bid.validUntil) revert BidExpired();
        if (usedBidNonces[bid.marketMaker][bid.nonce]) revert NonceUsed();
        usedBidNonces[bid.marketMaker][bid.nonce] = true;
        bytes32 digest = _hashTypedDataV4(BidHash.hash(bid));
        if (!SignatureChecker.isValidSignatureNow(bid.marketMaker, digest, signature)) revert BadSignature();

        VaultState storage s = _state[vaultId];
        VaultTerms storage t = _terms[vaultId];
        PairTerms storage p = _pairTerms[vaultId][bid.quoteToken];
        if (p.premiumToken == address(0)) revert PairUnknown(bid.quoteToken);
        if (!p.enabled) revert PairDisabled(bid.quoteToken);
        if (t.allowedExercise != ExercisePolicy.Either && uint8(t.allowedExercise) != uint8(bid.style)) {
            revert StyleNotAllowed();
        }
        if (t.allowedSettlement != SettlementPolicy.Either && uint8(t.allowedSettlement) != uint8(bid.settlement)) {
            revert SettlementNotAllowed();
        }
        if (bid.expiry <= block.timestamp) revert ExpiryInPast();
        if (bid.expiry - block.timestamp > t.maxTenor) revert TenorTooLong();
        _checkStrike(s.isCall, t, p, bid.quoteToken, bid.strike);
        if (bid.premium < p.minPremium) revert PremiumTooLow();

        uint256 totalNotional = IvyMath.notionalOf(s.isCall, totalSupply(vaultId), s.underlyingUnit, bid.strike);
        if (totalNotional == 0) revert EmptyNotional();
        uint256 totalPremium = IvyMath.premiumTotal(bid.premium, totalNotional, s.underlyingUnit);

        s.marketMaker = bid.marketMaker;
        s.quoteToken = bid.quoteToken;
        s.premiumToken = p.premiumToken;
        s.strike = bid.strike;
        s.premium = bid.premium;
        s.style = bid.style;
        s.settlement = bid.settlement;
        s.expiry = bid.expiry;
        s.totalNotional = totalNotional;
        s.phase = Phase.Live;

        if (totalPremium > 0) {
            uint256 received = IIvyVault(s.vault).pull(p.premiumToken, bid.marketMaker, totalPremium);
            if (received < totalPremium) revert ShortReceived(totalPremium, received);
        }

        emit Activated(
            vaultId,
            bid.marketMaker,
            bid.quoteToken,
            p.premiumToken,
            bid.strike,
            bid.premium,
            bid.style,
            bid.settlement,
            bid.expiry,
            totalNotional,
            totalPremium
        );
    }

    /// @notice Burn one of your own bid nonces so a bid signed with it can never be activated.
    function cancelBid(uint256 nonce) external {
        if (usedBidNonces[msg.sender][nonce]) revert NonceUsed();
        usedBidNonces[msg.sender][nonce] = true;
        emit BidCancelled(msg.sender, nonce);
    }

    /// @dev Spec §5.1: the configured limit and, when a feed is set, the oracle band. Both must pass.
    function _checkStrike(bool isCall, VaultTerms storage t, PairTerms storage p, address quoteToken, uint256 strike)
        internal view
    {
        if (isCall) {
            if (strike < p.strikeLimit) revert StrikeBelowLimit();
        } else {
            if (strike > p.strikeLimit) revert StrikeAboveLimit();
        }
        if (t.priceFeed != address(0)) {
            uint256 bound = IvyMath.spotBound(isCall, _readSpot(t, quoteToken), t.maxSpotDeviationBps);
            if (isCall ? strike < bound : strike > bound) revert StrikeOutsideSpotBand();
        }
    }
}
```

- [ ] **Step 5: Point the concrete hub at the activation layer**

In `contracts/IvyVaultsHub.sol`:
```solidity
import {IvyVaultsActivation} from "./hub/IvyVaultsActivation.sol";
import "./types/IvyTypes.sol";

contract IvyVaultsHub is IvyVaultsActivation {
```

- [ ] **Step 6: Run tests**

Run: `npx hardhat test`
Expected: all passing. If `activate` hits "stack too deep", confirm `viaIR: true` is set in `hardhat.config.ts` (it is required by this plan).

- [ ] **Step 7: Commit**

```bash
git add contracts test
git commit -m "feat: EIP-712 bid verification and vault activation"
```

---

### Task 11: Exercise (physical and cash, partial)

Implements spec §9.1 and the `_finalize` transition to `Settled` when fully exercised.

**Files:**
- Create: `contracts/hub/IvyVaultsSettlement.sol`
- Modify: `contracts/IvyVaultsHub.sol` (inherit `IvyVaultsSettlement`)
- Test: `test/10-exercise.test.ts`

**Interfaces:**
- Produces: `exercise(uint256 vaultId, uint256 amount)`, internal `_checkExerciseWindow(VaultState storage)`, `_finalize(uint256, VaultState storage)`.

- [ ] **Step 1: Write the failing test**

`test/10-exercise.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import { EXERCISE_WINDOW, ExerciseStyle, Phase, SettlementType, USDC_UNIT, WETH_UNIT, deployIvy, fund } from "./helpers/setup.js";
import { at, goLive, setSpot } from "./helpers/scenarios.js";

const connection = await network.create();
const { networkHelpers } = connection;

describe("exercise", function () {
  const fixture = () => deployIvy(connection);

  describe("physical call", function () {
    it("partial exercise pulls quote (rounded up) and pushes collateral; the vault stays Live", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, weth, usdc, marketMaker } = ctx;
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, usdc, marketMaker, vaultAddress, 12_000n * USDC_UNIT);
      const tx = hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 12_000n * USDC_UNIT, 4n * WETH_UNIT);
      await expect(tx).to.changeTokenBalances(weth, [marketMaker, vaultAddress], [4n * WETH_UNIT, -4n * WETH_UNIT]);
      await expect(tx).to.changeTokenBalances(usdc, [marketMaker, vaultAddress], [-12_000n * USDC_UNIT, 12_000n * USDC_UNIT]);
      expect(await hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
      expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Live);
    });

    it("rounds the quote due up", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 1n))
        .to.emit(ctx.hub, "Exercised").withArgs(vaultId, 1n, 1n, 1n);
    });

    it("a full exercise settles the vault", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 10n * WETH_UNIT))
        .to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 0n);
      expect((await ctx.hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);
      expect(await ctx.hub.remainingNotional(vaultId)).to.equal(0n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 1n))
        .to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Live, Phase.Settled);
    });

    it("cannot exceed the remaining notional; only the market maker; never zero", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 40_000n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 11n * WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExceedsRemaining").withArgs(10n * WETH_UNIT);
      await expect(ctx.hub.connect(ctx.alice).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "NotMarketMaker");
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 0n)).to.be.revertedWithCustomError(ctx.hub, "ZeroAmount");
    });

    it("American: open until expiry + exerciseWindow, closed one second later", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress, bid } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await at(ctx, bid.expiry + EXERCISE_WINDOW);
      await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExerciseWindowClosed");
    });

    it("European: closed before expiry, open inside the window", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress, bid } = await goLive(ctx, {}, { style: ExerciseStyle.European });
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 30_000n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExerciseNotOpenYet");
      await at(ctx, bid.expiry);
      await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ExerciseWindowClosed");
    });

    it("fails if the quote does not arrive in full", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx);
      await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 12_000n * USDC_UNIT);
      await ctx.usdc.setFeeBps(100n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT))
        .to.be.revertedWithCustomError(ctx.hub, "ShortReceived").withArgs(12_000n * USDC_UNIT, 11_880n * USDC_UNIT);
    });
  });

  describe("physical put", function () {
    it("pulls underlying and pushes quote (rounded down)", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { hub, weth, usdc, marketMaker } = ctx;
      const { vaultId, vaultAddress } = await goLive(ctx, { isCall: false });
      await fund(ctx, weth, marketMaker, vaultAddress, 4n * WETH_UNIT);
      const tx = hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 4n * WETH_UNIT, 12_000n * USDC_UNIT);
      await expect(tx).to.changeTokenBalances(weth, [marketMaker, vaultAddress], [-4n * WETH_UNIT, 4n * WETH_UNIT]);
      await expect(tx).to.changeTokenBalances(usdc, [marketMaker, vaultAddress], [12_000n * USDC_UNIT, -12_000n * USDC_UNIT]);
      expect(await hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
    });
  });

  describe("cash", function () {
    it("call pays the intrinsic value in underlying at the current spot", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await setSpot(ctx, 3300n * USDC_UNIT);
      const tx = ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(ctx.hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 0n, 363_636_363_636_363_636n);
      await expect(tx).to.changeTokenBalances(ctx.weth, [ctx.marketMaker, vaultAddress], [363_636_363_636_363_636n, -363_636_363_636_363_636n]);
      expect(await ctx.hub.remainingNotional(vaultId)).to.equal(6n * WETH_UNIT);
    });

    it("put pays the intrinsic value in quote", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, vaultAddress } = await goLive(ctx, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash });
      await setSpot(ctx, 2700n * USDC_UNIT);
      const tx = ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
      await expect(tx).to.emit(ctx.hub, "Exercised").withArgs(vaultId, 4n * WETH_UNIT, 0n, 1200n * USDC_UNIT);
      await expect(tx).to.changeTokenBalances(ctx.usdc, [ctx.marketMaker, vaultAddress], [1200n * USDC_UNIT, -1200n * USDC_UNIT]);
    });

    it("out of the money reverts", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await setSpot(ctx, 2900n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "NothingToExercise");
    });

    it("American cash is open right before expiry and closed at expiry", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await networkHelpers.time.increaseTo(bid.expiry - 3n);
      await setSpot(ctx, 3300n * USDC_UNIT);
      await at(ctx, bid.expiry - 1n);
      await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT);
      await at(ctx, bid.expiry);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "ExerciseWindowClosed");
    });

    it("European cash cannot be exercised at all", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
      await setSpot(ctx, 3300n * USDC_UNIT);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "ExerciseNotAvailable");
      await at(ctx, bid.expiry);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "ExerciseNotAvailable");
    });

    it("a stale price reverts", async function () {
      const ctx = await networkHelpers.loadFixture(fixture);
      const { vaultId } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash });
      await setSpot(ctx, 3300n * USDC_UNIT, 3601n);
      await expect(ctx.hub.connect(ctx.marketMaker).exercise(vaultId, WETH_UNIT)).to.be.revertedWithCustomError(ctx.hub, "StalePrice");
    });
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx hardhat test test/10-exercise.test.ts`
Expected: fails, `exercise is not a function`.

- [ ] **Step 3: Write IvyVaultsSettlement.sol (exercise only for now)**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IvyVaultsActivation} from "./IvyVaultsActivation.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import {IIvyPriceFeed} from "../interfaces/IIvyPriceFeed.sol";
import {IvyMath} from "../libraries/IvyMath.sol";
import "../types/IvyTypes.sol";

/// @dev Exercise, settlement and claims (spec §9, §10).
abstract contract IvyVaultsSettlement is IvyVaultsActivation {
    // ------------------------------------------------------------ exercise (spec §9.1)

    /// @notice Market maker exercises `amount` underlying units. Partial exercise is allowed; the vault settles
    ///         automatically once everything is exercised.
    function exercise(uint256 vaultId, uint256 amount) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker) revert NotMarketMaker();
        if (amount == 0) revert ZeroAmount();
        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (amount > remaining) revert ExceedsRemaining(remaining);
        _checkExerciseWindow(s);

        s.exercisedNotional += amount;

        VaultTerms storage t = _terms[vaultId];
        IIvyVault vault = IIvyVault(s.vault);
        uint256 paid;
        uint256 got;
        if (s.settlement == SettlementType.Physical) {
            if (s.isCall) {
                paid = IvyMath.quoteDueCeil(amount, s.strike, s.underlyingUnit);
                uint256 received = vault.pull(s.quoteToken, msg.sender, paid);
                if (received < paid) revert ShortReceived(paid, received);
                got = amount;
            } else {
                paid = amount;
                uint256 received = vault.pull(t.underlying, msg.sender, amount);
                if (received < amount) revert ShortReceived(amount, received);
                got = IvyMath.quoteOutFloor(amount, s.strike, s.underlyingUnit);
            }
        } else {
            uint256 spot = _readSpot(t, s.quoteToken);
            got = s.isCall
                ? IvyMath.callIntrinsic(amount, s.strike, spot)
                : IvyMath.putIntrinsic(amount, s.strike, spot, s.underlyingUnit);
            if (got == 0) revert NothingToExercise();
        }
        vault.push(t.collateral, msg.sender, got);

        emit Exercised(vaultId, amount, paid, got);
        if (s.exercisedNotional == s.totalNotional) _finalize(vaultId, s);
    }

    /// @dev Spec §9.1 timing table. Cash European never exercises (it auto-settles).
    function _checkExerciseWindow(VaultState storage s) internal view {
        uint256 ts = block.timestamp;
        if (s.settlement == SettlementType.Cash) {
            if (s.style == ExerciseStyle.European) revert ExerciseNotAvailable();
            if (ts >= s.expiry) revert ExerciseWindowClosed();
        } else {
            if (ts > uint256(s.expiry) + exerciseWindow) revert ExerciseWindowClosed();
            if (s.style == ExerciseStyle.European && ts < s.expiry) revert ExerciseNotOpenYet();
        }
    }

    function _finalize(uint256 vaultId, VaultState storage s) internal {
        s.phase = Phase.Settled;
        emit Settled(vaultId, s.exercisedNotional, s.totalNotional, s.pendingPayout);
    }
}
```

- [ ] **Step 4: Point the concrete hub at the settlement layer**

In `contracts/IvyVaultsHub.sol`:
```solidity
import {IvyVaultsSettlement} from "./hub/IvyVaultsSettlement.sol";
import "./types/IvyTypes.sol";

contract IvyVaultsHub is IvyVaultsSettlement {
```

- [ ] **Step 5: Run tests**

Run: `npx hardhat test`
Expected: all passing. (`IERC20` and `IIvyPriceFeed` imports are unused until Task 12/13; the compiler only warns.)

- [ ] **Step 6: Commit**

```bash
git add contracts test
git commit -m "feat: partial exercise for physical and cash settlement"
```

---

### Task 12: Settlement and market-maker payout

Implements spec §9.2: `settle`, cash auto-settlement with pull-based payout, dead-feed grace period, `claimPayout`.

**Files:**
- Modify: `contracts/hub/IvyVaultsSettlement.sol`
- Test: `test/11-settlement.test.ts`

**Interfaces:**
- Produces: `settlementTimeOf(uint256) → uint256`, `settle(uint256)`, `claimPayout(uint256)`, internal `_trySpot(VaultTerms storage, address, bool) → (bool, uint256)`.

- [ ] **Step 1: Write the failing test**

`test/11-settlement.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import {
  EXERCISE_WINDOW, ExerciseStyle, Phase, SETTLEMENT_GRACE, SettlementType, USDC_UNIT, WETH_UNIT,
  callPairs, callTerms, createVaultAs, deployIvy, fund,
} from "./helpers/setup.js";
import { at, goLive, setSpot } from "./helpers/scenarios.js";

const connection = await network.create();
const { networkHelpers } = connection;

const CALL_PAYOUT_ALL = 909_090_909_090_909_090n;   // 10 WETH × (3300 − 3000) / 3300
const CALL_PAYOUT_SIX = 545_454_545_454_545_454n;   // 6 WETH × (3300 − 3000) / 3300

describe("settle", function () {
  const fixture = () => deployIvy(connection);

  it("physical: not before expiry + window; afterwards leftovers stay for the LPs", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress, bid } = await goLive(ctx);
    expect(await ctx.hub.settlementTimeOf(vaultId)).to.equal(bid.expiry + EXERCISE_WINDOW);
    await expect(ctx.hub.settle(vaultId)).to.be.revertedWithCustomError(ctx.hub, "SettlementNotReached");
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await expect(ctx.hub.connect(ctx.bob).settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 0n, 10n * WETH_UNIT, 0n);
    expect((await ctx.hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);
    expect(await ctx.weth.balanceOf(vaultAddress)).to.equal(10n * WETH_UNIT);
    expect(await ctx.usdc.balanceOf(vaultAddress)).to.equal(1000n * USDC_UNIT);
  });

  it("physical: partially exercised then settled", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, vaultAddress, bid } = await goLive(ctx);
    await fund(ctx, ctx.usdc, ctx.marketMaker, vaultAddress, 12_000n * USDC_UNIT);
    await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 4n * WETH_UNIT, 10n * WETH_UNIT, 0n);
  });

  it("cash European call: settles at expiry and reserves the payout for the market maker", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, marketMaker, bob, alice } = ctx;
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    expect(await hub.settlementTimeOf(vaultId)).to.equal(bid.expiry);
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await setSpot(ctx, 3300n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(hub.connect(alice).settle(vaultId)).to.emit(hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, CALL_PAYOUT_ALL);
    expect((await hub.stateOf(vaultId)).pendingPayout).to.equal(CALL_PAYOUT_ALL);

    await expect(hub.connect(bob).claimPayout(vaultId)).to.be.revertedWithCustomError(hub, "NotMarketMaker");
    const tx = hub.connect(marketMaker).claimPayout(vaultId);
    await expect(tx).to.emit(hub, "PayoutClaimed").withArgs(vaultId, marketMaker.address, CALL_PAYOUT_ALL);
    await expect(tx).to.changeTokenBalances(weth, [marketMaker], [CALL_PAYOUT_ALL]);
    expect((await hub.stateOf(vaultId)).pendingPayout).to.equal(0n);
    await expect(hub.connect(marketMaker).claimPayout(vaultId)).to.be.revertedWithCustomError(hub, "NothingToClaim");
  });

  it("cash put: reserves the payout in quote", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await setSpot(ctx, 2700n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 3000n * USDC_UNIT);
    await expect(ctx.hub.connect(ctx.marketMaker).claimPayout(vaultId)).to.changeTokenBalances(ctx.usdc, [ctx.marketMaker], [3000n * USDC_UNIT]);
  });

  it("cash: out of the money reserves nothing", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await setSpot(ctx, 2900n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 0n);
    await expect(ctx.hub.connect(ctx.marketMaker).claimPayout(vaultId)).to.be.revertedWithCustomError(ctx.hub, "NothingToClaim");
  });

  it("cash: a stale or reverting feed blocks settlement until the grace period", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await at(ctx, bid.expiry);
    await expect(ctx.hub.settle(vaultId)).to.be.revertedWithCustomError(ctx.hub, "StalePrice");
    await ctx.feed.setRevert(true);
    await expect(ctx.hub.settle(vaultId)).to.be.revertedWithCustomError(ctx.hub, "StalePrice");
    expect((await ctx.hub.stateOf(vaultId)).phase).to.equal(Phase.Live);
  });

  it("cash: after the grace period a stale price is accepted", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await setSpot(ctx, 3300n * USDC_UNIT);
    await networkHelpers.time.increaseTo(bid.expiry + SETTLEMENT_GRACE);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, CALL_PAYOUT_ALL);
  });

  it("cash: after the grace period a reverting feed settles with zero payout", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await ctx.feed.setRevert(true);
    await networkHelpers.time.increaseTo(bid.expiry + SETTLEMENT_GRACE);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, 0n);
  });

  it("cash American: the unexercised remainder auto-settles at expiry", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { vaultId, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.American });
    await setSpot(ctx, 3300n * USDC_UNIT);
    await ctx.hub.connect(ctx.marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await setSpot(ctx, 3300n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await expect(ctx.hub.settle(vaultId)).to.emit(ctx.hub, "Settled").withArgs(vaultId, 10n * WETH_UNIT, 10n * WETH_UNIT, CALL_PAYOUT_SIX);
  });

  it("settle only works in the Live phase", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const open = await createVaultAs(ctx, ctx.alice, callTerms(ctx), callPairs(ctx));
    await expect(ctx.hub.settle(open.vaultId)).to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Live, Phase.Open);
    const { vaultId, bid } = await goLive(ctx);
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await ctx.hub.settle(vaultId);
    await expect(ctx.hub.settle(vaultId)).to.be.revertedWithCustomError(ctx.hub, "WrongPhase").withArgs(Phase.Live, Phase.Settled);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx hardhat test test/11-settlement.test.ts`
Expected: fails, `settlementTimeOf is not a function`.

- [ ] **Step 3: Add settlement to IvyVaultsSettlement.sol**

Append inside the contract, after `_finalize`:

```solidity
    // ------------------------------------------------------------ settlement (spec §9.2)

    /// @notice First moment `settle` may be called: expiry for cash, expiry + exerciseWindow for physical.
    function settlementTimeOf(uint256 vaultId) public view returns (uint256) {
        VaultState storage s = _state[vaultId];
        return s.settlement == SettlementType.Cash ? uint256(s.expiry) : uint256(s.expiry) + exerciseWindow;
    }

    /// @notice Permissionless. Physical: closes the vault. Cash: prices the remaining notional and reserves
    ///         the market maker's payout (collected via `claimPayout`).
    function settle(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Live);
        VaultState storage s = _state[vaultId];
        if (block.timestamp < settlementTimeOf(vaultId)) revert SettlementNotReached();

        uint256 remaining = s.totalNotional - s.exercisedNotional;
        if (s.settlement == SettlementType.Cash && remaining > 0) {
            VaultTerms storage t = _terms[vaultId];
            bool grace = block.timestamp >= uint256(s.expiry) + settlementGracePeriod;
            (bool ok, uint256 spot) = _trySpot(t, s.quoteToken, grace);
            if (!ok && !grace) revert StalePrice();
            uint256 payout;
            if (ok) {
                payout = s.isCall
                    ? IvyMath.callIntrinsic(remaining, s.strike, spot)
                    : IvyMath.putIntrinsic(remaining, s.strike, spot, s.underlyingUnit);
            }
            s.pendingPayout += payout;
            s.exercisedNotional = s.totalNotional;
        }
        _finalize(vaultId, s);
    }

    /// @notice Market maker collects what cash auto-settlement reserved. Pull-based so a failing transfer
    ///         can never block `settle`.
    function claimPayout(uint256 vaultId) external nonReentrant {
        _requirePhase(vaultId, Phase.Settled);
        VaultState storage s = _state[vaultId];
        if (msg.sender != s.marketMaker) revert NotMarketMaker();
        uint256 amount = s.pendingPayout;
        if (amount == 0) revert NothingToClaim();
        s.pendingPayout = 0;
        IIvyVault(s.vault).push(_terms[vaultId].collateral, msg.sender, amount);
        emit PayoutClaimed(vaultId, msg.sender, amount);
    }

    /// @dev Non-reverting feed read. `allowStale` lets an old (but non-zero, non-future) price through.
    function _trySpot(VaultTerms storage t, address quoteToken, bool allowStale)
        internal view returns (bool ok, uint256 spot)
    {
        try IIvyPriceFeed(t.priceFeed).spot(t.underlying, quoteToken) returns (uint256 price, uint256 updatedAt) {
            if (price == 0 || updatedAt > block.timestamp) return (false, 0);
            if (!allowStale && block.timestamp - updatedAt > t.maxPriceAge) return (false, 0);
            return (true, price);
        } catch {
            return (false, 0);
        }
    }
```

- [ ] **Step 4: Run tests**

Run: `npx hardhat test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add contracts test
git commit -m "feat: settlement with cash auto-settle, grace period and pull-based payout"
```

---

### Task 13: LP claims

Implements spec §10.

**Files:**
- Modify: `contracts/hub/IvyVaultsSettlement.sol`
- Test: `test/12-claims.test.ts`

**Interfaces:**
- Produces: `claim(uint256 vaultId, uint256 shares)`.

- [ ] **Step 1: Write the failing test**

`test/12-claims.test.ts`:
```ts
import { expect } from "chai";
import { network } from "hardhat";
import { EXERCISE_WINDOW, ExerciseStyle, Phase, SettlementType, USDC_UNIT, WETH_UNIT, deployIvy, fund, type IvyContext } from "./helpers/setup.js";
import { at, goLive, setSpot } from "./helpers/scenarios.js";

const connection = await network.create();
const { networkHelpers } = connection;

const CALL_PAYOUT_ALL = 909_090_909_090_909_090n;

describe("claim", function () {
  const fixture = () => deployIvy(connection);

  /** alice 6 WETH + bob 4 WETH, physical American call, expires unexercised. */
  async function expiredCall(ctx: IvyContext) {
    const live = await goLive(ctx, { deposit: 6n * WETH_UNIT, extraDeposits: [{ signer: ctx.bob, amount: 4n * WETH_UNIT }] });
    await at(ctx, live.bid.expiry + EXERCISE_WINDOW + 1n);
    await ctx.hub.settle(live.vaultId);
    return live;
  }

  it("expired physical call: LPs split collateral and premium pro-rata and the vault empties", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, bob } = ctx;
    const { vaultId, vaultAddress } = await expiredCall(ctx);

    const txA = hub.connect(alice).claim(vaultId, 6n * WETH_UNIT);
    await expect(txA).to.emit(hub, "Claimed").withArgs(vaultId, alice.address, 6n * WETH_UNIT);
    await expect(txA).to.changeTokenBalances(weth, [alice], [6n * WETH_UNIT]);
    await expect(txA).to.changeTokenBalances(usdc, [alice], [600n * USDC_UNIT]);

    const txB = hub.connect(bob).claim(vaultId, 4n * WETH_UNIT);
    await expect(txB).to.changeTokenBalances(weth, [bob], [4n * WETH_UNIT]);
    await expect(txB).to.changeTokenBalances(usdc, [bob], [400n * USDC_UNIT]);

    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
    expect(await usdc.balanceOf(vaultAddress)).to.equal(0n);
    expect(await hub.totalShares(vaultId)).to.equal(0n);
  });

  it("fully exercised physical call: LPs receive quote plus premium", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, bob, marketMaker } = ctx;
    const { vaultId, vaultAddress } = await goLive(ctx, { deposit: 6n * WETH_UNIT, extraDeposits: [{ signer: bob, amount: 4n * WETH_UNIT }] });
    await fund(ctx, usdc, marketMaker, vaultAddress, 30_000n * USDC_UNIT);
    await hub.connect(marketMaker).exercise(vaultId, 10n * WETH_UNIT);
    expect((await hub.stateOf(vaultId)).phase).to.equal(Phase.Settled);

    const txA = hub.connect(alice).claim(vaultId, 6n * WETH_UNIT);
    await expect(txA).to.changeTokenBalances(usdc, [alice], [18_600n * USDC_UNIT]);
    await expect(txA).to.changeTokenBalances(weth, [alice], [0n]);
    await expect(hub.connect(bob).claim(vaultId, 4n * WETH_UNIT)).to.changeTokenBalances(usdc, [bob], [12_400n * USDC_UNIT]);
    expect(await usdc.balanceOf(vaultAddress)).to.equal(0n);
  });

  it("partially exercised put: LPs receive a mixed pot", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, bob, marketMaker } = ctx;
    const { vaultId, vaultAddress, bid } = await goLive(ctx, {
      isCall: false,
      deposit: 18_000n * USDC_UNIT,
      extraDeposits: [{ signer: bob, amount: 12_000n * USDC_UNIT }],
    });
    await fund(ctx, weth, marketMaker, vaultAddress, 4n * WETH_UNIT);
    await hub.connect(marketMaker).exercise(vaultId, 4n * WETH_UNIT);
    await at(ctx, bid.expiry + EXERCISE_WINDOW + 1n);
    await hub.settle(vaultId);
    expect(await usdc.balanceOf(vaultAddress)).to.equal(19_000n * USDC_UNIT);
    expect(await weth.balanceOf(vaultAddress)).to.equal(4n * WETH_UNIT);

    const txA = hub.connect(alice).claim(vaultId, 18_000n * USDC_UNIT);
    await expect(txA).to.changeTokenBalances(usdc, [alice], [11_400n * USDC_UNIT]);
    await expect(txA).to.changeTokenBalances(weth, [alice], [24n * WETH_UNIT / 10n]);
    const txB = hub.connect(bob).claim(vaultId, 12_000n * USDC_UNIT);
    await expect(txB).to.changeTokenBalances(usdc, [bob], [7_600n * USDC_UNIT]);
    await expect(txB).to.changeTokenBalances(weth, [bob], [16n * WETH_UNIT / 10n]);
  });

  it("cash settlement excludes the market maker's pending payout", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, marketMaker } = ctx;
    const { vaultId, vaultAddress, bid } = await goLive(ctx, { withFeed: true }, { settlement: SettlementType.Cash, style: ExerciseStyle.European });
    await networkHelpers.time.increaseTo(bid.expiry - 2n);
    await setSpot(ctx, 3300n * USDC_UNIT);
    await at(ctx, bid.expiry);
    await hub.settle(vaultId);

    const tx = hub.connect(alice).claim(vaultId, 10n * WETH_UNIT);
    await expect(tx).to.changeTokenBalances(weth, [alice], [10n * WETH_UNIT - CALL_PAYOUT_ALL]);
    await expect(tx).to.changeTokenBalances(usdc, [alice], [1000n * USDC_UNIT]);
    expect(await weth.balanceOf(vaultAddress)).to.equal(CALL_PAYOUT_ALL);
    await expect(hub.connect(marketMaker).claimPayout(vaultId)).to.changeTokenBalances(weth, [marketMaker], [CALL_PAYOUT_ALL]);
    expect(await weth.balanceOf(vaultAddress)).to.equal(0n);
  });

  it("transferred shares can claim", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice, carol } = ctx;
    const { vaultId } = await expiredCall(ctx);
    await hub.connect(alice).safeTransferFrom(alice.address, carol.address, vaultId, 2n * WETH_UNIT, "0x");
    const tx = hub.connect(carol).claim(vaultId, 2n * WETH_UNIT);
    await expect(tx).to.changeTokenBalances(weth, [carol], [2n * WETH_UNIT]);
    await expect(tx).to.changeTokenBalances(usdc, [carol], [200n * USDC_UNIT]);
  });

  it("partial claims stay proportional", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, weth, usdc, alice } = ctx;
    const { vaultId } = await expiredCall(ctx);
    const first = hub.connect(alice).claim(vaultId, 3n * WETH_UNIT);
    await expect(first).to.changeTokenBalances(weth, [alice], [3n * WETH_UNIT]);
    await expect(first).to.changeTokenBalances(usdc, [alice], [300n * USDC_UNIT]);
    const second = hub.connect(alice).claim(vaultId, 3n * WETH_UNIT);
    await expect(second).to.changeTokenBalances(weth, [alice], [3n * WETH_UNIT]);
    await expect(second).to.changeTokenBalances(usdc, [alice], [300n * USDC_UNIT]);
    expect(await hub.balanceOf(alice.address, vaultId)).to.equal(0n);
  });

  it("rejects zero, too many shares and the wrong phase", async function () {
    const ctx = await networkHelpers.loadFixture(fixture);
    const { hub, alice, carol } = ctx;
    const { vaultId } = await expiredCall(ctx);
    await expect(hub.connect(alice).claim(vaultId, 0n)).to.be.revertedWithCustomError(hub, "ZeroAmount");
    await expect(hub.connect(carol).claim(vaultId, 1n)).to.be.revertedWithCustomError(hub, "InsufficientShares");
    await expect(hub.connect(alice).claim(vaultId, 7n * WETH_UNIT)).to.be.revertedWithCustomError(hub, "InsufficientShares");
    const live = await goLive(ctx);
    await expect(hub.connect(alice).claim(live.vaultId, 1n)).to.be.revertedWithCustomError(hub, "WrongPhase").withArgs(Phase.Settled, Phase.Live);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx hardhat test test/12-claims.test.ts`
Expected: fails, `claim is not a function`.

- [ ] **Step 3: Add claim to IvyVaultsSettlement.sol**

Append inside the contract, after `_trySpot`:

```solidity
    // ------------------------------------------------------------ claims (spec §10)

    /// @notice Burn `shares` and receive the same fraction of every token the vault holds
    ///         (collateral or settlement proceeds, plus premium), net of any reserved market-maker payout.
    function claim(uint256 vaultId, uint256 shares) external nonReentrant {
        _requirePhase(vaultId, Phase.Settled);
        if (shares == 0) revert ZeroAmount();
        if (balanceOf(msg.sender, vaultId) < shares) revert InsufficientShares();
        VaultState storage s = _state[vaultId];
        VaultTerms storage t = _terms[vaultId];
        uint256 supply = totalSupply(vaultId);

        address[3] memory tokens = [t.collateral, s.premiumToken, s.isCall ? s.quoteToken : t.underlying];
        uint256[3] memory amounts;
        for (uint256 i = 0; i < 3; ++i) {
            if (_seenBefore(tokens, i)) continue;
            uint256 available = IERC20(tokens[i]).balanceOf(s.vault);
            if (tokens[i] == t.collateral) available -= s.pendingPayout;
            amounts[i] = (available * shares) / supply;
        }

        _burn(msg.sender, vaultId, shares);
        IIvyVault vault = IIvyVault(s.vault);
        for (uint256 i = 0; i < 3; ++i) {
            if (amounts[i] > 0) vault.push(tokens[i], msg.sender, amounts[i]);
        }
        emit Claimed(vaultId, msg.sender, shares);
    }

    function _seenBefore(address[3] memory tokens, uint256 i) private pure returns (bool) {
        for (uint256 j = 0; j < i; ++j) {
            if (tokens[j] == tokens[i]) return true;
        }
        return false;
    }
```

- [ ] **Step 4: Run tests**

Run: `npx hardhat test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add contracts test
git commit -m "feat: pro-rata LP claims after settlement"
```

---

### Task 14: Deployment module, README, size and type checks

Implements spec §15 (Ignition module) and closes out verification.

**Files:**
- Create: `ignition/modules/IvyVaults.ts`, `README.md`

- [ ] **Step 1: Write the Ignition module**

`ignition/modules/IvyVaults.ts`:
```ts
import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SIX_HOURS = 6n * 3600n;
const THREE_DAYS = 3n * 24n * 3600n;
const SEVEN_DAYS = 7n * 24n * 3600n;

/**
 * Deploys the vault implementation, the hub implementation and an ERC1967 proxy that initializes the hub.
 * Override parameters with `--parameters` (see Hardhat Ignition docs); the admin is the deployer account.
 */
export default buildModule("IvyVaultsModule", (m) => {
  const admin = m.getAccount(0);
  const exerciseWindow = m.getParameter("exerciseWindow", SIX_HOURS);
  const auctionTimeout = m.getParameter("auctionTimeout", THREE_DAYS);
  const settlementGracePeriod = m.getParameter("settlementGracePeriod", SEVEN_DAYS);
  const uri = m.getParameter("uri", "");

  const vaultImplementation = m.contract("IvyVault");
  const hubImplementation = m.contract("IvyVaultsHub");
  const initData = m.encodeFunctionCall(hubImplementation, "initialize", [
    admin,
    vaultImplementation,
    exerciseWindow,
    auctionTimeout,
    settlementGracePeriod,
    uri,
  ]);
  const proxy = m.contract("ERC1967Proxy", [hubImplementation, initData]);
  const hub = m.contractAt("IvyVaultsHub", proxy, { id: "IvyVaultsHubProxy" });

  return { vaultImplementation, hubImplementation, proxy, hub };
});
```

- [ ] **Step 2: Smoke-deploy to the in-process network**

Run: `npx hardhat ignition deploy ignition/modules/IvyVaults.ts --network hardhatMainnet`
Expected: four deployed addresses printed (`IvyVault`, `IvyVaultsHub`, `ERC1967Proxy`, `IvyVaultsHubProxy`) with no errors. If Ignition complains that `ERC1967Proxy` is ambiguous, use the fully qualified name `"@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"` in `m.contract`.

- [ ] **Step 3: Check the hub's deployed bytecode size**

Run:
```bash
npx hardhat compile && node -e "const a=require('./artifacts/contracts/IvyVaultsHub.sol/IvyVaultsHub.json'); console.log((a.deployedBytecode.length-2)/2, 'bytes (limit 24576)')"
```
Expected: a number below 24576. If it is above, set `runs: 50` in `hardhat.config.ts`, recompile and re-check; if still above, stop and report the number before continuing.

- [ ] **Step 4: Type-check the tests**

Run: `npx tsc --noEmit`
Expected: no errors. Fix any type errors in `test/` by adjusting types (never by weakening assertions). Typical fixes: cast struct-returning views' fields with `Number(...)`/`BigInt(...)` when comparing against enum maps, and import `type` only where `verbatimModuleSyntax` demands.

- [ ] **Step 5: Write README.md**

```markdown
# Ivy Vaults

Single-use option vaults for Ivy. LPs deposit collateral, an off-chain auction picks a market maker,
the market maker's signed bid is activated on-chain, and the vault settles by physical delivery or cash.

- `contracts/IvyVaultsHub.sol` — UUPS-upgradeable hub: factory, rules, ERC-1155 share ledger, roles.
- `contracts/IvyVault.sol` — minimal clone per vault; only moves tokens on the hub's instruction.
- `contracts/interfaces/IIvyPriceFeed.sol` — price feed interface (implementation lands later).
- Design: `docs/superpowers/specs/2026-09-03-ivy-vaults-design.md`.

## Commands

    npm install
    npx hardhat compile
    npx hardhat test
    npx hardhat ignition deploy ignition/modules/IvyVaults.ts --network hardhatMainnet

Users approve the **vault** address, never the hub. Shares are ERC-1155 tokens on the hub whose id is the vault id.
```

- [ ] **Step 6: Full run**

Run: `npx hardhat test`
Expected: every test file passes (00 through 12).

- [ ] **Step 7: Commit**

```bash
git add ignition README.md hardhat.config.ts
git commit -m "chore: Ignition deployment module and README"
```
