import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Phase 0 of docs/design/AGENT_NEEDS_PLAN.md: homelab rules, long work, and memory freshness.
// Tests share one server and database (see playwright.config.ts), so each cleans up after itself.
test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  expect(res.status(), "reset demo scenario").toBe(204);
});

async function seriousViolations(page: Page) {
  await page.waitForTimeout(300);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test("homelab rules: a do-not-touch system and a reserved time are added and removed in Settings", async ({
  page,
}, testInfo) => {
  const clear = () =>
    page.request.put("/api/settings/rules", { data: { doNotTouch: [], reservations: [] } });
  await clear();
  await page.goto("/settings#cave");
  const rules = page.getByTestId("homelab-rules");
  await expect(rules.getByText("Nothing on the list.")).toBeVisible();

  await rules.getByLabel("System", { exact: true }).selectOption({ label: "Jellyfin" });
  await rules.getByLabel("Why (optional)", { exact: true }).fill("I manage this myself");
  await rules.getByRole("button", { name: "Add", exact: true }).click();
  const list = rules.getByRole("list", { name: "Do-not-touch list" });
  await expect(list).toContainText("Jellyfin");
  await expect(list).toContainText("I manage this myself");

  await rules.getByLabel("Machine", { exact: true }).fill("Gaming-PC");
  await rules.getByLabel("What", { exact: true }).selectOption({ label: "The GPU" });
  await rules.getByLabel("From", { exact: true }).fill("19:00");
  await rules.getByLabel("Until", { exact: true }).fill("23:00");
  await rules.getByRole("button", { name: "Fri" }).click();
  await rules.getByLabel("Note (optional)", { exact: true }).fill("gaming");
  await rules.getByRole("button", { name: "Add reserved time" }).click();
  await expect(rules.getByRole("list", { name: "Reserved times" })).toContainText(
    "The GPU on Gaming-PC, 7 PM to 11 PM Fri (gaming)",
  );

  expect(await seriousViolations(page)).toEqual([]);
  await rules.screenshot({
    path: `test-results/screens/${testInfo.project.name}/homelab-rules.png`,
  });

  // It sticks after a reload, then both come off again.
  await page.reload();
  await expect(list).toContainText("Jellyfin");
  await rules.getByRole("button", { name: "Remove Jellyfin from the do-not-touch list" }).click();
  await expect(rules.getByText("Nothing on the list.")).toBeVisible();
  await rules.getByRole("button", { name: /Remove the reservation/ }).click();
  await expect(rules.getByText("No reserved times.")).toBeVisible();
  await clear();
});

test("long work reported from a machine shows on Jobs with its progress", async ({
  page,
}, testInfo) => {
  // Unique per run: finished work stays listed for two days in the shared database.
  const title = `Voice training (${testInfo.project.name} ${Date.now()})`;
  const started = await page.request.post("/api/work", {
    data: { title, machine: "Gaming-PC", progress: 40 },
  });
  expect(started.status()).toBe(201);
  const { id } = (await started.json()) as { id: string };
  await page.request.post(`/api/work/${id}`, {
    data: { progress: 55, detail: "operator: 557 of 1012" },
  });

  await page.goto("/jobs");
  const panel = page.getByTestId("long-work");
  const row = panel.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Gaming-PC");
  await expect(row).toContainText("55%");
  await expect(row).toContainText("operator: 557 of 1012");
  await expect(row.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "55");
  await expect(row).toContainText("Running");
  expect(await seriousViolations(page)).toEqual([]);
  await panel.screenshot({ path: `test-results/screens/${testInfo.project.name}/long-work.png` });

  await page.request.post(`/api/work/${id}`, { data: { status: "done", progress: 100 } });
  await page.reload();
  await expect(row).toContainText("Finished");
});

test("a setup fact not checked for a while is marked as possibly out of date", async ({ page }) => {
  const created = await page.request.post("/api/memory/entries", {
    data: {
      kind: "note",
      title: "E2E: the microphone is shared to Homeserver",
      body: "Over VirtualHere.",
      happenedAt: "2026-01-01",
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  try {
    await page.goto("/memory");
    const item = page
      .getByRole("listitem")
      .filter({ hasText: "E2E: the microphone is shared to Homeserver" });
    await expect(item).toContainText("May be out of date");
    await item.getByRole("button").first().click();
    await expect(page.getByText(/Last checked \d+ days ago, may be out of date/)).toBeVisible();
  } finally {
    await page.request.delete(`/api/memory/entries/${id}`);
  }
});
