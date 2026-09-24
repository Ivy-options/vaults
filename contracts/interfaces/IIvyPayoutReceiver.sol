// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Optional hook for contract recipients of vault payouts.
/// @dev Called after tokens reach the recipient. The Hub ignores failed hooks unless they exhaust gas.
///      Return `onIvyPayout.selector` to acknowledge receipt. The vault may already be finalized.
interface IIvyPayoutReceiver {
    function onIvyPayout(uint256 vaultId, address token, uint256 amount) external returns (bytes4);
}
