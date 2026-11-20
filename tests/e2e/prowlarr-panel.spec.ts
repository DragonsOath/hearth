import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels Phase 3: Prowlarr's own tabs against the stand-in Prowlarr 2.6 (port 9696).
// Every change goes through the real plan, approval, re-reading and read-back code. Settings'
// Connections and System are the Radarr panel's shared tabs, reading Prowlarr.

/** A test address no earlier service in this run has (Hearth refuses a second one). */
let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.9`;
};

async function addProwlarr(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Prowlarr ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:9696`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Prowlarr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-prowlarr-panel-key",
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
  await expect(pop).toContainText(/verified|finished|confirms/, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

/** Secrets the stand-in holds: none may reach the page. */
const SECRETS = [
  "secret-indexer-key",
  "hunter2",
  "stand-in-secret",
  "stand-in-passkey",
  "e2e-stand-in-prowlarr-key",
];

test.describe("the native Prowlarr panel", () => {
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addProwlarr(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Indexers lists the failing one first and opens an indexer's settings", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "indexers");
    const rows = panel.getByTestId("prowlarr-indexer-row");
    await expect(rows.first()).toContainText("Torrent Alpha");
    await expect(rows.first()).toContainText("Prowlarr paused it");
    await panel.locator('[data-hearth-target="indexer:1:open"]').click();
    const page1 = panel.getByTestId("prowlarr-indexer-page");
    await expect(page1).toContainText("Usenet Prime");
    await expect(page1.getByTestId("radarr-secret-field")).toContainText("Set (hidden)");
    await page1.locator("#prio-indexer-1").fill("12");
    await page1.locator('[data-hearth-target="connection:indexer:1:save"]').click();
    await approve(page, /Usenet Prime[\s\S]*25[\s\S]*12/);
    for (const s of SECRETS) expect(await page.content()).not.toContain(s);
  });

  test("an indexer is added from Prowlarr's list of sites, once", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "indexers");
    await panel.locator('[data-hearth-target="indexers:add"]').click();
    await panel.locator('[data-hearth-target="add:search"]').fill("lantern");
    await expect(panel.getByTestId("prowlarr-definition")).toHaveCount(1);
    await panel.locator('[data-hearth-target="add:pick:Lantern Public"]').click();
    const form = panel.getByTestId("prowlarr-add-form");
    await form
      .locator('[data-hearth-target="add:field:baseUrl"]')
      .selectOption("https://lantern.mirror");
    await form.locator('[data-hearth-target="add:review"]').click();
    await approve(page, /Add the indexer "Lantern Public"[\s\S]*lantern\.mirror/);
    await open(page, id, "indexers");
    await expect(panel.getByTestId("prowlarr-indexer-row")).toContainText(["Lantern Public"]);
    // A site that needs a login says so before anything is planned.
    await open(page, id, "indexers/add");
    await panel.locator('[data-hearth-target="add:search"]').fill("members");
    await expect(panel.getByTestId("prowlarr-definition")).toHaveCount(1);
    await expect(panel.getByTestId("prowlarr-definition")).toContainText("Needs a login or key");
  });

  test("Search finds results across indexers and sends one to the download client", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "search");
    await panel.locator('[data-hearth-target="search:query"]').fill("lantern season");
    await panel.locator('[data-hearth-target="search:go"]').click();
    const results = panel.getByTestId("prowlarr-result");
    await expect(results).toHaveCount(3);
    await expect(results.first()).toContainText("120 seeding");
    // The download links carry Prowlarr's key: they never reach the page.
    for (const s of SECRETS) expect(await page.content()).not.toContain(s);
    await panel.locator('[data-hearth-target="search:grab:stand-in-1"]').click();
    await approve(page, /Send "Lantern\.Season\.2024\.1080p\.WEB-DL\.x264-GRP"[\s\S]*qBittorrent/);
    await open(page, id, "grabs");
    await expect(panel.getByTestId("prowlarr-history-row").first()).toContainText(
      "Lantern.Season.2024.1080p.WEB-DL.x264-GRP",
    );
  });

  test("Settings: how an app is synced, a sync profile, and a tag, each approved", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config");
    const radarr = panel.locator('[data-hearth-target="connection:application:1"]');
    await radarr.locator("summary").click();
    await radarr.locator('[data-hearth-target="application:1:sync"]').selectOption("addOnly");
    await radarr.locator('[data-hearth-target="connection:application:1:save"]').click();
    await approve(page, /Radarr[\s\S]*fullSync[\s\S]*addOnly/);
    await panel.locator('[data-hearth-target="appprofile:1:enableRss"]').uncheck();
    await panel.locator('[data-hearth-target="appprofile:1:save"]').click();
    await approve(page, /Standard[\s\S]*Yes[\s\S]*No/);
    await panel.locator('[data-hearth-target="settings:tags"]').click();
    await panel.locator('[data-hearth-target="tag:new:label"]').fill("e2e-proxy");
    await panel.locator('[data-hearth-target="tag:new:add"]').click();
    await approve(page, /e2e-proxy/);
    await expect(panel.getByTestId("prowlarr-tags")).toContainText("e2e-proxy");
    await panel.locator('[data-hearth-target="settings:connections"]').click();
    await expect(panel.getByTestId("radarr-connections")).toContainText("FlareSolverr");
    for (const s of SECRETS) expect(await page.content()).not.toContain(s);
  });

  test("System is shared with Radarr: health, a task now, and the log with keys hidden", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "system");
    await expect(panel.getByTestId("radarr-system")).toContainText("2.6.5.5623");
    await panel.locator('[data-hearth-target="system:tasks"]').click();
    await panel.locator('[data-hearth-target="task:run:CheckHealth"]').click();
    await approve(page, /Check Health|Check health/);
    await panel.locator('[data-hearth-target="system:logs"]').click();
    await expect(panel).toContainText("apikey=[hidden]");
    for (const s of SECRETS) expect(await page.content()).not.toContain(s);
  });

  test("on a phone, Indexers and Search are usable within the screen", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Phone only.");
    const panel = await open(page, id, "indexers");
    await expect(panel.getByTestId("prowlarr-indexer-row").first()).toBeVisible();
    await open(page, id, "search");
    await panel.locator('[data-hearth-target="search:query"]').fill("lantern season");
    await panel.locator('[data-hearth-target="search:go"]').click();
    await expect(panel.getByTestId("prowlarr-result").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
