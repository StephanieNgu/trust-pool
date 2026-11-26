// Submits a claim's repair receipt on Sepolia and pays the claim out, without the web app.
//
//   $env:CLAIM_ID="3"; $env:CLAIMANT_PRIVATE_KEY="0x..."; $env:RECEIPT_FILE="receipt.pdf"; $env:RECEIPT_TOTAL="100"
//   npx hardhat run scripts/sepolia-receipt.js --network sepolia
//
// Use it when the hosted backend can't take the upload. On-chain the receipt is only its SHA-256 hash
// and its total, so this sends the same submitReceipt the app sends; the file itself stays on your
// machine (jurors can't open it, since no backend stores it). It then calls executePayout, which
// anyone may call, so the payout doesn't wait for the keeper.
//
// Environment:
//   CLAIM_ID              required
//   CLAIMANT_PRIVATE_KEY  required, the wallet that filed the claim (MetaMask: Account details, Private key)
//   RECEIPT_TOTAL         required, mUSDC on the receipt; the payout is the smaller of this and the offer
//   RECEIPT_FILE          optional, a file to hash; without it the hash is of a short text note
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { ethers, network } = require("hardhat");

const root = path.join(__dirname, "..");
const tx = (hash) => `https://sepolia.etherscan.io/tx/${hash}`;

async function main() {
  const { CLAIM_ID, CLAIMANT_PRIVATE_KEY, RECEIPT_TOTAL, RECEIPT_FILE } = process.env;
  if (!CLAIM_ID || !CLAIMANT_PRIVATE_KEY || !RECEIPT_TOTAL) throw new Error("Set CLAIM_ID, CLAIMANT_PRIVATE_KEY and RECEIPT_TOTAL.");
  const deployment = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${network.name}.json`), "utf8"));
  const claimant = new ethers.Wallet(CLAIMANT_PRIVATE_KEY, ethers.provider);
  const claims = await ethers.getContractAt("ClaimManager", deployment.addresses.claimManager, claimant);
  const claimId = BigInt(CLAIM_ID);

  const bytes = RECEIPT_FILE ? fs.readFileSync(RECEIPT_FILE) : Buffer.from(`Receipt for claim ${CLAIM_ID}, ${new Date().toISOString()}`);
  const receiptHash = "0x" + createHash("sha256").update(bytes).digest("hex");
  const total = ethers.parseUnits(RECEIPT_TOTAL, 6);

  const before = await claims.getClaim(claimId);
  if (before.claimant.toLowerCase() !== claimant.address.toLowerCase()) throw new Error(`Claim #${claimId} was filed by ${before.claimant}, not ${claimant.address}.`);
  if (before.receiptHash === ethers.ZeroHash) {
    const sent = await claims.submitReceipt(claimId, receiptHash, total);
    await sent.wait();
    console.log(`Receipt submitted (${RECEIPT_TOTAL} mUSDC, hash ${receiptHash}): ${tx(sent.hash)}`);
  } else {
    console.log("A receipt is already on record; paying out.");
  }
  try {
    const sent = await claims.executePayout(claimId);
    await sent.wait();
    console.log(`Paid out: ${tx(sent.hash)}`);
  } catch (error) {
    const after = await claims.getClaim(claimId);
    if (after.paidAmount > 0n) console.log("The keeper already paid it.");
    else throw error;
  }
  const after = await claims.getClaim(claimId);
  console.log(`Claim #${claimId} paid ${ethers.formatUnits(after.paidAmount, 6)} mUSDC.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main };
