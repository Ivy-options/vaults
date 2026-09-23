// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IIvyBidValidator} from "../interfaces/IIvyBidValidator.sol";
import "../types/IvyTypes.sol";
import {IvyMath} from "./IvyMath.sol";

/// @notice Linked vault validation: creation inputs, the mandatory bid checks, and the creator's bid rules.
/// @dev Storage references address the calling hub under DELEGATECALL. No configurable target or independent state.
///      Validators are reached through STATICCALL (view interface calls) and their reverts bubble unchanged.
library IvyVaultRules {
    function validateTerms(VaultTerms calldata t, PairConfig[] calldata pairs) external view {
        if (t.underlying == address(0) || t.collateral == address(0)) {
            revert ZeroAddress();
        }
        if (t.expiry <= block.timestamp) {
            revert ExpiryInPast();
        }
        bool isCall = t.collateral == t.underlying;
        if (t.allowedSettlement != SettlementPolicy.Physical && t.maxSettlementPriceAge == 0) {
            revert CashSettlementNeedsMaxPriceAge();
        }
        if (pairs.length == 0) {
            revert NoPairs();
        }
        if (!isCall) {
            if (pairs.length != 1) {
                revert PutRequiresSinglePair();
            }
            if (pairs[0].quoteToken != t.collateral) {
                revert PutPairMustBeCollateral();
            }
        }
        for (uint256 i = 0; i < pairs.length; ++i) {
            PairConfig calldata p = pairs[i];
            if (p.quoteToken == address(0) || p.premiumToken == address(0)) {
                revert ZeroAddress();
            }
            if (isCall && p.quoteToken == t.underlying) {
                revert QuoteIsUnderlying();
            }
            for (uint256 j = 0; j < i; ++j) {
                if (pairs[j].quoteToken == p.quoteToken) {
                    revert DuplicatePair(p.quoteToken);
                }
            }
        }
    }

    /// @dev Validates, stores and commits the creator's rules in one call. Every validator must have code and
    ///      accept its own data before any deposit can arrive. Returns the termsHash bids must carry.
    function adoptRules(
        BidRule[] storage stored,
        VaultTerms calldata t,
        PairConfig[] calldata pairs,
        BidRule[] calldata rules
    ) external returns (bytes32) {
        for (uint256 i = 0; i < rules.length; ++i) {
            BidRule calldata r = rules[i];
            if (r.validator == address(0) || r.validator.code.length == 0) {
                revert InvalidValidator();
            }
            bytes4 ok = IIvyBidValidator(r.validator).validateConfig(r.kind, t, pairs, r.data);
            if (ok != IIvyBidValidator.validateConfig.selector) {
                revert InvalidValidator();
            }
            BidRule storage slot = stored.push();
            slot.validator = r.validator;
            slot.kind = r.kind;
            slot.data = r.data;
        }
        return _termsHash(t, pairs, rules);
    }

    /// @dev Mandatory checks. Bid signature and caller authorization are enforced by the hub before this runs.
    ///      A validator that approves everything cannot bypass anything here.
    function checkBid(
        VaultState storage s,
        VaultTerms storage t,
        address premiumToken,
        bytes32 expectedTermsHash,
        Bid calldata bid,
        uint256 supply
    ) external view returns (uint256 totalNotional) {
        if (premiumToken == address(0)) {
            revert PairUnknown(bid.quoteToken);
        }
        if (t.allowedExercise != ExercisePolicy.Either && uint8(t.allowedExercise) != uint8(bid.style)) {
            revert StyleNotAllowed();
        }
        if (t.allowedSettlement != SettlementPolicy.Either && uint8(t.allowedSettlement) != uint8(bid.settlement)) {
            revert SettlementNotAllowed();
        }
        if (bid.expiry <= block.timestamp) {
            revert ExpiryInPast();
        }
        if (
            bid.expiry != t.expiry || bid.auctionId != s.auctionId || bid.collateralAmount != supply
                || bid.termsHash != expectedTermsHash
        ) {
            revert CommitmentMismatch();
        }
        if (bid.recipient == address(0)) {
            revert ZeroAddress();
        }
        totalNotional = IvyMath.notionalOf(s.isCall, supply, s.underlyingUnit, bid.strike);
        if (totalNotional == 0) {
            revert EmptyNotional();
        }
    }

    /// @dev Runs every creator rule in order. The first rejection ends activation.
    function runRules(
        VaultState storage s,
        VaultTerms storage t,
        BidRule[] storage rules,
        address premiumToken,
        Bid calldata bid,
        uint256 supply,
        uint256 totalNotional
    ) external view {
        BidContext memory context = BidContext({
            vaultId: bid.vaultId,
            isCall: s.isCall,
            underlying: t.underlying,
            collateral: t.collateral,
            premiumToken: premiumToken,
            underlyingUnit: s.underlyingUnit,
            collateralAmount: supply,
            totalNotional: totalNotional,
            auctionOpenedAt: s.auctionOpenedAt
        });
        for (uint256 i = 0; i < rules.length; ++i) {
            BidRule storage r = rules[i];
            bytes4 ok = IIvyBidValidator(r.validator).validateBid(r.kind, context, bid, r.data);
            if (ok != IIvyBidValidator.validateBid.selector) {
                revert InvalidValidator();
            }
        }
    }

    /// @dev Commitment to the creator-supplied inputs of createVault. auctionStartsAt is operational and excluded.
    function _termsHash(VaultTerms calldata t, PairConfig[] calldata pairs, BidRule[] calldata rules)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                t.underlying,
                t.collateral,
                t.allowPartialExercise,
                t.publicDeposits,
                t.allowedExercise,
                t.allowedSettlement,
                t.expiry,
                t.minCollateral,
                t.maxSettlementPriceAge,
                keccak256(abi.encode(pairs)),
                keccak256(abi.encode(rules))
            )
        );
    }
}
