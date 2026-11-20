import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels Phase 3: Sonarr's own tabs against the stand-in Sonarr 4 (port 8990). Every
// change goes through the real plan, approval, re-reading and read-back code. Activity, Settings
// and System are the Radarr panel's tabs, shared, reading Sonarr.

/** A test address no earlier service in this run has (Hearth refuses a second one). */
let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.8`;
};

async function addSonarr(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Sonarr ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8990`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Sonarr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-8990-key",
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
  // Changes are verified by reading them back; commands report that they finished.
  await expect(pop).toContainText(/verified|finished/, { timeout: 20_000 });
  const text = await pop.innerText();
  await pop.getByTestId("approve-here-close").click();
  return text;
}

test.describe("the native Sonarr panel", () => {
  let id = "";
  test.beforeEach(async ({ page }, testInfo) => {
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addSonarr(page.request, `${testInfo.project.name}${Date.now() % 100000}`);
  });

  test("Library lists and filters the series, and opens one with its seasons and episodes", async ({
    page,
  }) => {
    const panel = await open(page, id, "library");
    const rows = panel.getByTestId("sonarr-series-row");
    await expect(rows).toHaveCount(4);
    await expect(panel.getByTestId("sonarr-library")).toContainText("2 with missing episodes");
    await panel.locator('[data-hearth-target="library:search"]').fill("copper");
    await expect(rows).toHaveCount(1);
    await rows.first().click();
    const series = panel.getByTestId("sonarr-series");
    await expect(series).toContainText("The Copper Line");
    await expect(series.getByTestId("sonarr-season")).toHaveCount(2);
    // The newest season is open: its episodes, with the missing one.
    await expect(series.getByTestId("sonarr-episode").filter({ hasText: "S02E06" })).toContainText(
      "No file",
    );
  });

  test("a season is monitored again and an episode stops being monitored, each approved", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "library/series/3");
    await panel.locator('[data-hearth-target="season:1:monitored"]').check();
    await panel.locator('[data-hearth-target="seasons:save"]').click();
    const done = await approve(page, /Season 2, Season 3 → Season 1, Season 2, Season 3|seasons/);
    expect(done).toContain("Monitored seasons");
    await expect(panel.locator('[data-hearth-target="seasons:save"]')).toHaveCount(0);
    const ep = panel.getByTestId("sonarr-episode").first();
    const toggle = ep.locator('[data-hearth-target$=":monitored"]');
    await expect(toggle).toHaveText("Monitored");
    await toggle.click();
    await approve(page, /Stop monitoring Small Hours/);
    await expect(toggle).toHaveText("Not monitored");
  });

  test("a new show is found through Sonarr's own search and added once", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "library/add");
    await panel.locator('[data-hearth-target="add:search"]').fill("lantern");
    await panel.getByRole("button", { name: "Find" }).click();
    await expect(panel.getByTestId("sonarr-lookup")).toHaveCount(2);
    await panel.locator('[data-hearth-target="add:pick:99000"]').click();
    await panel.getByLabel("Monitor").selectOption("future");
    await panel.locator('[data-hearth-target="add:review"]').click();
    const done = await approve(page, /Lantern Bay \(2024\)[\s\S]*Future episodes/);
    expect(done).toContain("Added Lantern Bay (2024) to");
    await panel.getByRole("button", { name: "Library" }).click();
    await expect(panel.getByTestId("sonarr-series-row")).toHaveCount(5);
  });

  test("Wanted lists missing episodes and opens their series", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "wanted");
    const rows = panel.getByTestId("sonarr-wanted-episode");
    await expect(rows.first()).toContainText("The Copper Line");
    await panel.locator('[data-hearth-target="wanted:missing:search-all"]').click();
    await approve(page, /every missing episode/);
    await rows.first().locator("button").first().click();
    await expect(panel.getByTestId("sonarr-series")).toContainText("The Copper Line");
  });

  test("Import files puts a file Sonarr matched into its episode", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "activity/import");
    await panel.locator('[data-hearth-target="import:folder"]').fill("/downloads");
    await panel.getByRole("button", { name: "Look" }).click();
    const files = panel.getByTestId("sonarr-import-file");
    await expect(files).toHaveCount(2);
    await expect(files.first()).toContainText("S02E07");
    await panel.locator('[data-hearth-target="import:review"]').click();
    const done = await approve(page, /Import 1 file into Sonarr/);
    expect(done).toContain("The Copper Line (2023) S02E07");
    await expect(files).toHaveCount(1);
  });

  test("Settings and System are shared with Radarr and read Sonarr", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config/media");
    await expect(panel.getByTestId("radarr-media")).toContainText("Season folder format");
    await expect(panel.getByTestId("radarr-media")).not.toContainText("Rename movies");
    await panel.locator('[data-hearth-target="settings:exclusions"]').click();
    await expect(panel.getByTestId("radarr-exclusion")).toContainText("The Orchard Road");
    await panel.locator('[data-hearth-target="exclusions:search"]').fill("lantern");
    await panel.getByRole("button", { name: "Find" }).click();
    await panel.locator('[data-hearth-target="exclusions:add:99000"]').click();
    await approve(page, /Lantern Bay \(2024\)/);
    await expect(panel.getByTestId("radarr-exclusion")).toHaveCount(2);
    const system = await open(page, id, "system");
    await expect(system).toContainText("4.0.20");
  });

  test("Overview is the everyday summary; the queue and missing episodes open their tabs", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "overview");
    await expect(panel.getByTestId("arr-right-now")).toBeVisible();
    await expect(panel.locator('[data-hearth-target="view:upcoming"]')).toBeVisible();
    await expect(panel.locator('[data-hearth-target="view:search"]')).toBeVisible();
    // The queue and Missing are Activity's and Wanted's, not repeated here.
    await expect(panel.locator('[data-hearth-target="view:queue"]')).toHaveCount(0);
    await expect(panel.locator('[data-hearth-target="view:missing"]')).toHaveCount(0);
    await panel.locator('[data-hearth-target="overview:queue"]').click();
    await expect(panel.getByTestId("radarr-activity")).toBeVisible();
    await open(page, id, "overview/missing");
    await expect(panel.getByTestId("sonarr-wanted")).toBeVisible();
  });

  test("on a phone, Library and a series are usable within the screen", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Phone only.");
    const panel = await open(page, id, "library");
    await panel.getByTestId("sonarr-series-row").first().click();
    await expect(panel.getByTestId("sonarr-series")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
