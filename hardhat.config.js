require("@nomicfoundation/hardhat-toolbox");

// Public testnet deployment is opt-in: the network only exists when its RPC URL and deployer key are set.
const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY } = process.env;
const sepolia =
  SEPOLIA_RPC_URL && DEPLOYER_PRIVATE_KEY
    ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [DEPLOYER_PRIVATE_KEY], chainId: 11155111 } }
    : {};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {},
    localhost: { url: "http://127.0.0.1:8545" },
    ...sepolia,
  },
};
