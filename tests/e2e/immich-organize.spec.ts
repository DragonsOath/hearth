import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Organizing photos in the Immich panel, against the stand-in Immich (port 2283), never a real
// library: choosing photos (tap, Shift-click, select all), putting them in a new or existing album
// through one approved plan with its progress, undoing it, and flipping and turning a photo with
// Immich's own non-destructive edits, then restoring the original.

let hosts = (Date.now() + 29_000) % 60_000;
const host = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.23`;
};

async function addImmich(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `Immich organize ${run}`,
      kind: "web",
      address: `http://${host()}:2283`,
      category: "Files & Photos",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Immich organize ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-im-organize",
    },
  });
  return id;
}

async function open(page: Page, id: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@photos`)}`);
  // A phone shows one panel at a time; a tablet or desktop shows it among the others (at tablet
  // width without the desktop's panel frame, so the Photos tab itself is the root there).
  const panel =
    device(page) === "mobile"
      ? page.getByTestId("service-workspace")
      : device(page) === "tablet"
        ? page.getByTestId("im-photos")
        : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByTestId("im-photos-grid").getByTestId("im-photo")).toHaveCount(60, {
    timeout: 20_000,
  });
  return panel;
}

const device = (page: Page) =>
  test.info().project.name === "mobile"
    ? "mobile"
    : (page.viewportSize()?.width ?? 1440) < 1000
      ? "tablet"
      : "desktop";
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/screens/${device(page)}/${name}.png` });

async function approve(page: Page, plan: RegExp, done: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(plan);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(done, { timeout: 30_000 });
  return pop;
}

test.describe("Organizing Immich photos", () => {
  test.describe.configure({ mode: "serial" });
  let id = "";
  test.beforeAll(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addImmich(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("choose photos, make an album with one approval, then undo it", async ({ page }) => {
    const panel = await open(page, id);
    const grid = panel.getByTestId("im-photos-grid").getByTestId("im-photo");
    await panel.getByTestId("im-select").click();
    const bar = panel.getByTestId("im-select-bar");
    await expect(bar).toBeVisible();
    // A tap chooses instead of opening the full view.
    await grid.nth(0).getByRole("button").first().click();
    await expect(page.getByTestId("im-full-view")).toHaveCount(0);
    await expect(grid.nth(0)).toHaveAttribute("data-chosen", "true");
    await grid.nth(2).getByRole("button").first().click();
    await expect(panel.getByTestId("im-select-count")).toHaveText("2 chosen");
    if (test.info().project.name !== "mobile") {
      // Shift-click chooses the run from the last one clicked.
      await grid
        .nth(6)
        .getByRole("button")
        .first()
        .click({ modifiers: ["Shift"] });
      await expect(panel.getByTestId("im-select-count")).toHaveText("6 chosen");
    } else {
      for (const n of [3, 4, 5, 6]) await grid.nth(n).getByRole("button").first().click();
      await expect(panel.getByTestId("im-select-count")).toHaveText("6 chosen");
    }
    // Chosen photos stay chosen when more load.
    await panel.getByTestId("im-photos-more").click();
    await expect(grid).toHaveCount(90, { timeout: 15_000 });
    await expect(grid.nth(0)).toHaveAttribute("data-chosen", "true");
    await expect(grid.nth(1)).toHaveAttribute("data-chosen", "false");
    await bar.scrollIntoViewIfNeeded();
    await shot(page, "immich-select");

    await panel.getByTestId("im-organize").click();
    const dialog = page.getByTestId("im-organize-dialog");
    await expect(dialog).toContainText("Put 6 photos in an album");
    // Files keep Immich's names until its storage template is on (Files and folders).
    await expect(dialog.getByTestId("im-organize-names")).toContainText(
      "keeps its own file names now",
    );
    await expect(dialog.getByTestId("im-organize-names")).toContainText(
      "never renames files behind",
    );
    await dialog.getByTestId("im-organize-name").fill("Utah Road Trip 2026");
    await shot(page, "immich-organize");
    await dialog.getByTestId("im-organize-review").click();
    const pop = await approve(
      page,
      /Make the album "Utah Road Trip 2026"[\s\S]*6 photos/,
      /read back/,
    );
    await shot(page, "immich-organize-done");
    await pop.getByTestId("approve-here-close").click();
    await expect(dialog.getByTestId("im-organize-done")).toContainText(
      '6 photos in "Utah Road Trip 2026"',
    );

    // A second album with the same name is not offered; adding to it is.
    await dialog.getByTestId("im-organize-undo").click();
    const undo = await approve(
      page,
      /Take 6 photos out of the album "Utah Road Trip 2026"/,
      /read back/,
    );
    await undo.getByTestId("approve-here-close").click();
    await expect(dialog.getByTestId("im-organize-undone")).toBeVisible();
    await dialog.getByTestId("im-organize-finish").click();
    await expect(bar).toHaveCount(0);
  });

  test("select everything shown, or the whole library, and add to an existing album", async ({
    page,
  }) => {
    const panel = await open(page, id);
    await panel.getByTestId("im-select").click();
    // The grid may load its next page as the bar appears, so "shown" is one page (60) or both
    // (90). Either way it is every photo on screen, which the library choice below then widens.
    await panel.getByTestId("im-select-loaded").click();
    const count = panel.getByTestId("im-select-count");
    await expect(count).toHaveText(/^All (60|90) photos shown so far$/);
    await panel.getByTestId("im-select-library").click();
    await expect(panel.getByTestId("im-select-count")).toHaveText("All 90 photos in the library");
    await panel.getByTestId("im-organize").click();
    const dialog = page.getByTestId("im-organize-dialog");
    await dialog.getByTestId("im-organize-name").fill("utah road trip 2026");
    await expect(dialog.getByTestId("im-organize-clash")).toBeVisible();
    await expect(dialog.getByTestId("im-organize-review")).toBeDisabled();
    await dialog.getByTestId("im-organize-existing").click();
    await dialog
      .getByTestId("im-organize-album")
      .selectOption({ label: "Utah Road Trip 2026 (0)" });
    await dialog.getByTestId("im-organize-review").click();
    const pop = await approve(
      page,
      /Add 90 photos to the album "Utah Road Trip 2026"/,
      /read back/,
    );
    await pop.getByTestId("approve-here-close").click();
    await expect(dialog.getByTestId("im-organize-done")).toContainText("90 photos");
    await dialog.getByTestId("im-organize-finish").click();
  });

  test("flip and turn a photo with a live preview, save it, and restore the original", async ({
    page,
  }) => {
    const panel = await open(page, id);
    const grid = panel.getByTestId("im-photos-grid").getByTestId("im-photo");
    await grid.nth(3).getByRole("button").first().click();
    const view = page.getByTestId("im-full-view");
    await expect(view).toBeVisible();
    // The name, date and place keep one line each, even on a phone.
    const meta = view.getByTestId("im-full-meta");
    await expect(meta).toContainText("4 of");
    expect((await meta.boundingBox())!.height).toBeLessThan(24);
    const before = await view.getByTestId("im-full-image").getAttribute("src");
    await view.getByTestId("im-edit").click();
    const preview = view.getByTestId("im-edit-preview");
    await expect(preview).toHaveAttribute("src", /edited=0/);
    await view.getByTestId("im-edit-rotate-right").click();
    await view.getByTestId("im-edit-flip-h").click();
    // Sideways, flipping what you see left to right is Immich's top to bottom mirror.
    await expect(preview).toHaveAttribute("data-transform", "rotate(90deg) scale(1, -1)");
    await page.waitForTimeout(400);
    await shot(page, "immich-edit");
    // Cancel leaves the photo as it was.
    await view.getByTestId("im-edit-cancel").click();
    await expect(view.getByTestId("im-full-image")).toHaveAttribute("src", before!);

    await view.getByTestId("im-edit").click();
    await view.getByTestId("im-edit-rotate-left").click();
    await view.getByTestId("im-edit-save").click();
    let pop = await approve(page, /turned 270° clockwise[\s\S]*original file stays/, /read back/);
    await pop.getByTestId("approve-here-close").click();
    // The edited picture loads afresh (a new version), and editing has closed.
    await expect(view.getByTestId("im-full-image")).not.toHaveAttribute("src", before!, {
      timeout: 15_000,
    });

    await view.getByTestId("im-edit").click();
    await expect(view.getByTestId("im-edit-restore")).toBeVisible({ timeout: 10_000 });
    await view.getByTestId("im-edit-restore").click();
    pop = await approve(page, /as taken \(the original\)/, /as taken again/);
    await pop.getByTestId("approve-here-close").click();
  });
});

test.describe("Organizing on a tablet", () => {
  test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  test.skip(() => test.info().project.name !== "desktop", "Tablet size runs once, on desktop.");

  test("taps choose photos and the bar fits", async ({ page, request }) => {
    const id = await addImmich(request, `tablet${Date.now() % 100000}`);
    const panel = await open(page, id);
    const grid = panel.getByTestId("im-photos-grid").getByTestId("im-photo");
    await panel.getByTestId("im-select").click();
    await grid.nth(0).getByRole("button").first().tap();
    await grid.nth(1).getByRole("button").first().tap();
    await expect(panel.getByTestId("im-select-count")).toHaveText("2 chosen");
    const bar = panel.getByTestId("im-select-bar");
    const box = await bar.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(820);
    await shot(page, "immich-select");
  });
});
