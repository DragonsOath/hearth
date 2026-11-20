import { expect, test } from "@playwright/test";

// The calendar (11-05): a month of every calendar, an event opens to change or delete it, new
// events go to the calendar you pick; and the little month in the Today card opens a day.

test("calendar: the month, change an event, add one, delete one", async ({ page }, info) => {
  test.setTimeout(60_000);
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
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home).toBeVisible({ timeout: 20_000 });

  // The little month in the Today card opens the calendar.
  await expect(home.getByTestId("home-mini-month")).toBeVisible();
  await home.locator('[data-page="household"]:visible').click();
  const cal = home.getByTestId("home-agenda");
  await expect(cal.getByTestId("home-cal-month")).toBeVisible();
  await expect(
    cal.getByTestId("home-cal-event").filter({ hasText: "Soccer practice" }),
  ).toBeVisible();
  await page.screenshot({ path: `test-results/screens/${info.project.name}/home-calendar.png` });

  // Change an event: Google only adds and deletes, so Hearth replaces it.
  await cal.getByTestId("home-cal-event").filter({ hasText: "Soccer practice" }).click();
  const win = page.getByTestId("home-event-window");
  await win.getByTestId("home-event-edit").click();
  await win.getByTestId("home-event-title").fill("Soccer finals");
  await win.getByTestId("home-event-save").click();
  await expect(win).toBeHidden();
  await expect(
    cal.getByTestId("home-cal-event").filter({ hasText: "Soccer finals" }),
  ).toBeVisible();
  await expect(
    cal.getByTestId("home-cal-event").filter({ hasText: "Soccer practice" }),
  ).toHaveCount(0);

  // Add one, then delete it.
  await cal.getByTestId("home-event-new").click();
  await page.getByTestId("home-event-title").fill("Vet appointment");
  await page.getByTestId("home-event-save").click();
  await expect(
    cal.getByTestId("home-cal-event").filter({ hasText: "Vet appointment" }),
  ).toBeVisible();
  await cal.getByTestId("home-cal-event").filter({ hasText: "Vet appointment" }).click();
  await page.getByTestId("home-event-delete").click();
  await expect(
    cal.getByTestId("home-cal-event").filter({ hasText: "Vet appointment" }),
  ).toHaveCount(0);
});

test("Google Calendar: the app step is a guide with each Google page and every value to copy", async ({
  page,
}, info) => {
  test.skip(info.project.name === "mobile", "One run is enough.");
  const run = `g${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.21`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await page.request.post("/api/services", {
    data: {
      name: `Home Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8123`,
      category: "Home",
    },
  });
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
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await home.getByTestId("home-settings-open").click();
  await page.getByTestId("home-settings").getByRole("button", { name: "A calendar" }).click();
  await page
    .getByTestId("home-connect")
    .getByRole("button", { name: /Google Calendar/ })
    .click();
  const guide = page.getByTestId("google-guide");
  await expect(guide.locator("li")).toHaveCount(6);
  await expect(guide).toContainText("Publish it");
  await expect(guide).toContainText("https://my.home-assistant.io/redirect/oauth");
  await expect(
    guide.getByRole("link", { name: /Turn on the Google Calendar API/ }),
  ).toHaveAttribute("href", /calendar-json\.googleapis\.com/);
});

test("calendar: Google needs a sign-in again, the card says so and renews it in one step", async ({
  page,
}, info) => {
  // 11-18, the owner's Google Calendar: Google stopped accepting Home Assistant's sign-in, the card
  // said "No calendars yet", and Connect started a new Google setup that ended "Invalid flow".
  test.setTimeout(60_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.18`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  await page.request.post("/api/test/fake-apps", { data: { home: { googleSignInAgain: true } } });
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
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home).toBeVisible({ timeout: 20_000 });
  const trouble = home.getByTestId("home-calendar-trouble").first();
  await expect(trouble).toContainText("Google Calendar needs you to sign in again");
  await expect(home.getByTestId("home-calendar").getByText("No calendars yet")).toHaveCount(0);
  await expect(trouble.getByTestId("home-calendar-ask-ember")).toBeVisible();
  await home
    .getByTestId("home-calendar")
    .first()
    .screenshot({
      path: `test-results/screens/${info.project.name}/home-calendar-sign-in-again.png`,
    });
  // One step: straight to Google's sign-in, renewing the connection that is there.
  await trouble.getByTestId("home-calendar-sign-in-again").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("home-connect-renewing")).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Open the sign-in page/ })).toHaveAttribute(
    "href",
    /accounts\.google\.com/,
  );
});

test("calendar: a sign-in thrown away, the card still signs in again (Home Assistant asks afresh)", async ({
  page,
}, info) => {
  // 11-18, the owner again: the waiting sign-in was used up in an old tab, so Home Assistant had
  // none waiting, the card offered only Ember, and he had to Reload Google in Home Assistant.
  test.setTimeout(60_000);
  const run = `${info.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.19`;
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  await page.request.post("/api/test/fake-apps", { data: { home: { googleSignInLost: true } } });
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
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@home`)}`);
  const home = page.getByTestId("home-dashboard");
  await expect(home).toBeVisible({ timeout: 20_000 });
  const trouble = home.getByTestId("home-calendar-trouble").first();
  await expect(trouble).toContainText("can't read right now");
  // Home Assistant's own repairs, at the address a browser reaches it on.
  await expect(trouble.getByTestId("home-calendar-open-repairs")).toHaveAttribute(
    "href",
    `http://${host}:8123/config/repairs`,
  );
  await trouble.getByTestId("home-calendar-sign-in-again").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("home-connect-renewing")).toBeVisible({ timeout: 20_000 });
  // My Home Assistant asks for this address once per browser: it is right there to copy.
  await expect(dialog.getByTestId("home-connect-address")).toContainText(`http://${host}:8123`);
  await dialog.screenshot({
    path: `test-results/screens/${info.project.name}/home-calendar-sign-in-afresh.png`,
  });
});
