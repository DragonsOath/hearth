import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels: qBittorrent's Settings tab against the stand-in qBittorrent 5.2 (port 8090). Edits
// become one plan with each before and after; nothing changes until it is approved and read back.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.12`;
};

async function addQbittorrent(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `qBittorrent ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8090`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const key = await request.post("/api/vault/secrets", {
    data: {
      name: `qBittorrent ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "hearth",
      value: "e2e-qbittorrent-password",
    },
  });
  expect(key.status(), await key.text()).toBeLessThan(300);
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

test.describe("qBittorrent's Settings tab", () => {
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addQbittorrent(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("edits become one plan with before and after, approved and read back", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config");
    await expect(panel.getByTestId("qb-settings-group").first()).toBeVisible({ timeout: 20_000 });
    // The ratio limit only matters once its switch is on.
    const ratio = panel.locator('[data-hearth-target="setting:max_ratio"]');
    await expect(ratio).toBeDisabled();
    await panel.locator('[data-hearth-target="setting:max_ratio_enabled"]').check();
    await expect(ratio).toBeEnabled();
    await ratio.fill("2");
    await panel.locator('[data-hearth-target="setting:dl_limit"]').fill("5000");
    await expect(panel.locator('[data-hearth-target="settings:review"]')).toContainText(
      "Review 3 changes",
    );

    await panel.locator('[data-hearth-target="settings:review"]').click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText(/Share ratio limit/);
    await expect(pop).toContainText(/Download speed limit/);
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/verified|finished/, { timeout: 20_000 });
    await pop.getByTestId("approve-here-close").click();
    // qBittorrent now has them, so nothing is left to review.
    await expect(panel.locator('[data-hearth-target="settings:review"]')).toBeDisabled({
      timeout: 15_000,
    });
    await expect(panel.locator('[data-hearth-target="setting:dl_limit"]')).toHaveValue("5000");
  });

  test("a limit that deletes files is warned about before review", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "config");
    await panel.locator('[data-hearth-target="setting:max_ratio_act"]').selectOption("3");
    await expect(panel.getByTestId("qb-delete-warning")).toContainText("files deleted");
    await panel.locator('[data-hearth-target="settings:reset"]').click();
    await expect(panel.getByTestId("qb-delete-warning")).toHaveCount(0);
  });

  test("on a phone, the settings fit the screen", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Phone only.");
    const panel = await open(page, id, "config");
    await expect(panel.getByTestId("qb-settings-group").first()).toBeVisible({ timeout: 20_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
