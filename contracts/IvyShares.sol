// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {IIvyShares} from "./interfaces/IIvyShares.sol";
import {IvyPremiums} from "./IvyPremiums.sol";
import {IvyUnwind} from "./IvyUnwind.sol";
import {NotHub, ZeroAddress} from "./types/IvyTypes.sol";

/// @title IvyShares
/// @notice ERC-1155 LP share token for Ivy vaults. Minted and burned only by the hub; freely transferable.
///         Token id == vault id. Lives outside the hub so the hub stays under the EIP-170 bytecode limit.
contract IvyShares is ERC1155, ERC1155Supply, IIvyShares {
    address public immutable override hub;
    address public immutable override premiums;
    address public immutable override unwind;

    modifier onlyHub() {
        if (msg.sender != hub) revert NotHub();
        _;
    }

    constructor(address hub_, address premiums_, address unwind_, string memory uri_) ERC1155(uri_) {
        if (hub_ == address(0) || premiums_ == address(0) || unwind_ == address(0)) revert ZeroAddress();
        hub = hub_;
        premiums = premiums_; unwind = unwind_;
    }

    function mint(address to, uint256 id, uint256 amount) external onlyHub {
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external onlyHub {
        _burn(from, id, amount);
    }

    function setURI(string calldata newUri) external onlyHub {
        _setURI(newUri);
    }

    function balanceOf(address account, uint256 id) public view override(ERC1155, IIvyShares) returns (uint256) {
        return super.balanceOf(account, id);
    }

    function totalSupply(uint256 id) public view override(ERC1155Supply, IIvyShares) returns (uint256) {
        return super.totalSupply(id);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal override(ERC1155, ERC1155Supply)
    {
        if (from != to) {
            for (uint256 i; i < ids.length; ++i) {
                bool seen;
                for (uint256 j; j < i; ++j) if (ids[j] == ids[i] && values[j] > 0) { seen = true; break; }
                if (seen || values[i] == 0) continue;
                _notify(ids[i], from);
                _notify(ids[i], to);
            }
        }
        super._update(from, to, ids, values);
    }
    function _notify(uint256 id, address holder) private {
        if (holder == address(0)) return;
        IvyPremiums(premiums).beforeShareUpdate(id, holder, balanceOf(holder, id));
        IvyUnwind(unwind).beforeShareUpdate(id, holder);
    }
}
