// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

/// @notice Optional hook for contract recipients of vault payouts.
/// @dev The hub calls this after each payout it pushes to a recipient with code: exercise proceeds and claimed
///      cash or unwind payouts. The call is best effort. A recipient without this method, or one that reverts,
///      never blocks the payout; the hub only records whether the recipient acknowledged by returning
///      `onIvyPayout.selector`. Tokens are already in the recipient's balance when the hook runs and the vault is
///      already finalized when applicable, so the hook may swap or forward the proceeds in the same transaction.
///      The same shape is intended for LP claim notifications later.
interface IIvyPayoutReceiver {
    function onIvyPayout(uint256 vaultId, address token, uint256 amount) external returns (bytes4);
}
