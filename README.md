# Ivy Vaults

Smart contracts for single-use covered-call and cash-secured-put vaults.

## Read the guide

Start with the [HTML protocol guide](docs/site/index.html) for how vaults work, examples, and the contract reference. For deployment and transaction commands, see the [operator runbook](docs/site/operations.html).

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

## Contract source map

`contracts/IvyVaultsHub.sol` contains the Hub's state, administration, creation,
auction, activation, settlement and claims in one file. Read the entrypoint there
alongside its permissions and phase checks; there is no protocol inheritance chain
to follow. The Hub retains OpenZeppelin access control, typed-data signing and
reentrancy protection.

Accounting responsibilities stay separate: `IvyVault` holds each vault's tokens
and reserves, `IvyShares` records ownership, `IvyPremiums` tracks premium credits,
and `IvyUnwind` tracks consent and refund contributions. Share changes update
premium rights and invalidate affected unwind consent before balances change.
Fixed linked libraries execute with the Hub's storage and authority. Separate
custody addresses segregate balances but still share the same Hub implementation.

Preserve these rules when editing: reserved payments cannot fund residual claims,
premium cannot be paid twice, and unwind requires current consent and sufficient
funding. Existing callback and conservation tests exercise these interactions.

## Edit the docs

Edit the guide and reference pages in `docs/site/`. `project-setup.html` is generated from this README; `operator-examples.html` is generated from `examples/operator/README.md`. The license page is generated from `LICENSE.md`.

After changing docs or request templates, rebuild and check:

```sh
npm run docs:build
npm run docs:check
```

## License

**Business Source License 1.1 (BUSL-1.1).** Copying, modification,
redistribution, and non-production use are permitted under the [license](LICENSE.md).
Production use requires a separate commercial license until the change to
GPL-2.0-or-later on September 14, 2030, or the fourth anniversary of this version's
first public distribution under BUSL-1.1, whichever comes first. No Additional Use
Grant is provided. Third-party material retains its own licenses.
