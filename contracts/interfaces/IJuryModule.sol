// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IJuryModule {
    enum Outcome {
        None,
        Approved,
        Rejected
    }

    function requestJury(uint256 claimId, address claimant) external;
    function tally(uint256 claimId) external returns (Outcome);
}
