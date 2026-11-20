import http from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Media announcements (FEATURE_CHECKLIST 39): a friends-and-family destination gets what newly
// arrives in Jellyfin (a stand-in, DC_FAKE_APPS, port 8096); the designer previews the message,
// sends a test that says it is a test, and Check now announces a new movie, never the back catalog.

test("media announcements: design, test, and announce a new arrival to a second channel", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const received: { title: string; message: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/movie-night`;
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.96`;
  let serviceId = "";
  let channelId = "";
  try {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const made = await request.post("/api/services", {
      data: {
        name: `Jellyfin ${run}`,
        kind: "web",
        address: `http://${host}:8096`,
        category: "Media",
      },
    });
    expect(made.status(), await made.text()).toBe(201);
    serviceId = ((await made.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `Jellyfin ${run} key`,
        kind: "api-key",
        tier: "automation",
        scope: "read",
        serviceId,
        value: "e2e-jellyfin-key",
      },
    });
    // The second channel: a friends-and-family destination, set up and chosen for new arrivals.
    channelId = (
      (await (
        await request.post("/api/notifications/destinations", {
          data: { kind: "webhook", name: `Movie night ${run}`, audience: "public" },
        })
      ).json()) as { id: string }
    ).id;
    expect(
      (
        await request.put(`/api/notifications/channels/${channelId}`, {
          data: { values: { url: hook } },
        })
      ).status(),
    ).toBeLessThan(300);
    expect(
      (
        await request.put("/api/notifications/routes/media-arrivals", {
          data: { channels: [channelId] },
        })
      ).status(),
    ).toBeLessThan(300);
    // Announce at once, whatever the hour the test runs.
    const state = (await (await request.get("/api/media-announce")).json()) as {
      settings: Record<string, unknown>;
    };
    await request.put("/api/media-announce", {
      // and from the default look, so this run's changes are real changes.
      data: {
        ...state.settings,
        looks: {
          ...(state.settings.looks as Record<string, unknown>),
          movie: { template: "cinematic", heading: "New movie" },
        },
        mode: "immediate",
        quietHours: false,
      },
    });

    await page.goto("/notifications");
    const panel = page.getByTestId("media-announcements");
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).toContainText(`Jellyfin ${run}`);
    // The first check only notes what is there (nothing is announced for it), and fills the
    // preview's list of titles.
    const sentBefore = received.length;
    await panel.getByTestId("announce-check").click();
    await expect(panel.getByTestId("announce-check")).toHaveText("Check now", { timeout: 30_000 });
    expect(received.length).toBe(sentBefore);
    // The preview is the real message, for a title from the library.
    await panel.getByLabel("Preview with").selectOption({ label: "Anora" });
    await expect(panel.getByTestId("announce-preview-title")).toContainText("Anora");
    // What posts is one checklist, visible whichever post is being designed.
    const kinds = panel.getByTestId("announce-kinds");
    await kinds.getByLabel("Episodes", { exact: true }).check();
    await expect(panel.getByTestId("announce-kinds-summary")).toContainText("episodes");
    await expect(panel.getByRole("tab", { name: /^Episodes/ })).toContainText("on");
    await kinds.getByLabel("Episodes", { exact: true }).uncheck();
    await expect(panel.getByRole("tab", { name: /^Episodes/ })).toContainText("off");
    // With no Discord destination, the preview shows the Hearth icon, and choosing a picture
    // says where it would go.
    // (the picture address sends the Hearth icon when there is no picture of its own, so the page
    // has no failed request).
    const picture = panel.getByTestId("announce-preview-picture");
    await expect
      .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
      .toBeGreaterThan(0);
    const sent = await request.get("/api/media-announce/sender-picture", { maxRedirects: 0 });
    expect(sent.status()).toBe(302);
    expect(sent.headers().location).toBe("/icon-192.png");
    await panel.getByTestId("announce-picture-input").setInputFiles("apps/web/public/icon-192.png");
    await expect(panel.getByTestId("announce-picture-note")).toContainText(
      "Choose a Discord destination",
    );
    await panel.getByLabel("Heading").fill("New at the Vault");
    await expect(panel.getByTestId("announce-preview")).toContainText("New at the Vault");
    // Banner: one picture Hearth draws leads the post, above the card.
    await panel.getByLabel(/^Banner/).check();
    await expect(panel.getByTestId("announce-preview-banner")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("announce-preview-title")).toHaveCount(0);
    await panel.getByLabel(/Streaming style/).check();
    await panel.getByTestId("announce-save").click();
    expect(
      await new AxeBuilder({ page }).include('[data-testid="media-announcements"]').analyze(),
    ).toMatchObject({ violations: [] });

    // A test goes to the chosen destination and says it is a test.
    await panel.getByLabel("Test destination").selectOption({ label: `Movie night ${run}` });
    await panel.getByTestId("announce-test").click();
    await expect(panel.getByTestId("announce-test-result")).toContainText("Test sent");
    expect(received.at(-1)?.title ?? "").toContain("[Test]");
    expect(received.at(-1)?.message ?? "").toContain("TEST: not a real new arrival");

    // A new movie is announced once, to the friends channel.
    const before = received.length;
    await request.post("/api/test/fake-apps", { data: { jellyfinArrival: `Quiet Harbor ${run}` } });
    await panel.getByTestId("announce-check").click();
    const history = panel.getByTestId("announce-history");
    await expect(history).toContainText(`Quiet Harbor ${run}`, { timeout: 20_000 });
    await expect(history).toContainText(/sent/);
    expect(
      received
        .slice(before)
        .map((r) => r.title)
        .join(" "),
    ).toContain(`Quiet Harbor ${run}`);
    // Nothing from the back catalog went out.
    expect(received.map((r) => r.title).join(" ")).not.toMatch(/Dune|Harbor Lights/);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/media-announcements.png`,
      fullPage: true,
    });
  } finally {
    if (channelId) await request.delete(`/api/notifications/channels/${channelId}`);
    if (serviceId) await request.post(`/api/services/${serviceId}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    server.close();
  }
});

// Movie nights (FEATURE_CHECKLIST 40): plan one from a library movie, preview the invitation, post
// it to the friends destination, add a guest, move it, and cancel it; each change reaches friends.
test("movie nights: plan, invite, add a guest, move it, and cancel it", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const received: { title: string; message: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/friends`;
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.97`;
  let serviceId = "";
  let channelId = "";
  try {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const made = await request.post("/api/services", {
      data: {
        name: `Jellyfin night ${run}`,
        kind: "web",
        address: `http://${host}:8096`,
        category: "Media",
      },
    });
    expect(made.status(), await made.text()).toBe(201);
    serviceId = ((await made.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `Jellyfin night ${run} key`,
        kind: "api-key",
        tier: "automation",
        scope: "read",
        serviceId,
        value: "e2e-jellyfin-key",
      },
    });
    channelId = (
      (await (
        await request.post("/api/notifications/destinations", {
          data: { kind: "webhook", name: `Friends ${run}`, audience: "public" },
        })
      ).json()) as { id: string }
    ).id;
    await request.put(`/api/notifications/channels/${channelId}`, {
      data: { values: { url: hook } },
    });
    await request.put("/api/notifications/routes/media-arrivals", {
      data: { channels: [channelId] },
    });
    // Hearth learns the library (nothing is announced for what is already there).
    await request.post("/api/media-announce/check", { data: {} });

    // Movie nights have their own panel (11-12); Settings only points there.
    await page.goto("/notifications#movie-nights");
    await expect(page.getByTestId("movie-nights-moved")).toBeVisible();
    await page.goto(`/?panels=${encodeURIComponent("tool:movie-nights")}`);
    const nights = page.getByTestId("movie-nights");
    await expect(nights).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("movie-nights-setup")).toHaveAttribute(
      "href",
      "/notifications#media-announcements",
    );
    await nights.getByTestId("movie-night-new").click();
    await nights.getByLabel("Find a movie").fill("anora");
    await nights.getByTestId("movie-night-title").filter({ hasText: "Anora" }).first().click();
    await expect(nights.getByTestId("movie-night-chosen")).toHaveText("Anora");
    await nights.getByLabel("Spots").fill("4");
    await nights.getByLabel("Note", { exact: true }).fill("Popcorn at 7:45");
    const preview = nights.getByTestId("movie-night-preview");
    await expect(preview).toContainText("Movie night");
    await expect(preview).toContainText("Anora");
    await expect(preview).toContainText("4 spots left");
    // The note stands out in a quote; the host's own Where to watch replaces Hearth's links.
    await expect(nights.getByTestId("movie-night-preview-quote")).toContainText("Popcorn at 7:45");
    // The style: Cinematic puts the poster beside the details; Streaming a wide picture under them.
    await expect(preview.getByTestId("movie-night-preview-wide")).toHaveCount(0);
    await nights
      .getByTestId("movie-night-look")
      .getByLabel(/^Streaming/)
      .check();
    await expect(preview.getByTestId("movie-night-preview-wide")).toBeVisible();
    // Banner: one picture Hearth makes leads the post, above the card.
    await nights
      .getByTestId("movie-night-look")
      .getByLabel(/^Banner/)
      .check();
    await expect(preview.getByTestId("movie-night-preview-banner")).toBeVisible({
      timeout: 20_000,
    });
    await expect(preview.getByTestId("movie-night-preview-wide")).toHaveCount(0);
    await nights
      .getByTestId("movie-night-look")
      .getByLabel(/^Cinematic/)
      .check();
    await expect(preview.getByTestId("movie-night-preview-wide")).toHaveCount(0);
    // A Discord channel saved once (its link), then one click puts it in the note as a link.
    const chans = nights.getByTestId("movie-night-channels");
    await chans.getByTestId("movie-night-channel-add").click();
    await chans.getByLabel("Channel name").fill(`chat-${run}`);
    await chans
      .getByLabel("Channel link")
      .fill("https://discord.com/channels/111111111111111111/123456789012345678");
    await chans.getByRole("button", { name: "Save", exact: true }).click();
    await chans.getByRole("button", { name: `Add #chat-${run} to the note` }).click();
    await expect(nights.getByLabel("Note", { exact: true })).toHaveValue(
      `Popcorn at 7:45 #chat-${run} `,
    );
    await expect(preview.getByTestId("discord-mention")).toHaveText(`# chat-${run}`);
    await chans.getByRole("button", { name: `Forget #chat-${run}` }).click();
    await expect(chans).not.toContainText(`chat-${run}`);
    // A place is one click away (ideas until the host saves their own).
    const where = nights.getByTestId("movie-night-where");
    await where
      .getByTestId("movie-night-place")
      .filter({ hasText: "Plezy Watch Together" })
      .click();
    await expect(preview).toContainText("choose Join Room");
    await nights.getByLabel("Where to watch", { exact: true }).fill("Come over to the house");
    await expect(preview).toContainText("Come over to the house");
    // Saved for next time, then forgotten again so other runs start the same.
    await where.getByTestId("movie-night-place-save").click();
    await where.getByTestId("movie-night-place-name").fill(`House ${run}`);
    await where.getByRole("button", { name: "Save", exact: true }).click();
    await expect(where.getByTestId("movie-night-places")).toContainText(`House ${run}`);
    await where.getByRole("button", { name: `Forget the place House ${run}` }).click();
    await expect(where.getByTestId("movie-night-places")).not.toContainText(`House ${run}`);
    // A page screenshot: an element one resizes the window on the desk, which rebuilds the panel.
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/movie-night-plan.png`,
    });
    expect(
      await new AxeBuilder({ page }).include('[data-testid="movie-nights"]').analyze(),
    ).toMatchObject({ violations: [] });
    // Only this run's destination is invited (others from earlier runs may exist, a bot too).
    for (const box of await nights
      .getByRole("group", { name: "Invite" })
      .getByRole("checkbox")
      .all())
      // Ticked whether or not a bot from an earlier test was picked first.
      if (((await box.evaluate((e) => e.parentElement?.textContent ?? "")) ?? "").includes(run))
        await box.check();
      else await box.uncheck();
    await nights.getByTestId("movie-night-post").click();

    const card = nights.getByTestId("movie-night").filter({ hasText: "Anora" }).first();
    await expect(card.getByTestId("movie-night-status")).toHaveText("Planned");
    await expect(card).toContainText(`Friends ${run}`);
    await expect.poll(() => received.map((r) => r.title)).toContain("Movie night: Anora (2024)");
    expect(received.at(-1)!.message).toContain("Popcorn at 7:45");
    await nights.screenshot({
      path: `test-results/screens/${testInfo.project.name}/movie-nights.png`,
    });

    // A guest: on the list here; a text destination is not pinged for it.
    const before = received.length;
    await card.getByLabel("Add a guest to Anora").fill("Sam");
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await expect(card.getByTestId("movie-night-guest")).toHaveText(["Sam"]);
    expect(received.length).toBe(before);

    // A new time reaches everyone.
    await card.getByRole("button", { name: "Change the time" }).click();
    const later = new Date(Date.now() + 9 * 24 * 60 * 60_000);
    const p = (n: number) => String(n).padStart(2, "0");
    await card
      .getByLabel("New time for Anora")
      .fill(`${later.getFullYear()}-${p(later.getMonth() + 1)}-${p(later.getDate())}T20:30`);
    await card.getByRole("button", { name: "Save the new time" }).click();
    await expect.poll(() => received.length).toBe(before + 1);
    expect(received.at(-1)!.message).toContain("1 going · 3 spots left");

    // The watch-party room code, added once the host has made the room: everyone gets it.
    await card.getByTestId("movie-night-edit-where-open").click();
    await card.getByLabel("Room code for Anora").fill("4N7-54F");
    await card.getByTestId("movie-night-save-where").click();
    await expect(card).toContainText("room code 4N7-54F");
    await expect.poll(() => received.length).toBe(before + 2);
    expect(received.at(-1)!.message).toContain("Room code: 4N7-54F");

    // Cancelled: friends are told, and the card says so.
    await card.getByRole("button", { name: "Cancel it" }).click();
    await card.getByRole("button", { name: "Cancel the movie night" }).click();
    await expect(card.getByTestId("movie-night-status")).toHaveText("Cancelled");
    await expect.poll(() => received.at(-1)?.title).toBe("Movie night cancelled: Anora (2024)");
  } finally {
    if (channelId) await request.delete(`/api/notifications/channels/${channelId}`);
    if (serviceId) await request.post(`/api/services/${serviceId}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    server.close();
  }
});

// Movie nights with nowhere to send invitations (11-12): the panel says so and its button goes
// straight to the setting (adding a channel when there is none, else choosing who is invited).
test("movie nights without a destination send you straight to the setting", async ({ page }) => {
  await page.route("**/api/movie-nights", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { nights: [], destinations: [] } })
      : route.fallback(),
  );
  await page.goto(`/?panels=${encodeURIComponent("tool:movie-nights")}`);
  const card = page.getByTestId("movie-night-no-destinations");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("First, where do invitations go?");
  await page.screenshot({
    path: `test-results/screens/${test.info().project.name}/movie-nights-set-up.png`,
  });
  await expect(page.getByTestId("movie-night-new")).toHaveCount(0);
  const go = card.getByTestId("movie-night-setup-invites");
  const href = await go.getAttribute("href");
  expect(["/notifications#channels", "/notifications#media-announcements"]).toContain(href);
  await go.click();
  await expect(page).toHaveURL(new RegExp(`${href!.replace("#", "#")}$`));
  await expect(page.locator(href!.slice(href!.indexOf("#")))).toBeInViewport({ timeout: 10_000 });
});

// Plan a movie night from a movie (11-12): the panel opens planning with that movie chosen, and a
// plan in progress survives the panel being rebuilt (the window resized between desk and phone).
test("plan a movie night from a movie, and keep the plan when the window changes size", async ({
  page,
}) => {
  await page.route("**/api/movie-nights", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { nights: [], destinations: [{ id: "d1", name: "Friends" }] } })
      : route.fallback(),
  );
  await page.route("**/api/movie-nights/titles**", (route) =>
    route.fulfill({
      json: [
        { key: "k1", title: "Anora" },
        { key: "k2", title: "Anora Returns" },
      ],
    }),
  );
  await page.addInitScript(() => sessionStorage.setItem("hearth.movieNight.plan", "Anora"));
  await page.goto(`/?panels=${encodeURIComponent("tool:movie-nights")}`);
  const nights = page.getByTestId("movie-nights");
  await expect(nights.getByTestId("movie-night-chosen")).toHaveText("Anora", { timeout: 20_000 });
  await nights.getByLabel("Note", { exact: true }).fill("Bring snacks");
  // From desk to phone width and back: the panel is rebuilt, the plan is not lost.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.setViewportSize(size);
  await expect(nights.getByTestId("movie-night-chosen")).toHaveText("Anora", { timeout: 10_000 });
  await expect(nights.getByLabel("Note", { exact: true })).toHaveValue("Bring snacks");
});
