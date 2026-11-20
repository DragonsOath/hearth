import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Prowlarr from Hearth (APP_PANELS.md plan): a stand-in Prowlarr (DC_FAKE_APPS, port 9696).
// Which indexers work and why not, testing one, and switching a failing one off.

test("Prowlarr panel: failing indexer first; test it, then switch it off", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.12`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Home Prowlarr ${run}`,
      kind: "web",
      address: `http://${host}:9696`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const prowlarr = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "Prowlarr test key",
      kind: "api-key",
      tier: "automation",
      // Diagnostics only, so the panel asks to allow changes first.
      scope: "read",
      serviceId: prowlarr,
      value: "e2e-prowlarr-key",
    },
  });
  try {
    await page.goto(`/?service=${prowlarr}`);
    const panel = page.getByTestId("prowlarr-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("prowlarr-failing")).toHaveText("1");
    const alpha = panel.getByTestId("prowlarr-indexer").first();
    await expect(alpha).toContainText("Torrent Alpha");
    await expect(alpha.getByTestId("prowlarr-why")).toContainText("Prowlarr paused it");
    await expect(panel.getByTestId("prowlarr-apps")).toContainText("Radarr");

    // Testing: the key was added for reading only, so the change is allowed first, then made.
    await alpha.getByTestId("prowlarr-test").click();
    await alpha.getByRole("button", { name: /Allow confirmed changes/ }).click();
    await expect(alpha.getByTestId("panel-allow-changes")).toContainText("Allowed");
    await alpha.getByTestId("prowlarr-test").click();
    const test1 = alpha.getByTestId("panel-change");
    await expect(test1).toContainText("Test Torrent Alpha");
    await test1.getByTestId("panel-confirm").click();
    await expect(alpha).toContainText("Blocked by CloudFlare Protection", { timeout: 20_000 });

    await alpha.getByTestId("prowlarr-disable").click();
    const off = alpha.getByTestId("panel-change");
    await expect(off).toContainText("Turn Torrent Alpha off");
    await off.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("prowlarr-failing")).toHaveText("0", { timeout: 40_000 });

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
    await request.post(`/api/services/${prowlarr}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
