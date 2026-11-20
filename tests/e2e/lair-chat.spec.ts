import { expect, test, type Locator } from "@playwright/test";

// The Lair's conversation (the owner, 2026-11-02): long names wrap inside the bubbles, and the
// colors match the War Room: yours translucent orange with blue text, the AI's translucent blue
// with orange text.

/** The right edge of the text's last character box, for "it stays inside its bubble". */
const textRight = (el: Locator) =>
  el.evaluate((node) => {
    const r = document.createRange();
    r.selectNodeContents(node);
    return Math.max(...[...r.getClientRects()].map((c) => c.right));
  });

test("a long name wraps inside your message and the AI's, in the War Room's colors", async ({
  page,
}) => {
  const name =
    "Doctor.Who.2005.S00E16.Special.The.End.Of.Time.Part1.720p.BluRay.x264-BiA.mkv.and.its.sample.file.name";
  await page.goto("/ask");
  await page.locator("textarea").first().fill(`Why is ${name} stuck?`);
  await page.getByRole("button", { name: "Send" }).first().click();

  const mine = page.getByTestId("your-message").filter({ hasText: name }).last();
  await expect(mine).toBeVisible({ timeout: 20_000 });
  const bubble = mine.locator(".lair-you");
  const box = (await bubble.boundingBox())!;
  expect(await textRight(bubble)).toBeLessThanOrEqual(box.x + box.width + 1);
  await expect(bubble).toHaveCSS("color", "rgb(159, 216, 255)");
  await expect(bubble).toHaveCSS("border-top-color", "rgba(255, 140, 30, 0.75)");

  const answer = page.getByTestId("answer").last();
  await expect(answer).toBeVisible({ timeout: 30_000 });
  const reply = answer.locator(".lair-ember");
  await expect(reply.locator("p").first()).toHaveCSS("color", "rgb(255, 165, 79)");
  await expect(reply).toHaveCSS("border-top-color", "rgba(56, 140, 255, 0.4)");
  const r = (await reply.boundingBox())!;
  expect(await textRight(reply)).toBeLessThanOrEqual(r.x + r.width + 1);

  await page.screenshot({ path: `test-results/screens/${test.info().project.name}/lair-chat.png` });

  // Nothing pushes the page sideways.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
});

test("the Lair's header says which AI is answering, beside the plan usage", async ({ page }) => {
  const ws = (await (await page.request.get("/api/workspace")).json()) as {
    agents: { id: string; name: string; status: string }[];
  };
  const on = ws.agents.find((a) => a.status === "connected");
  // The Lair: Ember beside the panels.
  await page.goto("/?panels=");
  // A phone: which AI answers is in the chat's menu (11-16).
  if (test.info().project.name === "mobile") await page.getByTestId("chat-menu").click();
  const label = page.getByTestId("lair-ai").first();
  await expect(label).toContainText(on ? on.name : "No AI connected", { timeout: 20_000 });
  await expect(label).toHaveAttribute("data-agent", on ? on.id : "none");
  // 11-07: switch the AI right here; the one answering is marked.
  for (const id of ["claude-code", "codex", "ollama"])
    await expect(label.getByTestId(`lair-ai-${id}`)).toBeVisible();
  if (on)
    await expect(label.getByTestId(`lair-ai-${on.id}`)).toHaveAttribute("aria-pressed", "true");
});

// 11-07: "I need to be able to delete and rename these conversations"; no ever-growing
// "main": opening one makes it the one Ember continues, and New conversation starts fresh.
test("conversations: rename one, delete one, and the one you open is the one Ember continues", async ({
  page,
}, testInfo) => {
  const tag = `${testInfo.project.name}${Date.now() % 100000}`;
  const made = (await (
    await page.request.post("/api/agent/conversations", {
      data: { text: `Rename me ${tag}`, wait: 20 },
    })
  ).json()) as { conversationId: string };
  await page.goto("/ask");
  await page.getByRole("button", { name: "Earlier conversations" }).click();
  const dialog = page.getByRole("dialog", { name: "Earlier conversations" });
  await expect(dialog.getByTestId("conversation-new")).toBeVisible();
  const row = dialog.getByTestId("conversation").filter({ hasText: `Rename me ${tag}` });
  await row.hover();
  await row.click({ button: "right" });
  await page.getByTestId("conversation-rename").click();
  await dialog.getByTestId("conversation-name").fill(`Renamed ${tag}`);
  await dialog.getByTestId("conversation-name").press("Enter");
  const renamed = dialog.getByTestId("conversation").filter({ hasText: `Renamed ${tag}` });
  await expect(renamed).toBeVisible();

  // Opening it makes it the one Ember continues.
  await renamed.locator("button").first().click();
  await expect
    .poll(
      async () =>
        ((await (await page.request.get("/api/agent/conversations/main")).json()) as { id: string })
          .id,
    )
    .toBe(made.conversationId);

  // Delete: asked first, then gone for good.
  await page.getByRole("button", { name: "Earlier conversations" }).click();
  const again = dialog.getByTestId("conversation").filter({ hasText: `Renamed ${tag}` });
  await again.hover();
  await again.click({ button: "right" });
  await page.getByTestId("conversation-delete").click();
  await expect(dialog).toContainText("This can't be undone.");
  await dialog.getByTestId("conversation-delete-confirm").click();
  // It was the one open: gone for good, and you are in a fresh conversation.
  await expect
    .poll(async () =>
      (await page.request.get(`/api/agent/conversations/${made.conversationId}`)).status(),
    )
    .toBe(404);
  await expect(page).toHaveURL(/\/ask$/);
  await page.getByRole("button", { name: "Earlier conversations" }).click();
  await expect(dialog.getByTestId("conversation-new")).toBeVisible();
  await expect(dialog).not.toContainText(`Renamed ${tag}`);
});

test("Thread Looks: a new conversation gets a picture and its name, the picture changes, and search opens the thread at the line", async ({
  page,
}, testInfo) => {
  // 11-17, the owner's "Ember Thread Looks": pick a small Ember picture when starting a thread;
  // it names the thread (Vinyl for music) and marks it in the list. And "where did we talk
  // about this?" without opening every thread.
  const tag = `zq${testInfo.project.name}${Date.now() % 100000}`;
  await page.goto("/ask");
  const open = async () => {
    await page.getByRole("button", { name: "Earlier conversations" }).click();
    return page.getByRole("dialog", { name: "Earlier conversations" });
  };
  let dialog = await open();
  await dialog.getByTestId("conversation-new").click();
  const picker = dialog.getByTestId("look-picker");
  await expect(picker.getByTestId("look-option")).toHaveCount(22);
  await expect(picker.getByTestId("look-none")).toBeVisible();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/thread-looks-picker.png`,
  });
  // 11-18, the owner: "A side scroller is a hard no." The pictures wrap; nothing scrolls sideways.
  const grid = picker.getByRole("group", { name: "Pictures" });
  expect(await grid.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await picker.locator('[data-look="vinyl"]').click();
  // Picking shows the name box with the picture's name; OK starts it and closes everything.
  await expect(picker.getByTestId("look-name")).toHaveValue("Vinyl");
  await picker.getByTestId("look-ok").click();
  await expect(picker).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("ember-thread-name").first()).toContainText("Vinyl");

  const box = page.getByLabel("Ask Ember");
  await box.fill(`Make a road trip playlist ${tag}`);
  await page.getByRole("button", { name: "Send" }).first().click();
  await expect(page).toHaveURL(/\/ask\/[\w-]+/, { timeout: 20_000 });
  const id = page.url().split("/ask/")[1]!.split(/[?#]/)[0]!;
  const read = async () =>
    (await (await page.request.get(`/api/agent/conversations/${id}`)).json()) as {
      title: string;
      look?: string;
    };
  await expect.poll(async () => (await read()).look).toBe("vinyl");
  expect((await read()).title).toMatch(/^Vinyl( \d+)?$/);

  // Change its picture from the row's menu.
  dialog = await open();
  const row = dialog
    .getByTestId("conversation")
    .filter({ has: page.locator('img[data-look="vinyl"]') })
    .first();
  await row.click({ button: "right" });
  await page.getByTestId("conversation-look").click();
  await dialog.getByTestId("look-picker").locator('[data-look="popcorn"]').click();
  await dialog.getByTestId("look-ok").click();
  await expect.poll(async () => (await read()).look).toBe("popcorn");
  await expect(dialog.locator('img[data-look="popcorn"]').first()).toBeVisible();

  // Search the words: the thread shows with the line, and opens at it.
  await page.goto("/ask");
  dialog = await open();
  await dialog.getByPlaceholder("Where did we talk about…").fill(tag);
  const hit = dialog.getByTestId("conversation-hit").first();
  await expect(hit.getByTestId("conversation-hit-line")).toContainText(`road trip playlist ${tag}`);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/thread-looks-search.png`,
  });
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/ask/${id}`));
  await expect(page.locator('[data-msg-index="0"]').first()).toBeInViewport();
});

// 11-16, the owner on a phone: "Where's the arrow, I have to scroll all the way down by hand",
// "it should always start at the bottom anytime I return to the chat", and the header had to be
// scrolled back to each time but is too big to stay fixed. The chat fits the screen (the page
// never scrolls), the thread scrolls by itself, opens at the newest message, and the rows above
// it fold away while scrolling through it and come back when you pull down.
test("a phone's chat fits the screen, starts at the newest message, and shows the arrow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "phones only");
  test.setTimeout(120_000);
  await page.goto(`/?panels=${encodeURIComponent("service:plex")}&view=chat`);
  const thread = page.getByTestId("cave-thread");
  await expect(thread).toBeVisible({ timeout: 20_000 });
  const box = page.locator("textarea").first();
  // The conversation's earlier answers finish loading before counting (a count taken mid-load
  // made this flaky).
  await page.waitForLoadState("networkidle");
  let before = -1;
  await expect
    .poll(
      async () => {
        const n = await page.getByTestId("answer").count();
        const same = n === before;
        before = n;
        return same;
      },
      { intervals: [700] },
    )
    .toBe(true);
  for (let i = 1; i <= 5; i++) {
    await box.fill(`Phone scroll check ${i}: what is running?`);
    await page.getByRole("button", { name: "Send" }).first().click();
    await expect(page.getByTestId("answer")).toHaveCount(before + i, { timeout: 20_000 });
  }
  const gap = () => thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  // The thread scrolls, not the page: the header is always on screen.
  expect(await thread.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
  ).toBe(true);
  await expect(page.getByTestId("tab-bar")).toBeVisible();
  await expect.poll(gap).toBeLessThan(40);

  // Scrolled up: the arrow, and it goes back down.
  await thread.evaluate((el) => (el.scrollTop = 0));
  const arrow = thread.getByTestId("jump-latest");
  await expect(arrow).toBeVisible();
  await arrow.dispatchEvent("click");
  await expect.poll(gap).toBeLessThan(40);

  // Hold the scroll handle and drag it: straight to the top of the conversation (11-16).
  const handle = page.getByTestId("scroll-handle");
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  const tb = (await thread.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, tb.y - 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => thread.evaluate((el) => el.scrollTop)).toBeLessThan(5);
  // A tap low on the track jumps near the bottom.
  await page.getByTestId("scroll-track").click({ position: { x: 8, y: tb.height - 10 } });
  await expect.poll(gap).toBeLessThan(80);

  // To a panel and back: the newest message again.
  await thread.evaluate((el) => (el.scrollTop = 0));
  // (the panels are in the menu while the chat is in front)
  await page.getByTestId("chat-menu").click();
  await page.getByTestId("chat-menu-drawer").getByTestId("phone-panels-toggle").click();
  await page
    .getByTestId("chat-menu-drawer")
    .getByTestId("phone-panels")
    .getByRole("button", { name: "Plex", exact: true })
    .click();
  await expect(page.getByTestId("carousel-current")).toContainText("Plex");
  await page.getByTestId("carousel-ember").click();
  await expect(thread).toBeVisible();
  await expect.poll(gap).toBeLessThan(40);

  // Like the Claude app: one + holds attach, the Forge and voice; the box grows as you type.
  await expect(page.getByTestId("attach")).toHaveCount(0);
  await page.getByTestId("chat-plus").click();
  const plus = page.getByTestId("chat-plus-menu");
  await expect(plus.getByRole("button", { name: "Attach a photo or file" })).toBeVisible();
  await expect(plus.getByRole("button", { name: "Open it in the Forge" })).toBeVisible();
  await page.getByTestId("chat-plus").click();
  await expect(plus).toHaveCount(0);
  const input = page.locator("textarea").first();
  const one = await input.evaluate((el) => el.clientHeight);
  await input.fill("A long message ".repeat(30));
  await expect.poll(() => input.evaluate((el) => el.clientHeight)).toBeGreaterThan(one * 3);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/phone-chat-typing.png`,
  });
  await input.fill("");

  // The header's rows are in the menu (three lines): which AI, the panels, the conversations.
  await expect(page.getByTestId("lair-ai")).toHaveCount(0);
  await page.getByTestId("chat-menu").click();
  const drawer = page.getByTestId("chat-menu-drawer");
  await expect(drawer.getByTestId("lair-ai")).toBeVisible();
  await expect(drawer.getByTestId("phone-panels-toggle")).toBeVisible();
  await expect(drawer.getByTestId("conversation-new")).toBeVisible();
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/phone-chat-menu.png`,
  });
  await drawer.getByRole("button", { name: "Close the menu" }).first().click();
  await expect(drawer).toHaveCount(0);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/phone-chat-fit.png`,
  });
});

test("New conversation: pick a picture, give it your own name, OK, and that is its name", async ({
  page,
}, testInfo) => {
  // 11-18, the owner: "click a image then ok a little box to rename that's it".
  const tag = `zn${testInfo.project.name}${Date.now() % 100000}`;
  await page.goto("/ask");
  await page.getByRole("button", { name: "Earlier conversations" }).click();
  const dialog = page.getByRole("dialog", { name: "Earlier conversations" });
  await dialog.getByTestId("conversation-new").click();
  const picker = page.getByTestId("look-picker");
  await expect(picker.getByTestId("look-name")).toHaveCount(0);
  await picker.locator('[data-look="popcorn"]').click();
  await picker.getByTestId("look-name").fill(`Friday movies ${tag}`);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/thread-looks-name.png`,
  });
  await picker.getByTestId("look-name").press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("ember-thread-name").first()).toContainText(`Friday movies ${tag}`);
  await page.getByLabel("Ask Ember").fill(`What should we watch ${tag}`);
  await page.getByRole("button", { name: "Send" }).first().click();
  await expect(page).toHaveURL(/\/ask\/[\w-]+/, { timeout: 20_000 });
  const id = page.url().split("/ask/")[1]!.split(/[?#]/)[0]!;
  const c = (await (await page.request.get(`/api/agent/conversations/${id}`)).json()) as {
    title: string;
    look?: string;
  };
  expect(c).toMatchObject({ title: `Friday movies ${tag}`, look: "popcorn" });
});

test("a phone's Ask opens Ember's chat in the Lair, not a separate page", async ({
  page,
}, testInfo) => {
  // 11-18, the owner: "This is dumb just get rid of it the ask should just take you to the ember
  // ask page ... the lair essentially".
  test.skip(testInfo.project.name !== "mobile", "phones only");
  await page.goto("/services");
  const bar = page.getByTestId("tab-bar");
  await bar.getByTestId("tab-ask").click();
  await expect(page).toHaveURL(/\/\?.*view=chat/);
  await expect(page.getByTestId("cave-thread")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Ask about your homelab" })).toHaveCount(0);
  await expect(bar.getByTestId("tab-ask")).toHaveAttribute("aria-current", "page");
  await expect(bar.getByRole("link", { name: "Home" })).toHaveClass(/text-faint/);
  // From a panel in the Lair, Ask turns to Ember and keeps the panels.
  await page.goto(`/?panels=${encodeURIComponent("service:plex")}`);
  await bar.getByTestId("tab-ask").click();
  await expect(page).toHaveURL(/panels=service%3Aplex.*view=chat|view=chat.*panels=service%3Aplex/);
  await expect(page.getByTestId("cave-thread")).toBeVisible();
});
