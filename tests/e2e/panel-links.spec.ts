import { expect, test } from "@playwright/test";

// Opening the same panel link again (a bookmark, a link in a message, the address bar) reuses
// the workspace group that already has exactly those panels, instead of leaving a new copy of it
// in the workspace dock each time.

test.describe("panel links", () => {
  test.skip(({ isMobile }) => isMobile, "The desk (side-by-side panels) is desktop only.");

  test("opening the same panel link three times keeps one workspace", async ({ page }) => {
    const run = `${Date.now() % 100000}`;
    const name = `Link Check ${run}`;
    const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.7`;
    const res = await page.request.post("/api/services", {
      data: { name, kind: "web", address: `http://${host}:8099`, category: "System" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const link = `/?panels=${encodeURIComponent(`service:${id}`)}`;
    const pills = page.getByTestId("workspace-pill").filter({ hasText: name });
    try {
      for (let i = 0; i < 3; i++) {
        await page.goto(link);
        const panel = page.locator(`[data-panel="service:${id}"]`);
        await expect(panel).toBeVisible();
        // A basic panel shows the app itself first (11-14); Hearth's own panel is Hearth view.
        await panel.getByTestId("app-view-hearth").click({ timeout: 20_000 });
        // The generic service panel names the AI as it is called now.
        await expect(panel).toContainText("Ask Ember what is in it");
        await expect(panel).not.toContainText("Warden");
        // The open group is on screen, so it has no pill of its own while it is open.
        await expect(pills).toHaveCount(0);
        // Let the group save, as it does while you work.
        await page.waitForTimeout(900);
      }
      // Leaving the command center minimizes the group: exactly one pill for it.
      await page.goto("/backups");
      await expect(pills).toHaveCount(1);
      const groups = (await (await page.request.get("/api/desk/groups")).json()) as {
        id: string;
        name: string;
      }[];
      expect(groups.filter((g) => g.name.includes(name))).toHaveLength(1);
    } finally {
      const groups = (await (await page.request.get("/api/desk/groups")).json()) as {
        id: string;
        name: string;
      }[];
      for (const g of groups.filter((g) => g.name.includes(name)))
        await page.request.delete(`/api/desk/groups/${encodeURIComponent(g.id)}`);
      await page.request.post(`/api/services/${id}/remove`, { data: {} });
    }
  });
});
