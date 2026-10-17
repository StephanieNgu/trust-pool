// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IClaimManager {
    function startVoting(uint256 claimId) external;
    function openClaimOfPolicy(uint256 policyId) external view returns (uint256);
}
