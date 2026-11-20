import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const OWNER_PASSWORD = "e2e owner password";

// The home dashboard (11-04, redesigned 11-05): Home Assistant's Home tab and its full screen,
// against the stand-in Home Assistant (port 8123). The window follows the real weather; taps act
// straight away; opening a door asks for the unlock PIN; the settings stay on this screen; when
// Home Assistant stops answering it says so; a paired home tablet sees nothing else of Hearth.

async function addHomeAssistant(request: APIRequestContext, run: string) {
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.15`;
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

/** A page by its tab: the top bar on a wide screen, the bottom bar on a phone. */
const goTo = (page: Page, name: string) => page.locator(`[data-page="${name}"]:visible`).click();

test("Home tab: the weather window, music, lists, rooms, the thermostat, doors with the PIN, settings", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const id = await addHomeAssistant(page.request, `${info.project.name}${Date.now() % 100000}`);
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home).toBeVisible({ timeout: 20_000 });

  // The time and the weather, from Home Assistant; the window shows a partly cloudy night.
  await expect(home.getByTestId("home-clock")).toBeVisible();
  await expect(home.getByTestId("home-weather")).toContainText("18°C");
  await expect(home.getByTestId("home-weather")).toContainText("Feels like 17°C");
  await expect(home.getByTestId("home-forecast").locator("li")).toHaveCount(5);
  await expect(home.getByTestId("home-hourly").locator("li")).toHaveCount(6);
  await expect(home.getByTestId("home-scene")).toHaveAttribute("data-scene", "partly-night");
  await expect(home.getByTestId("home-now-playing")).toHaveText("Harbor Song");
  await expect(home.getByTestId("home-event").first()).toContainText("Dentist");
  await page.screenshot({ path: `test-results/screens/${info.project.name}/home-dashboard.png` });

  // The forecast opens with the hours and the days.
  await home.getByTestId("home-weather").click();
  await expect(page.getByTestId("home-weather-detail")).toContainText("The next hours");
  // A window always has a way out: its Close button (and Escape, and a tap outside).
  await page.getByTestId("modal-close").click();
  await expect(page.getByTestId("home-weather-detail")).toHaveCount(0);

  // Music: the whole card is the poster; one tap pauses, no approval card.
  const card = home.getByTestId("home-music");
  await expect(card.getByTestId("home-music-poster")).toBeVisible();
  await home.getByTestId("home-play").click();
  await expect(home.getByTestId("home-play")).toHaveAttribute("aria-label", "Play", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("approve-here")).toHaveCount(0);

  // The song has an official video: Video plays it in the card, muted, under the controls.
  await card.getByTestId("home-av-video").click();
  await expect(card.getByTestId("home-music-video")).toHaveAttribute(
    "src",
    /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?.*mute=1/,
  );
  await expect(card.getByTestId("home-play")).toBeVisible();
  await page.screenshot({ path: `test-results/screens/${info.project.name}/home-music-video.png` });
  // The eye hides the controls; a tap on the card brings them back.
  await card.getByTestId("home-music-hide").click();
  await expect(card.getByTestId("home-play")).toHaveCount(0);
  await card.getByTestId("home-music-show").click();
  await expect(card.getByTestId("home-play")).toBeVisible();
  await card.getByRole("button", { name: "Audio" }).click();
  await expect(card.getByTestId("home-music-poster")).toBeVisible();
  // Watch on TV: the speaker is a Cast TV, so the video plays there through Home Assistant.
  await card.getByTestId("home-av-video").click();
  await card.getByTestId("home-video-tv").click();
  await expect(home.getByTestId("home-now-playing")).toHaveText("YouTube video dQw4w9WgXcQ", {
    timeout: 15_000,
  });

  // Groceries: add one, tick it off.
  const lists = home.getByTestId("home-lists");
  await lists.getByTestId("home-list-adding").click();
  await lists.getByTestId("home-list-add").fill("Apples");
  await lists.getByRole("button", { name: "Add", exact: true }).click();
  await expect(lists.getByTestId("home-list-item").filter({ hasText: "Apples" })).toBeVisible({
    timeout: 15_000,
  });
  await lists.getByRole("button", { name: "Done: Apples" }).click();
  await expect(lists.getByTestId("home-list-item").filter({ hasText: "Apples" })).toHaveCount(0, {
    timeout: 15_000,
  });

  // Rooms: a light by its room, and the thermostat a step warmer.
  await goTo(page, "rooms");
  const rooms = home.getByTestId("home-rooms");
  await rooms.getByRole("tab", { name: /Living room/ }).click();
  const lamp = rooms.locator('[data-entity="light.living_room"]');
  await lamp.click();
  await expect(lamp).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  const climate = home.getByTestId("home-climate");
  await climate.getByRole("button", { name: "Warmer" }).click();
  await expect(climate.getByTestId("home-climate-target")).toHaveText("21.5°");
  await expect(page.getByTestId("home-note")).toContainText("Thermostat", { timeout: 15_000 });
  // Moving between pages keeps the room chosen.
  await goTo(page, "home");
  await goTo(page, "rooms");
  await expect(rooms.getByRole("tab", { name: /Living room/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Doors: locking is one tap; unlocking needs the PIN, set first below the dashboard.
  await goTo(page, "security");
  const front = home.locator('[data-testid="home-secure"][data-entity="lock.front_door"]');
  await front.getByRole("button", { name: "Unlock" }).click();
  for (const n of ["1", "2", "3", "4"])
    await page.getByTestId("pin-pad").getByRole("button", { name: n }).click();
  await page.getByTestId("pin-enter").click();
  // No PIN yet (or, on the second run, not this one): either way the door stays shut.
  await expect(page.getByTestId("home-note")).toContainText(/No unlock PIN is set|not right/, {
    timeout: 15_000,
  });
  // Setting the PIN asks you to have confirmed it's you lately: confirm, as the owner would.
  await page.request.post("/api/auth/login", { data: { password: OWNER_PASSWORD } });
  await page.getByTestId("home-pin-input").fill("2468");
  await page.getByTestId("home-pin-form").getByRole("button", { name: "Set the PIN" }).click();
  await expect(page.getByTestId("home-pin-form")).toContainText("The unlock PIN is set");
  // A wrong PIN does nothing.
  await front.getByRole("button", { name: "Unlock" }).click();
  for (const n of ["9", "9", "9", "9"])
    await page.getByTestId("pin-pad").getByRole("button", { name: n }).click();
  await page.getByTestId("pin-enter").click();
  await expect(page.getByTestId("home-note")).toContainText(/PIN/, { timeout: 15_000 });
  await expect(front.getByTestId("home-secure-state")).toHaveText("Locked");
  await front.getByRole("button", { name: "Unlock" }).click();
  for (const n of ["2", "4", "6", "8"])
    await page.getByTestId("pin-pad").getByRole("button", { name: n }).click();
  await page.getByTestId("pin-enter").click();
  await expect(front.getByTestId("home-secure-state")).toHaveText("Unlocked", { timeout: 15_000 });
  await expect(home.getByTestId("home-status-chip")).toContainText("Front door unlocked");
  await front.getByRole("button", { name: "Lock" }).click();
  await expect(front.getByTestId("home-secure-state")).toHaveText("Locked", { timeout: 15_000 });

  // Household: connect a list through Home Assistant's own setup.
  await goTo(page, "household");
  const full = home.getByTestId("home-lists-full");
  await full.getByTestId("home-connect-lists").click();
  await page.locator('[data-handler="local_todo"]').click();
  await page.getByTestId("home-connect-field-todo_list_name").fill("Chores two");
  await page.getByTestId("home-connect-next").click();
  await expect(page.getByTestId("home-connect-done")).toContainText("Chores two");
  await page.getByTestId("home-connect-done").getByRole("button", { name: "Done" }).click();
  await expect(full.getByRole("tab", { name: /Chores two/ })).toBeVisible({ timeout: 15_000 });

  // Settings on this screen: a 24-hour clock and no scenes, still so after a reload.
  await goTo(page, "home");
  await home.getByTestId("home-settings-open").click();
  const sheet = page.getByTestId("home-settings");
  await sheet.getByRole("button", { name: "24-hour" }).click();
  await sheet.getByRole("button", { name: "Move and resize" }).click();
  await page.getByRole("button", { name: "Remove Scenes" }).click();
  await page.getByTestId("home-customizing").getByRole("button", { name: "Done" }).click();
  await expect(home.getByTestId("home-clock")).toHaveText(/^\d\d:\d\d$/);
  await expect(home.getByTestId("home-scenes")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("home-clock")).toHaveText(/^\d\d:\d\d$/, { timeout: 20_000 });
  await expect(page.getByTestId("home-scenes")).toHaveCount(0);
  // Back from the gallery.
  await page.getByTestId("home-settings-open").click();
  await page.getByTestId("home-open-gallery").click();
  await page.getByTestId("home-gallery-scenes").click();
  await page.getByTestId("home-gallery").getByRole("button", { name: "Done" }).click();
  await page.getByTestId("home-customizing").getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("home-scenes")).toBeVisible();
  await page.getByTestId("home-settings-open").click();
  await page.getByTestId("home-settings").getByRole("button", { name: "In words" }).click();

  // Full screen: the same dashboard without the rest of Hearth.
  await page.getByTestId("home-full-screen").click();
  await expect(page).toHaveURL(/\/home-screen/);
  await expect(page.getByTestId("home-screen").getByTestId("home-clock")).toBeVisible();
  await expect(page.getByTestId("home-scenes")).toBeVisible();
  await page.screenshot({ path: `test-results/screens/${info.project.name}/home-screen.png` });
});

test("the window follows the weather, swipes between pages, and says when Home Assistant stops answering", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const id = await addHomeAssistant(page.request, `wx${Date.now() % 100000}`);
  await page.request.post("/api/test/fake-apps", {
    data: { home: { condition: "snowy", sunUp: true } },
  });
  await page.goto(`/home-screen?service=${id}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home.getByTestId("home-scene")).toHaveAttribute("data-scene", "snow", {
    timeout: 20_000,
  });
  await page.request.post("/api/test/fake-apps", {
    data: { home: { condition: "lightning-rainy" } },
  });
  await expect(home.getByTestId("home-scene")).toHaveAttribute("data-scene", "storm", {
    timeout: 20_000,
  });

  // Swiping a finger sideways moves a page; the page dots and arrows do too.
  if (info.project.name === "mobile") {
    const box = (await home.getByTestId("home-home-page").boundingBox())!;
    const y = box.y + 140;
    await home.getByTestId("home-home-page").dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: box.x + 300,
      clientY: y,
    });
    await home.getByTestId("home-home-page").dispatchEvent("pointermove", {
      pointerType: "touch",
      clientX: box.x + 200,
      clientY: y,
    });
    await home.getByTestId("home-home-page").dispatchEvent("pointerup", {
      pointerType: "touch",
      clientX: box.x + 100,
      clientY: y,
    });
    await expect(home.getByTestId("home-rooms-page")).toBeVisible();
  } else {
    await home.getByRole("button", { name: "Next page" }).click();
    await expect(home.getByTestId("home-rooms-page")).toBeVisible();
    await home.getByRole("button", { name: "Previous page" }).click();
    await expect(home.getByTestId("home-home-page")).toBeVisible();
  }

  // Home Assistant stops answering: the last reading stays, and the dashboard says so.
  await page.request.post("/api/test/fake-apps", { data: { home: { down: true } } });
  await expect(home.getByTestId("home-offline")).toBeVisible({ timeout: 30_000 });
  await expect(home.getByTestId("home-status-chip")).toContainText("not answering");
  await page.request.post("/api/test/fake-apps", { data: { home: { down: false } } });
  await expect(home.getByTestId("home-offline")).toHaveCount(0, { timeout: 30_000 });
});

test("a paired home tablet opens the home dashboard and nothing else", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  test.skip(info.project.name === "mobile", "One run is enough: it is about the sign-in.");
  await addHomeAssistant(page.request, `tablet${Date.now() % 100000}`);
  // The owner makes a home tablet code in Devices.
  await page.goto("/devices?add=home");
  const add = page.getByTestId("add-device");
  await expect(add.getByRole("radio", { name: /home tablet/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await add.getByRole("button", { name: "Show a QR code" }).click();
  const code = (await page.getByTestId("device-code").textContent())!.trim();

  // The tablet: its own browser, signed in with the code.
  const tablet = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 1280, height: 800 },
  });
  const screen = await tablet.newPage();
  await screen.goto(`/pair?code=${encodeURIComponent(code)}`);
  await expect(screen).toHaveURL(/\/home-screen/, { timeout: 20_000 });
  await expect(screen.getByTestId("home-now-playing")).toHaveText("Harbor Song", {
    timeout: 20_000,
  });
  // No connecting and no PIN changes from a tablet; its settings are only for this screen.
  await screen.getByTestId("home-settings-open").click();
  await expect(screen.getByTestId("home-settings")).toContainText("Clock");
  await expect(screen.getByTestId("home-owner-note")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Unpair this tablet" })).toBeVisible();
  await screen.getByTestId("home-settings").getByRole("button", { name: "Done" }).click();
  // Anywhere else comes back here, and the server refuses the rest anyway.
  await screen.goto("/vault");
  await expect(screen).toHaveURL(/\/home-screen/);
  expect((await screen.request.get("/api/workspace")).status()).toBe(403);
  expect((await screen.request.get("/api/jobs")).status()).toBe(403);
  await screen.screenshot({ path: "test-results/screens/desktop/home-tablet.png" });
  await tablet.close();
});
