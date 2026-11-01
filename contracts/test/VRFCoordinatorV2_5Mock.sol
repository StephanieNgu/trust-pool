// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// LOCAL CHAINS AND TESTS ONLY. Pulls Chainlink's official VRF v2.5 coordinator mock into the build so
// Hardhat can deploy it. Unlike the real coordinator, the mock lets anyone answer a request, and
// fulfillRandomWordsWithOverride lets the caller pick the words. On a public network deploy against
// Chainlink's real coordinator instead (scripts/deploy.js does this for Sepolia).
// solhint-disable-next-line no-unused-import
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
