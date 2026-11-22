import type { AppKind } from "./apps";

/**
 * Hearth's own features, described for the AI inside it (checklist section 42). The AI's
 * `hearth_help` tool answers "how do I...", "where is..." and "can Hearth..." from this list, the
 * manual section each entry points to, and live facts about this installation.
 *
 * This list DESCRIBES. It never grants anything: what the AI may actually do is decided by the
 * backend (policy, approvals, the vault, Full access), whatever an entry says. An entry claiming
 * an ability the backend does not allow is a documentation bug, not a permission.
 */

/**
 * How finished a feature is in Hearth itself (not whether it works on this installation; see
 * `featureAvailability`).
 *
 * - working: built and usable, proven by the tests in `evidence`.
 * - partial: usable, but some of what it describes is missing (`statusNote` says what).
 * - preview: built, but hidden or waiting on something outside Hearth (`statusNote` says what).
 * - planned: not built. Never describe it as something the owner can use.
 */
export type FeatureStatus = "working" | "partial" | "preview" | "planned";

/** Facts about this installation a feature may need. */
export type FeatureFact =
  | "notify-destination"
  | "media-destination"
  | "movie-night-destination"
  | "rsvp-bot"
  | "hearth-bot-relay"
  | "another-pc";

export type FeatureNeed = { anyApp: AppKind[]; why: string } | { fact: FeatureFact; why: string };

/** What a level of help needs from the owner. */
export type FeatureApproval =
  /** Reads, or saving exactly what the owner asked for. */
  | "none"
  /** A plan the owner approves (some changes may go direct with Full access, never risky ones). */
  | "plan"
  /** The owner's Autonomy settings decide whether it runs or waits for approval. */
  | "autonomy";

export interface FeatureAbility {
  /** What the AI can do, in plain words. */
  what: string;
  /** The AI tools it uses (checked to exist). */
  tools: string[];
  approval: FeatureApproval;
}

export interface FeatureEvidence {
  /** A test file, relative to the repository root. */
  file: string;
  /** The test's title, exactly as written in that file. */
  test: string;
}

/**
 * Where "Open it for me" takes the owner (checklist 42.2). Only Hearth's own pages and panels:
 * never an outside address, and opening something never changes anything.
 *
 * - page: a registered route, with an optional #section (/notifications#media-announcements).
 * - panel: Hearth's Storage & Files panel, on one of its tabs.
 * - app: the panel of the first of these apps this installation has, on one of its tabs.
 */
export type FeatureOpen =
  | { page: string }
  | {
      panel:
        | "storage"
        | "todo"
        | "browser"
        | "home-rows"
        | "downloads"
        | "curator"
        | "movie-nights"
        | "crucible";
      tab?: string;
    }
  | { app: AppKind[]; tab?: string };

export interface Feature {
  id: string;
  name: string;
  /** One sentence: what it is for. */
  summary: string;
  /** How people ask about it ("invite friends to a watch party"). Lower case. */
  aliases: string[];
  where: {
    /** A page of Hearth (a registered route, with a Settings tab as #tab), if it has one. */
    route?: string;
    /** How to get there, in the interface's own words. */
    path: string;
  };
  /** Where "Open it for me" goes, when it is not simply `where.route` (see `featureOpen`). */
  open?: FeatureOpen;
  /** Exact on-screen text (checked against the interface's source). Descriptions go elsewhere. */
  labels: string[];
  status: FeatureStatus;
  /** What is missing or what it waits on (required unless working). */
  statusNote?: string;
  /** Tests that prove it works (required for working, partial and preview). */
  evidence: FeatureEvidence[];
  /** What this installation needs before the owner can use it. */
  needs?: FeatureNeed[];
  /**
   * Only the owner can do this, and why (their sign-in, Ember's own permissions, updates). Absent
   * with no `ember` either: nothing is recorded, which is not "Ember cannot" (the 11-03 handoff).
   */
  ownerOnly?: string;
  /** What the AI can do beyond explaining. */
  ember?: {
    /** Read it, check it, or prepare something for the owner to review. */
    prepare?: FeatureAbility;
    /** Carry it out. */
    execute?: FeatureAbility;
  };
}

const E2E = (name: string) => `tests/e2e/${name}`;
const SMOKE = E2E("smoke.spec.ts");
const PANELS = E2E("panels.spec.ts");
const WAR = E2E("war-room.spec.ts");
const MEDIA_SERVER: FeatureNeed = {
  anyApp: ["plex", "jellyfin"],
  why: "a media server (Plex or Jellyfin) Hearth watches",
};
const PLAN_CHANGE = (what: string, tools: string[] = []): FeatureAbility => ({
  what,
  tools: [...tools, "propose_job"],
  approval: "plan",
});
const READS = (what: string, tools: string[]): FeatureAbility => ({
  what,
  tools,
  approval: "none",
});
/** A change to Hearth itself: read it with hearth_api, then one hearth-api-call plan step. */
const HEARTH_PLAN = (what: string): FeatureAbility => ({
  what: `${what}: read it with hearth_api, then propose one hearth-api-call plan (serviceId "hearth") the owner approves`,
  tools: ["hearth_api", "propose_job"],
  approval: "plan",
});
const APP_API_CHANGE = (what: string): FeatureAbility => ({
  what: `${what}, through the app's own API with its vault key`,
  tools: ["app_api"],
  approval: "plan",
});

export const FEATURES: Feature[] = [
  {
    id: "capabilities",
    name: "What Hearth can do",
    summary: "The short list of everything Hearth does, by area.",
    aliases: [
      "what can hearth do",
      "what does hearth do",
      "what can you do for me",
      "actually do for me",
      "do for me",
      "what is hearth",
      "features",
      "what can ember do",
    ],
    where: { path: "The manual's first section; Ember answers it" },
    labels: ["What can Hearth do?"],
    status: "working",
    evidence: [
      {
        file: "apps/server/src/engine/guide.test.ts",
        test: "points to the full manual, which starts with what Hearth can do",
      },
    ],
  },
  {
    id: "first-run-setup",
    name: "First-run setup",
    summary: "Securing a new Hearth, connecting an AI, and making it yours.",
    aliases: [
      "setup",
      "set up hearth",
      "first run",
      "run setup again",
      "onboarding",
      "install hearth",
    ],
    where: { route: "/settings#general", path: "Settings, General, First-run setup" },
    labels: ["Secure Hearth", "Run the setup again", "Skip for now"],
    status: "working",
    evidence: [
      {
        file: E2E("onboarding.spec.ts"),
        test: "walks all seven steps, saving each one as it goes",
      },
      {
        file: E2E("onboarding.spec.ts"),
        test: "an owner with saved settings never sees it, but can run it again from Settings",
      },
    ],
    ember: { execute: HEARTH_PLAN("Carry out a first-run setup step") },
  },
  {
    id: "plan-first-homelab",
    name: "Plan my first homelab",
    summary: "A guided plan for someone with no homelab yet: what to run on this computer and why.",
    aliases: [
      "build a homelab",
      "first homelab",
      "start a homelab",
      "never had a homelab",
      "what should i run",
      "help me build",
      "create a homelab",
    ],
    where: { route: "/plan", path: "Build my setup (from setup's finish, or Home)" },
    labels: ["Build my setup", "Recommended for you", "Start over"],
    status: "partial",
    statusNote:
      "The plan is built here; Ember then builds it with you, step by step (see build-homelab), on Linux for now.",
    evidence: [
      {
        file: E2E("plan.spec.ts"),
        test: "help me build: human questions, a look at this computer when allowed, and a starter plan with options",
      },
    ],
  },
  {
    id: "build-homelab",
    name: "Hearth installs your homelab",
    summary: "Hearth setting up the planned apps itself, with their accounts.",
    aliases: [
      "install the apps for me",
      "set up plex for me",
      "build it for me",
      "install sonarr",
      "automatically install",
      "install and configure my entire homelab",
      "set up my whole homelab",
    ],
    where: {
      route: "/plan",
      path: "Plan, Your homelab: save your account details, then Build it with Ember",
    },
    labels: [
      "Build it with",
      "Building your homelab",
      "Save my VPN login",
      "Copy the command",
      "Or install it yourself",
    ],
    status: "partial",
    statusNote:
      "Linux (Ubuntu, Debian, Fedora and their relatives): Docker, Jellyfin or Plex (with Plex the owner signs in on its page), Seerr, Radarr, Sonarr, Prowlarr, qBittorrent through the VPN, the connections between them, and Tailscale. Docker and Tailscale need root: the first time a plan needs one, the step gives the reason and two ways, Hearth's admin helper (a fixed list of operations, each use approved) or the vendor's own commands run by the owner. Downloading is only ever set up with a VPN that allows P2P. The shared folder, backups and the other apps are not built yet, and Windows plans only.",
    evidence: [
      {
        file: "apps/server/src/build/service.test.ts",
        test: "asks about the admin helper only when Docker is needed, with the reason and both ways",
      },
      {
        file: "apps/server/src/build/service.test.ts",
        test: "makes the next step a plan to approve, with the details from Hearth, not the AI",
      },
      {
        file: "apps/server/src/build/apps.docker.test.ts",
        test: "connects the apps, each read back from the app it was added to",
      },
    ],
    ember: {
      prepare: READS("See where building the plan stands", ["homelab_build"]),
      execute: {
        what: "Propose the next step of the plan",
        tools: ["homelab_build"],
        approval: "plan",
      },
    },
  },
  {
    id: "discovery",
    name: "Find what I already run (Discovery)",
    summary: "Hearth looks at this machine and its containers and suggests what to watch.",
    aliases: ["discover", "find my apps", "scan my server", "find what i run", "add my containers"],
    where: { route: "/discover", path: "Systems, Discover (or Discover this machine on Home)" },
    labels: ["Discover this machine", "Needs a name", "Start over"],
    status: "working",
    evidence: [
      { file: SMOKE, test: "discovering this machine replaces sample data with your systems" },
    ],
    ember: { execute: HEARTH_PLAN("Run discovery and add what it finds") },
  },
  {
    id: "sample-data",
    name: "Sample data",
    summary: "Sample systems shown before discovery, always labelled.",
    aliases: ["sample data", "fake data", "demo data", "not my systems"],
    where: { route: "/settings#systems", path: "Settings, Systems" },
    labels: ["Show sample data instead", "Keep my systems"],
    status: "working",
    evidence: [{ file: SMOKE, test: "sample data is always labelled as such" }],
    ember: { execute: HEARTH_PLAN("Turn sample data on or off") },
  },
  {
    id: "navigation",
    name: "Finding your way",
    summary: "The top bar, sidebar, search, status dots and the Getting started list.",
    aliases: [
      "where is",
      "find a page",
      "sidebar",
      "top bar",
      "search hearth",
      "getting started",
      "status dot colors",
    ],
    where: { path: "The top bar and the sidebar, on every page" },
    labels: ["Find a service, or start a question"],
    status: "working",
    evidence: [
      {
        file: E2E("getting-started.spec.ts"),
        test: "getting started: built from real state, ticks itself, links, and can be dismissed",
      },
    ],
  },
  {
    id: "home",
    name: "Home",
    summary:
      "One screen: Ember with your active projects from every PC around it (each marked Lair or War Room, with its PC), alert pills, and your systems at a glance. Start a project asks Lair or War Room first.",
    aliases: [
      "home page",
      "dashboard",
      "what needs me",
      "requires your attention",
      "things need you",
      "lair project or war room project",
      "start a project",
    ],
    where: { route: "/", path: "Home (the sidebar's first item)" },
    labels: [
      "Requires your attention",
      "View all alerts",
      "Briefing",
      "Add to to-do",
      "Start in the Lair",
      "Start in the War Room",
    ],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "'N things need you' and the bell open the list of them, not just incidents",
      },
      {
        file: E2E("zones.spec.ts"),
        test: "Start a project asks Lair or War Room first, and Home shows both with their zone and PC",
      },
    ],
  },
  {
    id: "lair",
    name: "The Lair",
    summary:
      "Ember beside your systems' panels, from any page: the homelab zone, with voice chat right there (the ear stops it hearing you).",
    aliases: [
      "lair",
      "voice chat in the lair",
      "ear button",
      "open a panel",
      "panels beside ember",
      "chat with ember",
      "talk to ember",
      "layouts",
    ],
    where: { path: "The Lair button in the top bar" },
    labels: ["The Lair", "Open a panel"],
    status: "working",
    evidence: [
      { file: SMOKE, test: "several panels beside Ember: open, pin, overflow, close, reload" },
      {
        file: E2E("zones.spec.ts"),
        test: "voice chat in the Lair: it hears you, sends it, answers in the same thread; the ear stops it hearing",
      },
    ],
    needs: [],
  },
  {
    id: "ember-opens-panels",
    name: "Ember opens panels for you",
    summary:
      'Ask Ember to open an app ("open Seerr") and its panel opens beside the chat, or at the front on a phone. Works on every Hearth, with Show & Tell on or off; Show & Tell adds pointing at things.',
    aliases: ["open seerr", "open a panel for me", "ember open the app", "bring up radarr"],
    where: { path: "The Lair: ask Ember to open an app" },
    labels: ["The Lair"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "asked to open an app, Ember opens its panel beside the chat, with Show & Tell off",
      },
    ],
    needs: [],
    ember: { prepare: READS("Open a system's panel", ["open_panel"]) },
  },
  {
    id: "lair-arrange",
    name: "Arrange the Lair's systems",
    summary:
      "The row of systems at the top of the Lair in the order you choose: Arrange opens a box where you drag them into order, Done puts it on the bar (kept on Hearth, so a phone's Panels list shows the same order), and Most used first goes back to the automatic order.",
    aliases: [
      "arrange my systems",
      "reorder the systems in the lair",
      "change the order of the systems",
      "most used first",
    ],
    where: { path: "The Lair: the row of systems along the top, Arrange" },
    labels: ["Arrange", "Arrange the systems", "Most used first", "Done"],
    status: "working",
    evidence: [
      {
        file: E2E("lair-arrange.spec.ts"),
        test: "Arrange: drag a system to the front in the box, Done puts it on the bar, and it stays after a reload",
      },
    ],
    needs: [],
  },
  {
    id: "lair-phone",
    name: "Panels on a phone",
    summary:
      "On a phone, Ember and every open panel form a ring: swipe sideways round it (it wraps), or use the arrows, dots and list. Panels keep their place.",
    aliases: [
      "swipe between panels",
      "next panel on my phone",
      "switch panels on a phone",
      "go back to ember on my phone",
      "panel carousel",
      "open a panel on my phone",
      "tablet layout",
    ],
    where: { path: "The Lair on a phone: the bar above the panel" },
    labels: ["Previous panel", "Next panel", "Open panels", "Panels"],
    status: "working",
    evidence: [
      {
        file: E2E("panel-swipe.spec.ts"),
        test: "Ember and three systems: swipe round both ways, wrapping",
      },
      {
        file: E2E("panel-swipe.spec.ts"),
        test: "Panels lists every panel as bubbles; a tap adds it to the ring",
      },
      {
        file: E2E("panel-swipe.spec.ts"),
        test: "the conversations are in the chat's menu, and picking one closes it",
      },
      {
        file: E2E("touch-picker.spec.ts"),
        test: "a drop-down opens Hearth's picker, and the choice reaches the page",
      },
      {
        file: E2E("panel-swipe.spec.ts"),
        test: "a tablet held upright gets the desktop Lair",
      },
      {
        file: E2E("panel-swipe.spec.ts"),
        test: "the buttons and the list do everything a swipe does",
      },
    ],
    needs: [],
  },
  {
    id: "capture",
    name: "Capture",
    summary:
      "A picture of a panel, the whole screen, an item or a region, marked up and attached to your next message. Save puts it in the folder set in Settings > General > Screen captures (on Hearth's computer), or downloads it when none is set.",
    aliases: [
      "screenshot a panel",
      "capture",
      "attach a picture of a panel",
      "show ember a panel",
      "screenshot the screen",
      "capture the whole screen",
      "where screenshots are saved",
      "screen capture folder",
    ],
    where: { path: "The camera icon on a Lair panel, or in the top bar for the whole screen" },
    labels: [],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "contextual screenshots: capture a panel, an item, or a region; sensitive fields left out; mark up; attach; Ember receives the image",
      },
      {
        file: "tests/e2e/screen-capture.spec.ts",
        test: "the camera in the top bar captures the whole Hearth screen",
      },
      {
        file: "tests/e2e/screen-capture.spec.ts",
        test: "Save puts a capture in the folder set in Settings",
      },
    ],
    ownerOnly:
      "A capture is a picture of your screen that you take; Ember can look at one you attach.",
  },
  {
    id: "page-help",
    name: "How this works and Open buttons",
    summary:
      "Help on every page and panel from Hearth's own manual, and Open buttons that take you from Ember's answer to the right page.",
    aliases: ["how this works", "help on this page", "explain this page", "open buttons"],
    where: {
      path: "The question-mark button in the top bar or a panel's header; Open buttons under Ember's answers",
    },
    labels: ["How this works"],
    status: "working",
    evidence: [
      {
        file: E2E("help.smoke.spec.ts"),
        test: "open it for me: Ember's Open buttons reach movie nights, destinations, the vault, Home Assistant and RAID",
      },
    ],
  },
  {
    id: "war-room",
    name: "The War Room",
    summary:
      "Ember full screen: the permanent Lair tab (the Lair's own conversation), projects, the AI tabs, the task queue, Terminal and GitHub.",
    aliases: [
      "war room",
      "lair tab",
      "homelab tab",
      "projects with the ai",
      "task queue",
      "terminal",
      "kill switch",
      "github panel",
    ],
    where: { route: "/war-room", path: "War Room (top bar)" },
    labels: ["War Room", "New project", "Kill switch"],
    status: "working",
    evidence: [
      { file: WAR, test: "the War Room button opens the War Room, and a message gets its reply" },
      {
        file: E2E("zones.spec.ts"),
        test: "the War Room's Lair tab is the Lair's own conversation: always first, never closed",
      },
    ],
  },
  {
    id: "remote-control",
    name: "Remote Control (/rc)",
    summary:
      "Continue a War Room project's or a Lair conversation from the Claude app or claude.ai/code.",
    aliases: ["remote control", "/rc", "rc", "use from my phone claude app", "claude app"],
    where: {
      route: "/war-room",
      path: "Type /rc in a War Room project's message box, or in a Lair conversation",
    },
    labels: [],
    status: "working",
    statusNote:
      'Needs Claude Code on this computer (and as Ember\'s AI, for the Lair). Listed in the Claude app as "Hearth • <PC> • Lair • Main" or "Hearth • <PC> • War Room • <project>", with Hearth\'s tools under the same approvals.',
    evidence: [
      {
        file: "apps/server/src/engine/remote.test.ts",
        test: "connects, mirrors both sides of the conversation, and skips what Hearth typed",
      },
      {
        file: "apps/server/src/agent/lair-remote.test.ts",
        test: "turns on with /rc: Ember's instructions, Hearth's tools, both sides mirrored",
      },
    ],
    ownerOnly: "Remote Control links your own phone or browser to this session, so you start it.",
  },
  {
    id: "chat-login",
    name: "/login (sign Claude Code in from the chat)",
    summary:
      "Sign Claude Code back in on this computer from a Lair or War Room chat, without a terminal.",
    aliases: [
      "/login",
      "login",
      "logged out",
      "signed out",
      "sign claude back in",
      "claude code not logged in",
    ],
    where: { route: "/ask", path: "Type /login in a Lair or War Room message box" },
    labels: [],
    status: "working",
    statusNote:
      "The same sign-in as the AI Agent page. Claude Code refuses /login inside the Claude app (Remote Control), so it is done here.",
    evidence: [
      {
        file: "apps/server/src/agent/login-chat.test.ts",
        test: "gives Anthropic's link, takes the code as the next message, and signs Claude Code in",
      },
      {
        file: E2E("lair-remote.spec.ts"),
        test: "/rc in the Lair: the bar names the session, messages go live, /rc again turns it off",
      },
    ],
    ownerOnly: "Signing in links your own Anthropic account, so you do it.",
  },
  {
    id: "ai-choice",
    name: "Which AI (Claude Code, Codex, Ollama)",
    summary:
      "Choose Ember's brain: Claude Code, Codex, or free Ollama models on your own hardware. Switch from the Lair or the War Room; the conversation carries over.",
    aliases: [
      "switch ai",
      "use codex",
      "use ollama",
      "free ai",
      "local model",
      "change the model",
      "connect claude",
      "which ai",
    ],
    where: {
      route: "/settings#ollama",
      path: "The switch at the top of Ember's panel in the Lair; War Room AI tabs; Settings, Ember, Ollama",
    },
    labels: ["Claude Code", "Codex", "Ollama", "Make a Hearth copy", "Stop using Ollama"],
    status: "working",
    evidence: [
      {
        file: WAR,
        test: "Ollama: a tab next to Claude Code and Codex, set up in Settings, then it answers; the Lair can use it too",
      },
    ],
  },
  {
    id: "openai-compatible",
    name: "Any OpenAI-compatible AI",
    summary: "Hosted or local models that speak the OpenAI API, as Ember's brain.",
    aliases: ["openai api", "lm studio", "chatgpt api", "openrouter"],
    where: { path: "Not available yet" },
    labels: [],
    status: "planned",
    statusNote: "Listed as coming later on the Agents page. Ollama works today.",
    evidence: [],
  },
  {
    id: "full-access",
    name: "What Ember asks before acting",
    summary:
      "The AI is always the full Claude Code, Codex, or Ollama; the owner chooses what it asks first: every change, risky steps, or only serious ones.",
    aliases: [
      "full access",
      "permissions",
      "stop asking me",
      "bypass permissions",
      "approve first",
      "ask before",
      "ask level",
      "strict",
      "moderate",
    ],
    where: {
      route: "/settings#full-access",
      path: "Settings, Ember, What it asks before acting (or the picker in the War Room's footer)",
    },
    labels: ["Ask before every change", "Ask before risky steps", "Ask only before serious steps"],
    status: "working",
    evidence: [
      {
        file: WAR,
        test: "what the AI asks before acting: three choices in the War Room and in Settings, one setting",
      },
    ],
    ownerOnly: "This is Ember's own permission: only you choose it, on the screen.",
  },
  {
    id: "voice",
    name: "Voice",
    summary:
      "Dictation, voice chat, the Standard voice, Advanced character voices, and Home Assistant.",
    aliases: [
      "voice",
      "change ember's voice",
      "talk to ember",
      "speak replies",
      "microphone",
      "dictate",
      "voice chat",
      "wyoming",
    ],
    where: {
      route: "/settings#cave",
      path: "Settings, Ember, voice; the mic and waveform buttons",
    },
    labels: ["Free up voice memory", "Use this voice in Home Assistant", "Hear a sample"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "Standard voice: built in with nothing to set up, and the play button reads a message aloud",
      },
      {
        file: SMOKE,
        test: "voice: speak to the AI, check the words, hear the answer; voice profiles change name and voice",
      },
    ],
    ember: {
      execute: HEARTH_PLAN(
        "Change the voice settings (the active profile, its picture, the speech machine)",
      ),
    },
  },
  {
    id: "personality",
    name: "Personality, name and look",
    summary:
      "Ember's name, picture, enthusiasm, humor and technical detail; Turn on persona makes her talk as the chosen picture.",
    aliases: [
      "rename ember",
      "personality",
      "change the ai's name",
      "ai picture",
      "change ember's picture",
      "ember image",
      "ember mascot",
      "classic ember",
      "gamer ember",
      "ember avatar",
      "persona",
      "turn on persona",
      "detective ember",
      "humor",
      "writing assistance",
    ],
    where: { route: "/settings#cave", path: "Settings, Ember" },
    labels: [
      "AI administrator name",
      "Change picture",
      "Classic Ember",
      "Turn on persona",
      "Enthusiasm",
      "Humor",
      "Technical detail",
    ],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "Ember's personality is set in Settings and says it changes no permissions",
      },
      {
        file: E2E("ai-picture.spec.ts"),
        test: "Ember's picture: the ten Ember pictures, previewed, saved, shown everywhere",
      },
    ],
    ember: { execute: HEARTH_PLAN("Change Ember's name or personality") },
  },
  {
    id: "conversations",
    name: "Ask page and conversations",
    summary: "Earlier conversations with Ember, kept and searchable.",
    aliases: ["old conversations", "chat history", "new conversation", "ask page"],
    where: { route: "/ask", path: "Ask" },
    labels: ["New conversation"],
    status: "working",
    evidence: [{ file: SMOKE, test: "a project keeps its own conversation beside the main one" }],
  },
  {
    id: "crucible",
    name: "The Crucible: Quality & Size",
    summary:
      "Quality and size for movies in plain words, for anyone. Start from No limits, Balanced or Storage-smart, or answer a few questions; then each row is a group of movies (by age, genre, popularity or tag) and a ladder: the quality it tries first and the most it may cost in GB, stepping down when nothing fits, so not finding 4K never means not getting the movie. Each row shows how many of your movies are in it and how many are bigger. Save is one plan you approve, with Undo; moving the movies you already have is a separate choice. It makes Radarr's own profiles and formats (named Hearth · ...), so Radarr enforces them by itself, and never touches profiles you, Recyclarr or Profilarr made. Free. Appears once Radarr or Sonarr is connected. Shows (the Shows tab, Sonarr) work the same way per episode: the last row's sizes become Sonarr's own size limits (a season pack is judged per episode), the other rows choose their qualities; left alone when Recyclarr or Profilarr manages them.",
    aliases: [
      "crucible",
      "quality",
      "quality and size",
      "file size",
      "too big",
      "smaller files",
      "4k",
      "quality profile",
      "storage space",
    ],
    where: { path: "The Lair: The Crucible (once Radarr or Sonarr is connected)" },
    labels: [
      "Answer a few questions",
      "Add a row",
      "Save",
      "Start over",
      "Near misses",
      "Check now",
      "Grab it anyway",
      "Shows",
      "When two releases are the same quality, take the smaller one",
    ],
    status: "working",
    evidence: [
      {
        file: "apps/server/src/apps/crucible-apply.test.ts",
        test: "plans in words, creates Hearth's own profiles and caps, and touches nothing else",
      },
      {
        file: "apps/server/src/apps/crucible-near-miss.test.ts",
        test: "searches up to the budget, oldest missing first, skipping new, found and unwanted ones",
      },
      {
        file: "apps/server/src/apps/crucible-shows.test.ts",
        test: "makes a profile per show row and sets the main row's sizes as Sonarr's per-minute limits",
      },
      {
        file: "apps/server/src/apps/crucible-apply.test.ts",
        test: "adds size bands that score a smaller release of the same quality higher, never enough to upgrade",
      },
      {
        file: "apps/server/src/apps/crucible-apply.test.ts",
        test: "makes a delay profile on the row's tag, tags its movies before any search, and Undo removes it",
      },
    ],
    open: { panel: "crucible" },
    ember: {
      prepare: READS(
        "Set up quality and size: hearth_api GET /api/services/<radarr id>/crucible (the movies, Hearth's profiles, the saved rows). To change it, propose app-crucible-apply (on a Radarr for movie rows, a Sonarr for show rows) with params.setup = the rows as JSON ({preset, movies:[{id,name,group,ladder:[{quality,maxGB}],upgrade,waitHours}], shows:[]}) and params.resort (move existing movies, only if asked) and params.hookBase (Hearth's address, for Radarr's On Movie Added webhook); the owner approves it. Adding a movie: give it its Crucible row's profile (GET /api/crucible has the rows; the row's profile is named Hearth · <row name>), so Radarr's first search uses it. Near misses: GET /api/crucible/near-misses (the daily check's results and settings); a blocked one's closest release is grabbed with an app-arr-grab plan (guid, indexerId, release, title)",
        ["hearth_api"],
      ),
    },
  },
  {
    id: "near-miss",
    name: "Why isn't it grabbing? (near misses)",
    summary:
      "When Radarr or Sonarr hasn't grabbed something, Hearth tells apart 'no release exists' from 'releases exist, and your own rules turned every one down', in plain words, and names the closest one (for example a release just over your size limit). Grab it anyway downloads that one once, for that title only, as a change you confirm; your rules stay as they are.",
    aliases: [
      "near miss",
      "why isn't radarr grabbing",
      "why isn't sonarr grabbing",
      "nothing downloads",
      "over the size limit",
      "grab it anyway",
      "smart quality",
    ],
    where: { path: "Radarr or Sonarr panel: a movie's Pick a release, or Search releases" },
    labels: ["Grab it anyway"],
    status: "working",
    evidence: [
      {
        file: E2E("radarr-panel.spec.ts"),
        test: "Smart Quality: a missing movie whose releases are only over the size limit says so, and offers the closest",
      },
    ],
    ember: {
      prepare: READS(
        "Why isn't Radarr (or Sonarr) grabbing a title: hearth_api GET /api/services/<id>/why-not-grabbed?q=<title> (Sonarr: &season=<n>). Say its answer in your own words; when it has grab, offer that release, and on yes propose grab.operation with grab.params (a one-time download the owner confirms; never loosen the owner's rules for it)",
        ["hearth_api"],
      ),
    },
  },
  {
    id: "thread-looks",
    name: "Thread Looks and conversation search",
    summary:
      "New conversation opens a window of 22 small Ember pictures, each with a one-word name (Sprocket for fixing something, Vinyl for music, Page for media), or No image; picking one shows a Name box with that name filled in (type your own if you like), and OK starts the thread and closes the window. The picture shows only on the thread in the conversation list and the chat's header; Ember herself never changes. Rename a thread or change its picture any time (right-click or press and hold). The search box finds every conversation whose words mention something and opens the thread at that message; it is a plain search on this Hearth, no AI.",
    aliases: [
      "thread looks",
      "thread pictures",
      "conversation pictures",
      "where did we talk about",
      "where did we fix",
      "find an old conversation",
      "search conversations",
      "change a thread's picture",
    ],
    where: { route: "/ask", path: "Ember's conversations: New conversation, and the search box" },
    labels: ["New conversation", "No image", "Change picture", "Where did we talk about…"],
    status: "working",
    evidence: [
      {
        file: E2E("lair-chat.spec.ts"),
        test: "Thread Looks: a new conversation gets a picture and its name, the picture changes, and search opens the thread at the line",
      },
    ],
    ember: {
      prepare: READS(
        "Find where something was talked about (where did we fix Sonarr?): hearth_api GET /api/agent/conversations/search?q=<a few words>, then answer with the thread's name and date, the line that matched, and a link [name](/ask/<id>) that opens it",
        ["hearth_api"],
      ),
    },
  },
  {
    id: "ai-budget",
    name: "Ember's AI use, limit and administration",
    summary:
      "How much of your own AI Ember uses (no money shown; Hearth never charges for AI), the daily limit in runs, host administration and tools. Ember looks after whatever you ask: there is no list of what it may look after.",
    aliases: [
      "ai budget",
      "daily limit",
      "ai cost",
      "ai usage",
      "what does ember look after",
      "host administration",
      "elevated executor",
      "switch model",
      "change model",
      "use fable",
      "use opus",
      "which model",
    ],
    where: { route: "/settings#cave", path: "Settings, Ember" },
    labels: ["Model for questions", "Model", "Most AI runs a day"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "host administration: switched on and off by you, tiers shown, tools looked up",
      },
    ],
    ember: { execute: HEARTH_PLAN("Change the daily AI limit") },
  },
  {
    id: "agents",
    name: "Agents page",
    summary: "The connected AI operator, what it can and cannot do, and its recent work.",
    aliases: ["agents page", "operator", "disconnect the ai", "hand incidents to the ai"],
    where: { route: "/agent", path: "Agents (sidebar)" },
    labels: ["Your operator"],
    status: "working",
    evidence: [{ file: SMOKE, test: "connect the AI operator and talk with it" }],
    ownerOnly: "Connecting an AI account needs your own sign-in to it.",
  },
  {
    id: "services",
    name: "All services",
    summary: "Every watched service with its status, filterable and searchable.",
    aliases: ["all services", "list of services", "what is down", "services page"],
    where: { route: "/services", path: "Systems, All services" },
    labels: ["Filter services"],
    status: "working",
    evidence: [{ file: SMOKE, test: "services can be filtered and searched" }],
    ember: { prepare: READS("List services and their health", ["list_services", "get_overview"]) },
  },
  {
    id: "service-panel",
    name: "A service's panel",
    summary:
      "One service: the app's own tabs, then Hearth's (health, logs, history), sized to the panel's room.",
    aliases: [
      "hearth tabs",
      "sections menu",
      "link to a tab",
      "restart a service",
      "service logs",
      "pause watching",
      "restart plex",
      "read logs",
      "why did it restart",
    ],
    where: {
      route: "/services",
      path: "Click a service in the sidebar, the Lair, or All services",
    },
    labels: ["Pause watching", "Watch it again", "Restart"],
    status: "working",
    evidence: [
      { file: SMOKE, test: "you can restart, test, and read logs from a service page" },
      { file: PANELS, test: "the Hearth menu works from the keyboard" },
      {
        file: PANELS,
        test: "an expanded panel keeps the tab row and the Hearth menu, and returns as it was",
      },
      {
        file: PANELS,
        test: "old links and saved tabs open where they did, and a position inside a tab works",
      },
      {
        file: PANELS,
        test: "a covered panel stops refreshing and refreshes again within 2 s of being shown",
      },
    ],
    ember: {
      prepare: READS("Read its status, logs and history", [
        "get_service",
        "read_logs",
        "resource_history",
      ]),
      execute: { what: "Restart it", tools: ["restart_service"], approval: "autonomy" },
    },
  },
  {
    id: "machines",
    name: "Machines",
    summary: "Your machines, and apps on other computers checked over the network.",
    aliases: ["machines", "another machine", "plex on another computer", "add a machine"],
    where: { route: "/systems", path: "Systems, Machines" },
    labels: ["Add another machine"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "another machine is added by its address and shown as checked over the network",
      },
    ],
    ember: { execute: HEARTH_PLAN("Change a machine's details") },
  },
  {
    id: "memory-breakdown",
    name: "Where the memory goes",
    summary:
      "Every GB on a machine by app, container and Hearth part, a one-approval quick win, and Ember freeing the rest as a plan.",
    aliases: [
      "memory",
      "ram",
      "what is using memory",
      "free up memory",
      "memory is high",
      "close apps",
      "quick win",
      "swap",
    ],
    where: { route: "/systems", path: "Systems, Machines, What's using memory" },
    labels: ["What's using memory", "Quick win", "Ask Ember what else can go", "Close", "Stays"],
    status: "working",
    evidence: [
      {
        file: E2E("memory.spec.ts"),
        test: "Memory: where every GB goes, the quick win in one approval, then closing an app",
      },
      {
        file: "apps/server/src/monitor/memory.test.ts",
        test: "adds up every part, counts container processes once, and groups an app's processes",
      },
    ],
    ember: {
      prepare: READS("Read where the memory goes", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "Close apps (free-memory), stop containers (stop-container) or free the voice, as one plan you approve",
      ),
    },
  },
  {
    id: "ember-mark",
    name: "Ember's mark",
    summary:
      "Every button that starts Ember carries Ember's mark (its face and the AI's name), because pressing it uses your AI plan; buttons without it use no AI. The first press in a browser explains it before anything runs.",
    aliases: [
      "ember mark",
      "does this button use my ai",
      "which buttons use ai",
      "does this use my plan",
      "orange badge on a button",
      "this button starts ember",
    ],
    where: {
      route: "/",
      path: "On every button that starts Ember; its key is beside the plan usage bar in the chat",
    },
    labels: ["This button starts", "Start", "Cancel"],
    status: "working",
    evidence: [
      {
        file: E2E("ember-mark.spec.ts"),
        test: "a button that starts Ember carries the mark and explains itself on the first press",
      },
    ],
  },
  {
    id: "show-and-tell",
    name: "Show & Tell",
    summary:
      "Watch Ember work: it opens what it is really reading on any Hearth screen, points at the part that matters with a caption, and afterwards asks whether to close what it opened.",
    aliases: [
      "show and tell",
      "watch ember work",
      "teach me mode",
      "follow along with ember",
      "ember points at",
    ],
    where: { route: "/settings#show-and-tell", path: "Settings, Ember, Show & Tell" },
    // Show & Tell's own screens (Teach me, Read captions aloud, Tidy up afterwards, Keep this open,
    // Stop following, Show here instead) come with the Premium package and are tested there.
    labels: ["Show me", "Show again"],
    status: "working",
    statusNote:
      "Show & Tell is in the Premium package (its go-between with the screen, Ember's show and tidy_screen tools, and its screens, with their tests, live in the Premium repo). Without it Settings shows what Premium adds and Ember explains in words.",
    evidence: [
      {
        file: E2E("show-free.spec.ts"),
        test: "without the Premium package: Settings says what Show & Tell adds",
      },
      {
        file: "apps/server/src/app.test.ts",
        test: "without Show & Tell or Panel Builder she has neither tool nor instructions for them, and says so in one line",
      },
    ],
    ember: {
      // show and tidy_screen, Ember's tools for it, come with the Premium package.
      prepare: READS("Read what it is examining (pointing at it on screen is Premium)", [
        "hearth_api",
      ]),
    },
  },
  {
    id: "add-remove-system",
    name: "Add or remove a system",
    summary: "Add something discovery missed, or stop watching a system.",
    aliases: ["add a system", "remove a system", "stop watching", "bring back a removed system"],
    where: { route: "/services", path: "Add a system; Remove from Hearth on its panel" },
    labels: ["Add a system", "Remove from Hearth", "Removed systems"],
    status: "working",
    evidence: [
      { file: E2E("systems.spec.ts"), test: "adding a system discovery missed" },
      { file: E2E("systems.spec.ts"), test: "a removed system comes back from Settings" },
    ],
    ember: {
      prepare: READS("Read the systems Hearth watches and the removed ones", ["hearth_api"]),
      execute: HEARTH_PLAN(
        "Add a system (POST /api/services {name, kind, address, category}), stop watching one (POST /api/services/<id>/remove; its history stays) or bring a removed one back (POST /api/services/<id>/restore)",
      ),
    },
  },
  {
    id: "arr-panels",
    name: "Sonarr and Radarr panels",
    summary: "Queue, download trail, missing, coming, upgrades, collections and release search.",
    aliases: [
      "sonarr",
      "radarr",
      "where is my download",
      "download trail",
      "search releases",
      "pick a release",
      "stuck import",
      "missing episodes",
      "upgrades",
    ],
    where: { route: "/services", path: "Open Sonarr or Radarr (sidebar, Lair, or All services)" },
    open: { app: ["sonarr", "radarr"] },
    labels: ["Download trail", "Search releases", "Download this"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "Sonarr dashboard: the download trail shows the download folder, then the renamed file in the library",
      },
      {
        file: E2E("library.smoke.spec.ts"),
        test: "${app} panel: Search releases finds a title and downloads the picked release",
      },
    ],
    needs: [{ anyApp: ["sonarr", "radarr"], why: "Sonarr or Radarr, with its key in the vault" }],
    ember: {
      prepare: READS("Read the queue, missing items, releases and the library", [
        "arr",
        "radarr",
        "sonarr",
      ]),
      execute: PLAN_CHANGE("Import, search, monitor or change quality settings"),
    },
  },
  {
    id: "sonarr-panel",
    name: "Sonarr's own tabs",
    summary:
      "Manage Sonarr inside Hearth: an everyday Overview (Right now, health warnings linking to the setting that fixes them, next 7 days), Library (series, seasons and episodes), Activity (with Import files), Wanted (missing and below-cutoff episodes), Settings and System, shared with Radarr's panel.",
    aliases: [
      "sonarr library",
      "season monitoring",
      "monitor a season",
      "episode monitoring",
      "add a series to sonarr",
      "missing episodes",
      "season search",
      "sonarr manual import",
    ],
    where: {
      route: "/services",
      path: "Open Sonarr; tabs Library, Activity, Wanted, Settings, System",
    },
    open: { app: ["sonarr"] },
    labels: [
      "Add a show",
      "Review season monitoring",
      "Search missing",
      "Search all",
      "Import files",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("sonarr-panel.spec.ts"),
        test: "a season is monitored again and an episode stops being monitored, each approved",
      },
      {
        file: E2E("sonarr-panel.spec.ts"),
        test: "a new show is found through Sonarr's own search and added once",
      },
      {
        file: E2E("sonarr-panel.spec.ts"),
        test: "Import files puts a file Sonarr matched into its episode",
      },
      {
        file: E2E("sonarr-panel.spec.ts"),
        test: "Overview is the everyday summary; the queue and missing episodes open their tabs",
      },
      {
        file: E2E("radarr-panel.spec.ts"),
        test: "a health warning links straight to the setting that fixes it",
      },
    ],
    needs: [
      { anyApp: ["sonarr"], why: "Sonarr 4, with its key in the vault (changes you approve)" },
    ],
    ember: {
      prepare: READS("Read Sonarr's series, episodes, profiles and settings", [
        "sonarr",
        "app_api",
      ]),
      execute: PLAN_CHANGE(
        "The same steps as the panel: app-arr-edit (series, episode), app-arr-create, app-arr-delete, app-arr-command",
      ),
    },
  },
  {
    id: "prowlarr-panel",
    name: "Prowlarr's own tabs",
    summary:
      "Manage Prowlarr inside Hearth: Indexers (each one's settings, adding one from Prowlarr's list of sites), Search across every indexer with Download, History, Settings (apps and how they sync, sync profiles, connections, tags) and System.",
    aliases: [
      "prowlarr indexers",
      "add an indexer",
      "prowlarr search",
      "search every indexer",
      "sync profile",
      "prowlarr apps",
      "indexer proxy",
    ],
    where: {
      route: "/services",
      path: "Open Prowlarr; tabs Indexers, Search, History, Settings, System",
    },
    open: { app: ["prowlarr"] },
    labels: ["Add an indexer", "Push to apps", "Download", "Push indexers now"],
    status: "working",
    evidence: [
      {
        file: E2E("prowlarr-panel.spec.ts"),
        test: "an indexer is added from Prowlarr's list of sites, once",
      },
      {
        file: E2E("prowlarr-panel.spec.ts"),
        test: "Search finds results across indexers and sends one to the download client",
      },
      {
        file: E2E("prowlarr-panel.spec.ts"),
        test: "Settings: how an app is synced, a sync profile, and a tag, each approved",
      },
    ],
    needs: [
      { anyApp: ["prowlarr"], why: "Prowlarr 2, with its key in the vault (changes you approve)" },
    ],
    ember: {
      prepare: READS("Read Prowlarr's indexers, definitions, apps and history", ["app_api"]),
      execute: PLAN_CHANGE(
        "The same steps as the panel: app-arr-edit (indexer, application, appprofile), app-arr-create (indexer from a definition), app-arr-delete, app-arr-command (GrabRelease, ApplicationIndexerSync)",
      ),
    },
  },
  {
    id: "radarr-panel",
    name: "Radarr's own tabs",
    summary:
      "Manage Radarr inside Hearth: Library, Activity (with Import files), Wanted, Settings (quality profiles, custom formats, quality sizes, tags, naming, exclusions, connections) and System.",
    aliases: [
      "radarr library",
      "radarr settings",
      "quality profile",
      "custom format",
      "release profile",
      "delay profile",
      "radarr blocklist",
      "radarr history",
      "below cutoff",
      "rename movie files",
      "radarr backup",
      "radarr tasks",
      "quality sizes",
      "import list exclusion",
      "manual import",
    ],
    where: {
      route: "/services",
      path: "Open Radarr; tabs Library, Activity, Wanted, Settings, System",
    },
    open: { app: ["radarr"] },
    labels: [
      "Review change",
      "Pick a release",
      "Search all",
      "Run now",
      "Back up now",
      "Import files",
      "Quality sizes",
      "Exclusions",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("radarr-panel.spec.ts"),
        test: "a movie's monitoring and profile change in one approved, verified plan",
      },
      {
        file: E2E("radarr-panel.spec.ts"),
        test: "a quality profile's format score changes, and Radarr's own matcher checks a name",
      },
      {
        file: E2E("radarr-panel.spec.ts"),
        test: "connections never show a password or key, and switch off through a plan",
      },
      {
        file: E2E("radarr-panel.spec.ts"),
        test: "Import files: a file Radarr found goes into the movie chosen for it",
      },
    ],
    needs: [
      { anyApp: ["radarr"], why: "Radarr 6, with its key in the vault (changes you approve)" },
    ],
    ember: {
      prepare: READS("Read Radarr's library, profiles, formats and settings", [
        "radarr",
        "app_api",
      ]),
      execute: PLAN_CHANGE(
        "The same steps as the panel: app-arr-edit, app-arr-create, app-arr-delete, app-arr-command",
      ),
    },
  },
  {
    id: "lidarr-panel",
    name: "Lidarr's own tabs",
    summary:
      "Manage Lidarr inside Hearth: Library (artists, their albums and tracks, Add an artist), Activity (Import files, history, blocklist), Wanted (missing and below-cutoff albums), Settings and System, shared with Radarr's panel.",
    aliases: [
      "lidarr library",
      "add an artist",
      "add an artist to lidarr",
      "album monitoring",
      "missing albums",
      "lidarr import files",
      "metadata profile",
    ],
    where: {
      route: "/services",
      path: "Open Lidarr; tabs Library, Activity, Wanted, Settings, System",
    },
    open: { app: ["lidarr"] },
    labels: ["Add an artist", "Search missing", "Review import"],
    status: "working",
    evidence: [
      {
        file: E2E("lidarr-panel.spec.ts"),
        test: "Library lists artists and opens one with its albums and tracks",
      },
      {
        file: E2E("lidarr-panel.spec.ts"),
        test: "an album is monitored and an artist is added through Lidarr's own search, each approved",
      },
      {
        file: E2E("lidarr-panel.spec.ts"),
        test: "Import files puts a file Lidarr matched into its track",
      },
    ],
    needs: [
      { anyApp: ["lidarr"], why: "Lidarr 3, with its key in the vault (changes you approve)" },
    ],
    ember: {
      prepare: READS("Read Lidarr's artists, albums, profiles and settings", ["app_api"]),
      execute: PLAN_CHANGE(
        "The same steps as the panel: app-arr-edit (artist, album), app-arr-create (artist), app-arr-delete, app-arr-command (AlbumSearch, ArtistSearch, ManualImport)",
      ),
    },
  },
  {
    id: "jellyfin-panel",
    name: "Jellyfin's own tabs",
    summary:
      "Jellyfin in Hearth, laid out like Plex: Library (browse, search, a title's details and files, mark watched, edit, refresh), Manage (libraries and their folders, scans), Plugins (installed, updates, the catalog, enable, disable, remove, restart), Settings, People (access, downloads, disable, enable, remove), Devices (sign one out), Activity and Logs (keys hidden).",
    aliases: [
      "jellyfin users",
      "jellyfin library access",
      "disable a jellyfin user",
      "remove a jellyfin user",
      "jellyfin devices",
      "sign out a device",
      "jellyfin activity",
      "jellyfin logs",
      "jellyfin plugins",
      "install a jellyfin plugin",
      "update jellyfin plugins",
      "jellyfin library",
      "mark watched in jellyfin",
      "add a folder to a jellyfin library",
      "jellyfin settings",
      "jellyfin hardware acceleration",
      "restart jellyfin",
    ],
    where: {
      route: "/services",
      path: "Open Jellyfin; tabs Library, Tasks, People, Devices, Activity, Manage, Plugins, Settings, Logs",
    },
    open: { app: ["jellyfin"] },
    labels: [
      "Change access",
      "Review access",
      "Disable account",
      "Sign out",
      "Mark watched",
      "Edit details",
      "Refresh details",
      "Add a folder",
      "Stop reading it",
      "Add a library",
      "Catalog",
      "Install",
      "Show advanced",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("jellyfin-panel.spec.ts"),
        test: "People: change access, disable and enable, never touch the administrator",
      },
      {
        file: E2E("jellyfin-panel.spec.ts"),
        test: "People: remove someone; Devices: sign a device out",
      },
      {
        file: E2E("jellyfin-panel.spec.ts"),
        test: "Activity and Logs: Jellyfin's own log, keys hidden",
      },
      {
        file: E2E("jellyfin-panel.spec.ts"),
        test: "Library: search as you type, open a title, mark it watched and edit it",
      },
      {
        file: E2E("jellyfin-panel.spec.ts"),
        test: "Manage: add a folder to a library and stop reading it",
      },
      {
        file: E2E("jellyfin-panel.spec.ts"),
        test: "Plugins: update one, restart when Jellyfin asks, install from the catalog",
      },
      {
        file: E2E("jellyfin-panel.spec.ts"),
        test: "Settings: change one through a plan, networking stays in Jellyfin",
      },
    ],
    needs: [
      { anyApp: ["jellyfin"], why: "Jellyfin, with its key in the vault (changes you approve)" },
    ],
    ember: {
      prepare: READS(
        "Read Jellyfin's library, titles, users, libraries' folders, plugins, settings, devices, activity and logs",
        ["app_api"],
      ),
      execute: PLAN_CHANGE(
        "The same steps as the panel: app-jellyfin-control (watched, unwatched, edit-item, refresh-item, add-library, add-folder, remove-folder, remove-library, plugin-install, plugin-enable, plugin-disable, plugin-uninstall, restart, set-settings, user-access, disable-user, enable-user, remove-user, sign-out-device); never an administrator",
      ),
    },
  },
  {
    id: "media-home-tab",
    name: "Home tab of Plex, Jellyfin and Emby",
    summary:
      "Plex, Jellyfin and Emby panels open on Home: the server's home screen row by row with posters, in Home rows' editor for that server, with Refresh to read it again (a row just made or moved, a title that just landed). Changes not sent yet are kept.",
    aliases: [
      "plex home screen",
      "jellyfin home screen",
      "emby home screen",
      "see my home rows",
      "refresh home rows",
      "default tab plex",
      "what plex opens to",
    ],
    where: {
      route: "/services",
      path: "Open Plex, Jellyfin or Emby: it opens on Home; Refresh at the top",
    },
    open: { app: ["plex", "jellyfin", "emby"], tab: "home" },
    labels: ["Refresh"],
    status: "working",
    evidence: [
      {
        file: "tests/e2e/media-home-rows.spec.ts",
        test: "Plex opens on its home screen, and Refresh reads it again",
      },
      {
        file: "tests/e2e/media-home-rows.spec.ts",
        test: "Jellyfin and Emby open on their home screens too",
      },
    ],
  },
  {
    id: "plex-panel",
    name: "Plex's own tabs",
    summary:
      "Manage Plex inside Hearth: Library (browse, open a title with its files, seasons and episodes, mark watched, edit details, refresh, scan, empty trash), History (who watched what), Tasks (run Plex's maintenance), Manage (where each library's rows show on Home, Recommended and Friends' Home, their order, Merge Recently Added) and Settings (server settings; networking and credentials stay in Plex).",
    aliases: [
      "plex library",
      "mark watched in plex",
      "mark unwatched",
      "edit a title in plex",
      "plex sort title",
      "plex watch history",
      "who watched",
      "plex maintenance",
      "optimize plex database",
      "clean bundles",
      "empty trash in plex",
      "plex settings",
      "transcoder quality",
      "plex home screen",
      "manage libraries",
      "plex recommended rows",
      "friends home",
      "merge recently added",
      "reorder plex rows",
      "who has access to plex",
      "plex sharing",
      "plex friends",
    ],
    where: {
      route: "/services",
      path: "Open Plex; tabs Library, History, Tasks, Manage, Settings",
    },
    open: { app: ["plex"] },
    labels: [
      "Mark watched",
      "Edit details",
      "Run now",
      "Review changes",
      "Library Recommended",
      "Friends' Home",
      "Merge Recently Added Items",
      "Who has access",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("plex-panel.spec.ts"),
        test: "Library: find a film, mark it watched and edit its sort title",
      },
      {
        file: E2E("plex-panel.spec.ts"),
        test: "Library: a show's seasons; a whole season is marked watched",
      },
      {
        file: E2E("plex-panel.spec.ts"),
        test: "History, Tasks and Settings: run a task, change a setting, networking stays locked",
      },
      {
        file: E2E("plex-panel.spec.ts"),
        test: "Manage: rows on Home and Friends' Home, a new order, and Merge Recently Added, each approved",
      },
    ],
    needs: [{ anyApp: ["plex"], why: "Plex, linked in the vault (changes you approve)" }],
    ember: {
      prepare: READS("Read Plex's libraries, titles, history, tasks and settings", ["app_api"]),
      execute: PLAN_CHANGE(
        "The same steps as the panel: app-plex-control (watched, unwatched, edit-item, refresh-item, scan-library, empty-trash, run-task, clean-bundles, optimize-db, set-settings, set-rows, merge-recent); never networking or credentials",
      ),
    },
  },
  {
    id: "curator",
    name: "Curator",
    summary:
      "Say what you're in the mood for (Christmas movies, a cozy mystery series, funny sci-fi audiobooks), pick Movies, Shows, Books, Audiobooks or Music and a few filters (years, genres, rating, length), and Ember suggests. Curator is what to watch next and what's missing from your collection. Hearth checks every suggestion is real and says which you already have. Request one through Seerr (movies and shows), Lidarr (music, a plan you approve) or Chaptarr's own add page (books and audiobooks). More like these asks again without repeats. For You suggests what to watch next from the owner's own watch history only (Tautulli, else Plex, read locally; other people on the Plex are never included): hidden gems in your library you never played, new arrivals, favourites worth revisiting, each with Open in Plex, More like this, Seen it (rated, it steers the next picks) and Not for me; Not in your library from Seerr's own similar and recommended lists for what you finished (no AI), with Request, Watch trailer and More like this; and a What should I watch? box where plain words (genre, length, years, like a title) run locally and only a vague ask goes to Ember with titles and genres.",
    aliases: [
      "curator",
      "for you",
      "picks for me",
      "hidden gems",
      "recommend",
      "recommendations",
      "seen it",
      "mark watched from suggestions",
      "suggest movies",
      "what should i watch",
      "find me something to watch",
      "movies i don't have",
      "suggest books",
      "suggest audiobooks",
      "suggest music",
      "discover new movies",
    ],
    where: {
      route: "/",
      path: "The Lair: Curator (once Seerr, Lidarr or Chaptarr is connected)",
    },
    open: { panel: "curator" },
    labels: [
      "Curator",
      "Discover",
      "What are you in the mood for?",
      "Find",
      "More like these",
      "Request",
      "Missing from my collection",
      "In my library",
      "What are you here for?",
      "Something new",
      "Fill a gap",
      "Complete a niche",
      "Go deeper",
      "How was it?",
      "Request all",
      "Make it a Home row",
      "Find ones I don't have",
      "Both",
      "Seen it",
      "In your library",
      "Mark watched",
      "What should I watch?",
      "More like this",
      "Not in your library",
      "Back to your picks",
      "Not for me",
      "Open in Plex",
    ],
    status: "working",
    statusNote:
      "Discover only. Ember sees only what you typed and your filters, never your library or history. Books and audiobooks open Chaptarr's add page (a plan comes later); For You (personal picks from your own watching, free) reads only the owner's own history.",
    evidence: [
      {
        file: E2E("curator.spec.ts"),
        test: "Curator: Ember suggests, what you have is hidden, and a request is one approval",
      },
      {
        file: E2E("curator-for-you.spec.ts"),
        test: "For You: More like this, Seen it, Not in your library, and What should I watch?",
      },
      {
        file: E2E("curator.spec.ts"),
        test: "Curator: Both shows what you have; Seen it asks how it was, and only offers to mark it watched and rate it",
      },
      {
        file: E2E("curator.spec.ts"),
        test: "Curator: In my library picks only from what you own, and says what Ember was given",
      },
      {
        file: E2E("curator.spec.ts"),
        test: "Curator in a Forge pick sheet: finds ones you don't have, checks your Plex, and a requested one joins the row when it arrives",
      },
    ],
    needs: [
      {
        anyApp: ["seerr", "lidarr", "chaptarr"],
        why: "Seerr for movies and shows, Lidarr for music, Chaptarr for books and audiobooks",
      },
    ],
  },
  {
    id: "home-rows",
    name: "Home rows",
    summary:
      "The Plex home screen editor: your Home on one side (every row in order, with posters: move, take off, choose who sees it), Add a row on the other (Plex's own rows like Recently Added or Rediscover, any collection, ideas, rows from your apps, or anything typed). Ask Ember for a row or Make a collection walks you through a few questions, then Ember picks titles in the Forge. Changes collect in a bar and one Save to Plex is one plan you approve. Save whole home screens to switch between. For Jellyfin: each person's home screen (Jellyfin's own sections in order, library order, which libraries get a Recently Added row), for one person or several at once, with Undo. For Emby: each person's own rows (Emby's rows, a collection or playlist, titles by filters, or titles you pick, which Hearth makes into a collection first), library order and My Media, with Save to Emby and Undo.",
    aliases: [
      "home rows",
      "custom plex row",
      "make a plex row",
      "plex home screen rows",
      "christmas movies row",
      "make a collection",
      "collection on home",
      "recently added row",
      "design my plex home",
      "save my home screen",
      "jellyfin home screen",
      "jellyfin home rows",
      "jellyfin recently added row",
      "change what my family sees on jellyfin",
      "emby home screen",
      "emby home rows",
      "make an emby row",
    ],
    where: {
      route: "/",
      path: "The Lair: Home rows (or the link on the Plex, Jellyfin or Emby panel's Manage tab)",
    },
    open: { panel: "home-rows" },
    labels: [
      "Home rows",
      "Your Home",
      "Add a row",
      "Ask Ember for a row",
      "Make a collection",
      "Quick picks",
      "Your collections",
      "Save to Plex",
      "Saved home screens",
      "Merge rows on Home",
      "Whose home screen",
      "Save to Jellyfin",
    ],
    status: "working",
    statusNote:
      "Plex and Jellyfin. A theme with movies and shows is one row per library (Plex keeps libraries apart). Jellyfin rows of collections (they need the Home Screen Sections plugin), Emby, row schedules and auto-updating Ember rows come later.",
    evidence: [
      {
        file: E2E("home-rows.spec.ts"),
        test: "Home rows: add Plex's own row and a collection, take one off, send it in one plan; Ember walks you through",
      },
      {
        file: E2E("home-rows.spec.ts"),
        test: "Merge rows on Home: Recently Added and Recently Released are separate choices, rows change at once, one Save to Plex",
      },
      {
        file: E2E("jellyfin-home-rows.spec.ts"),
        test: "Home rows for Jellyfin: arrange a person's home screen, save it for two people, undo",
      },
      {
        file: E2E("home-rows.spec.ts"),
        test: "Home rows: Ember's plan for a movies-and-shows row shows up live to approve",
      },
      {
        file: E2E("home-rows.spec.ts"),
        test: "Saved home screens: save two, switch between them, and undo a switch",
      },
    ],
    needs: [{ anyApp: ["plex"], why: "Plex, linked in the vault (changes you approve)" }],
    ownerOnly: "Applying a row to Plex is the owner's approval of the plan it shows.",
    ember: {
      prepare: READS("Read the saved rows and what Plex shows now", ["hearth_api", "app_api"]),
      execute: PLAN_CHANGE(
        "Make a row from a request: ask what is missing (theme, about how many), read GET /api/home-rows/catalog, open a Forge pick with posters, then on submission one app-plex-control home-row-apply step per library with params.row; home-row-undo takes it off",
      ),
    },
  },
  {
    id: "tautulli-panel",
    name: "Tautulli's own tabs",
    summary:
      "Tautulli inside Hearth: History (every play by person, kind and title; delete play records), People (watch time, players; rename, record their plays or not, guest access), Libraries (plays per library; record or not), Graphs (plays per day) and System (Tautulli's log with keys hidden, back up the database).",
    aliases: [
      "tautulli history",
      "who watched what",
      "watch history",
      "delete play history",
      "tautulli users",
      "rename a user in tautulli",
      "stop recording plays",
      "plays per day",
      "tautulli graphs",
      "tautulli backup",
      "tautulli logs",
    ],
    where: {
      route: "/services",
      path: "Open Tautulli; tabs History, People, Libraries, Graphs, System",
    },
    open: { app: ["tautulli"] },
    labels: ["Read people from Plex again", "Stop recording their plays", "Back up database"],
    status: "working",
    evidence: [
      {
        file: E2E("tautulli-panel.spec.ts"),
        test: "History: filter by person, then delete two play records",
      },
      {
        file: E2E("tautulli-panel.spec.ts"),
        test: "People: rename someone and stop recording their plays",
      },
      {
        file: E2E("tautulli-panel.spec.ts"),
        test: "Libraries, Graphs and System: stop recording a library, a chart, a log without keys",
      },
    ],
    needs: [
      { anyApp: ["tautulli"], why: "Tautulli, with its key in the vault (changes you approve)" },
    ],
    ember: {
      prepare: READS("Read Tautulli's history, people, libraries, plays per day and log", [
        "app_api",
      ]),
      execute: PLAN_CHANGE(
        "The same steps as the panel: app-tautulli-control (edit-user, edit-library, delete-history, backup-db, refresh-users, refresh-libraries)",
      ),
    },
  },
  {
    id: "books-music-panels",
    name: "Lidarr, Chaptarr and Readarr panels",
    summary: "Music and books: queue, trail, wanted, coming, authors and release search.",
    aliases: ["lidarr", "chaptarr", "readarr", "audiobooks wanted", "ebooks", "music library"],
    where: { route: "/services", path: "Open Lidarr or Chaptarr (sidebar, Lair, or All services)" },
    open: { app: ["lidarr", "chaptarr"] },
    labels: ["Stop wanting"],
    status: "working",
    evidence: [
      {
        file: E2E("library.smoke.spec.ts"),
        test: "Chaptarr panel: wanted per format, authors, and wanting a coming book",
      },
    ],
    needs: [
      { anyApp: ["lidarr", "chaptarr"], why: "Lidarr or Chaptarr, with its key in the vault" },
    ],
    ember: {
      prepare: READS("Read the queue and wanted items", ["arr"]),
      execute: APP_API_CHANGE("Change wanted items or search"),
    },
  },
  {
    id: "generic-panel",
    name: "The basic panel for any app",
    summary:
      'An app Hearth has no panel of its own for shows the app itself on its Overview (its own page, when the app allows being shown inside another page; else a big Open button and the reason), with Hearth view, Open in a new tab and Details one tap away. Hearth view is the basic panel: whether it answers, its version, Open web UI, recent log lines, Ask Ember (which reaches the app\'s own API with its vault key, changes as plans you approve) and "This is a basic panel. Want a full one? Request it." A full panel replaces it automatically, and every full panel has Request a feature. Both open the Panel requests board, prefilled for the app (docs/HOW_REQUESTS_WORK.md).',
    aliases: [
      "generic panel",
      "basic panel",
      "app without a panel",
      "request a panel",
      "request a feature",
      "how requests work",
      "unsupported app",
      "show the app inside hearth",
      "embed the app",
    ],
    where: { route: "/services", path: "Open any app Hearth has no panel for; Overview" },
    labels: ["Answering", "Open web UI", "Request it", "Request a feature", "Hearth view"],
    status: "working",
    statusNote:
      "Checked with a made-up app in the e2e test; the request link opens the Panel requests board once GitHub Discussions is on for the repository.",
    evidence: [
      {
        file: E2E("generic-panel.spec.ts"),
        test: "a made-up app gets status, logs, Ask Ember and Request a full panel",
      },
      {
        file: E2E("generic-panel.spec.ts"),
        test: "an app with its own panel does not show the generic one",
      },
      {
        file: E2E("generic-panel.spec.ts"),
        test: "an app that refuses to be shown inside Hearth gets a big Open button",
      },
    ],
    ember: {
      prepare: READS("Read the app's own API", ["app_api"]),
      execute: PLAN_CHANGE(
        "app-api-call with params.method, params.path, params.body, params.why, and params.auth for an app Hearth has no reader for",
      ),
    },
  },
  {
    id: "panel-builder",
    name: "Ember Panel Builder",
    summary:
      "Improve this panel, on a basic panel or on Hearth's own panel for an app (there the custom panel is a layer, Show Hearth's panel one click away, and Ember starts from what Hearth's panel does), opens the Forge on it: Ember says you are working on that panel and asks how you would like it to look, then builds what you describe while the Forge preview on the panel changes as you talk, and Apply puts it in use. A panel is Hearth's own blocks (numbers, status lists, tables, snapshot pictures, timelines, charts, links, buttons that propose a plan), or Ember's own page for anything blocks cannot draw (poster folders that open details, a trailer player, popups, a Request button), which runs sealed: no internet, no keys, no Hearth session, reading only that app through Hearth by GET, with its key kept in the vault; trailers play in Hearth's own player and every change to the app is a plan the owner approves. Each block is marked Real or Not possible, with Keep and Drop; Apply lists what it reads first. Show basic panel, Back to basic and earlier versions stay one click away. Custom panels live in Hearth's database, so updates and backups keep them. Anything custom is Hearth Premium (Panel Builder): building with Ember, loading a panel file, installing and sharing. On Free, Improve with Ember and Load a panel file show what it is; every app keeps Hearth's own or basic panel, and Request it stays free. Premium members keep their panels private or share them with Donate your panel (the contributor agreement, and a name or GitHub user name for credit); donated panels the owner adds become skins, picked per app as Panel style: Hearth's own or Skin by @name, with Made by @name on the panel and the credits in Settings, About. Network and security apps (VPN, proxy, DNS, sign-in, passwords), infrastructure and Hearth's own tools keep Hearth's panel. Apply says how the panel reads the app (its key or Hearth's saved sign-in) and that it can stop working if the app changes how it answers, usually after an update or a settings change; a panel that stopped working says which part, with Ask Ember to fix it and Hearth's panel one click away.",
    aliases: [
      "panel builder",
      "custom panel",
      "improve this panel",
      "make a panel",
      "build a panel",
      "better panel",
      "donate your panel",
      "refine this panel",
    ],
    where: {
      route: "/services",
      path: "Open an app with a basic panel; the sparkle button in its header",
    },
    // Panel Builder's own screens (Install, Show basic panel, Back to basic, Donate your panel,
    // Save panel file, Load a panel file) come with the Premium package and are tested there.
    labels: ["Improve this panel", "Request it", "Custom panels"],
    status: "working",
    statusNote:
      "Panel Builder is in the Premium package (its own tests, with a stand-in ZoneMinder, live in the Premium repo); without it the Improve menu offers Request it and what Premium adds. Not yet tried with a real app and Ember end to end. Sharing (Donate) works for real once the donation service is deployed; donations, skins and credits are tested against stand-ins in the Premium repo.",
    evidence: [
      {
        file: E2E("custom-panels-free.spec.ts"),
        test: "without the Premium package: Request it, and Custom panels says what Premium adds",
      },
    ],
    ember: {
      // panel_builder, Ember's tool for it, comes with the Premium package.
      prepare: READS("Read the app's own API (Panel Builder's panel_builder tool is Premium)", [
        "app_api",
        "app_signin",
      ]),
    },
  },
  {
    id: "saved-sign-in",
    name: "Signing Hearth in to an app with no API key",
    summary:
      "For an app with no API key (Tasterr), the panel's Sign Hearth in box shows every way the app offers: Sign in with Plex (Allow in the Plex window once; no password needed; Hearth keeps the session going and asks again only if the app ends it) and a local user name and password (kept in the Secure Vault; Hearth signs in again by itself). The session stays in the Secure Vault, sent only to that app, never to the page or the AI.",
    aliases: [
      "sign in with plex",
      "tasterr sign in",
      "tasterr login",
      "no api key",
      "app has no api key",
      "saved sign-in",
      "i don't have a password",
      "plex login for an app",
    ],
    where: { route: "/services", path: "Open the app's panel; the Sign Hearth in box at the top" },
    labels: ["Sign in with Plex", "Save and sign in"],
    status: "working",
    statusNote:
      "Tasterr's sign-in was read from its own source on Homeserver (11-13) and is tested with a stand-in Tasterr; the real Plex sign-in to Tasterr is not verified yet.",
    evidence: [
      {
        file: E2E("sign-in-plex.spec.ts"),
        test: "Tasterr offers Sign in with Plex and a local login, and the wording agrees",
      },
      {
        file: E2E("sign-in-card.spec.ts"),
        test: "an app that needs its login asks for it on the panel, then signs in",
      },
    ],
    ember: {
      prepare: READS("Set up or check how Hearth signs in to the app", ["app_signin"]),
    },
  },
  {
    id: "uptimekuma-panel",
    name: "Uptime Kuma's panel",
    summary:
      "Uptime Kuma: every monitor up, down, paused or in maintenance with its recent checks, response time, uptime over 24 hours and 30 days and certificate, what is down and since when, recent state changes, maintenance windows and status pages; pausing, resuming, adding and removing monitors, and watching your apps in one step.",
    aliases: [
      "uptime kuma",
      "kuma",
      "monitors",
      "what is down",
      "uptime",
      "status page",
      "watch an app",
    ],
    where: { route: "/services", path: "Open Uptime Kuma; tabs Overview, Monitors" },
    open: { app: ["uptimekuma"] },
    labels: [
      "Down now",
      "Recent changes",
      "Ask Ember why",
      "Your apps it does not watch",
      "Find a monitor, address or group",
      "Add monitor",
      "Open Uptime Kuma",
    ],
    status: "working",
    statusNote:
      "Tested against real servers: throwaway louislam/uptime-kuma containers (1.23.17 and 2.5.9) on 2026-11-08, every reading and change read back (uptimekuma-real.test.ts).",
    evidence: [
      {
        file: E2E("uptimekuma-panel.spec.ts"),
        test: "Overview: what is down, certificates, changes and maintenance",
      },
      {
        file: E2E("uptimekuma-panel.spec.ts"),
        test: "Monitors: pause and resume one, and watch an app Hearth knows",
      },
    ],
    needs: [
      {
        anyApp: ["uptimekuma"],
        why: "Uptime Kuma, with its username and password in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS("Read Uptime Kuma's monitors, checks and state changes", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-uptimekuma-control with params.op pause, resume or remove (params.monitorId), add (params.name, params.url, params.interval), maintenance-pause or maintenance-resume (params.maintenanceId)",
      ),
    },
  },
  {
    id: "navidrome-panel",
    name: "Navidrome's panel",
    summary:
      "Navidrome (music): songs, albums and artists, the last library scan, who is listening to what right now, files it can no longer find, and every user with their role, when they were last on and the apps they listen with; scanning (quick or full), forgetting missing files, making a user an administrator or not, and removing a user.",
    aliases: ["navidrome", "music server", "subsonic", "who is listening", "music library scan"],
    where: { route: "/services", path: "Open Navidrome; tabs Overview, People" },
    open: { app: ["navidrome"] },
    labels: [
      "Playing now",
      "Forget them",
      "Scan for new music",
      "Full scan",
      "Find a person",
      "Make administrator",
      "Open Navidrome",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway deluan/navidrome 0.64.2 on 2026-11-08, every reading and change read back (navidrome-real.test.ts).",
    evidence: [
      {
        file: E2E("navidrome-panel.spec.ts"),
        test: "Overview: songs, listening now, scan and missing files",
      },
      {
        file: E2E("navidrome-panel.spec.ts"),
        test: "People: make a user an administrator through a plan",
      },
    ],
    needs: [
      { anyApp: ["navidrome"], why: "Navidrome, with an administrator's login in the vault" },
    ],
    ember: {
      prepare: READS("Read Navidrome's library, listeners, users and missing files", [
        "hearth_api",
      ]),
      execute: PLAN_CHANGE(
        "app-navidrome-control with params.op scan, full-scan, forget-missing, or admin-on, admin-off, remove-user (params.userId)",
      ),
    },
  },
  {
    id: "gitea-panel",
    name: "Gitea's panel",
    summary:
      "Gitea or Forgejo (git server): repositories, pull mirrors and when each last synced, Actions runners online or offline, recent workflow runs and failures, people, organizations, scheduled tasks and the version; syncing a mirror now, running a run's failed jobs again, turning a runner off or on or removing it, and running a scheduled task now.",
    aliases: [
      "gitea",
      "forgejo",
      "git server",
      "mirrors",
      "runners",
      "act_runner",
      "workflow runs",
    ],
    where: { route: "/services", path: "Open Gitea; tabs Overview, Actions" },
    open: { app: ["gitea"] },
    labels: [
      "Changed lately",
      "Sync now",
      "Recent runs",
      "Run failed jobs again",
      "Scheduled tasks",
      "Run now",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway gitea/gitea 1.27.3 with a pull mirror and two act_runner runners on 2026-11-08, every reading and change read back (gitea-real.test.ts).",
    evidence: [
      {
        file: E2E("gitea-panel.spec.ts"),
        test: "Overview: repositories, a late mirror synced through a plan",
      },
      {
        file: E2E("gitea-panel.spec.ts"),
        test: "Actions: runners, a failed run run again, a runner turned off",
      },
    ],
    needs: [
      {
        anyApp: ["gitea"],
        why: "Gitea or Forgejo, with an administrator's access token in the vault",
      },
    ],
    ember: {
      prepare: READS("Read Gitea's repositories, mirrors, runners and runs", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-gitea-control with params.op mirror-sync (params.repoId), rerun-failed (params.runId), runner-off, runner-on, runner-remove (params.runnerId), or task-run (params.task)",
      ),
    },
  },
  {
    id: "forgejo-panel",
    name: "Forgejo's panel",
    summary:
      "Forgejo (git server), through Gitea's panel: repositories, pull mirrors and when each last synced, recent workflow runs read per repository and how many wait for a runner, people, organizations, scheduled tasks and the version; syncing a mirror now and running a scheduled task now. Forgejo's API lists no runners and cannot run failed jobs again, so those stay on its own page.",
    aliases: ["forgejo", "codeberg", "git server", "forgejo runner"],
    where: { route: "/services", path: "Open Forgejo; tabs Overview, Actions" },
    open: { app: ["gitea"] },
    labels: ["Waiting runs", "Sync now", "Recent runs", "Scheduled tasks"],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway codeberg.org/forgejo/forgejo 13.0.5 on 2026-11-08, every reading and change read back (forgejo-real.test.ts).",
    evidence: [
      {
        file: E2E("gitea-panel.spec.ts"),
        test: "Forgejo: named, waiting runs, runs per repository, no re-run",
      },
    ],
    needs: [
      { anyApp: ["gitea"], why: "Forgejo, with an administrator's access token in the vault" },
    ],
    ember: {
      prepare: READS("Read Forgejo's repositories, mirrors and runs", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-gitea-control with params.op mirror-sync (params.repoId) or task-run (params.task); Forgejo cannot re-run a run or list runners",
      ),
    },
  },
  {
    id: "authelia-panel",
    name: "Authelia's panel",
    summary:
      "Authelia (sign-in for other apps), a light read-only panel: whether sign-in works and since when, and from its metrics, sign-ins, failed and banned sign-ins since it started, how long a sign-in takes, server errors and memory. Authelia has no admin API, so people and rules stay in its files.",
    aliases: ["authelia", "sso", "single sign-on", "failed logins", "banned logins", "2fa"],
    where: { route: "/services", path: "Open Authelia; Overview" },
    open: { app: ["authelia"] },
    labels: ["Sign-ins", "Failed", "Banned", "Open Authelia"],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway ghcr.io/authelia/authelia 4.39.28 on 2026-11-09, every reading checked (authelia-real.test.ts).",
    evidence: [
      {
        file: E2E("authelia-panel.spec.ts"),
        test: "Sign-in working, sign-ins, failed and banned from its metrics",
      },
    ],
    needs: [{ anyApp: ["authelia"], why: "Authelia, with its metrics on for sign-in counts" }],
    ember: {
      prepare: READS("Read Authelia's health and sign-in counts", ["hearth_api"]),
    },
  },
  {
    id: "frigate-panel",
    name: "Frigate's panel",
    summary:
      "Frigate (cameras): which cameras get a picture and detect, today's alerts and detections, recent events, the detector's speed and how full the recordings disk is; turning a camera's detection or recording on or off, keeping or deleting an event, and restarting Frigate. Never a camera's stream address or an image.",
    aliases: [
      "frigate",
      "cameras",
      "cctv",
      "nvr",
      "camera offline",
      "detections",
      "doorbell camera",
    ],
    where: { route: "/services", path: "Open Frigate; Overview" },
    open: { app: ["frigate"] },
    labels: [
      "Alerts today",
      "Recordings disk",
      "Turn off detection",
      "Recent events",
      "Keep",
      "Restart Frigate",
      "Open Frigate",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway ghcr.io/blakeblackshear/frigate 0.18.2 on 2026-11-09, every reading and change read back (frigate-real.test.ts).",
    evidence: [
      {
        file: E2E("frigate-panel.spec.ts"),
        test: "Cameras, alerts, detector and storage; detection turned off through a plan",
      },
      {
        file: E2E("frigate-panel.spec.ts"),
        test: "Recent events: keep one through a plan",
      },
    ],
    needs: [{ anyApp: ["frigate"], why: "Frigate, with a login in the vault" }],
    ember: {
      prepare: READS("Read Frigate's cameras, events, alerts and storage", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-frigate-control with params.op detect-on, detect-off, record-on or record-off (params.camera), event-keep, event-unkeep or event-delete (params.eventId), or restart",
      ),
    },
  },
  {
    id: "authentik-panel",
    name: "Authentik's panel",
    summary:
      "Authentik (sign-in for other apps): sign-ins and failed sign-ins in the last day and who failed from where, the apps it protects, its worker, outposts, failed background tasks and certificates near expiry, and the version; turning a person's account off or on (protected) and retrying a failed task. Never a password, token or secret.",
    aliases: [
      "authentik",
      "sso",
      "single sign-on",
      "failed logins",
      "who is trying to log in",
      "outposts",
    ],
    where: { route: "/services", path: "Open Authentik; tabs Overview, People" },
    open: { app: ["authentik"] },
    labels: [
      "Sign-ins today",
      "Failed today",
      "Apps protected",
      "Failed sign-ins, last day",
      "Turn off",
      "Open Authentik",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway ghcr.io/goauthentik/server 2026.8.5 on 2026-11-09, every reading and change read back (authentik-real.test.ts).",
    evidence: [
      {
        file: E2E("authentik-panel.spec.ts"),
        test: "Overview: sign-ins, failed sign-ins, apps and health, and a task retried",
      },
      {
        file: E2E("authentik-panel.spec.ts"),
        test: "People: turn an account off through a protected plan",
      },
    ],
    needs: [
      { anyApp: ["authentik"], why: "Authentik, with an administrator's API token in the vault" },
    ],
    ember: {
      prepare: READS("Read Authentik's sign-ins, failed sign-ins, apps and health", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-authentik-control with params.op user-off or user-on (params.userId), or retry-task (params.taskId); protected",
      ),
    },
  },
  {
    id: "actual-panel",
    name: "Actual Budget's panel",
    summary:
      "Actual Budget (budgets), a light read-only panel: whether its server is healthy, its version, memory and uptime, how people sign in, and its budget files by name, with whether each is encrypted and how many people can open it. Never what is in a budget.",
    aliases: ["actual", "actual budget", "budget server", "budgets", "envelope budgeting"],
    where: { route: "/services", path: "Open Actual Budget; Overview" },
    open: { app: ["actual"] },
    labels: ["Budget files", "Open Actual"],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway actualbudget/actual-server 26.11.0 on 2026-11-08, every reading checked (actual-real.test.ts).",
    evidence: [
      {
        file: E2E("actual-panel.spec.ts"),
        test: "Health, version and budget names, never the password",
      },
    ],
    needs: [{ anyApp: ["actual"], why: "Actual Budget, with its server password in the vault" }],
    ember: {
      prepare: READS("Read Actual Budget's server health, version and budget names", [
        "hearth_api",
      ]),
    },
  },
  {
    id: "mealie-panel",
    name: "Mealie's panel",
    summary:
      "Mealie (recipes), a light panel: version and whether a newer one is out, recipes, people and households, Mealie's setup checks, storage, backups, and a warning when its first-run administrator account is still there; making a backup, cleaning temporary files, deleting unused images, removing empty recipe folders and unlocking locked accounts.",
    aliases: ["mealie", "recipes", "recipe manager", "meal planner"],
    where: { route: "/services", path: "Open Mealie; Overview" },
    open: { app: ["mealie"] },
    labels: [
      "Newest backup",
      "Back up now",
      "Storage and clean-up",
      "Unlock locked accounts",
      "Open Mealie",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway ghcr.io/mealie-recipes/mealie v3.30.0 on 2026-11-08, every reading and change read back (mealie-real.test.ts).",
    evidence: [
      {
        file: E2E("mealie-panel.spec.ts"),
        test: "Health, version, the first-run administrator, and a backup through a plan",
      },
    ],
    needs: [{ anyApp: ["mealie"], why: "Mealie, with an administrator's API token in the vault" }],
    ember: {
      prepare: READS("Read Mealie's health, version, storage and backups", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-mealie-control with params.op backup, clean-temp, clean-images, clean-folders or unlock",
      ),
    },
  },
  {
    id: "komga-panel",
    name: "Komga's panel",
    summary:
      "Komga (comics and manga): books and series, every library with its scan schedule, books it could not read and why, what was added lately, who signed in and failed sign-ins, and its history; scanning a library (or deep scanning it), analyzing its books, refreshing metadata, emptying its trash, and reading a broken book again.",
    aliases: ["komga", "comics", "manga", "comic library", "unreadable books", "cbz"],
    where: { route: "/services", path: "Open Komga; tabs Overview, Books, People" },
    open: { app: ["komga"] },
    labels: [
      "Libraries",
      "Scan for new books",
      "Deep scan",
      "Empty trash",
      "Added lately",
      "Could not be read",
      "Read it again",
      "Open Komga",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway gotson/komga 1.30.0 on 2026-11-08, every reading and change read back (komga-real.test.ts).",
    evidence: [
      {
        file: E2E("komga-panel.spec.ts"),
        test: "Overview: books, unreadable, libraries and a scan through a plan",
      },
      {
        file: E2E("komga-panel.spec.ts"),
        test: "Books and People: read a broken book again, failed sign-ins",
      },
    ],
    needs: [{ anyApp: ["komga"], why: "Komga, with an administrator's API key in the vault" }],
    ember: {
      prepare: READS("Read Komga's libraries, unreadable books, users and sign-ins", [
        "hearth_api",
      ]),
      execute: PLAN_CHANGE(
        "app-komga-control with params.op scan, deep-scan, analyze, refresh-metadata or empty-trash (params.libraryId), or analyze-book (params.bookId)",
      ),
    },
  },
  {
    id: "wgeasy-panel",
    name: "wg-easy's panel",
    summary:
      "wg-easy (WireGuard): who is connected right now, every client's last handshake, where it connects from, data sent and received and end date, clients past their end date, and the address clients connect to; turning clients on or off, adding, renaming, giving an end date to and removing them, and restarting WireGuard. Every change is protected. Never a client's keys, configuration or QR code.",
    aliases: ["wg-easy", "wireguard", "vpn clients", "peers", "last handshake", "vpn"],
    where: { route: "/services", path: "Open wg-easy; tabs Overview, Clients" },
    open: { app: ["wgeasy"] },
    labels: [
      "Connected now",
      "Clients connect to",
      "Restart WireGuard",
      "Find a client or address",
      "End date",
      "New client's name",
      "Add client",
      "Open wg-easy",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway ghcr.io/wg-easy/wg-easy:15 on 2026-11-08, every reading and change read back and undone (wgeasy-real.test.ts).",
    evidence: [
      {
        file: E2E("wgeasy-panel.spec.ts"),
        test: "Overview: connected now, traffic, end dates, no keys",
      },
      {
        file: E2E("wgeasy-panel.spec.ts"),
        test: "Clients: turn one off through a protected plan, read back",
      },
    ],
    needs: [
      {
        anyApp: ["wgeasy"],
        why: "wg-easy 15 or later, with its web login in the vault (changes you approve, each confirming it is you)",
      },
    ],
    ember: {
      prepare: READS("Read wg-easy's clients, handshakes and traffic", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-wgeasy-control with params.op enable, disable or remove (params.clientId), rename or expiry (params.clientId, params.value), add (params.name, params.value), restart (protected: approving asks the owner to confirm it is them)",
      ),
    },
  },
  {
    id: "tailscale-panel",
    name: "Tailscale's panel",
    summary:
      "Tailscale, read from its own API: every device online or not and when last seen, devices waiting for approval, keys running out, exit nodes and subnet routes offered or approved, client updates and DNS; approving or taking away a device's access, turning key expiry off or on, approving or withdrawing exit nodes and routes, renaming and removing devices. Every change is protected. Not yet checked against a real tailnet.",
    aliases: [
      "tailscale",
      "tailnet",
      "exit node",
      "subnet routes",
      "key expiry",
      "vpn devices",
      "magicdns",
    ],
    where: { route: "/services", path: "Open Tailscale; tabs Overview, Devices" },
    open: { app: ["tailscale"] },
    labels: [
      "Needs a look",
      "Approve",
      "Never expire",
      "Approve exit node",
      "Approve routes",
      "Find a device, address, user or tag",
      "Take access away",
      "Open Tailscale",
    ],
    status: "working",
    statusNote:
      "Tested against a stand-in that follows Tailscale's official API client (tailscale-client-go-v2 at f9e92a8); not yet run against a real tailnet, because api.tailscale.com was out of reach where it was built. tailscale-real.test.ts reads a real tailnet when given a token.",
    evidence: [
      {
        file: E2E("tailscale-panel.spec.ts"),
        test: "Overview: online, waiting, keys and exit nodes, no keys on the page",
      },
      {
        file: E2E("tailscale-panel.spec.ts"),
        test: "Devices: approve a waiting device through a protected plan",
      },
    ],
    needs: [
      {
        anyApp: ["tailscale"],
        why: "Tailscale, with an API access token in the vault given the address https://api.tailscale.com (changes you approve, each confirming it is you)",
      },
    ],
    ember: {
      prepare: READS("Read the tailnet's devices, keys, exit nodes and routes", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-tailscale-control with params.op authorize, deauthorize, expiry-off, expiry-on, exit-approve, exit-withdraw, routes-approve, routes-withdraw or remove (params.deviceId), rename (params.deviceId, params.value) (protected: approving asks the owner to confirm it is them)",
      ),
    },
  },
  {
    id: "vaultwarden-panel",
    name: "Vaultwarden's panel",
    summary:
      "Vaultwarden: accounts active, invited and turned off, who has two-step sign-in, last active, organizations, whether sign-ups are open, https, its version and diagnostics, and its settings for who can get in; turning accounts off or on, signing out everywhere, turning off two-step sign-in for a lost phone, inviting, deleting, and backing up its database. Every change is protected. Never anything inside a vault.",
    aliases: [
      "vaultwarden",
      "bitwarden",
      "password manager",
      "two-step sign-in",
      "2fa",
      "lost phone",
      "invite to vaultwarden",
    ],
    where: { route: "/services", path: "Open Vaultwarden; tabs Overview, Accounts" },
    open: { app: ["vaultwarden"] },
    labels: [
      "Two-step sign-in",
      "Sign-ups",
      "Needs a look",
      "Who can get in",
      "Back up the database now",
      "Find an account or organization",
      "Sign out everywhere",
      "Lost their phone",
      "Email to invite",
      "Open Vaultwarden's admin page",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway vaultwarden/server 1.37.5 on 2026-11-08, every reading and change read back, two-step sign-in removed from a real authenticator set-up, and five reads with one admin sign-in (vaultwarden-real.test.ts).",
    evidence: [
      {
        file: E2E("vaultwarden-panel.spec.ts"),
        test: "Overview: two-step sign-in, open sign-ups and settings, no secrets",
      },
      {
        file: E2E("vaultwarden-panel.spec.ts"),
        test: "Accounts: turn one off through a protected plan, read back",
      },
    ],
    needs: [
      {
        anyApp: ["vaultwarden"],
        why: "Vaultwarden with its admin page on, and its admin token in the vault (changes you approve, each confirming it is you)",
      },
    ],
    ember: {
      prepare: READS("Read Vaultwarden's accounts, sign-up settings and diagnostics", [
        "hearth_api",
      ]),
      execute: PLAN_CHANGE(
        "app-vaultwarden-control with params.op disable, enable, deauth, remove-2fa, resend or delete (params.userId), invite (params.email), backup (protected: approving asks the owner to confirm it is them)",
      ),
    },
  },
  {
    id: "paperless-panel",
    name: "Paperless-ngx's panel",
    summary:
      "Paperless-ngx: the inbox of new documents still to sort, imports running and failed with Paperless's own reason, its health (database, Redis, workers, search index, classifier, sanity check), free space, tags, correspondents and document types; marking inbox documents done, tagging them, setting the correspondent or type, searching every document, moving documents to the trash or back, making tags and running maintenance. Titles only, never a document's text.",
    aliases: [
      "paperless",
      "paperless-ngx",
      "documents",
      "document inbox",
      "scans",
      "failed imports",
      "consume folder",
      "correspondents",
    ],
    where: { route: "/services", path: "Open Paperless-ngx; tabs Overview, Inbox, Documents" },
    open: { app: ["paperless"] },
    labels: [
      "Could not finish",
      "Ask Ember why",
      "Importing now",
      "Paperless itself",
      "Make tag",
      "Maintenance",
      "Mark done",
      "Search every document's text",
      "Move to trash",
      "Bring back",
      "Open Paperless-ngx",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway paperlessngx/paperless-ngx 3.4.2 on 2026-11-08, every reading and change read back and undone (paperless-real.test.ts). It speaks API version 9, which Paperless-ngx 2.x also answers.",
    evidence: [
      {
        file: E2E("paperless-panel.spec.ts"),
        test: "Overview: inbox, failed import, health and tags",
      },
      { file: E2E("paperless-panel.spec.ts"), test: "Inbox: mark documents done through a plan" },
      {
        file: E2E("paperless-panel.spec.ts"),
        test: "Documents: search, move to the trash and bring back",
      },
    ],
    needs: [
      {
        anyApp: ["paperless"],
        why: "Paperless-ngx, with an API token in the vault (an administrator's sees every document)",
      },
    ],
    ember: {
      prepare: READS(
        "Read Paperless-ngx's inbox, imports, health and labels, and search documents",
        ["hearth_api"],
      ),
      execute: PLAN_CHANGE(
        "app-paperless-control with params.op inbox-done, tag-add or tag-remove (params.tagId), correspondent or type (params.value), trash, restore or reprocess, all with params.documents; tag-create (params.name, params.inbox), dismiss (params.taskIds), run (params.task)",
      ),
    },
  },
  {
    id: "nextcloud-panel",
    name: "Nextcloud's panel",
    summary:
      "Nextcloud: free space, files and accounts, who used it lately, background jobs and when they last ran, public links without a password, app updates and Nextcloud's own setup checks; every account with its storage, quota, groups and last sign-in; every app on or off. Turning accounts off or on, setting quotas, changing groups, turning apps on or off, how background jobs run, and requiring a password on public links.",
    aliases: [
      "nextcloud",
      "cloud storage",
      "quota",
      "storage quota",
      "background jobs",
      "cron",
      "public links",
      "nextcloud accounts",
      "nextcloud apps",
    ],
    where: { route: "/services", path: "Open Nextcloud; tabs Overview, Accounts, Apps" },
    open: { app: ["nextcloud"] },
    labels: [
      "Needs a look",
      "Sharing and background jobs",
      "Require a password on public links",
      "Background jobs run by",
      "Find an account, email or group",
      "Set quota",
      "Add to group",
      "Find an app",
      "Open Nextcloud",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway nextcloud:apache 35.0.2 on 2026-11-08, every reading and change read back and undone, and an app password shown to read but not change (nextcloud-real.test.ts).",
    evidence: [
      {
        file: E2E("nextcloud-panel.spec.ts"),
        test: "Overview: jobs, open links, near-full accounts and setup checks",
      },
      {
        file: E2E("nextcloud-panel.spec.ts"),
        test: "Accounts: turn one off through a plan, read back",
      },
      {
        file: E2E("nextcloud-panel.spec.ts"),
        test: "Apps: the update waiting, and turning an app on",
      },
    ],
    needs: [
      {
        anyApp: ["nextcloud"],
        why: "Nextcloud, with an administrator's username and sign-in password in the vault (an app password only reads)",
      },
    ],
    ember: {
      prepare: READS("Read Nextcloud's storage, accounts, apps, background jobs and setup checks", [
        "hearth_api",
      ]),
      execute: PLAN_CHANGE(
        "app-nextcloud-control with params.op user-disable or user-enable (params.userId), user-quota (params.userId, params.value), group-add or group-remove (params.userId, params.group), app-enable or app-disable (params.appId), jobs-mode (params.value ajax, webcron or cron), setting (params.setting links-password or links-allowed, params.value on or off)",
      ),
    },
  },
  {
    id: "portainer-panel",
    name: "Portainer's panel",
    summary:
      "Portainer: each environment's containers running, stopped and unhealthy, every stack with its containers, and starting, stopping or updating a stack, or starting, stopping or restarting a container (protected when it runs networking).",
    aliases: [
      "portainer",
      "stacks",
      "docker stacks",
      "restart a container",
      "update a stack",
      "unhealthy container",
    ],
    where: { route: "/services", path: "Open Portainer; tabs Overview, Stacks and containers" },
    open: { app: ["portainer"] },
    labels: [
      "Unhealthy",
      "Restart",
      "Update",
      "Every environment",
      "Find a stack or container",
      "Open Portainer",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway portainer/portainer-ce container (2.45.3) on 2026-11-08, every reading and change read back (portainer-real.test.ts).",
    evidence: [
      {
        file: E2E("portainer-panel.spec.ts"),
        test: "Overview: environments and an unhealthy container restarted",
      },
      {
        file: E2E("portainer-panel.spec.ts"),
        test: "Stacks: stop and start one, update it, and a networking stack is protected",
      },
    ],
    needs: [
      {
        anyApp: ["portainer"],
        why: "Portainer, with an access token in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS("Read Portainer's environments, stacks and containers", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-portainer-control with params.op stack-start, stack-stop, stack-update (params.stackId) or container-start, container-stop, container-restart (params.container), and params.environmentId",
      ),
    },
  },
  {
    id: "traefik-panel",
    name: "Traefik's panel",
    summary:
      "Traefik, read only: every router with the names it answers and where it sends them, routers Traefik refused and why, apps it sees down behind a router, and certificates with their expiry. Its routers also fill in Open web UI addresses.",
    aliases: [
      "traefik",
      "traefik routers",
      "router refused",
      "traefik certificate",
      "reverse proxy",
    ],
    where: { route: "/services", path: "Open Traefik; tabs Overview, Routers, Certificates" },
    open: { app: ["traefik"] },
    labels: [
      "Routers",
      "Refused",
      "Apps down",
      "Ask Ember how to fix it",
      "Open Traefik's dashboard",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway traefik:v3 container (3.7.17) on 2026-11-08 (traefik-real.test.ts). Read only: Traefik's API cannot change routes.",
    evidence: [
      {
        file: E2E("traefik-panel.spec.ts"),
        test: "Overview: a refused router, an app down, a certificate running out",
      },
      { file: E2E("traefik-panel.spec.ts"), test: "Routers and certificates" },
    ],
    needs: [
      {
        anyApp: ["traefik"],
        why: "Traefik with its API on (api.insecure, port 8080 on your network)",
      },
    ],
    ember: {
      prepare: READS("Read Traefik's routers, refused routers, app servers and certificates", [
        "hearth_api",
        "app_api",
      ]),
    },
  },
  {
    id: "npm-panel",
    name: "Nginx Proxy Manager's panel",
    summary:
      "Nginx Proxy Manager: every site with where it forwards and its certificate, sites nginx could not load, certificates and expiry, and switching a site on or off, changing where it forwards, adding or removing one, renewing a certificate. Its sites also fill in Open web UI addresses. Every change is a protected plan.",
    aliases: [
      "nginx proxy manager",
      "npm",
      "proxy hosts",
      "reverse proxy sites",
      "add a site to my proxy",
      "certificate expiring",
      "renew certificate",
      "site not loading",
    ],
    where: {
      route: "/services",
      path: "Open Nginx Proxy Manager; tabs Overview, Sites, Certificates",
    },
    open: { app: ["npm"] },
    labels: [
      "Sites on",
      "Not loading",
      "Latest changes",
      "Add a site",
      "Change",
      "Send it there",
      "Remove the site",
      "Renew now",
      "Open Nginx Proxy Manager",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway jc21/nginx-proxy-manager container (2.16.0) on 2026-11-08, every reading and change read back (npm-real.test.ts).",
    evidence: [
      {
        file: E2E("npm-panel.spec.ts"),
        test: "Overview: sites on, one nginx could not load, a certificate expiring soon",
      },
      {
        file: E2E("npm-panel.spec.ts"),
        test: "Sites: switch one off, change where it forwards, add one",
      },
      {
        file: E2E("npm-panel.spec.ts"),
        test: "Certificates: expiry, sites using each, renew a Let's Encrypt one",
      },
    ],
    needs: [
      {
        anyApp: ["npm"],
        why: "Nginx Proxy Manager, with its email and password in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS("Read Nginx Proxy Manager's sites, certificates and latest changes", [
        "hearth_api",
      ]),
      execute: PLAN_CHANGE(
        "app-npm-control with params.op host-enable, host-disable, host-forward, host-add, host-remove or cert-renew (protected: approving asks the owner to confirm it is them)",
      ),
    },
  },
  {
    id: "proxmox-panel",
    name: "Proxmox VE's panel",
    summary:
      "Proxmox VE: each node's CPU, memory and disk, every VM and container with its state and resources, start, shut down, restart, force stop, back up now and snapshots, backup jobs and files, storage use, and failed tasks.",
    aliases: [
      "proxmox",
      "pve",
      "virtual machines",
      "vms",
      "lxc containers",
      "start a vm",
      "shut down a vm",
      "back up a vm",
      "snapshot a vm",
      "proxmox backups",
    ],
    where: { route: "/services", path: "Open Proxmox; tabs Overview, VMs and containers, Backups" },
    open: { app: ["proxmox"] },
    labels: [
      "Running",
      "Backed up this week",
      "Failed tasks",
      "Recent tasks",
      "Start",
      "Shut down",
      "Restart",
      "Force stop",
      "Back up now",
      "Take a snapshot",
      "Backup jobs",
      "Open Proxmox",
    ],
    status: "working",
    statusNote:
      "Not yet tested against a real server: Proxmox needs a machine of its own, so it was built and tested against Proxmox's own API schema and a stand-in. Ask a user who runs it to try it before release.",
    evidence: [
      {
        file: E2E("proxmox-panel.spec.ts"),
        test: "Overview: the node, guests running, backups, failed tasks and storage",
      },
      {
        file: E2E("proxmox-panel.spec.ts"),
        test: "VMs and containers: start one, back one up, take a snapshot",
      },
      {
        file: E2E("proxmox-panel.spec.ts"),
        test: "Backups: jobs, the newest backup of each guest, and the files",
      },
    ],
    needs: [
      {
        anyApp: ["proxmox"],
        why: "Proxmox VE, with an API token in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS(
        "Read Proxmox's nodes, VMs and containers, storage, backups and tasks, and a guest's snapshots (.../dashboard/proxmox/snapshots?guest=qemu/100)",
        ["hearth_api"],
      ),
      execute: PLAN_CHANGE(
        "app-proxmox-control with params.op start, shutdown, reboot, stop, backup or snapshot and params.guest (qemu/<vmid> or lxc/<vmid>)",
      ),
    },
  },
  {
    id: "adguard-panel",
    name: "AdGuard Home's panel",
    summary:
      "AdGuard Home's protection: queries and blocked in the last 24 hours, the query log with why each domain is blocked or allowed, pause and turn back on, safe browsing, parental control and safe search, custom rules, filter lists, blocked services, and DNS rewrites. Every change is a protected plan.",
    aliases: [
      "adguard",
      "adguard home",
      "pause adguard",
      "allow a domain in adguard",
      "block tiktok",
      "blocked services",
      "safe search",
      "parental control",
      "dns rewrite",
      "filter lists",
      "custom filtering rules",
    ],
    where: {
      route: "/services",
      path: "Open AdGuard Home; tabs Overview, Query log, Filters, Blocked services, DNS rewrites",
    },
    open: { app: ["adguard"] },
    labels: [
      "Pause protection",
      "Turn protection on",
      "Update filter lists",
      "Most blocked",
      "Busiest devices",
      "Safe search",
      "Custom rules",
      "Add list",
      "Find a service",
      "Review the change",
      "Add rewrite",
      "Find a domain or device",
      "Open AdGuard Home",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway adguard/adguardhome container (v0.107.80) on 2026-11-07, every reading and change read back (adguard-real.test.ts).",
    evidence: [
      {
        file: E2E("adguard-panel.spec.ts"),
        test: "Overview: numbers, pause and turn back on, a safety switch",
      },
      {
        file: E2E("adguard-panel.spec.ts"),
        test: "Query log: blocked lookups, why one is blocked, and allow it",
      },
      {
        file: E2E("adguard-panel.spec.ts"),
        test: "Filters: block a domain, switch a list off, add a list",
      },
      { file: E2E("adguard-panel.spec.ts"), test: "Blocked services and DNS rewrites" },
    ],
    needs: [
      {
        anyApp: ["adguard"],
        why: "AdGuard Home, with its username and password in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS(
        "Read AdGuard Home's numbers, query log (GET .../dashboard/adguard/queries), why a domain is blocked (.../adguard/check?domain=), filters, rules, services and rewrites",
        ["hearth_api"],
      ),
      execute: PLAN_CHANGE(
        "app-adguard-control with params.op: pause, resume, refresh, allow, block, rule-remove, filter-add, filter-enable, filter-disable, filter-remove, rewrite-add, rewrite-remove, services, safety (protected: approving asks the owner to confirm it is them)",
      ),
    },
  },
  {
    id: "pihole-panel",
    name: "Pi-hole's panel",
    summary:
      "Pi-hole's ad blocking: queries and blocked in the last 24 hours, the query log with why each domain is blocked or allowed, pause and turn back on, update the blocklists, allow or block a domain or a pattern, blocklists, and local DNS names and aliases. Every change is a protected plan.",
    aliases: [
      "pi-hole",
      "pihole",
      "ad blocking",
      "pause ad blocking",
      "turn off ad blocker",
      "allow a domain",
      "whitelist a domain",
      "block a domain",
      "blocklists",
      "update gravity",
      "a site is broken by ad blocking",
      "query log",
      "why is this domain blocked",
      "local dns",
      "dns record",
      "cname",
      "regex blocklist",
    ],
    where: {
      route: "/services",
      path: "Open Pi-hole; tabs Overview, Query log, Lists and domains, Local DNS",
    },
    open: { app: ["pihole"] },
    labels: [
      "Pause blocking",
      "Turn blocking on",
      "Update blocklists",
      "Most blocked",
      "Busiest devices",
      "Allow",
      "Take off",
      "Add blocklist",
      "Find a domain",
      "Why is it blocked or allowed?",
      "Add name",
      "Add alias",
      "Open Pi-hole",
    ],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway pihole/pihole container (Core v6.5, FTL v6.8) on 2026-11-07, every reading and change read back (pihole-real.test.ts).",
    evidence: [
      {
        file: E2E("pihole-panel.spec.ts"),
        test: "Overview: queries and blocked, most blocked, pause and turn back on",
      },
      {
        file: E2E("pihole-panel.spec.ts"),
        test: "Allow a blocked domain from the Overview, then take it off in Lists and domains",
      },
      {
        file: E2E("pihole-panel.spec.ts"),
        test: "Lists: switch one off, add one, update the blocklists",
      },
      {
        file: E2E("pihole-panel.spec.ts"),
        test: "Query log: from a busiest device, why a domain is blocked, and allow it from a line",
      },
      {
        file: E2E("pihole-panel.spec.ts"),
        test: "Local DNS: add a name and an alias; block a pattern in Lists and domains",
      },
    ],
    needs: [
      {
        anyApp: ["pihole"],
        why: "Pi-hole 6 or newer, with its app password in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS(
        "Read Pi-hole's numbers, query log (GET .../dashboard/pihole/queries), why a domain is blocked (.../pihole/check?domain=), lists, local DNS and warnings",
        ["hearth_api"],
      ),
      execute: PLAN_CHANGE(
        "app-pihole-control with params.op: pause, resume, gravity, allow, deny, domain-remove (params.match regex for a pattern), list-add, list-enable, list-disable, list-remove, dns-add, dns-remove, alias-add, alias-remove (protected: approving asks the owner to confirm it is them)",
      ),
    },
  },
  {
    id: "seerr-panel",
    name: "Overseerr / Jellyseerr / Seerr panel",
    summary: "Requests with release dates and Stop tracking; request new titles; issues; people.",
    aliases: [
      "overseerr",
      "jellyseerr",
      "seerr",
      "requests",
      "movie requests",
      "stop tracking",
      "overdue request",
      "request a movie",
      "request a show",
      "reported issue",
      "trending movies",
      "new releases",
      "what's trending",
      "recently released",
      "upcoming movies",
      "root folder for a request",
      "quality profile for a request",
      "already in my library",
      "seerr says not requested",
      "requested again",
      "mark as available",
    ],
    where: { route: "/services", path: "Open Seerr: Overview, Discover, Issues, People" },
    open: { app: ["seerr"] },
    labels: [
      "Stop tracking",
      "Tell Seerr you have it",
      "Request anyway",
      "Most overdue",
      "Choose seasons",
      "Resolve",
      "Reopen",
      "Hide what I have",
      "See all",
      "Quality profile",
      "Root folder",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("releases.smoke.spec.ts"),
        test: "Overseerr panel: a show request, Sonarr's state, and Stop tracking that stops Sonarr too",
      },
      {
        file: E2E("seerr-panel.spec.ts"),
        test: "Discover rows: trending and new posters, details without requesting, hide what I have, search takes over",
      },
      {
        file: E2E("seerr-panel.spec.ts"),
        test: "Discover: find a film and request it, approved and read back",
      },
      {
        file: E2E("seerr-panel.spec.ts"),
        test: "Issues: reply to one and resolve it, each approved",
      },
      {
        file: E2E("seerr-panel.spec.ts"),
        test: "Discover: a show's seasons are chosen before requesting",
      },
      {
        file: "apps/server/src/apps/seerr-panel.test.ts",
        test: "work on Overseerr 1.x too: the plain trending list, split into movies and shows",
      },
    ],
    needs: [{ anyApp: ["seerr"], why: "Overseerr or Jellyseerr, with its key in the vault" }],
    ember: {
      prepare: READS("Read requests and what holds each up", ["movie_requests"]),
      execute: APP_API_CHANGE(
        "Approve, change, request, retry or stop tracking a request; handle issues",
      ),
    },
  },
  {
    id: "media-server-panels",
    name: "Plex, Jellyfin and Tautulli panels",
    summary: "Who is watching (stop a stream), libraries, scans, tasks and users.",
    aliases: [
      "plex",
      "jellyfin",
      "tautulli",
      "who is watching",
      "stop a stream",
      "scan library",
      "link plex",
    ],
    where: { route: "/services", path: "Open Plex, Jellyfin or Tautulli" },
    open: { app: ["plex", "jellyfin", "tautulli"] },
    labels: ["Stop stream", "Link Plex"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "Plex dashboard: libraries, who is watching what, direct play or transcode, buffering, and ask about a stream",
      },
      {
        file: E2E("jellyfin.smoke.spec.ts"),
        test: "Jellyfin panel: paste a key, see who is watching and why it converts, stop a stream",
      },
    ],
    needs: [{ anyApp: ["plex", "jellyfin", "tautulli"], why: "Plex, Jellyfin or Tautulli" }],
    ember: {
      prepare: READS("See who is watching and the libraries", ["plex"]),
      execute: PLAN_CHANGE("Scan libraries or remove a duplicate version"),
    },
  },
  {
    id: "wizarr",
    name: "Wizarr invitations",
    summary: "Invitation links that give a friend access to your media server.",
    aliases: [
      "invite someone to my media server",
      "invite a friend to plex",
      "give someone access to jellyfin",
      "wizarr",
      "invitation link",
      "share my plex",
      "extend someone's access",
      "remove someone from my media server",
      "who has access to my server",
      "disable a user",
    ],
    where: { route: "/services", path: "Open Wizarr: Overview (invitations), People, Servers" },
    open: { app: ["wizarr"] },
    labels: [
      "New invitation",
      "Create invitation",
      "Copy link",
      "Change access",
      "Extend by",
      "Set end date",
      "No end date",
      "Disable account",
      "Remove",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("wizarr.smoke.spec.ts"),
        test: "Wizarr panel: connect with a pasted key, create an invitation and get its link, delete one",
      },
      {
        file: E2E("wizarr-panel.spec.ts"),
        test: "People: extend someone's access and remove someone, each approved",
      },
      {
        file: E2E("wizarr-panel.spec.ts"),
        test: "Servers shows libraries, and those Wizarr would ignore with how to fix them",
      },
    ],
    needs: [{ anyApp: ["wizarr"], why: "Wizarr, with its key in the vault" }],
    ember: { execute: APP_API_CHANGE("Create an invitation, or change someone's access") },
  },
  {
    id: "wizarr-setup",
    name: "Wizarr invite steps and settings",
    summary:
      "The guide people see when they open an invitation, and Wizarr's General settings, changed in Hearth.",
    aliases: [
      "wizarr wizard",
      "invite steps",
      "design my invites",
      "wizarr onboarding",
      "what people see when they accept an invite",
      "what happens when wizarr access ends",
      "clean expired users",
      "wizarr display name",
      "wizarr invite design",
      "make my invites look nice",
      "wizarr theme",
    ],
    where: { route: "/services", path: "Open Wizarr: Settings, General and Wizard" },
    open: { app: ["wizarr"] },
    labels: [
      "Before they accept",
      "After they accept",
      "Add a step",
      "Add step",
      "Save step",
      "Save settings",
      "Clean expired users",
      "Admin username",
      "Designs",
      "Choose colors and wording",
      "Use this design",
      "Save colors and wording",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("wizarr-setup.spec.ts"),
        test: "connect the admin sign-in, then add, edit and move invite steps",
      },
      {
        file: E2E("wizarr-setup.spec.ts"),
        test: "Settings: change what happens when access ends",
      },
      {
        file: E2E("wizarr-setup.spec.ts"),
        test: "Designs: pick Vault in Emerald, change the headline, and use it for Plex",
      },
    ],
    needs: [
      {
        anyApp: ["wizarr"],
        why: "Wizarr, with its admin sign-in in the vault (its API key cannot open these pages)",
      },
    ],
    ember: {
      prepare: READS(
        "Read the invite steps and settings (hearth_api GET /api/services/<id>/dashboard/wizarr/wizard or /settings)",
        ["hearth_api"],
      ),
      execute: PLAN_CHANGE(
        "Add, edit, move or delete an invite step, change General settings, or clean expired users",
      ),
    },
  },
  {
    id: "download-panels",
    name: "qBittorrent and SABnzbd panels",
    summary: "Every download, why one is stuck, and pause, resume, recheck and more.",
    aliases: [
      "qbittorrent",
      "sabnzbd",
      "torrent stuck",
      "pause downloads",
      "seeding limits",
      "download speed",
      "sabnzbd speed limit",
      "pause downloads for an hour",
      "download priority",
      "qbittorrent settings",
      "speed limit schedule",
      "max active downloads",
    ],
    where: { route: "/services", path: "Open qBittorrent or SABnzbd" },
    open: { app: ["qbittorrent", "sabnzbd"] },
    labels: [
      "Needs attention first",
      "Reannounce",
      "Recheck",
      "Remove and delete files",
      "Seeding, speed, and queue settings",
      "Undo my edits",
    ],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "qBittorrent dashboard: live torrents with moving progress bars, seeds and peers, groups, details",
      },
      {
        file: E2E("qbittorrent-settings.spec.ts"),
        test: "edits become one plan with before and after, approved and read back",
      },
      {
        file: E2E("sabnzbd.smoke.spec.ts"),
        test: "SABnzbd panel: queue and failures; pause all and retry a failed job",
      },
      {
        file: E2E("sabnzbd.smoke.spec.ts"),
        test: "SABnzbd panel: speed limit, a job's priority and its place in the queue",
      },
    ],
    needs: [{ anyApp: ["qbittorrent", "sabnzbd"], why: "qBittorrent or SABnzbd" }],
    ember: {
      prepare: READS("Read torrents and settings", ["qbittorrent"]),
      execute: PLAN_CHANGE("Resume, pause, reannounce, recheck or change limits"),
    },
  },
  {
    id: "romm-panel",
    name: "RomM panel (your game library)",
    summary:
      "Your RomM game library in Hearth: totals, recently added and favourites with covers, every game found by name, platform, genre or favourites, each game's page (cover, details, files), platforms, favourites, and library scans you approve (administrators only).",
    aliases: [
      "romm",
      "game library",
      "retro games",
      "roms",
      "scan my games",
      "favourite game",
      "game covers",
      "which platforms",
    ],
    where: { route: "/services", path: "Open RomM" },
    open: { app: ["romm"] },
    labels: [
      "Browse the library",
      "Scan for new games",
      "Find a game by name",
      "Add to favourites",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("romm-panel.spec.ts"),
        test: "Overview: totals, recently added with covers, favourites and platforms",
      },
      {
        file: E2E("romm-panel.spec.ts"),
        test: "Library: find, filter, open a game and make it a favourite",
      },
      {
        file: E2E("romm-panel.spec.ts"),
        test: "a quick scan of one platform is approved, then finds the new game",
      },
      {
        file: E2E("romm-panel.spec.ts"),
        test: "a viewer's login browses but is not offered scans",
      },
    ],
    needs: [
      { anyApp: ["romm"], why: "RomM, with a login in the vault (an administrator's for scans)" },
    ],
    ember: {
      prepare: READS("Read the library, games, platforms and favourites", ["app_api"]),
      execute: PLAN_CHANGE(
        "app-romm-control: scan (scanType, platformIds), favorite or unfavorite (romId)",
      ),
    },
  },
  {
    id: "emby-panel",
    name: "Emby's panel",
    summary:
      "Emby through Jellyfin's panel (it speaks the same API), with Emby's name and every tab: who is watching and whether it converts, the library (open a title, mark it watched, edit its details), tasks and scans, people, devices, activity, libraries and folders, plugins (remove; Emby has no off switch), settings and logs.",
    aliases: ["emby", "emby server", "emby users", "emby library", "emby plugins", "emby settings"],
    where: {
      route: "/services",
      path: "Open Emby; tabs Home, Overview, Library, Tasks, People, Devices, Activity, Manage, Plugins, Settings, Logs",
    },
    open: { app: ["emby"], tab: "people" },
    labels: ["Tasks", "People", "Devices", "Activity", "Logs"],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway emby/embyserver container (4.10.2.0) on 2026-11-08, every tab's readings and changes read back (emby-real.test.ts). Installing from Emby's online plugin catalog was not checked (the test server had no internet).",
    evidence: [
      {
        file: E2E("emby-panel.spec.ts"),
        test: "Emby gets Jellyfin's panel with its own name and every tab",
      },
      {
        file: E2E("emby-panel.spec.ts"),
        test: "Library: open a title and mark it watched, in Emby's words",
      },
    ],
    needs: [{ anyApp: ["emby"], why: "Emby, with an API key in the vault (changes you approve)" }],
    ember: {
      prepare: READS("Read Emby's library, people, devices, tasks, settings and activity", [
        "hearth_api",
      ]),
      execute: PLAN_CHANGE(
        "app-jellyfin-control on the Emby service, with the same ops as Jellyfin (no plugin-enable or plugin-disable)",
      ),
    },
  },
  {
    id: "nzbget-panel",
    name: "NZBGet's panel",
    summary:
      "NZBGet with the same Overview and Downloads tab as SABnzbd: the queue, speed, free space, its own health warnings, the history with why each download failed, pause or resume everything or one download, pause for a while, a speed limit in MB/s, priority, place, category, retry, remove, and adding NZBs.",
    aliases: ["nzbget", "usenet", "nzbget queue", "nzbget failed", "nzbget speed limit"],
    where: { route: "/services", path: "Open NZBGet; tabs Overview, Downloads" },
    open: { app: ["nzbget"], tab: "downloads" },
    labels: ["Pause all", "Retry", "Add NZB"],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway linuxserver/nzbget container (26.3) on 2026-11-08, every reading and change read back (nzbget-real.test.ts).",
    evidence: [
      {
        file: E2E("nzbget-panel.spec.ts"),
        test: "Overview: status, its warnings, and a speed limit in MB/s",
      },
      {
        file: E2E("nzbget-panel.spec.ts"),
        test: "the history with why it failed, and a retry",
      },
    ],
    needs: [
      {
        anyApp: ["nzbget"],
        why: "NZBGet, with its control login in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS("Read NZBGet's queue, history and warnings", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-nzbget-control with the same ops as app-sabnzbd-control (params.nzoId is NZBGet's NZBID), speed-limit in KB/s",
      ),
    },
  },
  {
    id: "sabnzbd-downloads",
    name: "SABnzbd's Downloads tab",
    summary:
      "Add NZBs (links or .nzb files) with a category, priority or paused, and a name; find and filter downloads and manage each one: pause, resume, priority, place, category, files, remove; search and filter the history, retry, remove; clear warnings.",
    aliases: [
      "add an nzb",
      "upload an nzb file",
      "nzb link",
      "sabnzbd history",
      "failed downloads",
      "retry a failed download",
      "sabnzbd warnings",
      "clear sabnzbd warnings",
      "files in a download",
    ],
    where: { route: "/services", path: "Open SABnzbd; tab Downloads" },
    open: { app: ["sabnzbd"], tab: "downloads" },
    labels: [
      "Add NZB",
      "Choose .nzb files",
      "Failed only",
      "Clear warnings",
      "Retry or remove them",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("sabnzbd-downloads.spec.ts"),
        test: "Add NZB from Overview: a link and an .nzb file, in a category, high priority",
      },
      {
        file: E2E("sabnzbd-downloads.spec.ts"),
        test: "a download's files and controls; removing it keeps what it downloaded",
      },
      {
        file: E2E("sabnzbd-downloads.spec.ts"),
        test: "the history: searched, failed only from Overview's link, and a retry",
      },
      {
        file: E2E("sabnzbd-downloads.spec.ts"),
        test: "warnings are shown on Overview and cleared there",
      },
    ],
    needs: [
      { anyApp: ["sabnzbd"], why: "SABnzbd, with its API key in the vault (changes you approve)" },
    ],
    ember: {
      prepare: READS("Read the queue, history, a download's files and warnings", ["app_api"]),
      execute: PLAN_CHANGE(
        "The same steps as the tab: app-sabnzbd-control with op add (links), pause, resume, priority, move, category, remove, retry, remove-history, clear-warnings",
      ),
    },
  },
  {
    id: "deluge-panel",
    name: "Deluge's panel",
    summary:
      "Deluge's torrents with the same Overview and Torrents tab as qBittorrent: add, pause, resume, recheck, reannounce, queue order, labels (its Label plugin), which files download, trackers, peers, remove keeping or deleting files; and its speed, queue and seeding settings.",
    aliases: [
      "deluge",
      "deluge torrents",
      "deluge label",
      "turn on deluge labels",
      "deluge settings",
      "deluge queue",
    ],
    where: { route: "/services", path: "Open Deluge; tabs Overview, Torrents, Settings" },
    open: { app: ["deluge"], tab: "torrents" },
    labels: ["Turn on labels", "Labels", "Top", "Bottom", "Open Deluge"],
    status: "working",
    evidence: [
      {
        file: E2E("deluge-panel.spec.ts"),
        test: "Overview at a glance, then a torrent's files, trackers and pause from Torrents",
      },
      {
        file: E2E("deluge-panel.spec.ts"),
        test: "labels: turn them on, make one, give it to a torrent; queue moves",
      },
      {
        file: E2E("deluge-panel.spec.ts"),
        test: "Settings: change a speed limit, read back",
      },
    ],
    needs: [
      {
        anyApp: ["deluge"],
        why: "Deluge, with its Web UI password in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS("Read Deluge's torrents, one torrent, and its settings", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-deluge-control with params.op: add, pause, resume, recheck, reannounce, queue-top/up/down/bottom, label, label-create, label-delete, labels-on, file-priority, settings, remove, remove-with-data",
      ),
    },
  },
  {
    id: "download-health",
    name: "Download Health",
    summary:
      "Stuck and failing downloads across qBittorrent, SABnzbd, Sonarr, Radarr, Lidarr and Chaptarr, explained in plain words. Strikes tell broken from slow; a shared cause (a VPN, a full disk, a client that does not answer) comes first. Fix it (Sonarr and Radarr) removes a stuck download, blocklists that one release and searches for another, as one plan you approve; Automatic Recovery, a switch off by default, does it without asking and says so in the bell.",
    aliases: [
      "stuck downloads",
      "automatic recovery",
      "fix stuck download",
      "why isn't my movie downloading",
      "stalled torrent",
      "failed download",
      "download problems",
      "cleanuparr",
      "is something wrong with sabnzbd",
    ],
    where: {
      route: "/",
      path: "The Lair: Download Health panel (and a line in qBittorrent's and SABnzbd's Overview)",
    },
    open: { panel: "downloads" },
    labels: ["Download Health", "Check now", "Needs you", "Being watched", "History"],
    status: "working",
    evidence: [
      {
        file: E2E("download-health.spec.ts"),
        test: "Download Health: the panel shows what needs you, why, and the shared cause first",
      },
    ],
    needs: [],
  },
  {
    id: "audiobook-intake",
    name: "Audiobook intake",
    summary:
      "Finished audiobook downloads are identified (tags, your library, names), copied into an Audiobookshelf library as Author/Title, checked file by file, and the library scanned. Sure ones go on their own; unsure ones wait for you to correct and import.",
    aliases: [
      "audiobook organizer",
      "import audiobooks",
      "organize audiobooks",
      "audiobooks into audiobookshelf",
      "audiobook download folder",
      "rename audiobooks",
    ],
    where: { route: "/services", path: "Open Audiobookshelf; tab Intake" },
    open: { app: ["audiobookshelf"], tab: "intake" },
    labels: ["Intake", "Review the setup", "Check now", "Import", "Skip", "Turn off"],
    status: "working",
    evidence: [
      {
        file: E2E("audiobook-intake.spec.ts"),
        test: "audiobook intake: set up once, then a release you name is copied in as Author/Title",
      },
    ],
    needs: [],
  },
  {
    id: "manual-sort",
    name: "Sort manual downloads",
    summary:
      "Torrents you add by hand (no category), and SABnzbd jobs with none, are sorted by type into their folders and handed to Radarr, Sonarr, Lidarr or Chaptarr; unclear ones wait in Unsorted. One setup plan, then automatic, each with Undo.",
    aliases: [
      "sort manual downloads",
      "manual torrent",
      "torrent i added myself",
      "no category",
      "unsorted downloads",
      "file a download as a movie",
      "replace the audiobook organizer",
    ],
    where: { route: "/services", path: "Open qBittorrent; tab Manual downloads" },
    open: { app: ["qbittorrent"], tab: "sort" },
    labels: ["Manual downloads", "Review the setup", "Check now", "File it", "Undo", "Turn off"],
    status: "working",
    evidence: [
      {
        file: E2E("manual-sort.spec.ts"),
        test: "manual downloads: set up once, then sorted, handed to Radarr, and the unclear one filed by you",
      },
    ],
    needs: [],
  },
  {
    id: "transmission-panel",
    name: "Transmission's panel",
    summary:
      "Transmission's torrents with the same Overview and Torrents tab as qBittorrent: add, pause, resume, recheck, reannounce, queue order, free-text labels, which files download, trackers, peers, remove keeping or deleting files; and its speed limits, turtle, share ratio, idle, queue and peer settings.",
    aliases: [
      "transmission",
      "transmission torrents",
      "transmission label",
      "transmission ratio",
      "turtle mode",
      "alternative speed",
    ],
    where: { route: "/services", path: "Open Transmission; tabs Overview, Torrents, Settings" },
    open: { app: ["transmission"], tab: "torrents" },
    labels: ["Labels", "Top", "Bottom", "Alternative speed (turtle)", "Open Transmission"],
    status: "working",
    statusNote:
      "Tested against a real server: a throwaway linuxserver/transmission container (4.1.4) on 2026-11-08, every reading and change read back (transmission-real.test.ts).",
    evidence: [
      {
        file: E2E("transmission-panel.spec.ts"),
        test: "Overview at a glance, then a torrent's files, trackers and pause from Torrents",
      },
      {
        file: E2E("transmission-panel.spec.ts"),
        test: "labels: type a new one for a torrent; queue moves; the label sheet lists them",
      },
      {
        file: E2E("transmission-panel.spec.ts"),
        test: "Settings: turn on a share ratio limit change and the turtle, read back",
      },
    ],
    needs: [
      {
        anyApp: ["transmission"],
        why: "Transmission, with its Web UI login in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS("Read Transmission's torrents, one torrent, and its settings", ["hearth_api"]),
      execute: PLAN_CHANGE(
        "app-transmission-control with params.op: add, pause, resume, recheck, reannounce, queue-top/up/down/bottom, label, file-priority, settings, remove, remove-with-data",
      ),
    },
  },
  {
    id: "qbittorrent-torrents",
    name: "qBittorrent's Torrents tab",
    summary:
      "Add torrents (links or .torrent files), find and filter them, and manage each one: pause, resume, force start, recheck, category, tags, which files download, trackers, peers, transfer; categories; remove keeping or deleting files.",
    aliases: [
      "add a torrent",
      "add a magnet link",
      "upload a torrent file",
      "torrent category",
      "change a torrent's category",
      "torrent tags",
      "skip a file in a torrent",
      "file priority",
      "torrent peers",
      "create a qbittorrent category",
      "remove a torrent",
    ],
    where: { route: "/services", path: "Open qBittorrent; tab Torrents" },
    open: { app: ["qbittorrent"], tab: "torrents" },
    labels: [
      "Add torrent",
      "Choose .torrent files",
      "Categories",
      "Force start",
      "Remove, keep files",
      "Remove and delete files",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("qbittorrent-torrents.spec.ts"),
        test: "Overview at a glance; Add torrent puts in a magnet link and a .torrent file",
      },
      {
        file: E2E("qbittorrent-torrents.spec.ts"),
        test: "a torrent's files, peers and category (with where its files go), then pause it",
      },
      {
        file: E2E("qbittorrent-torrents.spec.ts"),
        test: "categories: one in use cannot be removed; a new one is created and removed",
      },
      {
        file: E2E("qbittorrent-torrents.spec.ts"),
        test: "removing: the plan says plainly whether its files are kept or deleted",
      },
    ],
    needs: [
      {
        anyApp: ["qbittorrent"],
        why: "qBittorrent, with its login in the vault (changes you approve)",
      },
    ],
    ember: {
      prepare: READS("Read torrents, one torrent's files, settings and categories", [
        "qbittorrent",
      ]),
      execute: PLAN_CHANGE(
        "The same steps as the tab: app-qbt-add, app-qbt-pause/resume, app-qbt-force-start, app-qbt-recheck, app-qbt-set-category, app-qbt-set-tags, app-qbt-file-priority, app-qbt-category, app-qbt-remove, app-qbt-remove-with-data",
      ),
    },
  },
  {
    id: "home-assistant",
    name: "Home Assistant panel",
    summary: "Lights and switches, integrations, routines, automations and scenes.",
    aliases: [
      "home assistant",
      "automations",
      "routines",
      "turn on a light",
      "scenes",
      "manage my home assistant automations",
    ],
    where: { route: "/services", path: "Open Home Assistant" },
    open: { app: ["homeassistant"] },
    labels: ["Lights and switches", "Run now", "Look before running"],
    status: "working",
    evidence: [
      {
        file: E2E("homeassistant.smoke.spec.ts"),
        test: "Home Assistant panel: automations and switches; turn a light on; reload an integration",
      },
    ],
    needs: [{ anyApp: ["homeassistant"], why: "Home Assistant, with its token in the vault" }],
    ember: {
      prepare: READS("Read devices, routines and automations", ["home_assistant"]),
      execute: APP_API_CHANGE(
        "Run a routine or change an automation; anything beyond lights waits for you",
      ),
    },
  },
  {
    id: "speaker-names",
    name: "Speaker names",
    summary:
      "Speakers show by a real name, never a model number or an IP address: the name set in Home Assistant, the name their own system reports (Music Assistant, Sonos, Cast), or their room. Rename one right in the speaker list (right-click, long-press on a phone, or the pencil; Enter saves); the name is used everywhere Hearth shows that speaker, and Reset name goes back.",
    aliases: [
      "rename a speaker",
      "speaker name",
      "speaker shows an ip",
      "speaker shows a model number",
      "change speaker name",
    ],
    where: { route: "/", path: "Open Home Assistant, Home tab, Media: the speaker list" },
    open: { app: ["homeassistant"], tab: "home" },
    labels: ["Reset name", "Rename"],
    status: "working",
    evidence: [
      {
        file: E2E("speaker-names.spec.ts"),
        test: "a speaker shows by its room, renames in the picker, and Reset name goes back",
      },
    ],
  },
  {
    id: "music-playlist",
    name: "Have Ember make a playlist",
    summary:
      "Say the vibe, about how many songs and a name, and Ember picks the songs, checks each is real where it will play, opens them in the Forge so you can swap any, and creates the playlist only after you say yes: on a streaming service through Music Assistant (YouTube Music, Spotify and others), or from your own music in Plex (so Plexamp has it), Jellyfin, Emby or Navidrome.",
    aliases: [
      "make a playlist",
      "make me a playlist",
      "youtube music playlist",
      "create a playlist",
      "playlist of songs like",
      "generate a playlist",
      "plexamp playlist",
      "spotify playlist",
      "playlist from my own music",
    ],
    where: {
      route: "/",
      path: "Open Home Assistant, Home tab, Media (not on a home tablet); or a Plex, Jellyfin or Emby panel's Library tab on a music library; or Navidrome's Overview: Have Ember make a playlist",
    },
    open: { app: ["homeassistant"], tab: "home" },
    labels: ["Have Ember make a playlist", "What kind of playlist?", "Ask Ember to make it"],
    status: "working",
    statusNote:
      "Picking and the Forge are Hearth's; creating the playlist goes through Music Assistant's YouTube Music sign-in after your yes.",
    evidence: [
      {
        file: E2E("home-music.spec.ts"),
        test: "Media page: Have Ember make a playlist hands Ember the request",
      },
      {
        file: E2E("navidrome-panel.spec.ts"),
        test: "Have Ember make a playlist from the music Navidrome holds",
      },
    ],
  },
  {
    id: "calendar-sign-in-again",
    name: "A calendar that stopped: signing in to Google Calendar again",
    summary:
      "When Home Assistant's calendars stop showing (the Today card or Calendar says Home Assistant can't read them, or a service needs a sign-in again), the card's Sign in to Google Calendar again button renews it in one step: Hearth carries on with Home Assistant's own waiting sign-in, or, when none waits (it was used up in an old tab: Home Assistant's log shows UnknownFlow), reloads that service so Home Assistant asks afresh, then opens Google's sign-in page. It only says Connected once the calendars read again. On a browser that never used My Home Assistant, a page asks for the Home Assistant address: the sign-in window shows it to copy, then Save and Link account. A Google sign-in that stops about 7 days after it was made means the owner's Google Cloud app is still in Testing: on console.cloud.google.com/auth/branding add Application home page https://www.home-assistant.io, privacy policy link https://www.home-assistant.io/privacy/ and authorized domain home-assistant.io, no logo, Save; then on console.cloud.google.com/auth/audience press Publish app (greyed out means a Branding field is missing), and sign in again once, since a sign-in made in Testing still ends after 7 days. Google then warns the app is unverified: Advanced, then Go to it (it is the owner's own app).",
    aliases: [
      "calendar disconnected",
      "calendar stopped working",
      "calendar not showing",
      "google calendar disconnected",
      "sign in to google calendar again",
      "reauthenticate google calendar",
      "google calendar keeps disconnecting",
      "google sign in expires every week",
      "publish app greyed out",
      "oauth testing mode",
      "my home assistant address",
      "unknown flow",
    ],
    where: {
      route: "/home-screen",
      path: "Open Home Assistant, Home tab: the Today card or the Calendar on the Household page",
    },
    open: { app: ["homeassistant"], tab: "home" },
    labels: ["Ask Ember to fix it", "Open Home Assistant's repairs", "Open the sign-in page"],
    status: "working",
    evidence: [
      {
        file: E2E("home-calendar.spec.ts"),
        test: "calendar: Google needs a sign-in again, the card says so and renews it in one step",
      },
      {
        file: E2E("home-calendar.spec.ts"),
        test: "calendar: a sign-in thrown away, the card still signs in again (Home Assistant asks afresh)",
      },
    ],
    needs: [
      {
        anyApp: ["homeassistant"],
        why: "Home Assistant, with an administrator's token in the vault",
      },
    ],
    ownerOnly:
      "Google's sign-in and the Google Cloud console need the owner's own Google account: Google blocks automated sign-ins, so Ember guides those steps and hands over the button.",
    ember: {
      prepare: {
        what: "Reads Home Assistant's calendars, repairs and log to find why (a refused sign-in, a sign-in thrown away, Testing mode), opens the Home tab where the sign-in button is, and checks afterwards that the calendars read again",
        tools: ["home_assistant", "read_logs", "hearth_help"],
        approval: "none",
      },
    },
  },
  {
    id: "home-dashboard",
    name: "The home dashboard (a wall tablet)",
    summary:
      "Home Assistant's Home tab and full screen, a household command centre for a wall tablet: the time written out over a window that shows the real weather (rain, snow, sun, fog, storms, day and night), the hourly and daily forecast, music like a media app (Spotify, Music Assistant for YouTube Music and Amazon Music), calendars (Google, Apple, Proton), grocery and chore lists, lights and the thermostat by room, cameras, locks, the garage and the alarm, on swipeable Home, Rooms, Media, Security and Household pages, with one-tap controls, an unlock PIN for opening doors, settings for each screen, dimming when idle, and home tablets that open only the dashboard. A widget gallery puts any of twenty-one widgets on the Home page, moved and resized per screen: any device or sensor, who's home, the doorbell (its camera pops up when it rings), energy, commute times, a photo frame from Immich, chores with stars, reminders and bin day, countdowns, a family message board, news feeds, sports scores, plants and the next movie night.",
    aliases: [
      "home dashboard",
      "wall tablet",
      "kitchen tablet",
      "kiosk",
      "grocery list",
      "chore list",
      "family calendar",
      "connect spotify",
      "youtube music",
      "amazon music",
      "google calendar",
      "proton calendar",
      "apple calendar",
      "security cameras",
      "unlock the door",
      "garage door",
      "pair a home tablet",
      "unlock pin",
      "thermostat",
      "written out time",
      "weather animation",
      "now playing",
      "widgets",
      "add a widget",
      "photo frame",
      "message board",
      "chore chart",
      "countdown",
      "who is home",
      "doorbell camera",
      "energy usage",
      "commute time",
      "news headlines",
      "sports scores",
    ],
    where: {
      route: "/home-screen",
      path: "Open Home Assistant, Home tab (Full screen); a home tablet: Settings, PCs and devices, Add a device",
    },
    open: { app: ["homeassistant"] },
    labels: [
      "Today",
      "Lists",
      "Home Status",
      "Scenes",
      "Lights and switches",
      "Doors and alarm",
      "Speakers",
      "Dashboard settings",
      "Full screen",
      "Set the PIN",
      "Connect a calendar",
      "Add a list",
      "Add Item",
      "Show a QR code",
      "Add widgets",
      "Customize",
      "Move and resize",
      "Devices and Sensors",
      "Message Board",
      "Chores and Stars",
      "Countdowns",
      "Photo Frame",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("home-dashboard.spec.ts"),
        test: "Home tab: the weather window, music, lists, rooms, the thermostat, doors with the PIN, settings",
      },
      {
        file: E2E("home-dashboard.spec.ts"),
        test: "the window follows the weather, swipes between pages, and says when Home Assistant stops answering",
      },
      {
        file: E2E("home-dashboard.spec.ts"),
        test: "a paired home tablet opens the home dashboard and nothing else",
      },
      {
        file: E2E("home-widgets.spec.ts"),
        test: "the widget gallery adds widgets that show the real home, and the family board",
      },
    ],
    needs: [
      {
        anyApp: ["homeassistant"],
        why: "Home Assistant, with its token in the vault (an administrator's to connect services)",
      },
    ],
    ownerOnly:
      "Signing in to Spotify, Google or Apple, setting the unlock PIN, and pairing a tablet are yours.",
    ember: {
      prepare: READS("Read what the dashboard shows", ["home_assistant", "app_api"]),
      execute: APP_API_CHANGE(
        "Ember's changes to the house stay plans you approve; the dashboard's taps are yours",
      ),
    },
  },
  {
    id: "other-panels",
    name: "Other app panels",
    summary:
      "Prowlarr, Bazarr, Recyclarr, Caddy, Tinyauth, Gluetun, FlareSolverr, Audiobookshelf, Kavita, Immich, ErsatzTV, Syncthing.",
    aliases: [
      "prowlarr",
      "bazarr",
      "recyclarr",
      "caddy",
      "tinyauth",
      "protect a site with a sign-in",
      "who is behind tinyauth",
      "change my tinyauth password",
      "add a tinyauth user",
      "gluetun",
      "vpn",
      "flaresolverr",
      "audiobookshelf",
      "kavita",
      "immich",
      "recent photos",
      "latest photos in immich",
      "browse my photos",
      "share a photo",
      "blur a photo",
      "hide a photo",
      "make a photo album",
      "put photos in an album",
      "rotate a photo",
      "flip a photo",
      "rename my photos",
      "photo folders on disk",
      "storage template",
      "album tabs",
      "ersatztv",
      "syncthing",
      "subtitles",
      "indexers",
    ],
    where: { route: "/services", path: "Open the app (sidebar, Lair, or All services)" },
    labels: [
      "Move to another server",
      "Remove site",
      "Protect it",
      "Change password",
      "Add a user",
      "Recent photos",
      "Blur all",
      "See all photos",
      "Share a link",
      "Link works for",
      "Put in an album",
      "Select whole library",
      "Restore original",
      "Flip left to right",
      "Files and folders",
      "More albums",
      "All photos",
      "Take out of this album",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("immich.smoke.spec.ts"),
        test: "Immich panel: paste a key, see photos, storage and queues; clear failed jobs",
      },
      {
        file: E2E("immich-organize.spec.ts"),
        test: "choose photos, make an album with one approval, then undo it",
      },
      {
        file: E2E("immich-organize.spec.ts"),
        test: "flip and turn a photo with a live preview, save it, and restore the original",
      },
      {
        file: E2E("immich-files.spec.ts"),
        test: "build a pattern, preview it, approve it, and watch Immich move the files",
      },
      {
        file: E2E("immich-files.spec.ts"),
        test: "albums are tabs: make one, open it, take a photo out and undo",
      },
      {
        file: E2E("prowlarr.smoke.spec.ts"),
        test: "Prowlarr panel: failing indexer first; test it, then switch it off",
      },
      {
        file: E2E("caddy.smoke.spec.ts"),
        test: "Caddy panel: Caddy gets its own panel, with a plain reason when it cannot read",
      },
      {
        file: E2E("tinyauth.smoke.spec.ts"),
        test: "Tinyauth panel: what it does, the sites it guards, and putting one behind it",
      },
      {
        file: E2E("tinyauth.smoke.spec.ts"),
        test: "Tinyauth panel: change a password, the plan carrying only a reference to it",
      },
    ],
    ember: {
      prepare: READS("Read the app", ["app_health", "app_api"]),
      execute: APP_API_CHANGE(
        "Change it; protected systems (Caddy, VPN) need you to confirm it is you",
      ),
    },
  },
  {
    id: "storage",
    name: "Storage & Files",
    summary:
      "Drives, space, files, recent downloads, RAID and the collection PDF, on any of your PCs.",
    aliases: [
      "storage",
      "how much space",
      "disk space",
      "drives",
      "storage on another pc",
      "pc menu",
    ],
    where: { route: "/storage", path: "Storage (sidebar), or the Lair panel Storage & Files" },
    open: { panel: "storage" },
    labels: ["Storage & Files"],
    status: "working",
    evidence: [
      {
        file: E2E("storage-center.smoke.spec.ts"),
        test: "Storage & Files opens as a panel with every view, read only",
      },
    ],
    ember: {
      prepare: READS("Read drives, space and how fast each is growing", [
        "storage_overview",
        "host_disk_usage",
      ]),
    },
  },
  {
    id: "drive-health",
    name: "Drive health",
    summary: "Each drive's health verdict, temperature, errors and life used.",
    aliases: [
      "drive health",
      "smart",
      "is my drive dying",
      "drives are failing",
      "drive failing",
      "failing drive",
      "disk temperature",
      "rename a drive",
    ],
    where: { route: "/storage", path: "Storage, Drives" },
    open: { panel: "storage", tab: "drives" },
    labels: [],
    status: "working",
    statusNote: "Full drive health may need the elevated executor installed.",
    evidence: [
      {
        file: E2E("storage-center.smoke.spec.ts"),
        test: "Storage & Files opens as a panel with every view, read only",
      },
    ],
    ember: { prepare: READS("Read drive health", ["storage_overview"]) },
  },
  {
    id: "file-manager",
    name: "Files (file manager)",
    summary: "Browse your drives; rename, move, copy and new folder, each confirmed first.",
    aliases: [
      "browse files",
      "file manager",
      "move a file",
      "rename a file",
      "new folder",
      "copy files",
    ],
    where: { route: "/storage", path: "Storage, Files" },
    open: { panel: "storage", tab: "files" },
    labels: ["New folder here"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "a real folder: browsed, searched, previewed and downloaded; secrets never shown",
      },
    ],
    ember: {
      prepare: READS("Browse folders", ["files_browse"]),
      execute: PLAN_CHANGE("Rename, move or copy (never delete)"),
    },
  },
  {
    id: "file-journeys",
    name: "Recently Added and File Journeys",
    summary: "New files, and each download's path from grab to your library.",
    aliases: [
      "recently added",
      "file journeys",
      "new files",
      "where did my file go",
      "did it import",
    ],
    where: { route: "/storage", path: "Storage, Recently Added or File Journeys" },
    open: { panel: "storage", tab: "journeys" },
    labels: ["See its journey"],
    status: "working",
    evidence: [
      {
        file: E2E("storage-center.smoke.spec.ts"),
        test: "Storage & Files opens as a panel with every view, read only",
      },
    ],
  },
  {
    id: "raid",
    name: "RAID / Arrays",
    summary:
      "mdadm, ZFS, Btrfs, SnapRAID and Storage Spaces: checks, replacing drives and new arrays.",
    aliases: [
      "raid",
      "set up a raid array",
      "zfs",
      "mdadm",
      "snapraid",
      "storage spaces",
      "replace a failed drive",
      "scrub",
    ],
    where: { route: "/storage", path: "Storage, RAID / Arrays" },
    open: { panel: "storage", tab: "volumes" },
    labels: ["RAID / Arrays", "Drives Hearth could use"],
    status: "working",
    statusNote:
      "Changes need the elevated executor and your approval. Tested on virtual drives, not on your real arrays. RAID is not a backup.",
    evidence: [
      {
        file: E2E("raid.smoke.spec.ts"),
        test: "RAID / Arrays: inspect, replace a failed drive, pause a check, plan a new array",
      },
    ],
    ember: {
      prepare: READS("Read arrays, members and checks", ["storage_raid"]),
      execute: PLAN_CHANGE("Checks, replacing a member, or a new array"),
    },
  },
  {
    id: "collection-pdf",
    name: "Collection PDF",
    summary: "A printable catalog of your movies, shows, audiobooks and books.",
    aliases: [
      "collection pdf",
      "print my movies",
      "catalog",
      "list of my movies",
      "pdf of my library",
    ],
    where: { route: "/storage", path: "Storage, Collection PDF" },
    open: { panel: "storage", tab: "catalog" },
    labels: ["Collection PDF", "Make PDF"],
    status: "working",
    evidence: [
      {
        file: E2E("collection-pdf.smoke.spec.ts"),
        test: "Collection PDF: pick folders, make the PDF, open and download it",
      },
    ],
    ember: { execute: HEARTH_PLAN("Make the collection PDF") },
  },
  {
    id: "project-colors",
    name: "Project colors",
    summary:
      "A project's card on Home glows in the color you pick: red, orange, yellow, green, blue or purple.",
    aliases: [
      "project color",
      "project colour",
      "card color",
      "glowing project card",
      "color on home",
      "edit a project",
      "rename a project",
    ],
    where: { route: "/", path: "Home, a project card's pencil (or right-click), Edit project" },
    labels: ["Color on Home", "No color", "Edit name, description and color", "Edit project"],
    status: "working",
    evidence: [
      {
        file: E2E("edit-projects.spec.ts"),
        test: "Home's project cards edit: a Lair card's pencil and a War Room card's right-click",
      },
      {
        file: E2E("edit-projects.spec.ts"),
        test: "a Lair project's tab in the War Room edits on right-click",
      },
      {
        file: E2E("project-colors.spec.ts"),
        test: "a project started with a color glows in it on Home, and its color can change",
      },
      {
        file: "apps/server/src/app.test.ts",
        test: "keeps a color for the card on Home, changes it, and clears it",
      },
    ],
    ember: {
      prepare: READS("Read your projects and their colors", ["hearth_api"]),
      execute: {
        what: "Set or clear a project's color when you ask",
        tools: ["hearth_api"],
        approval: "none",
      },
    },
  },
  {
    id: "projects",
    name: "Projects",
    summary: "Your homelab projects with checklists, threads, systems and notes.",
    aliases: [
      "projects",
      "start a project",
      "mark complete",
      "make a project",
      "create a project",
      "ember make a project",
    ],
    where: { route: "/projects", path: "Projects, All projects" },
    labels: ["Start a project"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "command center: a project opens beside Ember, and closing returns to the hub",
      },
      {
        file: "apps/server/src/app.test.ts",
        test: "hearth_api: Ember uses Hearth itself (makes a project when asked), never sign-in, the vault or approvals",
      },
    ],
    ember: {
      prepare: READS("Read your projects and their tasks", ["hearth_api"]),
      execute: {
        what: "Start, rename, update or finish a project, and add or tick off its tasks, when you ask",
        tools: ["hearth_api"],
        approval: "none",
      },
    },
  },
  {
    id: "jobs",
    name: "Jobs (plans)",
    summary: "Plans of steps you review and approve once; each step checked.",
    aliases: ["plans", "jobs", "approve a plan", "approve and run", "what will it change"],
    where: { route: "/jobs", path: "Projects, Jobs" },
    labels: ["Approve and run", "Review the plan"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "a job is planned, reviewed, approved once, and carried out step by step",
      },
    ],
    ember: {
      prepare: {
        what: "Propose a plan for you to approve",
        tools: ["propose_job"],
        approval: "plan",
      },
    },
  },
  {
    id: "approvals-here",
    name: "Approvals where you are",
    summary:
      "A plan Ember proposes shows its card, with Approve and run and Decline, in the chat it was made in (also from an automatic follow-up, any AI agent); on any other page it slides in as Needs your approval. Hearth's instructions to the AI are never shown.",
    aliases: [
      "where do i approve",
      "approval card",
      "the approval card is not showing",
      "needs your approval",
      "approve in the chat",
      "approve without leaving the page",
    ],
    where: {
      route: "/ask",
      path: "In the chat under Ember's answer, or the Needs your approval panel",
    },
    labels: ["Approve and run", "Decline", "Needs your approval"],
    status: "working",
    evidence: [
      {
        file: "tests/e2e/approval-in-lair-chat.spec.ts",
        test: "an approval proposed in a chat renders in that chat, and the result follows there",
      },
      {
        file: "tests/e2e/approval-in-lair-chat.spec.ts",
        test: "on any other page, a plan waiting for you slides in with Approve and Decline",
      },
      {
        file: "apps/server/src/app.test.ts",
        test: "an automatic follow-up is hidden, and the plan it proposes belongs to the owner's chat",
      },
    ],
  },
  {
    id: "todo",
    name: "To-do",
    summary: "Issues, tasks and ideas, shared with Ember.",
    aliases: ["to-do", "todo", "add to my list", "remind me", "back burner"],
    where: { route: "/todo", path: "To-do (sidebar)" },
    labels: ["Add an item", "Mark resolved"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "the to-do list: add an item, filter it, read its history, and resolve it",
      },
    ],
    ember: {
      execute: {
        what: "Add, update or resolve items you ask about",
        tools: ["save_todo", "update_todo"],
        approval: "none",
      },
    },
  },
  {
    id: "todo-panel",
    name: "To-do in the Lair",
    summary:
      "The to-do list as a panel beside Ember and the systems: tick things off, add one, change a priority, without leaving the Lair.",
    aliases: ["to-do panel", "todo in the lair", "open my to-do list", "show the to-do list here"],
    where: { route: "/", path: "The Lair: To-do in the row of systems at the top" },
    open: { panel: "todo" },
    labels: ["To-do", "Done", "The whole list"],
    status: "working",
    evidence: [
      {
        file: E2E("todo-panel.spec.ts"),
        test: "To-do opens as a panel in the Lair: add, tick off, see it under Done",
      },
    ],
    ember: {
      execute: {
        what: "Add, update or resolve items you ask about",
        tools: ["save_todo", "update_todo"],
        approval: "none",
      },
    },
  },
  {
    id: "embers-browser",
    name: "Ember's Browser",
    summary:
      "A real browser Hearth runs for Ember: watch her work live, on websites and in your own apps' pages (signed in through Secure Vault when you allow it), with a ring where she really clicks.",
    aliases: [
      "ember's browser",
      "watch ember browse",
      "ember browsing the web",
      "browser panel",
      "ember research online",
    ],
    where: { route: "/", path: "The Lair: Ember's Browser in the row of systems at the top" },
    open: { panel: "browser" },
    labels: [
      "Ember's Browser",
      "Live",
      "Go",
      "Back",
      "Forward",
      "Reload",
      "Close the browser",
      "Take over",
      "Give it back",
      "Type into the page",
      "Open it",
      "Visible window",
      "Always allowed in a visible window",
      "Forget",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("browser.spec.ts"),
        test: "a site refuses the background browser: Ember says so, asks for a visible window, and carries on when you allow it",
      },
      {
        file: "apps/server/src/browser/manager.test.ts",
        test: "a site that refuses the background browser opens in a visible window when the owner says yes (45.19)",
      },
      {
        file: E2E("browser.spec.ts"),
        test: "stuck on a check, Ember hands you the page; you do it, give it back, and she carries on",
      },
      {
        file: "apps/server/src/browser/manager.test.ts",
        test: "hands the page to the owner for a CAPTCHA or a password, then carries on (45.18)",
      },
      {
        file: E2E("browser.spec.ts"),
        test: "you can open the browser yourself, watch frames arrive, and close it",
      },
      // Watching Ember's clicks through Show & Tell, and her captions read aloud, are tested with
      // the Premium package (its browser-show.spec.ts).
      {
        file: "apps/server/src/browser/manager.test.ts",
        test: "opens, reads, clicks, types, sends ordinary forms, refuses passwords, and cleans up",
      },
      {
        file: "apps/server/src/browser/manager.test.ts",
        test: "signs in, hides the app's secrets, needs approval for changes, and blocks other sites",
      },
      {
        file: "apps/server/src/browser/manager.test.ts",
        test: "works custom menus, dropdown lists and keys, the way a person would",
      },
      {
        file: "apps/server/src/app.test.ts",
        test: "a change held from Ember's browser: approved on its own, sent once by Hearth, read back, then shown",
      },
      {
        file: "apps/server/src/browser/staged.test.ts",
        test: "sends exactly once, only the approved one, and refuses when the app changed since",
      },
    ],
    ember: {
      prepare: READS(
        "Open websites and your apps' pages, read, click, search, fill in forms, download",
        ["browser"],
      ),
      execute: {
        what: "Change an app through its own web page (Full access, or a browser-change plan you approve)",
        tools: ["browser", "propose_job"],
        approval: "plan",
      },
    },
  },
  {
    id: "download-sources",
    name: "Where each download came from",
    summary:
      "Each torrent in qBittorrent and each SABnzbd job shows the indexer that grabbed it (\"TrackerOne · via Sonarr\"), read from Sonarr's, Radarr's, Lidarr's, Readarr's, Chaptarr's and Prowlarr's grab history; a private tracker's own address names it when no app grabbed it.",
    aliases: [
      "which indexer grabbed this",
      "which tracker",
      "where did this torrent come from",
      "indexer badge",
      "usenet indexer",
    ],
    where: { route: "/services", path: "Open qBittorrent or SABnzbd; on each torrent or job" },
    open: { app: ["qbittorrent", "sabnzbd"] },
    labels: [],
    status: "working",
    evidence: [
      {
        file: "apps/server/src/apps/grab-sources.test.ts",
        test: "matches by the download's id first, then by its name, newest record winning",
      },
      {
        file: E2E("seeding-rules.spec.ts"),
        test: "A TrackerOne rule previews, goes live, pauses a torrent, and Delete waits for an import",
      },
    ],
    needs: [
      {
        anyApp: ["qbittorrent", "sabnzbd"],
        why: "qBittorrent or SABnzbd, and Sonarr, Radarr or Prowlarr for their grab history",
      },
    ],
  },
  {
    id: "seeding-rules",
    name: "Seeding rules",
    summary:
      "Your own rules for torrents from the indexers you pick (\"TrackerOne: 3 days seeding, then remove\"): days of qBittorrent's seeding time, an optional ratio, then tell me, stop seeding, remove (files kept) or delete with files. Rules start in preview; Go live lets one act on its own (checked every 5 minutes), Stop every rule halts them all. Delete needs typed words and skips anything a media app hasn't imported or that sits in a library folder. Activity and the bell show what they did.",
    aliases: [
      "seeding rules",
      "seed time",
      "hit and run",
      "remove torrents after seeding",
      "delete after 3 days",
      "private tracker seeding",
      "trackerone",
    ],
    where: { route: "/services", path: "Open qBittorrent; tab Torrents; Seeding rules" },
    open: { app: ["qbittorrent"], tab: "torrents" },
    labels: [
      "Seeding rules",
      "Add rule",
      "Set rules",
      "Save rule",
      "Add another rule",
      "Go live",
      "Back to preview",
      "Stop every rule",
      "Check now",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("seeding-rules.spec.ts"),
        test: "A TrackerOne rule previews, goes live, pauses a torrent, and Delete waits for an import",
      },
      {
        file: "packages/core/src/seeding-rules.test.ts",
        test: "with two rules, takes the most time and the least destructive action",
      },
    ],
    needs: [
      {
        anyApp: ["qbittorrent"],
        why: "qBittorrent, with its login in the vault",
      },
    ],
  },
  {
    id: "saved-work",
    name: "The Forge",
    summary:
      "Ember's sheets beside the chat: every item, what it found and would do; you choose, then approve a plan. A pick sheet of Plex titles searches the whole library, forgiving typos (GET /api/home-rows/find), and Add puts a title in Selected. Saved ones live in the Forge Library. With more than one waiting, the arrows under a sheet's title switch to the next project in place.",
    aliases: [
      "the forge",
      "forge",
      "forge library",
      "saved work",
      "workspaces",
      "working files",
      "open it in the forge",
    ],
    where: { route: "/forge", path: "The Forge (sidebar)" },
    labels: ["The Forge", "Library", "Open now", "Notes", "Selected", "Alternatives", "Swap in"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "the Forge: a sheet waits for you, save it, close it, find it in the Forge Library, reopen it intact, edit, delete on purpose",
      },
      {
        file: E2E("forge-pick.spec.ts"),
        test: "the Forge pick layout: add, remove, swap, search, the count against the target, then send",
      },
      {
        file: E2E("forge-switch.spec.ts"),
        test: "the arrows on a Forge sheet switch to the next waiting project and back",
      },
      {
        file: "apps/server/src/apps/plex-collections.test.ts",
        test: "creates a collection with the first title, adds the next, and reads both back",
      },
    ],
  },
  {
    id: "releases",
    name: "Release watch",
    summary:
      "Every movie requested in Seerr, followed until it is in your library; overdue ones flagged.",
    aliases: [
      "releases",
      "release watch",
      "when will my movie come out",
      "overdue movie",
      "requested movie late",
    ],
    where: { route: "/releases", path: "Releases (sidebar)" },
    labels: ["Release watch", "Check now"],
    status: "working",
    evidence: [
      {
        file: E2E("releases.smoke.spec.ts"),
        test: "release watch: requested movies followed on their own, with snooze, dismiss, and date changes",
      },
    ],
    needs: [{ anyApp: ["seerr"], why: "Overseerr or Jellyseerr" }],
    ember: { prepare: READS("Read watched releases", ["release_watches"]) },
  },
  {
    id: "findings",
    name: "Findings",
    summary: "What Hearth noticed that is not yet a problem, or a pattern.",
    aliases: ["findings", "what has hearth found", "difference between a finding and an incident"],
    where: { route: "/findings", path: "Monitoring, Findings" },
    labels: ["Accept as it is"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "findings: the dashboard says what needs you and why, what works, and what Hearth can see",
      },
    ],
    ember: {
      prepare: READS("Read and investigate findings", ["list_findings", "get_finding"]),
      execute: {
        what: "Record or update a finding",
        tools: ["record_finding", "update_finding"],
        approval: "none",
      },
    },
  },
  {
    id: "incidents",
    name: "Incidents",
    summary: "Problems with a timeline and a proposed repair.",
    aliases: ["incidents", "something is down", "outage", "approve repair"],
    where: { route: "/incidents", path: "Monitoring, Incidents" },
    labels: ["Approve repair"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "practice: Ask before fixing proposes a repair and runs it once you approve",
      },
    ],
    ember: { prepare: READS("Read incidents", ["list_incidents", "get_incident"]) },
  },
  {
    id: "autonomy",
    name: "Autonomy",
    summary: "How far Hearth and the AI may go on their own: monitor, diagnose, ask, or fix.",
    aliases: [
      "autonomy",
      "fix automatically",
      "ask before fixing",
      "stop fixing things on its own",
    ],
    where: { route: "/autonomy", path: "Monitoring, Autonomy" },
    labels: ["Fix automatically", "Ask before fixing"],
    status: "working",
    evidence: [{ file: SMOKE, test: "autonomy changes save and flow through to services" }],
    ownerOnly: "Autonomy decides what Hearth and Ember may do on their own: only you change it.",
  },
  {
    id: "notifications",
    name: "Notifications",
    summary:
      "Where Hearth's messages go (Discord, email, ntfy, webhook), what goes where, quiet hours.",
    aliases: [
      "notifications",
      "connect my discord",
      "discord webhook",
      "email alerts",
      "ntfy",
      "telegram",
      "telegram alerts",
      "browser push",
      "push notifications",
      "phone notifications",
      "notification destination",
      "quiet hours",
      "add a destination",
      "change a destination",
      "switch discord to telegram",
      "switch back",
      "webhook deleted",
      "notifications stopped arriving",
      "broken destination",
    ],
    where: { route: "/notifications", path: "Monitoring, Notifications" },
    labels: [
      "Add a destination",
      "Send test",
      "Friends and family",
      "Send with",
      "Broken",
      "Fix it",
    ],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "notifications: set up a webhook, send a test, and receive a repair report",
      },
      {
        file: SMOKE,
        test: "notifications: add a friends-and-family destination; it gets only media, can be switched off and deleted",
      },
      {
        file: "tests/e2e/notify-change.spec.ts",
        test: "Change a destination: switch how it sends, test first, save once, switch back and undo",
      },
      {
        file: "tests/e2e/notify-broken.spec.ts",
        test: "a deleted webhook shows as broken, Fix opens Change, and working again clears it",
      },
    ],
    ember: {
      execute: HEARTH_PLAN(
        "Add, change, test or remove a notification destination or what it is told about",
      ),
    },
  },
  {
    id: "briefs",
    name: "Briefs and watches",
    summary:
      "A server summary on a schedule, or a word when a disk passes a level, a service stops answering or a machine goes offline, to the channels you pick. They only read and tell; a change to a system is still an approved plan.",
    aliases: [
      "scheduled brief",
      "morning summary",
      "daily summary",
      "server summary every morning",
      "send me a summary",
      "tell me if a disk is full",
      "disk space alert",
      "alert me if plex goes down",
      "automation",
      "schedule a report",
    ],
    where: {
      route: "/notifications",
      path: "Monitoring, Notifications, Briefs and watches",
    },
    labels: ["Add a brief or watch", "Send now", "Briefs and watches"],
    status: "working",
    evidence: [
      {
        file: "apps/server/src/app.test.ts",
        test: "a summary goes once on its day from its time; a disk watch tells once until it clears",
      },
      {
        file: E2E("briefs.spec.ts"),
        test: "Briefs and watches: add a morning summary, send it now, switch it off and remove it",
      },
    ],
    ember: {
      prepare: READS("Read the briefs and watches (GET /api/briefs)", ["hearth_api"]),
      execute: {
        what: "Add, change, send now or remove a brief or watch when you ask, in your words (POST, PATCH or DELETE /api/briefs); they only send messages",
        tools: ["hearth_api"],
        approval: "none",
      },
    },
  },
  {
    id: "hearth-bot",
    name: "Discord (Hearth bot, one click)",
    summary: "Add the official Hearth bot to your server and pick a channel; no token.",
    aliases: ["hearth bot", "one click discord", "add hearth to my server"],
    where: { route: "/notifications", path: "Monitoring, Notifications, Add a destination" },
    labels: ["Add Hearth to my server"],
    open: { page: "/notifications#channels" },
    status: "working",
    evidence: [
      { file: SMOKE, test: "notifications: the official Hearth bot in two clicks, no token" },
    ],
    needs: [{ fact: "hearth-bot-relay", why: "the Hearth bot's service to be online" }],
    ember: { execute: HEARTH_PLAN("Add the Hearth bot as a notification destination") },
  },
  {
    id: "discord-own-bot",
    name: "Discord (your own bot, with buttons)",
    summary: "Your own Discord bot, so invitations have I'm in and Can't make it buttons.",
    aliases: ["discord bot", "my own bot", "bot token", "rsvp buttons", "i'm in button"],
    where: { route: "/notifications", path: "Monitoring, Notifications, Add a destination" },
    open: { page: "/notifications#channels" },
    labels: ["Check it"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "notifications: your own Discord bot, set up step by step with a channel picked from a list",
      },
    ],
    ember: {
      execute: HEARTH_PLAN(
        "Add the owner's own Discord bot as a destination (its token goes in Secure Vault through Hearth's own import, never pasted to Ember)",
      ),
    },
  },
  {
    id: "more-notification-kinds",
    name: "Browser push, Gotify and Slack",
    summary: "More places to send notifications.",
    aliases: ["slack", "gotify", "browser push", "push notifications", "telegram"],
    where: { path: "Not available yet" },
    labels: [],
    status: "planned",
    statusNote: "Planned. Discord, email, ntfy and webhooks work today.",
    evidence: [],
  },
  {
    id: "media-announcements",
    name: "Media announcements (New in your library)",
    summary:
      "Posts to friends when a movie or show becomes available, and, when turned on, new music, audiobooks, ebooks, comics, games and podcasts, designed the way you like, with Ember's line on top.",
    aliases: [
      "movie announcement",
      "announce new movies",
      "announce new albums",
      "new music announcement",
      "new audiobooks",
      "new books and comics",
      "new games",
      "ember's line on announcements",
      "new in your library",
      "tell my friends a movie arrived",
      "when i add a movie",
      "tell my family",
      "media announcements",
    ],
    where: { route: "/notifications", path: "Monitoring, Notifications, Media announcements" },
    open: { page: "/notifications#media-announcements" },
    labels: [
      "What to post",
      "More from your library",
      "Customize for each destination",
      "Send a test",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("media.smoke.spec.ts"),
        test: "media announcements: design, test, and announce a new arrival to a second channel",
      },
      {
        file: E2E("library-announce.smoke.spec.ts"),
        test: "new in your library: an audiobook arrives with Ember's line, per destination",
      },
    ],
    needs: [
      MEDIA_SERVER,
      { fact: "media-destination", why: "a destination ticked for New in your library" },
    ],
    ember: { execute: HEARTH_PLAN("Turn media announcements on or off and choose where they go") },
  },
  {
    id: "movie-nights",
    name: "Movie nights",
    summary:
      "Invite friends to watch a movie from your library together, with reminders and a guest list.",
    aliases: [
      "movie night",
      "watch party",
      "invite friends to watch",
      "watch together",
      "schedule a movie",
      "rsvp",
      "invite my friends to a movie",
    ],
    where: {
      route: "/",
      path: "The Lair: Movie nights (once a media server is connected); who gets invited is set in Notifications, Media announcements",
    },
    open: { panel: "movie-nights" },
    labels: ["Plan a movie night", "Post the invitation", "Change the style", "Cancel it"],
    status: "working",
    statusNote:
      "Hearth posts and manages the invitation; it does not start the synced playback (Where to watch links to Plex, Plezy or Jellyfin).",
    evidence: [
      {
        file: E2E("media.smoke.spec.ts"),
        test: "movie nights: plan, invite, add a guest, move it, and cancel it",
      },
      {
        file: E2E("media.smoke.spec.ts"),
        test: "movie nights without a destination send you straight to the setting",
      },
      {
        file: E2E("media.smoke.spec.ts"),
        test: "plan a movie night from a movie, and keep the plan when the window changes size",
      },
    ],
    needs: [
      MEDIA_SERVER,
      {
        fact: "movie-night-destination",
        why: 'a Discord bot destination, or any destination ticked for "New in your library" under Media announcements',
      },
    ],
    ember: { execute: HEARTH_PLAN("Set up a movie night or post its invitation") },
  },
  {
    id: "vault",
    name: "Secure Vault",
    summary: "Encrypted keys and passwords; the AI never sees them.",
    aliases: [
      "vault",
      "api key",
      "where do i put my key",
      "password",
      "find my keys",
      "add a credential",
      "hearth api key",
    ],
    where: { route: "/vault", path: "Secure Vault (sidebar)" },
    labels: ["Lock now", "Add a credential", "Find my keys"],
    status: "working",
    evidence: [
      { file: E2E("auth.spec.ts"), test: "the vault keeps automation and protected secrets" },
    ],
    ember: {
      prepare: READS("See which keys exist (never their values)", ["vault_status"]),
      execute: PLAN_CHANGE("Import an app's key from its own settings into the vault"),
    },
  },
  {
    id: "docker",
    name: "Docker",
    summary: "Containers Hearth watches, by machine.",
    aliases: ["docker", "containers"],
    where: { route: "/docker", path: "Docker (sidebar)" },
    labels: [],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "command center: a service opens beside Ember with live and recorded facts",
      },
    ],
    ember: {
      prepare: READS("Read container setup (never secret values)", [
        "container_config",
        "compose_projects",
      ]),
    },
  },
  {
    id: "network",
    name: "Network",
    summary: "Machines, addresses, and which reverse proxy publishes each service.",
    aliases: ["network", "public address", "reverse proxy", "what is published"],
    where: { route: "/network", path: "Network (sidebar)" },
    labels: ["Not published"],
    status: "working",
    evidence: [{ file: SMOKE, test: "services link straight to their proxied or local address" }],
  },
  {
    id: "backups",
    name: "Backups",
    summary: "Hearth's own daily, checked backup, with an off-machine copy.",
    aliases: ["backups", "backup hearth", "keys to keep safe", "off this machine"],
    where: { route: "/backups", path: "Backups (sidebar), Settings, Backups" },
    labels: ["Off this machine", "Show the keys"],
    status: "working",
    evidence: [{ file: SMOKE, test: "a backup can be run from Settings and reports how it went" }],
    ember: { prepare: READS("Read backup status", ["backup_status"]) },
  },
  {
    id: "lab-blueprint",
    name: "Lab Blueprint",
    summary:
      "A written plan of the whole lab (apps, their compose settings with values hidden, drives, networks, install order, each app's own backups, vault entries) for rebuilding it on another machine. Once a day after 04:00 Hearth checks the lab mechanically (no AI) and, when anything changed, saves a new dated version encrypted to the owner's recovery key (age) in a folder or cloud storage they chose (S3-compatible: Backblaze B2, Cloudflare R2, Wasabi, Amazon S3, MinIO; or WebDAV such as Nextcloud; the cloud login is kept in the Secure Vault); 7 are kept. Daily versions leave out protected vault entries; Update now with the vault unlocked includes them. Import on a new machine shows what a blueprint holds before adding vault entries, then Ember reads it as a reference, not instructions (GET /api/blueprint/imported), and plans the rebuild with the owner. Ember reads the current one with GET /api/blueprint/preview and may add notes (PUT /api/blueprint/notes).",
    aliases: [
      "lab blueprint",
      "blueprint",
      "rebuild my lab",
      "disaster recovery",
      "recovery key",
      "move to a new server",
      "rebuild from scratch",
      "cloud backup",
      "backblaze",
      "s3",
      "webdav",
    ],
    where: { route: "/settings", path: "Settings, Backups, Lab Blueprint" },
    labels: [
      "Lab Blueprint",
      "Update now",
      "Test my key",
      "Import a blueprint",
      "Change where or key",
      "A folder",
      "Cloud storage",
      "Save recovery sheet",
      "See what it says",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("blueprint.spec.ts"),
        test: "The Lab Blueprint is set up with its key typed back, tests the key, and an import shows what it holds first",
      },
      {
        file: "apps/server/src/blueprint/blueprint.test.ts",
        test: "refuses a note holding a vault value, and goes stale after two days without a good check",
      },
      {
        file: E2E("blueprint.spec.ts"),
        test: "The Lab Blueprint can be saved to cloud storage, with its login kept in the vault",
      },
    ],
    ownerOnly:
      "Where the blueprint is saved (folder or cloud), its recovery key, Update now and import are yours alone, after confirming it's you: the key opens everything in it. Ember reads the blueprint and writes notes.",
    ember: {
      prepare: READS(
        "Read the Lab Blueprint (GET /api/blueprint/preview, /api/blueprint/imported)",
        ["hearth_api"],
      ),
    },
  },
  {
    id: "activity",
    name: "Changes and activity",
    summary: "Every change by you, Hearth or the AI, and what monitoring noticed.",
    aliases: ["audit log", "what changed", "activity", "history of changes"],
    where: { route: "/logs", path: "Logs, Changes and activity" },
    labels: ["Changes and activity"],
    status: "working",
    evidence: [{ file: SMOKE, test: "Ember shows the steps it actually took to answer" }],
    ember: { prepare: READS("Read recent changes", ["recent_changes"]) },
  },
  {
    id: "memory",
    name: "Memory",
    summary: "What Hearth remembers about your homelab: threads, journal, wins, how you work.",
    aliases: ["memory", "what do you remember", "remember something", "forget", "saved sessions"],
    where: { route: "/memory", path: "Logs, Memory" },
    labels: ["Remember something"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "remember something, change it, find it, and get it back after deleting it",
      },
    ],
    ember: { prepare: READS("Search memories and past conversations", ["recall"]) },
  },
  {
    id: "integrations",
    name: "Integrations",
    summary: "Which apps Hearth understands beyond whether they are running.",
    aliases: ["integrations", "supported apps", "which apps does hearth support"],
    where: { route: "/integrations", path: "Logs, Integrations" },
    labels: [],
    status: "working",
    evidence: [{ file: SMOKE, test: "a service page shows what Hearth read inside the app" }],
  },
  {
    id: "settings-general",
    name: "Settings, General",
    summary: "This PC, your name and picture, time zone, theme, setup and support.",
    aliases: [
      "theme",
      "change colors",
      "dark mode",
      "time zone",
      "my picture",
      "rename this pc",
      "support hearth",
    ],
    where: { route: "/settings#general", path: "Settings, General" },
    labels: ["Theme"],
    status: "working",
    evidence: [
      {
        file: SMOKE,
        test: "themes: four built in or your own two colors, applied everywhere and kept after a reload",
      },
    ],
    ember: { execute: HEARTH_PLAN("Change a general setting (the AI's name, theme, time format)") },
  },
  {
    id: "panel-looks",
    name: "Service panel looks",
    summary:
      "How service panels look: Minimal (plain, the default), Service branding (each service's own colors and artwork with Hearth's controls), or Hearth branding.",
    aliases: [
      "panel branding",
      "service branding",
      "panel artwork",
      "prowlarr colors",
      "make panels plain",
    ],
    where: { route: "/settings#general", path: "Settings, General, Themes, Service panels" },
    labels: ["Service panels", "Minimal", "Service branding", "Hearth branding"],
    status: "partial",
    statusNote:
      "Every service panel has a look: Sonarr, Radarr, Overseerr and qBittorrent from the owner's paintings, every other service automatically (Hearth's frame lit in its own color, with its logo). A service Hearth has no logo for gets Hearth's orange.",
    evidence: [
      {
        file: E2E("panel-branding.spec.ts"),
        test: "service panel looks: each service in its own colors, Hearth's, or plain; kept after a reload",
      },
    ],
    ember: { execute: HEARTH_PLAN("Change how service panels look") },
  },
  {
    id: "security",
    name: "Security settings",
    summary:
      "Passkeys, password, signed-in devices, recovery key, and access keys for other software.",
    aliases: [
      "passkey",
      "change password",
      "recovery key",
      "sign out everywhere",
      "access key",
      "forgot password",
    ],
    where: { route: "/settings#security", path: "Settings, Security" },
    labels: ["Make a new recovery key", "Sign out on every device"],
    status: "working",
    evidence: [
      {
        file: E2E("auth.spec.ts"),
        test: "the recovery key resets a forgotten password and keeps the secrets",
      },
      { file: SMOKE, test: "create an access key for Home Assistant, shown once, then revoke it" },
    ],
    ownerOnly: "Sign-in, passkeys and the recovery key are yours alone.",
  },
  {
    id: "homelab-rules",
    name: "Homelab rules",
    summary:
      "Systems the AI may never touch, times a machine is reserved for you, and your own rules for Ember in your words.",
    aliases: [
      "do not touch",
      "homelab rules",
      "reserved times",
      "keep the ai away from",
      "your own rules",
      "my rules for ember",
    ],
    where: { route: "/settings#cave", path: "Settings, Ember, Homelab rules" },
    labels: ["Homelab rules", "Your own rules"],
    status: "working",
    evidence: [
      {
        file: E2E("rules.spec.ts"),
        test: "homelab rules: a do-not-touch system and a reserved time are added and removed in Settings",
      },
      {
        file: E2E("zones.spec.ts"),
        test: "your own rules for Ember are saved in Settings > Ember > Homelab rules",
      },
    ],
    ember: { execute: HEARTH_PLAN("Add or change the owner's homelab rules for Ember") },
  },
  {
    id: "monitoring-settings",
    name: "Monitoring settings",
    summary: "How often services are checked, when an incident opens, and resource history.",
    aliases: ["check interval", "resource history", "how often does hearth check"],
    where: { route: "/settings#monitoring", path: "Settings, Monitoring" },
    labels: ["Resource history"],
    status: "working",
    evidence: [{ file: SMOKE, test: "monitoring can be tuned in Settings" }],
    ember: {
      execute: HEARTH_PLAN("Change monitoring settings (check intervals, resource history)"),
    },
  },
  {
    id: "updates",
    name: "Updates",
    summary:
      "A new Hearth on your release channel (stable, the default, or fast) is offered; you update when you are ready.",
    aliases: [
      "update hearth",
      "new version",
      "update now",
      "what version",
      "release channel",
      "stable channel",
      "fast channel",
      "beta",
    ],
    where: { route: "/settings#about", path: "Update Hearth in the top bar, or Settings, About" },
    labels: ["Update now", "Release channel"],
    status: "working",
    evidence: [
      {
        file: "apps/server/src/updates/service.test.ts",
        test: "follows the chosen channel, says which, and Update now pins that version",
      },
      {
        file: E2E("updates.spec.ts"),
        test: "a new Hearth: Update in the top bar, on the bell, and in Settings; Update now",
      },
    ],
    ownerOnly: "You choose when Hearth updates; installing an update is yours.",
  },
  {
    id: "pcs-and-devices",
    name: "More than one PC, phones and the app",
    summary:
      "One account across your PCs; phones and tablets sign in with a QR code. Linking another Hearth installation and working on it through this one is Hearth Connected (Premium package; its tests live in the Premium repo).",
    aliases: [
      "add another computer",
      "add a pc",
      "link another hearth",
      "link to my hearth",
      "join a pc",
      "join another hearth",
      "copy layout",
      "same layout as my other pc",
      "copy homeserver's layout",
      "link an existing install",
      "phone",
      "qr code",
      "android app",
      "tablet",
      "add a device",
    ],
    where: { route: "/settings#devices", path: "Settings, PCs and devices" },
    labels: [
      "Add a device",
      "Link to my Hearth",
      "Join another Hearth",
      "Copy another Hearth's layout",
    ],
    status: "working",
    evidence: [
      {
        file: E2E("devices.spec.ts"),
        test: "Add a device: a code signs another browser in once; removing it signs it out",
      },
    ],
    ownerOnly: "Pairing a PC or device needs you there, with the pairing code.",
  },
  {
    id: "premium",
    name: "Hearth Premium",
    summary:
      "Hearth is free for your homelab with no limits. The extras are Premium: Hearth Connected (linking two or more Hearth installations and working on one through another), Ember Show & Tell (Ember pointing at what she works on, on screen) and Panel Builder (Ember building a custom panel for an app with you). All of Curator is free. Settings, Premium has Upgrade to Premium: sponsor Dragon's Oath on GitHub Sponsors (Supporter $5 a month, Founder $99 once; opens with the public launch) or enter a code (bought, gifted or a promotion) at any time on a Hearth already in use. It shows what this Hearth has, adds a licence key (checked offline, made for one installation), and on the owner's issuing Hearth grants complimentary Premium and makes promo codes. Hearth never asks for card details.",
    aliases: [
      "premium",
      "licence",
      "license key",
      "promo code",
      "redeem a code",
      "upgrade",
      "upgrade to premium",
      "gift code",
      "sponsor",
      "hearth connected",
      "is it free",
      "what costs money",
      "complimentary",
      "subscription",
    ],
    where: { route: "/settings#premium", path: "Settings, Premium" },
    labels: ["Redeem a code", "Add a licence key", "Grant Premium", "Make a promo code"],
    status: "working",
    evidence: [
      {
        file: E2E("premium.spec.ts"),
        test: "Premium: access, a code shown once, revoke with a confirmation, locked states, redeem",
      },
    ],
    ownerOnly:
      "Redeeming a code, adding a licence key, and (on the issuing Hearth) granting, revoking and making codes are yours. Ember explains Premium but never grants or buys it.",
  },
  {
    id: "memory-usage",
    name: "When Hearth uses a lot of memory",
    summary: "What uses memory (the voice program, the window, AI sessions) and how to free it.",
    aliases: [
      "memory is high",
      "using too much ram",
      "free up memory",
      "reset ram",
      "why is memory so high",
    ],
    where: { path: "War Room, Free up voice memory; or Ctrl+R in the Hearth window" },
    labels: ["Free up voice memory"],
    status: "working",
    evidence: [{ file: SMOKE, test: "the War Room frees the Standard voice's memory on request" }],
    ember: {
      execute: HEARTH_PLAN(
        "Free memory: one plan with stop-container and free-memory steps (GET /api/machine/memory first)",
      ),
    },
  },
  {
    id: "safety",
    name: "How Hearth keeps you safe",
    summary:
      "Plans you approve, autonomy limits, protected systems, the vault and the elevated executor.",
    aliases: [
      "is it safe",
      "can the ai break things",
      "protected systems",
      "sudo",
      "security model",
    ],
    where: { path: "Across Hearth; see Autonomy, Homelab rules and the Secure Vault" },
    labels: [],
    status: "working",
    evidence: [{ file: WAR, test: "risky words wait for approval, then run" }],
  },
];

export function featureById(id: string): Feature | undefined {
  return FEATURES.find((f) => f.id === id);
}

/* ---------- Opening a feature for the owner (checklist 42.2) ---------- */

/**
 * Where "Open it for me" goes, or nothing when there is nowhere to go: a feature that is not
 * built or not available to owners yet, or one with no page of its own. The general "/services"
 * list is not a place for one app's feature; those name their app instead.
 */
export function featureOpen(f: Feature): FeatureOpen | undefined {
  if (f.status === "planned" || f.status === "preview") return undefined;
  if (f.open) return f.open;
  const route = f.where.route;
  return route && route !== "/services" ? { page: route } : undefined;
}

/** The reference that names a feature in the AI's activity and evidence ("feature:raid"). */
export const featureRef = (id: string) => `feature:${id}`;

/** The feature a reference names, when it is one ("feature:raid"). */
export function featureOfRef(ref?: string): Feature | undefined {
  return ref?.startsWith("feature:") ? featureById(ref.slice("feature:".length)) : undefined;
}

/**
 * The features that belong to one page (its route, plus the #section or Settings tab), for the
 * page's own "How this works" help. A page without a section shows its page-wide features first.
 */
export function featuresOnPage(pathname: string, hash = ""): Feature[] {
  const page = pathname.replace(/\/+$/, "") || "/";
  const section = hash.replace(/^#/, "");
  const on = FEATURES.filter((f) => {
    if (f.status === "planned") return false;
    const o = featureOpen(f);
    const target = o && "page" in o ? o.page : f.where.route;
    if (!target) return false;
    const [p, s = ""] = target.split("#");
    if ((p || "/") !== page) return false;
    // Settings shows one tab at a time: only that tab's features (General when there is none).
    if (page === "/settings") return s === (section || "general");
    return true;
  });
  return on.sort(
    (a, b) => Number(a.where.route?.includes("#")) - Number(b.where.route?.includes("#")),
  );
}

/** The features of the Storage & Files panel: the panel's own first, then the open tab's. */
export function featuresOnStorage(tab?: string): Feature[] {
  const of = (f: Feature) => featureOpen(f);
  const all = FEATURES.filter((f) => {
    const o = of(f);
    return o !== undefined && "panel" in o && o.panel === "storage";
  });
  return all.filter((f) => {
    const o = of(f) as { panel: "storage"; tab?: string };
    return !o.tab || o.tab === (tab ?? "overview");
  });
}

/** The features shown on one app's panel. */
export function featuresOfApp(app: AppKind): Feature[] {
  return FEATURES.filter((f) => {
    const o = featureOpen(f);
    return o !== undefined && "app" in o && o.app.includes(app);
  });
}

/* ---------- Finding the feature a question is about ---------- */

const STOP = new Set(
  "a an the i my me to do does did how can could would should is are be of in on for with and or it this that what where which who why you your hearth ember please there get set up make use".split(
    " ",
  ),
);

/** Lower case words, apostrophes dropped, a plural s trimmed, filler words left out. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^a-z0-9/]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

export interface FeatureMatch {
  feature: Feature;
  score: number;
}

/**
 * The features a question is most likely about, best first. A whole alias inside the question
 * counts most; then shared words with the aliases, the name, the labels and the summary.
 */
export function findFeatures(question: string, limit = 3): FeatureMatch[] {
  const q = ` ${question
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9/]+/g, " ")} `;
  const qw = new Set(words(question));
  const scored = FEATURES.map((feature) => {
    let score = 0;
    for (const a of feature.aliases) {
      const phrase = a
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9/]+/g, " ")
        .trim();
      if (q.includes(` ${phrase} `)) score += 6 + 3 * phrase.split(" ").length;
    }
    const field = (texts: string[], weight: number) => {
      const fw = new Set(texts.flatMap(words));
      for (const w of qw) if (fw.has(w)) score += weight;
    };
    field(feature.aliases, 3);
    field([feature.name], 3);
    field(feature.labels, 2);
    field([feature.summary], 1);
    return { feature, score };
  });
  return scored
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** A match good enough to answer from, rather than a guess. */
export const CONFIDENT_SCORE = 9;

/* ---------- Is it available on this installation? ---------- */

export interface InstallFacts {
  /** The apps this installation watches. */
  apps: AppKind[];
  facts: Partial<Record<FeatureFact, boolean>>;
}

export interface FeatureAvailability {
  /** ready: what it needs is here. needs-setup: something is missing. unknown: could not tell. */
  state: "ready" | "needs-setup" | "unknown" | "not-built";
  missing: string[];
}

export function featureAvailability(f: Feature, here?: InstallFacts): FeatureAvailability {
  if (f.status === "planned") return { state: "not-built", missing: [] };
  if (!here) return { state: "unknown", missing: [] };
  const missing: string[] = [];
  let unknown = false;
  for (const n of f.needs ?? []) {
    if ("anyApp" in n) {
      if (!n.anyApp.some((a) => here.apps.includes(a))) missing.push(n.why);
    } else {
      const v = here.facts[n.fact];
      if (v === undefined) unknown = true;
      else if (!v) missing.push(n.why);
    }
  }
  if (missing.length) return { state: "needs-setup", missing };
  return { state: unknown ? "unknown" : "ready", missing };
}

/* ---------- The manual section a feature points to ---------- */

/**
 * The parts of the manual tagged for a feature: `<!-- feature: id -->` on the line before a
 * heading (the section up to the next heading of the same or a higher level) or before a list
 * item (that item and the lines indented under it). One tag may name several features, and a
 * feature may be tagged in more than one place; the parts are joined in order.
 */
export function manualSection(manual: string, id: string): string | undefined {
  const lines = manual.split("\n");
  const isTag = (l: string) => /^\s*<!--\s*feature:/.test(l);
  const parts: string[] = [];
  lines.forEach((l, at) => {
    const m = /^\s*<!--\s*feature:\s*([^>]*?)\s*-->\s*$/.exec(l);
    if (!m || !m[1]!.split(/\s+/).includes(id)) return;
    const first = lines.slice(at + 1).findIndex((x) => x.trim() !== "" && !isTag(x));
    if (first < 0) return;
    const start = at + 1 + first;
    const head = lines[start]!;
    const out = [head];
    const level = /^(#+)\s/.exec(head)?.[1]!.length;
    if (level) {
      for (const x of lines.slice(start + 1)) {
        const h = /^(#+)\s/.exec(x);
        if (h && h[1]!.length <= level) break;
        if (!isTag(x)) out.push(x);
      }
    } else {
      const indent = /^\s*/.exec(head)![0].length;
      for (const x of lines.slice(start + 1)) {
        if (x.trim() === "" || isTag(x)) break;
        if (/^\s*/.exec(x)![0].length <= indent) break;
        out.push(x);
      }
    }
    parts.push(
      out
        .join("\n")
        .replace(/\n+---\s*$/, "")
        .trim(),
    );
  });
  return parts.length ? parts.join("\n\n") : undefined;
}

/** The feature ids tagged in the manual, each as often as it is tagged. */
export function manualTags(manual: string): string[] {
  return [...manual.matchAll(/^\s*<!--\s*feature:\s*([^>]*?)\s*-->\s*$/gm)].flatMap((m) =>
    m[1]!.split(/\s+/).filter(Boolean),
  );
}
