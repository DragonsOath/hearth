import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels Phase 2 (checklist 46.9): Radarr's own tabs against the stand-in Radarr 6.4
// (port 7879). Every change goes through the real plan, approval, re-reading and read-back code.

/** A test address no earlier service in this run has (Hearth refuses a second one). */
let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.9`;
};

async function addRadarr(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Radarr ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:7879`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Radarr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-7879-key",
    },
  });
  return id;
}

async function open(page: Page, id: string, tab: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@${tab}`)}`);
  // A phone shows one panel on its own; the desk shows it as a desk panel.
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

/** Approves the plan shown in the pop-up and returns what Hearth reported. */
async function approve(page: Page, expectSummary: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(expectSummary);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText("verified", { timeout: 20_000 });
  const text = await pop.innerText();
  await pop.getByTestId("approve-here-close").click();
  return text;
}

test.describe("the native Radarr panel", () => {
  let id = "";
  test.beforeEach(async ({ page }, testInfo) => {
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addRadarr(page.request, `${testInfo.project.name}${Date.now() % 100000}`);
  });

  test("Library lists, searches and filters the movies, and opens one", async ({ page }) => {
    const panel = await open(page, id, "library");
    const rows = panel.getByTestId("radarr-movie-row");
    await expect(rows).toHaveCount(12);
    await panel.locator('[data-hearth-target="library:search"]').fill("glass");
    await expect(rows).toHaveCount(2);
    await panel.locator('[data-hearth-target="library:search"]').fill("");
    await panel.locator('[data-hearth-target="library:filter"]').selectOption("missing");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Glass Meridian");
    await rows.first().click();
    const movie = panel.getByTestId("radarr-movie");
    await expect(movie).toContainText("Glass Meridian");
    await expect(movie).toContainText("No file yet. Radarr is looking for it.");
    // The movie's page is in the address, so a refresh returns to it.
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).searchParams.get("panels") ?? ""))
      .toBe(`service:${id}@library/movie/6`);
    await page.reload();
    await expect(panel.getByTestId("radarr-movie")).toContainText("Glass Meridian");
  });

  test("Smart Quality: a missing movie whose releases are only over the size limit says so, and offers the closest", async ({
    page,
  }) => {
    const panel = await open(page, id, "library/movie/6");
    await panel.locator('[data-hearth-target="movie:releases"]').click();
    const note = panel.getByTestId("near-miss");
    await expect(note).toBeVisible({ timeout: 20_000 });
    await expect(note).toContainText("your own rules turned every one down");
    await expect(note).toContainText("All are only over your size limit of 8 GB");
    await expect(note).toContainText("Closest: 8.9 GB Bluray-1080p");
    await panel.screenshot({
      path: `test-results/screens/near-miss-${test.info().project.name}.png`,
    });
    // Grab it anyway: the closest one, as a one-time download the owner confirms.
    await note.getByTestId("near-miss-grab").click();
    const oldie = panel.getByTestId("isearch-release").filter({ hasText: "OLDIE" });
    await expect(oldie.getByTestId("panel-change")).toContainText("Download");
    // Ember asks the same question in words, with the download ready to propose.
    const why = (await (
      await page.request.get(`/api/services/${id}/why-not-grabbed?q=glass meridian`)
    ).json()) as { answer: string; grab?: { operation: string; params: { sizeGB: number } } };
    expect(why.answer).toContain("Glass Meridian");
    expect(why.answer).toContain("Closest: 8.9 GB Bluray-1080p");
    expect(why.grab).toMatchObject({ operation: "app-arr-grab", params: { sizeGB: 8.9 } });
    const have = (await (
      await page.request.get(`/api/services/${id}/why-not-grabbed?q=harbor lights`)
    ).json()) as { answer: string };
    expect(have.answer).toContain("already has a file");
  });

  test("a movie's monitoring and profile change in one approved, verified plan", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Same code on a phone; checked on desktop.");
    const panel = await open(page, id, "library/movie/1");
    await panel.locator('[data-hearth-target="movie:monitored"]').uncheck();
    await panel.locator('[data-hearth-target="movie:profile"]').selectOption({ label: "Ultra-HD" });
    await panel.locator('[data-hearth-target="movie:save"]').click();
    const done = await approve(page, /Monitored[\s\S]*Yes[\s\S]*No[\s\S]*Ultra-HD/);
    expect(done).toMatch(/verified by reading it back/);
    await expect(panel.locator('[data-hearth-target="movie:monitored"]')).not.toBeChecked();
  });

  test("a movie that is not monitored has Monitor right beside the reason", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Same code on a phone; checked on desktop.");
    const panel = await open(page, id, "library");
    await panel.locator('[data-hearth-target="library:search"]').fill("winter");
    await panel.getByTestId("radarr-movie-row").first().click();
    const movie = panel.getByTestId("radarr-movie");
    await expect(movie).toContainText("not monitored");
    await movie.getByTestId("radarr-movie-monitor").click();
    await approve(page, /A House Called Winter/);
    await expect(movie.getByTestId("radarr-movie-monitor")).toHaveCount(0);
    await expect(movie).not.toContainText("not monitored");
  });

  test("several movies stop being monitored in one plan", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "library");
    await panel.getByRole("checkbox", { name: "Select Harbor Lights" }).check();
    await panel.getByRole("checkbox", { name: "Select Paper Lanterns" }).check();
    await expect(panel.getByTestId("radarr-bulk")).toContainText("2 selected");
    await panel.locator('[data-hearth-target="library:bulk:unmonitor"]').click();
    await approve(page, /Harbor Lights[\s\S]*Paper Lanterns/);
    await panel.locator('[data-hearth-target="library:filter"]').selectOption("unmonitored");
    await expect(panel.getByTestId("radarr-movie-row")).toHaveCount(3);
  });

  test("Activity shows the queue, history and blocklist; a blocklist entry comes off", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "activity");
    await expect(panel.getByTestId("arr-queue-item")).toHaveCount(2);
    await panel.locator('[data-hearth-target="activity:history"]').click();
    await expect(panel.getByTestId("radarr-history")).toContainText("Download failed");
    await panel.locator('[data-hearth-target="history:filter"]').selectOption("4");
    await expect(panel.getByTestId("radarr-history").locator("li")).toHaveCount(1);
    await panel.locator('[data-hearth-target="activity:blocklist"]').click();
    await panel.locator('[data-hearth-target="blocklist:remove:1"]').click();
    await approve(page, /blocklist/);
    await expect(panel.getByTestId("radarr-blocklist")).toContainText("The blocklist is empty.");
  });

  test("Wanted lists missing and below-cutoff movies and opens one in Library", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "wanted");
    await expect(panel.getByTestId("radarr-wanted")).toContainText("Glass Meridian");
    await panel.locator('[data-hearth-target="wanted:cutoff"]').click();
    await expect(panel.getByTestId("radarr-wanted")).toContainText("5 movies have a file below");
    await panel.locator('[data-hearth-target="wanted:movie:3"]').click();
    await expect(panel.getByTestId("radarr-movie")).toContainText("Paper Lanterns");
  });

  test("a quality profile's format score changes, and Radarr's own matcher checks a name", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config/profiles/1");
    await panel.getByRole("spinbutton", { name: "Score for x265 (HD)" }).fill("25");
    await panel.locator('[data-hearth-target="profile:1:save"]').click();
    await approve(page, /x265 \(HD\): -10[\s\S]*x265 \(HD\): 25/);

    await panel.locator('[data-hearth-target="settings:formats"]').click();
    await panel
      .locator('[data-hearth-target="format:preview"]')
      .fill("Harbor.Lights.2019.1080p.WEB-DL.x265-FAKEGRP");
    await panel.getByRole("button", { name: "Check" }).click();
    await expect(panel.getByTestId("radarr-preview-result")).toContainText(
      "Radarr matches x265 (HD), Bad release group",
    );
  });

  test("connections never show a password or key, and switch off through a plan", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config/connections");
    const client = panel.locator('[data-hearth-target="connection:downloadclient:1"]');
    await client.locator("summary").click();
    // Its user name and password are both private: shown only as set.
    await expect(client.getByTestId("radarr-secret-field")).toHaveText([
      "Set (hidden)",
      "Set (hidden)",
    ]);
    expect(await page.content()).not.toContain("stand-in-secret");
    expect(await page.content()).not.toContain("stand-in-indexer-key");
    await client.locator('[data-hearth-target="connection:downloadclient:1:enable"]').uncheck();
    await client.locator('[data-hearth-target="connection:downloadclient:1:save"]').click();
    await approve(page, /Stand-in Client[\s\S]*Yes[\s\S]*No/);
  });

  test("System shows health and runs a task now", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "system");
    await expect(panel.getByTestId("radarr-health")).toContainText("no indexers available");
    await panel.locator('[data-hearth-target="system:tasks"]').click();
    await panel.locator('[data-hearth-target="task:run:RssSync"]').click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toContainText('Run "RSS Sync" now');
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText("finished in Radarr", { timeout: 20_000 });
  });

  test("a new movie is found through Radarr's own search and added once", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "library");
    await panel.locator('[data-hearth-target="library:add"]').click();
    await panel.locator('[data-hearth-target="add:search"]').fill("lantern");
    await panel.getByRole("button", { name: "Find" }).click();
    // Two new ones, and Paper Lanterns, already in the library.
    await expect(panel.getByTestId("radarr-lookup")).toHaveCount(3);
    await expect(panel.getByRole("button", { name: "In your library" })).toHaveCount(1);
    await panel.locator('[data-hearth-target="add:pick:9900"]').click();
    await panel.locator('[data-hearth-target="add:review"]').click();
    await approve(page, /Lantern Season \(2023\)[\s\S]*\/movies\/Lantern Season \(2023\)/);
    await panel.getByRole("button", { name: "Library" }).click();
    await panel.locator('[data-hearth-target="library:search"]').fill("lantern season");
    await expect(panel.getByTestId("radarr-movie-row")).toHaveCount(1);
    await expect(panel.getByTestId("radarr-movie-row")).toContainText("Lantern Season");
  });

  test("Overview sums up what needs you and opens Activity; old queue links still work", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "overview");
    const now = panel.getByTestId("arr-right-now");
    await expect(now).toContainText("1 failed download");
    await expect(now).toContainText("Copper Sky");
    await now.locator('[data-hearth-target="overview:to-activity"]').click();
    await expect(panel.getByTestId("radarr-activity")).toBeVisible();
    // A saved layout from before the Activity tab opened the queue in Overview: it lands there.
    await open(page, id, "overview/queue");
    await expect(panel.getByTestId("radarr-activity")).toBeVisible();
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).searchParams.get("panels") ?? ""))
      .toBe(`service:${id}@activity`);
    await open(page, id, "overview/missing");
    await expect(panel.getByTestId("radarr-wanted")).toBeVisible();
  });

  test("a health warning links straight to the setting that fixes it", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "overview");
    const health = panel.getByTestId("arr-health");
    await expect(health).toContainText("no indexers available");
    await health.locator('[data-hearth-target="health:fix"]').click();
    const indexers = panel.locator('[data-hearth-target="connections:indexer"]');
    await expect(indexers).toBeInViewport();
    await expect(indexers).toHaveClass(/ring-2/);
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).searchParams.get("panels") ?? ""))
      .toBe(`service:${id}@config/connections/indexer`);
    // The same link from the System tab's full health list.
    await open(page, id, "system");
    await panel.getByTestId("radarr-health").locator('[data-hearth-target="health:fix"]').click();
    await expect(panel.locator('[data-hearth-target="connections:indexer"]')).toBeInViewport();
  });

  test("quality sizes change in MB per minute through a plan; a wrong order is not offered", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config/sizes");
    const max = panel.locator('[data-hearth-target="size:7:maxSize"]');
    await expect(max).toHaveValue("400");
    const review = panel.locator('[data-hearth-target="sizes:review"]');
    await max.fill("50");
    await expect(review).toBeDisabled(); // preferred 95 would be above the maximum
    await panel.locator('[data-hearth-target="size:7:preferredSize"]').fill("40");
    await expect(review).toBeEnabled();
    await review.click();
    const done = await approve(page, /size limits for Bluray-1080p/);
    expect(done).toContain("Maximum size (MB per minute)");
    await expect(max).toHaveValue("50");
  });

  test("a movie is excluded from import lists, and an exclusion comes off", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config/exclusions");
    await expect(panel.getByTestId("radarr-exclusion")).toHaveCount(1);
    await panel.locator('[data-hearth-target="exclusions:search"]').fill("lantern");
    await panel.getByRole("button", { name: "Find" }).click();
    await panel.locator('[data-hearth-target="exclusions:add:9900"]').click();
    await approve(page, /Lantern Season \(2023\)/);
    await expect(panel.getByTestId("radarr-exclusion")).toHaveCount(2);
    await panel.locator('[data-hearth-target="exclusions:remove:1"]').click();
    await approve(page, /Orchard Keeper/);
    await expect(panel.getByTestId("radarr-exclusion")).toHaveCount(1);
  });

  test("Import files: a file Radarr found goes into the movie chosen for it", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "activity/import");
    await panel.locator('[data-hearth-target="import:folder"]').fill("/downloads");
    await panel.getByRole("button", { name: "Look" }).click();
    await expect(panel.getByTestId("radarr-import-file")).toHaveCount(2);
    // The file Radarr could not match is skipped; the other is already matched to its movie.
    await panel.getByLabel("Movie for Holiday.Video.2024.mkv").selectOption("0");
    await panel.locator('[data-hearth-target="import:review"]').click();
    const done = await approve(page, /Import 1 file into Radarr/);
    expect(done).toContain("Glass Meridian");
    await expect(panel.getByTestId("radarr-import-file")).toHaveCount(1);
  });

  test("on a phone, Library and a movie are usable within the screen", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Phone layout.");
    const panel = await open(page, id, "library");
    await expect(panel.getByTestId("radarr-movie-row")).toHaveCount(12);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await panel.getByTestId("radarr-movie-row").first().click();
    await expect(panel.locator('[data-hearth-target="movie:save"]')).toBeVisible();
  });
});
