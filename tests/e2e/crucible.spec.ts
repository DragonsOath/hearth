import { expect, test, type APIRequestContext } from "@playwright/test";

// The Crucible: Quality & Size (11-17), against the stand-in Radarr 6.4 (port 7879). Pick a
// starting point, change a row, Save as a plan you approve, and it reads back in Radarr.

let hosts = (Date.now() % 50_000) + 3000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.11`;
};

async function addRadarr(request: APIRequestContext, run: string, app = "Radarr", port = 7879) {
  const res = await request.post("/api/services", {
    data: {
      name: `${app} ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:${port}`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `${app} ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: `e2e-${port}-key`,
    },
  });
  return id;
}

test("The Crucible: pick a starting point, change a row, Save as a plan, and it reads back", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const id = await addRadarr(page.request, `${info.project.name}${Date.now() % 100000}`);
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:crucible")}`);
    const panel = page.getByTestId("crucible-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // Several Radarrs may exist from other tests: pick ours.
    await expect(panel.getByTestId("crucible-movies")).toBeVisible({ timeout: 20_000 });
    const pick = panel.getByTestId("crucible-app");
    if ((await pick.count()) > 0) await pick.selectOption(id);
    await expect(panel.getByTestId("crucible-start")).toBeVisible({ timeout: 20_000 });
    // Nothing saved yet: the rules show straight away, on the Balanced start (11-18).
    await expect(panel.getByTestId("crucible-rule").first()).toBeVisible();
    await panel.screenshot({
      path: `test-results/screens/crucible-first-${info.project.name}.png`,
    });
    await panel.locator('[data-preset="storage-smart"]').click();
    // The full editor (Expert); Everyday has its own test below.
    await panel.getByTestId("crucible-level-expert").click();

    const rows = panel.getByTestId("crucible-row");
    await expect(rows).toHaveCount(5);
    const big = rows.filter({ has: page.locator('input[value="Big new releases"]') });
    await expect(big.getByTestId("crucible-row-group")).toContainText("of your movies");
    await expect(big.getByTestId("crucible-explain").first()).toContainText(
      "Most 2-hour movies in 4K",
    );
    // Raise the 4K cap.
    await big.getByTestId("crucible-step").first().locator('input[type="range"]').fill("30");
    await expect(big.getByTestId("crucible-step-cap").first()).toHaveText("up to 30 GB");
    // Wait 2 days for 4K before settling for 1080p.
    await big.getByTestId("crucible-wait").selectOption("48");
    await panel.screenshot({ path: `test-results/screens/crucible-${info.project.name}.png` });

    await panel.getByTestId("crucible-save").click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText("Big new releases");
    await expect(pop).toContainText("4K up to 30 GB");
    await expect(pop).toContainText("Wait up to 2 days for 4K before settling for 1080p");
    await expect(pop).toContainText("Same quality: take the smaller one");
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText("verified", { timeout: 30_000 });
    await pop.getByTestId("approve-here-close").click();

    // Saved: Radarr has Hearth's own profiles, and the Crucible remembers the rows.
    const after = (await (await page.request.get(`/api/services/${id}/crucible`)).json()) as {
      setup?: { movies: { name: string; ladder: { maxGB: number }[] }[] };
      library: { hearthProfiles: { name: string; blocks: string[] }[] };
    };
    expect(after.setup?.movies[0]).toMatchObject({ name: "Big new releases" });
    expect(after.library.hearthProfiles.map((p) => p.name)).toContain("Hearth · Big new releases");
    expect(
      after.library.hearthProfiles.find((p) => p.name === "Hearth · Big new releases")?.blocks,
    ).toContain("Hearth · 2160p over 30 GB");
    // Back in the panel, the saved rows show (not the starting points).
    await page.reload();
    await expect(page.getByTestId("crucible-movies")).toBeVisible({ timeout: 20_000 });
    const again = page.getByTestId("crucible-app");
    if ((await again.count()) > 0) await again.selectOption(id);
    await expect(page.getByTestId("crucible-editor")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("crucible-row")).toHaveCount(5);
    // Smaller wins is on unless turned off (step 10), and the wait was kept.
    await expect(page.getByTestId("crucible-smaller")).toBeChecked();
    await expect(page.getByTestId("crucible-wait").first()).toHaveValue("48");
    // Radarr's webhook to Hearth refuses anyone without its private key.
    const wrong = await page.request.post(`/api/crucible/hook/${id}?key=not-the-key`, {
      data: { eventType: "MovieAdded", movie: { id: 1 } },
    });
    expect(wrong.status()).toBe(404);

    // Add movie in the Radarr panel picks the Crucible's row for the new movie (desk only).
    if (info.project.name !== "mobile") {
      await page.goto(`/?panels=${encodeURIComponent(`service:${id}@library`)}`);
      const radarrPanel = page.locator(`[data-panel="service:${id}"]`);
      await radarrPanel.locator('[data-hearth-target="library:add"]').click();
      await radarrPanel.locator('[data-hearth-target="add:search"]').fill("lantern");
      await radarrPanel.getByRole("button", { name: "Find" }).click();
      await radarrPanel.locator('[data-hearth-target="add:pick:9900"]').click();
      await expect(radarrPanel.getByTestId("add-crucible-row")).toContainText(
        "Chosen by The Crucible",
      );
    }

    // Radarr's own settings tab marks the Crucible's profiles, with a link back.
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@config/profiles`)}`);
    await expect(page.getByTestId("radarr-profiles")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("managed-by-crucible").first()).toBeVisible();
  } finally {
    await page.request.post(`/api/services/${id}/remove`, { data: {} });
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  }
});

test("Near misses: Check now finds a movie held back only by size, with Grab it anyway", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  test.skip(
    info.project.name === "mobile",
    "One check is enough; the list is the same on a phone.",
  );
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const id = await addRadarr(page.request, `nm${Date.now() % 100000}`);
  try {
    // Every missing movie, today (the default waits until a movie is missing 7 days).
    await page.request.put("/api/crucible/near-misses/settings", {
      data: { perDay: 50, minDays: 0, notify: false },
    });
    await page.goto(`/?panels=${encodeURIComponent("tool:crucible")}`);
    const panel = page.getByTestId("crucible-panel");
    await expect(panel.getByTestId("crucible-movies")).toBeVisible({ timeout: 20_000 });
    const pick = panel.getByTestId("crucible-app");
    if ((await pick.count()) > 0) await pick.selectOption(id);
    await panel.getByTestId("near-misses-check").click();
    const miss = panel.getByTestId("near-miss").filter({ hasText: "Glass Meridian" });
    await expect(miss).toBeVisible({ timeout: 60_000 });
    await expect(miss).toContainText("only over your size limit");
    await miss.getByTestId("near-miss-grab").click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText("Glass Meridian");
  } finally {
    await page.request.put("/api/crucible/near-misses/settings", {
      data: { perDay: 10, minDays: 7, notify: false },
    });
    await page.request.post(`/api/services/${id}/remove`, { data: {} });
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  }
});

test("Shows: Sonarr rows judged per episode, saved as a plan and read back", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const id = await addRadarr(
    page.request,
    `tv${info.project.name}${Date.now() % 100000}`,
    "Sonarr",
    8990,
  );
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:crucible")}`);
    const panel = page.getByTestId("crucible-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByRole("tab", { name: "Shows" }).click();
    await expect(panel.getByTestId("crucible-shows")).toBeVisible({ timeout: 20_000 });
    const pick = panel.getByTestId("crucible-app");
    if ((await pick.count()) > 0) await pick.selectOption(id);
    await panel.locator('[data-preset="storage-smart"]').click();
    await panel.getByTestId("crucible-level-expert").click();
    const row = panel.getByTestId("crucible-row").last();
    await expect(row.getByTestId("crucible-step-cap").first()).toContainText("an episode");
    await expect(row.getByTestId("crucible-explain").first()).toContainText("episodes");
    await panel.getByTestId("crucible-save").click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText("Save the Crucible's show rows");
    // Sonarr's own episode size limits, or (this test workspace has Recyclarr) left alone, said so.
    await expect(pop).toContainText(
      /season packs judged per episode|Managed by Recyclarr or Profilarr/,
    );
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText("verified", { timeout: 30_000 });
  } finally {
    await page.request.post(`/api/services/${id}/remove`, { data: {} });
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  }
});

test("Everyday: rules as sentences, definitions changed with a tap, Ember's suggestion added, saved as a plan", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const id = await addRadarr(page.request, `ev${info.project.name}${Date.now() % 100000}`);
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:crucible")}`);
    await page.evaluate(() => localStorage.removeItem("crucible-level"));
    await page.reload();
    const panel = page.getByTestId("crucible-panel");
    await expect(panel.getByTestId("crucible-movies")).toBeVisible({ timeout: 20_000 });
    const pick = panel.getByTestId("crucible-app");
    if ((await pick.count()) > 0) await pick.selectOption(id);
    await panel.locator('[data-preset="balanced"]').click();

    const rules = panel.getByTestId("crucible-rule");
    await expect(rules).toHaveCount(2);
    await expect(rules.first().getByTestId("crucible-sentence")).toHaveText(
      "Movies released in the last 2 years and popular right now get 4K up to 40 GB, else 1080p up to 15 GB.",
    );
    // Tap "released in the last 2 years" and make it 3.
    await rules.first().getByTestId("crucible-chip").first().click();
    const editor = rules.first().getByTestId("crucible-condition-editor");
    await editor.locator('input[type="number"]').fill("3");
    await editor.getByRole("button", { name: "Done" }).click();
    await expect(rules.first().getByTestId("crucible-sentence")).toContainText(
      "released in the last 3 years",
    );
    // A ready-made rule, with its definitions in it, then changed: 6 months becomes 4.
    await panel.getByTestId("crucible-add-rule").click();
    await panel
      .getByTestId("crucible-statement")
      .filter({ hasText: "New releases get the best" })
      .click();
    await expect(rules).toHaveCount(3);
    const fresh = rules.nth(1);
    await expect(fresh.getByTestId("crucible-sentence")).toContainText(
      "out on digital less than 6 months ago",
    );
    await fresh.getByTestId("crucible-chip").first().click();
    await fresh.getByTestId("crucible-condition-editor").locator('input[type="number"]').fill("4");
    await expect(fresh.getByTestId("crucible-sentence")).toContainText(
      "out on digital less than 4 months ago",
    );
    // And its 4K size: 25 becomes 15.
    await fresh.getByTestId("crucible-step-chip").first().click();
    await fresh.getByTestId("crucible-step-gb").fill("15");
    await expect(fresh.getByTestId("crucible-step-chip").first()).toHaveText("4K up to 15 GB");
    // Switched off, it's kept but places nothing.
    await fresh.getByRole("switch").click();
    await expect(fresh.getByTestId("crucible-rule-count")).toHaveText("Off");
    await fresh.getByRole("switch").click();

    // What the library would get, and why.
    const preview = panel.getByTestId("crucible-preview");
    await expect(preview.getByTestId("crucible-space")).toContainText("Your movies take");
    await preview.getByTestId("crucible-preview-find").fill("Harbor");
    const title = preview.getByTestId("crucible-preview-title").first();
    await title.getByRole("button", { name: "Why?" }).click();
    await expect(title.getByTestId("crucible-why")).toContainText("Everything else");

    // Ember's suggestion (as Ember adds it, through Hearth's API) shows up, to add or dismiss.
    const sug = await page.request.post("/api/crucible/suggestions", {
      data: {
        serviceId: id,
        kind: "movie",
        row: {
          name: "The 80s",
          group: { fromYear: 1980, toYear: 1989 },
          ladder: [{ quality: "1080p", maxGB: 12 }],
        },
        note: "You said the 80s matter most to you.",
      },
    });
    expect(sug.status(), await sug.text()).toBe(200);
    const card = panel.getByTestId("crucible-suggestions");
    await expect(card).toContainText("made from 1980 to 1989", { timeout: 15_000 });
    await card.getByTestId("crucible-suggestion-add").click();
    await expect(rules).toHaveCount(4);
    await expect(rules.nth(2).getByTestId("crucible-sentence")).toHaveText(
      "Movies made from 1980 to 1989 get 1080p up to 12 GB.",
    );
    await expect(card).toHaveCount(0, { timeout: 15_000 });
    // A rule Hearth can't use is refused.
    const bad = await page.request.post("/api/crucible/suggestions", {
      data: {
        serviceId: id,
        kind: "movie",
        row: { name: "x", ladder: [{ quality: "8K", maxGB: 1 }] },
      },
    });
    expect(bad.status()).toBe(400);
    await panel.screenshot({
      path: `test-results/screens/crucible-everyday-${info.project.name}.png`,
    });

    await panel.getByTestId("crucible-save").click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText("The 80s");
    await expect(pop).toContainText("4K up to 15 GB");
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText("verified", { timeout: 30_000 });
    const after = (await (await page.request.get(`/api/services/${id}/crucible`)).json()) as {
      setup?: { movies: { name: string; group: Record<string, unknown> }[] };
    };
    expect(after.setup?.movies.map((m) => m.name)).toEqual([
      "Big new releases",
      "New releases",
      "The 80s",
      "Everything else",
    ]);
    expect(after.setup?.movies[1]?.group).toEqual({ digitalWithinMonths: 4 });
  } finally {
    await page.request.post(`/api/services/${id}/remove`, { data: {} });
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  }
});
