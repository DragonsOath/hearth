import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Authentik's panel against the stand-in Authentik (port 9010, answering as a real 2026.8.5 did):
// sign-ins, failed sign-ins, apps and health, a failed task retried and an account turned off as a
// protected plan. No token, password or secret ever reaches the page.

const OWNER_PASSWORD = "e2e owner password";
const KEY = "e2e-authentik-SECRET-token";

let hosts = (Date.now() + 81_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.97`;
};

async function addAuthentik(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Authentik ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:9010`,
      category: "System",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Authentik ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: KEY,
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

test.describe("Authentik's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addAuthentik(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: sign-ins, failed sign-ins, apps and health, and a task retried", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("ak-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("ak-signins")).toHaveText("2");
    await expect(d.getByTestId("ak-failed")).toHaveText("12");
    await expect(d.getByTestId("ak-apps")).toHaveText("2");
    await expect(d.getByTestId("ak-health")).toHaveText("Needs a look");
    await expect(d.getByTestId("ak-failed-list")).toContainText("203.0.113.9");
    await expect(d.getByTestId("ak-app-list")).toContainText("paperless.example.com");
    await expect(d.getByTestId("ak-outpost").last()).toContainText("LDAP outpost");
    await expect(d.getByTestId("ak-health-list")).toContainText("expires in 9 days");
    await expect(page.locator("body")).not.toContainText("SECRET");
    await shot(page, "authentik-overview");
    await d.getByTestId("ak-retry").click();
    await approve(page, /Retry the failed task/);
    await expect(d.getByTestId("ak-task")).toHaveCount(0, { timeout: 20_000 });
  });

  test("People: turn an account off through a protected plan", async ({ page }) => {
    const tab = (await open(page, id, "people")).getByTestId("ak-people-tab");
    await expect(tab.getByTestId("ak-user")).toHaveCount(2, { timeout: 30_000 });
    const sam = tab.getByTestId("ak-user").filter({ hasText: "sam" });
    await expect(sam).toContainText("12 failed sign-ins today");
    await shot(page, "authentik-people");
    await sam.getByTestId("ak-user-toggle").click();
    await approve(page, /Turn off sam's account/);
    await expect(sam).toContainText("off", { timeout: 20_000 });
    await expect(sam.getByTestId("ak-user-toggle")).toHaveText(/Turn on/);
  });
});
