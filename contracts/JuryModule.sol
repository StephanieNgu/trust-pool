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
/// @dev Jury selection takes two steps so the VRF callback stays small and cheap:
///      1. `fulfillRandomness` (the VRF callback) only stores the seed.
///      2. `seatJury` (anyone may call it, the keeper does) seats the jury from that seed.
///      Only members who were already eligible when the claim was filed can be picked, and they are
///      taken in an order fixed by the seed. So between the two steps, seeing the seed lets a member do
///      one thing: drop out (unstake or lapse), which removes only themselves; nobody can join, and the
///      order of everyone else does not change.
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
    /// @notice Pools with at most this many policyholders (when the claim was filed) rank every
    ///         candidate when seating a jury; larger pools sample members by index so `seatJury`'s gas
    ///         stays flat as the pool grows.
    uint256 public constant SCAN_LIMIT = 25;
    /// @notice In pools above `SCAN_LIMIT`, how many random draws each jury seat may use.
    uint256 public constant MAX_DRAWS_PER_SEAT = 6;

    struct Jury {
        Phase phase;
        address claimant;
        uint64 requestedAt;
        /// @dev Set by the VRF callback; the seed itself is in `seedOf`.
        bool seeded;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint8 commits;
        uint8 approvals;
        uint8 rejections;
        Outcome outcome;
        /// @dev The most a juror can vote: the claim amount, capped by the coverage limit.
        uint256 maxAmount;
        /// @dev Number of policyholders when the claim was filed; later holders are never candidates.
        uint256 holdersAtFiling;
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
    /// @notice The VRF word delivered for each claim (0 until it arrives). With the registry and pool
    ///         history it lets anyone recompute who `seatJury` picks.
    mapping(uint256 => uint256) public seedOf;

    event ClaimManagerSet(address indexed claimManager);
    event JuryRequested(uint256 indexed claimId, address indexed claimant);
    /// @notice The VRF word arrived; `seatJury` can now seat the jury.
    event SeedReceived(uint256 indexed claimId, uint256 seed);
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
    error NotSeeded();

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
        jury.holdersAtFiling = registry.holderCount();
        emit JuryRequested(claimId, claimant);
        randomness.requestRandomness(claimId);
    }

    /// @notice Gives up on a randomness request that has gone unanswered for `randomnessTimeout`, or on
    ///         a starved claim. A late callback afterwards reverts, so a cancelled claim can never get a
    ///         jury. Once the seed has arrived the claim cannot be cancelled (unless starved), so nobody
    ///         can throw away a draw they dislike.
    function cancel(uint256 claimId) external onlyClaimManager {
        if (!canCancel(claimId)) revert RandomnessNotTimedOut();
        _juries[claimId].phase = Phase.Cancelled;
        emit JuryCancelled(claimId);
    }

    /// @notice Randomness callback. Only stores the seed, so Chainlink's callback gas (and with it the
    ///         LINK the subscription must hold in reserve) stays small; `seatJury` does the rest.
    /// @dev Only the first callback counts; any later one (or one after `cancel`) reverts, and
    ///      VRFRandomness reports that instead of failing the coordinator's transaction.
    function fulfillRandomness(uint256 claimId, uint256 seed) external {
        if (msg.sender != address(randomness)) revert NotRandomnessProvider();
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) revert WrongPhase(Phase.AwaitingRandomness, jury.phase);
        if (jury.seeded) revert WrongPhase(Phase.AwaitingRandomness, jury.phase);
        jury.seeded = true;
        seedOf[claimId] = seed;
        emit SeedReceived(claimId, seed);
    }

    /// @notice Seats the jury for a claim whose seed has arrived. Anyone may call it; the result
    ///         depends only on the seed and on who is still eligible, not on the caller or timing.
    /// @dev Candidates are members who were already eligible when the claim was filed (policy past its
    ///      waiting period and stake placed by then) and still are now. Members are taken in an order
    ///      fixed by the seed, so someone who drops out between the seed and this call only removes
    ///      themselves, and the next member in that order takes the seat.
    ///      - Up to `SCAN_LIMIT` holders at filing: every candidate gets a score
    ///        keccak256(seed, member) and the `jurySize` lowest scores sit (a uniform random subset).
    ///      - Above that: holder indexes are drawn as keccak256(seed, draw) % holdersAtFiling, skipping
    ///        non-candidates and repeats (rejection sampling, still uniform), with at most
    ///        `MAX_DRAWS_PER_SEAT` draws per seat so gas stays flat.
    ///      Never seats a short jury: if fewer than `jurySize` candidates are found the claim is marked
    ///      starved and can be cancelled at once (see `canCancel`).
    function seatJury(uint256 claimId) external {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) revert WrongPhase(Phase.AwaitingRandomness, jury.phase);
        if (!jury.seeded) revert NotSeeded();
        if (starved[claimId]) revert WrongPhase(Phase.AwaitingRandomness, jury.phase);

        uint256 seed = seedOf[claimId];
        (address[] memory picked, uint256 available) = jury.holdersAtFiling <= SCAN_LIMIT
            ? _rank(jury, seed)
            : _sample(jury, seed);
        if (picked.length < jurySize) {
            starved[claimId] = true;
            emit JuryStarved(claimId, available, jurySize);
            return;
        }
        for (uint256 i = 0; i < picked.length; i++) {
            jury.jurors.push(picked[i]);
            isJuror[claimId][picked[i]] = true;
            pool.lockStake(picked[i]);
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

    /// @notice True once randomness has been pending for longer than `randomnessTimeout` without a
    ///         seed arriving, or as soon as the claim is starved of jurors. A claim whose seed has
    ///         arrived is waiting only for `seatJury`, which anyone can call, so it cannot be cancelled.
    function canCancel(uint256 claimId) public view returns (bool) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) return false;
        if (starved[claimId]) return true;
        return !jury.seeded && block.timestamp > cancelAvailableAt(claimId);
    }

    /// @notice When a still-pending randomness request becomes cancellable, or 0 if none is pending
    ///         (including once the seed has arrived). A starved claim is cancellable from filing.
    function cancelAvailableAt(uint256 claimId) public view returns (uint256) {
        Jury storage jury = _juries[claimId];
        if (jury.phase != Phase.AwaitingRandomness) return 0;
        if (starved[claimId]) return uint256(jury.requestedAt);
        if (jury.seeded) return 0;
        return uint256(jury.requestedAt) + randomnessTimeout;
    }

    /// @notice True when the seed has arrived and `seatJury` will seat a jury or mark the claim starved.
    function canSeat(uint256 claimId) external view returns (bool) {
        Jury storage jury = _juries[claimId];
        return jury.phase == Phase.AwaitingRandomness && jury.seeded && !starved[claimId];
    }

    /// @dev Small pools: the `jurySize` candidates with the lowest keccak256(seed, member). Returns
    ///      fewer (and how many candidates there were) when the jury cannot be filled.
    function _rank(Jury storage jury, uint256 seed) private view returns (address[] memory picked, uint256 n) {
        uint256 holders = jury.holdersAtFiling;
        uint256 k = jurySize;
        address[] memory best = new address[](k);
        uint256[] memory scores = new uint256[](k);
        for (uint256 i = 0; i < holders; i++) {
            address candidate = registry.holderAt(i);
            if (!_isCandidate(jury, candidate)) continue;
            uint256 score = uint256(keccak256(abi.encode(seed, candidate)));
            // Insert into the sorted top-k list (k is a handful).
            uint256 filled = n < k ? n : k;
            n++;
            if (filled == k && score >= scores[k - 1]) continue;
            uint256 j = filled == k ? k - 1 : filled;
            while (j > 0 && scores[j - 1] > score) {
                scores[j] = scores[j - 1];
                best[j] = best[j - 1];
                j--;
            }
            scores[j] = score;
            best[j] = candidate;
        }
        if (n < k) return (new address[](0), n);
        picked = best;
    }

    /// @dev Large pools: rejection sampling by holder index, in gas bounded by
    ///      `jurySize * MAX_DRAWS_PER_SEAT`. Returns the members found (fewer than `jurySize` if the
    ///      draws ran out).
    function _sample(Jury storage jury, uint256 seed) private view returns (address[] memory picked, uint256 found) {
        uint256 n = jury.holdersAtFiling;
        uint256 maxDraws = uint256(jurySize) * MAX_DRAWS_PER_SEAT;
        picked = new address[](jurySize);
        for (uint256 draw = 0; draw < maxDraws && found < jurySize; draw++) {
            address candidate = registry.holderAt(uint256(keccak256(abi.encode(seed, draw))) % n);
            if (!_isCandidate(jury, candidate)) continue;
            bool seated;
            for (uint256 i = 0; i < found; i++) {
                if (picked[i] == candidate) {
                    seated = true;
                    break;
                }
            }
            if (!seated) picked[found++] = candidate;
        }
        if (found < jurySize) {
            address[] memory shortList = new address[](found);
            for (uint256 i = 0; i < found; i++) shortList[i] = picked[i];
            picked = shortList;
        }
    }

    /// @dev Eligible now, and already eligible when the claim was filed: policy past its waiting
    ///      period by then and stake last topped up by then. Topping up or re-buying a policy after
    ///      filing therefore takes a member out of this claim's draw rather than into it.
    function _isCandidate(Jury storage jury, address member) private view returns (bool) {
        if (member == jury.claimant || !_isEligible(member)) return false;
        uint256 filedAt = jury.requestedAt;
        if (pool.stakedAt(member) > filedAt) return false;
        return registry.getPolicy(member).startTime + registry.waitingPeriod() <= filedAt;
    }

    function _isEligible(address member) private view returns (bool) {
        return pool.stakeOf(member) >= minStake && registry.isPastWaitingPeriod(member);
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
