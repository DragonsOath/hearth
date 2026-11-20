import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// RomM's panel (checklist 46.12) against the stand-in RomM 5.3 (port 8095): Overview, the
// Library with a game's page and a favourite, a scan approved and run, and a viewer's login that
// browses without scans. Every change goes through the real plan, approval and read-back code.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.19`;
};

async function addRomm(request: APIRequestContext, run: string, username = "hearth") {
  const res = await request.post("/api/services", {
    data: {
      name: `RomM ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8095`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const login = await request.post("/api/vault/secrets", {
    data: {
      name: `RomM ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username,
      value: "e2e-romm",
    },
  });
  expect(login.ok(), await login.text()).toBe(true);
  return id;
}

async function open(page: Page, id: string, tab: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@${tab}`)}`);
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

test.describe("RomM panel", () => {
  test.beforeEach(async ({ request }) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
  });

  test("Overview: totals, recently added with covers, favourites and platforms", async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    const id = await addRomm(page.request, `${info.project.name}${Date.now() % 100000}`);
    const panel = await open(page, id, "overview");
    const overview = panel.getByTestId("romm-dashboard");
    await expect(overview.getByTestId("romm-games")).toHaveText("8", { timeout: 20_000 });
    const recent = overview.getByTestId("romm-recent");
    await expect(recent.getByTestId("romm-game").first()).toContainText("Silent Ferry");
    // Covers come through Hearth and load.
    const cover = recent.getByRole("img", { name: "Silent Ferry cover" });
    await expect(cover).toBeVisible();
    await expect
      .poll(() => cover.evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBeGreaterThan(0);
    await expect(overview.getByTestId("romm-favorites")).toContainText("Lantern Quest");
    await expect(overview.getByTestId("romm-platforms")).toContainText(
      "Nintendo Entertainment System · 3",
    );
    const axe = await new AxeBuilder({ page }).include('[data-testid="romm-dashboard"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );
  });

  test("Library: find, filter, open a game and make it a favourite", async ({ page }, info) => {
    test.setTimeout(90_000);
    const id = await addRomm(page.request, `${info.project.name}${Date.now() % 100000}`);
    const panel = await open(page, id, "library");
    const library = panel.getByTestId("romm-library");
    await expect(library.getByTestId("romm-count")).toHaveText("8 games", { timeout: 20_000 });
    await library.locator('[data-hearth-target="library:search"]').fill("moss");
    await expect(library.getByTestId("romm-game")).toHaveText([/Moss Knight/], { timeout: 15_000 });
    await library.locator('[data-hearth-target="library:search"]').fill("");
    await library
      .locator('[data-hearth-target="library:platform"]')
      .selectOption({ label: "Super Nintendo Entertainment System (2)" });
    await expect(library.getByTestId("romm-count")).toHaveText("2 games", { timeout: 15_000 });
    await library.getByTestId("romm-game").filter({ hasText: "Harbor Lights" }).click();

    const game = panel.getByTestId("romm-game-page");
    await expect(game.getByTestId("romm-game-name")).toHaveText("Harbor Lights");
    await expect(game.getByTestId("romm-files")).toContainText("Harbor Lights (USA).sfc");
    await game.getByTestId("romm-favorite").click();
    const change = game.getByTestId("panel-change").first();
    await expect(change).toContainText("Add Harbor Lights to your favourites");
    await change.getByTestId("panel-confirm").click();
    await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 20_000 });
    await expect(game.getByTestId("romm-favorite")).toHaveText(/Favourite/, { timeout: 15_000 });
  });

  test("a quick scan of one platform is approved, then finds the new game", async ({
    page,
  }, info) => {
    test.setTimeout(90_000);
    const id = await addRomm(page.request, `${info.project.name}${Date.now() % 100000}`);
    const panel = await open(page, id, "overview");
    await panel.getByTestId("romm-scan").click();
    const form = page.getByTestId("romm-scan-form");
    await form.getByRole("checkbox", { name: /^Nintendo Entertainment System/ }).check();
    await form.getByRole("button", { name: "Scan", exact: true }).click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText(
      /Scan Nintendo Entertainment System[\s\S]*No game or file is deleted/,
    );
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/finished the scan[\s\S]*1 new/, { timeout: 30_000 });
    await pop.getByTestId("approve-here-close").click();
    await expect(panel.getByTestId("romm-games")).toHaveText("9", { timeout: 20_000 });
  });

  test("a viewer's login browses but is not offered scans", async ({ page }, info) => {
    test.setTimeout(60_000);
    const id = await addRomm(
      page.request,
      `${info.project.name}${Date.now() % 100000}`,
      "e2e-viewer",
    );
    const panel = await open(page, id, "overview");
    await expect(panel.getByTestId("romm-no-scan")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("romm-scan")).toHaveCount(0);
    await expect(panel.getByTestId("romm-game").first()).toBeVisible();
  });
});
