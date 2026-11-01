// @chainlink/contracts imports OpenZeppelin as "@openzeppelin/contracts@4.9.6/...", but npm installs
// that dependency as "@openzeppelin/contracts-4.9.6". Hardhat resolves imports by folder name, so
// link the name Chainlink's sources use to the folder npm created. Runs after every npm install.
const fs = require("fs");
const path = require("path");

const scope = path.join(__dirname, "..", "node_modules", "@openzeppelin");
const links = [["contracts@4.9.6", "contracts-4.9.6"]];

for (const [name, target] of links) {
  const from = path.join(scope, name);
  const to = path.join(scope, target);
  if (!fs.existsSync(to) || fs.existsSync(from)) continue;
  try {
    // A junction needs no admin rights on Windows; elsewhere it is an ordinary directory symlink.
    fs.symlinkSync(to, from, "junction");
  } catch {
    fs.cpSync(to, from, { recursive: true });
  }
}
