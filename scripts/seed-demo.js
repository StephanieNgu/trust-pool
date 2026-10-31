// Gets a fresh local deployment to a claim-ready state: demo accounts 1 to 5 sign up for coverage
// (device details and signup photos, through the backend like the app does) and stake for jury
// duty. Account 0 is left alone so the demo can start by signing it up live. Set SEED_CLAIMANT=1 to
// sign account 0 up too. Safe to run twice: members already covered or staked are skipped.
//
//   npm run chain            # terminal 1
//   npm run deploy:local     # terminal 2 (also funds the pool)
//   npm run dev:backend      # terminal 3
//   npm run seed:demo        # terminal 2 again
//
// TRUSTPOOL_API overrides the backend URL (default http://localhost:3000).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ethers, network } = require("hardhat");

const API = (process.env.TRUSTPOOL_API || "http://localhost:3000").replace(/\/$/, "");

// One device per demo account. Account 0 is the claimant in the demo script.
const MEMBERS = [
  { account: 0, cover: 1000, device: { type: "phone", make: "Apple", model: "iPhone 13", color: "Blue", serial: "F2LXK0QJ0D" }, hue: [70, 120, 200] },
  { account: 1, cover: 800, device: { type: "phone", make: "Google", model: "Pixel 8", color: "Obsidian", serial: "GP8A11293" }, hue: [60, 60, 70] },
  { account: 2, cover: 900, device: { type: "phone", make: "Samsung", model: "Galaxy S23", color: "Cream", serial: "R5CW20AB9" }, hue: [220, 210, 180] },
  { account: 3, cover: 700, device: { type: "tablet", make: "Apple", model: "iPad Air", color: "Space Grey", serial: "DMPX93KQ7" }, hue: [110, 110, 120] },
  { account: 4, cover: 1000, device: { type: "laptop", make: "Apple", model: "MacBook Air", color: "Silver", serial: "C02FK1ZYQ6L4" }, hue: [190, 195, 200] },
  { account: 5, cover: 600, device: { type: "phone", make: "Apple", model: "iPhone 12", color: "Red", serial: "DX3G81MNQ2" }, hue: [200, 50, 60] },
];

/** A valid 15-digit IMEI built from `seed` (Luhn check digit appended). */
function imei(seed) {
  const body = `35${String(seed).padStart(12, "0")}`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let digit = Number(body[13 - i]);
    if (i % 2 === 0) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return body + ((10 - (sum % 10)) % 10);
}

// --- Placeholder photos: a small PNG of a device outline on a tinted background. ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** `view` 0 = front, 1 = back, 2 = serial label. `variant` makes each upload's bytes unique. */
function photo([r, g, b], view, variant) {
  const w = 240;
  const h = 320;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const inDevice = x > 60 && x < 180 && y > 40 && y < 280;
      const edge = inDevice && (x < 66 || x > 174 || y < 46 || y > 274);
      const label = view === 2 && x > 80 && x < 160 && y > 200 && y < 230;
      const camera = view === 1 && x > 72 && x < 100 && y > 52 && y < 80;
      const shade = 236 - Math.floor(y / 16);
      const px = edge || camera ? [40, 44, 52] : label ? [250, 250, 250] : inDevice ? (view === 0 ? [30, 34, 44] : [r, g, b]) : [shade, shade, shade + 6];
      raw.set(px, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    // The backend refuses a file it has seen before, so each upload carries its own id.
    chunk("tEXt", Buffer.from(`Comment\0trustpool-seed-${variant}-${view}`, "latin1")),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Backend calls, signed like the app signs them. ---
async function request(method, route, signer, body) {
  const headers = { "Content-Type": "application/json" };
  if (signer) {
    const address = await signer.getAddress();
    const challenge = await request("GET", `/api/auth/message?address=${address}`);
    headers[challenge.headers.address] = address;
    headers[challenge.headers.issuedAt] = String(challenge.issuedAt);
    headers[challenge.headers.signature] = await signer.signMessage(challenge.message);
  }
  const res = await fetch(API + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}. Run npm run deploy:local first.`);
  const { addresses } = JSON.parse(fs.readFileSync(file, "utf8"));
  try {
    await request("GET", "/api/health");
  } catch {
    throw new Error(`The backend is not answering at ${API}. Start it with npm run dev:backend.`);
  }

  const signers = await ethers.getSigners();
  const token = await ethers.getContractAt("MockStablecoin", addresses.token);
  const registry = await ethers.getContractAt("PolicyRegistry", addresses.registry);
  const pool = await ethers.getContractAt("Pool", addresses.pool);
  const decimals = await token.decimals();
  const jury = await ethers.getContractAt("JuryModule", addresses.jury);
  const minStake = await jury.minStake();
  const units = (n) => ethers.parseUnits(String(n), decimals);

  const members = MEMBERS.filter((m) => m.account !== 0 || process.env.SEED_CLAIMANT === "1");
  for (const member of members) {
    const signer = signers[member.account];
    const who = `Account ${member.account} (${member.device.make} ${member.device.model})`;

    if (await registry.isActive(signer.address)) {
      console.log(`${who}: already covered`);
    } else {
      const device = { ...member.device };
      if (device.type === "phone") device.imei = imei(910_000 + member.account * 37 + (Date.now() % 1000));
      device.serial = `${device.serial}${Date.now() % 10_000}`;
      const { code } = await request("POST", "/api/capture/code", signer, {});
      const variant = `${member.account}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const files = ["front", "back", "serial"].map((name, view) => ({
        name: `${name}.png`,
        contentType: "image/png",
        data: photo(member.hue, view, variant).toString("base64"),
      }));
      const enrollment = await request("POST", "/api/evidence", signer, { kind: "enrollment", device, captureCode: code, files });
      const cover = units(member.cover);
      const premium = await registry.premiumFor(cover);
      await (await token.connect(signer).approve(addresses.pool, premium)).wait();
      const identifier = device.imei || `${device.make.trim().toLowerCase()}:${device.serial.replace(/\s+/g, "").toUpperCase()}`;
      await (await registry.connect(signer).buyPolicy(ethers.keccak256(ethers.toUtf8Bytes(identifier)), cover, enrollment.evidenceHash)).wait();
      console.log(`${who}: covered for ${member.cover}, paid ${ethers.formatUnits(premium, decimals)} first premium`);
    }

    if (member.account === 0) continue;
    const staked = await pool.stakeOf(signer.address);
    if (staked >= minStake) {
      console.log(`${who}: already staked`);
    } else {
      await (await token.connect(signer).approve(addresses.pool, minStake - staked)).wait();
      await (await pool.connect(signer).stake(minStake - staked)).wait();
      console.log(`${who}: staked ${ethers.formatUnits(minStake, decimals)} for jury duty`);
    }
  }

  const reserve = await pool.balance();
  console.log(`\nPool reserve: ${ethers.formatUnits(reserve, decimals)}. Open http://localhost:5173/?demo=1 as Account 0 to start.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
