// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IvyVaultRules} from "../libraries/IvyVaultRules.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
        _admission(vaultId);
        _requirePhase(vaultId, Phase.Auction);
        if (bid.settlement == SettlementType.Cash) _requireCashSettlementEnabled();
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
        uint256 supply = shareToken.totalSupply(vaultId);
        IvyVaultRules.validateBid(s, t, p, bid, supply);

        uint256 totalNotional = IvyMath.notionalOf(s.isCall, supply, s.underlyingUnit, bid.strike);
        if (totalNotional == 0) revert EmptyNotional();
        uint256 totalPremium = IvyMath.premiumTotal(bid.premium, totalNotional, s.underlyingUnit);

        s.marketMaker = bid.marketMaker;
        s.executor = bid.executor;
        s.recipient = bid.recipient;
        s.quoteToken = bid.quoteToken;
        s.premiumToken = p.premiumToken;
        s.strike = bid.strike;
        s.premium = bid.premium;
        s.style = bid.style;
        s.settlement = bid.settlement;
        s.expiry = bid.expiry;
        s.totalNotional = totalNotional;
        s.phase = Phase.Live;

        uint16 feeRate = platformFeeBps;
        if (feeRate > maxPlatformFeeBps[vaultId]) revert PlatformFeeAboveCap();
        address treasury = platformTreasury;
        uint256 fee = Math.mulDiv(totalPremium, feeRate, 10_000);
        platformFees[vaultId] = PlatformFee(feeRate, treasury, fee);
        premiums.activate(vaultId, s.vault, totalPremium - fee, supply);
        IIvyVault(s.vault).collectPremium(p.premiumToken, bid.marketMaker, totalPremium, fee, treasury);
        emit PlatformFeeAllocated(vaultId, treasury, feeRate, fee);

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

}
