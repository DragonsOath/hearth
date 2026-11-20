import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { CAPABILITIES } from "../../packages/core/src/capabilities";

// Native panels Phase 1: one lifecycle for every panel. A panel covered by an expanded one makes
// no background requests and refreshes as soon as it is shown again; panels that do not fit on
// the desk stay unmounted (they wait as chips).

async function addApp(request: APIRequestContext, name: string, port: number, run: string) {
  const host = `10.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}.${30 + (port % 50)}`;
  const res = await request.post("/api/services", {
    data: {
      name: `${name} ${run}`,
      kind: "web",
      address: `http://${host}:${port}`,
      category: "Downloads",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  // qBittorrent signs in with a username and password; the others take an API key.
  const login =
    name === "qBittorrent" ||
    name === "RomM" ||
    name === "AdGuard Home" ||
    name === "Nginx Proxy Manager" ||
    name === "Uptime Kuma" ||
    name === "Transmission" ||
    name === "NZBGet" ||
    name === "Nextcloud" ||
    name === "wg-easy" ||
    name === "Navidrome" ||
    name === "Frigate";
  const saved = await request.post("/api/vault/secrets", {
    data: {
      name: `${name} ${run} ${login ? "login" : "key"}`,
      kind: login ? "login" : "api-key",
      tier: "automation",
      scope: "read",
      serviceId: id,
      ...(login ? { username: "hearth" } : {}),
      // Tailscale's token goes to its own API, not the service's address.
      ...(name === "Tailscale" ? { endpoint: "https://api.tailscale.com" } : {}),
      // Proxmox takes its own token form: user@realm!tokenid=secret.
      value:
        name === "Proxmox"
          ? "root@pam!e2e=panels"
          : name === "Tailscale"
            ? "tskey-api-e2e-panels"
            : `e2e-${port}-key`,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return id;
}

function countDashboardCalls(page: Page, id: string) {
  const hits: number[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === `/api/services/${encodeURIComponent(id)}/dashboard`)
      hits.push(Date.now());
  });
  return hits;
}

test.describe("panel lifecycle", () => {
  test.skip(({ isMobile }) => isMobile, "The desk (side-by-side panels) is desktop only.");

  test("a covered panel stops refreshing and refreshes again within 2 s of being shown", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const run = `${testInfo.project.name}${Date.now() % 100000}`;
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    const radarr = await addApp(page.request, "Radarr", 7878, run);
    const sonarr = await addApp(page.request, "Sonarr", 8989, run);
    const hits = countDashboardCalls(page, sonarr);

    await page.goto(
      `/?panels=${encodeURIComponent(`service:${radarr},service:${sonarr}`)}&focus=${encodeURIComponent(`service:${radarr}`)}`,
    );
    const panels = page.getByTestId("desk-panel");
    await expect(panels).toHaveCount(2);
    // Sonarr refreshes on its own while it is on screen.
    await expect.poll(() => hits.length, { timeout: 15_000 }).toBeGreaterThan(1);

    await page
      .locator(`[data-panel="service:${radarr}"]`)
      .getByRole("button", { name: "Expand panel" })
      .click();
    await expect(page.locator(`[data-panel="service:${radarr}"]`)).toHaveAttribute(
      "data-expanded",
      "true",
    );
    await page.waitForTimeout(1000);
    const coveredFrom = hits.length;
    // Longer than two of its refresh periods: a covered panel asks for nothing.
    await page.waitForTimeout(12_000);
    expect(hits.length - coveredFrom).toBe(0);

    const shownAt = Date.now();
    await page.getByRole("button", { name: "Restore panels" }).first().click();
    await expect
      .poll(() => hits.filter((t) => t >= shownAt).length, { timeout: 2_000 })
      .toBeGreaterThan(0);
  });

  test("panels that do not fit stay unmounted and make no requests", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const run = `${testInfo.project.name}${Date.now() % 100000}`;
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    const ids = [
      await addApp(page.request, "Radarr", 7878, run),
      await addApp(page.request, "Sonarr", 8989, run),
      await addApp(page.request, "SABnzbd", 8080, run),
    ];
    const sab = countDashboardCalls(page, ids[2]!);
    await page.goto(
      `/?panels=${encodeURIComponent(ids.map((id) => `service:${id}`).join(","))}&focus=${encodeURIComponent(`service:${ids[0]}`)}`,
    );
    const slots = Number(await page.locator("[data-slots]").first().getAttribute("data-slots"));
    expect(slots).toBeLessThan(3);
    await expect(page.getByTestId("desk-panel")).toHaveCount(slots);
    await expect(page.locator(`[data-panel="service:${ids[2]}"]`)).toHaveCount(0);
    await page.waitForTimeout(8_000);
    expect(sab.length).toBe(0);
  });
});

// D14: every capability the registry gives a panel control is reachable from its address (the
// panel, its tab and position) and the control is on screen. Same list Ember and Show & Tell use.

test.describe("capability targets", () => {
  test.skip(({ isMobile }) => isMobile, "Checked on the desk; phones show the same panel alone.");

  test("every panel capability opens at its tab and shows its control", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const res = await page.request.post("/api/demo/scenario", {
      data: { scenario: "calm", replaceYourSystems: true },
    });
    expect(res.status()).toBe(204);
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    const run = `${testInfo.project.name}${Date.now() % 100000}`;
    const ids: Record<string, string> = {
      radarr: "radarr",
      sonarr: "sonarr",
      prowlarr: await addApp(page.request, "Prowlarr", 9696, run),
      wizarr: await addApp(page.request, "Wizarr", 5690, run),
      lidarr: await addApp(page.request, "Lidarr", 8686, run),
      tautulli: await addApp(page.request, "Tautulli", 8181, run),
      plex: await addApp(page.request, "Plex:", 32400, run),
      jellyfin: await addApp(page.request, "Jellyfin", 8096, run),
      qbittorrent: await addApp(page.request, "qBittorrent", 8090, run),
      sabnzbd: await addApp(page.request, "SABnzbd", 8080, run),
      romm: await addApp(page.request, "RomM", 8095, run),
      pihole: await addApp(page.request, "Pi-hole", 8053, run),
      adguard: await addApp(page.request, "AdGuard Home", 3000, run),
      proxmox: await addApp(page.request, "Proxmox", 8006, run),
      npm: await addApp(page.request, "Nginx Proxy Manager", 81, run),
      traefik: await addApp(page.request, "Traefik", 8082, run),
      portainer: await addApp(page.request, "Portainer", 9000, run),
      uptimekuma: await addApp(page.request, "Uptime Kuma", 3001, run),
      transmission: await addApp(page.request, "Transmission", 9091, run),
      nzbget: await addApp(page.request, "NZBGet", 6789, run),
      nextcloud: await addApp(page.request, "Nextcloud", 11000, run),
      paperless: await addApp(page.request, "Paperless-ngx", 8000, run),
      vaultwarden: await addApp(page.request, "Vaultwarden", 8222, run),
      tailscale: await addApp(page.request, "Tailscale", 41641, run),
      wgeasy: await addApp(page.request, "wg-easy", 51821, run),
      navidrome: await addApp(page.request, "Navidrome", 4533, run),
      komga: await addApp(page.request, "Komga", 25600, run),
      gitea: await addApp(page.request, "Gitea", 3030, run),
      mealie: await addApp(page.request, "Mealie", 9925, run),
      actual: await addApp(page.request, "Actual Budget", 5006, run),
      authentik: await addApp(page.request, "Authentik", 9010, run),
      frigate: await addApp(page.request, "Frigate", 8971, run),
      authelia: await addApp(page.request, "Authelia", 9092, run),
      emby: await addApp(page.request, "Emby", 8096, run),
    };
    // Some controls appear only for a particular item: these steps bring one on screen.
    const reach: Record<
      string,
      (panel: ReturnType<Page["locator"]>, app: string) => Promise<void>
    > = {
      // Radarr's bulk bar appears once a movie is selected.
      "library:bulk:unmonitor": async (panel) => {
        await panel
          .getByRole("checkbox", { name: /^Select / })
          .first()
          .check();
      },
      // qBittorrent's Review button appears once a setting is edited.
      "settings:review": async (panel, app) => {
        if (app === "qbittorrent")
          await panel.locator('[data-hearth-target="setting:dl_limit"]').fill("5000");
      },
      // Prowlarr's search results appear after a search.
      "search:grab:stand-in-1": async (panel) => {
        await panel.locator('[data-hearth-target="search:query"]').fill("lantern season");
        await panel.locator('[data-hearth-target="search:go"]').click();
      },
      "release:grab": async (panel, app) => {
        await panel.getByTestId("isearch-input").fill(app === "sonarr" ? "ghosts" : "heat");
        await panel.getByRole("button", { name: "Find" }).click();
        await panel.getByTestId("isearch-title").first().click();
        // Sonarr goes from a series to a season and an episode first.
        if (app === "sonarr") {
          const season = panel.getByTestId("isearch-season").first();
          await expect(season).toBeVisible({ timeout: 15_000 });
          await season.locator("summary").click();
          await panel.getByTestId("isearch-episode").first().click();
        }
      },
    };
    const checked: string[] = [];
    for (const cap of CAPABILITIES.filter((c) => c.panel && ids[c.app])) {
      const key = `service:${ids[cap.app]}`;
      await page.goto(
        `/?panels=${encodeURIComponent(`${key}@${cap.panel!.tab}`)}&focus=${encodeURIComponent(key)}`,
      );
      const panel = page.locator(`[data-panel="${key}"]`);
      await expect(panel, cap.id).toBeVisible({ timeout: 20_000 });
      await reach[cap.panel!.target]?.(panel, cap.app);
      const target = panel.locator(`[data-hearth-target="${cap.panel!.target}"]`).first();
      await expect(target, `${cap.id}: ${cap.panel!.target}`).toBeVisible({ timeout: 20_000 });
      checked.push(cap.id);
    }
    expect(checked.length).toBe(CAPABILITIES.filter((c) => c.panel && ids[c.app]).length);
  });
});

// Size classes (refinement C): navigation follows the panel's own room. Old links keep working.
test.describe("panel sizes and old links", () => {
  test.skip(({ isMobile }) => isMobile, "Phone width is checked below on the desktop project.");

  async function radarr(page: Page) {
    const res = await page.request.post("/api/demo/scenario", {
      data: { scenario: "calm", replaceYourSystems: true },
    });
    expect(res.status()).toBe(204);
  }
  const tablist = (page: Page, key = "service:radarr") =>
    page.locator(`[data-panel="${key}"] [role="tablist"]`).first();

  const HEARTH_TOOLS = ["Health", "Logs", "Terminal", "Files", "Settings", "Notes", "History"];

  for (const app of ["radarr", "sonarr"]) {
    test(`1600 px ${app}: the app's tabs, then one Hearth menu with every Hearth tool`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await radarr(page);
      await page.goto(`/?panels=${encodeURIComponent(`service:${app}`)}`);
      const panel = page.locator(`[data-panel="service:${app}"]`);
      const tabs = tablist(page, `service:${app}`);
      await expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
      await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(tabs.getByRole("tab", { name: "Diagnostics" })).toBeVisible();
      // The row is the app's: Hearth's tools are not tabs in it (Radarr has its own Settings tab,
      // a different tab from Hearth's Settings, so the check uses each tool's stable target).
      for (const tool of HEARTH_TOOLS)
        await expect(tabs.locator(`[data-hearth-target="tab:${tool.toLowerCase()}"]`)).toHaveCount(
          0,
        );
      const hearth = panel.getByRole("button", { name: "Hearth", exact: true });
      await expect(hearth).toHaveAttribute("aria-haspopup", "menu");
      await expect(hearth).toHaveAttribute("aria-expanded", "false");
      await hearth.click();
      const menu = panel.getByRole("menu", { name: "Hearth tools" });
      const items = menu.getByRole("menuitemradio");
      await expect(items).toHaveCount(HEARTH_TOOLS.length);
      for (const [i, tool] of HEARTH_TOOLS.entries())
        await expect(items.nth(i)).toHaveAccessibleName(tool);
      // Each says in a few words what it is for.
      await expect(items.first()).toHaveAccessibleDescription(/checks/i);
      // Every tool keeps its stable target, and the button says which targets it reveals.
      for (const tool of HEARTH_TOOLS)
        await expect(
          menu.locator(`[data-hearth-target="tab:${tool.toLowerCase()}"]`),
        ).toBeVisible();
      await expect(panel.locator('[data-hearth-target="menu:hearth"]')).toHaveAttribute(
        "data-hearth-opens",
        HEARTH_TOOLS.map((t) => `tab:${t.toLowerCase()}`).join(" "),
      );
      await menu.getByRole("menuitemradio", { name: "Logs" }).click();
      // The open tool shows on the button, underlined like a tab, and in the address.
      const open = panel.getByRole("button", { name: "Hearth: Logs" });
      await expect(open).toBeVisible();
      await expect(open).toHaveAttribute("aria-expanded", "false");
      await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute(
        "aria-selected",
        "false",
      );
      await expect
        .poll(() => new URL(page.url()).searchParams.get("panels"))
        .toBe(`service:${app}@logs`);
      // A click elsewhere closes the menu without choosing.
      await open.click();
      await expect(menu).toBeVisible();
      await panel.locator('[data-hearth-target="panel:title"]').click();
      await expect(menu).toBeHidden();
      await expect(panel.getByRole("button", { name: "Hearth: Logs" })).toBeVisible();
    });
  }

  test("an expanded panel keeps the tab row and the Hearth menu, and returns as it was", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await radarr(page);
    await page.goto(`/?panels=${encodeURIComponent("service:radarr,service:sonarr")}`);
    const panel = page.locator('[data-panel="service:radarr"]');
    await panel.getByRole("button", { name: "Expand panel" }).click();
    await expect(tablist(page)).toHaveAttribute("data-size", "expanded");
    await panel.locator('[data-hearth-target="menu:hearth"]').click();
    await panel.getByRole("menuitemradio", { name: "Notes" }).click();
    await expect(panel.getByRole("button", { name: "Hearth: Notes" })).toBeVisible();
    await panel.getByRole("button", { name: /^Restore/ }).click();
    await expect(tablist(page)).not.toHaveAttribute("data-size", "expanded");
    await expect(panel.getByRole("button", { name: "Hearth: Notes" })).toBeVisible();
    // Switching back to the app's own tab clears the Hearth button.
    await tablist(page).getByRole("tab", { name: "Diagnostics" }).click();
    await expect(panel.getByRole("button", { name: "Hearth", exact: true })).toBeVisible();
  });

  test("with reduced motion the Hearth menu appears without animating", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await radarr(page);
    await page.goto(`/?panels=${encodeURIComponent("service:radarr")}`);
    const panel = page.locator('[data-panel="service:radarr"]');
    await panel.locator('[data-hearth-target="menu:hearth"]').click();
    const menu = panel.getByRole("menu", { name: "Hearth tools" });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  });

  test("the Hearth menu works from the keyboard", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await radarr(page);
    await page.goto(`/?panels=${encodeURIComponent("service:radarr")}`);
    const panel = page.locator('[data-panel="service:radarr"]');
    const hearth = panel.locator('[data-hearth-target="menu:hearth"]');
    await hearth.focus();
    await page.keyboard.press("ArrowDown");
    const menu = panel.getByRole("menu", { name: "Hearth tools" });
    await expect(menu.getByRole("menuitemradio", { name: "Health" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: "Logs" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitemradio", { name: "History" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(hearth).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(hearth).toHaveAccessibleName("Hearth: History");
    await expect(hearth).toBeFocused();
    // Opening again starts on the open tool.
    await page.keyboard.press("Enter");
    await expect(menu.getByRole("menuitemradio", { name: "History" })).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { name: "History" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("2560 px: a wide panel gets side navigation", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1300 });
    await radarr(page);
    await page.goto(`/?panels=${encodeURIComponent("service:radarr")}`);
    const tabs = tablist(page);
    await expect(tabs).toHaveAttribute("data-size", "maximized");
    await expect(tabs).toHaveAttribute("aria-orientation", "vertical");
    // Hearth is a group in the side menu that folds open and shut.
    const panel = page.locator('[data-panel="service:radarr"]');
    const hearth = panel.locator('[data-hearth-target="menu:hearth"]');
    await expect(hearth).toHaveAttribute("aria-expanded", "false");
    await hearth.click();
    const tools = panel.getByRole("tablist", { name: "Hearth tools" });
    await tools.getByRole("tab", { name: "History" }).click();
    await expect(tools.getByRole("tab", { name: "History" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Folded, it still says which tool is open.
    await hearth.click();
    await expect(tools).toBeHidden();
    await expect(hearth).toHaveText(/Hearth: History/);
  });

  test("a narrow desk column gets a sections menu, not a squeezed tab row", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await radarr(page);
    await page.goto(`/?panels=${encodeURIComponent("service:radarr,service:sonarr")}`);
    await expect(page.getByTestId("desk-panel")).toHaveCount(2);
    // Narrow Radarr with the resize handle, from the keyboard, as someone making room would.
    const handle = page.getByRole("separator", { name: "Resize panels" }).first();
    await handle.focus();
    const panel = page.locator('[data-panel="service:radarr"]');
    for (let i = 0; i < 40 && (await panel.boundingBox())!.width >= 340; i++)
      await handle.press("ArrowLeft");
    const menu = panel.locator('[data-hearth-target="sections"]');
    await expect(menu).toBeVisible();
    await expect(tablist(page)).toBeHidden();
    await menu.click();
    await expect(tablist(page).getByRole("tab", { name: "Overview" })).toBeVisible();
    await panel.locator('[data-hearth-target="menu:hearth"]').click();
    await panel
      .getByRole("tablist", { name: "Hearth tools" })
      .getByRole("tab", { name: "Logs" })
      .click();
    await expect(menu).toContainText("Hearth: Logs");
    await expect(panel.getByTestId("service-logs")).toBeVisible();
  });

  test("phone width: the panel alone with a scrolling tab row", async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await radarr(page);
    await page.goto("/?service=radarr");
    const tabs = page.locator('[data-testid="service-workspace"] [role="tablist"]').first();
    await expect(tabs).toHaveAttribute("data-size", "mobile");
    await expect(tabs).toHaveAttribute("aria-orientation", "horizontal");
    // The Hearth menu is a tap away and its list stays on screen.
    const ws = page.getByTestId("service-workspace");
    await ws.getByRole("button", { name: "Hearth", exact: true }).click();
    const item = ws.getByRole("menuitemradio", { name: "Notes" });
    await expect(item).toBeInViewport();
    const box = (await ws.getByRole("menu", { name: "Hearth tools" }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(412);
    await item.click();
    await expect(ws.getByRole("button", { name: "Hearth: Notes" })).toBeVisible();
  });

  test("old links and saved tabs open where they did, and a position inside a tab works", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await radarr(page);
    await page.goto(`/?panels=${encodeURIComponent("service:radarr@logs")}`);
    const radarrPanel = page.locator('[data-panel="service:radarr"]');
    await expect(radarrPanel.getByRole("button", { name: "Hearth: Logs" })).toBeVisible();
    await expect(radarrPanel.getByTestId("service-logs")).toBeVisible();
    // Radarr's missing list moved to its own Wanted tab: the old address opens it there.
    await page.goto(`/?panels=${encodeURIComponent("service:radarr@overview/missing")}`);
    const missing = page.locator(
      '[data-panel="service:radarr"] [data-hearth-target="wanted:missing"]',
    );
    await expect(missing).toHaveAttribute("aria-selected", "true");
    await page.goto(`/?panels=${encodeURIComponent("service:radarr@overview/upgrades")}`);
    // Choosing another section updates the address, so a refresh comes back to it.
    await page
      .locator('[data-panel="service:radarr"] [data-hearth-target="view:upgrades"]')
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("panels"))
      .toBe("service:radarr@overview%2Fupgrades");
    await page.reload();
    await expect(
      page.locator('[data-panel="service:radarr"] [data-hearth-target="view:upgrades"]'),
    ).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("panel header", () => {
  test.skip(({ isMobile }) => isMobile, "Two panels side by side is a desk layout.");

  test("two panels at 1440 px: the name stays readable and every button stays on screen", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const res = await page.request.post("/api/demo/scenario", {
      data: { scenario: "calm", replaceYourSystems: true },
    });
    expect(res.status()).toBe(204);
    await page.goto(`/?panels=${encodeURIComponent("service:plex,service:jellyfin")}`);
    for (const key of ["service:plex", "service:jellyfin"]) {
      const panel = page.locator(`[data-panel="${key}"]`);
      const title = panel.locator('[data-hearth-target="panel:title"] h2');
      await expect(title).toBeVisible();
      expect((await title.boundingBox())!.width).toBeGreaterThan(100);
      // The state pill reads on one line, not one letter per line.
      const pill = panel.getByTestId("service-state");
      expect((await pill.boundingBox())!.height).toBeLessThan(40);
      for (const name of ["Pin panel", "Expand panel"])
        await expect(panel.getByRole("button", { name })).toBeVisible();
      await expect(panel.getByRole("button", { name: /^Close / })).toBeVisible();
    }
    await page.screenshot({ path: "test-results/screens/panel-header-1440.png" });
  });
});

// 11-16, the owner: "Three panels plus the chat panel ... should be its standard format", never
// smaller; more wait in the queue, and an arrow at the top right slides the panels. The chat
// never moves.
test.describe("the Lair slides its panels", () => {
  test.skip(({ isMobile }) => isMobile, "Phones show one panel at a time.");

  test("three panels beside the chat; the rest queue, and the arrows slide them", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    const tools = ["todo", "curator", "storage", "home-rows", "movie-nights"];
    const at = (id: string) => page.locator(`[data-panel="tool:${id}"]`);
    await page.goto(
      `/?panels=${encodeURIComponent(
        tools
          .slice(0, 4)
          .map((t) => `tool:${t}`)
          .join(","),
      )}&focus=${encodeURIComponent("tool:todo")}`,
    );
    const panels = page.getByTestId("desk-panel");
    await expect(panels).toHaveCount(3);
    const slide = page.getByTestId("panel-slide");
    await expect(slide).toContainText("1-3 of 4");
    await expect(at("home-rows")).toHaveCount(0);
    // None squeezed below a useful width.
    for (const box of await panels.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    ))
      expect(box).toBeGreaterThanOrEqual(330);
    const chat = await page.getByRole("region", { name: "Ember" }).boundingBox();

    // A new panel joins the queue instead of pushing one out.
    await page.getByTestId("lair-movie-nights").click();
    await expect(panels).toHaveCount(3);
    await expect(page.getByTestId("panel-slide-on")).toContainText("2");

    await page.getByTestId("panel-slide-on").click();
    await expect(at("home-rows")).toHaveCount(1);
    await expect(at("todo")).toHaveCount(0);
    await expect(slide).toContainText("2-4 of 5");
    await page.getByTestId("panel-slide-on").click();
    await expect(at("movie-nights")).toHaveCount(1);
    await expect(page.getByTestId("panel-slide-on")).toBeDisabled();
    // Three on screen share the room equally.
    const widths = await panels.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    // (the 16px gutter between two panels belongs to the one after it)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(17);
    // Ember's chat stays where it was.
    expect(await page.getByRole("region", { name: "Ember" }).boundingBox()).toEqual(chat);
    await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/lair-slide.png` });
    await page.getByTestId("panel-slide-back").click();
    await page.getByTestId("panel-slide-back").click();
    await expect(at("todo")).toHaveCount(1);
    await expect(page.getByTestId("panel-slide-back")).toBeDisabled();

    // Closing panels: the ones left grow, still equal.
    const narrow = await panels.first().evaluate((el) => el.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Close unpinned" }).click();
    await page.goto(
      `/?panels=${encodeURIComponent("tool:todo,tool:curator")}&focus=${encodeURIComponent("tool:todo")}`,
    );
    await expect(panels).toHaveCount(2);
    const two = await panels.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    expect(Math.abs(two[0]! - two[1]!)).toBeLessThanOrEqual(17);
    expect(two[0]!).toBeGreaterThan(narrow * 1.3);
  });
});
