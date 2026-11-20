import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Storage > RAID / Arrays on a simulated machine (DC_FAKE_RAID): a RAID 5 with a failed drive
// and a RAID 1 being checked. Replacing the failed drive is planned with the exact drive (model
// and serial), confirmed in place, and the rebuild shows; a drive holding data asks for its
// serial before it can be used; a running check can be paused; creating an array names every
// drive it erases and says RAID is not a backup.

test("RAID / Arrays: inspect, replace a failed drive, pause a check, plan a new array", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.request.post("/api/test/fake-raid");
  await page.goto("/?panels=tool%3Astorage%40volumes&focus=tool%3Astorage");
  const panel = page.getByTestId("storage-center");
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const tab = panel.getByTestId("storage-volumes");

  const media = tab.locator('[data-testid="raid-array"][data-array="media"]');
  const backup = tab.locator('[data-testid="raid-array"][data-array="backup"]');
  await expect(media).toHaveAttribute("data-health", "degraded");
  await expect(backup).toHaveAttribute("data-health", "checking");
  // Degraded arrays open by themselves, with what it means and who is who.
  await expect(media.getByTestId("raid-warnings")).toContainText("No redundancy left");
  const failed = media.locator('[data-testid="raid-member"][data-role="faulty"]');
  await expect(failed).toContainText("WD-WCC7K1CCCCCC");
  // Each action says whether it can run, and if not, why.
  await expect(media.locator('[data-action="change-level"]')).toHaveAttribute(
    "data-status",
    "unsupported",
  );
  await expect(media.locator('[data-action="check"]')).toHaveAttribute("data-status", "blocked");
  await tab.screenshot({ path: `test-results/screens/${testInfo.project.name}/raid-tab.png` });
  await testInfo.attach("raid", {
    body: await page.screenshot({ fullPage: false }),
    contentType: "image/png",
  });

  // Replace the failed drive with the new, empty one: planned with its serial, then confirmed.
  await failed.getByTestId("raid-replace-failed").click();
  const picker = failed.getByTestId("raid-drive-picker");
  await picker.locator('input[value="/dev/sde"]').check();
  await picker.getByTestId("raid-plan").click();
  await expect(failed.getByTestId("raid-plan-details")).toContainText("RAID superblock");
  const change = failed.getByTestId("panel-change");
  await expect(change).toContainText("ZDH1NEWDISK");
  await change.getByTestId("panel-confirm").click();
  await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 30_000 });
  await tab.getByTestId("raid-refresh").click();
  await expect(media).toHaveAttribute("data-health", "rebuilding", { timeout: 15_000 });
  await expect(media.getByTestId("raid-sync")).toContainText("Rebuilding");

  // A drive holding data: its serial must be typed before it can be planned.
  const spare = media.locator('[data-action="add-spare"]');
  await spare.getByTestId("raid-open-add-spare").click();
  const p2 = spare.getByTestId("raid-drive-picker");
  await p2.locator('input[value="/dev/sdf"]').check();
  await expect(p2).toContainText("ntfs");
  await expect(p2.getByTestId("raid-plan")).toBeDisabled();
  await p2.getByTestId("raid-erase-confirm").fill("DATA");
  await expect(p2.getByTestId("raid-plan")).toBeEnabled();
  // The 4 TB drive is too small for the 8 TB mirror: it is not offered there at all (the blank
  // 12 TB one is).
  await backup.getByRole("button", { expanded: false }).first().click();
  const backupSpare = backup.locator('[data-action="add-spare"]');
  await backupSpare.getByTestId("raid-open-add-spare").click();
  await expect(backupSpare.getByTestId("raid-drive-picker")).not.toContainText("/dev/sde");
  await expect(backupSpare.getByTestId("raid-drive-picker")).toContainText("/dev/sdo");

  // Pause the running check.
  const pause = backup.locator('[data-action="pause-check"]');
  await pause.getByTestId("raid-do-pause-check").click();
  await pause.getByTestId("panel-confirm").click();
  await expect(pause.getByTestId("panel-done")).toBeVisible({ timeout: 30_000 });
  await tab.getByTestId("raid-refresh").click();
  await expect(backup.getByTestId("raid-sync")).toContainText("paused", { timeout: 15_000 });

  // Creating an array: every drive it erases is named, and RAID is not a backup.
  const create = tab.getByTestId("raid-create");
  await create.getByRole("button", { name: /Create a new array/ }).click();
  await expect(create).toContainText("RAID is not a backup");
  await create.getByTestId("raid-create-drive").first().check();
  await expect(create.getByTestId("raid-create-erase")).toContainText("Erases everything");

  await media.getByTestId("raid-actions").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/raid-actions.png` });
  await create.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/raid-create.png` });
  // The technologies say what Hearth does with each, and redundancy is not backup.
  await expect(tab.getByTestId("raid-backup-note")).toContainText("not a backup");
  await tab.getByTestId("storage-array-checks").locator("summary").click();
  await expect(tab.getByTestId("storage-array-checks")).toContainText("not offered");

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.request.post("/api/test/fake-raid");
});

// ZFS beside mdadm on the same simulated machine: the pool's group (vdev), a drive with
// checksum errors replaced by serial with a rebuild shown, and the pool's own words.
test("RAID / Arrays: a ZFS pool, replacing a drive, and its scrub", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.request.post("/api/test/fake-raid");
  await page.goto("/?panels=tool%3Astorage%40volumes&focus=tool%3Astorage");
  const tab = page.getByTestId("storage-center").getByTestId("storage-volumes");
  const tank = tab.locator('[data-testid="raid-array"][data-array="tank"]');
  await expect(tank).toHaveAttribute("data-tech", "zfs", { timeout: 20_000 });
  await expect(tank).toContainText("RAID-Z2, 6 drives");
  await tank.getByRole("button", { expanded: false }).first().click();
  await expect(tank.getByTestId("raid-members")).toContainText("raidz2-0");
  await expect(tank.getByTestId("raid-last-check")).toContainText("Last scrub");
  const sdl = tank.locator('[data-testid="raid-member"][data-device="/dev/sdl1"]');
  await expect(sdl).toContainText("3 checksum errors");
  await tank.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/raid-zfs.png` });

  await sdl.getByTestId("raid-replace").click();
  await sdl.getByTestId("raid-drive-picker").locator('input[value="/dev/sdo"]').check();
  await sdl.getByTestId("raid-plan").click();
  const change = sdl.getByTestId("panel-change");
  await expect(change).toContainText("ZL2NEWTWELVE");
  await change.getByTestId("panel-confirm").click();
  await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 30_000 });
  await tab.getByTestId("raid-refresh").click();
  await expect(tank).toHaveAttribute("data-health", "rebuilding", { timeout: 15_000 });
  await expect(tank.getByTestId("raid-sync")).toContainText("Rebuilding (resilver)");
  await expect(tank.locator('[data-action="check"]')).toHaveAttribute("data-status", "blocked");
  await page.request.post("/api/test/fake-raid");
});

// SnapRAID: its data and parity drives, a sync with its safety stop explained, and what changed.
test("RAID / Arrays: SnapRAID, what changed, and a sync", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.request.post("/api/test/fake-raid");
  await page.goto("/?panels=tool%3Astorage%40volumes&focus=tool%3Astorage");
  const tab = page.getByTestId("storage-center").getByTestId("storage-volumes");
  const snap = tab.locator('[data-testid="raid-array"][data-tech="snapraid"]');
  await expect(snap).toContainText("1 parity drive, 3 data drives", { timeout: 20_000 });
  await snap.getByRole("button", { expanded: false }).first().click();
  await expect(snap.getByTestId("raid-warnings")).toContainText("not protected yet");
  await expect(snap.locator('[data-testid="raid-member"][data-role="parity"]')).toContainText(
    "VCJPARITY1",
  );
  const diff = snap.locator('[data-action="diff"]');
  await diff.getByTestId("raid-diff-run").click();
  await expect(diff.getByTestId("raid-snapraid-diff")).toContainText("1204 added", {
    timeout: 15_000,
  });
  await snap.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/raid-snapraid.png`,
  });

  const sync = snap.locator('[data-action="sync"]');
  await sync.getByTestId("raid-do-sync").click();
  await expect(sync.getByTestId("raid-plan-details")).toContainText(
    "more than 50 files were deleted",
  );
  await sync.getByTestId("panel-confirm").click();
  await expect(sync.getByTestId("panel-done")).toBeVisible({ timeout: 30_000 });
  await tab.getByTestId("raid-refresh").click();
  await expect(snap.getByTestId("raid-sync")).toContainText("Syncing parity", { timeout: 15_000 });
  await page.request.post("/api/test/fake-raid");
});

// The Windows machine: a Storage Spaces mirror with a drive that stopped answering, replaced
// with a blank drive (the Windows drive and one in use as E: are never offered), and SnapRAID
// over lettered drives beside it.
test("RAID / Arrays on Windows: Storage Spaces, replacing a lost drive", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.request.post("/api/test/fake-raid?windows=1");
  await page.goto("/?panels=tool%3Astorage%40volumes&focus=tool%3Astorage");
  const tab = page.getByTestId("storage-center").getByTestId("storage-volumes");
  const pool = tab.locator('[data-testid="raid-array"][data-array="MediaPool"]');
  await expect(pool).toHaveAttribute("data-health", "degraded", { timeout: 20_000 });
  await expect(pool).toContainText("Two-way mirror");
  await expect(pool.getByTestId("raid-warnings")).toContainText("is not answering");
  await expect(tab.locator('[data-testid="raid-array"][data-tech="snapraid"]')).toContainText(
    "3 data drives",
  );
  await pool.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/raid-windows.png` });

  const lost = pool.locator('[data-testid="raid-member"][data-role="missing"]');
  await lost.getByTestId("raid-replace-failed").click();
  const picker = lost.getByTestId("raid-drive-picker");
  await expect(picker).not.toContainText("Disk 0");
  await expect(picker).not.toContainText("Disk 7");
  await picker.getByRole("radio", { name: /Disk 5 / }).check();
  await picker.getByTestId("raid-plan").click();
  const change = lost.getByTestId("panel-change");
  await expect(change).toContainText("ZDHNEWSPACE");
  await change.getByTestId("panel-confirm").click();
  await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 30_000 });
  await tab.getByTestId("raid-refresh").click();
  await expect(pool).toHaveAttribute("data-health", "rebuilding", { timeout: 15_000 });
  await page.request.post("/api/test/fake-raid");
});

// Btrfs: a RAID 1 converted in place, which needs a third drive first.
test("RAID / Arrays: Btrfs, converting needs enough drives", async ({ page }) => {
  test.setTimeout(120_000);
  await page.request.post("/api/test/fake-raid");
  await page.goto("/?panels=tool%3Astorage%40volumes&focus=tool%3Astorage");
  const tab = page.getByTestId("storage-center").getByTestId("storage-volumes");
  const vault = tab.locator('[data-testid="raid-array"][data-array="vault"]');
  await expect(vault).toHaveAttribute("data-tech", "btrfs", { timeout: 20_000 });
  await expect(vault).toContainText("RAID 1 (two copies)");
  await vault.getByRole("button", { expanded: false }).first().click();
  const convert = vault.locator('[data-action="change-level"]');
  await expect(convert).toHaveAttribute("data-status", "available");
  await convert.getByTestId("raid-open-change-level").click();
  await convert.getByTestId("raid-convert").click();
  await expect(convert.getByTestId("panel-change")).toContainText("needs at least 3 drives", {
    timeout: 15_000,
  });
  await page.request.post("/api/test/fake-raid");
});
