// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IJuryModule} from "./interfaces/IJuryModule.sol";
import {IClaimManager} from "./interfaces/IClaimManager.sol";
import {IPolicyRegistry} from "./interfaces/IPolicyRegistry.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IRandomnessProvider.sol";

/// @title JuryModule
/// @notice Requests randomness, selects a jury from eligible policyholders, runs commit-reveal voting
///         and tallies the revealed votes.
/// @dev Holds no funds. Each juror votes the amount they think the claim should pay, from 0 (reject)
///      up to the amount requested, plus the hash of a short note explaining it (the note itself is
///      kept off-chain). The jury's offer is the median of the revealed amounts, so one juror voting
///      very high or very low cannot move it far. Voting has two windows so no juror can see another's
///      vote before choosing:
///      1. Commit: each juror submits keccak256(abi.encode(claimId, juror, amount, noteHash, salt)).
///      2. Reveal: opens when the commit window ends or every juror has committed; each juror reveals
///         (amount, noteHash, salt) and only revealed votes count. A commit never revealed counts as
///         no vote.
///
///      Incentives. Only members with at least `minStake` locked in the Pool are picked, and the stake
///      stays locked while they sit on a jury. When the jury is tallied:
///      - Jurors whose amount agrees with the outcome share a fee from the pool reserve. Agreeing
///        means: if the claim is rejected (median 0), voting 0; otherwise voting above 0 and within
///        `agreementBandBps` of the requested amount from the median. No fee is paid without quorum.
///      - Jurors who never revealed lose `noShowPenalty` of their stake, which is added to the fee.
///      - Jurors who voted but disagreed get nothing and lose nothing, so an honest minority view is
///        never punished.
contract JuryModule is IJuryModule, IRandomnessConsumer, Ownable {
    enum Phase {
        None,
        AwaitingRandomness,
        Voting,
        Tallied,
        Cancelled
    }

    /// @notice Stake, fee and penalty settings; amounts in token units, rates in basis points.
    struct Incentives {
        uint256 minStake;
        /// @dev Fee per claim, as a share of the requested amount, but at least `minFee`.
        uint256 feeBps;
        uint256 minFee;
        /// @dev How far from the median an amount may be and still agree, as a share of the request.
        uint256 agreementBandBps;
        uint256 noShowPenalty;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;

    struct Jury {
        Phase phase;
        address claimant;
        uint64 requestedAt;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint8 commits;
        uint8 approvals;
        uint8 rejections;
        Outcome outcome;
        /// @dev The most a juror can vote: the claim amount, capped by the coverage limit.
        uint256 maxAmount;
        /// @dev Median of the revealed amounts, set by `tally`; 0 when rejected.
        uint256 award;
        address[] jurors;
        uint256[] amounts;
    }

    IPolicyRegistry public immutable registry;
    IRandomnessProvider public immutable randomness;
    IPool public immutable pool;
    uint256 public immutable minStake;
    uint256 public immutable feeBps;
    uint256 public immutable minFee;
    uint256 public immutable agreementBandBps;
    uint256 public immutable noShowPenalty;
    uint8 public immutable jurySize;
    /// @notice Minimum number of revealed votes for a verdict to count; otherwise the claim is rejected.
    uint8 public immutable quorum;
    /// @notice Length of the commit window, starting when the jury is selected.
    uint256 public immutable commitPeriod;
    /// @notice Length of the reveal window, starting when the commit window ends.
    uint256 public immutable revealPeriod;
    /// @notice How long randomness may stay unanswered before the claim can be cancelled.
    uint256 public immutable randomnessTimeout;

    address public claimManager;

    mapping(uint256 => Jury) private _juries;
    mapping(uint256 => mapping(address => bool)) public isJuror;
    /// @notice Each juror's sealed vote, or zero if they have not committed.
    mapping(uint256 => mapping(address => bytes32)) public commitmentOf;
    mapping(uint256 => mapping(address => bool)) public hasRevealed;
    /// @notice A revealed juror's amount (0 means reject).
    mapping(uint256 => mapping(address => uint256)) public amountOf;
    /// @notice A revealed juror's note hash: keccak256 of the note text, or zero for no note.
    mapping(uint256 => mapping(address => bytes32)) public noteHashOf;
    /// @notice Set at tally: what each juror was paid, and what was taken from their stake.
    mapping(uint256 => mapping(address => uint256)) public rewardOf;
    mapping(uint256 => mapping(address => uint256)) public penaltyOf;
    /// @notice Set when randomness arrived but too few eligible jurors were left to seat a full jury.
    ///         The claim waits in AwaitingRandomness and may be cancelled straight away.
    mapping(uint256 => bool) public starved;

    event ClaimManagerSet(address indexed claimManager);
    event JuryRequested(uint256 indexed claimId, address indexed claimant);
    event JurySelected(
        uint256 indexed claimId,
        address[] jurors,
        uint256 seed,
        uint64 commitDeadline,
        uint64 revealDeadline
    );
    event VoteCommitted(uint256 indexed claimId, address indexed juror);
    event VoteRevealed(uint256 indexed claimId, address indexed juror, uint256 amount, bytes32 noteHash);
    event Tallied(uint256 indexed claimId, Outcome outcome, uint8 approvals, uint8 rejections, uint256 award);
    event JuryCancelled(uint256 indexed claimId);
    event JuryStarved(uint256 indexed claimId, uint256 available, uint256 required);
    event JurySettled(uint256 indexed claimId, uint256 agreeing, uint256 feePerJuror, uint256 penalties);

    error ZeroAddress();
    error AlreadySet();
    error InvalidConfig();
    error NotClaimManager();
    error NotRandomnessProvider();
    error WrongPhase(Phase expected, Phase actual);
    error NotEnoughEligibleJurors(uint256 available, uint256 required);
    error NotAJuror();
    error EmptyCommitment();
    error AlreadyCommitted();
    error CommitClosed();
    error NotCommitted();
    error AlreadyRevealed();
    error RevealNotOpen();
    error RevealClosed();
    error CommitmentMismatch();
    error VotingStillOpen();
    error RandomnessNotTimedOut();
    error AmountTooHigh(uint256 amount, uint256 maxAmount);

    modifier onlyClaimManager() {
        if (msg.sender != claimManager) revert NotClaimManager();
        _;
    }

    constructor(
        IPolicyRegistry registry_,
        IRandomnessProvider randomness_,
        IPool pool_,
        uint8 jurySize_,
        uint8 quorum_,
        uint256 commitPeriod_,
        uint256 revealPeriod_,
        uint256 randomnessTimeout_,
        Incentives memory incentives_
    ) Ownable(msg.sender) {
        if (address(registry_) == address(0) || address(randomness_) == address(0) || address(pool_) == address(0)) {
            revert ZeroAddress();
        }
        if (
            jurySize_ == 0 ||
            quorum_ == 0 ||
            quorum_ > jurySize_ ||
            commitPeriod_ == 0 ||
            revealPeriod_ == 0 ||
            randomnessTimeout_ == 0 ||
            incentives_.minStake == 0 ||
            incentives_.noShowPenalty > incentives_.minStake ||
            incentives_.feeBps > BPS_DENOMINATOR ||
            incentives_.agreementBandBps > BPS_DENOMINATOR
        ) {
            revert InvalidConfig();
        }
        registry = registry_;
        randomness = randomness_;
        pool = pool_;
        minStake = incentives_.minStake;
        feeBps = incentives_.feeBps;
        minFee = incentives_.minFee;
        agreementBandBps = incentives_.agreementBandBps;
        noShowPenalty = incentives_.noShowPenalty;
        jurySize = jurySize_;
        quorum = quorum_;
        commitPeriod = commitPeriod_;
        revealPeriod = revealPeriod_;
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
    /// @param maxAmount The most any juror may vote for this claim.
    function requestJury(uint256 claimId, address claimant, uint256 maxAmount) external onlyClaimManager {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.None) revert WrongPhase(Phase.None, jury.phase);

        uint256 available = eligibleJurors(claimant).length;
        if (available < jurySize) revert NotEnoughEligibleJurors(available, jurySize);

        jury.phase = Phase.AwaitingRandomness;
        jury.claimant = claimant;
        jury.maxAmount = maxAmount;
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
    ///      Never seats a short jury: if fewer than `jurySize` members are still eligible when the seed
    ///      arrives, the claim is marked starved and can be cancelled at once (see `canCancel`).
    function fulfillRandomness(uint256 claimId, uint256 seed) external {
        if (msg.sender != address(randomness)) revert NotRandomnessProvider();
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) revert WrongPhase(Phase.AwaitingRandomness, jury.phase);
        if (starved[claimId]) revert WrongPhase(Phase.AwaitingRandomness, jury.phase);

        // Eligibility is re-read at fulfilment time: policies may have lapsed or stakes been withdrawn.
        address[] memory candidates = eligibleJurors(jury.claimant);
        uint256 n = candidates.length;
        if (n < jurySize) {
            starved[claimId] = true;
            emit JuryStarved(claimId, n, jurySize);
            return;
        }
        uint256 k = jurySize;

        for (uint256 i = 0; i < k; i++) {
            uint256 j = i + (uint256(keccak256(abi.encode(seed, i))) % (n - i));
            (candidates[i], candidates[j]) = (candidates[j], candidates[i]);
            jury.jurors.push(candidates[i]);
            isJuror[claimId][candidates[i]] = true;
            pool.lockStake(candidates[i]);
        }

        jury.phase = Phase.Voting;
        jury.commitDeadline = uint64(block.timestamp + commitPeriod);
        jury.revealDeadline = uint64(block.timestamp + commitPeriod + revealPeriod);
        emit JurySelected(claimId, jury.jurors, seed, jury.commitDeadline, jury.revealDeadline);

        IClaimManager(claimManager).startVoting(claimId);
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    /// @notice The sealed vote a juror commits. Binding the claim and juror stops a commitment from
    ///         being copied to another claim or by another juror. Keep `salt` secret until revealing.
    /// @param amount What the juror thinks the claim should pay; 0 rejects it.
    /// @param noteHash keccak256 of the juror's note, so the note cannot be changed after seeing others.
    function computeCommitment(uint256 claimId, address juror, uint256 amount, bytes32 noteHash, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(claimId, juror, amount, noteHash, salt));
    }

    /// @notice Submit a sealed vote during the commit window. Each juror commits once.
    function commitVote(uint256 claimId, bytes32 commitment) external {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) revert WrongPhase(Phase.Voting, jury.phase);
        if (!isJuror[claimId][msg.sender]) revert NotAJuror();
        if (commitment == bytes32(0)) revert EmptyCommitment();
        if (commitmentOf[claimId][msg.sender] != bytes32(0)) revert AlreadyCommitted();
        if (block.timestamp > jury.commitDeadline) revert CommitClosed();

        commitmentOf[claimId][msg.sender] = commitment;
        jury.commits++;
        emit VoteCommitted(claimId, msg.sender);
    }

    /// @notice Open a sealed vote during the reveal window. Only revealed votes are counted.
    function revealVote(uint256 claimId, uint256 amount, bytes32 noteHash, bytes32 salt) external {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) revert WrongPhase(Phase.Voting, jury.phase);
        bytes32 commitment = commitmentOf[claimId][msg.sender];
        if (commitment == bytes32(0)) revert NotCommitted();
        if (hasRevealed[claimId][msg.sender]) revert AlreadyRevealed();
        if (!revealOpen(claimId)) revert RevealNotOpen();
        if (block.timestamp > jury.revealDeadline) revert RevealClosed();
        if (computeCommitment(claimId, msg.sender, amount, noteHash, salt) != commitment) revert CommitmentMismatch();
        if (amount > jury.maxAmount) revert AmountTooHigh(amount, jury.maxAmount);

        hasRevealed[claimId][msg.sender] = true;
        amountOf[claimId][msg.sender] = amount;
        noteHashOf[claimId][msg.sender] = noteHash;
        jury.amounts.push(amount);
        if (amount > 0) {
            jury.approvals++;
        } else {
            jury.rejections++;
        }
        emit VoteRevealed(claimId, msg.sender, amount, noteHash);
    }

    /// @notice Closes voting and returns the verdict and the jury's offer. Allowed once the reveal window
    ///         has ended, or once every juror has committed and revealed.
    /// @dev The offer is the median revealed amount (the lower middle one for an even count, so a split
    ///      jury errs towards paying less). Approved iff at least `quorum` votes were revealed and the
    ///      median is above zero, which means strictly more jurors voted to pay than to reject.
    function tally(uint256 claimId) external onlyClaimManager returns (Outcome outcome, uint256 award) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) revert WrongPhase(Phase.Voting, jury.phase);
        if (!canTally(claimId)) revert VotingStillOpen();

        if (quorate(claimId)) award = medianAmount(claimId);
        outcome = award > 0 ? Outcome.Approved : Outcome.Rejected;

        jury.phase = Phase.Tallied;
        jury.outcome = outcome;
        jury.award = award;
        emit Tallied(claimId, outcome, jury.approvals, jury.rejections, award);
        _settle(claimId, jury);
    }

    /// @dev Penalizes no-shows, pays agreeing jurors and unlocks everyone's stake. Runs once, at tally.
    function _settle(uint256 claimId, Jury storage jury) private {
        address[] memory jurors = jury.jurors;
        bool hasQuorum = quorate(claimId);
        uint256 agreeing;
        uint256 penalties;
        for (uint256 i = 0; i < jurors.length; i++) {
            address juror = jurors[i];
            if (!hasRevealed[claimId][juror]) {
                uint256 taken = pool.penalize(juror, noShowPenalty);
                penaltyOf[claimId][juror] = taken;
                penalties += taken;
            } else if (hasQuorum && agrees(claimId, amountOf[claimId][juror])) {
                agreeing++;
            }
            pool.unlockStake(juror);
        }
        uint256 share;
        if (agreeing > 0) {
            share = (feeFor(claimId) + penalties) / agreeing;
            for (uint256 i = 0; i < jurors.length; i++) {
                address juror = jurors[i];
                if (hasRevealed[claimId][juror] && agrees(claimId, amountOf[claimId][juror])) {
                    rewardOf[claimId][juror] = pool.payJurorFee(juror, share);
                }
            }
        }
        emit JurySettled(claimId, agreeing, share, penalties);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice True once reveals are accepted: the commit window has ended or every juror has committed.
    function revealOpen(uint256 claimId) public view returns (bool) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) return false;
        return block.timestamp > jury.commitDeadline || jury.commits == jury.jurors.length;
    }

    function canTally(uint256 claimId) public view returns (bool) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.Voting) return false;
        uint256 revealed = uint256(jury.approvals) + jury.rejections;
        return block.timestamp > jury.revealDeadline || revealed == jury.jurors.length;
    }

    /// @notice True once randomness has been pending for longer than `randomnessTimeout`, or as soon
    ///         as the claim is starved of jurors.
    function canCancel(uint256 claimId) public view returns (bool) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) return false;
        return starved[claimId] || block.timestamp > cancelAvailableAt(claimId);
    }

    /// @notice When a still-pending randomness request becomes cancellable, or 0 if none is pending.
    ///         A starved claim is cancellable from the moment it was filed.
    function cancelAvailableAt(uint256 claimId) public view returns (uint256) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) return 0;
        if (starved[claimId]) return uint256(jury.requestedAt);
        return uint256(jury.requestedAt) + randomnessTimeout;
    }

    /// @notice Policyholders who may be picked for a jury on `claimant`'s claim: past their waiting
    ///         period, not the claimant, and with at least `minStake` locked in the Pool.
    function eligibleJurors(address claimant) public view returns (address[] memory) {
        address[] memory holders = registry.eligibleJurors(claimant);
        uint256 count;
        for (uint256 i = 0; i < holders.length; i++) {
            if (pool.stakeOf(holders[i]) >= minStake) holders[count++] = holders[i];
        }
        address[] memory staked = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            staked[i] = holders[i];
        }
        return staked;
    }

    /// @notice The fee shared by agreeing jurors (before penalties are added): `feeBps` of the amount
    ///         requested, but at least `minFee`.
    function feeFor(uint256 claimId) public view returns (uint256) {
        uint256 fee = (_juries[claimId].maxAmount * feeBps) / BPS_DENOMINATOR;
        return fee < minFee ? minFee : fee;
    }

    /// @notice Whether `amount` agrees with a tallied jury's outcome, and so earns a share of the fee.
    function agrees(uint256 claimId, uint256 amount) public view returns (bool) {
        Jury storage jury = _juries[claimId];
        uint256 award = jury.award;
        if (award == 0) return amount == 0;
        if (amount == 0) return false;
        uint256 band = (jury.maxAmount * agreementBandBps) / BPS_DENOMINATOR;
        return amount > award ? amount - award <= band : award - amount <= band;
    }

    /// @notice Whether at least `quorum` votes have been revealed. A jury without quorum decides nothing.
    function quorate(uint256 claimId) public view returns (bool) {
        return _juries[claimId].amounts.length >= quorum;
    }

    /// @notice The lower median of the amounts revealed so far, or 0 if none are.
    function medianAmount(uint256 claimId) public view returns (uint256) {
        uint256[] memory amounts = _juries[claimId].amounts;
        uint256 n = amounts.length;
        if (n == 0) return 0;
        // Insertion sort: a jury is a handful of votes.
        for (uint256 i = 1; i < n; i++) {
            uint256 value = amounts[i];
            uint256 j = i;
            while (j > 0 && amounts[j - 1] > value) {
                amounts[j] = amounts[j - 1];
                j--;
            }
            amounts[j] = value;
        }
        return amounts[(n - 1) / 2];
    }

    /// @notice The jury's offer once tallied (0 when rejected), and the most a juror may vote.
    function getAward(uint256 claimId) external view returns (uint256 award, uint256 maxAmount) {
        Jury storage jury = _juries[claimId];
        return (jury.award, jury.maxAmount);
    }

    function getJurors(uint256 claimId) external view returns (address[] memory) {
        return _juries[claimId].jurors;
    }

    /// @notice `approvals` and `rejections` count revealed votes only, so they stay 0 while commits are sealed.
    function getJury(uint256 claimId)
        external
        view
        returns (
            Phase phase,
            address claimant,
            uint64 commitDeadline,
            uint64 revealDeadline,
            uint8 commits,
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
            jury.commitDeadline,
            jury.revealDeadline,
            jury.commits,
            jury.approvals,
            jury.rejections,
            jury.outcome,
            jury.jurors
        );
    }
}
