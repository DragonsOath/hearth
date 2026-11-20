import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Bazarr from Hearth (APP_PANELS.md plan): a stand-in Bazarr (DC_FAKE_APPS, port 6767).
// What is missing subtitles, throttled providers, and searching one movie, confirmed in the panel.

test("Bazarr panel: missing subtitles and providers; search one movie", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.13`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Home Bazarr ${run}`,
      kind: "web",
      address: `http://${host}:6767`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const bazarr = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "Bazarr test key",
      kind: "api-key",
      tier: "automation",
      // Diagnostics only, so the panel asks to allow changes first.
      scope: "read",
      serviceId: bazarr,
      value: "e2e-bazarr-key",
    },
  });
  try {
    await page.goto(`/?service=${bazarr}`);
    const panel = page.getByTestId("bazarr-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("bazarr-movies")).toHaveText("2");
    await expect(panel.getByTestId("bazarr-throttled")).toHaveText("1");
    await expect(panel.getByTestId("bazarr-providers")).toContainText(
      "TooManyRequests, tries again in 2 hours",
    );
    const arrival = panel.getByTestId("bazarr-wanted").filter({ hasText: "Arrival" });
    await expect(arrival).toContainText("English");

    // Searching: the key was added for reading only, so the change is allowed first, then made.
    await arrival.getByTestId("bazarr-search").click();
    await arrival.getByRole("button", { name: /Allow confirmed changes/ }).click();
    await expect(arrival.getByTestId("panel-allow-changes")).toContainText("Allowed");
    await arrival.getByTestId("bazarr-search").click();
    const change = arrival.getByTestId("panel-change");
    await expect(change).toContainText("Search subtitles for Arrival (English)");
    await change.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("bazarr-movies")).toHaveText("1", { timeout: 40_000 });

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
    await request.post(`/api/services/${bazarr}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
