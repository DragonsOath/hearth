import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Home Assistant from Hearth (APP_PANELS.md plan): a stand-in Home Assistant (DC_FAKE_APPS,
// port 8123). Automations, switches, a failing integration, and toggling a light, confirmed.

test("Home Assistant panel: automations and switches; turn a light on; reload an integration", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.14`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const ha = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "HA test token",
      kind: "api-key",
      tier: "automation",
      // Diagnostics only, so the panel asks to allow changes first.
      scope: "read",
      serviceId: ha,
      value: "e2e-ha-token",
    },
  });
  try {
    await page.goto(`/?service=${ha}`);
    // The panel opens on Home (11-07); Overview is the next tab.
    await page.getByRole("tab", { name: "Overview" }).first().click();
    const panel = page.getByTestId("ha-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("ha-failing")).toHaveText("1");
    const routines = panel.getByTestId("ha-routines");
    await expect(routines.getByTestId("ha-routine")).toHaveCount(7);
    await expect(panel.getByTestId("ha-unavailable")).toContainText("Garage temperature");
    await expect(panel).not.toContainText("Front door");

    const light = panel.getByTestId("ha-switch").filter({ hasText: "Living room" });
    await expect(light.getByTestId("ha-state")).toHaveText("Off");
    // The token was added for reading only, so the change is allowed first, then made.
    await light.getByTestId("ha-toggle").click();
    await light.getByRole("button", { name: /Allow confirmed changes/ }).click();
    await expect(light.getByTestId("panel-allow-changes")).toContainText("Allowed");
    await light.getByTestId("ha-toggle").click();
    const change = light.getByTestId("panel-change");
    await expect(change).toContainText("Turn on Living room");
    await change.getByTestId("panel-confirm").click();
    await expect(light.getByTestId("ha-state")).toHaveText("On", { timeout: 30_000 });

    // Routines and automations: filter, find, and run one on a single press (10-26).
    await routines.getByRole("button", { name: /^Automations/ }).click();
    await expect(routines.getByTestId("ha-routine")).toHaveCount(2);
    await routines.getByRole("button", { name: /^All/ }).click();
    await routines.getByTestId("ha-routine-find").fill("good");
    await expect(routines.getByTestId("ha-routine")).toHaveCount(2);
    const night = routines.getByTestId("ha-routine").filter({ hasText: "Goodnight" });
    await night.getByTestId("ha-run").click();
    await expect(night.getByTestId("ha-run-done")).toContainText(
      "Home Assistant ran Goodnight at",
      {
        timeout: 30_000,
      },
    );
    await night.getByTestId("ha-details").click();
    const detail = night.getByTestId("ha-detail");
    await expect(detail).toContainText("Turn on Kitchen (50%, red)");
    await expect(detail.getByTestId("ha-runs")).toContainText("Finished");

    // One that locks a door waits for an OK, and says why; it is not run here.
    await routines.getByTestId("ha-routine-find").fill("leaving");
    const leaving = routines.getByTestId("ha-routine").filter({ hasText: "Leaving home" });
    await leaving.getByTestId("ha-run").click();
    const ask = leaving.getByTestId("panel-change");
    await expect(ask).toContainText("Look first: it locks or unlocks doors");
    await ask.getByRole("button", { name: "Cancel" }).click();

    // An automation switches off, and the list shows it.
    await routines.getByTestId("ha-routine-find").fill("porch");
    const porch = routines.getByTestId("ha-routine").filter({ hasText: "Porch lights" });
    await expect(porch.getByTestId("ha-routine-status")).toHaveText("Runs by itself");
    await porch.getByTestId("ha-switch-off").click();
    await expect(porch.getByTestId("ha-routine-status")).toHaveText("Switched off", {
      timeout: 30_000,
    });

    const zigbee = panel.getByTestId("ha-integration").first();
    await zigbee.getByTestId("ha-reload-integration").click();
    await zigbee.getByTestId("panel-change").getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("ha-failing")).toHaveText("0", { timeout: 30_000 });

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
    await request.post(`/api/services/${ha}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
