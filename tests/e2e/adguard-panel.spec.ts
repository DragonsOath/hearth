import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// AdGuard Home's panel against the stand-in AdGuard Home (port 3000): the Overview's numbers, the
// query log and why a domain is blocked, filters and custom rules, blocked services and DNS
// rewrites. Every change is a protected plan (approving asks you to confirm it is you), through
// the real plan, approval and read-back code. A filter list's key never reaches the page.

const OWNER_PASSWORD = "e2e owner password";

let hosts = (Date.now() + 47_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.30`;
};

async function addAdguard(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `AdGuard Home ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:3000`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `AdGuard Home ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "admin",
      value: "e2e-adguard",
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

/** Approves a protected plan: confirms it is you when Hearth asks, then approves. */
async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  const confirm = pop.getByTestId("approve-confirm");
  const done = pop.getByText(/^done$/i);
  await expect(confirm.or(done).first()).toBeVisible({ timeout: 20_000 });
  if (await confirm.isVisible()) {
    await confirm.getByPlaceholder("Password").fill(OWNER_PASSWORD);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(done).toBeVisible({ timeout: 20_000 });
  }
  await pop.getByTestId("approve-here-close").click();
}

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("AdGuard Home's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addAdguard(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: numbers, pause and turn back on, a safety switch", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("ag-dashboard");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByTestId("ag-queries")).toHaveText("38,220");
    await expect(board.getByTestId("ag-blocked")).toHaveText("5,410");
    await expect(board.getByTestId("ag-top-blocked")).toContainText("ads.example.com");
    await expect(board.getByTestId("ag-filters-failing")).toContainText("1 never downloaded");
    await expect(page.locator("body")).not.toContainText("e2e-LISTKEY");
    await shot(page, "adguard-overview");

    await board.getByTestId("ag-pause").click();
    await board.getByTestId("ag-pause-choices").getByRole("button", { name: "5 minutes" }).click();
    await approve(page, /Pause protection in AdGuard Home[^\n]* for 5 minutes/);
    await expect(board.getByTestId("ag-protection")).toHaveAttribute("data-state", "paused", {
      timeout: 15_000,
    });
    await board.getByTestId("ag-resume").click();
    await approve(page, /Turn protection back on/);
    await expect(board.getByTestId("ag-protection")).toHaveAttribute("data-state", "on", {
      timeout: 15_000,
    });
    await board.getByTestId("ag-safety").getByRole("checkbox", { name: "Safe search" }).click();
    await approve(page, /Switch on safe search/);
    await expect(
      board.getByTestId("ag-safety").getByRole("checkbox", { name: "Safe search" }),
    ).toBeChecked({ timeout: 15_000 });
  });

  test("Query log: blocked lookups, why one is blocked, and allow it", async ({ page }) => {
    const panel = await open(page, id, "overview");
    await panel.getByTestId("ag-blocked").click();
    const log = panel.getByTestId("ag-queries-tab");
    await expect(log.getByTestId("ag-query")).toHaveCount(2, { timeout: 20_000 });
    const line = log.getByTestId("ag-query").filter({ hasText: "telemetry.example.net" });
    await expect(line).toContainText("blocked by a filter (AdGuard DNS filter)");
    await line.getByRole("button", { name: "telemetry.example.net" }).click();
    const why = log.getByTestId("ag-why");
    await expect(why).toContainText("Blocked by AdGuard DNS filter.", { timeout: 15_000 });
    await shot(page, "adguard-queries");
    await line.getByRole("button", { name: "Allow" }).click();
    await approve(page, /Allow telemetry\.example\.net and its subdomains/);
    await expect(why).toContainText("Allowed by an allow rule in your custom rules", {
      timeout: 15_000,
    });
  });

  test("Filters: block a domain, switch a list off, add a list", async ({ page }) => {
    const panel = await open(page, id, "filters");
    const tab = panel.getByTestId("ag-filters-tab");
    await tab.getByLabel("Domain", { exact: true }).fill("tracker.example.org");
    await tab.getByRole("button", { name: "Block", exact: true }).click();
    await approve(page, /Block tracker\.example\.org and its subdomains/);
    await expect(
      tab.getByTestId("ag-rule").filter({ hasText: "tracker.example.org" }),
    ).toHaveAttribute("data-kind", "block", { timeout: 15_000 });
    const priv = tab.getByTestId("ag-filter").filter({ hasText: "Private list" });
    await expect(priv).toContainText("private.txt?…");
    await priv.getByRole("checkbox").click();
    await approve(page, /Switch off the list Private list/);
    await expect(priv).toHaveAttribute("data-enabled", "no", { timeout: 15_000 });
    await tab.getByLabel("List name").fill("More ads");
    await tab.getByLabel("List address").fill("https://lists.example.org/more.txt");
    await tab.getByRole("button", { name: "Add list" }).click();
    await approve(page, /Add the blocklist More ads/);
    await expect(tab.getByTestId("ag-filter")).toHaveCount(3, { timeout: 15_000 });
    await shot(page, "adguard-filters");
    await expect(page.locator("body")).not.toContainText("e2e-LISTKEY");
  });

  test("Blocked services and DNS rewrites", async ({ page }) => {
    const panel = await open(page, id, "services");
    const tab = panel.getByTestId("ag-services");
    await tab.getByLabel("Find a service").fill("tik");
    await tab.getByRole("checkbox", { name: "TikTok" }).check();
    await tab.getByTestId("ag-services-review").click();
    await approve(page, /block TikTok/);
    await expect(tab).toContainText("1 blocked now.", { timeout: 15_000 });
    await shot(page, "adguard-services");

    const rw = await open(page, id, "rewrites");
    const rewrites = rw.getByTestId("ag-rewrites");
    await expect(rewrites.getByTestId("ag-rewrite")).toHaveCount(1, { timeout: 20_000 });
    await rewrites.getByLabel("Name").fill("nas.home");
    await rewrites.getByLabel("Answer").fill("192.168.1.20");
    await rewrites.getByRole("button", { name: "Add rewrite" }).click();
    await approve(page, /Answer nas\.home with 192\.168\.1\.20/);
    await expect(rewrites.getByTestId("ag-rewrite")).toHaveCount(2, { timeout: 15_000 });
  });
});
