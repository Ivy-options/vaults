# Ivy Vaults

Option vaults where LPs pool collateral, a bid master auctions the option and the winning bid's buyer pays a premium. This glossary fixes the words used for the vault's lifecycle and bid rules.

## Lifecycle

**Activation**:
The bid master's `activateOption` call that ends the auction and starts the option: the Hub checks the winning bid and its rules, collects the premium, and the vault goes Live. Anything checked "at activation" reads the chain at that call's block, not when the auction opened or closed off-chain.
_Avoid_: Auction start, auction open

## Bid rules

**Bid rule**:
A creator-chosen check on the winning bid, fixed at vault creation. Each rule kind is named for the bid field it bounds first (Strike, Premium or Expiry), then for how it bounds it.
_Avoid_: Bid limit, pair limit

**Strike rule**:
A bid rule that bounds the bid's strike: `StrikeRange` (absolute, per pair) or `StrikeSpotBand` (relative to spot).

**Premium rule**:
A bid rule that bounds the bid's premium per whole underlying token: `PremiumMin` (absolute, per pair), `PremiumSpotFloor` (share of spot), `PremiumGrossAprFloor` (annual rate of spot, before the platform fee), `PremiumNetAprFloor` (annual rate of the collateral locked, after the platform fee) or `PremiumVolFloor` (attested implied volatility).
_Avoid_: Premium floor, for the absolute per-pair minimum

**Expiry rule**:
A bid rule that bounds the bid's expiry: `ExpiryTenor` (a duration after activation) or `ExpiryDates` (between two calendar dates).
_Avoid_: Tenor range, expiry window

**Tenor**:
The time from activation to expiry.

**Required rules**:
The rules every vault must list: one `StrikeRange`, one `PremiumMin` and at least one expiry rule.
_Avoid_: Bid limits, mandatory limits
