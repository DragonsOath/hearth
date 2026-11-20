import { expect, test } from "@playwright/test";

// Add a speaker (11-05): from the music card, link Music Assistant first; then this device,
// or a link another computer (the PC you remote desktop from) opens to become a speaker. The
// link pairs it like a home tablet and opens the home screen with Add a speaker ready.

test("Add a speaker: this device, and a link for another computer", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  test.skip(info.project.name === "mobile", "One run is enough: it is about the pairing.");
  const run = `spk${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.18`;
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
  await expect(home.getByTestId("home-now-playing")).toHaveText("Harbor Song", { timeout: 20_000 });

  // Not linked yet: it says to link Music Assistant first.
  await home.getByTestId("home-add-speaker-btn").click();
  const win = page.getByTestId("home-add-speaker");
  await expect(win).toContainText("Kitchen speaker");
  await expect(win.getByRole("button", { name: "Link", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // Linked (Music Assistant with its key in the vault): this device, and another computer.
  const ma = await page.request.post("/api/services", {
    data: {
      name: `Music Assistant ${run}`,
      kind: "web",
      address: `http://${host}:8097`,
      category: "Media",
    },
  });
  const maId = ((await ma.json()) as { id: string }).id;
  try {
    await page.request.post("/api/vault/secrets", {
      data: {
        name: `Music Assistant ${run} key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: maId,
        value: "e2e-ma-key",
      },
    });
    await page.reload();
    await home.getByTestId("home-add-speaker-btn").click();
    await expect(win.getByTestId("home-speaker-start")).toBeVisible();
    // The Hearth computer itself, as a speaker by itself (off in tests), with its switch.
    await expect(win.getByTestId("home-speaker-host")).toContainText("The Hearth computer");
    // No QR code: the link is copied, with the steps for the other PC.
    await expect(win.locator("canvas, svg[aria-label*='QR']")).toHaveCount(0);
    await expect(win.getByTestId("home-speaker-host-toggle")).toBeVisible();
    await win.getByTestId("home-speaker-link").click();
    const url = (await win.getByTestId("home-speaker-url").textContent())!.trim();
    expect(url).toMatch(/\/pair\?code=.+&next=speaker$/);
    await page.screenshot({
      path: `test-results/screens/${info.project.name}/home-add-speaker.png`,
    });

    // The other computer: opens the link, lands on the home screen with Add a speaker open.
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pc = await other.newPage();
    await pc.goto(url);
    await expect(pc).toHaveURL(/\/home-screen\?speaker=1/, { timeout: 20_000 });
    await expect(pc.getByTestId("home-speaker-here")).toBeVisible({ timeout: 20_000 });
    // A home tablet can't make links of its own.
    await expect(pc.getByTestId("home-speaker-other")).toHaveCount(0);
    await other.close();
  } finally {
    // Removed, so later tests start with no Music Assistant linked (there is no DELETE route).
    await page.request.post(`/api/services/${maId}/remove`, { data: {} });
  }
});
