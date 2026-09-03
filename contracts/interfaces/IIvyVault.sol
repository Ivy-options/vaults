// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

interface IIvyVault {
    function hub() external view returns (address);
    function vaultId() external view returns (uint256);
    function collateral() external view returns (address);

    /// @notice One-time setup, called by the hub right after cloning.
    function initialize(address hub_, uint256 vaultId_, address collateral_) external;

    /// @notice Direct deposit: pulls `amount` of collateral from the caller and notifies the hub.
    function deposit(uint256 amount) external;

    /// @notice Hub only. Pulls `amount` of `token` from `from`; returns the balance delta actually received.
    function pull(address token, address from, uint256 amount) external returns (uint256 received);

    /// @notice Hub only. Sends `amount` of `token` to `to`.
    function push(address token, address to, uint256 amount) external;
}
