import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// qBittorrent's Torrents tab (checklist 46.11) against the stand-in qBittorrent 5.2 (port 8090):
// adding (a magnet link and a .torrent file), a torrent's files, peers, category and pause,
// categories, and the two kinds of remove. Every change goes through the real plan, approval and
// read-back code.

const UBUNTU = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHOW = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.17`;
};

async function addQbittorrent(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `qBittorrent ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8090`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `qBittorrent ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "hearth",
      value: "e2e-qbt-login",
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

/** Approves the plan in the pop-up, after checking what it says. */
async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(/Done|verified|finished/, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

/** A small, valid .torrent file. */
function torrentFile(name: string) {
  const info = `d6:lengthi2048e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:${"x".repeat(20)}e`;
  return {
    buffer: Buffer.from(`d8:announce19:http://t.example/an4:info${info}e`, "latin1"),
    hash: createHash("sha1").update(Buffer.from(info, "latin1")).digest("hex"),
  };
}

test.describe("qBittorrent's Torrents tab", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addQbittorrent(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview at a glance; Add torrent puts in a magnet link and a .torrent file", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const overview = await open(page, id, "overview");
    await expect(overview.getByTestId("qb-downloading")).toContainText("Ubuntu 24.04 Desktop");
    await overview.getByTestId("qb-overview-add").click();

    const form = page.getByTestId("qb-add-form");
    await expect(form).toBeVisible();
    await form
      .getByTestId("qb-add-links")
      .fill("magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=Open.Movie");
    const file = torrentFile("Big.Buck.Bunny.mkv");
    await form.getByTestId("qb-add-file").setInputFiles({
      name: "bunny.torrent",
      mimeType: "application/x-bittorrent",
      buffer: file.buffer,
    });
    await form.getByTestId("qb-add-category").selectOption("radarr");
    await expect(form).toContainText("Saves to /downloads/movies");
    const axe = await new AxeBuilder({ page }).include('[data-testid="qb-add-form"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );
    await form.getByRole("button", { name: "Add 2 torrents" }).click();
    await approve(
      page,
      /Add 2 torrents[\s\S]*Big.Buck.Bunny.mkv[\s\S]*from your file bunny.torrent/,
    );

    const torrents = await open(page, id, "torrents");
    for (const name of ["Open.Movie", "Big.Buck.Bunny.mkv"])
      await expect(torrents.getByTestId("qb-torrent").filter({ hasText: name })).toBeVisible({
        timeout: 15_000,
      });
  });

  test("a torrent's files, peers and category (with where its files go), then pause it", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, `torrents/${SHOW}`);
    const detail = panel.getByTestId("qb-detail");
    await expect(detail).toBeVisible();
    // Its files: the sample was skipped; download it after all.
    const files = detail.getByTestId("qb-files");
    await expect(files).toContainText("Sample/sample.mkv");
    await files.getByLabel("Priority of Sample/sample.mkv").selectOption({ label: "Normal" });
    await approve(page, /Do not download[\s\S]*Normal/);
    await expect(files.getByLabel("Priority of Sample/sample.mkv")).toHaveValue("1", {
      timeout: 15_000,
    });

    await detail.getByRole("tab", { name: "peers" }).click();
    await expect(detail.getByTestId("qb-peers")).toContainText("203.0.113.24");

    // Automatic management is on for it: the plan says its files move, and where.
    await detail.locator('[data-hearth-target="torrent:category"]').selectOption("radarr");
    await detail.getByRole("button", { name: "Change" }).click();
    await approve(page, /FILES MOVE[\s\S]*\/downloads\/tv[\s\S]*\/downloads\/movies/);
    await expect(panel.getByTestId("qb-torrent").filter({ hasText: "Night.Signal" })).toContainText(
      "Category radarr",
      { timeout: 15_000 },
    );

    const pauseResume = detail.locator('[data-hearth-target="torrent:pause-resume"]');
    await pauseResume.click();
    await approve(page, /Pause/);
    // Finished and stopped: it is no longer seeding, and the same button now resumes it.
    await expect(pauseResume).toHaveText("Resume", { timeout: 15_000 });
    await expect(
      panel.getByTestId("qb-torrent").filter({ hasText: "Night.Signal" }),
    ).not.toHaveAttribute("data-status", "seeding");
  });

  test("categories: one in use cannot be removed; a new one is created and removed", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "torrents");
    await panel.getByTestId("qb-categories").click();
    const sheet = page.getByTestId("qb-categories-sheet");
    const row = (name: string) => sheet.locator("li").filter({ hasText: name });
    await expect(row("radarr").getByRole("button", { name: "Remove" })).toBeDisabled();
    await sheet.getByTestId("qb-new-category").fill("games");
    await sheet.getByRole("button", { name: "Create" }).click();
    await approve(page, /Create the category "games"[\s\S]*\/downloads\/games/);

    // Back in the list after each change, with the change in it.
    await expect(row("games")).toContainText("/downloads/games · 0 torrents", {
      timeout: 15_000,
    });
    await row("games").getByRole("button", { name: "Remove" }).click();
    await approve(page, /Remove the category "games"/);
    await expect(row("games")).toHaveCount(0, { timeout: 15_000 });
  });

  test("removing: the plan says plainly whether its files are kept or deleted", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, `torrents/${UBUNTU}`);
    const detail = panel.getByTestId("qb-detail");
    await detail.locator('[data-hearth-target="torrent:remove-data"]').click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toContainText(/AND DELETE its downloaded data/);
    // Not this one: closing the pop-up declines it, nothing changes.
    await page.keyboard.press("Escape");
    await expect(pop).toHaveCount(0);

    await detail.locator('[data-hearth-target="torrent:remove"]').click();
    await approve(page, /keeping its downloaded data on disk/);
    await expect(panel.getByTestId("qb-torrent").filter({ hasText: "Ubuntu" })).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
