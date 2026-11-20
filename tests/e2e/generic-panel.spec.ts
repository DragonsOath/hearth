import { expect, test, type Page } from "@playwright/test";

// The generic panel for an app Hearth has no panel of its own for, with a made-up app ("Gizmo"):
// its status, Open web UI, its recent log lines on request, Ask Ember (with the app's address, so
// Ember can reach its own API), and Request a full panel, prefilled for this app. An app that has
// its own panel never shows it.

let hosts = (Date.now() + 43_000) % 60_000;
const uniqueHost = () => {
  hosts += 1;
  return `10.${1 + ((hosts >> 8) % 250)}.${1 + (hosts % 250)}.92`;
};

async function open(page: Page, id: string) {
  await page.goto(`/?panels=${encodeURIComponent(`service:${id}@overview`)}`);
  const panel =
    test.info().project.name === "mobile"
      ? page.getByTestId("service-workspace")
      : page.locator(`[data-panel="service:${id}"]`);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  return panel;
}

/**
 * A basic panel shows the app itself first (11-14); Hearth's own basic panel is Hearth view, one
 * tap away. Apps with no page (databases, the VPN) have no such switch.
 */
async function hearthView(panel: ReturnType<Page["locator"]>) {
  await panel.getByTestId("app-view").getByRole("tab", { name: "Hearth view" }).click();
}

test.describe("the generic panel", () => {
  test("a made-up app gets status, logs, Ask Ember and Request a full panel", async ({
    page,
    request,
  }, info) => {
    const name = `Gizmo ${info.project.name}${Date.now() % 100000}`;
    const res = await request.post("/api/services", {
      data: { name, kind: "web", address: `http://${uniqueHost()}:7777`, category: "Automation" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const id = ((await res.json()) as { id: string }).id;

    const panel = await open(page, id);
    // The stand-in app allows being shown inside another page: its own page comes first. On a
    // phone the Open button comes first (a whole app squeezed into a panel is too cramped).
    if (info.project.name === "mobile") {
      await expect(panel.getByTestId("app-view-open-button")).toBeVisible({ timeout: 20_000 });
      await panel.getByRole("button", { name: "Show it here anyway" }).click();
    }
    await expect(panel.getByTestId("app-view-frame")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("app-view-frame")).toHaveAttribute("allow", "");
    await hearthView(panel);
    const generic = panel.getByTestId("generic-panel");
    await expect(generic).toBeVisible({ timeout: 20_000 });
    await expect(generic.getByTestId("generic-status")).toBeVisible();
    await expect(generic.getByTestId("generic-open")).toHaveAttribute("href", /:7777/);
    const requestLink = generic.getByTestId("generic-request");
    await expect(requestLink).toHaveAttribute("href", /discussions\/new\?category=panel-requests/);
    await expect(requestLink).toHaveAttribute("href", /title=Panel%3A\+Gizmo/);
    // How requests work (11-10): the plain line, and where the process is explained.
    await expect(generic).toContainText("This is a basic panel. Want a full one for Gizmo");
    await expect(generic.getByTestId("generic-how-requests")).toHaveAttribute(
      "href",
      /docs\/HOW_REQUESTS_WORK\.md$/,
    );
    // The basic panel is not a hand-built one: no Request a feature.
    await expect(panel.getByTestId("panel-request-feature")).toHaveCount(0);

    // Logs come from a container: a web app without one has no log button.
    await expect(generic.getByTestId("generic-logs-toggle")).toHaveCount(0);
    await page.screenshot({
      path: `test-results/screens/${info.project.name === "mobile" ? "mobile" : "desktop"}/generic-panel.png`,
    });

    await generic.getByTestId("generic-question").fill("How many jobs has it run today?");
    await generic.getByRole("button", { name: "Ask", exact: true }).click();
    // On a phone the conversation sits beside the panel: open it.
    if (info.project.name === "mobile")
      await page.getByRole("button", { name: "Show Ember" }).click();
    await expect(
      page.getByText(/About Gizmo .* How many jobs has it run today\?/).first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("an app with its own panel does not show the generic one", async ({ page, request }) => {
    await request.post("/api/test/fake-apps", { data: { reset: true } });
    const res = await request.post("/api/services", {
      data: {
        name: `Traefik ${Date.now() % 100000}`,
        kind: "web",
        address: `http://${uniqueHost()}:8082`,
        category: "System",
      },
    });
    const id = ((await res.json()) as { id: string }).id;
    const panel = await open(page, id);
    await expect(panel.getByTestId("tr-dashboard")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("generic-panel")).toHaveCount(0);
    // Panel Builder: a first-party panel never offers Improve this panel.
    await expect(panel.getByTestId("improve-panel")).toHaveCount(0);
  });

  // Building a panel with Ember is Premium (Panel Builder, in the Premium package, with its own
  // tests); Free keeps Request it, and Custom panels says what Premium adds.
  test("a basic panel offers Improve: Request it, and Custom panels from Premium", async ({
    page,
    request,
  }, info) => {
    const name = `Gizmo ${info.project.name}${Date.now() % 100000}`;
    const res = await request.post("/api/services", {
      data: { name, kind: "web", address: `http://${uniqueHost()}:7777`, category: "Automation" },
    });
    const id = ((await res.json()) as { id: string }).id;
    const panel = await open(page, id);
    await hearthView(panel);
    await expect(panel.getByTestId("generic-panel")).toBeVisible({ timeout: 20_000 });

    // One compact menu in the header, opened from the keyboard.
    const button = panel.getByTestId("improve-panel");
    await button.focus();
    await page.keyboard.press("Enter");
    const menu = panel.getByTestId("improve-panel-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem")).toHaveCount(2);
    await expect(menu.getByTestId("improve-panel-request")).toHaveAttribute(
      "href",
      /discussions\/new\?category=panel-requests.*title=Panel%3A\+Gizmo/,
    );
    await expect(menu.getByTestId("improve-panel-custom")).toContainText("Hearth Premium");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();
    // The basic panel's own line opens the same menu (11-10: the icon alone was missed).
    await panel.getByTestId("generic-improve").click();
    await expect(menu).toBeVisible();
    await page.screenshot({
      path: `test-results/screens/${info.project.name === "mobile" ? "mobile" : "desktop"}/improve-panel.png`,
    });
    await page.keyboard.press("Escape");
  });

  test("infrastructure is watch-only: no Improve this panel", async ({ page, request }) => {
    const res = await request.post("/api/services", {
      data: {
        name: `Postgres ${Date.now() % 100000}`,
        kind: "web",
        address: `http://${uniqueHost()}:5432`,
        category: "System",
      },
    });
    const id = ((await res.json()) as { id: string }).id;
    const panel = await open(page, id);
    await expect(panel.getByTestId("integration-gap")).toBeVisible({ timeout: 20_000 });
    // A database has no page to show: no app view.
    await expect(panel.getByTestId("app-view")).toHaveCount(0);
    await expect(panel.getByTestId("improve-panel")).toHaveCount(0);
  });
});

// 11-14, the owner via Flint: a basic panel shows the app itself. The app's own headers decide
// whether it may be shown inside Hearth; the stand-in Tasterr (port 8220) refuses, as the real one
// does, so it gets the big Open button, with Hearth's own view and the container a tap away.
test("an app that refuses to be shown inside Hearth gets a big Open button", async ({
  page,
  request,
}, info) => {
  const name = `Taste View ${info.project.name}${Date.now() % 100000}`;
  const res = await request.post("/api/services", {
    data: { name, kind: "web", address: `${uniqueHost()}:8220`, category: "Media" },
  });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  try {
    const panel = await open(page, id);
    const view = panel.getByTestId("app-view");
    await expect(view.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    await expect(view.getByTestId("app-view-open-button")).toBeVisible({ timeout: 20_000 });
    await expect(view.getByTestId("app-view-open-button")).toHaveAttribute("target", "_blank");
    await expect(view.getByTestId("app-view-why")).toContainText("can't be shown inside Hearth");
    await expect(view.getByTestId("app-view-frame")).toHaveCount(0);
    // The container's details, behind Details.
    await view.getByTestId("app-view-details").click();
    await expect(view.getByTestId("app-view-details-body")).toContainText("Container");
    // Hearth's own view, one tap away, and remembered.
    await view.getByRole("tab", { name: "Hearth view" }).click();
    await expect(view.getByTestId("app-view-open")).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByTestId("app-view").getByRole("tab", { name: "Hearth view" }),
    ).toHaveAttribute("aria-selected", "true", { timeout: 20_000 });
  } finally {
    await request.post(`/api/services/${id}/remove`, { data: {} });
  }
});
