// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPolicyRegistry {
    enum Status {
        None,
        Active,
        Lapsed
    }

    /// @dev Paid: covered by a paid premium. Grace: premium missed, still covered until the grace
    ///      period ends. Overdue: grace period over, not active, waiting for `lapseOverdue`.
    enum PremiumState {
        None,
        Paid,
        Grace,
        Overdue,
        Lapsed
    }

    struct Policy {
        uint256 id;
        address holder;
        bytes32 deviceIdHash;
        uint256 coverageLimit;
        uint256 startTime;
        Status status;
        /// @dev Hash of the off-chain enrollment bundle: device details and photos taken at signup.
        bytes32 enrollmentHash;
    }

    function getPolicy(address holder) external view returns (Policy memory);
    function isActive(address holder) external view returns (bool);
    function isPastWaitingPeriod(address holder) external view returns (bool);
    function eligibleJurors(address exclude) external view returns (address[] memory);
}
