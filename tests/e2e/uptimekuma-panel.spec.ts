import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Uptime Kuma's panel against the stand-in Uptime Kuma (port 3001, its socket over polling): what
// is down, a certificate running out, recent changes, maintenance, and changes through the real
// plan, approval and read-back code. Monitor and notification secrets never reach the page.

const OWNER_PASSWORD = "e2e owner password";

let hosts = (Date.now() + 41_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.91`;
};

async function addService(request: APIRequestContext, name: string, port: number) {
  const res = await request.post("/api/services", {
    data: { name, kind: "web", address: `http://${uniqueHost()}:${port}`, category: "System" },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function addKuma(request: APIRequestContext, run: string) {
  const id = await addService(request, `Uptime Kuma ${run}`, 3001);
  await request.post("/api/vault/secrets", {
    data: {
      name: `Uptime Kuma ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "admin",
      value: "e2e-kuma",
    },
  });
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

async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  const confirm = pop.getByTestId("approve-confirm");
  const done = pop.getByText(/^done$/i);
  await expect(confirm.or(done).first()).toBeVisible({ timeout: 30_000 });
  if (await confirm.isVisible()) {
    await confirm.getByPlaceholder("Password").fill(OWNER_PASSWORD);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(done).toBeVisible({ timeout: 30_000 });
  }
  await pop.getByTestId("approve-here-close").click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Uptime Kuma's panel", () => {
  let id = "";
  let run = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    run = `${info.project.name}${Date.now() % 100000}`;
    id = await addKuma(request, run);
  });

  test("Overview: what is down, certificates, changes and maintenance", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("uk-dashboard");
    await expect(board.getByTestId("uk-up")).toHaveText("3", { timeout: 20_000 });
    await expect(board.getByTestId("uk-down")).toHaveText("1");
    await expect(board.getByTestId("uk-certs")).toHaveText("1");
    const down = board.getByTestId("uk-down-item");
    await expect(down).toContainText("Sonarr");
    await expect(down).toContainText("connect ECONNREFUSED");
    const certs = board.getByTestId("uk-cert-list");
    await expect(certs).toContainText("Home Assistant");
    await expect(certs).toContainText("certificate runs out in 9 days");
    await expect(board.getByTestId("uk-event").first()).toContainText("Sonarr");
    await expect(board.getByTestId("uk-status-pages")).toContainText("Home services");
    await expect(board.getByTestId("uk-silent")).toContainText("Home Assistant sends no alerts");
    await expect(page.locator("body")).not.toContainText("e2e-SECRET");
    await shot(page, "uptimekuma-overview");
    await board
      .getByTestId("uk-maintenance")
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await approve(page, /Pause the maintenance window NAS disk swap/);
    await expect(board.getByTestId("uk-maintenance")).toContainText("paused", {
      timeout: 15_000,
    });
  });

  test("Monitors: pause and resume one, and watch an app Hearth knows", async ({
    page,
    request,
  }) => {
    await addService(request, `Bazarr ${run}`, 6767);
    const panel = await open(page, id, "monitors");
    const tab = panel.getByTestId("uk-monitors");
    const sonarr = tab.getByTestId("uk-monitor").filter({ hasText: "Sonarr" });
    await expect(sonarr).toHaveAttribute("data-status", "down", { timeout: 20_000 });
    await expect(sonarr.getByTestId("uk-beats")).toBeVisible();
    await expect(sonarr).toContainText("87.00% today");
    await expect(tab.getByTestId("uk-group").first()).toContainText("Media");
    await shot(page, "uptimekuma-monitors");
    await sonarr.getByRole("button", { name: "Pause" }).click();
    await approve(page, /Pause the monitor Sonarr/);
    await expect(sonarr).toHaveAttribute("data-status", "paused", { timeout: 15_000 });
    await sonarr.getByRole("button", { name: "Resume" }).click();
    await approve(page, /Resume the monitor Sonarr/);
    await expect(sonarr).toHaveAttribute("data-status", "down", { timeout: 15_000 });

    const more = tab.getByRole("button", { name: /^Show all/ });
    if (await more.isVisible()) await more.click();
    await tab
      .getByTestId("uk-unwatched")
      .getByRole("button", { name: `Bazarr ${run}` })
      .click();
    await approve(page, new RegExp(`Add a monitor Bazarr ${run} that checks http://`));
    await expect(tab.getByTestId("uk-monitor").filter({ hasText: `Bazarr ${run}` })).toBeVisible({
      timeout: 15_000,
    });
  });
});
