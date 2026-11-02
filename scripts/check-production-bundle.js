const { readFileSync, readdirSync } = require("node:fs");
const { extname, join } = require("node:path");

const bundleDir = join(__dirname, "..", "dist", "frontend");
const forbidden = [
  "test test test test test test test test test test test junk",
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
];

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

for (const path of filesUnder(bundleDir)) {
  if (![".css", ".html", ".js"].includes(extname(path))) continue;
  const contents = readFileSync(path, "utf8").toLowerCase();
  if (forbidden.some((value) => contents.includes(value))) {
    throw new Error(`Production bundle contains Hardhat demo signing material: ${path}`);
  }
}

console.log("Production bundle contains no Hardhat demo signing material.");
