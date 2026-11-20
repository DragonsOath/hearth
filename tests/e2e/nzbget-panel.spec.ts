import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// NZBGet's panel against the stand-in NZBGet 26 (port 6789, its JSON-RPC): SABnzbd's Overview and
// Downloads tab with NZBGet's own speed limits (a rate, not a share of the line), its health
// warnings (not cleared from Hearth), a download's controls, the history and a retry, and adding
// an .nzb file. Every change goes through the real plan, approval and read-back code. NZBGet's
// news server password never reaches the page.

let hosts = (Date.now() + 53_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.94`;
};

async function addNzbget(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `NZBGet ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:6789`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const key = await request.post("/api/vault/secrets", {
    data: {
      name: `NZBGet ${run} login`,
      kind: "login",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      username: "nzbget",
      value: "e2e-nzbget",
    },
  });
  expect(key.ok(), await key.text()).toBe(true);
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

async function confirm(where: Locator, says: RegExp, rowLeaves = false) {
  const change = where.getByTestId("panel-change").first();
  await expect(change).toContainText(says, { timeout: 15_000 });
  await change.getByTestId("panel-confirm").click();
  if (!rowLeaves) await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 20_000 });
}

const NZB = Buffer.from(
  '<?xml version="1.0" encoding="utf-8"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="Sintel"/></nzb>\n',
);

test.describe("NZBGet's panel", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addNzbget(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Overview: status, its warnings, and a speed limit in MB/s", async ({ page }) => {
    test.setTimeout(90_000);
    const overview = await open(page, id, "overview");
    await expect(overview.getByTestId("sab-downloading")).toContainText("Lantern.S01E03", {
      timeout: 20_000,
    });
    const warnings = overview.getByTestId("sab-warnings");
    await expect(warnings).toContainText("The control password is easy to guess");
    // NZBGet's warnings come from its own health check and log: nothing to clear here.
    await expect(warnings.getByTestId("sab-clear-warnings")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("e2e-SECRET");
    await page.screenshot({
      path: `test-results/screens/${test.info().project.name === "mobile" ? "mobile" : "desktop"}/nzbget-overview.png`,
    });
    await overview.getByLabel("Speed limit").selectOption("5120");
    await confirm(overview, /Limit downloads to 5 MB\/s/);
    await expect(overview.getByLabel("Speed limit")).toHaveValue("5120", { timeout: 15_000 });
  });

  test("a download's controls: high priority, then removed", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "downloads/3");
    const job = panel.getByTestId("sab-job").filter({ hasText: "Open.Source.Album" });
    const detail = job.getByTestId("sab-job-detail");
    await expect(detail.getByTestId("sab-files")).toContainText(
      "Open.Source.Album.FLAC.part01.rar",
      {
        timeout: 20_000,
      },
    );
    await detail.locator('[data-hearth-target="job:priority"]').selectOption("high");
    await confirm(job, /Give Open.Source.Album.FLAC high priority/);
    await expect(job).toContainText("High priority", { timeout: 15_000 });
    await detail.getByTestId("sab-remove").click();
    await detail.getByTestId("sab-remove-plan").click();
    await confirm(job, /Remove Open.Source.Album.FLAC from the queue/, true);
    await expect(panel.getByTestId("sab-job").filter({ hasText: "Open.Source.Album" })).toHaveCount(
      0,
      { timeout: 15_000 },
    );
  });

  test("the history with why it failed, and a retry", async ({ page }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "downloads");
    const downloads = panel.getByTestId("sab-downloads");
    const history = downloads.getByTestId("sab-history");
    const failed = history.getByTestId("sab-done").filter({ hasText: "Broken.Release" });
    await expect(failed).toContainText("too many missing articles", { timeout: 20_000 });
    await failed.getByTestId("sab-retry").click();
    await confirm(failed, /Retry Broken.Release.1080p/, true);
    await expect(
      downloads.getByTestId("sab-job").filter({ hasText: "Broken.Release" }),
    ).toHaveCount(1, { timeout: 15_000 });
  });

  test("Add NZB: an .nzb file in a category, paused", async ({ page }) => {
    test.setTimeout(90_000);
    const overview = await open(page, id, "overview");
    await expect(overview.getByTestId("sab-downloading")).toContainText("Lantern", {
      timeout: 20_000,
    });
    await overview.getByTestId("sab-overview-add").click();
    const form = page.getByTestId("sab-add-form");
    await form.getByTestId("sab-add-file").setInputFiles({
      name: "Sintel.2010.nzb",
      mimeType: "application/x-nzb",
      buffer: NZB,
    });
    await form.getByTestId("sab-add-category").selectOption("Movies");
    await form.getByRole("button", { name: /^Add/ }).last().click();
    const pop = page.getByTestId("approve-here");
    await expect(pop).toContainText(/Add Sintel.2010 to NZBGet/, { timeout: 15_000 });
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/Done|confirms/, { timeout: 20_000 });
    await pop.getByTestId("approve-here-close").click();
    const downloads = await open(page, id, "downloads");
    await expect(downloads.getByTestId("sab-job").filter({ hasText: "Sintel.2010" })).toHaveCount(
      1,
      { timeout: 15_000 },
    );
  });
});
