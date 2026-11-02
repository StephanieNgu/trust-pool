import { expect, test } from "./fixtures/wallet";

test("starts the full local stack with a deterministic browser wallet", async ({ page, wallet }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Trust Pool");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Hardhat Local", { exact: true })).toBeVisible();
  await expect(page.getByTitle(wallet.accounts[0])).toBeVisible();
});
