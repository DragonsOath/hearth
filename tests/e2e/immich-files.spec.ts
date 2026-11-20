import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// Files and folders and album tabs in the Immich panel, against the stand-in Immich (port 2283),
// never a real library: the storage template built from choices with a live preview, changed
// through one approved plan, Immich's job moving the files with progress and a spot check; and
// every album as a tab under Photos, with More albums for the rest.

let hosts = (Date.now() + 41_000) % 60_000;
const host = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.27`;
};

async function addImmich(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Immich files ${run}`,
      kind: "web",
      address: `http://${host()}:2283`,
      category: "Files & Photos",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Immich files ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-im-files",
    },
  });
  return id;
}

const device = () => (test.info().project.name === "mobile" ? "mobile" : "desktop");
async function open(page: Page, id: string, tab: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@${tab}`)}`);
  const panel =
    device() === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}
/** What Show & Tell's cursor rule says about a control: "may press", or why not. */
const cursor = (loc: Locator) =>
  loc.evaluate((el) => {
    const h = (
      window as unknown as { __hearthShow?: { whyNotClick: (e: Element) => string | undefined } }
    ).__hearthShow;
    if (!h) return "presenter not loaded";
    return h.whyNotClick(el) ?? "may press";
  });

/** Show & Tell is Premium (11-14 split): its cursor rules are checked only when it is installed. */
const hasPresenter = (page: Page) =>
  page.evaluate(() => Boolean((window as unknown as { __hearthShow?: unknown }).__hearthShow));

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/screens/${device()}/${name}.png` });

async function approve(page: Page, plan: RegExp, done: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(plan);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(done, { timeout: 30_000 });
  return pop;
}

test.describe("Immich: Files and folders, and album tabs", () => {
  test.describe.configure({ mode: "serial" });
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addImmich(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("build a pattern, preview it, approve it, and watch Immich move the files", async ({
    page,
  }) => {
    const panel = await open(page, id, "folders");
    const files = panel.getByTestId("im-files");
    await expect(files.getByTestId("im-files-state")).toHaveText("Storage template: off", {
      timeout: 20_000,
    });
    await expect(files.getByTestId("im-files-explain")).toContainText("whole library");
    await expect(files.getByTestId("im-files-explain")).toContainText("no 001, 002");
    await expect(files.getByTestId("im-files-explain")).toContainText(
      "external library are never moved",
    );
    const first = files.getByTestId("im-files-sample").first();
    await expect(first).toContainText(/Now: upload\//);
    // The preview follows the choices as they change.
    await files.getByTestId("im-files-folder-year").click();
    await expect(first.getByTestId("im-files-after")).toContainText(
      "library/admin/2026/IMG_4100.jpg",
    );
    await files.getByTestId("im-files-folder-album").click();
    await files.getByTestId("im-files-name-date").click();
    await expect(first.getByTestId("im-files-after")).toContainText(
      "library/admin/2026/10/2026-10-30 IMG_4100.jpg",
    );
    // Nothing filed by a dated pattern yet: the preview says it uses UTC, and exactly when that
    // can be a day off.
    await expect(files.getByTestId("im-files-zone")).toContainText("this preview uses UTC");
    // Ember's cursor may try the choices (they only change the preview), never Save.
    if (await hasPresenter(page)) {
      await expect.poll(() => cursor(files.getByTestId("im-files-folder-year"))).toBe("may press");
      await expect
        .poll(() => cursor(files.getByTestId("im-files-name-original")))
        .toBe("may press");
      expect(await cursor(files.getByTestId("im-files-save"))).toMatch(/changes something/);
    }
    await files.scrollIntoViewIfNeeded();
    await shot(page, "immich-files");

    await files.getByTestId("im-files-save").click();
    const pop = await approve(
      page,
      /Name and file every photo[\s\S]*whole library[\s\S]*Storage template[\s\S]*off[\s\S]*\{\{#if album\}\}[\s\S]*storage template job/,
      /read back[\s\S]*started moving/,
    );
    await shot(page, "immich-files-approve");
    await pop.getByTestId("approve-here-close").click();
    await expect(files.getByTestId("im-files-state")).toHaveText("Storage template: on", {
      timeout: 15_000,
    });
    // Immich's job runs, then a few photos are checked where the pattern says.
    await expect(files.getByTestId("im-files-check")).toContainText("Checked: 4 of 4", {
      timeout: 20_000,
    });
    await expect(first).toContainText("Now: library/admin/2026/10/2026-10-30 IMG_4100.jpg");
    // Now Immich has filed photos by date, the time zone is worked out from them.
    await expect(files.getByTestId("im-files-zone")).toContainText(
      "worked out from where it already filed",
    );
    await shot(page, "immich-files-done");
  });

  test("albums are tabs: make one, open it, take a photo out and undo", async ({ page }) => {
    const panel = await open(page, id, "photos");
    const grid = panel.getByTestId("im-photos-grid").getByTestId("im-photo");
    await expect(grid).toHaveCount(60, { timeout: 20_000 });
    await panel.getByTestId("im-select").click();
    await grid.nth(0).getByRole("button").first().click();
    await grid.nth(1).getByRole("button").first().click();
    await panel.getByTestId("im-organize").click();
    const dialog = page.getByTestId("im-organize-dialog");
    await dialog.getByTestId("im-organize-name").fill("Utah Road Trip 2026");
    // The pattern is on: the dialog says what names these photos will get.
    await expect(dialog.getByTestId("im-organize-names")).toContainText(
      "library/admin/Utah Road Trip 2026/2026-10-30 IMG_4100.jpg",
    );
    await expect(dialog.getByTestId("im-organize-files")).toBeVisible();
    await dialog.getByTestId("im-organize-review").click();
    const pop = await approve(page, /Make the album "Utah Road Trip 2026"/, /read back/);
    await pop.getByTestId("approve-here-close").click();
    // Opening the album only shows it: Ember's cursor may press it (and never Undo).
    if (await hasPresenter(page)) {
      expect(await cursor(dialog.getByTestId("im-organize-open"))).toBe("may press");
      expect(await cursor(dialog.getByTestId("im-organize-undo"))).toMatch(/changes something/);
    }
    await dialog.getByTestId("im-organize-open").click();

    // Its tab appears right away and is open, with its two photos.
    const tabs = panel.getByTestId("im-album-tabs");
    await expect(tabs.getByRole("tab", { name: "Utah Road Trip 2026" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(grid).toHaveCount(2, { timeout: 15_000 });
    await shot(page, "immich-album-tab");

    await panel.getByTestId("im-select").click();
    await grid.nth(0).getByRole("button").first().click();
    if (await hasPresenter(page)) {
      expect(await cursor(tabs.getByTestId("im-album-tab").first())).toBe("may press");
      expect(await cursor(tabs.getByTestId("im-album-tab-all"))).toBe("may press");
      expect(await cursor(panel.getByTestId("im-select-remove"))).toMatch(/changes something/);
    }
    await panel.getByTestId("im-select-remove").click();
    const out = await approve(
      page,
      /Take 1 photo out of the album "Utah Road Trip 2026"/,
      /read back/,
    );
    await out.getByTestId("approve-here-close").click();
    await expect(grid).toHaveCount(1, { timeout: 15_000 });
    await panel.getByTestId("im-album-removed-undo").click();
    const back = await approve(page, /Add 1 photo to the album "Utah Road Trip 2026"/, /read back/);
    await back.getByTestId("approve-here-close").click();
    await expect(grid).toHaveCount(2, { timeout: 15_000 });

    // All photos is one tap away.
    await tabs.getByTestId("im-album-tab-all").click();
    await expect.poll(() => grid.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(60);
  });

  test("many albums: newest first on one line, the rest in More albums", async ({
    page,
    request,
  }) => {
    await request.post("/api/test/fake-apps", { data: { immichAlbums: 12 } });
    const panel = await open(page, id, "photos");
    const tabs = panel.getByTestId("im-album-tabs");
    await expect(tabs.getByTestId("im-album-tab").first()).toHaveText("Utah Road Trip 2026", {
      timeout: 20_000,
    });
    // One line: every tab sits at the same height.
    const tops = await tabs
      .getByRole("tab")
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    await tabs.getByTestId("im-album-more").click();
    const more = panel.getByTestId("im-album-more-list");
    await expect(more).toContainText("Album 1");
    // Newest first across the tabs and the menu (as many tabs as fit: fewer on a phone).
    const order = [
      ...(await tabs.getByTestId("im-album-tab").allTextContents()),
      ...(await more
        .getByRole("menuitem")
        .evaluateAll((els) =>
          els.map((e) => (e.getAttribute("aria-label") ?? "").replace(/, \d+ photos$/, "")),
        )),
    ];
    expect(order.slice(0, 3)).toEqual(["Utah Road Trip 2026", "Album 12", "Album 11"]);
    expect(order.at(-1)).toBe("Album 1");
    await shot(page, "immich-album-more");
    if (await hasPresenter(page)) {
      expect(await cursor(tabs.getByTestId("im-album-more"))).toBe("may press");
      expect(await cursor(more.getByRole("menuitem").first())).toBe("may press");
    }
    await more.getByRole("menuitem", { name: "Album 1, 2 photos" }).click();
    // The album picked from the menu gets a visible tab.
    await expect(tabs.getByRole("tab", { name: "Album 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(panel.getByTestId("im-photos-grid").getByTestId("im-photo")).toHaveCount(2, {
      timeout: 15_000,
    });
  });
});
