import { expect, test } from "@playwright/test";

// Curator For You (11-13, free since 11-14): picks from the owner's own history only,
// read from the scripted Plex (Alex watched Quiet Harbor; sam watched an episode of Signal Hill).

test("Curator For You: the owner's own picks, and Not for me", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true, forYouReset: true } });
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.32`;
  const res = await request.post("/api/services", {
    data: { name: `Plex: ${run}`, kind: "web", address: `http://${host}:32400`, category: "Media" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const plex = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Plex ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: plex,
      value: `e2e-for-you-${run}`,
    },
  });
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:curator")}`);
    const panel = page.getByTestId("recommend-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByRole("tab", { name: "For You" }).click();
    const fy = panel.getByTestId("for-you");
    await expect(fy).toBeVisible({ timeout: 20_000 });
    // Only the owner's own history: Alex owns the Plex; sam is never offered.
    await expect(fy.getByTestId("for-you-whose")).toContainText("your own watch history");
    // The note shows once: Got it, and it stays gone.
    await expect(fy.getByTestId("for-you-note")).toContainText("only from your own watch history");
    await fy.getByTestId("for-you-note-ok").click();
    await expect(fy.getByTestId("for-you-note")).toHaveCount(0);
    await expect(fy.getByTestId("for-you-missing")).toContainText("ask Ember, check in Seerr");
    // Another person on the Plex (sam) never appears.
    await expect(fy).not.toContainText(/\bsam\b/);
    // Alex: what Hearth learned, and picks with Hearth's own reasons.
    await expect(fy.getByTestId("for-you-taste")).toContainText("play", { timeout: 30_000 });
    const picks = fy.getByTestId("for-you-pick");
    await expect(picks.first()).toBeVisible();
    const before = await picks.count();
    // What Alex already watched is never a hidden gem.
    await expect(
      picks.getByTestId("for-you-title").filter({ hasText: "Quiet Harbor" }),
    ).toHaveCount(0);
    await testInfo.attach("for-you", { body: await page.screenshot(), contentType: "image/png" });

    // Spoken to you, never by the Plex username.
    await expect(picks.getByTestId("for-you-why").first()).not.toContainText("Alex");
    await expect(picks.first().getByTestId("for-you-hide")).toHaveText("Not for me");

    // Not for me: gone, and stays gone after fresh picks.
    const first = picks.first();
    const title = (await first.getByTestId("for-you-title").textContent())!.trim();
    await first.getByTestId("for-you-hide").click();
    // Gone; the next waiting pick (if any) takes its place.
    await expect(picks.filter({ hasText: title })).toHaveCount(0);
    expect(await picks.count()).toBeGreaterThanOrEqual(before - 1);
    await fy.getByTestId("for-you-refresh").click();
    await expect(fy.getByTestId("for-you-refresh")).toBeEnabled({ timeout: 30_000 });
    await expect(picks.filter({ hasText: title })).toHaveCount(0);

    // What's missing: Discover, started from the owner's taste.
    if (await fy.getByTestId("for-you-missing").count()) {
      await fy.getByTestId("for-you-missing").click();
      await expect(panel.getByTestId("recommend-interest")).toHaveValue(/Films like|\(/);
    }
  } finally {
    await request.post(`/api/services/${plex}/remove`, { data: {} });
  }
});

test("For You: More like this, Seen it, Not in your library, and What should I watch?", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const request = page.request;
  await request.post("/api/test/fake-apps", {
    data: { reset: true, forYouReset: true, media: { reset: true } },
  });
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = () =>
    `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.33`;
  const add = async (name: string, port: number, key: string) => {
    const res = await request.post("/api/services", {
      data: { name, kind: "web", address: `http://${host()}:${port}`, category: "Media" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `${name} key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: id,
        value: key,
      },
    });
    return id;
  };
  const plex = await add(`Plex: ${run}`, 32400, `e2e-for-you-${run}`);
  const seerr = await add(`Seerr ${run}`, 5055, `e2e-recommend-${run}`);
  try {
    await page.goto(`/?panels=${encodeURIComponent("tool:curator")}`);
    const panel = page.getByTestId("recommend-panel");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await panel.getByRole("tab", { name: "For You" }).click();
    const fy = panel.getByTestId("for-you");
    if (await fy.getByTestId("for-you-note-ok").count())
      await fy.getByTestId("for-you-note-ok").click();
    await expect(fy.getByTestId("for-you-taste")).toContainText("play", { timeout: 30_000 });

    // Not in your library, always shown: from Seerr's own lists for what Alex finished.
    const notOwned = fy.getByTestId("for-you-not-owned");
    await expect(notOwned).toContainText("No AI");
    const items = notOwned.getByTestId("for-you-not-owned-item");
    await expect(items.filter({ hasText: "Lantern Coast" })).toHaveCount(1);
    await expect(items.filter({ hasText: "Lantern Coast" })).toContainText(
      "Because you finished Quiet Harbor.",
    );
    // Already requested in Seerr says so; the other one can be requested.
    await expect(
      items.filter({ hasText: "Tidewater" }).getByTestId("for-you-requested"),
    ).toHaveText("Requested");
    await expect(
      items.filter({ hasText: "Lantern Coast" }).getByTestId("for-you-request"),
    ).toBeVisible();
    await testInfo.attach("for-you-more", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    // Not for me on a missing title: gone.
    await items.filter({ hasText: "Tidewater" }).getByTestId("for-you-not-owned-hide").click();
    await expect(items.filter({ hasText: "Tidewater" })).toHaveCount(0);

    // Request: one sheet with your defaults said, and one tap sends it (no second approval).
    await items.filter({ hasText: "Lantern Coast" }).getByTestId("for-you-request").click();
    const ask = page.getByTestId("request-ask");
    await expect(ask.getByTestId("request-ask-where")).toContainText("saved to /movies", {
      timeout: 15_000,
    });
    await ask.getByTestId("request-ask-go").click();
    await expect(
      items.filter({ hasText: "Lantern Coast" }).getByTestId("for-you-requested"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("approve-here")).toHaveCount(0);

    // More like this on one of yours: the picks start from it, and say so at the top.
    const picks = fy.getByTestId("for-you-pick");
    await expect(picks.first()).toBeVisible();
    const seedTitle = (await picks.first().getByTestId("for-you-title").textContent())!
      .replace(/\s*\(\d{4}\)$/, "")
      .trim();
    await picks.first().getByTestId("for-you-like").click();
    await expect(fy.getByTestId("for-you-showing")).toContainText(`More like ${seedTitle}`, {
      timeout: 20_000,
    });
    await fy.getByTestId("for-you-back").click();
    await expect(fy.getByTestId("for-you-showing")).toHaveCount(0);

    // Seen it: the same rating prompt as Discover; the card goes, and marking it watched on
    // Plex is offered as a plan.
    const seenTitle = (await picks.first().getByTestId("for-you-title").textContent())!.trim();
    await picks.first().getByTestId("for-you-seen").click();
    await expect(fy.getByTestId("recommend-rate")).toBeVisible();
    await fy.getByTestId("recommend-star-5").click();
    await fy.getByTestId("recommend-rate-save").click();
    await expect(picks.filter({ hasText: seenTitle })).toHaveCount(0);
    await expect(fy.getByTestId("for-you-mark-watched")).toContainText("watched on");

    // What should I watch?: plain words run here, no AI, and say what was understood.
    await fy.getByTestId("for-you-search-text").fill("a drama movie");
    await fy.getByTestId("for-you-search-go").click();
    await expect(fy.getByTestId("for-you-showing")).toContainText("Showing: Drama, movies", {
      timeout: 20_000,
    });
    await fy.getByTestId("for-you-search-text").fill("like Quiet Harbor");
    await fy.getByTestId("for-you-search-go").click();
    await expect(fy.getByTestId("for-you-showing")).toContainText("More like Quiet Harbor", {
      timeout: 20_000,
    });
    await testInfo.attach("for-you-search", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    for (const id of [plex, seerr]) await request.post(`/api/services/${id}/remove`, { data: {} });
    // Seen it is shared with Curator: what was marked seen here must not hide its picks there.
    await request.post("/api/test/fake-apps", { data: { forYouReset: true } });
  }
});
