import { expect, test } from "@playwright/test";

// The Premium split (11-14): an add-on's screens load into the core's slots, with Hearth's own
// React, and Settings says whether the Premium package is installed.
test("an add-on's screen fills its slot and reaches its own route", async ({ page }) => {
  await page.goto("/settings#premium");
  await expect(page.getByTestId("premium-package")).toContainText(
    "Premium package installed: test-addon 0.0.1",
  );
  await expect(page.getByTestId("test-addon-slot")).toHaveText(
    "Filled by the test add-on, and its route answered.",
  );
});
