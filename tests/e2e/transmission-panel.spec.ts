import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Transmission's panel against the stand-in Transmission 4.1 (port 9091, its RPC with the session
// handshake): the same Overview and Torrents tab as qBittorrent's and Deluge's, with Transmission's
// free-text labels, queue moves, and its Settings (speed, the turtle, share ratio). Every change
// goes through the real plan, approval and read-back code. No tracker passkey reaches the page.

const h = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

let hosts = (Date.now() + 47_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.93`;
};

async function addTransmission(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Transmission ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:9091`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Transmission ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "hearth",
      value: "e2e-transmission",
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

async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(/read back|asked|checking/, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Transmission's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addTransmission(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview at a glance, then a torrent's files, trackers and pause from Torrents", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("qb-dashboard");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByTestId("qb-header")).toContainText("Connected");
    await expect(board.getByTestId("qb-freshness")).toContainText("v4.1.4");
    await expect(board.getByTestId("qb-needs-you")).toContainText("Broken Download");
    await expect(board.getByTestId("qb-downloading")).toContainText("Lantern Season 1");
    await shot(page, "transmission-overview");

    await board.getByTestId("qb-all").click();
    const tab = panel.getByTestId("qb-torrents");
    await expect(tab.getByTestId("qb-torrent")).toHaveCount(5, { timeout: 15_000 });
    await expect(tab.getByRole("combobox", { name: "Label" })).toBeVisible();
    const lantern = tab.getByTestId("qb-torrent").filter({ hasText: "Lantern Season 1" });
    await lantern
      .getByRole("button", { name: /Lantern Season 1/ })
      .first()
      .click();
    const detail = lantern.getByTestId("qb-detail");
    await expect(detail.getByTestId("qb-files")).toContainText("Lantern Season 1.mkv");
    await expect(detail.getByRole("button", { name: "Force start" })).toHaveCount(0);
    await detail.getByRole("tab", { name: "trackers" }).click();
    await expect(detail.getByTestId("qb-trackers")).toContainText("tracker.example");
    await expect(page.locator("body")).not.toContainText("e2e-SECRET");
    await shot(page, "transmission-torrent");
    await detail.getByRole("button", { name: "Pause" }).click();
    await approve(page, /Pause Lantern Season 1/);
    await expect(lantern).toHaveAttribute("data-status", "paused", { timeout: 15_000 });
  });

  test("labels: type a new one for a torrent; queue moves; the label sheet lists them", async ({
    page,
  }) => {
    const panel = await open(page, id, `torrents/${h(2)}`);
    const tab = panel.getByTestId("qb-torrents");
    const harbor = tab.getByTestId("qb-torrent").filter({ hasText: "Quiet Harbor" });
    const detail = harbor.getByTestId("qb-detail");
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await detail.getByLabel("Label").fill("archive");
    await detail.getByRole("button", { name: "Change" }).click();
    await approve(page, /Label Quiet Harbor 2024 archive/);
    await expect(harbor).toContainText("archive", { timeout: 15_000 });
    await detail.getByRole("button", { name: "Top" }).click();
    await approve(page, /Move Quiet Harbor 2024 first/);

    await tab.getByTestId("qb-categories").click();
    const sheet = page.getByTestId("qb-categories-sheet");
    await expect(sheet).toContainText("archive", { timeout: 15_000 });
    // Free-text labels: nothing to create or remove on its own.
    await expect(sheet.getByTestId("qb-new-category")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await shot(page, "transmission-labels");
  });

  test("Add torrent puts in a magnet link with a label", async ({ page }) => {
    const panel = await open(page, id, "torrents");
    const tab = panel.getByTestId("qb-torrents");
    await expect(tab.getByTestId("qb-torrent")).toHaveCount(5, { timeout: 20_000 });
    await tab.getByTestId("qb-add").click();
    const form = page.getByTestId("qb-add-form");
    await form
      .getByTestId("qb-add-links")
      .fill(`magnet:?xt=urn:btih:${"cd".repeat(20)}&dn=Tears+of+Steel`);
    await form.getByTestId("qb-add-category").fill("movies");
    await expect(form.getByTestId("qb-add-folder")).toHaveCount(0);
    await form.getByRole("button", { name: /^Add/ }).last().click();
    await approve(page, /Add 1 link to Transmission \w+ with the label movies/);
    await expect(tab.getByTestId("qb-torrent")).toHaveCount(6, { timeout: 15_000 });
    await expect(tab).toContainText("Tears of Steel");
  });

  test("Settings: turn on a share ratio limit change and the turtle, read back", async ({
    page,
  }) => {
    const panel = await open(page, id, "config");
    const settings = panel.getByTestId("tr-settings");
    await expect(settings.getByTestId("tr-settings-group").first()).toBeVisible({
      timeout: 20_000,
    });
    // The RPC password and the proxy are never offered.
    await expect(settings).not.toContainText("e2e-SECRET");
    await expect(settings.getByRole("spinbutton", { name: /proxy|port|password/i })).toHaveCount(0);
    await settings.getByLabel("Share ratio to stop at").fill("1.5");
    await settings.getByLabel("Alternative speed limits on now (the turtle)").check();
    await shot(page, "transmission-settings");
    await settings.getByTestId("tr-settings-review").click();
    await approve(page, /Share ratio to stop at[\s\S]*2[\s\S]*1\.5/);
    await expect(settings.getByLabel("Share ratio to stop at")).toHaveValue("1.5", {
      timeout: 15_000,
    });
  });
});
