// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IIvyShares} from "./interfaces/IIvyShares.sol";
import {IIvyVault} from "./interfaces/IIvyVault.sol";
import "./types/IvyTypes.sol";

/// @notice Unclaimed premium follows shares; burns preserve credit. No token movement from share hooks.
contract IvyPremiums {
    address public immutable hub;
    address public immutable shares;
    struct Pool { address vault; uint256 amount; uint256 supply; }
    struct Credit { bool recorded; uint256 amount; }
    mapping(uint256 => Pool) public pools;
    mapping(uint256 => mapping(address => Credit)) public credits;
    event PremiumClaimed(uint256 indexed vaultId, address indexed holder, uint256 amount);
    constructor(address hub_, address shares_) {
        if (hub_ == address(0) || shares_ == address(0)) revert ZeroAddress();
        hub = hub_; shares = shares_;
    }
    modifier onlyHub() { if (msg.sender != hub) revert NotHub(); _; }
    function activate(uint256 id, address vault, uint256 amount, uint256 supply) external onlyHub {
        if (pools[id].supply != 0) revert AlreadyInitialized();
        if (supply == 0) revert ZeroAmount();
        pools[id] = Pool(vault, amount, supply);
    }
    function beforeShareUpdate(uint256 id, address from, address to, uint256 amount, uint256 fromBalance, uint256 toBalance) external {
        if (msg.sender != shares) revert NotShares();
        _checkpoint(id, from, fromBalance);
        _checkpoint(id, to, toBalance);
        if (from == address(0) || to == address(0) || from == to || amount == 0) return;
        uint256 credit = credits[id][from].amount;
        uint256 moved = amount == fromBalance ? credit : Math.mulDiv(credit, amount, fromBalance);
        credits[id][from].amount -= moved;
        credits[id][to].amount += moved;
    }
    function _checkpoint(uint256 id, address account, uint256 balance) private {
        Pool storage p = pools[id];
        if (account == address(0) || p.supply == 0 || credits[id][account].recorded) return;
        credits[id][account] = Credit(true, Math.mulDiv(p.amount, balance, p.supply));
    }
    function claimable(uint256 id, address holder) external view returns (uint256) {
        Credit storage c = credits[id][holder];
        Pool storage p = pools[id];
        if (c.recorded) return c.amount;
        if (p.supply == 0) return 0;
        return Math.mulDiv(p.amount, IIvyShares(shares).balanceOf(holder, id), p.supply);
    }
    function claimFor(uint256 id, address holder) external onlyHub {
        _checkpoint(id, holder, IIvyShares(shares).balanceOf(holder, id));
        uint256 amount = credits[id][holder].amount;
        if (amount == 0) revert NothingToClaim();
        credits[id][holder].amount = 0;
        IIvyVault(pools[id].vault).payPremium(holder, amount);
        emit PremiumClaimed(id, holder, amount);
    }
}
