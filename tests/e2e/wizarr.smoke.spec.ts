import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Wizarr from Hearth (checklist 34.8): a stand-in Wizarr (DC_FAKE_APPS, port 5690). Connect it by
// pasting its key in the panel, make an invitation and send its link, delete an unused one.

test("Wizarr panel: connect with a pasted key, create an invitation and get its link, delete one", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.8`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Home Wizarr ${run}`,
      kind: "web",
      address: `http://${host}:5690`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const wizarr = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${wizarr}`);
    // Not connected: why, and where the key comes from; pasting it connects.
    const needs = page.getByTestId("wizarr-needs-key");
    await expect(needs).toContainText("keeps its API keys scrambled", { timeout: 20_000 });
    await needs.getByTestId("wizarr-key").fill("e2e-wizarr-key");
    await needs.getByTestId("wizarr-key-save").click();

    const panel = page.getByTestId("wizarr-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("wizarr-invite")).toHaveCount(3);
    await expect(panel.locator('[data-testid="wizarr-invite"][data-status="used"]')).toContainText(
      "Used by sam",
    );

    // A new invitation: 30-day link, 90 days of access, Movies only; confirmed here, link shown.
    await panel.getByTestId("wizarr-expires").selectOption("30");
    await panel.getByTestId("wizarr-access").selectOption("90");
    await panel.getByLabel("Movies").check();
    await panel.getByTestId("wizarr-create").click();
    const change = panel.getByTestId("panel-change");
    await expect(change).toContainText(
      "libraries: Movies; link works 30 days; access lasts 90 days",
    );
    await change.getByTestId("panel-confirm").click();
    await expect(change.getByTestId("panel-new-link")).toHaveText(
      /^http:\/\/wizarr\.test\/j\/NEW\d+X$/,
      {
        timeout: 20_000,
      },
    );
    await expect(change.getByTestId("panel-copy")).toBeVisible();
    await expect(panel.getByTestId("wizarr-invite")).toHaveCount(4);

    // Delete the expired one: confirmed, then gone.
    await panel
      .locator('[data-testid="wizarr-invite"][data-status="expired"]')
      .getByTestId("wizarr-delete")
      .click();
    await expect(change).toContainText("Delete invitation OLDLINK");
    await change.getByTestId("panel-confirm").click();
    await expect(change.getByTestId("panel-done")).toContainText("Deleted invitation OLDLINK", {
      timeout: 20_000,
    });
    await expect(panel.getByTestId("wizarr-invite")).toHaveCount(3);

    // People is its own tab; Access ending opens it with the soonest first.
    await panel.locator('[data-hearth-target="overview:ending"]').click();
    await expect(page.getByTestId("wizarr-person").first()).toContainText("sam", {
      timeout: 20_000,
    });

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
  } finally {
    await request.post(`/api/services/${wizarr}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
