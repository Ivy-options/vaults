# Frontend integration guide

This guide explains how a frontend uses one permanent `IvyVaultsRegistry` address while continuing to support vaults created by every immutable Hub release.

The central rule is:

- Use the registry recommendation when starting a **new vault**.
- Use the vault's stored **original Hub address** for every later action.

The registry is a discovery contract. It does not proxy transactions, hold vault state or forward calls to a Hub.

```text
New vault
  configured registry
    -> recommendedVersion()
    -> hubOf(releaseId)
    -> selected Hub.createVault(...)

Existing vault
  stored (chainId, hubAddress, vaultId)
    -> original Hub.deposit/exercise/settleAtExpiry/claim(...)
```

## Addresses and release assets

Configure one trusted registry address for each supported chain. Do not discover the registry through another mutable service without verifying the result against the application's chain configuration.

The on-chain registry provides the release ID, Hub address and manifest hash. It does not store an ABI or the release bundle itself. The frontend therefore also needs a release-bundle store containing the preserved bundle for every supported release. A bundle contains the deployment manifest, deployment evidence and matching contract artifacts.

For each supported release, verify:

1. The connected chain matches the release manifest.
2. `hubOf(releaseId)` matches the Hub recorded in the bundle.
3. `manifestHashOf(releaseId)` matches the bundle hash.
4. The interface format and ABIs are supported by the frontend.
5. The deployed code and immutable module bindings match the bundle.

The reusable `resolveRelease` function in `scripts/releases.ts` performs these checks with an ethers `JsonRpcProvider` or `BrowserProvider`. A production frontend can package this resolver and load the JSON bundles from its static assets or a content-addressed release store.

## Stable identifiers

Vault IDs are local to one Hub. Release 1 and release 2 can both contain `vaultId == 1`, so `vaultId` alone is never a globally unique position identifier.

Persist at least:

```ts
export type IvyVaultReference = {
  chainId: bigint;
  registryAddress: string;
  releaseId: bigint;
  hubAddress: string;
  vaultId: bigint;
  vaultAddress: string;
};
```

Use `(chainId, hubAddress, vaultId)` as the canonical identity in URLs, database keys, caches and analytics. `releaseId` is useful metadata for finding the matching bundle and ABI. `vaultAddress` is the clone custody address and the ERC-20 approval target.

A suitable route is:

```text
/vaults/:chainId/:hubAddress/:vaultId
```

Do not build an existing-vault route containing only `vaultId`.

## Resolve the Hub for a new vault

Read the recommendation when the user begins a new-vault flow. Resolve and verify that release, then pin its Hub and release ID in the form state. Show both values in the final transaction review.

```ts
import { BrowserProvider, Contract } from "ethers";
import { resolveRelease } from "../scripts/releases.ts";

const REGISTRY_ABI = [
  "function recommendedVersion() view returns (uint256)",
  "function hubOf(uint256) view returns (address)",
  "function manifestHashOf(uint256) view returns (bytes32)",
];

export async function resolveRecommendedHub(
  provider: BrowserProvider,
  registryAddress: string,
  releaseBundles: Record<string, unknown>,
  supportedArtifacts: Record<string, unknown>,
) {
  const registry = new Contract(registryAddress, REGISTRY_ABI, provider);
  const releaseId: bigint = await registry.recommendedVersion();

  if (releaseId === 0n) throw new Error("Ivy has no recommended release on this chain");

  const releaseBundle = releaseBundles[releaseId.toString()];
  if (!releaseBundle) throw new Error(`Unsupported Ivy release ${releaseId}`);

  return resolveRelease(
    provider,
    { registry: registryAddress, releaseId, releaseBundle },
    supportedArtifacts,
  );
}
```

`resolveRelease` returns the concrete Hub, chain, registry, release ID, verified manifest hash and preserved artifacts. Instantiate the Hub with the ABI returned for that release.

Once resolution completes, do not silently switch the form to another Hub if `RecommendedVersionUpdated` is emitted. A recommendation change should apply to the next new-vault flow. If the UI offers a “refresh release” action, make the user review any values that depend on the selected release again.

## Create and fund a vault

Call `createVault` directly on the selected Hub. Calling it on `IvyVaultsRegistry` will revert because the registry has no forwarding interface.

```ts
import { Contract } from "ethers";

export async function createVault(
  signer: any,
  resolvedRelease: any,
  terms: any,
  pairs: any[],
  rules: any[],
): Promise<IvyVaultReference> {
  const hub = new Contract(
    resolvedRelease.hub,
    resolvedRelease.artifacts.IvyVaultsHub.abi,
    signer,
  );

  // Surface validation errors before opening the wallet confirmation.
  await hub.createVault.staticCall(terms, pairs, rules);

  const transaction = await hub.createVault(terms, pairs, rules);
  const receipt = await transaction.wait();

  let created: any;
  for (const log of receipt.logs) {
    try {
      const event = hub.interface.parseLog(log);
      if (event?.name === "VaultCreated") {
        created = event;
        break;
      }
    } catch {
      // The receipt may contain logs emitted by other contracts.
    }
  }

  if (!created) throw new Error("VaultCreated event missing from receipt");

  return {
    chainId: BigInt(resolvedRelease.chainId),
    registryAddress: resolvedRelease.registry,
    releaseId: BigInt(resolvedRelease.releaseId),
    hubAddress: resolvedRelease.hub,
    vaultId: created.args.vaultId,
    vaultAddress: created.args.vault,
  };
}
```

Treat the mined `VaultCreated` event as the authoritative identity. A `staticCall` preview can become stale if another vault is created before the user's transaction is mined.

After creation, approve collateral to the emitted clone address and deposit through the original Hub:

```ts
const ERC20_ABI = ["function approve(address,uint256) returns (bool)"];
const collateralToken = new Contract(terms.collateral, ERC20_ABI, signer);

await (await collateralToken.approve(reference.vaultAddress, depositAmount)).wait();

const hub = new Contract(
  reference.hubAddress,
  resolvedRelease.artifacts.IvyVaultsHub.abi,
  signer,
);
await (await hub.deposit(reference.vaultId, depositAmount)).wait();
await (await hub.openAuction(reference.vaultId)).wait();
```

The spender is `vaultAddress`. Never approve the registry or Hub to spend collateral. A direct `IvyVault.deposit(amount)` is also supported, but the same clone approval is required.

## Open an existing vault

When opening an existing position, start from its stored reference. Do not call `recommendedVersion()` to select its Hub.

1. Confirm that the wallet is connected to `reference.chainId`.
2. Load the bundle and ABI for `reference.releaseId`.
3. Verify that the registry still returns `reference.hubAddress` for that release. Registrations are permanent, so a mismatch is an integration or configuration error.
4. Instantiate `IvyVaultsHub` at `reference.hubAddress`.
5. Read `stateOf(reference.vaultId)`, `termsOf(reference.vaultId)`, `rulesOf(reference.vaultId)`, `termsHashOf(reference.vaultId)` and `vaultOf(reference.vaultId)`.
6. Send deposits, auction actions, exercise, expiration and claims to that original Hub.

The current recommendation may point to a newer Hub. That has no effect on the existing vault's terms, modules, balances or claim paths.

## Show a vault's bid rules

A vault stores a list of bid rules chosen by its creator and frozen at creation. Each rule is a validator address, a `bytes4` kind and opaque data. Read them with `rulesOf(vaultId)`. Since `ivy-vaults-v5`, a Hub accepts a validator only while it has the Hub's `keccak256("BID_VALIDATOR_ROLE")`; the initial deployment grants that role to the shipped `IvyStandardBidRules` contract. Governance must review any additional validator before granting the role.

- Label each rule by `(validator, kind)`. The release manifest's `addresses.IvyStandardBidRules` is the shipped validator; its kinds are `StrikeRange`, `StrikeSpotBand`, `PremiumMin`, `PremiumSpotFloor`, `PremiumYieldFloor`, `PremiumVolFloor`, `ExpiryTenor` and `ExpiryDates`, with ids `bytes4(keccak256(name))`. Each kind is named for the bid field it bounds: strike, premium or expiry. Its StrikeSpotBand and quote-denominated PremiumSpotFloor and PremiumYieldFloor rules accept only the release's `IvyPriceFeed`.
- Decode shipped data with these ABI types:
  - StrikeRange `tuple(address quoteToken,uint256 minStrike,uint256 maxStrike)[]`, one entry per pair, with `0 < minStrike <= maxStrike` for calls and puts.
  - StrikeSpotBand `tuple(address priceFeed,uint32 maxPriceAge,uint16 maxInTheMoneyBps,uint32 maxOutOfTheMoneyBps)`. The out-of-the-money bound caps call strikes at `spot × (1 + bps)` and floors put strikes at `spot × (1 − bps)`; a put bound of 10,000 or more sets no floor.
  - PremiumMin `tuple(address quoteToken,uint256 minPremiumPerUnit)[]`, one entry per pair, with `minPremiumPerUnit > 0` in premium-token units per whole underlying.
  - PremiumSpotFloor `tuple(address priceFeed,uint32 maxPriceAge,uint16 minPremiumBps)`.
  - PremiumYieldFloor `tuple(address priceFeed,uint32 maxPriceAge,uint16 minAprBps)`: `premiumPerUnit >= spot × minAprBps / 10,000 × (expiry − activation) / 365 days`.
  - ExpiryTenor `tuple(uint64 minTenor,uint64 maxTenor)`: `activation + minTenor <= expiry <= activation + maxTenor`, in seconds.
  - ExpiryDates `tuple(uint64 notBefore,uint64 notAfter)`: absolute Unix timestamps, inclusive.
  - PremiumVolFloor `uint32 minVolBps`, annualized, 10,000 = 100%. Its bid-master slot is `uint32 impliedVolBps`.
- Any other validator address is governance-allowlisted custom code. Show it as such and do not attempt to decode its data. Revoking its role blocks new vaults from adopting it but does not alter rules already stored by existing vaults.
- Every vault must include a `StrikeRange` rule and a `PremiumMin` rule, each with an entry for every pair, and at least one `ExpiryTenor` or `ExpiryDates` rule. Creation rejects a missing rule with `MissingStrikeRange`, `MissingPremiumMin` or `MissingExpiryRule`. The Hub matches these requirements by kind and never reads their values. Additional rules are optional. The mandatory activation checks also reject expiries not in the future, zero strikes, zero notionals and premiums whose total rounds to zero. These bounds are creator-chosen, so the bid master must still reject economically unreasonable bids and the UI must display the exact values before deposits.
- A vault has no expiry until activation. `stateOf(vaultId).expiry` is zero before then, `settlementStatus` returns zero deadlines and `settleAtExpiryTimeOf` returns zero. Show the expiry rules instead, and read the chosen expiry from `Activated` or `stateOf` once Live. An auction never unlocks at an expiry: LPs exit through the auction timeout, an admission pause or a bid master cancellation, even after an `ExpiryDates` rule's last date has passed.
- Flag `PremiumVolFloor`, and any custom rule documented as reading `bidMasterData`, as trusting the bid master: that check is only as good as the bid master's attestation.

The guide's [Bid rules](site/index.html#bid-rules) section explains what each kind checks, its errors, common combinations and what future validators can add.

Bids commit to `termsHashOf(vaultId)`, the hash of the creator's terms, pairs and rules. Fill `termsHash` from that view when building a bid to sign. Protocol settings snapshotted at creation are not in the hash: read `exerciseWindow`, `auctionTimeout` and `expiryPricePublicationWindow` from `stateOf(vaultId)`, and the fee rate from `vaultPlatformFeeBps(vaultId)`, before quoting.

## Pass rule data at activation

A rule's id is its index in `rulesOf(vaultId)`. The bid master calls `activate(vaultId, bid, marketMakerData, signature, bidMasterData)`. Each `bytes[]` is either empty, meaning no data for any rule, or holds exactly one slot per rule; any other length reverts with `RuleDataLengthMismatch(expected, actual)`. Slot `i` reaches rule `i` only, as the `marketMakerData` or `bidMasterData` argument of `validateBid`, so adding a rule never changes how another rule decodes its input. Use `0x` for rules that take nothing.

- `marketMakerData` is the market maker's. The bid signs `marketMakerDataHash = keccak256(abi.encode(marketMakerData))` as an ABI-encoded `bytes[]`; an empty array still has a hash. A bid master that alters, reorders or drops these slots fails with `CommitmentMismatch`. Validators treat these slots as the counterparty's claim, never as a market fact.
- `bidMasterData` is the bid master's and is not signed. It carries attestations a rule cannot compute on-chain, such as a bid's implied volatility for `PremiumVolFloor`.
- When either array is non-empty, activation emits `RuleDataProvided(vaultId, marketMakerData, bidMasterData)`. Index it next to `Activated` so LPs can audit what the bid master attested.

## Discover every historical vault

The registry does not expose an array of releases. Index its events instead:

1. Read `VersionRegistered(releaseId, hub, manifestHash)` from the registry deployment block onward.
2. Persist every registered release. Registrations cannot be removed or replaced.
3. For each Hub, read `VaultCreated(vaultId, vault, owner, kind, underlying, collateral)` from that release's deployment block onward.
4. Key the indexed record by `(chainId, hubAddress, vaultId)`.
5. Use `RecommendedVersionUpdated` to update the default shown in the new-vault flow.

The index may run in the browser for small deployments. A backend indexer or subgraph is preferable once event history grows. The indexer should handle chain reorganizations by waiting for the application's chosen confirmation depth and replaying a small block range when advancing its cursor.

For a user's portfolio, query ERC-1155 balances from the share-token contract belonging to each release. The share token ID is the Hub-local vault ID, so its contract address is also part of the balance identity.

## Transactions and signatures

Every wallet transaction must display and target the concrete contract that will execute it:

| Action | Transaction target |
| --- | --- |
| Discover recommended release | Registry read |
| Create, deposit, open auction, exercise, settle at expiry or claim | Original Hub |
| Approve collateral or premium | ERC-20 token, with the clone as spender |
| Direct deposit or platform-fee claim | Vault clone |
| Read or transfer shares | Release-specific `IvyShares` contract |

Typed signatures also bind to the concrete immutable deployment:

- Bid domain: `name = IvyVaultsHub`, `version = 3` for this release (`2` for `ivy-vaults-v3` Hubs), connected `chainId`, `verifyingContract = hubAddress`.

A registry release ID is not an EIP-712 version. Never rebuild an existing bid signature against the current recommendation.

## Auction exits and final claims

An auction becomes cancellable by anyone when the saved auction timeout elapses, the option expires, or admission is paused for the vault or globally. The bid master may cancel sooner. Once any public cancel condition holds, an LP may also call `withdraw(vaultId, shares)` directly while the vault remains in Auction. Cancelling and reopening does not restart the original timeout clock, so an owner cannot hide the LP exit window inside one block.

### Choosing tokens with claimTo

After settlement, `claim(vaultId, shares)` burns the caller's shares and sends their proportional share of every claimable token to the caller. `claimTo(vaultId, shares, recipient, tokenMask)` burns the caller's shares and sends the selected tokens to one nonzero `recipient`. The recipient does not need to hold shares. Each payout uses the token's vault balance minus its reserves, multiplied by `shares / totalSupply` before the burn, rounded down.

If a token rejects transfers to the holder's address, first try `claimTo(vaultId, shares, recipient, 7)` with a recipient that can receive all the tokens. Mask `7` requests every token. It changes the destination without changing the entitlement or swapping tokens. A failed transfer reverts the entire transaction, including the share burn.

Build `tokenMask` by adding the values for the token roles to include:

| Value | Bit | Token selected |
| --- | --- | --- |
| `1` | 0 | Collateral: underlying for calls, quote for puts. |
| `2` | 1 | Premium token: only the unreserved balance. Earned premium remains a separate `claimPremium` claim. |
| `4` | 2 | Physical-exercise proceeds: quote for calls, underlying for puts. |

For example, `7 = 1 + 2 + 4` selects all roles; `1` selects only collateral. Valid masks are `1` through `7`. Roles can share a token address. Selecting any role for an address includes the holder's proportional share of that token's entire unreserved balance, paid once. To skip a token, omit every role that uses its address.

Suppose a call uses WETH collateral and USDC for both premium and quote. The shares being redeemed entitle the holder to 2 WETH and 6,000 USDC. Mask `7` sends both amounts to the recipient. If USDC cannot be transferred, mask `1` requests only the 2 WETH and omits both USDC roles. On success, all the requested shares are burned and the holder permanently gives up the 6,000 USDC attributable to those shares. That USDC stays in the vault for any remaining shares. If no shares remain, no LP can recover it through this function.

Show forfeiture as an explicit choice with the skipped token and amount. It does not defer payment: burned shares cannot be used to claim the skipped tokens later. Reserved premium, treasury obligations and buyer payouts remain protected under every mask.

## Cash expiry fallback

For this release, creation snapshots `expiryPricePublicationWindow` (`P`) and `exerciseWindow` (`W`). Show both to depositors before funding and to buyers before signing. The final-price publication deadline is `D = expiry + P`; the physical fallback deadline is `F = D + W`. Cash-capable vaults require positive values. Settings changes affect only new vaults. A signed bid binds the immutable fallback terms through its Hub and vault identity. The expiry these deadlines count from is the one the winning bid chose.

Use `settlementStatus(vaultId)` to read `(route, publicationDeadline, fallbackDeadline, canSettleAtExpiry)` even if no one has transacted since expiry. Routes are `Physical = 0`, `Cash = 1`, `AwaitingExpiryPrice = 2`, `PhysicalFallback = 3`, `FallbackExpired = 4`, `Inactive = 5`. The last covers positions outside Live. `stateOf(vaultId).settlement` preserves the originally agreed settlement type. `settleAtExpiryTimeOf(vaultId)` returns expiry for cash with an accepted final price, `F` for cash without one, `expiry + W` for an originally physical position, and zero before activation. Read `canSettleAtExpiry` as well as the timestamp; a settled vault cannot be settled again.

| Time / report | Action |
| --- | --- |
| Before expiry | Existing exercise rules; missing American observations never enable fallback. |
| Expiry through strictly before `D`, no final price | Wait for publication; cash settlement cannot calculate a payoff. |
| Final price accepted before `D` | Cash exercise or `settleAtExpiry` uses that price, including after `F`; no physical fallback. |
| `D <= now < F`, no final price | Buyer or executor explicitly calls `exercisePhysicalFallback(vaultId, amount)`. |
| `now >= F`, no final price | Anyone calls `settleAtExpiry(vaultId)`; unexercised notional lapses and LP claims open. |

The same fallback applies to American and European cash options. It requires no separate activation transaction and never resets the deadlines. Ordinary `exercise` cannot turn into physical delivery while pending. Before explicit fallback, display the full payment: calls deliver quote at the strike (rounded up); puts deliver underlying and receive quote at the strike (rounded down). The exerciser approves the clone as spender. Inspect balance, allowance, authorized caller, recipient, remaining notional and the partial-exercise policy. Physical delivery does not require an oracle or an in-the-money check, and the buyer may decline it. LP recovery at `F` does not depend on buyer funding, a callback or publisher recovery.

Track `PhysicalFallbackExercised` and `PhysicalFallbackExpired` alongside normal exercise/settlement events. The expiration event reports lapsed notional; it must not be displayed as an exercised amount. Cash reserves already earned remain excluded from LP claims. Read `settlementStatus` for the route and deadlines before offering `exercisePhysicalFallback`.

This build uses interface format `ivy-vaults-v7` and deployment manifest 10. Relative to `ivy-vaults-v6`, vaults no longer fix an expiry at creation: `VaultTerms` drops `expiry` and the `termsHash` encoding drops it too, the winning bid chooses the expiry within the vault's required ExpiryTenor or ExpiryDates rules, `openAuction` no longer checks an expiry, and auctions no longer unlock at one. `activate` takes per-rule `marketMakerData` and `bidMasterData` arrays, the signed Bid adds `marketMakerDataHash` after `termsHash`, `IIvyBidValidator.validateBid` receives each rule's config and its two data slots, and the Hub emits `RuleDataProvided`. The shipped validator names each rule kind for the bid field it bounds: PairLimits splits into StrikeRange and PremiumMin, SpotBand becomes StrikeSpotBand and gains `maxOutOfTheMoneyBps`, PremiumFloor becomes PremiumSpotFloor, and PremiumYieldFloor, PremiumVolFloor, ExpiryTenor and ExpiryDates are new. Creation requires StrikeRange, PremiumMin and an expiry rule, and `MissingBidLimits` becomes `MissingStrikeRange` and `MissingPremiumMin`. The signed Bid and EIP-712 domain version are `4`. `ivy-vaults-v6`, relative to `ivy-vaults-v5`, removed the consensual unwind (the `IvyUnwind` contract, the Hub's unwind proposal, approval, funding, execution and preview functions, the `unwind()` getters and the `Unwound` event), dropped the unwind address from the Hub and `IvyShares` constructors, made `PayoutClaimed` report a single collateral amount, and renamed the shipped validator `IvyBidRules` to `IvyStandardBidRules`, so its manifest key is `addresses.IvyStandardBidRules`. `ivy-vaults-v5` added, relative to `ivy-vaults-v4`, `claimTo`, permissionless timed-out auction exits, expiry-bounded unwinds, per-vault-only share supply, validator allowlisting, a release-bound `IvyPriceFeed`, stricter mandatory bid checks and the shipped `IvyBidRules` address in the Hub constructor. Preserve prior interfaces and adapters for old positions. No in-place upgrade, migration or retroactive fix is provided.

## Recommendation changes

When the registry administrator recommends a new release:

- A newly opened creation flow resolves the new Hub.
- A creation form that already pinned a Hub keeps that selection through signing and confirmation.
- Existing vault pages keep their stored original Hub.
- Historical indexing continues to include every registered release.
- The frontend must have the new release bundle and interface adapter before presenting it as supported.

If the registry recommends an interface the frontend does not support, disable new-vault creation with a clear “frontend update required” message. Continue serving existing vaults through their preserved release adapters.

## Failure handling

Handle these cases explicitly:

- `recommendedVersion() == 0`: new-vault creation is unavailable on this chain.
- Missing bundle or unsupported interface format: do not guess an ABI or substitute the current ABI.
- Registry/bundle Hub mismatch: stop before transaction preparation.
- Wallet chain mismatch: request the correct network before reads, signatures or transactions.
- Recommendation changes during a prepared flow: keep the pinned Hub and show it in the confirmation screen.
- Unknown existing position: require its original Hub or release reference; do not search only the recommended Hub.
- RPC log limits: index releases and vault events in bounded block ranges.

## Integration checklist

- Configure one registry address per chain.
- Preserve every supported release bundle and ABI adapter.
- Resolve the recommendation only for new-vault creation.
- Persist `(chainId, hubAddress, vaultId)` after `VaultCreated`.
- Approve the vault clone, never the registry or Hub.
- Index all `VersionRegistered` and per-Hub `VaultCreated` events.
- Route existing actions and signatures to the original Hub release.
- Fail closed on missing bundles, mismatched hashes and unsupported interfaces.
- Show the selected release ID and Hub before the wallet signs.

See the [release deployment and registration guide](site/releases.html) and the [protocol Guide](site/index.html#execution-permissions) for the administrative workflows.
