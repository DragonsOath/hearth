import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Tailscale's panel against the stand-in for Tailscale's API (api.tailscale.com, following its
// official API client): devices online and waiting, a key running out, an exit node offered, and
// a device approved through a protected plan (approving asks to confirm it is you). Device keys
// and the token never reach the page.

const OWNER_PASSWORD = "e2e owner password";
const TOKEN = "tskey-api-e2e-panel";

let hosts = (Date.now() + 61_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.99`;
};

async function addTailscale(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Tailscale ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:41641`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Tailscale ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      // Tailscale keeps its devices in its own service: the token is only sent there.
      endpoint: "https://api.tailscale.com",
      value: TOKEN,
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

test.describe("Tailscale's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addTailscale(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: online, waiting, keys and exit nodes, no keys on the page", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("tsn-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("tsn-online")).toHaveText("3 of 4");
    await expect(d.getByTestId("tsn-waiting")).toHaveText("1");
    await expect(d.getByTestId("tsn-keys")).toHaveText("1");
    await expect(d.getByTestId("tsn-exits")).toHaveText("0");
    await expect(d.getByTestId("tsn-waiting-item")).toContainText("new-pi wants to join");
    await expect(d.getByTestId("tsn-key-item")).toContainText("laptop's key runs out in");
    await expect(d.getByTestId("tsn-offer-item")).toContainText("to be an exit node");
    await expect(d.getByTestId("tsn-updates")).toContainText("phone");
    await expect(d.getByTestId("tsn-dns")).toContainText("MagicDNS on");
    const body = page.locator("body");
    await expect(body).not.toContainText("e2e-SECRET");
    await expect(body).not.toContainText(TOKEN);
    await shot(page, "tailscale-overview");
  });

  test("Devices: approve a waiting device through a protected plan", async ({ page }) => {
    const panel = await open(page, id, "devices");
    const tab = panel.getByTestId("tsn-devices-tab");
    await expect(tab.getByTestId("tsn-device")).toHaveCount(5, { timeout: 30_000 });
    await tab.getByRole("button", { name: "Waiting", exact: true }).click();
    await expect(tab.getByTestId("tsn-device")).toHaveCount(1);
    const pi = tab.getByTestId("tsn-device").filter({ hasText: "new-pi" });
    await expect(pi).toContainText("waiting for approval");
    await shot(page, "tailscale-devices");
    await pi.getByTestId("tsn-auth-toggle").click();
    await approve(page, /Approve new-pi \(linux, sam@example.com\) to join the tailnet/);
    await expect(tab.getByTestId("tsn-device")).toHaveCount(0, { timeout: 20_000 });
    await tab.getByRole("button", { name: "All", exact: true }).click();
    await expect(
      tab.getByTestId("tsn-device").filter({ hasText: "new-pi" }).getByTestId("tsn-auth-toggle"),
    ).toContainText("Take access away");
  });
});
