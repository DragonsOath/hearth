import { expect, test } from "@playwright/test";

// Settings folds its sections (the owner, 11-13: "drop downs, not scrolling forever").
// The shared sign-in state opens them all for other tests; this one starts folded.

test("Settings: sections fold, remember, open from a link, and Open all / Close all", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("fold-test")) {
      sessionStorage.setItem("fold-test", "1");
      localStorage.setItem("settings-fold-default", "closed");
      for (const k of Object.keys(localStorage))
        if (k.startsWith("section-open:settings:")) localStorage.removeItem(k);
    }
  });
  await page.goto("/settings#cave");
  const voice = page.getByRole("region", { name: "Ember: voice" });
  const toggle = voice.getByRole("button", { name: "Ember: voice" });
  // Folded: only the title shows.
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Ember: what it looks after" })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // Remembered on this browser.
  await page.reload();
  await expect(
    page
      .getByRole("region", { name: "Ember: voice" })
      .getByRole("button", { name: "Ember: voice" }),
  ).toHaveAttribute("aria-expanded", "true");
  // A link to a section opens it.
  await page.goto("/settings#show-and-tell");
  await expect(
    page
      .getByRole("region", { name: "Ember: Show & Tell" })
      .getByRole("button", { name: "Ember: Show & Tell" }),
  ).toHaveAttribute("aria-expanded", "true");
  // Open all, then Close all.
  await page.getByTestId("settings-fold-all").click();
  const all = page.locator('[data-fold="settings"]');
  await expect(all.first()).toBeVisible();
  for (const b of await all.all()) await expect(b).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("settings-fold-all")).toHaveText("Close all");
  await page.getByTestId("settings-fold-all").click();
  for (const b of await all.all()) await expect(b).toHaveAttribute("aria-expanded", "false");
});
