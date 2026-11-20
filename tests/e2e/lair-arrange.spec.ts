import { expect, test } from "@playwright/test";

// The Lair's row of systems in the order you choose (the Arrange box, kept in this
// browser), and writing help's corrections readable at a glance.

test("Arrange: drag a system to the front in the box, Done puts it on the bar, and it stays after a reload", async ({
  page,
}) => {
  await page.request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  // The order and counts are kept on Hearth (11-16): start from none.
  await page.request.patch("/api/settings", { data: { lairOrder: null, lairUsage: null } });
  await page.goto("/settings");
  await page.getByTestId("lair-button").click();
  const strip = page.getByTestId("lair-systems");
  await expect(strip.locator("button").first()).toBeVisible({ timeout: 20_000 });
  const firstOnBar = () => strip.locator("button").first().getAttribute("aria-label");

  await page.getByTestId("lair-arrange").click();
  const dialog = page.getByRole("dialog", { name: "Arrange the systems" });
  await expect(dialog).toBeVisible();
  const items = dialog.getByTestId("lair-arrange-item");
  const third = await items.nth(2).locator("span").last().innerText();
  const thirdKey = (await items.nth(2).getAttribute("data-key"))!;

  // Drag the third one by its handle up above the first.
  const handle = items.nth(2).getByTestId("lair-arrange-handle");
  const from = (await handle.boundingBox())!;
  const to = (await items.first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 8 });
  await page.mouse.up();
  await expect(items.first()).toHaveAttribute("data-key", thirdKey);
  // The arrow keys on a handle move it too.
  await items.first().getByTestId("lair-arrange-handle").press("ArrowDown");
  await expect(items.nth(1)).toHaveAttribute("data-key", thirdKey);
  await items.nth(1).getByTestId("lair-arrange-handle").press("ArrowUp");
  await expect(items.first()).toHaveAttribute("data-key", thirdKey);
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/lair-arrange.png`,
  });
  await dialog.getByTestId("lair-arrange-done").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(firstOnBar).toBe(third);

  // Cancel leaves the bar alone.
  await page.getByTestId("lair-arrange").click();
  await dialog.getByTestId("lair-arrange-reset").click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(firstOnBar).toBe(third);

  await page.reload();
  await expect.poll(firstOnBar, { timeout: 20_000 }).toBe(third);
  // Most used first, then Done, goes back to the automatic order.
  await page.getByTestId("lair-arrange").click();
  await dialog.getByTestId("lair-arrange-reset").click();
  await dialog.getByTestId("lair-arrange-done").click();
  expect(await page.evaluate(() => localStorage.getItem("hearth-lair-order"))).toBeNull();
});

test("Writing help's corrections are easy to read", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("dc-writing-assist", "basic"));
  await page.goto("/ask");
  const box = page.getByLabel("Ask Ember");
  await box.click();
  await page.keyboard.type("i think teh disk is full. ");
  const fixed = page.getByTestId("cave-corrections");
  await expect(fixed).toContainText("teh → the");
  // On a solid strip, in the theme's main text color, not faint text over the panel's art.
  const look = await fixed.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, size: parseFloat(s.fontSize) };
  });
  expect(look.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(look.size).toBeGreaterThanOrEqual(13);
  await fixed.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/screens/desktop/writing-help.png" });
});

test("The order is kept on Hearth: a phone shows the systems in the desktop's order, and a phone can have its own look", async ({
  page,
  browser,
}) => {
  // 11-16, the owner: "the panels on mobile should be in the same order as the ones on the
  // desktop", and "have your mobile layout in a different scheme".
  test.skip(test.info().project.name !== "desktop", "Desktop and a phone together, once.");
  test.setTimeout(120_000);
  await page.request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  const ws = (await (await page.request.get("/api/workspace")).json()) as {
    services: { id: string; name: string }[];
  };
  const picked = [...ws.services].sort((a, b) => b.name.localeCompare(a.name)).slice(0, 3);
  expect(picked.length).toBe(3);

  // Arranged on the desktop (the Arrange box saves it to Hearth).
  await page.goto("/settings");
  await page.getByTestId("lair-button").click();
  const strip = page.getByTestId("lair-systems");
  await expect(strip.locator("button").first()).toBeVisible({ timeout: 20_000 });
  const res = await page.request.patch("/api/settings", {
    data: { lairOrder: picked.map((s) => `service:${s.id}`) },
  });
  expect(res.status()).toBe(204);
  await page.reload();
  await expect
    .poll(() => strip.locator("button").first().getAttribute("aria-label"), { timeout: 20_000 })
    .toBe(picked[0]!.name);

  // A phone, signed in as the same owner, with nothing kept in its own browser.
  const { devices } = await import("@playwright/test");
  const phone = await browser.newContext({
    ...devices["Pixel 7"],
    storageState: test.info().project.use.storageState as string,
    baseURL: test.info().project.use.baseURL,
  });
  const p = await phone.newPage();
  try {
    await p.goto("/");
    await p.getByTestId("phone-panels-toggle").click();
    const list = p.getByTestId("phone-panels").getByTestId("lair-systems").locator("button");
    await expect(list.first()).toBeVisible({ timeout: 20_000 });
    for (const [i, s] of picked.entries())
      await expect(list.nth(i)).toHaveAttribute("aria-label", s.name);

    // Phones' own look: Dragonfire on the phone, while the desktop keeps its theme.
    await p.goto("/settings");
    const target = p.getByTestId("theme-target");
    await expect(target.getByRole("radio", { name: /Desktop/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await target.getByRole("radio", { name: /Phone/ }).click();
    await expect(p.getByTestId("theme-phone-same")).toBeVisible();
    await p
      .getByTestId("theme-picker")
      .getByRole("radio", { name: /Dragonfire/ })
      .click();
    const gold = (pg: typeof p) =>
      pg.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-gold").trim(),
      );
    await expect.poll(() => gold(p)).toBe("#e2553f");
    await expect
      .poll(
        async () =>
          (
            (await (await p.request.get("/api/workspace")).json()) as {
              phoneTheme?: { preset: string };
            }
          ).phoneTheme?.preset,
      )
      .toBe("ember");
    await page.reload();
    await expect.poll(() => gold(page)).not.toBe("#e2553f");
    // Back to the desktop's look on phones.
    await p.getByTestId("theme-phone-reset").click();
    await expect.poll(() => gold(p)).not.toBe("#e2553f");
  } finally {
    await page.request.patch("/api/settings", { data: { lairOrder: null, phoneTheme: null } });
    await phone.close().catch(() => undefined);
  }
});
