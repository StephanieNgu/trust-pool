// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "../interfaces/IRandomnessProvider.sol";

/// @title VRFRandomness
/// @notice Production randomness provider: forwards each jury request to Chainlink VRF v2.5 and passes
///         the verified random word to the JuryModule. Nobody, including the owner, chooses the seed.
/// @dev Billing comes from a VRF subscription that must list this contract as a consumer.
///      Only the JuryModule may request, so nobody else can spend the subscription.
contract VRFRandomness is IRandomnessProvider, VRFConsumerBaseV2Plus {
    uint256 public immutable subscriptionId;
    /// @notice Selects the VRF gas lane (max gas price) on this network.
    bytes32 public immutable keyHash;
    /// @notice Gas for our callback, which runs jury selection. Must cover the O(n) eligible-juror scan.
    uint32 public immutable callbackGasLimit;
    uint16 public immutable requestConfirmations;
    /// @notice Pay VRF fees in the chain's native token instead of LINK.
    bool public immutable nativePayment;

    /// @notice The JuryModule, the only contract allowed to request randomness.
    address public consumer;

    /// @notice Claim waiting on each outstanding VRF request (0 once fulfilled).
    mapping(uint256 => uint256) public claimOfRequest;
    /// @notice Latest VRF request id for each claim.
    mapping(uint256 => uint256) public requestOfClaim;

    event ConsumerSet(address indexed consumer);
    event RandomnessRequested(uint256 indexed claimId, uint256 indexed requestId);
    event RandomnessFulfilled(uint256 indexed claimId, uint256 indexed requestId, uint256 seed);
    /// @notice The JuryModule rejected the seed (e.g. the claim was cancelled after a timeout).
    event FulfillmentFailed(uint256 indexed claimId, uint256 indexed requestId, bytes reason);

    error ConsumerAlreadySet();
    error NotConsumer();
    error AlreadyRequested(uint256 claimId);
    error InvalidConfig();

    constructor(
        address coordinator,
        uint256 subscriptionId_,
        bytes32 keyHash_,
        uint32 callbackGasLimit_,
        uint16 requestConfirmations_,
        bool nativePayment_
    ) VRFConsumerBaseV2Plus(coordinator) {
        if (keyHash_ == bytes32(0) || callbackGasLimit_ == 0 || requestConfirmations_ == 0) revert InvalidConfig();
        subscriptionId = subscriptionId_;
        keyHash = keyHash_;
        callbackGasLimit = callbackGasLimit_;
        requestConfirmations = requestConfirmations_;
        nativePayment = nativePayment_;
    }

    /// @notice One-time wiring to the JuryModule, which is deployed after this contract.
    function setConsumer(address consumer_) external onlyOwner {
        if (consumer_ == address(0)) revert ZeroAddress();
        if (consumer != address(0)) revert ConsumerAlreadySet();
        consumer = consumer_;
        emit ConsumerSet(consumer_);
    }

    function requestRandomness(uint256 claimId) external {
        if (msg.sender != consumer) revert NotConsumer();
        if (requestOfClaim[claimId] != 0) revert AlreadyRequested(claimId);

        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
        claimOfRequest[requestId] = claimId;
        requestOfClaim[claimId] = requestId;
        emit RandomnessRequested(claimId, requestId);
    }

    /// @dev Never reverts, as Chainlink requires: a failing JuryModule callback is recorded instead.
    ///      Each request is answered once, so a claim can never get a second jury from here.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 claimId = claimOfRequest[requestId];
        if (claimId == 0) return;
        delete claimOfRequest[requestId];

        uint256 seed = randomWords[0];
        try IRandomnessConsumer(consumer).fulfillRandomness(claimId, seed) {
            emit RandomnessFulfilled(claimId, requestId, seed);
        } catch (bytes memory reason) {
            emit FulfillmentFailed(claimId, requestId, reason);
        }
    }
}
