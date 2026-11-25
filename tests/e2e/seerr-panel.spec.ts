import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels: Seerr's Discover, Issues and People tabs against the stand-in Seerr (port 5055).
// Requests and issue changes go through the real plan, approval and read-back code.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.13`;
};

async function addSeerr(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Seerr ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:5055`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Seerr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-seerr-panel-key",
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

test.describe("the native Seerr panel", () => {
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    id = await addSeerr(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("a hand-built panel offers Request a feature, prefilled for the app", async ({ page }) => {
    // How requests work (11-10): the same board as a full panel request, quietly, on every full panel.
    const panel = await open(page, id, "overview");
    const line = panel.getByTestId("panel-request-feature");
    await expect(line).toBeVisible({ timeout: 20_000 });
    await expect(line).toContainText("Missing something here? Request a feature");
    const links = line.locator("a");
    await expect(links.first()).toHaveAttribute(
      "href",
      /discussions\/new\?category=panel-requests&title=Feature%3A\+Seerr\+/,
    );
    await expect(links.nth(1)).toHaveAttribute("href", /docs\/HOW_REQUESTS_WORK\.md$/);
  });

  test("Discover rows: trending and new posters, details without requesting, hide what I have, search takes over", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "discover");
    const movies = panel.getByTestId("discover-row-trending-movies");
    await expect(movies.getByTestId("discover-card").first()).toBeVisible({ timeout: 20_000 });
    await expect(movies).toContainText("Harbor Lights");
    await expect(
      panel.getByTestId("discover-row-recent-movies").getByTestId("discover-card").first(),
    ).toBeVisible();
    await expect(panel.getByTestId("discover-row-trending-tv")).toContainText("Signal Hill");
    // The hero: the latest movie over its own banner (11-19).
    await expect(panel.getByTestId("discover-hero-title")).toHaveText("Harbor Lights");
    await page.screenshot({ path: "test-results/screens/desktop/seerr-discover.png" });
    // Owned titles say so; Hide what I have takes them out (and is remembered).
    const owned = panel.getByTestId("discover-status").filter({ hasText: "Available" });
    expect(await owned.count()).toBeGreaterThan(0);
    await panel.getByTestId("discover-hide-available").check();
    await expect(owned).toHaveCount(0);
    // A tap opens details; nothing is requested until you ask.
    await movies.getByRole("button", { name: /Harbor Lights/ }).click();
    const sheet = page.getByTestId("discover-title");
    await expect(sheet).toContainText("A lighthouse keeper");
    // Front and center (11-19): tagline, age rating, director, cast, IMDb and Rotten Tomatoes,
    // More like this; the trailer plays right here.
    await expect(sheet).toContainText("The light stays on.");
    await expect(sheet).toContainText("PG-13");
    await expect(sheet.getByTestId("discover-director")).toHaveText("Ines Varga");
    await expect(sheet.getByTestId("discover-cast")).toContainText("Mara Quill");
    await expect(sheet.getByTestId("rating-imdb")).toContainText("7.6");
    await expect(sheet.getByTestId("rating-rt")).toContainText("91%");
    await expect(sheet.getByTestId("rating-rt")).toHaveAttribute(
      "href",
      "https://www.rottentomatoes.com/m/harbor_lights",
    );
    await expect(sheet.getByTestId("discover-more-like")).toContainText("Lantern Coast");
    await expect(sheet.locator('[data-hearth-target="discover:9101:request"]')).toHaveCount(0);
    await sheet.getByTestId("discover-request-open").click();
    await expect(sheet.locator('[data-hearth-target="discover:9101:request"]')).toBeVisible();
    await expect(page.getByTestId("approve-here")).toHaveCount(0);
    await page.screenshot({ path: "test-results/screens/desktop/seerr-title.png" });
    await sheet.getByTestId("trailer-link").click();
    const player = page.getByTestId("trailer-player");
    await expect(player.locator("iframe")).toHaveAttribute(
      "src",
      /youtube-nocookie\.com\/embed\/harborTrl01/,
    );
    await player.getByRole("button", { name: "Close the trailer" }).click();
    await expect(player).toHaveCount(0);
    // More like this opens that title right here.
    await sheet
      .getByTestId("discover-more-like")
      .getByRole("button", { name: /Lantern Coast/ })
      .click();
    await expect(sheet.locator("h2")).toHaveText("Lantern Coast");
    await sheet.getByRole("button", { name: "Close" }).first().click();
    await expect(sheet).toHaveCount(0);
    // See all: the whole list, a page at a time.
    await panel
      .getByTestId("discover-row-trending-tv")
      .getByTestId("discover-see-all-button")
      .click();
    await expect(page.getByTestId("discover-see-all")).toContainText("Signal Hill");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    // A search replaces the rows; clearing it brings them back.
    await panel.locator('[data-hearth-target="discover:search"]').fill("harbor");
    await panel.locator('[data-hearth-target="discover:find"]').click();
    await expect(panel.getByTestId("seerr-result").first()).toBeVisible();
    await expect(panel.getByTestId("discover-rows")).toHaveCount(0);
    await panel.locator('[data-hearth-target="discover:search"]').fill("");
    await expect(panel.getByTestId("discover-rows")).toBeVisible();
    await expect(panel.getByTestId("discover-hide-available")).toBeChecked();
    await page.evaluate(() => localStorage.removeItem("hearth.seerr.hideAvailable"));
  });

  test("Discover: find a film and request it, approved and read back", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "discover");
    await panel.locator('[data-hearth-target="discover:search"]').fill("harbor");
    await panel.locator('[data-hearth-target="discover:find"]').click();
    const film = panel.locator('[data-hearth-target="discover:9101"]');
    await expect(film).toContainText("Harbor Lights");
    await expect(film).toContainText("not requested");
    // Quiet Harbor was already requested: it says so instead of offering a request.
    await expect(panel.locator('[data-hearth-target="discover:9002"]')).toContainText("processing");
    await expect(panel.locator('[data-hearth-target="discover:9002:details"]')).toHaveCount(0);
    // Requesting asks where to save it: Seerr's quality profiles and root folders, defaults first.
    await panel.locator('[data-hearth-target="discover:9101:details"]').click();
    const sheet = page.getByTestId("discover-title");
    await expect(sheet.getByTestId("trailer-link")).toHaveAttribute("data-trailer", "harborTrl01");
    await page.getByTestId("discover-title").getByTestId("discover-request-open").click();
    const folder = sheet.getByTestId("seerr-root-folder");
    await expect(folder).toHaveValue("/movies");
    await expect(folder).toContainText("/movies-archive (850 GB)");
    await expect(sheet.getByTestId("seerr-profile")).toContainText("HD-1080p (Default)");
    await folder.selectOption("/movies-archive");
    await sheet.getByTestId("seerr-profile").selectOption({ label: "Ultra-HD" });
    await sheet.locator('[data-hearth-target="discover:9101:request"]').click();
    await expect(page.getByTestId("approve-here")).toContainText("/movies-archive", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("approve-here")).toContainText("Ultra-HD");
    await approve(page, /Request Harbor Lights \(2019\)/);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    await expect(film).toContainText("processing", { timeout: 15_000 });
  });

  test("on a phone, a drop-down in the request sheet opens Hearth's picker on top", async ({
    page,
  }) => {
    // 11-16, the owner: the root folder and quality drop-downs "won't open". The picker opened
    // behind the sheet (a modal dialog sits above the whole page), so nothing showed.
    test.skip(test.info().project.name !== "mobile", "Touch screens only.");
    const panel = await open(page, id, "discover/harbor");
    await panel.locator('[data-hearth-target="discover:9101:details"]').click();
    await page.getByTestId("discover-title").getByTestId("discover-request-open").click();
    const folder = page.getByTestId("discover-title").getByTestId("seerr-root-folder");
    await folder.evaluate((e) => e.scrollIntoView({ block: "center" }));
    const box = (await folder.boundingBox())!;
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const picker = page.getByRole("dialog", { name: "Root folder" });
    await expect(picker).toBeVisible();
    // Really on top: what a finger would touch at its options is the picker, not the sheet.
    const option = picker.getByRole("option", { name: /\/movies-archive/ });
    const o = (await option.boundingBox())!;
    const onTop = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest("[data-testid='touch-picker']"),
      { x: o.x + o.width / 2, y: o.y + o.height / 2 },
    );
    expect(onTop).toBe(true);
    await option.click();
    await expect(picker).toHaveCount(0);
    await expect(folder).toHaveValue("/movies-archive");
    // The request sheet stays open with the choice.
    await expect(page.getByTestId("discover-title")).toBeVisible();
  });

  test("Discover: a movie Radarr has that Seerr forgot says so, and Tell Seerr you have it fixes it", async ({
    page,
    request,
  }, info) => {
    test.skip(info.project.name === "mobile", "Desk only.");
    // Ember Lake was requested and downloaded, then Seerr forgot it (request removed early).
    await request.post("/api/test/fake-apps", { data: { media: { forget: 9005 } } });
    const radarr = await request.post("/api/services", {
      data: {
        name: `Radarr ${info.project.name}${Date.now() % 100000}`,
        kind: "web",
        address: `http://${uniqueHost()}:7878`,
        category: "Media",
      },
    });
    const radarrId = ((await radarr.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `Radarr ${radarrId} key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: radarrId,
        value: "e2e-radarr-key",
      },
    });
    const panel = await open(page, id, "discover");
    await panel.locator('[data-hearth-target="discover:search"]').fill("ember");
    await panel.locator('[data-hearth-target="discover:find"]').click();
    const film = panel.locator('[data-hearth-target="discover:9005"]');
    await expect(film).toContainText("in your library", { timeout: 15_000 });
    await panel.locator('[data-hearth-target="discover:9005:details"]').click();
    const sheet = page.getByTestId("discover-title");
    const note = sheet.getByTestId("discover-in-library");
    await expect(note).toContainText("Already in your library.");
    await expect(sheet.getByTestId("discover-request-open")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/screens/${info.project.name}/seerr-in-library.png`,
    });
    await note.getByTestId("discover-mark-available").click();
    await approve(page, /Tell Seerr .*Ember Lake \(2026\) is in your library/);
    await expect(sheet.getByTestId("discover-status").first()).toContainText("Available", {
      timeout: 15_000,
    });
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    await request.delete(`/api/services/${radarrId}`);
  });

  test("Discover: Upgrade quality sets a better profile in Radarr and searches, approved once", async ({
    page,
    request,
  }, info) => {
    test.skip(info.project.name === "mobile", "Desk only.");
    // Ember Lake is in the library (Radarr has its file, at WEBDL-720p on HD-1080p).
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    const radarr = await request.post("/api/services", {
      data: {
        name: `Radarr ${info.project.name}${Date.now() % 100000}`,
        kind: "web",
        address: `http://${uniqueHost()}:7878`,
        category: "Media",
      },
    });
    const radarrId = ((await radarr.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `Radarr ${radarrId} key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: radarrId,
        value: "e2e-radarr-key",
      },
    });
    const panel = await open(page, id, "discover");
    await panel.locator('[data-hearth-target="discover:search"]').fill("ember");
    await panel.locator('[data-hearth-target="discover:find"]').click();
    await panel.locator('[data-hearth-target="discover:9005:details"]').click();
    const sheet = page.getByTestId("discover-title");
    await sheet.getByTestId("discover-upgrade-open").click({ timeout: 15_000 });
    const box = sheet.getByTestId("discover-upgrade");
    await expect(box).toContainText("WEBDL-720p");
    const pick = box.getByTestId("discover-upgrade-profile");
    await expect(pick.locator("option")).toHaveText([
      "HD-1080p (now) · up to Bluray-1080p",
      "Ultra-HD · up to Bluray-2160p",
    ]);
    await pick.selectOption({ label: "Ultra-HD · up to Bluray-2160p" });
    await page.screenshot({
      path: `test-results/screens/${info.project.name}/seerr-upgrade.png`,
    });
    await box.getByTestId("discover-upgrade-go").click();
    await approve(page, /Upgrade Ember Lake/);
    const state = (await (await request.get("/api/test/fake-apps")).json()) as {
      movies: { tmdbId: number; profile: number; monitored: boolean; searches: number }[];
    };
    expect(state.movies.find((m) => m.tmdbId === 9005)).toMatchObject({
      profile: 2,
      monitored: true,
      searches: 1,
    });
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    await request.delete(`/api/services/${radarrId}`);
  });

  test("Discover: a show's seasons are chosen before requesting", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "discover/signal");
    await panel.locator('[data-hearth-target="discover:9102:details"]').click();
    const sheet = page.getByTestId("discover-title");
    await page.getByTestId("discover-title").getByTestId("discover-request-open").click();
    const seasons = sheet.getByTestId("seerr-seasons");
    await expect(seasons.locator('[data-hearth-target^="discover:9102:season:"]')).toHaveCount(3);
    await expect(sheet.getByTestId("seerr-root-folder")).toHaveValue("/tv");
    await sheet.locator('[data-hearth-target="discover:9102:season:3"]').uncheck();
    await sheet.locator('[data-hearth-target="discover:9102:request-seasons"]').click();
    await approve(page, /Signal Hill \(2018\),? \(?seasons 1, 2/);
  });

  test("Discover: season packs where seasons are picked, and a pack for this request only", async ({
    page,
    request,
  }, info) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    // Signal Hill not requested yet (the test before this one requests it).
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    // A Sonarr to try the pack in (the Crucible has no TV rows here, so the setting is off).
    const sonarr = await request.post("/api/services", {
      data: {
        name: `Sonarr ${info.project.name}${Date.now() % 100000}`,
        kind: "web",
        address: `http://${uniqueHost()}:8989`,
        category: "Media",
      },
    });
    const sonarrId = ((await sonarr.json()) as { id: string }).id;
    try {
      const panel = await open(page, id, "discover/signal");
      await panel.locator('[data-hearth-target="discover:9102:details"]').click();
      const sheet = page.getByTestId("discover-title");
      await sheet.getByTestId("discover-request-open").click();
      const packs = sheet.getByTestId("season-packs-switch");
      // Off in the Crucible, or not set up yet: either way, this request can try a pack.
      await expect(packs).toContainText("Season packs first", { timeout: 15_000 });
      await packs.getByTestId("season-pack-once").check();
      await sheet.locator('[data-hearth-target="discover:9102:request-seasons"]').click();
      // The plan carries the pack step for Sonarr; sample data has no real Sonarr, so it is
      // turned down, said plainly.
      await expect(sheet.getByTestId("discover-request")).toContainText(
        "Sample data: there is no real Sonarr to change",
        { timeout: 15_000 },
      );
    } finally {
      await request.delete(`/api/services/${sonarrId}`);
    }
  });

  test("Issues: reply to one and resolve it, each approved", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "issues");
    await expect(panel.getByTestId("seerr-issue-row")).toHaveCount(1);
    await expect(panel.getByTestId("seerr-issue-row")).toContainText("Ember Lake");
    await panel.locator('[data-hearth-target="issue:1:open"]').click();
    const issue = panel.getByTestId("seerr-issue");
    await expect(issue.getByTestId("seerr-comments")).toContainText("Subtitles drift");
    await issue
      .locator('[data-hearth-target="issue:comment-text"]')
      .fill("Replacing the file tonight.");
    await issue.locator('[data-hearth-target="issue:comment"]').click();
    await approve(page, /Comment on the issue with Ember Lake/);
    await expect(issue.getByTestId("seerr-comments")).toContainText("Replacing the file tonight.");
    await issue.locator('[data-hearth-target="issue:resolve"]').click();
    await approve(page, /Resolve the issue/);
    await expect(issue).toContainText("Resolved", { timeout: 15_000 });
  });

  test("People lists who can request and their limits", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "people");
    await expect(panel.getByTestId("seerr-user")).toHaveCount(2);
    await expect(panel.getByTestId("seerr-users")).toContainText("5 every 7 days");
  });

  test("on a phone, Discover results fit the screen", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Phone only.");
    // The rows scroll sideways inside the panel, never the page.
    const rows = await open(page, id, "discover");
    await expect(rows.getByTestId("discover-card").first()).toBeVisible({ timeout: 20_000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    const panel = await open(page, id, "discover/harbor");
    await expect(panel.getByTestId("seerr-result").first()).toBeVisible({ timeout: 20_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
