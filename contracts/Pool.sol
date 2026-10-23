// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPool} from "./interfaces/IPool.sol";

/// @title Pool
/// @notice The only contract in the protocol that holds funds. Accepts contributions and premiums,
///         and pays out approved claims on instruction from the ClaimManager. It also holds jurors'
///         stakes: members lock a stake to be picked for juries, and the JuryModule pays fees from the
///         reserve and moves no-show penalties out of stakes. It also holds claimants' bonds while their
///         claims are decided. Stakes and bonds are not part of the reserve: `balance()` and the
///         per-claim cap leave them out.
contract Pool is IPool, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable token;
    /// @notice Largest share of the pool balance a single claim may pay out, in basis points.
    uint256 public immutable maxPayoutBps;

    address public registry;
    address public override claimManager;
    address public jury;

    mapping(address => uint256) public contributionsOf;
    uint256 public totalContributed;
    uint256 public totalPaidOut;

    /// @notice Each juror's locked stake.
    mapping(address => uint256) public override stakeOf;
    /// @notice How many juries a juror currently sits on; a stake cannot be withdrawn while above 0.
    mapping(address => uint256) public activeJuriesOf;
    uint256 public totalStaked;
    /// @notice Fees paid to jurors from the reserve, and penalties taken from stakes into it.
    uint256 public totalJurorFees;
    uint256 public totalPenalties;

    /// @notice Bonds held for claims still being decided, and the part of settled bonds kept by the pool.
    uint256 public totalBonded;
    uint256 public totalBondsForfeited;

    event RegistrySet(address indexed registry);
    event ClaimManagerSet(address indexed claimManager);
    event Contributed(address indexed from, uint256 amount);
    event PaidOut(address indexed to, uint256 amount);
    event JurySet(address indexed jury);
    event Staked(address indexed juror, uint256 amount);
    event Unstaked(address indexed juror, uint256 amount);
    event JurorFeePaid(address indexed juror, uint256 amount);
    event StakePenalized(address indexed juror, uint256 amount);
    event BondPosted(address indexed claimant, uint256 amount);
    event BondSettled(address indexed claimant, uint256 returned, uint256 forfeited);

    error ZeroAddress();
    error AlreadySet();
    error ZeroAmount();
    error NotRegistry();
    error NotClaimManager();
    error InvalidBps();
    error InsufficientPoolBalance(uint256 amount, uint256 balance);
    error NotJury();
    error StakeLocked(uint256 activeJuries);
    error InsufficientStake(uint256 amount, uint256 staked);
    error InvalidBond();

    modifier onlyRegistry() {
        if (msg.sender != registry) revert NotRegistry();
        _;
    }

    modifier onlyJury() {
        if (msg.sender != jury) revert NotJury();
        _;
    }

    modifier onlyClaimManager() {
        if (msg.sender != claimManager) revert NotClaimManager();
        _;
    }

    constructor(IERC20 token_, uint256 maxPayoutBps_) Ownable(msg.sender) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (maxPayoutBps_ == 0 || maxPayoutBps_ > BPS_DENOMINATOR) revert InvalidBps();
        token = token_;
        maxPayoutBps = maxPayoutBps_;
    }

    // ---------------------------------------------------------------------
    // Wiring (one-time, owner only)
    // ---------------------------------------------------------------------

    function setRegistry(address registry_) external onlyOwner {
        if (registry_ == address(0)) revert ZeroAddress();
        if (registry != address(0)) revert AlreadySet();
        registry = registry_;
        emit RegistrySet(registry_);
    }

    function setClaimManager(address claimManager_) external onlyOwner {
        if (claimManager_ == address(0)) revert ZeroAddress();
        if (claimManager != address(0)) revert AlreadySet();
        claimManager = claimManager_;
        emit ClaimManagerSet(claimManager_);
    }

    function setJury(address jury_) external onlyOwner {
        if (jury_ == address(0)) revert ZeroAddress();
        if (jury != address(0)) revert AlreadySet();
        jury = jury_;
        emit JurySet(jury_);
    }

    // ---------------------------------------------------------------------
    // Money in
    // ---------------------------------------------------------------------

    /// @notice Voluntary contribution to the pool. Caller must approve this contract first.
    function contribute(uint256 amount) external nonReentrant {
        _collect(msg.sender, amount);
    }

    /// @notice Pulls a policy premium from `from`. Only callable by the PolicyRegistry,
    ///         which the holder calls directly; the holder must approve this contract first.
    function collectPremium(address from, uint256 amount) external onlyRegistry nonReentrant {
        _collect(from, amount);
    }

    function _collect(address from, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        contributionsOf[from] += amount;
        totalContributed += amount;
        emit Contributed(from, amount);
        token.safeTransferFrom(from, address(this), amount);
    }

    // ---------------------------------------------------------------------
    // Juror stakes
    // ---------------------------------------------------------------------

    /// @notice Lock `amount` more as a juror stake. Caller must approve this contract first. A member
    ///         is picked for juries only while their stake is at least JuryModule.minStake.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        stakeOf[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Take back `amount` of the caller's stake. Not while they sit on a jury.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 active = activeJuriesOf[msg.sender];
        if (active != 0) revert StakeLocked(active);
        uint256 staked = stakeOf[msg.sender];
        if (amount > staked) revert InsufficientStake(amount, staked);
        stakeOf[msg.sender] = staked - amount;
        totalStaked -= amount;
        emit Unstaked(msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    /// @notice Called by the JuryModule when a juror is seated, and again when their jury closes.
    function lockStake(address juror) external onlyJury {
        activeJuriesOf[juror]++;
    }

    function unlockStake(address juror) external onlyJury {
        activeJuriesOf[juror]--;
    }

    /// @notice Moves up to `amount` of a juror's stake into the reserve; returns how much was taken.
    function penalize(address juror, uint256 amount) external onlyJury returns (uint256 taken) {
        uint256 staked = stakeOf[juror];
        taken = amount < staked ? amount : staked;
        if (taken == 0) return 0;
        stakeOf[juror] = staked - taken;
        totalStaked -= taken;
        totalPenalties += taken;
        emit StakePenalized(juror, taken);
    }

    /// @notice Pays a juror's fee from the reserve. Pays what the reserve holds if it holds less.
    function payJurorFee(address juror, uint256 amount) external onlyJury nonReentrant returns (uint256 paid) {
        uint256 available = balance();
        paid = amount < available ? amount : available;
        if (paid == 0) return 0;
        totalJurorFees += paid;
        emit JurorFeePaid(juror, paid);
        token.safeTransfer(juror, paid);
    }

    // ---------------------------------------------------------------------
    // Claim bonds
    // ---------------------------------------------------------------------

    /// @notice Pulls a claimant's bond when they file. Only the ClaimManager; the claimant must approve
    ///         this contract first.
    function postBond(address from, uint256 amount) external onlyClaimManager nonReentrant {
        if (amount == 0) revert ZeroAmount();
        totalBonded += amount;
        emit BondPosted(from, amount);
        token.safeTransferFrom(from, address(this), amount);
    }

    /// @notice Releases a bond once its claim is decided: `forfeit` of it joins the reserve and the rest
    ///         goes back to the claimant.
    function settleBond(address to, uint256 amount, uint256 forfeit) external onlyClaimManager nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (forfeit > amount || amount > totalBonded) revert InvalidBond();
        totalBonded -= amount;
        totalBondsForfeited += forfeit;
        emit BondSettled(to, amount - forfeit, forfeit);
        if (amount > forfeit) token.safeTransfer(to, amount - forfeit);
    }

    // ---------------------------------------------------------------------
    // Money out
    // ---------------------------------------------------------------------

    /// @notice Pays an approved claim. The ClaimManager applies the per-claim cap (`maxPayout`) when the
    ///         jury approves; here the only limit is what the pool actually holds.
    function payout(address to, uint256 amount) external onlyClaimManager nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 available = balance();
        if (amount > available) revert InsufficientPoolBalance(amount, available);
        totalPaidOut += amount;
        emit PaidOut(to, amount);
        token.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The reserve that pays claims: everything held except jurors' stakes and open claims' bonds.
    function balance() public view returns (uint256) {
        return token.balanceOf(address(this)) - totalStaked - totalBonded;
    }

    /// @notice Current per-claim payout cap: `maxPayoutBps` of the pool balance.
    function maxPayout() public view returns (uint256) {
        return (balance() * maxPayoutBps) / BPS_DENOMINATOR;
    }
}
