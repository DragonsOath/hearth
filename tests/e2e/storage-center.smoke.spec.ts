import { expect, test, type APIRequestContext } from "@playwright/test";

// Storage & Files (docs/design/STORAGE_CENTER.md): a Lair panel like a service's, with the
// spec's views. Sample data supplies drives, volumes, folders, and app queues; the panel shows
// them read only, says what it cannot see, and never invents a health percentage.

async function useScenario(request: APIRequestContext) {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario: "attention", replaceYourSystems: true },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test("Storage & Files opens as a panel with every view, read only", async ({ page }, testInfo) => {
  await useScenario(page.request);
  await page.goto("/?panels=tool%3Astorage&focus=tool%3Astorage");
  const panel = page.getByTestId("storage-center");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole("heading", { name: "Storage & Files" })).toBeVisible();

  // Overview: the summary, drives with their own verdicts, activity, explorer, operations.
  const overview = panel.getByTestId("storage-overview");
  await expect(overview.getByTestId("storage-summary")).toContainText("Physical drives");
  await expect(overview.getByTestId("storage-summary")).toContainText("Total capacity");
  await expect(overview.getByTestId("storage-overall")).toBeVisible();
  await expect(overview.getByTestId("storage-overview-drive").first()).toBeVisible();
  await expect(overview.getByTestId("storage-overview-activity")).toBeVisible();
  await expect(
    overview.getByTestId("storage-overview-files").getByTestId("file-manager"),
  ).toBeVisible();
  await expect(panel.getByTestId("storage-host")).toBeVisible();
  await expect(panel).toContainText("Drives, files, and recent activity on");
  await expect(overview.getByTestId("storage-overview-operations")).toBeVisible();
  await expect(overview).toContainText("not a backup");
  await overview.screenshot({
    path: `test-results/screens/${testInfo.project.name}/storage-center-overview.png`,
  });

  // Drives: no single health percentage for hard drives; what is not shared says so.
  await panel.getByRole("tab", { name: "Drives" }).click();
  const drives = panel.getByTestId("storage-drives");
  await expect(drives).toContainText("no single health percentage");
  await expect(drives.getByTestId("storage-drive").first()).toBeVisible();
  // A drive goes by your name for it; renamed in place, it is the card's title.
  const first = drives.getByTestId("storage-drive").first();
  await first.getByTestId("volume-rename").first().click();
  await first.getByTestId("volume-name-input").fill("Film");
  await first.getByRole("button", { name: "Save" }).click();
  await expect(first.getByTestId("storage-drive-name")).toHaveText("Film");

  // Files: a file manager, navigated from the drive.
  await panel.getByRole("tab", { name: "Files" }).click();
  const files = panel.getByTestId("file-manager");
  await expect(files.getByTestId("file-row").first()).toBeVisible();
  await expect(files.getByRole("button", { name: "Back" })).toBeVisible();
  await expect(files.getByRole("button", { name: "Up one folder" })).toBeVisible();

  // Recently Added: every new file on the drives (sample data has none to index).
  await panel.getByRole("tab", { name: "Recently Added" }).click();
  await expect(panel.getByTestId("storage-added")).toBeVisible();
  await expect(panel.getByRole("button", { name: "In your library" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // File journeys: from the apps' own reports, confirmed or inferred.
  await panel.getByRole("tab", { name: "File Journeys" }).click();
  const journeys = panel.getByTestId("storage-journeys");
  await expect(journeys).toContainText("not failed");
  await expect(journeys.getByTestId("storage-journey").first()).toBeVisible();
  await expect(journeys.getByTestId("journey-step").first()).toBeVisible();
  // Open one: its steps say what is confirmed and what is inferred.
  await journeys.getByTestId("storage-journey").first().getByRole("button").first().click();
  await expect(journeys.getByTestId("journey-detail").first()).toContainText(
    /confirmed|inferred|not known/,
  );

  // Volumes & arrays: arrays are reported for what they are, and redundancy is not backup.
  await panel.getByRole("tab", { name: "RAID / Arrays" }).click();
  await expect(panel.getByTestId("storage-volumes")).toContainText("not a backup");
  // Each platform says whether it is read or only detected; nothing offers to repair.
  await panel.getByTestId("storage-array-checks").locator("summary").click();
  await expect(panel.getByTestId("storage-array-checks")).toContainText("not offered");

  // Health & history: what is available and what is not yet, said plainly.
  await panel.getByRole("tab", { name: "Health & History" }).click();
  // Space over time: a dated reading per volume, and a plain sentence about the trend.
  await expect(panel.getByTestId("storage-growth").first()).toBeVisible();
  await expect(panel.getByTestId("storage-trend").first()).toContainText(
    /reading|Steady|Growing|freed/,
  );
  await panel.getByTestId("storage-about").locator("summary").click();
  const caps = panel.getByTestId("storage-capabilities");
  await expect(caps).toContainText("Not built yet");
  await expect(caps).toContainText("Repairs and recovery");

  // The tab is kept in the address, like every panel.
  await expect(page).toHaveURL(/tool%3Astorage%40history|tool:storage@history/);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/storage-center.png`,
    fullPage: true,
  });
});

test("Storage & Files is a switch in the Lair, like the systems", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the Lair is a desktop workspace");
  await useScenario(page.request);
  await page.goto("/?panels=");
  const chip = page.getByTestId("lair-storage");
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("storage-center")).toBeVisible();
  await chip.click();
  await expect(page.getByTestId("storage-center")).toHaveCount(0);
});

test("the storage API answers only a signed-in owner", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await ctx.request.get("/api/storage-center");
  expect([401, 403]).toContain(res.status());
  expect([401, 403]).toContain((await ctx.request.get("/api/storage-center/smart")).status());
  await ctx.close();
});
