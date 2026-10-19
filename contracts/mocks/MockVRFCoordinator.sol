// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

interface IVRFConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @title MockVRFCoordinator
/// @notice TEST ONLY. Stands in for the Chainlink VRF v2.5 coordinator: same `requestRandomWords`
///         entry point and the same `rawFulfillRandomWords` callback, plus subscription/consumer checks
///         so a deployment that forgets to register its consumer fails here just as it would on Sepolia.
///         Chainlink's own VRFCoordinatorV2_5Mock imports a version-pinned OpenZeppelin path that
///         Hardhat 2 cannot resolve, so this mirrors the subset VRFRandomness uses.
contract MockVRFCoordinator {
    struct Request {
        address consumer;
        uint32 numWords;
    }

    uint256 public nextSubId = 1;
    uint256 public nextRequestId = 1;
    mapping(uint256 => address) public subscriptionOwner;
    mapping(uint256 => mapping(address => bool)) public isConsumer;
    mapping(uint256 => Request) public requests;

    event SubscriptionCreated(uint256 indexed subId, address owner);
    event ConsumerAdded(uint256 indexed subId, address consumer);
    event RandomWordsRequested(uint256 indexed requestId, uint256 indexed subId, address indexed consumer);
    event RandomWordsFulfilled(uint256 indexed requestId, bool success);

    error InvalidSubscription();
    error InvalidConsumer(uint256 subId, address consumer);
    error MustBeSubOwner();
    error UnknownRequest();

    function createSubscription() external returns (uint256 subId) {
        subId = nextSubId++;
        subscriptionOwner[subId] = msg.sender;
        emit SubscriptionCreated(subId, msg.sender);
    }

    function addConsumer(uint256 subId, address consumer) external {
        if (subscriptionOwner[subId] != msg.sender) revert MustBeSubOwner();
        isConsumer[subId][consumer] = true;
        emit ConsumerAdded(subId, consumer);
    }

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 requestId) {
        if (subscriptionOwner[req.subId] == address(0)) revert InvalidSubscription();
        if (!isConsumer[req.subId][msg.sender]) revert InvalidConsumer(req.subId, msg.sender);
        requestId = nextRequestId++;
        requests[requestId] = Request({consumer: msg.sender, numWords: req.numWords});
        emit RandomWordsRequested(requestId, req.subId, msg.sender);
    }

    /// @notice Delivers `words` for `requestId`. Like the real coordinator, a reverting consumer does
    ///         not revert this call; the outcome is reported in the event.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata words) external {
        Request memory r = requests[requestId];
        if (r.consumer == address(0)) revert UnknownRequest();
        delete requests[requestId];
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, ) = r.consumer.call(abi.encodeCall(IVRFConsumer.rawFulfillRandomWords, (requestId, words)));
        emit RandomWordsFulfilled(requestId, success);
    }
}
