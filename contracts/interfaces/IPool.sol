// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPool {
    function claimManager() external view returns (address);
    function collectPremium(address from, uint256 amount) external;
    function payout(address to, uint256 amount) external;
    function maxPayout() external view returns (uint256);
    function balance() external view returns (uint256);
    function stakeOf(address juror) external view returns (uint256);
    function lockStake(address juror) external;
    function unlockStake(address juror) external;
    function penalize(address juror, uint256 amount) external returns (uint256);
    function payJurorFee(address juror, uint256 amount) external returns (uint256);
}
