import { expect, test } from "./fixtures/wallet";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZP4sAAAAASUVORK5CYII=",
  "base64",
);

const photo = (name: string) => ({ name, mimeType: "image/png", buffer: PNG });

test("a member enrolls a device, reviews the premium, and purchases coverage", async ({ page, wallet }) => {
  await page.goto("/");

  await expect(page.getByText("Make this space yours.", { exact: true })).toBeVisible();
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByText("Hardhat Local", { exact: true })).toBeVisible();
  await expect(page.getByTitle(wallet.accounts[0])).toBeVisible();

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Device Coverage", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Get device coverage" })).toBeVisible();

  await page.getByLabel("IMEI").fill("123");
  await page.getByLabel("Serial number").fill("E2E-SERIAL-001");
  await page.getByLabel("Make").fill("Apple");
  await page.getByLabel("Model").fill("iPhone 13");
  await page.getByLabel("Colour").fill("Blue");
  await page.getByLabel("Desired coverage").fill("500");
  await page.getByRole("button", { name: "Review premium" }).click();
  await expect(page.getByRole("alert")).toContainText("15-digit IMEI");

  await page.getByLabel("IMEI").fill("490154203237518");
  await page.getByRole("button", { name: "Get capture code" }).click();
  await expect(page.locator(".capture-code-value")).toBeVisible();
  await page.getByLabel("Front, screen on").setInputFiles(photo("front.png"));
  await page.getByLabel("Back").setInputFiles(photo("back.png"));
  await page.getByLabel("Settings › About").setInputFiles(photo("about.png"));

  await page.getByRole("button", { name: "Review premium" }).click();
  await expect(page.locator(".premium-total dd")).toContainText("7.5 mUSDC");
  await expect(page.getByRole("button", { name: "Approve & confirm coverage" })).toBeEnabled();

  await page.getByLabel("Desired coverage").fill("600");
  await expect(page.getByRole("button", { name: "Approve & confirm coverage" })).toBeDisabled();
  await page.getByRole("button", { name: "Review premium" }).click();
  await expect(page.locator(".premium-total dd")).toContainText("9 mUSDC");

  await page.getByRole("button", { name: "Approve & confirm coverage" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Active coverage", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Coverage #\d+ · up to 600 mUSDC per claim\.$/)).toBeVisible();

  await page.getByRole("button", { name: "Device Coverage", exact: true }).click();
  await expect(page.getByText("This wallet already has active device coverage.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review premium" })).toBeDisabled();
});
