import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Audiobook intake (the owner's Audiobook Organizer, inside Hearth) in Audiobookshelf's Intake tab,
// against the stand-in Audiobookshelf (13378) and real folders on this machine: one setup plan,
// then a finished release you name yourself is copied into the library as Author/Title.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.29`;
};

async function approve(page: Page, says: RegExp) {
  const pop = page.getByTestId("approve-here");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop).toContainText(says);
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText(/Done|verified|finished/, { timeout: 20_000 });
  await pop.getByTestId("approve-here-close").click();
}

test("audiobook intake: set up once, then a release you name is copied in as Author/Title", async ({
  page,
  request,
}, info) => {
  test.setTimeout(120_000);
  const root = await fs.mkdtemp(path.join(tmpdir(), `hearth-intake-e2e-${info.project.name}-`));
  const downloads = path.join(root, "Audiobooks");
  const library = path.join(root, "Audio Books");
  const release = path.join(downloads, "Andy Weir - Project Hail Mary");
  await fs.mkdir(release, { recursive: true });
  await fs.mkdir(library, { recursive: true });
  for (const n of ["01.mp3", "02.mp3"])
    await fs.writeFile(path.join(release, n), Buffer.alloc(50_000, 3));
  // Finished an hour ago: intake waits for a release to be quiet before judging it.
  const old = new Date(Date.now() - 3600_000);
  for (const n of ["01.mp3", "02.mp3"]) await fs.utimes(path.join(release, n), old, old);

  const res = await request.post("/api/services", {
    data: {
      name: `Audiobookshelf ${info.project.name}${Date.now() % 100000}`,
      kind: "web",
      address: `http://${uniqueHost()}:13378`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Audiobookshelf ${id} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-abs-key",
    },
  });

  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@intake`)}`);
  const tab = page.getByTestId("abs-intake");
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(tab).toContainText("Bring finished audiobooks into");
  // The library comes from Audiobookshelf; its folder can be corrected.
  await expect(tab.getByTestId("abs-intake-library")).toContainText("Audiobooks");
  await tab.getByLabel("Audiobooks's folder on this machine").fill(library);
  await tab.getByLabel("Another download folder to watch").fill(downloads);
  await tab.getByRole("button", { name: "Add" }).click();
  await expect(tab.getByTestId("abs-intake-folder").filter({ hasText: downloads })).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page }).include('[data-testid="abs-intake"]').analyze()
    ).violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/audiobook-intake-setup.png`,
    fullPage: true,
  });

  await tab.getByTestId("abs-intake-review").click();
  await approve(page, /Import finished audiobooks/);
  await expect(tab.getByTestId("abs-intake-state")).toContainText("Watching 1 folder");

  // Check now: the release is found and waits for you (or goes in on its own if tags say enough).
  await tab.getByTestId("abs-intake-check").click();
  const job = tab.getByTestId("abs-intake-job").filter({ hasText: "Project Hail Mary" });
  await expect(job).toBeVisible({ timeout: 20_000 });
  await job.getByLabel(/^Author of/).fill("Andy Weir");
  await job.getByLabel(/^Title/).fill("Project Hail Mary");
  await page.screenshot({
    path: `test-results/screens/${info.project.name}/audiobook-intake-waiting.png`,
    fullPage: true,
  });
  await job.getByRole("button", { name: "Import" }).click();
  await approve(page, /Import "Andy Weir - Project Hail Mary"/);
  await expect(tab.getByTestId("abs-intake-history")).toContainText("Andy Weir, Project Hail Mary");
  await expect(tab.getByTestId("abs-intake-history")).toContainText("In your library");
  expect((await fs.readdir(path.join(library, "Andy Weir", "Project Hail Mary"))).sort()).toEqual([
    "01.mp3",
    "02.mp3",
  ]);
  // The download is untouched (0 days: originals kept).
  expect((await fs.readdir(release)).sort()).toEqual(["01.mp3", "02.mp3"]);
  await fs.rm(root, { recursive: true, force: true });
});
