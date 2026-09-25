// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Permanent release discovery only; never routes calls or controls a Hub.
contract IvyVaultsRegistry is AccessControl {
	struct Release {
		address hub;
		bytes32 manifestHash;
	}

	mapping(uint256 => Release) private releases;
	mapping(address => bool) private registeredHubs;
	uint256 public recommendedVersion;

	event RecommendedVersionUpdated(uint256 indexed previousReleaseId, uint256 indexed releaseId);
	event VersionRegistered(uint256 indexed releaseId, address indexed hub, bytes32 manifestHash);

	error AlreadyRegistered();
	error InvalidRegistration();
	error UnknownRelease(uint256 releaseId);

	constructor(address admin) {
		if (admin == address(0)) {
			revert InvalidRegistration();
		}
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
	}

	function registerVersion(uint256 releaseId, address hub, bytes32 manifestHash) external onlyRole(DEFAULT_ADMIN_ROLE) {
		if (releaseId == 0 || hub.code.length == 0 || manifestHash == bytes32(0)) {
			revert InvalidRegistration();
		}
		if (releases[releaseId].hub != address(0) || registeredHubs[hub]) {
			revert AlreadyRegistered();
		}
		releases[releaseId] = Release(hub, manifestHash);
		registeredHubs[hub] = true;
		emit VersionRegistered(releaseId, hub, manifestHash);
	}

	function setRecommendedVersion(uint256 releaseId) external onlyRole(DEFAULT_ADMIN_ROLE) {
		_release(releaseId);
		emit RecommendedVersionUpdated(recommendedVersion, releaseId);
		recommendedVersion = releaseId;
	}

	function hubOf(uint256 releaseId) external view returns (address) {
		return _release(releaseId).hub;
	}

	function manifestHashOf(uint256 releaseId) external view returns (bytes32) {
		return _release(releaseId).manifestHash;
	}

	function _release(uint256 releaseId) private view returns (Release storage release) {
		release = releases[releaseId];
		if (release.hub == address(0)) {
			revert UnknownRelease(releaseId);
		}
	}
}
