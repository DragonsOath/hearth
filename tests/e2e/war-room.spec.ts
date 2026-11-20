import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The War Room: Hearth's engine (the real Claude Code / Codex, working on this machine) in
// EMBER's control center, with Hearth's panels. In tests, Claude Code is a stand-in
// (DC_FAKE_AGENT) that answers "Heard you: ..." through the same queue and conversation.

test("the War Room button opens the War Room, and a message gets its reply", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("war-room-button").first().click();
  await expect(page).toHaveURL(/\/war-room$/);
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await expect(page.getByTestId("ember-tab-sandbox")).toContainText("Sandbox");
  // Connected live: the Bridge light turns green once the engine says hello.
  await expect(page.locator(".pill.ok", { hasText: "Live" })).toBeVisible();

  await page.getByTestId("ember-input").fill("Hello from the War Room");
  await page.getByTestId("ember-send").click();
  await expect(page.getByTestId("ember-convo")).toContainText("Heard you: Hello from the War Room");
  // The task shows in the queue as done.
  await expect(page.locator(".task.s-succeeded").first()).toBeVisible();
});

test("risky words wait for approval, then run", async ({ page }) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page.getByTestId("ember-input").fill("docker restart the test container");
  await page.getByTestId("ember-send").click();
  await expect(page.getByTestId("ember-convo")).toContainText("waiting for your approval");
  const waiting = page.locator(".task.s-awaiting_approval").first();
  await waiting.getByRole("button", { name: /approve task/ }).click();
  await expect(page.getByTestId("ember-convo")).toContainText(
    "Heard you: docker restart the test container",
  );
});

test("a held task asks for your OK in the conversation by itself, and is approved there", async ({
  page,
}) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page.getByTestId("ember-input").fill("delete the old test torrents after 7 days");
  await page.getByTestId("ember-send").click();
  // No clicking into the queue: the card shows up in the conversation with the request.
  const card = page.locator("[data-testid^=ember-approve-]").last();
  await expect(card).toContainText("needs your OK");
  await expect(card).toContainText("delete the old test torrents after 7 days");
  // The task panel shows this newest task by itself.
  const cardId = (await card.getAttribute("data-testid"))!.replace("ember-approve-", "");
  await expect(page.getByTestId("ember-task-detail").locator("h2")).toContainText(
    `Task #${cardId}`,
  );
  await expect(page.locator(".task .acts button.act-approve").first()).toBeVisible();
  await card.getByRole("button", { name: /Approve and run/ }).click();
  await expect(card).toContainText("✓ Approved");
  await expect(page.getByTestId("ember-convo")).toContainText(
    "Heard you: delete the old test torrents after 7 days",
  );

  // And "No" cancels it, right there too.
  await page.getByTestId("ember-input").fill("delete the spare test folder");
  await page.getByTestId("ember-send").click();
  const second = page.locator("[data-testid^=ember-approve-]", {
    hasText: "delete the spare test folder",
  });
  await second.getByRole("button", { name: /No, cancel it/ }).click();
  await expect(second).toContainText("✕ Cancelled");
});

test("Hearth's panels open over the room, and the engine switch changes the look", async ({
  page,
}) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page.getByTestId("ember-panels-button").click();
  await page.getByTestId("rail-todo-list").click();
  await expect(page.getByTestId("talk-todo")).toBeVisible();
  // A panel's own grid lists keep their natural height (the room's layout rule once stretched
  // them, so a card's details spilled over the next card).
  const check = await page.getByTestId("talk-todo").evaluate((el) => {
    const probe = document.createElement("div");
    probe.className = "grid";
    probe.textContent = "x";
    el.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return { h };
  });
  expect(check.h).toBeLessThan(60);

  await page.locator('.seg[data-engine="codex"]').click();
  await expect(page.getByTestId("ember-room")).toHaveClass(/theme-codex/);
  await page.locator('.seg[data-engine="claude-code"]').click();
  await expect(page.getByTestId("ember-room")).not.toHaveClass(/theme-codex/);
});

test("a new project opens as its own tab, with its own conversation", async ({ page }) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  const name = `Garden planner ${Date.now() % 100000}`;
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/Project Description/).fill("Plan the vegetable beds.");
  // The color for its card on Home is picked in the same box.
  await page
    .getByRole("radiogroup", { name: "Color" })
    .getByRole("radio", { name: "Blue" })
    .click();
  await page.getByRole("button", { name: "Create project" }).click();
  const tab = page.locator(".ptab", { hasText: name });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("ember-convo")).toContainText("Plan the vegetable beds.");
  await page.getByTestId("ember-input").fill("start the plan");
  await page.getByTestId("ember-send").click();
  await expect(page.getByTestId("ember-convo")).toContainText("Heard you: start the plan");

  // Right-click its tab: a new name and description.
  await tab.click({ button: "right" });
  await page
    .getByTestId("tab-menu")
    .getByRole("menuitem", { name: "Edit name, description and color" })
    .click();
  const form = page.getByTestId("edit-project");
  await expect(form.getByLabel("Name")).toHaveValue(name);
  await expect(form.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  await form.getByLabel("Name").fill(`${name} 2026`);
  await form.getByLabel(/Project Description/).fill("Plan the beds and the fence.");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator(".ptab", { hasText: `${name} 2026` })).toHaveAttribute(
    "title",
    "Plan the beds and the fence.",
  );
});

test("from the War Room: Hearth's menu, the Lair, and home", async ({ page }) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page.getByTestId("ember-menu-button").click();
  const menu = page.getByTestId("ember-menu");
  await expect(menu.getByRole("link", { name: "Settings" })).toBeVisible();
  await menu.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.goto("/war-room");
  await page.getByTestId("ember-lair-button").click();
  // The Lair opens where you left it: its panels, or the system you had open there.
  await expect(page).toHaveURL(/[?&](panels|service)=/);

  await page.goto("/war-room");
  await page.getByRole("button", { name: "Back to Hearth" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("the Terminal view runs the program live in the project's folder", async ({ page }) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page.locator('.viewseg button:has-text("Terminal")').click();
  const term = page.getByTestId("ember-terminal");
  await expect(term.locator(".xterm")).toBeVisible();
  // In tests the program is Node's own prompt.
  await term.locator(".xterm").click();
  await page.keyboard.type("21*2");
  await page.keyboard.press("Enter");
  await expect(term.locator(".xterm-rows")).toContainText("42");
});

test("your Claude artifacts, synced into Hearth, open in the War Room", async ({ page }) => {
  // What "sync my Claude artifacts" leaves in Hearth's data folder.
  const root = path.join(process.env.DC_E2E_DATA_DIR!, "claude-artifacts");
  mkdirSync(path.join(root, "mary1"), { recursive: true });
  writeFileSync(path.join(root, "mary1", "index.html"), "<h1>Mary's Enchanted World</h1>");
  writeFileSync(
    path.join(root, "index.json"),
    JSON.stringify({
      synced_at: new Date().toISOString(),
      artifacts: [
        {
          id: "mary1",
          title: "Mary's game",
          url: "https://claude.ai/artifact/mary1",
          entry: "index.html",
          size: 30,
        },
        { id: "doc1", title: "A plan doc", url: "https://claude.ai/artifact/doc1" },
      ],
    }),
  );

  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page.getByTitle(/^Artifacts:/).click();
  const panel = page.getByTestId("ember-artifacts");
  await panel.getByRole("tab", { name: "Claude artifacts" }).click();
  await expect(panel).toContainText("synced");
  await expect(panel).toContainText("A plan doc");
  await panel.getByText("Mary's game").click();
  await expect(panel.frameLocator(`iframe[title="Mary's game"]`).getByRole("heading")).toHaveText(
    "Mary's Enchanted World",
  );
});

test("right-click a project, Delete project, confirm: it is gone with its folder", async ({
  page,
}) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  const name = `Old idea ${Date.now() % 100000}`;
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/Project Description/).fill("Something to throw away.");
  await page.getByRole("button", { name: "Create project" }).click();
  const tab = page.locator(".ptab", { hasText: name });
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("ember-input").fill("make a note");
  await page.getByTestId("ember-send").click();
  await expect(page.getByTestId("ember-convo")).toContainText("Heard you: make a note");
  const slug = (await tab.getAttribute("data-testid"))!.replace("ember-tab-", "");
  const before = (await (await page.request.get("/api/engine/projects")).json()) as {
    slug: string;
    path: string;
  }[];
  const folder = before.find((p) => p.slug === slug)!.path;

  // Right-click, Delete project: nothing is deleted until the second click.
  await tab.click({ button: "right" });
  await page.getByTestId("tab-menu").getByRole("menuitem", { name: "Delete project" }).click();
  const confirm = page.getByTestId("delete-project");
  await expect(confirm).toContainText(`Delete ${name}?`);
  await expect(confirm).toContainText("can't be undone");
  await expect(confirm).toContainText(folder);
  await page.screenshot({ path: "test-results/delete-project.png" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(tab).toBeVisible();

  await tab.click({ button: "right" });
  await page.getByTestId("tab-menu").getByRole("menuitem", { name: "Delete project" }).click();
  await page.getByTestId("delete-project").getByRole("button", { name: "Delete for good" }).click();
  await expect(page.getByTestId("delete-project")).toHaveCount(0);
  await expect(tab).toHaveCount(0);
  await expect(page.locator(".ptab", { hasText: "Sandbox" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const after = (await (await page.request.get("/api/engine/projects")).json()) as {
    slug: string;
  }[];
  expect(after.some((p) => p.slug === slug)).toBe(false);
  // The Sandbox has no Delete.
  await page.locator(".ptab", { hasText: "Sandbox" }).click({ button: "right" });
  await expect(page.getByTestId("tab-menu")).toHaveCount(0);
});

test("your picture and the AI's sit beside the messages, unless Settings turns them off", async ({
  page,
}) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page.getByTestId("ember-input").fill("Pictures, please");
  await page.getByTestId("ember-send").click();
  const convo = page.getByTestId("ember-convo");
  await expect(convo).toContainText("Heard you: Pictures, please");
  const yours = convo.locator(".msg-row.you", { hasText: "Pictures, please" }).last();
  await expect(yours.getByTestId("message-picture-you")).toBeVisible();
  const reply = convo.locator(".msg-row.ember", { hasText: "Heard you: Pictures, please" }).last();
  await expect(reply.getByTestId("message-picture-ai").locator("img")).toBeVisible();
  try {
    await page.request.patch("/api/settings", { data: { chatPictures: false } });
    await page.reload();
    await expect(convo).toContainText("Heard you: Pictures, please");
    await expect(convo.getByTestId("message-picture-ai")).toHaveCount(0);
    await expect(convo.getByTestId("message-picture-you")).toHaveCount(0);
  } finally {
    await page.request.patch("/api/settings", { data: { chatPictures: true } });
  }
});

test("Home lists the War Room's projects; a card opens the War Room with that project open", async ({
  page,
}, testInfo) => {
  const name = `Home card ${testInfo.project.name} ${Date.now() % 100000}`;
  // Home shows its first-run page while there are no systems, and earlier tests in a full run
  // can leave none: give this test one of its own (46.12).
  const ws = (await (await page.request.get("/api/workspace")).json()) as { services: unknown[] };
  let system: string | undefined;
  if (ws.services.length === 0) {
    const res = await page.request.post("/api/services", {
      data: {
        name: "Home card test",
        kind: "web",
        address: "http://10.66.0.9:8080",
        category: "System",
      },
    });
    system = ((await res.json()) as { id: string }).id;
  }
  const made = (await (
    await page.request.post("/api/engine/projects", {
      data: { name, description: "A project made for this test." },
    })
  ).json()) as { slug: string };
  try {
    await page.goto("/");
    const hub = page.getByRole("region", { name: "Active projects" });
    const card = hub.getByTestId("war-room-project-card").filter({ hasText: name });
    // Earlier tests in a full run can leave more projects than Home has room for: then this one
    // is behind View all, which is what Home is for. The rest needs it on Home.
    const shown = await card
      .waitFor({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!shown) {
      await expect(hub.getByRole("link", { name: /more · View all/ })).toBeVisible();
      test
        .info()
        .annotations.push({ type: "note", description: "Home was full: card behind View all" });
      return;
    }
    await expect(card).toContainText("A project made for this test.");
    // The built-in Sandbox is not a project of yours: not on Home.
    await expect(
      hub.getByTestId("war-room-project-card").filter({ hasText: "Sandbox" }),
    ).toHaveCount(0);
    await card.click();
    await expect(page).toHaveURL(/\/war-room$/);
    await expect(page.getByTestId(`ember-tab-${made.slug}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Start a project: the War Room's new project form.
    await page.goto("/");
    const start = hub.getByRole("link", { name: "Start a project" });
    if (await start.count()) {
      await start.click();
      await expect(page).toHaveURL(/\/war-room$/);
      await expect(page.getByRole("button", { name: "Create project" })).toBeVisible();
    }
  } finally {
    await page.request.delete(`/api/engine/projects/${made.slug}`);
    if (system) await page.request.post(`/api/services/${system}/remove`, { data: {} });
  }
});

test("what the AI asks before acting: three choices in the War Room and in Settings, one setting", async ({
  page,
}) => {
  const level = async () =>
    ((await (await page.request.get("/api/engine/access")).json()) as { level: string }).level;
  try {
    await page.request.post("/api/engine/queue/ask-strict", { data: {} });
    await page.goto("/war-room");
    await expect(page.getByTestId("ember-room")).toBeVisible();
    const pick = page.getByTestId("ember-ask-level").locator("visible=true");
    await expect(pick).toHaveValue("strict");
    await pick.selectOption("free");
    await expect(page.getByTestId("ember-convo")).toContainText("asks only before serious steps");
    expect(await level()).toBe("free");
    // Settings, Ember shows the same choice and changes it.
    await page.goto("/settings#cave");
    const setting = page.getByTestId("full-access");
    await setting.scrollIntoViewIfNeeded();
    await expect(setting.getByTestId("ask-level-free")).toHaveAttribute("aria-checked", "true");
    await setting.getByTestId("ask-level-moderate").click();
    await expect(setting.getByTestId("ask-level-moderate")).toHaveAttribute("aria-checked", "true");
    await expect.poll(level).toBe("moderate");
  } finally {
    await page.request.post("/api/engine/queue/full-off", { data: {} });
  }
});

test("the GitHub panel shows your repos and a pull request (gh on this machine)", async ({
  page,
}) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  await page
    .getByRole("button", { name: /GitHub/ })
    .first()
    .click();
  const panel = page.getByTestId("ember-github");
  await expect(panel).toContainText("Rename downloads by date", { timeout: 15_000 });
  await expect(panel).not.toContainText("later stage");
  await panel.getByText("Rename downloads by date").first().click();
  await expect(panel).toContainText("rename.py");
});

test("a down arrow shows when you scroll up, and takes you back to the newest message", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  const convo = page.getByTestId("ember-convo");
  for (let i = 1; i <= 6; i++) {
    await page
      .getByTestId("ember-input")
      .fill(`scroll test message ${i} with enough words to wrap`);
    await page.getByTestId("ember-send").click();
    await expect(convo).toContainText(`Heard you: scroll test message ${i}`);
  }
  await expect(convo.getByTestId("jump-latest")).toHaveCount(0);
  await convo.evaluate((el) => (el.scrollTop = 0));
  const arrow = convo.getByTestId("jump-latest");
  await expect(arrow).toBeVisible();
  // Clicked where it sits: scrolling it into view first would reach the bottom and hide it.
  await arrow.dispatchEvent("click");
  await expect
    .poll(() => convo.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(40);
  await expect(arrow).toHaveCount(0);
});

test("Ollama: a tab next to Claude Code and Codex, set up in Settings, then it answers; the Lair can use it too", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const before = (await (await page.request.get("/api/workspace")).json()) as {
    operator: { agentId: string | null };
  };
  try {
    await page.goto("/war-room");
    await expect(page.getByTestId("ember-room")).toBeVisible();
    const tab = page.locator('.seg[data-engine="ollama"]');
    await expect(tab).toContainText("Ollama");
    await expect(tab).toContainText("set up");
    await tab.click();
    // Not set up yet: the note says so and links straight to the setting.
    await page.getByTestId("ollama-setup-link").click();
    await expect(page).toHaveURL(/\/settings#ollama$/);
    const setting = page.getByTestId("ollama-setting");
    await setting.scrollIntoViewIfNeeded();
    await setting.getByRole("button", { name: "Check" }).click();
    await expect(setting.getByTestId("ollama-found")).toContainText("Ollama 0.40.5 found");
    const models = setting.getByTestId("ollama-model");
    await expect(models.filter({ hasText: "coder-ready:14b" })).toContainText("Ready");
    // A model that can't use tools can't be chosen; one with a small memory window gets a copy.
    const chat = models.filter({ hasText: "chat-only:7b" });
    await expect(chat).toContainText("Can't use tools");
    await expect(chat.getByRole("button")).toHaveCount(0);
    await models
      .filter({ hasText: "qwen3-coder:30b" })
      .getByRole("button", { name: "Make a Hearth copy and use it" })
      .click();
    const copy = models.filter({ hasText: "qwen3-coder-30b-hearth" });
    await expect(copy).toContainText("In use");
    await expect(copy).toContainText("memory window 32k");

    // The War Room's Ollama tab is ready, and answers through the same queue.
    await page.goto("/war-room");
    await expect(tab).toContainText("free");
    await tab.click();
    await page.getByTestId("ember-input").fill("Hello from Ollama");
    await page.getByTestId("ember-send").click();
    await expect(page.getByTestId("ember-convo")).toContainText("Heard you: Hello from Ollama");
    // Ollama's own look: black and white, like its brand.
    await expect(page.getByTestId("ember-room")).toHaveClass(/theme-ollama/);
    await page.screenshot({ path: test.info().outputPath("ollama-look.png") });

    // The Lair: Ollama is offered, tested, and connected like Claude Code.
    await page.goto("/agent");
    const option = page.getByTestId("ai-option-ollama");
    await expect(option).toContainText("Available");
    await option.click();
    const setup = page.getByTestId("ai-setup-ollama");
    await expect(setup).toContainText("No per-request charge");
    await setup.getByRole("button", { name: "Test connection" }).click();
    await expect(setup.getByRole("button", { name: /Use Ollama for/ })).toBeEnabled({
      timeout: 30_000,
    });
    await setup.getByRole("button", { name: /Use Ollama for/ }).click();
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get("/api/workspace")).json()) as {
              operator: { agentId: string | null };
            }
          ).operator.agentId,
      )
      .toBe("ollama");
    await expect(page.getByText("Disconnect")).toBeVisible();
  } finally {
    await page.request.put("/api/engine/ollama", { data: { model: null } });
    if (before.operator.agentId)
      await page.request.post(`/api/agent/providers/${before.operator.agentId}/connect`, {
        data: {},
      });
    else await page.request.post("/api/agent/disconnect", { data: {} });
  }
});

test("Codex in the Lair: offered, and it works with Full access off too, as in the War Room", async ({
  page,
}) => {
  const before = (await (await page.request.get("/api/workspace")).json()) as {
    operator: { agentId: string | null };
  };
  try {
    await page.request.post("/api/engine/queue/full-off", { data: {} });
    await page.goto("/agent");
    const option = page.getByTestId("ai-option-codex");
    await expect(option).toContainText("Available");
    await option.click();
    const setup = page.getByTestId("ai-setup-codex");
    await expect(setup).toContainText("as in the War Room");
    await expect(setup).not.toContainText("Needs Full access on");
    // Full access off: it is tested and can be used, like the War Room's Codex.
    await setup.getByRole("button", { name: "Test connection" }).click();
    await expect(setup.getByRole("button", { name: /Use Codex for/ })).toBeEnabled({
      timeout: 30_000,
    });
    // And with Full access on.
    await page.request.post("/api/engine/queue/full-on", { data: {} });
    await setup.getByRole("button", { name: "Test connection" }).click();
    await expect(setup.getByRole("button", { name: /Use Codex for/ })).toBeEnabled({
      timeout: 30_000,
    });
  } finally {
    await page.request.post("/api/engine/queue/full-off", { data: {} });
    if (before.operator.agentId)
      await page.request.post(`/api/agent/providers/${before.operator.agentId}/connect`, {
        data: {},
      });
  }
});

test("a long name without spaces wraps inside your message, with no sideways scroll", async ({
  page,
}) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  const name =
    "Doctor.Who.2005.S00E16.Special.The.End.Of.Time.Part1.720p.BluRay.x264-BiA.mkv.and.its.sample.file.name";
  await page.getByTestId("ember-input").fill(`Why is ${name} stuck?`);
  await page.getByTestId("ember-send").click();
  const convo = page.getByTestId("ember-convo");
  await expect(convo).toContainText(`Heard you: Why is ${name}`);
  const mine = convo.locator(".msg.you").filter({ hasText: name }).first();
  const box = (await mine.boundingBox())!;
  // Every line of the text stays inside the bubble.
  const textRight = await mine.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return Math.max(...[...r.getClientRects()].map((c) => c.right));
  });
  expect(textRight).toBeLessThanOrEqual(box.x + box.width + 1);
  expect(await convo.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});
