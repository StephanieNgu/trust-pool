// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPool {
    function collectPremium(address from, uint256 amount) external;
    function payout(address to, uint256 amount) external;
    function maxPayout() external view returns (uint256);
    function balance() external view returns (uint256);
}
