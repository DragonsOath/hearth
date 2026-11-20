import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext } from "@playwright/test";

// Download Health, monitoring (the owner's design, 2026-11-07): the panel in the Lair shows what
// needs you and why, a client that does not answer as one shared cause first, and a line in the
// download client's own Overview. It changes nothing.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.31`;
};

async function add(request: APIRequestContext, name: string, address: string, secret: object) {
  const res = await request.post("/api/services", {
    data: { name, kind: "web", address, category: "Downloads" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `${name} key`,
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      ...secret,
    },
  });
  return id;
}

test("Download Health: the panel shows what needs you, why, and the shared cause first", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const run = `${info.project.name}${Date.now() % 100000}`;
  const sab = await add(request, `SABnzbd ${run}`, `http://${uniqueHost()}:8080`, {
    kind: "api-key",
    value: "e2e-sab-key",
  });
  // A qBittorrent that does not answer (nothing listens on port 9).
  await add(
    request,
    `qBittorrent ${run}`,
    `http://127.0.0.${info.project.name === "mobile" ? 3 : 2}:9`,
    {
      kind: "login",
      username: "hearth",
      value: "e2e-qbt-login",
    },
  );

  const checked = await request.post("/api/download-health/check");
  expect(checked.status()).toBe(200);

  await page.goto(`/?panels=${encodeURIComponent("tool:downloads")}`);
  const panel = page.getByTestId("download-health-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId("download-health-overview")).toContainText("downloading");
  await expect(
    panel.getByTestId("download-health-cause").filter({ hasText: `qBittorrent ${run}` }),
  ).toContainText("isn't judging its downloads right now");
  await panel.getByTestId("download-health-check").click();
  await expect(panel).toContainText(/Checked (just now|\d+ minutes? ago)/);
  await expect(panel.getByTestId("download-health-client").first()).toBeVisible();
  await page.screenshot({
    path: "test-results/screens/desktop/download-health.png",
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page }).include('[data-testid="download-health-panel"]').analyze()
    ).violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/download-health.png`,
    fullPage: true,
  });
  await panel.getByRole("tab", { name: "History" }).click();
  await expect(panel).toContainText(/Nothing yet|Needed you|Recovered/);

  // The client's own Overview has a line that opens the panel.
  await page.goto(`/?panels=${encodeURIComponent(`service:${sab}`)}`);
  const line = page.getByTestId("download-health-line").locator("visible=true");
  await expect(line).toBeVisible({ timeout: 20_000 });
  await line.click();
  await expect(page.getByTestId("download-health-panel")).toBeVisible();
});

test("Download Health: Fix it on a failed Radarr download is one plan; Automatic Recovery is a switch", async ({
  page,
  request,
}, info) => {
  test.setTimeout(90_000);
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const run = `${info.project.name}${Date.now() % 100000}`;
  await add(request, `Radarr ${run}`, `http://${uniqueHost()}:7879`, {
    kind: "api-key",
    value: "e2e-7879-key",
  });
  expect((await request.post("/api/download-health/check")).status()).toBe(200);
  await page.goto(`/?panels=${encodeURIComponent("tool:downloads")}`);
  const panel = page.getByTestId("download-health-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // The failed one has Fix it: the plan says what is removed, blocklisted and searched for.
  const glass = panel
    .getByTestId("download-health-item")
    .filter({ hasText: "Glass Meridian" })
    .first();
  await expect(glass).toBeVisible();
  await glass.getByTestId("download-health-fix").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("This one release is blocklisted", { timeout: 20_000 });
  await expect(dialog).toContainText("searches for another release");
  await dialog.getByRole("button", { name: /^Approve/ }).click();
  await expect(dialog).toContainText(/Fixed: .*searching for another/, { timeout: 30_000 });
  await page.keyboard.press("Escape");

  // Automatic Recovery: off until turned on, and kept.
  const auto = panel.getByTestId("download-health-auto").getByRole("checkbox");
  await expect(auto).not.toBeChecked();
  await auto.check();
  await expect(auto).toBeChecked();
  const v = (await (await request.get("/api/download-health")).json()) as {
    settings: { auto?: boolean };
  };
  expect(v.settings.auto).toBe(true);
  await auto.uncheck();
  await expect(auto).not.toBeChecked();
});
