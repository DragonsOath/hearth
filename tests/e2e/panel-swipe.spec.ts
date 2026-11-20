import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The phone's Lair as a ring (PanelCarousel): Ember and every open panel, swiped round in either
// direction, wrapping, without losing anyone's place. Sample systems (plex, sonarr, radarr, bazarr,
// prowlarr) are the stand-ins. The desk (a desktop) is unchanged.

test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  expect(res.status()).toBe(204);
});

const shots = (name: string) => `test-results/screens/mobile/${name}.png`;

/** Opens these sample systems on the phone, showing the first. */
async function openRing(page: Page, ids: string[], focus = ids[0]!) {
  const panels = ids.map((id) => `service:${id}`).join(",");
  await page.goto(
    `/?panels=${encodeURIComponent(panels)}&focus=${encodeURIComponent(`service:${focus}`)}`,
  );
  await expect(page.getByTestId("carousel")).toBeVisible();
}

/** A real finger: touch events through the browser, so its scrolling rules apply as on a phone. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= steps; i++)
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        },
      ],
    });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/**
 * Swipes sideways across the header of what is showing (always clear of content that scrolls
 * sideways itself, such as a code block in a reply): -1 to the left (next), 1 to the right.
 */
async function swipe(page: Page, way: -1 | 1) {
  const box = (await page.getByTestId("carousel").boundingBox())!;
  // Below anything pinned to the top of the screen (Hearth's bar, the sample-data notice): once
  // the page is scrolled, the ring's own top is under them and a finger there never reaches it.
  const pinned = await page.evaluate(() => {
    let bottom = 0;
    for (const el of document.querySelectorAll("body *")) {
      const { position } = getComputedStyle(el);
      if (position !== "fixed" && position !== "sticky") continue;
      const r = el.getBoundingClientRect();
      if (r.top <= 1 && r.bottom < window.innerHeight / 2) bottom = Math.max(bottom, r.bottom);
    }
    return bottom;
  });
  // Then further down past anything that scrolls sideways itself (a tab bar keeps a sideways
  // swipe, by design), wherever the page happens to be scrolled to.
  const y = await page.evaluate(
    ([x, start]) => {
      const sideways = (el: Element | null) => {
        // A text box is never where a finger swipes: touching it means typing.
        if (el?.closest("input, textarea, select, [contenteditable]")) return true;
        for (let e = el; e; e = e.parentElement) {
          const o = getComputedStyle(e).overflowX;
          if ((o === "auto" || o === "scroll") && e.scrollWidth > e.clientWidth) return true;
        }
        return false;
      };
      for (let y = start; y < window.innerHeight - 120; y += 20)
        if (!sideways(document.elementFromPoint(x, y))) return y;
      return start;
    },
    [box.x + box.width / 2, Math.max(box.y, pinned) + 40] as const,
  );
  const left = box.x + box.width * 0.18;
  const right = box.x + box.width * 0.82;
  const before = await page.getByTestId("carousel-current").innerText();
  await drag(page, { x: way < 0 ? right : left, y }, { x: way < 0 ? left : right, y });
  // Let the ring settle on its next panel before the next finger (a swipe that should not switch
  // just waits the short while out).
  await page
    .waitForFunction(
      (was) => document.querySelector('[data-testid="carousel-current"]')?.textContent !== was,
      before,
      { timeout: 1500 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(150);
}

const current = (page: Page) => page.getByTestId("carousel-current");
async function expectShowing(page: Page, name: RegExp | string, position: string) {
  await expect(current(page)).toContainText(name);
  await expect(current(page)).toContainText(position);
}

test.describe("the phone's panel ring", () => {
  test.skip(({ isMobile }) => !isMobile, "The ring is the phone's layout; the desk is unchanged.");

  test("Ember and three systems: swipe round both ways, wrapping", async ({ page }) => {
    await openRing(page, ["plex", "sonarr", "radarr"]);
    await expectShowing(page, "Plex", "2/4");
    await page.screenshot({ path: shots("swipe-plex") });

    // To the left: on round the ring, back to Ember, then Plex again.
    await swipe(page, -1);
    await expectShowing(page, "Sonarr", "3/4");
    await expect(page).toHaveURL(/focus=service%3Asonarr/);
    await expect(page.getByTestId("carousel-announce")).toHaveText("Showing Sonarr, 3 of 4");
    await swipe(page, -1);
    await expectShowing(page, "Radarr", "4/4");
    await page.waitForTimeout(300);
    await page.screenshot({ path: shots("swipe-radarr-mid-ring") });
    await swipe(page, -1);
    await expectShowing(page, /Ember/, "1/4");
    await expect(page).toHaveURL(/view=chat/);
    await page.screenshot({ path: shots("swipe-ember") });
    await swipe(page, -1);
    await expectShowing(page, "Plex", "2/4");

    // To the right: right from Ember goes to the last, Radarr.
    await swipe(page, 1);
    await expectShowing(page, /Ember/, "1/4");
    await swipe(page, 1);
    await expectShowing(page, "Radarr", "4/4");
  });

  test("one, three and five systems", async ({ page }) => {
    // One system: Ember and it, two in the ring.
    await openRing(page, ["plex"]);
    await expectShowing(page, "Plex", "2/2");
    await swipe(page, -1);
    await expectShowing(page, /Ember/, "1/2");
    await swipe(page, -1);
    await expectShowing(page, "Plex", "2/2");

    await openRing(page, ["plex", "sonarr", "radarr"], "radarr");
    await expectShowing(page, "Radarr", "4/4");

    // Five systems: a whole loop of six comes back to the start.
    await openRing(page, ["plex", "sonarr", "radarr", "bazarr", "prowlarr"]);
    await expectShowing(page, "Plex", "2/6");
    for (let i = 0; i < 6; i++) await swipe(page, -1);
    await expectShowing(page, "Plex", "2/6");
    for (let i = 0; i < 6; i++) await swipe(page, 1);
    await expectShowing(page, "Plex", "2/6");
  });

  test("Ember's draft and a chosen tab survive a full loop", async ({ page }) => {
    await openRing(page, ["plex", "sonarr", "radarr"], "sonarr");
    const sonarr = page.locator('[data-carousel-item="service:sonarr"]');
    await sonarr.getByRole("tab", { name: "Activity" }).click();
    await expect(sonarr.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Where the page was scrolled to (on a phone the page scrolls, not the panel).
    const scrollOf = () => page.evaluate(() => document.scrollingElement!.scrollTop);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight,
        ),
      )
      .toBeGreaterThan(200);
    await page.evaluate(() => window.scrollTo({ top: 150, behavior: "instant" }));
    await expect.poll(scrollOf).toBeGreaterThan(100);

    // Leave by swiping (where the page is), back past Plex to Ember.
    await swipe(page, 1);
    await swipe(page, 1);
    await expectShowing(page, /Ember/, "1/4");
    const box = page.locator('textarea[id$="-input"]').first();
    await box.fill("Check the disk on Homeserver");
    // Never switch while typing: a swipe with the box focused stays put.
    await box.focus();
    await swipe(page, -1);
    await expectShowing(page, /Ember/, "1/4");
    await box.blur();

    // A full loop: Ember, Plex, Sonarr, Radarr, Ember.
    for (let i = 0; i < 4; i++) await swipe(page, -1);
    await expectShowing(page, /Ember/, "1/4");
    await expect(box).toHaveValue("Check the disk on Homeserver");
    await swipe(page, -1);
    await expectShowing(page, "Plex", "2/4");
    await swipe(page, -1);
    await expectShowing(page, "Sonarr", "3/4");
    await expect(sonarr.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(scrollOf).toBeGreaterThan(100);
  });

  test("scrolling up and down, and a sideways tab bar, never switch", async ({ page }) => {
    await openRing(page, ["plex", "sonarr", "radarr"], "sonarr");
    const box = (await page.getByTestId("carousel").boundingBox())!;
    const x = box.x + box.width / 2;
    // Up and down, with a little sideways drift: a scroll.
    await drag(page, { x, y: box.y + 420 }, { x: x - 30, y: box.y + 160 });
    await expectShowing(page, "Sonarr", "3/4");

    // Sideways on Sonarr's tab bar, which scrolls sideways itself: it belongs to the tab bar.
    const tabs = page.locator('[data-carousel-item="service:sonarr"]').getByRole("tablist").first();
    const t = (await tabs.boundingBox())!;
    const scrolls = await tabs.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls, "Sonarr's tab bar is wider than a phone").toBe(true);
    await drag(
      page,
      { x: t.x + t.width * 0.85, y: t.y + t.height / 2 },
      { x: t.x + t.width * 0.15, y: t.y + t.height / 2 },
    );
    await expectShowing(page, "Sonarr", "3/4");
  });

  test("closing and opening panels while going round", async ({ page }) => {
    await openRing(page, ["plex", "sonarr", "radarr"], "sonarr");
    // Closing the one showing shows its neighbour, and the ring is one shorter.
    await page
      .locator('[data-carousel-item="service:sonarr"]')
      .getByRole("button", { name: "Close Sonarr" })
      .click();
    await expectShowing(page, "Radarr", "3/3");
    await swipe(page, -1);
    await expectShowing(page, /Ember/, "1/3");

    // A newly opened panel joins the ring and shows.
    await openRing(page, ["plex", "radarr", "bazarr"], "bazarr");
    await expectShowing(page, "Bazarr", "4/4");
    await swipe(page, -1);
    await expectShowing(page, /Ember/, "1/4");
  });

  test("the buttons and the list do everything a swipe does", async ({ page }) => {
    await openRing(page, ["plex", "sonarr", "radarr"]);
    await page.getByTestId("carousel-next").click();
    await expectShowing(page, "Sonarr", "3/4");
    await page.getByTestId("carousel-prev").click();
    await page.getByTestId("carousel-prev").click();
    await expectShowing(page, /Ember/, "1/4");

    // The list: every open panel, one tap to any of them.
    await page.getByTestId("carousel-current").click();
    const list = page.getByTestId("carousel-list");
    await expect(list.getByRole("button")).toHaveCount(4);
    await page.screenshot({ path: shots("swipe-quick-list") });
    await list.getByRole("button", { name: /Radarr/ }).click();
    await expect(list).toHaveCount(0);
    await expectShowing(page, "Radarr", "4/4");

    // One tap back to Ember.
    await page.getByTestId("carousel-ember").click();
    await expectShowing(page, /Ember/, "1/4");

    // Big enough to tap, and nothing serious for assistive tech.
    // (On Ember its own button steps aside, 11-18.)
    for (const id of ["carousel-prev", "carousel-current", "carousel-next"]) {
      const b = (await page.getByTestId(id).boundingBox())!;
      expect(b.height, id).toBeGreaterThanOrEqual(44);
      expect(b.width, id).toBeGreaterThanOrEqual(44);
    }
    const axe = await new AxeBuilder({ page }).include('[aria-label="Open panels"]').analyze();
    expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );

    // Back in the app later: the same panel shows.
    await page.getByTestId("carousel-next").click();
    await page.reload();
    await expectShowing(page, "Plex", "2/4");
  });
});

test("on a desktop the desk is unchanged: no ring", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop only.");
  await page.goto(`/?panels=${encodeURIComponent("service:plex,service:sonarr")}`);
  await expect(page.locator('[data-panel="service:plex"]')).toBeVisible();
  await expect(page.getByTestId("carousel")).toHaveCount(0);
});

// 11-15, the owner: a drop-down of the desktop's bubbles beside Saved workspaces, and a chat that
// never scrolls sideways (it swallowed the swipe between Ember and the panels).
test.describe("the phone's Panels drop-down", () => {
  test.skip(({ isMobile }) => !isMobile, "The drop-down is the phone's; the desk has the bubbles.");

  test("Panels lists every panel as bubbles; a tap adds it to the ring", async ({ page }) => {
    await openRing(page, ["plex"]);
    const toggle = page.getByTestId("phone-panels-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    const list = page.getByTestId("phone-panels");
    await expect(list).toBeVisible();
    await expect(list.getByRole("button", { name: "Plex", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(list.getByRole("button", { name: "Home rows" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: shots("phone-panels") });
    await list.getByRole("button", { name: "Sonarr", exact: true }).click();
    await expect(list).toHaveCount(0);
    await expectShowing(page, "Sonarr", "3/3");
  });

  test("the conversations are in the chat's menu, and picking one closes it", async ({ page }) => {
    await page.goto(`/?panels=${encodeURIComponent("service:plex")}&view=chat`);
    await expect(page.getByTestId("cave-thread")).toBeVisible({ timeout: 20_000 });
    // 11-16, the owner: "put all that header stuff in the hamburger", as the Claude app does.
    await page.getByTestId("chat-menu").click();
    const drawer = page.getByTestId("chat-menu-drawer");
    const list = drawer.getByTestId("conversation-new");
    await expect(list).toBeVisible();
    const width = await list.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(page.viewportSize()!.width * 0.6);
    await list.click();
    // New conversation offers the Thread Looks (11-17); No image starts a plain one.
    await drawer.getByTestId("look-none").click();
    await drawer.getByTestId("look-ok").click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId("cave-thread")).toBeVisible();
  });

  test("a long unbroken line in the chat wraps: the chat never scrolls sideways", async ({
    page,
  }) => {
    await page.goto(`/?panels=${encodeURIComponent("service:plex")}&view=chat`);
    const thread = page.getByTestId("cave-thread");
    await expect(thread).toBeVisible();
    // A plan card can carry a long list of ids with no spaces (a row's {"titles":[...]}).
    const fits = await thread.evaluate((ol) => {
      const li = document.createElement("li");
      li.textContent = `{"titles":[${Array(80).fill('"62001"').join(",")}]}`;
      ol.appendChild(li);
      const ok = ol.scrollWidth <= ol.clientWidth && getComputedStyle(ol).overflowX === "hidden";
      li.remove();
      return ok;
    });
    expect(fits).toBe(true);
  });
});

// 11-15, the owner: "it should be desktop period when on tablet regardless of landscape or
// portrait". A tablet is a touch screen at least 600px both ways.
/** The desktop Lair on a tablet: panels beside Ember, the bubbles, no ring, nothing cut off. */
async function expectDesktopLair(page: Page, width: number, name: string) {
  test.skip(test.info().project.name !== "mobile", "Runs once, in the mobile project.");
  await page.goto(`/?panels=${encodeURIComponent("service:plex,service:sonarr")}`);
  // A narrow tablet shows the latest panel beside Ember; the other waits in the strip.
  const panel = page.locator("[data-panel]").first();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("lair-systems")).toBeVisible();
  await expect(page.getByTestId("carousel")).toHaveCount(0);
  await expect(page.getByTestId("phone-panels-toggle")).toHaveCount(0);
  // The panel beside Ember fits on the screen.
  const right = await panel.evaluate((el) => el.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(width);
  await page.screenshot({ path: shots(name) });
}

test.describe("a tablet held upright", () => {
  test.use({ viewport: { width: 810, height: 1080 }, isMobile: true, hasTouch: true });
  test("a tablet held upright gets the desktop Lair", async ({ page }) => {
    await expectDesktopLair(page, 810, "tablet-upright");
  });
});

test.describe("a tablet held sideways", () => {
  test.use({ viewport: { width: 1080, height: 810 }, isMobile: true, hasTouch: true });
  test("a tablet held sideways gets the desktop Lair", async ({ page }) => {
    await expectDesktopLair(page, 1080, "tablet-sideways");
  });
});
