import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Home rows for Emby (11-09), against the stand-in Emby (port 8096, an address ending .95): a
// person's own rows with posters, a row of hand-picked titles (Hearth makes the collection),
// Continue Watching taken off, Shows left out of Latest Media, given to a second person too,
// saved in one approved plan, read back, and undone.

interface Home {
  home: { rows: { type: string; name?: string; excluded?: string[] }[] };
}

test("Home rows for Emby: build a row of picked titles, save it for two people, undo", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.95`;
  const res = await request.post("/api/services", {
    data: { name: `Emby ${run}`, kind: "web", address: `http://${host}:8096`, category: "Media" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Emby ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-emby-home-rows",
    },
  });
  const read = async (user: string) =>
    (await (await request.get(`/api/services/${id}/jellyfin/home?id=${user}`)).json()) as Home;
  try {
    // The way in: the Emby panel's Manage tab.
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@manage`)}`);
    const link = page.getByTestId("jellyfin-home-rows");
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    const panel = page.getByTestId("home-rows-panel");
    const editor = panel.getByTestId("emby-home");
    await expect(editor).toBeVisible({ timeout: 20_000 });
    const rows = editor.getByTestId("emby-home-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("My Media");
    const latest = rows.filter({ hasText: "Latest Media" });
    await expect(latest.locator("img").first()).toBeVisible();

    // A row of titles picked by hand.
    const build = editor.getByTestId("emby-home-build");
    await build.getByTestId("emby-home-build-name").fill("Award winners");
    await build.getByTestId("emby-home-find").fill("anora");
    await build.getByTestId("emby-home-find").press("Enter");
    await build.getByTestId("emby-home-found").filter({ hasText: "Anora" }).click();
    await build.getByTestId("emby-home-build-add").click();
    await expect(rows).toHaveCount(4);
    const mine = rows.filter({ hasText: "1 title you picked" });
    await expect(mine.locator("img")).toHaveCount(1);
    await editor.getByRole("button", { name: "Move Award winners up" }).click();
    await editor.getByRole("button", { name: "Move Award winners up" }).click();
    await editor.getByRole("button", { name: "Move Award winners up" }).click();
    await expect(rows.first().getByTestId("emby-home-row-name")).toHaveValue("Award winners");

    // Continue Watching off, Shows out of Latest Media.
    await editor.getByRole("button", { name: "Take Continue Watching off" }).click();
    await expect(rows).toHaveCount(3);
    await latest.getByTestId("emby-home-latest").nth(1).uncheck();
    await expect(latest.getByText("Latest in Shows")).toHaveCount(0);

    const bar = editor.getByTestId("emby-home-save");
    await bar.getByLabel("sam").check();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="home-rows-panel"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await bar.getByTestId("emby-home-send").click();
    const card = bar.getByTestId("panel-change");
    await expect(card).toContainText("for 2 people", { timeout: 15_000 });
    await card.getByTestId("panel-confirm").click();
    await expect(card.getByTestId("panel-done")).toContainText("read back", { timeout: 20_000 });
    // Read back from Emby: sam has it too, the picked titles as a row of their own collection.
    const sam = await read("u2");
    expect(sam.home.rows.map((r) => r.type)).toEqual(["boxset", "userviews", "latestmediablock"]);
    expect(sam.home.rows[0]!.name).toBe("Award winners");
    expect(sam.home.rows[2]!.excluded).toEqual(["lib-shows"]);

    // Undo puts both home screens back.
    await bar.getByTestId("emby-home-undo").click();
    await expect(card).toContainText("for 2 people", { timeout: 15_000 });
    await card.getByTestId("panel-confirm").click();
    await expect(card.getByTestId("panel-done")).toContainText("read back", { timeout: 20_000 });
    expect((await read("u2")).home.rows.map((r) => r.type)).toEqual([
      "userviews",
      "resume",
      "latestmediablock",
    ]);
  } finally {
    await request.post(`/api/services/${id}/remove`, { data: {} });
  }
});
