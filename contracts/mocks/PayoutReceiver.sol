// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IIvyPayoutReceiver } from "../interfaces/IIvyPayoutReceiver.sol";
import { VaultState } from "../types/IvyTypes.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IHubView {
	function stateOf(uint256 vaultId) external view returns (VaultState memory);

	function claimPayout(uint256 vaultId) external;
}

/// @dev Records payout notifications and can misbehave on demand.
contract PayoutReceiver is IIvyPayoutReceiver {
	enum Mode {
		Acknowledge,
		WrongMagic,
		Revert,
		Reenter,
		BurnGas
	}

	address public immutable hub;

	Mode public mode;
	uint256 public calls;
	address public lastCaller;
	uint256 public lastVaultId;
	address public lastToken;
	uint256 public lastAmount;
	uint256 public balanceSeen;
	uint8 public phaseSeen;

	constructor(address hub_) {
		hub = hub_;
	}

	function setMode(Mode mode_) external {
		mode = mode_;
	}

	function onIvyPayout(uint256 vaultId, address token, uint256 amount) external returns (bytes4) {
		++calls;
		lastCaller = msg.sender;
		lastVaultId = vaultId;
		lastToken = token;
		lastAmount = amount;
		balanceSeen = IERC20(token).balanceOf(address(this));
		phaseSeen = uint8(IHubView(hub).stateOf(vaultId).phase);
		if (mode == Mode.Revert) revert("PayoutReceiver: rejected");
		if (mode == Mode.Reenter) IHubView(hub).claimPayout(vaultId);
		if (mode == Mode.BurnGas) {
			for (;;) {
				++calls;
			}
		}
		return mode == Mode.WrongMagic ? bytes4(0xdeadbeef) : this.onIvyPayout.selector;
	}
}
