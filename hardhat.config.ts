import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers"
import { configVariable, defineConfig } from "hardhat/config"
import { existsSync } from "node:fs"
import { loadEnvFile } from "node:process"

if (existsSync(".env")) loadEnvFile(".env")

const solcSettings = {
	optimizer: { enabled: true, runs: 200 },
	viaIR: true,
	evmVersion: "cancun",
}

export default defineConfig({
	plugins: [hardhatToolboxMochaEthersPlugin],
	coverage: {
		skipFiles: ["contracts/mocks/**/*.sol"],
	},
	solidity: {
		profiles: {
			default: { version: "0.8.34", settings: solcSettings },
			production: { version: "0.8.34", settings: solcSettings },
		},
	},
	networks: {
		hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
		polygon: {
			type: "http",
			chainType: "l1",
			chainId: 137,
			url: configVariable("POLYGON_RPC_URL"),
			accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
		},
		sepolia: {
			type: "http",
			chainType: "l1",
			url: configVariable("SEPOLIA_RPC_URL"),
			accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
		},
	},
})
