import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Release watch (docs/design/RELEASE_WATCH.md): movies requested in a stand-in Seerr, followed
// against a stand-in Radarr (DC_FAKE_APPS). Each run adds its own Seerr and Radarr and removes
// them afterwards, so it does not depend on what other tests left behind.
// (The file name ends in smoke.spec.ts so the existing test pattern picks it up.)

async function seriousViolations(page: Page) {
  await page.waitForTimeout(300);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

async function addApp(request: APIRequestContext, name: string, address: string) {
  const res = await request.post("/api/services", {
    data: { name, kind: "web", address, category: "Media" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const service = (await res.json()) as { id: string };
  const key = await request.post("/api/vault/secrets", {
    data: {
      name: `${name} test key`,
      kind: "api-key",
      tier: "automation",
      // Diagnostics only, so the panel asks to allow changes first.
      scope: "read",
      serviceId: service.id,
      value: `e2e-${name.replace(/\W/g, "")}-key`,
    },
  });
  expect(key.ok(), await key.text()).toBe(true);
  return service.id;
}

const row = (page: Page, title: string, state?: string) =>
  page
    .getByTestId("watch-row")
    .filter({ hasText: title })
    .and(state ? page.locator(`[data-state="${state}"]`) : page.getByTestId("watch-row"));

test("release watch: requested movies followed on their own, with snooze, dismiss, and date changes", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  // Its own address too: a removed system's address is remembered (Settings, Removed systems).
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.5`;
  const added: string[] = [];
  const request = page.request;
  try {
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    await request.patch("/api/watches/settings", {
      data: {
        enabled: true,
        region: "",
        notify: { dates: true, "out-today": true, problems: true, arrived: true },
      },
    });
    added.push(await addApp(request, `Home Seerr ${run}`, `http://${host}:5055`));
    added.push(await addApp(request, `Home Radarr ${run}`, `http://${host}:7878`));
    expect((await request.post("/api/watches/check", { data: {} })).ok()).toBe(true);

    // Upcoming: each movie where it really stands.
    await page.goto("/releases");
    await expect(page.getByRole("heading", { level: 1, name: "Releases" })).toBeVisible();
    await expect(row(page, "Paper Moons", "downloading")).toContainText("downloading it (40%)");
    await expect(row(page, "Static Bloom", "out-today")).toContainText("Out today");
    await expect(row(page, "The Long Road", "upcoming")).toContainText("announced, from TMDB");
    // A theatrical date is never taken for a digital one.
    await expect(row(page, "Quiet Harbor", "unannounced")).toContainText(
      "No digital release date yet",
    );
    expect(await seriousViolations(page)).toEqual([]);
    await expectNoOverflow(page);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/releases-upcoming.png`,
      fullPage: true,
    });

    // Needs a look: what is in the way, and that it is not certain.
    await page.getByRole("radio", { name: /Needs a look/ }).click();
    await row(page, "Night Signal", "needs-look").click();
    const sheet = page.getByTestId("watch-sheet");
    await expect(sheet).toContainText("may not meet your quality profile");
    await expect(sheet).toContainText("Not certain");
    await expect(sheet.getByRole("link", { name: /Open in Seerr/ })).toHaveAttribute(
      "href",
      `http://${host}:5055/movie/9003`,
    );
    await expect(sheet.getByRole("link", { name: /Ask Ember about it/ })).toHaveAttribute(
      "href",
      /^\/ask\?q=/,
    );
    await expect(page.getByTestId("watch-history")).toContainText("Night Signal needs a look");
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/releases-needs-a-look.png`,
    });

    // Snooze, then stop snoozing.
    await sheet.getByRole("button", { name: "Snooze a day" }).click();
    await expect(sheet.getByRole("button", { name: "Stop snoozing" })).toBeVisible();
    await sheet.getByRole("button", { name: "Stop snoozing" }).click();
    await expect(sheet.getByRole("button", { name: "Snooze a day" })).toBeVisible();

    // Dismiss: listed under Dismissed, and it can be brought back.
    await sheet.getByRole("button", { name: "Dismiss" }).click();
    await expect(sheet.getByRole("button", { name: "Bring back" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: /Dismissed/ }).click();
    await row(page, "Night Signal").first().click();
    await page.getByTestId("watch-sheet").getByRole("button", { name: "Bring back" }).click();
    await expect(
      page.getByTestId("watch-sheet").getByRole("button", { name: "Dismiss" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // The date moves: checked now, it says so in the history.
    await request.post("/api/test/fake-apps", {
      data: { media: { moveDigital: { tmdbId: 9001, days: 19 } } },
    });
    await page.getByRole("radio", { name: /Upcoming/ }).click();
    await row(page, "The Long Road", "upcoming").click();
    await page.getByTestId("watch-sheet").getByRole("button", { name: "Check now" }).click();
    await expect(page.getByTestId("watch-history")).toContainText("release date moved later");
    await page.keyboard.press("Escape");

    // It arrives: listed under Arrived, finished.
    await request.post("/api/test/fake-apps", { data: { media: { arrive: 9001 } } });
    await row(page, "The Long Road", "upcoming").click();
    await page.getByTestId("watch-sheet").getByRole("button", { name: "Check now" }).click();
    await expect(page.getByTestId("watch-sheet")).toContainText("In your library");
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: /Arrived/ }).click();
    await expect(row(page, "The Long Road", "arrived").first()).toBeVisible();
    await expect(row(page, "Ember Lake", "arrived").first()).toBeVisible();

    // What to tell you: each kind can be switched off.
    const arrivedSwitch = page.getByRole("switch", { name: "In your library" });
    await arrivedSwitch.click();
    await expect(arrivedSwitch).toHaveAttribute("aria-checked", "false");
    await arrivedSwitch.click();
    await expect(arrivedSwitch).toHaveAttribute("aria-checked", "true");
    await expectNoOverflow(page);
  } finally {
    for (const id of added) await request.post(`/api/services/${id}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
  }
});

test("Overseerr panel: my requests with posters, digital dates, Radarr folder and status, overdue marked", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.6`;
  const added: string[] = [];
  const request = page.request;
  try {
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    await request.patch("/api/watches/settings", { data: { overdueAfterDays: 2 } });
    const seerr = await addApp(request, `Home Seerr ${run}`, `http://${host}:5055`);
    added.push(seerr);
    added.push(await addApp(request, `Home Radarr ${run}`, `http://${host}:7878`));

    // The threshold is chosen on the Releases page (0 = on the day).
    await page.goto("/releases");
    await page.getByTestId("release-overdue").selectOption("0");
    await expect
      .poll(
        async () =>
          (
            (await (await request.get("/api/watches")).json()) as {
              settings: { overdueAfterDays: number };
            }
          ).settings.overdueAfterDays,
      )
      .toBe(0);
    await request.patch("/api/watches/settings", { data: { overdueAfterDays: 2 } });
    await page.goto(`/?service=${seerr}`);
    const panel = page.getByTestId("seerr-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // Opens on the owner's own requests (Night Signal, Paper Moons, Ember Lake are his).
    await expect(panel.getByRole("radio", { name: /My requests/ })).toBeChecked();
    const card = (title: string) => panel.getByTestId("seerr-movie").filter({ hasText: title });
    await expect(panel.getByTestId("seerr-movie")).toHaveCount(3);

    // Out 5 days ago, monitored, nothing grabbed: overdue, with its real folder and profile.
    await expect(card("Night Signal")).toHaveAttribute("data-overdue", "yes");
    await expect(card("Night Signal").getByTestId("seerr-overdue")).toHaveText(
      "Digital release was 5 days ago. Not grabbed yet.",
    );
    await expect(card("Night Signal").getByTestId("seerr-root")).toHaveText("/movies");
    await expect(card("Night Signal")).toContainText("HD-1080p");
    await expect(panel.getByTestId("seerr-overdue-count")).toHaveText("1");
    // Downloading: not overdue.
    await expect(card("Paper Moons").getByTestId("seerr-stage")).toHaveText("Downloading 40%");
    await expect(card("Ember Lake").getByTestId("seerr-stage")).toHaveText("In your library");

    // Everyone's requests, with who asked; a movie with no digital date says so.
    await panel.getByRole("radio", { name: /All requests/ }).click();
    await expect(panel.getByTestId("seerr-movie")).toHaveCount(6);
    await expect(card("Quiet Harbor").getByTestId("seerr-digital")).toHaveText("Not announced");
    await expect(card("Quiet Harbor")).toContainText("by Alex");
    await expect(card("The Long Road").getByTestId("seerr-root")).toHaveText("/movies-4k");
    await panel.getByTestId("seerr-filter").selectOption("overdue");
    await expect(panel.getByTestId("seerr-movie")).toHaveCount(1);
    await panel.getByTestId("seerr-filter").selectOption("any");
    await panel.getByTestId("seerr-search-box").fill("harbor");
    await expect(panel.getByTestId("seerr-movie")).toHaveCount(1);

    // (The warning clearing when the movie arrives is covered by seerr-live.test.ts: the fake
    // apps are shared by the desktop and mobile runs, so this test does not change them.)

    expect(await seriousViolations(page)).toEqual([]);
    await expectNoOverflow(page);
  } finally {
    for (const id of added) await request.post(`/api/services/${id}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    // Opening the panel kept a workspace group: leave none behind for later tests.
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

test("Overseerr panel without its key: says what is missing and connects it through a plan", async ({
  page,
}, testInfo) => {
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.7`;
  const request = page.request;
  const res = await request.post("/api/services", {
    data: {
      name: `Keyless Seerr ${run}`,
      kind: "web",
      address: `http://${host}:5055`,
      category: "Media",
    },
  });
  const seerr = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${seerr}`);
    const box = page.getByTestId("seerr-error");
    await expect(box).toContainText("is not connected to", { timeout: 20_000 });
    await expect(box).toContainText("Ember never sees it");
    await expect(box.getByTestId("seerr-ask-fix")).toBeVisible();
    // Connect proposes the key plan (no settings file here, so Hearth says why instead).
    await box.getByTestId("seerr-connect").click();
    await expect(box).toContainText("settings on this machine");
  } finally {
    await request.post(`/api/services/${seerr}/remove`, { data: {} });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

test("Overseerr panel: approve a request and change a movie's root folder, confirmed in the panel", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.9`;
  const added: string[] = [];
  const request = page.request;
  try {
    await request.post("/api/test/fake-apps", { data: { media: { reset: true, pending: 9002 } } });
    const seerr = await addApp(request, `Home Seerr ${run}`, `http://${host}:5055`);
    added.push(seerr);
    added.push(await addApp(request, `Home Radarr ${run}`, `http://${host}:7878`));
    await page.goto(`/?service=${seerr}`);
    const panel = page.getByTestId("seerr-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByRole("radio", { name: /All requests/ }).click();
    const card = (title: string) => panel.getByTestId("seerr-movie").filter({ hasText: title });

    // The Seerr key was added for reading only: the panel says so and lets the owner allow it.
    await card("Quiet Harbor").getByTestId("seerr-approve").click();
    await expect(card("Quiet Harbor").getByTestId("panel-allow-changes")).toBeVisible();
    await card("Quiet Harbor")
      .getByRole("button", { name: /Allow confirmed changes/ })
      .click();
    await expect(card("Quiet Harbor").getByTestId("panel-allow-changes")).toContainText("Allowed");

    await card("Quiet Harbor").getByTestId("seerr-approve").click();
    const change = card("Quiet Harbor").getByTestId("panel-change");
    await expect(change).toContainText("Approve Alex's request for Quiet Harbor");
    await change.getByTestId("panel-confirm").click();
    await expect(change.getByTestId("panel-done")).toContainText("confirms it", {
      timeout: 20_000,
    });

    // A movie's root folder, from Radarr's own list; the Radarr key is allowed the same way.
    const bloom = card("Static Bloom");
    await bloom.getByTestId("seerr-change-root").click();
    await bloom.getByTestId("seerr-root-choice").selectOption("/new releases");
    await bloom.getByTestId("seerr-root-save").click();
    // Radarr's key was added for reading only too: allowed here, then the change again.
    await bloom.getByRole("button", { name: /Allow confirmed changes/ }).click();
    await expect(bloom.getByTestId("panel-allow-changes")).toContainText("Allowed");
    await bloom.getByTestId("seerr-change-root").click();
    await bloom.getByTestId("seerr-root-choice").selectOption("/new releases");
    await bloom.getByTestId("seerr-root-save").click();
    const moved = bloom.getByTestId("panel-change");
    await expect(moved).toContainText("from /movies to /new releases");
    await moved.getByTestId("panel-confirm").click();
    await expect(moved.getByTestId("panel-done")).toContainText("now goes to /new releases", {
      timeout: 20_000,
    });
    await expect(bloom.getByTestId("seerr-root")).toHaveText("/new releases", { timeout: 20_000 });

    // Stop tracking: one plan removes the request and stops Radarr monitoring it; files stay.
    await bloom.getByTestId("seerr-stop-tracking").click();
    const stop = bloom.getByTestId("panel-change");
    await expect(stop).toContainText("Remove");
    await expect(stop).toContainText("Static Bloom");
    await expect(stop).toContainText("Stop monitoring");
    await stop.getByTestId("panel-confirm").click();
    await expect(card("Static Bloom")).toHaveCount(0, { timeout: 30_000 });
  } finally {
    for (const id of added) await request.post(`/api/services/${id}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

test("Overseerr panel: a show request, Sonarr's state, and Stop tracking that stops Sonarr too", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.11`;
  const added: string[] = [];
  const request = page.request;
  // Keys that may make confirmed changes, so Stop tracking goes straight to its plan.
  const app = async (name: string, port: number) => {
    const res = await request.post("/api/services", {
      data: { name, kind: "web", address: `http://${host}:${port}`, category: "Media" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    added.push(id);
    await request.post("/api/vault/secrets", {
      data: {
        name: `${name} key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: id,
        value: `e2e-${name.replace(/\W/g, "")}-key`,
      },
    });
    return id;
  };
  try {
    await request.post("/api/test/fake-apps", { data: { reset: true, media: { reset: true } } });
    const seerr = await app(`Show Seerr ${run}`, 5055);
    await app(`Show Sonarr ${run}`, 8989);
    await page.goto(`/?service=${seerr}`);
    const panel = page.getByTestId("seerr-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByRole("radio", { name: /All requests/ }).click();
    // All: movies and shows in one list, counted together.
    await expect(panel.getByRole("radio", { name: /^All/ }).first()).toBeChecked();
    await expect(panel.getByTestId("seerr-all").getByTestId("seerr-show")).toHaveCount(1);
    await expect(panel.getByTestId("seerr-all").getByTestId("seerr-movie").first()).toBeVisible();
    await expect(panel.getByText(/\d+ movies?, 1 show/).first()).toBeVisible();
    // A request opens like a title in Discover (details, trailer), saying Requested where
    // Discover says Request.
    const firstMovie = panel.getByTestId("seerr-all").getByTestId("seerr-movie").first();
    await firstMovie.getByTestId("seerr-open-title").click();
    const titleWindow = page.getByTestId("discover-title");
    await expect(titleWindow).toBeVisible();
    await expect(titleWindow.getByTestId("discover-requested")).toBeVisible({ timeout: 15_000 });
    await expect(titleWindow.getByTestId("discover-request-open")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/seerr-request-title.png`,
    });
    await titleWindow.getByRole("button", { name: "Close" }).click();
    await expect(titleWindow).toHaveCount(0);
    // Movies and Shows still work on their own.
    await panel.getByRole("radio", { name: /^Movies/ }).click();
    await expect(panel.getByTestId("seerr-movies").getByTestId("seerr-show")).toHaveCount(0);
    await panel.getByRole("radio", { name: /^Shows/ }).click();
    await expect(panel.getByTestId("seerr-shows").getByTestId("seerr-movie")).toHaveCount(0);
    const show = panel.getByTestId("seerr-show").filter({ hasText: "Ghosts (US)" });
    await expect(show).toContainText("Seasons 1, 2");
    await expect(show).toContainText("requested by Alex");
    await expect(show.getByTestId("seerr-show-sonarr")).toContainText(
      "monitoring it · 30 of 40 episodes on disk",
    );
    // Like a movie: where it stands, the next episode, and the seasons in the library.
    await expect(show.getByTestId("seerr-show-state")).toHaveText("Missing 10 episodes");
    await expect(show.getByTestId("seerr-show-next")).not.toBeEmpty();
    await expect(show.getByTestId("seerr-show-seasons")).toHaveText("2 of 2 seasons");
    await expect(show.getByTestId("seerr-show-complete")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/seerr-show-card.png`,
      fullPage: true,
    });

    // What's Missing: the show's numbers, then each season, read from Sonarr.
    await show.getByTestId("seerr-show-missing").click();
    const missing = page.getByRole("dialog", { name: /^Ghosts \(US\)/ });
    const stats = missing.getByTestId("seerr-completeness-stats");
    await expect(stats).toContainText("Missing10 episodes");
    await expect(stats).toContainText("S03E01");
    const seasons = missing.getByTestId("seerr-season");
    await expect(seasons).toHaveCount(2);
    // Season 2 opens on its own: four on disk, ten missing.
    const s2 = seasons.filter({ hasText: "Season 2" });
    await expect(s2).toContainText("4 of 14 in library");
    await expect(s2).toContainText("10 missing");
    // Season 3 hasn't aired: nothing in it counts as missing.
    const s3 = seasons.filter({ hasText: "Season 3" });
    await expect(s3).toContainText("Not released");
    await s3.locator("summary").click();
    await expect(s3.locator('[data-state="next"]')).toContainText("Next to air");
    await expect(s3.locator('[data-state="unknown"]')).toContainText("Air date unknown");
    await expect(s3.getByTestId("seerr-episode-search")).toHaveCount(0);
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/seerr-whats-missing.png`,
    });

    // Interactive Search for one missing episode: Sonarr's own results for it.
    const e11 = s2.getByTestId("seerr-episode").filter({ hasText: "S02E11" });
    await expect(e11).toHaveAttribute("data-state", "missing");
    await e11.getByTestId("seerr-episode-search").click();
    const search = page.getByRole("dialog", { name: "Interactive search" });
    const releases = search.getByTestId("isearch-release");
    await expect(search.getByTestId("seerr-episode-releases")).toContainText("S02E11");
    await expect(search).toContainText("3 found, 1 Sonarr would take on its own");
    await search.getByRole("button", { name: /Show all 3/ }).click();
    await expect(releases).toHaveCount(3);
    const best = releases.filter({ hasText: "1080p.WEB-DL" });
    await expect(best.getByTestId("isearch-details")).toContainText("1080p");
    await expect(best.getByTestId("isearch-details")).toContainText("WEB-DL");
    await expect(best.getByTestId("isearch-details")).toContainText("H.264");
    await expect(best.getByTestId("isearch-details")).toContainText("DD+ 5.1");
    // Over the size limit: the rule in plain words, and a one-time exception, explained.
    const big = releases.filter({ hasText: "2160p" });
    await expect(big.getByTestId("isearch-rule")).toContainText(
      "Your rules turned it down: over your size limit",
    );
    await expect(big.getByTestId("isearch-details")).toContainText("Dolby Vision");
    await expect(big.getByTestId("isearch-download")).toHaveText("Download anyway");
    // Blocklisted: no way to download it from here.
    const blocked = releases.filter({ hasText: "HDTV" });
    await expect(blocked).toContainText("on your blocklist");
    await expect(blocked.getByTestId("isearch-download")).toHaveCount(0);
    await big.getByTestId("isearch-download").click();
    await expect(big.getByTestId("isearch-exception")).toContainText("A one-time exception");
    await expect(big.getByTestId("panel-change")).toContainText(
      "as a one-time exception to your quality rules (over your size limit). Your rules stay as they are",
    );
    // Not approved: changed my mind, nothing is sent.
    await big.getByTestId("panel-change").getByRole("button", { name: "Cancel" }).click();
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/seerr-episode-search.png`,
    });
    // The one the rules accept: picked, approved, and sent to Sonarr.
    await best.getByTestId("isearch-download").click();
    const change = best.getByTestId("panel-change");
    await expect(change).toContainText("Ghosts (US) S02E11");
    await change.getByTestId("panel-confirm").click();
    await expect(change.getByTestId("panel-done")).toContainText("is in the queue", {
      timeout: 30_000,
    });
    await search.getByRole("button", { name: "Close" }).click();
    // Back in What's Missing, the episode shows as downloading.
    await expect(e11).toHaveAttribute("data-state", "downloading", { timeout: 20_000 });
    await expect(e11).toContainText("Downloading 40%");
    await missing.getByRole("button", { name: "Close" }).first().click();
    await show.getByTestId("seerr-stop-tracking").click();
    const stop = show.getByTestId("panel-change");
    await expect(stop).toContainText("Ghosts (US)");
    await expect(stop).toContainText("Stop monitoring Ghosts (US)");
    await stop.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("seerr-show")).toHaveCount(0, { timeout: 30_000 });
  } finally {
    for (const id of added) await request.post(`/api/services/${id}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true, media: { reset: true } } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

test("Overseerr panel: a movie Radarr has but is not monitoring gets Monitor, and Radarr looks for it again", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  // Desktop only: the phone runs the same code, and two runs at once would share the stand-in Seerr.
  test.skip(testInfo.project.name === "mobile", "Same code on a phone; checked on desktop.");
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.12`;
  const added: string[] = [];
  const request = page.request;
  const app = async (name: string, port: number) => {
    const res = await request.post("/api/services", {
      data: { name, kind: "web", address: `http://${host}:${port}`, category: "Media" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    added.push(id);
    await request.post("/api/vault/secrets", {
      data: {
        name: `${name} key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: id,
        value: `e2e-${name.replace(/\W/g, "")}-key`,
      },
    });
    return id;
  };
  try {
    await request.post("/api/test/fake-apps", {
      data: { media: { reset: true, unmonitor: 9006 } },
    });
    const seerr = await app(`Monitor Seerr ${run}`, 5055);
    await app(`Monitor Radarr ${run}`, 7878);
    await page.goto(`/?service=${seerr}`);
    const panel = page.getByTestId("seerr-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByRole("radio", { name: /All requests/ }).click();
    const bloom = panel.getByTestId("seerr-movie").filter({ hasText: "Static Bloom" });
    await expect(bloom).toContainText(/not monitored/i);
    // A movie that Radarr is monitoring has no Monitor button.
    await expect(
      panel
        .getByTestId("seerr-movie")
        .filter({ hasText: "Quiet Harbor" })
        .getByTestId("seerr-monitor"),
    ).toHaveCount(0);

    await bloom.getByTestId("seerr-monitor").click();
    const change = bloom.getByTestId("panel-change");
    await expect(change).toContainText("Monitor Static Bloom");
    await change.getByTestId("panel-confirm").click();
    await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 20_000 });
    await expect(bloom.getByTestId("seerr-monitor")).toHaveCount(0, { timeout: 20_000 });
    await expect(bloom).not.toContainText(/not monitored/i);
  } finally {
    for (const id of added) await request.post(`/api/services/${id}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
