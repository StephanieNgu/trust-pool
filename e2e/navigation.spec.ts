import { expect, test } from "./fixtures/wallet";

test("profile, navigation, policy terms, and mobile layout remain usable", async ({ page, wallet }) => {
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByTitle(wallet.accounts[0])).toBeVisible();

  await page.getByRole("button", { name: /Pool member/ }).click();
  const name = page.getByLabel("Your name");
  await name.fill("Playwright Member");
  await name.press("Enter");
  await expect(page.getByRole("button", { name: /Playwright Member/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Playwright Member/ })).toBeVisible();
  await expect(page.getByTitle(wallet.accounts[0])).toBeVisible();

  const destinations = [
    ["Community Pool", "Community pool"],
    ["Device Coverage", "Get device coverage"],
    ["Claims", "Claims"],
    ["Jury Queue", "Jury queue"],
    ["Policy Terms", "What your cover includes"],
  ] as const;
  for (const [button, heading] of destinations) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }

  await expect(page.getByRole("region", { name: "At a glance" })).toContainText("Monthly premium");
  await expect(page.getByRole("region", { name: "What's covered" })).toContainText("Cracked or broken screen");
  await expect(page.getByRole("region", { name: "What's not covered" })).toContainText("Losing the device");
  await expect(page.getByRole("region", { name: "How a claim is paid" })).toContainText("Five members decide");
  await expect(page.getByRole("region", { name: "Premiums and ending cover" })).toContainText("cancel at any time");

  await page.setViewportSize({ width: 390, height: 844 });
  const facts = page.locator(".terms-facts > div");
  const first = await facts.nth(0).boundingBox();
  const second = await facts.nth(1).boundingBox();
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(Math.abs(first!.x - second!.x)).toBeLessThan(2);
  expect(second!.y).toBeGreaterThan(first!.y);

  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  const fitsViewport = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fitsViewport).toBe(true);
});
