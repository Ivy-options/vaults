import { AbiCoder, id, keccak256 } from "ethers"
import type { AddressLike, BigNumberish, TypedDataField } from "ethers"

const fields = (entries: [name: string, type: string][]): TypedDataField[] => entries.map(([name, type]) => ({ name, type }))
/** EIP-712 types signed by market makers and the indicative feed signer. */
export const BID_TYPES = {
	Bid: fields([
		["vaultId", "uint256"],
		["marketMaker", "address"],
		["quoteToken", "address"],
		["strike", "uint256"],
		["premiumPerUnit", "uint256"],
		["style", "uint8"],
		["settlement", "uint8"],
		["expiry", "uint64"],
		["validUntil", "uint64"],
		["nonce", "uint256"],
		["auctionId", "uint256"],
		["collateralAmount", "uint256"],
		["termsHash", "bytes32"],
		["marketMakerDataHash", "bytes32"],
		["executor", "address"],
		["recipient", "address"],
	]),
}
export const REPORT_TYPES = {
	SpotReport: fields([
		["underlying", "address"],
		["quote", "address"],
		["price", "uint256"],
		["observedAt", "uint64"],
		["validUntil", "uint64"],
	]),
}
export const RULE_KIND = {
	StrikeRange: id("StrikeRange").slice(0, 10),
	StrikeSpotBand: id("StrikeSpotBand").slice(0, 10),
	PremiumMin: id("PremiumMin").slice(0, 10),
	PremiumSpotFloor: id("PremiumSpotFloor").slice(0, 10),
	PremiumYieldFloor: id("PremiumYieldFloor").slice(0, 10),
	PremiumVolFloor: id("PremiumVolFloor").slice(0, 10),
	ExpiryTenor: id("ExpiryTenor").slice(0, 10),
	ExpiryDates: id("ExpiryDates").slice(0, 10),
}
const coder = AbiCoder.defaultAbiCoder()
/** What a bid signs as `marketMakerDataHash`: one slot per rule, or none at all. */
export const hashMarketMakerData = (marketMakerData: readonly string[]) => keccak256(coder.encode(["bytes[]"], [marketMakerData]))
export type StrikeRange = readonly [quoteToken: AddressLike, minStrike: BigNumberish, maxStrike: BigNumberish]
export type PremiumMin = readonly [quoteToken: AddressLike, minPremiumPerUnit: BigNumberish]
/** IvyStandardBidRules data layouts. `data` is opaque bytes on-chain, so these are the only off-chain definitions. */
export const encodeStrikeRange = (ranges: readonly StrikeRange[]) =>
	coder.encode(["tuple(address quoteToken,uint256 minStrike,uint256 maxStrike)[]"], [ranges])
export const encodePremiumMin = (mins: readonly PremiumMin[]) => coder.encode(["tuple(address quoteToken,uint256 minPremiumPerUnit)[]"], [mins])
export const encodeStrikeSpotBand = (
	priceFeed: AddressLike,
	maxPriceAge: BigNumberish,
	maxInTheMoneyBps: BigNumberish,
	maxOutOfTheMoneyBps: BigNumberish,
) =>
	coder.encode(
		["tuple(address priceFeed,uint32 maxPriceAge,uint16 maxInTheMoneyBps,uint32 maxOutOfTheMoneyBps)"],
		[[priceFeed, maxPriceAge, maxInTheMoneyBps, maxOutOfTheMoneyBps]],
	)
export const encodePremiumSpotFloor = (priceFeed: AddressLike, maxPriceAge: BigNumberish, minPremiumBps: BigNumberish) =>
	coder.encode(["tuple(address priceFeed,uint32 maxPriceAge,uint16 minPremiumBps)"], [[priceFeed, maxPriceAge, minPremiumBps]])
export const encodePremiumYieldFloor = (priceFeed: AddressLike, maxPriceAge: BigNumberish, minAprBps: BigNumberish) =>
	coder.encode(["tuple(address priceFeed,uint32 maxPriceAge,uint16 minAprBps)"], [[priceFeed, maxPriceAge, minAprBps]])
export const encodeExpiryTenor = (minTenor: BigNumberish, maxTenor: BigNumberish) =>
	coder.encode(["tuple(uint64 minTenor,uint64 maxTenor)"], [[minTenor, maxTenor]])
export const encodeExpiryDates = (notBefore: BigNumberish, notAfter: BigNumberish) =>
	coder.encode(["tuple(uint64 notBefore,uint64 notAfter)"], [[notBefore, notAfter]])
/** PremiumVolFloor config. Volatility is annualized in basis points: 10_000 is 100%. */
export const encodePremiumVolFloor = (minVolBps: BigNumberish) => coder.encode(["uint32"], [minVolBps])
/** PremiumVolFloor bid-master attestation for one bid. */
export const encodeImpliedVolAttestation = (impliedVolBps: BigNumberish) => coder.encode(["uint32"], [impliedVolBps])
