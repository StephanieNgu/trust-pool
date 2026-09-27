// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IClaimManager} from "./interfaces/IClaimManager.sol";
import {IJuryModule} from "./interfaces/IJuryModule.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IPool} from "./interfaces/IPool.sol";

/// @title ClaimManager
/// @notice Owns the claim state machine:
///         Submitted -> JuryPending -> Voting -> Approved -> Paid, or Voting -> Rejected.
/// @dev Holds no funds. Payouts are executed by the Pool on this contract's instruction.
contract ClaimManager is IClaimManager, Ownable, ReentrancyGuard {
    enum State {
        None,
        Submitted,
        JuryPending,
        Voting,
        Approved,
        Rejected,
        Paid
    }

    struct Claim {
        uint256 id;
        address claimant;
        uint256 policyId;
        uint256 amount;
        uint256 coverageLimit;
        bytes32 evidenceHash;
        State state;
        uint256 submittedAt;
        uint256 paidAmount;
    }

    IPolicyRegistry public immutable registry;
    IPool public immutable pool;
    IJuryModule public immutable jury;

    uint256 public claimCount;
    mapping(uint256 => Claim) private _claims;
    /// @notice The claim currently open (not Rejected or Paid) for each policy id, or 0.
    mapping(uint256 => uint256) public openClaimOfPolicy;

    event ClaimSubmitted(
        uint256 indexed claimId,
        address indexed claimant,
        uint256 indexed policyId,
        uint256 amount,
        bytes32 evidenceHash
    );
    event ClaimStateChanged(uint256 indexed claimId, State from, State to);
    event ClaimPaid(uint256 indexed claimId, address indexed claimant, uint256 amount);

    error ZeroAddress();
    error NoActivePolicy();
    error WaitingPeriodNotElapsed();
    error InvalidAmount();
    error ExceedsCoverageLimit(uint256 amount, uint256 limit);
    error InvalidEvidence();
    error OpenClaimExists(uint256 claimId);
    error NotJuryModule();
    error WrongState(State expected, State actual);
    error NothingToPay();

    constructor(IPolicyRegistry registry_, IPool pool_, IJuryModule jury_) Ownable(msg.sender) {
        if (address(registry_) == address(0) || address(pool_) == address(0) || address(jury_) == address(0)) {
            revert ZeroAddress();
        }
        registry = registry_;
        pool = pool_;
        jury = jury_;
    }

    // ---------------------------------------------------------------------
    // Claimant
    // ---------------------------------------------------------------------

    /// @notice File a claim against the caller's active policy and kick off jury selection.
    /// @param amount Requested payout, in token units. Must not exceed the policy's coverage limit.
    /// @param evidenceHash Content hash of the (encrypted) evidence bundle stored off-chain, e.g. on IPFS.
    function submitClaim(uint256 amount, bytes32 evidenceHash) external nonReentrant returns (uint256 claimId) {
        IPolicyRegistry.Policy memory policy = registry.getPolicy(msg.sender);
        if (policy.status != IPolicyRegistry.Status.Active) revert NoActivePolicy();
        if (!registry.isPastWaitingPeriod(msg.sender)) revert WaitingPeriodNotElapsed();
        if (amount == 0) revert InvalidAmount();
        if (amount > policy.coverageLimit) revert ExceedsCoverageLimit(amount, policy.coverageLimit);
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        uint256 existing = openClaimOfPolicy[policy.id];
        if (existing != 0) revert OpenClaimExists(existing);

        claimId = ++claimCount;
        _claims[claimId] = Claim({
            id: claimId,
            claimant: msg.sender,
            policyId: policy.id,
            amount: amount,
            coverageLimit: policy.coverageLimit,
            evidenceHash: evidenceHash,
            state: State.Submitted,
            submittedAt: block.timestamp,
            paidAmount: 0
        });
        openClaimOfPolicy[policy.id] = claimId;
        emit ClaimSubmitted(claimId, msg.sender, policy.id, amount, evidenceHash);

        _setState(claimId, State.JuryPending);
        jury.requestJury(claimId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Jury callback
    // ---------------------------------------------------------------------

    /// @notice Called by the JuryModule once jurors have been selected.
    function startVoting(uint256 claimId) external {
        if (msg.sender != address(jury)) revert NotJuryModule();
        _requireState(claimId, State.JuryPending);
        _setState(claimId, State.Voting);
    }

    // ---------------------------------------------------------------------
    // Resolution (callable by anyone, so a claim can never be stuck on one party)
    // ---------------------------------------------------------------------

    /// @notice Close voting and record the verdict. Rejected claims are closed immediately.
    function finalize(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Voting);
        IJuryModule.Outcome outcome = jury.tally(claimId);
        if (outcome == IJuryModule.Outcome.Approved) {
            _setState(claimId, State.Approved);
        } else {
            _setState(claimId, State.Rejected);
            delete openClaimOfPolicy[_claims[claimId].policyId];
        }
    }

    /// @notice Pay an approved claim: min(claim amount, coverage limit, pool per-claim cap).
    function executePayout(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Approved);
        Claim storage claim = _claims[claimId];

        uint256 amount = payoutAmount(claimId);
        if (amount == 0) revert NothingToPay();

        // Effects before the external call (checks-effects-interactions).
        claim.paidAmount = amount;
        _setState(claimId, State.Paid);
        delete openClaimOfPolicy[claim.policyId];
        emit ClaimPaid(claimId, claim.claimant, amount);

        pool.payout(claim.claimant, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }

    /// @notice What `executePayout` would pay right now.
    function payoutAmount(uint256 claimId) public view returns (uint256 amount) {
        Claim storage claim = _claims[claimId];
        amount = claim.amount;
        if (claim.coverageLimit < amount) amount = claim.coverageLimit;
        uint256 cap = pool.maxPayout();
        if (cap < amount) amount = cap;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _requireState(uint256 claimId, State expected) private view {
        State actual = _claims[claimId].state;
        if (actual != expected) revert WrongState(expected, actual);
    }

    function _setState(uint256 claimId, State to) private {
        Claim storage claim = _claims[claimId];
        emit ClaimStateChanged(claimId, claim.state, to);
        claim.state = to;
    }
}
