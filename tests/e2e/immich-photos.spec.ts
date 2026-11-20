import { expect, test, type Page } from "@playwright/test";

// Immich photos in Hearth, against the stand-in Immich v3 (port 2283): Recent photos blurred, hidden
// or off (kept in Hearth), the Photos tab loading the whole timeline as you scroll, and the full view
// with a shared link made through an approved plan, then Text, Email or Copy link.

let hosts = (Date.now() + 13_000) % 60_000;
const host = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.21`;
};

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

test.describe("Immich photos", () => {
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const res = await request.post("/api/services", {
      data: {
        name: `Immich photos ${info.project.name}${Date.now() % 100000}`,
        kind: "web",
        address: `http://${host()}:2283`,
        category: "Files & Photos",
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    id = ((await res.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: "Immich photos key",
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: id,
        value: "e2e-im-photos",
      },
    });
  });

  test("Recent photos: blur one, hide one, blur all, and switch them off", async ({ page }) => {
    const panel = await open(page, id, "overview");
    const recent = panel.getByTestId("im-recent");
    const photos = recent.getByTestId("im-photo");
    await expect(photos).toHaveCount(20, { timeout: 20_000 });

    await photos.nth(0).getByTestId("im-photo-menu").click();
    await page.getByTestId("im-photo-blur").click();
    await expect(photos.nth(0)).toHaveAttribute("data-show", "blur");
    await expect(photos.nth(0)).toContainText("Click to show");

    await photos.nth(1).getByTestId("im-photo-menu").click();
    await page.getByTestId("im-photo-hide").click();
    await expect(photos).toHaveCount(19);
    await shot(page, "immich-recent-blur");

    // Kept in Hearth: still blurred after a reload.
    await page.reload();
    await expect(panel.getByTestId("im-recent").getByTestId("im-photo").first()).toHaveAttribute(
      "data-show",
      "blur",
    );

    await recent.getByTestId("im-recent-blur").click();
    await expect(photos.nth(3)).toContainText("Click to show");
    await recent.getByTestId("im-recent-off").click();
    await expect(panel.getByTestId("im-recent-off-note")).toBeVisible();
    await expect(photos).toHaveCount(0);
    await recent.getByRole("radio", { name: "Show" }).click();
    await expect(photos).toHaveCount(19);
  });

  test("Photos tab: the whole timeline, a full view, and a shared link", async ({ page }) => {
    const panel = await open(page, id, "photos");
    const grid = panel.getByTestId("im-photos-grid").getByTestId("im-photo");
    await expect(grid).toHaveCount(60, { timeout: 20_000 });
    // The hidden photo stays here, blurred, so it can be shown again.
    await expect(grid.nth(1)).toHaveAttribute("data-show", "hide");
    await panel.getByTestId("im-photos-more").scrollIntoViewIfNeeded();
    await expect(grid).toHaveCount(90, { timeout: 15_000 });
    await panel.getByTestId("im-photos-grid").scrollIntoViewIfNeeded();
    await shot(page, "immich-photos-tab");

    await grid.nth(4).click();
    const view = page.getByTestId("im-full-view");
    await expect(view).toBeVisible();
    await expect(view).toContainText("IMG_4096.jpg");
    await expect
      .poll(() =>
        view
          .getByTestId("im-full-image")
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    await expect(view.getByTestId("im-download")).toHaveAttribute("href", /size=preview/);
    await shot(page, "immich-full-view");

    await view.getByTestId("im-share-days").selectOption("30");
    await view.getByTestId("im-share-link").click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText(/anyone can open to IMG_4096\.jpg[\s\S]*30 days/);
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/Made a link/, { timeout: 20_000 });
    await pop.getByTestId("approve-here-close").click();
    const link = view.getByTestId("im-link");
    await expect(link.getByTestId("im-link-url")).toContainText(/\/share\/share\d+key/);
    await expect(link.getByTestId("im-link-text")).toHaveAttribute("href", /^sms:/);
    await expect(link.getByTestId("im-link-email")).toHaveAttribute("href", /^mailto:/);
    await shot(page, "immich-shared-link");

    await page.keyboard.press("ArrowRight");
    await expect(view).toContainText("IMG_4095.jpg");
    await view.getByTestId("im-full-close").click();
    await expect(view).toHaveCount(0);
  });
});
