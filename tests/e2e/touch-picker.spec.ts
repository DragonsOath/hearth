import { expect, test, type Locator, type Page } from "@playwright/test";

// Drop-downs on a touch screen open Hearth's own picker instead of the phone's (11-15, the owner:
// "get rid of the generic Android pop ups and make Hearth themed ones"). The page keeps its
// ordinary drop-down, so the choice reaches it as if it were picked there.

/** A real finger: touch events, the way a phone sends them. */
async function tap(page: Page, el: Locator) {
  // Mid-screen, clear of the bottom tab bar.
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }));
  const box = (await el.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("a drop-down opens Hearth's picker, and the choice reaches the page", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch screens only; a mouse keeps the browser's own list.");
  await page.goto(`/?panels=${encodeURIComponent("tool:curator")}`);
  const rated = page.getByRole("combobox", { name: "Rated at least" });
  await expect(rated).toBeVisible({ timeout: 20_000 });
  await tap(page, rated);

  const sheet = page.getByRole("dialog", { name: "Rated at least" });
  await expect(sheet).toBeVisible();
  const options = sheet.getByRole("option");
  await expect(options).toHaveText(["Any", "6 / 10", "7 / 10", "8 / 10"]);
  await expect(sheet.getByRole("option", { name: "Any" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "test-results/screens/mobile/touch-picker.png" });

  await sheet.getByRole("option", { name: "7 / 10" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(rated).toHaveValue("7");

  // Open again: the choice is marked; the X closes it without changing anything.
  await tap(page, rated);
  await expect(sheet.getByRole("option", { name: "7 / 10" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await sheet.getByTestId("touch-picker-close").click();
  await expect(sheet).toHaveCount(0);
  await expect(rated).toHaveValue("7");
});
