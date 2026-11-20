import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// "Help me build" (a plan for someone starting from nothing, against a made-up machine:
// DC_FAKE_DISCOVERY), and what the mic and the War Room say when voice is not set up.

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

test("help me build: human questions, a look at this computer when allowed, and a starter plan with options", async ({
  page,
}, testInfo) => {
  const shot = (name: string) =>
    page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/plan-${name}.png`,
      fullPage: true,
    });
  // Start from an empty plan (the other screen size's run saved one on this shared server).
  await page.request.delete("/api/plan");
  // And the account choice back to the default (the other screen size's run saved its own).
  await page.request.put("/api/plan/accounts", {
    data: { email: "start@example.com", username: "start", passwords: "generate" },
  });
  await page.goto("/plan");
  const progress = page.getByTestId("plan-progress");
  // Exactly "Next": apps another test left behind (Nextcloud) have buttons that start with it.
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(progress).toHaveText("Step 1 of 7: What would you love to do?");

  // 1. Wishes: several at once; "not sure" stands alone.
  const wants = page.getByTestId("plan-q-wants");
  await wants.getByLabel("I'm not sure yet, show me what's possible").check();
  await wants.getByLabel("Watch my own movies and shows, like my own Netflix").check();
  await expect(wants.getByLabel("I'm not sure yet, show me what's possible")).not.toBeChecked();
  await wants.getByLabel("Ask for a movie or show and have it turn up on its own").check();
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("1-wishes");
  await next.click();

  // 2. About you
  await expect(progress).toHaveText("Step 2 of 7: A little about you");
  await page
    .getByTestId("plan-q-experience")
    .getByLabel("Brand new: I've never set up a server")
    .check();
  await page.getByTestId("plan-q-budget").getByLabel("Keep it free").check();
  await page.getByTestId("plan-q-pace").getByLabel("Build it for me and explain as we go").check();
  await next.click();
  // 3. What you have: the "already use Plex" question appears once they have media.
  await expect(page.getByTestId("plan-q-existingServer")).toHaveCount(0);
  await page.getByTestId("plan-q-media").getByLabel("Yes, on an external drive").check();
  await expect(page.getByTestId("plan-q-existingServer")).toBeVisible();
  await page.getByTestId("plan-q-existingServer").getByLabel("No", { exact: true }).check();
  await next.click();
  // 4. How you'll enjoy it
  await page.getByTestId("plan-q-devices").getByLabel("Roku").check();
  await page.getByTestId("plan-q-away").getByLabel("Just at home").check();
  await next.click();
  // Answers save as they go, so it can be left and resumed.
  await expect
    .poll(async () => (await (await page.request.get("/api/plan")).json()).saved?.answers?.media)
    .toBe("external");

  // 5. The computer: asked first, and nothing is looked at until they say yes.
  await expect(progress).toHaveText("Step 5 of 7: Your computer");
  await expect(page.getByTestId("plan-permission")).toContainText(
    "I won't change, move, or open anything.",
  );
  await expect(page.getByRole("button", { name: "See my plan" })).toBeDisabled();
  await page.getByRole("button", { name: "Yes, take a look" }).click();
  const scan = page.getByTestId("plan-scan");
  await expect(scan).toContainText("can convert video");
  await expect(scan).toContainText("412 videos");
  await expect(page.locator("main")).toContainText("I looked at sample-server");
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("5-computer");
  await page.getByRole("button", { name: "See my plan" }).click();

  // 6. The plan: capabilities first, a starter build, options explained, approvals listed.
  await expect(progress).toHaveText("Step 6 of 7: Your plan");
  const result = page.getByTestId("plan-result");
  await expect(page.getByTestId("plan-summary")).toContainText("Your starter build");
  const media = page.getByTestId("plan-choice-media-app");
  await expect(media.getByRole("radio", { name: /Jellyfin/ })).toBeChecked();
  await expect(media).toContainText("Recommended for you");
  await expect(media).toContainText("It's your call.");
  for (const id of ["jellyfin", "seerr", "radarr", "sonarr", "prowlarr", "qbittorrent"])
    await expect(result.getByTestId(`plan-item-${id}`)).toBeVisible();
  await expect(result.getByTestId("plan-item-qbittorrent")).toContainText("A VPN that allows P2P");
  // Jellyfin is reused when the sample server already runs it (other tests change that).
  await expect(result.getByTestId("plan-item-jellyfin")).toContainText(
    /Already running: reused|Runs comfortably here/,
  );
  await expect(result.getByTestId("plan-item-seerr")).toContainText(
    /Already running: reused|Runs comfortably here/,
  );
  await expect(page.getByTestId("plan-approvals")).toContainText(
    "Linking your VPN before any download starts",
  );
  // Downloads are part of this starter, and a P2P VPN is recommended for a free budget.
  await expect(
    page.getByTestId("plan-choice-downloads").getByRole("radio", { name: /Yes, request it/ }),
  ).toBeChecked();
  const vpn = page.getByTestId("plan-choice-vpn");
  await expect(vpn.getByRole("radio", { name: /Proton VPN/ })).toBeChecked();
  await expect(vpn).toContainText("no good free option");
  // A second opinion from the AI, ready to ask.
  await expect(page.getByRole("link", { name: "Have Ember review my plan" })).toHaveAttribute(
    "href",
    /\/ask\?q=Please%20review%20my%20homelab%20plan/,
  );
  await expect(page.getByTestId("plan-approvals")).toContainText("nothing is ever bought for you");
  // Choosing Plex instead swaps the media app and its request app.
  await media.getByRole("radio", { name: /Plex/ }).check();
  await expect(result.getByTestId("plan-item-plex")).toBeVisible();
  await expect(result.getByTestId("plan-item-seerr")).toBeVisible();
  // Leave one out, and ask Ember about another: the question is ready, nothing is sent.
  const sonarr = result.getByTestId("plan-item-sonarr");
  await sonarr.getByRole("button", { name: "Leave this out" }).click();
  // First it says what that would break, and asks.
  const check = sonarr.getByTestId("leave-out-check");
  await expect(check).toContainText(
    "Without Sonarr, Seerr can take show requests but nothing fetches them.",
  );
  await expect(check).toContainText("Now only partly met:");
  await expect(sonarr).not.toContainText("Left out");
  await check.getByRole("button", { name: "Keep it" }).click();
  await expect(check).toHaveCount(0);
  await sonarr.getByRole("button", { name: "Leave this out" }).click();
  await sonarr.getByRole("button", { name: "Leave it out anyway" }).click();
  await expect(sonarr).toContainText("Left out");
  await expect(
    result.getByTestId("plan-item-plex").getByRole("link", { name: "Ask Ember about this" }),
  ).toHaveAttribute("href", /\/ask\?q=.*Plex/);
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("6-plan");

  // "Next: your apps and accounts" saves the plan as finished and shows what it picked, with logos.
  await page.getByRole("button", { name: "Next: your apps and accounts" }).click();
  await expect(progress).toHaveText("Step 7 of 7: Your homelab");
  const homelab = page.getByTestId("your-homelab");
  await expect(homelab.getByTestId("homelab-app-plex")).toContainText("Why Ember picked it:");
  await expect(
    homelab.getByTestId("homelab-app-plex").locator('img[src="/logos/plex.svg"]'),
  ).toBeVisible();
  await expect(homelab.getByTestId("homelab-app-sonarr")).toHaveCount(0); // left out above
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
  await shot("7-homelab");

  // Account details: a password typed here goes to Secure Vault and never comes back.
  const accounts = page.getByRole("form", { name: "Your app accounts" });
  await accounts.getByLabel("Email").fill("sam@example.com");
  await accounts.getByLabel("Username").fill("sam");
  await expect(
    accounts.getByLabel("Make a strong, different one for each app (recommended)"),
  ).toBeChecked();
  await accounts.getByLabel("Use one password I choose for all of them").check();
  await accounts.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
  await accounts.getByLabel("Password again").fill("correct horse battery");
  await expect(accounts).toContainText("The two passwords don't match.");
  await expect(accounts.getByRole("button", { name: "Save my account details" })).toBeDisabled();
  await accounts.getByLabel("Password again").fill("correct horse battery staple");
  await accounts.getByRole("button", { name: "Save my account details" }).click();
  await expect(page.getByTestId("accounts-saved")).toContainText(
    "Your password is in Secure Vault.",
  );
  await expect(page.getByTestId("accounts-saved")).toContainText(
    "nothing has been installed or created",
  );
  const acct = await (await page.request.get("/api/plan/accounts")).text();
  expect(acct).toContain("sam@example.com");
  expect(acct).not.toContain("correct horse");

  const saved = await (await page.request.get("/api/plan")).json();
  expect(saved.saved).toMatchObject({
    confirmed: true,
    removed: ["sonarr"],
    chosen: { "media-app": "plex" },
  });
  const gs = await (await page.request.get("/api/getting-started")).json();
  expect(gs.items.find((i: { id: string }) => i.id === "plan").done).toBe(true);
});

test("help me build: they rank what matters most, the plan follows, and says what changed", async ({
  page,
}, testInfo) => {
  await page.request.delete("/api/plan");
  await page.request.post("/api/plan/scan", { data: {} });
  await page.request.put("/api/plan", {
    data: {
      answers: { wants: ["photos", "smart-home", "ai"], devices: [], dedicated: "shared" },
      removed: [],
    },
  });
  await page.goto("/plan?step=6");
  const ranks = page.getByTestId("plan-priorities");
  await expect(ranks.getByRole("listitem")).toHaveText([
    /1Keep my phone's photos safe at home/,
    /2Run my smart home/,
    /3Try running AI at home/,
  ]);
  await ranks.getByRole("button", { name: 'Move "Try running AI at home" up' }).click();
  await ranks.getByRole("button", { name: 'Move "Try running AI at home" up' }).click();
  await expect(ranks.getByRole("listitem").first()).toContainText("Try running AI at home");
  // Said plainly either way: what was gained and given up, or that it all still fits.
  await expect(page.getByTestId("plan-changes")).toContainText(
    /What changed:|the plan is the same/,
  );
  // AI on a computer with no graphics card that runs it: possible, with the trade-off named.
  await expect(page.getByTestId("plan-item-ollama")).toContainText("a few words a second");
  // The question about this computer being only a server is part of what they have.
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/plan-priorities.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Save this plan" }).click();
  await expect
    .poll(
      async () => (await (await page.request.get("/api/plan")).json()).saved?.answers?.priorities,
    )
    .toEqual(["ai", "photos", "smart-home"]);
  await page.goto("/plan?step=3");
  await expect(page.getByTestId("plan-q-dedicated")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
});

test("help me build: every wish is in one of three groups, with their choices and an undo", async ({
  page,
}, testInfo) => {
  await page.request.delete("/api/plan");
  await page.request.post("/api/plan/scan", { data: {} });
  const wishes = [
    "Watch my own movies and shows, like my own Netflix",
    "Keep my phone's photos safe at home",
    "Run my smart home",
    "Try running AI at home",
  ];
  await page.request.put("/api/plan", {
    data: {
      answers: {
        wants: ["watch", "photos", "smart-home", "ai"],
        devices: [],
        existingServer: "emby",
        media: "external",
      },
      removed: [],
    },
  });
  await page.goto("/plan?step=6");
  const included = page.getByTestId("group-included");
  const notIncluded = page.getByTestId("group-not-included");
  const later = page.getByTestId("group-later");
  await expect(included.getByRole("heading", { name: "Included in your plan" })).toBeVisible();
  await expect(
    notIncluded.getByRole("heading", { name: "Requested but not included" }),
  ).toBeVisible();
  await expect(later.getByRole("heading", { name: "Saved for later" })).toBeVisible();

  // Every wish appears exactly once across the three groups, in their words, with a reason.
  for (const w of wishes)
    await expect(page.getByRole("heading", { name: `“${w}”` })).toHaveCount(1);

  // Emby can't be set up: shown as met another way, waiting for their OK.
  const emby = notIncluded.getByTestId("goal-existing:emby");
  await expect(emby).toContainText("Met another way");
  await expect(emby).toContainText("Your Emby stays as it is");
  await emby.getByRole("button", { name: "That's fine" }).click();
  await expect(included.getByTestId("goal-existing:emby")).toBeVisible();

  // Save a wish for later: it moves, says why, and its room goes elsewhere.
  const photos = included.getByTestId("goal-want:photos");
  await photos.getByRole("button", { name: "Save for later" }).click();
  const saved = later.getByTestId("goal-want:photos");
  await expect(saved).toContainText("Saved for later");
  await expect(saved).toContainText("You saved this for later.");
  await expect(page.getByTestId("plan-changes")).toContainText(
    /Saved for later, as you chose: "Keep my phone's photos safe at home"/,
  );
  await expect(page.getByTestId("plan-item-immich")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/plan-groups.png`,
    fullPage: true,
  });
  // And back, exactly as before.
  await saved.getByRole("button", { name: "Bring it back" }).click();
  await expect(included.getByTestId("goal-want:photos")).toBeVisible();
  await expect(page.getByTestId("plan-item-immich")).toBeVisible();

  // Decisions are saved with the plan (the choice only; the server dates it).
  await page.getByRole("button", { name: "Save this plan" }).click();
  await expect
    .poll(async () => (await (await page.request.get("/api/plan")).json()).saved?.decisions)
    .toMatchObject({ "existing:emby": { choice: "accept" } });
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
});

test("help me build: include it anyway, with the warning first, the plan updated, and the same approvals", async ({
  page,
}, testInfo) => {
  // A fixed, answered computer ("about 8 GB", nothing looked at), so the outcome never depends
  // on the test machine: photos fit, and the smart home always waits for room.
  await page.request.delete("/api/plan");
  await page.request.put("/api/plan", {
    data: { answers: { wants: ["photos", "smart-home"], devices: [] }, removed: [] },
  });
  await page.goto("/plan?step=5");
  await page.getByRole("button", { name: "No, I'll answer myself" }).click();
  await page.getByTestId("plan-manual").getByLabel("About 8 GB").check();
  await page.getByRole("button", { name: "See my plan" }).click();

  const notIncluded = page.getByTestId("group-not-included");
  const included = page.getByTestId("group-included");
  const waiting = notIncluded.getByTestId("goal-want:smart-home");
  await expect(waiting).toContainText("Waiting for room");
  await expect(waiting).toContainText("It needs about 1.0 GB of memory");
  await expect(waiting.getByTestId("goal-adds")).toHaveText(
    "Would add: Home Assistant (about 1 GB, an estimate)",
  );
  await expect(page.getByTestId("plan-item-home-assistant")).toHaveCount(0);
  const approvals = page.getByTestId("plan-approvals");
  const before = await approvals.getByRole("listitem").allInnerTexts();
  expect(before).toContain(
    "Creating your accounts in each app (passwords go straight into Secure Vault; you never type them into chat)",
  );

  // 1. The warning comes first, specific to this computer, and nothing changes yet.
  await waiting.getByRole("button", { name: "Include it anyway" }).click();
  const check = waiting.getByTestId("include-check");
  await expect(check).toContainText("Before you include it anyway:");
  await expect(check).toContainText(
    "Included at your request. The plan now needs about 3.7 GB of memory, and about 2.8 GB is comfortably free here (this computer has 8 GB in all).",
  );
  await expect(check).toContainText("It shares this computer's memory with Immich");
  await expect(check).toContainText(
    "This changes your plan only. Nothing is installed yet, and each install, account, and network change still asks for your approval.",
  );
  await expect(included.getByTestId("goal-want:smart-home")).toHaveCount(0);
  await page.screenshot({
    path: `test-results/screens/${testInfo.project.name}/plan-include-check.png`,
    fullPage: true,
  });

  // 2. They confirm: the plan updates, says what changed, and marks the trade-off.
  await check.getByRole("button", { name: "I understand, include it" }).click();
  const now = included.getByTestId("goal-want:smart-home");
  await expect(now).toContainText("Included anyway");
  await expect(now).toContainText("Included at your request");
  await expect(notIncluded.getByTestId("goal-want:smart-home")).toHaveCount(0);
  await expect(page.getByTestId("plan-item-home-assistant")).toContainText(
    "Possible with trade-offs",
  );
  await expect(page.getByTestId("plan-changes")).toContainText(
    'Now in your plan, with a trade-off: "Run my smart home".',
  );

  // 3. The approvals asked for before anything happens are exactly the same.
  await expect(approvals.getByRole("listitem")).toHaveText(before);

  // 4. Saved as their decision, and the acknowledgment is on record.
  await page.getByRole("button", { name: "Save this plan" }).click();
  await expect
    .poll(async () => (await (await page.request.get("/api/plan")).json()).saved?.decisions)
    .toMatchObject({ "want:smart-home": { choice: "include" } });
  const audit = await (await page.request.get("/api/audit?limit=10")).text();
  expect(audit).toContain(
    'Chose to include \\"Run my smart home\\" in your homelab plan anyway, after seeing the risks (plan only, nothing installed)',
  );

  // 5. Undo puts it back exactly as it was.
  await now.getByRole("button", { name: "Undo my choice" }).click();
  await expect(notIncluded.getByTestId("goal-want:smart-home")).toContainText("Waiting for room");
  await expect(page.getByTestId("plan-item-home-assistant")).toHaveCount(0);
  await expect(approvals.getByRole("listitem")).toHaveText(before);
  expect(await seriousViolations(page)).toEqual([]);
  await expectNoOverflow(page);
});

test("help me build without looking at the computer: one question, and the plan says it's an estimate", async ({
  page,
}) => {
  await page.request.delete("/api/plan");
  await page.goto("/plan?step=5");
  await page.getByRole("button", { name: "No, I'll answer myself" }).click();
  await page.getByTestId("plan-manual").getByLabel("4 GB or less").check();
  await page.getByRole("button", { name: "See my plan" }).click();
  await expect(page.getByTestId("plan-result")).toContainText("This is an estimate");
  // Nothing was looked at.
  expect((await (await page.request.get("/api/plan")).json()).scan).toBeNull();
});

test("without a speech machine, the mic and the War Room say why instead of doing nothing", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const before = await (await page.request.get("/api/voice")).json();
  const config = (host: string) => ({
    host,
    sttPort: before.sttPort,
    ttsPort: before.ttsPort,
    profiles: before.profiles,
    active: before.active,
  });
  expect((await page.request.put("/api/voice", { data: config("") })).status()).toBe(204);
  try {
    await page.goto("/ask");
    const mic = page.getByTestId("mic-not-set-up").first();
    await expect(mic).toBeVisible();
    await mic.click();
    await expect(page.getByTestId("voice-not-set-up").first()).toContainText(
      "Voice isn't set up yet",
    );
    await page
      .getByTestId("voice-not-set-up")
      .first()
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.getByTestId("voice-not-set-up")).toHaveCount(0);

    // The War Room button opens the engine's War Room (Claude Code and Codex); a phone has none.
    if (testInfo.project.name !== "mobile") {
      const warRoom = page.getByTestId("war-room-button").locator("visible=true");
      await expect(warRoom).toHaveAttribute("title", /Claude Code and Codex/);
    }
    expect(await seriousViolations(page)).toEqual([]);
    await expectNoOverflow(page);

    // Settings > Voice sets it up from right here: Hearth looks on its own and offers what it
    // found, or sets voice up on this computer with one button and shows the progress. (The
    // chat opened above is closed first so it doesn't cover the page.)
    await page.evaluate(() => sessionStorage.removeItem("dc-cave-expanded"));
    await page.goto("/settings#cave");
    const note = page.getByTestId("voice-setup-note");
    await expect(note).toContainText("Set up voice");
    await expect(note).toContainText("previews can't play");
    await expect(note.getByTestId("voice-found")).toContainText("Speech machine (test)");
    await expect(note).not.toContainText("pnpm");
    await note.getByTestId("voice-install").click();
    await expect(note.getByTestId("voice-install-done")).toContainText("Speech runs on", {
      timeout: 15_000,
    });
    await expect
      .poll(async () => (await (await page.request.get("/api/voice")).json()).host)
      .toBe("speech.test");
    // Back to none, then one click on what Hearth found does the same.
    expect((await page.request.put("/api/voice", { data: config("") })).status()).toBe(204);
    await page.reload();
    await page.getByTestId("voice-use-speech.test").click();
    await expect
      .poll(async () => (await (await page.request.get("/api/voice")).json()).host)
      .toBe("speech.test");
  } finally {
    await page.request.put("/api/voice", { data: config(before.host) });
  }
});
