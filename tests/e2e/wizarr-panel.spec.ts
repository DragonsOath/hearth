import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Native panels: Wizarr's People and Servers tabs against the stand-in Wizarr 2.2 (port 5690).
// Every change goes through the real plan, confirmation, and read-back code.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.11`;
};

async function addWizarr(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Wizarr ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:5690`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Wizarr ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-wizarr-panel-key",
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

async function confirm(page: Page, expectPlan: RegExp, expectDone: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(expectPlan);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(expectDone, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

test.describe("the native Wizarr panel", () => {
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addWizarr(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("People: extend someone's access and remove someone, each approved", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "people");
    await expect(panel.getByTestId("wizarr-person")).toHaveCount(3);
    await panel.locator('[data-hearth-target="people:search"]').fill("ki");
    await expect(panel.getByTestId("wizarr-person")).toHaveCount(1);
    await panel.locator('[data-hearth-target="person:3:open"]').click();
    await panel.locator('[data-hearth-target="person:3:remove"]').click();
    await confirm(
      page,
      /Remove kim[\s\S]*account deleted on Plex[\s\S]*Check first/,
      /Removed kim/,
    );
    await panel.locator('[data-hearth-target="people:search"]').fill("");
    await expect(panel.getByTestId("wizarr-person")).toHaveCount(2);

    await panel.locator('[data-hearth-target="person:2:open"]').click();
    await panel.locator('[data-hearth-target="person:2:extend:30"]').click();
    await confirm(page, /Extend alex on Plex's access by 30 days/, /read back/);
    await expect(
      panel.locator('[data-hearth-target="person:2"]').getByTestId("wizarr-person-expiry"),
    ).toContainText("Ends");
  });

  test("Overview's Access ending opens People with the soonest first", async ({ page }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    const panel = await open(page, id, "overview");
    await panel.locator('[data-hearth-target="overview:ending"]').click();
    await expect(panel.getByTestId("wizarr-person").first()).toContainText("sam");
    await expect(panel.locator('[data-hearth-target="people:sort"]')).toHaveValue("ending");
  });

  test("Servers shows libraries, and those Wizarr would ignore with how to fix them", async ({
    page,
  }) => {
    test.skip(test.info().project.name === "mobile", "Desk only.");
    const panel = await open(page, id, "servers");
    const server = panel.getByTestId("wizarr-server");
    await expect(server).toContainText("Plex");
    await expect(server).toContainText("Connected");
    await expect(server.getByTestId("wizarr-libraries")).toContainText("TV Shows");
    await expect(server.getByTestId("wizarr-libraries")).not.toContainText("Old Movies");
    await expect(panel.getByTestId("wizarr-unlinked")).toContainText("Old Movies");
    await expect(panel.getByTestId("wizarr-open-settings")).toHaveAttribute(
      "href",
      /\/settings\/$/,
    );
  });

  test("on a phone, People and a person's choices fit the screen", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "Phone only.");
    const panel = await open(page, id, "people");
    await panel.locator('[data-hearth-target="person:1:open"]').click();
    await expect(panel.getByTestId("wizarr-person-actions")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
