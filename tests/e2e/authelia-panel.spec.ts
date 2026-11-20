import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Authelia's read-only panel against the stand-in Authelia (port 9092, its metrics on 9959, as a
// real 4.39.28 answered): sign-in working, and sign-ins, failed and banned from its metrics.

let hosts = (Date.now() + 85_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.101`;
};

async function addAuthelia(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Authelia ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:9092`,
      category: "System",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
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

test.describe("Authelia's panel", () => {
  test("Sign-in working, sign-ins, failed and banned from its metrics", async ({
    page,
    request,
  }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const id = await addAuthelia(request, `${info.project.name}${Date.now() % 100000}`);
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("au-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("au-health")).toHaveText("Working");
    await expect(d.getByTestId("au-signins")).toHaveText("142");
    await expect(d.getByTestId("au-failed")).toHaveText("4");
    await expect(d.getByTestId("au-banned")).toHaveText("2");
    await expect(d.getByTestId("au-facts")).toContainText("1 request answered with a server error");
    await shot(page, "authelia-overview");
  });
});
