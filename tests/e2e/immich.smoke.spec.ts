import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Immich from Hearth (APP_PANELS.md plan): a stand-in Immich v3 (DC_FAKE_APPS, port 2283).
// No key yet: the panel asks for one, it is pasted, the panel reads; failed face jobs are cleared.

test("Immich panel: paste a key, see photos, storage and queues; clear failed jobs", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.20`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Immich ${run}`,
      kind: "web",
      address: `http://${host}:2283`,
      category: "Files & Photos",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const im = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${im}`);
    const ask = page.getByTestId("needs-key");
    await expect(ask).toBeVisible({ timeout: 20_000 });
    await expect(ask).toContainText("API Keys");
    await ask.getByTestId("paste-key").fill("e2e-im-key");
    await ask.getByTestId("paste-key-save").click();

    const panel = page.getByTestId("im-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("im-photos")).toHaveText("48,210");
    await expect(panel.getByTestId("im-failed")).toHaveText("7");
    await expect(panel.getByTestId("im-people")).toContainText("112 GB of 200 GB");
    // The newest 20 photos, as thumbnails fetched through Hearth.
    const recent = panel.getByTestId("im-recent").getByTestId("im-photo");
    await expect(recent).toHaveCount(20);
    const first = recent.first().locator("img");
    await expect(first).toHaveAttribute("alt", /^IMG_4100\.jpg/);
    await expect
      .poll(() => first.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    // They scroll up and down in their own box, never sideways.
    const box = panel.getByTestId("im-recent-list");
    const sizes = await box.evaluate((el) => ({
      tall: el.scrollHeight > el.clientHeight,
      wide: el.scrollWidth > el.clientWidth,
    }));
    expect(sizes).toEqual({ tall: true, wide: false });
    await panel.getByTestId("im-recent").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name === "mobile" ? "mobile" : "desktop"}/immich-recent.png`,
    });
    const faces = panel.getByTestId("im-queue").filter({ hasText: "Finding faces" });
    await faces.getByTestId("im-clear").click();
    const change = faces.getByTestId("panel-change");
    await expect(change).toContainText("Clear 7 failed finding faces jobs");
    await change.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("im-failed")).toHaveText("0", { timeout: 30_000 });

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      axe.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => v.id),
    ).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await request.post(`/api/services/${im}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
