import { expect, test } from "@playwright/test";

// Hearth in a browser tab on the PC it is installed on (11-22, the owner: "After logging in on
// browser the user should be directed to the app on their PC"). The server's answer (this PC has
// the app) is a stand-in here: the test server has no installer's app next to it.

test("a browser tab on Hearth's PC offers the app, and Stay in the browser keeps the tab", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Phones have no installed app.");
  await page.route("**/api/app-window", (r) => r.fulfill({ json: { app: true } }));
  await page.goto("/plan");
  const dialog = page.getByRole("dialog", { name: "Hearth is an app on this PC" });
  await expect(dialog).toBeVisible();
  // Opens this same page in Hearth's own window.
  await expect(dialog.getByRole("link", { name: "Open the Hearth app" })).toHaveAttribute(
    "href",
    "hearth://open/plan",
  );
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/open-in-app.png` });
  await dialog.getByRole("button", { name: "Stay in the browser" }).click();
  await expect(dialog).toHaveCount(0);
  // For the rest of this browser session.
  await page.reload();
  await expect(page.getByTestId("open-in-app")).toHaveCount(0);
});

test("Hearth's own window, or a PC without the app, never shows it", async ({ page }) => {
  await page.route("**/api/app-window", (r) => r.fulfill({ json: { app: false } }));
  await page.goto("/plan");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page.getByTestId("open-in-app")).toHaveCount(0);

  await page.unroute("**/api/app-window");
  await page.route("**/api/app-window", (r) => r.fulfill({ json: { app: true } }));
  await page.goto("/plan?window=app");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page.getByTestId("open-in-app")).toHaveCount(0);
});
