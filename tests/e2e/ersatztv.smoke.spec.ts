import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// ErsatzTV from Hearth (APP_PANELS.md plan): a stand-in ErsatzTV (DC_FAKE_APPS, port 8409).
// No key at all: the panel reads straight away; a channel's stream is stopped, confirmed here.

test("ErsatzTV panel: channels with now and next; stop a channel's stream", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.23`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `ErsatzTV ${run}`,
      kind: "web",
      address: `http://${host}:8409`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const etv = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${etv}`);
    const panel = page.getByTestId("etv-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("etv-channel")).toHaveCount(3);
    const one = panel.getByTestId("etv-channel").filter({ hasText: "Home Network TV" });
    await expect(one.getByTestId("etv-now")).toContainText("The Expanse: Dulcinea");
    await expect(
      panel.getByTestId("etv-channel").filter({ hasText: "Sci-Fi" }).getByTestId("etv-now"),
    ).toHaveText("Nothing scheduled right now");

    await one.getByTestId("etv-stop").click();
    const change = one.getByTestId("panel-change");
    await expect(change).toContainText("Stop the stream of channel 1");
    await change.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("etv-streams")).toHaveText("0", { timeout: 30_000 });

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
    await request.post(`/api/services/${etv}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
