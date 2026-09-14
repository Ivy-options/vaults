// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IIvyVaultsHubEvents} from "./IIvyVaultsHubEvents.sol";

/// @notice The part of the hub a vault talks to.
interface IIvyVaultsHub is IIvyVaultsHubEvents {
    /// @notice Called by a vault after a direct deposit. `amount` is the balance delta the vault received.
    function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external;
}
