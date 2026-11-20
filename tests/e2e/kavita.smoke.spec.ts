import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Kavita from Hearth (APP_PANELS.md plan): a stand-in Kavita (DC_FAKE_APPS, port 5000).
// No key yet: the panel asks, the key is pasted, the panel reads; a library is scanned.

test("Kavita panel: paste a key, see series, libraries and unreadable files; scan a library", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.22`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: { name: `Kavita ${run}`, kind: "web", address: `http://${host}:5000`, category: "Media" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const kv = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${kv}`);
    const ask = page.getByTestId("needs-key");
    await expect(ask).toBeVisible({ timeout: 20_000 });
    await ask.getByTestId("paste-key").fill("e2e-kv-key");
    await ask.getByTestId("paste-key-save").click();

    const panel = page.getByTestId("kv-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("kv-series")).toHaveText("420");
    await expect(panel.getByTestId("kv-unreadable")).toHaveText("1");
    await expect(panel.getByTestId("kv-errors")).toContainText("The file is not a valid EPUB");
    const books = panel.getByTestId("kv-library").filter({ hasText: "Books" });
    await expect(books).toContainText("never scanned");

    await books.getByTestId("kv-scan").click();
    const change = books.getByTestId("panel-change");
    await expect(change).toContainText("Scan the Books library");
    await change.getByTestId("panel-confirm").click();
    await expect(books.getByTestId("panel-done")).toContainText("Kavita is scanning Books", {
      timeout: 30_000,
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
    await request.post(`/api/services/${kv}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
