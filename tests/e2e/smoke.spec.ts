import { openHearthTool } from "./hearth-tools";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The owner password claim.setup.ts sets (importing it would register its setup again).
const OWNER_PASSWORD = "e2e owner password";

// Tests share one server and database, so they run serially (see
// playwright.config.ts) and each one starts from a known demo scenario.
async function useScenario(request: APIRequestContext, scenario: "calm" | "attention" | "fresh") {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario, replaceYourSystems: true },
  });
  expect(res.status(), "reset demo scenario").toBe(204);
}

/** On a phone, shows an open panel by name from the ring's list (PanelCarousel). */
async function showOnPhone(page: Page, name: string) {
  await page.getByTestId("carousel-current").click();
  await page
    .getByTestId("carousel-list")
    .getByRole("button", { name: new RegExp(name) })
    .click();
}

// Home fits one screen: what needs you opens from its alert band, the longer read from Briefing.
async function openAlerts(page: Page) {
  await page.getByTestId("view-all-alerts").click();
}
async function openBriefing(page: Page) {
  await page
    .getByTestId("band-briefing")
    .or(page.getByTestId("open-briefing"))
    .locator("visible=true")
    .first()
    .click();
}
async function closeSheet(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  await useScenario(request, "calm");
  await request.patch("/api/settings", {
    data: {
      instanceName: "Home",
      quietHours: true,
      monitorIntervalSec: 15,
      failureThreshold: 2,
      liveRepairs: false,
    },
  });
});

const routes: [name: string, path: string][] = [
  ["home", "/"],
  ["systems", "/systems"],
  ["services", "/services"],
  ["service-detail", "/services/jellyfin"],
  ["incidents", "/incidents"],
  ["incident-detail", "/incidents/inc-1042"],
  ["agent", "/agent"],
  ["autonomy", "/autonomy"],
  ["notifications", "/notifications"],
  ["integrations", "/integrations"],
  ["settings", "/settings"],
  ["discover", "/discover"],
  ["storage-browser", "/storage/demo-movies"],
  ["vault", "/vault"],
  ["memory", "/memory"],
  ["todo", "/todo"],
  ["the forge", "/forge"],
];

function watchProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => problems.push(`requestfailed: ${req.url()}`));
  page.on("response", (res) => {
    if (res.status() >= 400) problems.push(`http ${res.status()}: ${res.url()}`);
  });
  return problems;
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

for (const scenario of ["calm", "attention"] as const) {
  for (const [name, path] of routes) {
    test(`${scenario} · ${name} renders cleanly and accessibly`, async ({ page }, testInfo) => {
      const problems = watchProblems(page);
      await useScenario(page.request, scenario);
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      // Let the page fade-in finish so contrast is measured at full opacity.
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== "running"),
      );
      await expectNoOverflow(page);

      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = axe.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map(
          (v) =>
            `${v.id}: ${v.nodes
              .map((n) => n.target.join(" "))
              .slice(0, 3)
              .join(" | ")}`,
        );
      expect(serious, "serious accessibility violations").toEqual([]);

      await page.screenshot({
        path: `test-results/screens/${testInfo.project.name}/${scenario}-${name}.png`,
        fullPage: true,
      });
      expect(problems).toEqual([]);
    });
  }
}

test("calm home says nothing needs attention", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Nothing requires your attention.");
  await expect(page.getByRole("region", { name: "Requires your attention" })).toHaveCount(0);
});

test("Home fits one screen, and Ember follows you to other pages", async ({ page }, testInfo) => {
  await useScenario(page.request, "attention");
  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Five matters need your attention.");
  await expect(
    page.getByTestId("project-card").or(page.getByText("Start a project")).first(),
  ).toBeVisible();
  if (testInfo.project.name !== "mobile") {
    // No page scrolling on a computer, either way (10-29).
    const fit = await page.evaluate(() => {
      const main = document.getElementById("main")!;
      return {
        down: main.scrollHeight - main.clientHeight,
        across: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(fit).toEqual({ down: 0, across: 0 });
    // Open Ember, then click through to another page: it stays open (10-29).
    await page.getByTestId("cave-hub").getByRole("button").first().click();
    const chat = page.getByRole("region", { name: "Ember" });
    await expect(chat).toBeVisible();
    await page.getByRole("navigation").getByRole("link", { name: "Settings" }).first().click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(chat).toBeVisible();
    await chat.getByRole("button", { name: "Minimize Ember" }).click();
    await expect(chat).toHaveCount(0);
  }
});

test("'N things need you' and the bell open the list of them, not just incidents", async ({
  page,
}, testInfo) => {
  await useScenario(page.request, "attention");
  await page.goto("/incidents");
  // Two incidents are here; the three findings live on Home, and this page says so.
  const elsewhere = page.getByTestId("needs-you-elsewhere");
  await expect(elsewhere).toContainText("3 other things need you");
  await elsewhere.click();
  await expect(page).toHaveURL(/\/#needs-you$/);
  const list = page.locator("#needs-you");
  await expect(list).toBeInViewport();
  await expect(list.getByRole("link")).toHaveCount(5);
  // The status pill (top bar, or the phone's header) and the bell go to the same list.
  await page.goto("/incidents");
  const pill = page
    .getByTestId(testInfo.project.name === "mobile" ? "overall-status-phone" : "overall-status")
    .locator("visible=true");
  await expect(pill).toContainText("need you");
  await pill.click();
  await expect(page).toHaveURL(/\/#needs-you$/);
  await expect(list).toBeInViewport();
  if (testInfo.project.name !== "mobile") {
    await page.goto("/incidents");
    await expect(page.getByTestId("bell")).toHaveAttribute("href", "/#needs-you");
  }
});

test("each thing that needs you can go on the to-do list, once", async ({ page }) => {
  await useScenario(page.request, "attention");
  await page.goto("/");
  await openAlerts(page);
  const list = page.locator("#needs-you");
  const card = list.getByTestId("finding-card").first();
  const title = (await card.locator("p").first().innerText()).trim();
  await card.getByTestId("add-to-todo").click();
  const done = card.getByTestId("add-to-todo-done");
  await expect(done).toContainText("On your to-do list");
  const todos = (await (await page.request.get("/api/todos")).json()) as {
    id: string;
    title: string;
    status: string;
  }[];
  const saved = todos.filter((t) => t.title === title && t.status !== "dismissed");
  expect(saved).toHaveLength(1);
  // The incidents have the button too.
  await expect(list.getByTestId("add-to-todo").first()).toBeVisible();
  // Its link opens the item; then it is taken off again, for the other tests.
  await done.click();
  await expect(page).toHaveURL(new RegExp(`/todo\\?item=${saved[0]!.id}`));
  await page.request.patch(`/api/todos/${saved[0]!.id}`, { data: { status: "dismissed" } });
});

test("each thing that needs you can be removed: snooze, fine as it is, or dismiss", async ({
  page,
}) => {
  await useScenario(page.request, "attention");
  await page.goto("/");
  await openAlerts(page);
  const list = page.locator("#needs-you");
  const card = list.getByTestId("finding-card").first();
  await card.getByTestId("remove-item").click();
  const choices = card.getByTestId("remove-choices");
  await expect(choices.getByTestId("remove-snooze")).toBeVisible();
  await expect(choices.getByTestId("remove-accept")).toBeVisible();
  await expect(choices.getByTestId("remove-dismiss")).toBeVisible();
  // Cancel changes nothing (other tests share these items).
  await choices.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByTestId("remove-item")).toBeVisible();
  // Incidents can be dismissed too.
  await expect(list.getByTestId("remove-item")).toHaveCount(5);
});

test("attention home surfaces every matter and approval is saved", async ({ page }) => {
  await useScenario(page.request, "attention");
  await page.goto("/");
  // Two incidents, and three problems the apps report about themselves (findings): each
  // stuck download is its own, named.
  await expect(page.getByTestId("headline")).toHaveText("Five matters need your attention.");
  // Home shows them as pills; the list opens beside it.
  await expect(page.getByTestId("pill-warnings")).toBeVisible();
  await openAlerts(page);
  const attention = page.getByRole("region", { name: "Requires your attention" });
  await expect(attention.getByRole("link")).toHaveCount(5);
  await expect(attention.getByTestId("finding-card")).toHaveCount(3);

  await attention.getByRole("link", { name: /Two indexers failing/ }).click();
  await expect(page).toHaveURL(/\/incidents\/inc-1047$/);
  await expect(page.getByTestId("approval-expiry")).toContainText("Can be approved until");
  await page.getByRole("button", { name: "Approve repair" }).click();
  await expect(page.getByText("Repair approved")).toBeVisible();
  await expect(page.getByText("You approved the proposed repair")).toBeVisible();

  // Survives a reload, no longer counts as needing you, and is in the audit trail.
  await page.reload();
  await expect(page.getByText("Approved by you").first()).toBeVisible();
  await expect(page.getByText("cannot be carried out automatically yet")).toBeVisible();
  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Four matters need your attention.");
  await page.goto("/settings#about");
  await expect(page.getByTestId("audit-row").first()).toContainText("Approved a repair");
});

test("findings: the dashboard says what needs you and why, what works, and what Hearth can see", async ({
  page,
}, testInfo) => {
  // A calm homelab still has something worth knowing, and real evidence of what works.
  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Nothing requires your attention.");
  await openBriefing(page);
  await expect(page.getByTestId("working-well")).toContainText("Sonarr imported");
  // Gaps are shown, never hidden as healthy.
  await expect(page.getByTestId("coverage")).toContainText("Docker containers");
  await expect(page.getByTestId("coverage")).toContainText("Off");
  expect(await seriousViolations(page)).toEqual([]);
  await closeSheet(page);
  await openAlerts(page);
  const worth = page.getByRole("region", { name: "Worth knowing" });
  await expect(worth).toContainText("Movies on Atlas is 83% full");

  // A finding in full: what was seen, why, evidence, and its history.
  await worth.getByRole("link", { name: /Movies on Atlas is 83% full/ }).click();
  await expect(page).toHaveURL(/\/findings\/fnd-/);
  await expect(page.getByRole("region", { name: "Why it matters" })).toContainText("Above 90%");
  await expect(page.getByTestId("evidence")).toContainText("Used");
  await page.getByRole("button", { name: "Mark as seen" }).click();
  await expect(page.getByTestId("finding-history")).toContainText("You have seen it.");
  await page.getByRole("button", { name: "Snooze a week" }).click();
  await expect(page.getByTestId("finding-history")).toContainText(
    "Hidden from the dashboard until",
  );
  await page.goto("/");
  // Settled first (the count waits for the briefing), so "worth knowing" is really gone.
  await expect(page.getByTestId("headline")).toHaveText("Nothing requires your attention.");
  await expect(page.getByTestId("view-all-alerts")).not.toContainText("worth knowing");
  await openBriefing(page);
  await expect(page.getByTestId("working-well")).toBeVisible();
  await closeSheet(page);

  // Trouble: an app's own problem, with its reason, one click from Ember.
  await useScenario(page.request, "attention");
  await page.goto("/");
  await openBriefing(page);
  await expect(
    page
      .getByRole("region", { name: "Since you were last here" })
      .or(page.getByRole("region", { name: "In the last day" })),
  ).toContainText(/Found \d+ new things/);
  // What still needs you is not repeated as activity.
  await expect(page.getByRole("region", { name: "Recent activity" })).not.toContainText(
    "1 item in the queue",
  );
  await closeSheet(page);
  await openAlerts(page);
  const attention = page.getByRole("region", { name: "Requires your attention" });
  const queue = attention
    .getByTestId("finding-card")
    .filter({
      hasText:
        /didn't import|failed to download|is stalled|downloads (didn't import|failed|need you)/,
    })
    .first();
  // The stuck download is named, with the app's own reason and what Ember can do about it.
  await expect(queue).toContainText("will not reach your library");
  await expect(queue).toContainText(/Ask Ember to read (Sonarr|Radarr)'s queue and import/);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/home-findings.png`,
    fullPage: true,
  });
  await queue.getByRole("button", { name: "Investigate with Ember" }).click();
  await expect(queue.getByTestId("finding-status")).toHaveText("Ember is investigating");
  await closeSheet(page);
  // Investigating opens Ember's conversation; minimize it to reach the briefing.
  const minimize = page.getByRole("button", { name: "Minimize Ember" });
  if (await minimize.count()) await minimize.first().click();
  await openBriefing(page);
  await expect(page.getByRole("region", { name: "Being handled" })).toContainText(
    "Investigating F-",
  );

  // The Findings page lists everything, with what Hearth can see (with Ember's conversation,
  // opened by Investigate above, closed again).
  await page.evaluate(() => sessionStorage.removeItem("dc-cave-expanded"));
  await page.goto("/findings");
  await expect(page.getByRole("region", { name: "Needs your attention" })).toContainText(
    "Home Assistant: Zigbee Home Automation (zha) keeps retrying setup",
  );
  await expect(page.getByTestId("coverage")).toContainText("Inside your apps");
  expect(await seriousViolations(page)).toEqual([]);

  // Accepting a condition: it leaves the open list, and stays recorded with why.
  await page
    .getByRole("region", { name: "Needs your attention" })
    .getByRole("link", { name: /Zigbee Home Automation/ })
    .click();
  await page.getByRole("button", { name: "Accept as it is" }).click();
  await page.getByLabel("Why it is fine as it is (optional)").fill("Zigbee stick is unplugged");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByTestId("finding-history")).toContainText("Accepted as it is");
  await page.goto("/findings");
  await expect(page.getByRole("region", { name: "Needs your attention" })).not.toContainText(
    "Zigbee",
  );
  await page.getByRole("radio", { name: "Accepted" }).click();
  await expect(page.getByRole("region", { name: "Accepted" })).toContainText("Zigbee");
});

test("fresh install shows onboarding empty states", async ({ page }, testInfo) => {
  await useScenario(page.request, "fresh");
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("Let's see what you're running.");
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/fresh-home.png`,
    fullPage: true,
  });
  await page.goto("/services");
  await expect(page.getByText("No services yet")).toBeVisible();
});

test("unreachable server shows a calm error and settings can recover", async ({
  page,
}, testInfo) => {
  await page.goto("/settings#systems");
  await page.getByRole("radio", { name: /Server unreachable/ }).click();
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("We've lost contact.");
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/unreachable-home.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Open settings" }).click();
  await page.getByRole("radio", { name: /All clear/ }).click();
  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Nothing requires your attention.");
});

test("resource history shows what it would keep before it is switched on", async ({ page }) => {
  await page.goto("/settings#monitoring");
  const section = page.getByTestId("resource-history");
  await expect(section).toContainText("Off: nothing is recorded.");
  await expect(page.getByTestId("resource-history-estimate")).toContainText(
    /What it would keep: \d+ subjects .* x 24 hours x 14 days = [\d,]+ rows, about [\d.]+ (KB|MB)/,
  );
  await page.getByLabel("Keep resource history for").selectOption("7");
  await expect(page.getByTestId("resource-history-estimate")).toContainText("x 7 days");
  await section.getByRole("button", { name: "Turn on resource history" }).click();
  await expect(section).toContainText("On. Recording since");
  await section.getByRole("button", { name: "Turn off resource history" }).click();
  await expect(section).toContainText("Off: nothing is recorded.");
  await page.getByLabel("Keep resource history for").selectOption("14");
});

test("settings shows live control plane status from the real API", async ({ page }) => {
  await page.goto("/settings#about");
  await expect(page.getByTestId("about-control-plane")).toHaveText("Healthy");
  await expect(page.getByTestId("about-database")).toHaveText("Healthy");
});

test("settings is split into tabs, each with its own link, and nothing is lost", async ({
  page,
}, testInfo) => {
  await page.goto("/settings");
  const tabs = page.getByRole("tablist", { name: "Settings sections" }).getByRole("tab");
  await expect(tabs).toHaveText([
    "General",
    "PCs and devices",
    "Ember",
    "Security",
    "Backups",
    "Monitoring",
    "Systems",
    "Premium",
    "About",
  ]);
  await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Themes" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Security" })).toHaveCount(0);

  // This PC's name and icon are one click away, in their own tab.
  await page.getByTestId("this-pc").getByRole("button").click();
  await expect(page).toHaveURL(/\/settings#devices$/);
  await expect(page.getByRole("region", { name: "PCs" })).toBeVisible();
  await page.getByRole("tab", { name: "General" }).click();

  // A click opens the tab and puts it in the address, so it can be linked to and refreshed.
  await page.getByRole("tab", { name: "Monitoring" }).click();
  await expect(page).toHaveURL(/\/settings#monitoring$/);
  await expect(page.getByTestId("resource-history")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Monitoring" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Arrow keys move between tabs.
  await page.getByRole("tab", { name: "Monitoring" }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Systems" })).toBeFocused();
  await expect(page).toHaveURL(/#systems$/);

  // Links from elsewhere land on the right tab.
  await page.goto("/settings#security");
  await expect(page.getByRole("region", { name: "Access keys" })).toBeVisible();
  await page.goto("/settings#cave");
  await expect(page.getByTestId("homelab-rules")).toBeVisible();
  await expect(page.getByRole("region", { name: "Ember: voice" })).toBeVisible();
  await page.goto("/settings#nonsense");
  await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");

  // Arriving from another page on a tab's link shows the tabs, not the middle of the page.
  await page.goto("/notifications");
  await page.evaluate(() => window.scrollTo(0, 400));
  await page.goto("/settings#about");
  await expect(page.getByRole("tab", { name: "About" })).toBeInViewport();

  // The tab bar fits a phone without pushing the page sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/settings-tabs.png`,
  });
});

test("notifications: add a friends-and-family destination; it gets only media, can be switched off and deleted", async ({
  page,
}) => {
  const received: { title: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/friends`;
  const name = `Friends ${Date.now() % 100000}`;
  let id = "";
  try {
    await page.goto("/notifications");
    await page.getByTestId("add-destination").click();
    const add = page.getByRole("dialog", { name: "Add a destination" });
    await add.getByLabel("Name").fill(name);
    await add.getByLabel("Kind").selectOption("webhook");
    await add.getByLabel(/Friends and family/).check();
    await add.getByRole("button", { name: "Add, then set it up" }).click();
    // It opens straight into its setup.
    const setup = page.getByRole("dialog", { name: `Set up ${name}` });
    await setup.getByLabel("Address").fill(hook);
    await setup.getByRole("button", { name: `Set up ${name}` }).click();
    await expect(setup).toBeHidden();
    const row = page.locator('[data-testid^="channel-webhook-"]').filter({ hasText: name });
    id = ((await row.getAttribute("data-testid")) ?? "").replace("channel-", "");
    await expect(row).toContainText("Friends and family");
    await expect(page.locator("body")).not.toContainText(hook);
    await row.getByRole("button", { name: "Send test" }).click();
    await expect(row.getByTestId("test-result")).toHaveText("Test sent. Check that it arrived.");
    expect(received.map((r) => r.title)).toEqual(["Test from Hearth"]);
    // System alerts can never go there: it is not even offered for them.
    await expect(
      page
        .getByRole("group", { name: "Channels for Needs your attention" })
        .getByRole("button", { name }),
    ).toHaveCount(0);
    // Off, then deleted.
    await row.getByRole("switch", { name: `${name}: on or off` }).click();
    await expect(row.getByText("Off", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.getByRole("button", { name: "Delete for good" }).click();
    await expect(
      page.locator('[data-testid^="channel-webhook-"]').filter({ hasText: name }),
    ).toHaveCount(0);
    id = "";
  } finally {
    if (id) await page.request.delete(`/api/notifications/channels/${id}`);
    server.close();
  }
});

test("notifications: your own Discord bot, set up step by step with a channel picked from a list", async ({
  page,
}, testInfo) => {
  const name = `Bot ${Date.now() % 100000}`;
  let id = "";
  try {
    await page.goto("/notifications");
    await page.getByTestId("add-destination").click();
    const add = page.getByRole("dialog", { name: "Add a destination" });
    await add.getByLabel("Name").fill(name);
    await add.getByLabel("Kind").selectOption("discord-bot");
    await add.getByLabel(/Friends and family/).check();
    await add.getByRole("button", { name: "Add, then set it up" }).click();
    const setup = page.getByRole("dialog", { name: `Set up ${name}` });
    const steps = setup.getByTestId("bot-setup");
    await expect(steps.getByRole("link", { name: "Open Discord's developer site" })).toBeVisible();
    // A wrong token is said plainly.
    await steps.getByLabel("Bot token").fill("not-a-real-token");
    await steps.getByTestId("bot-check").click();
    await expect(steps.getByRole("alert")).toContainText("did not accept the bot token");
    // The right one: its name, the add-to-server link, and the channels to pick from.
    await steps.getByLabel("Bot token").fill(`fake${"x".repeat(60)}`);
    await steps.getByTestId("bot-check").click();
    await expect(steps.getByTestId("bot-name")).toHaveText("Connected as Hearth");
    await expect(steps.getByTestId("bot-invite")).toHaveAttribute("href", /permissions=117760/);
    await steps.getByLabel("Channel").selectOption({ label: "#movie-chat" });
    await setup.screenshot({ path: `test-results/screens/${testInfo.project.name}/bot-setup.png` });
    await steps.getByRole("button", { name: "Finish setting up" }).click();
    await expect(setup).toBeHidden();
    const row = page.locator('[data-testid^="channel-discord-bot-"]').filter({ hasText: name });
    id = ((await row.getAttribute("data-testid")) ?? "").replace("channel-", "");
    await expect(row).toContainText("#movie-chat");
    await expect(page.locator("body")).not.toContainText("xxxxxxxxxx");
  } finally {
    if (id) await page.request.delete(`/api/notifications/channels/${id}`);
  }
});

test("notifications: the official Hearth bot in two clicks, no token", async ({ page }) => {
  const name = `Hearth bot ${Date.now() % 100000}`;
  let id = "";
  try {
    await page.goto("/notifications");
    await page.getByTestId("add-destination").click();
    const add = page.getByRole("dialog", { name: "Add a destination" });
    await add.getByLabel("Name").fill(name);
    // It is the Discord choice offered first.
    await expect(add.getByLabel("Kind")).toHaveValue("hearth-bot");
    await add.getByLabel(/Friends and family/).check();
    await add.getByRole("button", { name: "Add, then set it up" }).click();
    const setup = page.getByRole("dialog", { name: `Set up ${name}` });
    const steps = setup.getByTestId("hearth-bot-setup");
    await expect(steps).not.toContainText("token");
    const popup = page.waitForEvent("popup");
    await steps.getByTestId("hearth-bot-invite").click();
    await (await popup).close();
    await steps.getByTestId("hearth-bot-channels").click();
    await steps.getByLabel("Channel").selectOption({ label: "#general" });
    await steps.getByRole("button", { name: "Finish setting up" }).click();
    await expect(setup).toBeHidden();
    const row = page.locator('[data-testid^="channel-hearth-bot-"]').filter({ hasText: name });
    id = ((await row.getAttribute("data-testid")) ?? "").replace("channel-", "");
    await expect(row).toContainText("#general · Hearth bot");
  } finally {
    if (id) await page.request.delete(`/api/notifications/channels/${id}`);
  }
});

test("services can be filtered and searched", async ({ page }) => {
  await useScenario(page.request, "attention");
  await page.goto("/services");
  await page.getByRole("radio", { name: /Needs attention/ }).click();
  await expect(page.getByRole("link", { name: "Prowlarr", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Jellyfin", exact: true })).toHaveCount(0);
  await page.getByRole("radio", { name: /^All/ }).click();
  await page.getByRole("searchbox").fill("immich");
  await expect(page.getByRole("link", { name: /^Immich/ })).toHaveCount(2);
});

test("unknown pages and incidents are handled", async ({ page }) => {
  await page.goto("/nope/nothing");
  await expect(page.getByText("This page does not exist.")).toBeVisible();
  await page.goto("/incidents/inc-0000");
  await expect(page.getByText("Incident not found")).toBeVisible();
});

test("keyboard users can skip to content", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium");
  await page.goto("/");
  // The app shell appears once the session is confirmed.
  await expect(page.getByTestId("headline")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
});

test("mobile More sheet reaches secondary screens", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/");
  await page.getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: "test-results/screens/mobile/more-sheet.png" });
  await sheet.getByRole("link", { name: "Monitoring" }).click();
  await expect(page).toHaveURL(/\/incidents$/);
  await expect(sheet).toBeHidden();
  // Monitoring's own tabs reach the rest (11-13).
  await page.getByRole("tab", { name: "Autonomy" }).click();
  await expect(page).toHaveURL(/\/autonomy$/);
});

test("unknown API routes return JSON 404", async ({ request }) => {
  const res = await request.get("/api/nope");
  expect(res.status()).toBe(404);
  expect(await res.json()).toMatchObject({ error: "Not Found" });
});

test("autonomy changes save and flow through to services", async ({ page }) => {
  await page.goto("/services/prowlarr");
  await expect(page.getByText("Ask before fixing", { exact: true })).toBeVisible();

  await page.goto("/autonomy");
  await page.getByLabel("Media automation").selectOption("monitor");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Media automation")).toHaveValue("monitor");

  await page.goto("/services/prowlarr");
  await expect(page.getByRole("definition").filter({ hasText: /^Monitor$/ })).toBeVisible();
});

test("notifications: set up a webhook, send a test, and receive a repair report", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  // A receiver standing in for Home Assistant, n8n, or similar.
  const received: { title: string; message: string; severity: string; link: string | null }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

  try {
    await page.goto("/notifications");
    // Quiet hours would hold routine messages if this runs at night.
    await page.getByRole("switch", { name: "Quiet hours" }).click();
    await expect(page.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    const row = page.getByTestId("channel-webhook");
    await row.getByRole("button", { name: "Set up" }).click();
    const sheet = page.getByRole("dialog", { name: "Set up Webhook" });
    await sheet.getByLabel("Address").fill(hook);
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/notifications-setup.png`,
      fullPage: true,
    });
    await sheet.getByRole("button", { name: "Set up Webhook" }).click();
    await expect(sheet).toBeHidden();
    await expect(row.getByText("Active")).toBeVisible();
    // The address is a secret: it went to the vault and is not shown.
    await expect(page.locator("body")).not.toContainText(hook);

    await row.getByRole("button", { name: "Send test" }).click();
    await expect(row.getByTestId("test-result")).toHaveText("Test sent. Check that it arrived.");
    expect(received.map((r) => r.title)).toEqual(["Test from Hearth"]);

    // New channels are routed to everything that matters, except the weekly note.
    await expect(
      page
        .getByRole("group", { name: "Channels for Needs your attention" })
        .getByRole("button", { name: "Webhook" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page
        .getByRole("group", { name: "Channels for Weekly summary" })
        .getByRole("button", { name: "Webhook" }),
    ).toHaveAttribute("aria-pressed", "false");

    // A practice failure is repaired, and the report arrives.
    await page.goto("/services/jellyfin");
    await page.getByRole("button", { name: "Make it fail" }).click();
    await expect(page.getByTestId("last-check")).toContainText("failed 1 time in a row");
    await page.getByRole("button", { name: "Run health check" }).click();
    await expect
      .poll(() => received.map((r) => r.title), { timeout: 20_000 })
      .toContain("[Sample data] Fixed: Jellyfin stopped responding");
    const report = received.find((r) => r.title.includes("Fixed: Jellyfin"))!;
    expect(report.severity).toBe("info");
    expect(report.message).toContain("Nothing is needed from you.");
    expect(report.link).toMatch(/\/incidents\/inc-[0-9a-f]+$/);

    await page.goto("/notifications");
    await expect(page.getByTestId("recent-notifications")).toContainText(
      "[Sample data] Fixed: Jellyfin stopped responding",
    );
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/notifications.png`,
      fullPage: true,
    });
  } finally {
    // Channels are settings that outlive scenarios; leave the next test a clean slate.
    await page.request.delete("/api/notifications/channels/webhook");
    server.close();
  }
});

test("connect the AI operator and talk with it", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // Starts from no AI connected, whatever an earlier test left (tests share one Hearth).
  await page.request.post("/api/agent/disconnect", { data: {} });
  try {
    await page.goto("/agent");
    await expect(page.getByText("No operator connected")).toBeVisible();
    // The same Connect your AI step as the welcome: signed in from this page (the stand-in for
    // Anthropic's sign-in), then checked and connected by Hearth on its own.
    await page.request.post("/api/agent/claude/sign-out", { data: {} });
    await page.reload();
    await page
      .context()
      .route("https://claude.com/**", (r) => r.fulfill({ body: "Anthropic sign-in (test)" }));
    await page.getByTestId("claude-connect").click();
    await page.getByTestId("claude-code-input").fill("TESTCODE123#TESTSTATE");
    await page.getByTestId("claude-code-submit").click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/Open a shell, read arbitrary files, or browse the web/),
    ).toBeVisible();

    await page.getByRole("link", { name: "Ask Ember" }).click();
    await expect(page).toHaveURL(/\/ask$/);
    await page.getByLabel("Ask Ember").fill("Is anything wrong?");
    await page.getByRole("button", { name: "Send" }).click();
    const conversation = page.getByTestId("cave-thread");
    await expect(conversation).toContainText("Is anything wrong?");
    await expect(conversation).toContainText("Nothing is wrong right now. Everything is healthy.", {
      timeout: 20_000,
    });
    await expect(page.getByTestId("answer").last()).toContainText(
      "Answered from live state and records",
    );
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/ask-ai.png`,
      fullPage: true,
    });

    await page.goto("/agent");
    await expect(page.getByRole("region", { name: "Recent work" })).toContainText(
      "Nothing is wrong right now.",
    );
  } finally {
    // The operator is an installation setting; leave other tests without one.
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("create an access key for Home Assistant, shown once, then revoke it", async ({
  page,
}, testInfo) => {
  await page.goto("/settings#security");
  const keys = page.getByRole("region", { name: "Access keys" });
  await keys.getByRole("button", { name: "New key" }).click();
  const sheet = page.getByRole("dialog", { name: "New access key" });
  await expect(sheet.getByLabel("What it is for")).toHaveValue("Home Assistant");
  expect(await seriousViolations(page)).toEqual([]);
  await sheet.getByRole("button", { name: "Create key" }).click();

  const shown = page.getByTestId("new-key");
  const key = (await shown.textContent())!.trim();
  expect(key).toMatch(/^dc_/);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/access-key.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Done" }).click();

  // The key works for what it was given, and nothing else.
  const status = await page.request.get("/api/status", {
    headers: { authorization: `Bearer ${key}`, cookie: "" },
  });
  expect(status.status()).toBe(200);
  expect(await status.json()).toMatchObject({ installation: "Home", sampleData: true });
  const vault = await page.request.get("/api/vault", {
    headers: { authorization: `Bearer ${key}`, cookie: "" },
  });
  expect(vault.status()).toBe(403);

  const row = page
    .getByTestId("access-keys")
    .getByRole("listitem")
    .filter({ hasText: "Home Assistant" })
    .first();
  await expect(row).toContainText("Talk to the operator");
  await expect(page.locator("body")).not.toContainText(key);
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toBeHidden();
  const after = await page.request.get("/api/status", {
    headers: { authorization: `Bearer ${key}`, cookie: "" },
  });
  expect(after.status()).toBe(401);
});

test("renaming the installation saves and updates the tab title", async ({ page }) => {
  await page.goto("/settings");
  const name = page.getByLabel("Name", { exact: true });
  await name.fill("Lakehouse");
  await name.press("Enter");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Lakehouse · Hearth");
  await page.reload();
  await expect(name).toHaveValue("Lakehouse");
  await page.getByRole("tab", { name: "About" }).click();
  await expect(page.getByTestId("audit-row").first()).toContainText("Renamed this installation");
});

test("Ember's personality is set in Settings and says it changes no permissions", async ({
  page,
}) => {
  await page.goto("/settings#cave");
  const section = page.getByTestId("cave-personality");
  await expect(section.getByRole("radio", { name: "Warm" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await section.getByRole("radio", { name: "None" }).click();
  await section.getByRole("radio", { name: "Deep" }).click();
  await expect(section).toContainText("never approves anything");
  await page.reload();
  await expect(section.getByRole("radio", { name: "None" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(section.getByRole("radio", { name: "Deep" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("tab", { name: "About" }).click();
  await expect(page.getByTestId("audit-row").first()).toContainText("Changed how Ember talks");
});

test("the to-do list: add an item, filter it, read its history, and resolve it", async ({
  page,
}, testInfo) => {
  const title = `Check the UPS battery (${testInfo.project.name} ${Date.now()})`;
  await page.goto("/todo");
  await page.getByRole("button", { name: "Add an item" }).click();
  const sheet = page.getByRole("dialog", { name: "Add to the to-do list" });
  await sheet.getByRole("radio", { name: "Task" }).click();
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByRole("radio", { name: "High" }).click();
  await sheet.getByRole("button", { name: "Add to the list" }).click();
  const row = page.getByTestId("todo-row").filter({ hasText: title });
  await expect(row).toBeVisible();

  // Kind filter: it is a task, not an idea.
  await page.getByRole("radio", { name: /^Ideas/ }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("radio", { name: /^Tasks/ }).click();
  await expect(row).toBeVisible();
  expect(page.url()).toContain("category=task");

  await row.click();
  const detail = page.getByTestId("todo-detail");
  await expect(detail).toContainText("High priority");
  await expect(detail.getByRole("link", { name: "Work on it with Ember" })).toBeVisible();
  await detail.getByRole("button", { name: "Mark resolved" }).click();
  await expect(detail).toContainText("Resolved");
  await expect(page.getByTestId("todo-history")).toContainText("Open to Resolved");
  await page
    .getByRole("dialog", { name: /To-do #/ })
    .getByRole("button", { name: "Close" })
    .click();
  // Resolved items leave the "to deal with" view and appear under Resolved.
  await expect(row).toHaveCount(0);
  await page.getByLabel("Status").selectOption("resolved");
  await expect(page).toHaveURL(/view=resolved/);
  await expect(row).toBeVisible();
});

test("Ember message box: Enter, Shift+Enter, one send, writing help, and copy", async ({
  page,
  context,
}, testInfo) => {
  const phone = testInfo.project.name === "mobile";
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/ask");
  const box = page.getByLabel("Ask Ember");
  const thread = page.getByTestId("cave-thread");
  const asked = () => thread.locator("li").filter({ hasText: /^You:/ });

  // Empty or blank: nothing is sent.
  await box.fill("   ");
  await box.press("Enter");
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await box.fill("");
  await box.click();
  await page.keyboard.type("first line");
  if (phone) {
    // An on-screen keyboard: Enter is a new line; the button sends.
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    await expect(box).toHaveValue(/first line\nsecond line/i);
    await page.getByRole("button", { name: "Send" }).click();
  } else {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await expect(box).toHaveValue(/first line\nsecond line/i);
    // Two quick Enters send once.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
  }
  await expect(thread).toContainText(/second line/i);
  await expect(page.getByTestId("answer")).toHaveCount(1, { timeout: 20_000 });
  await expect(asked()).toHaveCount(1);
  await expect(box).toHaveValue("");

  if (!phone) {
    // Basic writing help (the desktop default): fixes land when a sentence ends, and undo.
    await box.click();
    await page.keyboard.type("i think teh disk is full. ");
    await expect(box).toHaveValue("I think the disk is full. ");
    const fixed = page.getByTestId("cave-corrections");
    await expect(fixed).toContainText("teh → the");
    await fixed.getByRole("button", { name: "Undo" }).click();
    await expect(box).toHaveValue("i think teh disk is full. ");
    // Technical text is left alone.
    await box.fill("");
    await box.click();
    await page.keyboard.type("run docker restart teh-app on /mnt/teh now. ");
    await expect(box).toHaveValue("Run docker restart teh-app on /mnt/teh now. ");
    await box.fill("");
  }

  // Copy an answer.
  await page.getByRole("button", { name: "Copy this answer" }).first().click();
  await expect(page.getByRole("button", { name: "Copied" }).first()).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.length).toBeGreaterThan(10);
  expect(copied).not.toMatch(/\[E\d+\]/);
  // Your own messages copy too, exactly as you wrote them.
  await page.getByRole("button", { name: "Copy your message" }).first().click();
  const mine = await page.evaluate(() => navigator.clipboard.readText());
  expect(mine.length).toBeGreaterThan(3);
  expect(mine).not.toBe(copied);
});

test("Enhanced writing help: grammar suggestions in the browser, offered never applied, technical text protected", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("dc-writing-assist", "enhanced"));
  const outside: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (/^https?:$/.test(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname))
      outside.push(r.url());
  });
  await page.goto("/ask");
  const box = page.getByLabel("Ask Ember");
  await box.click();
  await box.pressSequentially("Check the logs on /srv/homelab and and restart it. ");
  const suggestions = page.getByTestId("cave-grammar");
  await expect(suggestions).toContainText("and and", { timeout: 30_000 });
  // Nothing was changed by itself, and the path is never suggested for a change.
  await expect(box).toHaveValue("Check the logs on /srv/homelab and and restart it. ");
  await expect(suggestions).not.toContainText("storage");
  await suggestions.getByRole("button", { name: /Change "and and" to "and"/ }).click();
  await expect(box).toHaveValue("Check the logs on /srv/homelab and restart it. ");
  // The checker ran here: no request left Hearth's own address.
  expect(outside).toEqual([]);
  // Its engine is sent compressed.
  const wasm = await page.request.get(
    (await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name))).find(
      (n) => n.endsWith(".wasm"),
    )!,
    { headers: { "accept-encoding": "br" } },
  );
  expect(wasm.headers()["content-encoding"]).toBe("br");
});

test("a browser that reports no pointer at all (Chrome in a remote desktop) is a keyboard: Enter sends, writing help on", async ({
  page,
}) => {
  // Regression (the home server xrdp, 2026-10-09): Chrome reports any-pointer: none there.
  await page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) =>
      /any-pointer|^\(pointer/.test(q)
        ? ({ ...real(q), matches: /none/.test(q), media: q } as MediaQueryList)
        : real(q);
  });
  await page.goto("/ask");
  const box = page.getByLabel("Ask Ember");
  await box.click();
  await page.keyboard.type("i think teh disk is full. ");
  await expect(box).toHaveValue("I think the disk is full. ");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("cave-thread")).toContainText(/I think the disk is full/);
  await expect(box).toHaveValue("");
});

test("desktop fits the window: a long conversation and open panels never make the page scroll", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Phones keep natural page scrolling.");
  // Regression (the home server, 2026-10-09): hidden labels in a long conversation stretched the page
  // by thousands of pixels of empty space.
  await page.goto("/ask");
  const box = page.getByLabel("Ask Ember");
  for (let i = 0; i < 8; i++) {
    await box.fill(`How are my servers doing? (${i + 1})`);
    await box.press("Enter");
    await expect(page.getByTestId("answer")).toHaveCount(i + 1, { timeout: 20_000 });
  }
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1600, height: 860 },
  ]) {
    await page.setViewportSize(size);
    for (const url of ["/", "/?panels=service:jellyfin,service:plex", "/ask", "/services"]) {
      await page.goto(url);
      await expect(page.locator("#main")).toBeVisible();
      await page.waitForTimeout(400);
      const { doc, win } = await page.evaluate(() => ({
        doc: document.documentElement.scrollHeight,
        win: window.innerHeight,
      }));
      expect(doc, `${url} at ${size.width}x${size.height}`).toBeLessThanOrEqual(win);
    }
    // The desk fills the space exactly: nothing below it.
    await page.goto("/?panels=service:jellyfin,service:plex");
    await expect(page.getByTestId("desk")).toBeVisible();
    await page.waitForTimeout(500); // the page's 320 ms fade-in slides 4 px
    const over = await page.evaluate(() => {
      const m = document.getElementById("main");
      return m ? m.scrollHeight - m.clientHeight : Infinity;
    });
    expect(over).toBeLessThanOrEqual(2);
  }
});

test("Sonarr dashboard: stuck import named with its reason, Import and Search propose a plan for that one item", async ({
  page,
}) => {
  await useScenario(page.request, "calm");
  // The queue lives in Sonarr's Activity tab (native panels Phase 3).
  await page.goto("/?panels=service:sonarr@activity");
  const dash = page.getByTestId("arr-dashboard");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  await expect(dash.getByTestId("arr-freshness")).toContainText("Sample data");
  const stuck = dash.locator('[data-testid="arr-queue-item"][data-stuck="yes"]');
  await expect(stuck).toContainText("Ghosts (US) S02E01");
  await expect(stuck).toContainText("matched to series by ID");
  const planned = page.waitForRequest(
    (r) => r.url().endsWith("/api/jobs") && r.method() === "POST",
  );
  await stuck.getByTestId("arr-import").click();
  expect(JSON.parse((await planned).postData() ?? "{}").steps).toEqual([
    { kind: "app-arr-import", serviceId: "sonarr", params: { queueId: 101 } },
  ]);
  // Sample data has no real Sonarr: the plan is refused, with the reason, here.
  await expect(dash.getByTestId("arr-plan-error")).toContainText("Sample data");
  // Missing episodes live in Wanted, each with its own Search.
  await page.goto("/?panels=service:sonarr@wanted");
  const missing = page.getByTestId("sonarr-wanted-episode").first();
  await expect(missing).toBeVisible({ timeout: 15_000 });
  await expect(missing.locator('[data-hearth-target^="wanted:search:"]')).toBeVisible();
});

test("Sonarr dashboard: the download trail shows the download folder, then the renamed file in the library", async ({
  page,
}) => {
  await useScenario(page.request, "calm");
  await page.goto("/?panels=service:sonarr@activity");
  const dash = page.getByTestId("arr-dashboard");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  await dash.getByRole("radio", { name: /^Download trail/ }).click();
  const trail = dash.getByTestId("download-trail").filter({ hasText: "Foundation S03E03" });
  await expect(trail.getByTestId("trail-status")).toHaveText("In the library");
  // The newest trail opens by itself; this one is older than what is in the queue.
  if (!(await trail.getByTestId("trail-step").count()))
    await trail.getByRole("button").first().click();
  await expect(trail.getByTestId("trail-step").first()).toContainText(
    "Sonarr grabbed it from UsenetOne (Prowlarr) and sent it to SABnzbd",
  );
  const imported = trail.locator('[data-testid="trail-step"][data-kind="imported"]');
  await expect(imported).toContainText("renamed into the library");
  await expect(imported.getByTestId("trail-path").first()).toContainText(
    "/usenet-tv/Foundation.S03E03.1080p.WEB.h264/",
  );
  await expect(imported.getByTestId("trail-path").last()).toContainText(
    "Foundation - S03E03 - The Missing Chapter WEBDL-1080p.mkv",
  );
  // A download in the library has no question to ask; one that went wrong has Ask Ember.
  await expect(trail.getByTestId("trail-ask")).toHaveCount(0);
  const bad = dash.getByTestId("download-trail").filter({ hasText: "Ghosts (US) S02E10" });
  await expect(bad.getByTestId("trail-status")).toHaveText("Did not finish");
  if (!(await bad.getByTestId("trail-step").count())) await bad.getByRole("button").first().click();
  await bad.getByTestId("trail-ask").click();
  await expect(page.getByTestId("your-message").last()).toContainText(
    `Sonarr's download of "Ghosts (US) S02E10" did not finish.`,
    { timeout: 15_000 },
  );
  await page.goto("/?service=sonarr");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Sonarr dashboard: Search releases goes from a series to a season or an episode, then its releases", async ({
  page,
}) => {
  await useScenario(page.request, "calm");
  await page.goto("/?service=sonarr");
  const dash = page.getByTestId("arr-dashboard");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  await dash.getByRole("radio", { name: /Search releases/ }).click();
  await dash.getByTestId("isearch-input").fill("ghosts");
  await dash.getByRole("button", { name: "Find" }).click();
  await dash.getByTestId("isearch-title").first().click();
  await expect(dash.getByTestId("isearch-season").first()).toContainText("Season 2");
  await dash.getByTestId("isearch-season").first().locator("summary").click();
  await dash.getByTestId("isearch-episode").filter({ hasText: "S02E10" }).click();
  const releases = dash.getByTestId("isearch-releases");
  await expect(releases).toContainText("Ghosts (US) S02E10");
  await expect(releases.getByTestId("isearch-release")).toHaveCount(1);
  await expect(releases).toContainText("sample data");
  // Sample data has no real Sonarr: downloading is planned, and refused with the reason here.
  await releases.getByTestId("isearch-download").first().click();
  await expect(releases.getByTestId("panel-change")).toContainText("Sample data");
});

test("Sonarr dashboard: a failed download shows as failed, with Remove, Search again, and Clear all failed as plans", async ({
  page,
}) => {
  await useScenario(page.request, "calm");
  await page.goto("/?service=sonarr");
  const overview = page.getByTestId("arr-dashboard");
  await expect(overview).toBeVisible({ timeout: 15_000 });
  await expect(overview).toContainText("Need attention");
  await expect(overview).toContainText("1 failed · 1 stuck");
  // The queue with its fixes is in Activity.
  await page.goto("/?panels=service:sonarr@activity");
  const dash = page.getByTestId("arr-dashboard");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  const failed = dash.locator('[data-testid="arr-queue-item"][data-failed="yes"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText("Ghosts (US) S02E10");
  await expect(failed).toContainText("Failed in SABnzbd");
  await expect(failed).toContainText("not enough repair blocks");
  await expect(failed.getByRole("progressbar")).toHaveCount(0);
  await expect(failed.getByTestId("arr-search-again")).toBeVisible();
  await expect(dash.getByTestId("arr-failed-summary")).toContainText(
    "1 download failed and will sit here until removed",
  );
  const planned = page.waitForRequest(
    (r) => r.url().endsWith("/api/jobs") && r.method() === "POST",
  );
  await dash.getByTestId("arr-clear-failed").click();
  expect(JSON.parse((await planned).postData() ?? "{}").steps).toEqual([
    {
      kind: "app-arr-queue-remove",
      serviceId: "sonarr",
      params: { queueId: 103, removeFromClient: true },
    },
  ]);
  await expect(dash.getByTestId("arr-plan-error")).toContainText("Sample data");
  const one = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await failed.getByTestId("arr-remove-failed").click();
  expect(JSON.parse((await one).postData() ?? "{}").steps[0].params).toEqual({
    queueId: 103,
    removeFromClient: true,
  });
  await failed.screenshot({ path: "test-results/sonarr-failed.png" });
});

test("panel changes are approved in a pop-up right there: Cancel declines, Approve runs it", async ({
  page,
}) => {
  await useScenario(page.request, "calm");
  // Sample data can't be changed, so the plan replies are stood in for here; the pop-up is real.
  const decisions: { decision: string; fingerprint?: string }[] = [];
  const job = (status: string, result?: string) => ({
    id: "job-popup",
    title: "Remove the failed download of Ghosts (US) S02E10",
    status,
    requestedBy: "you",
    createdAt: new Date().toISOString(),
    steps: [
      {
        seq: 1,
        kind: "app-arr-queue-remove",
        serviceId: "sonarr",
        label: "Remove Ghosts.S02E10 from Sonarr's queue and from the download client",
        serviceName: "Sonarr",
        changes: true,
        policy: "approve-first",
        policyReason: "",
        verify: "",
        rollback: "",
        status: status === "succeeded" ? "succeeded" : "pending",
        change: {
          summary: "",
          settings: [
            {
              name: "The download",
              before: "In SABnzbd",
              after: "Removed from SABnzbd's history too",
            },
          ],
        },
        ...(result ? { result } : {}),
      },
    ],
    ...(status === "awaiting-approval"
      ? { approval: { fingerprint: "fp-1", expiresAt: "2099-01-01T00:00:00Z" } }
      : {}),
  });
  let current = job("awaiting-approval");
  await page.route("**/api/jobs", (r) =>
    r.request().method() === "POST"
      ? r.fulfill({ json: (current = job("awaiting-approval")) })
      : r.fallback(),
  );
  await page.route("**/api/jobs/job-popup", (r) => r.fulfill({ json: current }));
  await page.route("**/api/jobs/job-popup/decision", (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}");
    decisions.push(body);
    current =
      body.decision === "approve"
        ? job("succeeded", "Removed from Sonarr's queue and SABnzbd; checked.")
        : job("declined");
    return r.fulfill({ json: current });
  });

  await page.goto("/?panels=service:sonarr@activity");
  const dash = page.getByTestId("arr-dashboard");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  const failed = dash.locator('[data-testid="arr-queue-item"][data-failed="yes"]');
  const url = page.url();

  // Remove: the plan pops up here, with exactly what changes. Cancel declines it.
  await failed.getByTestId("arr-remove-failed").click();
  const pop = page.getByTestId("approve-here");
  await expect(pop).toContainText("Your approval");
  await expect(pop).toContainText("Remove Ghosts.S02E10 from Sonarr's queue");
  await expect(pop).toContainText("Removed from SABnzbd's history too");
  expect(page.url()).toBe(url);
  await pop.screenshot({ path: "test-results/approve-popup.png" });
  await pop.getByTestId("approve-here-cancel").click();
  await expect(pop).toHaveCount(0);
  expect(decisions).toEqual([{ decision: "decline" }]);

  // Remove again, Approve: it runs, says what happened, and closes when you're done.
  await failed.getByTestId("arr-remove-failed").click();
  await pop.getByTestId("approve-here-approve").click();
  await expect(pop).toContainText("Removed from Sonarr's queue and SABnzbd; checked.");
  expect(decisions[1]).toEqual({ decision: "approve", fingerprint: "fp-1" });
  await pop.getByTestId("approve-here-close").click();
  await expect(pop).toHaveCount(0);
  expect(decisions).toHaveLength(2);
  expect(page.url()).toBe(url);
});

test("Radarr panel: the library at a glance, coming, upgrades, collections, and Find", async ({
  page,
}) => {
  await useScenario(page.request, "calm");
  await page.goto("/?service=radarr");
  const dash = page.getByTestId("arr-dashboard");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  const lib = dash.getByTestId("radarr-library");
  await expect(lib).toContainText("8 movies on disk");
  await expect(lib).toContainText("free (/movies, /new releases)");
  await expect(dash.getByTestId("radarr-tiers")).toContainText("Standard definition 2");
  await expect(dash.getByTestId("radarr-biggest")).toContainText("The Road");
  await lib.screenshot({ path: "test-results/radarr-library.png" });

  await dash.getByRole("radio", { name: /^Coming/ }).click();
  await expect(dash.getByTestId("radarr-coming").first()).toContainText("The Odyssey");
  await expect(dash.getByTestId("radarr-coming").first()).toContainText("Digital");

  await dash.getByRole("radio", { name: /^Upgrades/ }).click();
  await expect(dash.getByTestId("radarr-upgrade").first()).toContainText("Heat (1995)");
  let planned = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await dash.getByTestId("radarr-upgrade").first().getByTestId("radarr-search-better").click();
  expect(JSON.parse((await planned).postData() ?? "{}").steps).toEqual([
    { kind: "app-arr-search", serviceId: "radarr", params: { movieId: 6 } },
  ]);
  planned = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await dash.getByTestId("radarr-upgrade-batch").click();
  expect(JSON.parse((await planned).postData() ?? "{}").steps).toHaveLength(2);

  await dash.getByRole("radio", { name: /^Collections/ }).click();
  const wick = dash.getByTestId("radarr-collection").filter({ hasText: "John Wick Collection" });
  await expect(wick).toContainText("2 of 4");
  await expect(wick).toContainText("John Wick: Chapter 2 (2017)");
  planned = page.waitForRequest((r) => r.url().endsWith("/api/jobs") && r.method() === "POST");
  await wick.getByTestId("radarr-add-collection").click();
  expect(JSON.parse((await planned).postData() ?? "{}").steps).toEqual([
    { kind: "app-arr-add-collection", serviceId: "radarr", params: { collectionId: 731 } },
  ]);
  await dash.screenshot({ path: "test-results/radarr-collections.png" });

  await dash.getByRole("radio", { name: /^Find/ }).click();
  await dash.getByLabel("Find a movie in your library").fill("dune");
  await expect(dash.getByTestId("radarr-find").first()).toContainText("Dune (2021)");
  await expect(dash.getByTestId("radarr-find").first()).toContainText("/movies/Dune (2021)");
  await expect(dash.getByTestId("radarr-find").first()).toContainText("DV HDR10");
});

test("qBittorrent repairs: only the ones that fit the torrent, each proposed as a plan, never run directly", async ({
  page,
}, testInfo) => {
  await page.goto(`/?panels=${encodeURIComponent("service:qbittorrent@torrents")}`);
  const dash = page.getByTestId("qb-torrents");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  const orville = dash.getByTestId("qb-torrent").filter({ hasText: "The.Orville.S02E04" });
  await orville.getByRole("button").first().click();
  // A stalled torrent that is running: pause, force start, recheck, reannounce, ask.
  const repairs = orville.getByTestId("qb-actions");
  await expect(repairs.getByRole("button")).toHaveText([
    "Pause",
    "Force start",
    "Recheck",
    "Reannounce",
    "Ask Ember",
  ]);
  await repairs.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/qb-repairs.png`,
  });
  // Removing with its files is a plan too: nothing is deleted until it is approved.
  const removal = page.waitForRequest(
    (r) => r.url().endsWith("/api/jobs") && r.method() === "POST",
  );
  await orville.getByRole("button", { name: "Remove and delete files" }).click();
  expect(JSON.parse((await removal).postData() ?? "{}").steps[0].kind).toBe(
    "app-qbt-remove-with-data",
  );
  await expect(dash.getByTestId("qb-action-error")).toContainText("Sample data");
  const planned = page.waitForRequest(
    (r) => r.url().endsWith("/api/jobs") && r.method() === "POST",
  );
  await repairs.getByRole("button", { name: "Reannounce" }).click();
  const body = JSON.parse((await planned).postData() ?? "{}");
  expect(body.steps).toEqual([
    {
      kind: "app-qbt-reannounce",
      serviceId: "qbittorrent",
      params: { hash: expect.stringMatching(/^[a-f0-9]{40}$/) },
    },
  ]);
  // Sample data has no real qBittorrent to change: the plan is refused, with the reason, here.
  await expect(dash.getByTestId("qb-action-error")).toContainText("Sample data");
});

test("qBittorrent dashboard: live torrents with moving progress bars, seeds and peers, groups, details", async ({
  page,
}, testInfo) => {
  // Overview at a glance: what needs you is named there, one tap from it in the Torrents tab.
  await page.goto("/?panels=service:qbittorrent");
  const overview = page.getByTestId("qb-dashboard");
  await expect(overview).toBeVisible({ timeout: 15_000 });
  await expect(overview.getByTestId("qb-needs-you")).toContainText("The.Orville.S02E04");
  await page.goto(`/?panels=${encodeURIComponent("service:qbittorrent@torrents")}`);
  const dash = page.getByTestId("qb-torrents");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("qb-header")).toContainText("Connected");
  await expect(page.getByTestId("qb-freshness")).toContainText("Sample data");
  const ghost = dash.getByTestId("qb-torrent").filter({ hasText: "Ghost.S05E02" });
  const bar = ghost.getByRole("progressbar");
  const before = Number(await bar.getAttribute("aria-valuenow"));
  expect(before).toBeGreaterThanOrEqual(60);
  await expect(ghost).toContainText("Seeds 14 (212 in swarm)");
  // The bar moves: the dashboard refreshes every two seconds.
  await expect
    .poll(async () => Number(await bar.getAttribute("aria-valuenow")), { timeout: 8_000 })
    .toBeGreaterThan(before);
  const orville = dash.getByTestId("qb-torrent").filter({ hasText: "The.Orville.S02E04" });
  await expect(orville).toHaveAttribute("data-status", "stalled");
  await expect(orville).toContainText("No seeders");
  await expect(orville).toContainText("Stalled: no seeders in the swarm.");
  await dash.getByRole("button", { name: /^Stalled 1$/ }).click();
  await expect(dash.getByTestId("qb-torrent")).toHaveCount(1);
  await orville.getByRole("button").first().click();
  await orville.getByRole("tab", { name: "trackers" }).click();
  await expect(orville.getByTestId("qb-trackers")).toContainText("not working");
  await page.screenshot({ path: testInfo.outputPath("qbittorrent.png"), fullPage: false });
  // Point at it and ask: the chat knows "that" is this torrent, and only its identity is sent.
  await orville.getByTestId("qb-ask").click();
  const chip = page.getByTestId("cave-focus").first();
  await expect(chip).toContainText("About: The.Orville.S02E04.1080p.WEB.x264 (qBittorrent)");
  // The chat box that took focus (a phone can have more than one on the page).
  const box = page.locator("textarea:focus");
  await expect(box).toHaveAccessibleName("Ask Ember");
  const sent = page.waitForRequest(
    (r) => r.url().endsWith("/api/agent/conversations") && r.method() === "POST",
  );
  await box.fill("hey, what's up with that?");
  await page.getByRole("button", { name: "Send" }).first().click();
  const body = JSON.parse((await sent).postData() ?? "{}");
  expect(body.focus).toEqual({
    kind: "service",
    id: "qbittorrent",
    item: { kind: "torrent", id: expect.stringMatching(/^[a-f0-9]{40}$/) },
  });
  await expect(page.getByTestId("answer").last()).toBeVisible({ timeout: 20_000 });
  await expect(chip).toContainText("The.Orville");
  if (testInfo.project.name === "mobile") await showOnPhone(page, "qBittorrent");
  await dash.getByRole("button", { name: /^All \d+$/ }).click();
  await dash.getByPlaceholder("Find a torrent by name").fill("linux");
  await expect(dash.getByTestId("qb-torrent")).toHaveCount(1);
});

test("Plex dashboard: libraries, who is watching what, direct play or transcode, buffering, and ask about a stream", async ({
  page,
}, testInfo) => {
  // Overview by name: the Plex panel opens on Home (11-21).
  await page.goto(`/?panels=${encodeURIComponent("service:plex@overview")}`);
  const dash = page.getByTestId("plex-dashboard");
  await expect(dash).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("plex-totals")).toContainText("1,284");
  await expect(page.getByTestId("plex-totals")).toContainText("18,406");
  await expect(dash).toContainText("Watching now: 2 · 1 transcoding");
  const jeff = dash.getByTestId("plex-session").filter({ hasText: "Jeff" });
  await expect(jeff).toContainText("Dune: Part Two (2024)");
  await expect(jeff).toContainText("Direct play");
  await expect(jeff).toContainText("4K");
  const sam = dash.getByTestId("plex-session").filter({ hasText: "Sam" });
  await expect(sam).toHaveAttribute("data-state", "buffering");
  await expect(sam).toContainText("Transcode (software)");
  await expect(sam).toContainText("Buffering: the transcoder runs at 0.7x, slower than real time.");
  await expect(page.getByTestId("plex-libraries")).toContainText(
    "212 shows · 961 seasons · 18,406 episodes",
  );
  await expect(page.getByTestId("plex-activities")).toContainText("Scanning TV Shows");
  await page.screenshot({ path: testInfo.outputPath("plex.png") });
  await sam.getByTestId("plex-ask").click();
  await expect(page.getByTestId("cave-focus").first()).toContainText(
    "About: Sam watching A Tale of Two Ships (Plex)",
  );
});

test("the API explains invalid changes", async ({ request }) => {
  const res = await request.put("/api/autonomy", { data: { default: "yolo", rules: [] } });
  expect(res.status()).toBe(400);
  expect((await res.json()).message).toBeTruthy();
});

test("services link straight to their proxied or local address", async ({ page }) => {
  await page.goto("/services");
  const jellyfin = page.getByRole("link", { name: "Open Jellyfin at watch.example.com" });
  await expect(jellyfin).toHaveAttribute("href", "https://watch.example.com");
  await expect(jellyfin).toHaveAttribute("target", "_blank");
  await expect(jellyfin).toHaveAttribute("rel", /noopener/);
  // No public address: falls back to the local web interface.
  await expect(page.getByRole("link", { name: "Open Plex on your network" })).toHaveAttribute(
    "href",
    "http://192.168.1.20:32400",
  );
  // Nothing to open in a browser: no link at all.
  await expect(page.getByRole("link", { name: /Open Mosquitto/ })).toHaveCount(0);

  await page.goto("/services/jellyfin");
  const addresses = page.getByRole("region", { name: "Addresses" });
  await expect(addresses.getByRole("link", { name: "Caddy" })).toBeVisible();
  await expect(addresses.getByRole("link", { name: /Open/ }).first()).toHaveAttribute(
    "href",
    "https://watch.example.com",
  );
  await page.goto("/services/mosquitto");
  await expect(page.getByText("No web address.")).toBeVisible();
});

test("sample data is always labelled as such", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /Sample data/ })).toBeVisible();
});

test("discovering this machine replaces sample data with your systems", async ({
  page,
}, testInfo) => {
  await useScenario(page.request, "fresh");
  await page.goto("/");
  await page.getByRole("link", { name: "Discover this machine" }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await page.getByRole("button", { name: "Scan this machine" }).click();

  await expect(page.getByText("testbox", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Recognised/ })).toContainText("Prowlarr");
  await expect(page.getByRole("region", { name: /^Stopped/ })).toBeVisible();
  // Stopped containers start unticked.
  await expect(page.getByRole("checkbox", { name: /Include Audiobookshelf/ })).not.toBeChecked();

  await page.getByLabel("Name for mystery-app").fill("Shortlist");
  await page.getByRole("checkbox", { name: "Include Sonarr" }).uncheck();

  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/discover-results.png`,
    fullPage: true,
  });

  // After adopting, Hearth offers to find the apps' keys. (The keys found are stood in for
  // here: the test machine has no real app settings files.)
  await page.route("**/api/credentials", (route) =>
    route.fulfill({
      json: [
        {
          serviceId: "s1",
          serviceName: "Prowlarr",
          state: "missing",
          importSources: [{ id: "app-settings-file", description: "" }],
        },
        { serviceId: "s2", serviceName: "Shortlist", state: "missing", importSources: [] },
      ],
    }),
  );
  await page.route("**/api/credentials/find-keys", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            serviceId: "s1",
            serviceName: "Prowlarr",
            imported: true,
            note: 'Imported as "Prowlarr API key".',
          },
          {
            serviceId: "s2",
            serviceName: "Shortlist",
            imported: false,
            note: "No key in a settings file Hearth can read: add it by hand in Secure Vault.",
          },
        ],
        credentials: [],
      },
    }),
  );
  await page.getByRole("button", { name: /^Adopt \d+ services$/ }).click();
  const offer = page.getByTestId("keys-offer");
  await expect(offer).toContainText("Want me to find your API keys?");
  await expect(offer).toContainText("1 of your apps keep an API key");
  await expect(offer).toContainText("Prowlarr");
  await offer.getByRole("button", { name: "Yes, find my keys" }).click();
  await expect(offer).toContainText("1 key stored.");
  await expect(page.getByTestId("keys-offer-results")).toContainText("Prowlarr: Imported");
  await page.unroute("**/api/credentials");
  await page.unroute("**/api/credentials/find-keys");
  await offer.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: /Sample data/ })).toHaveCount(0);

  await page.goto("/services");
  await expect(page.getByRole("link", { name: "Shortlist", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sonarr", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Prowlarr on your network" })).toHaveAttribute(
    "href",
    "http://10.0.0.5:9696",
  );

  await page.goto("/settings#systems");
  await expect(page.getByRole("region", { name: "Your systems" })).toBeVisible();
  await page.getByRole("tab", { name: "About" }).click();
  await expect(page.getByTestId("audit-row").first()).toContainText(
    "Replaced sample data with your systems",
  );
});

test("going back to sample data needs a second, explicit confirmation", async ({ page }) => {
  const report = await (await page.request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  expect(
    (
      await page.request.post("/api/discovery/adopt", { data: { reportId: report.id, selections } })
    ).ok(),
  ).toBe(true);

  await page.goto("/settings#systems");
  const section = page.getByRole("region", { name: "Your systems" });
  await section.getByRole("button", { name: "Show sample data instead" }).click();
  await expect(section.getByRole("status")).toContainText("Nothing on your machines is affected");
  await section.getByRole("button", { name: "Keep my systems" }).click();
  await expect(section).toBeVisible();

  await section.getByRole("button", { name: "Show sample data instead" }).click();
  await section.getByRole("button", { name: "Replace with sample data" }).click();
  await expect(page.getByRole("link", { name: /Sample data/ }).first()).toBeVisible();
});

test("another machine is added by its address and shown as checked over the network", async ({
  page,
}, testInfo) => {
  const report = await (await page.request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  await page.request.post("/api/discovery/adopt", { data: { reportId: report.id, selections } });

  await page.goto("/discover");
  const form = page.getByRole("region", { name: "Another machine" });
  await form.getByLabel("Address").fill("http://10.0.0.20");
  await form.getByLabel("Name").fill("Windows PC");
  await form.getByRole("button", { name: "Check this machine" }).click();
  await expect(form.getByRole("alert")).toContainText("Enter just the name or IP address");

  await form.getByLabel("Address").fill("10.0.0.20");
  await form.getByRole("button", { name: "Check this machine" }).click();
  await expect(page.getByText("Windows PC", { exact: true })).toBeVisible();
  await expect(page.getByText("Another machine", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Recognised/ })).toContainText(
    "Hearth cannot restart it there",
  );
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/discover-remote.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Adopt 1 service" }).click();
  await page
    .getByTestId("keys-offer")
    .getByRole("button", { name: /Continue|No thanks/ })
    .click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/systems");
  const pc = page.getByRole("article", { name: "Windows PC" });
  await expect(pc).toContainText("Over the network");
  await expect(pc).toContainText("10.0.0.20");
  await expect(page.getByRole("article", { name: "testbox" })).toContainText("This machine");
  expect(await seriousViolations(page)).toEqual([]);
});

test("remember something, change it, find it, and get it back after deleting it", async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  const title = `Move Caddy to Homeserver (${tag})`;
  await page.goto("/memory");
  await page.getByRole("button", { name: "Remember something" }).first().click();
  const form = page.getByRole("dialog", { name: "Remember something" });
  await form.getByLabel("Kind").selectOption("thread");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Details").fill("After the arr stack settles, so nothing breaks twice.");
  await form.getByLabel("Machine").fill("Homeserver");
  await form.getByRole("button", { name: "Remember it" }).click();
  const list = page.getByTestId("memory-list");
  await expect(list.getByText(title)).toBeVisible();

  await list.getByText(title).click();
  const sheet = page.getByRole("dialog", { name: "Memory" });
  await sheet.getByRole("button", { name: "Edit" }).click();
  await page
    .getByRole("dialog", { name: "Edit memory" })
    .getByLabel("Title")
    .fill(`${title}, later`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(sheet).toContainText(`${title}, later`);
  await expect(sheet.getByTestId("memory-history")).toContainText(
    `Title: ${title} → ${title}, later`,
  );
  await sheet.getByRole("button", { name: "Mark done" }).click();
  await expect(sheet.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(sheet.getByTestId("memory-history")).toContainText("Status: open → done");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/screens/${tag}/memory-entry.png`, fullPage: true });
  await page.keyboard.press("Escape");

  await page.getByLabel("Search memories and conversations").fill("arr stack");
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results).toContainText(`${title}, later`);
  await expect(results.locator("mark").first()).toBeVisible();
  await page.getByLabel("Search memories and conversations").fill("");

  await list.getByText(`${title}, later`).click();
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(list.getByText(`${title}, later`)).toHaveCount(0);
  await page.getByRole("radio", { name: "Recently deleted" }).click();
  await page.getByTestId("memory-list").getByText(`${title}, later`).click();
  await sheet.getByRole("button", { name: "Restore" }).click();
  await expect(sheet.getByRole("button", { name: "Edit" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Everything" }).click();
  await expect(page.getByTestId("memory-list").getByText(`${title}, later`)).toBeVisible();
  await page.screenshot({ path: `test-results/screens/${tag}/memory.png`, fullPage: true });
});

test("review imported notes: sorted for you, kept in bulk, corrected one by one", async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  const origin = `/notes/Media ${tag}/STATE.md`;
  const entry = (ref: string, e: Record<string, unknown>, note = "dated section") => ({
    sourceRef: `md:e2e-${tag}-${ref}`,
    origin,
    anchor: ref,
    note,
    payload: {
      kind: "entry",
      entry: { projectName: `Media ${tag}`, happenedAt: "2026-08-20T12:00:00.000Z", ...e },
    },
  });
  const res = await page.request.post("/api/memory/imports", {
    data: {
      batch: `E2E ${tag}`,
      drafts: [
        {
          sourceRef: `md:e2e-${tag}-project`,
          origin,
          anchor: "project",
          note: "project from the file's title",
          payload: { kind: "project", project: { name: `Media ${tag}`, summary: "Plex." } },
        },
        {
          ...entry("elsewhere", { kind: "note", title: `Another file's note (${tag})` }),
          origin: `/notes/Other ${tag}/STATE.md`,
        },
        entry("history", {
          kind: "journal",
          title: `Moved the Plex library to the big disk (${tag})`,
          body: "Copied 4 TB overnight and pointed the Plex library at the new disk.",
        }),
        entry("history-copy", {
          kind: "journal",
          title: `Moved the Plex library to the big disk (${tag})`,
          body: "Copied overnight.",
        }),
        entry(
          "caddy",
          {
            kind: "thread",
            status: "open",
            title: `Move Caddy (${tag})`,
            body: "Once certificates are copied. The admin password is Hunter2! for now.",
          },
          "item in an open-work list",
        ),
        entry(
          "stale",
          { kind: "thread", status: "open", title: `Stale idea (${tag})` },
          "item in an open-work list",
        ),
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);

  await page.goto("/memory");
  await page.getByRole("link", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Review your notes" })).toBeVisible();
  // Only this file, so other runs' drafts stay out of the counts.
  await page.getByLabel("Source").selectOption({ label: `Media ${tag} / STATE.md` });
  const cards = page.getByRole("navigation", { name: "Sorted for review" });
  await expect(cards).toContainText("2Ready to keep");
  await expect(cards).toContainText("2Worth a look");
  await expect(cards).toContainText("1Probably leave out");
  const skip = page.getByRole("region", { name: "Probably leave out" });
  await expect(skip).toContainText("Same as another draft");

  // Open one, see why it was sorted there, correct it, keep it.
  await page.getByText(`Move Caddy (${tag})`, { exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Imported draft" });
  await expect(sheet.getByTestId("draft-reasons")).toContainText("check it is still open");
  await expect(sheet.getByTestId("draft-reasons")).toContainText("replaced with [hidden]");
  await expect(sheet.getByLabel("Details")).toHaveValue(/password is \[hidden\]/);
  await sheet.getByLabel("Title").fill(`Move Caddy to Homeserver (${tag})`);
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/screens/${tag}/import-draft.png`, fullPage: true });
  await sheet.getByRole("button", { name: "Save with my changes" }).click();
  await expect(sheet).toHaveCount(0);
  await page.screenshot({ path: `test-results/screens/${tag}/import-review.png`, fullPage: true });

  // The duplicate goes in one step, the confident ones in another.
  await skip.getByRole("button", { name: "Leave out" }).click();
  await skip.getByRole("button", { name: "Yes" }).click();
  const ready = page.getByRole("region", { name: "Ready to keep" });
  await ready.getByRole("button", { name: "Keep all 2" }).click();
  await ready.getByRole("button", { name: "Yes" }).click();
  await expect(cards).toContainText("0Ready to keep");

  // Pick by hand: select the stale idea and leave it out from the selection bar.
  await page.getByRole("checkbox", { name: `Select “Stale idea (${tag})”` }).check();
  const bar = page.getByRole("region", { name: "Selected drafts" });
  await expect(bar).toContainText("1 selected");
  await bar.getByRole("button", { name: "Leave out" }).click();
  await expect(page.getByText("Nothing waiting")).toBeVisible();

  await page.getByRole("radio", { name: /Left out/ }).click();
  await page.getByText(`Stale idea (${tag})`, { exact: true }).click();
  await sheet.getByRole("button", { name: "Reconsider" }).click();
  await page.getByRole("radio", { name: /Waiting/ }).click();
  await expect(page.getByText(`Stale idea (${tag})`, { exact: true })).toBeVisible();

  // Kept ones are memories now, in their project.
  await page.goto("/memory");
  await expect(
    page.getByTestId("memory-list").getByText(`Move Caddy to Homeserver (${tag})`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Projects" }).getByText(`Media ${tag}`, { exact: true }),
  ).toBeVisible();
});

test("Home says what's up, by name, with or without an AI connected", async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  await page.goto("/settings");
  await page.getByLabel("Your name").fill("Sam");
  await page.getByLabel("Your name").press("Enter");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const win = `Every app moved to the new server (${tag})`;
  await page.request.post("/api/memory/entries", {
    data: { kind: "win", title: win, happenedAt: new Date().toISOString() },
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(", Sam.");
  await openBriefing(page);
  const whatsUp = page.getByTestId("whats-up");
  await expect(whatsUp).toContainText(win);
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/screens/${tag}/home-whats-up.png`, fullPage: true });

  // Reaching out is offered, and off until a channel is chosen.
  await page.goto("/notifications");
  await expect(page.getByText("A word from Hearth")).toBeVisible();

  await page.goto("/settings");
  await page.getByLabel("Your name").fill("");
  await page.getByLabel("Your name").press("Enter");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("Sam");
});

test("Ember answers from records without an AI, and never declines as off-topic", async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  const project = `Side project ${tag}`;
  // No AI, whatever an earlier test connected: this is about answering without one.
  await page.request.post("/api/agent/disconnect", { data: {} });
  // From Home: the circle opens the main conversation right there, without leaving Home.
  await page.goto("/");
  await page.getByTestId("cave-hub").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/screens/${tag}/home-hub.png` });
  // Focusing the circle opens the chat with the cursor in its message box.
  await page.getByLabel("Ask about your homelab").click();
  const chat = page.getByRole("region", { name: "Ember" });
  await expect(chat).toBeVisible();
  await expect(chat.getByLabel("Ask Ember")).toBeFocused();
  await chat.getByLabel("Ask Ember").fill("Did my backups finish?");
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chat.getByRole("status").filter({ hasText: "No AI is connected" })).toBeVisible();
  const answer = chat.getByTestId("answer").last();
  await expect(answer).toContainText("From Hearth's records");
  await expect(answer).toContainText(/backup/i);
  await answer.getByText(/^Evidence/).click();
  await expect(answer.getByTestId("evidence")).toContainText("Backups");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/screens/${tag}/ask.png`, fullPage: true });
  // Minimizing brings the circle back; the conversation is kept.
  await chat.getByRole("button", { name: "Minimize Ember" }).click();
  await expect(chat).toHaveCount(0);
  await expect(page.getByTestId("cave-hub")).toBeVisible();
  // Reopening shows the same conversation.
  await page.getByTestId("cave-hub").getByRole("button").first().click();
  await expect(page.getByTestId("answer").last()).toContainText(/backup/i);
  await chat.getByRole("button", { name: "Minimize Ember" }).click();

  // Ember looks after whatever you ask (11-13: the "What it looks after" list is gone).
  await page.goto("/settings#cave");
  await expect(page.getByRole("region", { name: "Ember: what it looks after" })).toHaveCount(0);
  await expect(page.getByTestId("ai-budget")).toContainText("no daily limit");
  await page.screenshot({ path: `test-results/screens/${tag}/cave-settings.png`, fullPage: true });

  await page.goto("/ask");
  await page.getByLabel("Ask Ember").fill(`Work on my ${project} login page`);
  await page.getByRole("button", { name: "Send" }).click();
  // Work outside the homelab is answered, never refused (10-29).
  await expect(page.getByTestId("answer").last()).toBeVisible();
  await expect(page.getByTestId("answer").last()).not.toContainText("Outside what I look after");

  // Earlier conversations are a tap away.
  await page.getByRole("button", { name: "Earlier conversations" }).click();
  await expect(page.getByRole("dialog", { name: "Earlier conversations" })).toContainText(
    "Ember continues this one",
  );
  await page.keyboard.press("Escape");
});

test("a backup can be run from Settings and reports how it went", async ({ page }) => {
  await page.goto("/settings#backups");
  const section = page.getByRole("region", { name: "Backups" });
  await section.getByRole("button", { name: "Back up now" }).click();
  await expect(section.getByTestId("backup-status")).toContainText("Backed up");
  await expect(section).toContainText("Not set up");
  expect(await seriousViolations(page)).toEqual([]);
});

test("the Storage address opens Storage & Files, whose file manager browses, sorts, and inspects", async ({
  page,
}, testInfo) => {
  await page.goto("/storage");
  await expect(page).toHaveURL(/tool(%3A|:)storage/);
  const panel = page.getByTestId("storage-center");
  await panel.getByRole("tab", { name: "Files" }).click();
  const fm = panel.getByTestId("file-manager");
  await fm.getByRole("group", { name: "Drives" }).getByRole("button", { name: "Movies" }).click();
  await expect(fm.getByTestId("file-row").first()).toBeVisible();
  // Sort by size, largest first.
  await fm.getByRole("button", { name: "Sort by Size" }).click();
  await fm.getByRole("button", { name: /Metropolis \(1927\)/ }).click();
  await expect(fm.getByRole("navigation", { name: "Folder path" })).toContainText(
    "Metropolis (1927)",
  );
  await fm.getByTestId("file-row").filter({ hasText: ".mkv" }).first().click();
  await expect(fm.getByTestId("file-details")).toContainText("bytes)");
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/storage-files.png`,
  });
  // Back returns to where you were.
  await fm.getByRole("button", { name: "Back" }).click();
  await expect(fm.getByRole("navigation", { name: "Folder path" })).not.toContainText("Metropolis");
});

test("a real folder: browsed, searched, previewed and downloaded; secrets never shown", async ({
  page,
}) => {
  // Adopt the synthetic machine first: real folders need your own systems.
  const report = await (await page.request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  expect(
    (
      await page.request.post("/api/discovery/adopt", { data: { reportId: report.id, selections } })
    ).ok(),
  ).toBe(true);

  const dir = path.join(mkdtempSync(path.join(tmpdir(), "dc-e2e-")), "Films");
  // Its own title: desktop and mobile share one server, and each sees the other's files.
  const movie = `Big Movie ${Math.random().toString(36).slice(2, 6)} (2020)`;
  mkdirSync(path.join(dir, movie), { recursive: true });
  writeFileSync(path.join(dir, movie, `${movie}.mkv`), Buffer.alloc(1_500_000));
  writeFileSync(path.join(dir, movie, "movie.nfo"), "Title: Big Movie\napikey=abc123\n");
  writeFileSync(path.join(dir, "server.key"), "PRIVATE");
  writeFileSync(path.join(dir, "config.xml"), "<ApiKey>secret</ApiKey>");
  const added = await page.request.post("/api/storage/locations", { data: { path: dir } });
  expect(added.ok(), await added.text()).toBe(true);
  const id = ((await added.json()) as { id: string }).id;
  try {
    await page.goto("/?panels=tool%3Astorage%40files&focus=tool%3Astorage");
    const fm = page.getByTestId("file-manager");
    await fm.getByRole("group", { name: "Drives" }).getByRole("button", { name: "Films" }).click();
    const rows = fm.getByTestId("file-row");
    await expect(rows.filter({ hasText: movie })).toBeVisible();
    await expect(rows.filter({ hasText: "config.xml" })).toBeVisible();
    await expect(rows.filter({ hasText: "server.key" })).toHaveCount(0);
    await expect(fm).toContainText("hidden (secrets)");
    // Settings files are listed but never opened.
    await rows.filter({ hasText: "config.xml" }).click();
    await expect(fm.getByTestId("file-details")).toContainText("API keys");
    await expect(fm.getByTestId("file-download")).toHaveCount(0);
    // Into the folder, a text preview with keys redacted, and the real size.
    await rows.filter({ hasText: movie }).click();
    await rows.filter({ hasText: "movie.nfo" }).click();
    await expect(fm.getByTestId("file-preview")).toContainText("Title: Big Movie");
    await expect(fm.getByTestId("file-preview")).not.toContainText("abc123");
    await rows.filter({ hasText: ".mkv" }).click();
    await expect(fm.getByTestId("file-details")).toContainText("1,500,000 bytes");
    const download = await page.request.get(
      (await fm.getByTestId("file-download").getAttribute("href")) ?? "",
    );
    expect(download.status()).toBe(200);
    expect((await download.body()).length).toBe(1_500_000);
    // Search below a folder by name.
    await fm.getByRole("button", { name: "Up one folder" }).click();
    await fm.getByLabel("Search this folder and everything below").fill("big movie");
    await fm.getByLabel("Search this folder and everything below").press("Enter");
    await expect(fm.getByTestId("file-search")).toContainText(`${movie}.mkv`);
    // Recently Added: the new movie, its path and size, and Open in folder lands on it.
    await page.getByRole("tab", { name: "Recently Added" }).click();
    const added = page.getByTestId("storage-added");
    await added.getByRole("button", { name: "Everything" }).click();
    await added.getByLabel("Added within").selectOption("90");
    await added.getByTestId("storage-added-check").click();
    // A folder seen for the first time: its files were already there, shown by their date.
    await added.getByTestId("storage-added-before").check();
    const row = added.getByTestId("storage-added-file").filter({ hasText: `${movie}.mkv` });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Films");
    await row.getByTestId("storage-added-open").click();
    await expect(page.locator('[data-testid="file-row"][data-highlight="true"]')).toContainText(
      `${movie}.mkv`,
    );
    // Paths cannot leave the drive.
    expect(
      (await page.request.get(`/api/files/list?root=${id}&path=..%2F..`)).status(),
    ).toBeGreaterThanOrEqual(400);
    // Changes are plans you confirm: rename the movie, then make a folder beside it.
    const fm2 = page.getByTestId("file-manager");
    await fm2
      .getByTestId("file-row")
      .filter({ hasText: `${movie}.mkv` })
      .click();
    const changes = fm2.getByTestId("file-changes");
    await changes.locator("summary").click();
    await changes.getByTestId("file-change-name").fill(`${movie} Remux.mkv`);
    await changes.getByTestId("file-change-plan").click();
    await expect(changes.getByTestId("panel-change")).toContainText("Rename");
    await changes.getByTestId("panel-confirm").click();
    await expect(changes.getByTestId("panel-done")).toContainText("Renamed", { timeout: 15_000 });
    await expect(
      fm2.getByTestId("file-row").filter({ hasText: `${movie} Remux.mkv` }),
    ).toBeVisible();
    await fm2.getByTestId("file-new-folder").click();
    const box = fm2.getByTestId("file-new-folder-box");
    await box.getByTestId("file-new-folder-name").fill("Extras");
    await box.getByRole("button", { name: "Review" }).click();
    await box.getByTestId("panel-confirm").click();
    await expect(fm2.getByTestId("file-row").filter({ hasText: "Extras" })).toBeVisible({
      timeout: 15_000,
    });
    // Nothing is ever replaced: renaming onto an existing name is refused when planned.
    const clash = await page.request.post("/api/jobs", {
      data: {
        title: "Clash",
        steps: [
          {
            kind: "file-manage",
            serviceId: "this-host",
            params: { op: "rename", root: id, path: `${movie}/movie.nfo`, name: "Extras" },
          },
        ],
      },
    });
    expect(((await clash.json()) as { status: string }).status).toBe("refused");
  } finally {
    await page.request.delete(`/api/storage/locations/${id}`);
  }
});

async function seriousViolations(page: Page) {
  // Let sheet and page transitions finish so colours are measured at rest.
  await page.waitForTimeout(400);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Two failed checks in a row confirm a practice failure and start the response. */
async function confirmPracticeFailure(page: Page, serviceId: string, button: string) {
  await page.goto(`/services/${serviceId}`);
  await page.getByRole("button", { name: button }).click();
  await expect(page.getByTestId("last-check")).toContainText("failed 1 time in a row");
  await page.getByRole("button", { name: "Run health check" }).click();
}

test("practice: a failure is confirmed, repaired automatically, and verified", async ({
  page,
}, testInfo) => {
  await confirmPracticeFailure(page, "jellyfin", "Make it fail");

  // Media servers are set to Fix automatically: restart, then Hearth's own check.
  const actions = page.getByTestId("recent-actions");
  await expect(actions).toContainText("Restart the Jellyfin container", { timeout: 20_000 });
  await expect(actions).toContainText("Done", { timeout: 20_000 });
  await expect(actions).toContainText("Jellyfin is back");
  await expect(page.getByTestId("last-check")).toContainText("is responding");

  await page.getByRole("link", { name: "Jellyfin stopped responding" }).first().click();
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText("Diagnosis: The container is running");
  await expect(timeline).toContainText(
    "Restart the Jellyfin container. Allowed: Media servers is set to Fix automatically.",
  );
  await expect(timeline).toContainText("Health check passed");
  await expect(page.getByText("Fixed automatically")).toBeVisible();
  await page.waitForTimeout(400); // page fade-in
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/incident-auto-fixed.png`,
    fullPage: true,
  });

  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Nothing requires your attention.");
  await openBriefing(page);
  await expect(page.getByRole("region", { name: "Recent activity" })).toContainText(
    "Jellyfin fixed automatically",
  );
});

test("practice: when a restart does not help, it escalates to you", async ({ page }) => {
  await confirmPracticeFailure(page, "jellyfin", "Fail so a restart won't help");
  const actions = page.getByTestId("recent-actions");
  await expect(actions).toContainText("Did not work", { timeout: 20_000 });

  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("One matter needs your attention.");
  await openAlerts(page);
  await page
    .getByRole("region", { name: "Requires your attention" })
    .getByRole("link", { name: /Jellyfin stopped responding/ })
    .click();
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText(
    "The restart did not fix it. Waiting for you.",
  );

  // Fixed by other means: it recovers on its own and closes.
  await page.goto("/services/jellyfin");
  await page.getByRole("button", { name: "Back to normal" }).click();
  await expect(page.getByTestId("last-check")).toContainText("is responding");
  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Nothing requires your attention.");
  await openBriefing(page);
  await expect(page.getByRole("region", { name: "Recent activity" })).toContainText(
    "Jellyfin recovered on its own",
  );
});

test("practice: Ask before fixing proposes a repair and runs it once you approve", async ({
  page,
}, testInfo) => {
  await confirmPracticeFailure(page, "caddy", "Make it fail");
  await page.goto("/");
  await expect(page.getByTestId("headline")).not.toHaveText("Nothing requires your attention.", {
    timeout: 20_000,
  });
  await openAlerts(page);
  await page
    .getByRole("region", { name: "Requires your attention" })
    .getByRole("link", { name: /Caddy stopped responding/ })
    .click({ timeout: 20_000 });
  await expect(page.getByText("Proposed repair")).toBeVisible();
  await expect(
    page.getByText("Restart the Caddy container, then check it is working again."),
  ).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/incident-proposed.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Approve repair" }).click();
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText("Health check passed", { timeout: 20_000 });
  await expect(timeline).toContainText("verified by Hearth's own check");
  await expect(page.getByText("Resolved by you")).toBeVisible();
});

test("a service page shows what Hearth read inside the app", async ({ page }, testInfo) => {
  await useScenario(page.request, "attention");
  await page.request.post("/api/monitor/run", { data: {} });
  await page.goto("/services/prowlarr");
  const inside = page.getByRole("region", { name: "Inside Prowlarr" });
  await expect(inside.getByTestId("app-health")).toContainText("Problems inside the app");
  await expect(inside).toContainText("Indexer Alpha is failing");
  await expect(inside).toContainText("never answered with a restart");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/inside-app.png`,
    fullPage: true,
  });
  await inside.getByRole("button", { name: "Read it now" }).click();
  await expect(inside.getByTestId("app-health")).toContainText("read");
});

test("a job is planned, reviewed, approved once, and carried out step by step", async ({
  page,
}, testInfo) => {
  await useScenario(page.request, "calm");
  await page.goto("/jobs");
  await page.getByRole("button", { name: "Plan a job" }).click();
  const form = page.getByRole("form", { name: "Plan a job" });
  await form.getByLabel("Title").fill("Refresh Jellyfin");
  await form.getByLabel("Step 1: service").selectOption({ label: "Jellyfin" });
  await form.getByRole("button", { name: "Add a step" }).click();
  await form.getByLabel("Step 2: what").selectOption("restart-container");
  await form.getByRole("button", { name: "Review the plan" }).click();

  await expect(page).toHaveURL(/\/jobs\/[0-9a-f-]+$/);
  await expect(page.getByText("Awaiting your approval")).toBeVisible();
  await expect(page.getByTestId("job-approval-expiry")).toContainText("Can be approved until");
  const steps = page.getByTestId("job-steps");
  await expect(steps).toContainText("Run the health check for Jellyfin");
  await expect(steps).toContainText("Restart the Jellyfin container");
  await expect(steps).toContainText("Nothing to undo: a restart changes no settings or data.");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/job-review.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Approve and run" }).click();
  await expect(page.getByTestId("job-summary")).toHaveText("All 2 steps done and verified.", {
    timeout: 30_000,
  });
  await expect(steps).not.toContainText("Waiting");
  // A notice says it finished (the same appears wherever you are in Hearth).
  await expect(page.getByTestId("plan-notices")).toContainText("Plan finished: Refresh Jellyfin", {
    timeout: 10_000,
  });
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/job-done.png`,
    fullPage: true,
  });
  await page.goto("/jobs");
  await expect(page.getByRole("link", { name: "Refresh Jellyfin" }).first()).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("practice: a broken dependency is fixed first, and the service recovers untouched", async ({
  page,
}, testInfo) => {
  await page.goto("/services/tautulli");
  await page.getByRole("button", { name: "Break what it depends on" }).click();
  await expect(page.getByTestId("last-check")).toContainText("its requests are failing");
  // A second pass of every check confirms both Plex and Tautulli.
  expect((await page.request.post("/api/monitor/run", { data: {} })).status()).toBe(200);

  await page.goto("/incidents");
  await page.getByRole("radio", { name: /Resolved/ }).click();
  const tautulli = page.getByRole("link", { name: /Tautulli is failing/ });
  await expect(tautulli).toBeVisible({ timeout: 20_000 });
  await tautulli.click();
  await expect(page.getByText("Nothing was restarted for Tautulli.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText(
    "Tautulli depends on Plex, which was just repaired.",
  );
  await page.waitForTimeout(400); // page fade-in
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/incident-dependency.png`,
    fullPage: true,
  });

  await page.goto("/");
  await expect(page.getByTestId("headline")).toHaveText("Nothing requires your attention.");
  await openBriefing(page);
  await expect(page.getByRole("region", { name: "Recent activity" })).toContainText(
    "Tautulli recovered once Plex was fixed",
  );
});

test("you can restart, test, and read logs from a service page", async ({ page }, testInfo) => {
  await page.goto("/services/sonarr");
  await page.getByRole("button", { name: "Test web address" }).click();
  await expect(page.getByTestId("test-result")).toContainText("Answered in");

  await page.getByRole("button", { name: "View recent logs" }).click();
  const logs = page.getByRole("dialog", { name: "Recent logs for Sonarr" });
  await expect(logs.getByTestId("log-lines")).toContainText("Starting Sonarr");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/service-logs.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Restart", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Restart Sonarr" });
  await expect(confirm).toContainText("unavailable for a few seconds");
  expect(await seriousViolations(page)).toEqual([]);
  await confirm.getByRole("button", { name: "Restart Sonarr" }).click();
  await expect(confirm).toBeHidden();
  const restart = page
    .getByTestId("recent-actions")
    .getByRole("listitem")
    .filter({ hasText: "Restart the Sonarr container" });
  await expect(restart).toContainText("Done", { timeout: 20_000 });
  await expect(restart).toContainText("Sonarr is back");
  await expect(restart).toContainText("You");

  await page.goto("/settings#about");
  await expect(page.getByTestId("audit-row").first()).toContainText(
    "Verified Sonarr is working after the restart",
  );
});

test("automatic repairs on your own systems are off until you switch them on", async ({ page }) => {
  await page.goto("/autonomy");
  const toggle = page.getByRole("switch", { name: "Automatic repairs on your systems" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText(/wait for your approval instead/)).toBeVisible();
  await toggle.click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.goto("/settings#about");
  await expect(page.getByTestId("audit-row").first()).toContainText(
    "Turned on automatic repairs for your systems",
  );
});

test("monitoring can be tuned in Settings", async ({ page }) => {
  await page.goto("/settings#monitoring");
  await page.getByLabel("Check services").selectOption("300");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.getByLabel("Open an incident after").selectOption("3");
  await page.reload();
  await expect(page.getByLabel("Check services")).toHaveValue("300");
  await expect(page.getByLabel("Open an incident after")).toHaveValue("3");
  await page.request.patch("/api/settings", {
    data: { monitorIntervalSec: 15, failureThreshold: 2 },
  });
});

test.describe("installable app", () => {
  test.use({ serviceWorkers: "allow" });

  test("is installable, opens offline from its own files, and never caches your data", async ({
    page,
    context,
  }) => {
    const manifest = await page.request.get("/manifest.webmanifest");
    expect(manifest.ok()).toBe(true);
    expect(await manifest.json()).toMatchObject({
      name: "Hearth",
      display: "standalone",
      start_url: "/",
    });
    for (const icon of [
      "/icon-192.png",
      "/icon-512.png",
      "/icon-maskable-512.png",
      "/apple-touch-icon.png",
    ]) {
      const res = await page.request.get(icon);
      expect(res.ok(), icon).toBe(true);
      expect(res.headers()["content-type"], icon).toContain("image/png");
    }

    await page.goto("/");
    await expect(page.getByTestId("headline")).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // Load once more under the worker's control so the page's files are in its cache.
    await page.reload();
    await expect(page.getByTestId("headline")).toBeVisible();
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const k of keys) {
        for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
      }
      return urls;
    });
    expect(cached).toContain("/");
    expect(cached.some((u) => u.startsWith("/assets/"))).toBe(true);
    expect(cached.filter((u) => u.startsWith("/api/"))).toEqual([]);

    // Offline: the app still opens, and says it cannot reach Hearth.
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByText(/did not respond|could not reach|unreachable/i).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    await context.setOffline(false);
  });
});

test("command center: a project opens beside Ember, and closing returns to the hub", async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  await useScenario(page.request, "calm");
  const created = await page.request.post("/api/projects", {
    data: {
      name: `Audit public servers ${tag}`,
      summary: "Check external access and certificates",
      icon: "shield",
      phase: "in-progress",
      related: [{ kind: "service", id: "caddy" }],
    },
  });
  expect(created.ok()).toBe(true);
  const project = (await created.json()) as { id: string; name: string };

  await page.goto("/");
  await page.getByRole("link", { name: new RegExp(`^${project.name}`) }).click();
  await expect(page).toHaveURL(new RegExp(`[?]project=${project.id}`));
  const ws = page.getByTestId("project-workspace");
  await expect(ws.getByRole("heading", { name: project.name })).toBeVisible();
  await expect(ws).toContainText("Check external access and certificates");
  await expect(ws.getByRole("link", { name: /Caddy/ })).toBeVisible();

  // Tasks are kept with the project.
  await ws.getByRole("tab", { name: "Tasks" }).click();
  await ws.getByLabel("New task").fill("Verify TLS certificates");
  await ws.getByRole("button", { name: "Add" }).click();
  await expect(ws.getByRole("list", { name: "Tasks" })).toContainText("Verify TLS certificates");
  await ws.getByRole("button", { name: 'Mark "Verify TLS certificates" done' }).click();
  await expect(
    ws.getByRole("button", { name: 'Mark "Verify TLS certificates" not done' }),
  ).toBeVisible();

  // Ember stays available and knows what is open.
  if (tag === "mobile") await page.getByTestId("carousel-ember").click();
  await expect(page.getByTestId("cave-focus")).toContainText(`About: ${project.name}`);
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/screens/${tag}/project-split.png`, fullPage: true });

  // A refresh lands in the same place, on the same tab.
  await page.reload();
  if (tag === "mobile") await showOnPhone(page, project.name);
  await expect(
    page.getByTestId("project-workspace").getByRole("tab", { name: "Tasks" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: `Close ${project.name}` }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("cave-hub")).toBeVisible();
});

test("command center: a service opens beside Ember with live and recorded facts", async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  await useScenario(page.request, "calm");
  await page.goto("/");
  if (tag === "desktop") {
    const systems = page.getByTestId("systems-list");
    await systems.getByLabel("Filter services").fill("jelly");
    await systems.getByRole("link", { name: "Jellyfin" }).click();
  } else {
    await page.goto("/?service=jellyfin");
  }
  const ws = page.getByTestId("service-workspace");
  await expect(ws.getByRole("heading", { name: "Jellyfin" })).toBeVisible();
  // Jellyfin's panel opens on Home (11-21): its facts are on Overview.
  await ws.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(ws.getByTestId("service-state")).toHaveText("Running");
  await expect(ws).toContainText("Recorded");
  await expect(ws.getByTestId("service-runtime")).toContainText(
    "Sample data has no live containers",
  );
  await openHearthTool(ws, "Health");
  await expect(ws).toContainText("Hearth's own check");
  await openHearthTool(ws, "Logs");
  await expect(ws.getByTestId("service-logs")).toContainText("Starting Jellyfin");
  await openHearthTool(ws, "Files");
  await expect(ws).toContainText("not available yet");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/screens/${tag}/service-split.png`, fullPage: true });
  if (tag === "mobile") await page.getByTestId("carousel-ember").click();
  await expect(page.getByTestId("cave-focus")).toContainText("About: Jellyfin");
  await page.getByRole("button", { name: "Stop asking about Jellyfin" }).click();
  await expect(page.getByTestId("cave-focus")).toHaveCount(0);
});

test("service tabs: logs by time range and search, restarts and trends on Health, one History timeline, each with Ask", async ({
  page,
}, testInfo) => {
  await useScenario(page.request, "calm");
  await page.goto("/?service=jellyfin");
  const ws = page.getByTestId("service-workspace");
  await openHearthTool(ws, "Logs");
  const tab = ws.getByTestId("logs-tab");
  await expect(ws.getByTestId("service-logs")).toContainText("Starting Jellyfin");
  await tab.getByRole("radio", { name: "6 hours" }).click();
  await tab.getByTestId("logs-filter").fill("Starting");
  await tab.getByRole("button", { name: "Search" }).click();
  await expect(tab.getByTestId("logs-summary")).toContainText('1 containing "Starting"');
  await expect(ws.getByTestId("service-logs")).toContainText("Starting Jellyfin");
  await tab.getByRole("radio", { name: "Custom" }).click();
  await expect(tab.getByTestId("logs-from")).toBeVisible();
  await tab.getByRole("radio", { name: "6 hours" }).click();
  const asked = page.waitForRequest(
    (r) => r.url().includes("/api/agent/conversations") && r.method() === "POST",
  );
  await tab.getByTestId("logs-ask").click();
  expect(JSON.parse((await asked).postData() ?? "{}").text).toBe(
    `Look at Jellyfin's logs from the last 6 hours containing "Starting", tell me what's going on, and fix it if something needs fixing.`,
  );
  if (testInfo.project.name === "mobile") await showOnPhone(page, "Jellyfin");

  // Running fine: nothing to ask about.
  await ws.getByRole("tab", { name: "Overview" }).click();
  await expect(ws.getByTestId("service-ask-trouble")).toHaveCount(0);
  await openHearthTool(ws, "Health");
  await expect(ws.getByTestId("health-ask")).toBeVisible();
  await expect(ws.getByTestId("restart-history")).toContainText("Restarts and stops");
  await expect(ws.getByTestId("resource-trends")).toContainText("Resource use over time");

  await page.goto("/?service=prowlarr");
  const prowlarr = page.getByTestId("service-workspace");
  await openHearthTool(prowlarr, "History");
  const history = prowlarr.getByTestId("history-tab");
  await expect(history.getByRole("radiogroup", { name: "Show" })).toBeVisible();
  await expect(history.locator('[data-kind="incident"]').first()).toContainText(
    "Indexer searches failing in Prowlarr",
  );
  await history.getByRole("radio", { name: /^Problems/ }).click();
  await history.getByRole("radio", { name: /^All/ }).click();
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("history.png"), fullPage: false });
});

test("command center: you stop a service on request and start it again", async ({ page }) => {
  await useScenario(page.request, "calm");
  await page.goto("/?service=jellyfin");
  const ws = page.getByTestId("service-workspace");
  await expect(ws.getByTestId("service-state")).toHaveText("Running");
  // Jellyfin's panel opens on Home (11-21): Stop is on Overview.
  await ws.getByRole("tab", { name: "Overview", exact: true }).click();
  await ws.getByRole("button", { name: "Stop", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Stop Jellyfin" });
  await expect(sheet).toContainText("It stays off");
  await sheet.getByRole("button", { name: "Stop Jellyfin" }).click();
  await expect(ws.getByTestId("service-state")).toHaveText("Stopped on request");
  await expect(ws.getByRole("button", { name: "Restart" })).toHaveCount(0);
  await openHearthTool(ws, "Health");
  await expect(ws.getByTestId("stopped-note")).toContainText("will not restart it");
  await ws.getByRole("tab", { name: "Overview" }).click();

  await ws.getByRole("button", { name: "Start", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Start Jellyfin" })
    .getByRole("button", { name: "Start Jellyfin" })
    .click();
  await expect(ws.getByTestId("service-state")).toHaveText("Running");
  await expect(ws.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
});

test("Ember shows the steps it actually took to answer", async ({ page }) => {
  await useScenario(page.request, "calm");
  await page.goto("/ask");
  await page.getByLabel("Ask Ember").fill("How are my servers?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByTestId("answer").last()).toBeVisible();
  const progress = page.getByTestId("cave-progress").last();
  // Answered: folded into one line, opened on request.
  await progress.getByRole("button", { name: /2 steps/ }).click();
  const steps = progress.getByRole("list", { name: "What Ember did" });
  await expect(steps).toContainText("Gathered what Hearth knows");
  await expect(steps).toContainText("Answered from Hearth's records");
  await expect(steps).not.toContainText("still working");
});

test("a project keeps its own conversation beside the main one", async ({ page }, testInfo) => {
  const tag = testInfo.project.name;
  await useScenario(page.request, "calm");
  const project = (await (
    await page.request.post("/api/projects", { data: { name: `Tidy media ${tag}` } })
  ).json()) as { id: string; name: string };
  await page.goto(`/?project=${project.id}`);
  if (tag === "mobile") await page.getByTestId("carousel-ember").click();
  await expect(page).toHaveURL(tag === "mobile" ? /view=chat/ : /project=/);
  // The desk (desktop) names each open project's conversation; one panel at a time says "this".
  const own = page.getByRole("button", {
    name: tag === "desktop" ? `${project.name} conversation` : "This project's conversation",
  });
  const mainChat = page.getByRole("button", { name: "Current conversation" });
  await expect(own).toHaveAttribute("aria-pressed", "true");
  const thread = page.getByTestId("cave-thread");
  const words = `What is left in ${project.name}?`;
  await page.getByLabel("Ask Ember").fill(words);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(thread).toContainText(words);
  await expect(page.getByTestId("answer").last()).toBeVisible();

  await mainChat.click();
  await expect(mainChat).toHaveAttribute("aria-pressed", "true");
  await expect(thread).not.toContainText(words);
  await own.click();
  await expect(thread).toContainText(words);

  // Reload and full screen keep the same project and conversation.
  await page.reload();
  await expect(page.getByTestId("cave-thread")).toContainText(words);
  // A phone: full screen is in the chat's menu (11-16).
  if (test.info().project.name === "mobile") await page.getByTestId("chat-menu").click();
  await page.getByRole("link", { name: "Open full screen" }).click();
  await expect(page).toHaveURL(new RegExp(`/ask/.+[?]project=${project.id}`));
  await expect(page.getByTestId("cave-thread")).toContainText(words);
  await expect(page.getByTestId("cave-focus")).toContainText(`About: ${project.name}`);
  await page.getByTestId("ask-back").click();
  await expect(page).toHaveURL(new RegExp(`project(=|%3A)${project.id}`));
  await expect(page.getByTestId("cave-thread")).toContainText(words);
});

test("a tablet keeps the split screen; a narrow screen takes turns", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Sets its own window sizes.");
  await useScenario(page.request, "calm");
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/?service=jellyfin");
  await expect(page.getByTestId("service-workspace")).toBeVisible();
  await expect(page.getByRole("region", { name: "Ember" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Show" })).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
  await expect(page.getByTestId("tab-bar")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(820);
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: "test-results/screens/tablet/service-split.png" });

  // A phone (under 600px; tablets from 600px get the desktop layout, 11-15): Ember and the panel
  // take turns in the ring (PanelCarousel).
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.getByTestId("carousel-current")).toContainText("Jellyfin");
  await expect(page.getByTestId("service-workspace")).toBeVisible();
  await expect(page.getByRole("region", { name: "Ember" })).toBeHidden();
  await page.getByTestId("carousel-ember").click();
  await expect(page.getByRole("region", { name: "Ember" })).toBeVisible();
  await expect(page.getByTestId("cave-focus")).toContainText("About: Jellyfin");
  await expect(page.getByTestId("tab-bar")).toBeVisible();
});

test.describe("desktop desk", () => {
  test.skip(({ isMobile }) => isMobile, "Desktop only.");

  test("several panels beside Ember: open, pin, overflow, close, reload", async ({ page }) => {
    await useScenario(page.request, "calm");
    await page.goto("/");
    const systems = page.getByTestId("systems-list");
    const open = async (name: string) => {
      await systems.getByLabel("Filter services").fill(name);
      await systems.getByRole("link", { name: new RegExp(`${name}$`) }).click();
    };
    await open("Radarr");
    await open("Prowlarr");
    const panels = page.getByTestId("desk-panel");
    await expect(panels).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Ember" })).toBeVisible();
    await expect(page.getByTestId("cave-focus")).toContainText("About: Prowlarr");

    // Pin Radarr, then open more than fit: the new one waits in the queue (11-16, the owner:
    // panels never squeeze or push out what you are looking at); the slide arrow brings it in.
    await page
      .getByRole("region", { name: "Service: Radarr" })
      .getByRole("button", { name: "Pin panel" })
      .click();
    await open("Sonarr");
    await expect(panels).toHaveCount(2);
    await expect(page.getByRole("region", { name: "Service: Radarr" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Service: Prowlarr" })).toBeVisible();
    const strip = page.getByRole("group", { name: "Also open" });
    await expect(strip).toContainText("Sonarr");
    await page.getByTestId("panel-slide-on").click();
    await expect(page.getByRole("region", { name: "Service: Sonarr" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Service: Radarr" })).toBeVisible();
    await expect(strip).toContainText("Prowlarr");
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({ path: "test-results/screens/desktop/desk.png" });

    // Bring Prowlarr back from the strip: the unpinned Sonarr makes way, never the pinned Radarr.
    await strip.getByRole("button", { name: /Prowlarr/ }).click();
    await expect(page.getByRole("region", { name: "Service: Prowlarr" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Service: Radarr" })).toBeVisible();
    await expect(strip).toContainText("Sonarr");

    // The arrangement is in the address: reload keeps it, including the pin.
    await page.reload();
    await expect(panels).toHaveCount(2);
    await expect(
      page
        .getByRole("region", { name: "Service: Radarr" })
        .getByRole("button", { name: "Unpin panel" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Close unpinned" }).click();
    await expect(panels).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Service: Radarr" })).toBeVisible();
    await page.getByRole("button", { name: "Close Radarr" }).click();
    await expect(page.getByTestId("cave-hub")).toBeVisible();
  });

  test("the dock minimizes, widens, and keeps the conversation", async ({ page }) => {
    await useScenario(page.request, "calm");
    await page.goto("/?panels=service:jellyfin");
    await page.getByLabel("Ask Ember").fill("Is this one healthy?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("answer").last()).toBeVisible();
    await page.getByRole("button", { name: "Minimize Ember" }).first().click();
    await expect(page.getByTestId("desk-dock-rail")).toBeVisible();
    await expect(page.getByRole("region", { name: "Service: Jellyfin" })).toBeVisible();
    await page.getByRole("button", { name: "Show Ember" }).click();
    await expect(page.getByTestId("cave-thread")).toContainText("Is this one healthy?");
    await page.getByRole("button", { name: "Widen Ember" }).click();
    await expect(page.getByTestId("desk-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "Show the panels again" }).click();
    await expect(page.getByTestId("desk-panel")).toHaveCount(1);
    await expect(page.getByTestId("cave-thread")).toContainText("Is this one healthy?");
  });

  test("native diagnostics side by side: Radarr's queue and Prowlarr's indexers", async ({
    page,
  }) => {
    await useScenario(page.request, "attention");
    await page.goto("/?panels=service:radarr@diagnostics,service:prowlarr@diagnostics");
    const radarr = page.getByRole("region", { name: "Service: Radarr" });
    const prowlarr = page.getByRole("region", { name: "Service: Prowlarr" });
    await expect(radarr.getByRole("tab", { name: "Diagnostics" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const queue = radarr.getByTestId("diag-queue");
    await expect(queue).toContainText("Example Movie (2024)");
    await expect(queue).toContainText("No files found are eligible for import");
    await expect(queue.getByRole("progressbar").first()).toHaveAttribute("aria-valuenow", "62");
    await expect(radarr.getByTestId("diag-connections")).toContainText("qBittorrent (torrent)");
    await expect(radarr.getByTestId("diag-activity")).toContainText("Download failed");
    // Sample data is never presented as a live read.
    await expect(radarr.getByTestId("diag-app").getByTestId("diag-stamp")).toContainText(
      "Recorded",
    );
    await expect(radarr.getByTestId("diagnostics")).toContainText("Sample data");
    await expect(prowlarr.getByTestId("diag-app")).toContainText("Reporting errors");
    await expect(prowlarr.getByTestId("diag-connections")).toContainText("Indexer Alpha");
    await expect(page.getByRole("region", { name: "Ember" })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({ path: "test-results/screens/desktop/diagnostics.png" });
    // Services without an integration have no Diagnostics tab.
    await page.goto("/?panels=service:plex");
    await expect(
      page.getByRole("region", { name: "Service: Plex" }).getByRole("tab", { name: "Diagnostics" }),
    ).toHaveCount(0);
  });

  test("layouts are saved and restored", async ({ page }) => {
    await useScenario(page.request, "calm");
    // Start with none: another test (devices.spec.ts) saves one of its own.
    const saved = (await (await page.request.get("/api/desk/layouts")).json()) as
      { id: string }[] | { layouts: { id: string }[] };
    for (const l of Array.isArray(saved) ? saved : saved.layouts)
      await page.request.delete(`/api/desk/layouts/${l.id}`);
    await page.goto("/?panels=!service:plex,service:jellyfin@logs");
    await page.getByRole("button", { name: "Layouts" }).click();
    await page.getByLabel("Layout name").fill("Media check");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Saved layouts" });
    await expect(menu.getByRole("list", { name: "Layouts" })).toContainText("Media check");
    await page.keyboard.press("Escape");
    await page.goto("/");
    await page.goto("/?panels=service:caddy");
    await page.getByRole("button", { name: "Layouts" }).click();
    await menu.getByRole("button", { name: "Media check 2 panels" }).click();
    await expect(page.getByRole("region", { name: "Service: Plex" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Service: Jellyfin" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Service: Jellyfin" })
        .getByRole("button", { name: "Hearth: Logs" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Layouts" }).click();
    await menu.getByRole("button", { name: "Delete layout Media check" }).click();
    await expect(menu).toContainText("No saved layouts yet.");
  });
});

test("workspaces: Ember opens a review panel; choices persist, minimize, submit, and close asks first", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "mobile";
  await useScenario(page.request, "calm");
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await page.goto("/");
    await page.locator("#hub-ask").click();
    await page.getByLabel("Ask Ember").fill("Make a test review list of my duplicate movies");
    await page.getByRole("button", { name: "Send" }).click();

    // It opens beside the chat on its own, with a long list that scrolls inside the panel.
    const panel = page.getByTestId("workspace-panel");
    await expect(panel).toBeVisible({ timeout: 25_000 });
    await expect(panel.getByRole("heading", { name: "Duplicate Media Review" })).toBeVisible();
    await expect(page.getByTestId("workspace-progress")).toHaveText("0 of 120 decided");
    await expectNoOverflow(page);
    const rows = page.getByTestId("workspace-row");
    // Only the rows in view are drawn, however long the list.
    expect(await rows.count()).toBeLessThan(80);

    await rows.nth(0).getByRole("button", { name: "Keep" }).click();
    await rows.nth(1).getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");
    await panel.getByPlaceholder("Search").fill("Movie 7");
    await expect(rows.first()).toContainText("Movie 7");
    await panel.getByPlaceholder("Search").fill("");
    await panel.getByRole("button", { name: "Discard 1" }).click();
    await expect(rows).toHaveCount(1);
    await panel.getByRole("button", { name: "All 120" }).click();
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/workspace.png` });

    // A refresh keeps every choice (they are saved on the server as you make them).
    await page.waitForTimeout(700);
    await page.reload();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided", {
      timeout: 15_000,
    });

    // Minimize keeps it; one tap brings it back.
    await page.getByRole("button", { name: "Minimize workspace" }).click();
    await expect(panel).toHaveCount(0);
    const chip = page.getByRole("button", { name: /Duplicate Media Review/ });
    await expect(chip).toContainText("2/120");
    await chip.click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");

    // Submit hands the exact choices to Ember, which reads them back.
    await page.getByRole("button", { name: "Submit decisions" }).click();
    await expect(panel.getByRole("status")).toContainText("Sent");
    if (phone) await page.getByTestId("carousel-ember").click();
    await expect(page.getByTestId("cave-thread")).toContainText(
      "Read your decisions: keep 1, discard 1",
      {
        timeout: 25_000,
      },
    );
    if (phone) await showOnPhone(page, "Duplicate Media Review");

    // X always asks first; Cancel leaves it as it was.
    await page.getByRole("button", { name: "Close and discard workspace" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Close temporary workspace?" });
    await expect(confirm).toContainText("will discard the list and any unsaved selections");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");
    // Already gone (Ember removed it while the panel still showed it): closing still closes it.
    const open = (await (await page.request.get("/api/workspaces?kind=temporary")).json()) as {
      id: string;
    }[];
    for (const w of open) await page.request.delete(`/api/workspaces/${w.id}`);
    await page.getByRole("button", { name: "Close and discard workspace" }).click();
    await confirm.getByRole("button", { name: "Close & Discard" }).click();
    await expect(panel).toHaveCount(0);
    const left = (await (
      await page.request.get("/api/workspaces?kind=temporary")
    ).json()) as unknown[];
    expect(left).toEqual([]);
  } finally {
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("the Forge: a sheet waits for you, save it, close it, find it in the Forge Library, reopen it intact, edit, delete on purpose", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "mobile";
  const name = `Movie duplicates ${testInfo.project.name}`;
  await useScenario(page.request, "calm");
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await page.goto("/");
    await page.locator("#hub-ask").click();
    await page.getByLabel("Ask Ember").fill("Make a test review list of my duplicate movies");
    await page.getByRole("button", { name: "Send" }).click();
    const panel = page.getByTestId("workspace-panel");
    await expect(panel).toBeVisible({ timeout: 25_000 });
    await page.getByTestId("workspace-row").nth(1).getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("1 of 120 decided");
    // It is a Forge sheet, and the chat has a Forge button.
    await expect(page.getByTestId("workspace-kind")).toContainText("The Forge · in progress");
    // Waiting for choices: the top bar says so (wide screens), and the Forge lists it first.
    if (!phone) await expect(page.getByTestId("forge-chip")).toBeVisible({ timeout: 15_000 });

    // Save as a working file: the whole workspace, in a folder.
    await panel.getByRole("button", { name: "Save workspace" }).click();
    let dialog = page.getByRole("dialog", { name: "Save this workspace" });
    await expect(dialog.getByRole("radio", { name: /Working file/ })).toBeChecked();
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel("Folder (optional)").fill("Media cleanup");
    await dialog.getByRole("button", { name: "Save as working file" }).click();
    await expect(page.getByTestId("workspace-notice")).toContainText("Saved in the Forge Library");
    await expect(page.getByTestId("workspace-kind")).toHaveText(
      "The Forge · saved in the Forge Library · Media cleanup",
    );

    // Save as a note too: only a note can be made from a working file.
    await panel.getByRole("button", { name: "Save workspace" }).click();
    dialog = page.getByRole("dialog", { name: "Save this workspace" });
    await expect(dialog.getByRole("radio", { name: /Working file/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save as note" }).click();
    await expect(page.getByTestId("workspace-notice")).toContainText("Saved as a note in Memory");

    // X on a working file closes its view only: no discard question, nothing lost.
    await panel.getByRole("button", { name: "Close workspace", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(panel).toHaveCount(0);

    // It is in the sidebar (desktop) and in the Forge Library, in its folder.
    if (!phone) {
      await page.getByRole("button", { name: "Open The Forge" }).click();
      await expect(page.getByTestId("sidebar-saved")).toContainText(name);
    }
    // The old Saved work address still arrives at the Forge.
    await page.goto("/saved");
    await expect(page).toHaveURL(/\/forge$/);
    await expect(page.getByRole("heading", { name: "The Forge", level: 1 })).toBeVisible();
    await expect(page.getByTestId("forge-intro")).toContainText("Forge sheet");
    await expect(page.getByTestId("forge-example")).toHaveCount(4);
    await expect(page.getByTestId("forge-waiting")).toContainText(name);
    const file = page.getByTestId("working-file").filter({ hasText: name });
    await expect(page.getByRole("region", { name: "Media cleanup" })).toContainText(name);
    await expect(file).toContainText("1 of 120 decided");
    await expectNoOverflow(page);
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole("radio", { name: /^Notes/ }).click();
    const note = page.getByTestId("saved-note").filter({ hasText: name }).first();
    await expect(note).toContainText("From a workspace");
    await note.getByRole("button", { name }).click();
    await expect(page.getByRole("dialog", { name: "Note" })).toContainText(
      "| Movie 1 | copy-720p.mkv | 720p | 2.0 GB | Discard |",
    );
    await page.getByRole("dialog", { name: "Note" }).getByRole("button", { name: "Close" }).click();

    // Edit its details.
    await page.getByRole("radio", { name: /^Library/ }).click();
    await file.getByRole("button", { name: `Edit ${name}` }).click();
    const edit = page.getByRole("dialog", { name: "Edit working file" });
    await edit.getByLabel("Name").fill(`${name} (checked)`);
    await edit.getByRole("button", { name: "Save changes" }).click();
    const renamed = page.getByTestId("working-file").filter({ hasText: `${name} (checked)` });
    await expect(renamed).toBeVisible();

    // Reopen: back beside its conversation, still interactive, choices intact.
    await renamed.getByRole("button", { name: "Open", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: `${name} (checked)` })).toBeVisible();
    await expect(page.getByTestId("workspace-progress")).toHaveText("1 of 120 decided");
    await page.getByTestId("workspace-row").nth(0).getByRole("button", { name: "Keep" }).click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");
    await page.waitForTimeout(700);
    await panel.getByRole("button", { name: "Close workspace", exact: true }).click();

    // The chat's anvil asks for the Forge where the chat has room (a narrow one keeps its typing
    // space): on the Ask page it is there.
    await page.goto("/ask");
    // A phone: under the + beside the box (11-16).
    if (test.info().project.name === "mobile") await page.getByTestId("chat-plus").first().click();
    await expect(page.getByTestId("forge-button").locator("visible=true").first()).toBeVisible();

    // Deleting is its own deliberate step, with its own confirmation.
    await page.goto("/forge");
    await expect(renamed).toContainText("2 of 120 decided");
    await renamed.getByRole("button", { name: `Delete ${name} (checked)` }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete working file?" });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(renamed).toBeVisible();
    await renamed.getByRole("button", { name: `Delete ${name} (checked)` }).click();
    await confirm.getByRole("button", { name: "Delete working file" }).click();
    await expect(renamed).toHaveCount(0);
  } finally {
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("first administrative workflow: Ember investigates, proposes, you approve, it runs, is verified and remembered", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  // Your systems (the synthetic machine), with Sonarr's key allowing approved changes.
  const report = await (await page.request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  await page.request.post("/api/discovery/adopt", { data: { reportId: report.id, selections } });
  const ws = await (await page.request.get("/api/workspace")).json();
  const sonarr = (ws.services as { id: string; name: string }[]).find((s) => s.name === "Sonarr")!;
  const secret = await (
    await page.request.post("/api/vault/secrets", {
      data: {
        name: "Sonarr naming test key",
        kind: "api-key",
        tier: "automation",
        serviceId: sonarr.id,
        value: "e2e-sonarr-naming-key",
        scope: "approved-changes",
      },
    })
  ).json();
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  const naming = async () =>
    (
      (await (await page.request.get("/api/test/fake-apps")).json()) as {
        naming: Record<string, unknown>;
      }
    ).naming;
  try {
    expect((await naming()).renameEpisodes).toBe(false);

    // Discuss: ask in plain words. Ember investigates (reads Sonarr's naming) and recommends.
    await page.goto("/ask");
    await page.getByLabel("Ask Ember").fill("Please turn on episode renaming in Sonarr");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator("main")).toContainText("planned turning it on for your approval", {
      timeout: 25_000,
    });
    // Recommending is not doing: nothing has changed yet.
    expect((await naming()).renameEpisodes).toBe(false);

    // Approve the exact plan.
    await page.goto("/jobs");
    await page.getByRole("link", { name: "Turn on episode renaming in Sonarr" }).first().click();
    await expect(page.getByText("Awaiting your approval")).toBeVisible();
    const steps = page.getByTestId("job-steps");
    await expect(steps).toContainText(`Change "Rename episodes" in Sonarr's naming settings`);
    await expect(steps).toContainText("files already in the library keep their names");
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/naming-review.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Approve and run" }).click();

    // Execute and verify: the result says it was read back, and Sonarr really changed.
    await expect(steps).toContainText("verified by reading Sonarr back", { timeout: 20_000 });
    expect((await naming()).renameEpisodes).toBe(true);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/naming-done.png`,
      fullPage: true,
    });

    // Remember: it's in the journal, and the plan stays in the history.
    const entries = (await (await page.request.get("/api/memory/entries")).json()) as
      { title: string; body?: string }[] | { entries: { title: string; body?: string }[] };
    const list = Array.isArray(entries) ? entries : entries.entries;
    expect(list.some((e) => /Rename episodes/.test(`${e.title} ${e.body ?? ""}`))).toBe(true);
    await page.goto("/jobs");
    await expect(
      page.getByRole("link", { name: "Turn on episode renaming in Sonarr" }).first(),
    ).toBeVisible();
  } finally {
    await page.request.delete(`/api/vault/secrets/${secret.id}`, { timeout: 10_000 });
    await page.request.post("/api/test/fake-apps", { data: { reset: true } });
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("workspace plans: submit makes a frozen plan; editing after it is flagged and replaced; approved items run on their own and report each result", async ({
  page,
}, testInfo) => {
  // A long journey: two plans, an approval, and a run.
  test.setTimeout(120_000);
  const phone = testInfo.project.name === "mobile";
  // Your systems (the synthetic machine), with Sonarr's key allowing approved changes.
  const report = await (await page.request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  expect(
    (
      await page.request.post("/api/discovery/adopt", { data: { reportId: report.id, selections } })
    ).ok(),
  ).toBe(true);
  const ws = await (await page.request.get("/api/workspace")).json();
  const sonarr = (ws.services as { id: string; name: string }[]).find((s) => s.name === "Sonarr")!;
  const secret = await (
    await page.request.post("/api/vault/secrets", {
      data: {
        name: "Sonarr test key",
        kind: "api-key",
        tier: "automation",
        serviceId: sonarr.id,
        value: "e2e-sonarr-test-key",
        scope: "approved-changes",
      },
    })
  ).json();
  await page.request.post("/api/test/fake-apps", { data: { reset: true } });
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  const S = (n: number, q: string) => `/tv/Ghosts (US)/Season 2/Ghosts.S02E0${n}.${q}.mkv`;
  try {
    await page.goto("/");
    await page.locator("#hub-ask").click();
    await page.getByLabel("Ask Ember").fill("Make a test cleanup list of my episodes");
    await page.getByRole("button", { name: "Send" }).click();
    const panel = page.getByTestId("workspace-panel");
    await expect(panel.getByRole("heading", { name: "Episode cleanup" })).toBeVisible({
      timeout: 25_000,
    });
    const row = (n: number, q: string) =>
      page.locator(`[data-testid="workspace-row"][data-item="${S(n, q)}"]`);

    // First decisions: discard E01 and E02, keep E03 and E04; submit.
    await row(1, "1080p").getByRole("button", { name: "Discard" }).click();
    await row(2, "1080p").getByRole("button", { name: "Discard" }).click();
    await row(3, "720p").getByRole("button", { name: "Keep" }).click();
    await row(4, "720p").getByRole("button", { name: "Keep" }).click();
    await page.getByRole("button", { name: "Submit decisions" }).click();
    const plan = page.getByTestId("workspace-plan");
    await expect(page.getByTestId("workspace-plan-status")).toContainText(
      "Waiting for your approval",
      { timeout: 25_000 },
    );
    await expect(row(1, "1080p").getByTestId("item-plan-status")).toHaveText("Planned");
    await expect(row(2, "1080p").getByTestId("item-plan-status")).toHaveText("Planned");
    await expect(row(3, "720p").getByTestId("item-plan-status")).toHaveCount(0);
    const firstJob = (await plan
      .getByRole("link", { name: "Review and approve" })
      .getAttribute("href"))!;

    // Editing after the plan: the plan stays as approved-to-be, and the change is flagged.
    await row(2, "1080p").getByRole("button", { name: "Keep" }).click();
    await row(3, "720p").getByRole("button", { name: "Discard" }).click();
    await row(4, "720p").getByRole("button", { name: "Discard" }).click();
    const revised = page.getByTestId("workspace-revised");
    await expect(revised).toContainText("You changed 3 choices after this plan was made", {
      timeout: 10_000,
    });
    await expect(revised).toContainText("will not change");
    await expect(row(2, "1080p").getByTestId("item-plan-status")).toHaveText("Planned");
    await expectNoOverflow(page);
    expect(await seriousViolations(page)).toEqual([]);

    // A replacement plan for the revised choices replaces the waiting one.
    await revised.getByRole("button", { name: "Ask for a replacement plan" }).click();
    await expect(revised).toHaveCount(0, { timeout: 25_000 });
    await expect(row(3, "720p").getByTestId("item-plan-status")).toHaveText("Planned");
    await expect(row(4, "720p").getByTestId("item-plan-status")).toHaveText("Planned");
    await expect(row(2, "1080p").getByTestId("item-plan-status")).toHaveCount(0);
    const job = (await plan
      .getByRole("link", { name: "Review and approve" })
      .getAttribute("href"))!;
    expect(job).not.toBe(firstJob);
    const old = await (await page.request.get(`/api${firstJob}`)).json();
    expect(old.status).toBe("cancelled");
    expect(old.summary).toContain("Replaced by a plan for your revised decisions");

    // Before approving: E03's file changes on disk, and deleting E04 will fail.
    await page.request.post("/api/test/fake-apps", { data: { resize: { id: 103, gb: 0.9 } } });
    await page.request.post("/api/test/fake-apps", { data: { failDelete: 104 } });
    const back = page.url();
    await plan.getByRole("link", { name: "Review and approve" }).click();
    await expect(page.getByTestId("job-from-workspace")).toContainText("frozen snapshot");
    await expect(page.getByText(`Item: ${S(3, "720p")}`)).toBeVisible();
    await page.getByRole("button", { name: "Approve and run" }).click();
    await expect(page.getByTestId("job-summary")).toContainText(
      "1 of 3 done and verified, 1 skipped (nothing done to them), 1 failed. Verified space freed: 1.5 GB.",
      { timeout: 25_000 },
    );

    // Each item's own result, in the workspace.
    await page.goto(back);
    await expect(page.getByTestId("workspace-plan-status")).toContainText("Partly done", {
      timeout: 15_000,
    });
    await expect(row(1, "1080p").getByTestId("item-plan-status")).toHaveText("Done");
    await expect(row(3, "720p").getByTestId("item-plan-status")).toHaveText("Skipped");
    await expect(row(4, "720p").getByTestId("item-plan-status")).toHaveText("Failed");
    const results = page.getByTestId("workspace-plan-items");
    await expect(results.locator(`[data-item="${S(1, "1080p")}"]`)).toContainText("verified");
    await expect(results.locator(`[data-item="${S(3, "720p")}"]`)).toContainText(
      "not the one approved",
    );
    await expect(results.locator(`[data-item="${S(4, "720p")}"]`)).toContainText(
      "refused to delete it (500)",
    );
    await expect(page.getByTestId("workspace-plan-freed")).toHaveText(
      "Verified space freed: 1.50 GB",
    );
    // Only the one verified delete happened.
    const state = await (await page.request.get("/api/test/fake-apps")).json();
    expect(state.deleted).toEqual([101]);
    if (!phone)
      await page.screenshot({
        path: `test-results/screens/${testInfo.project.name}/workspace-plan.png`,
      });
  } finally {
    // Workspaces follow you across devices: leave none open for the next test.
    const left = (await (
      await page.request.get("/api/workspaces?kind=temporary", { timeout: 10_000 })
    ).json()) as { id: string; title: string }[];
    for (const w of left.filter((x) => x.title === "Episode cleanup"))
      await page.request.delete(`/api/workspaces/${w.id}`, { timeout: 10_000 });
    await page.request
      .post("/api/agent/disconnect", { data: {}, timeout: 10_000 })
      .catch(() => undefined);
    if (secret?.id)
      await page.request.delete(`/api/vault/secrets/${secret.id}`, { timeout: 10_000 });
    await page.request.post("/api/test/fake-apps", { data: { reset: true }, timeout: 10_000 });
  }
});

test("contextual screenshots: capture a panel, an item, or a region; sensitive fields left out; mark up; attach; Ember receives the image", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90_000);
  const tag = testInfo.project.name;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await page.goto(`/?panels=${encodeURIComponent("service:qbittorrent@torrents")}`);
    const dash = page.getByTestId("qb-torrents");
    await expect(dash).toBeVisible({ timeout: 15_000 });
    const panel = page.getByTestId("service-workspace");
    // A password field in the panel is never drawn.
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "password";
      input.value = "never-in-a-capture";
      input.setAttribute("aria-label", "test secret");
      document.querySelector('[data-testid="qb-torrents"]')!.prepend(input);
    });
    const preview = page.getByRole("dialog", { name: "Capture preview" });
    const saveCanvas = async (name: string) => {
      const data = await preview
        .getByTestId("capture-canvas")
        .evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
      const fs = await import("node:fs");
      fs.mkdirSync(`test-results/screens/${tag}`, { recursive: true });
      fs.writeFileSync(
        `test-results/screens/${tag}/${name}.png`,
        Buffer.from(data.split(",")[1]!, "base64"),
      );
      // Not blank: the drawn panel has many different colours.
      const colours = await preview.getByTestId("capture-canvas").evaluate((c) => {
        const cv = c as HTMLCanvasElement;
        const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
        const seen = new Set<number>();
        for (let i = 0; i < d.length; i += 4 * 97)
          seen.add((d[i]! >> 4) * 256 + (d[i + 1]! >> 4) * 16 + (d[i + 2]! >> 4));
        return seen.size;
      });
      expect(colours).toBeGreaterThan(8);
    };

    // Whole panel.
    await panel.getByRole("button", { name: "Capture this panel" }).click();
    await page.getByRole("menuitem", { name: /Whole panel/ }).click();
    await expect(preview).toBeVisible({ timeout: 15_000 });
    await expect(preview.getByTestId("capture-context")).toContainText(
      "The whole panel of qBittorrent",
    );
    await expect(preview.getByTestId("capture-context")).toContainText(
      "1 sensitive item was left out",
    );
    await saveCanvas("capture-panel");
    expect(await seriousViolations(page)).toEqual([]);
    await preview.getByRole("button", { name: "Discard" }).click();
    await expect(preview).toBeHidden();

    // One item.
    await panel.getByRole("button", { name: "Capture this panel" }).click();
    await page.getByRole("menuitem", { name: /Pick an item/ }).click();
    await dash.getByTestId("qb-torrent").filter({ hasText: "The.Orville.S02E04" }).click();
    await expect(preview.getByTestId("capture-context")).toContainText("Item: The.Orville.S02E04");
    await saveCanvas("capture-item");
    await preview.getByRole("button", { name: "Discard" }).click();

    // A region, marked up, then attached.
    await panel.getByRole("button", { name: "Capture this panel" }).click();
    await page.getByRole("menuitem", { name: /Draw a region/ }).click();
    const area = page.getByTestId("capture-region");
    const box = (await area.boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(300, box.width - 20), box.y + 260, { steps: 6 });
    await page.mouse.up();
    await expect(preview.getByTestId("capture-context")).toContainText("A region of qBittorrent");
    const canvas = preview.getByTestId("capture-canvas");
    const cb = (await canvas.boundingBox())!;
    await page.mouse.move(cb.x + 20, cb.y + 20);
    await page.mouse.down();
    await page.mouse.move(cb.x + 80, cb.y + 60, { steps: 4 });
    await page.mouse.up();
    await expect(preview.getByRole("button", { name: "Undo" })).toBeEnabled();
    await saveCanvas("capture-region-marked");
    await expect(preview).toContainText(
      "Attaching sends it to the AI provider only with your next message",
    );
    await preview.getByRole("button", { name: "Attach to conversation" }).click();
    await expect(preview).toBeHidden();

    // It waits in the message box until sent; then Ember receives the image itself.
    if (tag === "mobile") await page.getByTestId("carousel-ember").click();
    const attached = page.getByTestId("cave-attached").first();
    await expect(attached).toContainText("Region of qBittorrent");
    await expect(attached).toContainText("Sent to the AI provider only with this message");
    await page.getByLabel("Ask Ember").first().fill("What do you see in this capture?");
    await page.getByRole("button", { name: "Send" }).first().click();
    await expect(page.getByTestId("cave-thread").first()).toContainText(
      /I received the image \(image\/png, \d+ bytes\): attachment .*a region of the screen, in the qBittorrent panel/,
      { timeout: 25_000 },
    );
    await expect(page.getByTestId("message-images").last().getByRole("img")).toBeVisible();
    await expect(page.getByTestId("cave-attached")).toHaveCount(0);
  } finally {
    await page.request
      .post("/api/agent/disconnect", { data: {}, timeout: 10_000 })
      .catch(() => undefined);
  }
});

test("host administration: switched on and off by you, tiers shown, tools looked up", async ({
  page,
}, testInfo) => {
  const tag = testInfo.project.name;
  await page.goto("/settings#cave");
  const admin = page.getByRole("region", { name: "Ember: administration" });
  await admin.scrollIntoViewIfNeeded();
  const group = admin.getByRole("radiogroup");
  await expect(group.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
  await group.getByRole("radio", { name: "Investigate", exact: true }).click();
  // Switching on reaches the whole machine: a fresh "it's you" when the sign-in is not recent.
  const confirm = admin.getByTestId("host-admin-confirm");
  const investigating = group.getByRole("radio", { name: "Investigate", exact: true });
  await expect(confirm.or(investigating.and(page.locator('[aria-checked="true"]')))).toBeVisible();
  if (await confirm.isVisible()) {
    await confirm.getByPlaceholder("Password").fill(OWNER_PASSWORD);
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
  }
  await expect(group.getByRole("radio", { name: "Investigate", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(admin.getByTestId("host-admin-hint")).toContainText("Read only, automatic");
  await expect(admin).toContainText("Protected");
  // The elevated executor: not set up here, and it says what setting it up takes.
  await expect(admin.getByTestId("elevated-executor")).toContainText("Not set up");
  await expect(admin.getByTestId("elevated-executor")).toContainText("install-elevation.sh");
  // It is kept: a reload shows the same choice.
  await page.reload();
  const again = page.getByRole("region", { name: "Ember: administration" });
  await expect(again.getByRole("radio", { name: "Investigate", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const tools = page.getByRole("region", { name: "Ember: tools and capabilities" });
  await tools.getByRole("button", { name: "Look for tools on this machine" }).click();
  await expect(tools.getByTestId("capability-list")).toContainText("ffprobe");
  expect(await seriousViolations(page)).toEqual([]);
  await page.screenshot({ path: `test-results/screens/${tag}/host-admin.png`, fullPage: true });
  // Switching it off withdraws it at once.
  await again.getByRole("radio", { name: "Off" }).click();
  await expect(again.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "true");
});

test("workspace groups: leaving the command center minimizes everything to one pill; the pill restores it all; several groups; close asks first", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const phone = testInfo.project.name === "mobile";
  // On a phone the saved workspaces are a list behind one button: start with it open.
  await page.addInitScript(() => localStorage.setItem("hearth-dock-open", "1"));
  await useScenario(page.request, "calm");
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  // Arrangements left by earlier tests are kept as pills (as they should be): start without them.
  for (const g of (await (await page.request.get("/api/desk/groups")).json()) as { id: string }[])
    await page.request.delete(`/api/desk/groups/${g.id}`);
  const jobsBefore = ((await (await page.request.get("/api/jobs")).json()) as unknown[]).length;
  const nav = (name: string) =>
    phone
      ? page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name, exact: true })
      : page
          .getByRole("complementary", { name: "Sidebar" })
          .getByRole("link", { name, exact: true });
  try {
    await page.goto("/");
    await page.locator("#hub-ask").click();
    await page.getByLabel("Ask Ember").fill("Make a test review list of my duplicate movies");
    await page.getByRole("button", { name: "Send" }).click();
    const panel = page.getByTestId("workspace-panel");
    await expect(panel).toBeVisible({ timeout: 25_000 });
    const rows = page.getByTestId("workspace-row");
    await rows.nth(0).getByRole("button", { name: "Keep" }).click();
    await rows.nth(1).getByRole("button", { name: "Discard" }).click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");
    await panel.getByPlaceholder("Search").fill("Movie 1");
    await expect(rows.first()).toContainText("Movie 1");

    // On the desk a service panel joins the review (three things open: chat, review, service).
    const ws = (await (await page.request.get("/api/workspace")).json()) as {
      services: { id: string; name: string }[];
    };
    const service = ws.services[0]!;
    if (!phone) {
      const url = new URL(page.url());
      url.searchParams.set("panels", `${url.searchParams.get("panels")},service:${service.id}`);
      await page.goto(url.pathname + url.search);
      await expect(page.getByTestId("desk-panel")).toHaveCount(2);
      await expect(panel.getByPlaceholder("Search")).toHaveValue("Movie 1");
      // Panel sizes: the divider between the two panels, moved with the keyboard.
      const divider = page.getByRole("separator", { name: "Resize panels" });
      await divider.focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
    }
    // Where the list was scrolled.
    await panel.getByPlaceholder("Search").fill("Movie");
    await page.getByTestId("workspace-list").evaluate((el) => (el.scrollTop = 600));
    await page.waitForTimeout(900);
    const sizes = phone
      ? null
      : await page.getByRole("separator", { name: "Resize panels" }).getAttribute("aria-valuenow");

    // Any other page: everything collapses into one pill, on every page.
    await nav(phone ? "Systems" : "Backups").click();
    const dock = page.getByTestId("workspace-dock");
    const pill = dock.getByTestId("workspace-pill");
    await expect(pill).toHaveCount(1);
    await expect(pill).toContainText("Ember · Duplicate Media Review");
    await nav(phone ? "Projects" : "Settings").click();
    await expect(pill).toHaveCount(1);
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/workspace-dock.png`,
    });

    // The pill brings back every panel, the choices, the search, the scroll, and the sizes.
    await pill.getByRole("button", { name: /Bring back/ }).click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");
    await expect(panel.getByPlaceholder("Search")).toHaveValue("Movie");
    await expect
      .poll(() => page.getByTestId("workspace-list").evaluate((el) => el.scrollTop))
      .toBeGreaterThan(500);
    if (sizes)
      await expect(page.getByRole("separator", { name: "Resize panels" })).toHaveAttribute(
        "aria-valuenow",
        sizes,
      );
    if (!phone) await expect(page.getByTestId("desk-panel")).toHaveCount(2);
    // No other saved workspace left (a phone keeps the row for its Panels button, 11-15).
    await expect(page.getByTestId("workspace-pill")).toHaveCount(0);

    // A fresh start (as after closing the browser): the group is still there as a pill.
    await page.waitForTimeout(900);
    await page.goto("/backups");
    await page.goto("/");
    await page
      .getByTestId("workspace-pill")
      .getByRole("button", { name: /Bring back/ })
      .click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");
    await expect(panel.getByPlaceholder("Search")).toHaveValue("Movie");

    // A second group, opened while the first is minimized, gets its own pill; switching keeps both.
    await page.getByRole("button", { name: "Minimize all" }).click();
    await expect(page.getByTestId("workspace-pill")).toHaveCount(1);
    await page.goto(`/?panels=${encodeURIComponent(`service:${service.id}`)}`);
    await expect(page.getByTestId("workspace-pill")).toHaveCount(1);
    await page.waitForTimeout(900);
    await page
      .getByTestId("workspace-pill")
      .filter({ hasText: "Duplicate Media Review" })
      .getByRole("button", { name: /Bring back/ })
      .click();
    await expect(page.getByTestId("workspace-progress")).toHaveText("2 of 120 decided");
    const other = page.getByTestId("workspace-pill");
    await expect(other).toHaveCount(1);
    await expect(other).toContainText(service.name);

    // Closing is deliberate: the plain group closes, the one with unsent choices asks first.
    await other.getByRole("button", { name: /^Close / }).click();
    await expect(page.getByTestId("workspace-pill")).toHaveCount(0);
    await page.getByRole("button", { name: "Minimize all" }).click();
    const review = page.getByTestId("workspace-pill");
    await review.getByRole("button", { name: /^Close / }).click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText("2 decisions you have not submitted");
    await ask.getByRole("button", { name: "Keep it" }).click();
    await expect(review).toHaveCount(1);
    await review.getByRole("button", { name: /^Close / }).click();
    await ask.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByTestId("workspace-pill")).toHaveCount(0);

    // Nothing was submitted, planned, or run by any of this; the choices are still saved.
    const temp = (await (await page.request.get("/api/workspaces?kind=temporary")).json()) as {
      id: string;
    }[];
    const view = (await (await page.request.get(`/api/workspaces/${temp[0]!.id}`)).json()) as {
      submission?: unknown;
      selections: Record<string, string>;
    };
    expect(view.submission).toBeUndefined();
    expect(Object.keys(view.selections)).toHaveLength(2);
    expect(((await (await page.request.get("/api/jobs")).json()) as unknown[]).length).toBe(
      jobsBefore,
    );
  } finally {
    for (const g of (await (await page.request.get("/api/desk/groups")).json()) as { id: string }[])
      await page.request.delete(`/api/desk/groups/${g.id}`);
    for (const w of (await (await page.request.get("/api/workspaces?kind=temporary")).json()) as {
      id: string;
    }[])
      await page.request.delete(`/api/workspaces/${w.id}`);
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("panel expansion: one panel fills the space beside Ember; Restore puts back the exact arrangement", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Phones show one panel at a time already.");
  test.setTimeout(120_000);
  await useScenario(page.request, "calm");
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  for (const g of (await (await page.request.get("/api/desk/groups")).json()) as { id: string }[])
    await page.request.delete(`/api/desk/groups/${g.id}`);
  try {
    await page.goto("/");
    await page.locator("#hub-ask").click();
    await page.getByLabel("Ask Ember").fill("Make a test review list of my duplicate movies");
    await page.getByRole("button", { name: "Send" }).click();
    const review = page.getByTestId("workspace-panel");
    await expect(review).toBeVisible({ timeout: 25_000 });
    await page.getByTestId("workspace-row").nth(0).getByRole("button", { name: "Keep" }).click();
    const ws = (await (await page.request.get("/api/workspace")).json()) as {
      services: { id: string }[];
    };
    const url = new URL(page.url());
    url.searchParams.set(
      "panels",
      `${url.searchParams.get("panels")},service:${ws.services[0]!.id}`,
    );
    await page.goto(url.pathname + url.search);
    const panels = page.getByTestId("desk-panel");
    await expect(panels).toHaveCount(2);
    await expect(page.getByTestId("workspace-progress")).toHaveText("1 of 120 decided");
    const list = page.getByTestId("workspace-list");
    await list.evaluate((el) => (el.scrollTop = 700));
    const divider = page.getByRole("separator", { name: "Resize panels" });
    const sizes = await divider.getAttribute("aria-valuenow");
    const reviewBox = await panels.first().boundingBox();

    // Expand the service panel: it covers the panel area; the review stays open underneath.
    const service = panels.nth(1);
    await service.getByRole("button", { name: "Expand panel" }).click();
    await expect(service).toHaveAttribute("data-expanded", "true");
    await expect(review).toBeHidden();
    const big = (await service.boundingBox())!;
    expect(big.x).toBeLessThanOrEqual(reviewBox!.x + 1);
    // Ember stays visible and usable.
    const ask = page.getByLabel("Ask Ember");
    await expect(ask).toBeVisible();
    await ask.fill("still here");
    await expect(ask).toHaveValue("still here");
    await ask.fill("");
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/panel-expanded.png`,
    });

    // Minimizing the whole workspace and bringing it back keeps it expanded.
    await page.getByRole("button", { name: "Minimize all" }).click();
    await page
      .getByTestId("workspace-pill")
      .getByRole("button", { name: /Bring back/ })
      .click();
    await expect(page.getByTestId("desk-panel").nth(1)).toHaveAttribute("data-expanded", "true");

    // Restore (Esc): the same arrangement, choice, scroll, and sizes; nothing reloaded or submitted.
    await page.keyboard.press("Escape");
    await expect(review).toBeVisible();
    await expect(page.getByTestId("desk-panel").nth(1)).not.toHaveAttribute(
      "data-expanded",
      "true",
    );
    await expect(page.getByTestId("workspace-progress")).toHaveText("1 of 120 decided");
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(600);
    await expect(page.getByRole("separator", { name: "Resize panels" })).toHaveAttribute(
      "aria-valuenow",
      sizes!,
    );
    // The button works the same way.
    await page
      .getByTestId("desk-panel")
      .first()
      .getByRole("button", { name: "Expand panel" })
      .click();
    await page
      .getByTestId("desk-panel")
      .first()
      .getByRole("button", { name: "Restore panels" })
      .click();
    await expect(page.getByTestId("desk-panel")).toHaveCount(2);
    const temp = (await (await page.request.get("/api/workspaces?kind=temporary")).json()) as {
      id: string;
    }[];
    const view = (await (await page.request.get(`/api/workspaces/${temp[0]!.id}`)).json()) as {
      submission?: unknown;
    };
    expect(view.submission).toBeUndefined();
  } finally {
    for (const g of (await (await page.request.get("/api/desk/groups")).json()) as { id: string }[])
      await page.request.delete(`/api/desk/groups/${g.id}`);
    for (const w of (await (await page.request.get("/api/workspaces?kind=temporary")).json()) as {
      id: string;
    }[])
      await page.request.delete(`/api/workspaces/${w.id}`);
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test.describe("identity", () => {
  // Reset even when the test runs out of time, so later tests see the default name.
  test.afterEach(async ({ page }) => {
    await page.request.patch("/api/settings", { data: { aiName: "" } });
  });

  test("identity: you name your AI administrator; the same conversations carry on under the new name", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await useScenario(page.request, "calm");
    await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
    try {
      // A conversation of its own, before the name changes.
      await page.goto("/ask");
      await page.getByLabel("Ask Ember").fill("Is everything healthy?");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page).toHaveURL(/\/ask\/[0-9a-f-]{36}/, { timeout: 25_000 });
      await expect(page.getByTestId("answer").last()).toBeVisible({ timeout: 25_000 });
      const conversation = new URL(page.url()).pathname;
      const before = await page.getByTestId("answer").count();

      await page.goto("/settings#cave");
      const identity = page.getByRole("region", { name: "Ember: identity" });
      await identity.scrollIntoViewIfNeeded();
      await identity.getByLabel("AI administrator name").fill("Warden");
      await expect(identity.getByTestId("ai-name-preview")).toContainText('Shown as "Warden"');
      await identity.getByRole("button", { name: "Save name" }).click();
      await expect(identity.getByRole("button", { name: "Use Ember" })).toBeVisible();
      // Not a name: Save stays off and says why.
      await identity.getByLabel("AI administrator name").fill("<b>");
      await expect(identity.getByRole("button", { name: "Save name" })).toBeDisabled();
      await expect(identity.getByTestId("ai-name-preview")).toContainText("Use letters");
      await identity.getByLabel("AI administrator name").fill("Warden");
      expect(await seriousViolations(page)).toEqual([]);

      // The same conversation carries on, addressed by the new name.
      await page.goto(conversation);
      await expect(page.getByLabel("Ask Warden")).toBeVisible();
      await expect(page.getByText("Is everything healthy?").first()).toBeVisible();
      await expect(page.getByTestId("answer")).toHaveCount(before);
      await page.getByLabel("Ask Warden").fill("And now?");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByTestId("answer")).toHaveCount(before + 1, { timeout: 25_000 });
      await page.goto("/");
      await expect(page.getByTestId("cave-hub")).toContainText("Warden");
      await page.screenshot({ path: `test-results/screens/${testInfo.project.name}/identity.png` });

      // Back to its own name.
      await page.goto("/settings#cave");
      await page
        .getByRole("region", { name: "Ember: identity" })
        .getByRole("button", { name: "Use Ember" })
        .click();
      await page.goto(conversation);
      await expect(page.getByLabel("Ask Ember")).toBeVisible();
    } finally {
      await page.request.post("/api/agent/disconnect", { data: {} });
    }
  });
});

test.describe("voice", () => {
  // Back to no profile and the AI's own name, even when the test runs out of time.
  test.afterEach(async ({ page }) => {
    const status = await (await page.request.get("/api/voice")).json();
    await page.request.put("/api/voice", {
      data: {
        host: status.host,
        sttPort: status.sttPort,
        ttsPort: status.ttsPort,
        profiles: status.profiles,
      },
    });
    await page.request.patch("/api/settings", { data: { aiName: "" } });
  });

  test("voice: speak to the AI, check the words, hear the answer; voice profiles change name and voice", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await useScenario(page.request, "calm");
    await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
    // Start without panels left by another test.
    await page.request.put("/api/talk/layouts/draft:dc-ask-draft", {
      data: { layout: { v: 1, windows: [] } },
    });
    try {
      await page.goto("/ask");
      // Speak: the words land in the box for review; nothing is sent by itself.
      await page.getByRole("button", { name: "Speak to Ember" }).click();
      await expect(page.getByTestId("cave-listening")).toBeVisible();
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "Done" }).click();
      const box = page.getByLabel("Ask Ember");
      await expect(box).toHaveValue("What is happening with my servers?", { timeout: 15_000 });
      await expect(page.getByTestId("answer")).toHaveCount(0);
      await page.screenshot({
        path: `test-results/screens/${testInfo.project.name}/voice-heard.png`,
      });

      // With the speaker on, answers are read aloud (crossed out, nothing is spoken: the owner, 10-12).
      // A phone: under the + beside the box (11-16); the menu stays open for this switch.
      if (testInfo.project.name === "mobile") await page.getByTestId("chat-plus").click();
      await page
        .getByRole("button", { name: /Read every answer aloud|Read answers aloud/ })
        .click();
      if (testInfo.project.name === "mobile") await page.getByTestId("chat-plus").click();
      const spoken = page.waitForRequest((r) => r.url().endsWith("/api/voice/speak"), {
        timeout: 30_000,
      });
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByTestId("answer").last()).toBeVisible({ timeout: 25_000 });
      const request = await spoken;
      expect(JSON.parse(request.postData() ?? "{}").text).toBeTruthy();
      const res = await request.response();
      expect(res?.headers()["content-type"]).toBe("audio/wav");
      await expect(page.getByTestId("cave-speak-error")).toHaveCount(0);

      // Cancel throws the recording away.
      await page.getByRole("button", { name: "Speak to Ember" }).click();
      await expect(page.getByTestId("cave-listening")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByTestId("cave-listening")).toHaveCount(0);
      await expect(box).toHaveValue("");

      // Send while it listens: the mic turns off, and what was said is sent (10-26).
      const asked = await page.getByTestId("your-message").count();
      await page.getByRole("button", { name: "Speak to Ember" }).click();
      await expect(page.getByTestId("cave-listening")).toBeVisible();
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByTestId("cave-listening")).toHaveCount(0);
      await expect(page.getByTestId("your-message")).toHaveCount(asked + 1, { timeout: 15_000 });
      await expect(page.getByTestId("your-message").last()).toContainText(
        "What is happening with my servers?",
      );
      await expect(box).toHaveValue("");
      await expect(page.getByRole("button", { name: "Speak to Ember" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );

      // Settings: the speech machine answers; choosing Warden gives the AI its voice.
      await page.goto("/settings#cave");
      const voice = page.getByRole("region", { name: "Ember: voice" });
      await voice.scrollIntoViewIfNeeded();
      await expect(voice.getByTestId("voice-status")).toContainText("Speech to text ready");
      // The five archetypes are built in; each starts on Classic Ember (any picture goes with
      // any voice). The Companion speaks through its voice box.
      await expect(voice.getByTestId("voice-profiles").getByRole("listitem")).toHaveCount(5);
      for (const id of ["operator", "enchantress", "scholar", "companion"]) {
        await expect(voice.getByTestId(`voice-profile-${id}`).locator("img")).toHaveAttribute(
          "src",
          "/avatars/ember-classic.webp",
        );
      }
      await expect(
        voice
          .getByTestId("voice-profile-companion")
          .getByRole("checkbox", { name: /Voice box effect/ }),
      ).toBeChecked();
      await expect(
        voice
          .getByTestId("voice-profile-scholar")
          .getByRole("checkbox", { name: /Voice box effect/ }),
      ).not.toBeChecked();
      await expect(voice.getByTestId("voice-profile-warden").getByLabel("Swearing")).toHaveValue(
        "",
      );
      await voice.getByRole("button", { name: "Use Warden" }).click();
      // Switching voices asks which picture goes with it; keep the one Ember has now.
      await page.getByTestId("picture-for-voice").getByRole("button", { name: "Keep it" }).click();
      await expect(voice.getByTestId("voice-profile-warden")).toContainText("In use");
      const heard = page.waitForRequest((r) => r.url().endsWith("/api/voice/speak"));
      await voice.getByRole("button", { name: "Hear Warden" }).click();
      expect(JSON.parse((await heard).postData() ?? "{}").profile).toBe("warden");
      expect(await seriousViolations(page)).toEqual([]);
      await page.screenshot({
        path: `test-results/screens/${testInfo.project.name}/voice-settings.png`,
        fullPage: false,
      });
      // No name saved: it is called Ember, whichever voice is in use.
      await page.goto("/ask");
      await expect(page.getByLabel("Ask Ember")).toBeVisible();
      await expect(page.getByRole("button", { name: "Speak to Ember" })).toBeVisible();
    } finally {
      await page.request.post("/api/agent/disconnect", { data: {} });
    }
  });

  test("your picture: chosen in Settings, shown beside your name and in conversations", async ({
    page,
  }) => {
    await useScenario(page.request, "calm");
    await page.request.delete("/api/owner/avatar");
    await page.goto("/settings");
    await page.getByTestId("owner-avatar-input").setInputFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(page.getByRole("img", { name: "Your picture" })).toBeVisible();
    const res = await page.request.get("/api/owner/avatar");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/jpeg");
    await page.getByRole("button", { name: "Remove your picture" }).click();
    await expect(page.getByRole("img", { name: "Your picture" })).toHaveCount(0);
    expect((await page.request.get("/api/owner/avatar")).status()).toBe(404);
  });

  test("themes: four built in or your own two colors, applied everywhere and kept after a reload", async ({
    page,
  }) => {
    await useScenario(page.request, "calm");
    await page.request.patch("/api/settings", { data: { theme: { preset: "sapphire" } } });
    await page.goto("/settings");
    const gold = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-gold").trim(),
      );
    const picker = page.getByTestId("theme-picker");
    await expect(picker.getByRole("radio", { name: /Sapphire/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await gold()).toBe("#3d8bff");
    await picker.getByRole("radio", { name: /Dragonfire/ }).click();
    expect(await gold()).toBe("#e2553f");
    await picker.getByRole("radio", { name: /Your colors/ }).click();
    await page.getByRole("button", { name: "Main color: #e05a9c" }).click();
    await page.getByRole("button", { name: "Secondary color: #000000" }).click();
    expect(await gold()).toBe("#e05a9c");
    await expect(
      page.getByRole("region", { name: "Themes" }).getByText("Saved", { exact: true }),
    ).toBeVisible();
    await page.reload();
    expect(await gold()).toBe("#e05a9c");
    await expect(page.getByTestId("theme-custom")).toBeVisible();
    await page.request.patch("/api/settings", { data: { theme: { preset: "sapphire" } } });
  });

  test("Hearth is the theme for anyone who hasn't chosen one, and a theme they chose is kept", async ({
    page,
  }, testInfo) => {
    await useScenario(page.request, "calm");
    const seriousViolations = async (p: typeof page) => {
      await p.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== "running"),
      );
      const axe = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa"]).analyze();
      return axe.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    };
    const theme = () =>
      page.evaluate(() => ({
        preset: document.documentElement.dataset.theme,
        gold: getComputedStyle(document.documentElement).getPropertyValue("--color-gold").trim(),
        ink: getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim(),
        bg: getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim(),
      }));
    // An installation where nobody has chosen a theme (the saved one is hidden from the app).
    await page.route("**/api/workspace", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      delete body.theme;
      await route.fulfill({ response: res, json: body });
    });
    await page.goto("/");
    await expect.poll(async () => (await theme()).preset).toBe("hearth");
    expect(await theme()).toMatchObject({ gold: "#ff8a00", ink: "#f6e6d7", bg: "#0b0f14" });
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0b0f14");
    // The brand in the shell: the Hearth mark and name, and the page title.
    await expect(page).toHaveTitle(/Hearth/);
    await expect(
      page.getByRole("link", { name: "Hearth home" }).locator("visible=true"),
    ).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/hearth-home.png`,
    });
    await page.goto("/settings");
    await expect(
      page.getByTestId("theme-picker").getByRole("radio", { name: /Hearth/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(await seriousViolations(page)).toEqual([]);

    // A theme someone chose is never replaced by the default.
    await page.unroute("**/api/workspace");
    await page.request.patch("/api/settings", { data: { theme: { preset: "verdant" } } });
    await page.goto("/");
    await expect.poll(async () => (await theme()).preset).toBe("verdant");
    expect((await theme()).gold).toBe("#3fbf7f");
    await page.request.patch("/api/settings", { data: { theme: { preset: "sapphire" } } });
  });

  test("the Lair from the top bar; systems along the top and in the sidebar turn panels on and off", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "the Lair is a desktop workspace");
    await useScenario(page.request, "calm");
    // The order and counts are kept on Hearth from every device (11-16): start from none.
    await page.request.patch("/api/settings", { data: { lairOrder: null, lairUsage: null } });
    await page.goto("/settings");
    await page.getByTestId("lair-button").click();
    await expect(page).toHaveURL(/[?&](panels|g)=/);
    const strip = page.getByTestId("lair-systems");
    await expect(strip).toBeVisible();
    await expect(page.getByTestId("lair-name")).toHaveText("The Lair");
    await expect(page.getByTestId("lair-button")).toHaveAttribute("aria-current", "page");

    // On: lit, and its panel opens. Off: dark, the panel closes, and you stay in the Lair.
    const chip = strip.locator('[aria-pressed="false"]:not([data-testid="lair-storage"])').first();
    const name = (await chip.getAttribute("aria-label"))!;
    await chip.click();
    const on = strip.getByRole("button", { name, exact: true });
    await expect(on).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region", { name: `Service: ${name}` })).toBeVisible();
    await on.click();
    await expect(on).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("region", { name: `Service: ${name}` })).toHaveCount(0);
    await expect(strip).toBeVisible();

    // The sidebar does the same.
    const side = page
      .getByTestId("systems-list")
      .getByRole("link", { name: new RegExp(`${name}$`) });
    await side.click();
    await expect(side).toHaveAttribute("aria-current", "page");
    await expect(on).toHaveAttribute("aria-pressed", "true");
    await side.click();
    await expect(side).not.toHaveAttribute("aria-current", "page");
    await expect(on).toHaveAttribute("aria-pressed", "false");
  });

  test("the Lair's systems: most used first, and a mouse drag scrolls them without toggling", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "the Lair is a desktop workspace");
    await useScenario(page.request, "calm");
    // The counts are kept on Hearth from every device (11-16): start from none, as a new owner.
    await page.request.patch("/api/settings", { data: { lairUsage: null } });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/settings");
    await page.getByTestId("lair-button").click();
    const strip = page.getByTestId("lair-systems");
    await expect(strip).toBeVisible();

    // Open the last system in the strip, then come back to the Lair: it now sits first.
    const last = strip.getByRole("button").last();
    const name = (await last.getAttribute("aria-label"))!;
    await last.scrollIntoViewIfNeeded();
    await last.click();
    await expect(last).toHaveAttribute("aria-pressed", "true");
    await last.click();
    await page.goto("/settings");
    await page.getByTestId("lair-button").click();
    await expect(strip.getByRole("button").first()).toHaveAttribute("aria-label", name);

    // Hold the mouse on a chip and drag left: the strip scrolls and nothing opens.
    expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const chip = strip.getByRole("button").nth(1);
    const before = await chip.getAttribute("aria-pressed");
    const box = (await chip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await expect(chip).toHaveAttribute("aria-pressed", before!);
  });

  test("voice chat in the War Room: its own voice button; the ear stops it hearing you", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "No War Room on a phone (11-13).");
    // A silent stand-in microphone, and no browser speech recognition, so Hearth's own is used.
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () =>
        new AudioContext().createMediaStreamDestination().stream;
      const w = window as unknown as Record<string, unknown>;
      delete w.SpeechRecognition;
      delete w.webkitSpeechRecognition;
    });
    await useScenario(page.request, "calm");
    // The Lair's voice chat stays in the Lair (zones.spec.ts); the War Room has its own.
    await page.goto("/war-room");
    const chat = page.getByTestId("ember-voice-chat").locator("visible=true");
    const ear = page.getByTestId("ember-ear").locator("visible=true");
    await chat.click();
    await expect(chat).toHaveAttribute("aria-pressed", "true");
    await expect(ear).toHaveAttribute("aria-pressed", "true");
    // The ear: it can't hear you, and voice chat stays on.
    await ear.click();
    await expect(ear).toHaveAttribute("aria-pressed", "false");
    await expect(ear).toHaveAccessibleName("Let it hear you");
    await expect(chat).toHaveAttribute("aria-pressed", "true");
    await ear.click();
    await expect(ear).toHaveAttribute("aria-pressed", "true");
    // Ending voice chat takes the ear away; starting it again from the War Room works too.
    await chat.click();
    await expect(chat).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("ember-ear")).toHaveCount(0);
    await chat.click();
    await expect(chat).toHaveAttribute("aria-pressed", "true");
    await expect(ear).toHaveAttribute("aria-pressed", "true");
    await chat.click();
  });

  test("the War Room from any page; a system's logo opens its web UI through the proxy or the host", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "No War Room on a phone (11-13).");
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () =>
        new AudioContext().createMediaStreamDestination().stream;
    });
    await useScenario(page.request, "calm");
    await page.goto("/settings");
    await page.getByTestId("war-room-button").locator("visible=true").click();
    await expect(page).toHaveURL(/\/war-room$/);
    await expect(page.getByTestId("ember-room")).toBeVisible();
    await page.getByRole("button", { name: "Back to Hearth" }).click();
    await expect(page).toHaveURL(/\/$/);

    const services = (await (await page.request.get("/api/workspace")).json()) as {
      services: { id: string; name: string; publicUrl?: string; localUrl?: string }[];
    };
    const svc = services.services.find(
      (s) => s.publicUrl && s.localUrl && !s.publicUrl.includes("*"),
    )!;
    await page.request.patch("/api/settings", { data: { webUiVia: "proxy" } });
    await page.goto(`/services/${svc.id}`);
    await expect(page.getByTestId("service-logo-link").first()).toHaveAttribute(
      "href",
      /^https:\/\//,
    );
    await page.request.patch("/api/settings", { data: { webUiVia: "host" } });
    await page.reload();
    await expect(page.getByTestId("service-logo-link").first()).toHaveAttribute(
      "href",
      svc.localUrl!,
    );
    await page.request.patch("/api/settings", { data: { webUiVia: "proxy" } });
  });

  test("a proxy address Hearth did not find is typed in by hand, used to open, and removed", async ({
    page,
  }) => {
    await useScenario(page.request, "calm");
    await page.request.patch("/api/settings", { data: { webUiVia: "proxy" } });
    const services = (await (await page.request.get("/api/workspace")).json()) as {
      services: { id: string; publicUrl?: string; localUrl?: string }[];
    };
    // Not found in the proxy (a theme in front of the app, say): typed in by hand, then used.
    const plain = services.services.find((s) => !s.publicUrl && s.localUrl)!;
    await page.goto(`/services/${plain.id}`);
    await page.getByTestId("proxy-address-edit").click();
    await page.getByTestId("proxy-address-input").fill("https://books.example.com/");
    await page.getByTestId("proxy-address-save").click();
    await expect(page.getByText("books.example.com").first()).toBeVisible();
    await expect(page.getByTestId("service-logo-link").first()).toHaveAttribute(
      "href",
      "https://books.example.com",
    );
    await page.getByTestId("proxy-address-edit").click();
    await page.getByTestId("proxy-address-remove").click();
    await expect(page.getByTestId("proxy-address-edit")).toHaveText("Add proxy address");
  });
});

test("asked to open an app, Ember opens its panel beside the chat, with Show & Tell off", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await useScenario(page.request, "calm");
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await page.goto("/?panels=&view=chat");
    await page.getByLabel("Ask Ember").first().fill("open the Plex panel");
    await page.getByRole("button", { name: "Send" }).first().click();
    await expect(
      page.getByTestId("answer").filter({ hasText: "Plex is open" }).last(),
    ).toBeAttached({
      timeout: 20_000,
    });
    // Desktop: beside the chat. Phone: at the front, as when picked from Panels.
    if (test.info().project.name === "mobile")
      await expect(page.getByTestId("carousel-current")).toContainText("Plex");
    else await expect(page.locator('[data-panel="service:plex"]')).toBeVisible();
    await expect(page).toHaveURL(/panels=[^&]*service%3Aplex|panels=[^&]*service:plex/);
  } finally {
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("the Lair shows a down arrow when you scroll up, back to the newest message", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto("/ask");
  const box = page.locator("textarea").first();
  for (let i = 1; i <= 4; i++) {
    await box.fill(`Arrow check ${i}: what is running?`);
    await page.getByRole("button", { name: "Send" }).first().click();
    await expect(page.getByTestId("answer")).toHaveCount(i, { timeout: 20_000 });
  }
  const thread = page.getByTestId("cave-thread");
  await thread.evaluate((el) => (el.scrollTop = 0));
  const arrow = thread.getByTestId("jump-latest");
  await expect(arrow).toBeVisible();
  // Clicked where it sits: scrolling it into view first would reach the bottom and hide it.
  await arrow.dispatchEvent("click");
  await expect
    .poll(() => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(40);
  await expect(arrow).toHaveCount(0);
});

test("the chat shows your picture and the AI's beside each message; Settings turns them off", async ({
  page,
}) => {
  await page.goto("/ask");
  const box = page.locator("textarea").first();
  await box.fill("Who wrote what?");
  await page.getByRole("button", { name: "Send" }).first().click();
  const answer = page.getByTestId("answer").last();
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId("your-message").last().getByTestId("message-picture-you"),
  ).toBeVisible();
  // The AI's chosen look, and it really loads (it was a broken image before).
  const ai = answer.getByTestId("message-picture-ai").locator("img");
  await expect(ai).toBeVisible();
  await expect
    .poll(() => ai.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);

  try {
    await page.goto("/settings");
    const toggle = page.getByRole("switch", { name: "Pictures beside messages" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.goto("/ask");
    await page.locator("textarea").first().fill("And now?");
    await page.getByRole("button", { name: "Send" }).first().click();
    await expect(page.getByTestId("answer").last()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("message-picture-ai")).toHaveCount(0);
    await expect(page.getByTestId("message-picture-you")).toHaveCount(0);
  } finally {
    await page.request.patch("/api/settings", { data: { chatPictures: true } });
  }
});

test("answers show bold and code as such, and cite what the AI looked at", async ({ page }) => {
  // The stand-in AI answers this one; put things back as they were afterwards.
  const ws = (await (await page.request.get("/api/workspace")).json()) as {
    operator: { agentId?: string | null };
  };
  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    await askHowAnswersLook(page);
  } finally {
    if (!ws.operator.agentId) await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

async function askHowAnswersLook(page: import("@playwright/test").Page) {
  await page.goto("/ask");
  await page.locator("textarea").first().fill("show me how answers look");
  await page.getByRole("button", { name: "Send" }).first().click();
  const answer = page.getByTestId("answer").last();
  await expect(answer).toContainText("Here is bold", { timeout: 20_000 });
  await expect(answer.locator("strong")).toHaveText("bold");
  await expect(answer.locator("code")).toHaveText("code");
  await expect(answer).not.toContainText("**");
  await expect(answer).not.toContainText("[C1]");
  // The citation is a numbered mark, like the evidence Hearth gathered itself.
  await expect(answer.locator("sup")).toHaveCount(1);
  // No prices in a conversation: answers on a plan aren't charged per use (10-26).
  await expect(answer).not.toContainText("$");
}

test("Standard voice: built in with nothing to set up, and the play button reads a message aloud", async ({
  page,
}, testInfo) => {
  // Desktop and phone share one installation: each run says its own words.
  const words = `Say something for ${testInfo.project.name} ${Date.now() % 100000}`;
  const before = (await (await page.request.get("/api/voice")).json()) as Record<string, unknown>;
  const engine = (e: "builtin" | "machine") =>
    page.request.put("/api/voice", {
      data: {
        engine: e,
        host: before.host,
        sttPort: before.sttPort,
        ttsPort: before.ttsPort,
        profiles: before.profiles,
        ...(before.active ? { active: before.active } : {}),
      },
    });
  try {
    expect((await engine("builtin")).status()).toBe(204);
    await page.goto("/settings#cave");
    const voice = page.getByRole("region", { name: "Ember: voice" });
    await voice.scrollIntoViewIfNeeded();
    await expect(voice.getByTestId("voice-engine-builtin").getByRole("radio")).toBeChecked();
    // The five characters are Advanced (a speech machine): not offered on Standard.
    await expect(voice.getByTestId("voice-profiles")).toHaveCount(0);
    await expect(voice.getByTestId("voice-standard")).toContainText("Advanced");
    // Its recorded sample is there to hear before anything is downloaded.
    const sample = await page.request.get("/voice-samples/standard.mp3");
    expect(sample.status()).toBe(200);
    await expect(voice.getByTestId("voice-standard-sample")).toBeVisible();
    // It gets ready by itself (a stand-in download here), then Ember can be heard.
    const hear = voice.getByTestId("voice-standard-hear");
    await expect(hear).toBeEnabled({ timeout: 15_000 });
    await expect(voice.getByTestId("voice-builtin-note")).toHaveCount(0);
    let spoken = page.waitForResponse((r) => r.url().endsWith("/api/voice/speak"));
    await hear.click();
    expect((await spoken).status()).toBe(200);

    // Home Assistant can use the same voice: off until turned on, then the steps to add it.
    const share = voice.getByTestId("voice-share");
    await expect(share.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await share.getByRole("switch").click();
    await expect(share.getByTestId("voice-share-steps")).toContainText("Wyoming Protocol");
    await expect(share.getByTestId("voice-share-steps")).toContainText("choose Hearth");
    await share.getByRole("switch").click();
    await expect(share.getByTestId("voice-share-steps")).toHaveCount(0);

    // The play button on an answer reads that answer.
    await page.goto("/ask");
    await page.locator("textarea").first().fill("Read this one to me");
    await page.getByRole("button", { name: "Send" }).first().click();
    const answer = page.getByTestId("answer").last();
    await expect(answer).toBeVisible({ timeout: 20_000 });
    const text = (await answer.locator("p").nth(1).innerText()).slice(0, 20);
    spoken = page.waitForResponse((r) => r.url().endsWith("/api/voice/speak"));
    await answer.getByTestId("play-message").click();
    const res = await spoken;
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.request().postData() ?? "{}").text).toContain(text.trim().slice(0, 10));

    // And in the War Room, beside Copy on the AI's replies (a phone has no War Room).
    if (testInfo.project.name === "mobile") return;
    await page.goto("/war-room");
    await page.getByTestId("ember-input").fill(words);
    await page.getByTestId("ember-send").click();
    const reply = page.locator(".msg-row.ember", { hasText: `Heard you: ${words}` }).last();
    await expect(reply).toBeVisible({ timeout: 20_000 });
    // On a phone the War Room's conversation is a short strip between its pinned tabs and the
    // pinned input, so the button is pressed directly rather than chasing the scroll position.
    spoken = page.waitForResponse((r) => r.url().endsWith("/api/voice/speak"));
    await expect(reply.getByTestId("play-message")).toBeVisible();
    await reply.getByTestId("play-message").dispatchEvent("click");
    expect((await spoken).status()).toBe(200);
  } finally {
    await engine("machine");
  }
});

test("the War Room frees the Standard voice's memory on request", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "No War Room on a phone (11-13).");
  const before = (await (await page.request.get("/api/voice")).json()) as Record<string, unknown>;
  const engine = (e: "builtin" | "machine") =>
    page.request.put("/api/voice", {
      data: {
        engine: e,
        host: before.host,
        sttPort: before.sttPort,
        ttsPort: before.ttsPort,
        profiles: before.profiles,
        ...(before.active ? { active: before.active } : {}),
      },
    });
  try {
    expect((await engine("builtin")).status()).toBe(204);
    await page.request.post("/api/voice/builtin/prepare", { data: {} });
    // Speaking once loads the voice program.
    await expect
      .poll(
        async () =>
          (await page.request.post("/api/engine/voice/tts", { data: { text: "Hello." } })).status(),
        { timeout: 15_000 },
      )
      .toBe(200);
    await page.goto("/war-room");
    const free = page.getByTestId("ember-free-voice");
    await expect(free).toBeAttached();
    await free.dispatchEvent("click");
    await expect(free).toHaveCount(0);
    expect((await (await page.request.get("/api/engine/voice/memory")).json()).loaded).toBe(false);
  } finally {
    await engine("machine");
  }
});

test("a service in trouble offers to ask Ember why", async ({ page }, testInfo) => {
  await useScenario(page.request, "attention");
  await page.goto("/?service=prowlarr");
  const ws = page.getByTestId("service-workspace");
  await expect(ws.getByTestId("service-state")).toHaveText("Degraded");
  const ask = ws.getByTestId("service-ask-trouble");
  await expect(ask).toHaveText(/why it is degraded/);
  await ask.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/service-ask-trouble.png`,
  });
  const asked = page.waitForRequest(
    (r) => r.url().includes("/api/agent/conversations") && r.method() === "POST",
  );
  await ask.click();
  expect(JSON.parse((await asked).postData() ?? "{}").text).toMatch(
    /^Prowlarr is having trouble\. Find out what is wrong/,
  );
});
