// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice The hub-owned ERC-1155 share token. Token id == vault id. 1 share == 1 smallest unit of collateral.
interface IIvyShares {
    /// @notice Hub only.
    function mint(address to, uint256 id, uint256 amount) external;

    /// @notice Hub only.
    function burn(address from, uint256 id, uint256 amount) external;

    /// @notice Hub only.
    function setURI(string calldata newUri) external;

    function premiums() external view returns (address);

    function unwind() external view returns (address);

    function hub() external view returns (address);

    function balanceOf(address account, uint256 id) external view returns (uint256);

    function totalSupply(uint256 id) external view returns (uint256);
}
