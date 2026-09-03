import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SIX_HOURS = 6n * 3600n;
const THREE_DAYS = 3n * 24n * 3600n;
const SEVEN_DAYS = 7n * 24n * 3600n;

/**
 * Deploys the vault implementation, the hub implementation, an ERC1967 proxy that initializes the hub,
 * then the IvyShares token bound to the proxy, and wires it with setShares. The admin is the deployer.
 * Override numeric/uri parameters with Ignition's `--parameters` file.
 */
export default buildModule("IvyVaultsModule", (m) => {
  const admin = m.getAccount(0);
  const exerciseWindow = m.getParameter("exerciseWindow", SIX_HOURS);
  const auctionTimeout = m.getParameter("auctionTimeout", THREE_DAYS);
  const settlementGracePeriod = m.getParameter("settlementGracePeriod", SEVEN_DAYS);
  const uri = m.getParameter("uri", "");

  const vaultImplementation = m.contract("IvyVault");
  const hubImplementation = m.contract("IvyVaultsHub");
  const initData = m.encodeFunctionCall(hubImplementation, "initialize", [
    admin,
    vaultImplementation,
    exerciseWindow,
    auctionTimeout,
    settlementGracePeriod,
  ]);
  const proxy = m.contract("ERC1967Proxy", [hubImplementation, initData]);
  const hub = m.contractAt("IvyVaultsHub", proxy, { id: "IvyVaultsHubProxy" });
  const shares = m.contract("IvyShares", [proxy, uri]);
  m.call(hub, "setShares", [shares], { from: admin });

  return { vaultImplementation, hubImplementation, proxy, hub, shares };
});
