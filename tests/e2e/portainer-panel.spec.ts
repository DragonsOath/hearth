import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Portainer's panel against the stand-in Portainer (port 9000): environments, an unhealthy
// container, stacks and their containers, and changes through the real plan, approval and
// read-back code (a networking stack is protected). A stack's variables never reach the page.

const OWNER_PASSWORD = "e2e owner password";

let hosts = (Date.now() + 37_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.90`;
};

async function addPortainer(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Portainer ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:9000`,
      category: "System",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Portainer ${run} token`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-portainer",
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

test.describe("Portainer's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addPortainer(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: environments and an unhealthy container restarted", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const board = panel.getByTestId("pt-dashboard");
    await expect(board.getByTestId("pt-environment")).toHaveCount(2, { timeout: 20_000 });
    await expect(board.getByTestId("pt-environment").first()).toContainText(
      "4 running · 1 stopped · 1 unhealthy · 2 stacks",
    );
    await expect(board.getByTestId("pt-environment").nth(1)).toContainText("not reachable");
    const sick = board.getByTestId("pt-unhealthy");
    await expect(sick).toContainText("media-sonarr-1");
    await expect(page.locator("body")).not.toContainText("e2e-SECRET");
    await shot(page, "portainer-overview");
    await sick.getByRole("button", { name: "Restart" }).click();
    await approve(page, /Restart the container media-sonarr-1/);
  });

  test("Stacks: stop and start one, update it, and a networking stack is protected", async ({
    page,
  }) => {
    const panel = await open(page, id, "stacks");
    const tab = panel.getByTestId("pt-stacks");
    const media = tab.getByTestId("pt-stack").filter({ hasText: "media" }).first();
    await expect(media).toContainText("2 of 2 running", { timeout: 20_000 });
    await expect(media.getByTestId("pt-container")).toHaveCount(2);
    await shot(page, "portainer-stacks");
    await media.getByRole("button", { name: "Stop" }).first().click();
    await approve(page, /Stop the stack media \(2 containers\)/);
    await expect(media).toHaveAttribute("data-running", "no", { timeout: 15_000 });
    await media.getByRole("button", { name: "Start" }).first().click();
    await approve(page, /Start the stack media/);
    await expect(media).toHaveAttribute("data-running", "yes", { timeout: 15_000 });
    await media.getByRole("button", { name: "Update" }).click();
    await approve(page, /Update the stack media: pull its images and deploy it again/);
    const vpn = tab.getByTestId("pt-stack").filter({ hasText: "vpn" });
    await vpn.getByRole("button", { name: "Stop" }).first().click();
    await approve(page, /runs networking: approving asks you to confirm it is you/);
    await expect(vpn).toHaveAttribute("data-running", "no", { timeout: 15_000 });
  });
});
