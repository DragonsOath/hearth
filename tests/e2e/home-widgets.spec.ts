import { expect, test, type APIRequestContext } from "@playwright/test";

// The widget gallery (11-05): every widget a family might want, chosen per screen, each showing
// only what is real (the stand-in Home Assistant, or Hearth's household board). Notes, chores and
// countdowns are kept by Hearth and shared by every screen; the doorbell brings its camera up.

async function addHomeAssistant(request: APIRequestContext, run: string) {
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.16`;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Home Assistant ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-home-token",
    },
  });
  return id;
}

test("the widget gallery adds widgets that show the real home, and the family board", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const id = await addHomeAssistant(page.request, run);
  await page.request.post("/api/home/board", {
    data: { op: "feeds.set", feeds: [{ url: "https://news.test/rss" }] },
  });
  // The next movie night (11-12): a stand-in list, so the widget has one to show.
  const nightAt = new Date(Date.now() + 2 * 86400_000).toISOString();
  await page.route("**/api/movie-nights", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            destinations: [],
            nights: [
              {
                id: "n1",
                title: "Harbor Lights",
                startsAt: nightAt,
                status: "scheduled",
                guests: ["Sam", "Riley"],
                spots: 6,
              },
              {
                id: "n0",
                title: "Old night",
                startsAt: nightAt,
                status: "cancelled",
                guests: [],
                spots: null,
              },
            ],
          },
        })
      : route.fallback(),
  );
  await page.goto(`/home-screen?service=${id}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home.getByTestId("home-now-playing")).toBeVisible({ timeout: 20_000 });

  // The gallery: every widget, grouped, with what each still needs.
  await home.getByTestId("home-settings-open").click();
  await page.getByTestId("home-open-gallery").click();
  const gallery = page.getByTestId("home-gallery");
  await expect(gallery.locator(".hd-card")).toHaveCount(21);
  await expect(gallery.getByTestId("home-gallery-music")).toHaveAttribute("aria-pressed", "true");
  for (const w of [
    "people",
    "devices",
    "energy",
    "travel",
    "notes",
    "chores",
    "countdown",
    "news",
    "doorbell",
    "sports",
    "movienight",
  ])
    await gallery.getByTestId(`home-gallery-${w}`).click();
  await expect(gallery.getByTestId("home-gallery-people")).toHaveAttribute("aria-pressed", "true");
  await gallery.getByRole("button", { name: "Done" }).click();
  await page.getByTestId("home-customizing").getByRole("button", { name: "Done" }).click();

  const night = home.getByTestId("home-movienight");
  await expect(night).toContainText("Harbor Lights");
  await expect(night).toContainText("Coming: Sam, Riley · 4 spots left");
  await expect(night).not.toContainText("Old night");

  // Home Assistant's own readings.
  await expect(home.getByTestId("home-people")).toContainText("Alex");
  await expect(home.getByTestId("home-people")).toContainText("Away");
  await expect(home.getByTestId("home-energy")).toContainText("1.4 kW");
  await expect(home.getByTestId("home-energy")).toContainText("8.4 kWh used today");
  await expect(home.getByTestId("home-travel")).toContainText("24 min");
  await expect(home.getByTestId("home-sports")).toContainText("Harbor City");
  await expect(home.getByTestId("home-doorbell")).toContainText("Front door doorbell");
  await expect(home.getByTestId("home-headline").first()).toContainText("Harbor bridge reopens", {
    timeout: 20_000,
  });

  // Devices: chosen from everything Home Assistant has, then flipped from the widget.
  await home.getByTestId("home-devices").getByRole("button", { name: "Choose devices" }).click();
  const picker = page.getByTestId("home-device-picker");
  await picker.getByLabel("Find a device").fill("guest");
  await picker.getByRole("button", { name: /Guest mode/ }).click();
  await picker.getByLabel("Find a device").fill("living room temp");
  await picker.getByRole("button", { name: /Living room temperature/ }).click();
  await picker.getByRole("button", { name: "Done" }).click();
  const devices = home.getByTestId("home-devices");
  await expect(devices.getByTestId("home-device")).toHaveCount(2, { timeout: 15_000 });
  await expect(devices).toContainText("21.3°C");
  await devices.getByRole("button", { name: "Off" }).click();
  await expect(devices.getByRole("button", { name: "On" })).toBeVisible({ timeout: 15_000 });

  // The family board: a note, a chore with stars, a countdown.
  const notes = home.getByTestId("home-notes");
  await notes.getByLabel("New note").fill(`Dinner at 7 ${run}`);
  await notes.getByRole("button", { name: "Post the note" }).click();
  await expect(notes.getByTestId("home-note-item").filter({ hasText: run })).toBeVisible();

  const chores = home.getByTestId("home-chores");
  await chores.getByRole("button", { name: "Add a chore" }).click();
  await chores.getByLabel("Chore").fill(`Feed the fish ${run}`);
  await chores.getByLabel("Whose").fill(`Kid ${run}`);
  await chores.getByRole("button", { name: "Daily" }).click();
  await chores.getByRole("button", { name: "Add", exact: true }).click();
  await chores.getByRole("button", { name: `Done: Feed the fish ${run}` }).click();
  await expect(chores.getByTestId("home-stars").filter({ hasText: `Kid ${run} 1` })).toBeVisible({
    timeout: 15_000,
  });

  const countdown = home.getByTestId("home-countdown");
  await countdown.getByRole("button", { name: "Add a countdown" }).click();
  await countdown.getByLabel("What").fill(`Trip ${run}`);
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await countdown.getByLabel("Date").fill(soon);
  await countdown.getByRole("button", { name: "Add", exact: true }).click();
  await expect(countdown).toContainText(`Trip ${run}`);

  // This screen keeps its choice; the board is Hearth's, there on any screen.
  await page.reload();
  await expect(page.getByTestId("home-people")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("home-notes")).toContainText(`Dinner at 7 ${run}`);
  await page.screenshot({ path: `test-results/screens/${info.project.name}/home-widgets.png` });

  // The doorbell rings: its camera comes up over everything.
  await page.request.post("/api/test/fake-apps", { data: { home: { ring: true } } });
  await expect(page.getByTestId("home-ring")).toContainText("Front door doorbell", {
    timeout: 20_000,
  });
  await page.getByTestId("home-ring").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("home-ring")).toHaveCount(0);

  // Tidy the shared board.
  await page
    .getByTestId("home-notes")
    .getByRole("button", { name: /Remove the note: Dinner at 7/ })
    .first()
    .click();
});
