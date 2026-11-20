import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Lidarr and Chaptarr from Hearth (APP_PANELS.md plan): stand-ins (DC_FAKE_APPS, ports 8686 and
// 8789). The stuck download and its reason, what is missing, and searching for an album.

for (const [app, port, missing] of [
  ["Lidarr", 8686, "Radiohead - Kid A"],
  ["Chaptarr", 8789, "Andy Weir - Artemis"],
] as const) {
  test(`${app} panel: stuck download first, missing items; search for one`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const run = `${testInfo.project.name}${Date.now() % 100000}`;
    const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.18`;
    const request = page.request;
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const res = await request.post("/api/services", {
      data: {
        name: `${app} ${run}`,
        kind: "web",
        address: `http://${host}:${port}`,
        category: "Media",
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `${app} test key`,
        kind: "api-key",
        tier: "automation",
        // Diagnostics only, so the panel asks to allow changes first.
        scope: "read",
        serviceId: id,
        value: "e2e-lib-key",
      },
    });
    try {
      await page.goto(`/?service=${id}`);
      const panel = page.getByTestId("lib-dashboard");
      await expect(panel).toBeVisible({ timeout: 20_000 });
      if (app === "Lidarr") await expect(panel.getByTestId("lib-stuck")).toHaveText("1");
      else
        await expect(panel.getByTestId("lib-downloading").locator("..")).toContainText("1 stuck");
      await expect(panel.getByTestId("lib-problem").first()).toBeVisible();
      // Laid out like Sonarr's panel: the release, size, client and indexer on each download.
      const stuck = panel.locator('[data-testid="lib-queue"][data-stuck="yes"]');
      await expect(stuck).toContainText("SABnzbd");
      await expect(stuck).toContainText("UsenetOne");
      await expect(stuck.locator(".font-mono")).not.toBeEmpty();
      await panel.getByRole("radio", { name: /Recent activity/ }).click();
      await expect(panel.getByTestId("lib-recent")).toContainText(/imported/i);
      await panel.getByRole("radio", { name: /Missing/ }).click();
      const item = panel.getByTestId("lib-missing").filter({ hasText: missing });

      // The key was added for reading only, so the change is allowed first, then made.
      await item.getByTestId("lib-search").click();
      await item.getByRole("button", { name: /Allow confirmed changes/ }).click();
      await expect(item.getByTestId("panel-allow-changes")).toContainText("Allowed");
      await item.getByTestId("lib-search").click();
      const change = item.getByTestId("panel-change");
      await expect(change).toContainText(`Search for ${missing}`);
      await change.getByTestId("panel-confirm").click();
      if (app === "Lidarr")
        await expect(panel.getByTestId("lib-missing-count")).toHaveText("0", { timeout: 40_000 });
      else
        await expect(panel.getByRole("radio", { name: /Missing/ })).toHaveText(/Missing\s*0/, {
          timeout: 40_000,
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
      await request.post(`/api/services/${id}/remove`, { data: {} });
      await request.post("/api/test/fake-apps", { data: { reset: true } });
      for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
        await request.delete(`/api/desk/groups/${g.id}`);
    }
  });
}

// Chaptarr's collection: wanted books per format and on disk, the folders, each author, and
// wanting a book that is coming out (a plan confirmed in place, then read back).
test("Chaptarr panel: wanted per format, authors, and wanting a coming book", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${testInfo.project.name}${Date.now() % 100000}`;
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.19`;
  const request = page.request;
  await request.post("/api/test/fake-apps", { data: { reset: true } });
  const res = await request.post("/api/services", {
    data: {
      name: `Chaptarr ${run}`,
      kind: "web",
      address: `http://${host}:8789`,
      category: "Media",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await request.post("/api/vault/secrets", {
    data: {
      name: "Chaptarr test key",
      kind: "api-key",
      tier: "automation",
      scope: "approved-changes",
      serviceId: id,
      value: "e2e-lib-key",
    },
  });
  try {
    await page.goto(`/?service=${id}`);
    const panel = page.getByTestId("lib-dashboard");
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("lib-format-audiobook")).toHaveText("1 / 1");
    await expect(panel.getByTestId("lib-format-ebook")).toHaveText("1 / 2");
    await expect(panel.getByTestId("lib-collection")).toContainText("6 books");
    await expect(panel.getByTestId("lib-folders")).toContainText("/audiobooks");

    await panel.getByRole("radio", { name: /^Wanted/ }).click();
    await expect(panel.getByTestId("lib-wanted")).toHaveCount(3);
    await panel.getByRole("radio", { name: /Not on disk/ }).click();
    await expect(panel.getByTestId("lib-wanted")).toHaveCount(1);
    await expect(panel.getByTestId("lib-wanted")).toContainText("Artemis");
    await expect(panel.getByTestId("lib-wanted-search")).toBeVisible();
    await panel.getByRole("radio", { name: /^All/ }).click();
    await panel.getByLabel("Find a wanted book, author, or series").fill("martian");
    await expect(panel.getByTestId("lib-wanted")).toHaveCount(2);
    await expect(panel.locator('[data-testid="lib-wanted"] [data-format="audiobook"]')).toHaveCount(
      1,
    );
    await expect(panel.getByTestId("lib-wanted").first()).toContainText("R. C. Bray");
    await testInfo.attach("chaptarr-wanted", {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    await panel.getByRole("radio", { name: /Authors/ }).click();
    const weir = panel.getByTestId("lib-author").filter({ hasText: "Andy Weir" });
    await expect(weir).toContainText("1 audiobook and 2 ebooks wanted");
    await expect(weir).toContainText("1 not on disk");
    await expect(weir).toContainText("Next: The Next One");

    await panel.getByRole("radio", { name: /Coming/ }).click();
    const coming = panel.getByTestId("lib-coming").filter({ hasText: "The Next One" });
    await expect(coming).toHaveAttribute("data-wanted", "no");
    await coming.getByTestId("lib-want").click();
    const change = coming.getByTestId("panel-change");
    await expect(change).toContainText("the audiobook of The Next One by Andy Weir");
    await change.getByTestId("panel-confirm").click();
    await expect(coming).toHaveAttribute("data-wanted", "yes", { timeout: 40_000 });
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/chaptarr-coming.png`,
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
    await request.post(`/api/services/${id}/remove`, { data: {} });
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
      await request.delete(`/api/desk/groups/${g.id}`);
  }
});

// Interactive search (10-26): find a title, see what the indexers offer with the app's
// verdict, download one (a plan confirmed in place), and see it arrive in the queue.
for (const [app, port, find, item] of [
  ["Lidarr", 8686, "kid a", "31"],
  ["Chaptarr", 8789, "artemis", "63"],
] as const) {
  test(`${app} panel: Search releases finds a title and downloads the picked release`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const run = `${testInfo.project.name}${Date.now() % 100000}`;
    const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.20`;
    const request = page.request;
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const res = await request.post("/api/services", {
      data: {
        name: `${app} ${run}`,
        kind: "web",
        address: `http://${host}:${port}`,
        category: "Media",
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    await request.post("/api/vault/secrets", {
      data: {
        name: `${app} search key`,
        kind: "api-key",
        tier: "automation",
        scope: "approved-changes",
        serviceId: id,
        value: "e2e-lib-key",
      },
    });
    try {
      await page.goto(`/?service=${id}`);
      const panel = page.getByTestId("lib-dashboard");
      await expect(panel).toBeVisible({ timeout: 20_000 });
      await panel.getByRole("radio", { name: /Search releases/ }).click();
      const search = panel.getByTestId("interactive-search");
      await search.getByTestId("isearch-input").fill(find);
      await search.getByRole("button", { name: "Find" }).click();
      await search.getByTestId("isearch-title").first().click();
      const releases = page.getByTestId("isearch-releases");
      // The one the app would take is shown; the other, with the app's reason, on request.
      await expect(releases.getByTestId("isearch-release")).toHaveCount(1, { timeout: 20_000 });
      await expect(releases).toContainText("2 found, 1");
      await releases.getByRole("button", { name: /Show all 2/ }).click();
      await expect(releases.getByTestId("isearch-release")).toHaveCount(2);
      await expect(releases.getByTestId("isearch-release").last()).toContainText(
        "Not wanted in profile",
      );
      // Chaptarr's hidden results (collections, packs) are listed too, and say so.
      await expect(releases.getByTestId("isearch-hidden")).toHaveCount(app === "Chaptarr" ? 1 : 0);
      const best = releases.getByTestId("isearch-release").first();
      await best.getByTestId("isearch-download").click();
      const change = best.getByTestId("panel-change");
      await expect(change).toContainText("Download");
      await change.getByTestId("panel-confirm").click();
      await expect(change.getByTestId("panel-done")).toContainText("is in the queue", {
        timeout: 30_000,
      });
      const queued = (await (await request.get(`/api/services/${id}/dashboard`)).json()) as {
        data?: { queue?: { title: string }[] };
      };
      expect(JSON.stringify(queued)).toContain(item);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await request.post(`/api/services/${id}/remove`, { data: {} });
      await request.post("/api/test/fake-apps", { data: { reset: true } });
      for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
        await request.delete(`/api/desk/groups/${g.id}`);
    }
  });
}
