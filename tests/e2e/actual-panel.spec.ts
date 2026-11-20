import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Actual Budget's read-only panel against the stand-in server (port 5006, answering as a real
// 26.11.0 did): health, version and budget names. The server password never reaches the page.

const KEY = "e2e-actual-SECRET-password";

let hosts = (Date.now() + 79_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.95`;
};

async function addActual(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Actual Budget ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:5006`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Actual Budget ${run} key`,
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

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/${name}.png`,
  });

test.describe("Actual Budget's panel", () => {
  test("Health, version and budget names, never the password", async ({ page, request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const id = await addActual(request, `${info.project.name}${Date.now() % 100000}`);
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("ac-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("ac-health")).toHaveText("Healthy");
    await expect(d.getByTestId("ac-version")).toHaveText("26.11.0");
    await expect(d.getByTestId("ac-budgets")).toHaveText("2");
    await expect(d).toContainText("1 in the trash");
    const budgets = d.getByTestId("ac-budget");
    await expect(budgets.first()).toContainText("Household 2026");
    await expect(budgets.first()).toContainText("encrypted");
    await expect(budgets.last()).toContainText("not encrypted");
    await expect(page.locator("body")).not.toContainText("SECRET");
    await shot(page, "actual-overview");
  });
});
