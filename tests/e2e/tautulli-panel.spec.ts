import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels (46.10p): Tautulli's History, People, Libraries, Graphs and System tabs against the
// stand-in Tautulli (port 8181). Every change goes through the real plan, approval, re-reading and
// read-back code.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.25`;
};

async function addTautulli(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Tautulli ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8181`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Tautulli ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-tautulli-panel-key",
    },
  });
  return id;
}

async function open(page: Page, id: string, tab: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@${tab}`)}`);
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function approve(page: Page, expectSummary: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(expectSummary);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(/Done/, { timeout: 20_000 });
  await expect(pop).not.toContainText("Not done");
  await pop.getByTestId("approve-here-close").click();
}

test.describe("the native Tautulli panel", () => {
  test.describe.configure({ mode: "serial" });
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addTautulli(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("History: filter by person, then delete two play records", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "plays");
    const plays = panel.getByTestId("tt-play");
    await expect(plays).toHaveCount(5, { timeout: 20_000 });
    await panel.locator('[data-hearth-target="history:person"]').selectOption({ label: "sam" });
    await expect(plays).toHaveCount(2);
    await panel.locator('[data-hearth-target="history:pick:4"]').check();
    await panel.locator('[data-hearth-target="history:pick:1"]').check();
    await panel.locator('[data-hearth-target="history:delete"]').click();
    await approve(page, /sam: Dune: Part Two[\s\S]*Cannot be undone/);
    await expect(panel.getByText("Nothing matches.")).toBeVisible({ timeout: 20_000 });
  });

  test("People: rename someone and stop recording their plays", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "people");
    await expect(panel.getByTestId("tt-person-row")).toHaveCount(3, { timeout: 20_000 });
    await panel.locator('[data-hearth-target="person:1:open"]').click();
    const person = panel.getByTestId("tt-person");
    await expect(person.getByTestId("tt-watch-time")).toContainText("All time");
    await person.locator('[data-hearth-target="person:name"]').fill("Alex P");
    await person.locator('[data-hearth-target="person:rename"]').click();
    await approve(page, /Alex P/);
    await expect(person.getByRole("heading", { name: "Alex P" })).toBeVisible({ timeout: 20_000 });
    await person.locator('[data-hearth-target="person:history"]').click();
    await approve(page, /Record their plays/);
    await expect(person).toContainText("Their plays are not recorded.", { timeout: 20_000 });
  });

  test("Libraries, Graphs and System: stop recording a library, a chart, a log without keys", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    let panel = await open(page, id, "libraries");
    const movies = panel.getByTestId("tt-library").filter({ hasText: "Movies" });
    await expect(movies).toContainText("812 items", { timeout: 20_000 });
    await panel.locator('[data-hearth-target="library:1:history"]').click();
    await approve(page, /Movies/);
    await expect(movies).toContainText("plays not recorded", { timeout: 20_000 });

    panel = await open(page, id, "graphs");
    await expect(panel.getByTestId("tt-graph")).toBeVisible({ timeout: 20_000 });
    await panel.locator('[data-hearth-target="graphs:7"]').click();
    await expect(panel.getByRole("table")).toContainText("Movies");
    await expect(panel.locator("table tbody tr")).toHaveCount(7);

    panel = await open(page, id, "system");
    const log = panel.getByTestId("tt-log");
    await expect(log).toContainText("Unable to refresh users list", { timeout: 20_000 });
    expect((await log.textContent())?.includes("0123456789abcdef0123456789abcdef")).toBe(false);
    await panel.locator('[data-hearth-target="system:backup"]').click();
    await approve(page, /Back up/);
  });
});
