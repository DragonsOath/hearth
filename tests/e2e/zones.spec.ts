import { expect, test } from "@playwright/test";

// Two zones (10-30): the Lair for homelab work (Ember with Hearth's live tools) and the War
// Room for building things (Claude Code, Codex or Ollama in a project folder). The War Room has a
// permanent Lair tab that is the Lair's own conversation; Home shows every project with its zone
// and PC; starting a project asks which zone first. Voice chat happens in the Lair itself.

test.beforeEach(async ({ request }) => {
  const res = await request.post("/api/demo/scenario", {
    data: { scenario: "calm", replaceYourSystems: true },
  });
  expect(res.status(), "reset demo scenario").toBe(204);
});

test("the War Room's Lair tab is the Lair's own conversation: always first, never closed", async ({
  page,
}) => {
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-room")).toBeVisible();
  const lair = page.getByTestId("ember-tab-lair");
  await expect(page.locator(".ptab-list .ptab").first()).toHaveAttribute(
    "data-testid",
    "ember-tab-lair",
  );
  await expect(lair).toContainText("The Lair");
  await expect(lair.locator(".x")).toHaveCount(0);
  // No Homelab project tab any more: the Lair is the homelab zone.
  await expect(page.locator(".ptab", { hasText: /^Homelab/ })).toHaveCount(0);

  await lair.click();
  await expect(lair).toHaveAttribute("aria-selected", "true");
  // The War Room's own chat (orb, bubbles, message bar), showing the Lair's conversation.
  const convo = page.getByTestId("ember-convo");
  await expect(convo).toContainText("The Lair's main conversation");
  await expect(page.getByTestId("ember-orb-state")).toBeVisible();
  const words = `What's running here? ${Date.now() % 100000}`;
  await page.getByTestId("ember-input").fill(words);
  await page.getByTestId("ember-send").click();
  await expect(convo).toContainText(words);
  await expect(convo.locator(".msg.ember").last()).toBeVisible({ timeout: 15_000 });
  // Nothing scrolls sideways.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "test-results/war-room-lair-tab.png" });

  // The same thread as the Lair: it is in the main conversation.
  const main = (await (await page.request.get("/api/agent/conversations/main")).json()) as {
    messages: { text: string }[];
  };
  expect(main.messages.some((m) => m.text.includes(words))).toBe(true);

  // A War Room project tab brings the War Room's chat back.
  await page.getByTestId("ember-tab-sandbox").click();
  await expect(lair).toHaveAttribute("aria-selected", "false");
  await expect(convo).not.toContainText(words);
});

test("no Homelab project is made in the War Room, even for a real homelab", async ({ page }) => {
  const scenario = await page.request.post("/api/demo/scenario", {
    data: { scenario: "attention", replaceYourSystems: true },
  });
  expect(scenario.ok(), await scenario.text()).toBeTruthy();
  const report = await (await page.request.post("/api/discovery/scan")).json();
  const selections = report.findings
    .filter((f: { selectedByDefault: boolean }) => f.selectedByDefault)
    .map((f: { key: string; name: string }) => ({ key: f.key, name: f.name }));
  expect(
    (
      await page.request.post("/api/discovery/adopt", { data: { reportId: report.id, selections } })
    ).ok(),
  ).toBe(true);
  await page.goto("/war-room");
  await expect(page.getByTestId("ember-tab-lair")).toBeVisible();
  // The snapshot is refreshed when the War Room opens; still no project is made.
  await page.waitForTimeout(1500);
  const projects = (await (await page.request.get("/api/engine/projects")).json()) as {
    slug: string;
    homelab?: boolean;
  }[];
  expect(projects.filter((p) => p.homelab)).toEqual([]);
});

test("Start a project asks Lair or War Room first, and Home shows both with their zone and PC", async ({
  page,
}) => {
  const stamp = Date.now() % 100000;
  await page.goto("/");
  await page.getByTestId("hub-start-project").click();
  const dialog = page.getByTestId("start-project");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("start-zone-lair")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("start-pc")).not.toBeEmpty();
  await dialog.getByTestId("start-name").fill(`Tidy the media drives ${stamp}`);
  await dialog.getByTestId("start-about").fill("Rename the files so the library matches them");
  await expect(dialog.getByTestId("start-submit")).toHaveText("Start in the Lair");
  await page.screenshot({ path: "test-results/start-project-lair.png" });
  await dialog.getByTestId("start-submit").click();
  // A Lair project opens in the Lair, with its own conversation.
  await expect(page).toHaveURL(/\/\?project=/);

  await page.goto("/");
  await page.getByTestId("hub-start-project").click();
  await dialog.getByTestId("start-zone-war-room").click();
  await expect(dialog.getByTestId("start-zone-war-room")).toHaveAttribute("aria-checked", "true");
  await dialog.getByTestId("start-name").fill(`Game night ${stamp}`);
  await dialog.getByTestId("start-about").fill("A phone app that tracks quests and loot");
  await expect(dialog.getByTestId("start-submit")).toHaveText("Start in the War Room");
  await dialog.getByTestId("start-submit").click();
  // A War Room project opens in the War Room, on the PC it lives on.
  await expect(page).toHaveURL(/\/war-room/);
  await expect(page.locator(".ptab", { hasText: `Game night ${stamp}` })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Both on Home: the zone and the PC on each card.
  await page.goto("/");
  const war = page.getByTestId("war-room-project-card").filter({ hasText: `Game night ${stamp}` });
  await expect(war.getByTestId("zone-badge")).toHaveAttribute("data-zone", "war-room");
  await expect(war.getByTestId("pc-chip")).not.toBeEmpty();
  const projects = (await (await page.request.get("/api/projects")).json()) as {
    id: string;
    name: string;
  }[];
  expect(projects.some((p) => p.name === `Tidy the media drives ${stamp}`)).toBe(true);
  const lairCard = page
    .getByTestId("project-card")
    .filter({ hasText: `Tidy the media drives ${stamp}` });
  if (await lairCard.count()) {
    await expect(lairCard.getByTestId("zone-badge")).toHaveAttribute("data-zone", "lair");
    await expect(lairCard.getByTestId("pc-chip")).not.toBeEmpty();
  }
  await page.screenshot({ path: "test-results/home-zones.png" });
});

test("voice chat in the Lair: it hears you, sends it, answers in the same thread; the ear stops it hearing", async ({
  page,
}) => {
  // A stand-in microphone that says something for a moment, then is quiet.
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.6, ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime + 0.8);
      const out = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(out);
      osc.start();
      return out.stream;
    };
  });
  await page.goto("/ask");
  const talk = page.getByTestId("talk-start");
  await talk.click();
  // It stays right here: no trip to the War Room.
  await expect(page).toHaveURL(/\/ask/);
  await expect(talk).toHaveAttribute("aria-pressed", "true");
  const status = page.getByTestId("talk-status");
  await expect(status).toContainText("Voice chat on.");
  const ear = page.getByTestId("talk-ear");
  await expect(ear).toHaveAttribute("aria-pressed", "true");
  // What it heard (the stand-in speech machine hears one fixed sentence) is sent and answered.
  await expect(page.getByTestId("cave-thread")).toContainText(
    "What is happening with my servers?",
    { timeout: 30_000 },
  );
  await page.screenshot({ path: "test-results/lair-voice-chat.png" });

  // The ear: it can't hear you, and voice chat stays on.
  await ear.click();
  await expect(ear).toHaveAttribute("aria-pressed", "false");
  await expect(ear).toHaveAccessibleName(/^Let .+ hear you$/);
  await expect(status).toHaveAttribute("data-phase", /paused|waiting|speaking/);
  await expect(talk).toHaveAttribute("aria-pressed", "true");
  // Ending voice chat takes the ear away.
  await talk.click();
  await expect(talk).toHaveAttribute("aria-pressed", "false");
  await expect(ear).toHaveCount(0);
  await expect(status).toHaveCount(0);
});

test("Home's numbers are for the PC you are at: this Hearth when it is the only PC", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("vitals")).toHaveAttribute("data-scope", "hub");
  // One PC: nothing to switch between.
  await expect(page.getByTestId("vitals-scope")).toHaveCount(0);
});

test("your own rules for Ember are saved in Settings > Ember > Homelab rules", async ({ page }) => {
  const words = `- Ask before restarting the media server ${Date.now() % 100000}.`;
  await page.goto("/settings#cave");
  const box = page.getByTestId("own-rules");
  await box.fill(words);
  await page.getByTestId("own-rules-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const ws = (await (await page.request.get("/api/workspace")).json()) as {
    rules: { notes?: string };
  };
  expect(ws.rules.notes).toBe(words);
  await page.request.put("/api/settings/rules", {
    data: { doNotTouch: [], reservations: [], notes: "" },
  });
});
