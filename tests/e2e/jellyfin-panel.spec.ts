import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels (46.10n): Jellyfin's People, Devices, Activity and Logs tabs, and (11-04) Library,
// Manage, Plugins and Settings like Plex's, against the
// stand-in Jellyfin (port 8096). Every change goes through the real plan, approval, re-reading and
// read-back code; an administrator is never offered disable or remove.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.21`;
};

async function addJellyfin(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Jellyfin ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8096`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Jellyfin ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-jellyfin-panel-key",
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
  await expect(pop).toContainText(/Done|verified|finished/, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

test.describe("the native Jellyfin panel", () => {
  test.describe.configure({ mode: "serial" });
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addJellyfin(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("People: change access, disable and enable, never touch the administrator", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "people");
    const users = panel.getByTestId("jf-user");
    await expect(users).toHaveCount(3, { timeout: 20_000 });

    // The administrator can have access changed but is never offered disable or remove.
    const alex = users.filter({ hasText: "Alex" });
    await alex.getByRole("button", { name: "Change access" }).click();
    await expect(alex.getByTestId("jf-access")).toContainText("never disabled or removed");
    await expect(alex.getByRole("button", { name: "Disable account" })).toHaveCount(0);
    await expect(alex.getByRole("button", { name: "Remove" })).toHaveCount(0);

    // sam: Movies only, downloads on.
    const sam = users.filter({ hasText: "sam" });
    await sam.getByRole("button", { name: "Change access" }).click();
    await sam.locator('[data-hearth-target="jf-user:u2:all"]').click();
    await sam.locator('[data-hearth-target="jf-user:u2:lib:Movies"]').click();
    await sam.locator('[data-hearth-target="jf-user:u2:downloads"]').click();
    await sam.getByRole("button", { name: "Review access" }).click();
    await approve(page, /sam/);
    await expect(sam).toContainText("Movies · downloads on", { timeout: 20_000 });

    // kim: disable, then enable again.
    const kim = users.filter({ hasText: "kim" });
    await kim.getByRole("button", { name: "Change access" }).click();
    await kim.getByRole("button", { name: "Disable account" }).click();
    await approve(page, /kim/);
    await expect(kim).toContainText("disabled", { timeout: 20_000 });
    await kim.getByRole("button", { name: "Enable account" }).click();
    await approve(page, /kim/);
    await expect(kim).not.toContainText("disabled", { timeout: 20_000 });
  });

  test("People: remove someone; Devices: sign a device out", async ({ page }) => {
    test.setTimeout(90_000);
    let panel = await open(page, id, "people");
    const kim = panel.getByTestId("jf-user").filter({ hasText: "kim" });
    await kim.getByRole("button", { name: "Change access" }).click();
    await kim.getByRole("button", { name: "Remove" }).click();
    await approve(page, /kim/);
    await expect(panel.getByTestId("jf-user")).toHaveCount(2, { timeout: 20_000 });

    panel = await open(page, id, "devices");
    const phone = panel.getByTestId("jf-device").filter({ hasText: "Pixel 8" });
    await expect(phone).toContainText("Findroid");
    await phone.getByRole("button", { name: "Sign out" }).click();
    await approve(page, /Pixel 8/);
    await expect(panel.getByTestId("jf-device")).toHaveCount(1, { timeout: 20_000 });
  });

  test("Activity and Logs: Jellyfin's own log, keys hidden", async ({ page }) => {
    let panel = await open(page, id, "activity");
    await expect(panel.getByTestId("jf-activity")).toContainText("failed to sign in", {
      timeout: 20_000,
    });
    panel = await open(page, id, "system");
    await panel.getByLabel("Log file").selectOption("log_20261101.log");
    const log = panel.getByTestId("jf-log");
    await expect(log).toContainText("ffmpeg exited with code 1", { timeout: 20_000 });
    await expect(log).toContainText("[hidden]");
    expect((await log.textContent())?.includes("0123456789abcdef0123456789abcdef")).toBe(false);
  });

  test("Library: search as you type, open a title, mark it watched and edit it", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "library");
    await expect(panel.getByTestId("jf-card")).toHaveCount(2, { timeout: 20_000 });
    await panel.locator('[data-hearth-target="library:search"]').fill("anor");
    await expect(panel.getByTestId("jf-card")).toHaveCount(1);
    await panel.locator('[data-hearth-target="library:item:m-anora"]').click();
    const item = panel.getByTestId("jf-item");
    await expect(item.getByTestId("jf-item-title")).toContainText("Anora");
    await expect(item.getByTestId("jf-files")).toContainText("1080p");
    // A movie can become a movie night from here (11-12).
    await expect(item.getByTestId("plan-movie-night")).toBeVisible();
    await item.locator('[data-hearth-target="item:watched"]').click();
    await approve(page, /Mark Anora watched/);
    await expect(item.locator('[data-hearth-target="item:watched"]')).toHaveText(/Mark unwatched/, {
      timeout: 20_000,
    });
    await item.locator('[data-hearth-target="item:edit"]').click();
    await item.locator('[data-hearth-target="item:edit:sort"]').fill("Anora (2024)");
    await item.locator('[data-hearth-target="item:edit:save"]').click();
    await approve(page, /Sort title/);
    await page.screenshot({
      path: `test-results/screens/${test.info().project.name}/jellyfin-item.png`,
    });
  });

  test("Manage: add a folder to a library and stop reading it", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "manage");
    const movies = panel.getByTestId("jf-library-row").filter({ hasText: "Movies" });
    await expect(movies.getByTestId("jf-folder")).toHaveCount(1, { timeout: 20_000 });
    await movies.locator('[data-hearth-target="manage:library:Movies:add-folder"]').click();
    await movies.locator('[data-hearth-target="manage:library:Movies:path"]').fill("/media/extra");
    await movies.getByRole("button", { name: "Review" }).click();
    await approve(page, /\/media\/extra/);
    await expect(movies.getByTestId("jf-folder")).toHaveCount(2, { timeout: 20_000 });
    await movies
      .getByTestId("jf-folder")
      .filter({ hasText: "/media/extra" })
      .getByRole("button", { name: "Stop reading it" })
      .click();
    await approve(page, /files stay on disk/);
    await expect(movies.getByTestId("jf-folder")).toHaveCount(1, { timeout: 20_000 });
  });

  test("Plugins: update one, restart when Jellyfin asks, install from the catalog", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const panel = await open(page, id, "plugins");
    await expect(panel.getByTestId("jf-plugin")).toHaveCount(2, { timeout: 20_000 });
    await expect(panel.getByTestId("jf-updates")).toContainText("1 update");
    // A plugin that needs a newer Jellyfin is not offered.
    await expect(panel.getByTestId("jf-catalog-entry")).toHaveCount(1);
    await page.screenshot({
      path: `test-results/screens/${test.info().project.name}/jellyfin-plugins.png`,
    });
    await panel.locator('[data-hearth-target="plugin:Open Subtitles:update"]').click();
    await approve(page, /Update the Open Subtitles plugin to 21.0.0.0/);
    await expect(panel.getByTestId("jf-restart-needed")).toBeVisible({ timeout: 20_000 });
    await panel.locator('[data-hearth-target="catalog:Fanart:install"]').click();
    await approve(page, /Install the Fanart plugin/);
    await panel.locator('[data-hearth-target="plugins:restart"]').click();
    await approve(page, /cut off for about a minute/);
    await expect(panel.getByTestId("jf-restart-needed")).toHaveCount(0, { timeout: 20_000 });
    await expect(panel.getByTestId("jf-plugin").filter({ hasText: "Fanart" })).toBeVisible();
  });

  test("Settings: change one through a plan, networking stays in Jellyfin", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "config");
    const tone = panel.locator('[data-hearth-target="setting:EnableTonemapping"]');
    await expect(tone).not.toBeChecked({ timeout: 20_000 });
    await tone.check();
    await panel.locator('[data-hearth-target="settings:review"]').click();
    await approve(page, /Tone mapping/);
    await expect(tone).toBeChecked({ timeout: 20_000 });
    await expect(panel).toContainText("Networking, remote access");
  });
});
