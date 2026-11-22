import { expect, test } from "@playwright/test";

// The Lair with nothing open (11-22, the owner: "if I open the lair and there are no open panels
// have ember open to full screen. But there should still be the panel selector on the top if you
// select a panel to open then it goes to that split panels in lair").

test("an empty Lair is Ember across the whole space; picking a system splits it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the Lair is a desktop workspace");
  await page.goto("/?panels=");
  const desk = page.getByTestId("desk");
  await expect(desk).toHaveAttribute("data-empty", "true", { timeout: 15_000 });
  const strip = page.getByTestId("lair-systems");
  await expect(strip).toBeVisible();
  const dock = page.getByTestId("desk-dock");
  // Ember takes the full width, below the systems.
  const d = (await desk.boundingBox())!;
  const e = (await dock.boundingBox())!;
  expect(e.width).toBeGreaterThan(d.width - 4);
  expect(e.y).toBeGreaterThan((await strip.boundingBox())!.y);
  await expect(page.getByTestId("lair-start")).toHaveCount(0);
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/lair-empty.png` });

  // Turn a system on: Ember beside its panel.
  const chip = strip.locator('[aria-pressed="false"]:not([data-testid="lair-storage"])').first();
  const name = (await chip.getAttribute("aria-label"))!;
  await chip.click();
  await expect(page.getByRole("region", { name: `Service: ${name}` })).toBeVisible();
  await expect(desk).not.toHaveAttribute("data-empty", "true");
  expect((await dock.boundingBox())!.width).toBeLessThan(d.width * 0.7);

  // Close that last panel with its own X: still the Lair, Ember full again (not Home).
  await page
    .getByRole("button", { name: `Close ${name}` })
    .first()
    .click();
  await expect(desk).toHaveAttribute("data-empty", "true");
  await expect(page).toHaveURL(/[?&]panels=/);
  await expect(strip).toBeVisible();
});
