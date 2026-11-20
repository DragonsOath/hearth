import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Deluge's panel against the stand-in Deluge 2.2 Web UI (port 8112): the same Overview and
// Torrents tab as qBittorrent's, with Deluge's own words (labels, from its Label plugin, which
// starts off), queue moves, and Settings. Every change goes through the real plan, approval and
// read-back code.

const BUNNY = "1111111111111111111111111111111111111111";
const SINTEL = "2222222222222222222222222222222222222222";

let hosts = (Date.now() + 23_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.31`;
};

async function addDeluge(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Deluge ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8112`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Deluge ${run} Web UI password`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-deluge",
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

/** A small, valid .torrent file. */
function torrentFile(name: string) {
  const info = `d6:lengthi2048e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:${"x".repeat(20)}e`;
  return {
    buffer: Buffer.from(`d8:announce19:http://t.example/an4:info${info}e`, "latin1"),
    hash: createHash("sha1").update(Buffer.from(info, "latin1")).digest("hex"),
  };
}

test.describe("Deluge's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addDeluge(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview at a glance, then a torrent's files, trackers and pause from Torrents", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("qb-dashboard");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByTestId("qb-header")).toContainText("Connected");
    await expect(board.getByTestId("qb-freshness")).toContainText("v2.2.0");
    await expect(board.getByTestId("qb-needs-you")).toContainText("Sintel.S01E02.720p");
    await expect(board.getByTestId("qb-downloading")).toContainText("Big.Buck.Bunny");
    await shot(page, "deluge-overview");

    await board.getByTestId("qb-all").click();
    const tab = panel.getByTestId("qb-torrents");
    await expect(tab.getByTestId("qb-torrent")).toHaveCount(3, { timeout: 15_000 });
    // Deluge's words: labels, not categories; no tags; no force start.
    await expect(tab.getByRole("combobox", { name: "Label" })).toBeVisible();
    await expect(tab.getByRole("combobox", { name: "Tag" })).toHaveCount(0);
    const bunny = tab.getByTestId("qb-torrent").filter({ hasText: "Big.Buck.Bunny" });
    await bunny
      .getByRole("button", { name: /Big\.Buck\.Bunny/ })
      .first()
      .click();
    const detail = bunny.getByTestId("qb-detail");
    await expect(detail.getByTestId("qb-files")).toContainText("sample.mkv");
    await expect(detail.getByRole("button", { name: "Force start" })).toHaveCount(0);
    await expect(detail.getByTestId("dl-labels-off")).toBeVisible();
    await detail.getByRole("tab", { name: "trackers" }).click();
    await expect(detail.getByTestId("qb-trackers")).toContainText("tracker.example.org");
    await expect(detail).not.toContainText("passkey");
    await shot(page, "deluge-torrent");
    await detail.getByRole("button", { name: "Pause" }).click();
    await approve(page, /Pause Big\.Buck\.Bunny\.2008\.1080p/);
    await expect(bunny).toHaveAttribute("data-status", "paused", { timeout: 15_000 });
  });

  test("labels: turn them on, make one, give it to a torrent; queue moves", async ({ page }) => {
    const panel = await open(page, id, "torrents");
    const tab = panel.getByTestId("qb-torrents");
    await expect(tab.getByTestId("qb-torrent")).toHaveCount(3, { timeout: 20_000 });
    await tab.getByTestId("qb-categories").click();
    const sheet = page.getByTestId("qb-categories-sheet");
    await sheet.getByTestId("dl-labels-on").click();
    await approve(page, /Turn on Deluge[^']*'s Label plugin/);
    await expect(sheet.getByTestId("qb-new-category")).toBeVisible({ timeout: 15_000 });
    await sheet.getByTestId("qb-new-category").fill("movies");
    await sheet.getByRole("button", { name: "Create" }).click();
    await approve(page, /Make the label movies/);
    await expect(sheet).toContainText("movies", { timeout: 15_000 });
    await shot(page, "deluge-labels");
    await page.keyboard.press("Escape");

    const sintel = tab.getByTestId("qb-torrent").filter({ hasText: "Sintel" });
    await sintel
      .getByRole("button", { name: /Sintel/ })
      .first()
      .click();
    const detail = sintel.getByTestId("qb-detail");
    await detail.getByLabel("Label").selectOption("movies");
    await detail.getByRole("button", { name: "Change" }).click();
    await approve(page, /Label Sintel\.S01E02\.720p movies/);
    await expect(sintel).toContainText("movies", { timeout: 15_000 });
    await detail.getByRole("button", { name: "Top" }).click();
    await approve(page, /Move Sintel\.S01E02\.720p first/);
  });

  test("Add torrent puts in a magnet link and a .torrent file", async ({ page }) => {
    const panel = await open(page, id, "torrents");
    const tab = panel.getByTestId("qb-torrents");
    await expect(tab.getByTestId("qb-torrent")).toHaveCount(3, { timeout: 20_000 });
    await tab.getByTestId("qb-add").click();
    const form = page.getByTestId("qb-add-form");
    await form
      .getByTestId("qb-add-links")
      .fill("magnet:?xt=urn:btih:5555555555555555555555555555555555555555&dn=Tears.of.Steel");
    const file = torrentFile("Cosmos.Laundromat.mkv");
    await form.getByTestId("qb-add-file").setInputFiles({
      name: "cosmos.torrent",
      mimeType: "application/x-bittorrent",
      buffer: file.buffer,
    });
    // No folder or tags in Deluge's add; labels are off until turned on.
    await expect(form.getByTestId("qb-add-folder")).toHaveCount(0);
    await expect(form).toContainText("Add it paused");
    await form.getByRole("button", { name: "Add 2 torrents" }).click();
    await approve(page, /Add 2 torrents to Deluge/);
    await expect(tab.getByTestId("qb-torrent")).toHaveCount(5, { timeout: 15_000 });
    await expect(tab).toContainText("Cosmos.Laundromat.mkv");
    void BUNNY;
    void SINTEL;
  });

  test("Settings: change a speed limit, read back", async ({ page }) => {
    const panel = await open(page, id, "config");
    const settings = panel.getByTestId("dl-settings");
    await expect(settings.getByTestId("dl-settings-group").first()).toBeVisible({
      timeout: 20_000,
    });
    // The proxy (it holds a password), ports and folders are never offered as settings.
    await expect(settings.getByRole("spinbutton", { name: /proxy|port/i })).toHaveCount(0);
    await expect(settings).not.toContainText("never-shown");
    await settings.getByLabel("Download speed limit").fill("2048");
    await shot(page, "deluge-settings");
    await settings.getByTestId("dl-settings-review").click();
    await approve(page, /Download speed limit[\s\S]*no limit[\s\S]*2048 KiB\/s/);
    await expect(settings.getByLabel("Download speed limit")).toHaveValue("2048", {
      timeout: 15_000,
    });
  });
});
