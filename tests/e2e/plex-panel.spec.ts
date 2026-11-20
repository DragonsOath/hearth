import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels (46.10o): Plex's Library, History, Tasks and Settings tabs against the stand-in
// Plex (port 32400). Every change goes through the real plan, approval, re-reading and read-back
// code; networking settings are shown locked.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.24`;
};

async function addPlex(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      // Plex is recognized by its image or a name of plain "Plex"; "Plex: <run>" keeps them apart.
      name: `Plex: ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:32400`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Plex ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-plex-panel-token",
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

test.describe("the native Plex panel", () => {
  test.describe.configure({ mode: "serial" });
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addPlex(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Library: find a film, mark it watched and edit its sort title", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "library");
    await expect(panel.getByTestId("plex-card")).toHaveCount(3, { timeout: 20_000 });
    await panel.locator('[data-hearth-target="library:search"]').fill("harbor");
    // It searches as you type, no Enter needed (11-04).
    await expect(panel.getByTestId("plex-card")).toHaveCount(2);
    await panel.locator('[data-hearth-target="library:item:101"]').click();
    const item = panel.getByTestId("plex-item");
    await expect(item.getByTestId("plex-item-title")).toContainText("Harbor Lights");
    await expect(item.getByTestId("plex-files")).toContainText("Harbor Lights (2019).mkv");
    // A movie can become a movie night from here (11-12).
    await expect(item.getByTestId("plan-movie-night")).toBeVisible();

    await item.locator('[data-hearth-target="item:watched"]').click();
    await approve(page, /Harbor Lights/);
    await expect(item).toContainText("Mark unwatched", { timeout: 20_000 });

    await item.locator('[data-hearth-target="item:edit"]').click();
    await item.locator('[data-hearth-target="item:edit:sort"]').fill("Lights, Harbor");
    await item.locator('[data-hearth-target="item:edit:save"]').click();
    await approve(page, /Edit Harbor Lights/);
    await expect(item.locator('[data-hearth-target="item:edit:sort"]')).toHaveValue(
      "Lights, Harbor",
      { timeout: 20_000 },
    );
  });

  test("Library: put a film in a collection from its page", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "library");
    await panel.locator('[data-hearth-target="library:item:103"]').click();
    const item = panel.getByTestId("plex-item");
    await expect(item.getByTestId("plex-item-title")).toContainText("Ember Lake", {
      timeout: 20_000,
    });
    const add = panel.getByTestId("plex-add-to-collection");
    await add.getByTestId("plex-collection-name").fill("Harbor Classics");
    await add.getByTestId("plex-collection-add").click();
    await approve(page, /Ember Lake/);
  });

  test("Library: a show's seasons; a whole season is marked watched", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "library");
    await panel.locator('[data-hearth-target="library:section:2"]').click();
    const show = panel.locator('[data-hearth-target="library:item:200"]');
    await expect(show).toContainText("3/6 watched", { timeout: 20_000 });
    await show.click();
    const seasons = panel.getByTestId("plex-child");
    await expect(seasons).toHaveCount(2);
    await expect(seasons.nth(1)).toContainText("0 of 3 watched");
    await panel.locator('[data-hearth-target="item:child:220:watched"]').click();
    await approve(page, /Every episode/);
    await expect(seasons.nth(1)).toContainText("3 of 3 watched", { timeout: 20_000 });
  });

  test("History, Tasks and Settings: run a task, change a setting, networking stays locked", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    let panel = await open(page, id, "plays");
    await expect(panel.getByTestId("plex-history")).toContainText("Signal Hill S01E03", {
      timeout: 20_000,
    });
    await expect(panel.getByTestId("plex-history")).toContainText("sam");

    panel = await open(page, id, "tasks");
    await panel.locator('[data-hearth-target="task:BackupDatabase:run"]').click();
    await approve(page, /Backup Database/);
    await expect(panel.getByTestId("plex-activities")).toContainText("Backup Database", {
      timeout: 20_000,
    });

    panel = await open(page, id, "config");
    const port = panel.locator('[data-setting="ManualPortMappingPort"]');
    await expect(port).toBeVisible({ timeout: 20_000 });
    await expect(port.getByLabel("Changed in Plex only")).toBeVisible();
    await expect(port.locator("input, select")).toHaveCount(0);
    await expect(panel).not.toContainText("e2e-never-shown-token");
    await panel.locator('[data-hearth-target="setting:TranscoderQuality"]').selectOption("2");
    await panel.locator('[data-hearth-target="settings:review"]').click();
    await approve(page, /Transcoder quality/);
    await expect(panel.locator('[data-hearth-target="setting:TranscoderQuality"]')).toHaveValue(
      "2",
      { timeout: 20_000 },
    );
  });
  test("Manage: rows on Home and Friends' Home, a new order, and Merge Recently Added, each approved", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    const panel = await open(page, id, "manage");
    await expect(panel.getByTestId("plex-library")).toHaveCount(2, { timeout: 20_000 });
    const rows = panel.getByTestId("plex-rows");
    await expect(rows.getByTestId("plex-row")).toHaveCount(5);
    // Time Loop Movies: onto Home and Friends' Home, and to the top.
    await rows.getByLabel("Time Loop Movies: Home").check();
    await rows.getByLabel("Time Loop Movies: Friends' Home").check();
    for (let i = 0; i < 3; i++) await rows.getByLabel("Move Time Loop Movies up").click();
    await expect(rows.getByTestId("plex-row").first()).toContainText("Time Loop Movies");
    await expect(panel.getByTestId("plex-rows-save")).toContainText("1 row changed, new order");
    await panel.locator('[data-hearth-target="manage:rows:save"]').click();
    await approve(page, /Change 1 row and the order in Movies/);
    await expect(rows.getByTestId("plex-row").first()).toContainText("Time Loop Movies", {
      timeout: 15_000,
    });
    await expect(rows.getByLabel("Time Loop Movies: Friends' Home")).toBeChecked();
    await expect(panel.getByTestId("plex-rows-save")).toHaveCount(0);
    // Another library's rows.
    await panel.locator('[data-hearth-target="manage:library:2"]').click();
    await expect(rows.getByTestId("plex-row")).toHaveCount(3);
    await expect(rows).toContainText("On Deck");
    // Who has access, from plex.tv: friends and Home members with their libraries.
    const access = panel.getByTestId("plex-access");
    await expect(access.getByTestId("plex-friend")).toHaveCount(4, { timeout: 15_000 });
    await expect(access).toContainText("Alex Rivers");
    await expect(access).toContainText("All libraries");
    await expect(access).toContainText("Invite not accepted yet");
    await expect(access).not.toContainText("@example.com");
    await access.getByRole("button", { name: /sam/ }).click();
    await expect(access).toContainText("TV Shows");
    // Merge Recently Added Items.
    // It shows what Plex has until the change is approved.
    await panel.getByTestId("plex-merge").click();
    await approve(page, /Merge Recently Added Items/);
    await expect(panel.getByTestId("plex-merge")).toBeChecked({ timeout: 15_000 });
  });

  test("Manage on a phone: the rows table scrolls inside itself, the page does not", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "mobile", "Phone only.");
    const panel = await open(page, id, "manage");
    await expect(panel.getByTestId("plex-row").first()).toBeVisible({ timeout: 20_000 });
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(wide).toBe(false);
  });
});
