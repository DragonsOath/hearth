import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Tautulli from Hearth (APP_PANELS.md plan): a stand-in Tautulli (DC_FAKE_APPS, port 8181).
// Who is watching and how, the week's tops, and stopping a stream, confirmed in the panel.

test("Tautulli panel: who is watching and why it converts; stop a stream with a message", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.10`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Home Tautulli ${run}`,
      kind: "web",
      address: `http://${host}:8181`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const tautulli = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "Tautulli test key",
      kind: "api-key",
      tier: "automation",
      // Diagnostics only, so the panel asks to allow changes first.
      scope: "read",
      serviceId: tautulli,
      value: "e2e-tautulli-key",
    },
  });
  try {
    await page.goto(`/?service=${tautulli}`);
    const panel = page.getByTestId("tautulli-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("tautulli-count")).toHaveText("2");
    const stream = (who: string) => panel.getByTestId("tautulli-stream").filter({ hasText: who });
    await expect(stream("Alex").getByTestId("tautulli-decision")).toHaveText("Direct play");
    await expect(stream("sam").getByTestId("tautulli-decision")).toHaveText("Converting");
    await expect(stream("sam").getByTestId("tautulli-why")).toHaveText(
      "Video converted from 4k to 720p (hevc to h264), on the graphics card.",
    );
    await expect(stream("sam")).toContainText("away from home");
    await expect(panel).toContainText("Most active this week");
    await expect(panel.getByTestId("tautulli-history")).toContainText("Severance - Woe's Hollow");

    // Stopping: the key was added for reading only, so the change is allowed first, then made.
    await stream("sam").getByTestId("tautulli-stop").click();
    await stream("sam")
      .getByPlaceholder("Message to show them (optional)")
      .fill("Server maintenance");
    await stream("sam").getByTestId("tautulli-stop-plan").click();
    await stream("sam")
      .getByRole("button", { name: /Allow confirmed changes/ })
      .click();
    await expect(stream("sam").getByTestId("panel-allow-changes")).toContainText("Allowed");
    await stream("sam").getByTestId("tautulli-stop").click();
    await stream("sam").getByTestId("tautulli-stop-plan").click();
    const change = stream("sam").getByTestId("panel-change");
    await expect(change).toContainText("Stop sam's stream of Dune: Part Two");
    await change.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("tautulli-count")).toHaveText("1", { timeout: 30_000 });

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
    await request.post(`/api/services/${tautulli}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
