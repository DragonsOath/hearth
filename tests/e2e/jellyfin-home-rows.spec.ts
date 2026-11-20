import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Home rows for Jellyfin (11-08), against the stand-in Jellyfin (port 8096): a person's home
// screen with posters, sections moved and taken off, a library's Recently Added row turned off,
// given to a second person too, saved in one approved plan, read back, and undone.

test("Home rows for Jellyfin: arrange a person's home screen, save it for two people, undo", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const request = page.request;
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.37`;
  const res = await request.post("/api/services", {
    data: {
      name: `Jellyfin ${run}`,
      kind: "web",
      address: `http://${host}:8096`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: `Jellyfin ${run} key`,
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-jellyfin-home-rows",
    },
  });
  try {
    // The way in: the Jellyfin panel's Manage tab.
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}@manage`)}`);
    const link = page.getByTestId("jellyfin-home-rows");
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    const panel = page.getByTestId("home-rows-panel");
    const editor = panel.getByTestId("jf-home");
    await expect(editor).toBeVisible({ timeout: 20_000 });
    // The administrator's home, as Jellyfin has it, with posters.
    await expect(editor.getByTestId("jf-home-user").first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const sections = editor.getByTestId("jf-home-section");
    await expect(sections.first()).toContainText("My Media");
    const recent = sections.filter({ hasText: "Recently Added in Movies" });
    await expect(recent.locator("img").first()).toBeVisible();

    // Continue Watching to the top, Live TV off, Shows' Recently Added row off.
    await editor.getByRole("button", { name: "Move Continue Watching up" }).click();
    await expect(sections.first()).toContainText("Continue Watching");
    await editor.getByRole("button", { name: "Take Live TV off" }).click();
    await expect(sections.filter({ hasText: "Live TV" })).toHaveCount(0);
    await expect(editor.getByTestId("jf-home-add").filter({ hasText: "Live TV" })).toBeVisible();
    await editor
      .getByTestId("jf-home-library")
      .filter({ hasText: "Shows" })
      .getByTestId("jf-home-latest")
      .uncheck();
    await expect(sections.filter({ hasText: "Recently Added in Shows" })).toHaveCount(0);

    const bar = editor.getByTestId("jf-home-save");
    await bar.getByLabel("sam").check();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="home-rows-panel"]')
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

    await bar.getByTestId("jf-home-send").click();
    const card = bar.getByTestId("panel-change");
    await expect(card).toContainText("for 2 people", { timeout: 15_000 });
    await card.getByTestId("panel-confirm").click();
    await expect(card.getByTestId("panel-done")).toContainText("read back", { timeout: 20_000 });
    // Read back from Jellyfin: sam has it too.
    const sam = (await (await request.get(`/api/services/${id}/jellyfin/home?id=u2`)).json()) as {
      home: { sections: string[]; latest: string[] };
    };
    expect(sam.home.sections[0]).toBe("resume");
    expect(sam.home.sections).not.toContain("livetv");
    expect(sam.home.latest).toEqual(["lib-movies"]);

    // Undo puts the administrator's and sam's home screens back.
    await bar.getByTestId("jf-home-undo").click();
    await expect(card).toContainText("for 2 people", { timeout: 15_000 });
    await card.getByTestId("panel-confirm").click();
    await expect(card.getByTestId("panel-done")).toContainText("read back", { timeout: 20_000 });
    const back = (await (await request.get(`/api/services/${id}/jellyfin/home?id=u2`)).json()) as {
      home: { sections: string[]; latest: string[] };
    };
    expect(back.home.sections).toContain("livetv");
    expect(back.home.latest).toEqual(["lib-movies", "lib-shows"]);
  } finally {
    await request.post(`/api/services/${id}/remove`, { data: {} });
    // No reset of the stand-in apps: other specs use them at the same time; Undo above put
    // both home screens back.
  }
});
