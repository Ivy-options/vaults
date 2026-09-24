// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice ERC-1155 LP shares. A token ID identifies a vault; one share equals the smallest collateral unit.
/// @dev Only the Hub may mint, burn, or set the URI.
interface IIvyShares {
    function mint(address to, uint256 id, uint256 amount) external;

    function burn(address from, uint256 id, uint256 amount) external;

    function setURI(string calldata newUri) external;

    function premiums() external view returns (address);

    function unwind() external view returns (address);

    function hub() external view returns (address);

    function balanceOf(address account, uint256 id) external view returns (uint256);

    function totalSupply(uint256 id) external view returns (uint256);
}
