import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Home rows, the editor (11-07, from the mockup the owner chose), against the stand-in Plex (port
// 32400). Your Home on one side (Plex's rows in order, with posters), Add a row on the other:
// Plex's own rows, every collection, Ember's walkthrough for a row or a collection. Changes
// collect in a bar; one Send is one plan you approve. Ember's own plans show up live.

async function plexFor(request: APIRequestContext, run: string, last: number) {
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${last}`;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
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
      value: `e2e-home-rows-${last}`,
    },
  });
  return id;
}

async function cleanUp(request: APIRequestContext, id: string) {
  for (const r of (await (await request.get(`/api/home-rows?serviceId=${id}`)).json()) as {
    id: string;
  }[])
    await request.delete(`/api/home-rows/${r.id}`);
  await request.post(`/api/services/${id}/remove`, { data: {} });
  await request.post("/api/test/fake-apps", { data: { reset: true } });
}

/** On a narrow panel, Home and Add are two tabs. */
async function side(page: Page, which: "home" | "add") {
  const tab = page.getByTestId(`home-rows-tab-${which}`);
  if (await tab.isVisible()) await tab.click();
}

test("Home rows: add Plex's own row and a collection, take one off, send it in one plan; Ember walks you through", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const request = page.request;
  const id = await plexFor(request, `${testInfo.project.name}${Date.now() % 100000}`, 26);
  try {
    // The way in: the Plex panel's Manage tab.
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@manage`)}`);
    const link = page.getByTestId("plex-home-rows");
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    const panel = page.getByTestId("home-rows-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const home = panel.getByTestId("home-rows-home");
    // One library of each kind: nothing to share, so no Home screen setup.
    await expect(home.getByTestId("home-rows-setup")).toHaveCount(0);
    const movies = home.getByTestId("home-rows-library").filter({ hasText: "Movies" });
    await expect(movies.getByTestId("home-row").first()).toBeVisible({ timeout: 20_000 });
    // Plex's own Continue Watching first, fixed: never a row under a library (11-11).
    await expect(home.getByTestId("home-rows-continue")).toContainText("Continue Watching");
    await expect(home.getByTestId("home-row").filter({ hasText: "Continue Watching" })).toHaveCount(
      0,
    );
    await home.getByRole("button", { name: "Move the TV Shows library up" }).click();
    await expect(home.getByTestId("home-rows-library").first()).toContainText("TV Shows");
    await home.getByRole("button", { name: "Move the Movies library up" }).click();
    await expect(home.getByTestId("home-rows-library").first()).toContainText("Movies");
    // Posters, as Home shows them.
    await expect(
      movies.getByTestId("home-row").first().getByTestId("row-poster").first(),
    ).toBeVisible();

    // Plex's own row: Recently Released, from Movies.
    await side(page, "add");
    const add = panel.getByTestId("home-rows-add");
    await add
      .getByTestId("home-rows-quick")
      .getByRole("button", { name: "Recently Released" })
      .click();
    await add.getByRole("button", { name: "Movies", exact: true }).click();
    await side(page, "home");
    await expect(movies.getByTestId("home-row").first()).toContainText("Recently Released Movies");
    await expect(movies.getByTestId("home-row").first()).toContainText("NEW");
    const bar = panel.getByTestId("home-rows-bar");
    await expect(bar).toContainText("1");

    // A collection that has never been a row: Harbor Classics.
    await side(page, "add");
    await add.getByTestId("home-rows-collection").selectOption({ label: "Harbor Classics (2)" });
    await add.getByTestId("home-rows-collection-add").click();
    await side(page, "home");
    await expect(movies.getByTestId("home-row").first()).toContainText("Harbor Classics");
    await expect(movies.getByTestId("home-row").first().getByTestId("row-poster")).toHaveCount(2);

    // Take one off, and put the collection after Recently Released.
    await movies.getByRole("button", { name: "Take Recently Added Movies off Home" }).click();
    await expect(home).toContainText("Taken off:");
    await movies.getByRole("button", { name: "Move Harbor Classics down" }).click();
    await expect(bar).toContainText("4");
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/home-rows-editor.png`,
    });

    // One Send: what changes first, then Plex.
    await bar.getByTestId("home-rows-send").click();
    const review = panel.getByTestId("home-rows-review");
    await expect(review.getByTestId("home-rows-plan")).toContainText("Harbor Classics", {
      timeout: 15_000,
    });
    await expect(review.getByTestId("home-rows-plan")).toContainText(
      "after “Recently Released Movies” in Movies",
    );
    await review.getByTestId("panel-confirm").click();
    await expect(panel.getByText("Sent. Your Plex Home now looks like this.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(bar).toHaveCount(0);
    // Read back from Plex: the order and places as sent.
    await expect(movies.getByTestId("home-row").nth(0)).toContainText("Recently Released Movies", {
      timeout: 15_000,
    });
    await expect(movies.getByTestId("home-row").nth(1)).toContainText("Harbor Classics");
    await expect(movies).not.toContainText("Recently Added Movies");

    // One title into a hand-kept collection, right here (11-10: Anna and the Apocalypse).
    const harbor = movies.getByTestId("home-row").nth(1);
    await harbor.getByTestId("home-row-add-title").click();
    await harbor.getByTestId("add-title-search").fill("ember");
    await harbor.getByTestId("add-title-pick").filter({ hasText: "Ember Lake" }).click();
    await expect(harbor.getByTestId("panel-change")).toContainText("Ember Lake", {
      timeout: 15_000,
    });
    await harbor.getByTestId("panel-confirm").click();
    await expect(harbor.getByTestId("panel-done")).toContainText("Ember Lake", {
      timeout: 20_000,
    });

    // Rename the row right here (11-19): one approved plan renames the collection on Plex.
    const rename = harbor.getByTestId("home-row-rename");
    await rename.getByLabel("Row name").fill("Harbor Nights");
    await rename.getByRole("button", { name: "Rename" }).click();
    await expect(rename.getByTestId("panel-change")).toContainText("Harbor Nights", {
      timeout: 15_000,
    });
    await harbor.screenshot({
      path: `test-results/screens/${testInfo.project.name}/home-rows-rename.png`,
    });
    await rename.getByTestId("panel-confirm").click();
    await expect(rename.getByTestId("panel-done")).toBeVisible({ timeout: 20_000 });
    await expect(movies.getByTestId("home-row").nth(1).locator("h5")).toHaveText("Harbor Nights", {
      timeout: 15_000,
    });

    const axe = await new AxeBuilder({ page })
      .include('[data-testid="home-rows-panel"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(
      axe.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    ).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // Ember's walkthrough for a collection: a few questions, then one request to Ember.
    await side(page, "add");
    await add.getByTestId("home-rows-collection-go").click();
    const walk = add.getByTestId("home-rows-walkthrough");
    await expect(walk.getByTestId("home-rows-question")).toContainText(
      "What should the collection be?",
    );
    await walk.getByTestId("home-rows-theme").fill("Rainy day movies");
    await walk.getByRole("button", { name: "Next" }).click();
    await expect(walk.getByTestId("home-rows-question")).toContainText("About how many titles?");
    await walk.getByRole("button", { name: "25" }).click();
    await walk.getByRole("button", { name: "Movies" }).click();
    await expect(walk.getByTestId("home-rows-question")).toContainText(
      "Put it on your Home screen too",
    );
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/home-rows-walkthrough.png`,
    });
    await walk.getByRole("button", { name: "Just the collection" }).click();
    await expect(walk.getByTestId("home-rows-question")).toContainText("in the Forge");
    await expect(
      page.getByText(/Make me a collection on Plex .*Rainy day movies.*Collection only/).first(),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await cleanUp(request, id);
  }
});

test("Merge rows on Home: Recently Added and Recently Released are separate choices, rows change at once, one Save to Plex", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const request = page.request;
  const id = await plexFor(request, `${testInfo.project.name}${Date.now() % 100000}`, 27);
  try {
    // A second movie library, as on the owner's Plex: New Releases.
    await request.post("/api/test/fake-apps", { data: { plexNewReleases: true } });
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@manage`)}`);
    await page.getByTestId("plex-home-rows").click({ timeout: 20_000 });
    const panel = page.getByTestId("home-rows-panel");
    const home = panel.getByTestId("home-rows-home");
    const setup = home.getByTestId("home-rows-setup");
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 1440, height: 2000 });
      await panel.getByRole("button", { name: "Expand panel" }).click();
    }
    const lib = (name: string) =>
      home.getByTestId("home-rows-library").filter({
        has: page.getByRole("heading", { name, exact: true }),
      });
    const movies = setup.locator('[data-testid="home-rows-setup-kind"][data-kind="movie"]');
    // One show library: nothing to merge there.
    await expect(setup.getByTestId("home-rows-setup-kind")).toHaveCount(1, { timeout: 20_000 });
    // The arrow folds the card to one line, and unfolds it again.
    await setup.getByTestId("home-rows-setup-toggle").click();
    await expect(setup.getByTestId("home-rows-setup-kind")).toHaveCount(0);
    await expect(setup.getByTestId("home-rows-setup-summary")).toContainText(
      "Movies: separate row for each library",
    );
    await setup.getByTestId("home-rows-setup-toggle").click();
    await expect(setup.getByTestId("home-rows-setup-kind")).toHaveCount(1);
    await expect(movies.getByTestId("home-rows-setup-status")).toHaveText("Saved in Plex");
    await expect(movies.getByTestId("home-rows-setup-menu")).toContainText("None");
    await expect(lib("New Releases")).toBeVisible();
    const added = setup.locator('[data-testid="home-rows-setup-added"][data-kind="movie"]');
    const choice = (name: string) =>
      added.getByTestId("home-rows-setup-added-choice").filter({ hasText: name });
    await expect(choice("Separate row for each library")).toHaveAttribute("aria-checked", "true");
    await expect(added.getByTestId("home-rows-setup-status")).toHaveText("Saved in Plex");

    // Open the list, tap Movies and New Releases: both light up; New Releases leaves Home at once.
    await movies.getByTestId("home-rows-setup-menu").click();
    const pick = (name: string) =>
      movies.getByTestId("home-rows-setup-lib").filter({ hasText: name });
    await pick("Movies").click();
    await expect(pick("Movies")).toHaveAttribute("aria-pressed", "true");
    await pick("New Releases").click();
    await expect(pick("New Releases")).toHaveAttribute("aria-pressed", "true");
    await expect(movies.getByTestId("home-rows-setup-menu")).toContainText(
      "Movies and New Releases",
    );
    await expect(movies.getByTestId("home-rows-setup-status")).toHaveText("Changed, not saved yet");
    await expect(lib("New Releases")).toHaveCount(0);
    await expect(lib("Movies")).toContainText("Recently Released Movies");
    // Tap again: out, and back on Home; tap once more to merge it.
    await pick("New Releases").click();
    await expect(pick("New Releases")).toHaveAttribute("aria-pressed", "false");
    await expect(lib("New Releases")).toBeVisible();
    await pick("New Releases").click();
    await expect(lib("New Releases")).toHaveCount(0);
    // Recently Added is its own choice: merged too, and back.
    await choice("One merged row").click();
    await expect(choice("One merged row")).toHaveAttribute("aria-checked", "true");
    await expect(added.getByTestId("home-rows-setup-status")).toHaveText("Changed, not saved yet");
    await choice("Separate row for each library").click();
    await expect(added.getByTestId("home-rows-setup-status")).toHaveText("Saved in Plex");
    await choice("One merged row").click();
    await setup.screenshot({
      path: `test-results/screens/${testInfo.project.name}/home-rows-setup.png`,
    });

    // One Save to Plex: the merge, read back.
    await panel.getByTestId("home-rows-send").click();
    const review = panel.getByTestId("home-rows-review");
    await expect(review.getByTestId("home-rows-plan")).toContainText(
      "Where New Releases showsSidebar, Home and search → Sidebar only",
      { timeout: 15_000 },
    );
    await expect(review.getByTestId("home-rows-plan")).toContainText(
      "Merge Recently Added Itemsoff → on",
    );
    await review.getByTestId("panel-confirm").click();
    await expect(panel.getByText("Sent. Your Plex Home now looks like this.")).toBeVisible({
      timeout: 45_000,
    });
    await expect(movies.getByTestId("home-rows-setup-status")).toHaveText("Saved in Plex", {
      timeout: 15_000,
    });
    await expect(movies).toContainText(
      "In Plex now: Movies and New Releases merged, rows under Movies.",
    );
    await expect(added.getByTestId("home-rows-setup-status")).toHaveText("Saved in Plex");
    await expect(added).toContainText("In Plex now: one merged row.");
    await expect(lib("New Releases")).toHaveCount(0);
    await setup.screenshot({
      path: `test-results/screens/${testInfo.project.name}/home-rows-setup-saved.png`,
    });

    // Rows show under New Releases instead, and back again (11-11: "toggle back and forth"):
    // one step each time, never locked.
    for (const [to, from] of [
      ["New Releases", "Movies"],
      ["Movies", "New Releases"],
    ] as const) {
      await movies.getByTestId("home-rows-setup-keeper").selectOption({ label: to });
      await expect(movies.getByTestId("home-rows-setup-move")).toContainText(
        `moves the merged rows from ${from} to ${to} in one step`,
      );
      await expect(movies.getByTestId("home-rows-setup-status")).toHaveText(
        "Changed, not saved yet",
      );
      await panel.getByTestId("home-rows-send").click();
      await expect(review).toContainText(`Show the merged films under ${to} instead of ${from}`, {
        timeout: 15_000,
      });
      await review.getByTestId("panel-confirm").click();
      await expect(movies.getByTestId("home-rows-setup-status")).toHaveText("Saved in Plex", {
        timeout: 45_000,
      });
      await expect(movies).toContainText(`rows under ${to}.`);
    }
  } finally {
    await cleanUp(request, id);
  }
});

test("Home rows: Ember's plan for a movies-and-shows row shows up live to approve", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const id = await plexFor(request, `${testInfo.project.name}${Date.now() % 100000}`, 28);
  try {
    await page.goto(`/?panels=${encodeURIComponent(`tool:home-rows@${id}`)}`);
    const panel = page.getByTestId("home-rows-panel");
    const home = panel.getByTestId("home-rows-home");
    await expect(home).toContainText("Continue Watching", { timeout: 20_000 });
    // As Ember proposes it after the Forge: one step per library, same name.
    const planned = await request.post("/api/jobs", {
      data: {
        title: "Put “Mystery Night” on the Plex home screen",
        reason: "Test",
        steps: ["1", "2"].map((lib) => ({
          kind: "app-plex-control",
          serviceId: id,
          params: {
            op: "home-row-apply",
            row: JSON.stringify({
              name: "Mystery Night",
              libraryId: lib,
              rules: { titles: [lib === "1" ? "102" : "200"] },
            }),
          },
        })),
      },
    });
    expect(planned.status(), await planned.text()).toBeLessThan(300);
    const building = panel.getByTestId("home-rows-building");
    await expect(building).toContainText("Mystery Night", { timeout: 20_000 });
    await building.getByRole("button", { name: /Approve and run/ }).click();
    const libs = home.getByTestId("home-rows-library");
    await expect(libs.filter({ hasText: "Movies" }).getByTestId("home-row").first()).toContainText(
      "Mystery Night",
      { timeout: 30_000 },
    );
    const tv = libs.filter({ hasText: "TV Shows" }).getByTestId("home-row").first();
    await expect(tv).toContainText("Mystery Night");
    await expect(tv).toContainText("Ember");
    await expect(panel.getByTestId("home-rows-building")).toContainText("done, on Plex now");
    // The full editor, side by side, when the panel is wide.
    if (testInfo.project.name === "desktop") {
      await page.setViewportSize({ width: 2100, height: 1200 });
      await expect(panel.getByTestId("home-rows-add")).toBeVisible();
      await expect(panel.getByTestId("home-rows-home")).toBeVisible();
      await page.waitForTimeout(800);
      await page.screenshot({
        path: `test-results/screens/${testInfo.project.name}/home-rows-wide.png`,
      });
    }
  } finally {
    await cleanUp(request, id);
  }
});

test("Saved home screens: save two, switch between them, and undo a switch", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const id = await plexFor(request, `${testInfo.project.name}${Date.now() % 100000}`, 27);
  try {
    await page.goto(`/?panels=${encodeURIComponent(`tool:home-rows@${id}`)}`);
    const panel = page.getByTestId("home-rows-panel");
    const home = panel.getByTestId("home-rows-home");
    const movies = home.getByTestId("home-rows-library").filter({ hasText: "Movies" });
    await expect(home).toContainText("Continue Watching", { timeout: 20_000 });
    await panel.getByTestId("home-rows-saved").locator("summary").click();
    const layouts = panel.getByTestId("home-layouts");
    // The home screen as it is: "Everyday".
    await layouts.getByTestId("home-layout-name").fill("Everyday");
    await layouts.getByTestId("home-layout-save").click();
    await expect(layouts.getByTestId("home-layout").filter({ hasText: "Everyday" })).toContainText(
      "On now",
    );

    // Build another: a row on Home (Ember's plan, approved here), then save it as "Movie night".
    await request.post("/api/jobs", {
      data: {
        title: "Put “Movie Night Picks” on the Plex home screen",
        reason: "Test",
        steps: [
          {
            kind: "app-plex-control",
            serviceId: id,
            params: {
              op: "home-row-apply",
              row: JSON.stringify({
                name: "Movie Night Picks",
                libraryId: "1",
                rules: { titles: ["101", "103"] },
              }),
            },
          },
        ],
      },
    });
    const building = panel.getByTestId("home-rows-building");
    await building.getByRole("button", { name: /Approve and run/ }).click({ timeout: 20_000 });
    await expect(movies.getByTestId("home-row").first()).toContainText("Movie Night Picks", {
      timeout: 30_000,
    });
    await layouts.getByTestId("home-layout-name").fill("Movie night");
    await layouts.getByTestId("home-layout-save").click();
    await expect(layouts.getByTestId("home-layout")).toHaveCount(2);

    // Switch to Everyday: the row is hidden, not deleted.
    const everyday = layouts.getByTestId("home-layout").filter({ hasText: "Everyday" });
    await everyday.getByTestId("home-layout-switch").click();
    await expect(layouts.getByTestId("home-layout-plan")).toContainText("Movie Night Picks", {
      timeout: 15_000,
    });
    await expect(layouts.getByTestId("home-layout-plan")).toContainText("Home → Hidden");
    await layouts.getByTestId("panel-confirm").click();
    await expect(everyday).toContainText("On now", { timeout: 30_000 });
    await expect(movies).not.toContainText("Movie Night Picks", { timeout: 15_000 });

    // Undo the switch: Movie night's screen is back.
    await layouts.getByTestId("home-layout-undo").click();
    await layouts.getByTestId("panel-confirm").click();
    await expect(movies.getByTestId("home-row").first()).toContainText("Movie Night Picks", {
      timeout: 30_000,
    });
    await expect(
      layouts.getByTestId("home-layout").filter({ hasText: "Movie night" }),
    ).toContainText("On now");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    await cleanUp(request, id);
  }
});
