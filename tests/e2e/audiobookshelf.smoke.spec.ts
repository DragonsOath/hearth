import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Audiobookshelf from Hearth (APP_PANELS.md plan): a stand-in (DC_FAKE_APPS, port 13378).
// No key yet: the panel asks, the key is pasted, the panel reads; a backup is made now.

test("Audiobookshelf panel: paste a key, see listening and libraries; make a backup", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.21`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Audiobookshelf ${run}`,
      kind: "web",
      address: `http://${host}:13378`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const abs = ((await res.json()) as { id: string }).id;
  try {
    await page.goto(`/?service=${abs}`);
    const ask = page.getByTestId("needs-key");
    await expect(ask).toBeVisible({ timeout: 20_000 });
    await ask.getByTestId("paste-key").fill("e2e-abs-key");
    await ask.getByTestId("paste-key-save").click();

    const panel = page.getByTestId("abs-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("abs-listening")).toHaveText("1");
    await expect(panel.getByTestId("abs-session")).toContainText("The Hobbit");
    await expect(panel.getByTestId("abs-library").first()).toContainText("312 books");
    // Currently listening: the book, where you are in it, and the chapter.
    const now = panel.getByTestId("abs-now");
    await expect(now).toContainText("The Hobbit");
    await expect(now).toContainText("Listening now");
    await expect(now.getByTestId("abs-now-chapter")).toContainText(
      "Chapter 3 of 4: Over Hill and Under Hill",
    );
    await expect(now.getByTestId("abs-now-chapter")).toContainText("50% through the chapter");
    await expect(now.getByTestId("abs-now-position")).toContainText("3:00:00 of 10:00:00");
    // Shelves: continue listening, your TBR, next in your series.
    await expect(panel.getByTestId("abs-continue-shelf")).toContainText("The Hobbit");
    await expect(panel.getByTestId("abs-tbr-shelf")).toContainText("Dune");
    await expect(panel.getByTestId("abs-series-shelf")).toBeVisible();
    // Recently added with covers (through Hearth) and the book's own details.
    const recent = panel.getByTestId("abs-recent").first();
    await expect(recent).toContainText("Project Hail Mary");
    const cover = recent.getByTestId("abs-cover");
    await expect(cover).toBeVisible();
    await expect
      .poll(() => cover.evaluate((img) => (img as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await recent.click();
    const book = panel.getByTestId("abs-book");
    await expect(book).toContainText("Ray Porter");
    await expect(book).toContainText("16.2 hours");
    await expect(book).toContainText("sole survivor");
    await expect(book).not.toContainText("<p>");

    // Your lists: add a book to the TBR, move it to the top, take it out again.
    await expect(panel.getByTestId("abs-lists")).toContainText("Road trip");
    await book.getByTestId("abs-add-tbr").click();
    let step = book.getByTestId("panel-change");
    await expect(step).toContainText("TBR");
    await step.getByTestId("panel-confirm").click();
    const tbr = panel.getByTestId("abs-tbr-shelf");
    await expect(tbr).toContainText("Project Hail Mary", { timeout: 30_000 });
    await tbr.getByTestId("abs-tbr").filter({ hasText: "Project Hail Mary" }).click();
    const inTbr = tbr.getByTestId("abs-book");
    await expect(inTbr.getByTestId("abs-in-list")).toContainText("2 of 2");
    await inTbr.getByRole("button", { name: /Move Project Hail Mary up/ }).click();
    step = inTbr.getByTestId("panel-change");
    await step.getByTestId("panel-confirm").click();
    await expect(inTbr.getByTestId("abs-in-list")).toContainText("1 of 2", { timeout: 30_000 });
    await inTbr.getByTestId("abs-take-out").click();
    await inTbr.getByTestId("panel-change").getByTestId("panel-confirm").click();
    await expect(tbr).not.toContainText("Project Hail Mary", { timeout: 30_000 });
    await expect(panel.getByTestId("abs-session").getByTestId("abs-cover")).toBeVisible();
    await expect(panel.getByTestId("abs-backup-age")).toHaveText(/days? ago/);

    await panel.getByTestId("abs-backup").click();
    const change = panel.getByTestId("panel-change").last();
    await expect(change).toContainText("Make a backup of");
    await change.getByTestId("panel-confirm").click();
    await expect(panel.getByTestId("abs-backup-age")).toHaveText(/Just now|min ago/, {
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
    await request.post(`/api/services/${abs}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});
