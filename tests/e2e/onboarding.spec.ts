import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The first-run welcome (connecting the AI, then "Make it yours"), from a brand new owner's point of view. Each run
// (desktop and phone) has its own fresh, unclaimed installation (see playwright.config.ts): it
// is claimed here, the way a new owner would, and the steps below happen in order.
test.describe.configure({ mode: "serial" });

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

let page: Page;
let project = "desktop";

test.beforeAll(async ({ browser }, info) => {
  project = info.project.name;
  const [port, dataDir] = process.env[
    project === "mobile" ? "DC_E2E_WELCOME_MOBILE" : "DC_E2E_WELCOME_DESKTOP"
  ]!.split("|") as [string, string];
  const use = info.project.use;
  // A context of its own: the owner of this installation, nobody else's session.
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    serviceWorkers: "block",
  });
  // Settings starts with its sections open, as for every other test (settings-fold.spec.ts
  // tests the folding).
  await context.addInitScript(() => localStorage.setItem("settings-fold-default", "open"));
  page = await context.newPage();
  const code = readFileSync(path.join(dataDir, "setup-code.txt"), "utf8").trim();
  const claimed = await page.request.post("/api/auth/setup", {
    data: { code, password: "e2e welcome password" },
  });
  expect(claimed.status(), await claimed.text()).toBe(200);
});
test.afterAll(async () => page.context().close());

const shot = (step: string) =>
  page.screenshot({
    path: `test-results/screens/${project}/onboarding-${step}.png`,
    fullPage: true,
  });

const workspace = async () =>
  (await (await page.request.get("/api/workspace")).json()) as {
    onboardingNeeded: boolean;
    onboardingDoneAt?: string;
    onboardingStep?: string;
    journey?: string;
    operator: { agentId?: string | null };
    ownerName?: string;
    aiName?: string;
    theme?: { preset: string };
  };

const profileAvatar = async (id: string) =>
  (
    (await (await page.request.get("/api/voice")).json()) as {
      profiles: { id: string; avatar?: string }[];
    }
  ).profiles.find((p) => p.id === id)?.avatar;

// A real picture for "Choose from your library" (a 2 by 2 PNG); the browser squares it first.
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000200000002080600000072" +
    "b60d240000001149444154789c63f8cfc0f01f8419600c0047ca07f967596eb70000000049454e44ae426082",
  "hex",
);

test("a new owner is welcomed after claiming, and can skip it", async () => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  // The first thing after the account: connecting Ember's AI, with where you are in setup.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect Ember's AI");
  const stages = page.getByTestId("onboarding-stages");
  await expect(stages.locator("[aria-current=step]")).toContainText("Connect your AI");
  await expect(stages).toContainText("Your account (done)");
  // Only what Hearth can really connect is offered as working.
  await expect(page.getByTestId("ai-option-claude-code")).toContainText("Available");
  await expect(page.getByTestId("ai-option-claude-code")).toHaveAttribute("aria-checked", "true");
  // Ollama is free and runs on your own hardware (through Claude Code): offered as working.
  await expect(page.getByTestId("ai-option-ollama")).toContainText("Available");
  // Codex too (with Hearth's tools, as in the War Room).
  await expect(page.getByTestId("ai-option-codex")).toContainText("Available");
  for (const id of ["openai-compatible"]) {
    const option = page.getByTestId(`ai-option-${id}`);
    await expect(option).toContainText("Not available yet");
    await expect(option).toBeDisabled();
  }
  // What it costs and what it may do, in plain English, before anything is connected.
  const costs = page.getByTestId("ai-costs");
  await costs.locator("summary").click();
  await expect(costs).toContainText("Hearth doesn't include an AI subscription.");
  await expect(costs).toContainText("doesn't necessarily include separate API usage");
  await expect(costs).toContainText("several requests");
  await expect(costs).toContainText("no per-request charge, but they use your");
  await expect(page.getByTestId("ai-permissions")).toContainText(
    "Connecting gives Ember a brain, not the keys.",
  );
  await expect(page.getByTestId("ai-setup-claude-code")).toContainText(
    "How Claude Code is paid for",
  );
  // Installed is checked at once (free); signing in is one button on this page, no terminal.
  await expect(page.getByTestId("ai-test-results")).toContainText("Installed on this computer");
  await expect(page.getByTestId("claude-connect")).toHaveText("Connect Claude Code");
  await expect(page.getByTestId("ai-setup-claude-code")).not.toContainText("sudo");
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("ai");

  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("headline")).toBeVisible();
  expect((await workspace()).onboardingDoneAt).toBeTruthy();
  await page.reload();
  await expect(page).toHaveURL(/\/$/);
});

test("walks all seven steps, saving each one as it goes", async () => {
  // Offered again (nothing chosen yet), the way a fresh install sees it.
  await page.request.patch("/api/settings", { data: { onboardingDone: false } });
  await page.goto("/services");
  await expect(page).toHaveURL(/\/welcome$/);
  const heading = page.getByRole("heading", { level: 1 });
  const next = page.getByRole("button", { name: "Next" });
  const progress = page.getByTestId("welcome-progress");

  // Connecting the AI can wait: Skip for now moves on, and nothing else needs it.
  await expect(heading).toHaveText("Connect Ember's AI");
  await page.getByTestId("ai-skip").click();
  await expect(progress).toHaveText("Step 1 of 8: Hello");
  await expect(heading).toHaveText("Welcome to Hearth");
  // Two ways in: building a first homelab, or bringing an existing one.
  await expect(page.getByTestId("welcome-path-build")).toContainText(
    "Help me build my first homelab",
  );
  await expect(page.getByTestId("welcome-path-existing")).toContainText("I already have a homelab");

  // 1. Hello: the beginner's path. Picking it is saved and moves on.
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("0-hello");
  await page.getByTestId("welcome-path-build").click();
  await expect(progress).toHaveText("Step 2 of 8: You");
  await expect.poll(async () => (await workspace()).journey).toBe("build");

  // 2. You
  await page.getByLabel("Your name").fill("Alex");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("1-you");
  await next.click();
  await expect(progress).toHaveText("Step 3 of 8: This PC");
  await expect.poll(async () => (await workspace()).ownerName).toBe("Alex");

  // 3. This PC: its name (the computer's own to start) and one of the ten icons, saved as chosen.
  const editor = page.getByTestId("pc-editor");
  await expect(editor.getByRole("radio")).toHaveCount(10);
  // It gets the first icon at once, so its marks show everywhere even if nothing is picked.
  await expect
    .poll(async () => (await (await page.request.get("/api/pcs")).json()).hub.icon)
    .toBe("preset:dragon");
  await editor.getByRole("radio", { name: "Wolf" }).click();
  await editor.getByTestId("pc-name").fill("Den");
  await editor.getByTestId("pc-name").blur();
  await expect
    .poll(async () => (await (await page.request.get("/api/pcs")).json()).hub)
    .toMatchObject({ icon: "preset:wolf", name: "Den" });
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("1b-this-pc");
  await next.click();
  await expect(progress).toHaveText("Step 4 of 8: Your AI's name");

  // Closing the browser halfway: coming back resumes at the same step, still signed in.
  await expect.poll(async () => (await workspace()).onboardingStep).toBe("name");
  expect((await workspace()).onboardingNeeded).toBe(true);
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(progress).toHaveText("Step 4 of 8: Your AI's name");
  await page.reload();
  await expect(progress).toHaveText("Step 4 of 8: Your AI's name");

  // 2. Your AI's name: empty, and called by the archetype's title until a name is typed.
  const name = page.getByLabel("AI administrator name");
  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("placeholder", "Ember");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(progress).toHaveText("Step 3 of 8: This PC");
  await expect(page.getByTestId("pc-name")).toHaveValue("Den");
  await next.click();
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("2-name");
  await next.click();
  await expect(progress).toHaveText("Step 5 of 8: Its voice");
  let ws = await workspace();
  // Nothing typed: no name is saved, so it is called Ember.
  expect(ws.aiName).toBeUndefined();

  // 3. Its voice first, then its look (any look goes with any voice).
  await expect(heading).toHaveText("Ember's voice");
  // Both ways explained, for people new to this: Standard is recommended and can be heard right
  // away; Advanced is plainly for experienced users with a speech machine.
  const standard = page.getByTestId("voice-engine-builtin");
  const advanced = page.getByTestId("voice-engine-machine");
  await expect(standard).toContainText("Recommended");
  await expect(standard).toContainText("nothing to install");
  await expect(standard.getByTestId("voice-standard-sample")).toBeVisible();
  await expect(advanced).toContainText("For experienced users");
  await expect(advanced).toContainText("Piper");
  await expect(advanced).toContainText("Whisper");
  const voices = page.getByTestId("welcome-voices");
  await expect(voices.getByTestId("welcome-voice")).toHaveCount(5);
  // Nothing chosen yet on a fresh install.
  await expect(voices.getByRole("radio", { checked: true })).toHaveCount(0);
  // Voices not on the speech machine yet say so plainly, and cannot be heard; choosing works.
  // Hearth sets the rest up from right here: it already found the speech service, and offers
  // to set voice up on this computer.
  const note = page.getByTestId("voice-setup-note");
  await expect(note).toContainText("Some voices aren't on the speech service yet");
  await expect(note.getByTestId("voice-found")).toContainText("Speech machine (test)");
  await expect(note.getByTestId("voice-install")).toBeVisible();
  await expect(voices.getByRole("button", { name: "Hear Operator" })).toBeDisabled();
  await expect(voices).toContainText("This voice isn't on the speech service yet");
  await expect(voices).toContainText("Speaks through its voice box.");
  await voices.getByRole("radio", { name: /^Operator/ }).click();
  await expect(voices.getByRole("radio", { name: /^Operator/ })).toBeChecked();
  await expect
    .poll(async () => (await (await page.request.get("/api/voice")).json()).active)
    .toBe("operator");
  // Choosing a voice never names it: still Ember.
  expect((await workspace()).aiName).toBeUndefined();
  await voices.getByRole("radio", { name: /^Guardian/ }).click();
  await expect
    .poll(async () => (await (await page.request.get("/api/voice")).json()).active)
    .toBe("warden");
  // A real preview through the speech machine, with the chosen profile.
  const preview = page.waitForRequest(
    (r) => r.url().endsWith("/api/voice/speak") && r.method() === "POST",
  );
  await voices.getByRole("button", { name: "Hear Guardian" }).click();
  expect(JSON.parse((await preview).postData() ?? "{}")).toMatchObject({ profile: "warden" });
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("3-voice");
  await next.click();
  await expect(progress).toHaveText("Step 6 of 8: Its look");

  // 4. Its look: every look is offered, whatever the voice.
  await expect(heading).toHaveText("Ember's look");
  const picker = page.getByTestId("look-picker");
  // The ten Ember pictures, named, Classic first; any goes with any voice (46.16).
  await expect(picker.getByRole("radio")).toHaveCount(10);
  await expect(picker.getByRole("radio").first()).toHaveAccessibleName("Classic Ember (default)");
  await expect(picker).toContainText("Cozy Ember");
  const look = (label: string) => picker.getByRole("radio", { name: label, exact: true });
  // A new install starts on Classic Ember.
  await expect(look("Classic Ember (default)")).toBeChecked();
  // Keyboard: arrow keys move between looks.
  await look("Classic Ember (default)").focus();
  await page.keyboard.press("ArrowRight");
  await expect(look("Chatty Ember")).toBeChecked();
  await expect.poll(async () => await profileAvatar("warden")).toBe("/avatars/ember-chatty.webp");
  await look("Detective Ember").check();
  await expect
    .poll(async () => await profileAvatar("warden"))
    .toBe("/avatars/ember-detective.webp");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("4-look");

  // Your own picture, from your library: used at once, and removing it goes back to the default.
  await page.getByTestId("ai-picture-input").setInputFiles({
    name: "my-dragon.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(look("Your own picture")).toBeChecked();
  await expect.poll(async () => await profileAvatar("warden")).toBe("/api/ai/avatar");
  expect((await page.request.get("/api/ai/avatar")).headers()["content-type"]).toBe("image/jpeg");
  await shot("4-look-own");
  await page.getByRole("button", { name: "Remove your picture" }).click();
  await expect(look("Your own picture")).toHaveCount(0);
  await expect.poll(async () => await profileAvatar("warden")).toBe("/avatars/ember-classic.webp"); // back to the default
  expect((await page.request.get("/api/ai/avatar")).status()).toBe(404);
  await look("Detective Ember").check();
  await expect
    .poll(async () => await profileAvatar("warden"))
    .toBe("/avatars/ember-detective.webp");

  // The Guardian's voice can wear a woman's look too: the owner chooses.
  await look("Manager Ember").check();
  await expect.poll(async () => await profileAvatar("warden")).toBe("/avatars/ember-manager.webp");
  await look("Detective Ember").check();
  await expect
    .poll(async () => await profileAvatar("warden"))
    .toBe("/avatars/ember-detective.webp");

  // Back to the voice: a woman's voice is offered every look as well, a man's included.
  await page.getByRole("button", { name: "Back" }).click();
  await voices.getByRole("radio", { name: /^Operator/ }).click();
  await expect
    .poll(async () => (await (await page.request.get("/api/voice")).json()).active)
    .toBe("operator");
  await next.click();
  await expect(picker.getByRole("radio")).toHaveCount(10);
  await look("Gamer Ember").check();
  await expect.poll(async () => await profileAvatar("operator")).toBe("/avatars/ember-gamer.webp");
  await look("Arcane Ember").check();
  await expect.poll(async () => await profileAvatar("operator")).toBe("/avatars/ember-arcane.webp");
  // Each voice keeps its own look.
  expect(await profileAvatar("warden")).toBe("/avatars/ember-detective.webp");
  expect((await workspace()).aiName).toBeUndefined();
  await next.click();

  // 5. Personality: style only.
  await expect(progress).toHaveText("Step 7 of 8: Personality");
  await expect(page.locator("main")).toContainText("never what it may do");
  await page
    .getByRole("radiogroup", { name: "Humor" })
    .getByRole("radio", { name: "Playful" })
    .click();
  await expect(
    page.getByRole("radiogroup", { name: "Humor" }).getByRole("radio", { name: "Playful" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("5-personality");
  await next.click();

  // 6. Theme
  await expect(progress).toHaveText("Step 8 of 8: Theme");
  await page
    .getByRole("radiogroup", { name: "Theme" })
    .getByRole("radio", { name: /^Dragonfire/ })
    .click();
  await expect.poll(async () => (await workspace()).theme?.preset).toBe("ember");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("6-theme");
  await page.getByRole("button", { name: "Finish" }).click();

  // Done
  await expect(heading).toHaveText("All set");
  await expect(page.getByTestId("onboarding-stages").locator("[aria-current=step]")).toContainText(
    "Finish",
  );
  // Skipped: it says Ember is waiting for an AI service, and offers nothing that needs one.
  await expect(page.getByTestId("welcome-ai-status")).toContainText(
    "Ember is waiting for an AI service. Everything else in Hearth works without one",
  );
  const paths = page.getByTestId("welcome-paths");
  await expect(paths.getByRole("button", { name: "Meet Ember" })).toHaveCount(0);
  // The beginner's plan stays one click away.
  await expect(paths.getByRole("button", { name: "Build my setup" })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await shot("7-done");
  await page.getByRole("button", { name: "Enter Hearth" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("headline")).toBeVisible();
  ws = await workspace();
  expect(ws).toMatchObject({ onboardingNeeded: false, ownerName: "Alex" });
  expect(ws.aiName).toBeUndefined();
  await expect(page.getByTestId("cave-hub-name")).toHaveText("Ember");
  expect(ws.onboardingDoneAt).toBeTruthy();
  // Finished: the saved step is gone, so it is never resumed again.
  expect(ws.onboardingStep).toBeUndefined();
  const personality = await (await page.request.get("/api/agent/personality")).json();
  expect(personality.humor).toBe("playful");
});

test("does not appear again once done", async () => {
  for (const url of ["/", "/services", "/settings"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(url);
  }
});

test("an owner with saved settings never sees it, but can run it again from Settings", async () => {
  // Even with the welcome offered again, choices already saved mean it stays away.
  await page.request.patch("/api/settings", { data: { onboardingDone: false } });
  expect((await workspace()).onboardingNeeded).toBe(false);
  await page.goto("/");
  await expect(page.getByTestId("headline")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");

  await page.goto("/settings");
  await page.getByRole("link", { name: "Run the setup again" }).click();
  await expect(page).toHaveURL(/\/welcome\?step=ai$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect Ember's AI");
  await page.getByTestId("ai-skip").click();
  // Then Hello, with the path chosen before still marked.
  await expect(page.getByTestId("welcome-path-build")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByLabel("Your name")).toHaveValue("Alex");
  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("Connect your AI: a failed test says what to do, a passing one connects, and the finish says so", async () => {
  test.setTimeout(60_000);
  // An owner who finished setup reruns it (the welcome stays away on its own, as above).
  await page.request.patch("/api/settings", { data: { onboardingDone: false } });
  await page.goto("/welcome?step=ai");
  const results = page.getByTestId("ai-test-results");
  await page.request.post("/api/agent/claude/sign-out", { data: {} });
  await page.reload();
  await expect(results).toContainText("Installed on this computer: passed");
  await expect(results).toContainText("Signed in to your Anthropic account: not tested");
  const setup = page.getByTestId("ai-setup-claude-code");
  await expect(setup).not.toContainText("sudo");
  await expect(setup).not.toContainText("hearth-svc");

  // Connect: Hearth starts Claude Code's sign-in and opens Anthropic's page in a new tab (the
  // stand-in for Anthropic here), then waits for the code that page shows.
  await page
    .context()
    .route("https://claude.com/**", (r) => r.fulfill({ body: "Anthropic sign-in (test)" }));
  const opened = page.waitForEvent("popup");
  await page.getByTestId("claude-connect").click();
  const tab = await opened;
  await expect.poll(() => tab.url()).toContain("https://claude.com/cai/oauth/authorize");
  await tab.close();
  await expect(page.getByTestId("claude-sign-in-link")).toHaveAttribute(
    "href",
    /^https:\/\/claude\.com\/cai\/oauth\/authorize/,
  );
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("ai-sign-in");

  // A code Anthropic refuses is explained, and the sign-in keeps waiting for the right one.
  await page.getByTestId("claude-code-input").fill("WRONGCODE1#x");
  await page.getByTestId("claude-code-submit").click();
  await expect(page.getByTestId("claude-sign-in-error")).toContainText("did not accept that code");
  await page.getByTestId("claude-code-input").fill("TESTCODE123#TESTSTATE");
  await page.getByTestId("claude-code-submit").click();

  // Signed in: Hearth checks the connection and connects by itself.
  await expect(page.getByTestId("ai-connected")).toContainText(
    "Ember is connected to Claude Code.",
    { timeout: 30_000 },
  );
  await expect(page.getByTestId("claude-account")).toContainText("owner@example.com");
  await expect(results).toContainText("read Hearth's overview through its own tools");
  await shot("ai-tested");
  await expect(page.getByTestId("ai-option-claude-code")).toContainText("Connected");
  await expect.poll(async () => (await workspace()).operator.agentId).toBe("claude-code");
  // Connected: no Skip any more, and Next moves on.
  await expect(page.getByTestId("ai-skip")).toHaveCount(0);
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByTestId("welcome-progress")).toHaveText("Step 1 of 8: Hello");

  // Leaving and coming back resumes here, not at the start.
  await expect.poll(async () => (await workspace()).onboardingStep).toBe("hello");
  await page.goto("/welcome");
  await expect(page.getByTestId("welcome-progress")).toHaveText("Step 1 of 8: Hello");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("ai-connected")).toBeVisible();

  // The finish says Ember is connected, and Enter Hearth opens it for good.
  await page.goto("/welcome?step=done");
  await expect(page.getByTestId("welcome-ai-status")).toHaveText(
    "Ember is connected to Claude Code.",
  );
  await expect(
    page.getByTestId("welcome-paths").getByRole("button", { name: "Meet Ember" }),
  ).toBeVisible();
  await shot("done-connected");
  await page.getByRole("button", { name: "Enter Hearth" }).click();
  await expect(page).toHaveURL(/\/$/);
  const ws = await workspace();
  expect(ws.onboardingDoneAt).toBeTruthy();
  expect(ws.onboardingStep).toBeUndefined();
  await page.goto("/settings");
  expect(new URL(page.url()).pathname).toBe("/settings");

  // Running the setup again from Settings shows the AI as connected and changes nothing.
  await page.getByRole("link", { name: "Run the setup again" }).click();
  await expect(page).toHaveURL(/\/welcome\?step=ai$/);
  await expect(page.getByTestId("ai-connected")).toContainText(
    "Ember is connected to Claude Code.",
  );
  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await workspace()).operator.agentId).toBe("claude-code");

  // The AI can be changed or disconnected later, from the AI Agent page.
  await page.goto("/agent");
  await page.getByRole("button", { name: "Disconnect" }).first().click();
  await expect(page.getByText("No operator connected")).toBeVisible();
  await expect(page.getByTestId("connect-ai")).toBeVisible();
  expect((await workspace()).operator.agentId ?? undefined).toBeUndefined();
});

test("the AI's name and look can be changed later in Settings", async () => {
  await page.goto("/settings#cave");
  // The name box shows the title the AI goes by until a name is typed.
  const identity = page.getByRole("region", { name: "Ember: identity" });
  await expect(identity.getByLabel("AI administrator name")).toHaveAttribute(
    "placeholder",
    "Ember",
  );
  // A typed name is kept, and choosing another voice never replaces it.
  await identity.getByLabel("AI administrator name").fill("Warden");
  await identity.getByRole("button", { name: "Save name" }).click();
  await expect.poll(async () => (await workspace()).aiName).toBe("Warden");

  const voice = page.getByRole("region", { name: "Ember: voice" });
  const scholar = voice.getByTestId("voice-profile-scholar");
  // A voice not in use has no picture of its own to edit: it's chosen when switching to it.
  await expect(scholar.getByRole("button", { name: "Change look" })).toHaveCount(0);
  await scholar.getByRole("button", { name: "Use Scholar" }).click();
  const choose = page.getByTestId("picture-for-voice");
  const picker = choose.getByTestId("look-picker");
  // Every look is offered with every voice.
  await expect(picker.getByRole("radio")).toHaveCount(10);
  await picker.getByRole("radio", { name: "Cozy Ember", exact: true }).check();
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("settings-look");
  await choose.getByRole("button", { name: "Use Scholar with this picture" }).click();
  await expect(choose).toHaveCount(0);
  await expect.poll(async () => await profileAvatar("scholar")).toBe("/avatars/ember-cozy.webp");
  await expect.poll(async () => (await workspace()).aiName).toBe("Warden");
  await page.request.patch("/api/settings", { data: { aiName: "" } });
  await expect.poll(async () => (await workspace()).aiName).toBeUndefined();
  await page.goto("/ask");
  await expect(page.getByLabel("Ask Ember")).toBeVisible();
});

test("changing the voice asks for a picture: keep it, a character, the flame, or your own", async () => {
  const voices = async () =>
    (await (await page.request.get("/api/voice")).json()) as {
      active?: string;
      profiles: { id: string; avatar?: string }[];
    };
  const reset = await voices();
  // Start with no voice in use (another test may have left one on).
  const cfg = (await (await page.request.get("/api/voice")).json()) as Record<string, unknown>;
  await page.request.put("/api/voice", {
    data: { host: cfg.host, sttPort: cfg.sttPort, ttsPort: cfg.ttsPort, profiles: reset.profiles },
  });
  await page.goto("/settings#cave");
  const voice = page.getByRole("region", { name: "Ember: voice" });
  const use = async (name: string) => {
    await voice.getByRole("button", { name: `Use ${name}`, exact: true }).click();
    return page.getByTestId("picture-for-voice");
  };
  const look = (sheet: ReturnType<typeof page.getByTestId>, label: string) =>
    sheet.getByTestId("look-picker").getByRole("radio", { name: label, exact: true });

  // Start on the Scholar with a man's picture.
  let sheet = await use("Scholar");
  await look(sheet, "IT Ember").check();
  await sheet.getByRole("button", { name: "Use Scholar with this picture" }).click();
  await expect.poll(async () => (await voices()).active).toBe("scholar");

  // Cancel changes nothing: same voice, same picture.
  sheet = await use("Companion");
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  expect((await voices()).active).toBe("scholar");

  // Keep it: the Companion takes the picture Ember has now.
  sheet = await use("Companion");
  await expect(sheet).toContainText("Keep the picture Ember has now");
  await sheet.getByRole("button", { name: "Keep it" }).click();
  await expect.poll(async () => (await voices()).active).toBe("companion");
  expect(await profileAvatar("companion")).toBe("/avatars/ember-it.webp");

  // Any picture can be kept with any voice: a man's picture with a woman's voice.
  sheet = await use("Operator");
  await expect(sheet.getByTestId("look-picker").getByRole("radio")).toHaveCount(10);
  await sheet.getByRole("button", { name: "Keep it" }).click();
  await expect.poll(async () => (await voices()).active).toBe("operator");
  expect(await profileAvatar("operator")).toBe("/avatars/ember-it.webp");

  // And any character can be chosen with any voice: a woman's look with a man's voice.
  sheet = await use("Scholar");
  await look(sheet, "Cosmic Ember").check();
  await sheet.getByRole("button", { name: "Use Scholar with this picture" }).click();
  await expect.poll(async () => (await voices()).active).toBe("scholar");
  expect(await profileAvatar("scholar")).toBe("/avatars/ember-cosmic.webp");

  // Ember's flame.
  sheet = await use("Operator");
  await look(sheet, "Classic Ember (default)").check();
  await sheet.getByRole("button", { name: "Use Operator with this picture" }).click();
  await expect.poll(async () => (await voices()).active).toBe("operator");
  expect(await profileAvatar("operator")).toBe("/avatars/ember-classic.webp");

  // Your own picture, uploaded from your library while choosing.
  sheet = await use("Warden");
  await sheet.getByTestId("ai-picture-input").setInputFiles({
    name: "my-picture.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await expect(look(sheet, "Your own picture")).toBeChecked();
  await sheet.getByRole("button", { name: "Use Warden with this picture" }).click();
  await expect.poll(async () => (await voices()).active).toBe("warden");
  expect(await profileAvatar("warden")).toBe("/api/ai/avatar");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);

  // Nothing else moved: the name, personality, and conversations are untouched by any of it.
  expect((await workspace()).aiName).toBeUndefined();

  // Leave the voices as they were, and remove the uploaded picture.
  await page.request.delete("/api/ai/avatar");
  const now = (await (await page.request.get("/api/voice")).json()) as Record<string, unknown>;
  await page.request.put("/api/voice", {
    data: {
      host: now.host,
      sttPort: now.sttPort,
      ttsPort: now.ttsPort,
      active: reset.active,
      profiles: reset.profiles,
    },
  });
});

test("Home: the AI's name sits clear of its portrait, with the default and a gallery look", async () => {
  const setLook = async (avatar: string) => {
    const v = await (await page.request.get("/api/voice")).json();
    const res = await page.request.put("/api/voice", {
      data: {
        host: v.host,
        sttPort: v.sttPort,
        ttsPort: v.ttsPort,
        active: "warden",
        profiles: v.profiles.map((p: { id: string }) => (p.id === "warden" ? { ...p, avatar } : p)),
      },
    });
    expect(res.status()).toBe(204);
  };
  for (const [look, file] of [
    // A new install's default, Classic Ember; a retired picture shows as Classic Ember too.
    ["/avatars/ember-classic.webp", "/avatars/ember-classic.webp"],
    ["/avatars/scholar-2.webp", "/avatars/ember-classic.webp"],
    ["/avatars/ember-gamer.webp", "/avatars/ember-gamer.webp"],
  ] as const) {
    await setLook(look);
    await page.goto("/");
    const hub = page.getByTestId("cave-hub");
    const portrait = hub.locator(`img[src="${file}"]`);
    await expect(portrait).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const picture = (await portrait.boundingBox())!;
    const name = (await hub.getByTestId("cave-hub-name").boundingBox())!;
    expect(name.y, "the name starts below the picture").toBeGreaterThanOrEqual(
      picture.y + picture.height,
    );
    await expectNoOverflow(page);
    await shot(
      `hub-${look.includes("gamer") ? "gallery" : look.includes("ember") ? "default" : "retired"}`,
    );
  }
});

test("choosing another character changes the AI's picture everywhere it appears", async () => {
  const v = await (await page.request.get("/api/voice")).json();
  const use = async (active: string) =>
    expect(
      (
        await page.request.put("/api/voice", {
          data: {
            host: v.host,
            sttPort: v.sttPort,
            ttsPort: v.ttsPort,
            profiles: v.profiles,
            active,
          },
        })
      ).status(),
    ).toBe(204);
  const companion = v.profiles.find((p: { id: string }) => p.id === "companion").avatar;
  await use("companion");
  await page.goto("/");
  // The small picture in the sidebar or top bar follows it, and so does the hub portrait where
  // the hub is shown (wide screens).
  await expect(
    page.locator(`img[src="${companion}"]`).locator("visible=true").first(),
  ).toBeVisible();
  const hub = page.getByTestId("cave-hub");
  if (await hub.isVisible()) await expect(hub.locator(`img[src="${companion}"]`)).toBeVisible();
  await expect(page.locator('img[src="/voices/warden-small.webp"]')).toHaveCount(0);
  await use("warden");
});
