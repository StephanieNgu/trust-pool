// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRandomnessProvider, IRandomnessConsumer} from "../interfaces/IRandomnessProvider.sol";

/// @title MockRandomness
/// @notice DEMO ONLY. NOT RANDOM. Records requests and lets the owner fulfil them with a chosen seed,
///         mimicking the asynchronous request/callback flow of Chainlink VRF.
contract MockRandomness is IRandomnessProvider, Ownable {
    /// @notice Requesting consumer for each pending claim; zero once fulfilled.
    mapping(uint256 => address) public pendingRequester;

    event RandomnessRequested(uint256 indexed claimId, address indexed requester);
    event RandomnessFulfilled(uint256 indexed claimId, uint256 seed);

    error AlreadyPending();
    error NoPendingRequest();

    constructor() Ownable(msg.sender) {}

    function requestRandomness(uint256 claimId) external {
        if (pendingRequester[claimId] != address(0)) revert AlreadyPending();
        pendingRequester[claimId] = msg.sender;
        emit RandomnessRequested(claimId, msg.sender);
    }

    /// @notice Deliver `seed` for `claimId`. Deterministic seeds make tests reproducible.
    function fulfill(uint256 claimId, uint256 seed) public onlyOwner {
        address requester = pendingRequester[claimId];
        if (requester == address(0)) revert NoPendingRequest();
        delete pendingRequester[claimId];
        emit RandomnessFulfilled(claimId, seed);
        IRandomnessConsumer(requester).fulfillRandomness(claimId, seed);
    }

    /// @notice Convenience for demos: derives a pseudo-random seed from the previous block hash.
    function fulfillWithBlockhash(uint256 claimId) external onlyOwner {
        fulfill(claimId, uint256(keccak256(abi.encode(blockhash(block.number - 1), claimId))));
    }
}
