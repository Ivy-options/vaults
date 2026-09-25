import { AbiCoder, id } from "ethers"
import type { AddressLike, BigNumberish, TypedDataField } from "ethers"

const fields = (entries: [name: string, type: string][]): TypedDataField[] => entries.map(([name, type]) => ({ name, type }))
/** EIP-712 types signed by market makers, buyers and the indicative feed signer. */
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
		["executor", "address"],
		["recipient", "address"],
	]),
}
export const UNWIND_TYPES = {
	UnwindAgreement: fields([
		["vaultId", "uint256"],
		["nonce", "uint256"],
		["deadline", "uint64"],
		["exercisedNotional", "uint256"],
		["supply", "uint256"],
		["refund", "uint256"],
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
	PairLimits: id("PairLimits").slice(0, 10),
	SpotBand: id("SpotBand").slice(0, 10),
	PremiumFloor: id("PremiumFloor").slice(0, 10),
}
const coder = AbiCoder.defaultAbiCoder()
export type PairLimit = readonly [quoteToken: AddressLike, strikeLimit: BigNumberish, minPremiumPerUnit: BigNumberish]
/** IvyBidRules data layouts. `data` is opaque bytes on-chain, so these are the only off-chain definitions. */
export const encodePairLimits = (limits: readonly PairLimit[]) =>
	coder.encode(["tuple(address quoteToken,uint256 strikeLimit,uint256 minPremiumPerUnit)[]"], [limits])
export const encodeSpotBand = (priceFeed: AddressLike, maxPriceAge: BigNumberish, maxInTheMoneyBps: BigNumberish) =>
	coder.encode(["tuple(address priceFeed,uint32 maxPriceAge,uint16 maxInTheMoneyBps)"], [[priceFeed, maxPriceAge, maxInTheMoneyBps]])
export const encodePremiumFloor = (priceFeed: AddressLike, maxPriceAge: BigNumberish, minPremiumBps: BigNumberish) =>
	coder.encode(["tuple(address priceFeed,uint32 maxPriceAge,uint16 minPremiumBps)"], [[priceFeed, maxPriceAge, minPremiumBps]])
