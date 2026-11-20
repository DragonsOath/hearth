import { expect, test, type Page } from "@playwright/test";

// Custom panels are Premium (Panel Builder, in the Premium package, 11-14). Without the package,
// a basic panel's Improve menu offers Request it (free) and Custom panels (what Premium adds),
// and the server has no custom panel routes at all.
const uniqueHost = () =>
  `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

async function open(page: Page, id: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}`)}`);
  // A basic panel shows the app itself first (11-14); Hearth's own panel is Hearth view.
  await page.getByTestId("app-view-hearth").click({ timeout: 20_000 });
  const panel = page.getByTestId("generic-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

test("without the Premium package: Request it, and Custom panels says what Premium adds", async ({
  page,
  request,
}) => {
  const res = await request.post("/api/services", {
    data: {
      name: `ZoneMinder free${Date.now() % 100000}`,
      kind: "web",
      address: `http://${uniqueHost()}:8484`,
      category: "Home",
    },
  });
  const id = ((await res.json()) as { id: string }).id;
  await open(page, id);
  await page.getByTestId("improve-panel").click();
  await expect(page.getByTestId("improve-panel-request")).toBeVisible();
  await expect(page.getByTestId("improve-panel-ember")).toHaveCount(0);
  await expect(page.getByTestId("improve-panel-load")).toHaveCount(0);
  await page.getByTestId("improve-panel-custom").click();
  const card = page.getByTestId("premium-card-panel_builder");
  await expect(card).toContainText("Panel Builder is part of Hearth Premium");
  await expect(card).toContainText("Request it");
  // Nothing custom is reachable without the package.
  expect((await request.get(`/api/services/${id}/custom-panel`)).status()).toBe(404);
  expect(
    (await request.post(`/api/services/${id}/custom-panel/draft`, { data: { spec: {} } })).status(),
  ).toBe(404);
});
