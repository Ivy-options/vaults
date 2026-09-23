import { AbiCoder, id } from 'ethers';
/** EIP-712 types signed by market makers, buyers and the indicative feed signer. */
export const BID_TYPES = {Bid:[['vaultId','uint256'],['marketMaker','address'],['quoteToken','address'],['strike','uint256'],['premium','uint256'],['style','uint8'],['settlement','uint8'],['expiry','uint64'],['validUntil','uint64'],['nonce','uint256'],['auctionId','uint256'],['collateralAmount','uint256'],['termsHash','bytes32'],['executor','address'],['recipient','address']].map(([name,type])=>({name,type}))};
export const UNWIND_TYPES = {UnwindAgreement:[['vaultId','uint256'],['nonce','uint256'],['deadline','uint64'],['exercisedNotional','uint256'],['supply','uint256'],['refund','uint256']].map(([name,type])=>({name,type}))};
export const REPORT_TYPES = {
  SpotReport:[['underlying','address'],['quote','address'],['price','uint256'],['observedAt','uint64'],['validUntil','uint64']].map(([name,type])=>({name,type})),
};
export const RULE_KIND = { PairLimits: id('PairLimits').slice(0, 10), SpotBand: id('SpotBand').slice(0, 10), PremiumFloor: id('PremiumFloor').slice(0, 10) };
const coder = AbiCoder.defaultAbiCoder();
/** IvyBidRules data layouts. `data` is opaque bytes on-chain, so these are the only off-chain definitions. */
export const encodePairLimits = limits => coder.encode(['tuple(address quoteToken,uint256 strikeLimit,uint256 minPremium)[]'],[limits]);
export const encodeSpotBand = (priceFeed,maxPriceAge,maxInTheMoneyBps) => coder.encode(['tuple(address priceFeed,uint32 maxPriceAge,uint16 maxInTheMoneyBps)'],[[priceFeed,maxPriceAge,maxInTheMoneyBps]]);
export const encodePremiumFloor = (priceFeed,maxPriceAge,minPremiumBps) => coder.encode(['tuple(address priceFeed,uint32 maxPriceAge,uint16 minPremiumBps)'],[[priceFeed,maxPriceAge,minPremiumBps]]);
