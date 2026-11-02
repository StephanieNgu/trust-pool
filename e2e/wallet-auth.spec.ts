import { expect, test } from "./fixtures/wallet";

test("wallet, authentication, network, and transaction errors recover cleanly", async ({ page, wallet }) => {
  await page.goto("/");
  await expect(page.getByText("Make this space yours.", { exact: true })).toBeVisible();
  const connect = page.getByRole("banner").getByRole("button", { name: "Connect wallet" });
  await connect.click();
  await wallet.selectAccount(19);
  await expect(page.getByTitle(wallet.accounts[19])).toBeVisible();

  await wallet.setChainId("0x1");
  await expect(page.getByText("Wrong network", { exact: true })).toBeVisible();
  await expect(page.getByText(/Switch MetaMask to Hardhat Local/)).toBeVisible();
  await wallet.setChainId("0x7a69");
  await expect(page.getByText("Hardhat Local", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  await wallet.rejectNext("personal_sign");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Request cancelled in your wallet. You can try again.");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Community Pool", exact: true }).click();
  await page.getByLabel("Contribution amount").fill("1");
  await page.getByRole("button", { name: "Contribute to pool" }).click();
  await expect(page.getByText(/You are contributing/)).toContainText("1 mUSDC");
  await wallet.rejectNext("eth_sendTransaction");
  await page.getByRole("button", { name: "Confirm contribution" }).click();
  await expect(page.getByRole("alert")).toContainText("Request cancelled in your wallet. No contribution was made.");
  await expect(page.getByLabel("Contribution amount")).toHaveValue("1");

  await page.getByRole("button", { name: "Contribute to pool" }).click();
  await page.getByRole("button", { name: "Confirm contribution" }).click();
  await expect(page.getByText("Contribution confirmed. The shared pool balance has been updated.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Contribution amount")).toHaveValue("");

  await wallet.reset();
  await expect(page.getByText("Make this space yours.", { exact: true })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("button", { name: "Connect wallet" })).toBeEnabled();
});
