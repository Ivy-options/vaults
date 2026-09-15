// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;
import {IvyVaultsSettlement} from "./hub/IvyVaultsSettlement.sol";
import {IvyVaultsHubStorage} from "./hub/IvyVaultsHubStorage.sol";
import "./types/IvyTypes.sol";

/// @notice Immutable factory and rule engine for individual option vaults.
contract IvyVaultsHub is IvyVaultsSettlement {
    constructor(address admin, address implementation, address shares_, address premiums_, address unwind_, uint64 window_, uint64 timeout_)
        IvyVaultsHubStorage(admin, implementation, shares_, premiums_, unwind_, window_, timeout_) {}

    function setPlatformFeeBps(uint16 rate) external onlyRole(PLATFORM_FEE_MANAGER_ROLE) {
        if (rate > 10_000) revert InvalidPlatformFee();
        emit PlatformFeeBpsUpdated(platformFeeBps, rate);
        platformFeeBps = rate;
    }
    function setPlatformTreasury(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        emit PlatformTreasuryUpdated(platformTreasury, recipient);
        platformTreasury = recipient;
    }
    function setTransfersEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        transfersEnabled = enabled;
        emit TransfersEnabledUpdated(enabled);
    }

    /// @notice Controls new cash admissions. Admins must arrange publisher authority before enabling.
    /// @dev Existing positions and publisher membership are independent of this flag.
    function setCashSettlementEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        cashSettlementEnabled = enabled;
        emit CashSettlementEnabledUpdated(enabled);
    }

    function setSettings(uint64 window_, uint64 timeout_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        exerciseWindow = window_;
        auctionTimeout = timeout_;
        emit SettingsUpdated(window_, timeout_);
    }
    /// @param vaultId Zero pauses admission globally; other ids pause one vault.
    function setAdmissionPause(uint256 vaultId, bool value) external onlyRole(GUARDIAN_ROLE) {
        if (vaultId == 0) paused = value;
        else { _requireExists(vaultId); vaultPaused[vaultId] = value; }
        emit AdmissionPauseUpdated(vaultId, value);
    }
    function setURI(string calldata uri_) external onlyRole(DEFAULT_ADMIN_ROLE) { shareToken.setURI(uri_); }
    function version() external pure returns (string memory) { return "2"; }
}
