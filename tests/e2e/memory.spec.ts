import { expect, test, type Page } from "@playwright/test";

// Systems > Memory (the owner, 2026-11-02): where every GB goes, the quick win as one plan you
// approve, closing one app, and Ask Ember for the rest. Against a stand-in machine
// (DC_FAKE_MEMORY): nothing on the real machine is read for this or closed.

async function approve(page: Page, expectSummary: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(expectSummary);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(/Done/, { timeout: 20_000 });
  await expect(pop).not.toContainText("Not done");
  await pop.getByTestId("approve-here-close").click();
}

async function openMemory(page: Page) {
  await page.goto("/systems");
  const open = page.getByTestId("memory-open").first();
  await expect(open).toBeVisible({ timeout: 20_000 });
  if ((await open.getAttribute("aria-expanded")) !== "true") await open.click();
  const panel = page.getByTestId("memory-breakdown").first();
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

test("Memory: where every GB goes, the quick win in one approval, then closing an app", async ({
  page,
}) => {
  test.skip(test.info().project.name === "mobile", "Desk only (the stand-in machine changes).");
  const panel = await openMemory(page);
  const legend = panel.getByTestId("memory-legend");
  for (const label of ["Containers", "Hearth", "Apps", "System", "Cache", "Free"])
    await expect(legend).toContainText(label);
  const items = panel.getByTestId("memory-item");
  await expect(panel.locator('[data-item="app:google chrome"]')).toContainText("2 processes");
  await expect(panel.locator('[data-item="app:sshd"]')).toContainText("Stays: Networking");
  await expect(panel.locator('[data-item="container:proxy"]')).toContainText("Stays");
  expect(await items.count()).toBeGreaterThan(5);
  await page.screenshot({ path: "test-results/memory-breakdown.png", fullPage: true });

  // The quick win: Hearth's voice (the safe part), one plan.
  await expect(panel.getByTestId("memory-quick-win")).toContainText("Hearth voice");
  await panel.locator('[data-hearth-target="memory:quick-win"]').click();
  await approve(page, /Free up Hearth's voice memory/);
  await expect(panel.locator('[data-item="hearth-voice"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(panel.getByTestId("memory-quick-win")).toContainText("No quick win");

  // One app: closed the normal way, after approval.
  await panel.locator('[data-hearth-target="memory:stop:app:google chrome"]').click();
  await approve(page, /Close Google Chrome \(frees about 2\.0 GB\)/);
  await expect(panel.locator('[data-item="app:google chrome"]')).toHaveCount(0, {
    timeout: 30_000,
  });

  // The rest is Ember's call.
  await expect(panel.locator('[data-hearth-target="memory:ask"]')).toBeVisible();
});

test("Memory on a phone fits the screen", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "Phone only.");
  const panel = await openMemory(page);
  await expect(panel.getByTestId("memory-item").first()).toBeVisible();
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(wide).toBe(false);
});
