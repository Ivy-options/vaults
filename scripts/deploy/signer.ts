import { HDNodeWallet, Wallet } from "ethers"
import type { NetworkConnection } from "hardhat/types/network"

/** Use Hardhat's selected account config, but sign offline so the journal precedes broadcast. */
export async function deploymentSigner(connection: NetworkConnection) {
	const config = connection.networkConfig
	if (config.type !== "http") throw new Error("Use a persistent network with --network; for local testing run a Hardhat node")
	const accounts = config.accounts
	const provider = connection.ethers.provider
	if (accounts === "remote") throw new Error("Resumable deployment requires private-key or mnemonic accounts in the selected Hardhat network config")
	if (Array.isArray(accounts)) {
		if (!accounts.length) throw new Error("No deployment account configured for this network")
		return new Wallet(await accounts[0].getHexString(), provider)
	}
	if (accounts.count < 1) throw new Error("No deployment account configured for this network")
	return HDNodeWallet.fromPhrase(await accounts.mnemonic.get(), await accounts.passphrase.get(), `${accounts.path}/${accounts.initialIndex}`).connect(
		provider,
	)
}
