// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPool} from "./interfaces/IPool.sol";

/// @title Pool
/// @notice The only contract in the protocol that holds funds. Accepts contributions and premiums,
///         and pays out approved claims on instruction from the ClaimManager.
contract Pool is IPool, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable token;
    /// @notice Largest share of the pool balance a single claim may pay out, in basis points.
    uint256 public immutable maxPayoutBps;

    address public registry;
    address public claimManager;

    mapping(address => uint256) public contributionsOf;
    uint256 public totalContributed;
    uint256 public totalPaidOut;

    event RegistrySet(address indexed registry);
    event ClaimManagerSet(address indexed claimManager);
    event Contributed(address indexed from, uint256 amount);
    event PaidOut(address indexed to, uint256 amount);

    error ZeroAddress();
    error AlreadySet();
    error ZeroAmount();
    error NotRegistry();
    error NotClaimManager();
    error InvalidBps();
    error ExceedsPayoutCap(uint256 amount, uint256 cap);

    modifier onlyRegistry() {
        if (msg.sender != registry) revert NotRegistry();
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
    // Money out
    // ---------------------------------------------------------------------

    /// @notice Pays an approved claim. Reverts if `amount` exceeds the per-claim cap.
    function payout(address to, uint256 amount) external onlyClaimManager nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 cap = maxPayout();
        if (amount > cap) revert ExceedsPayoutCap(amount, cap);
        totalPaidOut += amount;
        emit PaidOut(to, amount);
        token.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function balance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Current per-claim payout cap: `maxPayoutBps` of the pool balance.
    function maxPayout() public view returns (uint256) {
        return (balance() * maxPayoutBps) / BPS_DENOMINATOR;
    }
}
