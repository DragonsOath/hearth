import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Syncthing from Hearth (APP_PANELS.md plan): a stand-in Syncthing (DC_FAKE_APPS, port 8384).
// Folders with progress and failures, machines online, and pausing a machine, confirmed here.

test("Syncthing panel: failing and syncing folders, machines; pause a machine", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.16`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Syncthing ${run}`,
      kind: "web",
      address: `http://${host}:8384`,
      category: "Files & Photos",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const sync = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "Syncthing test key",
      kind: "api-key",
      tier: "automation",
      // Diagnostics only, so the panel asks to allow changes first.
      scope: "read",
      serviceId: sync,
      value: "e2e-sync-key",
    },
  });
  try {
    await page.goto(`/?service=${sync}`);
    const panel = page.getByTestId("sync-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("sync-failing")).toHaveText("1");
    await expect(panel.getByTestId("sync-failed")).toContainText(
      "taxes/2025.pdf: permission denied",
    );
    await expect(
      panel
        .getByTestId("sync-folder")
        .filter({ hasText: "Phone photos" })
        .getByTestId("sync-state"),
    ).toHaveText("Syncing 80%");
    const laptop = panel.getByTestId("sync-device").filter({ hasText: "Laptop" });
    await expect(laptop.getByTestId("sync-device-state")).toHaveText("Offline");

    // The key was added for reading only, so the change is allowed first, then made.
    await laptop.getByTestId("sync-pause-device").click();
    await laptop.getByRole("button", { name: /Allow confirmed changes/ }).click();
    await expect(laptop.getByTestId("panel-allow-changes")).toContainText("Allowed");
    await laptop.getByTestId("sync-pause-device").click();
    const change = laptop.getByTestId("panel-change");
    await expect(change).toContainText("Pause syncing with Laptop");
    await change.getByTestId("panel-confirm").click();
    await expect(laptop.getByTestId("sync-device-state")).toHaveText("Paused", { timeout: 30_000 });

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
    await request.post(`/api/services/${sync}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
