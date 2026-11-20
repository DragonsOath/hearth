import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Service panel looks (components/panels/brands.tsx): Minimal (the default), Service branding
// (Prowlarr's own colors and artwork with Hearth's controls), and Hearth branding. Decoration
// only: the panel's controls and layout are the same in every look.

const shots = (name: string, project: string) => `test-results/screens/${project}/${name}.png`;

async function setLook(page: Page, look: "minimal" | "service" | "hearth") {
  const res = await page.request.patch("/api/settings", {
    data: { theme: { preset: "hearth", panels: look } },
  });
  expect(res.ok(), await res.text()).toBe(true);
}

/** Serious or critical contrast problems inside the panel. */
async function contrastIssues(page: Page, selector: string) {
  const axe = await new AxeBuilder({ page })
    .include(selector)
    .withRules(["color-contrast"])
    .analyze();
  return axe.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.map((n) => n.target.join(" ")));
}

const serviceLayer = (page: Page) =>
  page.locator('[data-layer="service"][data-panel-brand="prowlarr"]');
const hearthLayer = (page: Page) => page.locator('[data-brand="prowlarr"] [data-layer="hearth"]');

test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  expect(res.status()).toBe(204);
});

test.afterEach(async ({ page }) => {
  await setLook(page, "minimal");
});

test("service panel looks: each service in its own colors, Hearth's, or plain; kept after a reload", async ({
  page,
  isMobile,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  const project = testInfo.project.name;
  const open = (id: string) =>
    isMobile ? `/?service=${id}` : `/?panels=${encodeURIComponent(`service:${id}`)}`;
  const panel = page.locator('[data-brand="prowlarr"]');

  // The default is Minimal: nothing decorated.
  await page.goto(open("prowlarr"));
  await expect(panel).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-panels", "minimal");
  await expect(serviceLayer(page)).toBeHidden();
  await expect(hearthLayer(page)).toBeHidden();
  const minimalIssues = await contrastIssues(page, '[data-brand="prowlarr"]');

  // Chosen in Settings, Themes: Service branding.
  await page.goto("/settings");
  const looks = page.getByRole("radiogroup", { name: "Service panels" });
  await expect(looks.getByRole("radio", { name: /Minimal/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await looks.getByRole("radio", { name: /Service branding/ }).click();
  await expect(page.locator("html")).toHaveAttribute("data-panels", "service");
  // Saved shortly after the choice, then kept after a reload.
  await expect
    .poll(async () => (await (await page.request.get("/api/workspace")).json()).theme?.panels)
    .toBe("service");
  await page.reload();
  await expect(
    page.getByRole("radiogroup", { name: "Service panels" }).getByRole("radio", {
      name: /Service branding/,
    }),
  ).toHaveAttribute("aria-checked", "true");

  await page.goto(open("prowlarr"));
  await expect(serviceLayer(page)).toBeVisible();
  await expect(hearthLayer(page)).toBeHidden();
  // Decoration never takes a click or a screen reader's attention.
  const deco = panel.locator('[aria-hidden="true"]').first();
  await expect(deco).toHaveCSS("pointer-events", "none");
  // Prowlarr's controls and tabs are all still there and work.
  if (!isMobile) {
    await expect(panel.getByRole("tab", { name: "Overview" })).toBeVisible();
    await panel.getByRole("tab", { name: "Overview" }).click();
  }
  expect(await contrastIssues(page, '[data-brand="prowlarr"]')).toEqual(minimalIssues);
  await page.screenshot({ path: shots("prowlarr-service", project) });

  // Painted frames from the owner's artwork: Hearth's lava frame around each service's header.
  for (const [id, name] of [
    ["sonarr", "sonarr"],
    ["radarr", "radarr"],
    ["qbittorrent", "qbittorrent"],
    ["overseerr", "overseerr"],
  ] as const) {
    await page.goto(open(id));
    const framed = page.locator(`[data-brand="${name}"]`);
    await expect(framed).toHaveAttribute("data-painted", "true");
    await expect(framed.locator('[data-frame="painted"]')).toBeVisible();
    // The system's own logo, in the corner, opens its web page (reverse proxy or local address)
    // and is never covered by the artwork.
    const logo = framed.locator("header").getByTestId("service-logo-link");
    await expect(logo).toHaveAttribute("href", /^https?:\/\//);
    await expect(logo).toHaveAttribute("target", "_blank");
    const box = (await logo.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x!, y!)?.closest('[data-testid="service-logo-link"]') !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(hit, "the logo takes the click, not the artwork").toBe(true);
    // Let the panel finish sliding in before the picture.
    await page.waitForTimeout(800);
    await page.screenshot({ path: shots(`${id}-service`, project) });
  }

  // Ember's own panel: its painted lava frame beside the services, the conversation in front.
  if (!isMobile) {
    await page.goto(open("sonarr"));
    const ember = page.getByRole("region", { name: "Ember" }).first();
    await expect(ember.locator('[data-frame="ember"]')).toBeVisible();
    await expect(ember.locator('[data-frame="ember"]')).toHaveCSS("pointer-events", "none");
    await page.waitForTimeout(800);
    await page.screenshot({ path: shots("ember-and-sonarr-service", project) });
  }

  // Every other service gets the automatic look: Hearth's frame lit in its own color, its own
  // logo large and faint in the header. Plex: gold, Bazarr: its own color, Prowlarr: orange.
  for (const id of ["plex", "bazarr", "prowlarr"]) {
    await page.goto(open(id));
    const auto = page.locator(`[data-brand="${id}"] [data-layer="service"][data-frame="auto"]`);
    await expect(auto).toBeVisible();
    await expect(auto.locator(`img[src="/logos/${id}.svg"]`)).toHaveCount(1);
    await page.waitForTimeout(800);
    await page.screenshot({ path: shots(`${id}-service-auto`, project) });
  }

  if (!isMobile) {
    // A narrow desk panel: three side by side.
    await page.goto(
      `/?panels=${encodeURIComponent("service:prowlarr,service:sonarr,service:radarr")}&focus=${encodeURIComponent("service:prowlarr")}`,
    );
    await expect(serviceLayer(page)).toBeVisible();
    const box = await panel.boundingBox();
    expect(box!.width).toBeLessThan(700);
    await page.screenshot({ path: shots("prowlarr-service-narrow", project) });
  }

  // Loading, then error: both stay readable in front of the artwork.
  await page.route("**/api/services/prowlarr/dashboard*", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => undefined);
  });
  await page.goto(open("prowlarr"));
  await expect(serviceLayer(page)).toBeVisible();
  await page.screenshot({ path: shots("prowlarr-service-loading", project) });
  await page.unroute("**/api/services/prowlarr/dashboard*");
  await page.route("**/api/services/prowlarr/dashboard*", (route) =>
    route.fulfill({ status: 500, body: '{"message":"Prowlarr did not answer."}' }),
  );
  await page.goto(open("prowlarr"));
  await expect(serviceLayer(page)).toBeVisible();
  // The panel tries a few times before it shows the error.
  await expect(panel).toContainText("Prowlarr did not answer", { timeout: 25_000 });
  expect(await contrastIssues(page, '[data-brand="prowlarr"]')).toEqual([]);
  await page.screenshot({ path: shots("prowlarr-service-error", project) });
  await page.unroute("**/api/services/prowlarr/dashboard*");

  // Hearth branding: Hearth's ember look instead of Prowlarr's, on every service panel.
  await setLook(page, "hearth");
  await page.goto(open("prowlarr"));
  await expect(hearthLayer(page)).toBeVisible();
  await expect(serviceLayer(page)).toBeHidden();
  await page.screenshot({ path: shots("prowlarr-hearth", project) });
  await page.goto(open("plex"));
  await expect(page.locator('[data-brand="plex"] [data-layer="hearth"]')).toBeVisible();
  await expect(page.locator('[data-brand="plex"] [data-layer="service"]')).toBeHidden();

  // Minimal again: plain.
  await setLook(page, "minimal");
  await page.goto(open("prowlarr"));
  await expect(serviceLayer(page)).toBeHidden();
  await expect(hearthLayer(page)).toBeHidden();
  for (const f of await page.locator('[data-frame="ember"]').all()) await expect(f).toBeHidden();
  await page.screenshot({ path: shots("prowlarr-minimal", project) });

  expect(errors).toEqual([]);
});

test("Hearth's own panels (Storage & Files) wear Hearth's frame with branding on, plain with Minimal", async ({
  page,
}) => {
  const storage = page.locator('[data-brand="storage & files"]');
  const layer = storage.locator('[data-layer="service"]');
  await page.goto(`/?panels=${encodeURIComponent("tool:storage")}`);
  await expect(storage).toBeVisible();
  await expect(layer).toBeHidden();

  await setLook(page, "service");
  await page.reload();
  await expect(storage).toHaveAttribute("data-painted", "true");
  await expect(layer).toBeVisible();
  await expect(storage.locator('[aria-hidden="true"]').first()).toHaveCSS("pointer-events", "none");
  // Its own controls still work through the decoration.
  await storage.getByRole("tab", { name: /Drives/ }).click();
  await expect(storage.getByRole("tab", { name: /Drives/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await setLook(page, "hearth");
  await page.reload();
  await expect(storage.locator('[data-layer="hearth"]')).toBeVisible();
});
