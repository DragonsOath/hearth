import { expect, test, type Page } from "@playwright/test";

// The phone (11-13, the owner: "make every screen fixed, no scrolling side to side, make
// everything fit width wise"): on every screen, nothing is wider than the phone. Each element
// is checked, not just the page, so nothing hides past the edge. Things inside a strip that
// scrolls on its own (a row of tabs, a carousel) are allowed past it.

const SCREENS = [
  "/",
  "/?panels=",
  "/ask",
  "/projects",
  "/services",
  "/services/plex",
  "/systems",
  "/findings",
  "/incidents",
  "/autonomy",
  "/notifications",
  "/storage",
  "/docker",
  "/network",
  "/logs",
  "/backups",
  "/todo",
  "/releases",
  "/forge",
  "/jobs",
  "/agent",
  "/vault",
  "/memory",
  "/integrations",
  "/settings",
  "/devices",
  "/discover",
  "/plan",
  "/war-room",
];

async function tooWide(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    // A strip meant to scroll sideways on its own: a row of tabs, the Lair's ring.
    const strip = (e: Element) =>
      e.getAttribute("role") === "tablist" ||
      (e as HTMLElement).dataset.testid === "carousel" ||
      (e as HTMLElement).dataset.strip !== undefined;
    const scrollsSideways = (el: Element | null): boolean => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (strip(e) && e.scrollWidth > e.clientWidth + 1) return true;
        if (s.position === "fixed" && e !== el) return false;
      }
      return false;
    };
    // Any other box that scrolls sideways is the problem itself.
    for (const e of document.body.querySelectorAll<HTMLElement>("*")) {
      if (e.closest('[role="tablist"],[data-testid="carousel"],[data-strip]')) continue;
      const s = getComputedStyle(e);
      if (!/(auto|scroll)/.test(s.overflowX) || e.scrollWidth <= e.clientWidth + 1) continue;
      if (!e.getBoundingClientRect().height) continue;
      const what =
        e.dataset.testid ??
        e.getAttribute("aria-label") ??
        `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 3).join(".")}`;
      out.push(`scrolls sideways: ${what} (${e.scrollWidth} in ${e.clientWidth})`);
    }
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") continue;
      if (r.right <= width + 1 && r.left >= -1) continue;
      if (scrollsSideways(el.parentElement)) continue;
      // Off-screen on purpose (skip links, screen-reader text).
      if (r.right <= 0 || r.left >= width) continue;
      const name =
        el.dataset.testid ??
        el.getAttribute("aria-label") ??
        `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")}`;
      out.push(`${name} (${Math.round(r.left)}..${Math.round(r.right)} of ${width})`);
      if (out.length >= 12) break;
    }
    return {
      page: document.documentElement.scrollWidth - width,
      elements: out,
    };
  });
}

test("every screen fits the phone's width: nothing scrolls sideways", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  test.setTimeout(240_000);
  const problems: string[] = [];
  for (const path of SCREENS) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(600);
    const r = await tooWide(page);
    if (r.page > 0 || r.elements.length)
      problems.push(`${path}: page +${r.page}px; ${r.elements.join("; ") || "-"}`);
    const x = await page.evaluate(() => {
      window.scrollTo(400, window.scrollY);
      return window.scrollX;
    });
    if (x > 0) problems.push(`${path}: the page moved sideways by ${x}px`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the phone has the Lair and no War Room; the War Room page points to the Lair", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");
  await expect(page.getByTestId("war-room-button").locator("visible=true")).toHaveCount(0);
  await page.getByTestId("phone-lair-button").click();
  await expect(page).toHaveURL(/panels=/);
  await page.goto("/war-room");
  const notice = page.getByTestId("war-room-phone");
  await expect(notice).toContainText("tablet or computer");
  await notice.getByRole("link", { name: "Open the Lair" }).click();
  await expect(page).toHaveURL(/panels=/);
});

test("every app's panel fits the phone's width, on each of its tabs", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  test.setTimeout(600_000);
  const services = (
    (await (await page.request.get("/api/workspace")).json()) as { services: { id: string }[] }
  ).services;
  const problems: string[] = [];
  for (const { id } of services) {
    await page.goto(`/?panels=${encodeURIComponent(`service:${id}`)}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(700);
    const tabs = page.locator('[role="tablist"]:visible [role="tab"]');
    const count = Math.min(await tabs.count(), 8);
    for (let i = 0; i <= count; i++) {
      if (i > 0) {
        await tabs
          .nth(i - 1)
          .click({ timeout: 3000 })
          .catch(() => undefined);
        await page.waitForTimeout(500);
      }
      const r = await tooWide(page);
      if (r.page > 0 || r.elements.length)
        problems.push(
          `${id}${i ? ` tab ${i}` : ""}: page +${r.page}px; ${r.elements.slice(0, 4).join("; ") || "-"}`,
        );
    }
  }
  expect(problems, problems.join("\n")).toEqual([]);
});
