# Ivy Vaults

Smart contracts for single-use covered-call and cash-secured-put vaults.

## Read the guide

Start with the [lifecycle map](docs/site/index.html), a single zoomable page covering how vaults work, interactive examples and cash settlement pricing. Deploying a Hub suite, running vaults by hand, the release registry and the request templates live on their own reference pages, linked from the map's "Project" station (see "Reference pages" below).

Open `docs/site/index.html` directly in your browser. To serve the docs locally, run this from the repository root:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory docs/site
```

Then visit `http://localhost:8000`. The documentation works offline and needs no build step to read.

## Build and verify

Use Node.js 22.13.0 or newer on an even-numbered release. From the repository root:

```sh
npm ci
npm run compile
npm run typecheck
npm test -- --no-compile
```

Compilation also checks deployed contract sizes. Tests run on a local simulated EVM.

To run one test file, for example the deployment and settlement rehearsal:

```sh
npm test -- test/17-local-rehearsal.test.ts
```

## Solidity style

The contracts follow the Solidity style guide (`https://docs.soliditylang.org/en/latest/style-guide.html`).

- Use four spaces, a 120-character line target, and braces for control-flow bodies.
- Keep imports sorted and separate declarations with blank lines.
- Order contract members: using directives, enums, structs, constants, immutables, storage, events, errors, modifiers, then functions.
- Sort events and errors alphabetically within each contract or interface.
- Order functions: constructor, receive/fallback, external, public, internal, private; put view and pure functions last within each visibility group.
- Preserve storage-variable order, struct-field order, enum values, inheritance order, and modifier execution order during style changes.

Install Foundry (`https://getfoundry.sh/introduction/installation/`) to use the formatter (validated with Forge 1.7.1). Hardhat remains the compiler and test runner.

```sh
npm run format:solidity
npm run format:solidity:check
```

Formatting is configured in `foundry.toml`. Declaration ordering and control-flow braces are review conventions; the formatter does not enforce them. After editing downloadable Solidity examples, run `npm run docs:build` to refresh the guide's source copies.

## Edit the docs

Edit the map and its hand-written content directly in `docs/site/`. One region of the map is generated: the project-setup station from this README. The operator request examples and license pages are generated from `examples/operator/README.md` and `LICENSE.md`.

After changing docs or request templates, rebuild, check, and test:

```sh
npm run docs:build
npm run docs:check
npm run docs:test
```

## Reference pages

Deploying a Hub suite, running vaults by hand, and the permanent release registry each have their own standalone reference page, kept out of the interactive map so their long command sequences and tables read as ordinary documents.

- [Operator runbook](docs/site/operations.html): deploying an immutable Hub suite and running individual vaults by hand.
- [Operator request examples](docs/site/operator-examples.html): copyable request templates for every runbook command.
- [Release registry specification](docs/site/registry-specification.html): the permanent registry contract and what it does and does not guarantee.
- [Releases and integration](docs/site/releases.html): deploying the registry, registering and recommending releases, and integrating a frontend.

## License

**Business Source License 1.1 (BUSL-1.1).** Copying, modification,
redistribution, and non-production use are permitted under the [license](LICENSE.md).
Production use requires a separate commercial license until the change to
GPL-2.0-or-later on September 14, 2030, or the fourth anniversary of this version's
first public distribution under BUSL-1.1, whichever comes first. No Additional Use
Grant is provided. Third-party material retains its own licenses.
