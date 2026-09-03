// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IvyVaultsHubStorage} from "./hub/IvyVaultsHubStorage.sol";
import "./types/IvyTypes.sol";

/// @title IvyVaultsHub
/// @notice Factory, rule engine and ERC-1155 share ledger for Ivy option vaults. UUPS upgradeable.
contract IvyVaultsHub is IvyVaultsHubStorage {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address vaultImplementation_,
        uint64 exerciseWindow_,
        uint64 auctionTimeout_,
        uint64 settlementGracePeriod_,
        string calldata uri_
    ) external initializer {
        if (admin == address(0) || vaultImplementation_ == address(0)) revert ZeroAddress();
        __AccessControl_init();
        __ERC1155_init(uri_);
        __ERC1155Supply_init();
        __EIP712_init("IvyVaultsHub", "1");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        vaultImplementation = vaultImplementation_;
        exerciseWindow = exerciseWindow_;
        auctionTimeout = auctionTimeout_;
        settlementGracePeriod = settlementGracePeriod_;
        emit VaultImplementationUpdated(vaultImplementation_);
        emit SettingsUpdated(exerciseWindow_, auctionTimeout_, settlementGracePeriod_);
    }

    // ------------------------------------------------------------ admin

    function setSettings(uint64 exerciseWindow_, uint64 auctionTimeout_, uint64 settlementGracePeriod_)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        exerciseWindow = exerciseWindow_;
        auctionTimeout = auctionTimeout_;
        settlementGracePeriod = settlementGracePeriod_;
        emit SettingsUpdated(exerciseWindow_, auctionTimeout_, settlementGracePeriod_);
    }

    function setVaultImplementation(address implementation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (implementation == address(0)) revert ZeroAddress();
        vaultImplementation = implementation;
        emit VaultImplementationUpdated(implementation);
    }

    function setURI(string calldata newUri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(newUri);
    }

    function version() external pure virtual returns (string memory) {
        return "1";
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
