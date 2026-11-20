import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Pi-hole's panel against the stand-in Pi-hole 6 (port 8053): the Overview's numbers, most blocked
// domains and blocklists, and changes as protected plans (approving asks you to confirm it is you),
// each through the real plan, approval and read-back code. A list's key never reaches the page.

const OWNER_PASSWORD = "e2e owner password";

let hosts = (Date.now() + 41_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.53`;
};

async function addPihole(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Pi-hole ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8053`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Pi-hole ${run} app password`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-pihole",
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

test.describe("Pi-hole's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addPihole(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: queries and blocked, most blocked, pause and turn back on", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("ph-dashboard");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByTestId("ph-queries")).toHaveText("41,230");
    await expect(board.getByTestId("ph-blocked")).toHaveText("6,112");
    await expect(board.getByTestId("ph-history")).toBeVisible();
    await expect(board.getByTestId("ph-top-blocked")).toContainText("ads.example.com");
    await expect(board.getByTestId("ph-lists-failing")).toContainText("1 could not be downloaded");
    await expect(board).toContainText("FTL 6.8.1 is out.");
    // The private list's key never reaches the page, not even in Pi-hole's own warnings.
    await expect(page.locator("body")).not.toContainText("e2e-LISTKEY");
    await shot(page, "pihole-overview");

    await board.getByTestId("ph-pause").click();
    await board.getByTestId("ph-pause-choices").getByRole("button", { name: "5 minutes" }).click();
    await approve(page, /Pause ad blocking in Pi-hole[^\n]* for 5 minutes/);
    await expect(board.getByTestId("ph-blocking")).toHaveAttribute("data-state", "disabled", {
      timeout: 15_000,
    });
    await expect(board.getByTestId("ph-blocking")).toContainText("Back on by itself in 5 min");
    await board.getByTestId("ph-resume").click();
    await approve(page, /Turn ad blocking back on/);
    await expect(board.getByTestId("ph-blocking")).toHaveAttribute("data-state", "enabled", {
      timeout: 15_000,
    });
  });

  test("Allow a blocked domain from the Overview, then take it off in Lists and domains", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const row = panel.getByTestId("ph-blocked-domain").filter({ hasText: "ads.example.com" });
    await row.getByRole("button", { name: "Allow" }).click();
    await approve(page, /Allow ads\.example\.com/);
    await expect(row).toContainText("allowed", { timeout: 15_000 });

    const lists = await open(page, id, "lists");
    const tab = lists.getByTestId("ph-lists");
    const allowed = tab.getByTestId("ph-domain").filter({ hasText: "ads.example.com" });
    await expect(allowed).toHaveAttribute("data-list", "allow", { timeout: 15_000 });
    await shot(page, "pihole-lists");
    await allowed.getByRole("button", { name: "Take off" }).click();
    await approve(page, /Take ads\.example\.com off/);
    await expect(allowed).toHaveCount(0, { timeout: 15_000 });
  });

  test("Lists: switch one off, add one, update the blocklists", async ({ page }) => {
    const panel = await open(page, id, "lists");
    const tab = panel.getByTestId("ph-lists");
    const priv = tab.getByTestId("ph-list").filter({ hasText: "Private list" });
    await expect(priv).toContainText("private.txt?…", { timeout: 20_000 });
    await priv.getByRole("checkbox").click();
    await approve(page, /Switch off the list Private list/);
    await expect(priv).toHaveAttribute("data-enabled", "no", { timeout: 15_000 });

    await tab.getByLabel("List address").fill("https://lists.example.org/more.txt");
    await tab.getByRole("button", { name: "Add blocklist" }).click();
    await approve(page, /Add the blocklist https:\/\/lists\.example\.org\/more\.txt/);
    await expect(tab.getByTestId("ph-list")).toHaveCount(3, { timeout: 15_000 });

    await tab.getByRole("button", { name: "Update blocklists" }).click();
    await approve(page, /Update Pi-hole[^']*'s blocklists/);
    await expect(page.locator("body")).not.toContainText("e2e-LISTKEY");
  });

  test("Query log: from a busiest device, why a domain is blocked, and allow it from a line", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    await panel
      .getByTestId("ph-top-clients")
      .getByRole("button", { name: /living-room-tv/ })
      .click();
    const log = panel.getByTestId("ph-queries-tab");
    await expect(log.getByTestId("ph-query")).toHaveCount(2, { timeout: 20_000 });
    await expect(log.getByLabel("Device")).toHaveValue("192.168.1.40");
    await log.getByLabel("Device").selectOption("");
    await log.getByRole("button", { name: "Blocked", exact: true }).click();
    await expect(log.getByTestId("ph-query")).toHaveCount(3, { timeout: 15_000 });
    await expect(log.locator('[data-testid="ph-query"][data-verdict="allowed"]')).toHaveCount(0);
    const line = log.getByTestId("ph-query").filter({ hasText: "telemetry.example.net" });
    await expect(line).toContainText("blocked by a blocklist");
    await line.getByRole("button", { name: "telemetry.example.net" }).click();
    const why = log.getByTestId("ph-why");
    await expect(why).toContainText("Blocked by a blocklist.", { timeout: 15_000 });
    await expect(why).toContainText("raw.githubusercontent.com/StevenBlack");
    await shot(page, "pihole-queries");
    await line.getByRole("button", { name: "Allow" }).click();
    await approve(page, /Allow telemetry\.example\.net/);
    await expect(why).toContainText("Allowed: you allowed it", { timeout: 15_000 });
  });

  test("Local DNS: add a name and an alias; block a pattern in Lists and domains", async ({
    page,
  }) => {
    const panel = await open(page, id, "dns");
    const dns = panel.getByTestId("ph-dns");
    await expect(dns.getByTestId("ph-dns-record")).toHaveCount(1, { timeout: 20_000 });
    await dns.getByLabel("Name").fill("nas.home");
    await dns.getByLabel("Address").fill("192.168.1.20");
    await dns.getByRole("button", { name: "Add name" }).click();
    await approve(page, /Point nas\.home to 192\.168\.1\.20/);
    await expect(dns.getByTestId("ph-dns-record")).toHaveCount(2, { timeout: 15_000 });
    await dns.getByLabel("Alias").fill("movies.home");
    await dns.getByLabel("Points to").fill("plex.home");
    await dns.getByRole("button", { name: "Add alias" }).click();
    await approve(page, /Make movies\.home another name for plex\.home/);
    await expect(dns.getByTestId("ph-dns-alias")).toContainText("movies.home", { timeout: 15_000 });
    await shot(page, "pihole-dns");

    const lists = await open(page, id, "lists");
    const tab = lists.getByTestId("ph-lists");
    await tab.getByText(/A pattern \(regular expression\)/).click();
    await tab.getByLabel("Pattern", { exact: true }).fill("(\\.|^)doubleclick\\.net$");
    await tab.getByRole("button", { name: "Block", exact: true }).click();
    await approve(page, /Block names matching/);
    await expect(tab.locator('[data-testid="ph-domain"][data-match="regex"]')).toContainText(
      "doubleclick",
      { timeout: 15_000 },
    );
  });
});
