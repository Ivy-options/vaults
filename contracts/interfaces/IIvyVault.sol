// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

interface IIvyVault {
    function initialize(address hub, uint256 vaultId, address collateral, address premiums) external;

    function deposit(uint256 amount) external;

    function pull(address token, address from, uint256 amount) external returns (uint256);

    function push(address token, address to, uint256 amount) external;

    function collectPremium(address token, address from, uint256 amount, uint256 fee, address treasury) external;

    function payPremium(address to, uint256 amount) external;

    function fundUnwind(address from, uint256 amount) external returns (uint256);

    function returnUnwind(address to, uint256 amount) external;

    function consumeUnwind(uint256 amount) external;

    function reserveBuyer(address token, uint256 amount) external;

    function payBuyer(address token, address to) external returns (uint256);

    function reserved(address token) external view returns (uint256);
}
