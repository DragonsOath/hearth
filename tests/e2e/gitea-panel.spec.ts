import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Gitea's panel against the stand-in Gitea (port 3030, answering as a real 1.27.3 did): repositories,
// a late mirror synced, a failed run run again and a runner turned off, through the real plan,
// approval and read-back code. The access token never reaches the page.

const OWNER_PASSWORD = "e2e owner password";
const KEY = "e2e-gitea-SECRET-token";

let hosts = (Date.now() + 73_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.91`;
};

async function addGitea(request: APIRequestContext, run: string, app = "Gitea", port = 3030) {
  const res = await request.post("/api/services", {
    data: {
      name: `${app} ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:${port}`,
      category: "System",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `${app} ${run} key`,
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

test.describe("Gitea's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addGitea(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: repositories, a late mirror synced through a plan", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("gt-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("gt-repos")).toHaveText("4");
    await expect(d.getByTestId("gt-runners")).toHaveText("1 of 2");
    await expect(d.getByTestId("gt-failed")).toHaveText("1");
    const mirror = d.getByTestId("gt-mirror");
    await expect(mirror).toContainText("alex/upstream-mirror");
    await expect(mirror).toContainText("late");
    await expect(d.getByTestId("gt-recent")).toContainText("alex/homelab");
    await expect(d).toContainText("Gitea 1.27.3");
    await expect(page.locator("body")).not.toContainText("SECRET");
    await shot(page, "gitea-overview");
    await mirror.getByTestId("gt-sync").click();
    await approve(page, /Sync the mirror alex\/upstream-mirror now/);
    await expect(mirror).not.toContainText("late", { timeout: 20_000 });
  });

  test("Actions: runners, a failed run run again, a runner turned off", async ({ page }) => {
    const panel = await open(page, id, "actions");
    const tab = panel.getByTestId("gt-actions-tab");
    await expect(tab.getByTestId("gt-runner")).toHaveCount(2, { timeout: 30_000 });
    await expect(tab.getByTestId("gt-runner").last()).toContainText("offline");
    await expect(tab.getByTestId("gt-run")).toContainText("failed");
    await shot(page, "gitea-actions");
    await tab.getByTestId("gt-rerun").click();
    await approve(page, /Run the failed jobs of "Update compose files"/);
    await expect(tab.getByTestId("gt-run")).toContainText("attempt 2", { timeout: 20_000 });
    const garage = tab.getByTestId("gt-runner").filter({ hasText: "garage-runner" });
    await garage.getByTestId("gt-runner-toggle").click();
    await approve(page, /Turn off the runner garage-runner/);
    await expect(garage).toContainText(/\boff\b/, { timeout: 20_000 });
  });

  test("Forgejo: named, waiting runs, runs per repository, no re-run", async ({
    page,
    request,
  }, info) => {
    const fj = await addGitea(
      request,
      `${info.project.name}${Date.now() % 100000}`,
      "Forgejo",
      3031,
    );
    const panel = await open(page, fj, "overview");
    const d = panel.getByTestId("gt-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d).toContainText("Forgejo 13.0.5");
    await expect(d.getByTestId("gt-waiting")).toHaveText("1");
    await expect(page.locator("body")).not.toContainText("SECRET");
    const tab = (await open(page, fj, "actions")).getByTestId("gt-actions-tab");
    await expect(tab).toContainText("Forgejo lists its runners only on its own page", {
      timeout: 30_000,
    });
    await expect(tab.getByTestId("gt-run")).toHaveCount(2);
    await expect(tab.getByTestId("gt-run").last()).toContainText("failed");
    await expect(tab.getByTestId("gt-rerun")).toHaveCount(0);
    await shot(page, "forgejo-actions");
  });
});
