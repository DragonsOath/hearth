import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// SABnzbd's Downloads tab (checklist 46.11) against the stand-in SABnzbd 5.1 (port 8080): adding
// NZBs (a link and an .nzb file), a download's files, the history searched and filtered, and
// clearing warnings. Every change goes through the real plan, approval and read-back code.

let hosts = Date.now() % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.18`;
};

async function addSabnzbd(request: APIRequestContext, run: string) {
  const res = await request.post("/api/services", {
    data: {
      name: `SABnzbd ${run}`,
      kind: "web",
      address: `http://${uniqueHost()}:8080`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const key = await request.post("/api/vault/secrets", {
    data: {
      name: `SABnzbd ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-sab-key",
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

/**
 * Confirms a change in its card, after checking what it says. A change that takes its row away
 * (a retry, a removal) takes the card with it: the caller checks the result instead.
 */
async function confirm(where: Locator, says: RegExp, rowLeaves = false) {
  const change = where.getByTestId("panel-change").first();
  await expect(change).toContainText(says, { timeout: 15_000 });
  await change.getByTestId("panel-confirm").click();
  if (!rowLeaves) await expect(change.getByTestId("panel-done")).toBeVisible({ timeout: 20_000 });
}

const NZB = Buffer.from(
  '<?xml version="1.0" encoding="utf-8"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="Sintel"/></nzb>\n',
);

test.describe("SABnzbd's Downloads tab", () => {
  let id = "";
  test.beforeEach(async ({ request }, info) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    id = await addSabnzbd(request, `${info.project.name}${Date.now() % 100000}`);
  });

  test("Add NZB from Overview: a link and an .nzb file, in a category, high priority", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const overview = await open(page, id, "overview");
    await expect(overview.getByTestId("sab-downloading")).toContainText("Arrival.2016");
    await overview.getByTestId("sab-overview-add").click();

    const form = page.getByTestId("sab-add-form");
    await expect(form).toBeVisible();
    await form
      .getByTestId("sab-add-links")
      .fill("https://indexer.example/getnzb/Big.Buck.Bunny.nzb?apikey=e2e-indexer-key");
    await form.getByTestId("sab-add-file").setInputFiles({
      name: "Sintel.2010.nzb",
      mimeType: "application/x-nzb",
      buffer: NZB,
    });
    await form.getByTestId("sab-add-category").selectOption("movies");
    await form.getByTestId("sab-add-priority").selectOption("high");
    const axe = await new AxeBuilder({ page }).include('[data-testid="sab-add-form"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );
    await form.getByRole("button", { name: "Add 2 NZBs" }).click();

    const pop = page.getByTestId("approve-here");
    await expect(pop).toBeVisible({ timeout: 15_000 });
    await expect(pop).toContainText(/Add 2 NZBs[\s\S]*Big.Buck.Bunny.nzb\?…[\s\S]*Sintel.2010/);
    // An indexer link's key is never shown in the plan.
    await expect(pop).not.toContainText("e2e-indexer-key");
    await pop.getByTestId("approve-here-approve").click();
    await expect(pop).toContainText(/Done|verified|finished/, { timeout: 20_000 });
    await pop.getByTestId("approve-here-close").click();

    const downloads = await open(page, id, "downloads");
    for (const name of ["Big.Buck.Bunny", "Sintel.2010"])
      await expect(downloads.getByTestId("sab-job").filter({ hasText: name })).toContainText(
        "High priority",
        { timeout: 15_000 },
      );
  });

  test("a download's files and controls; removing it keeps what it downloaded", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const panel = await open(page, id, "downloads/SABnzbd_nzo_a1");
    const job = panel.getByTestId("sab-job").filter({ hasText: "Arrival.2016" });
    const detail = job.getByTestId("sab-job-detail");
    await expect(detail.getByTestId("sab-files")).toContainText(
      "Arrival.2016.1080p.BluRay.part01.rar",
    );
    await detail.getByTestId("sab-remove").click();
    await detail.getByTestId("sab-remove-plan").click();
    await confirm(job, /Remove Arrival.2016.1080p.BluRay from the queue[\s\S]*stays/, true);
    await expect(panel.getByTestId("sab-job").filter({ hasText: "Arrival.2016" })).toHaveCount(0, {
      timeout: 15_000,
    });
  });

  test("the history: searched, failed only from Overview's link, and a retry", async ({ page }) => {
    test.setTimeout(90_000);
    const overview = await open(page, id, "overview");
    await overview.getByRole("button", { name: "Retry or remove them" }).click();
    const downloads = page.getByTestId("sab-downloads");
    await expect(downloads.getByTestId("sab-failed-only")).toBeChecked({ timeout: 15_000 });
    const history = downloads.getByTestId("sab-history");
    await expect(history.getByTestId("sab-done")).toHaveCount(1);
    await expect(history).toContainText("Dune.Part.Two");

    await downloads.getByTestId("sab-failed-only").uncheck();
    await downloads.locator('[data-hearth-target="history:search"]').fill("paper");
    await expect(history.getByTestId("sab-done")).toHaveCount(1, { timeout: 15_000 });
    await expect(history).toContainText("Paper.Moons");

    await downloads.locator('[data-hearth-target="history:search"]').fill("dune");
    const failed = history.getByTestId("sab-done").filter({ hasText: "Dune.Part.Two" });
    await failed.getByTestId("sab-retry").click();
    await confirm(failed, /Retry Dune.Part.Two.2024.2160p/, true);
    await expect(downloads.getByTestId("sab-job").filter({ hasText: "Dune.Part.Two" })).toHaveCount(
      1,
      { timeout: 15_000 },
    );
  });

  test("warnings are shown on Overview and cleared there", async ({ page }) => {
    test.setTimeout(90_000);
    const overview = await open(page, id, "overview");
    const warnings = overview.getByTestId("sab-warnings");
    await expect(warnings).toContainText("too many connections");
    await warnings.getByTestId("sab-clear-warnings").click();
    await confirm(warnings, /Clear the warning/);
    await expect(warnings).not.toContainText("too many connections", { timeout: 15_000 });
  });
});
