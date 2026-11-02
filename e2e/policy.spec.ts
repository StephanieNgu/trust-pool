import { expect, test } from "./fixtures/wallet";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP4sAAAAASUVORK5CYII=",
  "base64",
);
const photo = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.concat([PNG, Buffer.from(name)]) });

test("a member contributes, pays a premium early, and cancels coverage", async ({ page, wallet }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  await wallet.selectAccount(18);
  await expect(page.getByTitle(wallet.accounts[18])).toBeVisible();

  await page.getByRole("button", { name: "Community Pool", exact: true }).click();
  await page.getByLabel("Contribution amount").fill("100");
  await page.getByRole("button", { name: "Contribute to pool" }).click();
  await expect(page.getByText("Contribution confirmed. The shared pool balance has been updated.", { exact: true })).toBeVisible();
  const contributions = page.locator(".pool-stat-grid > div").filter({ hasText: "Your contributions" });
  await expect(contributions.locator("strong")).toHaveText("100 mUSDC");

  await page.getByRole("button", { name: "Device Coverage", exact: true }).click();
  await page.getByLabel("Device type").selectOption("camera");
  await page.getByLabel("Serial number").fill("POLICY-E2E-18");
  await page.getByLabel("Make").fill("Playwright");
  await page.getByLabel("Model").fill("Lifecycle Camera");
  await page.getByLabel("Colour").fill("Silver");
  await page.getByRole("button", { name: "Get capture code" }).click();
  await page.getByLabel("Front", { exact: true }).setInputFiles(photo("policy-front.png"));
  await page.getByLabel("Back", { exact: true }).setInputFiles(photo("policy-back.png"));
  await page.getByLabel("Serial number label", { exact: true }).setInputFiles(photo("policy-serial.png"));
  await page.getByLabel("Desired coverage").fill("600");
  await page.getByRole("button", { name: "Review premium" }).click();
  await page.getByRole("button", { name: "Approve & confirm coverage" }).click();
  await expect(page.getByText("Active coverage", { exact: true })).toBeVisible({ timeout: 30_000 });

  const premium = page.getByRole("group", { name: "Monthly premium" });
  await premium.getByRole("button", { name: "Pay 9 mUSDC early" }).click();
  await expect(premium.getByRole("button", { name: "Paid ahead" })).toBeDisabled({ timeout: 30_000 });
  await expect(premium).toContainText("Next premium 9 mUSDC every 30 days.");

  await page.getByRole("button", { name: "Cancel coverage" }).click();
  const confirmation = page.getByRole("group", { name: "Confirm coverage cancellation" });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep coverage" }).click();
  await expect(page.getByText("Active coverage", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cancel coverage" }).click();
  await page.getByRole("group", { name: "Confirm coverage cancellation" }).getByRole("button", { name: "Confirm cancellation" }).click();
  const coverageStat = page.getByRole("region", { name: "Account overview" }).locator("article").filter({ hasText: "My coverage" });
  await expect(coverageStat.locator("strong")).toHaveText("Not covered", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Get Device Coverage" })).toBeVisible();
  await expect(page.getByText("Get started", { exact: true })).toBeVisible();
});
