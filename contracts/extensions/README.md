# Extensions: vol bidding and the depositor's APR floor

Two add-ons that work with the hub as deployed: neither changes the hub or needs a new release.
Separate, optional proposals to the shipped contracts are in the same commit, listed at the end; each
touches its own lines and can be taken or left alone.

## `IvyVolBidder` — delegated signing for a bidder that quotes vol

A market maker's account (ERC-1271). The desk signs a **vol surface once per asset pair**: a grid of
moneyness × time-to-expiry → the most it pays per whole underlying, in bps of the collateral's own
unit (spot for calls paid in the quote token, strike for puts, a fixed unit for premium paid in the
underlying). In those coordinates the grid is a vol quote, not a price list: spot moves and time
passes without the desk re-signing. The account then approves each final bid on the desk's behalf.

At activation the hub's `SignatureChecker` calls `isValidSignature(hash, signature)`. The signature
bytes carry the full `Bid`, the signed surface and a signed spot. The account rebuilds the hub's
EIP-712 digest and requires it to equal `hash`, checks the desk and spot keys, reads the vault's
underlying and premium token from the hub, then requires the bid's premium to sit under the surface at
that spot and that tenor. `maxPremiumPerUnit` lets the bid master compute the point with the same code.

Keys are split: owner (funds), desk signer (surfaces only), spot signer, killer (halt only).
`approveVault` is permissionless and only approves a clone the hub reports.

## `IvyAprFloorRule` — "at least X% APR" as a bid rule (kind `PremiumNetAprFloor`)

A validator for the hub's bid rules. It checks, at activation:

    premium the LPs keep  ≥  X × (expiry − now) / 365 days × collateral value

- **per tenor**: the floor follows the bid's own expiry;
- **net of the platform fee**: it reads the vault's fee rate from the hub;
- **on collateral locked**: strike for puts, not spot;
- **no price when premium and collateral share a token** (puts paid in the quote, calls paid in the
  underlying); a call paid in the quote token reads the one trusted feed. Anything it can't value is
  refused at vault creation.

This is the standalone form of `PremiumNetAprFloor`, usable on a hub as deployed with one role grant.
The same check is also proposed as a standard rule kind on this branch (below).

## Integration notes

- Both mirror the hub's ABI types (`Bid`, `BidContext`, `VaultTerms`, `PairConfig`) instead of importing
  them, so they also work against an already deployed hub. A struct change on the hub makes the typehash
  or selector stop matching and every bid fails loudly. Last checked against `4edf8d5`, and against
  this branch with every proposal below applied.
- `IvyAprFloorRule` needs `BID_VALIDATOR_ROLE` and must be in the vault's rule list at creation.
- `IvyVolBidder` needs `MARKET_MAKER_ROLE` on the account address.
- Tests are a Foundry suite run against this repo, including activations on the real hub. They are not
  in this branch because the repo is Hardhat-only; happy to share them or port them.

Licence: these files are MIT.

## Separate proposals to the shipped contracts

Not part of the extensions. Each can be taken or left alone; the only dependency is that the net floor
sits next to the gross floor's renamed kind. TypeScript tests are included where the existing
harness allows, but were not run here; each change was checked with Foundry against this tree.
`docs/site/frontend-integration.html` was edited by hand to match `docs/frontend-integration.md`:
please regenerate it with the docs build.

- **`StrikeSpotBand`: an out-of-the-money minimum** (rules contract only). The inner edge is
  `maxInTheMoneyBps`, which can't go past spot, so "at least 9% out of the money" could only be written
  as a fixed-dollar `StrikeRange` that drifts towards the money on a rally. `minOutOfTheMoneyBps` moves
  the inner edge past spot, read at activation; zero keeps today's behaviour. The config becomes a
  5-tuple.
- **`activate` → `activateOption`, `Activated` → `OptionActivated`** (**needs a new Hub release**). Read
  cold, `activate` suggests the start of the auction; the call ends it and starts the option. Plus a
  Lifecycle section in `CONTEXT.md`.
- **`PremiumYieldFloor` → `PremiumGrossAprFloor`, and a new `PremiumNetAprFloor`** (rules contract
  only). The gross floor checks premium before the fee against spot; the net floor checks what
  LPs keep against what they lock (spot for a call, the strike for a put), reading the vault's
  fee from the Hub. Same config tuple.
- **`PremiumVolFloor`: room for evidence** (rules contract only). The bid master's slot may carry
  evidence after the attested vol (for example the spot and time it was computed from); the rule still
  reads only the first word, and refuses a slot shorter than 32 bytes. The evidence is published with
  the activation in `RuleDataProvided`.
- **`frontend-integration.md`: the EIP-712 domain version is 4** (it said 3), with a note to read it
  from the Hub's `eip712Domain()`.
