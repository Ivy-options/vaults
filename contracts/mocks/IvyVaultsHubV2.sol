// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IvyVaultsHub} from "../IvyVaultsHub.sol";

/// @dev Upgrade target for the UUPS smoke test.
contract IvyVaultsHubV2 is IvyVaultsHub {
    function version() external pure override returns (string memory) {
        return "2";
    }
}
