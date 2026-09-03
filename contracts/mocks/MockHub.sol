// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IIvyVault} from "../interfaces/IIvyVault.sol";

/// @dev Stand-in hub for IvyVault unit tests: clones vaults and records deposit callbacks.
contract MockHub {
    address public lastClone;
    uint256 public lastVaultId;
    address public lastDepositor;
    uint256 public lastAmount;
    uint256 public calls;

    function createClone(address implementation, uint256 id, address collateral) external returns (address clone) {
        clone = Clones.clone(implementation);
        IIvyVault(clone).initialize(address(this), id, collateral);
        lastClone = clone;
    }

    function onVaultDeposit(uint256 vaultId, address depositor, uint256 amount) external {
        lastVaultId = vaultId;
        lastDepositor = depositor;
        lastAmount = amount;
        calls++;
    }

    function pull(address vault, address token, address from, uint256 amount) external returns (uint256) {
        return IIvyVault(vault).pull(token, from, amount);
    }

    function push(address vault, address token, address to, uint256 amount) external {
        IIvyVault(vault).push(token, to, amount);
    }
}
