import { expect, test, type E2EWallet } from "./fixtures/wallet";
import type { Page } from "@playwright/test";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP4sAAAAASUVORK5CYII=",
  "base64",
);

const photo = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.from(name)]) });

async function buyCoverage(page: Page, wallet: E2EWallet, accountIndex: number, claimant = false) {
  await wallet.selectAccount(accountIndex);
  await expect(page.getByTitle(wallet.accounts[accountIndex])).toBeVisible();
  await page.getByRole("button", { name: "Device Coverage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Get device coverage" })).toBeVisible();

  if (claimant) {
    await page.getByLabel("IMEI").fill("356938035643809");
  } else {
    await page.getByLabel("Device type").selectOption("camera");
  }
  await page.getByLabel("Serial number").fill(`E2E-DEVICE-${accountIndex}`);
  await page.getByLabel("Make").fill("Playwright");
  await page.getByLabel("Model").fill(claimant ? "Claim Phone" : `Jury Camera ${accountIndex}`);
  await page.getByLabel("Colour").fill("Blue");
  await page.getByRole("button", { name: "Get capture code" }).click();
  await expect(page.locator(".capture-code-value")).toBeVisible();

  if (claimant) await page.getByLabel("I'm signing up on the device I'm insuring").check();
  await page.getByLabel(claimant ? "Front, screen on" : "Front", { exact: true }).setInputFiles(photo(`front-${accountIndex}.png`));
  await page.getByLabel("Back", { exact: true }).setInputFiles(photo(`back-${accountIndex}.png`));
  await page.getByLabel(claimant ? "Settings › About" : "Serial number label", { exact: true }).setInputFiles(photo(`serial-${accountIndex}.png`));
  await page.getByLabel("Desired coverage").fill("600");
  await page.getByRole("button", { name: "Review premium" }).click();
  await expect(page.getByRole("button", { name: "Approve & confirm coverage" })).toBeEnabled();
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

test("a covered member submits claim evidence and opens the new claim", async ({ page, wallet }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();

  for (const accountIndex of [7, 8, 9, 10, 11]) {
    await buyCoverage(page, wallet, accountIndex);
    await joinJury(page);
  }

  await buyCoverage(page, wallet, 6, true);
  await page.getByRole("button", { name: "Claims", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tell the pool what happened." })).toBeVisible();
  await expect(page.getByText("Claims are paused:")).toHaveCount(0);

  await page.getByLabel("What happened to the device?").selectOption({ label: "Cracked or broken screen" });
  await page.getByLabel("Requested payout").fill("300");
  await page.getByLabel("How did you arrive at this amount?").fill("A repair shop quoted 300 mUSDC for a replacement screen.");
  await page.getByLabel("Tell jurors what happened").fill("The phone slipped from my hand today and the front glass cracked.");
  await page.getByLabel("IMEI or serial number").fill("E2E-DEVICE-6");
  await page.getByRole("button", { name: "Get capture code" }).click();
  await expect(page.locator(".capture-code-value")).toBeVisible();
  await expect(page.getByText(/This browser holds the key made when you signed up/)).toBeVisible();
  await page.locator("#claim-files").setInputFiles(photo("cracked-screen.png"));

  const submit = page.getByRole("button", { name: "Upload evidence & submit claim" });
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(page.getByRole("heading", { name: /^Claim #\d+$/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".detail-hero")).toContainText("300 mUSDC");
  await expect(page.getByText("Available to authorized wallets", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to list" })).toBeVisible();
});
