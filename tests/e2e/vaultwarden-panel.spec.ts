import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Vaultwarden's panel against the stand-in Vaultwarden (port 8222, answering as a real 1.37.5 did):
// two-step sign-in, open sign-ups, settings, and an account turned off through a protected plan
// (approving asks to confirm it is you). Account keys, the admin token and secrets never reach the
// page.

const OWNER_PASSWORD = "e2e owner password";
const ADMIN_TOKEN = "e2e-vaultwarden-admin";

let hosts = (Date.now() + 59_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.97`;
};

async function addVaultwarden(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Vaultwarden ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8222`,
      category: "System",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Vaultwarden ${run} admin token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: ADMIN_TOKEN,
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

test.describe("Vaultwarden's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addVaultwarden(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: two-step sign-in, open sign-ups and settings, no secrets", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("vw-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("vw-accounts")).toHaveText("2");
    await expect(d.getByTestId("vw-2fa")).toHaveText("1 of 2");
    await expect(d.getByTestId("vw-signups")).toHaveText("Open");
    await expect(d.getByTestId("vw-version")).toHaveText("1.37.5");
    await expect(d.getByTestId("vw-attention")).toContainText("Sign-ups are open");
    await expect(d.getByTestId("vw-no-2fa")).toContainText("Sam");
    await expect(d.getByTestId("vw-settings")).toContainText("Email is set up");
    await expect(d.getByTestId("vw-orgs")).toContainText("Family (2)");
    const body = page.locator("body");
    await expect(body).not.toContainText("e2e-SECRET");
    await expect(body).not.toContainText(ADMIN_TOKEN);
    await shot(page, "vaultwarden-overview");
  });

  test("Accounts: turn one off through a protected plan, read back", async ({ page }) => {
    const panel = await open(page, id, "accounts");
    const tab = panel.getByTestId("vw-accounts-tab");
    await expect(tab.getByTestId("vw-account")).toHaveCount(4, { timeout: 30_000 });
    await tab.getByRole("button", { name: "No two-step", exact: true }).click();
    await expect(tab.getByTestId("vw-account")).toHaveCount(1);
    await tab.getByRole("button", { name: "All", exact: true }).click();
    const alex = tab.getByTestId("vw-account").filter({ hasText: "alex@example.com" });
    await expect(alex.getByTestId("vw-remove-2fa")).toBeVisible();
    await shot(page, "vaultwarden-accounts");
    const sam = tab.getByTestId("vw-account").filter({ hasText: "sam@example.com" });
    await sam.getByTestId("vw-toggle").click();
    await approve(page, /Turn off sam@example.com/);
    await expect(sam).toContainText("turned off", { timeout: 20_000 });
    await expect(sam.getByTestId("vw-toggle")).toContainText("Turn on");
  });
});
