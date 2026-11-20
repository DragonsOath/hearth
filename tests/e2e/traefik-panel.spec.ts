import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Traefik's panel against the stand-in Traefik (port 8082), read only: routers, a refused one with
// Traefik's error, an app it sees down, and certificates. No middleware's password hash reaches
// the page.

let hosts = (Date.now() + 31_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.82`;
};

async function addTraefik(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Traefik ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8082`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
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

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Traefik's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    id = await addTraefik(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: a refused router, an app down, a certificate running out", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("tr-dashboard");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByTestId("tr-routers")).toHaveText("3");
    await expect(board.getByTestId("tr-refused")).toHaveText("1");
    await expect(board.getByTestId("tr-down")).toHaveText("1");
    await expect(board.getByTestId("tr-expiring")).toHaveText("1");
    await expect(board.getByTestId("tr-problems")).toContainText(
      'the service "missing-service@file" does not exist',
    );
    await expect(board.getByTestId("tr-problems")).toContainText("sonarr.example.com");
    await expect(page.locator("body")).not.toContainText("e2e-SECRET");
    await shot(page, "traefik-overview");
  });

  test("Routers and certificates", async ({ page }) => {
    const panel = await open(page, id, "routers");
    const tab = panel.getByTestId("tr-routers-tab");
    await expect(tab.getByTestId("tr-router")).toHaveCount(3, { timeout: 20_000 });
    const radarr = tab.getByTestId("tr-router").filter({ hasText: "radarr.example.com" });
    await expect(radarr).toContainText("http://172.18.0.5:7878");
    await expect(radarr).toContainText("auth@file");
    await tab.getByLabel("Find a router").fill("sonarr");
    await expect(tab.getByTestId("tr-router")).toHaveCount(1);
    await expect(tab.getByTestId("tr-router")).toContainText("(down)");
    await shot(page, "traefik-routers");
    const certs = await open(page, id, "certificates");
    await expect(certs.getByTestId("tr-certificate")).toContainText(
      /\*\.example\.com.*expires in (8|9) days/,
      {
        timeout: 20_000,
      },
    );
  });
});
