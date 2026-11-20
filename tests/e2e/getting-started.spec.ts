import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Getting started (built from real state) and Meet Ember (a scripted stand-in for Claude Code,
// DC_FAKE_AGENT). The tests share the main server, so each starts from its own systems adopted
// and the list's own choices reset.

async function seriousViolations(page: Page) {
  await page.waitForTimeout(300);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  return axe.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

type List = {
  items: { id: string; title: string; done: boolean; dismissed: boolean }[];
  hidden: boolean;
};

async function fresh(request: APIRequestContext) {
  expect(
    (
      await request.post("/api/demo/scenario", {
        data: { scenario: "calm", replaceYourSystems: true },
      })
    ).status(),
  ).toBe(204);
  await request.post("/api/agent/disconnect", { data: {} });
  // What earlier tests on this shared server left open: Forge projects (they open the Lair over
  // Home), Lair panel groups, and a notification channel (it ticks "Set up notifications").
  for (const w of (await (await request.get("/api/workspaces?kind=temporary")).json()) as {
    id: string;
  }[])
    await request.delete(`/api/workspaces/${w.id}`);
  for (const g of (await (await request.get("/api/desk/groups")).json()) as { id: string }[])
    await request.delete(`/api/desk/groups/${g.id}`);
  for (const c of ["webhook", "discord", "email", "ntfy", "telegram"])
    await request.delete(`/api/notifications/channels/${c}`);
  await request.patch("/api/settings", { data: { aiName: "" } });
  const report = await (await request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  expect(
    (
      await request.post("/api/discovery/adopt", { data: { reportId: report.id, selections } })
    ).ok(),
  ).toBe(true);
  const list = (await (await request.get("/api/getting-started")).json()) as List;
  for (const i of list.items.filter((x) => x.dismissed))
    await request.patch("/api/getting-started", { data: { restore: i.id } });
  await request.patch("/api/getting-started", { data: { hidden: false } });
}

const step = (page: Page, title: string) =>
  page
    .getByTestId("getting-started")
    .getByTestId("getting-started-item")
    .filter({ hasText: title });

test("getting started: built from real state, ticks itself, links, and can be dismissed", async ({
  page,
}, testInfo) => {
  await fresh(page.request);
  // Adopted apps that need a key each have a step, with where the app shows it. Other tests
  // on this server may already have stored some keys, so take one that is still missing.
  const state = (await (await page.request.get("/api/getting-started")).json()) as List & {
    items: { detail: string }[];
  };
  // Not one another test dismissed: Home leaves dismissed steps out.
  const missing = state.items.find(
    (i) => i.id.startsWith("key:") && !i.done && !(i as { dismissed?: boolean }).dismissed,
  );
  expect(missing, "an adopted app still missing its key").toBeTruthy();
  expect(missing!.detail).toMatch(/^How to get it: /);
  await page.goto("/");
  const list = page.getByTestId("getting-started");
  await expect(list).toBeVisible();
  await expect(step(page, "Adopt your systems")).toHaveAttribute("data-state", "done");
  const keyStep = step(page, missing!.title);
  await expect(keyStep).toHaveAttribute("data-state", "todo");
  await expect(keyStep).toContainText(missing!.detail);
  // A key already in Secure Vault is ticked.
  for (const done of state.items.filter((i) => i.id.startsWith("key:") && i.done))
    await expect(step(page, done.title)).toHaveAttribute("data-state", "done");
  await expect(step(page, "Connect the AI operator")).toHaveAttribute("data-state", "todo");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/getting-started-home.png`,
    fullPage: true,
  });

  // Each step links to the page that does it.
  await keyStep.getByRole("link", { name: missing!.title }).click();
  await expect(page).toHaveURL(/\/vault$/);

  // Connecting the operator ticks its step by itself.
  expect(
    (await page.request.post("/api/agent/providers/claude-code/connect", { data: {} })).status(),
  ).toBe(204);
  await page.goto("/");
  await expect(step(page, "Connect the AI operator")).toHaveAttribute("data-state", "done");

  // Dismissed: gone from Home, still in Settings, where it can be brought back.
  await step(page, "Set up notifications")
    .getByRole("button", { name: 'Dismiss "Set up notifications"' })
    .click();
  await expect(step(page, "Set up notifications")).toHaveCount(0);
  await openSettingsGettingStarted(page);
  const inSettings = page.getByRole("region", { name: "Getting started" });
  const notifications = inSettings
    .getByTestId("getting-started-item")
    .filter({ hasText: "Set up notifications" });
  await expect(notifications).toHaveAttribute("data-state", "dismissed");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await inSettings.screenshot({
    path: `test-results/screens/${testInfo.project.name}/getting-started-settings.png`,
  });
  await notifications.getByRole("button", { name: "Bring back" }).click();
  await expect(notifications).toHaveAttribute("data-state", "todo");

  // The whole list can be hidden from Home, and shown again from Settings.
  await page.goto("/");
  const hide = page.getByRole("button", { name: "Hide this list" });
  if (testInfo.project.name === "mobile") {
    // On a phone the page scrolls under a fixed tab bar: the list's own controls must come
    // clear of it, and the end of the page must too.
    await hide.scrollIntoViewIfNeeded();
    const covered = await hide.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(top && (el === top || el.contains(top)));
    });
    expect(covered, "Hide this list is under the tab bar").toBe(false);
    const clear = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const bar = [...document.querySelectorAll<HTMLElement>(".fixed.bottom-0")].find(
        (e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed",
      );
      const main = document.getElementById("main")!;
      const children = [...main.querySelectorAll<HTMLElement>("section, li, a, button, p")].filter(
        (e) => e.getBoundingClientRect().height > 0,
      );
      const lastBottom = Math.max(...children.map((e) => e.getBoundingClientRect().bottom));
      return { lastBottom, barTop: bar ? bar.getBoundingClientRect().top : innerHeight };
    });
    expect(clear.lastBottom, "the end of the page is under the tab bar").toBeLessThanOrEqual(
      clear.barTop,
    );
  }
  await hide.click();
  await expect(page.getByTestId("getting-started")).toHaveCount(0);
  await openSettingsGettingStarted(page);
  await page.getByRole("button", { name: "Show it on Home again" }).click();
  await page.goto("/");
  await expect(page.getByTestId("getting-started")).toBeVisible();
  await page.request.post("/api/agent/disconnect", { data: {} });
});

test("Meet Ember: introduces itself, checks up read only, recommends three, saves only on request", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await fresh(page.request);
  const before = new Set(
    ((await (await page.request.get("/api/todos")).json()) as { id: string }[]).map((t) => t.id),
  );
  const todosBefore = before.size;
  // Without the operator there is no one to meet yet: it says so up front, wherever Meet Ember is
  // offered, and points to Agents instead of a button that would fail.
  const metBefore = (
    (await (await page.request.get("/api/getting-started")).json()) as List
  ).items.find((i) => i.id === "meet")!.done;
  // The list offers it only until it is met (the other project's run may have met it already).
  if (!metBefore) {
    await page.goto("/");
    const needs = step(page, "Meet Ember").getByTestId("meet-needs-operator");
    await expect(needs).toContainText("Ember needs an AI service connected");
    await expect(
      step(page, "Meet Ember").getByRole("button", { name: "Meet Ember", exact: true }),
    ).toHaveCount(0);
  }
  await openSettingsGettingStarted(page);
  const inSettings = page.getByRole("region", { name: "Getting started" });
  await expect(inSettings.getByRole("button", { name: "Meet Ember again" })).toHaveCount(0);
  const connectFirst = inSettings.getByTestId("meet-needs-operator").last();
  await connectFirst.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/meet-cove-connect-first.png`,
  });
  await connectFirst.getByRole("link", { name: "Connect your AI" }).click();
  await expect(page).toHaveURL(/\/agent$/);

  await page.request.post("/api/agent/providers/claude-code/connect", { data: {} });
  try {
    // From the list while it is offered there (the first run); from Settings after that.
    const met = (
      (await (await page.request.get("/api/getting-started")).json()) as List
    ).items.find((i) => i.id === "meet")!.done;
    if (met) {
      await openSettingsGettingStarted(page);
      await page.getByRole("button", { name: "Meet Ember again" }).click();
    } else {
      await page.goto("/");
      await step(page, "Meet Ember")
        .getByRole("button", { name: "Meet Ember", exact: true })
        .click();
    }
    await expect(page).toHaveURL(/\/ask\/[0-9a-f-]{36}/);
    await expect(page.getByText("Meet Ember: please introduce yourself").first()).toBeVisible();
    const answer = page.getByTestId("answer").last();
    await expect(answer).toContainText("I never change anything without you approving", {
      timeout: 25_000,
    });
    await expect(answer).toContainText("never see a secret");
    // The check-up is shown step by step, like any other conversation.
    const progress = page.getByTestId("cave-progress").last();
    await progress.getByRole("button", { name: /\d+ steps/ }).click();
    for (const done of [
      "Looked over every system",
      "Listed the services",
      "Checked storage and drives",
      "Checked Secure Vault",
      "Checked backups",
    ])
      await expect(progress).toContainText(done);
    await expect(answer).toContainText("My top three next steps:");
    await expect(answer).toContainText("1. Set up notifications");
    await expect(answer).toContainText("3. Add the missing app keys in Secure Vault");
    expect(await seriousViolations(page)).toEqual([]);
    await expectNoOverflow(page);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/meet-cove.png`,
      fullPage: true,
    });

    // No: the stand-in tries to save anyway, and nothing is saved.
    const box = page.getByLabel("Ask Ember").first();
    await box.fill("No thanks");
    await page.getByRole("button", { name: "Send" }).first().click();
    await expect(page.getByTestId("answer")).toHaveCount(2, { timeout: 25_000 });
    expect(((await (await page.request.get("/api/todos")).json()) as unknown[]).length).toBe(
      todosBefore,
    );

    // Asked in the owner's own words: the three are saved.
    await box.fill("Add them to my list");
    await page.getByRole("button", { name: "Send" }).first().click();
    await expect(page.getByTestId("answer")).toHaveCount(3, { timeout: 25_000 });
    const todos = (await (await page.request.get("/api/todos")).json()) as {
      id: string;
      title: string;
    }[];
    expect(todos.length).toBe(todosBefore + 3);
    expect(todos.map((t) => t.title)).toEqual(
      expect.arrayContaining(["Set up notifications", "Keep a backup copy on another drive"]),
    );
    // Met: its step is ticked.
    const list = (await (await page.request.get("/api/getting-started")).json()) as List;
    expect(list.items.find((i) => i.id === "meet")!.done).toBe(true);
    // Leave the list as other tests expect it.
    for (const t of todos.filter((x) => !before.has(x.id)))
      await page.request.patch(`/api/todos/${t.id}`, { data: { status: "dismissed" } });
  } finally {
    await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("Settings has a Support Hearth link that opens the coffee page in a new tab", async ({
  page,
}) => {
  await openSettingsGettingStarted(page);
  const link = page.getByTestId("support-hearth");
  await expect(link).toBeVisible();
  await expect(link).toHaveText(/Buy me a coffee/);
  // It is the first thing on the General tab, above This PC.
  const pc = await page.getByText("This PC", { exact: true }).first().boundingBox();
  const coffee = await link.boundingBox();
  expect(coffee!.y).toBeLessThan(pc!.y);
  await expect(link).toHaveAttribute("href", "https://buymeacoffee.com/dragonsoath");
  await expect(link).toHaveAttribute("target", "_blank");
});

/** Settings, with its Getting started section unfolded (it starts folded). */
async function openSettingsGettingStarted(page: Page) {
  await page.goto("/settings");
  const toggle = page.getByTestId("section-toggle-getting-started");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
