// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockStablecoin
/// @notice Demo-only ERC-20 standing in for USDC (6 decimals). The owner can mint freely, and on a
///         testnet anyone can draw a small amount from the faucet once a day so they can try the app.
contract MockStablecoin is ERC20, Ownable {
    /// @notice What one faucet call mints: 1,000 mUSDC.
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** 6;
    /// @notice How long an address waits between faucet calls.
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    /// @notice When each address last used the faucet.
    mapping(address => uint256) public lastFaucetAt;

    error FaucetCooldown(uint256 availableAt);

    event FaucetUsed(address indexed to, uint256 amount);

    constructor() ERC20("Mock USD Coin", "mUSDC") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Mints FAUCET_AMOUNT to the caller, at most once per FAUCET_COOLDOWN.
    function faucet() external {
        uint256 last = lastFaucetAt[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetUsed(msg.sender, FAUCET_AMOUNT);
    }
}
