// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IvyVaultsHubStorage} from "./IvyVaultsHubStorage.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";
import "../types/IvyTypes.sol";

/// @dev Vault creation, deposits, withdrawals, owner controls and the auction phase (spec §4.2, §6.1, §6.2, §8).
abstract contract IvyVaultsLifecycle is IvyVaultsHubStorage {
    // ------------------------------------------------------------ creation (spec §4.2)

    /// @notice Create a vault. Kind is derived: `collateral == underlying` is a covered call, anything else a put.
    function createVault(VaultTerms calldata terms, PairInput[] calldata pairs)
        external nonReentrant returns (uint256 vaultId, address vault)
    {
        _validateTerms(terms, pairs);
        bool isCall = terms.collateral == terms.underlying;

        vaultId = ++vaultCount;
        vault = Clones.clone(vaultImplementation);
        IIvyVault(vault).initialize(address(this), vaultId, terms.collateral);

        _terms[vaultId] = terms;
        VaultState storage s = _state[vaultId];
        s.vault = vault;
        s.owner = msg.sender;
        s.isCall = isCall;
        s.phase = Phase.Open;
        s.underlyingUnit = 10 ** IERC20Metadata(terms.underlying).decimals();

        for (uint256 i = 0; i < pairs.length; ++i) {
            _pairTerms[vaultId][pairs[i].quoteToken] = pairs[i].terms;
            _quoteTokens[vaultId].push(pairs[i].quoteToken);
        }

        emit VaultCreated(
            vaultId,
            vault,
            msg.sender,
            isCall ? OptionKind.CoveredCall : OptionKind.CashSecuredPut,
            terms.underlying,
            terms.collateral
        );
        if (terms.auctionStartsAt != 0) emit AuctionScheduled(vaultId, terms.auctionStartsAt);
    }

    function _validateTerms(VaultTerms calldata t, PairInput[] calldata pairs) internal pure {
        if (t.underlying == address(0) || t.collateral == address(0)) revert ZeroAddress();
        if (t.maxTenor == 0) revert InvalidTenor();
        bool isCall = t.collateral == t.underlying;
        if (t.allowedSettlement != SettlementPolicy.Physical && t.priceFeed == address(0)) revert CashSettlementNeedsFeed();
        if (t.priceFeed != address(0)) {
            if (t.maxPriceAge == 0) revert FeedNeedsMaxPriceAge();
            if (isCall && t.maxSpotDeviationBps > 10_000) revert DeviationTooLarge();
        }
        if (pairs.length == 0) revert NoPairs();
        if (!isCall) {
            if (pairs.length != 1) revert PutRequiresSinglePair();
            if (pairs[0].quoteToken != t.collateral) revert PutPairMustBeCollateral();
        }
        for (uint256 i = 0; i < pairs.length; ++i) {
            PairInput calldata p = pairs[i];
            if (p.quoteToken == address(0) || p.terms.premiumToken == address(0)) revert ZeroAddress();
            if (isCall && p.quoteToken == t.underlying) revert QuoteIsUnderlying();
            if (!p.terms.enabled) revert PairMustBeEnabled();
            if (!isCall && p.terms.strikeLimit == 0) revert InvalidStrikeLimit();
            for (uint256 j = 0; j < i; ++j) {
                if (pairs[j].quoteToken == p.quoteToken) revert DuplicatePair(p.quoteToken);
            }
        }
    }
}
