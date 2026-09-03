// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

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
        _requirePhase(vaultId, Phase.Auction);
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
        if (p.premiumToken == address(0)) revert PairUnknown(bid.quoteToken);
        if (!p.enabled) revert PairDisabled(bid.quoteToken);
        if (t.allowedExercise != ExercisePolicy.Either && uint8(t.allowedExercise) != uint8(bid.style)) {
            revert StyleNotAllowed();
        }
        if (t.allowedSettlement != SettlementPolicy.Either && uint8(t.allowedSettlement) != uint8(bid.settlement)) {
            revert SettlementNotAllowed();
        }
        if (bid.expiry <= block.timestamp) revert ExpiryInPast();
        if (bid.expiry - block.timestamp > t.maxTenor) revert TenorTooLong();
        _checkStrike(s.isCall, t, p, bid.quoteToken, bid.strike);
        if (bid.premium < p.minPremium) revert PremiumTooLow();

        uint256 totalNotional = IvyMath.notionalOf(s.isCall, shareToken.totalSupply(vaultId), s.underlyingUnit, bid.strike);
        if (totalNotional == 0) revert EmptyNotional();
        uint256 totalPremium = IvyMath.premiumTotal(bid.premium, totalNotional, s.underlyingUnit);

        s.marketMaker = bid.marketMaker;
        s.quoteToken = bid.quoteToken;
        s.premiumToken = p.premiumToken;
        s.strike = bid.strike;
        s.premium = bid.premium;
        s.style = bid.style;
        s.settlement = bid.settlement;
        s.expiry = bid.expiry;
        s.totalNotional = totalNotional;
        s.phase = Phase.Live;

        if (totalPremium > 0) {
            uint256 received = IIvyVault(s.vault).pull(p.premiumToken, bid.marketMaker, totalPremium);
            if (received < totalPremium) revert ShortReceived(totalPremium, received);
        }

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

    /// @dev Spec §5.1: the configured limit and, when a feed is set, the oracle band. Both must pass.
    function _checkStrike(bool isCall, VaultTerms storage t, PairTerms storage p, address quoteToken, uint256 strike)
        internal view
    {
        if (isCall) {
            if (strike < p.strikeLimit) revert StrikeBelowLimit();
        } else {
            if (strike > p.strikeLimit) revert StrikeAboveLimit();
        }
        if (t.priceFeed != address(0)) {
            uint256 bound = IvyMath.spotBound(isCall, _readSpot(t, quoteToken), t.maxSpotDeviationBps);
            if (isCall ? strike < bound : strike > bound) revert StrikeOutsideSpotBand();
        }
    }
}
