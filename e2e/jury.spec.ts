import { expect, test, type E2EWallet } from "./fixtures/wallet";
import type { Page } from "@playwright/test";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP4sAAAAASUVORK5CYII=",
  "base64",
);
const photo = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.from(name)]) });

async function buyCoverage(page: Page, wallet: E2EWallet, accountIndex: number, insuredDevice = false) {
  await wallet.selectAccount(accountIndex);
  await expect(page.getByTitle(wallet.accounts[accountIndex])).toBeVisible();
  await page.getByRole("button", { name: "Device Coverage", exact: true }).click();
  await page.getByLabel("Device type").selectOption("camera");
  await page.getByLabel("Serial number").fill(`JURY-E2E-${accountIndex}`);
  await page.getByLabel("Make").fill("Playwright");
  await page.getByLabel("Model").fill(`Review Camera ${accountIndex}`);
  await page.getByLabel("Colour").fill("Black");
  await page.getByRole("button", { name: "Get capture code" }).click();
  await expect(page.locator(".capture-code-value")).toBeVisible();
  if (insuredDevice) await page.getByLabel("I'm signing up on the device I'm insuring").check();
  await page.getByLabel("Front", { exact: true }).setInputFiles(photo(`jury-front-${accountIndex}.png`));
  await page.getByLabel("Back", { exact: true }).setInputFiles(photo(`jury-back-${accountIndex}.png`));
  await page.getByLabel("Serial number label", { exact: true }).setInputFiles(photo(`jury-serial-${accountIndex}.png`));
  await page.getByLabel("Desired coverage").fill("600");
  await page.getByRole("button", { name: "Review premium" }).click();
  await page.getByRole("button", { name: "Approve & confirm coverage" }).click();
  await expect(page.getByText("Active coverage", { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function joinJury(page: Page) {
  await page.getByRole("button", { name: "Jury Queue", exact: true }).click();
  const stake = page.getByRole("button", { name: /^Stake .* mUSDC$/ });
  await expect(stake).toBeEnabled();
  await stake.click();
  await expect(page.getByText("Stake locked. You can now be picked for juries.", { exact: true })).toBeVisible();
}

async function openQueue(page: Page, wallet: E2EWallet, accountIndex: number) {
  await wallet.selectAccount(accountIndex);
  await expect(page.getByTitle(wallet.accounts[accountIndex])).toBeVisible();
  await page.getByRole("button", { name: "Jury Queue", exact: true }).click();
  await expect(page.getByText("Loading jury assignments from the backend…", { exact: true })).toHaveCount(0, { timeout: 30_000 });
}

async function openAssignment(page: Page, wallet: E2EWallet, accountIndex: number, claimId: string) {
  await openQueue(page, wallet, accountIndex);
  const card = page.locator(".jury-card").filter({ hasText: `CLAIM #${claimId}` });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Review claim →" }).click();
  await expect(page.getByRole("heading", { name: `Claim #${claimId}` })).toBeVisible();
  await expect(page.getByText("Selected juror", { exact: true })).toBeVisible();
}

async function findSelectedJurors(page: Page, wallet: E2EWallet, claimId: string) {
  const candidates = [7, 8, 9, 10, 11, 13, 14, 15, 16, 17];
  let selected: number[] = [];
  await expect.poll(async () => {
    selected = [];
    for (const accountIndex of candidates) {
      await openQueue(page, wallet, accountIndex);
      if (await page.locator(".jury-card").filter({ hasText: `CLAIM #${claimId}` }).count()) selected.push(accountIndex);
    }
    return selected.length;
  }, { timeout: 30_000 }).toBe(5);
  return selected;
}

async function verifyClaimEvidence(page: Page) {
  const evidence = page.getByRole("region", { name: "Claim photos" });
  const load = evidence.getByRole("button", { name: "Sign in & view evidence" });
  if (await load.isVisible()) await load.click();
  await expect(evidence.getByText("✓ Unchanged since filing", { exact: true })).toBeVisible({ timeout: 30_000 });
}

test("jurors complete review and the claimant receives a receipt-based payout", async ({ page, wallet }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();

  const preparedJurors = [13, 14, 15, 16, 17];
  for (const accountIndex of preparedJurors) {
    await buyCoverage(page, wallet, accountIndex);
    await joinJury(page);
  }

  await buyCoverage(page, wallet, 12, true);
  await page.getByRole("button", { name: "Claims", exact: true }).click();
  await page.getByLabel("What happened to the device?").selectOption({ label: "Other accidental damage" });
  await page.getByLabel("Requested payout").fill("300");
  await page.getByLabel("How did you arrive at this amount?").fill("A repair shop quoted 300 mUSDC for the damaged camera body.");
  await page.getByLabel("Tell jurors what happened").fill("The camera fell from a table and the body and lens mount were damaged.");
  await page.getByLabel("IMEI or serial number").fill("JURY-E2E-12");
  await page.getByRole("button", { name: "Get capture code" }).click();
  await page.locator("#claim-capture-photo").setInputFiles(photo("jury-claim-damage.png"));
  await page.getByRole("button", { name: "Upload evidence & submit claim" }).click();

  const claimHeading = page.getByRole("heading", { name: /^Claim #\d+$/ });
  await expect(claimHeading).toBeVisible({ timeout: 30_000 });
  const claimId = (await claimHeading.textContent())?.match(/\d+/)?.[0];
  expect(claimId).toBeTruthy();
  const selectedJurors = await findSelectedJurors(page, wallet, claimId!);

  for (const accountIndex of selectedJurors) {
    await openAssignment(page, wallet, accountIndex, claimId!);
    await verifyClaimEvidence(page);
    await page.getByRole("button", { name: "Pay in full" }).click();
    await page.getByRole("button", { name: "Seal my vote" }).click();
    await expect(page.getByText(/Vote sealed|Reveal your vote/)).toBeVisible({ timeout: 30_000 });
  }

  for (const accountIndex of selectedJurors) {
    await openAssignment(page, wallet, accountIndex, claimId!);
    const reveal = page.getByRole("button", { name: "Reveal my vote" });
    await expect(reveal).toBeEnabled({ timeout: 30_000 });
    await reveal.click();
    await expect(page.getByRole("heading", { name: "Vote revealed" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("You voted 300 mUSDC.", { exact: false })).toBeVisible();
  }

  await wallet.selectAccount(12);
  await expect(page.getByTitle(wallet.accounts[12])).toBeVisible();
  await page.getByRole("button", { name: "Claims", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Claim #${claimId}` })).toBeVisible({ timeout: 30_000 });

  const offer = page.getByRole("region", { name: "Jury offer" });
  await expect(offer).toBeVisible({ timeout: 30_000 });
  await expect(offer.getByRole("heading", { name: "300 mUSDC" })).toBeVisible();
  await offer.getByRole("button", { name: "Show 5 revealed votes" }).click();
  await expect(offer.locator(".reasoning-list li")).toHaveCount(5);
  await offer.getByRole("button", { name: "Accept 300 mUSDC" }).click();

  const receipt = page.getByRole("region", { name: "Receipt" });
  await expect(receipt.getByRole("heading", { name: "Upload your repair or replacement receipt" })).toBeVisible({ timeout: 30_000 });
  await receipt.getByLabel("Shop or seller").fill("Playwright Camera Repair");
  await receipt.getByLabel("Total paid").fill("250");
  await receipt.getByLabel("Date on the receipt").fill(new Date().toISOString().slice(0, 10));
  await receipt.getByLabel("What was done").fill("Replaced the damaged body and lens mount.");
  await receipt.locator('input[type="file"]').setInputFiles(photo("jury-repair-receipt.png"));
  await expect(receipt.getByText("You'll be paid 250 mUSDC, what the receipt shows.", { exact: true })).toBeVisible();
  await receipt.getByRole("button", { name: "Upload receipt & get paid" }).click();

  await expect(page.locator(".claim-status")).toHaveText("Paid", { timeout: 30_000 });
  await expect(page.locator(".detail-grid").getByText("250 mUSDC", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Repair or replacement receipt" })).toBeVisible();
});
