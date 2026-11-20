import { expect, test } from "@playwright/test";

// The screen camera (11-17, the owner: "a screen capture the same you have for individual panels
// but for the whole hearth screen"): the camera in the top bar captures the whole Hearth screen as
// it is in the window, picks any item, or a drawn region, and the result can be marked up and
// attached like a panel's capture.

test("the camera in the top bar captures the whole Hearth screen", async ({ page }, info) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
  const camera = page.getByTestId("capture-screen").locator("visible=true");
  await camera.click();
  await page.getByRole("menuitem", { name: /Whole screen/ }).click();
  const preview = page.getByRole("dialog", { name: "Capture preview" });
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(preview.getByTestId("capture-context")).toContainText("The whole screen (Settings)");

  // The window's size (a phone's taller page is cut to what is on screen), and not blank.
  const size = await preview
    .getByTestId("capture-canvas")
    .evaluate((c) => ({ w: (c as HTMLCanvasElement).width, h: (c as HTMLCanvasElement).height }));
  const vp = page.viewportSize()!;
  const ratio = size.w / size.h;
  expect(Math.abs(ratio - vp.width / vp.height)).toBeLessThan(0.05);
  const colours = await preview.getByTestId("capture-canvas").evaluate((c) => {
    const cv = c as HTMLCanvasElement;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4 * 97)
      seen.add((d[i]! >> 4) * 256 + (d[i + 1]! >> 4) * 16 + (d[i + 2]! >> 4));
    return seen.size;
  });
  expect(colours).toBeGreaterThan(8);
  const data = await preview
    .getByTestId("capture-canvas")
    .evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
  const fs = await import("node:fs");
  fs.mkdirSync("test-results/screens", { recursive: true });
  fs.writeFileSync(
    `test-results/screens/screen-capture-${info.project.name}.png`,
    Buffer.from(data.split(",")[1]!, "base64"),
  );

  await preview.getByRole("button", { name: "Discard" }).click();
  await expect(preview).toBeHidden();

  // A region of the screen.
  await camera.click();
  await page.getByRole("menuitem", { name: /Draw a region/ }).click();
  await expect(page.getByText("Drag over the part of the screen to capture.")).toBeVisible();
  const box = (await page.getByTestId("capture-region").boundingBox())!;
  const top = Math.max(box.y, 0) + 120;
  await page.mouse.move(40, top);
  await page.mouse.down();
  await page.mouse.move(Math.min(320, vp.width - 20), top + 200, { steps: 6 });
  await page.mouse.up();
  await expect(preview.getByTestId("capture-context")).toContainText("A region");
  await preview.getByRole("button", { name: "Discard" }).click();
  await expect(preview).toBeHidden();

  // Attached to the conversation like any capture, named as the screen.
  await camera.click();
  await page.getByRole("menuitem", { name: /Whole screen/ }).click();
  await preview.getByRole("button", { name: "Attach to conversation" }).click();
  await expect(page.getByText("Screen: Settings")).toBeVisible();
});

// Settings > General > Screen captures (11-18, the owner): Save puts them in a folder on
// Hearth's computer; empty, they download as before.
test("Save puts a capture in the folder set in Settings", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run is enough: the folder is Hearth's.");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const folder = path.resolve(`test-results/captures-${Date.now()}`, "nested");
  try {
    await page.goto("/settings");
    const field = page.getByTestId("capture-folder");
    await expect(field).toBeVisible({ timeout: 15_000 });
    // A partial path is refused, with what to type instead.
    await field.fill("Pictures/Hearth");
    await page.getByTestId("capture-folder-save").click();
    await expect(page.getByRole("alert").filter({ hasText: "whole path" })).toBeVisible();
    await field.fill(folder);
    await page.getByTestId("capture-folder-save").click();
    await expect(page.getByTestId("capture-folder-note")).toHaveText(
      "Captures will be saved there.",
    );
    await field.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/screens/capture-folder-setting.png" });

    await page.getByTestId("capture-screen").locator("visible=true").click();
    await page.getByRole("menuitem", { name: /Whole screen/ }).click();
    const preview = page.getByRole("dialog", { name: "Capture preview" });
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.getByTestId("capture-download")).toBeVisible();
    await preview.getByTestId("capture-save").click();
    await expect(preview.getByRole("status")).toContainText("Saved as", { timeout: 15_000 });
    const files = fs.readdirSync(folder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^hearth-capture-.*\.png$/);
    expect(fs.statSync(path.join(folder, files[0]!)).size).toBeGreaterThan(1000);
    await preview.getByRole("button", { name: "Discard" }).click();

    // Cleared: back to downloading, and no Download button beside Save.
    await field.fill("");
    await page.getByTestId("capture-folder-save").click();
    await expect(page.getByTestId("capture-folder-note")).toHaveText(
      "Captures will download in the browser.",
    );
  } finally {
    await page.request.put("/api/captures/folder", { data: { path: "" } });
    fs.rmSync(path.dirname(folder), { recursive: true, force: true });
  }
});
