// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IJuryModule} from "./interfaces/IJuryModule.sol";
import {IClaimManager} from "./interfaces/IClaimManager.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IRandomnessProvider.sol";

/// @title JuryModule
/// @notice Requests randomness, selects a jury from eligible policyholders, records votes and tallies them.
/// @dev Holds no funds. Voting is plain on-chain (no commit-reveal) for the prototype.
contract JuryModule is IJuryModule, IRandomnessConsumer, Ownable {
    enum Phase {
        None,
        AwaitingRandomness,
        Voting,
        Tallied,
        Cancelled
    }

    struct Jury {
        Phase phase;
        address claimant;
        uint64 votingDeadline;
        uint64 requestedAt;
        uint8 approvals;
        uint8 rejections;
        Outcome outcome;
        address[] jurors;
    }

    IPolicyRegistry public immutable registry;
    IRandomnessProvider public immutable randomness;
    uint8 public immutable jurySize;
    /// @notice Minimum number of votes cast for a verdict to count; otherwise the claim is rejected.
    uint8 public immutable quorum;
    uint256 public immutable votingPeriod;
    /// @notice How long randomness may stay unanswered before the claim can be cancelled.
    uint256 public immutable randomnessTimeout;

    address public claimManager;

    mapping(uint256 => Jury) private _juries;
    mapping(uint256 => mapping(address => bool)) public isJuror;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event ClaimManagerSet(address indexed claimManager);
    event JuryRequested(uint256 indexed claimId, address indexed claimant);
    event JurySelected(uint256 indexed claimId, address[] jurors, uint256 seed, uint64 votingDeadline);
    event VoteCast(uint256 indexed claimId, address indexed juror, bool approve);
    event Tallied(uint256 indexed claimId, Outcome outcome, uint8 approvals, uint8 rejections);
    event JuryCancelled(uint256 indexed claimId);

    error ZeroAddress();
    error AlreadySet();
    error InvalidConfig();
    error NotClaimManager();
    error NotRandomnessProvider();
    error WrongPhase(Phase expected, Phase actual);
    error NotEnoughEligibleJurors(uint256 available, uint256 required);
    error NotAJuror();
    error AlreadyVoted();
    error VotingClosed();
    error VotingStillOpen();
    error RandomnessNotTimedOut();

    modifier onlyClaimManager() {
        if (msg.sender != claimManager) revert NotClaimManager();
        _;
    }

    constructor(
        IPolicyRegistry registry_,
        IRandomnessProvider randomness_,
        uint8 jurySize_,
        uint8 quorum_,
        uint256 votingPeriod_,
        uint256 randomnessTimeout_
    ) Ownable(msg.sender) {
        if (address(registry_) == address(0) || address(randomness_) == address(0)) revert ZeroAddress();
        if (jurySize_ == 0 || quorum_ == 0 || quorum_ > jurySize_ || votingPeriod_ == 0 || randomnessTimeout_ == 0) {
            revert InvalidConfig();
        }
        registry = registry_;
        randomness = randomness_;
        jurySize = jurySize_;
        quorum = quorum_;
        votingPeriod = votingPeriod_;
        randomnessTimeout = randomnessTimeout_;
    }

    function setClaimManager(address claimManager_) external onlyOwner {
        if (claimManager_ == address(0)) revert ZeroAddress();
        if (claimManager != address(0)) revert AlreadySet();
        claimManager = claimManager_;
        emit ClaimManagerSet(claimManager_);
    }

    // ---------------------------------------------------------------------
    // Selection
    // ---------------------------------------------------------------------

    /// @notice Starts jury selection for a claim. Fails fast if there are not enough eligible jurors.
    function requestJury(uint256 claimId, address claimant) external onlyClaimManager {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.None) revert WrongPhase(Phase.None, jury.phase);

        uint256 available = registry.eligibleJurors(claimant).length;
        if (available < jurySize) revert NotEnoughEligibleJurors(available, jurySize);

        jury.phase = Phase.AwaitingRandomness;
        jury.claimant = claimant;
        jury.requestedAt = uint64(block.timestamp);
        emit JuryRequested(claimId, claimant);
        randomness.requestRandomness(claimId);
    }

    /// @notice Gives up on a randomness request that has gone unanswered for `randomnessTimeout`.
    ///         A late callback afterwards reverts, so a cancelled claim can never get a jury.
    function cancel(uint256 claimId) external onlyClaimManager {
        if (!canCancel(claimId)) revert RandomnessNotTimedOut();
        _juries[claimId].phase = Phase.Cancelled;
        emit JuryCancelled(claimId);
    }

    /// @notice Randomness callback. Picks jurors via a partial Fisher-Yates shuffle seeded by `seed`.
    /// @dev Only the first callback selects a jury; any later one (or one after `cancel`) reverts.
    function fulfillRandomness(uint256 claimId, uint256 seed) external {
        if (msg.sender != address(randomness)) revert NotRandomnessProvider();
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) revert WrongPhase(Phase.AwaitingRandomness, jury.phase);

        // Eligibility is re-read at fulfilment time: policies may have lapsed since the request.
        address[] memory pool = registry.eligibleJurors(jury.claimant);
        uint256 n = pool.length;
        uint256 k = n < jurySize ? n : jurySize;

        for (uint256 i = 0; i < k; i++) {
            uint256 j = i + (uint256(keccak256(abi.encode(seed, i))) % (n - i));
            (pool[i], pool[j]) = (pool[j], pool[i]);
            jury.jurors.push(pool[i]);
            isJuror[claimId][pool[i]] = true;
        }

        jury.phase = Phase.Voting;
        jury.votingDeadline = uint64(block.timestamp + votingPeriod);
        emit JurySelected(claimId, jury.jurors, seed, jury.votingDeadline);

        IClaimManager(claimManager).startVoting(claimId);
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    function castVote(uint256 claimId, bool approve) external {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) revert WrongPhase(Phase.Voting, jury.phase);
        if (block.timestamp > jury.votingDeadline) revert VotingClosed();
        if (!isJuror[claimId][msg.sender]) revert NotAJuror();
        if (hasVoted[claimId][msg.sender]) revert AlreadyVoted();

        hasVoted[claimId][msg.sender] = true;
        if (approve) {
            jury.approvals++;
        } else {
            jury.rejections++;
        }
        emit VoteCast(claimId, msg.sender, approve);
    }

    /// @notice Closes voting and returns the verdict. Allowed once the deadline has passed or every juror voted.
    /// @dev Approved iff at least `quorum` votes were cast and approvals strictly outnumber rejections.
    function tally(uint256 claimId) external onlyClaimManager returns (Outcome outcome) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) revert WrongPhase(Phase.Voting, jury.phase);
        if (!canTally(claimId)) revert VotingStillOpen();

        uint256 votes = uint256(jury.approvals) + jury.rejections;
        outcome = (votes >= quorum && jury.approvals > jury.rejections) ? Outcome.Approved : Outcome.Rejected;

        jury.phase = Phase.Tallied;
        jury.outcome = outcome;
        emit Tallied(claimId, outcome, jury.approvals, jury.rejections);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function canTally(uint256 claimId) public view returns (bool) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) return false;
        uint256 votes = uint256(jury.approvals) + jury.rejections;
        return block.timestamp > jury.votingDeadline || votes == jury.jurors.length;
    }

    /// @notice True once randomness has been pending for longer than `randomnessTimeout`.
    function canCancel(uint256 claimId) public view returns (bool) {
        Jury storage jury = _juries[claimId];
        return jury.phase == Phase.AwaitingRandomness && block.timestamp > cancelAvailableAt(claimId);
    }

    /// @notice When a still-pending randomness request becomes cancellable, or 0 if none is pending.
    function cancelAvailableAt(uint256 claimId) public view returns (uint256) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) return 0;
        return uint256(jury.requestedAt) + randomnessTimeout;
    }

    function getJurors(uint256 claimId) external view returns (address[] memory) {
        return _juries[claimId].jurors;
    }

    function getJury(uint256 claimId)
        external
        view
        returns (
            Phase phase,
            address claimant,
            uint64 votingDeadline,
            uint8 approvals,
            uint8 rejections,
            Outcome outcome,
            address[] memory jurors
        )
    {
        Jury storage jury = _juries[claimId];
        return (
            jury.phase,
            jury.claimant,
            jury.votingDeadline,
            jury.approvals,
            jury.rejections,
            jury.outcome,
            jury.jurors
        );
    }
}
