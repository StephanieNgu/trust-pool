const { readFileSync, rmSync, mkdirSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { spawn } = require("node:child_process");

const repositoryRoot = resolve(__dirname, "..");
const e2eData = join(repositoryRoot, ".e2e-data");
const children = [];
const rpcUrl = "http://127.0.0.1:28545";
const backendUrl = "http://127.0.0.1:23000";
const frontendUrl = "http://127.0.0.1:25173";

function packageBin(name) {
  const packageFile = require.resolve(`${name}/package.json`, { paths: [repositoryRoot] });
  const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
  const relativeBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin[Object.keys(packageJson.bin)[0]];
  return resolve(dirname(packageFile), relativeBin);
}

function start(label, bin, args, env = {}) {
  const child = spawn(process.execPath, [packageBin(bin), ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: label === "Hardhat node" ? ["ignore", "ignore", "inherit"] : "inherit",
    windowsHide: true,
  });
  child.on("exit", (code, signal) => {
    if (code && !stopping) console.error(`${label} exited with code ${code}${signal ? ` (${signal})` : ""}.`);
  });
  children.push(child);
  return child;
}

function runOnce(label, bin, args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = start(label, bin, args, env);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${label} exited with code ${code}.`));
    });
  });
}

async function waitFor(label, request, processToWatch, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (processToWatch.exitCode !== null) throw new Error(`${label} process exited before becoming ready.`);
    try {
      const response = await request();
      if (response.ok) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        if (processToWatch.exitCode !== null) throw new Error(`${label} process exited while becoming ready.`);
        return;
      }
      lastError = new Error(`${label} returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

async function requireFreeEndpoint(label, request) {
  try {
    await request();
  } catch {
    return;
  }
  throw new Error(`${label} is already in use. Stop the existing E2E services before running Playwright.`);
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await Promise.race([
    Promise.all(children.map((child) => child.exitCode === null
      ? new Promise((resolveExit) => child.once("exit", resolveExit))
      : Promise.resolve())),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function startE2EServices() {
  try {
    await requireFreeEndpoint("E2E RPC port 28545", () => fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    }));
    await requireFreeEndpoint("E2E backend port 23000", () => fetch(`${backendUrl}/api/health`));
    await requireFreeEndpoint("E2E frontend port 25173", () => fetch(frontendUrl));

    if (dirname(e2eData) !== repositoryRoot) throw new Error(`Refusing to clear unexpected E2E path: ${e2eData}`);
    rmSync(e2eData, { recursive: true, force: true });
    mkdirSync(e2eData, { recursive: true });

    const chain = start("Hardhat node", "hardhat", ["node", "--hostname", "127.0.0.1", "--port", "28545"]);
    await waitFor(
    "Hardhat node",
    () => fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    }),
    chain,
  );

    await runOnce("Local deployment", "hardhat", ["run", "scripts/deploy.js", "--network", "localhost"], {
      LOCALHOST_RPC_URL: rpcUrl,
    });

    const backend = start("Backend", "tsx", ["backend/src/server.ts"], {
    EVIDENCE_DIR: join(e2eData, "evidence"),
    EVIDENCE_KEY_FILE: join(e2eData, "evidence.key"),
    ACCOUNTS_DIR: join(e2eData, "accounts"),
    KEEPER_INTERVAL_MS: "250",
    PORT: "23000",
    RPC_URL: rpcUrl,
  });
    await waitFor("Backend", () => fetch(`${backendUrl}/api/health`), backend);

    const frontend = start("Vite", "vite", ["--host", "127.0.0.1", "--port", "25173", "--strictPort"], {
      BACKEND_URL: backendUrl,
    });
    await waitFor("Frontend", () => fetch(frontendUrl), frontend);
    console.log("Playwright services are ready.");
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

async function runFromCommandLine() {
  const stopServices = await startE2EServices();
  await new Promise((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
  await stopServices();
}

if (require.main === module) runFromCommandLine()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

module.exports = { startE2EServices };
