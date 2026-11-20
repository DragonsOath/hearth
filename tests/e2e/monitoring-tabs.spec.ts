import { expect, test } from "@playwright/test";

// Monitoring's pages as tabs, like Settings (11-13): each tab is still its own address.
test("Monitoring has Findings, Incidents, Autonomy and Notifications tabs", async ({ page }) => {
  await page.goto("/incidents");
  const tabs = page.getByRole("tablist", { name: "Monitoring" });
  await expect(tabs).toBeVisible({ timeout: 20_000 });
  await expect(tabs.getByRole("tab")).toHaveText([
    "Findings",
    "Incidents",
    "Autonomy",
    "Notifications",
  ]);
  await expect(tabs.getByRole("tab", { name: "Incidents" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabs.getByRole("tab", { name: "Autonomy" }).click();
  await expect(page).toHaveURL(/\/autonomy$/);
  await expect(tabs.getByRole("tab", { name: "Autonomy" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Arrow keys move between tabs, as in Settings.
  await tabs.getByRole("tab", { name: "Autonomy" }).press("ArrowRight");
  await expect(page).toHaveURL(/\/notifications$/);
  // The next page's own tab bar is up (each tab is its own page) before the next key.
  await expect(tabs.getByRole("tab", { name: "Notifications" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await tabs.getByRole("tab", { name: "Notifications" }).press("ArrowRight");
  await expect(page).toHaveURL(/\/findings$/);
  await expect(tabs.getByRole("tab", { name: "Findings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
