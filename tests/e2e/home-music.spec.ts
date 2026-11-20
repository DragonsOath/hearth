import { expect, test } from "@playwright/test";

// The music library on the Media page (11-05): with Music Assistant in Home Assistant, the
// owner's playlists, search, and Play / Start mix on a Music Assistant speaker.

test("Media page: the music library, search and starting a mix", async ({ page }, info) => {
  test.setTimeout(120_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.16`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await page.request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await page.request.post("/api/vault/secrets", {
    data: {
      name: `Home Assistant ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-home-token",
    },
  });
  await page.request.post("/api/test/fake-apps", { data: { home: { musicAssistant: true } } });
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home).toBeVisible({ timeout: 20_000 });
  await home.locator('[data-page="media"]:visible').click();
  const lib = home.getByTestId("home-music-library");
  await expect(lib).toBeVisible();
  // Rows of posters: your playlists, albums, artists.
  await expect(lib.getByRole("region", { name: "Your playlists" })).toContainText("Road Trip");
  await page.screenshot({ path: `test-results/screens/${info.project.name}/home-music.png` });
  // A song opens its choices; Start mix plays it on the Music Assistant speaker.
  await lib.getByTestId("home-music-search").fill("sadness");
  const songs = lib.getByRole("region", { name: "Songs" });
  await expect(songs.getByTestId("home-music-poster")).toHaveCount(1);
  await songs.getByTestId("home-music-poster").click();
  await lib.getByTestId("home-music-sheet-mix").click();
  await expect(lib.getByTestId("home-music-said")).toContainText("Mix started: Summertime Sadness");
  await expect(home.getByTestId("home-media")).toContainText("Summertime Sadness");
});

// The player as the owner drew it (11-11): the speaker in one menu, Up Next beside the song from
// Music Assistant, thumbs up saves the song, tapping a song in Up Next plays it.
test("Media page: speaker menu, Up Next and the like button", async ({ page }, info) => {
  test.setTimeout(120_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = () =>
    `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.17`;
  await page.request.post("/api/test/fake-apps", {
    data: { reset: true, home: { musicAssistant: true } },
  });
  const add = async (name: string, address: string, value: string, kind: string) => {
    const res = await page.request.post("/api/services", {
      data: { name, kind: "web", address, category: kind },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    await page.request.post("/api/vault/secrets", {
      data: {
        name: `${name} key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: id,
        value,
      },
    });
    return id;
  };
  const id = await add(`Home Assistant ${run}`, `http://${host()}:8123`, "e2e-home-token", "Home");
  const maId = await add(
    `Music Assistant ${run}`,
    `http://${host()}:8099`,
    "e2e-ma-token",
    "Media",
  );
  // Linked Music Assistant only for this test: later ones start unlinked (home-speaker.spec.ts).
  try {
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
    const home = page.getByTestId("home-dashboard");
    await expect(home).toBeVisible({ timeout: 20_000 });
    await home.locator('[data-page="media"]:visible').click();

    // The speakers are one menu, closed until asked.
    await expect(home.getByTestId("home-speakers")).toHaveCount(0);
    await home.getByTestId("home-speaker-menu").click();
    const menu = home.getByTestId("home-speakers");
    await expect(menu).toBeVisible();
    await menu
      .getByRole("button", { name: /^Kitchen speaker/ })
      .last()
      .click();
    await expect(menu).toHaveCount(0);

    const next = home.getByTestId("home-up-next");
    await expect(next.getByTestId("home-up-next-item")).toHaveCount(5, { timeout: 20_000 });
    await expect(next.getByTestId("home-up-next-item").first()).toContainText("The Middle");
    await home.getByTestId("home-like").click();
    await expect(home.getByTestId("home-liked")).toHaveText("Saved to YouTube Music");
    await page.screenshot({ path: `test-results/screens/${info.project.name}/home-up-next.png` });
    // A song from Up Next plays now: the list moves on.
    await next.getByTestId("home-up-next-item").nth(1).click();
    await expect(next.getByTestId("home-up-next-item").first()).toContainText(
      "My Friends Over You",
    );
  } finally {
    await page.request.post(`/api/services/${maId}/remove`, { data: {} });
  }
});

// Switching speakers moves the music (11-12, the owner: "you'd think it would just play that music
// on the new speakers"): the new speaker plays the same song, the old one goes quiet.
test("Media page: picking another speaker moves what is playing", async ({ page }, info) => {
  test.setTimeout(120_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.18`;
  await page.request.post("/api/test/fake-apps", {
    data: { reset: true, home: { musicAssistant: true, livingRoom: true } },
  });
  const res = await page.request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await page.request.post("/api/vault/secrets", {
    data: {
      name: `Home Assistant ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-home-token",
    },
  });
  try {
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
    const home = page.getByTestId("home-dashboard");
    await expect(home).toBeVisible({ timeout: 20_000 });
    await home.locator('[data-page="media"]:visible').click();
    const menu = home.getByTestId("home-speakers");
    await home.getByTestId("home-speaker-menu").click();
    await menu.getByRole("button", { name: /^Living room speaker/ }).click();
    await expect(home.getByTestId("home-media")).toContainText("Moon Palace");
    // To the kitchen: it plays there now, and the living room is no longer playing.
    await home.getByTestId("home-speaker-menu").click();
    await menu
      .getByRole("button", { name: /^Kitchen speaker/ })
      .last()
      .click();
    await home.getByTestId("home-speaker-menu").click();
    await expect(
      menu.getByRole("button", { name: /Kitchen speaker · playing/ }).last(),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(menu.getByRole("button", { name: /^Living room speaker/ })).not.toContainText(
      "playing",
    );
    await expect(home.getByTestId("home-media")).toContainText("Moon Palace");
  } finally {
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  }
});

// Have Ember make a playlist (11-12): the vibe, about how many and a name go to Ember as one
// request, the same flow as a Home row. Only where Ember is: never on the standalone home screen.
test("Media page: Have Ember make a playlist hands Ember the request", async ({ page }, info) => {
  test.setTimeout(120_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.17`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await page.request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await page.request.post("/api/vault/secrets", {
    data: {
      name: `Home Assistant ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-home-token",
    },
  });
  await page.request.post("/api/test/fake-apps", { data: { home: { musicAssistant: true } } });

  // The standalone home screen has no Ember: no button there.
  await page.goto(`/home-screen?service=${id}`);
  const screen = page.getByTestId("home-dashboard");
  await expect(screen).toBeVisible({ timeout: 20_000 });
  await screen.locator('[data-page="media"]:visible').click();
  await expect(screen.getByTestId("home-music-library")).toBeVisible();
  await expect(page.getByTestId("home-music-make-playlist")).toHaveCount(0);

  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home).toBeVisible({ timeout: 20_000 });
  await home.locator('[data-page="media"]:visible').click();
  const lib = home.getByTestId("home-music-library");
  await lib.getByTestId("home-music-make-playlist").click();
  const form = lib.getByTestId("home-music-playlist-form");
  await expect(form.getByTestId("home-music-playlist-go")).toBeDisabled();
  await expect(form.getByTestId("ember-mark")).toBeVisible();
  await form
    .getByTestId("home-music-playlist-what")
    .fill("2010s rock like Muse and Cage the Elephant");
  await form.getByLabel("About how many songs").fill("100");
  await form.getByLabel("Name (optional)").fill(`Ember's Rock ${run}`);
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/home-music-playlist.png`,
  });
  await form.getByTestId("home-music-playlist-go").click();
  await expect(form).toHaveCount(0);
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Show Ember" }).click();
  await expect(
    page
      .getByText(/Make me a playlist on my .+ through Music Assistant .* 2010s rock like Muse/)
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(`Call it "Ember's Rock ${run}".`, { exact: false }).first(),
  ).toBeVisible();
});
