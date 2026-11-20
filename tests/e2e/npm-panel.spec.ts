import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Nginx Proxy Manager's panel against the stand-in NPM (port 81): sites, a site nginx could not
// load, certificates and expiry, and changes as protected plans (approving asks you to confirm it
// is you), through the real plan, approval and read-back code. NPM's secrets never reach the page.

const OWNER_PASSWORD = "e2e owner password";

let hosts = (Date.now() + 59_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.81`;
};

async function addNpm(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Nginx Proxy Manager ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:81`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Nginx Proxy Manager ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "alex@example.com",
      value: "e2e-npm",
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

test.describe("Nginx Proxy Manager's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addNpm(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: sites on, one nginx could not load, a certificate expiring soon", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("npm-dashboard");
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expect(board.getByTestId("npm-on")).toHaveText("2");
    await expect(board.getByTestId("npm-broken")).toHaveText("1");
    await expect(board.getByTestId("npm-broken-list")).toContainText('unknown directive "this"');
    await expect(board.getByTestId("npm-expiring")).toHaveText("1");
    await expect(board.getByTestId("npm-activity")).toContainText(
      "Alex updated proxy host radarr.example.com",
    );
    await expect(page.locator("body")).not.toContainText("e2e-SECRET");
    await shot(page, "npm-overview");
  });

  test("Sites: switch one off, change where it forwards, add one", async ({ page }) => {
    const panel = await open(page, id, "sites");
    const tab = panel.getByTestId("npm-sites");
    const radarr = tab.getByTestId("npm-site").filter({ hasText: "radarr.example.com" });
    await expect(radarr).toContainText("http://192.168.1.10:7878", { timeout: 20_000 });
    await radarr.getByRole("checkbox").click();
    await approve(page, /Switch off radarr\.example\.com/);
    await expect(radarr).toHaveAttribute("data-enabled", "no", { timeout: 15_000 });
    await radarr.getByRole("button", { name: "Change" }).click();
    await radarr.getByLabel("Forward to").fill("192.168.1.20");
    await radarr.getByRole("button", { name: "Send it there" }).click();
    await approve(page, /Send radarr\.example\.com to http:\/\/192\.168\.1\.20:7878/);
    await expect(radarr).toContainText("192.168.1.20", { timeout: 15_000 });
    await tab.getByRole("button", { name: "Add a site" }).click();
    const form = tab.getByTestId("npm-add-form");
    await form.getByLabel("Site name").fill("sonarr.example.com");
    await form.getByLabel("Forward to").fill("192.168.1.10");
    await form.getByLabel("Port").fill("8989");
    await form.getByLabel("Certificate").selectOption({ label: "example.com" });
    await shot(page, "npm-sites");
    await form.getByRole("button", { name: "Add it" }).click();
    await approve(page, /Add the site sonarr\.example\.com[^\n]*with the certificate example\.com/);
    await expect(tab.getByTestId("npm-site")).toHaveCount(3, { timeout: 15_000 });
  });

  test("Certificates: expiry, sites using each, renew a Let's Encrypt one", async ({ page }) => {
    const panel = await open(page, id, "certificates");
    const tab = panel.getByTestId("npm-certificates");
    const le = tab.getByTestId("npm-certificate").filter({ hasText: "Let's Encrypt" });
    await expect(le).toContainText("Used by radarr.example.com", { timeout: 20_000 });
    await expect(le).toContainText(/expires in [56] days/);
    await expect(
      tab.getByTestId("npm-certificate").filter({ hasText: "uploaded" }).getByRole("button"),
    ).toHaveCount(0);
    await le.getByRole("button", { name: "Renew now" }).click();
    await approve(page, /Renew the certificate example\.com/);
    await expect(le).toContainText(/expires in (89|90) days/, { timeout: 15_000 });
    await shot(page, "npm-certificates");
  });
});
