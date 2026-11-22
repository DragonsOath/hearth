import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Jellyfin from Hearth (APP_PANELS.md plan): a stand-in Jellyfin (DC_FAKE_APPS, port 8096).
// No key yet: the panel asks for one, it is pasted, and the panel reads; then a stream is stopped.

test("Jellyfin panel: paste a key, see who is watching and why it converts, stop a stream", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.19`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Jellyfin ${run}`,
      kind: "web",
      address: `http://${host}:8096`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const jf = ((await res.json()) as { id: string }).id;
  try {
    // Overview: Jellyfin's panel opens on Home (11-21), and this is about Overview.
    await page.goto(`/?panels=${encodeURIComponent(`service:${jf}@overview`)}`);
    const ask = page.getByTestId("needs-key");
    await expect(ask).toBeVisible({ timeout: 20_000 });
    await expect(ask).toContainText("Dashboard, then API Keys");
    await ask.getByTestId("paste-key").fill("e2e-jf-key");
    await ask.getByTestId("paste-key-save").click();

    const panel = page.getByTestId("jf-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("jf-count")).toHaveText("2");
    // A failed scheduled task is flagged on the Overview; the tasks themselves have their tab.
    await expect(panel.getByTestId("jf-failed")).toContainText("failed");
    await expect(panel.getByTestId("jf-failed")).toContainText("Tasks tab");
    await expect(panel.getByTestId("jf-task")).toHaveCount(0);
    // Like Plex: each library says what is in it, and what was just added shows its poster.
    await expect(
      panel.getByTestId("jf-library").filter({ hasText: "Movies" }).getByTestId("jf-library-size"),
    ).toHaveText("812 movies");
    await expect(
      panel.getByTestId("jf-library").filter({ hasText: "Shows" }).getByTestId("jf-library-size"),
    ).toHaveText("140 shows · 6,123 episodes");
    const recent = panel.getByTestId("jf-recent").getByRole("listitem").first();
    await expect(recent).toContainText("Anora (2024)");
    const poster = recent.locator("img");
    await expect(poster).toHaveAttribute("src", /dashboard\/jellyfin-poster\?item=anora/);
    await expect
      .poll(() => poster.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0);
    const sam = panel.getByTestId("jf-stream").filter({ hasText: "sam" });
    await expect(sam.getByTestId("jf-decision")).toHaveText("Converting");
    await expect(sam.getByTestId("jf-why")).toContainText("cannot play the video format");

    // A pasted key is allowed for confirmed changes, so stopping goes straight to the confirmation.
    await sam.getByTestId("jf-stop").click();
    await sam.getByTestId("jf-stop-plan").click();
    const change = sam.getByTestId("panel-change");
    await expect(change).toContainText("Stop sam's stream of Dune: Part Two (2024)");
    await change.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("jf-count")).toHaveText("1", { timeout: 30_000 });

    // The big Scan libraries button at the top: one press and Jellyfin is scanning, no detour.
    const scan = panel.getByTestId("jf-scan-libraries");
    await scan.getByTestId("jf-scan-libraries-button").click();
    await expect(scan.getByTestId("jf-scan-libraries-done")).toHaveText(
      // The server's own name (11-08: the panel is shared with Emby).
      `Jellyfin ${run} is scanning all libraries.`,
      { timeout: 20_000 },
    );
    // Still on Jellyfin's panel (its address, in either form).
    await expect(page).toHaveURL(new RegExp(`service(=|%3A)${jf}`));

    // Turn off a scheduled task that eats the processor (Trickplay): it stops and stays off.
    await page.getByRole("tab", { name: "Tasks", exact: true }).click();
    const tasks = page.getByTestId("jf-tasks");
    await expect(tasks).toBeVisible();
    const trick = tasks.getByTestId("jf-task").filter({ hasText: "Generate Trickplay Images" });
    await expect(trick).toContainText("running now");
    await trick.getByTestId("jf-task-off").click();
    const off = trick.getByTestId("panel-change");
    await expect(off).toContainText('Generate Trickplay Images" and stop it now');
    await off.getByTestId("panel-confirm").click();
    await expect(trick).toContainText("off, runs only when started", { timeout: 20_000 });
    await expect(trick.getByTestId("jf-task-on")).toBeVisible();

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
    await request.post(`/api/services/${jf}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
