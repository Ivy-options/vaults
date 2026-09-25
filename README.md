# Ivy Vaults

Smart contracts for single-use covered-call and cash-secured-put vaults.

## Read the guide

Start with the [HTML protocol guide](docs/site/index.html) for how vaults work and interactive examples. The documentation opens in Guide view; use the Guide / Map toggle to explore the lifecycle spatially.

Open `docs/site/index.html` directly in your browser. To serve the docs locally, run this from the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory docs/site
```

Then visit `http://localhost:8000`. The documentation works offline and needs no build step to read.

Frontend developers can use the [frontend integration guide](docs/frontend-integration.md) for release selection and routing transactions to each vault's original Hub.

## Build and verify

Use Node.js 22.13.0 or newer on an even-numbered release. From the repository root:

```sh
npm ci
npm run compile
npm run typecheck
npm test -- --no-compile
```

Compilation also checks deployed contract sizes. Tests run on a local simulated EVM.

To run one test file, or only the tests whose titles match a pattern:

```sh
npm test -- test/hub/physical-fallback.test.ts
npm test -- --grep "physical fallback"
```

## Solidity style

The contracts follow the Solidity style guide (`https://docs.soliditylang.org/en/latest/style-guide.html`).

- Use braces for control-flow bodies.
- Keep imports sorted and separate declarations with blank lines.
- Order contract members: using directives, enums, structs, constants, immutables, storage, events, errors, modifiers, then functions.
- Sort events and errors alphabetically within each contract or interface.
- Order functions: constructor, receive/fallback, external, public, internal, private; put view and pure functions last within each visibility group.
- Preserve storage-variable order, struct-field order, enum values, inheritance order, and modifier execution order during style changes.

Prettier formats the contracts with `prettier-plugin-solidity` (tabs, 150-character lines), both through `npm run format` and on every commit. The list above is for review; Prettier does not enforce it. After editing downloadable Solidity examples, run `npm run docs:build` to refresh the guide's source copies.

## TypeScript style

Scripts and tests are TypeScript that Node runs directly. Prettier formats them (`.prettierrc.yml`: tabs, no semicolons, 150-character lines, sorted imports), and the pre-commit hook formats staged files automatically:

```sh
npm run format
npm run format:check
```

## Tests

Tests live in `test/`, grouped by what they cover:

- `test/hub/`: the Hub, one file per entrypoint or feature (`create-vault`, `activate`, `exercise`, `expire`, `claim`, `unwind`, `physical-fallback`, …).
- `test/contracts/`: contracts and libraries on their own (`IvyVault`, `IvyShares`, `IvyPremiums`, `IvyUnwind`, `IvyBidRules`, `IvyPriceFeed`, `IvyMath`, `BidHash`, `ExampleSettlementPublisher`).
- `test/deployment/`: deployment plans, linked libraries and the release registry.
- `test/properties/`: reentrancy, cross-module callbacks and stateful conservation.
- `test/helpers/`: deployment, fixtures, scenarios and signing.

A file's top-level `describe` names what it tests: an entrypoint, a contract or a feature. A `context` names the state its tests run in, and each `it` checks one behaviour:

```ts
const connection = await network.create();
const deployed = fixture(connection, () => deployIvy(connection));
const cashPut = fixture(deployed, async c => ({
	c,
	v: await goLive(c, { isCall: false, withFeed: true }, { settlement: SettlementType.Cash }),
}));

describe("expire", () => {
	let c: IvyContext;
	let v: LiveVault;

	context("cash put", () => {
		beforeEach(async () => {
			({ c, v } = await cashPut());
		});

		it("reserves the in-the-money payout in the quote token", async () => {
			// ...
		});
	});
});
```

`fixture` from `test/helpers/setup.ts` builds its state once and snapshots it. Later loads revert to that snapshot, so every test starts from the same state and passes on its own. A fixture built from a connection starts from the chain's genesis, and one built from another fixture starts from that fixture's state, so one chain per file covers every scenario. Create fixtures at module scope or while defining a `describe`, never inside a hook or a test.

Measure coverage with:

```sh
npm run coverage
```

The report lands in `coverage/html`. Instrumented bytecode is larger than EIP-170 allows, and deployment plans refuse it by design, so suites that build deployment plans call `skipUnderCoverage()` and show as pending. Coverage also writes instrumented artifacts: run `npm test` or `npm run compile` before using `--no-compile` again.

## Edit the docs

Edit the guide and reference pages in `docs/site/`. `project-setup.html` is generated from this README. The frontend integration page is generated from `docs/frontend-integration.md`; the license page is generated from `LICENSE.md`.

After changing docs or request templates, rebuild, check, and test:

```sh
npm run docs:build
npm run docs:check
npm run docs:test
```

`docs:check` and `docs:test` cover Guide and Map modes in `docs/site/index.html`.

## License

**Business Source License 1.1 (BUSL-1.1).** Copying, modification,
redistribution, and non-production use are permitted under the [license](LICENSE.md).
Production use requires a separate commercial license until the change to
GPL-2.0-or-later on September 14, 2030, or the fourth anniversary of this version's
first public distribution under BUSL-1.1, whichever comes first. No Additional Use
Grant is provided. Third-party material retains its own licenses.
