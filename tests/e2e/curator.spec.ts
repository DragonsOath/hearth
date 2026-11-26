import { expect, test, type APIRequestContext } from "@playwright/test";

// Curator, Discover (checklist 48.1; named Recommend until 11-09), against the sample Seerr (port 5055) and the scripted
// stand-in for Ember: it suggests Harbor Lights (not requested), Ember Lake (in the library),
// The Long Road (already being fetched) and one title that doesn't exist.

async function seerrFor(request: APIRequestContext, run: string) {
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.8`;
  await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
  const res = await request.post("/api/services", {
    data: { name: `Seerr ${run}`, kind: "web", address: `http://${host}:5055`, category: "Media" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const key = await request.post("/api/vault/secrets", {
    data: {
      name: `Seerr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: `e2e-recommend-${run}`,
    },
  });
  expect(key.ok(), await key.text()).toBe(true);
  return id;
}

test("Curator: Ember suggests, what you have is hidden, and a request is one approval", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const id = await seerrFor(request, `${testInfo.project.name}${Date.now() % 100000}`);
  // The scripted stand-in for Ember (no real AI is used).
  await request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:curator")}`);
    const panel = page.getByTestId("recommend-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });

    await panel.getByTestId("recommend-kind-movie").click();
    await panel.getByTestId("recommend-interest").fill("quiet coastal dramas");
    // A year is typed one digit at a time (it used to vanish until it had four).
    const from = panel.getByTestId("recommend-from");
    await from.pressSequentially("1980");
    await expect(from).toHaveValue("1980");
    await from.fill("");
    await panel.getByRole("button", { name: "Drama" }).click();
    await panel.getByTestId("recommend-find").click();

    // Only what you don't have: Harbor Lights to request, The Long Road already on its way.
    const items = panel.getByTestId("recommend-item");
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    const harbor = items.filter({ hasText: "Harbor Lights" });
    await expect(harbor).toContainText("A quiet coastal story");
    await expect(
      items.filter({ hasText: "The Long Road" }).getByTestId("recommend-requested"),
    ).toBeVisible();
    // Said, never silent: what was hidden and what couldn't be found.
    await expect(panel.getByTestId("recommend-owned")).toContainText("Ember Lake");
    await expect(panel).toContainText("A Film Nobody Made");

    // Rows like Plex (11-24): what's missing in its own row, posters you tap.
    await expect(panel.getByTestId("recommend-row-missing")).toContainText(
      "Missing from your collection",
    );
    await expect(panel.getByTestId("recommend-row-have")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/curator-rows.png`,
    });
    // A poster opens the title's full page, as in Seerr's Discover: its trailer, and Request.
    await harbor.getByTestId("recommend-open-title").click();
    const sheet = page.getByTestId("discover-title");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId("trailer-link")).toHaveAttribute("data-trailer", "harborTrl01", {
      timeout: 15_000,
    });
    await sheet.getByTestId("discover-request-open").click();
    await sheet
      .getByTestId("discover-request")
      .getByRole("button", { name: "Request", exact: true })
      .click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toContainText("Harbor Lights", { timeout: 15_000 });
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/Done|verified|finished|Requested/, { timeout: 30_000 });
    await pop.getByTestId("approve-here-close").click();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(panel.getByTestId("recommend-more")).toBeVisible();
    // See all (11-25): every title of the row on one screen, posters you tap, More like these.
    await panel.getByTestId("recommend-row-missing").getByTestId("recommend-see-all").click();
    const all = page.getByTestId("recommend-all");
    await expect(all.getByTestId("recommend-item")).toHaveCount(2);
    await expect(all.getByTestId("recommend-all-more")).toBeVisible();
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/curator-see-all.png`,
    });
    await all
      .getByTestId("recommend-item")
      .filter({ hasText: "The Long Road" })
      .getByTestId("recommend-open-title")
      .click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await page
      .getByRole("dialog", { name: "Missing from your collection" })
      .getByRole("button", { name: "Close" })
      .click();
    await expect(all).toHaveCount(0);
    // Think outside the box: Ember's nearby picks carry Ember thinking beside the title (11-24).
    await panel.getByTestId("recommend-wide").getByRole("checkbox").check();
    await panel.getByTestId("recommend-find").click();
    await expect(
      items.filter({ hasText: "The Long Road" }).getByTestId("recommend-outside"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      items.filter({ hasText: "Harbor Lights" }).getByTestId("recommend-outside"),
    ).toHaveCount(0);
  } finally {
    // Tests share one Hearth: leave no AI connected for the next file.
    await request.post("/api/agent/disconnect", { data: {} });
    await request.post(`/api/services/${id}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { media: { reset: true } } });
  }
});

async function plexFor(request: APIRequestContext, run: string) {
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.31`;
  const res = await request.post("/api/services", {
    data: { name: `Plex: ${run}`, kind: "web", address: `http://${host}:32400`, category: "Media" },
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
      value: `e2e-recommend-plex-${run}`,
    },
  });
  return id;
}

test("Curator: Both shows what you have; Seen it asks how it was, and only offers to mark it watched and rate it", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const seerr = await seerrFor(request, run);
  const plex = await plexFor(request, run);
  await request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:curator")}`);
    const panel = page.getByTestId("recommend-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByTestId("recommend-interest").fill("quiet coastal dramas");
    await panel.getByTestId("recommend-show-both").click();
    await panel.getByTestId("recommend-find").click();

    // Both: Ember Lake is in your library, shown and marked instead of hidden.
    const items = panel.getByTestId("recommend-item");
    await expect(items).toHaveCount(3, { timeout: 30_000 });
    const lake = items.filter({ hasText: "Ember Lake" });
    await expect(lake.getByTestId("recommend-have")).toBeVisible();
    await expect(panel.getByTestId("recommend-owned")).toHaveCount(0);
    // Two rows: missing from your collection, and in your library (11-24).
    await expect(panel.getByTestId("recommend-row-missing")).toContainText("The Long Road");
    await expect(panel.getByTestId("recommend-row-have")).toContainText("Ember Lake");
    // One you have opens with Watch on Plex, not Request.
    await lake.getByTestId("recommend-open-title").click();
    const sheet = page.getByTestId("discover-title");
    await expect(sheet.getByTestId("discover-status").first()).toHaveText(
      /in your library|available/i,
      {
        timeout: 15_000,
      },
    );
    const watch = sheet.getByTestId("watch-link");
    await expect(watch).toContainText("Watch on Plex", { timeout: 20_000 });
    await expect(watch).toHaveAttribute(
      "href",
      /^https:\/\/app\.plex\.tv\/desktop\/#!\/server\/sample-plex-machine\/details\?key=%2Flibrary%2Fmetadata%2F103$/,
    );
    await expect(sheet.getByTestId("discover-request-open")).toHaveCount(0);
    await sheet.screenshot({
      path: `test-results/screens/${testInfo.project.name}/curator-watch.png`,
    });
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);

    // Seen it on a title you don't have: gone, and Undo brings it back.
    const road = items.filter({ hasText: "The Long Road" });
    // Seen it sits in the title page now (11-24), with the same "How was it?".
    await road.getByTestId("recommend-open-title").click();
    await sheet.getByTestId("recommend-seen").click();
    // "How was it?" is all optional: Skip just takes it off.
    await sheet.getByTestId("recommend-rate-skip").click();
    await expect(sheet).toHaveCount(0);
    await expect(items).toHaveCount(2);
    await panel.getByTestId("recommend-seen-undo").click();
    await expect(items).toHaveCount(3);

    // Seen it, rated, on one that's on Plex and unwatched: nothing changes on Plex until you
    // approve, and then it is marked watched and gets your stars, in one approval.
    await lake.getByTestId("recommend-open-title").click();
    await sheet.getByTestId("recommend-seen").click();
    await sheet.getByTestId("recommend-star-4").click();
    await sheet.getByTestId("recommend-reaction-loved").click();
    await sheet.getByTestId("recommend-note-text").fill("Creepy in the best way.");
    await sheet.getByTestId("recommend-rate-save").click();
    await expect(items).toHaveCount(2);
    const bar = panel.getByTestId("recommend-mark-watched");
    await expect(bar).toContainText("Ember Lake (2026)", { timeout: 20_000 });
    await expect(bar).toContainText("put your rating");
    await expect(bar).toContainText(`Plex: ${run}`);
    await expect(page.getByTestId("approve-here")).toHaveCount(0);
    await bar.getByTestId("recommend-mark-watched-yes").click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toContainText("Ember Lake", { timeout: 20_000 });
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/Done|verified|finished/, { timeout: 30_000 });
    await pop.getByTestId("approve-here-close").click();
    await expect(bar).toHaveCount(0);

    // Seen is remembered: asked again, Ember Lake isn't suggested.
    await panel.getByTestId("recommend-find").click();
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    await expect(items.filter({ hasText: "Ember Lake" })).toHaveCount(0);
  } finally {
    await request.post("/api/agent/disconnect", { data: {} });
    for (const title of ["Ember Lake", "The Long Road"])
      await request.post("/api/recommend/unseen", { data: { kind: "movie", title } });
    await request.post(`/api/services/${plex}/remove`, { data: {} });
    await request.post(`/api/services/${seerr}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true, media: { reset: true } } });
  }
});

test("Curator in a Forge pick sheet: finds ones you don't have, checks your Plex, and a requested one joins the row when it arrives", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const seerr = await seerrFor(request, run);
  const plex = await plexFor(request, run);
  await request.post("/api/agent/providers/claude-code/connect", { data: {} });
  let wsId: string | undefined;
  try {
    const { conversationId } = (await (
      await request.post("/api/agent/conversations", {
        data: { text: `pick a test collection of 5 from 4 on plex ${plex}`, wait: 20 },
      })
    ).json()) as { conversationId: string };
    for (let i = 0; i < 40 && !wsId; i++) {
      const all = (await (await request.get("/api/workspaces?kind=temporary")).json()) as {
        id: string;
        conversationId?: string;
      }[];
      wsId = all.find((w) => w.conversationId === conversationId)?.id;
      if (!wsId) await page.waitForTimeout(500);
    }
    await page.goto(`/?panels=workspace:${wsId}`);
    const panel = page.getByTestId("workspace-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // Short of the target: Curator says so, and finds titles the library doesn't have.
    const curator = panel.getByTestId("pick-curator");
    await expect(curator).toContainText("Your library has 4 of 5");
    // Think outside the box (11-10): tick it and Curator says it's on it.
    await curator.getByTestId("pick-curator-wide").locator("input").check();
    await expect(curator.getByTestId("pick-curator-wide-on")).toContainText("On it");
    await curator.getByTestId("pick-curator-find").click();
    const items = curator.getByTestId("pick-curator-item");
    // Harbor Lights and Ember Lake are in this Plex (whatever Seerr says): named, not offered.
    await expect(items).toHaveCount(1, { timeout: 30_000 });
    const owned = curator.getByTestId("pick-curator-owned");
    await expect(owned).toContainText("Ember Lake");
    await expect(owned).toContainText("Harbor Lights");

    // Already requested in Seerr: it only waits, and joins Selected once it is in Plex.
    const road = items.filter({ hasText: "The Long Road" });
    await road.getByTestId("pick-curator-request").click();
    await expect(road).toContainText("Joins when it arrives", { timeout: 20_000 });

    // Seen it takes one off, with Undo right there (11-10); Seen it again stays.
    await road.getByTestId("pick-curator-seen").click();
    const undo = curator.getByTestId("pick-curator-seen-row");
    await expect(undo).toContainText("The Long Road is marked as seen");
    await undo.getByTestId("pick-curator-undo").click();
    await expect(items).toHaveCount(1);
    await items.first().getByTestId("pick-curator-seen").click();
    await expect(items).toHaveCount(0);
    // The arrow in its corner folds the Curator section away, and back.
    await curator.getByTestId("pick-curator-collapse").click();
    await expect(curator.getByTestId("pick-curator-seen-row")).toHaveCount(0);
    await curator.getByTestId("pick-curator-collapse").click();
    await expect(curator.getByTestId("pick-curator-seen-row")).toHaveCount(1);
  } finally {
    await request.post("/api/agent/disconnect", { data: {} });
    await request.post("/api/recommend/unseen", {
      data: { kind: "movie", title: "The Long Road" },
    });
    if (wsId) await request.delete(`/api/workspaces/${wsId}`);
    await request.post(`/api/services/${plex}/remove`, { data: {} });
    await request.post(`/api/services/${seerr}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true, media: { reset: true } } });
  }
});

test("Curator: In my library picks only from what you own, and says what Ember was given", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const seerr = await seerrFor(request, run);
  const plex = await plexFor(request, run);
  await request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:curator")}`);
    const panel = page.getByTestId("recommend-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByTestId("recommend-mode-expand").click();
    await panel.getByTestId("recommend-interest").fill("quiet coastal dramas");
    await panel.getByTestId("recommend-show-have").click();
    await expect(panel.getByTestId("recommend-have-note")).toContainText("names and years");
    await panel.getByTestId("recommend-find").click();
    const items = panel.getByTestId("recommend-item");
    await expect(items).toHaveCount(2, { timeout: 30_000 });
    await expect(
      items.filter({ hasText: "Harbor Lights" }).getByTestId("recommend-have"),
    ).toBeVisible();
    await expect(
      items.filter({ hasText: "Ember Lake" }).getByTestId("recommend-have"),
    ).toBeVisible();
    await expect(panel.getByTestId("recommend-note")).toContainText("in your library");
    // Ember's other picks aren't yours: left out, said so.
    await expect(panel).toContainText("aren't in your library");
  } finally {
    await request.post("/api/agent/disconnect", { data: {} });
    await request.post(`/api/services/${plex}/remove`, { data: {} });
    await request.post(`/api/services/${seerr}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true, media: { reset: true } } });
  }
});
