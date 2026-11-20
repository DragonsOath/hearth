import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Sorting manual downloads (the owner, 2026-11-07) in qBittorrent's Manual downloads tab, against
// the stand-in qBittorrent (8090) and Radarr (7879): one setup plan, then torrents added by hand are
// sorted by their files and handed to Radarr; an unclear one waits for you to say what it is.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.23`;
};

async function add(request: APIRequestContext, name: string, port: number, secret: object) {
  const res = await request.post("/api/services", {
    data: { name, kind: "web", address: `http://${uniqueHost()}:${port}`, category: "Downloads" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `${name} key`,
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      ...secret,
    },
  });
  return id;
}

async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(/Done|verified|finished/, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

test("manual downloads: set up once, then sorted, handed to Radarr, and the unclear one filed by you", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  // Two torrents finished, added by hand: a film and an unclear pack.
  await request.post("/api/test/fake-apps", { data: { manualTorrents: true } });
  const run = `${info.project.name}${Date.now() % 100000}`;
  await add(request, `Radarr ${run}`, 7879, { kind: "api-key", value: "e2e-7879-key" });
  const id = await add(request, `qBittorrent ${run}`, 8090, {
    kind: "login",
    username: "hearth",
    value: "e2e-qbt-login",
  });
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@sort`)}`);
  const tab = page.getByTestId("qb-sort");
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(tab).toContainText("Sort what you add by hand");
  await expect(tab.getByTestId("qb-sort-type-movie")).toContainText("manual-movies");
  await expect(tab.getByTestId("qb-sort-type-movie")).toContainText("Radarr");
  expect(
    (await new AxeBuilder({ page }).include('[data-testid="qb-sort"]').analyze()).violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    ),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/manual-sort-setup.png`,
    fullPage: true,
  });

  // The phone checks the layout only: both runs share one stand-in qBittorrent, so only one of
  // them can sort its torrents.
  if (info.project.name === "mobile") {
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    return;
  }
  await tab.getByLabel(/Also sort the \d+ finished manual torrents? already there/).check();
  await tab.getByTestId("qb-sort-review").click();
  await approve(page, /Sort manual downloads/);
  await expect(tab.getByTestId("qb-sort-state")).toContainText("Sorting is on");

  // Check now: sorted into their categories; again: the film is handed to Radarr.
  const history = tab.getByTestId("qb-sort-history");
  await expect(async () => {
    await tab.getByTestId("qb-sort-check").click();
    await expect(
      history.getByTestId("qb-sort-row").filter({ hasText: "Orchard.Keeper" }),
    ).toContainText(/Importing|Done/, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(history).toContainText("Radarr");
  const waiting = tab.getByTestId("qb-sort-unsorted");
  await expect(waiting).toContainText("Mystery Pack");
  await expect(waiting).toContainText("Several videos of a similar size");
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/manual-sort-history.png`,
    fullPage: true,
  });

  // You say what it is.
  await waiting.getByLabel("What is Mystery Pack?").selectOption("movie");
  await waiting.getByRole("button", { name: "File it" }).click();
  await approve(page, /File "Mystery Pack" as movie/);
  await expect(tab.getByTestId("qb-sort-unsorted")).toHaveCount(0);
  await expect(
    history.getByTestId("qb-sort-row").filter({ hasText: "Mystery Pack" }),
  ).toContainText("Movie");

  // Undo puts the film back, never sorted again.
  await history
    .getByTestId("qb-sort-row")
    .filter({ hasText: "Orchard.Keeper" })
    .getByRole("button", { name: "Undo" })
    .click();
  await approve(page, /back unsorted/);
  await expect(
    history.getByTestId("qb-sort-row").filter({ hasText: "Orchard.Keeper" }),
  ).toContainText("Undone");
});
