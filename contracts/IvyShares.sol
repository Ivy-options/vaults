// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import {IvyPremiums} from "./IvyPremiums.sol";
import {IvyUnwind} from "./IvyUnwind.sol";
import {IIvyShares} from "./interfaces/IIvyShares.sol";
import {NotHub, ZeroAddress} from "./types/IvyTypes.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";

interface IShareTransferPolicy {
    function transfersEnabled() external view returns (bool);
}

/// @notice ERC-1155 LP shares. Each token ID is a vault ID; one share equals the smallest collateral unit.
/// @dev Only the hub mints and burns. The hub also controls whether shares can transfer.
///      This separate contract keeps the Hub within the EIP-170 code size limit.
contract IvyShares is ERC1155, ERC1155Supply, IIvyShares {
    address public immutable override hub;
    address public immutable override premiums;
    address public immutable override unwind;

    error TransfersDisabled();

    modifier onlyHub() {
        if (msg.sender != hub) {
            revert NotHub();
        }
        _;
    }

    constructor(address hub_, address premiums_, address unwind_, string memory uri_) ERC1155(uri_) {
        if (hub_ == address(0) || premiums_ == address(0) || unwind_ == address(0)) {
            revert ZeroAddress();
        }
        hub = hub_;
        premiums = premiums_;
        unwind = unwind_;
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
        internal
        override(ERC1155, ERC1155Supply)
    {
        if (from != address(0) && to != address(0) && !IShareTransferPolicy(hub).transfersEnabled()) {
            revert TransfersDisabled();
        }
        if (ids.length != values.length) {
            revert ERC1155InvalidArrayLength(ids.length, values.length);
        }
        if (from != to) {
            for (uint256 i; i < ids.length; ++i) {
                bool seen;
                for (uint256 j; j < i; ++j) {
                    if (ids[j] == ids[i]) {
                        seen = true;
                        break;
                    }
                }
                if (seen) {
                    continue;
                }
                uint256 amount;
                for (uint256 j = i; j < ids.length; ++j) {
                    if (ids[j] == ids[i]) {
                        amount += values[j];
                    }
                }
                if (amount == 0) {
                    continue;
                }
                uint256 fromBalance = from == address(0) ? 0 : balanceOf(from, ids[i]);
                if (from != address(0) && amount > fromBalance) {
                    revert ERC1155InsufficientBalance(from, fromBalance, amount, ids[i]);
                }
                IvyPremiums(premiums)
                    .beforeShareUpdate(
                        ids[i], from, to, amount, fromBalance, to == address(0) ? 0 : balanceOf(to, ids[i])
                    );
                if (from != address(0)) {
                    IvyUnwind(unwind).beforeShareUpdate(ids[i], from);
                }
                if (to != address(0)) {
                    IvyUnwind(unwind).beforeShareUpdate(ids[i], to);
                }
            }
        }
        super._update(from, to, ids, values);
    }
}
