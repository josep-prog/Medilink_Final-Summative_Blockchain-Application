const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name}`);
  console.log(`Admin:    ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  const medilink = await ethers.deployContract("MediLink");
  await medilink.waitForDeployment();
  const address = await medilink.getAddress();
  const txHash = medilink.deploymentTransaction().hash;

  console.log(`MediLink deployed to: ${address}`);
  console.log(`Transaction:          ${txHash}`);
  if (network.name === "sepolia") console.log(`Etherscan:            https://sepolia.etherscan.io/address/${address}`);

  const { abi } = await artifacts.readArtifact("MediLink");
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify({ network: network.name, address, txHash, abi }, null, 2));
  console.log(`\nSaved to deployments/${network.name}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
