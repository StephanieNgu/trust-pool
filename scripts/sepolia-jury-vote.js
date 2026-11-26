// Votes on a Sepolia claim from the demo juror wallets, without the web app.
//
//   $env:CLAIM_ID="2"; npx hardhat run scripts/sepolia-jury-vote.js --network sepolia
//
// Use it when the app can't show a claim's evidence (for example after the hosted backend lost its
// files), which locks the app's "Seal my vote" button. The contracts don't check evidence, only the
// commit-reveal rules, so this is the same vote the app would send.
//
// It loads the keys in deployments/sepolia-demo-wallets.json (written by sepolia-vrf-demo.js), finds
// which of them sit on the claim's jury, commits a sealed vote for each, and, once every juror has
// committed (which opens reveals at once) or the commit window has ended, reveals them. Run it again
// to finish an interrupted run: the salts are kept in deployments/sepolia-votes-<claim>.json.
//
// Environment:
//   CLAIM_ID   required, the claim number
//   AMOUNT     mUSDC each juror votes to pay (default: the full amount asked; 0 votes to reject)
//   NOTE       the note sealed with the vote (default: "Voted from the command line.")
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const root = path.join(__dirname, "..");
const deployment = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${network.name}.json`), "utf8"));
const keys = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${network.name}-demo-wallets.json`), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tx = (hash) => `https://sepolia.etherscan.io/tx/${hash}`;

async function main() {
  const claimId = BigInt(process.env.CLAIM_ID || "0");
  if (claimId === 0n) throw new Error("Set CLAIM_ID to the claim number.");
  const jury = await ethers.getContractAt("JuryModule", deployment.addresses.jury);
  const claims = await ethers.getContractAt("ClaimManager", deployment.addresses.claimManager);
  const claim = await claims.getClaim(claimId);
  const amount = process.env.AMOUNT !== undefined ? ethers.parseUnits(process.env.AMOUNT, 6) : claim.amount;
  const note = process.env.NOTE || "Voted from the command line.";
  const noteHash = ethers.keccak256(ethers.toUtf8Bytes(note));

  const jurors = (await jury.getJurors(claimId)).map((a) => a.toLowerCase());
  if (jurors.length === 0) throw new Error(`Claim #${claimId} has no seated jury yet.`);
  const wallets = keys.map((k) => new ethers.Wallet(k, ethers.provider)).filter((w) => jurors.includes(w.address.toLowerCase()));
  console.log(`Claim #${claimId}: jurors ${jurors.join(", ")}`);
  console.log(`Demo wallets on this jury: ${wallets.length} of ${jurors.length}. Voting ${ethers.formatUnits(amount, 6)} mUSDC each.`);
  if (wallets.length === 0) throw new Error("None of the demo wallets sit on this jury.");

  const saltsFile = path.join(root, "deployments", `${network.name}-votes-${claimId}.json`);
  const salts = fs.existsSync(saltsFile) ? JSON.parse(fs.readFileSync(saltsFile, "utf8")) : {};

  for (const w of wallets) {
    if ((await jury.commitmentOf(claimId, w.address)) !== ethers.ZeroHash) {
      console.log(`  ${w.address} already committed`);
      continue;
    }
    const salt = ethers.hexlify(ethers.randomBytes(32));
    salts[w.address] = { salt, amount: amount.toString(), noteHash };
    fs.writeFileSync(saltsFile, JSON.stringify(salts, null, 2) + "\n", { mode: 0o600 });
    const commitment = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "uint256", "bytes32", "bytes32"],
        [claimId, w.address, amount, noteHash, salt],
      ),
    );
    const sent = await jury.connect(w).commitVote(claimId, commitment);
    await sent.wait();
    console.log(`  ${w.address} committed: ${tx(sent.hash)}`);
  }

  while (!(await jury.revealOpen(claimId))) {
    console.log("  Reveals open when every juror has committed or the commit window ends. Waiting 30 s...");
    await sleep(30_000);
  }

  for (const w of wallets) {
    if (await jury.hasRevealed(claimId, w.address)) {
      console.log(`  ${w.address} already revealed`);
      continue;
    }
    const saved = salts[w.address];
    if (!saved) {
      console.log(`  ${w.address} committed outside this script; reveal it from the app`);
      continue;
    }
    const sent = await jury.connect(w).revealVote(claimId, BigInt(saved.amount), saved.noteHash, saved.salt);
    await sent.wait();
    console.log(`  ${w.address} revealed: ${tx(sent.hash)}`);
  }
  console.log("Done. The keeper tallies the claim within a minute once voting can close; then accept the offer in the app.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
