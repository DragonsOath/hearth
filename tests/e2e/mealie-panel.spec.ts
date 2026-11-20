import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Mealie's light panel against the stand-in Mealie (port 9925, answering as a real v3.30.0 did):
// health and version, the first-run administrator warning, and a backup through the real plan,
// approval and read-back code. The token and Mealie's database address never reach the page.

const OWNER_PASSWORD = "e2e owner password";
const KEY = "e2e-mealie-SECRET-token";

let hosts = (Date.now() + 77_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.93`;
};

async function addMealie(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Mealie ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:9925`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Mealie ${run} key`,
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

test.describe("Mealie's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addMealie(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Health, version, the first-run administrator, and a backup through a plan", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("ml-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("ml-version")).toHaveText("3.30.0");
    await expect(d).toContainText("3.31.0 is out");
    await expect(d.getByTestId("ml-recipes")).toHaveText("214");
    await expect(d.getByTestId("ml-default-admin")).toContainText("changeme@example.com");
    await expect(d.getByTestId("ml-checks")).toContainText("Database: PostgreSQL");
    await expect(d.getByTestId("ml-backup")).toHaveText("30 days ago");
    await expect(page.locator("body")).not.toContainText("SECRET");
    await expect(page.locator("body")).not.toContainText("postgresql://");
    await shot(page, "mealie-overview");
    await d.getByTestId("ml-backup-now").click();
    await approve(page, /Make a backup of Mealie/);
    await expect(d.getByTestId("ml-backups").locator("li")).toHaveCount(2, { timeout: 20_000 });
  });
});
