import { expect, test } from "@playwright/test";

// Ember Show & Tell is in the Premium package (11-14). Without it, its place in Settings says what
// Premium adds, and nothing on screen follows Ember around.

test("without the Premium package: Settings says what Show & Tell adds", async ({ page }) => {
  test.skip(Boolean(process.env.DC_E2E_ADDONS_DIR), "With the package its own setting shows.");
  await page.goto("/settings#show-and-tell");
  const card = page.getByTestId("premium-card-ember_show_and_tell");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Show & Tell is part of Hearth Premium");
  await expect(card.getByRole("link", { name: /Upgrade/ })).toHaveAttribute(
    "href",
    "/settings#premium",
  );
  await expect(page.getByTestId("show-settings")).toHaveCount(0);
  // No /api/show here: the screen reads that as off and never asks for the next thing to show.
  expect((await page.request.get("/api/show/settings")).status()).toBe(404);
});
