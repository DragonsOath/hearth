import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Frigate's panel against the stand-in Frigate (port 8971, answering as a real 0.18.2 did): cameras,
// alerts, detector and storage, detection turned off and an event kept through the real plan,
// approval and read-back code. The password and camera stream addresses never reach the page.

const OWNER_PASSWORD = "e2e owner password";
const PASSWORD = "e2e-frigate-SECRET-pass";

let hosts = (Date.now() + 83_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.99`;
};

async function addFrigate(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Frigate ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8971`,
      category: "Home",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Frigate ${run} login`,
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

test.describe("Frigate's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addFrigate(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Cameras, alerts, detector and storage; detection turned off through a plan", async ({
    page,
  }) => {
    const panel = await open(page, id, "overview");
    const d = panel.getByTestId("fg-dashboard");
    await expect(d).toBeVisible({ timeout: 30_000 });
    await expect(d.getByTestId("fg-online")).toHaveText("1 of 2");
    await expect(d.getByTestId("fg-alerts")).toHaveText("3");
    await expect(d.getByTestId("fg-detector")).toHaveText("8.4 ms");
    await expect(d.getByTestId("fg-storage")).toHaveText("96%");
    const garage = d.getByTestId("fg-camera").filter({ hasText: "garage" });
    await expect(garage).toContainText("no picture");
    await expect(page.locator("body")).not.toContainText("SECRET");
    await expect(page.locator("body")).not.toContainText("rtsp://");
    await shot(page, "frigate-overview");
    await garage.getByTestId("fg-detect").click();
    await approve(page, /Turn off object detection for garage/);
    await expect(garage).toContainText("detection off", { timeout: 20_000 });
  });

  test("Recent events: keep one through a plan", async ({ page }) => {
    const d = (await open(page, id, "overview")).getByTestId("fg-dashboard");
    const person = d.getByTestId("fg-event").filter({ hasText: "person" });
    await expect(person).toBeVisible({ timeout: 30_000 });
    await person.getByTestId("fg-keep").click();
    await approve(page, /Keep the event person on front_door forever/);
    await expect(person).toContainText("kept", { timeout: 20_000 });
  });
});
