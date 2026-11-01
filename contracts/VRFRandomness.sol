// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVRFCoordinatorV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "./interfaces/IRandomnessProvider.sol";

/// @title VRFRandomness
/// @notice Randomness provider backed by Chainlink VRF v2.5. JuryModule asks for a seed per claim;
///         the VRF coordinator answers with a verifiably random word, which is forwarded to JuryModule
///         in the same transaction so nobody sees the seed before the jury is seated.
/// @dev Nobody can choose or influence the seed through this contract:
///      - It has no owner and no admin functions. The coordinator, subscription and key hash are
///        immutable, so the coordinator cannot be swapped for one that returns chosen words (unlike
///        Chainlink's VRFConsumerBaseV2Plus, whose owner may call setCoordinator).
///      - Only the coordinator may deliver randomness, and only once per request.
///      - The one setup step, `setConsumer`, can be called once, by the deployer, and only names who
///        may request randomness; it cannot touch a seed.
///      A failed delivery (for example, too few eligible jurors) is caught and reported, never
///      reverted, as Chainlink requires: a reverting callback would not be retried anyway, and the
///      claim can still be cancelled once JuryModule's randomness timeout passes.
contract VRFRandomness is IRandomnessProvider {
    IVRFCoordinatorV2Plus public immutable coordinator;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint32 public immutable callbackGasLimit;
    uint16 public immutable requestConfirmations;
    /// @notice Pay for requests in the chain's native token (true) or in LINK (false).
    bool public immutable nativePayment;

    address private immutable _deployer;
    /// @notice The only contract allowed to request randomness (the JuryModule). Set once.
    address public consumer;

    /// @notice VRF request id for a claim's pending request; zero once it has been answered.
    mapping(uint256 => uint256) public requestIdOf;
    /// @notice Claim a VRF request was made for.
    mapping(uint256 => uint256) public claimOfRequest;
    /// @notice True while a request has been made and not yet answered.
    mapping(uint256 => bool) private _pending;
    /// @notice The verified VRF word delivered for each claim, kept so anyone can audit the draw.
    mapping(uint256 => uint256) public seedOf;

    event ConsumerSet(address indexed consumer);
    event RandomnessRequested(uint256 indexed claimId, uint256 indexed requestId);
    event RandomnessFulfilled(uint256 indexed claimId, uint256 indexed requestId, uint256 seed);
    /// @notice The consumer rejected the seed (e.g. too few eligible jurors). `reason` is its revert data.
    event RandomnessDeliveryFailed(uint256 indexed claimId, uint256 indexed requestId, bytes reason);

    error ZeroAddress();
    error InvalidConfig();
    error AlreadySet();
    error NotDeployer();
    error NotConsumer();
    error OnlyCoordinator(address caller);
    error AlreadyPending();
    error UnknownRequest(uint256 requestId);

    constructor(
        address coordinator_,
        uint256 subscriptionId_,
        bytes32 keyHash_,
        uint32 callbackGasLimit_,
        uint16 requestConfirmations_,
        bool nativePayment_
    ) {
        if (coordinator_ == address(0)) revert ZeroAddress();
        if (subscriptionId_ == 0 || keyHash_ == bytes32(0) || callbackGasLimit_ == 0) revert InvalidConfig();
        coordinator = IVRFCoordinatorV2Plus(coordinator_);
        subscriptionId = subscriptionId_;
        keyHash = keyHash_;
        callbackGasLimit = callbackGasLimit_;
        requestConfirmations = requestConfirmations_;
        nativePayment = nativePayment_;
        _deployer = msg.sender;
    }

    /// @notice One-time link to the JuryModule, which is deployed after this contract.
    function setConsumer(address consumer_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (consumer != address(0)) revert AlreadySet();
        if (consumer_ == address(0)) revert ZeroAddress();
        consumer = consumer_;
        emit ConsumerSet(consumer_);
    }

    /// @inheritdoc IRandomnessProvider
    function requestRandomness(uint256 claimId) external {
        if (msg.sender != consumer) revert NotConsumer();
        if (isPending(claimId)) revert AlreadyPending();

        uint256 requestId = coordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
        requestIdOf[claimId] = requestId;
        claimOfRequest[requestId] = claimId;
        _pending[requestId] = true;
        emit RandomnessRequested(claimId, requestId);
    }

    /// @notice Called by the VRF coordinator with the verified random words for `requestId`.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert OnlyCoordinator(msg.sender);
        if (!_pending[requestId]) revert UnknownRequest(requestId);

        uint256 claimId = claimOfRequest[requestId];
        delete _pending[requestId];
        delete requestIdOf[claimId];

        uint256 seed = randomWords[0];
        seedOf[claimId] = seed;
        emit RandomnessFulfilled(claimId, requestId, seed);
        try IRandomnessConsumer(consumer).fulfillRandomness(claimId, seed) {} catch (bytes memory reason) {
            emit RandomnessDeliveryFailed(claimId, requestId, reason);
        }
    }

    /// @notice True while the claim's randomness request is waiting for the coordinator.
    function isPending(uint256 claimId) public view returns (bool) {
        uint256 requestId = requestIdOf[claimId];
        return requestId != 0 && _pending[requestId];
    }
}
