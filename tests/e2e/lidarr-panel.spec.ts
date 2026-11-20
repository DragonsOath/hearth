import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels Phase 3: Lidarr's own tabs against the stand-in Lidarr 3.1 (port 8686). Every
// change goes through the real plan, approval, re-reading and read-back code. Activity, Settings
// and System are the Radarr panel's shared tabs, reading Lidarr.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.10`;
};

async function addLidarr(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Lidarr ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8686`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Lidarr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-lidarr-panel-key",
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
  await expect(pop).toContainText(/verified|finished/, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

test.describe("the native Lidarr panel", () => {
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addLidarr(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Library lists artists and opens one with its albums and tracks", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "library");
    await expect(panel.getByTestId("lidarr-artist-row")).toHaveCount(3);
    await panel.locator('[data-hearth-target="library:search"]').fill("radio");
    await expect(panel.getByTestId("lidarr-artist-row")).toHaveCount(1);
    await expect(panel.getByTestId("lidarr-artist-row")).toContainText("3/9");
    await panel.locator('[data-hearth-target="artist:1:open"]').click();
    const artist = panel.getByTestId("lidarr-artist-page");
    await expect(artist.getByTestId("lidarr-album")).toHaveCount(3);
    await artist.locator('[data-hearth-target="album:32:open"]').click();
    const album = panel.getByTestId("lidarr-album-page");
    await expect(album.getByTestId("lidarr-track")).toHaveCount(3);
    await expect(album.getByTestId("lidarr-track").nth(1)).toContainText("Paranoid Android");
    await expect(album.getByTestId("lidarr-track").nth(1)).toContainText("FLAC");
  });

  test("an album is monitored and an artist is added through Lidarr's own search, each approved", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "library/artist/1");
    await panel.locator('[data-hearth-target="album:33:monitor"]').click();
    await approve(page, /Pablo Honey[\s\S]*No[\s\S]*Yes/);

    await open(page, id, "library/add");
    await panel.locator('[data-hearth-target="add:search"]').fill("lantern");
    await panel.locator('[data-hearth-target="add:find"]').click();
    await panel.getByTestId("lidarr-lookup").first().click();
    const form = panel.getByTestId("lidarr-add-form");
    await form.locator('[data-hearth-target="add:monitor"]').selectOption("future");
    await form.locator('[data-hearth-target="add:review"]').click();
    await approve(page, /Add The Lantern Choir[\s\S]*Future albums/);
    await open(page, id, "library");
    await expect(panel.getByTestId("lidarr-artist-row")).toContainText(["The Lantern Choir"]);
  });

  test("Wanted lists missing albums and searches for one", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "wanted");
    const row = panel.getByTestId("lidarr-wanted-album").first();
    await expect(row).toContainText("Kid A");
    await panel.locator('[data-hearth-target="wanted:search:31"]').click();
    await approve(page, /Search for the album[\s\S]*Kid A/);
  });

  test("Import files puts a file Lidarr matched into its track", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "activity");
    await expect(panel.locator('[data-hearth-target="activity:queue"]')).toHaveCount(0);
    await panel.locator('[data-hearth-target="import:look"]').click();
    const file = panel.getByTestId("lidarr-import-file");
    await expect(file).toContainText("Homogenic");
    await file.getByRole("checkbox").check();
    await panel.locator('[data-hearth-target="import:copy"]').check();
    await panel.locator('[data-hearth-target="import:review"]').click();
    await approve(page, /Import 1 file[\s\S]*Hunter/);
  });

  test("Settings and System are shared with Radarr and read Lidarr", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config/media");
    await expect(panel).toContainText("Track file name format");
    await open(page, id, "config");
    await expect(panel).toContainText("Lossless");
    await open(page, id, "system");
    await expect(panel.getByTestId("radarr-system")).toContainText("3.1.0.4875");
  });

  test("on a phone, Library and an artist are usable within the screen", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Phone only.");
    const panel = await open(page, id, "library");
    await expect(panel.getByTestId("lidarr-artist-row").first()).toBeVisible();
    await open(page, id, "library/artist/1");
    await expect(panel.getByTestId("lidarr-album").first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
