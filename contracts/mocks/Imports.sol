// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

// Pulls third-party contracts into the compilation so their artifacts exist for tests and Ignition.
import {ERC1967Proxy as _ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract ERC1967Proxy is _ERC1967Proxy {
    constructor(address implementation, bytes memory data) _ERC1967Proxy(implementation, data) {}
}
