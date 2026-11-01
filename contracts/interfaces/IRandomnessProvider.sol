// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Source of randomness for jury selection.
/// @dev Implementations must later call `IRandomnessConsumer(requester).fulfillRandomness(claimId, seed)`.
///      Implemented by VRFRandomness (Chainlink VRF v2.5).
interface IRandomnessProvider {
    function requestRandomness(uint256 claimId) external;
}

/// @notice Callback implemented by contracts that request randomness.
interface IRandomnessConsumer {
    function fulfillRandomness(uint256 claimId, uint256 seed) external;
}
