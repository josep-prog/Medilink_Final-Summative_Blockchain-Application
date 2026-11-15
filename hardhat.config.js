require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ quiet: true });

// Give each network connection attempt 3 seconds (the 250 ms default fails on slow links)
require("net").setDefaultAutoSelectFamilyAttemptTimeout(3000);

// Values come from blockchain/.env (see .env.example). Never commit your real .env!
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // Ethereum Sepolia testnet (free test ETH, same rules as mainnet)
    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      gasPrice: 200_000_000,
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
  },
};
