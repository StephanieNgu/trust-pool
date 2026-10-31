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
///         or JuryPending -> Cancelled when randomness never arrives,
///         or Approved -> Expired when no receipt arrives in time.
/// @dev The jury votes an amount rather than yes/no. Its offer (the median juror amount, capped) is
///      shown to the claimant with each juror's reasoning; the claimant accepts or withdraws within
///      `responsePeriod`. Saying nothing counts as accepting, so a claim never waits on the claimant.
/// @dev Filing a claim posts a bond (`bondBps` of the amount asked, at least `minBond`), held by the Pool.
///      When the jury decides, the claimant gets the bond back minus the share of the ask the jury cut:
///      a claim paid in full loses nothing, one cut to half loses half the bond, and a rejected claim
///      loses all of it. The forfeited part joins the reserve. A jury without quorum or a stalled
///      claim refunds the bond in full, since nobody judged the claim.
/// @dev Payout is reimbursement: once the offer is accepted the claimant has `receiptPeriod` to submit
///      the receipt for the repair or replacement (its hash and total). The claim then pays the smaller
///      of the offer and the receipt, so money goes to what was actually spent.
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
        Withdrawn,
        Expired
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
        /// @dev Posted when the claim is filed and settled when the jury decides (or the claim is cancelled).
        uint256 bond;
        uint256 bondForfeited;
        /// @dev Set when the offer is accepted: the receipt must arrive by then or the claim expires.
        uint256 receiptDeadline;
        /// @dev Content hash of the receipt bundle stored off-chain, and the total it shows.
        bytes32 receiptHash;
        uint256 receiptAmount;
    }

    IPolicyRegistry public immutable registry;
    IPool public immutable pool;
    IJuryModule public immutable jury;
    /// @notice How long a claimant has to accept or withdraw the jury's offer before it is accepted for them.
    uint256 public immutable responsePeriod;
    /// @notice The claimant's bond: `bondBps` of the amount asked, but at least `minBond`.
    uint256 public immutable bondBps;
    uint256 public immutable minBond;
    /// @notice How long after accepting an offer the claimant has to submit the repair or replacement receipt.
    uint256 public immutable receiptPeriod;

    uint256 public constant BPS_DENOMINATOR = 10_000;

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
    event BondSettled(uint256 indexed claimId, uint256 returned, uint256 forfeited);
    event ReceiptSubmitted(uint256 indexed claimId, bytes32 receiptHash, uint256 amount, uint256 payout);

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
    error ReceiptRequired();
    error ReceiptAlreadySubmitted();
    error ReceiptWindowOpen(uint256 deadline);
    error ReceiptWindowClosed(uint256 deadline);

    constructor(
        IPolicyRegistry registry_,
        IPool pool_,
        IJuryModule jury_,
        uint256 responsePeriod_,
        uint256 bondBps_,
        uint256 minBond_,
        uint256 receiptPeriod_
    ) Ownable(msg.sender) {
        if (address(registry_) == address(0) || address(pool_) == address(0) || address(jury_) == address(0)) {
            revert ZeroAddress();
        }
        if (responsePeriod_ == 0 || receiptPeriod_ == 0 || bondBps_ > BPS_DENOMINATOR) revert InvalidConfig();
        registry = registry_;
        pool = pool_;
        jury = jury_;
        responsePeriod = responsePeriod_;
        bondBps = bondBps_;
        minBond = minBond_;
        receiptPeriod = receiptPeriod_;
    }

    // ---------------------------------------------------------------------
    // Claimant
    // ---------------------------------------------------------------------

    /// @notice File a claim against the caller's active policy and kick off jury selection.
    /// @param amount Requested payout, in token units. Must not exceed the policy's coverage limit.
    ///        Jurors may vote any amount from 0 up to this.
    /// @param evidenceHash Content hash of the (encrypted) evidence bundle stored off-chain, e.g. on IPFS.
    /// @dev Pulls `bondFor(amount)` from the caller, who must approve the Pool first.
    function submitClaim(uint256 amount, bytes32 evidenceHash) external nonReentrant returns (uint256 claimId) {
        IPolicyRegistry.Policy memory policy = registry.getPolicy(msg.sender);
        // isActive also requires the premiums to be paid, or within their grace period.
        if (!registry.isActive(msg.sender)) revert NoActivePolicy();
        if (!registry.isPastWaitingPeriod(msg.sender)) revert WaitingPeriodNotElapsed();
        if (amount == 0) revert InvalidAmount();
        if (amount > policy.coverageLimit) revert ExceedsCoverageLimit(amount, policy.coverageLimit);
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        uint256 existing = openClaimOfPolicy[policy.id];
        if (existing != 0) revert OpenClaimExists(existing);

        claimId = ++claimCount;
        uint256 bond = bondFor(amount);
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
            offerDeadline: 0,
            bond: bond,
            bondForfeited: 0,
            receiptDeadline: 0,
            receiptHash: bytes32(0),
            receiptAmount: 0
        });
        openClaimOfPolicy[policy.id] = claimId;
        emit ClaimSubmitted(claimId, msg.sender, policy.id, amount, evidenceHash);
        if (bond > 0) pool.postBond(msg.sender, bond);

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
        claim.receiptDeadline = block.timestamp + receiptPeriod;
        _setState(claimId, State.Approved);
    }

    /// @notice Submit the receipt for the repair or replacement. Only the claimant, once, before
    ///         `receiptDeadline`. The claim will pay the smaller of the offer and `amount`.
    /// @param receiptHash Content hash of the (encrypted) receipt bundle stored off-chain.
    /// @param amount The receipt's total, in token units.
    function submitReceipt(uint256 claimId, bytes32 receiptHash, uint256 amount) external nonReentrant {
        _requireState(claimId, State.Approved);
        Claim storage claim = _claims[claimId];
        if (msg.sender != claim.claimant) revert NotClaimant();
        if (claim.receiptHash != bytes32(0)) revert ReceiptAlreadySubmitted();
        if (block.timestamp > claim.receiptDeadline) revert ReceiptWindowClosed(claim.receiptDeadline);
        if (receiptHash == bytes32(0)) revert InvalidEvidence();
        if (amount == 0) revert InvalidAmount();
        claim.receiptHash = receiptHash;
        claim.receiptAmount = amount;
        emit ReceiptSubmitted(claimId, receiptHash, amount, payoutAmount(claimId));
    }

    /// @notice Close an accepted claim whose receipt never arrived. Anyone, after `receiptDeadline`.
    ///         Nothing is paid and the policy is freed.
    function expireClaim(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Approved);
        Claim storage claim = _claims[claimId];
        if (claim.receiptHash != bytes32(0)) revert ReceiptAlreadySubmitted();
        if (block.timestamp <= claim.receiptDeadline) revert ReceiptWindowOpen(claim.receiptDeadline);
        _setState(claimId, State.Expired);
        delete openClaimOfPolicy[claim.policyId];
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
    ///         The bond is settled here too, against the jury's own figure (before any pool cap).
    function finalize(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Voting);
        Claim storage claim = _claims[claimId];
        (IJuryModule.Outcome outcome, uint256 award) = jury.tally(claimId);
        if (outcome == IJuryModule.Outcome.Approved) {
            claim.approvedAmount = _capped(claim, award);
            claim.offerDeadline = block.timestamp + responsePeriod;
            _setState(claimId, State.Offered);
            emit OfferMade(claimId, claim.approvedAmount, claim.offerDeadline);
        } else {
            _setState(claimId, State.Rejected);
            delete openClaimOfPolicy[claim.policyId];
        }
        _settleBond(claimId, jury.quorate(claimId) ? bondForfeit(claim.bond, claim.amount, award) : 0);
    }

    /// @notice Pay an approved claim once its receipt is in: the smaller of the offer and the receipt.
    ///         If the pool cannot cover it right now the Pool reverts and the claim stays Approved until
    ///         it can (first come, first served).
    function executePayout(uint256 claimId) external nonReentrant {
        _requireState(claimId, State.Approved);
        Claim storage claim = _claims[claimId];
        if (claim.receiptHash == bytes32(0)) revert ReceiptRequired();

        uint256 amount = payoutAmount(claimId);
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
        _settleBond(claimId, 0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The bond for a claim asking `amount`.
    function bondFor(uint256 amount) public view returns (uint256) {
        uint256 bond = (amount * bondBps) / BPS_DENOMINATOR;
        return bond < minBond ? minBond : bond;
    }

    /// @notice How much of `bond` is kept when a claim asking `amount` is awarded `award`: the bond times
    ///         the share of the ask the jury cut. Rounds in the claimant's favour.
    function bondForfeit(uint256 bond, uint256 amount, uint256 award) public pure returns (uint256) {
        if (amount == 0 || award >= amount) return 0;
        return (bond * (amount - award)) / amount;
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }

    /// @notice What the claim pays: the fixed amount once the jury has made its offer (lowered to the
    ///         receipt's total once one is in), otherwise the most a full approval would fix right now
    ///         (min of claim amount, coverage limit, pool cap).
    function payoutAmount(uint256 claimId) public view returns (uint256) {
        Claim storage claim = _claims[claimId];
        State state = claim.state;
        if (state == State.Paid) return claim.paidAmount;
        if (state == State.Offered || state == State.Approved || state == State.Withdrawn || state == State.Expired) {
            uint256 receipt = claim.receiptAmount;
            return receipt != 0 && receipt < claim.approvedAmount ? receipt : claim.approvedAmount;
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

    function _settleBond(uint256 claimId, uint256 forfeit) private {
        Claim storage claim = _claims[claimId];
        if (claim.bond == 0) return;
        claim.bondForfeited = forfeit;
        emit BondSettled(claimId, claim.bond - forfeit, forfeit);
        pool.settleBond(claim.claimant, claim.bond, forfeit);
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
