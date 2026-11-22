import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Plex, Jellyfin and Emby panels open on Home (11-21, the owner: "we need to see the home screen
// and its rows ... that should be the default page it opens to"), against the stand-in servers.
// Refresh reads the home screen again, so a row made elsewhere or a title that just landed shows.
// 11-22: the home screen itself, rows of posters as the server shows them, not the editor.

const host = (end: number) =>
  `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${end}`;

async function add(page: Page, name: string, port: number, end: number, key: string) {
  const res = await page.request.post("/api/services", {
    data: { name, kind: "web", address: `http://${host(end)}:${port}`, category: "Media" },
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
      value: key,
    },
  });
  return id;
}

/** Opens the panel without naming a tab: it should land on Home. */
async function openPanel(page: Page, id: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}`)}`);
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("tab", { name: "Home", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  return panel;
}

test("Plex opens on its home screen, and Refresh reads it again", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // "Plex: <run>" is recognized as Plex by its name.
  const id = await add(page, `Plex: home ${testInfo.project.name}`, 32400, 41, "e2e-home-tab-plex");
  try {
    const panel = await openPanel(page, id);
    const home = panel.getByTestId("server-home");
    const rows = home.getByTestId("screen-row");
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await expect(rows.first().getByTestId("screen-poster").first()).toBeVisible();
    // Continue Watching first, from Plex's Home, as Plex shows it (11-22).
    await expect(rows.first().getByRole("heading").first()).toHaveText("Continue Watching");
    // Nothing to edit here: Home rows does that, one click away.
    await expect(home.getByTestId("home-row")).toHaveCount(0);
    await expect(home.getByTestId("server-home-change")).toBeVisible();

    // Refresh asks the server again for its rows and their posters.
    const asked = page.waitForRequest((r) => r.url().includes("/api/home-rows/options"));
    await home.getByTestId("server-home-refresh").click();
    await asked;
    await expect(home.getByTestId("server-home-read")).toHaveText("Read just now.");
    await expect(rows.first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .include('[data-testid="server-home"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(
      results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.help}`),
    ).toEqual([]);
    await home.screenshot({
      path: `test-results/screens/${testInfo.project.name}/plex-home-tab.png`,
    });
    // Overview is one tab away.
    await panel.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(home).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/services/${id}`);
  }
});

test("Jellyfin and Emby open on their home screens too", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const jf = await add(page, `Jellyfin ${run}`, 8096, 42, "e2e-home-tab-jellyfin");
  const emby = await add(page, `Emby ${run}`, 8096, 95, "e2e-home-tab-emby");
  try {
    let panel = await openPanel(page, jf);
    await expect(panel.getByTestId("server-home").getByTestId("screen-row").first()).toBeVisible({
      timeout: 20_000,
    });
    await panel.getByTestId("server-home").screenshot({
      path: `test-results/screens/${testInfo.project.name}/jellyfin-home-tab.png`,
    });
    const asked = page.waitForRequest((r) => r.url().includes(`/api/services/${jf}/jellyfin/home`));
    await panel.getByTestId("server-home-refresh").click();
    await asked;

    panel = await openPanel(page, emby);
    await expect(panel.getByTestId("server-home").getByTestId("screen-row").first()).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await page.request.delete(`/api/services/${jf}`);
    await page.request.delete(`/api/services/${emby}`);
  }
});
