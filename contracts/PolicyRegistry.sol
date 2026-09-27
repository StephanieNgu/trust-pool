// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IPool} from "./interfaces/IPool.sol";

/// @title PolicyRegistry
/// @notice Membership: creates policies, tracks their status, enforces one policy per wallet and
///         one policy per device, and exposes the list of wallets eligible for jury duty.
/// @dev Holds no funds. Premiums are pulled straight into the Pool.
contract PolicyRegistry is IPolicyRegistry, Ownable {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IPool public immutable pool;
    /// @notice Time after purchase before a holder can file claims or serve on a jury.
    uint256 public immutable waitingPeriod;
    /// @notice Upfront premium as a share of the chosen coverage limit, in basis points.
    uint256 public immutable premiumBps;
    /// @notice Largest coverage limit a single policy may choose.
    uint256 public immutable maxCoverageLimit;

    uint256 public policyCount;
    mapping(address => Policy) private _policyOf;
    /// @notice Device hashes currently covered by an Active policy.
    mapping(bytes32 => bool) public deviceCovered;

    /// @dev Every wallet that has ever held a policy; iterated for juror selection (fine for a demo pool).
    address[] private _holders;
    mapping(address => bool) private _isKnownHolder;

    event PolicyPurchased(
        uint256 indexed policyId,
        address indexed holder,
        bytes32 deviceIdHash,
        uint256 coverageLimit,
        uint256 premium
    );
    event PolicyLapsed(uint256 indexed policyId, address indexed holder);

    error ZeroAddress();
    error InvalidDevice();
    error InvalidCoverage();
    error InvalidBps();
    error AlreadyHasActivePolicy();
    error DeviceAlreadyCovered();
    error NoActivePolicy();

    constructor(
        IPool pool_,
        uint256 waitingPeriod_,
        uint256 premiumBps_,
        uint256 maxCoverageLimit_
    ) Ownable(msg.sender) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        if (premiumBps_ == 0 || premiumBps_ > BPS_DENOMINATOR) revert InvalidBps();
        if (maxCoverageLimit_ == 0) revert InvalidCoverage();
        pool = pool_;
        waitingPeriod = waitingPeriod_;
        premiumBps = premiumBps_;
        maxCoverageLimit = maxCoverageLimit_;
    }

    // ---------------------------------------------------------------------
    // Policy lifecycle
    // ---------------------------------------------------------------------

    /// @notice Premium owed for a given coverage limit.
    function premiumFor(uint256 coverageLimit) public view returns (uint256) {
        return (coverageLimit * premiumBps) / BPS_DENOMINATOR;
    }

    /// @notice Buy a policy. The caller must first approve the Pool for `premiumFor(coverageLimit)`.
    /// @param deviceIdHash keccak256 of the device identifier (e.g. IMEI); the raw ID never goes on-chain.
    /// @param coverageLimit Maximum amount any single claim on this policy can pay, in token units.
    function buyPolicy(bytes32 deviceIdHash, uint256 coverageLimit) external returns (uint256 policyId) {
        if (deviceIdHash == bytes32(0)) revert InvalidDevice();
        if (coverageLimit == 0 || coverageLimit > maxCoverageLimit) revert InvalidCoverage();
        if (_policyOf[msg.sender].status == Status.Active) revert AlreadyHasActivePolicy();
        if (deviceCovered[deviceIdHash]) revert DeviceAlreadyCovered();

        uint256 premium = premiumFor(coverageLimit);
        if (premium == 0) revert InvalidCoverage();

        policyId = ++policyCount;
        _policyOf[msg.sender] = Policy({
            id: policyId,
            holder: msg.sender,
            deviceIdHash: deviceIdHash,
            coverageLimit: coverageLimit,
            startTime: block.timestamp,
            status: Status.Active
        });
        deviceCovered[deviceIdHash] = true;

        if (!_isKnownHolder[msg.sender]) {
            _isKnownHolder[msg.sender] = true;
            _holders.push(msg.sender);
        }

        emit PolicyPurchased(policyId, msg.sender, deviceIdHash, coverageLimit, premium);
        pool.collectPremium(msg.sender, premium);
    }

    /// @notice Holder voluntarily ends their own policy.
    function cancelPolicy() external {
        _lapse(msg.sender);
    }

    /// @notice Admin marks a policy lapsed (e.g. non-renewal). Stand-in for a future renewal model.
    function lapsePolicy(address holder) external onlyOwner {
        _lapse(holder);
    }

    function _lapse(address holder) private {
        Policy storage p = _policyOf[holder];
        if (p.status != Status.Active) revert NoActivePolicy();
        p.status = Status.Lapsed;
        deviceCovered[p.deviceIdHash] = false;
        emit PolicyLapsed(p.id, holder);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPolicy(address holder) external view returns (Policy memory) {
        return _policyOf[holder];
    }

    function isActive(address holder) public view returns (bool) {
        return _policyOf[holder].status == Status.Active;
    }

    /// @notice True once the holder's active policy has been in force for `waitingPeriod`.
    function isPastWaitingPeriod(address holder) public view returns (bool) {
        Policy storage p = _policyOf[holder];
        return p.status == Status.Active && block.timestamp >= p.startTime + waitingPeriod;
    }

    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    /// @notice Wallets with an active policy past the waiting period, excluding `exclude`.
    /// @dev O(n) over all holders. Acceptable for the prototype; see design doc "Future Work" #8.
    function eligibleJurors(address exclude) external view returns (address[] memory) {
        uint256 n = _holders.length;
        address[] memory buffer = new address[](n);
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            address h = _holders[i];
            if (h != exclude && isPastWaitingPeriod(h)) {
                buffer[count++] = h;
            }
        }
        address[] memory result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = buffer[i];
        }
        return result;
    }
}
