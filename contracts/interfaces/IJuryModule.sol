// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IJuryModule {
    enum Outcome {
        None,
        Approved,
        Rejected
    }

    function requestJury(uint256 claimId, address claimant, uint256 maxAmount) external;
    function tally(uint256 claimId) external returns (Outcome outcome, uint256 award);
    function cancel(uint256 claimId) external;
    function quorate(uint256 claimId) external view returns (bool);
}
