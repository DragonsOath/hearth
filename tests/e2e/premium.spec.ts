import { expect, test } from "@playwright/test";
const OWNER_PASSWORD = "e2e owner password";

// Hearth Premium (11-05): Settings, Premium shows the two premium features and this Hearth's
// access. The test Hearth is its own issuer (a test key, trusted only in browser tests): a code is
// shown once; revoking the owner's grant locks Show & Tell and adding a PC with a plain message,
// while the rest of Hearth stays free; redeeming the code brings it back.

test("Premium: access, a code shown once, revoke with a confirmation, locked states, redeem", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Issuing needs a fresh "it's you" and the vault unlocked: sign in again, as the owner would.
  const login = await page.request.post("/api/auth/login", { data: { password: OWNER_PASSWORD } });
  expect(login.status(), await login.text()).toBeLessThan(300);
  await page.goto("/settings#premium");
  const features = page.getByTestId("premium-features");
  await expect(features).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("premium-hearth_interconnectivity")).toHaveAttribute(
    "data-state",
    "active",
  );
  await expect(page.getByTestId("premium-ember_show_and_tell")).toContainText(
    "Complimentary, for good",
  );
  await expect(page.getByTestId("premium-install-id")).toHaveText(/^[0-9a-f-]{36}$/);
  // Paying is never in Hearth: no card fields. Sponsors opens at launch.
  await expect(page.locator("input[autocomplete^='cc-']")).toHaveCount(0);

  // A promo code: the whole code once, then only its first letters.
  const issuer = page.getByTestId("premium-issuer");
  const codeForm = issuer.getByTestId("premium-code-form");
  await codeForm.getByLabel("Campaign (optional)").fill("Browser test");
  await codeForm.getByRole("button", { name: "Make the code" }).click();
  const once = page.getByTestId("premium-shown-once");
  await expect(once).toContainText(/HRTH-[0-9A-Z]{5}-/);
  const code = (await once.locator("code").textContent())!.trim();
  await once.getByRole("button", { name: "Done" }).click();
  await expect(issuer.getByTestId("premium-codes")).toContainText(code.slice(0, 10));
  await expect(page.locator("body")).not.toContainText(code);

  // Revoke the owner's grant, after a confirmation.
  const grants = issuer.getByTestId("premium-grants");
  const mine = grants.locator("li").filter({ hasText: "The test owner" }).first();
  await mine.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("settings and links are kept");
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(mine).toContainText("Revoked");
  await expect(page.getByTestId("premium-ember_show_and_tell")).toHaveAttribute(
    "data-state",
    "revoked",
  );

  try {
    // Show & Tell: a plain locked note (its own setting comes with the Premium package).
    await page.goto("/settings#show-and-tell");
    await expect(page.getByTestId("premium-card-ember_show_and_tell")).toContainText(
      "part of Hearth Premium",
    );
    await page
      .getByTestId("premium-card-ember_show_and_tell")
      .getByRole("link", { name: /Upgrade/ })
      .click();
    await expect(page.getByTestId("premium-upgrade")).toBeVisible();
    // Adding a PC: said plainly up front, and refused by the server too (not just hidden).
    await page.goto("/settings#devices");
    await page.getByRole("button", { name: /Link another Hearth/ }).click();
    await expect(page.getByTestId("add-pc-locked")).toContainText("Hearth Connected");
    // The free option is named next to the lock, and opens Add a system.
    await expect(page.getByTestId("add-pc-free")).toContainText("That's free");
    await page.getByTestId("add-pc-free").getByRole("link", { name: "Add a system" }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Add a system" })).toBeVisible();
    // Without the Premium package, linking doesn't exist on the server at all.
    expect((await page.request.post("/api/pcs/codes", { data: {} })).status()).toBe(404);
    // The rest of Hearth is free as ever: signing in a phone still works.
    expect(
      (await page.request.post("/api/devices/codes", { data: { purpose: "device" } })).status(),
    ).toBe(200);

    // Upgrade, on a Hearth already in use: sponsor (at launch) or enter a code. The code brings
    // it back (redeemed on this issuing Hearth), and a gifted one says so.
    await page.goto("/settings#premium");
    const upgrade = page.getByTestId("premium-upgrade");
    await expect(upgrade).toContainText("Upgrade to Premium");
    await expect(upgrade.getByTestId("premium-sponsor-soon")).toBeVisible();
    await expect(upgrade.getByTestId("premium-founder-price")).toHaveText(
      /^Founder: \$60 launch price, \$99 after /,
    );
    await upgrade.getByTestId("premium-enter-code").click();
    await expect(page.getByLabel("Redeem a code")).toBeFocused();
    await page.getByLabel("Redeem a code").fill(code.toLowerCase());
    await page.getByRole("button", { name: "Redeem", exact: true }).click();
    await expect(page.getByTestId("premium-gifted")).toContainText(
      "please mention you received Premium free",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("premium-ember_show_and_tell")).toHaveAttribute(
      "data-state",
      "active",
      {
        timeout: 15_000,
      },
    );
    // Once per installation.
    await page.getByLabel("Redeem a code").fill(code);
    await page.getByRole("button", { name: "Redeem", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "already redeemed" })).toBeVisible();
  } finally {
    // Back as it was for the other suites: the grant from the code taken back, the owner's
    // grant reinstated.
    const view = (await (await page.request.get("/api/premium/issuer")).json()) as {
      grants: { id: string; codeId: string | null; state: string }[];
    };
    for (const g of view.grants.filter((x) => x.codeId && x.state === "active"))
      await page.request.post(`/api/premium/issuer/grants/${g.id}/revoke`, { data: {} });
    await page.goto("/settings#premium");
    const again = page
      .getByTestId("premium-grants")
      .locator("li")
      .filter({ hasText: "The test owner" })
      .first();
    if (await again.getByRole("button", { name: "Reinstate" }).isVisible())
      await again.getByRole("button", { name: "Reinstate" }).click();
    await expect(again).toContainText("Active");
  }
});
