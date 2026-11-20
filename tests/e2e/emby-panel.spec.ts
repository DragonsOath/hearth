import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Emby through Jellyfin's panel (Emby speaks the same API), against the stand-in on port 8096:
// the panel says Emby, has every tab, and changes (an account, a title) go through the real plan,
// approval and read-back code.

let hosts = (Date.now() + 59_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.95`;
};

async function addEmby(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Emby ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8096`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Emby ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-emby-key",
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

test.describe("Emby's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addEmby(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Emby gets Jellyfin's panel with its own name and every tab", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "people");
    const users = panel.getByTestId("jf-user");
    await expect(users).toHaveCount(3, { timeout: 20_000 });
    await expect(panel).toContainText("Passwords stay in Emby");
    if (test.info().project.name !== "mobile") {
      const tabs = panel.getByRole("tablist").first();
      for (const t of ["Library", "People", "Manage"])
        await expect(tabs.getByRole("tab", { name: t })).toBeVisible();
    }
    const kim = users.filter({ hasText: "kim" });
    await kim.getByRole("button", { name: "Change access" }).click();
    await kim.getByRole("button", { name: "Disable account" }).click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toContainText(/kim/, { timeout: 15_000 });
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/Done|verified|finished/, { timeout: 20_000 });
    await pop.getByTestId("approve-here-close").click();
    await expect(kim).toContainText("disabled", { timeout: 20_000 });
    await page.screenshot({
      path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/emby-people.png`,
    });
  });

  test("Library: open a title and mark it watched, in Emby's words", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "library");
    await expect(panel.getByTestId("jf-card")).toHaveCount(2, { timeout: 20_000 });
    await panel.locator('[data-hearth-target="library:item:m-anora"]').click();
    const item = panel.getByTestId("jf-item");
    await expect(item.getByTestId("jf-item-title")).toContainText("Anora");
    await item.locator('[data-hearth-target="item:watched"]').click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toContainText(/Mark Anora watched/, { timeout: 15_000 });
    await expect(pop).toContainText(/Emby/);
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/Done|verified|finished/, { timeout: 20_000 });
    await pop.getByTestId("approve-here-close").click();
    await expect(item.locator('[data-hearth-target="item:watched"]')).toHaveText(/Mark unwatched/, {
      timeout: 20_000,
    });
  });
});
