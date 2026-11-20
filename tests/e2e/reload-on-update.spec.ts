import { expect, test, type Page } from "@playwright/test";

/** The page's marker, or "gone" once it reloaded (also while it is reloading). */
const marker = (page: Page) =>
  page
    .evaluate(() => (window as unknown as { marker?: number }).marker ?? "gone")
    .catch(() => "reloading");

// After an update (the owner, 11-13): an open page reloads into the new version at a safe moment,
// and a file the update replaced makes it reload once instead of showing an error.

test("a newer version loads when you move to another page; a missing file reloads once", async ({
  page,
}) => {
  // The server says it now serves another build than the one this page runs.
  await page.route("**/api/health", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, webBuild: "index-newer.js" } });
  });
  // The "new" page is the same page with that build named in it, so the reload goes ahead.
  await page.route("**/", async (route) => {
    if (route.request().resourceType() !== "fetch") return route.fallback();
    const res = await route.fetch();
    await route.fulfill({ response: res, body: `${await res.text()}<!-- index-newer.js -->` });
  });
  await page.goto("/");
  await expect(page.getByTestId("update-notice")).toContainText("A new version of Hearth is ready");
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  // Moving to another page reloads into the new version.
  // An in-app move to another page (as a sidebar or bottom-bar link does).
  await page.evaluate(() => {
    history.pushState({}, "", "/todo");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect.poll(() => marker(page), { timeout: 20_000 }).toBe("gone");

  // A file the update replaced: reload once, then show the error if it happens again soon.
  await page.unroute("**/api/health");
  await page.waitForLoadState("domcontentloaded");
  // A file cut off by that reload may already have used up this minute's one reload: start clean.
  await page.evaluate(() => {
    sessionStorage.removeItem("hearth-reloaded-for-update");
    (window as unknown as { marker: number }).marker = 2;
  });
  await page.evaluate(() =>
    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true })),
  );
  await expect.poll(() => marker(page), { timeout: 20_000 }).toBe("gone");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 3));
  const prevented = await page.evaluate(() => {
    const e = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(3);
});
