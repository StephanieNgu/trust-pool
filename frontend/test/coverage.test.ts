// The device-coverage workflow as the Pool page runs it: quote, buy (approving mUSDC when needed),
// read the dashboard, contribute, cancel. Calls the real frontend modules against Hardhat + backend.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toUtf8Bytes } from "ethers";
import { enrollDevice, getDashboardOverview, getEvidence, getMember, requestCaptureCode } from "../src/api";
import { purchaseCoverage, quoteCoverage } from "../src/contracts/insurance";
import { cancelCoverage, contributeToPool } from "../src/contracts/member";
import { USDC, browser, pickedFile, progressLog, startStack, stopStack, testDevice, testImei, type Stack } from "./harness";

/** Stands in for a signup bundle in tests that fail before anything is sent. */
const SOME_ENROLLMENT = `0x${"11".repeat(32)}`;
const photos = () => [
  pickedFile("IMG_0001.jpg", "image/jpeg", "front"),
  pickedFile("IMG_0002.jpg", "image/jpeg", "back"),
  pickedFile("IMG_0003.png", "image/png", "about screen"),
];

describe("frontend coverage workflow", () => {
  let t: Stack;
  let account: string;

  before(async () => {
    t = await startStack({ autoResolve: false });
    // A wallet with mUSDC but no policy, like a freshly funded MetaMask account.
    account = t.signers[10].address;
    await (await t.token.mint(account, USDC(500))).wait();
  });
  after(async () => {
    await stopStack(t);
  });

  it("shows an uncovered wallet on the dashboard", async () => {
    const overview = await getDashboardOverview(account);
    assert.equal(overview.active, false);
    assert.equal(overview.policyId, "0");
    assert.equal(overview.coverage, "0.0");
    assert.equal(overview.balance, "500.0");
    assert.equal(overview.maxCoverage, "2000.0");
    assert.equal(overview.tokenSymbol, "mUSDC");
    assert.equal(overview.tokenDecimals, 6);
    assert.equal(overview.claimEligibleAt, null);
    assert.equal(overview.openClaimId, null);
  });

  it("quotes the premium the registry will charge", async () => {
    assert.equal(await quoteCoverage(account, "800"), "40.0");
    assert.equal(await quoteCoverage(account, "2000"), "100.0");
    assert.equal(await t.registry.premiumFor(USDC(800)), USDC(40));

    await assert.rejects(quoteCoverage(account, "0"), /within the available limit/);
    await assert.rejects(quoteCoverage(account, "2000.000001"), /within the available limit/);
  });

  it("refuses to buy against a stale quote or without enough mUSDC", async () => {
    await assert.rejects(purchaseCoverage(account, testDevice(60), "800", "39.0", SOME_ENROLLMENT, () => {}), /premium has changed/);

    const broke = t.signers[11].address;
    await assert.rejects(purchaseCoverage(broke, testDevice(60), "800", "40.0", SOME_ENROLLMENT, () => {}), /Insufficient mUSDC/);

    assert.equal((await getMember(account)).policy, null);
    assert.equal((await getMember(broke)).policy, null);
  });

  it("refuses to buy before the device photos are uploaded", async () => {
    await assert.rejects(purchaseCoverage(account, testDevice(60), "800", "40.0", "", () => {}), /device photos/);
    await assert.rejects(
      purchaseCoverage(account, testDevice(60), "800", "40.0", `0x${"0".repeat(64)}`, () => {}),
      /device photos/,
    );
  });

  it("checks the device details before asking for a signature", async () => {
    const code = { code: "TP-AAAAAA" };
    await assert.rejects(enrollDevice(account, { ...testDevice(60), imei: "1234" }, photos(), code.code), /15-digit IMEI/);
    await assert.rejects(enrollDevice(account, { ...testDevice(60), color: " " }, photos(), code.code), /device color/);
    await assert.rejects(enrollDevice(account, testDevice(60), photos(), ""), /capture code/);
    await assert.rejects(enrollDevice(account, { ...testDevice(60), imei: "" }, photos(), code.code), /15-digit IMEI/, "a phone needs its IMEI");
    await assert.rejects(enrollDevice(account, { ...testDevice(60), type: undefined }, photos(), code.code), /kind of device/);
  });

  let enrollmentHash: string;
  it("uploads the device details and signup photos with a capture code", async () => {
    const { code } = await requestCaptureCode(account);
    const summary = await enrollDevice(account, { ...testDevice(60), imei: ` ${testImei(60).slice(0, 8)} ${testImei(60).slice(8)} ` }, photos(), code);
    assert.equal(summary.kind, "enrollment");
    assert.deepEqual(summary.device, testDevice(60), "IMEI spaces removed, fields trimmed");
    assert.equal(summary.capture?.code, code);
    assert.equal(summary.files.length, 3);
    enrollmentHash = summary.evidenceHash;
    assert.equal((await getEvidence(account, enrollmentHash)).kind, "enrollment");

    await assert.rejects(enrollDevice(account, testDevice(60), photos(), code), /already been used/);
  });

  it("approves the premium, buys the policy and shows it on the dashboard", async () => {
    const before = await getDashboardOverview(account);
    const progress = progressLog();

    const txHash = await purchaseCoverage(account, testDevice(60), "800", "40.0", enrollmentHash, progress.report);
    assert.match(txHash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(progress.messages, [
      "Approve the mUSDC payment in MetaMask.",
      "Waiting for payment approval to confirm…",
      "Confirm your device coverage in MetaMask.",
      "Your coverage transaction is confirming…",
    ]);

    const after = await getDashboardOverview(account);
    assert.equal(after.active, true);
    assert.equal(after.coverage, "800.0");
    assert.equal(after.balance, "460.0");
    assert.equal(after.contributed, "40.0");
    assert.equal(Number(after.pool) - Number(before.pool), 40);
    assert.equal(after.policyCount, before.policyCount + 1);
    assert.equal(after.waitingPeriod, Number(t.params.waitingPeriod));
    assert.equal(after.claimEligibleAt, after.startTime + Number(t.params.waitingPeriod));
    assert.equal(after.pastWaitingPeriod, false);
    assert.notEqual(after.policyId, "0");

    // Only hashes go on-chain: of the IMEI, and of the signup bundle.
    const policy = (await getMember(account)).policy;
    assert.ok(policy);
    assert.equal(policy.deviceIdHash, keccak256(toUtf8Bytes(testImei(60))));
    assert.equal(policy.enrollmentHash, enrollmentHash);
    const onChain = await t.registry.getPolicy(account);
    assert.equal(onChain.deviceIdHash, policy.deviceIdHash);
    assert.equal(onChain.enrollmentHash, enrollmentHash);
  });

  it("does not let the same wallet buy a second policy", async () => {
    await assert.rejects(purchaseCoverage(account, testDevice(61), "500", "25.0", SOME_ENROLLMENT, () => {}));
    const policy = (await getMember(account)).policy;
    assert.equal(policy?.coverageLimit, USDC(800).toString());
  });

  it("skips the approval step when the allowance already covers the premium", async () => {
    const other = t.signers[12];
    await (await t.token.mint(other.address, USDC(100))).wait();
    await (await t.token.connect(other).approve(await t.pool.getAddress(), USDC(100))).wait();

    const progress = progressLog();
    // A camera has no IMEI, so it is identified on-chain by make and serial number.
    const camera = { type: "camera" as const, serial: "cam 0001", make: "Canon", model: "EOS R50", color: "Black" };
    await purchaseCoverage(other.address, camera, "1000", "50.0", SOME_ENROLLMENT, progress.report);
    assert.deepEqual(progress.messages, [
      "Confirm your device coverage in MetaMask.",
      "Your coverage transaction is confirming…",
    ]);
    assert.equal((await getDashboardOverview(other.address)).coverage, "1000.0");
    assert.equal((await t.registry.getPolicy(other.address)).deviceIdHash, keccak256(toUtf8Bytes("canon:CAM0001")));
  });

  it("adds a pool contribution to the member and pool totals", async () => {
    const before = await getDashboardOverview(account);
    const progress = progressLog();
    await contributeToPool(account, "25.5", 6, progress.report);
    assert.equal(progress.messages[0], "Approve the mUSDC contribution in your wallet.");

    const after = await getDashboardOverview(account);
    assert.equal(after.contributed, "65.5");
    assert.equal(after.balance, "434.5");
    assert.equal(Number(after.totalContributed) - Number(before.totalContributed), 25.5);

    await assert.rejects(contributeToPool(account, "1.0000001", 6, () => {}), /no more than 6 decimal places/);
    await assert.rejects(contributeToPool(account, "0", 6, () => {}), /greater than zero/);
    await assert.rejects(contributeToPool(account, "10000", 6, () => {}), /does not have enough mUSDC/);
  });

  it("cancels coverage and shows the policy as lapsed", async () => {
    const progress = progressLog();
    await cancelCoverage(account, progress.report);
    assert.deepEqual(progress.messages, [
      "Confirm the coverage cancellation in your wallet.",
      "Your cancellation is confirming on-chain…",
    ]);

    const overview = await getDashboardOverview(account);
    assert.equal(overview.active, false);
    assert.equal(overview.contributed, "65.5", "premiums and contributions stay in the pool");
    assert.equal((await getMember(account)).policy?.status, "Lapsed");
    await assert.rejects(cancelCoverage(account, () => {}), /does not have active coverage/);
  });

  it("explains a missing deployment or the wrong network instead of sending transactions", async () => {
    browser.deploymentAvailable = false;
    try {
      await assert.rejects(quoteCoverage(account, "100"), /Local contract addresses are unavailable/);
    } finally {
      browser.deploymentAvailable = true;
    }

    browser.walletChainId = "0x1";
    try {
      await assert.rejects(quoteCoverage(account, "100"), /Switch to Hardhat Local/);
      await assert.rejects(purchaseCoverage(account, testDevice(60), "100", "5.0", SOME_ENROLLMENT, () => {}), /Switch to Hardhat Local/);
    } finally {
      browser.walletChainId = null;
    }
  });
});