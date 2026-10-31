// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IClaimManager} from "./interfaces/IClaimManager.sol";

/// @title PolicyRegistry
/// @notice Membership: creates policies, collects monthly premiums, tracks their status, enforces one
///         policy per wallet and one policy per device, and exposes the list of wallets eligible for
///         jury duty.
/// @dev Holds no funds. Premiums are pulled straight into the Pool.
///
///      Premiums are paid per `premiumPeriod` (30 days by default). Buying a policy pays the first
///      period; each `payPremium` call pays one more, counted from the end of the period already paid,
///      so paying early never loses days. A policy whose premium is not paid by `paidThrough` enters a
///      `gracePeriod`, during which coverage continues and the holder can still pay to catch up. Once
///      the grace period ends the policy no longer counts as active: it cannot file claims or serve on
///      juries, and anyone (normally the backend keeper) can call `lapseOverdue` to close it and free
///      its device. A claim already open when the premium is missed keeps the policy open until it is
///      decided, exactly as it does for a cancellation.
contract PolicyRegistry is IPolicyRegistry, Ownable {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    IPool public immutable pool;
    /// @notice Time after purchase before a holder can file claims or serve on a jury.
    uint256 public immutable waitingPeriod;
    /// @notice Premium for one `premiumPeriod`, as a share of the chosen coverage limit, in basis points.
    uint256 public immutable premiumBps;
    /// @notice Length of the period one premium pays for.
    uint256 public immutable premiumPeriod;
    /// @notice Time after a missed premium during which coverage continues and the holder can still pay.
    uint256 public immutable gracePeriod;
    /// @notice Largest coverage limit a single policy may choose.
    uint256 public immutable maxCoverageLimit;

    uint256 public policyCount;
    mapping(address => Policy) private _policyOf;
    /// @notice Device hashes currently covered by an Active policy.
    mapping(bytes32 => bool) public deviceCovered;
    /// @dev Holder whose policy covers each device, so an overdue policy can be cleared off the device.
    mapping(bytes32 => address) private _deviceHolder;
    /// @notice End of the last premium period the holder's current policy has paid for.
    mapping(address => uint256) public paidThrough;

    /// @dev Every wallet that has ever held a policy; iterated for juror selection (fine for a demo pool).
    address[] private _holders;
    mapping(address => bool) private _isKnownHolder;

    event PolicyPurchased(
        uint256 indexed policyId,
        address indexed holder,
        bytes32 deviceIdHash,
        uint256 coverageLimit,
        uint256 premium,
        bytes32 enrollmentHash
    );
    event PolicyLapsed(uint256 indexed policyId, address indexed holder);
    event PremiumPaid(uint256 indexed policyId, address indexed holder, uint256 amount, uint256 paidThrough);

    error ZeroAddress();
    error InvalidDevice();
    error InvalidEnrollment();
    error InvalidCoverage();
    error InvalidBps();
    error AlreadyHasActivePolicy();
    error DeviceAlreadyCovered();
    error NoActivePolicy();
    error OpenClaimExists(uint256 claimId);
    error InvalidPeriod();
    error PolicyOverdue();
    error NotOverdue();
    error PaidTooFarAhead(uint256 paidThrough);

    constructor(
        IPool pool_,
        uint256 waitingPeriod_,
        uint256 premiumBps_,
        uint256 maxCoverageLimit_,
        uint256 premiumPeriod_,
        uint256 gracePeriod_
    ) Ownable(msg.sender) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        if (premiumBps_ == 0 || premiumBps_ > BPS_DENOMINATOR) revert InvalidBps();
        if (maxCoverageLimit_ == 0) revert InvalidCoverage();
        if (premiumPeriod_ == 0) revert InvalidPeriod();
        pool = pool_;
        waitingPeriod = waitingPeriod_;
        premiumBps = premiumBps_;
        maxCoverageLimit = maxCoverageLimit_;
        premiumPeriod = premiumPeriod_;
        gracePeriod = gracePeriod_;
    }

    // ---------------------------------------------------------------------
    // Policy lifecycle
    // ---------------------------------------------------------------------

    /// @notice Premium owed for one `premiumPeriod` of a given coverage limit.
    function premiumFor(uint256 coverageLimit) public view returns (uint256) {
        return (coverageLimit * premiumBps) / BPS_DENOMINATOR;
    }

    /// @notice Buy a policy and pay its first premium period. The caller must first approve the Pool for
    ///         `premiumFor(coverageLimit)`. A previous policy of the caller's, or one on the same device,
    ///         that is past its grace period is closed first.
    /// @param deviceIdHash keccak256 of the device identifier (e.g. IMEI); the raw ID never goes on-chain.
    /// @param coverageLimit Maximum amount any single claim on this policy can pay, in token units.
    /// @param enrollmentHash Hash of the enrollment bundle (device details and signup photos) held by
    ///        the backend. Jurors compare a claim's photos against it to check it is the same device.
    function buyPolicy(bytes32 deviceIdHash, uint256 coverageLimit, bytes32 enrollmentHash)
        external
        returns (uint256 policyId)
    {
        if (deviceIdHash == bytes32(0)) revert InvalidDevice();
        if (enrollmentHash == bytes32(0)) revert InvalidEnrollment();
        if (coverageLimit == 0 || coverageLimit > maxCoverageLimit) revert InvalidCoverage();
        if (_policyOf[msg.sender].status == Status.Active) {
            if (!isOverdue(msg.sender)) revert AlreadyHasActivePolicy();
            _lapse(msg.sender);
        }
        if (deviceCovered[deviceIdHash]) {
            address current = _deviceHolder[deviceIdHash];
            if (!isOverdue(current)) revert DeviceAlreadyCovered();
            _lapse(current);
        }

        uint256 premium = premiumFor(coverageLimit);
        if (premium == 0) revert InvalidCoverage();

        policyId = ++policyCount;
        _policyOf[msg.sender] = Policy({
            id: policyId,
            holder: msg.sender,
            deviceIdHash: deviceIdHash,
            coverageLimit: coverageLimit,
            startTime: block.timestamp,
            status: Status.Active,
            enrollmentHash: enrollmentHash
        });
        deviceCovered[deviceIdHash] = true;
        _deviceHolder[deviceIdHash] = msg.sender;
        uint256 paidUntil = block.timestamp + premiumPeriod;
        paidThrough[msg.sender] = paidUntil;

        if (!_isKnownHolder[msg.sender]) {
            _isKnownHolder[msg.sender] = true;
            _holders.push(msg.sender);
        }

        emit PolicyPurchased(policyId, msg.sender, deviceIdHash, coverageLimit, premium, enrollmentHash);
        emit PremiumPaid(policyId, msg.sender, premium, paidUntil);
        pool.collectPremium(msg.sender, premium);
    }

    /// @notice Pay the next premium period of the caller's policy. The caller must first approve the
    ///         Pool for `premiumFor(coverageLimit)`. Allowed while the policy is paid up or in its grace
    ///         period, and at most one period in advance.
    /// @return paidUntil The new end of the paid coverage.
    function payPremium() external returns (uint256 paidUntil) {
        Policy storage p = _policyOf[msg.sender];
        if (p.status != Status.Active) revert NoActivePolicy();
        if (isOverdue(msg.sender)) revert PolicyOverdue();
        uint256 current = paidThrough[msg.sender];
        if (current > block.timestamp + premiumPeriod) revert PaidTooFarAhead(current);

        paidUntil = current + premiumPeriod;
        paidThrough[msg.sender] = paidUntil;
        uint256 premium = premiumFor(p.coverageLimit);
        emit PremiumPaid(p.id, msg.sender, premium, paidUntil);
        pool.collectPremium(msg.sender, premium);
    }

    /// @notice Close a policy whose grace period has ended without payment. Permissionless, so the
    ///         keeper (or anyone) can free the device for re-enrolment. Reverts while a claim is open.
    function lapseOverdue(address holder) external {
        if (!isOverdue(holder)) revert NotOverdue();
        _lapse(holder);
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
        address manager = pool.claimManager();
        if (manager != address(0)) {
            uint256 openClaimId = IClaimManager(manager).openClaimOfPolicy(p.id);
            if (openClaimId != 0) revert OpenClaimExists(openClaimId);
        }
        p.status = Status.Lapsed;
        deviceCovered[p.deviceIdHash] = false;
        delete _deviceHolder[p.deviceIdHash];
        emit PolicyLapsed(p.id, holder);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPolicy(address holder) external view returns (Policy memory) {
        return _policyOf[holder];
    }

    /// @notice True while the holder's policy is open and its premiums are paid, or within the grace
    ///         period after a missed one.
    function isActive(address holder) public view returns (bool) {
        return _policyOf[holder].status == Status.Active && block.timestamp <= paidThrough[holder] + gracePeriod;
    }

    /// @notice True when the holder's policy is still open on-chain but its grace period has ended
    ///         without payment. Such a policy is not active and can be closed with `lapseOverdue`.
    function isOverdue(address holder) public view returns (bool) {
        return _policyOf[holder].status == Status.Active && block.timestamp > paidThrough[holder] + gracePeriod;
    }

    /// @notice Where the holder's premiums stand.
    /// @return state One of `PremiumState`.
    /// @return paidUntil End of the paid coverage (0 without a policy).
    /// @return graceEndsAt When an unpaid policy stops being active (0 without a policy).
    /// @return amount Premium for one period of this policy (0 without a policy).
    function premiumStatus(address holder)
        external
        view
        returns (PremiumState state, uint256 paidUntil, uint256 graceEndsAt, uint256 amount)
    {
        Policy storage p = _policyOf[holder];
        if (p.status == Status.None) return (PremiumState.None, 0, 0, 0);
        paidUntil = paidThrough[holder];
        graceEndsAt = paidUntil + gracePeriod;
        amount = premiumFor(p.coverageLimit);
        if (p.status == Status.Lapsed) state = PremiumState.Lapsed;
        else if (block.timestamp <= paidUntil) state = PremiumState.Paid;
        else if (block.timestamp <= graceEndsAt) state = PremiumState.Grace;
        else state = PremiumState.Overdue;
    }

    /// @notice True once the holder's active policy has been in force for `waitingPeriod`.
    function isPastWaitingPeriod(address holder) public view returns (bool) {
        return isActive(holder) && block.timestamp >= _policyOf[holder].startTime + waitingPeriod;
    }

    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    /// @notice Wallets whose policies are past their grace period but not yet closed; the keeper
    ///         calls `lapseOverdue` on each.
    /// @dev O(n) over all holders, like `eligibleJurors`.
    function overdueHolders() external view returns (address[] memory) {
        uint256 n = _holders.length;
        address[] memory buffer = new address[](n);
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            if (isOverdue(_holders[i])) buffer[count++] = _holders[i];
        }
        address[] memory result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = buffer[i];
        }
        return result;
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
