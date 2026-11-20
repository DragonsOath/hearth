import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// SABnzbd from Hearth (APP_PANELS.md plan): a stand-in SABnzbd (DC_FAKE_APPS, port 8080).
// The queue, why a download failed, and pausing and retrying, confirmed in the panel.

test("SABnzbd panel: queue and failures; pause all and retry a failed job", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.11`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Home SABnzbd ${run}`,
      kind: "web",
      address: `http://${host}:8080`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const sab = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "SABnzbd test key",
      kind: "api-key",
      tier: "automation",
      // Diagnostics only, so the panel asks to allow changes first.
      scope: "read",
      serviceId: sab,
      value: "e2e-sab-key",
    },
  });
  try {
    await page.goto(`/?service=${sab}`);
    const panel = page.getByTestId("sab-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("sab-status")).toHaveText("Downloading");
    // A long status word stays inside its tile, even in a narrow panel (10-26).
    const size = page.viewportSize()!;
    for (const width of [1280, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const spill = await panel.evaluate((el) =>
        [...el.querySelectorAll(".stat-value")].map((v) => {
          const tile = v.closest(".stat-tile")!.getBoundingClientRect();
          const r = v.getBoundingClientRect();
          return Math.max(0, r.right - tile.right, v.scrollWidth - v.clientWidth);
        }),
      );
      expect(Math.max(...spill), `at ${width}px`).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize(size);
    // What needs you is on Overview; everything is managed in the Downloads tab.
    await expect(panel.getByTestId("sab-needs-you")).toContainText("Dune.Part.Two");
    await panel.getByTestId("sab-all").click();
    const downloads = page.getByTestId("sab-downloads");
    await expect(downloads.getByTestId("sab-job")).toHaveCount(3, { timeout: 15_000 });
    const failed = downloads.getByTestId("sab-done").filter({ hasText: "Dune.Part.Two" });
    await expect(failed.getByTestId("sab-why")).toHaveText(
      "Repair failed, not enough repair blocks (412 short)",
    );

    // Pause all: the key was added for reading only, so the change is allowed first, then made.
    await downloads.getByTestId("sab-pause-all").click();
    await downloads.getByRole("button", { name: /Allow confirmed changes/ }).click();
    await expect(downloads.getByTestId("panel-allow-changes")).toContainText("Allowed");
    await downloads.getByTestId("sab-pause-all").click();
    const change = downloads.getByTestId("panel-change").first();
    await expect(change).toContainText("Pause all downloads in");
    await change.getByTestId("panel-confirm").click();
    await expect(downloads.getByTestId("sab-downloads-status")).toHaveText("Paused", {
      timeout: 20_000,
    });

    // Retry the failed job: it moves back into the queue.
    await failed.getByTestId("sab-retry").click();
    const retry = failed.getByTestId("panel-change");
    await expect(retry).toContainText("Retry Dune.Part.Two.2024.2160p");
    await retry.getByTestId("panel-confirm").click();
    await expect(downloads.getByTestId("sab-job")).toHaveCount(4, { timeout: 20_000 });

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
    await request.post(`/api/services/${sab}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

test("SABnzbd panel: speed limit, a job's priority and its place in the queue", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desk only.");
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.14`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `SABnzbd ${run}`,
      kind: "web",
      address: `http://${host}:8080`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const sab = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "SABnzbd controls key",
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: sab,
      value: "e2e-sab-key",
    },
  });
  try {
    await page.goto(`/?service=${sab}`);
    const panel = page.getByTestId("sab-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const confirm = async (where: ReturnType<typeof panel.getByTestId>, text: RegExp) => {
      const change = where.getByTestId("panel-change").first();
      await expect(change).toContainText(text);
      await change.getByTestId("panel-confirm").click();
      await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 20_000 });
    };

    await panel.locator('[data-hearth-target="sab:speed-limit"]').selectOption("50");
    await confirm(panel, /Limit downloads to 50% of the line speed/);
    await expect(panel.locator('[data-hearth-target="sab:speed-limit"]')).toHaveValue("50");

    // A download's own controls: open it in the Downloads tab.
    await panel.getByTestId("sab-all").click();
    const downloads = page.getByTestId("sab-downloads");
    const last = downloads.getByTestId("sab-job").filter({ hasText: "Nosferatu" });
    await last
      .getByRole("button", { name: /Nosferatu/ })
      .first()
      .click();
    await last.locator('[data-hearth-target="job:priority"]').selectOption("high");
    await confirm(last, /Give Nosferatu.1922.Restored.1080p high priority/);
    await last.locator('[data-hearth-target="job:top"]').click();
    await confirm(last, /Move Nosferatu.1922.Restored.1080p to place 1 of 3/);
    await expect(downloads.getByTestId("sab-job").first()).toContainText("Nosferatu", {
      timeout: 15_000,
    });
  } finally {
    await request.post(`/api/services/${sab}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
  }
});
