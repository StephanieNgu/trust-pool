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
///         Submitted -> JuryPending -> Voting -> Offered -> Approved -> Paid, or Voting -> Rejected,
///         or Offered -> Withdrawn when the claimant turns the jury's offer down,
///         or JuryPending -> Cancelled when randomness never arrives.
/// @dev The jury votes an amount rather than yes/no. Its offer (the median juror amount, capped) is
///      shown to the claimant with each juror's reasoning; the claimant accepts or withdraws within
///      `responsePeriod`. Saying nothing counts as accepting, so a claim never waits on the claimant.
/// @dev Holds no funds. Payouts are executed by the Pool on this contract's instruction.
contract ClaimManager is IClaimManager, Ownable, ReentrancyGuard {
    enum State {
        None,
        Submitted,
        JuryPending,
        Voting,
        Approved,
        Rejected,
        Paid,
        Cancelled,
        Offered,
        Withdrawn
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
        /// @dev Payout fixed when the jury decides: min(jury offer, coverage limit, pool cap at that moment).
        uint256 approvedAmount;
        /// @dev While Offered: when the claimant's time to accept or withdraw ends.
        uint256 offerDeadline;
    }

    IPolicyRegistry public immutable registry;
    IPool public immutable pool;
    IJuryModule public immutable jury;
    /// @notice How long a claimant has to accept or withdraw the jury's offer before it is accepted for them.
    uint256 public immutable responsePeriod;

    uint256 public claimCount;
    mapping(uint256 => Claim) private _claims;
    /// @notice The claim currently open (not Rejected, Paid or Cancelled) for each policy id, or 0.
    mapping(uint256 => uint256) public override openClaimOfPolicy;

    event ClaimSubmitted(
        uint256 indexed claimId,
        address indexed claimant,
        uint256 indexed policyId,
        uint256 amount,
        bytes32 evidenceHash
    );
    event ClaimStateChanged(uint256 indexed claimId, State from, State to);
    event ClaimPaid(uint256 indexed claimId, address indexed claimant, uint256 amount);
    event OfferMade(uint256 indexed claimId, uint256 amount, uint256 deadline);

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
    error NotClaimant();
    error ResponseWindowOpen(uint256 deadline);
    error ResponseWindowClosed(uint256 deadline);
    error InvalidConfig();

    constructor(IPolicyRegistry registry_, IPool pool_, IJuryModule jury_, uint256 responsePeriod_)
        Ownable(msg.sender)
    {
        if (address(registry_) == address(0) || address(pool_) == address(0) || address(jury_) == address(0)) {
            revert ZeroAddress();
        }
        if (responsePeriod_ == 0) revert InvalidConfig();
        registry = registry_;
        pool = pool_;
        jury = jury_;
        responsePeriod = responsePeriod_;
    }

    // ---------------------------------------------------------------------
    // Claimant
    // ---------------------------------------------------------------------

    /// @notice File a claim against the caller's active policy and kick off jury selection.
    /// @param amount Requested payout, in token units. Must not exceed the policy's coverage limit.
    ///        Jurors may vote any amount from 0 up to this.
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
            paidAmount: 0,
            approvedAmount: 0,
            offerDeadline: 0
        });
        openClaimOfPolicy[policy.id] = claimId;
        emit ClaimSubmitted(claimId, msg.sender, policy.id, amount, evidenceHash);

        _setState(claimId, State.JuryPending);
        jury.requestJury(claimId, msg.sender, amount);
    }

    /// @notice Take the jury's offer. The claimant can accept any time while it is open; after
    ///         `offerDeadline` anyone can, so silence counts as accepting.
    function acceptOffer(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Offered);
        Claim storage claim = _claims[claimId];
        if (msg.sender != claim.claimant && block.timestamp <= claim.offerDeadline) {
            revert ResponseWindowOpen(claim.offerDeadline);
        }
        _setState(claimId, State.Approved);
    }

    /// @notice Turn the jury's offer down and close the claim with no payout. Only the claimant,
    ///         and only before `offerDeadline`.
    function withdrawClaim(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Offered);
        Claim storage claim = _claims[claimId];
        if (msg.sender != claim.claimant) revert NotClaimant();
        if (block.timestamp > claim.offerDeadline) revert ResponseWindowClosed(claim.offerDeadline);
        claim.approvedAmount = 0;
        _setState(claimId, State.Withdrawn);
        delete openClaimOfPolicy[claim.policyId];
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
    ///         An approved claim becomes an offer to the claimant; its amount is fixed here, so later
    ///         pool movements cannot change it.
    function finalize(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Voting);
        (IJuryModule.Outcome outcome, uint256 award) = jury.tally(claimId);
        if (outcome == IJuryModule.Outcome.Approved) {
            Claim storage claim = _claims[claimId];
            claim.approvedAmount = _capped(claim, award);
            claim.offerDeadline = block.timestamp + responsePeriod;
            _setState(claimId, State.Offered);
            emit OfferMade(claimId, claim.approvedAmount, claim.offerDeadline);
        } else {
            _setState(claimId, State.Rejected);
            delete openClaimOfPolicy[_claims[claimId].policyId];
        }
    }

    /// @notice Pay an approved claim the amount fixed at approval. If the pool cannot cover it right
    ///         now the Pool reverts and the claim stays Approved until it can (first come, first served).
    function executePayout(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Approved);
        Claim storage claim = _claims[claimId];

        uint256 amount = claim.approvedAmount;
        if (amount == 0) revert NothingToPay();

        // Effects before the external call (checks-effects-interactions).
        claim.paidAmount = amount;
        _setState(claimId, State.Paid);
        delete openClaimOfPolicy[claim.policyId];
        emit ClaimPaid(claimId, claim.claimant, amount);

        pool.payout(claim.claimant, amount);
    }

    /// @notice Close a claim whose randomness never arrived, freeing the policy for a new claim.
    ///         Callable by anyone once the JuryModule's randomness timeout has passed.
    function cancelStalledClaim(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.JuryPending);
        jury.cancel(claimId);
        _setState(claimId, State.Cancelled);
        delete openClaimOfPolicy[_claims[claimId].policyId];
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }

    /// @notice What the claim pays: the fixed amount once the jury has made its offer, otherwise the
    ///         most a full approval would fix right now (min of claim amount, coverage limit, pool cap).
    function payoutAmount(uint256 claimId) public view returns (uint256) {
        Claim storage claim = _claims[claimId];
        State state = claim.state;
        if (state == State.Offered || state == State.Approved || state == State.Paid || state == State.Withdrawn) {
            return claim.approvedAmount;
        }
        return _capped(claim, claim.amount);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _capped(Claim storage claim, uint256 amount) private view returns (uint256) {
        if (claim.coverageLimit < amount) amount = claim.coverageLimit;
        uint256 cap = pool.maxPayout();
        return cap < amount ? cap : amount;
    }

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
