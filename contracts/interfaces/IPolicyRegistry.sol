// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPolicyRegistry {
    enum Status {
        None,
        Active,
        Lapsed
    }

    struct Policy {
        uint256 id;
        address holder;
        bytes32 deviceIdHash;
        uint256 coverageLimit;
        uint256 startTime;
        Status status;
    }

    function getPolicy(address holder) external view returns (Policy memory);
    function isActive(address holder) external view returns (bool);
    function isPastWaitingPeriod(address holder) external view returns (bool);
    function eligibleJurors(address exclude) external view returns (address[] memory);
}
