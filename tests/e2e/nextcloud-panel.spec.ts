import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Nextcloud's panel against the stand-in Nextcloud (port 11000, answering as a real 35.0.2 did):
// late background jobs, public links without a password, an account almost out of space, setup
// checks, and changes through the real plan, approval and read-back code. The password the vault
// holds never reaches the page.

const OWNER_PASSWORD = "e2e owner password";
const NEXTCLOUD_PASSWORD = "e2e-nextcloud-pass";

let hosts = (Date.now() + 47_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.93`;
};

async function addNextcloud(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Nextcloud ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:11000`,
      category: "Files & Photos",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Nextcloud ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "admin",
      value: NEXTCLOUD_PASSWORD,
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

test.describe("Nextcloud's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addNextcloud(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: jobs, open links, near-full accounts and setup checks", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("nc-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("nc-free")).toHaveText("412 GB");
    await expect(d.getByTestId("nc-accounts")).toHaveText("3");
    await expect(d.getByTestId("nc-jobs")).toHaveText("Late");
    await expect(d.getByTestId("nc-updates")).toHaveText("1");
    const attention = d.getByTestId("nc-attention");
    await expect(attention).toContainText("Needs a look");
    await expect(attention.getByTestId("nc-jobs-late")).toContainText("Background jobs last ran");
    await expect(attention.getByTestId("nc-open-links")).toContainText(
      "3 of 5 public links have no password",
    );
    await expect(attention.getByTestId("nc-near-full")).toContainText("Sam");
    await expect(attention.getByTestId("nc-check").first()).toContainText("Cron last run");
    // Hearth's own http connection is a note, not a problem.
    await expect(attention).not.toContainText("HTTPS access and URLs");
    await d.getByTestId("nc-notes").locator("summary").click();
    await expect(d.getByTestId("nc-notes")).toContainText("about Hearth's own connection");
    await expect(d.getByTestId("nc-settings")).toContainText("Sharing and background jobs");
    await expect(d.getByTestId("nc-system")).toContainText("PHP 8.5.12");
    await expect(page.locator("body")).not.toContainText(NEXTCLOUD_PASSWORD);
    await shot(page, "nextcloud-overview");

    // The fix sits beside the problem: require a password on new links, through a plan.
    await attention.getByRole("button", { name: "Require a password on new links" }).click();
    await approve(page, /Require a password on public links/);
    await expect(d.getByTestId("nc-setting-links-password")).toHaveText("Turn off", {
      timeout: 20_000,
    });
    await expect(
      attention.getByRole("button", { name: "Require a password on new links" }),
    ).toHaveCount(0);
  });

  test("Accounts: turn one off through a plan, read back", async ({ page }) => {
    const panel = await open(page, id, "accounts");
    const tab = panel.getByTestId("nc-accounts-tab");
    await expect(tab.getByTestId("nc-account")).toHaveCount(3, { timeout: 30_000 });
    await tab.getByPlaceholder("Find an account, email or group").fill("family");
    await expect(tab.getByTestId("nc-account")).toHaveCount(1);
    const sam = tab.getByTestId("nc-account").filter({ hasText: "sam@example.com" });
    await expect(sam).toContainText("Sam");
    await expect(sam).toContainText("10 GB");
    // Hearth's own account cannot be turned off from here.
    await tab.getByPlaceholder("Find an account, email or group").fill("");
    const me = tab.getByTestId("nc-account").filter({ hasText: "Hearth signs in as this" });
    await expect(me.getByTestId("nc-account-toggle")).toBeDisabled();
    await shot(page, "nextcloud-accounts");

    await sam.getByTestId("nc-account-toggle").click();
    await approve(page, /Turn off the account Sam/);
    await expect(
      tab.getByTestId("nc-account").filter({ hasText: "Sam" }).getByTestId("nc-account-toggle"),
    ).toContainText("Turn on", { timeout: 20_000 });
    await tab.getByRole("button", { name: "Off", exact: true }).click();
    await expect(tab.getByTestId("nc-account")).toHaveCount(2);
  });

  test("Apps: the update waiting, and turning an app on", async ({ page }) => {
    const panel = await open(page, id, "apps");
    const tab = panel.getByTestId("nc-apps-tab");
    await expect(tab.getByTestId("nc-app")).toHaveCount(5, { timeout: 30_000 });
    await expect(tab.getByTestId("nc-app-updates")).toContainText("Calendar 6.1.0");
    // Hearth reads through Monitoring (serverinfo): it stays on.
    await expect(
      tab.getByTestId("nc-app").filter({ hasText: "serverinfo" }).getByTestId("nc-app-toggle"),
    ).toBeDisabled();
    await tab.getByPlaceholder("Find an app").fill("audit");
    const audit = tab.getByTestId("nc-app");
    await expect(audit).toHaveCount(1);
    await expect(audit).toContainText("Off");
    await shot(page, "nextcloud-apps");
    await audit.getByTestId("nc-app-toggle").click();
    await approve(page, /Turn on the app Auditing \/ Logging/);
    await expect(audit.getByTestId("nc-app-toggle")).toHaveText("Turn off", { timeout: 20_000 });
  });
});
