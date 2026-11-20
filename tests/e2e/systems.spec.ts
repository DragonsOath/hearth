import { openHearthTool } from "./hearth-tools";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Adding and removing systems by hand. Tests share one server and database
// (see playwright.config.ts), so each starts from sample data and adopts the
// synthetic machine that DC_FAKE_DISCOVERY scans.
test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  expect(res.status(), "reset demo scenario").toBe(204);
});

async function adoptThisMachine(page: Page) {
  const report = await (await page.request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  const res = await page.request.post("/api/discovery/adopt", {
    data: { reportId: report.id, selections },
  });
  expect(res.ok(), "adopt this machine").toBe(true);
}

async function seriousViolations(page: Page) {
  // Let the dialog finish opening so colours are measured at rest.
  await page.waitForTimeout(400);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test("removing a system asks first, then hides it everywhere", async ({ page }, testInfo) => {
  await adoptThisMachine(page);
  await page.goto("/services/sonarr");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sonarr");

  await page.getByRole("button", { name: "Remove from Hearth" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Remove Sonarr from Hearth?" });
  await expect(dialog).toContainText("Sonarr itself is not stopped, deleted, or changed");
  await expect(dialog).toContainText("bring it back any time from Settings");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/remove-system.png`,
    fullPage: true,
  });

  // Cancel changes nothing.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sonarr");

  await page.getByRole("button", { name: "Remove from Hearth" }).click();
  await dialog.getByRole("button", { name: "Remove Sonarr" }).click();
  await expect(page).toHaveURL(/\/services$/);
  await expect(page.getByRole("link", { name: "Prowlarr", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sonarr", exact: true })).toHaveCount(0);
  if (testInfo.project.name === "desktop") {
    await expect(page.getByTestId("systems-list")).toContainText("Prowlarr");
    await expect(page.getByTestId("systems-list")).not.toContainText("Sonarr");
  }

  // Its own page is gone too.
  await page.goto("/services/sonarr");
  await expect(page.getByText("Service not found")).toBeVisible();

  // Listed under Removed systems, and recorded in the audit log.
  await page.goto("/settings#systems");
  const removed = page.getByRole("region", { name: "Removed systems" });
  await expect(removed.getByTestId("removed-system")).toHaveText([/Sonarr/]);
  await page.getByRole("tab", { name: "About" }).click();
  await expect(page.getByTestId("audit-row").first()).toContainText("Removed Sonarr from Hearth");
});

test("removing a system from its panel closes the panel", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Panels are a desktop view.");
  await adoptThisMachine(page);
  await page.goto("/?panels=service:sonarr");
  await openHearthTool(page.locator('[data-panel="service:sonarr"]'), "Settings");
  await page.getByRole("button", { name: "Remove from Hearth" }).click();
  await page
    .getByRole("alertdialog", { name: "Remove Sonarr from Hearth?" })
    .getByRole("button", { name: "Remove Sonarr" })
    .click();
  await expect(page.getByRole("tablist", { name: "Sonarr sections" })).toHaveCount(0);
  await expect(page).not.toHaveURL(/service:sonarr/);

  // An old link to the panel does not bring it back.
  await page.goto("/?panels=service:sonarr");
  await expect(page.getByTestId("systems-list")).toContainText("Prowlarr");
  await expect(page.getByRole("tablist", { name: "Sonarr sections" })).toHaveCount(0);
  await expect(page.getByText("not in Hearth's records")).toHaveCount(0);
});

test("a removed system comes back from Settings", async ({ page }) => {
  await adoptThisMachine(page);
  expect((await page.request.post("/api/services/sonarr/remove")).ok()).toBe(true);

  await page.goto("/settings#systems");
  const removed = page.getByRole("region", { name: "Removed systems" });
  await removed.getByRole("button", { name: "Bring back Sonarr" }).click();
  await expect(removed).toContainText("Nothing removed");
  await page.getByRole("tab", { name: "About" }).click();
  await expect(page.getByTestId("audit-row").first()).toContainText(
    "Brought Sonarr back to Hearth",
  );

  await page.goto("/services");
  await expect(page.getByRole("link", { name: "Sonarr", exact: true })).toBeVisible();
});

test("a new scan does not bring a removed system back", async ({ page }) => {
  await adoptThisMachine(page);
  expect((await page.request.post("/api/services/sonarr/remove")).ok()).toBe(true);

  await page.goto("/discover");
  await page.getByRole("button", { name: "Scan this machine" }).click();
  const recognised = page.getByRole("region", { name: /^Recognised/ });
  await expect(recognised).toContainText("Prowlarr");
  // Shown as yours to bring back, with nothing to tick.
  await expect(recognised).toContainText("Removed by you");
  await expect(recognised).toContainText("You removed Sonarr from Hearth");
  await expect(page.getByRole("checkbox", { name: "Include Sonarr" })).toHaveCount(0);
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole("button", { name: /^Adopt \d+ services$/ }).click();
  await page
    .getByTestId("keys-offer")
    .getByRole("button", { name: /Continue|No thanks/ })
    .click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/services");
  await expect(page.getByRole("link", { name: "Prowlarr", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sonarr", exact: true })).toHaveCount(0);
  await page.goto("/settings#systems");
  await expect(
    page.getByRole("region", { name: "Removed systems" }).getByTestId("removed-system"),
  ).toHaveText([/Sonarr/]);
});

test("adding a system discovery missed", async ({ page }, testInfo) => {
  await adoptThisMachine(page);
  await page.goto("/services");
  await page.getByRole("button", { name: "Add a system" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a system" });
  // A neutral hint, and an empty field until you type.
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveAttribute(
    "placeholder",
    "System Name",
  );
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Name", { exact: true }).fill("Tasterr");
  await dialog.getByRole("radio", { name: /An app with a web address/ }).check();
  await dialog.getByLabel("Web address", { exact: true }).fill("127.0.0.1:9");
  await dialog.getByLabel("Category").selectOption("Home");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/add-system.png`,
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Add system" }).click();

  await expect(page).toHaveURL(/\/services\/tasterr$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasterr");
  await page.goto("/services");
  await expect(page.getByRole("link", { name: "Tasterr", exact: true })).toBeVisible();

  // The same address twice is explained, not added again.
  await page.getByRole("button", { name: "Add a system" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Tasterr again");
  await dialog.getByRole("radio", { name: /An app with a web address/ }).check();
  await dialog.getByLabel("Web address", { exact: true }).fill("http://127.0.0.1:9");
  await dialog.getByRole("button", { name: "Add system" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already watches that address as Tasterr");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await page.goto("/settings#about");
  await expect(page.getByTestId("audit-row").first()).toContainText("Added Tasterr to Hearth");
});

test("with nothing ticked, Discover still watches the machine itself", async ({ page }) => {
  const scan = await page.request.post("/api/discovery/scan");
  expect(scan.ok()).toBe(true);
  const report = (await scan.json()) as { host: { name: string } };
  await page.goto("/discover");
  await expect(page.getByRole("checkbox").first()).toBeVisible();
  for (const box of await page.getByRole("checkbox").all())
    if (await box.isChecked()) await box.uncheck();
  const watch = page.getByRole("button", { name: `Watch ${report.host.name} only` });
  await expect(watch).toBeEnabled();
  await watch.click();
  const offer = page.getByTestId("keys-offer");
  if (await offer.isVisible().catch(() => false))
    await offer.getByRole("button", { name: /Continue|No thanks/ }).click();
  await page.goto("/systems");
  await expect(page.getByRole("article", { name: report.host.name })).toContainText("This machine");
});
