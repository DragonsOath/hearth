import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// wg-easy's panel against the stand-in wg-easy (port 51821, answering as a real 15 did): who is
// connected, traffic, a client past its end date, and a client turned off through a protected plan
// (approving asks to confirm it is you). Keys and configurations never reach the page.

const OWNER_PASSWORD = "e2e owner password";
const PASSWORD = "e2e-wg-easy-pass";

let hosts = (Date.now() + 63_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.89`;
};

async function addWgEasy(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `wg-easy ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:51821`,
      category: "Network",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `wg-easy ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "admin",
      value: PASSWORD,
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

test.describe("wg-easy's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addWgEasy(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: connected now, traffic, end dates, no keys", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("wg-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("wg-connected")).toHaveText("1 of 2");
    await expect(d.getByTestId("wg-clients")).toHaveText("3");
    await expect(d.getByTestId("wg-traffic")).toHaveText("3.2 GB");
    await expect(d.getByTestId("wg-host")).toHaveText("vpn.example.com:51820");
    await expect(d.getByTestId("wg-now")).toContainText("Alex's phone");
    await expect(d.getByTestId("wg-now")).toContainText("from 203.0.113.24:51413");
    await expect(d.getByTestId("wg-settings")).toContainText("all their internet traffic");
    const body = page.locator("body");
    await expect(body).not.toContainText("e2e-SECRET");
    await expect(body).not.toContainText(PASSWORD);
    await shot(page, "wgeasy-overview");
  });

  test("Clients: turn one off through a protected plan, read back", async ({ page }) => {
    const panel = await open(page, id, "clients");
    const tab = panel.getByTestId("wg-clients-tab");
    await expect(tab.getByTestId("wg-client")).toHaveCount(3, { timeout: 30_000 });
    await tab.getByRole("button", { name: "Off", exact: true }).click();
    await expect(tab.getByTestId("wg-client")).toHaveCount(1);
    await expect(tab.getByTestId("wg-client")).toContainText("ended");
    await tab.getByRole("button", { name: "All", exact: true }).click();
    await shot(page, "wgeasy-clients");
    const laptop = tab.getByTestId("wg-client").filter({ hasText: "laptop" });
    await laptop.getByTestId("wg-toggle").click();
    await approve(page, /Turn off laptop in wg-easy/);
    await expect(laptop.getByTestId("wg-toggle")).toContainText("Turn on", { timeout: 20_000 });
  });
});
