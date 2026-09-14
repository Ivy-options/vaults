// SPDX-License-Identifier: BUSL-1.1
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
        IIvyVault(clone).initialize(address(this), id, collateral, address(this));
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
    function collectPremium(address vault, address token, address from, uint256 amount) external { IIvyVault(vault).collectPremium(token, from, amount, 0, address(this)); }
    function reserveBuyer(address vault, address token, uint256 amount) external { IIvyVault(vault).reserveBuyer(token, amount); }
    function payPremium(address vault, address to, uint256 amount) external { IIvyVault(vault).payPremium(to, amount); }
    function payBuyer(address vault, address token, address to) external { IIvyVault(vault).payBuyer(token, to); }
}
