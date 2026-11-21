import { trend } from "@dragon-control/core";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { newSigningKey, signLicense } from "./premium/license";
import { readInstallIdentity } from "./db/meta";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppDashboard, SeerrDashboard } from "@dragon-control/core";
import type {
  HostScan,
  GettingStarted,
  TodoDetail,
  TodoItem,
  Finding,
  DashboardBriefing,
  CaveAttachment,
  WorkspaceSummary,
  WorkspaceView,
  AuditRecord,
  BackupRecord,
  CompanionBriefing,
  BackupStatus,
  DiscoveryReport,
  AiUsageReport,
  CaveAnswerMeta,
  CaveMessage,
  ImportDraft,
  ImportSummary,
  JurisdictionEntry,
  MemoryEntry,
  MemoryProject,
  MemoryRevision,
  MemorySearchHit,
  Transcript,
  TranscriptMessage,
  FolderListing,
  HealthReport,
  ItemProperties,
  Workspace,
  Job,
  ProjectDetail,
  ProjectSummary,
  ProjectTask,
  ServiceRuntime,
  ActionKind,
  AppDiagnostics,
  CredentialStatus,
  AgentCheck,
  AgentConnectionTest,
  AgentSetupInfo,
} from "@dragon-control/core";
import { buildApp } from "./app";
import { redactTranscript } from "./memory/redact";
import { getSetting, setSetting } from "./store/settings";
import {
  AI_AVATAR_PATH,
  EMBER_LOOKS,
  EMBER_PERSONAS,
  lookPersonaInstruction,
  personaReminder,
} from "@dragon-control/core";
import { HearthSelf } from "./agent/hearth-self";
import { fakeHostScan } from "./plan/scan";
import { fakeArrV1 } from "./apps/fake-arr-v1";
import { SERVER_ROOT } from "./config";
import { openDatabase, runMigrations, type DbHandle } from "./db/client";
import { ensureInstallIdentity } from "./db/meta";
import { ensureInitialEnvironment, seedDemo } from "./demo/seed";
import { fakeProbes } from "./discovery/fake";
import { fakeContainerTools, fakeMonitorProbes, fakeOutages } from "./monitor/fake";
import { RestartLog } from "./monitor/restarts";
import { ActionRunner } from "./actions/service";
import { fromStats, publishedPorts } from "./actions/tools";
import { expireApprovals } from "./actions/approval";
import { Jobs } from "./jobs/engine";
import { AppWatcher } from "./apps/service";
import { AppOperations } from "./apps/operations";
import { CredentialBroker } from "./credentials/broker";
import { MediaLibrary } from "./apps/media-library";
import type { Fetch } from "./apps/prowlarr";
import { toQueueItem } from "./apps/arr-live";
import { keyImportOperations } from "./credentials/import-step";
import { runnerOperations } from "./jobs/operations";
import { StagedChanges, browserChangeOperations } from "./browser/staged";
import { memoryKeyGuard } from "./auth/keyguard";
import { Auth } from "./auth/service";
import { Engine } from "./engine/service";
import { fakeOllamaFetch, ollamaIsLocalOnly } from "./engine/ollama";
import WebSocket from "ws";
import { Vault } from "./auth/vault";
import { Notifier } from "./notify/notifier";
import { Watches } from "./watches/engine";
import { MovieReleases } from "./watches/movie-release";
import { fakeMedia, type FakeMedia } from "./watches/fake-media";
import { FAKE_TASTERR_LOGIN, fakeTasterr } from "./apps/fake-tasterr";
import type { AddressInfo } from "node:net";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessKeys } from "./auth/tokens";
import { Workspaces, submissionMessage } from "./workspaces/service";
import { Attachments } from "./cave/attachments";
import { WorkspacePlans, type WorkspacePlanInput } from "./workspaces/plans";
import { fakeClaudeSignIn, TEST_SIGN_IN_CODE } from "./agent/claude-signin";
import { Agents, CAVE_SYSTEM } from "./agent/service";
import { LairRemotes } from "./agent/lair-remote";
import { Terminals } from "./engine/terminal";
import { fakeWyoming } from "./voice/fake-wyoming";
import { CAVE_RULES } from "./cave/personality";
import type { VoiceStatus } from "@dragon-control/core";
import {
  claudeCodeArgs,
  type AgentProvider,
  type AgentRun,
  type AgentUsage,
  type AgentReply,
} from "./agent/providers";
import { simulate } from "./monitor/simulation";
import { PROVIDERS, type Message, type Provider } from "./notify/providers";
import { PUBLIC_ROUTES } from "./auth/routes";
import { resetOwner } from "./auth/reset";
import { Memory } from "./memory/service";
import { Backups, verify as verifyBackup } from "./backup/service";
import { backupKey, decryptFile, sha256File } from "./backup/crypto";
import {
  actions as actionsTable,
  apiTokens as apiTokensTable,
  incidentTimeline as timelineTable,
  notificationLog as notificationLogTable,
  sessions as sessionsTable,
  settings as settingsTable,
  vaultSecrets as vaultSecretsTable,
  volumes as volumesTable,
  memoryImportDrafts as draftsTable,
  hosts as hostsTable,
  volumeUsageDaily,
} from "./db/schema";
import { eq, sql } from "drizzle-orm";

const migrationsDir = path.join(SERVER_ROOT, "drizzle");
const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  // Last in, first out: close apps and databases before deleting their folders.
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Actions wired to the fake homelab, with no waiting between verification checks. */
function testRunner(handle: DbHandle) {
  const runner = new ActionRunner(handle, {
    probes: fakeMonitorProbes,
    containers: fakeContainerTools,
    verify: { intervalMs: 0, attempts: 2 },
    demoRestartMs: 0,
  });
  runner.memory = new Memory(handle);
  // Background repairs finish before the database closes.
  cleanup.push(() => runner.idle());
  return runner;
}

/** The memory (shared with the runner) and backups into a temporary folder. */
function testMemory(handle: DbHandle, runner: ActionRunner, clock?: () => Date) {
  const memory = runner.memory!;
  const dir = tempDir();
  const backups = new Backups(handle, memory, {
    dir: path.join(dir, "backups"),
    copyDir: path.join(dir, "second-copy"),
    keep: 3,
    keyDir: path.join(dir, "key"),
    clock,
    offsite: { name: "Home Vault" },
  });
  return { memory, backups, backupRoot: dir };
}

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freshDb(file = ":memory:") {
  const handle = openDatabase(file);
  cleanup.push(() => {
    try {
      handle.close();
    } catch {
      // Already closed by the test.
    }
  });
  await runMigrations(handle, migrationsDir);
  return handle;
}

export const TEST_PASSWORD = "correct horse battery staple";
const EMAIL = {
  to: "owner@example.com",
  from: "dc@example.com",
  host: "smtp.example.com",
  port: "587",
  username: "dc@example.com",
  password: "smtp-password-123",
};

/** Messages "sent" by tests, by channel. Real providers still validate settings. */
const outbox: { channel: string; message: Message }[] = [];
let failing = new Set<string>();
let testClock = () => new Date("2026-10-07T12:00:00"); // a Wednesday afternoon
function fakeProvider(kind: keyof typeof PROVIDERS): Provider {
  return {
    validate: PROVIDERS[kind].validate,
    describe: PROVIDERS[kind].describe,
    async send(message) {
      if (failing.has(kind)) throw new Error(`${kind} is unreachable`);
      outbox.push({ channel: kind, message });
    },
  };
}
/** A stand-in Telegram for setting up the Telegram channel (who wrote to the bot, if anyone). */
let telegramUpdates: unknown[] = [];
const telegramStandIn = async (url: string, _init?: RequestInit) => {
  const method = url.split("/").pop();
  const body =
    method === "getMe"
      ? { ok: true, result: { username: "lab_alerts_bot" } }
      : method === "getUpdates"
        ? { ok: true, result: telegramUpdates }
        : { ok: true, result: {} };
  return new Response(JSON.stringify(body), { status: 200 });
};
const testProviders = {
  email: fakeProvider("email"),
  discord: fakeProvider("discord"),
  "discord-bot": fakeProvider("discord-bot"),
  "hearth-bot": fakeProvider("hearth-bot"),
  ntfy: fakeProvider("ntfy"),
  push: fakeProvider("push"),
  telegram: fakeProvider("telegram"),
  webhook: fakeProvider("webhook"),
};
afterEach(() => {
  telegramUpdates = [];
  outbox.length = 0;
  failing = new Set();
  testClock = () => new Date("2026-10-07T12:00:00");
});

/** One automation key per test run, like one machine. */
const keyGuard = memoryKeyGuard();

/** Sign-in and vault with fast key derivation, so tests stay quick. */
/**
 * A scripted stand-in for Claude Code. It talks to Hearth's real
 * MCP endpoint over HTTP with the session key it is given, exactly as the
 * real agent would; `agentScript` decides which tools it calls and what it says.
 */
type AgentScript = (tools: {
  call: (name: string, args?: Record<string, unknown>) => Promise<string>;
  list: () => Promise<string[]>;
  /** The tools marked to load up front, never behind Claude Code's tool search. */
  alwaysLoaded: () => Promise<string[]>;
  prompt: string;
}) => Promise<string>;
let agentScript: AgentScript = async () => "Everything looks fine.";
const agentPrompts: string[] = [];
/** The limits Hearth set on each run, and the system instructions it gave. */
const agentRuns: Pick<AgentRun, "limits" | "system" | "full" | "lookOnly" | "lean">[] = [];
/** What the next runs report spending (tokens and cost), like Claude Code does. */
let agentSpend: Partial<AgentReply> & { usage?: AgentUsage } = {};
const fakeAgent: AgentProvider = {
  id: "claude-code",
  async check() {
    return { ok: true, detail: "Claude Code (test stand-in)." };
  },
  async run(task) {
    agentPrompts.push(task.prompt);
    agentRuns.push({
      limits: task.limits,
      system: task.system,
      full: task.full,
      lookOnly: task.lookOnly,
      lean: task.lean,
    });
    const client = new McpClient({ name: "test-agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(task.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${task.key}` } },
      }),
    );
    try {
      // Image parts show as a marker with their type and size, so tests can see an image arrived.
      const textOf = (r: unknown) =>
        (
          (r as { content?: { type?: string; text?: string; data?: string; mimeType?: string }[] })
            .content ?? []
        )
          .map((c) =>
            c.type === "image" ? `[image ${c.mimeType} ${c.data?.length ?? 0}]` : (c.text ?? ""),
          )
          .join("");
      const result = await agentScript({
        prompt: task.prompt,
        call: async (name, args = {}) => textOf(await client.callTool({ name, arguments: args })),
        list: async () => (await client.listTools()).tools.map((t) => t.name),
        alwaysLoaded: async () =>
          (await client.listTools()).tools
            .filter((t) => t._meta?.["anthropic/alwaysLoad"] === true)
            .map((t) => t.name),
      });
      return { text: result, durationMs: 5, ...agentSpend };
    } finally {
      await client.close();
    }
  },
};
afterEach(() => {
  agentScript = async () => "Everything looks fine.";
  agentPrompts.length = 0;
  agentRuns.length = 0;
  agentSpend = {};
});

function testAgents(handle: DbHandle, runner: ActionRunner, port: () => number) {
  const keys = new AccessKeys(handle);
  const agents = new Agents(handle, runner, keys, {
    claudeSignIn: fakeClaudeSignIn(),
    providers: { "claude-code": fakeAgent },
    mcpUrl: () => `http://127.0.0.1:${port()}/api/mcp`,
    probes: fakeMonitorProbes,
    demo: true,
  });
  cleanup.push(() => agents.idle());
  return { keys, agents };
}

function testAuth(handle: DbHandle) {
  const auth = new Auth(handle, { keyGuard, kdfCost: 1024 });
  const vault = new Vault(handle, auth);
  // Channels deliver to an in-memory outbox unless a test swaps a provider.
  const notifier = new Notifier(handle, vault, {
    providers: testProviders,
    localTime: () => testClock(),
    telegramFetch: (url, init) => telegramStandIn(String(url), init),
  });
  cleanup.push(() => notifier.idle());
  return { auth, vault, notifier };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type Caller = (
  method: Method,
  url: string,
  payload?: unknown,
) => Promise<{ statusCode: number; json: <T>() => T }>;

/** Approves the proposal as the app shows it: the decision carries the proposal's fingerprint. */
async function approve(call: Caller, decisionUrl: string) {
  const id = decodeURIComponent(decisionUrl.split("/")[3]!);
  const ws = (await call("GET", "/api/workspace")).json<Workspace>();
  const fingerprint = ws.incidents.find((i) => i.id === id)?.approval?.fingerprint;
  return call("POST", decisionUrl, { decision: "approve", fingerprint });
}

/** A stand-in for apps' own APIs (M9): what each path answers, or a refusal. Tests never reach the network. */
const fakeAppApi: { data: Record<string, unknown>; status: number; calls: string[] } = {
  data: {},
  status: 200,
  calls: [],
};
const fakeAppFetch: Fetch = async (url) => {
  fakeAppApi.calls.push(url);
  return {
    ok: fakeAppApi.status < 400,
    status: fakeAppApi.status,
    json: async () => fakeAppApi.data[new URL(url).pathname],
  };
};

/** A licence signing key only these tests trust (never a production key). */
const TEST_SIGNER = newSigningKey();
const TEST_TRUST = { [TEST_SIGNER.keyId]: TEST_SIGNER.publicKey };

/** Gives an app's installation a Premium licence (both features, for good, unless told). */
/** Whether this Hearth's licence gives a Premium feature now (Settings, Premium). */
async function active(
  app: { call: (method: "GET", url: string) => Promise<{ json<T>(): T }> },
  feature: string,
): Promise<boolean> {
  const st = (await app.call("GET", "/api/premium")).json<{
    features: { feature: string; state: string }[];
  }>();
  return st.features.find((f) => f.feature === feature)?.state === "active";
}

async function givePremium(
  handle: DbHandle,
  opts: {
    features?: ("hearth_interconnectivity" | "ember_show_and_tell" | "panel_builder")[];
    end?: string;
    id?: string;
  } = {},
) {
  const install = (await readInstallIdentity(handle.db))!.installId;
  const token = signLicense(
    {
      id: opts.id ?? `test-${install.slice(0, 8)}`,
      install,
      features: opts.features ?? ["hearth_interconnectivity", "ember_show_and_tell"],
      kind: "complimentary",
      start: new Date(Date.now() - 60_000).toISOString(),
      ...(opts.end ? { end: opts.end } : {}),
      issued: new Date().toISOString(),
    },
    TEST_SIGNER.privatePem,
  );
  await setSetting(handle.db, "premium", { licenses: [token], revoked: [] });
  return token;
}

/**
 * The built Premium package (Hearth Connected, Panel Builder...), when the Premium repo runs these
 * tests with it. Tests of a Premium feature run only then; without it, the core is tested alone.
 */
const PREMIUM_PACKAGE = process.env.DC_TEST_ADDONS_DIR;
const withPremiumPackage = PREMIUM_PACKAGE ? it : it.skip;

async function makeApp(
  opts: {
    handle?: DbHandle;
    scenario?: "calm" | "attention" | "fresh";
    demo?: boolean;
    /** false: leave the installation unclaimed and send requests without a session. */
    signedIn?: boolean;
    /** Listen on a real port, so an agent can reach the MCP endpoint. */
    listen?: boolean;
    /** The War Room's engine (Claude Code stand-in), for a PC that joins another Hearth. */
    engine?: (handle: DbHandle, auth: Auth, dir: string) => Engine;
    /** The backups' clock (to test the daily schedule). */
    clock?: () => Date;
    /** A stand-in Seerr and Radarr for release watch (watches/fake-media.ts). */
    media?: FakeMedia;
    /** Where held browser changes are sent (a stand-in app). */
    stagedFetch?: typeof fetch;
    /** This installation has Hearth Premium (a test licence). */
    premium?: boolean;
    /** The apps' network instead of the plain stand-in (one app's own stand-in). */
    appFetch?: Fetch;
    /** Where add-ons are installed (the Premium package). */
    addonsDir?: string;
  } = {},
) {
  const handle = opts.handle ?? (await freshDb());
  await ensureInstallIdentity(handle.db);
  if (opts.premium) await givePremium(handle);
  if (opts.scenario) await seedDemo(handle, opts.scenario);
  const runner = testRunner(handle);
  const { auth, vault, notifier } = testAuth(handle);
  let port = 0;
  const { keys, agents } = testAgents(handle, runner, () => port);
  const { memory, backups, backupRoot } = testMemory(handle, runner, opts.clock);
  // The stand-in Seerr and Radarr (ports 5055 and 7878) answer for the Seerr dashboard too.
  const media = opts.media;
  const apps = new AppWatcher(
    handle,
    vault,
    opts.appFetch ??
      (media
        ? (url, init) =>
            /:(5055|7878)\//.test(url) ? media.fetch(url, init) : fakeAppFetch(url, init)
        : fakeAppFetch),
  );
  const hearthSelf = new HearthSelf();
  const staged = new StagedChanges({ fetch: opts.stagedFetch });
  const jobs = new Jobs(
    handle,
    runnerOperations(
      handle,
      runner,
      undefined,
      undefined,
      keyImportOperations(handle, vault, runner.containerTools, apps),
      undefined,
      undefined,
      undefined,
      hearthSelf,
      undefined,
      browserChangeOperations(handle, staged),
    ),
  );
  agents.onReply = (id) => void notifier.announceReply(id);
  runner.onChange = () => {
    notifier.kick();
    agents.kick();
  };
  const app = await buildApp({
    handle,
    premiumKeys: TEST_TRUST,
    config: {
      webDir: tempDir(),
      mode: "test",
      demo: opts.demo ?? true,
      keyDir: path.join(backupRoot, "key"),
      // The Premium package, when its repo runs these tests with it (npm run test:core there).
      ...((opts.addonsDir ?? PREMIUM_PACKAGE)
        ? { addonsDir: opts.addonsDir ?? PREMIUM_PACKAGE }
        : {}),
    },
    probes: fakeProbes,
    monitorProbes: fakeMonitorProbes,
    runner,
    auth,
    vault,
    notifier,
    keys,
    agents,
    hearthSelf,
    memory,
    backups,
    jobs,
    apps,
    stagedChanges: staged,
    ...(opts.engine ? { engine: opts.engine(handle, auth, backupRoot) } : {}),
    ...(opts.media
      ? {
          watches: new Watches(
            handle,
            new MovieReleases(handle, apps.broker, opts.media.fetch),
            notifier,
          ),
        }
      : {}),
  });
  cleanup.push(() => {
    void app.close();
  });
  if (opts.listen) {
    // Agents reach the MCP endpoint over real HTTP.
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
  }
  const send = (
    method: Method,
    url: string,
    payload?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      payload: payload as Record<string, unknown> | undefined,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
    const c = res.cookies.find((x) => x.name === "dc_session");
    return c ? `dc_session=${c.value}` : undefined;
  };

  let cookie: string | undefined;
  let recoveryKey: string | undefined;
  if (opts.signedIn !== false) {
    const code = await auth.setupCode();
    const res = code
      ? await send("POST", "/api/auth/setup", { code, password: TEST_PASSWORD })
      : await send("POST", "/api/auth/login", { password: TEST_PASSWORD });
    expect(res.statusCode, res.body).toBeLessThan(300);
    cookie = cookieOf(res);
    recoveryKey = code ? res.json<{ recoveryKey: string }>().recoveryKey : undefined;
  }
  const call = async (method: Method, url: string, payload?: unknown) =>
    send(method, url, payload, cookie);
  const workspace = async () => (await call("GET", "/api/workspace")).json<Workspace>();
  // Sign-in and security records are checked by their own tests.
  const audit = async () =>
    (await call("GET", "/api/audit")).json<AuditRecord[]>().filter((a) => a.target !== "security");
  return {
    app,
    handle,
    call,
    workspace,
    audit,
    runner,
    auth,
    vault,
    notifier,
    keys,
    agents,
    send,
    memory,
    backups,
    backupRoot,
    jobs,
    apps,
    staged,
    cookieOf,
    cookie: () => cookie,
    recoveryKey: () => recoveryKey,
  };
}

describe("persistence", () => {
  it("keeps the same install identity across a close and reopen", async () => {
    const file = path.join(tempDir(), "nested", "dc.db");

    const first = await freshDb(file);
    const created = await ensureInstallIdentity(first.db);
    first.close();

    const second = await freshDb(file); // migrations must be idempotent on reopen
    const reopened = await ensureInstallIdentity(second.db);
    second.close();

    expect(reopened).toEqual(created);
  });

  it("keeps settings, autonomy, and decisions across a restart", async () => {
    const file = path.join(tempDir(), "dc.db");
    const first = await makeApp({ handle: await freshDb(file), scenario: "attention" });
    await first.call("PATCH", "/api/settings", { instanceName: "Lakehouse", quietHours: false });
    await first.call("PUT", "/api/autonomy", {
      default: "diagnose",
      rules: [{ id: "automation", level: "monitor" }],
    });
    await approve(first.call, "/api/incidents/inc-1047/decision");
    await first.app.close();
    first.handle.close();

    const second = await makeApp({ handle: await freshDb(file) });
    const ws = await second.workspace();
    expect(ws.instanceName).toBe("Lakehouse");
    expect(ws.quietHours).toBe(false);
    expect(ws.autonomyDefault).toBe("diagnose");
    expect(ws.autonomyRules.find((r) => r.id === "automation")?.level).toBe("monitor");
    expect(ws.incidents.find((i) => i.id === "inc-1047")?.status).toBe("approved");
    // Rename and quiet hours are separate changes, then autonomy and the decision.
    expect((await second.audit()).map((a) => a.action)).toEqual([
      "Approved a repair",
      "Changed autonomy settings",
      "Turned quiet hours off",
      "Renamed this installation",
    ]);
    second.handle.close();
  });
});

describe("GET /api/health", () => {
  it("reports ok with the install identity once initialised", async () => {
    const { call, handle } = await makeApp();
    const body = (await call("GET", "/api/health")).json<HealthReport>();
    expect(body.status).toBe("ok");
    expect(body.app).toBe("Hearth");
    expect(body.database.installId).toMatch(/[0-9a-f-]{36}/);
    handle.close();
  });

  it("reports degraded before the install identity exists", async () => {
    const handle = await freshDb();
    const runner = testRunner(handle);
    const app = await buildApp({
      handle,
      config: { webDir: tempDir(), mode: "test", demo: false, keyDir: tempDir() },
      runner,
      ...testAuth(handle),
      ...testAgents(handle, runner, () => 0),
      ...testMemory(handle, runner),
    });
    const body = (await app.inject({ url: "/api/health" })).json<HealthReport>();
    expect(body.status).toBe("degraded");
    await app.close();
    handle.close();
  });

  it("serves a pre-compressed copy of a large file to browsers that accept it", async () => {
    const handle = await freshDb();
    const runner = testRunner(handle);
    const webDir = tempDir();
    fs.mkdirSync(path.join(webDir, "assets"));
    fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html>");
    fs.writeFileSync(path.join(webDir, "assets", "big.wasm"), Buffer.alloc(1000, 1));
    fs.writeFileSync(
      path.join(webDir, "assets", "big.wasm.br"),
      zlib.brotliCompressSync(Buffer.alloc(1000, 1)),
    );
    const app = await buildApp({
      handle,
      config: { webDir, mode: "test", demo: false, keyDir: tempDir() },
      runner,
      ...testAuth(handle),
      ...testAgents(handle, runner, () => 0),
      ...testMemory(handle, runner),
    });
    const br = await app.inject({
      url: "/assets/big.wasm",
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(br.headers["content-encoding"]).toBe("br");
    expect(br.headers["content-type"]).toMatch(/wasm/);
    const plain = await app.inject({
      url: "/assets/big.wasm",
      headers: { "accept-encoding": "identity" },
    });
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.rawPayload.length).toBe(1000);
    await app.close();
    handle.close();
  });

  it("reports down with an actionable error when the database is unusable", async () => {
    const { call, handle } = await makeApp();
    handle.close();
    const body = (await call("GET", "/api/health")).json<HealthReport>();
    expect(body.status).toBe("down");
    expect(body.database.error).toBeTruthy();
  });
});

describe("GET /api/workspace", () => {
  it("returns the calm demo environment", async () => {
    const { workspace } = await makeApp({ scenario: "calm" });
    const ws = await workspace();
    expect(ws.demoScenario).toBe("calm");
    expect(ws.hosts).toHaveLength(3);
    expect(ws.services).toHaveLength(32);
    expect(ws.incidents.every((i) => i.status === "resolved")).toBe(true);
    expect(ws.hosts[1]?.volumes.length).toBeGreaterThan(0);
    expect(ws.services.find((s) => s.id === "overseerr")?.dependsOn).toEqual(
      expect.arrayContaining(["sonarr", "radarr"]),
    );
    expect(ws.guardrails.length).toBeGreaterThan(0);
    const jellyfin = ws.services.find((s) => s.id === "jellyfin")!;
    expect(jellyfin.publicUrl).toBe("watch.example.com");
    expect(jellyfin.proxyServiceId).toBe("caddy");
    expect(ws.services.find((s) => s.id === "mosquitto")?.localUrl).toBeUndefined();
  });

  it("returns ordered incident timelines with real timestamps", async () => {
    const { workspace } = await makeApp({ scenario: "attention" });
    const inc = (await workspace()).incidents.find((i) => i.id === "inc-1047")!;
    const times = inc.timeline.map((e) => Date.parse(e.at));
    expect(times.every((t) => !Number.isNaN(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("starts empty on a fresh install", async () => {
    const ws = await (await makeApp({ scenario: "fresh" })).workspace();
    expect(ws.services).toHaveLength(0);
    expect(ws.incidents).toHaveLength(0);
    expect(ws.hosts).toHaveLength(1);
  });

  it("hides the demo scenario when demo mode is off", async () => {
    const ws = await (await makeApp({ scenario: "calm", demo: false })).workspace();
    expect(ws.demoScenario).toBeNull();
  });
});

describe("autonomy", () => {
  it("derives each service's level from its area, falling back to the default", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    const prowlarr = async () => (await workspace()).services.find((s) => s.id === "prowlarr")!;
    // Media automation starts on "default" and the default is "ask".
    expect((await prowlarr()).autonomy).toBe("ask");

    await call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    expect((await prowlarr()).autonomy).toBe("auto");

    await call("PUT", "/api/autonomy", {
      default: "auto",
      rules: [{ id: "automation", level: "monitor" }],
    });
    expect((await prowlarr()).autonomy).toBe("monitor");
  });

  it("rejects unknown areas and invalid levels without changing anything", async () => {
    const { call, workspace, audit } = await makeApp({ scenario: "calm" });
    const before = await workspace();

    const unknown = await call("PUT", "/api/autonomy", {
      default: "auto",
      rules: [{ id: "nope", level: "auto" }],
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain("nope");

    const invalid = await call("PUT", "/api/autonomy", { default: "yolo", rules: [] });
    expect(invalid.statusCode).toBe(400);

    expect((await workspace()).autonomyDefault).toBe(before.autonomyDefault);
    expect(await audit()).toHaveLength(0);
  });

  it("records only actual changes in the audit log", async () => {
    const { call, audit } = await makeApp({ scenario: "calm" });
    await call("PUT", "/api/autonomy", { default: "ask", rules: [{ id: "media", level: "auto" }] });
    expect(await audit()).toHaveLength(0);
    await call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "media", level: "diagnose" }],
    });
    const records = await audit();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ actor: "you", action: "Changed autonomy settings" });
    expect(records[0]?.detail).toEqual({ "Media servers": { from: "auto", to: "diagnose" } });
  });
});

describe("settings", () => {
  it("rejects an empty name and unknown fields", async () => {
    const { call } = await makeApp();
    expect((await call("PATCH", "/api/settings", { instanceName: "   " })).statusCode).toBe(400);
    expect((await call("PATCH", "/api/settings", { colour: "gold" })).statusCode).toBe(400);
  });

  it("shows pictures beside messages until the owner turns them off", async () => {
    const { call, workspace } = await makeApp();
    expect((await workspace()).chatPictures).toBe(true);
    expect((await call("PATCH", "/api/settings", { chatPictures: false })).statusCode).toBe(204);
    expect((await workspace()).chatPictures).toBe(false);
    expect((await call("PATCH", "/api/settings", { chatPictures: true })).statusCode).toBe(204);
    expect((await workspace()).chatPictures).toBe(true);
    expect((await call("PATCH", "/api/settings", { chatPictures: "yes" })).statusCode).toBe(400);
  });

  it("welcomes a newly claimed owner once, until they finish or skip it", async () => {
    const { call, workspace } = await makeApp();
    let ws = await workspace();
    expect(ws).toMatchObject({ onboardingNeeded: true });
    expect(ws.onboardingDoneAt).toBeUndefined();

    // Finishing or skipping records when; the welcome is not offered again.
    expect((await call("PATCH", "/api/settings", { onboardingDone: true })).statusCode).toBe(204);
    ws = await workspace();
    expect(ws.onboardingNeeded).toBe(false);
    expect(ws.onboardingDoneAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Offered again on request, but never once the owner has made a choice of their own.
    await call("PATCH", "/api/settings", { onboardingDone: false });
    expect((await workspace()).onboardingNeeded).toBe(true);
    await call("PATCH", "/api/settings", { ownerName: "Sam" });
    expect((await workspace()).onboardingNeeded).toBe(false);
    expect((await call("PATCH", "/api/settings", { onboardingDone: "yes" })).statusCode).toBe(400);
  });
});

describe("notification routing", () => {
  it("routes to configured channels only", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    await call("PUT", "/api/notifications/channels/email", { values: EMAIL });
    expect(
      (await call("PUT", "/api/notifications/routes/weekly", { channels: ["email"] })).statusCode,
    ).toBe(204);
    expect((await workspace()).routes.find((r) => r.id === "weekly")?.channels).toEqual(["email"]);

    const notSetUp = await call("PUT", "/api/notifications/routes/weekly", {
      channels: ["discord"],
    });
    expect(notSetUp.statusCode).toBe(400);
    expect(notSetUp.json().message).toContain("discord");

    expect((await call("PUT", "/api/notifications/routes/nope", { channels: [] })).statusCode).toBe(
      404,
    );
  });
});

describe("incident decisions", () => {
  it("approving records the decision on the timeline, in activity, and in the audit log", async () => {
    const { call, workspace, audit } = await makeApp({ scenario: "attention" });
    const res = await approve(call, "/api/incidents/inc-1047/decision");
    expect(res.statusCode).toBe(204);

    const ws = await workspace();
    const inc = ws.incidents.find((i) => i.id === "inc-1047")!;
    expect(inc.status).toBe("approved");
    expect(inc.timeline.at(-1)?.text).toContain("You approved");
    expect(ws.activity[0]?.text).toContain("approved");
    expect((await audit())[0]).toMatchObject({
      action: "Approved a repair",
      target: "incident:inc-1047",
    });
  });

  it("declining keeps the incident open for you", async () => {
    const { call, workspace } = await makeApp({ scenario: "attention" });
    await call("POST", "/api/incidents/inc-1047/decision", { decision: "decline" });
    const inc = (await workspace()).incidents.find((i) => i.id === "inc-1047")!;
    expect(inc.status).toBe("open");
    expect(inc.handledBy).toBe("pending");
  });

  it("refuses a second decision, unknown incidents, and incidents with nothing to decide", async () => {
    const { call } = await makeApp({ scenario: "attention" });
    await approve(call, "/api/incidents/inc-1047/decision");
    expect((await approve(call, "/api/incidents/inc-1047/decision")).statusCode).toBe(409);
    expect((await approve(call, "/api/incidents/inc-1048/decision")).statusCode).toBe(409);
    expect((await approve(call, "/api/incidents/nope/decision")).statusCode).toBe(404);
    expect(
      (await call("POST", "/api/incidents/inc-1047/decision", { decision: "maybe" })).statusCode,
    ).toBe(400);
  });
});

describe("approvals are bound to one proposal", () => {
  const decide = (call: Caller, id: string, body: unknown) =>
    call("POST", `/api/incidents/${id}/decision`, body);

  it("needs the fingerprint of the proposal you saw, and works once", async () => {
    const { call, workspace, audit } = await makeApp({ scenario: "attention" });
    const inc = (await workspace()).incidents.find((i) => i.id === "inc-1047")!;
    expect(inc.approval).toMatchObject({ fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(Date.parse(inc.approval!.expiresAt) - Date.now()).toBeGreaterThan(23 * 3600_000);

    expect((await decide(call, "inc-1047", { decision: "approve" })).statusCode).toBe(400);
    const stale = await decide(call, "inc-1047", {
      decision: "approve",
      fingerprint: "0".repeat(32),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ message: string }>().message).toMatch(/changed after you saw it/);
    expect((await workspace()).incidents.find((i) => i.id === "inc-1047")!.status).toBe(
      "awaiting-approval",
    );

    const ok = await decide(call, "inc-1047", {
      decision: "approve",
      fingerprint: inc.approval!.fingerprint,
    });
    expect(ok.statusCode).toBe(204);
    expect((await audit())[0]).toMatchObject({
      action: "Approved a repair",
      detail: expect.objectContaining({ fingerprint: inc.approval!.fingerprint }),
    });
    // Used once: the same approval cannot be replayed.
    const again = await decide(call, "inc-1047", {
      decision: "approve",
      fingerprint: inc.approval!.fingerprint,
    });
    expect(again.statusCode).toBe(409);
    expect(
      (await workspace()).incidents.find((i) => i.id === "inc-1047")!.approval,
    ).toBeUndefined();
  });

  it("a changed proposal needs a new approval", async () => {
    const { call, workspace, handle } = await makeApp({ scenario: "attention" });
    const before = (await workspace()).incidents.find((i) => i.id === "inc-1047")!.approval!;
    handle.sqlite
      .prepare("UPDATE incidents SET proposed_action = 'Something else entirely' WHERE id = ?")
      .run("inc-1047");
    const after = (await workspace()).incidents.find((i) => i.id === "inc-1047")!.approval!;
    expect(after.fingerprint).not.toBe(before.fingerprint);
    const res = await decide(call, "inc-1047", {
      decision: "approve",
      fingerprint: before.fingerprint,
    });
    expect(res.statusCode).toBe(409);
  });

  it("an expired proposal cannot be approved, lapses on its own, and stays expired after a restart", async () => {
    const file = path.join(tempDir(), "dc.db");
    const first = await makeApp({ scenario: "attention", handle: await freshDb(file) });
    const ticket = (await first.workspace()).incidents.find((i) => i.id === "inc-1047")!.approval!;
    first.handle.sqlite
      .prepare("UPDATE incidents SET proposal_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), "inc-1047");
    await first.app.close();
    first.handle.close();

    // After a restart the old approval is still refused.
    const second = await makeApp({ handle: await freshDb(file) });
    const late = await decide(second.call, "inc-1047", {
      decision: "approve",
      fingerprint: ticket.fingerprint,
    });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ message: string }>().message).toMatch(/expired/);

    expect(await expireApprovals(second.handle)).toBe(1);
    const inc = (await second.workspace()).incidents.find((i) => i.id === "inc-1047")!;
    expect(inc).toMatchObject({ status: "open", handledBy: "pending" });
    expect(inc.proposedAction).toBeUndefined();
    expect(inc.timeline.at(-1)!.text).toMatch(/not approved in time/);
    expect((await second.audit())[0]).toMatchObject({
      actor: "dragon-control",
      action: "A proposed repair expired unapproved",
    });
    expect(await expireApprovals(second.handle)).toBe(0);
    await second.app.close();
    second.handle.close();
  });

  it("declining revokes a pending proposal without a fingerprint", async () => {
    const { call, workspace } = await makeApp({ scenario: "attention" });
    expect((await decide(call, "inc-1047", { decision: "decline" })).statusCode).toBe(204);
    const inc = (await workspace()).incidents.find((i) => i.id === "inc-1047")!;
    expect(inc.status).toBe("open");
    expect(inc.approval).toBeUndefined();
  });
});

describe("jobs (Cave 2)", () => {
  const plan = {
    title: "Refresh Jellyfin",
    reason: "Playback stalls",
    steps: [
      { kind: "run-check", serviceId: "jellyfin" },
      { kind: "restart-container", serviceId: "jellyfin" },
      { kind: "test-endpoint", serviceId: "jellyfin" },
    ],
  };

  it("your plan waits for review, then runs each step through the runner and verifies it", async () => {
    const { call, workspace, jobs, audit } = await makeApp({ scenario: "calm" });
    const created = await call("POST", "/api/jobs", plan);
    expect(created.statusCode, created.body).toBe(200);
    const job = created.json<Job>();
    expect(job).toMatchObject({ status: "awaiting-approval", requestedBy: "you" });
    expect(job.steps.map((s) => s.label)).toEqual([
      "Run the health check for Jellyfin",
      "Restart the Jellyfin container",
      "Test Jellyfin's web address",
    ]);
    expect(job.steps[1]).toMatchObject({
      changes: true,
      rollback: expect.stringMatching(/Nothing to undo/),
    });
    expect((await workspace()).pendingJobs).toMatchObject([{ id: job.id, steps: 3 }]);
    expect((await workspace()).actions).toHaveLength(0);

    const approved = await call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await jobs.idle();
    const done = (await call("GET", `/api/jobs/${job.id}`)).json<Job>();
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps.every((s) => s.status === "succeeded" && s.actionId)).toBe(true);
    const ws = await workspace();
    expect(ws.pendingJobs).toEqual([]);
    expect(ws.actions.map((a) => a.kind).sort()).toEqual([
      "restart-container",
      "run-check",
      "test-endpoint",
    ]);
    expect((await audit()).map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "Planned a job: Refresh Jellyfin",
        "Approved a job: Refresh Jellyfin",
        "Restarted the Jellyfin container",
        "Finished a job: Refresh Jellyfin",
      ]),
    );
    expect((await call("GET", "/api/jobs")).json<Job[]>()[0]!.id).toBe(job.id);
  });

  it("checks the policy again when each step runs", async () => {
    const { call, jobs, workspace } = await makeApp({ scenario: "calm" });
    const area = (await workspace()).services.find((x) => x.id === "jellyfin")!.autonomyArea;
    await call("PUT", "/api/autonomy", { default: "ask", rules: [{ id: area, level: "ask" }] });
    const job = await jobs.create({
      title: "AI plan",
      steps: [{ kind: "restart-container", serviceId: "jellyfin" }],
      requestedBy: "agent",
    });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]).toMatchObject({ policy: "approve-first" });
    // You tighten autonomy before approving: the approved step is still refused.
    await call("PUT", "/api/autonomy", {
      default: "diagnose",
      rules: [{ id: area, level: "diagnose" }],
    });
    await call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status).toBe("failed");
    expect(done.steps[0]!.result).toMatch(/Diagnose/);
  });

  it("an AI plan touching a paused service is refused before anything runs", async () => {
    const { call, jobs } = await makeApp({ scenario: "calm" });
    await call("PUT", "/api/services/jellyfin/lifecycle", { lifecycle: "paused" });
    const job = await jobs.create({
      title: "AI plan",
      steps: [{ kind: "restart-container", serviceId: "jellyfin" }],
      requestedBy: "agent",
    });
    expect(job).toMatchObject({ status: "refused", summary: expect.stringMatching(/paused/) });
  });

  it("keys can read and decide jobs, but only you can plan or stop one", async () => {
    const { call, send, jobs } = await makeApp({ scenario: "calm" });
    const { key } = (
      await call("POST", "/api/keys", { name: "HA", scopes: ["read", "approve"] })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    expect((await send("POST", "/api/jobs", plan, undefined, auth)).statusCode).toBe(403);
    const job = (await call("POST", "/api/jobs", plan)).json<Job>();
    expect((await send("GET", `/api/jobs/${job.id}`, undefined, undefined, auth)).statusCode).toBe(
      200,
    );
    expect((await send("POST", `/api/jobs/${job.id}/stop`, {}, undefined, auth)).statusCode).toBe(
      403,
    );
    const decided = await send(
      "POST",
      `/api/jobs/${job.id}/decision`,
      { decision: "approve", fingerprint: job.approval!.fingerprint },
      undefined,
      auth,
    );
    expect(decided.statusCode, decided.body).toBe(200);
    await jobs.idle();
    expect((await call("POST", "/api/jobs", { ...plan, steps: [] })).statusCode).toBe(400);
    expect(
      (await call("POST", "/api/jobs", { ...plan, steps: [{ kind: "rm", serviceId: "x" }] }))
        .statusCode,
    ).toBe(400);
    expect((await call("GET", "/api/jobs/nope")).statusCode).toBe(404);
  });

  it("takes a long body, settings, links or uploaded files in a step, each within its limit, but keeps other parameters short", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const step = plan.steps[0]!;
    const long = "x".repeat(600);
    const withBody = await call("POST", "/api/jobs", {
      ...plan,
      steps: [{ ...step, params: { resource: "artist", body: long } }],
    });
    // Past the schema: the operation itself decides (here, it is not an app step at all).
    expect(withBody.statusCode, withBody.body).not.toBe(400);
    const withPrefs = await call("POST", "/api/jobs", {
      ...plan,
      steps: [{ ...step, params: { preferences: long } }],
    });
    expect(withPrefs.statusCode, withPrefs.body).not.toBe(400);
    const other = await call("POST", "/api/jobs", {
      ...plan,
      steps: [{ ...step, params: { hash: long } }],
    });
    expect(other.statusCode).toBe(400);
    expect(other.body).toMatch(/Only body, .* may be longer than 200 characters/);
    // Plex's Home rows (a library's rows and order) and an app's edits grow with the library.
    for (const key of ["order", "rows", "changes", "settings", "books"]) {
      const res = await call("POST", "/api/jobs", {
        ...plan,
        steps: [{ ...step, params: { [key]: long } }],
      });
      expect(res.statusCode, `${key}: ${res.body}`).not.toBe(400);
    }
    // Magnet links carry their trackers, so links to add may be long too, within their own limit.
    const links = await call("POST", "/api/jobs", {
      ...plan,
      steps: [{ ...step, params: { urls: long } }],
    });
    expect(links.statusCode, links.body).not.toBe(400);
    const tooMany = await call("POST", "/api/jobs", {
      ...plan,
      steps: [{ ...step, params: { urls: "x".repeat(20_001) } }],
    });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe("this machine's own numbers", () => {
  it("are read live, with nothing adopted (sample data still on)", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const res = await call("GET", "/api/machine");
    expect(res.statusCode, res.body).toBe(200);
    const m = res.json<{ name: string; cpu: { cores: number }; memory: { totalGb: number } }>();
    expect(m.name).toBeTruthy();
    expect(m.cpu.cores).toBeGreaterThan(0);
    expect(m.memory.totalGb).toBeGreaterThan(0);
  });
});

describe("homelab rules and long work (Phase 0)", () => {
  it("saves the do-not-touch list and reservations, and an AI plan touching a listed service is refused", async () => {
    const { call, jobs } = await makeApp({ scenario: "calm" });
    const saved = await call("PUT", "/api/settings/rules", {
      doNotTouch: [{ serviceId: "jellyfin", reason: "I manage this myself" }],
      reservations: [
        {
          id: "r1",
          machine: "Gaming-PC",
          resource: "gpu",
          from: "19:00",
          until: "23:00",
          note: "gaming",
        },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(204);
    const ws = await (await call("GET", "/api/workspace")).json<Workspace>();
    expect(ws.rules.doNotTouch).toMatchObject([
      { serviceId: "jellyfin", reason: "I manage this myself" },
    ]);
    expect(ws.rules.reservations).toHaveLength(1);
    expect(ws.rules.notes).toBe("");
    // The owner's own rules for Ember, in their words; left alone when a save does not send them.
    const rules = { doNotTouch: [], reservations: [] };
    await call("PUT", "/api/settings/rules", {
      ...rules,
      notes: "  - Ask before restarting Plex.  ",
    });
    const withNotes = await (await call("GET", "/api/workspace")).json<Workspace>();
    expect(withNotes.rules.notes).toBe("- Ask before restarting Plex.");
    await call("PUT", "/api/settings/rules", rules);
    expect((await (await call("GET", "/api/workspace")).json<Workspace>()).rules.notes).toBe(
      "- Ask before restarting Plex.",
    );
    await call("PUT", "/api/settings/rules", {
      doNotTouch: [{ serviceId: "jellyfin", reason: "I manage this myself" }],
      reservations: ws.rules.reservations,
    });
    const job = await jobs.create({
      title: "AI plan",
      steps: [{ kind: "restart-container", serviceId: "jellyfin" }],
      requestedBy: "agent",
    });
    expect(job).toMatchObject({
      status: "refused",
      summary: expect.stringMatching(/do-not-touch/),
    });
    // Looking is still fine, and your own plans still go to approval.
    const look = await jobs.create({
      title: "Check",
      steps: [{ kind: "run-check", serviceId: "jellyfin" }],
      requestedBy: "agent",
    });
    expect(look.status).not.toBe("refused");
    const mine = await jobs.create({
      title: "Mine",
      steps: [{ kind: "restart-container", serviceId: "jellyfin" }],
      requestedBy: "you",
    });
    expect(mine.status).toBe("awaiting-approval");
    const audit = (await call("GET", "/api/audit")).json<{ action: string }[]>();
    expect(audit.some((a) => a.action === "Updated your homelab rules")).toBe(true);
  });

  it("rejects unknown services and malformed times", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    expect(
      (
        await call("PUT", "/api/settings/rules", {
          doNotTouch: [{ serviceId: "nope", reason: "" }],
          reservations: [],
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call("PUT", "/api/settings/rules", {
          doNotTouch: [],
          reservations: [{ id: "r", machine: "PC", resource: "gpu", from: "7pm", until: "23:00" }],
        })
      ).statusCode,
    ).toBe(400);
  });

  it("a key with the work scope starts and reports long work, and nothing else", async () => {
    const { call, send } = await makeApp({ scenario: "calm" });
    const { key } = (
      await call("POST", "/api/keys", { name: "PC2 trainer", scopes: ["work"] })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    const started = await send(
      "POST",
      "/api/work",
      { title: "Voice training", machine: "Gaming-PC", stopBy: "2030-01-01T18:00:00-08:00" },
      undefined,
      auth,
    );
    expect(started.statusCode, started.body).toBe(201);
    const w = started.json<{ id: string; reportedBy: string; stopBy: string }>();
    expect(w).toMatchObject({ reportedBy: "PC2 trainer", stopBy: "2030-01-02T02:00:00.000Z" });
    const r = await send(
      "POST",
      `/api/work/${w.id}`,
      { progress: 25, detail: "operator" },
      undefined,
      auth,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (await send("POST", `/api/work/${w.id}`, { status: "stalled" }, undefined, auth)).statusCode,
    ).toBe(400);
    expect((await send("GET", "/api/workspace", undefined, undefined, auth)).statusCode).toBe(403);
    expect((await send("GET", "/api/work", undefined, undefined, auth)).statusCode).toBe(403);
    const list = (await call("GET", "/api/work")).json<{ title: string; progress: number }[]>();
    expect(list).toMatchObject([{ title: "Voice training", progress: 25 }]);
  });
});

describe("desk layouts (desktop command center)", () => {
  it("saves, replaces by name, lists, and deletes; only you, never an access key", async () => {
    const { call, send } = await makeApp({ scenario: "calm" });
    const saved = await call("POST", "/api/desk/layouts", {
      name: "Media check",
      panels: "!service:plex,service:jellyfin@logs",
      dock: { width: 400, mode: "docked" },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    await call("POST", "/api/desk/layouts", { name: "media CHECK", panels: "service:radarr" });
    const list = (await call("GET", "/api/desk/layouts")).json<{ id: string; panels: string }[]>();
    expect(list).toHaveLength(1);
    expect(list[0]!.panels).toBe("service:radarr");
    expect((await call("POST", "/api/desk/layouts", { name: "", panels: "" })).statusCode).toBe(
      400,
    );
    const { key } = (
      await call("POST", "/api/keys", { name: "HA", scopes: ["read", "act", "converse"] })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    expect((await send("GET", "/api/desk/layouts", undefined, undefined, auth)).statusCode).toBe(
      403,
    );
    expect((await call("DELETE", `/api/desk/layouts/${list[0]!.id}`)).statusCode).toBe(204);
    expect((await call("GET", "/api/desk/layouts")).json<unknown[]>()).toEqual([]);
    expect((await call("DELETE", `/api/desk/layouts/${list[0]!.id}`)).statusCode).toBe(404);
  });
});

describe("workspace groups (minimized arrangements)", () => {
  it("saves and updates a group by id, keeps its view state, limits size, deletes; never an access key", async () => {
    const { call, send } = await makeApp({ scenario: "calm" });
    const id = "0b6f8f3e-1d2c-4b7a-9a51-3f2e8c1d0a99";
    const body = {
      name: "Ember · Duplicate Movies",
      search: "panels=workspace%3Aw1%2Cservice%3Aplex&focus=workspace%3Aw1",
      conversationId: "c1",
      view: { "workspace:w1:search": "Movie", "desk:weights": { "service:plex": 1.4 } },
      unsent: 2,
    };
    const saved = await call("PUT", `/api/desk/groups/${id}`, body);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ id, ...body });
    await call("PUT", `/api/desk/groups/${id}`, { ...body, unsent: 0, view: {} });
    const list = (await call("GET", "/api/desk/groups")).json<{ unsent: number }[]>();
    expect(list).toHaveLength(1);
    expect(list[0]!.unsent).toBe(0);
    expect((await call("PUT", "/api/desk/groups/bad id", body)).statusCode).toBe(400);
    const big = { ...body, view: { x: "y".repeat(70 * 1024) } };
    expect((await call("PUT", `/api/desk/groups/${id}`, big)).statusCode).toBe(400);
    const { key } = (
      await call("POST", "/api/keys", { name: "HA", scopes: ["read", "act", "converse"] })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    expect((await send("GET", "/api/desk/groups", undefined, undefined, auth)).statusCode).toBe(
      403,
    );
    expect((await call("DELETE", `/api/desk/groups/${id}`)).statusCode).toBe(204);
    expect((await call("GET", "/api/desk/groups")).json<unknown[]>()).toEqual([]);
  });
});

describe("projects (command center)", () => {
  it("builds on memory projects: systems, tasks, jobs, and a phase that facts override", async () => {
    const { call, jobs } = await makeApp({ scenario: "calm" });
    const created = await call("POST", "/api/projects", {
      name: "Improve Jellyfin",
      summary: "Faster starts and fewer buffering complaints",
      icon: "tv",
      phase: "investigating",
      related: [
        { kind: "service", id: "jellyfin" },
        { kind: "host", id: "atlas" },
      ],
    });
    expect(created.statusCode, created.body).toBe(200);
    const project = created.json<ProjectDetail>();
    expect(project).toMatchObject({ phase: "investigating", icon: "tv", status: "active" });
    expect(project.systems.map((x) => x.name)).toEqual(["Jellyfin", "Atlas"]);
    // It is the same store the companion and the Memory page use.
    expect(
      (await call("GET", "/api/memory/projects")).json<{ id: string }[]>().map((p) => p.id),
    ).toContain(project.id);

    const task = (
      await call("POST", `/api/projects/${project.id}/tasks`, { title: "Check transcoding" })
    ).json<ProjectTask>();
    await call("POST", `/api/projects/${project.id}/tasks`, { title: "Review logs" });
    await call("PATCH", `/api/projects/${project.id}/tasks/${task.id}`, { status: "done" });

    const job = await jobs.create({
      title: "Check Jellyfin",
      steps: [{ kind: "run-check", serviceId: "jellyfin" }],
      requestedBy: "you",
      projectId: project.id,
    });
    let summary = (await call("GET", "/api/projects")).json<ProjectSummary[]>()[0]!;
    expect(summary).toMatchObject({
      id: project.id,
      phase: "awaiting-approval",
      awaitingApproval: 1,
      progress: { done: 1, total: 2 },
    });
    await call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    await jobs.idle();
    const detail = (await call("GET", `/api/projects/${project.id}`)).json<ProjectDetail>();
    expect(detail.phase).toBe("investigating");
    expect(detail.jobs[0]).toMatchObject({ id: job.id, status: "succeeded" });
    expect(detail.terminal[0]!.lines[0]).toBe("$ Run the health check for Jellyfin");
    expect(detail.history.map((h) => h.text)).toEqual(
      expect.arrayContaining([
        "Started a project: Improve Jellyfin",
        "Task done: Check transcoding",
        "Finished a job: Check Jellyfin",
      ]),
    );

    await call("PATCH", `/api/projects/${project.id}`, { status: "paused" });
    summary = (await call("GET", "/api/projects")).json<ProjectSummary[]>()[0]!;
    expect(summary.phase).toBe("paused");
    await call("PATCH", `/api/projects/${project.id}`, { status: "done" });
    expect((await call("GET", "/api/projects")).json<ProjectSummary[]>()).toEqual([]);
    expect((await call("GET", "/api/projects?all=1")).json<ProjectSummary[]>()[0]!.phase).toBe(
      "completed",
    );
  });

  it("keeps a color for the card on Home, changes it, and clears it", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const created = await call("POST", "/api/projects", { name: "Media cleanup", color: "orange" });
    expect(created.statusCode, created.body).toBe(200);
    const project = created.json<ProjectDetail>();
    expect(project.color).toBe("orange");
    expect((await call("POST", "/api/projects", { name: "X", color: "pink" })).statusCode).toBe(
      400,
    );
    await call("PATCH", `/api/projects/${project.id}`, { color: "blue" });
    expect((await call("GET", "/api/projects")).json<ProjectSummary[]>()[0]!.color).toBe("blue");
    // A status change leaves the color alone.
    await call("PATCH", `/api/projects/${project.id}`, { status: "paused" });
    expect((await call("GET", `/api/projects/${project.id}`)).json<ProjectDetail>().color).toBe(
      "blue",
    );
    await call("PATCH", `/api/projects/${project.id}`, { color: null });
    expect(
      (await call("GET", `/api/projects/${project.id}`)).json<ProjectDetail>().color,
    ).toBeUndefined();
  });

  it("refuses links to systems that do not exist, and keys can only read", async () => {
    const { call, send } = await makeApp({ scenario: "calm" });
    const bad = await call("POST", "/api/projects", {
      name: "X",
      related: [{ kind: "service", id: "nope" }],
    });
    expect(bad.statusCode).toBe(400);
    const { key } = (
      await call("POST", "/api/keys", { name: "HA", scopes: ["read", "act"] })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    expect((await send("GET", "/api/projects", undefined, undefined, auth)).statusCode).toBe(200);
    expect((await send("POST", "/api/projects", { name: "Y" }, undefined, auth)).statusCode).toBe(
      403,
    );
  });

  it("keeps one main conversation, scopes project conversations, and answers about what is open", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const main = (await call("GET", "/api/agent/conversations/main")).json<{
      id: string;
      main: boolean;
    }>();
    expect(main.main).toBe(true);
    expect((await call("GET", "/api/agent/conversations/main")).json<{ id: string }>().id).toBe(
      main.id,
    );

    const project = (
      await call("POST", "/api/projects", {
        name: "Audit public servers",
        related: [{ kind: "service", id: "caddy" }],
      })
    ).json<ProjectDetail>();
    await call("POST", `/api/projects/${project.id}/tasks`, { title: "Check certificates" });
    const inProject = (
      await call("POST", "/api/agent/conversations", {
        text: "What is left to do here?",
        projectId: project.id,
        focus: { kind: "project", id: project.id },
      })
    ).json<{ conversationId: string; reply: string }>();
    expect(inProject.reply).toMatch(/Project "Audit public servers".*left: Check certificates/);
    const scoped = (await call("GET", `/api/agent/conversations?projectId=${project.id}`)).json<
      { id: string }[]
    >();
    expect(scoped.map((c) => c.id)).toEqual([inProject.conversationId]);
    expect(
      (await call("GET", `/api/projects/${project.id}`)).json<ProjectDetail>().conversations,
    ).toHaveLength(1);

    // "Check this" with a service open is about that service, and in scope.
    const svc = (
      await call("POST", "/api/agent/conversations", {
        text: "Check this and tell me if anything is wrong",
        conversationId: main.id,
        focus: { kind: "service", id: "jellyfin" },
      })
    ).json<{ reply: string; meta: { mode: string } }>();
    expect(svc.meta.mode).toBe("records");
    expect(svc.reply).toMatch(/Jellyfin on/);

    expect(
      (
        await call("PUT", "/api/agent/conversations/main", {
          conversationId: inProject.conversationId,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("renames and deletes conversations; a fresh one is named by its first message", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const main = (await call("GET", "/api/agent/conversations/main")).json<{
      id: string;
      title: string;
    }>();
    expect(main.title).toBe("New conversation");
    // A command is never its name (11-12: Remote Control showed "Lair • /login"): the first real
    // message after it names the conversation.
    await call("POST", "/api/agent/conversations", { text: "/login", conversationId: main.id });
    expect(
      (await call("GET", `/api/agent/conversations/${main.id}`)).json<{ title: string }>().title,
    ).toBe("New conversation");
    const started = (await call("POST", "/api/agent/conversations", { text: "/help" })).json<{
      conversationId: string;
    }>();
    expect(
      (await call("GET", `/api/agent/conversations/${started.conversationId}`)).json<{
        title: string;
      }>().title,
    ).toBe("New conversation");
    await call("POST", "/api/agent/conversations", {
      text: "Why is Plex slow?",
      conversationId: main.id,
    });
    expect(
      (await call("GET", `/api/agent/conversations/${main.id}`)).json<{ title: string }>().title,
    ).toBe("Why is Plex slow?");
    const other = (await call("POST", "/api/agent/conversations", { text: "Hello there" })).json<{
      conversationId: string;
    }>();
    const renamed = await call("PATCH", `/api/agent/conversations/${other.conversationId}`, {
      title: "  Plex   tuning ",
    });
    expect(renamed.json<{ title: string }>().title).toBe("Plex tuning");
    expect(
      (await call("PATCH", `/api/agent/conversations/${other.conversationId}`, { title: " " }))
        .statusCode,
    ).toBe(400);
    // Opening another makes it the one Ember continues; deleting that one starts fresh next time.
    await call("PUT", "/api/agent/conversations/main", { conversationId: other.conversationId });
    expect(
      (await call("DELETE", `/api/agent/conversations/${other.conversationId}`)).statusCode,
    ).toBe(204);
    expect((await call("GET", `/api/agent/conversations/${other.conversationId}`)).statusCode).toBe(
      404,
    );
    const next = (await call("GET", "/api/agent/conversations/main")).json<{ id: string }>();
    expect(next.id).not.toBe(other.conversationId);
    expect(next.id).not.toBe(main.id);
  });

  it("Thread Looks: a look names a new thread (numbered when taken), changes later, and search finds the line", async () => {
    // 11-17, the owner's "Ember Thread Looks": a small Ember picture with a default thread name,
    // and "where did we talk about this?" without asking the AI.
    const { call } = await makeApp({ scenario: "calm" });
    const start = async (text: string, look?: string) =>
      (await call("POST", "/api/agent/conversations", { text, ...(look ? { look } : {}) })).json<{
        conversationId: string;
      }>().conversationId;
    const read = async (id: string) =>
      (await call("GET", `/api/agent/conversations/${id}`)).json<{
        title: string;
        look?: string;
      }>();

    const a = await start("Sonarr stopped importing episodes", "sprocket");
    expect(await read(a)).toMatchObject({ title: "Sprocket", look: "sprocket" });
    const b = await start("Radarr is stuck too", "sprocket");
    expect((await read(b)).title).toBe("Sprocket 2");
    // The first message still names a plain one; an unknown look is refused.
    const plain = await start("Hello there");
    expect(await read(plain)).toMatchObject({ title: "Hello there" });
    expect((await read(plain)).look).toBeUndefined();
    expect(
      (await call("POST", "/api/agent/conversations", { text: "hi", look: "nope" })).statusCode,
    ).toBe(400);
    // Listed with its picture.
    const list = (await call("GET", "/api/agent/conversations")).json<
      { id: string; look?: string }[]
    >();
    expect(list.find((c) => c.id === a)?.look).toBe("sprocket");

    // Renaming keeps the picture; the picture changes, and comes off.
    await call("PATCH", `/api/agent/conversations/${a}`, { title: "Sonarr imports" });
    expect(await read(a)).toMatchObject({ title: "Sonarr imports", look: "sprocket" });
    expect(
      (await call("PATCH", `/api/agent/conversations/${a}`, { look: "parcel" })).json<{
        look: string;
      }>().look,
    ).toBe("parcel");
    expect((await read(a)).look).toBe("parcel");
    await call("PATCH", `/api/agent/conversations/${a}`, { look: null });
    expect((await read(a)).look).toBeUndefined();
    expect(
      (await call("PATCH", `/api/agent/conversations/${a}`, { look: "nope" })).statusCode,
    ).toBe(400);
    expect((await call("PATCH", `/api/agent/conversations/${a}`, {})).statusCode).toBe(400);

    // Search: every word must be there; the hit carries the line and its place in the thread.
    const hits = (await call("GET", "/api/agent/conversations/search?q=sonarr%20importing")).json<
      { id: string; title: string; match?: { text: string; index: number; role: string } }[]
    >();
    expect(hits.map((h) => h.id)).toEqual([a]);
    expect(hits[0]!.match).toMatchObject({ index: 0, role: "you" });
    expect(hits[0]!.match!.text).toContain("Sonarr stopped importing");
    // A thread's name is searched too; nothing found is an empty list; too short is refused.
    expect(
      (await call("GET", "/api/agent/conversations/search?q=imports"))
        .json<{ id: string }[]>()
        .map((h) => h.id),
    ).toContain(a);
    expect(
      (await call("GET", "/api/agent/conversations/search?q=zebra%20crossing")).json(),
    ).toEqual([]);
    expect((await call("GET", "/api/agent/conversations/search?q=a")).statusCode).toBe(400);
  });
});

describe("Remote Control in the Lair (11-04)", () => {
  // A stand-in for Claude Code: shows a session address and echoes what is typed into it.
  const FAKE = `
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const sid = args[args.indexOf("--session-id") + 1];
fs.writeFileSync(process.env.FAKE_RC_ARGS, JSON.stringify(args));
const file = path.join(process.env.FAKE_RC_TRANSCRIPTS, process.cwd().replace(/[^A-Za-z0-9]/g, "-"), sid + ".jsonl");
fs.mkdirSync(path.dirname(file), { recursive: true });
process.stdout.write("Remote Control active: https://claude.ai/code/session_MAIN1\\r\\n");
let buf = "";
// Keys as typed: a terminal on Linux would turn Enter into a newline otherwise.
process.stdin.setRawMode && process.stdin.setRawMode(true);
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (!buf.includes("\\r")) return;
  const text = buf.replace(/\\x1b\\[20[01]~/g, "").replace(/\\r/g, "").trim();
  buf = "";
  fs.appendFileSync(file, JSON.stringify({ type: "assistant", uuid: "a" + Date.now(), message: { content: [{ type: "text", text: "live: " + text }] } }) + "\\n");
});
`;
  const terms = new Terminals();
  afterEach(() => terms.stopAll());

  it("/rc opens the main conversation as Hearth • PC • Lair • Main, and messages go there", async () => {
    const { call, agents } = await makeApp({ scenario: "calm" });
    await agents.connect("claude-code");
    const dir = fs.mkdtempSync(path.join(tmpdir(), "hearth-lair-rc-app-"));
    const script = path.join(dir, "fake.cjs");
    fs.writeFileSync(script, FAKE);
    process.env.FAKE_RC_ARGS = path.join(dir, "args.json");
    process.env.FAKE_RC_TRANSCRIPTS = path.join(dir, "transcripts");
    const settings = new Map<string, unknown>();
    agents.remote = new LairRemotes({
      terminals: () => terms,
      binary: () => process.execPath,
      pcName: () => "Homeserver",
      setup: (id) => agents.remoteSetup(id),
      say: (id, role, text, from) => agents.remoteSay(id, role, text, from),
      setting: async (k, d) => (settings.has(k) ? (settings.get(k) as never) : d),
      setSetting: async (k, v) => void settings.set(k, v),
      launch: [script],
      transcripts: path.join(dir, "transcripts"),
    });
    const main = (await call("GET", "/api/agent/conversations/main")).json<{ id: string }>();
    await call("POST", "/api/agent/conversations", {
      text: "Is Plex up?",
      conversationId: main.id,
    });
    // Signed out: /rc says so; /login signs in from the chat, and the code is never kept (11-04).
    const refused = (
      await call("POST", "/api/agent/conversations", { text: "/rc", conversationId: main.id })
    ).json<{ reply: string }>();
    expect(refused.reply).toMatch(/isn't signed in.*Type \/login/);
    const login = (
      await call("POST", "/api/agent/conversations", { text: "/login", conversationId: main.id })
    ).json<{ reply: string }>();
    expect(login.reply).toMatch(/paste it here as your next message/);
    const done = (
      await call("POST", "/api/agent/conversations", {
        text: TEST_SIGN_IN_CODE,
        conversationId: main.id,
      })
    ).json<{ reply: string }>();
    expect(done.reply).toMatch(/^Claude Code is signed in/);
    const signedIn = (await call("GET", `/api/agent/conversations/${main.id}`)).json<{
      messages: { role: string; text: string; meta?: { link?: { url: string } } }[];
    }>();
    expect(JSON.stringify(signedIn)).not.toContain(TEST_SIGN_IN_CODE);
    expect(signedIn.messages.some((m) => m.text === "(the one-time sign-in code)")).toBe(true);
    expect(signedIn.messages.find((m) => m.meta?.link)?.meta?.link?.url).toMatch(
      /^https:\/\/claude\.com\//,
    );
    const on = (
      await call("POST", "/api/agent/conversations", { text: "/rc", conversationId: main.id })
    ).json<{ status: string; reply: string }>();
    expect(on.reply).toMatch(/Starting Remote Control/);
    type Convo = {
      remote?: { title: string; url?: string };
      messages: { role: string; text: string }[];
    };
    const read = async () =>
      (await call("GET", `/api/agent/conversations/${main.id}`)).json<Convo>();
    const end = Date.now() + 15_000;
    while (!(await read()).remote?.url && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
    expect((await read()).remote).toEqual({
      title: "Hearth • Homeserver • Lair • Is Plex up?",
      url: "https://claude.ai/code/session_MAIN1",
      connecting: false,
    });
    const args = JSON.parse(fs.readFileSync(process.env.FAKE_RC_ARGS, "utf8")) as string[];
    expect(args[args.indexOf("--remote-control") + 1]).toBe(
      "Hearth • Homeserver • Lair • Is Plex up?",
    );

    // While it is on, the owner's message goes into the live session, not a new Ember run.
    const sent = (
      await call("POST", "/api/agent/conversations", {
        text: "restart nothing, just look",
        conversationId: main.id,
      })
    ).json<{ status: string; reply: string }>();
    expect(sent).toMatchObject({ status: "answered", reply: "" });
    while (
      !(await read()).messages.some((m) => m.text === "live: restart nothing, just look") &&
      Date.now() < end + 10_000
    )
      await new Promise((r) => setTimeout(r, 100));
    const msgs = (await read()).messages;
    expect(msgs.find((m) => m.text === "live: restart nothing, just look")?.role).toBe("agent");
    expect(msgs.filter((m) => m.text === "restart nothing, just look")).toHaveLength(1);

    await call("POST", "/api/agent/conversations", { text: "/rc", conversationId: main.id });
    const off = Date.now() + 10_000;
    while ((await read()).remote && Date.now() < off) await new Promise((r) => setTimeout(r, 100));
    expect((await read()).remote).toBeUndefined();
    agents.remote.stopAll();
  }, 40_000);
});

describe("demo scenarios", () => {
  it("switches the environment but keeps your name", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    await call("PATCH", "/api/settings", { instanceName: "Lakehouse" });
    expect((await call("POST", "/api/demo/scenario", { scenario: "attention" })).statusCode).toBe(
      204,
    );

    const ws = await workspace();
    expect(ws.demoScenario).toBe("attention");
    expect(ws.incidents.filter((i) => i.status !== "resolved")).toHaveLength(2);
    expect(ws.instanceName).toBe("Lakehouse");
  }, 20_000); // Two full sample switches: slow on a busy machine.

  it("can be reseeded repeatedly", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    for (const scenario of ["fresh", "attention", "calm", "calm"]) {
      expect((await call("POST", "/api/demo/scenario", { scenario })).statusCode).toBe(204);
    }
    expect((await workspace()).services).toHaveLength(32);
  });

  it("is unavailable when demo mode is off, and validates the scenario", async () => {
    expect(
      (
        await (
          await makeApp({ demo: false })
        ).call("POST", "/api/demo/scenario", { scenario: "calm" })
      ).statusCode,
    ).toBe(404);
    expect(
      (await (await makeApp()).call("POST", "/api/demo/scenario", { scenario: "chaos" }))
        .statusCode,
    ).toBe(400);
  });
});

describe("routing", () => {
  it("returns JSON 404 for unknown API routes", async () => {
    const { call } = await makeApp();
    const res = await call("GET", "/api/does-not-exist");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Not Found" });
  });
});

describe("discovery and adoption", () => {
  async function scanAndAdopt(
    call: Awaited<ReturnType<typeof makeApp>>["call"],
    choose: (r: DiscoveryReport) => { key: string; name: string }[] = (r) =>
      r.findings.filter((f) => f.selectedByDefault).map((f) => ({ key: f.key, name: f.name })),
  ) {
    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    const res = await call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: choose(report),
    });
    return { report, res };
  }

  it("replaces sample data with your systems, keeping settings and autonomy", async () => {
    const { call, workspace, audit } = await makeApp({ scenario: "attention" });
    await call("PATCH", "/api/settings", { instanceName: "Lakehouse" });
    await call("PUT", "/api/autonomy", {
      default: "diagnose",
      rules: [{ id: "media", level: "monitor" }],
    });

    const { res } = await scanAndAdopt(call);
    expect(res.statusCode).toBe(200);

    const ws = await workspace();
    expect(ws.environment).toBe("real");
    expect(ws.demoScenario).toBeNull();
    expect(ws.discoveredAt).toBeTruthy();
    expect(ws.hosts.map((h) => h.name)).toEqual(["testbox"]);
    expect(ws.incidents).toHaveLength(0); // sample incidents are gone
    expect(ws.instanceName).toBe("Lakehouse");
    expect(ws.autonomyDefault).toBe("diagnose");
    expect(ws.autonomyRules.find((r) => r.id === "media")?.level).toBe("monitor");
    // Nothing pretends to be configured on a real install.
    expect(ws.channels.every((c) => c.status === "available")).toBe(true);
    expect(ws.agents.some((a) => a.status === "connected")).toBe(false);
    expect(ws.integrations.find((i) => i.id === "docker")?.status).toBe("connected");
    expect((await audit())[0]?.action).toBe("Replaced sample data with your systems");
  });

  it("adopts only what you select, with your names, and only relationships between kept services", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    const { res } = await scanAndAdopt(call, (r) =>
      r.findings
        .filter((f) => ["prowlarr", "mystery-app"].includes(f.sourceName))
        .map((f) => ({ key: f.key, name: f.sourceName === "mystery-app" ? "Shortlist" : f.name })),
    );
    expect(res.json()).toEqual({ services: 2 });
    const ws = await workspace();
    expect(ws.services.map((s) => s.name).sort()).toEqual(["Prowlarr", "Shortlist"]);
    // Prowlarr depends on the VPN, which was not adopted, so no dangling link.
    expect(ws.services.find((s) => s.name === "Prowlarr")?.dependsOn).toEqual([]);
    expect(ws.services.find((s) => s.name === "Shortlist")?.uptimePct).toBeUndefined();
  });

  it("keeps relationships when both ends are adopted", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    await scanAndAdopt(call);
    const ws = await workspace();
    expect(ws.services.find((s) => s.name === "Prowlarr")?.dependsOn).toEqual(["vpn"]);
  });

  it("refuses findings that were not in the scan, and stale scans", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    const forged = await call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: [{ key: "container:evil", name: "Evil" }],
    });
    expect(forged.statusCode).toBe(400);
    expect(
      (
        await call("POST", "/api/discovery/adopt", {
          reportId: "old",
          selections: [{ key: report.findings[0]!.key, name: "x" }],
        })
      ).statusCode,
    ).toBe(409);
  });

  it("with nothing ticked, watches the machine itself: its numbers, no services", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    const res = await call("POST", "/api/discovery/adopt", { reportId: report.id, selections: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ services: number }>().services).toBe(0);
    const ws = await workspace();
    expect(ws.environment).toBe("real");
    expect(ws.hosts.map((h) => h.id)).toContain(report.host.id);
    expect(ws.services.filter((s) => s.hostId === report.host.id)).toHaveLength(0);
  });

  it("protects your systems from an accidental switch to sample data", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    await scanAndAdopt(call);
    const blocked = await call("POST", "/api/demo/scenario", { scenario: "calm" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().message).toContain("your own systems");
    expect((await workspace()).environment).toBe("real");

    const forced = await call("POST", "/api/demo/scenario", {
      scenario: "calm",
      replaceYourSystems: true,
    });
    expect(forced.statusCode).toBe(204);
    expect((await workspace()).environment).toBe("demo");
  });

  it("never seeds sample data over your systems on restart", async () => {
    const file = path.join(tempDir(), "dc.db");
    const first = await makeApp({ handle: await freshDb(file), scenario: "calm" });
    await scanAndAdopt(first.call);
    await first.app.close();
    first.handle.close();

    const handle = await freshDb(file);
    await ensureInitialEnvironment(handle, { demo: true });
    const second = await makeApp({ handle });
    const ws = await second.workspace();
    expect(ws.environment).toBe("real");
    expect(ws.hosts.map((h) => h.name)).toEqual(["testbox"]);
  });

  it("treats a pre-discovery database with a demo scenario as sample data", async () => {
    const handle = await freshDb();
    await seedDemo(handle, "calm");
    handle.sqlite.exec("DELETE FROM settings WHERE key = 'environment'"); // as written by M2
    await ensureInitialEnvironment(handle, { demo: true });
    const ws = await (await makeApp({ handle })).workspace();
    expect(ws.environment).toBe("demo");
    expect(ws.demoScenario).toBe("calm");
  });
});

describe("storage browsing", () => {
  async function adoptFake(call: Awaited<ReturnType<typeof makeApp>>["call"]) {
    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    await call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings
        .filter((f) => f.selectedByDefault)
        .map((f) => ({ key: f.key, name: f.name })),
    });
  }

  function realFolder() {
    const dir = path.join(tempDir(), "Movies");
    mkdirSync(path.join(dir, "Metropolis (1927)"), { recursive: true });
    writeFileSync(path.join(dir, "Metropolis (1927)", "Metropolis (1927).mkv"), Buffer.alloc(1234));
    return dir;
  }

  it("browses sample folders with breadcrumbs and Properties", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    expect((await workspace()).storageLocations.map((l) => l.label)).toEqual([
      "Movies",
      "Shows",
      "Photos",
      "Books & Audio",
    ]);
    const root = (await call("GET", "/api/storage/demo-movies/browse")).json<FolderListing>();
    expect(root.breadcrumbs).toEqual([{ name: "Movies", path: "" }]);
    const first = root.entries[0]!;
    const inside = (
      await call("GET", `/api/storage/demo-movies/browse?path=${encodeURIComponent(first.path)}`)
    ).json<FolderListing>();
    expect(inside.breadcrumbs.map((b) => b.name)).toEqual(["Movies", first.name]);
    expect(inside.displayPath).toBe(`/mnt/tank/movies/${first.name}`);
    const props = (await call("GET", "/api/storage/demo-movies/properties")).json<ItemProperties>();
    expect(props).toMatchObject({ name: "Movies", kind: "folder", complete: true });
  });

  it("refuses traversal, unknown locations, and missing items with clear errors", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const traversal = await call("GET", "/api/storage/demo-movies/browse?path=..%2F..%2Fetc");
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().message).toContain("cannot leave");
    expect((await call("GET", "/api/storage/nope/browse")).statusCode).toBe(404);
    expect(
      (await call("GET", "/api/storage/demo-movies/browse?path=No%20Such%20Film")).statusCode,
    ).toBe(404);
  });

  it("only watches real folders once your systems are discovered", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const res = await call("POST", "/api/storage/locations", { path: realFolder() });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("Discover this machine");
  });

  it("watches, browses, and stops watching a real folder, and survives a re-scan", async () => {
    const { call, workspace, audit } = await makeApp({ scenario: "calm" });
    await adoptFake(call);
    const dir = realFolder();

    const added = await call("POST", "/api/storage/locations", { path: dir });
    expect(added.statusCode).toBe(201);
    const location = added.json<{ id: string; label: string }>();
    expect(location.label).toBe("Movies");

    const listing = (
      await call("GET", `/api/storage/${location.id}/browse?path=Metropolis%20(1927)`)
    ).json<FolderListing>();
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: "Metropolis (1927).mkv", kind: "file", sizeBytes: 1234 }),
    ]);
    expect((await audit())[0]?.action).toBe(`Started watching ${dir}`);

    expect((await call("POST", "/api/storage/locations", { path: dir })).statusCode).toBe(409);

    await adoptFake(call); // scan again
    expect((await workspace()).storageLocations.map((l) => l.id)).toEqual([location.id]);

    expect((await call("DELETE", `/api/storage/locations/${location.id}`)).statusCode).toBe(204);
    expect((await workspace()).storageLocations).toEqual([]);
    expect((await audit())[0]?.action).toBe(`Stopped watching ${dir}`);
  });

  it("validates new locations", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    await adoptFake(call);
    const dir = realFolder();
    expect(
      (await call("POST", "/api/storage/locations", { path: "relative/folder" })).statusCode,
    ).toBe(400);
    expect(
      (await call("POST", "/api/storage/locations", { path: path.join(dir, "nope") })).statusCode,
    ).toBe(400);
    const fileRes = await call("POST", "/api/storage/locations", {
      path: path.join(dir, "Metropolis (1927)", "Metropolis (1927).mkv"),
    });
    expect(fileRes.statusCode).toBe(400);
    expect(fileRes.json().message).toContain("is a file");
  });
});

describe("drive health", () => {
  it("shows sample drives with full detail in demo mode, and refuses a live refresh there", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    const ws = await workspace();
    expect(ws.disks.filter((d) => d.hostId === "atlas")).toHaveLength(4);
    expect(ws.disks.every((d) => d.temperatureC !== undefined)).toBe(true);
    expect((await call("POST", "/api/storage/disks/refresh")).statusCode).toBe(409);
  });

  it("stores drives on adoption, types volumes from them, and refreshes on demand", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    expect(report.disks).toHaveLength(2);
    expect(report.host.volumes.find((v) => v.id === "testbox-root")?.kind).toBe("ssd");
    await call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: [{ key: report.findings[0]!.key, name: "x" }],
    });

    const ws = await workspace();
    expect(ws.disks.map((d) => d.model).sort()).toEqual(["Example NAS share", "Example NVMe 1TB"]);
    expect(ws.hosts[0]!.volumes.find((v) => v.id === "testbox-root")?.kind).toBe("ssd");

    const refreshed = await call("POST", "/api/storage/disks/refresh");
    expect(refreshed.statusCode).toBe(200);
    expect((await workspace()).disks).toHaveLength(2);
  });
});

describe("Ember and storage growth", () => {
  it("tells Ember how fast each drive is growing, from the same daily readings as the panel", async () => {
    const handle = await freshDb();
    const app = await makeApp({ handle, scenario: "calm", listen: true });
    const ws = await app.workspace();
    const v = ws.hosts.flatMap((h) => h.volumes)[0]!;
    await handle.db.delete(volumeUsageDaily);
    const DAY = 86_400_000;
    for (let d = 5; d >= 1; d--)
      await handle.db.insert(volumeUsageDaily).values({
        volumeId: v.id,
        day: new Date(Date.now() - d * DAY).toISOString().slice(0, 10),
        usedTb: v.usedTb - d * 0.05,
        totalTb: v.totalTb,
      });
    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("storage_overview", {});
      return "ok";
    };
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    const asked = await app.call("POST", "/api/agent/conversations", {
      text: "Which of my drives is filling up fastest?",
    });
    expect(asked.statusCode, asked.body).toBe(200);
    await app.agents.idle();
    const said = JSON.parse(answer) as {
      volumes: {
        id: string;
        volume: string;
        mount: string;
        growth: string;
        gbPerDay?: number;
        fullInDays?: number;
      }[];
    };
    const row = said.volumes.find((x) => x.volume === v.label)!;
    expect(row.gbPerDay).toBe(50);
    expect(row.growth).toMatch(/^Growing about 50 GB a day over 4 days/);
    expect(row.fullInDays).toBeGreaterThan(0);

    // What Ember is told matches what Storage > Health & History shows, drive by drive.
    const center = (await app.call("GET", "/api/storage-center")).json<{
      volumes: {
        id: string;
        label: string;
        mount: string;
        totalTb: number;
        usedTb: number;
        history: { day: string; usedTb: number }[];
      }[];
    }>();
    for (const shown of center.volumes) {
      const told = said.volumes.find((x) => x.id === shown.id);
      if (told) expect(told.growth).toBe(trend(shown.history, shown.totalTb, shown.usedTb).words);
    }
  });
});

describe("add-ons (the Premium split)", () => {
  const addonFolder = (dir: string, name: string, api: number, body = "") => {
    const root = path.join(dir, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name, hearth: { addon: "index.mjs" } }),
    );
    writeFileSync(
      path.join(root, "index.mjs"),
      body ||
        `export const addon = {
  name: ${JSON.stringify(name)},
  version: "1.0.0",
  api: ${api},
  features: ["curator_for_you"],
  register(host) {
    host.app.get("/api/addons/${name}/hello", async () => ({
      hello: "from the add-on",
      forYou: await host.has("curator_for_you"),
    }));
    host.tools((server) => {
      server.registerTool("${name.replace(/-/g, "_")}_hello", { description: "Says hello." }, async () => ({
        content: [{ type: "text", text: "Hello from the add-on tool." }],
      }));
    });
  },
};`,
    );
  };

  it("loads an add-on's routes and Ember tools, and skips broken or mismatched ones without failing", async () => {
    const dir = tempDir();
    addonFolder(dir, "demo-premium", 1);
    addonFolder(dir, "old-premium", 99);
    addonFolder(
      dir,
      "broken",
      1,
      "export const addon = { register() { throw new Error('boom'); }, api: 1 };",
    );
    const app = await makeApp({ scenario: "calm", listen: true, addonsDir: dir });

    const list = (await app.call("GET", "/api/addons")).json<{
      loaded: { name: string; features: string[] }[];
      skipped: { folder: string; why: string }[];
    }>();
    expect(list.loaded.map((a) => a.name)).toEqual(["demo-premium"]);
    expect(list.skipped.find((x) => x.folder === "old-premium")!.why).toMatch(/version 99/);
    expect(list.skipped.find((x) => x.folder === "broken")!.why).toMatch(/boom/);

    const hello = (await app.call("GET", "/api/addons/demo-premium/hello")).json<{
      hello: string;
      forYou: boolean;
    }>();
    expect(hello.hello).toBe("from the add-on");
    expect(hello.forYou).toBe(false);

    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("demo_premium_hello", {});
      return "ok";
    };
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    await app.call("POST", "/api/agent/conversations", { text: "Say hello" });
    await app.agents.idle();
    expect(answer).toContain("Hello from the add-on tool.");
  });

  it("runs complete with no add-ons installed", async () => {
    const app = await makeApp({ scenario: "calm", addonsDir: path.join(tempDir(), "none") });
    expect((await app.call("GET", "/api/addons")).json()).toEqual({ loaded: [], skipped: [] });
    expect((await app.call("GET", "/api/health")).statusCode).toBe(200);
  });
});

describe("Free Ember (11-14)", () => {
  it("without Show & Tell or Panel Builder she has neither tool nor instructions for them, and says so in one line", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    let tools: string[] = [];
    agentScript = async ({ list }) => {
      tools = await list();
      return "ok";
    };
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    await app.call("POST", "/api/agent/conversations", { text: "Show me where my backups are" });
    await app.agents.idle();
    expect(tools).not.toContain("show");
    expect(tools).not.toContain("panel_builder");
    expect(tools).toContain("hearth_help");
    const system = agentRuns.at(-1)!.system!;
    expect(system).not.toMatch(/with show, open|the show tool is your cursor/);
    expect(system).toContain("Show & Tell is a Premium extra, so here it is in words");
    expect(system).toContain("custom panels are a Premium extra");
    expect(system.match(/Premium extra/g)!.length).toBeLessThanOrEqual(4);

    // With the licence, both are back and the one-liners are gone.
    await givePremium(app.handle, {
      features: ["hearth_interconnectivity", "ember_show_and_tell", "panel_builder"],
    });
    await app.call("POST", "/api/agent/conversations", { text: "Build me a better panel" });
    await app.agents.idle();
    // Their tools come with the Premium package: a licence alone adds nothing.
    if (PREMIUM_PACKAGE) {
      expect(tools).toEqual(expect.arrayContaining(["show", "tidy_screen", "panel_builder"]));
      expect(agentRuns.at(-1)!.system).not.toContain("so here it is in words");
      expect(agentRuns.at(-1)!.system).not.toContain("custom panels are a Premium extra");
    } else {
      expect(tools).not.toContain("show");
      expect(agentRuns.at(-1)!.system).toContain("so here it is in words");
    }
  });
});

describe("Ember guessing a Hearth address", () => {
  it("gets the real addresses closest to a wrong guess, not a bare not found", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("hearth_api", { method: "GET", path: "/api/storage/history" });
      return "ok";
    };
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    await app.call("POST", "/api/agent/conversations", { text: "Which drive grows fastest?" });
    await app.agents.idle();
    const said = JSON.parse(answer.split("\n(cite")[0]!) as {
      status: number;
      answer: { closest: string[]; next: string };
    };
    expect(said.status).toBe(404);
    expect(said.answer.closest).toContain("/api/storage-center");
    expect(said.answer.next).toMatch(/Never read Hearth's source code/);
  });

  it("is told which methods a real address takes when it used the wrong one", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    let answer = "";
    agentScript = async ({ call }) => {
      // 11-15, the owner's Plex: PATCH on a saved home row, which only takes PUT and DELETE.
      answer = await call("hearth_api", {
        method: "PATCH",
        path: "/api/home-rows/c5f1c3dd-8f59-4faa-8706-462a8b45742c",
        body: JSON.stringify({ titles: ["103"] }),
      });
      return "ok";
    };
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    await app.call("POST", "/api/agent/conversations", { text: "Add High Life to Space Night" });
    await app.agents.idle();
    const said = JSON.parse(answer.split("\n(cite")[0]!) as {
      status: number;
      answer: { methods: string[]; message: string };
    };
    expect(said.status).toBe(404);
    expect(said.answer.methods).toEqual(["DELETE", "PUT"]);
    expect(said.answer.message).toMatch(/takes DELETE, PUT/);
  });
});

describe("another machine, over the network", () => {
  afterEach(() => fakeOutages.restoreAll());

  async function addWindowsPc(env: Awaited<ReturnType<typeof realEnvironment>>) {
    const scan = await env.call("POST", "/api/discovery/scan-remote", {
      address: "10.0.0.20",
      name: "Windows PC",
    });
    expect(scan.statusCode).toBe(200);
    const report = scan.json<DiscoveryReport>();
    const adopt = await env.call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings.map((f) => ({ key: f.key, name: f.name })),
    });
    expect(adopt.statusCode).toBe(200);
    return report;
  }

  it("finds well-known apps at an address and adds them without touching this machine", async () => {
    const env = await realEnvironment();
    const before = await env.workspace();
    const report = await addWindowsPc(env);

    // Plex answers on the network; Syncthing only listens to its own machine, so it is not seen.
    expect(report.host).toMatchObject({ id: "windows-pc", connection: "network" });
    expect(report.findings.map((f) => f.name)).toEqual(["Plex"]);
    expect(report.findings[0]).toMatchObject({
      key: "remote:windows-pc:plex",
      localUrl: "http://10.0.0.20:32400",
    });

    const ws = await env.workspace();
    expect(ws.hosts.map((h) => h.name).sort()).toEqual(["Windows PC", "testbox"]);
    expect(ws.services).toHaveLength(before.services.length + 1);
    const plex = ws.services.find((s) => s.id === "windows-pc-plex")!;
    expect(plex).toMatchObject({ hostId: "windows-pc", kind: "process" });

    // Rescanning this machine leaves the other machine's services alone, and vice versa.
    const local = (await env.call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    await env.call("POST", "/api/discovery/adopt", {
      reportId: local.id,
      selections: local.findings
        .filter((f) => f.selectedByDefault && f.sourceName !== "photos_db")
        .map((f) => ({ key: f.key, name: f.name })),
    });
    expect((await env.workspace()).services.some((s) => s.id === "windows-pc-plex")).toBe(true);
    await addWindowsPc(env);
    expect((await env.workspace()).services).toHaveLength(before.services.length + 1);
    // Integrations still describe the machine Hearth runs on.
    expect((await env.workspace()).integrations.find((i) => i.id === "docker")?.status).toBe(
      "connected",
    );
  });

  it("checks the other machine's apps, reports its health, and never restarts them", async () => {
    const env = await realEnvironment();
    await addWindowsPc(env);
    await env.check();
    expect((await env.workspace()).hosts.find((h) => h.id === "windows-pc")?.health).toBe(
      "healthy",
    );

    fakeOutages.failUrl("http://10.0.0.20:32400");
    await env.check();
    await env.check();
    const ws = await env.workspace();
    expect(ws.hosts.find((h) => h.id === "windows-pc")?.health).toBe("offline");
    expect(ws.incidents.some((i) => i.serviceId === "windows-pc-plex")).toBe(true);
    expect(fakeOutages.restarts()).toEqual([]);

    const restart = await env.call("POST", "/api/actions", {
      kind: "restart-container",
      serviceId: "windows-pc-plex",
    });
    expect(JSON.stringify(restart.json())).toContain("not a container");
    expect(fakeOutages.restarts()).toEqual([]);
  });

  it("explains a bad address, a clash with this machine, and an address where nothing answers", async () => {
    const env = await realEnvironment();
    for (const address of ["http://10.0.0.20", "10.0.0.20:32400", "a b", ""]) {
      const res = await env.call("POST", "/api/discovery/scan-remote", { address, name: "PC" });
      expect(res.statusCode, address).toBe(400);
    }
    const clash = await env.call("POST", "/api/discovery/scan-remote", {
      address: "10.0.0.5",
      name: "testbox",
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toContain("runs on");

    const quiet = await env.call("POST", "/api/discovery/scan-remote", {
      address: "nothing.example",
      name: "Empty",
    });
    // The fake answers the same everywhere except loopback-only ports, so check the shape only.
    expect(quiet.statusCode).toBe(200);
    expect(quiet.json<DiscoveryReport>().host.connection).toBe("network");

    // Remote scans are owner-only, never for access keys.
    const { key } = (
      await env.call("POST", "/api/keys", { name: "HA", scopes: ["read", "act"] })
    ).json<{ key: string }>();
    const viaKey = await env.send(
      "POST",
      "/api/discovery/scan-remote",
      { address: "10.0.0.20", name: "PC" },
      undefined,
      { authorization: `Bearer ${key}` },
    );
    expect(viaKey.statusCode).toBe(403);
  });
});

describe("homelab memory", () => {
  afterEach(() => fakeOutages.restoreAll());

  it("saves memories at once, keeps every version, and restores deleted ones", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const project = (
      await call("POST", "/api/memory/projects", {
        name: "Homeserver migration",
        summary: "Docker moves to Linux.",
      })
    ).json<MemoryProject>();
    expect(project.id).toBe("homeserver-migration");

    const created = await call("POST", "/api/memory/entries", {
      kind: "thread",
      title: "Jellyfin not reachable from Homeserver",
      body: "Port 8096 did not answer.",
      projectId: project.id,
      machine: "Homeserver",
    });
    expect(created.statusCode).toBe(201);
    const entry = created.json<MemoryEntry>();
    expect(entry).toMatchObject({
      status: "open",
      source: "you",
      basis: "stated",
      machine: "Homeserver",
    });

    const edited = await call("PATCH", `/api/memory/entries/${entry.id}`, {
      title: "Jellyfin moved to Homeserver",
      status: "done",
      basis: "observed",
      verification: { at: "2026-10-08T10:00:00Z", check: "curl :8096", result: "302" },
    });
    expect(edited.json<MemoryEntry>()).toMatchObject({ status: "done", basis: "observed" });
    const detail = (await call("GET", `/api/memory/entries/${entry.id}`)).json<{
      entry: MemoryEntry;
      history: MemoryRevision[];
    }>();
    expect(detail.history.map((h) => h.action)).toEqual(["edited", "created"]);
    // The previous version is kept word for word.
    expect(detail.history[0]!.snapshot.title).toBe("Jellyfin not reachable from Homeserver");
    expect((await call("GET", "/api/memory/projects")).json<MemoryProject[]>()[0]).toMatchObject({
      entries: 1,
      openThreads: 0,
    });

    expect((await call("DELETE", `/api/memory/entries/${entry.id}`)).statusCode).toBe(204);
    expect((await call("GET", "/api/memory/entries")).json<MemoryEntry[]>()).toEqual([]);
    expect((await call("GET", "/api/memory/search?q=jellyfin")).json()).toEqual([]);
    const deleted = (await call("GET", "/api/memory/entries?view=deleted")).json<MemoryEntry[]>();
    expect(deleted.map((e) => e.id)).toEqual([entry.id]);
    expect(
      (await call("PATCH", `/api/memory/entries/${entry.id}`, { title: "x" })).statusCode,
    ).toBe(409);

    expect((await call("POST", `/api/memory/entries/${entry.id}/restore`)).statusCode).toBe(200);
    expect(
      (await call("GET", "/api/memory/search?q=jellyfin")).json<MemorySearchHit[]>(),
    ).toHaveLength(1);
    const history = (await call("GET", `/api/memory/entries/${entry.id}`)).json<{
      history: MemoryRevision[];
    }>().history;
    expect(history.map((h) => h.action)).toEqual(["restored", "deleted", "edited", "created"]);

    // Gone for good only from Recently deleted.
    expect((await call("DELETE", `/api/memory/entries/${entry.id}/forever`)).statusCode).toBe(409);
    await call("DELETE", `/api/memory/entries/${entry.id}`);
    expect((await call("DELETE", `/api/memory/entries/${entry.id}/forever`)).statusCode).toBe(204);
    expect((await call("GET", `/api/memory/entries/${entry.id}`)).statusCode).toBe(404);
  });

  it("searches memories, saved transcripts, and conversations, and marks the matches", async () => {
    const { call, handle } = await makeApp({ scenario: "calm" });
    await call("POST", "/api/memory/entries", {
      kind: "journal",
      title: "Fixed RomM's crash loop",
      body: "A 600 MB Valkey dump took longer to load than RomM waits at startup.",
    });
    const tr = (
      await call("POST", "/api/memory/transcripts", {
        client: "claude-code",
        title: "Homeserver firewall session",
        machine: "ai-box",
      })
    ).json<Transcript>();
    await call("POST", `/api/memory/transcripts/${tr.id}/messages`, {
      messages: [
        { role: "you", text: "Why did we leave the firewall alone?" },
        {
          role: "ai",
          text: "Because Tailscale Serve already covers remote access, so opening ports adds risk.",
        },
      ],
    });
    handle.sqlite.exec(`
      INSERT INTO conversations (id, source, title, status, created_at, updated_at)
        VALUES ('c1', 'voice', 'Plex is down', 'idle', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');
      INSERT INTO conversation_messages (conversation_id, role, text, at)
        VALUES ('c1', 'you', 'Tell Claude Plex is buffering again', '2026-10-01T10:00:00Z');
    `);

    const search = async (q: string) =>
      (await call("GET", `/api/memory/search?q=${encodeURIComponent(q)}`)).json<
        MemorySearchHit[]
      >();
    const valkey = await search("valkey");
    expect(valkey).toHaveLength(1);
    expect(valkey[0]).toMatchObject({
      type: "entry",
      title: "Fixed RomM's crash loop",
      kind: "journal",
    });
    expect(valkey[0]!.snippet).toContain("[[Valkey]]");

    // Word forms match ("ports" finds "port"), so the reasoning is found by its gist.
    const why = await search("open port");
    expect(why[0]).toMatchObject({
      type: "transcript",
      id: tr.id,
      seq: 2,
      title: "Homeserver firewall session",
    });
    expect(await search("buffer")).toMatchObject([
      { type: "conversation", id: "c1", seq: 1, title: "Plex is down" },
    ]);
    // Typing a prefix finds the word.
    expect(await search("crash lo")).toHaveLength(1);

    // Search syntax never reaches the index unescaped.
    for (const q of ['"', "NEAR(", "title:x", "a OR", ")*(", "-"]) {
      expect(
        (await call("GET", `/api/memory/search?q=${encodeURIComponent(q)}`)).statusCode,
        q,
      ).toBe(200);
    }
    expect(await search("   ")).toEqual([]);

    // Deleting a conversation takes it out of search too.
    handle.sqlite.exec("DELETE FROM conversations WHERE id = 'c1'");
    expect(await search("buffer")).toEqual([]);
  });

  it("saves transcripts as they happen, without duplicates when a client resends", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const start = { client: "claude-code", title: "Homelab session", sessionRef: "abc-123" };
    const first = (await call("POST", "/api/memory/transcripts", start)).json<Transcript>();
    const again = (await call("POST", "/api/memory/transcripts", start)).json<Transcript>();
    expect(again.id).toBe(first.id);

    const append = async (messages: unknown[]) =>
      (await call("POST", `/api/memory/transcripts/${first.id}/messages`, { messages })).json<{
        added: number;
        skipped: number;
        lastSeq: number;
      }>();
    expect(
      await append([
        { seq: 1, role: "you", text: "one" },
        { seq: 2, role: "ai", text: "two" },
      ]),
    ).toEqual({
      added: 2,
      skipped: 0,
      lastSeq: 2,
    });
    // After a dropped connection the client resends from 2: only 3 is new.
    expect(
      await append([
        { seq: 2, role: "ai", text: "two" },
        { seq: 3, role: "you", text: "three" },
      ]),
    ).toEqual({
      added: 1,
      skipped: 1,
      lastSeq: 3,
    });
    expect((await append([{ role: "note", text: "four" }])).lastSeq).toBe(4);
    await call("POST", `/api/memory/transcripts/${first.id}/end`);

    const saved = (await call("GET", `/api/memory/transcripts/${first.id}`)).json<{
      transcript: Transcript;
      messages: TranscriptMessage[];
    }>();
    expect(saved.transcript).toMatchObject({ messageCount: 4, sessionRef: "abc-123" });
    expect(saved.transcript.endedAt).toBeTruthy();
    expect(saved.messages.map((m) => m.text)).toEqual(["one", "two", "three", "four"]);
    expect((await call("GET", "/api/memory/transcripts")).json<Transcript[]>()).toHaveLength(1);
  });

  it("checks what it is given, and is for you only", async () => {
    const { call, send } = await makeApp({ scenario: "calm" });
    for (const body of [
      { kind: "diary", title: "x" },
      { kind: "note", title: "" },
      { kind: "note", title: "x", projectId: "no-such-project" },
      { kind: "note", title: "x", happenedAt: "yesterday-ish" },
      { kind: "note", title: "x", secret: "nope" },
    ]) {
      expect(
        (await call("POST", "/api/memory/entries", body)).statusCode,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await call("GET", "/api/memory/entries/nope")).statusCode).toBe(404);

    const { key } = (
      await call("POST", "/api/keys", {
        name: "HA",
        scopes: ["read", "converse", "approve", "act"],
      })
    ).json<{ key: string }>();
    for (const [method, url] of [
      ["GET", "/api/memory/entries"],
      ["GET", "/api/memory/search?q=x"],
      ["POST", "/api/memory/entries"],
      ["GET", "/api/backups"],
      ["POST", "/api/backups/run"],
    ] as const) {
      const res = await send(method, url, method === "POST" ? {} : undefined, undefined, {
        authorization: `Bearer ${key}`,
      });
      expect(res.statusCode, url).toBe(403);
      expect((await send(method, url, method === "POST" ? {} : undefined)).statusCode, url).toBe(
        401,
      );
    }
  });

  it("remembers Hearth's own fixes and discoveries on your systems, never sample data", async () => {
    const env = await realEnvironment();
    const journal = async () =>
      (await env.call("GET", "/api/memory/entries?kind=journal")).json<MemoryEntry[]>();
    const [discovered] = await journal();
    expect(discovered).toMatchObject({
      source: "dragon-control",
      basis: "observed",
      machine: "testbox",
    });
    expect(discovered!.title).toMatch(/^Added \d+ services on testbox to Hearth$/);

    await env.call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    await env.call("PATCH", "/api/settings", { liveRepairs: true });
    fakeOutages.stopContainer("sonarr");
    await env.check();
    await env.check();
    await env.runner.idle();
    const fixed = (await journal()).find((e) => e.links.some((l) => l.ref.startsWith("incident:")));
    expect(fixed).toBeDefined();
    expect(fixed!.body).toMatch(/on its own, and verified by Hearth's own check/);
    expect(fixed!.links.map((l) => l.label)).toContain("Sonarr");

    // Practice repairs on sample data are not memories.
    const demo = await makeApp({ scenario: "calm" });
    const service = (await demo.workspace()).services[0]!;
    await demo.call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    await demo.call("POST", "/api/demo/simulate", { serviceId: service.id, condition: "down" });
    await demo.call("POST", "/api/monitor/run");
    await demo.call("POST", "/api/monitor/run");
    await demo.runner.idle();
    expect((await demo.workspace()).incidents.some((i) => i.serviceId === service.id)).toBe(true);
    expect((await demo.call("GET", "/api/memory/entries")).json()).toEqual([]);
  });
});

describe("importing existing notes, with you deciding", () => {
  const entryDraft = (n: number, extra: Record<string, unknown> = {}) => ({
    sourceRef: `md:test-entry-${n}`,
    origin: "/notes/Media/STATE.md",
    anchor: `Section ${n}`,
    note: "dated section",
    payload: {
      kind: "entry",
      entry: {
        kind: "journal",
        title: `Moved service ${n}`,
        body: `Notes ${n}. The admin password is Hunter2! and the API key was \`abc123\`.`,
        happenedAt: "2026-08-20T20:57:00.000Z",
        projectName: "Media server",
        author: "Codex",
        ...extra,
      },
    },
  });
  const projectDraft = {
    sourceRef: "md:test-project",
    origin: "/notes/Media/STATE.md",
    anchor: "project",
    payload: { kind: "project", project: { name: "Media server", summary: "Plex and friends." } },
  };
  const sessionDraft = (messages: { seq: number; role: string; text: string }[]) => ({
    sourceRef: "session:claude-code:abc",
    origin: "/home/me/.claude/projects/x/abc.jsonl",
    anchor: "session",
    payload: {
      kind: "session",
      session: { client: "claude-code", title: "Fix Plex", sessionRef: "abc", messages },
    },
  });

  async function setup() {
    const env = await makeApp({ scenario: "calm" });
    const key = (
      await env.call("POST", "/api/keys", { name: "Importer", scopes: ["memory"] })
    ).json<{ key: string }>().key;
    const asKey = (method: Method, url: string, body?: unknown) =>
      env.send(method, url, body, undefined, {
        authorization: `Bearer ${key}`,
        "x-dc-client": "Claude Code on test",
      });
    const pending = async () =>
      (await env.call("GET", "/api/memory/imports?status=pending")).json<ImportDraft[]>();
    return { ...env, asKey, pending };
  }

  it("keeps imports as drafts until you accept them, hiding secrets first", async () => {
    const { call, asKey, pending } = await setup();
    const proposed = await asKey("POST", "/api/memory/imports", {
      batch: "First import",
      drafts: [projectDraft, entryDraft(1), entryDraft(2)],
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    expect(proposed.json()).toEqual({ added: 3, refreshed: 0, kept: 0, appended: 0 });

    // Nothing is memory yet.
    expect((await call("GET", "/api/memory/entries")).json<MemoryEntry[]>()).toEqual([]);
    expect((await call("GET", "/api/memory/imports/summary")).json<ImportSummary>()).toMatchObject({
      pending: 3,
      accepted: 0,
      batches: [{ batch: "First import", pending: 3, total: 3 }],
    });
    const drafts = await pending();
    const one = drafts.find((d) => d.sourceRef === "md:test-entry-1")!;
    const body = (one.payload as { entry: { body: string } }).entry.body;
    expect(body).not.toContain("Hunter2");
    expect(body).not.toContain("abc123");
    expect(body).toContain("password is [hidden]");

    // The importer may propose, but only you decide.
    expect((await asKey("POST", `/api/memory/imports/${one.id}/accept`, {})).statusCode).toBe(403);
    expect(
      (await asKey("POST", "/api/memory/imports/decide", { ids: [one.id], decision: "accept" }))
        .statusCode,
    ).toBe(403);

    // Accept with an edit: the entry lands in its project, labelled as imported.
    const accepted = await call("POST", `/api/memory/imports/${one.id}/accept`, {
      edits: { title: "Moved Plex to Homeserver", kind: "win" },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const draft = accepted.json<ImportDraft>();
    expect(draft.status).toBe("accepted");
    const entry = (await call("GET", `/api/memory/entries/${draft.resultId}`)).json<{
      entry: MemoryEntry;
    }>().entry;
    expect(entry).toMatchObject({
      title: "Moved Plex to Homeserver",
      kind: "win",
      source: "import",
      author: "Codex, imported",
      basis: "documented",
      happenedAt: "2026-08-20T20:57:00.000Z",
      projectId: "media-server",
    });
    expect(entry.links[0]!.ref).toBe("file:/notes/Media/STATE.md#Section 1");
    // Accepting again changes nothing.
    await call("POST", `/api/memory/imports/${one.id}/accept`, {});
    expect((await call("GET", "/api/memory/entries")).json<MemoryEntry[]>()).toHaveLength(1);

    // Many at once: projects go first so entries attach to them.
    const rest = (await pending()).map((d) => d.id);
    expect(
      (await call("POST", "/api/memory/imports/decide", { ids: rest, decision: "accept" })).json(),
    ).toEqual({ done: 2, skipped: 0 });
    const projects = (await call("GET", "/api/memory/projects")).json<MemoryProject[]>();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      name: "Media server",
      summary: "Plex and friends.",
      entries: 2,
    });
  });

  it("re-running an import refreshes what is pending and keeps what you decided", async () => {
    const { call, asKey, pending } = await setup();
    await asKey("POST", "/api/memory/imports", {
      batch: "Run 1",
      drafts: [entryDraft(1), entryDraft(2)],
    });
    const [a, b] = await pending();
    await call("POST", `/api/memory/imports/${a!.id}/reject`);
    expect((await call("POST", `/api/memory/imports/${a!.id}/accept`)).statusCode).toBe(200);
    await call("POST", `/api/memory/imports/${b!.id}/reject`);
    // An accepted draft cannot be rejected afterwards.
    expect((await call("POST", `/api/memory/imports/${a!.id}/reject`)).statusCode).toBe(409);

    const again = await asKey("POST", "/api/memory/imports", {
      batch: "Run 2",
      drafts: [entryDraft(1, { title: "Changed" }), entryDraft(2), entryDraft(3)],
    });
    expect(again.json()).toEqual({ added: 1, refreshed: 0, kept: 2, appended: 0 });
    expect((await pending()).map((d) => d.sourceRef)).toEqual(["md:test-entry-3"]);

    // A rejected draft can be reconsidered; a pending one is refreshed in place.
    expect((await call("POST", `/api/memory/imports/${b!.id}/reopen`)).statusCode).toBe(200);
    await asKey("POST", "/api/memory/imports", {
      batch: "Run 3",
      drafts: [entryDraft(2, { title: "Renamed" })],
    });
    const reopened = (await call("GET", `/api/memory/imports/${b!.id}`)).json<ImportDraft>();
    expect(reopened).toMatchObject({ status: "pending", batch: "Run 3" });
    expect((reopened.payload as { entry: { title: string } }).entry.title).toBe("Renamed");
    expect((await call("POST", `/api/memory/imports/${a!.id}/reopen`)).statusCode).toBe(409);
  });

  it("imports a past session word for word and adds what was said since", async () => {
    const { call, asKey, pending } = await setup();
    const said = [
      { seq: 1, role: "you", text: "Plex is buffering" },
      { seq: 2, role: "ai", text: "The transcoder was on the slow disk." },
      { seq: 3, role: "you", text: "move it" },
      { seq: 4, role: "ai", text: "Done." },
    ];
    await asKey("POST", "/api/memory/imports", { batch: "Sessions", drafts: [sessionDraft(said)] });
    const [draft] = await pending();
    // The list shows a preview; the draft itself has every message.
    expect(draft).toMatchObject({ messageCount: 4 });
    expect((draft!.payload as { session: { messages: unknown[] } }).session.messages).toHaveLength(
      3,
    );
    const accepted = (
      await call("POST", `/api/memory/imports/${draft!.id}/accept`)
    ).json<ImportDraft>();
    const tr = (await call("GET", `/api/memory/transcripts/${accepted.resultId}`)).json<{
      messages: { seq: number; text: string }[];
    }>();
    expect(tr.messages.map((m) => m.text)).toEqual(said.map((m) => m.text));

    const more = [...said, { seq: 5, role: "you", text: "thanks" }];
    const again = await asKey("POST", "/api/memory/imports", {
      batch: "Sessions",
      drafts: [sessionDraft(more)],
    });
    expect(again.json()).toMatchObject({ appended: 1, added: 0 });
    const after = (await call("GET", `/api/memory/transcripts/${accepted.resultId}`)).json<{
      messages: unknown[];
    }>();
    expect(after.messages).toHaveLength(5);
  });

  it("hides passwords written in sentences, and leaves ordinary words alone", () => {
    const cases: [string, string][] = [
      ["the Plex password is Hunter2! ok", "the Plex password is [hidden] ok"],
      ["API key was `abc123`.", "API key was `[hidden]`."],
      ["PIN set to 4821", "PIN set to [hidden]"],
      ["password for the NAS admin is 'tr0ub4dor'", "password for the NAS admin is '[hidden]'"],
      ["I set the password to `wallet99#` yesterday", "I set the password to `[hidden]` yesterday"],
      ["the new password (`summer24!`) works", "the new password (`[hidden]`) works"],
      ["login admin, password summer99# for now", "login admin, password [hidden] for now"],
      // Inside saved JSON the quotes arrive escaped.
      ['{\\"api-key\\": \\"12ab_cd_e1f2345678g90123\\"}', '{\\"api-key\\": \\"[hidden]\\"}'],
    ];
    for (const [input, expected] of cases) expect(redactTranscript(input), input).toBe(expected);
    for (const keep of [
      "the password is stored in the vault",
      "the token is expired",
      "password reset on 2026-10-04 via the web UI",
      "pin the window to C:\\Tools\\app.exe",
      "the password file lives at /etc/app/secrets.yml",
    ]) {
      expect(redactTranscript(keep), keep).toBe(keep);
    }
  });

  it("sorts drafts against your real systems and keeps older setup as history", async () => {
    const { call, asKey, handle, pending } = await setup();
    // Checked against your real systems only; the sample homelab stands in for them here.
    await setSetting(handle.db, "environment", "real");
    const doc = (n: number, kind: string, body: string, extra: Record<string, unknown> = {}) => ({
      sourceRef: `md:triage-${n}`,
      origin: "/notes/Reference/Syncthing.md",
      anchor: n === 1 ? "whole file" : `Section ${n}`,
      note: n === 1 ? "reference document" : "section",
      payload: {
        kind: "entry",
        entry: { kind, title: `Syncthing notes ${n}`, body, projectName: "Homelab", ...extra },
      },
    });
    await asKey("POST", "/api/memory/imports", {
      batch: "Triage",
      drafts: [
        {
          ...doc(1, "note", "Runs natively on Windows: C:\\Syncthing\\syncthing.exe."),
          payload: {
            kind: "entry",
            entry: {
              kind: "note",
              title: "Syncthing",
              body: "Syncthing runs natively on Windows: C:\\Syncthing\\syncthing.exe.",
              projectName: "Homelab",
            },
          },
        },
        doc(2, "hardware", "Syncthing lives on Windows under C:\\Syncthing with the other tools."),
        doc(3, "hardware", "Syncthing on Windows keeps the notes folder in sync."),
        doc(4, "journal", "Installed Syncthing on Windows.", {
          happenedAt: "2026-08-01T12:00:00Z",
        }),
      ],
    });
    const drafts = await pending();
    const by = (n: number) => drafts.find((d) => d.sourceRef === `md:triage-${n}`)!;
    expect(by(1).triage).toMatchObject({ tier: "review" });
    expect(by(1).triage!.supersede).toMatch(/Syncthing on Windows.*Atlas/);
    expect(by(1).triage!.reasons[0]).toMatchObject({ kind: "conflict" });
    expect(by(4).triage).toMatchObject({ tier: "confident" });
    expect(by(4).triage!.supersede).toBeUndefined();

    // Accepted as history by default, as current only when you say so.
    const kept = (
      await call("POST", `/api/memory/imports/${by(1).id}/accept`, {})
    ).json<ImportDraft>();
    const asHistory = (await call("GET", `/api/memory/entries/${kept.resultId}`)).json<{
      entry: MemoryEntry;
    }>().entry;
    expect(asHistory.superseded?.reason).toMatch(/Syncthing on Windows/);
    const current = (
      await call("POST", `/api/memory/imports/${by(2).id}/accept`, { asCurrent: true })
    ).json<ImportDraft>();
    expect(
      (await call("GET", `/api/memory/entries/${current.resultId}`)).json<{ entry: MemoryEntry }>()
        .entry.superseded,
    ).toBeUndefined();
    // In bulk, the same default applies.
    await call("POST", "/api/memory/imports/decide", { ids: [by(3).id], decision: "accept" });

    // History never shows up as how things are now.
    const briefing = (await asKey("GET", "/api/companion/briefing")).json<CompanionBriefing>();
    expect(briefing.hardware.map((h) => h.title)).toEqual(["Syncthing notes 2"]);
    expect(briefing.vocabulary).toEqual(expect.arrayContaining(["Atlas", "Syncthing", "Homelab"]));

    // You can change your mind either way later.
    const revived = await call("PATCH", `/api/memory/entries/${kept.resultId}`, {
      superseded: null,
    });
    expect(revived.json<MemoryEntry>().superseded).toBeUndefined();
  });

  it("refuses drafts that are not well formed", async () => {
    const { asKey } = await setup();
    const bad = await asKey("POST", "/api/memory/imports", {
      batch: "x",
      drafts: [
        { ...entryDraft(1), payload: { kind: "entry", entry: { kind: "secret", title: "x" } } },
      ],
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("backups", () => {
  it("backs up everything, checks the copy, writes the readable export, and keeps a second copy", async () => {
    const { call, backupRoot } = await makeApp({ scenario: "calm" });
    await call("POST", "/api/memory/entries", {
      kind: "thread",
      title: "Move Caddy to Homeserver",
      body: "Eventually, after the arr stack settles.",
    });
    const tr = (
      await call("POST", "/api/memory/transcripts", { client: "claude-code", title: "Caddy plan" })
    ).json<Transcript>();
    await call("POST", `/api/memory/transcripts/${tr.id}/messages`, {
      messages: [{ role: "you", text: "Caddy moves last so nothing breaks twice." }],
    });
    const secret = "plaintext-that-must-never-leak-42";
    expect(
      (
        await call("POST", "/api/vault/secrets", {
          name: "Sonarr key",
          kind: "api-key",
          tier: "automation",
          value: secret,
        })
      ).statusCode,
    ).toBe(200);

    const record = (await call("POST", "/api/backups/run")).json<BackupRecord>();
    expect(record).toMatchObject({ ok: true, reason: "manual", copied: true });
    expect(record.detail).toMatch(/checked: 1 memories, 1 transcript messages/);

    const dir = path.join(backupRoot, "backups");
    const file = path.join(dir, record.file!);
    expect(
      readFileSync(path.join(backupRoot, "second-copy", record.file!)).equals(readFileSync(file)),
    ).toBe(true);
    expect(readFileSync(file).includes(secret)).toBe(false);

    const exportDir = path.join(dir, "memory-export");
    expect(readFileSync(path.join(exportDir, "threads.md"), "utf8")).toContain(
      "### Move Caddy to Homeserver",
    );
    const transcriptFiles = readdirSync(path.join(exportDir, "transcripts"));
    expect(transcriptFiles).toHaveLength(1);
    expect(
      readFileSync(path.join(exportDir, "transcripts", transcriptFiles[0]!), "utf8"),
    ).toContain("Caddy moves last so nothing breaks twice.");
    const everything = readdirSync(exportDir, { recursive: true })
      .map((f) => path.join(exportDir, String(f)))
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    expect(everything).not.toContain(secret);
    expect(readdirSync(dir)).not.toContain("vault.key");

    const status = (await call("GET", "/api/backups")).json<BackupStatus>();
    expect(status.lastOk?.file).toBe(record.file);
    expect(status.files.map((f) => f.name)).toEqual([record.file]);
  });

  it("restores: a backup opens as a working Hearth database", async () => {
    const { call, backupRoot } = await makeApp({ scenario: "calm" });
    await call("POST", "/api/memory/entries", {
      kind: "win",
      title: "Whole arr stack green for a week",
    });
    const record = (await call("POST", "/api/backups/run")).json<BackupRecord>();

    const restored = path.join(tempDir(), "dragon-control.db");
    copyFileSync(path.join(backupRoot, "backups", record.file!), restored);
    const handle = openDatabase(restored);
    cleanup.push(() => handle.close());
    await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
    const memory = new Memory(handle);
    expect((await memory.list()).map((e) => e.title)).toEqual(["Whole arr stack green for a week"]);
    expect(await memory.search("arr stack")).toHaveLength(1);
  });

  it("runs once a day after 3 in the morning and keeps the newest few", async () => {
    let now = new Date(2026, 9, 8, 10, 0, 0);
    const { backups, backupRoot } = await makeApp({ scenario: "calm", clock: () => now });
    expect(await backups.due()).toBe(true); // never backed up
    await backups.tick();
    expect(await backups.due()).toBe(false);
    now = new Date(2026, 9, 8, 23, 0, 0);
    expect(await backups.due()).toBe(false);
    now = new Date(2026, 9, 9, 2, 59, 0);
    expect(await backups.due()).toBe(false);
    now = new Date(2026, 9, 9, 3, 1, 0);
    expect(await backups.due()).toBe(true);

    for (let i = 0; i < 5; i++) {
      now = new Date(2026, 9, 10 + i, 3, 30, 0);
      expect((await backups.run("scheduled")).ok).toBe(true);
    }
    for (const where of ["backups", "second-copy"]) {
      const files = readdirSync(path.join(backupRoot, where)).filter((f) => f.endsWith(".db"));
      expect(files.sort(), where).toEqual([
        "dragon-control-2026-10-12-033000.db",
        "dragon-control-2026-10-13-033000.db",
        "dragon-control-2026-10-14-033000.db",
      ]);
    }
  });

  it("never keeps a backup that fails its check", async () => {
    const { handle, runner, backupRoot } = await makeApp({ scenario: "calm" });
    const dir = path.join(backupRoot, "strict");
    const strict = new Backups(handle, runner.memory!, {
      dir,
      keep: 3,
      keyDir: dir,
      verify: () => ({ ok: false, detail: "integrity check: page 3 is never used" }),
    });
    const record = await strict.run("manual");
    expect(record.ok).toBe(false);
    expect(record.detail).toContain("page 3 is never used");
    expect(readdirSync(dir).filter((f) => f.includes(".db"))).toEqual([]);

    // The real check catches a damaged file.
    const damaged = path.join(dir, "damaged.db");
    writeFileSync(damaged, "SQLite format 3\0 but then nothing useful");
    expect(verifyBackup(damaged).ok).toBe(false);
  });

  it("records a failed backup plainly and waits an hour before trying again", async () => {
    let now = new Date(2026, 9, 8, 4, 0, 0);
    const { backups, backupRoot } = await makeApp({ scenario: "calm", clock: () => now });
    // Something that is not a folder where the backups should go.
    writeFileSync(path.join(backupRoot, "backups"), "not a folder");
    const failed = await backups.run("scheduled");
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/EEXIST|ENOTDIR|not a directory|file already exists/i);
    expect(await backups.due()).toBe(false);
    now = new Date(2026, 9, 8, 5, 1, 0);
    expect(await backups.due()).toBe(true);
    expect((await backups.status()).recent[0]).toMatchObject({ ok: false, reason: "scheduled" });
  });
});

describe("the Claude Code companion", () => {
  async function companionKey(call: Awaited<ReturnType<typeof makeApp>>["call"]) {
    return (await call("POST", "/api/keys", { name: "Claude Code", scopes: ["memory"] })).json<{
      key: string;
    }>().key;
  }

  it("reads and adds to the memory with its key, labelled as Claude, and never deletes", async () => {
    const { call, send } = await makeApp({ scenario: "calm" });
    const key = await companionKey(call);
    const as = (method: Method, url: string, body?: unknown) =>
      send(method, url, body, undefined, {
        authorization: `Bearer ${key}`,
        "x-dc-client": "Claude Code on GAMING-PC",
      });

    const saved = await as("POST", "/api/memory/entries", {
      kind: "thread",
      title: "Move Caddy to Homeserver",
      basis: "stated",
      clientRef: "11111111-2222-3333-4444-555555555555",
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json<MemoryEntry>()).toMatchObject({
      source: "ai",
      author: "Claude Code on GAMING-PC",
    });
    // Sent again after a dropped connection: the first copy stands.
    const again = await as("POST", "/api/memory/entries", {
      kind: "thread",
      title: "Move Caddy to Homeserver",
      basis: "stated",
      clientRef: "11111111-2222-3333-4444-555555555555",
    });
    expect(again.json<MemoryEntry>().id).toBe(saved.json<MemoryEntry>().id);
    expect((await call("GET", "/api/memory/entries")).json<MemoryEntry[]>()).toHaveLength(1);

    const id = saved.json<MemoryEntry>().id;
    expect((await as("PATCH", `/api/memory/entries/${id}`, { status: "done" })).statusCode).toBe(
      200,
    );
    expect((await as("GET", "/api/memory/search?q=caddy")).json<MemorySearchHit[]>()).toHaveLength(
      1,
    );
    for (const [method, url] of [
      ["DELETE", `/api/memory/entries/${id}`],
      ["DELETE", `/api/memory/entries/${id}/forever`],
      ["GET", "/api/vault"],
      ["GET", "/api/workspace"],
      ["GET", "/api/backups"],
      ["POST", "/api/backups/keys"],
      ["POST", "/api/actions"],
      ["GET", "/api/keys"],
    ] as const) {
      expect((await as(method, url, method === "POST" ? {} : undefined)).statusCode, url).toBe(403);
    }
    const history = (await call("GET", `/api/memory/entries/${id}`)).json<{
      history: MemoryRevision[];
    }>().history;
    expect(history.map((h) => [h.action, h.author])).toEqual([
      ["edited", "Claude Code on GAMING-PC"],
      ["created", "Claude Code on GAMING-PC"],
    ]);
  });

  it("gives a briefing: what needs you, what is new, open threads, projects, and live systems", async () => {
    const { call, send } = await makeApp({ scenario: "attention" });
    const key = await companionKey(call);
    const project = (
      await call("POST", "/api/memory/projects", { name: "Homeserver migration" })
    ).json<MemoryProject>();
    await call("POST", "/api/memory/entries", {
      kind: "thread",
      title: "Retire Docker Desktop",
      projectId: project.id,
    });
    await call("POST", "/api/memory/entries", {
      kind: "journal",
      title: "Plex moved to Homeserver",
      // Inside "the last week" whenever the test runs (a fixed date here expired on 2026-10-13).
      happenedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    await call("POST", "/api/memory/entries", {
      kind: "journal",
      title: "Old news",
      happenedAt: "2020-01-01T00:00:00Z",
    });
    await call("POST", "/api/memory/entries", {
      kind: "preference",
      title: "Confirm before moving files",
    });

    const res = await send(
      "GET",
      "/api/companion/briefing?since=2026-10-01T00:00:00Z",
      undefined,
      undefined,
      {
        authorization: `Bearer ${key}`,
      },
    );
    expect(res.statusCode).toBe(200);
    const b = res.json<CompanionBriefing>();
    expect(b.sampleData).toBe(true);
    expect(b.needsYou.length).toBeGreaterThan(0);
    expect(b.system.servicesTotal).toBeGreaterThan(0);
    // The last week, plus anything written since the client last looked (even about the past).
    expect(b.recent.map((e) => e.title)).toEqual(["Plex moved to Homeserver", "Old news"]);
    const later = (
      await send(
        "GET",
        `/api/companion/briefing?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
        undefined,
        undefined,
        {
          authorization: `Bearer ${key}`,
        },
      )
    ).json<CompanionBriefing>();
    expect(later.recent.map((e) => e.title)).toEqual(["Plex moved to Homeserver"]);
    expect(b.openThreads.map((e) => e.title)).toEqual(["Retire Docker Desktop"]);
    expect(b.projects).toMatchObject([{ name: "Homeserver migration", openThreads: 1 }]);
    expect(b.howYouWork.map((e) => e.title)).toEqual(["Confirm before moving files"]);
    expect(b.backups.offsite).toMatchObject({ name: "Home Vault", waiting: 0 });
  });

  it("hides anything that looks like a secret in saved sessions, and keeps the rest word for word", async () => {
    const { call } = await makeApp({ scenario: "calm" });
    const tr = (
      await call("POST", "/api/memory/transcripts", { client: "claude-code", title: "Keys" })
    ).json<Transcript>();
    const text = [
      "Use key dc_AbCdEfGhIjKlMnOpQrStUvWxYz012345 for Belle.",
      "Webhook https://discord.com/api/webhooks/123456789/AbCdEf-ghIJkl_mnOPqr",
      "password=hunter2 and Authorization: Bearer abcdefghijklmnop",
      "backup key 3q2+7w8vZXJ5X3NlY3JldF9rZXlfZm9yX3Rlc3RzMTIzNDU2Nzg=",
      "The Valkey dump in /srv/homelab/backups/dragon-control was 600 MB.",
    ].join("\n");
    await call("POST", `/api/memory/transcripts/${tr.id}/messages`, {
      messages: [{ role: "you", text }],
    });
    const saved = (await call("GET", `/api/memory/transcripts/${tr.id}`)).json<{
      messages: TranscriptMessage[];
    }>().messages[0]!.text;
    for (const secret of [
      "dc_AbCdEf",
      "AbCdEf-ghIJkl",
      "hunter2",
      "abcdefghijklmnop",
      "3q2+7w8vZXJ5",
    ]) {
      expect(saved, secret).not.toContain(secret);
    }
    expect(saved).toContain("The Valkey dump in /srv/homelab/backups/dragon-control was 600 MB.");
    expect(saved).toContain("https://discord.com/api/webhooks/[hidden]");
  });
});

describe("off-machine backups", () => {
  async function receipt(
    backupRoot: string,
    file: string,
    sha256: string,
    receivedAt = new Date().toISOString(),
  ) {
    const dir = path.join(backupRoot, "backups", "offsite-receipts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${file}.json`),
      JSON.stringify({ file, sha256, receivedAt, destination: "X:\\Backups\\Hearth" }),
    );
  }

  it("encrypts each backup for the other machine, and only the backup key opens it", async () => {
    const { call, backupRoot } = await makeApp({ scenario: "calm" });
    await call("POST", "/api/memory/entries", { kind: "win", title: "Encrypted and away" });
    const record = (await call("POST", "/api/backups/run")).json<BackupRecord>();
    expect(record.detail).toContain("encrypted for Home Vault");
    const outbox = path.join(backupRoot, "backups", "offsite-outbox");
    const encrypted = path.join(outbox, record.file!.replace(/\.db$/, ".dcbak"));
    const original = path.join(backupRoot, "backups", record.file!);
    expect(readFileSync(encrypted).includes("Encrypted and away")).toBe(false);
    expect(readFileSync(`${encrypted}.sha256`, "utf8").split(" ")[0]).toBe(
      await sha256File(encrypted),
    );

    const restored = path.join(tempDir(), "restored.db");
    await decryptFile(encrypted, restored, backupKey(path.join(backupRoot, "key")));
    expect(await sha256File(restored)).toBe(await sha256File(original));

    await expect(decryptFile(encrypted, `${restored}2`, Buffer.alloc(32, 7))).rejects.toThrow();
    const tampered = path.join(tempDir(), "tampered.dcbak");
    const bytes = readFileSync(encrypted);
    bytes[bytes.length - 40]! ^= 1;
    writeFileSync(tampered, bytes);
    await expect(
      decryptFile(tampered, `${restored}3`, backupKey(path.join(backupRoot, "key"))),
    ).rejects.toThrow();
  });

  it("counts a copy only when the other machine's fingerprint matches, then clears it from the queue", async () => {
    const { call, backups, backupRoot } = await makeApp({ scenario: "calm" });
    const record = (await call("POST", "/api/backups/run")).json<BackupRecord>();
    const name = record.file!.replace(/\.db$/, ".dcbak");
    const outbox = path.join(backupRoot, "backups", "offsite-outbox");

    await receipt(backupRoot, name, "0".repeat(64));
    await backups.processReceipts();
    let status = (await backups.status()).offsite!;
    expect(status.lastVerified).toBeUndefined();
    expect(status.lastError?.detail).toMatch(/does not match the original/);
    expect(status.pending.map((p) => p.name)).toEqual([name]);

    // A damaged receipt is reported, not silently dropped (once it is clearly not still arriving).
    const receipts = path.join(backupRoot, "backups", "offsite-receipts");
    writeFileSync(path.join(receipts, `${name}.json`), '{"file":"x\nbroken');
    utimesSync(
      path.join(receipts, `${name}.json`),
      new Date(Date.now() - 600_000),
      new Date(Date.now() - 600_000),
    );
    await backups.processReceipts();
    expect((await backups.status()).offsite!.lastError?.detail).toMatch(/could not be read/);

    await receipt(backupRoot, name, await sha256File(path.join(outbox, name)));
    await backups.processReceipts();
    status = (await backups.status()).offsite!;
    expect(status.lastVerified).toMatchObject({
      file: name,
      destination: "X:\\Backups\\Hearth",
    });
    expect(status.pending).toEqual([]);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it("raises an incident when backups fail or the off-machine copy falls behind, and clears it after", async () => {
    let now = new Date(2026, 9, 8, 4, 0, 0);
    const env = await realEnvironment({ clock: () => now });
    const { backups, backupRoot } = env;
    const incident = async (key: string) =>
      (await env.workspace()).incidents.find((i) => i.title.startsWith(key));

    // A failure, then a recovery.
    writeFileSync(path.join(backupRoot, "backups"), "not a folder");
    await backups.run("scheduled");
    await backups.checkHealth();
    expect((await incident("Backups are failing"))?.status).not.toBe("resolved");
    rmSync(path.join(backupRoot, "backups"));
    await backups.run("manual");
    await backups.checkHealth();
    expect((await incident("Backups are failing"))?.status).toBe("resolved");

    // Home Vault never fetched anything for a day and a half.
    now = new Date(2026, 9, 9, 17, 0, 0);
    await backups.checkHealth();
    const behind = await incident("No off-machine backup");
    expect(behind).toMatchObject({ severity: "warning" });
    expect(behind?.status).not.toBe("resolved");

    // It catches up: everything waiting is fetched and checked.
    for (const p of (await backups.status()).offsite!.pending) {
      await receipt(
        backupRoot,
        p.name,
        await sha256File(path.join(backupRoot, "backups", "offsite-outbox", p.name)),
        now.toISOString(),
      );
    }
    await backups.processReceipts();
    await backups.checkHealth();
    expect((await incident("No off-machine backup"))?.status).toBe("resolved");
  });

  it("tells you through your notification channels when backups fail, and when they recover", async () => {
    const env = await realEnvironment();
    expect(
      (await env.call("PUT", "/api/notifications/channels/email", { values: EMAIL })).statusCode,
    ).toBe(204);
    outbox.length = 0;
    writeFileSync(path.join(env.backupRoot, "backups"), "not a folder");
    await env.backups.run("scheduled");
    await env.backups.checkHealth();
    env.notifier.kick();
    await env.notifier.idle();
    expect(outbox.map((o) => o.message.title)).toContain("Needs you: Backups are failing");

    rmSync(path.join(env.backupRoot, "backups"));
    await env.backups.run("manual");
    await env.backups.checkHealth();
    env.notifier.kick();
    await env.notifier.idle();
    expect(outbox.map((o) => o.message.title)).toContain("Resolved: Backups are failing");
  });

  it("shows the keys to keep safe only to you, after confirming it is you", async () => {
    const { call, send } = await makeApp({ scenario: "calm" });
    const keys = await call("POST", "/api/backups/keys");
    expect(keys.statusCode).toBe(200);
    expect(Buffer.from(keys.json<{ backupKey: string }>().backupKey, "base64")).toHaveLength(32);
    expect((await send("POST", "/api/backups/keys", {})).statusCode).toBe(401);
  });
});

/** The synthetic homelab, minus its deliberately unhealthy database unless asked for. */
async function realEnvironment(
  opts: { includeUnhealthyDb?: boolean; clock?: () => Date; appFetch?: Fetch } = {},
) {
  const app = await makeApp({ scenario: "calm", clock: opts.clock, appFetch: opts.appFetch });
  const report = (await app.call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
  await app.call("POST", "/api/discovery/adopt", {
    reportId: report.id,
    selections: report.findings
      .filter(
        (f) => f.selectedByDefault && (opts.includeUnhealthyDb || f.sourceName !== "photos_db"),
      )
      .map((f) => ({ key: f.key, name: f.name })),
  });
  const check = async () => {
    const summary = (await app.call("POST", "/api/monitor/run")).json<{
      opened: number;
      resolved: number;
      failing: number;
    }>();
    await app.runner.idle(); // let the response to any new incident finish
    return summary;
  };
  return { ...app, check };
}

describe("release watch: requested movies followed until they arrive", () => {
  type W = import("@dragon-control/core").Watch;
  type Detail = W & { history: import("@dragon-control/core").WatchHistoryEntry[] };
  const SEERR_KEY = "seerr-test-key-0123456789";
  const RADARR_KEY = "radarr-test-key-0123456789";

  /** Your own Seerr and Radarr (stand-ins), with their keys in the vault, and a channel set up. */
  async function setup(opts: { channel?: boolean; listen?: boolean } = {}) {
    const media = fakeMedia();
    const env = await makeApp({ scenario: "calm", media, listen: opts.listen });
    const add = async (name: string, address: string, value: string) => {
      const res = await env.call("POST", "/api/services", {
        name,
        kind: "web",
        address,
        category: "Media",
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBeLessThan(300);
      // The id it was added with: sample data may already have an app of the same name.
      const service = res.json<{ id: string; name: string }>();
      const secret = await env.call("POST", "/api/vault/secrets", {
        name: `${name} API key`,
        kind: "api-key",
        tier: "automation",
        serviceId: service.id,
        value,
      });
      expect(secret.statusCode).toBeLessThan(300);
      return service;
    };
    await add("Seerr", "http://10.0.0.5:5055", SEERR_KEY);
    await add("Radarr", "http://10.0.0.5:7878", RADARR_KEY);
    if (opts.channel !== false)
      expect(
        (await env.call("PUT", "/api/notifications/channels/email", { values: EMAIL })).statusCode,
      ).toBe(204);
    const list = async (view?: string) =>
      (await env.call("GET", `/api/watches${view ? `?view=${view}` : ""}`)).json<{
        watches: W[];
      }>().watches;
    const byTitle = async (title: string) => (await list()).find((w) => w.title === title)!;
    const detail = async (id: string) =>
      (await env.call("GET", `/api/watches/${id}`)).json<Detail>();
    const check = async (id: string) => env.call("POST", `/api/watches/${id}/check`, {});
    return { ...env, media, list, byTitle, detail, check };
  }
  const releaseMail = () =>
    outbox.filter(
      (o) =>
        o.message.link?.endsWith("/releases") || /movie|library|release/i.test(o.message.title),
    );

  it("the Seerr panel and Ember see each request with its Radarr folder, profile, and overdue days", async () => {
    const env = await setup({ channel: false, listen: true });
    const seerr = (await env.workspace()).services.find(
      (x) => x.name === "Seerr" && x.localUrl?.includes("10.0.0.5"),
    )!;
    const dash = (
      await env.call("GET", `/api/services/${seerr.id}/dashboard`)
    ).json<AppDashboard>();
    expect(dash.error).toBeUndefined();
    const data = dash.data as SeerrDashboard;
    expect(data.me).toBe("Alex");
    const night = data.movies.find((m) => m.title === "Night Signal")!;
    expect(night).toMatchObject({
      mine: true,
      stage: "searching",
      overdueDays: 5,
      radarr: { rootFolder: "/movies", quality: "HD-1080p", path: "/movies/Night Signal (2026)" },
    });
    expect(data.movies.find((m) => m.title === "The Long Road")!.radarr).toMatchObject({
      rootFolder: "/movies-4k",
      quality: "Ultra-HD",
    });
    expect(JSON.stringify(dash)).not.toContain(SEERR_KEY);

    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("movie_requests", { overdueOnly: true });
      return "ok";
    };
    expect(
      (await env.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    const asked = await env.call("POST", "/api/agent/conversations", {
      text: "Which of my requests are past their digital release?",
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const said = JSON.parse(answer) as {
      serviceId: string;
      movies: { title: string; overdueDays?: number; rootFolder?: string }[];
    }[];
    expect(said.find((x) => x.serviceId === seerr.id)!.movies).toEqual([
      expect.objectContaining({
        title: expect.stringContaining("Night Signal"),
        overdueDays: 5,
        rootFolder: "/movies",
      }),
    ]);
    expect(answer).not.toContain(RADARR_KEY);
  });

  it("finds every movie request on its own, once, and judges each from real dates", async () => {
    const env = await setup();
    outbox.length = 0;
    const found = (await env.call("POST", "/api/watches/check", {})).json<{ added: number }>();
    expect(found.added).toBe(6);
    // No duplicates, however often it looks.
    expect((await env.call("POST", "/api/watches/check", {})).json<{ added: number }>().added).toBe(
      0,
    );
    const all = await env.list();
    expect(all).toHaveLength(6);
    const state = Object.fromEntries(all.map((w) => [w.title, w.state]));
    expect(state).toEqual({
      "The Long Road": "upcoming",
      "Quiet Harbor": "unannounced",
      "Night Signal": "needs-look",
      "Paper Moons": "downloading",
      "Ember Lake": "arrived",
      "Static Bloom": "out-today",
    });
    const night = all.find((w) => w.title === "Night Signal")!;
    expect(night.assessment.problem).toMatchObject({ code: "nothing-accepted", confirmed: false });
    // The same trouble is a finding in Hearth's one list, saying how long ago it came out.
    await env.call("POST", "/api/findings/refresh", {});
    const listed = (await env.call("GET", "/api/findings")).json<
      { findings?: Finding[] } | Finding[]
    >();
    const findings = Array.isArray(listed) ? listed : (listed.findings ?? []);
    expect(findings.find((x) => x.title.startsWith("Night Signal"))).toMatchObject({
      title: "Night Signal: 5 days past its digital release, not grabbed",
      severity: "medium",
    });
    // The Seerr is removed: its old watches are not findings any more, and nothing fails.
    const seerrId = (await env.workspace()).services.find(
      (x) => x.localUrl?.includes(":5055") && x.name === "Seerr",
    )!.id;
    expect((await env.call("POST", `/api/services/${seerrId}/remove`, {})).statusCode).toBeLessThan(
      300,
    );
    // "Look again" runs at most every 30 seconds: as if that long has passed.
    const realNow = Date.now;
    const later = realNow() + 31_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => later);
    const refreshed = await env.call("POST", "/api/findings/refresh", {});
    clock.mockRestore();
    expect(refreshed.json<{ ran: boolean }>().ran).toBe(true);
    expect(refreshed.body).not.toMatch(/Failed query|Could not run/);
    const after = (await env.call("GET", "/api/findings")).json<
      { findings?: Finding[] } | Finding[]
    >();
    const open = (Array.isArray(after) ? after : (after.findings ?? [])).filter(
      (x) => x.title.startsWith("Night Signal") && x.status === "open",
    );
    expect(open).toEqual([]);
    const harbor = all.find((w) => w.title === "Quiet Harbor")!;
    // A theatrical date is shown for context, never taken for a digital one.
    expect(harbor.assessment.theatrical).toBeDefined();
    expect(harbor.assessment.homeDate).toBeUndefined();
    const road = all.find((w) => w.title === "The Long Road")!;
    expect(road.assessment).toMatchObject({ homeKind: "digital", dateSource: "tmdb" });
    expect(road.links.seerr).toBe("http://10.0.0.5:5055/movie/9001");
    expect(road.links.radarr).toBe("http://10.0.0.5:7878/movie/the-long-road");
    expect(road.requestedBy).toBe("Alex");
    // Lists: needs a look, completed, and the rest upcoming.
    expect((await env.list("attention")).map((w) => w.title)).toEqual(["Night Signal"]);
    expect((await env.list("completed")).map((w) => w.title)).toEqual(["Ember Lake"]);
    // The first look over requests made before watching started is quiet: history, no messages.
    expect(releaseMail()).toEqual([]);
    const h = await env.detail(night.id);
    expect(h.history.map((e) => e.type)).toEqual(["problem", "watching"]);
    expect(h.history.every((e) => e.sent === "none")).toBe(true);
    // Keys stay in the vault: nothing the page or history shows carries one.
    const shown = JSON.stringify([all, h]);
    expect(shown).not.toContain(SEERR_KEY);
    expect(shown).not.toContain(RADARR_KEY);
  }, 30_000);

  it("tells the owner once when a date moves, the day comes, or the movie arrives", async () => {
    const env = await setup();
    await env.call("POST", "/api/watches/check", {});
    outbox.length = 0;
    const road = await env.byTitle("The Long Road");
    // Delayed by nine days.
    await env.media.control({ moveDigital: { tmdbId: 9001, days: 19 } });
    const moved = (await env.check(road.id)).json<Detail>();
    expect(moved.history[0]).toMatchObject({ type: "date-moved", sent: "sent" });
    expect(moved.history[0]!.text).toMatch(
      /^The expected digital release date for The Long Road has moved from .+ to .+\. Its release watch has been updated\.$/,
    );
    expect(releaseMail().map((o) => o.message.title)).toEqual([
      "The Long Road: release date moved later",
    ]);
    // Checked again with nothing new: nothing more is sent.
    await env.check(road.id);
    expect(releaseMail()).toHaveLength(1);
    // It arrives: told once, then finished, with no further checks.
    await env.media.control({ arrive: 9001 });
    const arrived = (await env.check(road.id)).json<Detail>();
    expect(arrived).toMatchObject({ state: "arrived", view: "completed" });
    expect(arrived.nextCheckAt).toBeUndefined();
    expect(arrived.history[0]).toMatchObject({ type: "arrived", sent: "sent" });
    expect(releaseMail().map((o) => o.message.title)).toContain("The Long Road is in your library");
  });

  it("snoozed news waits; a kind switched off is kept but not sent; dismissed stops checking", async () => {
    const env = await setup();
    await env.call("POST", "/api/watches/check", {});
    outbox.length = 0;
    const road = await env.byTitle("The Long Road");
    expect((await env.call("POST", `/api/watches/${road.id}/snooze`, { days: 3 })).statusCode).toBe(
      204,
    );
    await env.media.control({ moveDigital: { tmdbId: 9001, days: 15 } });
    const held = (await env.check(road.id)).json<Detail>();
    expect(held.snoozedUntil).toBeDefined();
    expect(held.history.find((e) => e.type === "date-moved")).toMatchObject({ sent: "held" });
    expect(releaseMail()).toEqual([]);
    // Snooze over: the held news goes out on the next pass, once.
    await env.call("POST", `/api/watches/${road.id}/unsnooze`, {});
    await env.call("POST", "/api/watches/check", {});
    expect(releaseMail().map((o) => o.message.title)).toEqual([
      "The Long Road: release date moved later",
    ]);
    expect((await env.detail(road.id)).history.find((e) => e.type === "date-moved")?.sent).toBe(
      "sent",
    );

    // A kind switched off: recorded, not sent.
    await env.call("PATCH", "/api/watches/settings", { notify: { arrived: false } });
    await env.media.control({ arrive: 9001 });
    const arrived = (await env.check(road.id)).json<Detail>();
    expect(arrived.history[0]).toMatchObject({ type: "arrived", sent: "off" });
    expect(releaseMail()).toHaveLength(1);

    // Dismissed: listed under Dismissed, not checked, and can be brought back.
    const harbor = await env.byTitle("Quiet Harbor");
    await env.call("POST", `/api/watches/${harbor.id}/dismiss`, {});
    const dismissed = await env.detail(harbor.id);
    expect(dismissed).toMatchObject({ view: "dismissed" });
    expect(dismissed.nextCheckAt).toBeUndefined();
    expect((await env.check(harbor.id)).statusCode).toBe(400);
    await env.call("POST", `/api/watches/${harbor.id}/restore`, {});
    expect((await env.detail(harbor.id)).view).toBe("upcoming");
  });

  it("survives a restart, keeps what it knew when Seerr is down, and is yours only", async () => {
    const env = await setup({ channel: false });
    await env.call("POST", "/api/watches/check", {});
    const before = await env.list();
    // A new engine over the same database (a restart) knows every watch and adds none.
    const again = new Watches(
      env.handle,
      new MovieReleases(env.handle, new AppWatcher(env.handle, env.vault).broker, env.media.fetch),
      env.notifier,
    );
    expect((await again.discover()).added).toBe(0);
    expect((await again.list()).map((w) => [w.title, w.state])).toEqual(
      before.map((w) => [w.title, w.state]),
    );
    // Seerr does not answer: the watch keeps its state and says why, and nothing is news.
    const down = new Watches(
      env.handle,
      new MovieReleases(env.handle, new AppWatcher(env.handle, env.vault).broker, async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      env.notifier,
    );
    const road = before.find((w) => w.title === "The Long Road")!;
    const after = await down.checkNow(road.id);
    expect(after.state).toBe("upcoming");
    expect(after.checkError).toMatch(/did not answer/);
    expect(after.history.filter((e) => e.type !== "watching")).toEqual([]);
    // Access keys never reach it.
    const { key } = (
      await env.call("POST", "/api/keys", { name: "HA", scopes: ["read", "approve"] })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    expect((await env.send("GET", "/api/watches", undefined, undefined, auth)).statusCode).toBe(
      403,
    );
    expect(
      (await env.send("POST", `/api/watches/${road.id}/dismiss`, {}, undefined, auth)).statusCode,
    ).toBe(403);
    // Switched off: nothing is looked for.
    await env.call("PATCH", "/api/watches/settings", { enabled: false });
    expect(
      (await env.call("POST", "/api/watches/check", {})).json<{ errors: string[] }>().errors,
    ).toEqual(["Watching is switched off, so nothing was checked."]);
    await env.call("PATCH", "/api/watches/settings", { enabled: true });
    // Settings are checked.
    expect((await env.call("PATCH", "/api/watches/settings", { region: "USA" })).statusCode).toBe(
      400,
    );
    expect(
      (await env.call("PATCH", "/api/watches/settings", { region: "gb" })).json<{
        region: string;
      }>().region,
    ).toBe("GB");
  });
});

describe("release watch: a Seerr no longer watched", () => {
  it("closes its watches quietly when its Seerr is removed from Hearth", async () => {
    const media = fakeMedia();
    const env = await makeApp({ scenario: "calm", media });
    const seerr = (
      await env.call("POST", "/api/services", {
        name: "Home Seerr",
        kind: "web",
        address: "http://10.0.0.5:5055",
        category: "Media",
      })
    ).json<{ id: string }>();
    await env.call("POST", "/api/vault/secrets", {
      name: "Seerr key",
      kind: "api-key",
      tier: "automation",
      serviceId: seerr.id,
      value: "seerr-key-0123456789",
    });
    await env.call("POST", "/api/watches/check", {});
    const before = (await env.call("GET", "/api/watches")).json<{
      watches: import("@dragon-control/core").Watch[];
    }>().watches;
    expect(before.length).toBeGreaterThan(0);
    expect(
      (await env.call("POST", `/api/services/${seerr.id}/remove`, {})).statusCode,
    ).toBeLessThan(300);
    await env.call("POST", "/api/watches/check", {});
    const after = (await env.call("GET", "/api/watches")).json<{
      watches: import("@dragon-control/core").Watch[];
    }>().watches;
    expect(after.every((w) => w.view === "completed" && w.state === "gone")).toBe(true);
    expect(after.every((w) => !w.nextCheckAt)).toBe(true);
  });
});

describe("start and stop (Cave 2)", () => {
  afterEach(() => fakeOutages.restoreAll());

  const byContainer = async (env: { workspace: () => Promise<Workspace> }, name: string) => {
    const ws = await env.workspace();
    return [...ws.services, ...ws.inactiveServices].find((s) => s.container === name)!;
  };

  it("you stop and start a container: verified, held off, and never repaired while stopped", async () => {
    const env = await realEnvironment();
    await env.call("PATCH", "/api/settings", { liveRepairs: true });
    const sonarr = await byContainer(env, "sonarr");
    await env.call("PUT", "/api/autonomy", {
      default: "auto",
      rules: [{ id: sonarr.autonomyArea, level: "auto" }],
    });

    const stop = await env.call("POST", "/api/actions", {
      kind: "stop-container",
      serviceId: sonarr.id,
    });
    expect(stop.statusCode, stop.body).toBe(200);
    await env.runner.idle();
    let ws = await env.workspace();
    expect(ws.actions[0]).toMatchObject({
      kind: "stop-container",
      status: "succeeded",
      result: expect.stringMatching(/Stopped and verified/),
    });
    expect(fakeOutages.power()).toEqual(["stop:sonarr"]);
    expect(ws.services.find((s) => s.id === sonarr.id)!.stopped).toMatchObject({ by: "you" });

    // Monitoring leaves it alone: no incident, no automatic restart, even on Fix automatically.
    const summary = await env.check();
    await env.check();
    expect(summary.opened).toBe(0);
    ws = await env.workspace();
    expect(ws.incidents.filter((i) => i.serviceId === sonarr.id)).toEqual([]);
    expect(fakeOutages.restarts()).toEqual([]);
    await expect(
      env.runner.request({ kind: "restart-container", serviceId: sonarr.id, requestedBy: "agent" }),
    ).rejects.toThrow(/stopped on request/);
    expect(
      (await env.call("POST", "/api/actions", { kind: "stop-container", serviceId: sonarr.id }))
        .statusCode,
    ).toBe(409);

    const start = await env.call("POST", "/api/actions", {
      kind: "start-container",
      serviceId: sonarr.id,
    });
    expect(start.statusCode, start.body).toBe(200);
    await env.runner.idle();
    ws = await env.workspace();
    expect(ws.actions[0]).toMatchObject({
      kind: "start-container",
      status: "succeeded",
      result: expect.stringMatching(/Started and verified/),
    });
    const after = ws.services.find((s) => s.id === sonarr.id)!;
    expect(after.stopped).toBeUndefined();
    expect(after.health).toBe("healthy");
    expect((await env.audit()).map((a) => a.action)).toEqual(
      expect.arrayContaining(["Stopped the Sonarr container", "Started the Sonarr container"]),
    );
  });

  it("is watched again if it is started some other way", async () => {
    const env = await realEnvironment();
    const sonarr = await byContainer(env, "sonarr");
    await env.call("POST", "/api/actions", { kind: "stop-container", serviceId: sonarr.id });
    await env.runner.idle();
    fakeOutages.restoreAll(); // someone ran `docker start sonarr`
    await env.check();
    expect((await byContainer(env, "sonarr")).stopped).toBeUndefined();
  });

  it("never happens for the AI or an access key without a plan you approve", async () => {
    const env = await realEnvironment();
    const sonarr = await byContainer(env, "sonarr");
    await env.call("PATCH", "/api/settings", { liveRepairs: true });
    await env.call("PUT", "/api/autonomy", {
      default: "auto",
      rules: [{ id: sonarr.autonomyArea, level: "auto" }],
    });
    for (const kind of ["start-container", "stop-container"] as const) {
      await expect(
        env.runner.request({ kind, serviceId: sonarr.id, requestedBy: "agent" }),
      ).rejects.toThrow(/plan you approve/);
    }
    const { key } = (
      await env.call("POST", "/api/keys", { name: "HA", scopes: ["read", "act"] })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    const viaKey = await env.send(
      "POST",
      "/api/actions",
      { kind: "stop-container", serviceId: sonarr.id },
      undefined,
      auth,
    );
    expect(viaKey.statusCode).toBe(403);
    expect(
      (
        await env.send(
          "POST",
          "/api/actions",
          { kind: "run-check", serviceId: sonarr.id },
          undefined,
          auth,
        )
      ).statusCode,
    ).toBe(200);
    expect(fakeOutages.power()).toEqual([]);

    // Even on Fix automatically with live repairs on, an AI plan to stop waits for you.
    const job = await env.jobs.create({
      title: "Stop Sonarr",
      steps: [{ kind: "stop-container", serviceId: sonarr.id }],
      requestedBy: "agent",
    });
    expect(job).toMatchObject({ status: "awaiting-approval" });
    expect(job.steps[0]).toMatchObject({
      policy: "approve-first",
      verify: expect.stringMatching(/stopped/),
      rollback: expect.stringMatching(/started again/),
    });
    expect(fakeOutages.power()).toEqual([]);
    await env.call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    await env.jobs.idle();
    expect((await env.jobs.get(job.id)).status).toBe("succeeded");
    expect(fakeOutages.power()).toEqual(["stop:sonarr"]);
    expect((await byContainer(env, "sonarr")).stopped).toMatchObject({ by: "agent" });
  });

  it("keeps paused services paused and never stops core networking", async () => {
    const env = await realEnvironment();
    const sonarr = await byContainer(env, "sonarr");
    await env.call("POST", "/api/actions", { kind: "stop-container", serviceId: sonarr.id });
    await env.runner.idle();
    await env.call("PUT", `/api/services/${sonarr.id}/lifecycle`, { lifecycle: "paused" });
    const start = await env.call("POST", "/api/actions", {
      kind: "start-container",
      serviceId: sonarr.id,
    });
    expect(start.statusCode).toBe(409);
    expect(start.body).toMatch(/paused/);
    const aiPlan = await env.jobs.create({
      title: "Start Sonarr",
      steps: [{ kind: "start-container", serviceId: sonarr.id }],
      requestedBy: "agent",
    });
    expect(aiPlan.status).toBe("refused");

    const vpn = await byContainer(env, "vpn");
    expect(vpn.coreNetworking).toBe(true);
    const stopVpn = await env.call("POST", "/api/actions", {
      kind: "stop-container",
      serviceId: vpn.id,
    });
    expect(stopVpn.statusCode).toBe(409);
    expect(stopVpn.body).toMatch(/never stops/);
    expect(fakeOutages.power()).toEqual(["stop:sonarr"]);
  });

  it("respects dependencies: stop what depends on it first, start what it depends on first", async () => {
    const env = await realEnvironment({ includeUnhealthyDb: true });
    const server = await byContainer(env, "photos_server");
    const db = await byContainer(env, "photos_db");
    expect(server.dependsOn).toContain(db.id);
    await env.call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [...new Set([server.autonomyArea, db.autonomyArea])].map((id) => ({
        id,
        level: "ask",
      })),
    });
    const run = async (steps: { kind: ActionKind; serviceId: string }[]) => {
      const job = await env.jobs.create({ title: "Plan", steps, requestedBy: "agent" });
      expect(job.status, job.summary).toBe("awaiting-approval");
      await env.call("POST", `/api/jobs/${job.id}/decision`, {
        decision: "approve",
        fingerprint: job.approval!.fingerprint,
      });
      await env.jobs.idle();
      return env.jobs.get(job.id);
    };

    const tooSoon = await run([{ kind: "stop-container", serviceId: db.id }]);
    expect(tooSoon.status).toBe("failed");
    expect(tooSoon.steps[0]!.result).toMatch(/depends on .* still running/);
    expect(fakeOutages.power()).toEqual([]);

    const ordered = await run([
      { kind: "stop-container", serviceId: server.id },
      { kind: "stop-container", serviceId: db.id },
    ]);
    expect(ordered.status, ordered.summary).toBe("succeeded");

    const startTooSoon = await run([{ kind: "start-container", serviceId: server.id }]);
    expect(startTooSoon.status).toBe("failed");
    expect(startTooSoon.steps[0]!.result).toMatch(/not running\. Start it first/);
    expect(fakeOutages.power()).toEqual(["stop:photos_server", "stop:photos_db"]);
  });

  it("a failed plan undoes its stops by starting them again", async () => {
    const env = await realEnvironment();
    const sonarr = await byContainer(env, "sonarr");
    const prowlarr = await byContainer(env, "prowlarr");
    fakeOutages.stopContainer("prowlarr", 1);
    const job = (
      await env.call("POST", "/api/jobs", {
        title: "Quiet Sonarr, check Prowlarr",
        steps: [
          { kind: "stop-container", serviceId: sonarr.id },
          { kind: "run-check", serviceId: prowlarr.id },
        ],
      })
    ).json<Job>();
    expect(job.status, JSON.stringify(job)).toBe("awaiting-approval");
    await env.call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    await env.jobs.idle();
    const done = await env.jobs.get(job.id);
    expect(done.status, done.summary).toBe("rolled-back");
    expect(done.steps[0]).toMatchObject({
      status: "rolled-back",
      result: expect.stringMatching(/Rollback: Started and verified/),
    });
    expect(fakeOutages.power()).toEqual(["stop:sonarr", "start:sonarr"]);
    expect((await byContainer(env, "sonarr")).stopped).toBeUndefined();
  });
});

describe("repairs inside apps: Prowlarr indexers (repair framework)", () => {
  afterEach(() => fakeOutages.restoreAll());

  /** A stand-in Prowlarr that keeps state, so changes and read-backs are real. */
  function fakeProwlarr() {
    const indexers = [
      {
        id: 5,
        name: "PublicTracker",
        enable: true,
        fields: [
          { name: "baseUrl", value: "https://publictracker.example/" },
          { name: "apiKey", value: "indexer-own-secret" },
        ],
      },
      { id: 6, name: "PublicTwo", enable: true, fields: [] as { name: string; value: string }[] },
    ];
    const calls: { method: string; path: string; body?: string }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      calls.push({ method, path, body: init.body });
      const reply = (status: number, data: unknown) => ({
        ok: status < 400,
        status,
        json: async () => data,
      });
      if (method === "GET" && path === "/api/v1/indexer")
        return reply(200, structuredClone(indexers));
      if (method === "PUT" && path.startsWith("/api/v1/indexer/")) {
        const body = JSON.parse(init.body!) as (typeof indexers)[number];
        const i = indexers.findIndex((x) => x.id === body.id);
        indexers[i] = body;
        return reply(202, body);
      }
      if (method === "POST" && path === "/api/v1/indexer/test") {
        return reply(400, [
          { errorMessage: "Unable to connect to indexer: 403 Forbidden, error code: 1006" },
        ]);
      }
      return reply(404, {});
    };
    return { indexers, calls, fetchImpl };
  }

  async function setup() {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    const prowlarr = fakeProwlarr();
    const ops = new AppOperations(env.handle, env.vault, env.runner, prowlarr.fetchImpl);
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    return { env, svc, prowlarr, jobs };
  }
  const addKey = (env: Awaited<ReturnType<typeof setup>>["env"], serviceId: string) =>
    env.vault.add({
      name: "Prowlarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId,
      value: "prowlarr-key",
      scope: "approved-changes",
    });

  it("needs the API key first, then plans the exact change; the AI's change always waits for you", async () => {
    const { env, svc, prowlarr, jobs } = await setup();
    const step = {
      kind: "app-set-indexer-enabled" as const,
      serviceId: svc.id,
      params: { indexer: "PublicTracker", enabled: false },
    };
    const noKey = await jobs.create({
      title: "Turn off PublicTracker",
      steps: [step],
      requestedBy: "agent",
    });
    expect(noKey).toMatchObject({
      status: "refused",
      summary: expect.stringMatching(/API key to the vault/),
    });

    await addKey(env, svc.id);
    // Even on Fix automatically with live repairs on.
    await env.call("PATCH", "/api/settings", { liveRepairs: true });
    await env.call("PUT", "/api/autonomy", {
      default: "auto",
      rules: [{ id: svc.autonomyArea, level: "auto" }],
    });
    const job = await jobs.create({
      title: "Turn off PublicTracker",
      steps: [step],
      requestedBy: "agent",
    });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]).toMatchObject({
      label: "Turn off the PublicTracker indexer in Prowlarr",
      policy: "approve-first",
      params: { indexerId: 5, indexer: "PublicTracker", enabled: false },
      change: { settings: [{ name: "PublicTracker: enabled", before: "On", after: "Off" }] },
    });
    expect(prowlarr.calls.every((c) => c.method === "GET")).toBe(true);
    expect(prowlarr.indexers[0]!.enable).toBe(true);

    // Approval is bound to the exact change: editing it behind the plan's back breaks the approval.
    env.handle.sqlite.prepare("UPDATE job_steps SET change = ? WHERE job_id = ?").run(
      JSON.stringify({
        summary: "x",
        settings: [{ name: "PublicTracker: enabled", before: "On", after: "On" }],
      }),
      job.id,
    );
    await expect(jobs.decide(job.id, "approve", job.approval!.fingerprint)).rejects.toThrow(
      /changed/,
    );
    expect(prowlarr.indexers[0]!.enable).toBe(true);

    // Nothing to change, an unknown indexer, a service without support: refused with the reason.
    const already = await jobs.create({
      title: "x",
      steps: [{ ...step, params: { indexer: "PublicTwo", enabled: true } }],
      requestedBy: "you",
    });
    expect(already.summary).toMatch(/already on/);
    const unknown = await jobs.create({
      title: "x",
      steps: [{ ...step, params: { indexer: "Nope", enabled: false } }],
      requestedBy: "you",
    });
    expect(unknown.summary).toMatch(/no indexer named "Nope".*PublicTracker, PublicTwo/);
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const wrongApp = await jobs.create({
      title: "x",
      steps: [{ ...step, serviceId: sonarr.id }],
      requestedBy: "you",
    });
    expect(wrongApp.summary).toMatch(/only supported for Prowlarr/);
    // The runner never carries these out directly.
    await expect(
      env.runner.request({
        kind: "app-set-indexer-enabled",
        serviceId: svc.id,
        requestedBy: "you",
      }),
    ).rejects.toThrow(/plan/);
  });

  it("approved: changes exactly that, verifies by reading back, audits before and after, keeps no secrets", async () => {
    const { env, svc, prowlarr, jobs } = await setup();
    await addKey(env, svc.id);
    await env.call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: svc.autonomyArea, level: "ask" }],
    });
    const job = await jobs.create({
      title: "Investigate and quiet PublicTracker",
      steps: [
        { kind: "app-test-indexer", serviceId: svc.id, params: { indexer: "PublicTracker" } },
        {
          kind: "app-set-indexer-enabled",
          serviceId: svc.id,
          params: { indexer: "PublicTracker", enabled: false },
        },
      ],
      requestedBy: "agent",
    });
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/tested PublicTracker: it failed: .*1006/);
    expect(done.steps[1]!.result).toBe(
      "Changed and verified: PublicTracker: enabled is now Off (was On).",
    );
    expect(prowlarr.indexers[0]!.enable).toBe(false);
    // The resource went back whole (the indexer's own fields untouched), changed only where approved.
    const put = prowlarr.calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toMatchObject({
      id: 5,
      enable: false,
      fields: [{ name: "baseUrl" }, { name: "apiKey", value: "indexer-own-secret" }],
    });
    const audit = (await env.audit()).map((a) => a.action);
    expect(audit).toEqual(
      expect.arrayContaining([
        "Tested the PublicTracker indexer in Prowlarr",
        "Turned off the PublicTracker indexer in Prowlarr",
      ]),
    );
    const everything = JSON.stringify([
      await env.audit(),
      await jobs.get(job.id),
      await env.workspace(),
    ]);
    expect(everything).not.toContain("indexer-own-secret");
    expect(everything).not.toContain("prowlarr-key");
  });

  it("stops without changing anything if Prowlarr changed since approval, and undoes changes when a later step fails", async () => {
    const { env, svc, prowlarr, jobs } = await setup();
    await addKey(env, svc.id);
    const step = {
      kind: "app-set-indexer-enabled" as const,
      serviceId: svc.id,
      params: { indexer: "PublicTracker", enabled: false },
    };
    const drift = await jobs.create({ title: "Turn off", steps: [step], requestedBy: "you" });
    prowlarr.indexers[0]!.enable = false; // someone turned it off in Prowlarr meanwhile
    await jobs.decide(drift.id, "approve", drift.approval!.fingerprint);
    await jobs.idle();
    const stopped = await jobs.get(drift.id);
    expect(stopped.status).toBe("failed");
    expect(stopped.steps[0]!.result).toMatch(
      /not on as when this plan was approved. Nothing was changed/,
    );
    expect(prowlarr.calls.some((c) => c.method === "PUT")).toBe(false);

    prowlarr.indexers[0]!.enable = true;
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    fakeOutages.stopContainer("sonarr", 1);
    const plan = await jobs.create({
      title: "Turn off, then check Sonarr",
      steps: [step, { kind: "run-check", serviceId: sonarr.id }],
      requestedBy: "you",
    });
    await jobs.decide(plan.id, "approve", plan.approval!.fingerprint);
    await jobs.idle();
    const rolled = await jobs.get(plan.id);
    expect(rolled.status, rolled.summary).toBe("rolled-back");
    expect(rolled.steps[0]!.result).toMatch(
      /Rollback: Changed and verified: PublicTracker: enabled is now On/,
    );
    expect(prowlarr.indexers[0]!.enable).toBe(true);
  });
});

describe("app-api-call: any request to an app's own API, as a plan you approve", () => {
  it("removes one stuck Chaptarr item by its exact id once approved; refused without change scope", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "SABnzbd")!;
    env.handle.sqlite
      .prepare("UPDATE services SET name = 'Chaptarr', image = ? WHERE id = ?")
      .run("robertlordhood/chaptarr:latest", svc.id);
    const chaptarr = fakeArrV1("chaptarr");
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      chaptarr.fetch,
      undefined,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    const step = {
      kind: "app-api-call" as const,
      serviceId: svc.id,
      params: {
        method: "DELETE",
        path: "/api/v1/queue/502?removeFromClient=false&blocklist=false",
        why: "Remove The Dispossessed from the queue, keeping the download",
      },
    };
    const noKey = await jobs.create({ title: "Remove", steps: [step], requestedBy: "agent" });
    expect(noKey.status).toBe("refused");
    const key = await env.vault.add({
      name: "Chaptarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: svc.id,
      value: "e2e-chaptarr-key",
      scope: "read",
    });
    const limited = await jobs.create({ title: "Remove", steps: [step], requestedBy: "agent" });
    expect(limited.summary).toMatch(/limited to diagnostics/);
    await env.vault.update(key.id, { scope: "approved-changes" });
    const bad = await jobs.create({
      title: "x",
      steps: [{ ...step, params: { ...step.params, path: "//elsewhere.example/x" } }],
      requestedBy: "agent",
    });
    expect(bad.status).toBe("refused");

    const job = await jobs.create({ title: "Remove", steps: [step], requestedBy: "agent" });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]!.change!.settings[0]!.name).toBe(
      "DELETE /api/v1/queue/502?removeFromClient=false&blocklist=false",
    );
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/Chaptarr accepted DELETE \/api\/v1\/queue\/502/);
    const audit = await env.audit();
    expect(audit.some((a) => a.action.includes("(approved plan)"))).toBe(true);
    expect(JSON.stringify([audit, done])).not.toContain("e2e-chaptarr-key");
  });
});

describe("repairs inside apps: one qBittorrent torrent (resume, pause, reannounce, recheck)", () => {
  afterEach(() => fakeOutages.restoreAll());

  const ORVILLE = "a".repeat(40);
  const GHOSTS = "b".repeat(40);

  /** A stand-in qBittorrent (v5 style, with v4's pause/resume names refused) that keeps state. */
  function fakeQbittorrent() {
    const torrents: Record<string, Record<string, unknown>> = {
      [ORVILLE]: {
        name: "The Orville S02E04",
        state: "stoppedDL",
        progress: 0.4,
        size: 1000,
        num_seeds: 0,
        num_complete: 0,
        tracker: "https://tracker.example/announce?passkey=personal-passkey",
      },
      [GHOSTS]: {
        name: "Ghosts S05E02",
        state: "downloading",
        progress: 0.7,
        size: 1000,
        dlspeed: 200_000,
        num_seeds: 4,
        num_complete: 9,
      },
    };
    const trackers: Record<string, { url: string; status: number; msg: string }[]> = {
      [ORVILLE]: [
        { url: "** [DHT] **", status: 2, msg: "" },
        {
          url: "https://tracker.example/announce?passkey=personal-passkey",
          status: 4,
          msg: "timed out",
        },
      ],
      [GHOSTS]: [{ url: "https://tracker.example/announce", status: 2, msg: "" }],
    };
    let checkingReads = 0;
    const calls: { method: string; path: string; body?: string }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      calls.push({ method, path: u.pathname, body: init.body });
      const reply = (status: number, data: unknown, cookie?: string) => ({
        ok: status < 400,
        status,
        json: async () => data,
        text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
        headers: { get: (n: string) => (n === "set-cookie" && cookie ? cookie : null) },
      });
      const hash = (u.searchParams.get("hashes") ?? u.searchParams.get("hash") ?? "").toLowerCase();
      const posted = new URLSearchParams(init.body ?? "").get("hashes") ?? "";
      if (u.pathname === "/api/v2/auth/login")
        return reply(200, "Ok.", "SID=session-cookie; path=/");
      if (u.pathname === "/api/v2/auth/logout") return reply(200, "");
      if (u.pathname === "/api/v2/torrents/info") {
        const t = torrents[hash];
        if (t?.state === "checkingDL" && ++checkingReads > 1) t.state = "stalledDL";
        return reply(200, t ? [{ hash, ...t }] : []);
      }
      if (u.pathname === "/api/v2/torrents/trackers") return reply(200, trackers[hash] ?? []);
      if (u.pathname === "/api/v2/torrents/properties")
        return reply(200, { reannounce: trackers[hash]?.[1]?.status === 2 ? 1800 : 30 });
      const t = torrents[posted];
      if (method === "POST" && t) {
        if (u.pathname === "/api/v2/torrents/start") {
          t.state = "stalledDL"; // runs, but nobody seeds it
          return reply(200, "");
        }
        if (u.pathname === "/api/v2/torrents/stop") {
          t.state = "stoppedDL";
          return reply(200, "");
        }
        if (u.pathname === "/api/v2/torrents/delete") {
          delete torrents[posted];
          return reply(200, "");
        }
        if (u.pathname === "/api/v2/torrents/reannounce") {
          trackers[posted]![trackers[posted]!.length - 1] = {
            ...trackers[posted]!.at(-1)!,
            status: 2,
            msg: "",
          };
          return reply(200, "");
        }
        if (u.pathname === "/api/v2/torrents/recheck") {
          t.state = "checkingDL";
          checkingReads = 0;
          return reply(200, "");
        }
      }
      return reply(404, "");
    };
    return { torrents, trackers, calls, fetchImpl };
  }

  async function setup(scope: "read" | "approved-changes" = "approved-changes") {
    const env = await realEnvironment();
    // The test environment's SABnzbd plays qBittorrent (same network, same Gluetun dependency).
    const svc = (await env.workspace()).services.find((s) => s.name === "SABnzbd")!;
    env.handle.sqlite
      .prepare("UPDATE services SET name = 'qBittorrent', image = ? WHERE id = ?")
      .run("lscr.io/linuxserver/qbittorrent:latest", svc.id);
    const qb = fakeQbittorrent();
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      qb.fetchImpl,
      undefined,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    const login = await env.vault.add({
      name: "qBittorrent Web UI",
      kind: "login",
      tier: "automation",
      serviceId: svc.id,
      username: "admin",
      value: "qb-password-value",
      scope,
    });
    return { env, svc, qb, jobs, login };
  }

  const changes = (qb: ReturnType<typeof fakeQbittorrent>) =>
    qb.calls.filter((c) => c.method === "POST" && c.path.startsWith("/api/v2/torrents/"));

  it("needs the 'changes you approve' scope, then plans one torrent exactly; the AI's plan always waits for you", async () => {
    const { env, svc, qb, jobs, login } = await setup("read");
    const step = { kind: "app-qbt-resume" as const, serviceId: svc.id, params: { hash: ORVILLE } };
    const limited = await jobs.create({ title: "Resume", steps: [step], requestedBy: "agent" });
    expect(limited).toMatchObject({
      status: "refused",
      summary: expect.stringMatching(/limited to diagnostics/),
    });

    await env.vault.update(login.id, { scope: "approved-changes" });
    await env.call("PATCH", "/api/settings", { liveRepairs: true });
    await env.call("PUT", "/api/autonomy", {
      default: "auto",
      rules: [{ id: svc.autonomyArea, level: "auto" }],
    });
    const job = await jobs.create({ title: "Resume", steps: [step], requestedBy: "agent" });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]).toMatchObject({
      label: 'Resume the torrent "The Orville S02E04" in qBittorrent',
      policy: "approve-first",
      params: { hash: ORVILLE, torrent: "The Orville S02E04", state: "stoppedDL" },
      change: {
        settings: [
          { name: "The Orville S02E04: state", before: "Paused (stoppedDL)", after: "Running" },
        ],
      },
    });
    expect(changes(qb)).toEqual([]);

    // Plans that make no sense for the torrent as it is, or name no torrent, are refused with the reason.
    const plan = (kind: "app-qbt-resume" | "app-qbt-reannounce" | "app-qbt-pause", hash: string) =>
      jobs.create({
        title: "x",
        steps: [{ kind, serviceId: svc.id, params: { hash } }],
        requestedBy: "you",
      });
    expect((await plan("app-qbt-resume", GHOSTS)).summary).toMatch(/is not paused/);
    expect((await plan("app-qbt-reannounce", ORVILLE)).summary).toMatch(
      /paused torrent does not talk/,
    );
    expect((await plan("app-qbt-pause", "c".repeat(40))).summary).toMatch(
      /no torrent with the hash/,
    );
    expect((await plan("app-qbt-pause", "not-a-hash")).summary).toMatch(/by its hash/);
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const wrong = await jobs.create({
      title: "x",
      steps: [{ ...step, serviceId: sonarr.id }],
      requestedBy: "you",
    });
    expect(wrong.summary).toMatch(/only supported for qBittorrent/);
    await expect(
      env.runner.request({ kind: "app-qbt-pause", serviceId: svc.id, requestedBy: "you" }),
    ).rejects.toThrow(/plan/);
    expect(changes(qb)).toEqual([]);
  });

  it("approved resume: verified running, but reported not fixed when no one seeds it; audited, no secrets kept", async () => {
    const { env, svc, qb, jobs } = await setup();
    const job = await jobs.create({
      title: "Resume The Orville",
      steps: [{ kind: "app-qbt-resume", serviceId: svc.id, params: { hash: ORVILLE } }],
      requestedBy: "agent",
    });
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /Resumed and verified it is running; but it is not fixed: Stalled: no seeders in the swarm/,
    );
    // Exactly one change call, for this torrent only.
    expect(changes(qb)).toEqual([
      { method: "POST", path: "/api/v2/torrents/start", body: `hashes=${ORVILLE}` },
    ]);
    expect(qb.torrents[GHOSTS]!.state).toBe("downloading");
    const audit = await env.audit();
    expect(audit.find((a) => a.action.startsWith("Resumed the torrent"))).toMatchObject({
      action: 'Resumed the torrent "The Orville S02E04" in qBittorrent',
      detail: expect.objectContaining({
        verified: true,
        fixed: false,
        before: "Paused (stoppedDL)",
      }),
    });
    const everything = JSON.stringify([audit, await jobs.get(job.id)]);
    expect(everything).not.toContain("qb-password-value");
    expect(everything).not.toContain("personal-passkey");
    expect(everything).not.toContain("session-cookie");
  });

  it("refuses a stale or mismatched target without changing anything; undoes a resume when a later step fails", async () => {
    const { env, svc, qb, jobs } = await setup();
    const pause = { kind: "app-qbt-pause" as const, serviceId: svc.id, params: { hash: GHOSTS } };

    const drift = await jobs.create({ title: "Pause", steps: [pause], requestedBy: "you" });
    qb.torrents[GHOSTS]!.state = "stalledDL"; // changed by itself since approval
    await jobs.decide(drift.id, "approve", drift.approval!.fingerprint);
    await jobs.idle();
    expect((await jobs.get(drift.id)).steps[0]!.result).toMatch(
      /now Stalled \(stalledDL\), not downloading as when this plan was approved. Nothing was changed/,
    );

    qb.torrents[GHOSTS]!.state = "downloading";
    const renamed = await jobs.create({ title: "Pause", steps: [pause], requestedBy: "you" });
    qb.torrents[GHOSTS]!.name = "Something else";
    await jobs.decide(renamed.id, "approve", renamed.approval!.fingerprint);
    await jobs.idle();
    expect((await jobs.get(renamed.id)).steps[0]!.result).toMatch(
      /now named "Something else".*Nothing was changed/,
    );

    qb.torrents[GHOSTS]!.name = "Ghosts S05E02";
    const gone = await jobs.create({ title: "Pause", steps: [pause], requestedBy: "you" });
    const saved = qb.torrents[GHOSTS]!;
    delete qb.torrents[GHOSTS];
    await jobs.decide(gone.id, "approve", gone.approval!.fingerprint);
    await jobs.idle();
    expect((await jobs.get(gone.id)).steps[0]!.result).toMatch(/no longer in qBittorrent/);
    qb.torrents[GHOSTS] = saved;
    expect(changes(qb)).toEqual([]);

    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    fakeOutages.stopContainer("sonarr", 1);
    const plan = await jobs.create({
      title: "Resume, then check Sonarr",
      steps: [
        { kind: "app-qbt-resume", serviceId: svc.id, params: { hash: ORVILLE } },
        { kind: "run-check", serviceId: sonarr.id },
      ],
      requestedBy: "you",
    });
    await jobs.decide(plan.id, "approve", plan.approval!.fingerprint);
    await jobs.idle();
    const rolled = await jobs.get(plan.id);
    expect(rolled.status, rolled.summary).toBe("rolled-back");
    expect(rolled.steps[0]!.result).toMatch(/Rollback: Paused and verified/);
    expect(qb.torrents[ORVILLE]!.state).toBe("stoppedDL");
  });

  it("removing a torrent: keeping its data and deleting it are separate steps, each for one exact torrent, never undone", async () => {
    const { svc, qb, jobs } = await setup();
    const keep = await jobs.create({
      title: "Remove Ghosts, keep the files",
      steps: [{ kind: "app-qbt-remove", serviceId: svc.id, params: { hash: GHOSTS } }],
      requestedBy: "agent",
    });
    expect(keep.status).toBe("awaiting-approval");
    expect(keep.steps[0]!.rollback).toMatch(/Cannot be undone by Hearth/);
    const wipe = await jobs.create({
      title: "Remove The Orville and delete its data",
      steps: [{ kind: "app-qbt-remove-with-data", serviceId: svc.id, params: { hash: ORVILLE } }],
      requestedBy: "agent",
    });
    expect(wipe.status).toBe("awaiting-approval");
    expect(JSON.stringify(wipe.steps[0]!.change)).toMatch(/DELETE/);
    expect(changes(qb)).toEqual([]);

    await jobs.decide(keep.id, "approve", keep.approval!.fingerprint);
    await jobs.idle();
    const kept = await jobs.get(keep.id);
    expect(kept.status, kept.summary).toBe("succeeded");
    expect(kept.steps[0]!.result).toMatch(/its downloaded data was left on disk/);
    await jobs.decide(wipe.id, "approve", wipe.approval!.fingerprint);
    await jobs.idle();
    const wiped = await jobs.get(wipe.id);
    expect(wiped.steps[0]!.result).toMatch(/no freed space is claimed/);
    expect(changes(qb)).toEqual([
      {
        method: "POST",
        path: "/api/v2/torrents/delete",
        body: `hashes=${GHOSTS}&deleteFiles=false`,
      },
      {
        method: "POST",
        path: "/api/v2/torrents/delete",
        body: `hashes=${ORVILLE}&deleteFiles=true`,
      },
    ]);
  });

  it("reannounce and recheck: verified by what qBittorrent shows afterwards, never just by the request", async () => {
    const { svc, qb, jobs } = await setup();
    qb.torrents[ORVILLE]!.state = "stalledDL";
    const job = await jobs.create({
      title: "Ask the trackers, then recheck",
      steps: [
        { kind: "app-qbt-reannounce", serviceId: svc.id, params: { hash: ORVILLE } },
        { kind: "app-qbt-recheck", serviceId: svc.id, params: { hash: ORVILLE } },
      ],
      requestedBy: "you",
    });
    expect(job.steps[0]!.change!.settings[0]).toMatchObject({
      before: "tracker.example not working",
    });
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /Trackers asked again and verified they answered: tracker.example working; 0 seeders .*not fixed: Stalled: no seeders/,
    );
    expect(done.steps[1]!.result).toMatch(/Recheck finished: .* 40% complete on disk \(was 40%\)/);
    expect(changes(qb).map((c) => c.path)).toEqual([
      "/api/v2/torrents/reannounce",
      "/api/v2/torrents/recheck",
    ]);
    expect(JSON.stringify(done)).not.toContain("personal-passkey");
  });
});

describe("restart history, log windows, and the service timeline (Logs, Health, History tabs)", () => {
  afterEach(() => fakeOutages.restoreAll());

  const svcByContainer = async (env: Awaited<ReturnType<typeof realEnvironment>>, name: string) =>
    (await env.workspace()).services.find((s) => s.container === name)!;

  it("records each start and stop with who caused it, from Docker's own data, within its limits", async () => {
    const env = await realEnvironment();
    const log = new RestartLog(env.handle, fakeContainerTools);
    const first = await log.sweep();
    expect(first).toBeGreaterThan(3);
    expect(await log.sweep()).toBe(0); // nothing changed, nothing recorded

    const sonarr = await svcByContainer(env, "sonarr");
    const restart = await env.call("POST", "/api/actions", {
      kind: "restart-container",
      serviceId: sonarr.id,
    });
    expect(restart.statusCode, restart.body).toBe(200);
    await env.runner.idle();
    const prowlarr = await svcByContainer(env, "prowlarr");
    fakeOutages.dockerRestarted("prowlarr");
    const sab = await svcByContainer(env, "sabnzbd");
    fakeOutages.stopContainer("sabnzbd", 137);
    expect(await log.sweep()).toBe(3);

    const view = async (id: string) =>
      (await env.call("GET", `/api/services/${id}/restarts`)).json<{
        events: { kind: string; cause: string; text: string }[];
      }>().events;
    expect((await view(sonarr.id))[0]).toMatchObject({
      kind: "start",
      cause: "dragon-control",
      text: "Started by Hearth (an action it ran)",
    });
    expect((await view(prowlarr.id))[0]).toMatchObject({
      cause: "docker",
      text: "Restarted by Docker (its restart policy)",
    });
    expect((await view(sab.id))[0]).toMatchObject({
      kind: "stop",
      text: "Stopped: killed for running out of memory",
    });
    expect((await view(sab.id)).at(-1)).toMatchObject({ cause: "first-seen" });

    const settings = (await env.call("GET", "/api/history/restarts")).json<{
      enabled: boolean;
      retentionDays: number;
      keepPerService: number;
      stored: { rows: number };
    }>();
    expect(settings).toMatchObject({ enabled: true, retentionDays: 90, keepPerService: 300 });
    expect(settings.stored.rows).toBe(first + 3);
    expect((await env.call("PUT", "/api/history/restarts", { retentionDays: 7 })).statusCode).toBe(
      409,
    );
    await env.call("PUT", "/api/history/restarts", { enabled: false });
    fakeOutages.dockerRestarted("prowlarr");
    await log.tick();
    expect((await view(prowlarr.id)).filter((e) => e.cause === "docker")).toHaveLength(1);
    expect((await env.audit()).map((a) => a.action)).toContain("Turned restart history off");

    // Retention: anything older than the kept days goes on the next prune.
    env.handle.sqlite
      .prepare("UPDATE container_events SET at = '2020-01-01T00:00:00Z' WHERE service_id = ?")
      .run(sab.id);
    expect(await log.prune(true)).toBeGreaterThan(0);
    expect(await view(sab.id)).toEqual([]);
  });

  it("you read logs for a time window, filtered, with times; a bad window is a plain answer", async () => {
    const env = await realEnvironment();
    const sonarr = await svcByContainer(env, "sonarr");
    const r = await env.call("POST", "/api/actions", {
      kind: "inspect-logs",
      serviceId: sonarr.id,
      logs: { since: "6h", filter: "ready" },
    });
    expect(r.statusCode, r.body).toBe(200);
    const lines = r.json<{ lines: string[] }>().lines;
    // A summary of the window first, then the matching lines with their times.
    expect(lines[0]).toMatch(/^\(3 lines in .* to now, 1 containing "ready", showing all\)$/);
    expect(lines.slice(1)).toEqual([
      expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:]+Z \[sonarr\] Ready$/),
    ]);
    const bad = await env.call("POST", "/api/actions", {
      kind: "inspect-logs",
      serviceId: sonarr.id,
      logs: { since: "yesterday-ish" },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.statusCode).toBeLessThan(500);
    // The window is only for reading logs.
    const odd = await env.call("POST", "/api/actions", {
      kind: "run-check",
      serviceId: sonarr.id,
      logs: { since: "6h", nope: 1 },
    });
    expect(odd.statusCode).toBe(400);
  });

  it("History: incidents, actions, plans, changes, restarts, and investigations in one timeline", async () => {
    const env = await realEnvironment();
    const log = new RestartLog(env.handle, fakeContainerTools);
    await log.sweep();
    const sonarr = await svcByContainer(env, "sonarr");
    fakeOutages.stopContainer("sonarr", 1);
    await env.check();
    await env.check();
    await env.call("POST", "/api/actions", { kind: "restart-container", serviceId: sonarr.id });
    await env.runner.idle();
    await log.sweep();
    await env.call("PUT", `/api/services/${sonarr.id}/lifecycle`, {
      lifecycle: "paused",
      note: "testing",
    });
    const t = (await env.call("GET", `/api/services/${sonarr.id}/timeline?days=7`)).json<{
      events: { kind: string; title: string; link?: string; by?: string }[];
    }>().events;
    const kinds = new Set(t.map((e) => e.kind));
    for (const k of ["incident", "action", "change", "restart"]) expect(kinds, k).toContain(k);
    expect(t.find((e) => e.kind === "change")).toMatchObject({
      title: "Marked Sonarr as paused",
      by: "you",
    });
    // The restart you asked for (an automatic one may also appear, depending on timing).
    expect(t.find((e) => e.kind === "action" && e.by === "you")).toMatchObject({
      title: "Restart the Sonarr container: succeeded",
    });
    expect(t.find((e) => e.kind === "incident")!.link).toMatch(/^\/incidents\//);
    // Newest first.
    const ats = t.map((e) => (e as unknown as { at: string }).at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });
});

describe("library repairs: a Radarr movie and its Plex versions (re-grabs, upgrades, duplicates)", () => {
  afterEach(() => fakeOutages.restoreAll());

  /** Stand-in Radarr and Plex that keep state, so changes and read-backs are real. */
  function fakeLibrary(opts: { plexAllowsDeletion?: boolean } = {}) {
    const movies = [
      {
        id: 7,
        title: "Colony",
        year: 2021,
        monitored: true,
        qualityProfileId: 4,
        hasFile: true,
        path: "/movies/Colony (2021)",
      },
      {
        id: 8,
        title: "Colony Bay",
        year: 2019,
        monitored: true,
        qualityProfileId: 4,
        hasFile: false,
      },
      { id: 9, title: "Other", monitored: true, qualityProfileId: 5, hasFile: false },
    ];
    const files: Record<number, Record<string, unknown>[]> = {
      7: [
        {
          id: 70,
          movieId: 7,
          path: "/movies/Colony (2021)/Colony.2021.2160p.mkv",
          size: 30 * 1024 ** 3,
          quality: { quality: { name: "Bluray-2160p" } },
          customFormatScore: 120,
        },
      ],
    };
    const profiles: Record<number, Record<string, unknown>> = {
      4: {
        id: 4,
        name: "Any",
        upgradeAllowed: true,
        cutoff: 31,
        items: [{ quality: { id: 31, name: "Remux-2160p" }, allowed: true }],
        cutoffFormatScore: 10000,
      },
    };
    const plexMedia = [
      {
        id: 901,
        videoResolution: "4k",
        Part: [{ file: "/movies/Colony (2021)/Colony.2021.2160p.mkv", size: 30 * 1024 ** 3 }],
      },
      {
        id: 902,
        videoResolution: "1080",
        Part: [{ file: "/movies/Colony (2021)/Colony.2021.1080p.mkv", size: 2.4 * 1024 ** 3 }],
      },
    ];
    const calls: {
      method: string;
      path: string;
      body?: string;
      headers: Record<string, string>;
    }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      calls.push({ method, path: u.pathname + u.search, body: init.body, headers: init.headers });
      const reply = (status: number, data: unknown) => ({
        ok: status < 400,
        status,
        json: async () => data,
      });
      const p = u.pathname;
      // Radarr
      if (p === "/api/v3/movie" && method === "GET") return reply(200, structuredClone(movies));
      const movie = /^\/api\/v3\/movie\/(\d+)$/.exec(p);
      if (movie) {
        const m = movies.find((x) => x.id === Number(movie[1]));
        if (!m) return reply(404, {});
        if (method === "PUT") Object.assign(m, JSON.parse(init.body!));
        return reply(method === "PUT" ? 202 : 200, structuredClone(m));
      }
      if (p === "/api/v3/moviefile" && method === "GET")
        return reply(200, structuredClone(files[Number(u.searchParams.get("movieId"))] ?? []));
      const mf = /^\/api\/v3\/moviefile\/(\d+)$/.exec(p);
      if (mf && method === "DELETE") {
        for (const k of Object.keys(files))
          files[Number(k)] = files[Number(k)]!.filter((f) => f.id !== Number(mf[1]));
        return reply(200, {});
      }
      const qp = /^\/api\/v3\/qualityprofile\/(\d+)$/.exec(p);
      if (qp) {
        const prof = profiles[Number(qp[1])];
        if (!prof) return reply(404, {});
        if (method === "PUT") Object.assign(prof, JSON.parse(init.body!));
        return reply(method === "PUT" ? 202 : 200, structuredClone(prof));
      }
      if (p === "/api/v3/history/movie")
        return reply(200, [
          {
            date: "2026-10-07T19:54:00Z",
            eventType: "downloadFolderImported",
            sourceTitle: "Colony.2021.1080p.WEB",
            quality: { quality: { name: "WEBDL-1080p" } },
          },
          {
            date: "2026-10-10T11:35:00Z",
            eventType: "grabbed",
            sourceTitle: "Colony.2021.2160p.BluRay",
            quality: { quality: { name: "Bluray-2160p" } },
            customFormatScore: 120,
            data: { indexer: "PublicTracker" },
          },
          {
            date: "2026-10-10T12:08:00Z",
            eventType: "movieFileDeleted",
            sourceTitle: "Colony.2021.1080p.WEB",
            data: { reason: "Upgrade" },
          },
        ]);
      if (p === "/api/v3/config/mediamanagement")
        return reply(200, { recycleBin: "/recycle", recycleBinCleanupDays: 7 });
      if (p === "/api/v3/manualimport")
        return reply(200, [
          {
            path: "/movies/Colony (2021)/Colony.2021.1080p.mkv",
            size: 2.4 * 1024 ** 3,
            quality: { quality: { name: "WEBDL-1080p" } },
            rejections: [{ reason: "Not an upgrade for existing movie file" }],
          },
        ]);
      // Plex
      if (p === "/library/sections")
        return reply(200, {
          MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Movies" }] },
        });
      if (p === "/library/sections/1/all")
        return reply(200, {
          MediaContainer: {
            Metadata: [
              { ratingKey: "500", title: "Colony", year: 2021, Media: structuredClone(plexMedia) },
            ],
          },
        });
      if (p === "/library/metadata/500")
        return reply(200, {
          MediaContainer: {
            Metadata: [
              { ratingKey: "500", title: "Colony", year: 2021, Media: structuredClone(plexMedia) },
            ],
          },
        });
      const pm = /^\/library\/metadata\/500\/media\/(\d+)$/.exec(p);
      if (pm && method === "DELETE") {
        const i = plexMedia.findIndex((x) => x.id === Number(pm[1]));
        if (i >= 0) plexMedia.splice(i, 1);
        return reply(200, {});
      }
      if (p === "/:/prefs")
        return reply(200, {
          MediaContainer: {
            Setting: [{ id: "allowMediaDeletion", value: opts.plexAllowsDeletion ?? true }],
          },
        });
      return reply(404, {});
    };
    return { movies, files, profiles, plexMedia, calls, fetchImpl };
  }

  async function setup(
    opts: { plexAllowsDeletion?: boolean; scope?: "read" | "approved-changes" } = {},
  ) {
    const env = await realEnvironment();
    const ws = await env.workspace();
    // The test environment's Sonarr plays Radarr and its SABnzbd plays Plex.
    const radarr = ws.services.find((s) => s.name === "Sonarr")!;
    const plex = ws.services.find((s) => s.name === "SABnzbd")!;
    env.handle.sqlite
      .prepare(
        "UPDATE services SET name = 'Radarr', image = 'lscr.io/linuxserver/radarr:latest' WHERE id = ?",
      )
      .run(radarr.id);
    env.handle.sqlite
      .prepare(
        "UPDATE services SET name = 'Plex', image = 'plexinc/pms-docker:latest' WHERE id = ?",
      )
      .run(plex.id);
    const lib = fakeLibrary(opts);
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      lib.fetchImpl,
      undefined,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    for (const [svc, value] of [
      [radarr, "radarr-key-value"],
      [plex, "plex-token-value"],
    ] as const) {
      await env.vault.add({
        name: `${svc.id} key`,
        kind: "api-key",
        tier: "automation",
        serviceId: svc.id,
        value,
        scope: opts.scope ?? "approved-changes",
      });
    }
    return { env, radarr, plex, lib, jobs };
  }

  const approveAndRun = async (jobs: Jobs, job: Job) => {
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    return jobs.get(job.id);
  };

  it("workspace plans: frozen snapshot, only items chosen to act on, revisions flagged and replaced, items skipped safely, verified space only", async () => {
    const { env, lib, jobs, radarr, plex } = await setup();
    const at = new Date().toISOString();
    env.handle.sqlite
      .prepare(
        "INSERT INTO conversations (id, source, title, status, created_at, updated_at) VALUES ('c1', 'app', 'Duplicates', 'idle', ?, ?)",
      )
      .run(at, at);
    const ws = new Workspaces(env.handle);
    const plans = new WorkspacePlans(env.handle, ws, jobs);
    jobs.itemCheck = (job, step) => plans.check(job, step);
    const small = "/movies/Colony (2021)/Colony.2021.1080p.mkv";
    const big = "/movies/Colony (2021)/Colony.2021.2160p.mkv";
    const v = await ws.create({
      conversationId: "c1",
      spec: {
        title: "Colony copies",
        columns: [{ key: "file", label: "File", kind: "path" }],
        choices: [
          { value: "keep", label: "Keep" },
          { value: "discard", label: "Discard", acts: true },
        ],
        items: [
          { id: small, values: { file: small } },
          { id: big, values: { file: big } },
        ],
      },
    });
    await ws.select(v.id, { [small]: "discard", [big]: "keep" });
    const first = await ws.submit(v.id);
    expect(first.submission!.snapshotId).toBeTruthy();

    const plexStep = (item: string) => ({
      item,
      kind: "app-plex-delete-media" as const,
      serviceId: plex.id,
      params: { ratingKey: "500", mediaId: 902 },
    });
    const radarrStep = (item: string) => ({
      item,
      kind: "app-radarr-delete-file" as const,
      serviceId: radarr.id,
      params: { movieId: 7, movieFileId: 70 },
    });
    const propose = (steps: WorkspacePlanInput["steps"]) =>
      plans.propose("c1", {
        workspaceId: v.id,
        title: "Remove duplicate copies",
        reason: "Owner's picks",
        steps,
      });

    // Never an item they chose to keep, and never a step that acts on another item.
    await expect(propose([radarrStep(big)])).rejects.toThrow(/chose "Keep"/);
    await expect(propose([radarrStep(small)])).rejects.toThrow(/not the item/);

    const j1 = (await propose([plexStep(small)])).job;
    expect(j1).toMatchObject({
      status: "awaiting-approval",
      workspace: { id: v.id, snapshotId: first.submission!.snapshotId },
      steps: [{ itemId: small }],
    });
    const fp1 = j1.approval!.fingerprint;

    // Editing after the plan: the plan does not change, and the change is flagged.
    await ws.select(v.id, { [big]: "discard" });
    const edited = await ws.get(v.id);
    expect(edited.revised).toMatchObject({ jobId: j1.id, changed: [big] });
    const j1again = await jobs.get(j1.id);
    expect(j1again.approval!.fingerprint).toBe(fp1);
    expect(j1again.steps.map((s) => s.itemId)).toEqual([small]);
    // No plan from decisions changed since submitting.
    await expect(propose([plexStep(small)])).rejects.toThrow(/submit again/);

    // Submitting again says the waiting plan reflects the earlier submission.
    const second = await ws.submit(v.id);
    expect(submissionMessage(second)).toContain("does not reflect these decisions");
    expect(submissionMessage(second)).toContain("replacement plan");

    // The replacement plan replaces the waiting one, which can no longer be approved.
    const j2 = (await propose([plexStep(small), radarrStep(big)])).job;
    expect(j2.workspace!.snapshotId).toBe(second.submission!.snapshotId);
    expect(await jobs.get(j1.id)).toMatchObject({ status: "cancelled" });
    expect((await jobs.get(j1.id)).summary).toContain(
      "Replaced by a plan for your revised decisions",
    );
    await expect(jobs.decide(j1.id, "approve", fp1)).rejects.toThrow(/not waiting/);

    // Radarr's file changes before it runs: that item is skipped, the other still done.
    lib.files[7]![0]!.size = 31 * 1024 ** 3;
    const done = await approveAndRun(jobs, j2);
    expect(done.status).toBe("partial");
    expect(done.steps.map((s) => [s.itemId, s.status])).toEqual([
      [small, "succeeded"],
      [big, "skipped"],
    ]);
    expect(done.steps[1]!.result).toMatch(/^Skipped: File #70 of Colony \(2021\) is now/);
    expect(done.summary).toMatch(
      /^1 of 2 done and verified, 1 skipped \(nothing done to them\)\. Verified space freed: 2\.4 GB\./,
    );
    expect(lib.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/library/metadata/500/media/902",
    ]);

    // Shown per item in the workspace, with space only from the verified delete.
    const shown = await ws.get(v.id);
    expect(shown.plans![0]).toMatchObject({
      jobId: j2.id,
      status: "partial",
      items: { [small]: { status: "done" }, [big]: { status: "skipped" } },
      counts: { done: 1, skipped: 1, failed: 0 },
      freedBytes: Math.round(2.4 * 1024 ** 3),
    });
    expect(shown.plans![1]).toMatchObject({
      jobId: j1.id,
      items: { [small]: { status: "not-run" } },
    });
    expect(shown.revised).toBeUndefined();

    // A change of mind after approving always wins, in the safe direction.
    await ws.select(v.id, { [small]: "keep" });
    expect(
      await plans.check(
        { workspaceId: v.id, snapshotId: second.submission!.snapshotId! },
        { itemId: small },
      ),
    ).toBe('You changed it to "Keep" after this plan was made.');
    // Discarding the workspace never touches the plan or its snapshot.
    await ws.remove(v.id);
    expect((await jobs.get(j2.id)).status).toBe("partial");
    expect(
      await plans.check(
        { workspaceId: v.id, snapshotId: second.submission!.snapshotId! },
        { itemId: small },
      ),
    ).toBeUndefined();
  });

  it("reads why a movie keeps being grabbed: profile, history with reasons, tracked and untracked copies, Plex versions", async () => {
    const { env, radarr, plex, lib } = await setup();
    const library = new MediaLibrary(new CredentialBroker(env.handle, env.vault), lib.fetchImpl);
    const svc = (s: typeof radarr) => ({
      id: s.id,
      name: s.name === "Sonarr" ? "Radarr" : "Plex",
      localUrl: s.localUrl!,
    });
    const several = await library.movieReport(svc(radarr), { title: "colon" });
    expect(several).toMatchObject({ matches: [{ movieId: 7 }, { movieId: 8 }] });
    const r = await library.movieReport(svc(radarr), { title: "Colony" }, "agent");
    expect(r).toMatchObject({
      movie: { movieId: 7, title: "Colony", monitored: true },
      qualityProfile: {
        profileId: 4,
        upgradesAllowed: true,
        upgradeUntil: "Remux-2160p",
        moviesUsingIt: 2,
      },
      trackedFiles: [{ movieFileId: 70, sizeGB: 30, quality: "Bluray-2160p" }],
      untrackedFilesInFolder: [
        { path: "/movies/Colony (2021)/Colony.2021.1080p.mkv", sizeGB: 2.4 },
      ],
      recycleBin: expect.stringMatching(/^\/recycle \(emptied after 7 days\)/),
    });
    expect((r.history as { event: string; reason?: string }[])[0]).toMatchObject({
      event: "file deleted",
      reason: "Upgrade",
    });
    const versions = await library.plexItems(svc(plex), "Colony");
    expect(versions).toMatchObject({
      plexAllowsDeletingMedia: true,
      items: [
        {
          ratingKey: "500",
          versions: [{ mediaId: 901 }, { mediaId: 902, files: [{ sizeGB: 2.4 }] }],
        },
      ],
    });
    // Keys travel as headers to each service's own address only, and the reads changed nothing.
    expect(lib.calls.every((c) => c.method === "GET")).toBe(true);
    expect(
      lib.calls.some((c) => c.path.includes("key-value") || c.path.includes("token-value")),
    ).toBe(false);
    expect((await env.audit()).map((a) => a.action)).toContain(
      "Ember used Radarr's Secure Vault credential to read the movie list (read only): worked",
    );
  });

  it("stops the re-grabs: unmonitor the movie and stop upgrades in its profile, each approved, verified, put back on failure", async () => {
    const { env, radarr, lib, jobs } = await setup();
    const job = await jobs.create({
      title: "Stop Colony re-grabs",
      steps: [
        {
          kind: "app-radarr-set-monitored",
          serviceId: radarr.id,
          params: { movieId: 7, monitored: false },
        },
        {
          kind: "app-radarr-set-upgrades",
          serviceId: radarr.id,
          params: { profileId: 4, upgradeAllowed: false },
        },
      ],
      requestedBy: "agent",
    });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps.map((s) => s.label)).toEqual([
      "Stop monitoring Colony (2021) in Radarr",
      'Stop upgrades in the "Any" quality profile in Radarr (used by 2 movies)',
    ]);
    expect(job.steps[0]!.change!.settings[0]).toEqual({
      name: "Colony (2021): monitored",
      before: "Yes",
      after: "No",
    });
    expect(lib.calls.some((c) => c.method !== "GET")).toBe(false);
    const done = await approveAndRun(jobs, job);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /Stopped monitoring Colony \(2021\), verified.*will not grab it again/,
    );
    expect(lib.movies[0]!.monitored).toBe(false);
    expect(lib.profiles[4]!.upgradeAllowed).toBe(false);
    expect((await env.audit()).map((a) => a.action)).toContain(
      "Stop monitoring Colony (2021) in Radarr",
    );

    // Put back when a later step fails.
    lib.movies[0]!.monitored = true;
    fakeOutages.stopContainer("prowlarr", 1);
    const prowlarr = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    const rolled = await approveAndRun(
      jobs,
      await jobs.create({
        title: "x",
        steps: [
          {
            kind: "app-radarr-set-monitored",
            serviceId: radarr.id,
            params: { movieId: 7, monitored: false },
          },
          { kind: "run-check", serviceId: prowlarr.id },
        ],
        requestedBy: "you",
      }),
    );
    expect(rolled.status, rolled.summary).toBe("rolled-back");
    expect(lib.movies[0]!.monitored).toBe(true);
  });

  it("deletes a duplicate: refused until Plex allows it, never the last copy, stale targets refused, verified after", async () => {
    const blocked = await setup({ plexAllowsDeletion: false });
    const refused = await blocked.jobs.create({
      title: "x",
      steps: [
        {
          kind: "app-plex-delete-media",
          serviceId: blocked.plex.id,
          params: { ratingKey: "500", mediaId: 901 },
        },
      ],
      requestedBy: "agent",
    });
    expect(refused.summary).toMatch(
      /does not allow deleting media.*Allow media deletion.*your decision/,
    );

    const { env, plex, radarr, lib, jobs } = await setup();
    const step = {
      kind: "app-plex-delete-media" as const,
      serviceId: plex.id,
      params: { ratingKey: "500", mediaId: 901 },
    };
    const job = await jobs.create({
      title: "Keep the 1080p copy",
      steps: [step],
      requestedBy: "agent",
    });
    expect(job.steps[0]!.change!.settings).toEqual([
      {
        name: "Colony (2021): version",
        before: "/movies/Colony (2021)/Colony.2021.2160p.mkv (4k, 30 GB)",
        after: "Deleted from disk by Plex (not recoverable by Hearth)",
      },
      {
        name: "Colony (2021): kept",
        before: "2 versions",
        after: "/movies/Colony (2021)/Colony.2021.1080p.mkv (1080, 2.4 GB)",
      },
    ]);
    // Stale: the version's file changed since approval.
    lib.plexMedia[0]!.Part[0]!.size += 1;
    const stale = await approveAndRun(jobs, job);
    expect(stale.steps[0]!.result).toMatch(/now a different file. Nothing was deleted/);
    lib.plexMedia[0]!.Part[0]!.size -= 1;
    expect(lib.calls.some((c) => c.method === "DELETE")).toBe(false);

    const done = await approveAndRun(
      jobs,
      await jobs.create({ title: "Keep the 1080p copy", steps: [step], requestedBy: "agent" }),
    );
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /verified: Plex now lists 1 version: .*1080p\.mkv \(1080\)/,
    );
    expect(lib.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/library/metadata/500/media/901",
    ]);
    // The last copy is never deleted.
    const last = await jobs.create({
      title: "x",
      steps: [{ ...step, params: { ratingKey: "500", mediaId: 902 } }],
      requestedBy: "you",
    });
    expect(last.summary).toMatch(/only copy/);

    // Radarr's own file: the plan says where it goes and what Radarr does next.
    const del = await jobs.create({
      title: "x",
      steps: [
        {
          kind: "app-radarr-delete-file",
          serviceId: radarr.id,
          params: { movieId: 7, movieFileId: 70 },
        },
      ],
      requestedBy: "agent",
    });
    expect(del.steps[0]!.change!.settings.slice(1)).toEqual([
      {
        name: "Where it goes",
        before: "On disk",
        after: expect.stringMatching(/^\/recycle .*can be restored/),
      },
      {
        name: "Colony (2021) afterwards",
        before: "1 file tracked",
        after: "No file, and Radarr is monitoring it, so it will search for it again",
      },
    ]);
    const deleted = await approveAndRun(jobs, del);
    expect(deleted.steps[0]!.result).toMatch(
      /^Deleted .*2160p\.mkv \(30 GB\) of Colony \(2021\), verified/,
    );
    expect(lib.files[7]).toEqual([]);
    const everything = JSON.stringify([await env.audit(), await jobs.list()]);
    expect(everything).not.toContain("radarr-key-value");
    expect(everything).not.toContain("plex-token-value");
  });

  it("Sonarr: the same repairs for an episode (stop re-grabs, delete one file), checked and verified", async () => {
    const env = await realEnvironment();
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const episodes = [
      {
        id: 31,
        seriesId: 3,
        seasonNumber: 1,
        episodeNumber: 2,
        title: "Pilot II",
        monitored: true,
        episodeFileId: 310,
      },
    ];
    const files: Record<number, Record<string, unknown>> = {
      310: {
        id: 310,
        seriesId: 3,
        relativePath: "Season 1/Show.S01E02.mkv",
        path: "/tv/Show/Season 1/Show.S01E02.mkv",
        size: 1.5 * 1024 ** 3,
        quality: { quality: { name: "WEBDL-1080p" } },
      },
    };
    const calls: { method: string; path: string; body?: string }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      calls.push({ method, path: u.pathname, body: init.body });
      const reply = (status: number, data: unknown) => ({
        ok: status < 400,
        status,
        json: async () => data,
      });
      const p = u.pathname;
      if (p === "/api/v3/series")
        return reply(200, [{ id: 3, title: "Show", monitored: true, qualityProfileId: 1 }]);
      if (p === "/api/v3/series/3")
        return reply(200, { id: 3, title: "Show", monitored: true, qualityProfileId: 1 });
      if (p === "/api/v3/episode/31") return reply(200, structuredClone(episodes[0]));
      if (p === "/api/v3/episode") return reply(200, structuredClone(episodes));
      if (p === "/api/v3/episode/monitor" && method === "PUT") {
        const body = JSON.parse(init.body!) as { episodeIds: number[]; monitored: boolean };
        for (const e of episodes) if (body.episodeIds.includes(e.id)) e.monitored = body.monitored;
        return reply(202, {});
      }
      const ef = /^\/api\/v3\/episodefile\/(\d+)$/.exec(p);
      if (ef) {
        const id = Number(ef[1]);
        if (method === "DELETE") {
          delete files[id];
          return reply(200, {});
        }
        return files[id] ? reply(200, structuredClone(files[id])) : reply(404, {});
      }
      if (p === "/api/v3/config/mediamanagement") return reply(200, { recycleBin: "" });
      return reply(404, {});
    };
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      fetchImpl,
      undefined,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    await env.vault.add({
      name: "Sonarr key",
      kind: "api-key",
      tier: "automation",
      serviceId: sonarr.id,
      value: "sonarr-key-value",
      scope: "approved-changes",
    });
    const job = await jobs.create({
      title: "Stop the re-grabs",
      steps: [
        {
          kind: "app-sonarr-set-monitored",
          serviceId: sonarr.id,
          params: { episodeId: 31, monitored: false },
        },
        { kind: "app-sonarr-delete-file", serviceId: sonarr.id, params: { episodeFileId: 310 } },
      ],
      requestedBy: "agent",
    });
    expect(job.status, job.summary).toBe("awaiting-approval");
    expect(job.steps[0]!.label).toBe("Stop monitoring Show S01E02 in Sonarr");
    expect(job.steps[1]!.change!.settings.slice(1)).toEqual([
      { name: "Where it goes", before: "On disk", after: "none: Sonarr deletes files permanently" },
      {
        name: "Afterwards",
        before: "Has this file",
        after: "No file, and Sonarr is monitoring the episode, so it will search for it again",
      },
    ]);
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/Stopped monitoring Show S01E02, verified/);
    expect(done.steps[1]!.result).toMatch(
      /^Deleted \/tv\/Show\/Season 1\/Show.S01E02.mkv \(1.5 GB\), verified/,
    );
    expect(episodes[0]!.monitored).toBe(false);
    expect(files[310]).toBeUndefined();
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /api/v3/episode/monitor",
      "DELETE /api/v3/episodefile/310",
    ]);
  });

  it("Sonarr: stop monitoring a whole series (Seerr's Stop tracking for a show), verified and undoable", async () => {
    const env = await realEnvironment();
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const series = { id: 3, title: "Show", monitored: true, qualityProfileId: 1, path: "/tv/Show" };
    const calls: string[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      calls.push(`${method} ${u.pathname}`);
      const reply = (status: number, data: unknown) => ({
        ok: status < 400,
        status,
        json: async () => data,
      });
      if (u.pathname === "/api/v3/series/3" && method === "PUT") {
        const body = JSON.parse(init.body!) as typeof series;
        // Sonarr takes the whole series back; only monitored changed.
        expect({ ...body, monitored: series.monitored }).toEqual(series);
        series.monitored = body.monitored;
        return reply(202, series);
      }
      if (u.pathname === "/api/v3/series/3") return reply(200, structuredClone(series));
      return reply(404, {});
    };
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      fetchImpl,
      undefined,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    await env.vault.add({
      name: "Sonarr key",
      kind: "api-key",
      tier: "automation",
      serviceId: sonarr.id,
      value: "sonarr-key-value",
      scope: "approved-changes",
    });
    const job = await jobs.create({
      title: "Stop tracking Show",
      steps: [
        {
          kind: "app-sonarr-set-monitored",
          serviceId: sonarr.id,
          params: { seriesId: 3, monitored: false },
        },
      ],
      requestedBy: "you",
    });
    expect(job.steps[0]!.label).toBe("Stop monitoring Show in Sonarr");
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/Stopped monitoring Show, verified/);
    expect(series.monitored).toBe(false);
    expect(calls.filter((c) => !c.startsWith("GET"))).toEqual(["PUT /api/v3/series/3"]);
  });

  it("a read-only credential cannot be used for these changes", async () => {
    const { radarr, jobs } = await setup({ scope: "read" });
    const job = await jobs.create({
      title: "x",
      steps: [
        {
          kind: "app-radarr-set-monitored",
          serviceId: radarr.id,
          params: { movieId: 7, monitored: false },
        },
      ],
      requestedBy: "you",
    });
    expect(job).toMatchObject({
      status: "refused",
      summary: expect.stringMatching(/limited to diagnostics/),
    });
  });
});

describe("the public address: sign-in name, remembered devices, and what the internet cannot do", () => {
  const PUBLIC = { "x-dc-public": "1", "x-forwarded-for": "203.0.113.9" };

  async function owned() {
    const app = await makeApp({ signedIn: false });
    const code = (await app.auth.setupCode())!;
    const setup = await app.send("POST", "/api/auth/setup", { code, password: TEST_PASSWORD });
    return { ...app, owner: app.cookieOf(setup)! };
  }

  it("from the internet: no setup, no access keys, no AI tool endpoint; your own sign-in works", async () => {
    const { send, owner } = await owned();
    const key = (
      await send("POST", "/api/keys", { name: "companion", scopes: ["read"] }, owner)
    ).json<{ key: string }>().key;
    expect(
      (
        await send("GET", "/api/workspace", undefined, undefined, {
          authorization: `Bearer ${key}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await send("GET", "/api/workspace", undefined, undefined, {
          ...PUBLIC,
          authorization: `Bearer ${key}`,
        })
      ).json<{ message: string }>().message,
    ).toMatch(/only work on your home network or Tailscale/);
    expect((await send("POST", "/api/mcp", {}, undefined, PUBLIC)).statusCode).toBe(403);
    expect(
      (
        await send(
          "POST",
          "/api/auth/setup",
          { code: "X", password: TEST_PASSWORD },
          undefined,
          PUBLIC,
        )
      ).statusCode,
    ).toBe(403);
    const status = (await send("GET", "/api/auth/status", undefined, undefined, PUBLIC)).json<{
      viaInternet: boolean;
    }>();
    expect(status.viaInternet).toBe(true);
    const login = await send(
      "POST",
      "/api/auth/login",
      { password: TEST_PASSWORD },
      undefined,
      PUBLIC,
    );
    expect(login.statusCode).toBe(204);
  });

  it("not remembered: the cookie ends with the browser and the sign-in after 12 hours; remembered: 90 days", async () => {
    const { send, cookieOf, handle, owner } = await owned();
    const short = await send("POST", "/api/auth/login", {
      password: TEST_PASSWORD,
      remember: false,
    });
    expect(short.cookies[0]!.maxAge).toBeUndefined();
    const long = await send(
      "POST",
      "/api/auth/login",
      { password: TEST_PASSWORD, remember: true },
      undefined,
      PUBLIC,
    );
    expect(long.cookies[0]!.maxAge).toBe(90 * 86_400);
    const rows = handle.sqlite
      .prepare(
        "SELECT persistent, via_public, created_at, expires_at FROM sessions ORDER BY created_at",
      )
      .all() as {
      persistent: number;
      via_public: number;
      created_at: string;
      expires_at: string;
    }[];
    const hours = (r: (typeof rows)[number]) =>
      (Date.parse(r.expires_at) - Date.parse(r.created_at)) / 3_600_000;
    expect(rows.map((r) => [r.persistent, r.via_public, Math.round(hours(r))])).toEqual([
      [1, 0, 90 * 24],
      [0, 0, 12],
      [1, 1, 90 * 24],
    ]);
    // Your devices: recognisable, and each can be signed out.
    const devices = (await send("GET", "/api/auth/devices", undefined, owner)).json<{
      devices: { id: string; current: boolean; remembered: boolean; viaInternet: boolean }[];
    }>().devices;
    expect(devices).toHaveLength(3);
    expect(devices.filter((d) => d.current)).toHaveLength(1);
    const internet = devices.find((d) => d.viaInternet)!;
    expect(
      (await send("DELETE", `/api/auth/devices/${internet.id}`, undefined, owner)).statusCode,
    ).toBe(204);
    expect((await send("GET", "/api/workspace", undefined, cookieOf(long))).statusCode).toBe(401);
  });

  it("Add a device: a one-time code signs a device in, once, never from the internet", async () => {
    const { send, cookieOf, owner } = await owned();
    const made = await send("POST", "/api/devices/codes", { purpose: "device" }, owner);
    expect(made.statusCode).toBe(200);
    const { code, addresses } = made.json<{ code: string; addresses: unknown[] }>();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(Array.isArray(addresses)).toBe(true);
    // Not from the internet, even with the right code.
    expect((await send("POST", "/api/auth/pair", { code }, undefined, PUBLIC)).statusCode).toBe(
      403,
    );
    // Typed in lower case without the dash still works, once.
    const typed = code.toLowerCase().replace("-", "");
    const paired = await send("POST", "/api/auth/pair", { code: typed });
    expect(paired.statusCode).toBe(204);
    const tablet = cookieOf(paired)!;
    expect((await send("GET", "/api/workspace", undefined, tablet)).statusCode).toBe(200);
    expect((await send("POST", "/api/auth/pair", { code })).statusCode).toBe(401);
    // The tablet has not proved it is you: it cannot make codes for other devices.
    expect(
      (await send("POST", "/api/devices/codes", { purpose: "device" }, tablet)).statusCode,
    ).toBe(403);
    // It shows in your devices, and removing it signs it out.
    const devices = (await send("GET", "/api/auth/devices", undefined, owner)).json<{
      devices: { id: string; method: string }[];
    }>().devices;
    const it2 = devices.find((d) => d.method === "paired")!;
    expect((await send("DELETE", `/api/auth/devices/${it2.id}`, undefined, owner)).statusCode).toBe(
      204,
    );
    expect((await send("GET", "/api/workspace", undefined, tablet)).statusCode).toBe(401);
    // A wrong code says so.
    expect(
      (await send("POST", "/api/auth/pair", { code: "ZZZZ-ZZZZ" })).json<{ message: string }>()
        .message,
    ).toMatch(/not right/);
  });

  it("a home tablet: paired with its own code, it reaches the home dashboard and nothing else", async () => {
    const { send, cookieOf, owner } = await owned();
    const { code } = (await send("POST", "/api/devices/codes", { purpose: "home" }, owner)).json<{
      code: string;
    }>();
    const paired = await send("POST", "/api/auth/pair", { code });
    expect(paired.statusCode).toBe(204);
    const tablet = cookieOf(paired)!;
    // It knows it is a home tablet, and nothing else about the owner's sign-ins.
    const status = (await send("GET", "/api/auth/status", undefined, tablet)).json<{
      method: string;
      passkeys?: unknown;
    }>();
    expect(status.method).toBe("home");
    expect(status.passkeys).toBeUndefined();
    // The home dashboard answers (no Home Assistant here, so a plain 404), the rest of Hearth refuses.
    expect((await send("GET", "/api/home", undefined, tablet)).statusCode).toBe(404);
    for (const [method, url] of [
      ["GET", "/api/workspace"],
      ["GET", "/api/vault/secrets"],
      ["GET", "/api/jobs"],
      ["POST", "/api/agent/conversations"],
      ["POST", "/api/home/connect"],
      ["POST", "/api/home/music-assistant/start"],
      ["PUT", "/api/home/pin"],
      ["POST", "/api/devices/codes"],
    ] as const)
      expect((await send(method, url, {}, tablet)).statusCode, `${method} ${url}`).toBe(403);
    // The owner sets the unlock PIN (digits only); a tablet never can.
    expect((await send("PUT", "/api/home/pin", { pin: "12" }, owner)).statusCode).toBe(409);
    expect((await send("PUT", "/api/home/pin", { pin: "2468" }, owner)).statusCode).toBe(204);
    expect((await send("PUT", "/api/home/pin", { pin: "1111" }, tablet)).statusCode).toBe(403);
    // It shows in your devices as a home tablet, and signing it out works.
    const devices = (await send("GET", "/api/auth/devices", undefined, owner)).json<{
      devices: { method: string }[];
    }>().devices;
    expect(devices.some((d) => d.method === "home")).toBe(true);
    expect((await send("POST", "/api/auth/logout", {}, tablet)).statusCode).toBe(204);
    expect((await send("GET", "/api/home", undefined, tablet)).statusCode).toBe(401);
  });

  it("a sign-in name and a new password, set without the old password only after confirming it is you", async () => {
    const { send, cookieOf, owner } = await owned();
    // With the vault key locked in this session, it is refused.
    await send("POST", "/api/vault/lock", {}, owner);
    const locked = await send(
      "POST",
      "/api/auth/credentials",
      { username: "Homeserver", password: "a new long passphrase" },
      owner,
    );
    expect(locked.statusCode).toBe(403);
    // Confirm (password here; a passkey works the same way), then set it.
    expect(
      (await send("POST", "/api/auth/login", { password: TEST_PASSWORD }, owner)).statusCode,
    ).toBe(204);
    expect(
      (
        await send(
          "POST",
          "/api/auth/credentials",
          { username: "Homeserver", password: "a new long passphrase" },
          owner,
        )
      ).statusCode,
    ).toBe(204);
    expect(
      (await send("GET", "/api/auth/status")).json<{ usernameRequired: boolean }>()
        .usernameRequired,
    ).toBe(true);
    // A new sign-in needs the name too (any case); the vault still opens with the new password.
    expect(
      (await send("POST", "/api/auth/login", { password: "a new long passphrase" })).statusCode,
    ).toBe(401);
    expect(
      (
        await send("POST", "/api/auth/login", {
          username: "nobody",
          password: "a new long passphrase",
        })
      ).json<{ message: string }>().message,
    ).toBe("That name or password is not right.");
    const ok = await send("POST", "/api/auth/login", {
      username: "homeserver",
      password: "a new long passphrase",
    });
    expect(ok.statusCode).toBe(204);
    expect((await send("GET", "/api/vault", undefined, cookieOf(ok))).statusCode).toBe(200);
  });

  it("guessing from the internet slows that address down and never locks you out at home", async () => {
    const { send } = await owned();
    for (let i = 0; i < 5; i++) {
      await send("POST", "/api/auth/login", { password: "wrong password here" }, undefined, PUBLIC);
    }
    expect(
      (await send("POST", "/api/auth/login", { password: TEST_PASSWORD }, undefined, PUBLIC))
        .statusCode,
    ).toBe(429);
    // Another internet address, and home or Tailscale, are unaffected.
    expect(
      (
        await send("POST", "/api/auth/login", { password: TEST_PASSWORD }, undefined, {
          ...PUBLIC,
          "x-forwarded-for": "198.51.100.4",
        })
      ).statusCode,
    ).toBe(204);
    expect((await send("POST", "/api/auth/login", { password: TEST_PASSWORD })).statusCode).toBe(
      204,
    );
  });
});

describe("Sonarr/Radarr operations: a stuck import, a missing episode, where upgrades stop", () => {
  afterEach(() => fakeOutages.restoreAll());

  function fakeSonarr() {
    const episodes: Record<
      number,
      {
        id: number;
        seriesId: number;
        seasonNumber: number;
        episodeNumber: number;
        monitored: boolean;
        hasFile: boolean;
      }
    > = {
      701: {
        id: 701,
        seriesId: 7,
        seasonNumber: 2,
        episodeNumber: 1,
        monitored: true,
        hasFile: false,
      },
      702: {
        id: 702,
        seriesId: 7,
        seasonNumber: 2,
        episodeNumber: 2,
        monitored: true,
        hasFile: false,
      },
    };
    const queue = [
      {
        id: 101,
        downloadId: "ABC123",
        title: "Ghosts.US.S02E01.1080p.WEB-GROUP",
        protocol: "torrent",
        episodeId: 701,
        seriesId: 7,
        status: "completed",
        sizeleft: 0,
        trackedDownloadStatus: "warning",
        trackedDownloadState: "importPending",
        statusMessages: [
          {
            title: "Ghosts.US.S02E01",
            messages: ["Episode was matched to series by ID. Automatic import is not possible."],
          },
        ],
      },
    ];
    const files = [
      {
        path: "/downloads/Ghosts.US.S02E01/ep.mkv",
        folderName: "Ghosts.US.S02E01",
        size: 2 * 1024 ** 3,
        series: { id: 7, title: "Ghosts (US)" },
        seasonNumber: 2,
        episodes: [{ id: 701, seasonNumber: 2, episodeNumber: 1 }],
        quality: { quality: { name: "WEBDL-1080p" } },
        languages: [{ id: 1 }],
        releaseGroup: "GROUP",
        downloadId: "ABC123",
        rejections: [{ reason: "Matched to series by ID" }],
      },
      {
        path: "/downloads/Ghosts.US.S02E01/sample.mkv",
        size: 1024 ** 2,
        series: { id: 7 },
        episodes: [{ id: 701 }],
        rejections: [{ reason: "Sample" }],
      },
    ];
    const naming: Record<string, unknown> = {
      id: 1,
      renameEpisodes: false,
      replaceIllegalCharacters: true,
      standardEpisodeFormat: "{Series Title} - S{season:00}E{episode:00} - {Episode Title}",
      seriesFolderFormat: "{Series Title}",
      seasonFolderFormat: "Season {season}",
    };
    const profile = {
      id: 7,
      name: "Sitcom 720p",
      upgradeAllowed: true,
      cutoff: 4,
      cutoffFormatScore: 10000,
      items: [],
    };
    const commands: { name: string; body: Record<string, unknown> }[] = [];
    const removals: { id: number; query: string }[] = [];
    const history: {
      date: string;
      eventType: string;
      sourceTitle: string;
      episodeId: number;
      quality: unknown;
      data: unknown;
    }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      const reply = (status: number, data: unknown) => ({
        ok: status < 400,
        status,
        json: async () => data,
      });
      const p = u.pathname;
      if (p === "/api/v3/queue")
        return reply(200, { totalRecords: queue.length, records: structuredClone(queue) });
      const qd = /^\/api\/v3\/queue\/(\d+)$/.exec(p);
      if (qd && method === "DELETE") {
        removals.push({ id: Number(qd[1]), query: u.search });
        const at = queue.findIndex((x) => x.id === Number(qd[1]));
        if (at >= 0) queue.splice(at, 1);
        return reply(200, {});
      }
      if (p === "/api/v3/manualimport") return reply(200, structuredClone(files));
      const ep = /^\/api\/v3\/episode\/(\d+)$/.exec(p);
      if (ep)
        return episodes[Number(ep[1])]
          ? reply(200, structuredClone(episodes[Number(ep[1])]))
          : reply(404, {});
      if (p === "/api/v3/series/7")
        return reply(200, { id: 7, title: "Ghosts (US)", monitored: true, qualityProfileId: 7 });
      if (p === "/api/v3/episode" && u.searchParams.get("seriesId") === "7")
        return reply(200, structuredClone(Object.values(episodes)));
      if (p === "/api/v3/episode" && u.searchParams.get("seriesId") === "8") return reply(200, []);
      if (p === "/api/v3/episode/monitor" && method === "PUT") {
        const body = JSON.parse(init.body!) as { episodeIds: number[]; monitored: boolean };
        for (const id of body.episodeIds) episodes[id]!.monitored = body.monitored;
        return reply(202, {});
      }
      if (p === "/api/v3/series")
        return reply(200, [
          { id: 7, title: "Ghosts (US)", monitored: true, qualityProfileId: 7 },
          { id: 8, title: "Other", monitored: true, qualityProfileId: 7 },
        ]);
      if (p === "/api/v3/movie") return reply(404, {});
      if (p === "/api/v3/config/naming") return reply(200, structuredClone(naming));
      if (p === "/api/v3/config/naming/1" && method === "PUT") {
        const body = JSON.parse(init.body!) as Record<string, unknown>;
        // Sonarr checks a format has an episode number before it saves it.
        if (
          typeof body.standardEpisodeFormat === "string" &&
          !/\{episode/i.test(body.standardEpisodeFormat)
        )
          return reply(400, [
            { propertyName: "StandardEpisodeFormat", errorMessage: "Must contain Episode numbers" },
          ]);
        Object.assign(naming, body);
        return reply(202, structuredClone(naming));
      }
      if (p === "/api/v3/qualityprofile/7") {
        if (method === "PUT") Object.assign(profile, JSON.parse(init.body!));
        return reply(method === "PUT" ? 202 : 200, structuredClone(profile));
      }
      if (p === "/api/v3/command" && method === "POST") {
        const body = JSON.parse(init.body!) as Record<string, unknown> & { name: string };
        commands.push({ name: body.name, body });
        if (body.name === "ManualImport") {
          for (const f of body.files as { episodeIds: number[] }[])
            for (const id of f.episodeIds) episodes[id]!.hasFile = true;
          queue.splice(0, 1);
        }
        if (body.name === "EpisodeSearch")
          history.push({
            date: new Date(Date.now() + 1000).toISOString(),
            eventType: "grabbed",
            sourceTitle: "Ghosts.US.S02E02.1080p.WEB",
            episodeId: 702,
            quality: { quality: { name: "WEBDL-1080p" } },
            data: { indexer: "UsenetOne" },
          });
        return reply(201, { id: commands.length, status: "queued" });
      }
      if (/^\/api\/v3\/command\/\d+$/.test(p)) return reply(200, { status: "completed" });
      if (p === "/api/v3/history") return reply(200, { records: structuredClone(history) });
      return reply(404, {});
    };
    return { episodes, queue, files, profile, naming, commands, removals, fetchImpl };
  }

  async function setup() {
    const env = await realEnvironment();
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const fake = fakeSonarr();
    // With the journal, as the real app has it, so a verified change is remembered.
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      fake.fetchImpl,
      env.memory,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    await env.vault.add({
      name: "Sonarr key",
      kind: "api-key",
      tier: "automation",
      serviceId: sonarr.id,
      value: "sonarr-key-value",
      scope: "approved-changes",
    });
    return { env, sonarr, fake, jobs };
  }
  const approve = async (jobs: Jobs, job: Job) => {
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    return jobs.get(job.id);
  };

  it("imports a stuck download: the exact queue item, files, target, and reasons; samples left; verified on disk", async () => {
    const { sonarr, fake, jobs } = await setup();
    const job = await jobs.create({
      title: "Import",
      steps: [{ kind: "app-arr-import", serviceId: sonarr.id, params: { queueId: 101 } }],
      requestedBy: "agent",
    });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]!.label).toBe("Import the stuck download of Ghosts (US) S02E01 in Sonarr");
    expect(job.steps[0]!.change!.settings).toEqual([
      {
        name: "ep.mkv",
        before: "Downloaded, not imported: Matched to series by ID",
        after: "Import as Ghosts (US) S02E01 (WEBDL-1080p, 2 GB)",
      },
      {
        name: "1 other file",
        before: "sample.mkv",
        after: "Left alone (samples, or files the app cannot place)",
      },
      {
        name: "The download",
        before: "Ghosts.US.S02E01.1080p.WEB-GROUP in the download client",
        after: "Left as is (a torrent keeps seeding); nothing is removed or blocklisted",
      },
    ]);
    // Stale: the file changed after approval.
    fake.files[0]!.size += 1;
    expect((await approve(jobs, job)).steps[0]!.result).toMatch(
      /files .* changed since this plan was approved. Nothing was imported/,
    );
    fake.files[0]!.size -= 1;
    expect(fake.commands).toEqual([]);
    const done = await approve(
      jobs,
      await jobs.create({
        title: "Import",
        steps: [{ kind: "app-arr-import", serviceId: sonarr.id, params: { queueId: 101 } }],
        requestedBy: "agent",
      }),
    );
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /^Imported and verified: Ghosts \(US\) S02E01 now has its file in Sonarr, and the item left the queue/,
    );
    expect(fake.commands[0]).toMatchObject({
      name: "ManualImport",
      body: {
        importMode: "auto",
        files: [
          {
            path: "/downloads/Ghosts.US.S02E01/ep.mkv",
            seriesId: 7,
            episodeIds: [701],
            downloadId: "ABC123",
          },
        ],
      },
    });
  });

  it("removes one queue item: release and reason in the plan, kept in the client, never blocklisted, refused if it changed", async () => {
    const { sonarr, fake, jobs } = await setup();
    const plan = () =>
      jobs.create({
        title: "Remove",
        steps: [{ kind: "app-arr-queue-remove", serviceId: sonarr.id, params: { queueId: 101 } }],
        requestedBy: "agent",
      });
    const job = await plan();
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]!.label).toBe(
      "Remove Ghosts.US.S02E01.1080p.WEB-GROUP (Ghosts (US) S02E01) from Sonarr's queue",
    );
    expect(job.steps[0]!.change!.settings).toEqual([
      {
        name: "Queue item #101",
        before:
          "Ghosts.US.S02E01.1080p.WEB-GROUP, for Ghosts (US) S02E01. Why it is stuck: Episode was matched to series by ID. Automatic import is not possible.",
        after: "Removed from Sonarr's queue",
      },
      {
        name: "The download",
        before: "In the download client",
        after: "Left in the download client as is (a torrent keeps seeding)",
      },
      {
        name: "Blocklist and library",
        before: "Not changed",
        after:
          "Nothing is blocklisted (the app may grab this release again) and no library files are touched",
      },
    ]);
    // Changed after approval: refused, nothing removed.
    fake.queue[0]!.trackedDownloadState = "importing";
    const stale = await approve(jobs, job);
    expect(stale.steps[0]!.result).toMatch(
      /changed since this plan was approved.*Nothing was removed/,
    );
    expect(fake.removals).toEqual([]);
    fake.queue[0]!.trackedDownloadState = "importPending";

    const done = await approve(jobs, await plan());
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /^Removed and verified: "Ghosts.US.S02E01.1080p.WEB-GROUP" \(Ghosts \(US\) S02E01\) is no longer in Sonarr's queue\. The download was left in the download client\. Nothing was blocklisted\./,
    );
    expect(fake.removals).toEqual([
      {
        id: 101,
        query: "?removeFromClient=false&blocklist=false&skipRedownload=false&changeCategory=false",
      },
    ]);
    expect(fake.files.length).toBe(2); // no library or download files touched by Hearth
    // Already gone: refused at planning, with the reason.
    const gone = await plan();
    expect(gone.status).toBe("refused");
    expect(JSON.stringify(gone)).toMatch(/no item #101/);
  });

  it("Download Health's Fix it: removes it from the client, blocklists only that release, searches again; a third replacement is refused", async () => {
    const { sonarr, fake, jobs } = await setup();
    const item = structuredClone(fake.queue[0]!);
    const plan = () =>
      jobs.create({
        title: "Fix",
        steps: [
          {
            kind: "app-arr-queue-remove",
            serviceId: sonarr.id,
            params: { queueId: 101, recover: true },
          },
        ],
        requestedBy: "agent",
      });
    const job = await plan();
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    const names = job.steps[0]!.change!.settings.map((x) => [x.name, x.after]);
    expect(names).toContainEqual([
      "Blocklist",
      "This one release is blocklisted, so Sonarr never grabs it again. Nothing else is, and no library files are touched",
    ]);
    expect(names).toContainEqual([
      "Another release",
      "Sonarr searches for another release of Ghosts (US) S02E01 right away",
    ]);
    const done = await approve(jobs, job);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /^Fixed: .* that release is blocklisted, and Sonarr is searching for another\./,
    );
    expect(fake.removals).toEqual([
      {
        id: 101,
        query: "?removeFromClient=true&blocklist=true&skipRedownload=false&changeCategory=false",
      },
    ]);
    // Grabbed again and stuck again: a second replacement is fine, a third is the owner's call.
    fake.queue.push(structuredClone(item));
    expect((await approve(jobs, await plan())).status).toBe("succeeded");
    fake.queue.push(structuredClone(item));
    const third = await plan();
    expect(third.status).toBe("refused");
    expect(JSON.stringify(third)).toMatch(
      /already replaced the download for Ghosts \(US\) S02E01 2 times/,
    );
  });

  it("removes a queue item from the download client only when asked, and says that deletes its data", async () => {
    const { sonarr, fake, jobs } = await setup();
    const job = await jobs.create({
      title: "Remove",
      steps: [
        {
          kind: "app-arr-queue-remove",
          serviceId: sonarr.id,
          params: { queueId: 101, removeFromClient: true },
        },
      ],
      requestedBy: "agent",
    });
    expect(job.steps[0]!.label).toMatch(/from Sonarr's queue and from the download client$/);
    expect(job.steps[0]!.change!.settings[1]!.after).toMatch(/DELETES its downloaded data/);
    await approve(jobs, job);
    expect(fake.removals[0]!.query).toMatch(/^\?removeFromClient=true&blocklist=false/);
  });

  it("shows a failed SABnzbd download as failed, and removes it from the queue and the client's history", async () => {
    const { sonarr, fake, jobs } = await setup();
    const raw = {
      id: 102,
      downloadId: "SABnzbd_nzo_1",
      title: "Ghosts.US.2021.S02E10.1080p.WEB-DL-YELLO",
      protocol: "usenet",
      episodeId: 702,
      seriesId: 7,
      status: "failed",
      size: 690_920_473,
      sizeleft: 0,
      trackedDownloadStatus: "warning",
      trackedDownloadState: "downloading",
      downloadClient: "SABnzbd",
      errorMessage: "Repair failed, not enough repair blocks (4 short)",
      statusMessages: [
        {
          title: "Ghosts.US.2021.S02E10.1080p.WEB-DL-YELLO",
          messages: ["Download wasn't grabbed by sonarr, skipping"],
        },
      ],
    };
    const item = toQueueItem("sonarr", raw);
    expect(item).toMatchObject({ failed: true, stuckImport: false, client: "SABnzbd" });
    expect(item.progressPct).toBeUndefined();
    expect(item.onDisk).toBeUndefined();
    // One for an episode you already have says so (no need to search again).
    expect(
      toQueueItem("sonarr", {
        ...raw,
        episode: { seasonNumber: 4, episodeNumber: 15, hasFile: true },
      }).onDisk,
    ).toBe(true);
    expect(item.problem).toBe(
      "Repair failed, not enough repair blocks (4 short). Sonarr did not grab this download itself, so it will not clear it or try another release on its own.",
    );
    // A healthy download is not failed.
    expect(
      toQueueItem("sonarr", { id: 1, status: "downloading", sizeleft: 5, size: 10 }).failed,
    ).toBe(undefined);

    fake.queue.push(raw as (typeof fake.queue)[number]);
    const job = await jobs.create({
      title: "Clear failed",
      steps: [
        {
          kind: "app-arr-queue-remove",
          serviceId: sonarr.id,
          params: { queueId: 102, removeFromClient: true },
        },
      ],
      requestedBy: "agent",
    });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]!.change!.settings[0]!.before).toMatch(
      /Why it failed: Repair failed, not enough repair blocks \(4 short\)/,
    );
    expect(job.steps[0]!.change!.settings[1]!.after).toBe(
      "Removed from SABnzbd's history too, with any partial data (it failed, so nothing usable is lost)",
    );
    const done = await approve(jobs, job);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(
      /no longer in Sonarr's queue\. The download client was told to remove the failed download and its partial data\. Nothing was blocklisted\./,
    );
    expect(fake.removals).toEqual([
      {
        id: 102,
        query: "?removeFromClient=true&blocklist=false&skipRedownload=false&changeCategory=false",
      },
    ]);
    expect(fake.queue.map((q) => q.id)).toEqual([101]);
  });

  it("adds a collection's missing movies in Radarr, as a movie you have from it, and verifies each", async () => {
    const env = await realEnvironment();
    const radarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    env.handle.sqlite
      .prepare(
        "UPDATE services SET name = 'Radarr', image = 'lscr.io/linuxserver/radarr:latest' WHERE id = ?",
      )
      .run(radarr.id);
    const movies: Record<string, unknown>[] = [
      {
        id: 1,
        tmdbId: 245891,
        title: "John Wick",
        year: 2014,
        qualityProfileId: 4,
        rootFolderPath: "/movies",
        minimumAvailability: "released",
      },
    ];
    const collection = {
      id: 731,
      title: "John Wick Collection",
      qualityProfileId: 1,
      rootFolderPath: "/other",
      movies: [
        { tmdbId: 245891, title: "John Wick", year: 2014, status: "released", isExisting: true },
        {
          tmdbId: 324552,
          title: "John Wick: Chapter 2",
          year: 2017,
          status: "released",
          isExisting: false,
        },
        { tmdbId: 999, title: "John Wick 5", year: 2027, status: "announced", isExisting: false },
        { tmdbId: 777, title: "Left out", status: "released", isExisting: false, isExcluded: true },
      ],
    };
    const posted: Record<string, unknown>[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      const reply = (status: number, data: unknown) => ({
        ok: status < 400,
        status,
        json: async () => data,
      });
      const p = u.pathname;
      if (p === "/api/v3/collection/731") {
        const have = new Set(movies.map((m) => m.tmdbId));
        return reply(200, {
          ...collection,
          movies: collection.movies.map((m) => ({ ...m, isExisting: have.has(m.tmdbId) })),
        });
      }
      if (p === "/api/v3/collection/5") return reply(404, {});
      if (p === "/api/v3/qualityprofile/4") return reply(200, { id: 4, name: "Any" });
      if (p === "/api/v3/movie" && method === "GET")
        return reply(
          200,
          movies.filter((m) => String(m.tmdbId) === u.searchParams.get("tmdbId")),
        );
      if (p === "/api/v3/movie" && method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        movies.push({ id: movies.length + 1, ...body });
        return reply(201, { id: movies.length });
      }
      return reply(404, {});
    };
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      fetchImpl,
      env.memory,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    await env.vault.add({
      name: "Radarr key",
      kind: "api-key",
      tier: "automation",
      serviceId: radarr.id,
      value: "radarr-key-value",
      scope: "approved-changes",
    });
    const plan = (collectionId: number) =>
      jobs.create({
        title: "Add",
        steps: [{ kind: "app-arr-add-collection", serviceId: radarr.id, params: { collectionId } }],
        requestedBy: "agent",
      });
    const job = await plan(731);
    expect(job.status, job.summary).toBe("awaiting-approval");
    expect(job.steps[0]!.label).toBe("Add 2 missing movies from John Wick Collection to Radarr");
    expect(job.steps[0]!.change!.settings).toEqual([
      {
        name: "John Wick: Chapter 2 (2017)",
        before: "Not in Radarr",
        after: "Added and monitored; Radarr searches for it now",
      },
      {
        name: "John Wick 5 (2027)",
        before: "Not in Radarr",
        after: "Added and monitored; Radarr grabs it once it is released",
      },
      {
        name: "Quality and folder",
        before: "As John Wick (2014), which you already have",
        after: "Quality profile Any, folder /movies",
      },
    ]);
    const done = await approve(jobs, job);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toBe(
      "Added and verified: John Wick: Chapter 2 (2017), John Wick 5 (2027) are in Radarr, monitored, and being searched for.",
    );
    expect(posted).toEqual([
      expect.objectContaining({
        tmdbId: 324552,
        qualityProfileId: 4,
        rootFolderPath: "/movies",
        minimumAvailability: "released",
        monitored: true,
        addOptions: { searchForMovie: true, monitor: "movieOnly" },
      }),
      expect.objectContaining({ tmdbId: 999 }),
    ]);
    // Nothing missing any more, and a collection that does not exist: refused with the reason.
    expect(JSON.stringify(await plan(731))).toMatch(/is not missing any movies/);
    expect(JSON.stringify(await plan(5))).toMatch(/has no collection #5/);
  });

  it("searches for one missing episode and reports whether something was actually grabbed", async () => {
    const { sonarr, fake, jobs } = await setup();
    const done = await approve(
      jobs,
      await jobs.create({
        title: "Search",
        steps: [{ kind: "app-arr-search", serviceId: sonarr.id, params: { episodeId: 702 } }],
        requestedBy: "agent",
      }),
    );
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.label).toBe("Search for Ghosts (US) S02E02 now in Sonarr");
    expect(done.steps[0]!.result).toMatch(
      /grabbed Ghosts.US.S02E02.1080p.WEB \(WEBDL-1080p, from UsenetOne\). It is downloading; it is not on disk yet/,
    );
    expect(fake.commands.map((c) => c.body)).toEqual([
      { name: "EpisodeSearch", episodeIds: [702] },
    ]);
  });

  it("stops monitoring everything you already have, and only that; missing ones stay monitored", async () => {
    const { sonarr, fake, jobs } = await setup();
    fake.episodes[701]!.hasFile = true;
    const job = await jobs.create({
      title: "Unmonitor owned",
      steps: [{ kind: "app-arr-unmonitor-owned", serviceId: sonarr.id }],
      requestedBy: "agent",
    });
    expect(job.status, job.summary).toBe("awaiting-approval");
    expect(job.steps[0]!.label).toBe("Stop monitoring the 1 episodes you already have in Sonarr");
    const done = await approve(jobs, job);
    expect(done.status, done.summary).toBe("succeeded");
    expect(fake.episodes[701]!.monitored).toBe(false);
    expect(fake.episodes[702]!.monitored).toBe(true);
  });

  it("changes one naming setting: before and after shown, verified, journaled, put back on failure", async () => {
    const { env, sonarr, fake, jobs } = await setup();
    const step = {
      kind: "app-arr-set-naming" as const,
      serviceId: sonarr.id,
      params: { setting: "renameEpisodes", value: true },
    };
    const job = await jobs.create({
      title: "Rename episodes",
      steps: [step],
      requestedBy: "agent",
    });
    expect(job.status, job.summary).toBe("awaiting-approval");
    expect(job.steps[0]!.label).toBe(`Change "Rename episodes" in Sonarr's naming settings`);
    expect(job.steps[0]!.change!.settings[0]).toMatchObject({ before: "No", after: "Yes" });
    const done = await approve(jobs, job);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/now Yes \(was No\), verified by reading Sonarr back/);
    expect(fake.naming.renameEpisodes).toBe(true);
    // Remembered: the journal has it, with the service linked.
    const listed = (await env.call("GET", "/api/memory/entries")).json<unknown>();
    const entries = (
      Array.isArray(listed) ? listed : (listed as { entries: unknown[] }).entries
    ) as {
      title: string;
      body?: string;
    }[];
    expect(entries.some((e) => /naming|Rename episodes/i.test(`${e.title} ${e.body ?? ""}`))).toBe(
      true,
    );

    // A later step fails: the setting goes back to how it was.
    fake.naming.renameEpisodes = false;
    fakeOutages.stopContainer("prowlarr", 1);
    const prowlarr = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    const rolled = await approve(
      jobs,
      await jobs.create({
        title: "x",
        steps: [step, { kind: "run-check", serviceId: prowlarr.id }],
        requestedBy: "you",
      }),
    );
    expect(rolled.status, rolled.summary).toBe("rolled-back");
    expect(fake.naming.renameEpisodes).toBe(false);
  });

  it("naming: refuses what isn't allowed, stale approvals, and says why the app refused", async () => {
    const { sonarr, fake, jobs } = await setup();
    const plan = (params: Record<string, string | boolean>) =>
      jobs.create({
        title: "n",
        steps: [{ kind: "app-arr-set-naming", serviceId: sonarr.id, params }],
        requestedBy: "agent",
      });
    // Only naming settings, never paths or anything else.
    expect((await plan({ setting: "rootFolderPath", value: "/x" })).summary).toMatch(
      /Say which naming setting/,
    );
    expect((await plan({ setting: "renameMovies", value: true })).summary).toMatch(
      /no "Rename movies" setting/,
    );
    expect((await plan({ setting: "renameEpisodes", value: "maybe" })).summary).toMatch(
      /true or false/,
    );
    expect((await plan({ setting: "seasonFolderFormat", value: "a\nb" })).summary).toMatch(
      /one line/,
    );
    expect((await plan({ setting: "renameEpisodes", value: false })).summary).toMatch(/already No/);

    // Changed in Sonarr after approval: nothing is written.
    const stale = await plan({ setting: "seasonFolderFormat", value: "S{season:00}" });
    fake.naming.seasonFolderFormat = "Changed by hand";
    const s = await approve(jobs, stale);
    expect(s.status).not.toBe("succeeded");
    expect(s.steps[0]!.result).toMatch(/not Season \{season\} as approved. Nothing was changed/);
    expect(fake.naming.seasonFolderFormat).toBe("Changed by hand");

    // Sonarr's own validation: its reason is shown, and nothing else changes.
    const bad = await approve(
      jobs,
      await plan({ setting: "standardEpisodeFormat", value: "{Series Title}" }),
    );
    expect(bad.status).not.toBe("succeeded");
    expect(bad.steps[0]!.result).toMatch(
      /refused the change \(400: Must contain Episode numbers\)/,
    );
  });

  it("sets where a profile stops upgrading: states how many titles it affects, verified, put back on failure", async () => {
    const { env, sonarr, fake, jobs } = await setup();
    const step = {
      kind: "app-arr-set-cutoff-score" as const,
      serviceId: sonarr.id,
      params: { profileId: 7, score: 2000 },
    };
    const job = await jobs.create({
      title: "Stop chasing 10000",
      steps: [step],
      requestedBy: "agent",
    });
    expect(job.steps[0]!.label).toBe(
      'Make the "Sitcom 720p" quality profile stop upgrading at custom format score 2000 in Sonarr (used by 2 series)',
    );
    const done = await approve(jobs, job);
    expect(done.status, done.summary).toBe("succeeded");
    expect(fake.profile.cutoffFormatScore).toBe(2000);
    fake.profile.cutoffFormatScore = 10000;
    fakeOutages.stopContainer("prowlarr", 1);
    const prowlarr = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    const rolled = await approve(
      jobs,
      await jobs.create({
        title: "x",
        steps: [step, { kind: "run-check", serviceId: prowlarr.id }],
        requestedBy: "you",
      }),
    );
    expect(rolled.status, rolled.summary).toBe("rolled-back");
    expect(fake.profile.cutoffFormatScore).toBe(10000);
  });
});

describe("credential broker (Secure Vault)", () => {
  afterEach(() => {
    fakeOutages.restoreAll();
    fakeAppApi.data = {};
    fakeAppApi.status = 200;
    fakeAppApi.calls = [];
  });

  it("uses a service's credential only for that service's address, and only as its scope allows", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const broker = new CredentialBroker(env.handle, env.vault);
    const use = (destination: string, access: "read" | "change" = "read") =>
      broker.use(
        { serviceId: svc.id, purpose: "test", access, destination },
        async ({ value }) => value.length,
      );
    await expect(use(`${svc.localUrl}/api/v3/system/status`)).rejects.toMatchObject({
      reason: "missing",
    });
    const added = await env.vault.add({
      name: "Sonarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: svc.id,
      value: "sonarr-real-key-123",
      scope: "read",
    });
    expect(await use(`${svc.localUrl}/api/v3/system/status`)).toBe(19);
    // Never anywhere else, whatever the caller (or a compromised conversation) asks for.
    await expect(use("https://attacker.example/collect")).rejects.toMatchObject({
      reason: "destination",
    });
    // Diagnostics-only credentials never serve a change, approved or not.
    await expect(use(`${svc.localUrl}/api/v3/indexer/1`, "change")).rejects.toMatchObject({
      reason: "scope",
    });
    await env.vault.update(added.id, { scope: "approved-changes" });
    expect(await use(`${svc.localUrl}/api/v3/indexer/1`, "change")).toBe(19);

    // A failure is recorded without the value, even when the error text contained it.
    await expect(
      broker.use(
        { serviceId: svc.id, purpose: "test", access: "read", destination: svc.localUrl! },
        async ({ value }) => {
          throw new Error(`connect failed for ${svc.localUrl}/api?apikey=${value}`);
        },
      ),
    ).rejects.toThrow(/apikey=\[hidden\]/);
    const status = (await broker.status()).find((c) => c.serviceId === svc.id)!;
    expect(status).toMatchObject({ state: "failing", need: { kind: "api-key" } });
    expect(status.secret!.lastFailure).toMatch(/\[hidden\]/);
    expect(JSON.stringify([status, await env.audit()])).not.toContain("sonarr-real-key-123");
  });

  it("reports per service what is missing, protected, unused, or working; never values; never to access keys", async () => {
    const env = await realEnvironment();
    const ws = await env.workspace();
    const byName = (n: string) => ws.services.find((s) => s.name === n)!;
    await env.vault.add({
      name: "SABnzbd key",
      kind: "api-key",
      tier: "protected",
      serviceId: byName("SABnzbd").id,
      value: "p-123456",
    });
    await env.vault.add({
      name: "Sonarr key",
      kind: "api-key",
      tier: "automation",
      serviceId: byName("Sonarr").id,
      value: "s-123456",
    });
    const list = (await env.call("GET", "/api/credentials")).json<CredentialStatus[]>();
    const state = (n: string) => list.find((c) => c.serviceName === n)?.state;
    expect(state("SABnzbd")).toBe("protected");
    expect(state("Sonarr")).toBe("unused");
    expect(state("Prowlarr")).toBe("missing");
    expect(JSON.stringify(list)).not.toMatch(/p-123456|s-123456/);
    await env.apps.check();
    const after = (await env.call("GET", "/api/credentials")).json<CredentialStatus[]>();
    expect(after.find((c) => c.serviceName === "Sonarr")!.state).toMatch(/working|failing/);

    const { key } = (
      await env.call("POST", "/api/keys", {
        name: "HA",
        scopes: ["read", "act", "converse", "approve"],
      })
    ).json<{ key: string }>();
    const auth = { authorization: `Bearer ${key}` };
    expect((await env.send("GET", "/api/credentials", undefined, undefined, auth)).statusCode).toBe(
      403,
    );
    expect((await env.send("GET", "/api/vault", undefined, undefined, auth)).statusCode).toBe(403);
  });

  it("stores credentials Hearth generates: linked, audited, never shown", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    const broker = new CredentialBroker(env.handle, env.vault);
    await broker.storeGenerated({
      serviceId: svc.id,
      kind: "api-key",
      value: "generated-secret-987",
      workflow: "set up the Prowlarr integration",
    });
    const status = (await broker.status()).find((c) => c.serviceId === svc.id)!;
    expect(status.secret).toMatchObject({
      name: "Prowlarr API key",
      scope: "approved-changes",
      source: "generated: set up the Prowlarr integration",
    });
    const audit = await env.audit();
    expect(audit.map((a) => a.action)).toContain("Stored a credential it generated for Prowlarr");
    expect(audit.find((a) => a.action.startsWith("Added"))!.actor).toBe("dragon-control");
    expect(JSON.stringify(audit)).not.toContain("generated-secret-987");
  });

  it("offers a key it finds in an app's settings file, and imports it only when you confirm", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "config.xml"),
      "<Config>\n  <Port>9696</Port>\n  <ApiKey>0123456789abcdef0123456789abcdef</ApiKey>\n</Config>\n",
    );
    fakeOutages.mount("prowlarr", dir, "/config");
    const offered = (await env.call("GET", "/api/credentials")).json<CredentialStatus[]>();
    const entry = offered.find((c) => c.serviceId === svc.id)!;
    expect(entry.importSources).toEqual([
      { id: "app-settings-file", description: expect.stringContaining("config.xml") },
    ]);
    // Detecting it did not read it: nothing is in the vault.
    expect(entry.state).toBe("missing");

    // Not right after confirming it is you: refused.
    env.handle.sqlite
      .prepare("UPDATE sessions SET verified_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    const refused = await env.call("POST", `/api/credentials/${svc.id}/import`, {
      source: "app-settings-file",
    });
    expect(refused.statusCode).toBe(403);
    env.handle.sqlite.prepare("UPDATE sessions SET verified_at = ?").run(new Date().toISOString());

    const done = await env.call("POST", `/api/credentials/${svc.id}/import`, {
      source: "app-settings-file",
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).not.toContain("0123456789abcdef0123456789abcdef");
    const now = (await env.call("GET", "/api/credentials")).json<CredentialStatus[]>();
    expect(now.find((c) => c.serviceId === svc.id)!.secret).toMatchObject({
      name: "Prowlarr API key",
      source: expect.stringMatching(/^imported from .*config\.xml$/),
    });
    const audit = await env.audit();
    expect(audit.map((a) => a.action)).toContain(
      "Imported Prowlarr's API key into the vault from its settings file",
    );
    expect(JSON.stringify(audit)).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("Ember stores apps' keys itself: one plan, one approval after confirming it's you, never seeing them", async () => {
    const env = await realEnvironment();
    const ws = await env.workspace();
    const prowlarr = ws.services.find((s) => s.name === "Prowlarr")!;
    const sonarr = ws.services.find((s) => s.name === "Sonarr")!;
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "config.xml"),
      "<Config>\n  <ApiKey>0123456789abcdef0123456789abcdef</ApiKey>\n</Config>\n",
    );
    fakeOutages.mount("prowlarr", dir, "/config");

    // An app with no readable key cannot be in the plan: Hearth says why.
    const none = await env.jobs.create({
      title: "Store Sonarr's key",
      steps: [{ kind: "credential-import", serviceId: sonarr.id }],
      requestedBy: "agent",
    });
    expect(none.status).toBe("refused");
    expect(none.summary).toMatch(/Secure Vault/);

    const job = await env.jobs.create({
      title: "Connect your apps",
      steps: [{ kind: "credential-import", serviceId: prowlarr.id }],
      requestedBy: "agent",
    });
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]).toMatchObject({ params: { protected: "yes" } });

    // Approving needs a fresh "it's you".
    env.handle.sqlite
      .prepare("UPDATE sessions SET verified_at = ?")
      .run("2020-01-01T00:00:00.000Z");
    const early = await env.call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    expect(early.statusCode).toBe(403);
    env.handle.sqlite.prepare("UPDATE sessions SET verified_at = ?").run(new Date().toISOString());
    const approved = await env.call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await env.jobs.idle();
    const done = (await env.call("GET", `/api/jobs/${job.id}`)).json<Job>();
    expect(done.steps[0]!.result).toMatch(/Stored as "Prowlarr API key" in Secure Vault/);
    expect(JSON.stringify(done)).not.toContain("0123456789abcdef0123456789abcdef");
    const now = (await env.call("GET", "/api/credentials")).json<CredentialStatus[]>();
    expect(now.find((c) => c.serviceId === prowlarr.id)!.secret).toMatchObject({
      name: "Prowlarr API key",
    });
    expect(JSON.stringify(await env.audit())).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it.skipIf(process.platform === "win32")(
    "never offers or imports a settings file that is a link to somewhere else",
    async () => {
      const env = await realEnvironment();
      const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
      const elsewhere = tempDir();
      writeFileSync(
        path.join(elsewhere, "other.xml"),
        "<ApiKey>0123456789abcdef0123456789abcdef</ApiKey>",
      );
      const dir = tempDir();
      symlinkSync(path.join(elsewhere, "other.xml"), path.join(dir, "config.xml"));
      fakeOutages.mount("prowlarr", dir, "/config");
      const offered = (await env.call("GET", "/api/credentials")).json<CredentialStatus[]>();
      expect(offered.find((c) => c.serviceId === svc.id)!.importSources).toEqual([]);
      const r = await env.call("POST", `/api/credentials/${svc.id}/import`, {
        source: "app-settings-file",
      });
      expect(r.statusCode).toBe(409);
    },
  );

  it("an approved change needs the credential's scope too; read-only credentials refuse at planning", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    await env.vault.add({
      name: "Prowlarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: svc.id,
      value: "k-123456",
      scope: "read",
    });
    const ops = new AppOperations(env.handle, env.vault, env.runner, async () => ({
      ok: true,
      status: 200,
      json: async () => [],
    }));
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    const job = await jobs.create({
      title: "Turn off",
      steps: [
        {
          kind: "app-set-indexer-enabled",
          serviceId: svc.id,
          params: { indexer: "x", enabled: false },
        },
      ],
      requestedBy: "you",
    });
    expect(job).toMatchObject({
      status: "refused",
      summary: expect.stringMatching(/limited to diagnostics/),
    });
  });
});

describe("service runtime (command center)", () => {
  afterEach(() => fakeOutages.restoreAll());

  it("reads uptime, ports, CPU, and memory live, and says why when it cannot", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const live = (await env.call("GET", `/api/services/${svc.id}/runtime`)).json<ServiceRuntime>();
    expect(live).toMatchObject({
      available: true,
      running: true,
      ports: ["8080 -> 80/tcp"],
      cpuPct: 1.5,
      memoryMb: 256,
    });
    fakeOutages.stopContainer("sonarr", 0);
    const stopped = (
      await env.call("GET", `/api/services/${svc.id}/runtime`)
    ).json<ServiceRuntime>();
    expect(stopped).toMatchObject({ available: true, running: false, ports: [] });
    expect(stopped.cpuPct).toBeUndefined();

    const demo = await makeApp({ scenario: "calm" });
    const sample = (
      await demo.call("GET", "/api/services/jellyfin/runtime")
    ).json<ServiceRuntime>();
    expect(sample).toMatchObject({
      available: false,
      reason: expect.stringMatching(/Sample data/),
    });
  });

  it("computes CPU and memory the way docker stats does", () => {
    expect(
      fromStats({
        cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 },
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        memory_stats: {
          usage: 300 * 1048576,
          limit: 4096 * 1048576,
          stats: { inactive_file: 44 * 1048576 },
        },
      }),
    ).toEqual({ cpuPct: 80, memoryMb: 256, memoryLimitMb: 4096 });
    expect(
      publishedPorts({
        "80/tcp": [
          { HostIp: "0.0.0.0", HostPort: "8080" },
          { HostIp: "::", HostPort: "8080" },
        ],
        "443/tcp": null,
        "53/udp": [{ HostPort: "53" }],
      }),
    ).toEqual(["53 -> 53/udp", "8080 -> 80/tcp"]);
  });
});

describe("inside the apps (M9)", () => {
  const prowlarr = (failing: boolean) => ({
    "/api/v1/system/status": { version: "1.24.3" },
    "/api/v1/health": [],
    "/api/v1/indexer": [
      { id: 1, name: "Alpha", enable: true },
      { id: 2, name: "Beta", enable: true },
    ],
    "/api/v1/indexerstatus": failing
      ? [{ indexerId: 1, disabledTill: new Date(Date.now() + 3600_000).toISOString() }]
      : [],
  });
  afterEach(() => {
    fakeAppApi.data = {};
    fakeAppApi.status = 200;
    fakeAppApi.calls = [];
    fakeOutages.restoreAll();
  });

  it("an app problem the AI could not fix stays open, and the AI is not asked again every few minutes", async () => {
    // Regression (the home server, 2026-10-09): the container answering was taken as proof the PublicTracker ban
    // was fixed, the incident closed, reopened five minutes later, and the AI was asked 27 times.
    const env = await makeApp({ scenario: "calm", listen: true });
    expect(
      (await env.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    const report = (await env.call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    await env.call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings
        .filter((f) => f.selectedByDefault && f.sourceName !== "photos_db")
        .map((f) => ({ key: f.key, name: f.name })),
    });
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    await env.call("PUT", "/api/autonomy", { default: "diagnose", rules: [] });
    await env.vault.add({
      name: "Prowlarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: svc.id,
      value: "prowlarr-test-key",
    });
    agentScript = async ({ call }) => {
      await call("report", {
        summary: "Not fixed; I changed nothing. Alpha is banned by its site.",
        outcome: "escalated",
      });
      return "Not fixed.";
    };
    fakeAppApi.data = prowlarr(true);
    await env.apps.check();
    const [first] = await env.apps.check();
    env.agents.kick();
    await env.agents.idle();
    expect(agentRuns).toHaveLength(1);
    let incident = (await env.workspace()).incidents.find((i) => i.id === first)!;
    // Prowlarr's container answers, but Prowlarr still reports the problem: not "fixed".
    expect(incident.status).toBe("open");
    expect(incident.timeline.at(-1)!.text).toMatch(
      /^Prowlarr still reports: Alpha is failing.*[^.]\. Waiting for you\.$/,
    );
    expect(incident.timeline.map((e) => e.text).join(" ")).not.toMatch(/Fixed in/);

    // It clears, then comes back: a new incident, but the AI is not asked again so soon.
    fakeAppApi.data = prowlarr(false);
    await env.apps.check();
    fakeAppApi.data = prowlarr(true);
    await env.apps.check();
    const [second] = await env.apps.check();
    expect(second).toBeTruthy();
    env.agents.kick();
    await env.agents.idle();
    env.agents.kick();
    await env.agents.idle();
    expect(agentRuns).toHaveLength(1);
    incident = (await env.workspace()).incidents.find((i) => i.id === second)!;
    const said = incident.timeline.filter((e) => /Not asking the AI again/.test(e.text));
    expect(said).toHaveLength(1);
  });

  it("asks for an API key first, then reads Prowlarr with the vault key, never restarting for app problems", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    await env.call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    await env.call("PATCH", "/api/settings", { liveRepairs: true });

    // No key yet: nothing is read, and you are told how to add it.
    expect(await env.apps.check()).toEqual([]);
    let report = (await env.workspace()).apps.find((r) => r.serviceId === svc.id)!;
    expect(report).toMatchObject({ status: "needs-key" });
    expect(report.detail).toMatch(/Add Prowlarr's API key to the vault/);
    expect(fakeAppApi.calls).toEqual([]);

    await env.vault.add({
      name: "Prowlarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: svc.id,
      value: "prowlarr-test-key",
    });
    fakeAppApi.data = prowlarr(true);
    // One bad read is not an incident yet; the second confirms it.
    expect(await env.apps.check()).toEqual([]);
    const opened = await env.apps.check();
    expect(opened).toHaveLength(1);
    await env.runner.idle();
    const ws = await env.workspace();
    const incident = ws.incidents.find((i) => i.id === opened[0])!;
    expect(incident.title).toMatch(/^Prowlarr: Alpha is failing/);
    expect(incident.timeline.at(-1)!.text).toMatch(/restarting its container will not fix it/);
    expect(fakeOutages.restarts()).toEqual([]);
    report = ws.apps.find((r) => r.serviceId === svc.id)!;
    expect(report).toMatchObject({ status: "failing", version: "1.24.3" });
    // The key worked, so the vault says when it was last known good.
    expect(
      (await env.call("GET", "/api/vault")).json<{ secrets: { verifiedAt?: string }[] }>()
        .secrets[0]!.verifiedAt,
    ).toBeTruthy();
    // The key went to Prowlarr only: never into the report, the incident, or the audit trail.
    const everything = JSON.stringify([ws, await env.audit()]);
    expect(everything).not.toContain("prowlarr-test-key");

    // A third read with the same problem does not open another incident.
    expect(await env.apps.check()).toEqual([]);

    fakeAppApi.data = prowlarr(false);
    const now = (await env.call("POST", `/api/services/${svc.id}/app/check`)).json<{
      status: string;
    }>();
    expect(now.status).toBe("ok");
    expect((await env.workspace()).incidents.find((i) => i.id === incident.id)!.status).toBe(
      "resolved",
    );
  });

  it("diagnostics read Sonarr live for the panel, never faster than allowed, never raising incidents", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const first = (
      await env.call("GET", `/api/services/${svc.id}/diagnostics`)
    ).json<AppDiagnostics>();
    expect(first.report).toMatchObject({ app: "sonarr", status: "needs-key" });
    expect(first.report!.detail).toMatch(/Add Sonarr's API key/);

    await env.vault.add({
      name: "Sonarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: svc.id,
      value: "sonarr-test-key",
    });
    fakeAppApi.data = {
      "/api/v3/system/status": { version: "4.0.11" },
      "/api/v3/health": [
        { source: "IndexerStatusCheck", type: "error", message: "All indexers are unavailable" },
      ],
      "/api/v3/queue": {
        totalRecords: 1,
        records: [{ id: 1, title: "Show.S01E01", trackedDownloadState: "downloading" }],
      },
      "/api/v3/history": { records: [] },
      "/api/v3/downloadclient": [{ name: "SABnzbd", enable: true, protocol: "usenet" }],
    };
    // Make the needs-key read old enough for a new live read.
    env.handle.sqlite
      .prepare("UPDATE app_health SET checked_at = ? WHERE service_id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), svc.id);
    const live = (
      await env.call("GET", `/api/services/${svc.id}/diagnostics`)
    ).json<AppDiagnostics>();
    expect(live.live).toBe(true);
    expect(live.report).toMatchObject({ status: "failing", version: "4.0.11", queueTotal: 1 });
    expect(live.report!.queue![0]!.title).toBe("Show.S01E01");
    expect(live.report!.connections).toEqual([{ name: "SABnzbd (usenet)", ok: true }]);
    const calls = fakeAppApi.calls.length;
    // Within ten seconds: the same read again, not another request to Sonarr.
    const again = (
      await env.call("GET", `/api/services/${svc.id}/diagnostics`)
    ).json<AppDiagnostics>();
    expect(again.live).toBe(false);
    expect(fakeAppApi.calls.length).toBe(calls);
    // Repeated live reads with an error never open an incident; the regular reads do that.
    for (let i = 0; i < 3; i++) {
      env.handle.sqlite
        .prepare("UPDATE app_health SET checked_at = ? WHERE service_id = ?")
        .run(new Date(Date.now() - 60_000).toISOString(), svc.id);
      await env.call("GET", `/api/services/${svc.id}/diagnostics`);
    }
    expect((await env.workspace()).incidents.filter((i) => i.serviceId === svc.id)).toEqual([]);
    expect(JSON.stringify(await env.workspace())).not.toContain("sonarr-test-key");
    expect((await env.call("GET", "/api/services/nope/diagnostics")).statusCode).toBe(404);
  });

  it("a refused key is reported as needing the key, not as a failure", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    await env.vault.add({
      name: "Prowlarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: svc.id,
      value: "wrong",
    });
    fakeAppApi.status = 401;
    await env.apps.check();
    await env.apps.check();
    const ws = await env.workspace();
    expect(ws.apps.find((r) => r.serviceId === svc.id)).toMatchObject({
      status: "needs-key",
      detail: expect.stringMatching(/refused the API key/),
    });
    expect(ws.incidents.filter((i) => i.status !== "resolved")).toEqual([]);
  });

  it("does not read paused apps; sample data shows a believable reading", async () => {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "Prowlarr")!;
    await env.call("PUT", `/api/services/${svc.id}/lifecycle`, { lifecycle: "paused" });
    await env.apps.check();
    expect((await env.workspace()).apps.map((r) => r.serviceId)).not.toContain(svc.id);

    const demo = await makeApp({ scenario: "attention" });
    await demo.apps.tick();
    const reading = (await demo.workspace()).apps.find((r) => r.app === "prowlarr")!;
    expect(reading).toMatchObject({ app: "prowlarr", status: "failing" });
    expect(reading.issues[0]!.text).toMatch(/sample data/);
    expect(fakeAppApi.calls).toEqual([]);
  });
});

describe("monitoring", () => {
  afterEach(() => fakeOutages.restoreAll());

  it("asks about a container that was stopped on purpose instead of restarting it", async () => {
    const { call, check, workspace, runner } = await realEnvironment();
    // Even with automatic repairs on, a clean stop is never undone by Hearth.
    await call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    await call("PATCH", "/api/settings", { liveRepairs: true });
    fakeOutages.stopContainer("sonarr", 143);
    await check();
    await check();
    let ws = await workspace();
    const incident = ws.incidents.find((i) => i.status !== "resolved")!;
    expect(incident).toMatchObject({ title: "Sonarr was stopped (not a crash)", severity: "info" });
    expect(incident.timeline.at(-1)!.text).toMatch(/stopped on purpose.*pause or retire it/);
    expect(fakeOutages.restarts()).toEqual([]);
    const sonarr = ws.services.find((s) => s.name === "Sonarr")!;
    await expect(
      runner.request({ kind: "restart-container", serviceId: sonarr.id, requestedBy: "agent" }),
    ).rejects.toThrow(/stopped on purpose/);

    // You say it is off on purpose: the question is closed, and it is no longer watched.
    const paused = await call("PUT", `/api/services/${sonarr.id}/lifecycle`, {
      lifecycle: "paused",
      note: "Waiting on a decision",
    });
    expect(paused.statusCode, paused.body).toBe(200);
    ws = await workspace();
    expect(ws.incidents.find((i) => i.id === incident.id)).toMatchObject({
      status: "resolved",
      handledBy: "you",
    });
    expect(ws.services.some((s) => s.id === sonarr.id)).toBe(false);
    expect(ws.inactiveServices).toMatchObject([
      { id: sonarr.id, lifecycle: "paused", lifecycleNote: "Waiting on a decision" },
    ]);
    await check();
    await check();
    expect((await workspace()).incidents.filter((i) => i.status !== "resolved")).toEqual([]);
    await expect(
      runner.request({ kind: "restart-container", serviceId: sonarr.id, requestedBy: "agent" }),
    ).rejects.toThrow(/paused by its owner/);
    const remembered = (await call("GET", "/api/memory/entries")).json<MemoryEntry[]>();
    expect(remembered[0]).toMatchObject({ title: "Sonarr paused", source: "you", basis: "stated" });

    // A re-scan keeps your choice, whether or not the paused service is ticked.
    for (const ticked of [true, false]) {
      const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
      const adopted = await call("POST", "/api/discovery/adopt", {
        reportId: report.id,
        selections: report.findings
          .filter((f) => f.selectedByDefault && f.sourceName !== "photos_db")
          .filter((f) => ticked || f.name !== "Sonarr")
          .map((f) => ({ key: f.key, name: f.name })),
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      expect((await workspace()).inactiveServices).toMatchObject([
        { id: sonarr.id, lifecycle: "paused", lifecycleNote: "Waiting on a decision" },
      ]);
    }

    // Retired, then watched again.
    await call("PUT", `/api/services/${sonarr.id}/lifecycle`, {
      lifecycle: "retired",
      note: "Replaced by something else",
    });
    expect((await workspace()).inactiveServices[0]!.lifecycle).toBe("retired");
    await call("PUT", `/api/services/${sonarr.id}/lifecycle`, { lifecycle: "active" });
    expect((await workspace()).services.some((s) => s.id === sonarr.id)).toBe(true);
  });

  it("still treats a crash as a failure to repair", async () => {
    const { check, workspace } = await realEnvironment();
    fakeOutages.stopContainer("sonarr", 1);
    await check();
    await check();
    expect((await workspace()).incidents.at(0)?.title).toBe("Sonarr is not running");
  });

  it("keeps a healthy environment quiet", async () => {
    const { check, workspace } = await realEnvironment();
    const first = await check();
    await check();
    expect(first).toMatchObject({ opened: 0, failing: 0 });
    const ws = await workspace();
    expect(ws.incidents).toHaveLength(0);
    expect(ws.services.find((s) => s.name === "Sonarr")?.responseMs).toBe(25);
    expect(ws.monitoring.lastRunAt).toBeTruthy();
  });

  it("does not open an incident for a single failed check", async () => {
    const { check, workspace } = await realEnvironment();
    fakeOutages.stopContainer("sonarr");
    expect((await check()).opened).toBe(0);
    fakeOutages.restoreAll();
    await check();
    const ws = await workspace();
    expect(ws.incidents).toHaveLength(0);
    expect(ws.activity.some((a) => /Sonarr/.test(a.text))).toBe(false);
  });

  it("opens one incident for a confirmed failure, then closes it when the service recovers", async () => {
    const { check, workspace } = await realEnvironment();
    fakeOutages.stopContainer("sonarr");
    await check();
    expect((await check()).opened).toBe(1);
    await check(); // still failing: no duplicate
    let ws = await workspace();
    expect(ws.incidents).toHaveLength(1);
    const incident = ws.incidents[0]!;
    // Media automation defaults to Ask before fixing, so a restart is proposed, not made.
    expect(incident).toMatchObject({
      title: "Sonarr is not running",
      status: "awaiting-approval",
      proposedAction: "Restart the Sonarr container, then check it is working again.",
    });
    expect(incident.timeline.map((e) => e.kind)).toEqual([
      "detected",
      "check",
      "check",
      "approval",
    ]);
    expect(incident.timeline[2]!.text).toBe(
      "Diagnosis: The container is not running: it was stopped because the system ran out of memory.",
    );
    expect(fakeOutages.restarts()).toEqual([]);
    expect(ws.services.find((s) => s.name === "Sonarr")?.health).toBe("offline");
    expect(ws.activity.slice(0, 2).map((a) => a.text)).toEqual([
      "Approval requested to restart Sonarr",
      "Sonarr is not running",
    ]);

    fakeOutages.restoreAll();
    expect((await check()).resolved).toBe(1);
    ws = await workspace();
    expect(ws.incidents[0]).toMatchObject({ status: "resolved", handledBy: "recovered" });
    expect(ws.incidents[0]!.proposedAction).toBeUndefined();
    expect(ws.incidents[0]!.timeline.at(-1)?.text).toMatch(/Recovered on its own/);
    // The proposal it no longer needs is closed, not left waiting.
    expect(ws.actions[0]).toMatchObject({ status: "refused", result: /recovered on its own/ });
    expect(ws.services.find((s) => s.name === "Sonarr")?.health).toBe("healthy");
    expect(ws.activity[0]?.text).toBe("Sonarr recovered on its own");
  });

  it("treats a container Docker reports unhealthy as failing", async () => {
    const { check, workspace } = await realEnvironment({ includeUnhealthyDb: true });
    await check();
    await check();
    const ws = await workspace();
    expect(ws.incidents.map((i) => i.title)).toEqual(["PostgreSQL (photos_db) is unhealthy"]);
  });

  it("spots a crash loop even while the container looks running", async () => {
    const { check, workspace } = await realEnvironment();
    fakeOutages.crashLoop("sonarr");
    await check(); // first look sets the baseline
    await check();
    await check();
    const incident = (await workspace()).incidents.find(
      (i) => i.title === "Sonarr keeps restarting",
    );
    expect(incident).toBeTruthy();
    expect(incident!.summary).toMatch(/3 restarts since the last check/);
  });

  it("checks web addresses as well as containers", async () => {
    const { check, workspace } = await realEnvironment();
    const prowlarr = (await workspace()).services.find((s) => s.name === "Prowlarr")!;
    fakeOutages.failUrl(prowlarr.localUrl!);
    await check();
    await check();
    const incident = (await workspace()).incidents.find((i) => i.serviceId === prowlarr.id)!;
    expect(incident.title).toBe("Prowlarr stopped responding");
    expect(incident.summary).toMatch(/connection refused/);
  });

  it("measures availability from checks", async () => {
    const { check, workspace } = await realEnvironment();
    expect(
      (await workspace()).services.find((s) => s.name === "Sonarr")?.uptimePct,
    ).toBeUndefined();
    await check();
    fakeOutages.stopContainer("sonarr");
    await check();
    expect((await workspace()).services.find((s) => s.name === "Sonarr")?.uptimePct).toBe(50);
  });

  it("keeps incident history and availability through a re-scan", async () => {
    const { call, check, workspace } = await realEnvironment();
    fakeOutages.stopContainer("sonarr");
    await check();
    await check();
    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    await call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings
        .filter((f) => f.selectedByDefault && f.sourceName !== "photos_db")
        .map((f) => ({ key: f.key, name: f.name })),
    });
    const ws = await workspace();
    expect(ws.incidents.map((i) => i.title)).toEqual(["Sonarr is not running"]);
    expect(ws.services.find((s) => s.name === "Sonarr")?.uptimePct).toBe(0);
  });

  it("simulates failures on sample data only", async () => {
    const { call, workspace, runner } = await makeApp({ scenario: "calm" });
    // Watch only, so the simulated failure stays until it is switched off.
    await call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "media", level: "monitor" }],
    });
    expect(
      (await call("POST", "/api/demo/simulate", { serviceId: "jellyfin", condition: "down" }))
        .statusCode,
    ).toBe(204);
    await call("POST", "/api/monitor/run");
    await call("POST", "/api/monitor/run");
    await runner.idle();
    let ws = await workspace();
    expect(ws.monitoring.simulated).toEqual(["jellyfin"]);
    expect(ws.incidents.find((i) => i.status === "open")?.title).toBe(
      "Jellyfin stopped responding",
    );
    await call("POST", "/api/demo/simulate", { serviceId: "jellyfin", condition: "normal" });
    await call("POST", "/api/monitor/run");
    ws = await workspace();
    expect(ws.incidents.filter((i) => i.status === "open")).toHaveLength(0);

    const real = await realEnvironment();
    const refused = await real.call("POST", "/api/demo/simulate", {
      serviceId: "sonarr",
      condition: "down",
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain("never on your own systems");
  });

  it("does not duplicate the sample full-disk incident", async () => {
    const { call, workspace } = await makeApp({ scenario: "attention" });
    await call("POST", "/api/monitor/run");
    const full = (await workspace()).incidents.filter((i) => /Movies volume/.test(i.title));
    expect(full).toHaveLength(1);
  });

  it("lets you tune how often and how strictly it checks", async () => {
    const { call, workspace } = await makeApp({ scenario: "calm" });
    expect(
      (await call("PATCH", "/api/settings", { monitorIntervalSec: 120, failureThreshold: 3 }))
        .statusCode,
    ).toBe(204);
    expect((await workspace()).monitoring).toMatchObject({ intervalSec: 120, failureThreshold: 3 });
    expect((await call("PATCH", "/api/settings", { monitorIntervalSec: 5 })).statusCode).toBe(400);
  });
});

describe("actions and autonomy", () => {
  afterEach(() => fakeOutages.restoreAll());

  const incidentFor = (ws: Workspace, serviceId: string) =>
    ws.incidents.find((i) => i.serviceId === serviceId)!;

  /** Sample data with one service failing until confirmed, and the response finished. */
  async function sampleFailure(serviceId: string, condition: "down" | "stuck") {
    const app = await makeApp({ scenario: "calm" });
    await app.call("POST", "/api/demo/simulate", { serviceId, condition });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await app.runner.idle();
    return app;
  }

  it("fixes a failure automatically and verifies it (Fix automatically)", async () => {
    const { workspace, audit } = await sampleFailure("jellyfin", "down");
    const ws = await workspace();
    const incident = incidentFor(ws, "jellyfin");
    // Detected with context, policy evaluated, repaired, verified, resolved, recorded.
    expect(incident).toMatchObject({ status: "resolved", handledBy: "runbook" });
    expect(incident.timeline.map((e) => e.kind)).toEqual([
      "detected",
      "check",
      "check",
      "action",
      "check",
      "resolved",
    ]);
    expect(incident.timeline[3]!.text).toBe(
      "Restart the Jellyfin container. Allowed: Media servers is set to Fix automatically.",
    );
    expect(incident.timeline[4]!.text).toMatch(/^Health check passed: Jellyfin is responding/);
    expect(incident.resolution).toMatch(/Nothing is needed from you/);
    expect(ws.actions[0]).toMatchObject({
      kind: "restart-container",
      requestedBy: "dragon-control",
      status: "succeeded",
      incidentId: incident.id,
    });
    expect(ws.services.find((s) => s.id === "jellyfin")?.health).toBe("healthy");
    expect(ws.monitoring.simulated).toEqual([]);
    expect(ws.activity[0]?.text).toBe("Jellyfin fixed automatically");
    expect((await audit()).slice(0, 2).map((a) => [a.actor, a.action])).toEqual([
      ["dragon-control", "Verified Jellyfin is working after the restart"],
      ["dragon-control", "Restarted the Jellyfin container"],
    ]);
  });

  it("escalates when the repair does not work, and does not keep retrying", async () => {
    const { call, workspace, runner } = await sampleFailure("jellyfin", "stuck");
    let ws = await workspace();
    const incident = incidentFor(ws, "jellyfin");
    expect(incident).toMatchObject({ status: "open", handledBy: "pending" });
    expect(incident.timeline.at(-1)).toMatchObject({
      kind: "escalated",
      text: "The restart did not fix it. Waiting for you.",
    });
    expect(ws.actions[0]).toMatchObject({ status: "failed" });
    expect(ws.actions[0]!.result).toMatch(/Still failing/);
    expect(ws.activity[0]?.text).toBe("Restarting Jellyfin did not fix it");

    await call("POST", "/api/monitor/run");
    await call("POST", "/api/monitor/run");
    await runner.idle();
    ws = await workspace();
    expect(ws.actions.filter((a) => a.kind === "restart-container")).toHaveLength(1);
    // One incident still open (the other Jellyfin incident is resolved sample history).
    expect(
      ws.incidents.filter((i) => i.serviceId === "jellyfin" && i.status !== "resolved"),
    ).toHaveLength(1);
  });

  it("proposes the repair under Ask before fixing, and carries it out once approved", async () => {
    const { call, workspace, runner, audit } = await sampleFailure("caddy", "down");
    let incident = incidentFor(await workspace(), "caddy");
    expect(incident).toMatchObject({
      status: "awaiting-approval",
      proposedAction: "Restart the Caddy container, then check it is working again.",
    });
    expect(incident.timeline.at(-1)).toMatchObject({
      kind: "approval",
      text: "Proposed: Restart the Caddy container. Reverse proxy is set to Ask before fixing.",
    });

    const decided = await approve(call, `/api/incidents/${incident.id}/decision`);
    expect(decided.statusCode).toBe(204);
    await runner.idle();
    const ws = await workspace();
    incident = incidentFor(ws, "caddy");
    expect(incident).toMatchObject({ status: "resolved", handledBy: "you" });
    expect(incident.resolution).toMatch(/with your approval/);
    expect(ws.actions[0]).toMatchObject({ status: "succeeded", requestedBy: "dragon-control" });
    expect((await audit()).map((a) => a.action)).toContain("Approved a repair");
  });

  it("re-checks the policy when you approve: tightening autonomy in between wins", async () => {
    const { call, workspace, runner } = await sampleFailure("caddy", "down");
    const incident = incidentFor(await workspace(), "caddy");
    await call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "proxy", level: "diagnose" }],
    });
    await approve(call, `/api/incidents/${incident.id}/decision`);
    await runner.idle();
    const ws = await workspace();
    expect(incidentFor(ws, "caddy")).toMatchObject({ status: "open", handledBy: "pending" });
    expect(incidentFor(ws, "caddy").timeline.at(-1)?.text).toBe(
      "Your approval could not be carried out: Reverse proxy is set to Diagnose, so Hearth does not change anything there.",
    );
    expect(ws.actions[0]).toMatchObject({ status: "refused" });
    expect(ws.monitoring.simulated).toEqual(["caddy"]); // nothing was restarted
  });

  it("closes the proposal when you decline", async () => {
    const { call, workspace } = await sampleFailure("caddy", "down");
    const incident = incidentFor(await workspace(), "caddy");
    await call("POST", `/api/incidents/${incident.id}/decision`, { decision: "decline" });
    const ws = await workspace();
    expect(incidentFor(ws, "caddy").status).toBe("open");
    expect(ws.actions[0]).toMatchObject({ status: "refused", result: "You declined it." });
  });

  it("only diagnoses under Diagnose, and only watches under Monitor", async () => {
    const diag = await makeApp({ scenario: "calm" });
    await diag.call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "media", level: "diagnose" }],
    });
    await diag.call("POST", "/api/demo/simulate", { serviceId: "plex", condition: "down" });
    await diag.call("POST", "/api/monitor/run");
    await diag.call("POST", "/api/monitor/run");
    await diag.runner.idle();
    let incident = incidentFor(await diag.workspace(), "plex");
    expect(incident.status).toBe("open");
    expect(incident.timeline.slice(-2).map((e) => e.text)).toEqual([
      "Diagnosis: The container is running, but its web interface stopped answering.",
      "Media servers is set to Diagnose, so Hearth does not change anything there. A restart would be the usual fix. Waiting for you.",
    ]);

    const watch = await makeApp({ scenario: "calm" });
    await watch.call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "media", level: "monitor" }],
    });
    await watch.call("POST", "/api/demo/simulate", { serviceId: "plex", condition: "down" });
    await watch.call("POST", "/api/monitor/run");
    await watch.call("POST", "/api/monitor/run");
    await watch.runner.idle();
    incident = incidentFor(await watch.workspace(), "plex");
    expect(incident.timeline.map((e) => e.kind)).toEqual(["detected", "check", "escalated"]);
    expect(incident.timeline[2]!.text).toMatch(/set to Monitor, so Hearth only watches/);
    expect((await watch.workspace()).actions).toHaveLength(0);
  });

  it("holds automatic repairs on your real systems until you switch them on", async () => {
    const env = await realEnvironment();
    await env.call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;

    fakeOutages.stopContainer("sonarr");
    await env.check();
    await env.check();
    let incident = incidentFor(await env.workspace(), sonarr.id);
    expect(incident.status).toBe("awaiting-approval");
    expect(incident.timeline.at(-1)?.text).toMatch(
      /Automatic repairs on your own systems are switched off/,
    );
    expect(fakeOutages.restarts()).toEqual([]);

    // You approve: the restart happens and is verified against Docker.
    await approve(env.call, `/api/incidents/${incident.id}/decision`);
    await env.runner.idle();
    expect(fakeOutages.restarts()).toEqual(["sonarr"]);
    incident = incidentFor(await env.workspace(), sonarr.id);
    expect(incident).toMatchObject({ status: "resolved", handledBy: "you" });

    // Switched on: the next failure is fixed without asking.
    expect((await env.call("PATCH", "/api/settings", { liveRepairs: true })).statusCode).toBe(204);
    fakeOutages.stopContainer("sonarr");
    await env.check();
    await env.check();
    const ws = await env.workspace();
    expect(ws.liveRepairs).toBe(true);
    expect(fakeOutages.restarts()).toEqual(["sonarr", "sonarr"]);
    expect(ws.incidents.filter((i) => i.serviceId === sonarr.id).map((i) => i.handledBy)).toEqual([
      "runbook",
      "you",
    ]);
    expect((await env.audit()).map((a) => a.action)).toContain(
      "Turned on automatic repairs for your systems",
    );
  });

  it("may repair a labelled test container automatically even with live repairs off", async () => {
    const env = await realEnvironment();
    await env.call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    fakeOutages.markSandbox("sonarr");
    fakeOutages.stopContainer("sonarr");
    await env.check();
    await env.check();
    const ws = await env.workspace();
    expect(fakeOutages.restarts()).toEqual(["sonarr"]);
    expect(ws.incidents[0]?.timeline.find((e) => e.kind === "action")?.text).toMatch(
      /this is a test container/,
    );
  });

  it("does not restart a crash loop, and stops after repeated restarts in an hour", async () => {
    const env = await realEnvironment();
    await env.call("PUT", "/api/autonomy", { default: "auto", rules: [] });
    await env.call("PATCH", "/api/settings", { liveRepairs: true });
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;

    fakeOutages.crashLoop("prowlarr");
    await env.check();
    await env.check();
    await env.check();
    const radarr = (await env.workspace()).incidents.find(
      (i) => i.title === "Prowlarr keeps restarting",
    )!;
    expect(radarr.timeline.at(-1)?.text).toMatch(/already restarting Prowlarr over and over/);
    expect(fakeOutages.restarts()).toEqual([]);

    for (let i = 0; i < 4; i++) {
      fakeOutages.stopContainer("sonarr");
      await env.check();
      await env.check();
    }
    expect(fakeOutages.restarts()).toEqual(["sonarr", "sonarr", "sonarr"]);
    const last = (await env.workspace()).incidents.find(
      (i) => i.serviceId === sonarr.id && i.status !== "resolved",
    )!;
    expect(last.timeline.at(-1)?.text).toMatch(/already been restarted 3 times in the last hour/);
  });

  it("lets you restart, test, and read logs, and records each", async () => {
    const env = await realEnvironment();
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;

    const restart = await env.call("POST", "/api/actions", {
      kind: "restart-container",
      serviceId: sonarr.id,
    });
    expect(restart.json().action).toMatchObject({ status: "running", requestedBy: "you" });
    await env.runner.idle();
    expect(fakeOutages.restarts()).toEqual(["sonarr"]);
    expect((await env.workspace()).actions[0]).toMatchObject({
      label: "Restart the Sonarr container",
      status: "succeeded",
    });
    const audited = (await env.audit()).find((a) => a.action === "Restarted the Sonarr container");
    expect(audited?.actor).toBe("you");

    const test = (
      await env.call("POST", "/api/actions", { kind: "test-endpoint", serviceId: sonarr.id })
    ).json();
    expect(test.action).toMatchObject({
      status: "succeeded",
      result: "Answered in 25 ms (HTTP 200).",
    });

    const logs = (
      await env.call("POST", "/api/actions", { kind: "inspect-logs", serviceId: sonarr.id })
    ).json<{ lines: string[] }>();
    expect(logs.lines).toContain("[sonarr] Connected with apikey=[hidden]");
  });

  it("rejects attempts to get around the policy", async () => {
    const env = await realEnvironment();
    const ws = await env.workspace();
    const sonarr = ws.services.find((s) => s.name === "Sonarr")!;

    // A request cannot claim to come from Hearth or an agent.
    const spoofed = await env.call("POST", "/api/actions", {
      kind: "restart-container",
      serviceId: sonarr.id,
      requestedBy: "dragon-control",
    });
    expect(spoofed.statusCode).toBe(400);
    const unknownKind = await env.call("POST", "/api/actions", {
      kind: "delete-everything",
      serviceId: sonarr.id,
    });
    expect(unknownKind.statusCode).toBe(400);
    const unknownService = await env.call("POST", "/api/actions", {
      kind: "restart-container",
      serviceId: "nope",
    });
    expect(unknownService.statusCode).toBe(404);

    const native = ws.services.find((s) => s.kind === "process")!;
    const notContainer = await env.call("POST", "/api/actions", {
      kind: "restart-container",
      serviceId: native.id,
    });
    expect(notContainer.statusCode).toBe(409);
    expect(notContainer.json().message).toMatch(/not a container/);

    // Approving something that was never proposed changes nothing.
    const unknownIncident = await approve(env.call, "/api/incidents/inc-none/decision");
    expect(unknownIncident.statusCode).toBe(404);
    expect(fakeOutages.restarts()).toEqual([]);
  });
});

describe("sign-in, sessions, and the vault", () => {
  type Status = {
    claimed: boolean;
    signedIn: boolean;
    recentlyVerified?: boolean;
    vaultUnlockedUntil?: string;
  };

  it("locks every API route except health and the ways to sign in", async () => {
    const { app, send } = await makeApp({ scenario: "calm" });
    const locked = app.apiRoutes.filter(
      (r) => r.split(" ")[1]!.startsWith("/api/") && !PUBLIC_ROUTES.has(r),
    );
    expect(locked.length).toBeGreaterThan(30);
    for (const route of locked) {
      const [method, url] = route.split(" ") as [Method, string];
      const res = await send(method, url.replace(/:[a-z]+/gi, "x"), {});
      expect(res.statusCode, route).toBe(401);
    }
    expect((await send("GET", "/api/health")).statusCode).toBe(200);
  });

  it("can only be claimed with the setup code, once, and slows down guessing", async () => {
    const { send, auth } = await makeApp({ signedIn: false });
    expect((await send("GET", "/api/auth/status")).json<Status>()).toEqual({
      claimed: false,
      signedIn: false,
      usernameRequired: false,
      viaInternet: false,
      joinedTo: null,
    });
    const code = (await auth.setupCode())!;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await send("POST", "/api/auth/setup", { code, password: "short" })).statusCode).toBe(
      400,
    );
    for (let i = 0; i < 5; i++) {
      const wrong = await send("POST", "/api/auth/setup", {
        code: "AAAA-AAAA",
        password: TEST_PASSWORD,
      });
      expect(wrong.statusCode).toBe(403);
    }
    // Now even the right code has to wait.
    const throttled = await send("POST", "/api/auth/setup", { code, password: TEST_PASSWORD });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json().message).toMatch(/Try again in \d+ seconds/);
  });

  it("claims, signs out, and signs in with the password", async () => {
    const { send, auth, cookieOf } = await makeApp({ signedIn: false });
    const code = (await auth.setupCode())!;
    const setup = await send("POST", "/api/auth/setup", { code, password: TEST_PASSWORD });
    expect(setup.statusCode).toBe(200);
    const { recoveryKey } = setup.json<{ recoveryKey: string }>();
    expect(recoveryKey).toMatch(/^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);
    const cookie = cookieOf(setup)!;
    expect(setup.cookies[0]).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/" });
    expect(await auth.setupCode()).toBeNull();
    expect(
      (await send("POST", "/api/auth/setup", { code, password: TEST_PASSWORD })).statusCode,
    ).toBe(409);

    expect((await send("GET", "/api/workspace", undefined, cookie)).statusCode).toBe(200);
    expect((await send("POST", "/api/auth/logout", {}, cookie)).statusCode).toBe(204);
    expect((await send("GET", "/api/workspace", undefined, cookie)).statusCode).toBe(401);

    expect(
      (await send("POST", "/api/auth/login", { password: "wrong password here" })).statusCode,
    ).toBe(401);
    const login = await send("POST", "/api/auth/login", { password: TEST_PASSWORD });
    expect(login.statusCode).toBe(204);
    expect((await send("GET", "/api/workspace", undefined, cookieOf(login))).statusCode).toBe(200);
  });

  it("expires sessions and refuses requests from other sites", async () => {
    const { handle, call, send, cookie } = await makeApp({ scenario: "calm" });
    const crossSite = await send("POST", "/api/monitor/run", {}, cookie());
    expect(crossSite.statusCode).toBe(200);
    const forged = await (async () =>
      (await makeApp({ handle, scenario: undefined })).app.inject({
        method: "POST",
        url: "/api/monitor/run",
        payload: {},
        headers: { cookie: cookie()!, origin: "https://evil.example", host: "localhost" },
      }))();
    expect(forged.statusCode).toBe(403);

    await handle.db.update(sessionsTable).set({ expiresAt: "2000-01-01T00:00:00.000Z" });
    expect((await call("GET", "/api/workspace")).statusCode).toBe(401);
  });

  it("keeps secret values out of everything it shows or stores in the clear", async () => {
    const { call, handle, workspace } = await makeApp({ scenario: "calm" });
    const value = "sk-live-1234567890-very-secret";
    for (const tier of ["automation", "protected"] as const) {
      const res = await call("POST", "/api/vault/secrets", {
        name: `Sonarr ${tier}`,
        kind: "api-key",
        tier,
        serviceId: "sonarr",
        value,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(value);
    }
    const listed = await call("GET", "/api/vault");
    expect(listed.json().secrets).toHaveLength(2);
    const everything = [
      listed.body,
      JSON.stringify(await workspace()),
      (await call("GET", "/api/audit?limit=100")).body,
      JSON.stringify(await handle.db.select().from(vaultSecretsTable)),
    ].join("\n");
    expect(everything).not.toContain(value);
    expect(everything).not.toContain("very-secret");
  });

  it("shows automation secrets after a recent check and protected ones only when unlocked", async () => {
    const { call, handle } = await makeApp();
    const add = async (tier: "automation" | "protected") =>
      (
        await call("POST", "/api/vault/secrets", {
          name: tier,
          kind: "password",
          tier,
          value: `value-${tier}`,
        })
      ).json<{ id: string }>().id;
    const auto = await add("automation");
    const prot = await add("protected");
    const reveal = (id: string) => call("POST", `/api/vault/secrets/${id}/reveal`, {});

    // Just signed in with the password: recent, and the vault is unlocked.
    expect((await reveal(auto)).json().value).toBe("value-automation");
    expect((await reveal(prot)).json().value).toBe("value-protected");

    await call("POST", "/api/vault/lock", {});
    expect((await reveal(prot)).statusCode).toBe(403);
    expect((await reveal(auto)).statusCode).toBe(200);

    // An hour later the check is no longer recent.
    await handle.db.update(sessionsTable).set({ verifiedAt: "2000-01-01T00:00:00.000Z" });
    expect((await reveal(auto)).statusCode).toBe(403);
    expect((await call("DELETE", `/api/vault/secrets/${auto}`)).statusCode).toBe(403);

    // Confirming the password inside the session unlocks again.
    expect((await call("POST", "/api/auth/login", { password: TEST_PASSWORD })).statusCode).toBe(
      204,
    );
    expect((await reveal(prot)).json().value).toBe("value-protected");
    expect((await call("DELETE", `/api/vault/secrets/${auto}`)).statusCode).toBe(204);
    const audit = (await call("GET", "/api/audit?limit=50")).json<AuditRecord[]>();
    expect(audit.map((a) => a.action)).toContain('Viewed "protected"');
  });

  it("switches host administration on only right after you confirm it is you; off never asks", async () => {
    const { call, handle } = await makeApp();
    await handle.db.update(sessionsTable).set({ verifiedAt: "2000-01-01T00:00:00.000Z" });
    const on = () =>
      call("POST", "/api/admin/scopes", { hostId: "no-such-host", operations: ["investigate"] });
    const refused = await on();
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/whole machine\. Confirm it's you/);
    expect((await call("POST", "/api/auth/login", { password: TEST_PASSWORD })).statusCode).toBe(
      204,
    );
    // Past the check: the request itself is judged now (this test has no such host).
    expect((await on()).statusCode).toBe(404);
  });

  it("keeps the credential list behind the lock, with details that describe but never reveal", async () => {
    const { call, handle } = await makeApp();
    const created = await call("POST", "/api/vault/secrets", {
      name: "Router admin",
      kind: "login",
      tier: "protected",
      value: "router-pass-do-not-leak",
      category: "Router",
      username: "admin",
      endpoint: "192.168.1.1",
      notes: "Admin page on the LAN only",
      tags: ["network", "network", " admin "],
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json<{ id: string }>().id;
    let vault = (await call("GET", "/api/vault")).json<{
      locked: boolean;
      secrets: Record<string, unknown>[];
    }>();
    expect(vault.locked).toBe(false);
    expect(vault.secrets[0]).toMatchObject({
      category: "Router",
      username: "admin",
      endpoint: "192.168.1.1",
      tags: ["network", "admin"],
    });

    // Locked and no recent check: only a count, no names, accounts, or places.
    await call("POST", "/api/vault/lock", {});
    await handle.db.update(sessionsTable).set({ verifiedAt: "2000-01-01T00:00:00.000Z" });
    const locked = await call("GET", "/api/vault");
    expect(locked.json()).toMatchObject({ locked: true, count: 1, secrets: [] });
    expect(locked.body).not.toContain("Router admin");
    expect(locked.body).not.toContain("admin");

    // Unlocking opens the list again; "it works" is recorded without the value.
    expect((await call("POST", "/api/auth/login", { password: TEST_PASSWORD })).statusCode).toBe(
      204,
    );
    expect((await call("POST", `/api/vault/secrets/${id}/verified`, {})).statusCode).toBe(204);
    await call("PATCH", `/api/vault/secrets/${id}`, { notes: null, tags: [] });
    vault = (await call("GET", "/api/vault")).json();
    expect(vault.secrets[0]).toMatchObject({ verifiedAt: expect.any(String), tags: [] });
    expect(vault.secrets[0]!.notes).toBeUndefined();
    // Replacing the value clears "worked", since the new one has not been tried.
    await call("PATCH", `/api/vault/secrets/${id}`, { value: "new-router-pass" });
    expect((await call("GET", "/api/vault")).json().secrets[0].verifiedAt).toBeUndefined();
    const audit = (await call("GET", "/api/audit?limit=50")).body;
    expect(
      (await call("GET", "/api/audit?limit=50")).json<AuditRecord[]>().map((a) => a.action),
    ).toContain('Confirmed "Router admin" still works');
    expect(audit).not.toContain("router-pass");
  });

  it("uses automation secrets unattended after a restart, but never protected ones", async () => {
    const first = await makeApp();
    const add = async (tier: "automation" | "protected") =>
      (
        await first.call("POST", "/api/vault/secrets", {
          name: tier,
          kind: "token",
          tier,
          value: `v-${tier}`,
        })
      ).json<{ id: string }>().id;
    const auto = await add("automation");
    const prot = await add("protected");

    // A fresh process: same database and machine, nothing in memory.
    const auth = new Auth(first.handle, { keyGuard, kdfCost: 1024 });
    const vault = new Vault(first.handle, auth);
    expect(await vault.use(auto, "check the Sonarr queue", { actor: "dragon-control" })).toBe(
      "v-automation",
    );
    await expect(vault.use(prot, "log in to the router", { actor: "agent" })).rejects.toThrow(
      /needs you to unlock it/,
    );
    const audit = (await first.call("GET", "/api/audit?limit=50")).json<AuditRecord[]>();
    expect(audit.find((a) => a.action === 'Used "automation"')).toMatchObject({
      actor: "dragon-control",
      detail: { purpose: "check the Sonarr queue" },
    });

    // On another machine (another key guard) automation secrets cannot be opened.
    const elsewhere = new Vault(
      first.handle,
      new Auth(first.handle, { keyGuard: memoryKeyGuard(), kdfCost: 1024 }),
    );
    await expect(elsewhere.use(auto, "x", { actor: "dragon-control" })).rejects.toThrow(
      /cannot be opened/,
    );

    // Tampering is detected, not decrypted into garbage.
    await first.handle.db.update(vaultSecretsTable).set({ ciphertext: "AAAA" + "B".repeat(60) });
    await expect(vault.use(auto, "x", { actor: "dragon-control" })).rejects.toThrow(/tampered/);
  });

  it("recovers with the recovery key, keeping protected secrets readable", async () => {
    const { call, send, cookieOf, recoveryKey } = await makeApp();
    const id = (
      await call("POST", "/api/vault/secrets", {
        name: "Router",
        kind: "password",
        tier: "protected",
        value: "router-admin-pass",
      })
    ).json<{ id: string }>().id;

    const typed = recoveryKey()!.toLowerCase().replace(/-/g, " ");
    const wrong = await send("POST", "/api/auth/recover", {
      recoveryKey: "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA",
      newPassword: "a brand new password",
    });
    expect(wrong.statusCode).toBe(401);
    const recovered = await send("POST", "/api/auth/recover", {
      recoveryKey: typed,
      newPassword: "a brand new password",
    });
    expect(recovered.statusCode).toBe(204);
    const cookie = cookieOf(recovered)!;
    expect((await send("POST", `/api/vault/secrets/${id}/reveal`, {}, cookie)).json().value).toBe(
      "router-admin-pass",
    );
    expect((await send("POST", "/api/auth/login", { password: TEST_PASSWORD })).statusCode).toBe(
      401,
    );
    expect(
      (await send("POST", "/api/auth/login", { password: "a brand new password" })).statusCode,
    ).toBe(204);
  });

  it("changes the password and replaces the recovery key", async () => {
    const { call, send, recoveryKey } = await makeApp();
    const id = (
      await call("POST", "/api/vault/secrets", {
        name: "Mail",
        kind: "password",
        tier: "protected",
        value: "mail-pass",
      })
    ).json<{ id: string }>().id;
    expect(
      (
        await call("POST", "/api/auth/password", {
          current: "nope nope nope",
          next: "x".repeat(12),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await call("POST", "/api/auth/password", {
          current: TEST_PASSWORD,
          next: "new password 123",
        })
      ).statusCode,
    ).toBe(204);
    const fresh = await send("POST", "/api/auth/login", { password: "new password 123" });
    expect(fresh.statusCode).toBe(204);

    const old = recoveryKey()!;
    const replaced = await call("POST", "/api/auth/recovery-key", { password: "new password 123" });
    const next = replaced.json<{ recoveryKey: string }>().recoveryKey;
    expect(next).not.toBe(old);
    expect(
      (await send("POST", "/api/auth/recover", { recoveryKey: old, newPassword: "y".repeat(12) }))
        .statusCode,
    ).toBe(401);
    const viaNew = await send("POST", "/api/auth/recover", {
      recoveryKey: next,
      newPassword: "z".repeat(12),
    });
    expect(viaNew.statusCode).toBe(204);
    expect(
      (
        await send(
          "POST",
          `/api/vault/secrets/${id}/reveal`,
          {},
          `dc_session=${viaNew.cookies[0]!.value}`,
        )
      ).json().value,
    ).toBe("mail-pass");
  });

  it("only offers to add a passkey right after you confirm it is you", async () => {
    const { call, handle } = await makeApp();
    const options = await call("POST", "/api/auth/passkeys/options", {});
    expect(options.statusCode).toBe(200);
    expect(options.json()).toMatchObject({
      rp: { name: "Hearth", id: "localhost" },
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await call("POST", "/api/vault/lock", {});
    expect((await call("POST", "/api/auth/passkeys/options", {})).statusCode).toBe(403);
    await handle.db.update(sessionsTable).set({ verifiedAt: "2000-01-01T00:00:00.000Z" });
    expect((await call("POST", "/api/auth/passkeys/options", {})).statusCode).toBe(403);
  });
});

describe("resetting the owner from the machine", () => {
  it("forgets the owner and vault but keeps everything else, ready to set up again", async () => {
    const { call, send, handle, auth, workspace } = await makeApp({ scenario: "calm" });
    await call("POST", "/api/vault/secrets", {
      name: "Test key",
      kind: "api-key",
      tier: "automation",
      value: "throwaway",
    });
    const servicesBefore = (await workspace()).services.length;

    expect(await resetOwner(handle)).toEqual({ secretsRemoved: 1 });

    // The old session is gone and the installation is unclaimed again.
    expect((await call("GET", "/api/workspace")).statusCode).toBe(401);
    expect((await send("GET", "/api/auth/status")).json()).toEqual({
      claimed: false,
      signedIn: false,
      usernameRequired: false,
      viaInternet: false,
      joinedTo: null,
    });
    expect((await send("POST", "/api/auth/login", { password: TEST_PASSWORD })).statusCode).toBe(
      409,
    );

    // A new setup works, with a fresh vault, and nothing else was lost.
    const code = (await auth.setupCode())!;
    const again = await send("POST", "/api/auth/setup", { code, password: "a different one 1" });
    expect(again.statusCode).toBe(200);
    const cookie = `dc_session=${again.cookies[0]!.value}`;
    const ws = (await send("GET", "/api/workspace", undefined, cookie)).json<Workspace>();
    expect(ws.services).toHaveLength(servicesBefore);
    expect((await send("GET", "/api/vault", undefined, cookie)).json().secrets).toEqual([]);
    const audit = (await send("GET", "/api/audit?limit=5", undefined, cookie)).json<
      AuditRecord[]
    >();
    expect(audit.map((a) => a.action)).toContain("Reset the owner from this machine");
  });
});

describe("runbooks: dependencies first", () => {
  afterEach(() => fakeOutages.restoreAll());

  async function confirmSample(app: Awaited<ReturnType<typeof makeApp>>, serviceId: string) {
    await app.call("POST", "/api/demo/simulate", { serviceId, condition: "upstream" });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await app.runner.idle();
  }

  it("waits for a dependency's own repair, then finds the service recovered (sample data)", async () => {
    const app = await makeApp({ scenario: "calm" });
    await confirmSample(app, "tautulli"); // Tautulli depends on Plex; both Fix automatically
    const ws = await app.workspace();
    const plex = ws.incidents.find((i) => i.serviceId === "plex" && i.status === "resolved")!;
    const tautulli = ws.incidents.find((i) => i.serviceId === "tautulli")!;
    expect(plex.handledBy).toBe("runbook");
    expect(tautulli).toMatchObject({ status: "resolved", handledBy: "runbook" });
    expect(tautulli.resolution).toBe(
      "Tautulli recovered once Plex, which it depends on, was fixed. Nothing was restarted for Tautulli.",
    );
    expect(tautulli.timeline.at(-2)?.text).toMatch(
      /^Tautulli depends on Plex, which was just repaired/,
    );
    const restarts = ws.actions.filter((a) => a.kind === "restart-container");
    expect(restarts.map((a) => a.label)).toEqual(["Restart the Plex container"]);
    expect(ws.monitoring.simulated).toEqual([]);
  });

  it("points at the dependency's incident when that one needs you (sample data)", async () => {
    const app = await makeApp({ scenario: "calm" });
    await confirmSample(app, "prowlarr"); // FlareSolverr is Ask before fixing
    let ws = await app.workspace();
    const flare = ws.incidents.find(
      (i) => i.serviceId === "flaresolverr" && i.status !== "resolved",
    )!;
    expect(flare.status).toBe("awaiting-approval");
    const prowlarr = ws.incidents.find(
      (i) => i.serviceId === "prowlarr" && i.status !== "resolved",
    )!;
    expect(prowlarr.timeline.at(-1)?.text).toBe(
      'Prowlarr cannot recover until FlareSolverr does, and FlareSolverr needs you first (see "FlareSolverr stopped responding"). Waiting for you.',
    );

    // Approving FlareSolverr's restart fixes it; Prowlarr then recovers by itself.
    await approve(app.call, `/api/incidents/${flare.id}/decision`);
    await app.runner.idle();
    await app.call("POST", "/api/monitor/run");
    ws = await app.workspace();
    expect(ws.incidents.filter((i) => i.status !== "resolved")).toHaveLength(0);
    expect(ws.actions.filter((a) => a.kind === "restart-container").map((a) => a.label)).toEqual([
      "Restart the FlareSolverr container",
    ]);
  });

  /** Your systems (the fake homelab) with everything on Fix automatically and live repairs on. */
  async function automatic() {
    const env = await realEnvironment();
    const rules = (await env.workspace()).autonomyRules.map((r) => ({
      id: r.id,
      level: "default",
    }));
    await env.call("PUT", "/api/autonomy", { default: "auto", rules });
    await env.call("PATCH", "/api/settings", { liveRepairs: true });
    const ws = await env.workspace();
    const prowlarr = ws.services.find((s) => s.name === "Prowlarr")!;
    const vpn = ws.services.find((s) => prowlarr.dependsOn.includes(s.id))!;
    return { ...env, prowlarr, vpn };
  }

  it("repairs the dependency instead of the service, then retests the service", async () => {
    const env = await automatic();
    fakeOutages.failUrl(env.prowlarr.localUrl!, "vpn"); // the VPN's fault
    await env.check();
    fakeOutages.stopContainer("vpn");
    await env.check(); // Prowlarr confirmed; the VPN has only failed once
    expect(fakeOutages.restarts()).toEqual(["vpn"]);
    const ws = await env.workspace();
    const incident = ws.incidents.find((i) => i.serviceId === env.prowlarr.id)!;
    expect(incident).toMatchObject({ status: "resolved", handledBy: "runbook" });
    const texts = incident.timeline.map((e) => e.text);
    expect(texts).toContain(
      `Known fix: check what Prowlarr depends on first. ${env.vpn.name} is not running.`,
    );
    expect(
      texts.some((t) =>
        t.startsWith(`Restart the ${env.vpn.name} container, which Prowlarr depends on.`),
      ),
    ).toBe(true);
    expect(texts.some((t) => t.startsWith("Retested Prowlarr: Prowlarr is responding"))).toBe(true);
    expect(incident.resolution).toMatch(/Prowlarr itself was not touched/);
    expect(ws.incidents.filter((i) => i.serviceId === env.vpn.id)).toHaveLength(0);
  });

  it("goes on to repair the service when fixing the dependency was not enough", async () => {
    const env = await automatic();
    fakeOutages.failUrl(env.prowlarr.localUrl!, "prowlarr"); // Prowlarr's own fault
    await env.check();
    fakeOutages.stopContainer("vpn");
    await env.check();
    await env.runner.idle();
    expect(fakeOutages.restarts()).toEqual(["vpn", "prowlarr"]);
    const incident = (await env.workspace()).incidents.find(
      (i) => i.serviceId === env.prowlarr.id,
    )!;
    expect(incident.status).toBe("resolved");
    expect(incident.timeline.map((e) => e.text)).toContain(
      `${env.vpn.name} is back, but Prowlarr still stopped responding (connection refused).`,
    );
  });

  it("escalates when the dependency cannot be fixed", async () => {
    const env = await automatic();
    fakeOutages.failUrl(env.prowlarr.localUrl!, "vpn");
    await env.check();
    fakeOutages.stopContainer("vpn");
    fakeOutages.stuck("vpn");
    await env.check();
    const incident = (await env.workspace()).incidents.find(
      (i) => i.serviceId === env.prowlarr.id,
    )!;
    expect(incident).toMatchObject({ status: "open", handledBy: "pending" });
    expect(incident.timeline.at(-1)?.text).toBe(
      `Restarting ${env.vpn.name} did not fix it, so Prowlarr cannot recover yet. Waiting for you.`,
    );
    expect(fakeOutages.restarts()).toEqual(["vpn"]);
  });

  it("notes when the same problem has been seen before", async () => {
    const env = await automatic();
    for (let i = 0; i < 2; i++) {
      fakeOutages.stopContainer("sonarr");
      await env.check();
      await env.check();
    }
    const sonarr = (await env.workspace()).incidents.filter(
      (i) => i.title === "Sonarr is not running",
    );
    expect(sonarr).toHaveLength(2);
    expect(sonarr.map((i) => i.status)).toEqual(["resolved", "resolved"]);
    expect(sonarr[0]!.timeline.map((e) => e.text)).toContain(
      "Seen before: 1 time in the last 30 days. Last time: Restarted the Sonarr container automatically. Hearth confirmed it is working again. Nothing is needed from you.",
    );
    expect(sonarr[1]!.timeline.some((e) => e.text.startsWith("Seen before"))).toBe(false);
  });
});

describe("notifications", () => {
  afterEach(() => fakeOutages.restoreAll());

  async function withEmail(scenario: "calm" | "attention" = "calm") {
    const app = await makeApp({ scenario });
    const res = await app.call("PUT", "/api/notifications/channels/email", { values: EMAIL });
    expect(res.statusCode, res.body).toBe(204);
    return app;
  }
  const settle = async (app: Awaited<ReturnType<typeof makeApp>>) => {
    await app.runner.idle();
    app.notifier.kick();
    await app.notifier.idle();
  };
  const titles = () => outbox.map((o) => `${o.channel}: ${o.message.title}`);

  it("keeps channel secrets in the vault and routes new channels to what matters", async () => {
    const { call, workspace, audit } = await withEmail();
    const ws = await workspace();
    const email = ws.channels.find((c) => c.id === "email")!;
    expect(email).toMatchObject({
      status: "configured",
      detail: "owner@example.com via smtp.example.com",
      supported: true,
    });
    expect(email.config).not.toHaveProperty("password");
    expect(JSON.stringify(ws)).not.toContain("smtp-password-123");
    const vault = (await call("GET", "/api/vault")).json<{
      secrets: { name: string; tier: string }[];
    }>();
    expect(vault.secrets).toEqual([
      expect.objectContaining({ name: "Email notifications", tier: "automation" }),
    ]);
    expect(ws.routes.filter((r) => r.channels.includes("email")).map((r) => r.id)).toEqual([
      "needs-you",
      "auto-repaired",
      "repair-failed",
      "critical",
      "long-work",
      "releases",
      "hearth-updates",
    ]);
    expect((await audit()).map((a) => a.action)).toContain("Set up Email notifications");
    expect(ws.channels.find((c) => c.id === "slack")?.supported).toBe(false);

    // Wrong settings are refused with a reason.
    const bad = await call("PUT", "/api/notifications/channels/discord", {
      values: { webhookUrl: "https://example.com/not-discord" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toBe("That does not look like a Discord webhook address.");
    expect(
      (await call("PUT", "/api/notifications/channels/slack", { values: {} })).statusCode,
    ).toBe(400);

    // Editing without retyping the password keeps it.
    expect(
      (
        await call("PUT", "/api/notifications/channels/email", {
          values: { ...EMAIL, password: "", to: "other@example.com" },
        })
      ).statusCode,
    ).toBe(204);
    expect((await call("GET", "/api/vault")).json().secrets).toHaveLength(1);

    // Stopping a channel removes its secret and its routes.
    expect((await call("DELETE", "/api/notifications/channels/email")).statusCode).toBe(204);
    const after = await workspace();
    expect(after.channels.find((c) => c.id === "email")?.status).toBe("available");
    expect(after.routes.every((r) => r.channels.length === 0)).toBe(true);
    expect((await call("GET", "/api/vault")).json().secrets).toEqual([]);
  });

  it("survives switching sample data", async () => {
    const { call, workspace } = await withEmail();
    await call("POST", "/api/demo/scenario", { scenario: "attention" });
    expect((await workspace()).channels.find((c) => c.id === "email")?.status).toBe("configured");
  });

  it("never sends history as news", async () => {
    const app = await withEmail("attention"); // two open sample incidents from before
    await settle(app);
    expect(outbox).toEqual([]);
  });

  it("tells you about an automatic repair once", async () => {
    const app = await withEmail();
    await app.call("POST", "/api/demo/simulate", { serviceId: "jellyfin", condition: "down" });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await settle(app);
    await settle(app);
    expect(titles()).toEqual(["email: [Sample data] Fixed: Jellyfin stopped responding"]);
    const msg = outbox[0]!.message;
    expect(msg.severity).toBe("info");
    expect(msg.lines.join(" ")).toMatch(/Nothing is needed from you/);
    expect(msg.lines.at(-1)).toBe("Hearth on Home (sample data, not your systems).");
    expect(msg.link).toMatch(/^http:\/\/localhost(:80)?\/incidents\/inc-[0-9a-f]+$/);
    expect((await app.workspace()).notifications[0]).toMatchObject({
      event: "auto-repaired",
      channelId: "email",
      status: "sent",
    });
  });

  it("asks for approval, then follows up once it is resolved", async () => {
    const app = await withEmail();
    await app.call("POST", "/api/demo/simulate", { serviceId: "caddy", condition: "down" });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await settle(app);
    expect(titles()).toEqual(["email: [Sample data] Needs you: Caddy stopped responding"]);
    expect(outbox[0]!.message.lines[1]).toBe(
      "Proposed repair: Restart the Caddy container, then check it is working again. Open Hearth to approve or decline it.",
    );
    const incident = (await app.workspace()).incidents.find(
      (i) => i.serviceId === "caddy" && i.status !== "resolved",
    )!;
    await approve(app.call, `/api/incidents/${incident.id}/decision`);
    await settle(app);
    expect(titles()).toEqual([
      "email: [Sample data] Needs you: Caddy stopped responding",
      "email: [Sample data] Resolved: Caddy stopped responding",
    ]);
  });

  it("says when a repair did not work", async () => {
    const app = await withEmail();
    await app.call("POST", "/api/demo/simulate", { serviceId: "jellyfin", condition: "stuck" });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await settle(app);
    expect(titles()).toEqual([
      "email: [Sample data] Repair did not work: Jellyfin stopped responding",
    ]);
    expect(outbox[0]!.message.severity).toBe("warning");
  });

  it("holds routine news overnight but lets critical matters through", async () => {
    testClock = () => new Date("2026-10-07T23:30:00");
    const app = await withEmail();
    // A volume at 98% opens a critical incident that also needs you.
    await app.handle.db
      .update(volumesTable)
      .set({ usedTb: sql`${volumesTable.totalTb} * 0.98` })
      .where(eq(volumesTable.id, "atl-movies"));
    await app.call("POST", "/api/monitor/run");
    await settle(app);
    expect(titles()).toEqual(["email: [Sample data] Critical: Movies volume is 98% full"]);
    expect((await app.workspace()).notifications.map((n) => [n.event, n.status])).toEqual([
      ["needs-you", "held"],
      ["critical", "sent"],
    ]);

    testClock = () => new Date("2026-10-08T07:05:00");
    await settle(app);
    expect(titles()).toEqual([
      "email: [Sample data] Critical: Movies volume is 98% full",
      "email: [Sample data] Needs you: Movies volume is 98% full",
    ]);
  });

  it("keeps sending through the channels that work, and retries the one that failed", async () => {
    const app = await withEmail();
    await app.call("PUT", "/api/notifications/channels/discord", {
      values: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    });
    failing = new Set(["discord"]);
    await app.call("POST", "/api/demo/simulate", { serviceId: "jellyfin", condition: "down" });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await settle(app);
    expect(titles()).toEqual(["email: [Sample data] Fixed: Jellyfin stopped responding"]);
    const failed = (await app.workspace()).notifications.find((n) => n.channelId === "discord")!;
    expect(failed).toMatchObject({ status: "failed", error: "discord is unreachable" });

    // Not hammered straight away; retried a couple of minutes later.
    failing = new Set();
    await settle(app);
    expect(outbox).toHaveLength(1);
    await app.handle.db.update(notificationLogTable).set({ at: "2000-01-01T00:00:00.000Z" });
    await settle(app);
    expect(titles()).toContain("discord: [Sample data] Fixed: Jellyfin stopped responding");
  });

  it("adds a second Discord destination for friends: starts with nothing, takes only media, can be switched off and deleted", async () => {
    const app = await withEmail();
    // Your existing Discord channel works as before (a built-in channel, signed up to what matters).
    expect(
      (
        await app.call("PUT", "/api/notifications/channels/discord", {
          values: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
        })
      ).statusCode,
    ).toBe(204);
    let ws = await app.workspace();
    expect(ws.routes.find((r) => r.id === "needs-you")?.channels).toContain("discord");
    expect(ws.channels.find((c) => c.id === "discord")).toMatchObject({
      kind: "discord",
      enabled: true,
      audience: "private",
      added: false,
    });

    // A second one, for friends and family.
    const made = await app.call("POST", "/api/notifications/destinations", {
      kind: "discord",
      name: "New in the Vault",
      audience: "public",
    });
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json<{ id: string }>().id;
    expect(id).toMatch(/^discord-/);
    expect(
      (
        await app.call("POST", "/api/notifications/destinations", {
          kind: "discord",
          name: "new in the vault",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("PUT", `/api/notifications/channels/${id}`, {
          values: { webhookUrl: "https://discord.com/api/webhooks/999/friends-secret" },
        })
      ).statusCode,
    ).toBe(204);
    ws = await app.workspace();
    expect(ws.channels.find((c) => c.id === id)).toMatchObject({
      name: "New in the Vault",
      status: "configured",
      kind: "discord",
      audience: "public",
      added: true,
    });
    // Signed up to nothing, and never to system or admin messages.
    expect(ws.routes.filter((r) => r.channels.includes(id))).toEqual([]);
    const refused = await app.call("PUT", "/api/notifications/routes/needs-you", {
      channels: ["discord", id],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ message: string }>().message).toMatch(/friends and family/);
    expect(JSON.stringify(ws)).not.toContain("friends-secret");

    // Media announcements are what it is for: that route is allowed, and it is listed for them.
    expect(
      (await app.call("PUT", "/api/notifications/routes/media-arrivals", { channels: [id] }))
        .statusCode,
    ).toBe(204);
    const announce = (await app.call("GET", "/api/media-announce")).json<{
      settings: { types: Record<string, boolean>; looks: Record<string, { template: string }> };
      destinations: { id: string; audience: string }[];
    }>();
    expect(announce.destinations).toEqual([{ id, name: "New in the Vault", audience: "public" }]);
    // Music, books, comics, games and podcasts start off.
    expect(announce.settings.types).toEqual({
      movie: true,
      series: true,
      season: true,
      episode: false,
      album: false,
      audiobook: false,
      book: false,
      comic: false,
      game: false,
      podcast: false,
    });
    const changed = {
      ...announce.settings,
      accent: "#3399ff",
      looks: {
        ...announce.settings.looks,
        movie: { template: "compact", heading: "Fresh in the Vault" },
      },
    };
    const saved = await app.call("PUT", "/api/media-announce", changed);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      accent: "#3399ff",
      looks: { movie: { template: "compact" } },
    });
    expect(
      (await app.call("PUT", "/api/media-announce", { ...changed, accent: "red" })).statusCode,
    ).toBe(400);
    await app.call("PUT", "/api/notifications/routes/media-arrivals", { channels: [] });

    // Its test message goes out through Discord.
    outbox.length = 0;
    expect((await app.call("POST", `/api/notifications/channels/${id}/test`, {})).json()).toEqual({
      ok: true,
    });
    expect(titles()).toEqual(["discord: Test from Hearth"]);

    // Switched off, it is kept but nothing is sent; then deleted for good.
    expect(
      (await app.call("PUT", `/api/notifications/channels/${id}/enabled`, { enabled: false }))
        .statusCode,
    ).toBe(204);
    expect((await app.workspace()).channels.find((c) => c.id === id)?.enabled).toBe(false);
    expect((await app.call("DELETE", `/api/notifications/channels/${id}`)).statusCode).toBe(204);
    ws = await app.workspace();
    expect(ws.channels.find((c) => c.id === id)).toBeUndefined();
    expect(ws.channels.find((c) => c.id === "discord")?.status).toBe("configured");
  });

  it("a destination whose webhook was deleted shows as broken until a delivery works again (11-13)", async () => {
    const app = await withEmail();
    await app.call("PUT", "/api/notifications/channels/discord", {
      values: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
    });
    const discord = async () => (await app.workspace()).channels.find((c) => c.id === "discord")!;
    const log = (status: "sent" | "held" | "failed", error?: string) =>
      app.handle.db.insert(notificationLogTable).values({
        event: "needs-you",
        channelId: "discord",
        title: "Radarr needs you",
        status,
        error: error ?? null,
        incidentId: null,
        at: new Date().toISOString(),
        sentAt: status === "sent" ? new Date().toISOString() : null,
      });

    await log("sent");
    expect((await discord()).broken).toBeUndefined();
    // A busy or slow server may pass on its own: not broken.
    await log("failed", "The server answered 503 Service Unavailable");
    expect((await discord()).broken).toBeUndefined();
    // Discord's answer for a webhook deleted in Discord.
    await log("failed", "The server answered 404 Not Found");
    expect((await discord()).broken?.reason).toBe(
      "This webhook was deleted in Discord, so nothing reaches it.",
    );
    // A held message (quiet hours) says nothing about it.
    await log("held");
    expect((await discord()).broken).toBeDefined();
    // Changed and working again: cleared.
    await log("sent");
    expect((await discord()).broken).toBeUndefined();
  });

  it("Change: switches a destination's way in place, tests before saving, switches back and undoes (11-13)", async () => {
    const app = await withEmail();
    expect(
      (
        await app.call("PUT", "/api/notifications/channels/discord", {
          values: { webhookUrl: "https://discord.com/api/webhooks/123/abc" },
        })
      ).statusCode,
    ).toBe(204);
    const discord = async () => (await app.workspace()).channels.find((c) => c.id === "discord")!;
    const routesOf = async () =>
      (await app.workspace()).routes.filter((r) => r.channels.includes("discord")).map((r) => r.id);
    telegramUpdates = [{ message: { chat: { id: 77, type: "private", first_name: "Alex" } } }];
    const draft = {
      name: "Alerts",
      kind: "telegram",
      values: { token: "123456789:AAH-telegram_secret_for_tests_abcdefgh" },
      audience: "private",
      quiet: "any",
      routes: ["needs-you"],
    };

    // Send test before saving: it goes out the new way, and nothing is saved.
    const tried = await app.call("POST", "/api/notifications/channels/discord/try", draft);
    expect(tried.json()).toEqual({ ok: true });
    expect(outbox.at(-1)?.channel).toBe("telegram");
    expect(await discord()).toMatchObject({ kind: "discord", name: "Discord" });

    // One save: name, way, token, quiet hours and messages together; the id (and history) stays.
    expect(
      (await app.call("PUT", "/api/notifications/channels/discord/change", draft)).statusCode,
    ).toBe(204);
    expect(await discord()).toMatchObject({
      name: "Alerts",
      kind: "telegram",
      status: "configured",
      added: false,
      config: expect.objectContaining({ quiet: "any", chat: "77" }),
    });
    expect(await routesOf()).toEqual(["needs-you"]);
    expect(JSON.stringify(await app.workspace())).not.toContain("telegram_secret_for_tests");
    const state = (await app.call("GET", "/api/notifications/change-state")).json<
      Record<string, { previous?: string; undo?: string }>
    >();
    expect(state.discord).toMatchObject({ previous: "discord" });
    expect(state.discord!.undo).toBeTruthy();
    // Shown in Changes and activity.
    const audit = (await app.call("GET", "/api/audit?limit=5")).json<{ action: string }[]>();
    expect(audit[0]!.action).toBe(
      "Changed Discord notifications: renamed to Alerts, now sent with Telegram",
    );

    // Switch back: the webhook kept in the vault works again; the name and messages stay.
    expect(
      (await app.call("POST", "/api/notifications/channels/discord/switch-back")).statusCode,
    ).toBe(204);
    expect(await discord()).toMatchObject({ name: "Alerts", kind: "discord" });
    expect((await app.call("POST", "/api/notifications/channels/discord/test")).json()).toEqual({
      ok: true,
    });
    expect(outbox.at(-1)?.channel).toBe("discord");
    expect(await routesOf()).toEqual(["needs-you"]);

    // Undo the switch back: Telegram again, with its token.
    expect((await app.call("POST", "/api/notifications/channels/discord/undo")).statusCode).toBe(
      204,
    );
    expect(await discord()).toMatchObject({ kind: "telegram" });
    expect((await app.call("POST", "/api/notifications/channels/discord/test")).json()).toEqual({
      ok: true,
    });
    expect(outbox.at(-1)?.channel).toBe("telegram");

    // Friends and family never take system messages.
    const bad = await app.call("PUT", "/api/notifications/channels/discord/change", {
      ...draft,
      values: {},
      audience: "public",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ message: string }>().message).toMatch(/media announcements only/);

    // One field in place, the token kept: just the name. Undo puts it back.
    expect(
      (
        await app.call("PUT", "/api/notifications/channels/discord/change", {
          ...draft,
          name: "Lab alerts",
          values: {},
        })
      ).statusCode,
    ).toBe(204);
    expect(await discord()).toMatchObject({ name: "Lab alerts", kind: "telegram" });
    await app.call("POST", "/api/notifications/channels/discord/undo");
    expect(await discord()).toMatchObject({ name: "Alerts", kind: "telegram" });

    // Forget the old way: Switch back is no longer offered.
    await app.call("DELETE", "/api/notifications/channels/discord/previous");
    const after = (await app.call("GET", "/api/notifications/change-state")).json<
      Record<string, { previous?: string }>
    >();
    expect(after.discord?.previous).toBeUndefined();
    expect(
      (await app.call("POST", "/api/notifications/channels/discord/switch-back")).statusCode,
    ).toBe(400);
  });

  it("sends a test message on request", async () => {
    const app = await withEmail();
    const ok = await app.call("POST", "/api/notifications/channels/email/test", {});
    expect(ok.json()).toEqual({ ok: true });
    expect(titles()).toEqual(["email: Test from Hearth"]);
    failing = new Set(["email"]);
    const bad = await app.call("POST", "/api/notifications/channels/email/test", {});
    expect(bad.json()).toEqual({ ok: false, error: "email is unreachable" });
    expect((await app.call("POST", "/api/notifications/channels/ntfy/test", {})).statusCode).toBe(
      400,
    );
  });

  it("reaches out once a day with something new, only when you chose a channel for it", async () => {
    testClock = () => new Date("2026-10-07T10:00:00");
    const app = await withEmail();
    // A new channel is not signed up for check-ins: reaching out is your choice.
    expect((await app.workspace()).routes.find((r) => r.id === "check-in")?.channels).toEqual([]);
    await setSetting(app.handle.db, "environment", "real");
    await app.call("POST", "/api/memory/entries", {
      kind: "win",
      title: "Every service moved to the new server",
      happenedAt: new Date().toISOString(),
    });
    await settle(app);
    expect(titles()).toEqual([]);

    await app.call("PUT", "/api/notifications/routes/check-in", { channels: ["email"] });
    await settle(app);
    expect(titles()).toEqual(["email: What's up on Home"]);
    expect(outbox[0]!.message.lines.join(" ")).toContain("Every service moved to the new server");
    // Once a day, and never the same words twice.
    await settle(app);
    testClock = () => new Date("2026-10-08T10:00:00");
    await settle(app);
    expect(outbox).toHaveLength(1);

    // Something new, the next day: but not at night.
    await app.call("POST", "/api/memory/entries", { kind: "journal", title: "Moved the photos" });
    testClock = () => new Date("2026-10-08T23:00:00");
    await settle(app);
    expect(outbox).toHaveLength(1);
    testClock = () => new Date("2026-10-09T09:15:00");
    await settle(app);
    expect(outbox).toHaveLength(2);
    expect(outbox[1]!.message.lines.join(" ")).toContain("Moved the photos");

    // Never about sample data.
    await setSetting(app.handle.db, "environment", "demo");
    await app.call("POST", "/api/memory/entries", { kind: "win", title: "Another win" });
    testClock = () => new Date("2026-10-10T10:00:00");
    await settle(app);
    expect(outbox).toHaveLength(2);
  });

  it("sends the weekly summary on Sunday morning, once", async () => {
    testClock = () => new Date("2026-10-11T09:30:00"); // a Sunday
    const app = await withEmail();
    await app.call("PUT", "/api/notifications/routes/weekly", { channels: ["email"] });
    await settle(app);
    await settle(app);
    expect(titles()).toEqual(["email: Your week on Home"]);
    // The sample week's history: three incidents, two fixed automatically.
    expect(outbox[0]!.message.lines[0]).toBe(
      "3 incidents this week. 2 fixed automatically, 0 recovered on their own, 0 still open.",
    );
  });

  it("Telegram: the token is checked, the chat is found, and alerts go there", async () => {
    const app = await makeApp({ scenario: "calm" });
    const token = "123456789:AAH-fake_token_for_tests_only_abcdefgh";
    const first = await app.call("PUT", "/api/notifications/channels/telegram", {
      values: { token },
    });
    expect(first.statusCode).toBe(400);
    expect(first.body).toContain("Nobody has written to @lab_alerts_bot yet");
    telegramUpdates = [{ message: { chat: { id: 77, type: "private", first_name: "Alex" } } }];
    const ok = await app.call("PUT", "/api/notifications/channels/telegram", { values: { token } });
    expect(ok.statusCode, ok.body).toBe(204);
    const ws = await app.workspace();
    expect(ws.channels.find((c) => c.id === "telegram")).toMatchObject({
      status: "configured",
      detail: "Alex · @lab_alerts_bot",
    });
    // The token went to the vault and is never shown.
    expect(JSON.stringify(ws)).not.toContain(token);
    expect(
      (await app.call("POST", "/api/notifications/channels/telegram/test")).statusCode,
    ).toBeLessThan(300);
    expect(outbox.map((o) => o.channel)).toContain("telegram");
  });

  it("browser push: turned on per device, only for real push services, and alerts go there", async () => {
    const app = await makeApp({ scenario: "calm" });
    const key = (await app.call("GET", "/api/notifications/push")).json<{
      publicKey: string;
      devices: unknown[];
    }>();
    expect(key.publicKey.length).toBeGreaterThan(40);
    expect(key.devices).toEqual([]);
    // The same key every time (made once, kept in the vault).
    expect(
      (await app.call("GET", "/api/notifications/push")).json<{ publicKey: string }>().publicKey,
    ).toBe(key.publicKey);
    const sub = (endpoint: string) => ({
      subscription: { endpoint, keys: { p256dh: "p".repeat(60), auth: "a".repeat(22) } },
      name: "Chrome on Android",
    });
    const bad = await app.call(
      "POST",
      "/api/notifications/push",
      sub("https://evil.example.com/x"),
    );
    expect(bad.statusCode).toBe(400);
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
    expect((await app.call("POST", "/api/notifications/push", sub(endpoint))).statusCode).toBe(204);
    let ws = await app.workspace();
    expect(ws.channels.find((c) => c.id === "push")).toMatchObject({
      status: "configured",
      detail: "On for 1 device",
    });
    // Set up for the first time: it hears about what matters, like any built-in channel.
    expect(ws.routes.find((r) => r.id === "needs-you")?.channels).toContain("push");
    expect(
      (
        await app.call("GET", `/api/notifications/push?endpoint=${encodeURIComponent(endpoint)}`)
      ).json<{
        thisDevice: boolean;
      }>().thisDevice,
    ).toBe(true);
    await app.call("POST", "/api/notifications/channels/push/test");
    expect(outbox.map((o) => o.channel)).toContain("push");
    expect(
      (await app.call("DELETE", `/api/notifications/push?endpoint=${encodeURIComponent(endpoint)}`))
        .statusCode,
    ).toBe(204);
    ws = await app.workspace();
    expect(ws.channels.find((c) => c.id === "push")?.status).toBe("available");
  });

  it("a summary goes once on its day from its time; a disk watch tells once until it clears", async () => {
    testClock = () => new Date("2026-10-07T12:00:00"); // a Wednesday
    const app = await withEmail();
    const later = await app.call("POST", "/api/briefs", {
      what: { kind: "summary", days: [3], time: "13:00" },
      channels: ["email"],
    });
    expect(later.statusCode, later.body).toBe(201);
    const made = (
      await app.call("POST", "/api/briefs", {
        name: "Morning summary",
        what: { kind: "summary", days: [1, 2, 3, 4, 5], time: "11:30" },
        channels: ["email"],
      })
    ).json<{ id: string; says: string; createdBy: string }>();
    expect(made.says).toBe("A server summary, weekdays at 11:30 AM.");
    expect(made.createdBy).toBe("owner");
    outbox.length = 0;
    await app.call("POST", "/api/briefs/check");
    await app.call("POST", "/api/briefs/check");
    // Only the one that is due, and only once.
    expect(titles()).toEqual(["email: Home: your summary"]);
    expect(outbox[0]!.message.lines[0]).toMatch(/services (are healthy|need a look)/);
    // A watch: any disk over 1% trips at once, and says so once.
    outbox.length = 0;
    const disk = (
      await app.call("POST", "/api/briefs", {
        what: { kind: "disk", percent: 1 },
        channels: ["email"],
      })
    ).json<{ says: string; name: string }>();
    expect(disk.says).toBe("Tell me when any disk goes over 1% full.");
    await app.call("POST", "/api/briefs/check");
    await app.call("POST", "/api/briefs/check");
    expect(outbox.filter((o) => o.message.title === disk.name)).toHaveLength(1);
    expect(outbox.at(-1)!.message.lines[0]).toMatch(/% full \(your level is 1%\)\.$/);
    // Wrong input says why; a brief can be switched off and removed.
    expect(
      (await app.call("POST", "/api/briefs", { what: { kind: "summary", days: [], time: "7am" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.call("PATCH", `/api/briefs/${made.id}`, { enabled: false })).json<{
        enabled: boolean;
      }>().enabled,
    ).toBe(false);
    expect((await app.call("DELETE", `/api/briefs/${made.id}`)).statusCode).toBe(204);
    const left = (await app.call("GET", "/api/briefs")).json<{ briefs: { id: string }[] }>();
    expect(left.briefs.map((b) => b.id)).not.toContain(made.id);
  });
});

describe("access keys", () => {
  it("open only the routes their permissions name, and never settings, security, or the vault", async () => {
    const { call, send, audit } = await makeApp({ scenario: "calm" });
    const created = await call("POST", "/api/keys", { name: "Home Assistant", scopes: ["read"] });
    expect(created.statusCode).toBe(200);
    const { key, summary } = created.json<{ key: string; summary: { prefix: string } }>();
    expect(key).toMatch(/^dc_/);
    expect(summary.prefix).toBe(key.slice(0, 7));
    expect((await call("GET", "/api/keys")).body).not.toContain(key);

    const withKey = (method: Method, url: string, payload?: unknown) =>
      app_inject(send, method, url, payload, key);
    expect((await withKey("GET", "/api/workspace")).statusCode).toBe(200);
    expect((await withKey("GET", "/api/status")).json()).toMatchObject({
      installation: "Home",
      sampleData: true,
      needsYou: 0,
    });
    for (const [method, url] of [
      ["POST", "/api/monitor/run"],
      ["POST", "/api/actions"],
      ["GET", "/api/vault"],
      ["GET", "/api/keys"],
      ["POST", "/api/keys"],
      ["PATCH", "/api/settings"],
      ["PUT", "/api/autonomy"],
      ["GET", "/api/audit"],
      ["POST", "/api/agent/conversations"],
      ["POST", "/api/mcp"],
    ] as [Method, string][]) {
      expect((await withKey(method, url, {})).statusCode, `${method} ${url}`).toBe(403);
    }
    expect(
      (await app_inject(send, "GET", "/api/workspace", undefined, "dc_not-a-real-key-at-all-123"))
        .statusCode,
    ).toBe(401);

    const id = (await call("GET", "/api/keys")).json<{ id: string }[]>()[0]!.id;
    expect((await call("DELETE", `/api/keys/${id}`)).statusCode).toBe(204);
    expect((await withKey("GET", "/api/workspace")).statusCode).toBe(401);
    expect((await audit()).length).toBeGreaterThanOrEqual(0);
    const all = (await call("GET", "/api/audit?limit=10"))
      .json<AuditRecord[]>()
      .map((a) => a.action);
    expect(all).toContain("Created an access key: Home Assistant");
    expect(all).toContain("Revoked the access key: Home Assistant");
  });

  it("let an act key restart a service, as if you pressed the button", async () => {
    const env = await realEnvironment();
    const { key } = (
      await env.call("POST", "/api/keys", { name: "Script", scopes: ["act"] })
    ).json<{ key: string }>();
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    const res = await app_inject(
      env.send,
      "POST",
      "/api/actions",
      { kind: "restart-container", serviceId: sonarr.id },
      key,
    );
    expect(res.statusCode).toBe(200);
    await env.runner.idle();
    expect(fakeOutages.restarts()).toEqual(["sonarr"]);
    fakeOutages.restoreAll();
  });
});

/** Sends a request with an access key instead of the session cookie. */
function app_inject(
  send: (
    method: Method,
    url: string,
    payload?: unknown,
    cookie?: string,
  ) => Promise<{ statusCode: number; json: <T = unknown>() => T; body: string }>,
  method: Method,
  url: string,
  payload: unknown,
  key: string,
) {
  return (
    send as unknown as (
      m: Method,
      u: string,
      p?: unknown,
      c?: string,
      h?: Record<string, string>,
    ) => ReturnType<typeof send>
  )(method, url, payload, undefined, { authorization: `Bearer ${key}` });
}

describe("the AI operator", () => {
  afterEach(() => fakeOutages.restoreAll());

  async function connected(
    opts: { scenario?: "calm"; stagedFetch?: typeof fetch } = { scenario: "calm" },
  ) {
    const app = await makeApp({
      scenario: opts.scenario,
      listen: true,
      ...(opts.stagedFetch ? { stagedFetch: opts.stagedFetch } : {}),
    });
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    return app;
  }
  const failSample = async (
    app: Awaited<ReturnType<typeof makeApp>>,
    serviceId: string,
    condition: "down" | "stuck",
  ) => {
    await app.call("POST", "/api/demo/simulate", { serviceId, condition });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await app.runner.idle();
    await app.agents.idle();
    await app.runner.idle();
  };

  it("is only reachable with a live session key, and offers only Hearth's tools", async () => {
    const app = await connected();
    // Every tool: this Hearth has every Premium extra (Free Ember is tested on its own).
    await givePremium(app.handle, {
      features: ["hearth_interconnectivity", "ember_show_and_tell", "panel_builder"],
    });
    expect((await app.send("POST", "/api/mcp", {})).statusCode).toBe(401);
    let tools: string[] = [];
    agentScript = async ({ list }) => {
      tools = await list();
      return "ok";
    };
    await app.call("POST", "/api/agent/conversations", { text: "What can you do?" });
    expect(tools.sort()).toEqual(
      [
        "backup_status",
        "browser",
        "hearth_help",
        "open_panel",
        "get_incident",
        "get_overview",
        "get_service",
        "container_config",
        "resource_history",
        "home_assistant",
        "qbittorrent",
        "plex",
        "radarr",
        "sonarr",
        "arr",
        "list_incidents",
        "list_services",
        "app_health",
        "propose_job",
        "read_logs",
        "recall",
        "recent_changes",
        "report",
        "restart_service",
        "run_check",
        "storage_raid",
        "files_browse",
        "storage_overview",
        "test_endpoint",
        "unreviewed_notes",
        "suggest_preference",
        "list_findings",
        "get_finding",
        "record_finding",
        "update_finding",
        "note_finding",
        "save_todo",
        "update_todo",
        "todo_list",
        "todo_item",
        "workspace_create",
        "workspace_update",
        "workspace_read",
        "propose_workspace_plan",
        "view_attachment",
        "host_scope",
        "host_list",
        "host_stat",
        "host_read",
        "host_search",
        "host_disk_usage",
        "host_diagnose",
        "host_conventions",
        "service_files",
        "recyclarr_status",
        "release_watches",
        "movie_requests",
        "config_check",
        "compose_inspect",
        "compose_projects",
        "app_api",
        "app_signin",
        "hearth_api",
        "vpn_servers",
        "record_missing_capability",
        "list_capabilities",
        "vault_status",
        "draft_report",
        "confirm_memory",
        "long_work",
        // The Premium package adds Show & Tell's and Panel Builder's tools when it is installed.
        ...(PREMIUM_PACKAGE ? ["show", "tidy_screen", "panel_builder"] : []),
      ].sort(),
    );
    // The session key stops working the moment the session ends.
    const keys = await app.handle.db.select().from(apiTokensTable);
    expect(keys.every((k) => k.kind !== "agent" || k.revokedAt)).toBe(true);
  });

  it("runs Claude Code with every built-in tool switched off", () => {
    const args = claudeCodeArgs("C:/tmp/system.md", "C:/tmp/mcp.json");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    // The prompt goes through standard input and the instructions through a file: neither is
    // command-line text, so a long conversation never passes Windows' command-line limit.
    expect(args[args.indexOf("-p") + 1]).toBe("--output-format");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("C:/tmp/system.md");
    expect(args).not.toContain("--system-prompt");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__dragon-control");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--bare"); // it would also skip the login
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("with Full access on, runs the whole Claude Code: every tool, the owner's add-ons, Hearth's tools", () => {
    const args = claudeCodeArgs("C:/tmp/system.md", "C:/tmp/mcp.json", {}, true);
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--setting-sources");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    // Its own prompt stays; Hearth's instructions are added on top.
    expect(args).not.toContain("--system-prompt-file");
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("C:/tmp/system.md");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("C:/tmp/mcp.json");
    expect(
      CAVE_SYSTEM({
        instance: "Home",
        sample: false,
        voice: false,
        jurisdiction: "",
        intent: "question",
        full: true,
      }),
    ).toContain("You are a full coding agent (Claude Code, Codex, or Ollama through Claude Code)");
    // What it asks first follows the owner's choice.
    expect(
      CAVE_SYSTEM({
        instance: "Home",
        sample: false,
        voice: false,
        jurisdiction: "",
        intent: "question",
        full: true,
        ask: "strict",
      }),
    ).toContain("before every change");
    expect(
      CAVE_SYSTEM({
        instance: "Home",
        sample: false,
        voice: false,
        jurisdiction: "",
        intent: "question",
      }),
    ).toContain("you have the same tools as the War Room with Full access off");
  });

  it("the Lair knows homelabs: know-how, the live snapshot, and the owner's own rules (no new limits)", () => {
    const base = {
      instance: "Home",
      sample: false,
      voice: false,
      jurisdiction: "",
      intent: "question" as const,
    };
    const plain = CAVE_SYSTEM(base);
    expect(plain).toContain("<homelab-knowhow>");
    expect(plain).toContain("## Common jobs");
    expect(plain).not.toContain("## House rules");
    expect(plain).not.toContain("<homelab-snapshot>");
    expect(plain).not.toContain("<owner-rules>");
    const full = CAVE_SYSTEM({
      ...base,
      snapshot: "# Homelab snapshot\n\n## This machine: media-box",
      ownerRules: "- Ask before restarting Plex during movie night.",
    });
    expect(full).toContain("<homelab-snapshot>\n# Homelab snapshot");
    expect(full).toContain("<owner-rules>\n- Ask before restarting Plex during movie night.");
  });

  it("hearth_api: Ember uses Hearth itself (makes a project when asked), never sign-in, the vault or approvals", async () => {
    const app = await connected();
    const out: Record<string, string> = {};
    agentScript = async ({ call }) => {
      out.create = await call("hearth_api", {
        method: "POST",
        path: "/api/projects",
        body: JSON.stringify({ name: "Move the NAS", summary: "New drives, then the copy" }),
      });
      out.list = await call("hearth_api", { method: "GET", path: "/api/projects" });
      out.vault = await call("hearth_api", { method: "GET", path: "/api/vault" });
      out.auth = await call("hearth_api", { method: "POST", path: "/api/auth/logout", body: "{}" });
      out.settings = await call("hearth_api", {
        method: "PATCH",
        path: "/api/settings",
        body: JSON.stringify({ aiName: "Pip" }),
      });
      out.sneak = await call("hearth_api", { method: "POST", path: "/api/projects/../vault/x" });
      out.bad = await call("hearth_api", { method: "POST", path: "/api/projects", body: "{" });
      return "Done.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "make a project for the NAS move" });
    expect(out.create).toMatch(/"status":\s*200/);
    const made = (await app.call("GET", "/api/projects")).json<ProjectSummary[]>();
    expect(made.map((p) => p.name)).toContain("Move the NAS");
    expect(out.list).toContain("Move the NAS");
    for (const refused of [out.vault, out.auth, out.settings, out.sneak])
      expect(refused).toMatch(/"status":\s*403/);
    expect(out.vault).toMatch(/never reads or changes them/);
    expect(out.settings).toMatch(/only through a plan the owner approves/);
    expect(out.bad).toMatch(/not valid JSON/);
    // Ember's changes are recorded as Ember's.
    expect((await app.audit()).map((a) => a.action)).toContain(
      "Ember used Hearth: POST /api/projects",
    );
    // From outside, the header does nothing but refuse: its secret never leaves the process.
    const forged = await app.app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { "x-hearth-ember": "guess" },
    });
    expect(forged.statusCode).toBe(403);
  });

  it("hearth-api-call: Ember changes Hearth's settings only through a plan you approve, never its own permissions", async () => {
    const { call, jobs } = await makeApp({ scenario: "calm" });
    const plan = (path: string, body: unknown, method = "PATCH") => ({
      title: "Change Hearth",
      reason: "The owner asked",
      steps: [
        {
          kind: "hearth-api-call",
          serviceId: "hearth",
          params: { method, path, body: JSON.stringify(body), why: "Rename the AI to Pip" },
        },
      ],
    });
    const created = await call("POST", "/api/jobs", plan("/api/settings", { aiName: "Pip" }));
    expect(created.statusCode, created.body).toBe(200);
    const job = created.json<Job>();
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(job.steps[0]).toMatchObject({ label: "Change Hearth: Rename the AI to Pip" });
    expect(JSON.stringify(job.steps[0])).toContain('"after":"Pip"');
    // Nothing changes before approval.
    expect((await call("GET", "/api/workspace")).json<Workspace>().aiName).toBeUndefined();
    const approved = await call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await jobs.idle();
    const done = (await call("GET", `/api/jobs/${job.id}`)).json<Job>();
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/aiName is now Pip/);
    expect((await call("GET", "/api/workspace")).json<Workspace>().aiName).toBe("Pip");

    // Never, even with approval: its own permissions, the vault, approvals, updates.
    for (const [path, body] of [
      ["/api/settings", { liveRepairs: true }],
      ["/api/vault/secrets", { name: "x" }],
      ["/api/agent/full-access", { on: true }],
      ["/api/jobs/x/decision", { decision: "approve" }],
      ["/api/updates/install", {}],
      ["/api/autonomy", { default: "auto" }],
    ] as const) {
      const r = (await call("POST", "/api/jobs", plan(path, body, "POST"))).json<Job>();
      expect(r.status, path).toBe("refused");
    }
  });

  it("app_api: any app's own API; changes are plans, or done directly under Full access", async () => {
    const app = await connected();
    const sonarr = (await app.workspace()).services.find((s) => s.name === "Sonarr")!;
    const out: Record<string, string> = {};
    agentScript = async ({ call }) => {
      out.read = await call("app_api", { serviceId: sonarr.id, path: "/api/v3/queue" });
      out.change = await call("app_api", {
        serviceId: sonarr.id,
        method: "DELETE",
        path: "/api/v3/queue/7",
      });
      out.plan = await call("propose_job", {
        title: "Remove a stuck item",
        reason: "It is stuck",
        steps: [
          {
            kind: "app-api-call",
            serviceId: sonarr.id,
            params: { method: "DELETE", path: "/api/v3/queue/7", why: "Remove item 7" },
          },
        ],
      });
      return "Done.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "fix the stuck sonarr item" });
    // Sample data has no real app behind it: said plainly, nothing sent.
    expect(out.read).toMatch(/Sample data/);
    // Full access off: a change is a plan the owner approves.
    expect(out.change).toMatch(/Full access is off.*app-api-call/s);
    expect(out.change).toContain("This action requires Full access. If that's what you want");
    // The plan step is known (here, with no apps wired, it is refused before anything is sent).
    expect(out.plan).toMatch(/A request to .* own API/);
    expect(agentRuns.at(-1)!.system).toContain("app_api sends any request");

    // Full access on: no step limit or per-answer cap, and the change is tried directly.
    (app.agents as unknown as { deps: { fullAccess: () => { on: boolean } } }).deps.fullAccess =
      () => ({ on: true });
    await app.call("POST", "/api/agent/conversations", { text: "fix the stuck sonarr item" });
    expect(out.change).not.toMatch(/Full access is off/);
    expect(out.change).toMatch(/Sample data/);
    expect(agentRuns.at(-1)!.limits?.maxTurns).toBeUndefined();
    expect(agentRuns.at(-1)!.limits?.maxUsd).toBeUndefined();
    expect(agentRuns.at(-1)!.limits?.model).toBe("default");
    expect(out.change).not.toContain("This action requires Full access");

    // The War Room gets a session with the same tools and the same Full access rule.
    const session = await app.agents.toolSession("claude-code");
    const contexts = (app.agents as unknown as { contexts: Map<string, { full?: boolean }> })
      .contexts;
    expect([...contexts.values()].some((c) => c.full === true)).toBe(true);
    await session.release();
    expect(contexts.size).toBe(0);
  });

  // panel_builder (Ember's Panel Builder tool) is tested in the Premium repo, with the add-on.

  it("takes over an incident a known fix could not resolve, and Hearth verifies the fix", async () => {
    const app = await connected();
    agentScript = async ({ call, prompt }) => {
      expect(prompt).toContain("Jellyfin stopped responding");
      await call("get_incident", { incidentId: /Incident (inc-[0-9a-f]+)/.exec(prompt)![1] });
      await call("read_logs", { serviceId: "jellyfin" });
      // Whatever it was, a second restart now clears it.
      simulate("jellyfin", "down");
      const restart = await call("restart_service", {
        serviceId: "jellyfin",
        reason: "The logs show the request handler hung; a fresh start should clear it.",
      });
      expect(restart).toMatch(/^Restart worked/);
      await call("report", {
        summary: "Jellyfin's request handler had hung. I restarted it and it answers again.",
        outcome: "resolved",
      });
      return "Done.";
    };
    await failSample(app, "jellyfin", "stuck");
    const incident = (await app.workspace()).incidents.find(
      (i) => i.serviceId === "jellyfin" && i.openedAt > "2001",
    )!;
    expect(incident).toMatchObject({ status: "resolved", handledBy: "agent" });
    const texts = incident.timeline.map((e) => e.text);
    expect(texts).toContain("Asked Claude Code to take a look.");
    expect(texts).toContain("Read Jellyfin's recent logs.");
    expect(texts.some((t) => t.startsWith("Asked to restart Jellyfin: The logs show"))).toBe(true);
    expect(texts).toContain(
      "Claude Code: Jellyfin's request handler had hung. I restarted it and it answers again.",
    );
    expect(texts.some((t) => t.startsWith("Health check passed: Jellyfin"))).toBe(true);
    expect(incident.resolution).toMatch(/Hearth confirmed Jellyfin is working again/);
    const session = (await app.workspace()).agentSessions.find(
      (s) => s.incidentId === incident.id,
    )!;
    expect(session).toMatchObject({ outcome: "resolved", provider: "claude-code" });
    const audit = (await app.call("GET", "/api/audit?limit=30")).json<AuditRecord[]>();
    expect(
      audit.find((a) => a.action === "Restarted the Jellyfin container" && a.actor === "agent"),
    ).toBeTruthy();
  });

  it("does not take the agent's word for it", async () => {
    const app = await connected();
    agentScript = async ({ call }) => {
      await call("report", { summary: "All fixed, trust me.", outcome: "resolved" });
      return "Fixed!";
    };
    await failSample(app, "jellyfin", "stuck");
    const incident = (await app.workspace()).incidents.find(
      (i) => i.serviceId === "jellyfin" && i.openedAt > "2001",
    )!;
    expect(incident.status).toBe("open");
    expect(incident.timeline.at(-1)).toMatchObject({
      kind: "escalated",
      text: "Jellyfin still stopped responding (simulated). Waiting for you.",
    });
    expect(
      (await app.workspace()).agentSessions.find((s) => s.incidentId === incident.id)?.outcome,
    ).toBe("escalated");
  });

  it("turns a restart asked for in a conversation into a plan the owner can approve", async () => {
    // 10-29: Ember's restart waited "for your approval" with no Approve button anywhere,
    // because a request outside an incident has nothing to approve it from.
    const app = await connected();
    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("restart_service", {
        serviceId: "caddy",
        reason: "The owner asked for a restart.",
      });
      return "It's waiting for your approval on Home.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "Please restart Caddy for me." });
    await app.agents.idle();
    expect(answer).toContain('"status": "awaiting-approval"');
    expect(answer).toContain("it has an Approve button on Home");
    const jobs = (await app.call("GET", "/api/jobs")).json<Job[]>();
    expect(jobs).toEqual([
      expect.objectContaining({ title: "Restart Caddy", status: "awaiting-approval" }),
    ]);
    const dangling = await app.handle.db
      .select()
      .from(actionsTable)
      .where(eq(actionsTable.status, "requested"));
    expect(dangling).toEqual([]);
  });

  it("is held to the same autonomy rules: under Ask it can only propose", async () => {
    const app = await connected();
    // Caddy is Ask before fixing; decline the runbook's proposal so it reaches the agent.
    await app.call("POST", "/api/demo/simulate", { serviceId: "caddy", condition: "down" });
    await app.call("POST", "/api/monitor/run");
    await app.call("POST", "/api/monitor/run");
    await app.runner.idle();
    const incident = (await app.workspace()).incidents.find(
      (i) => i.serviceId === "caddy" && i.status !== "resolved",
    )!;
    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("restart_service", {
        serviceId: "caddy",
        reason: "It stopped responding.",
      });
      await call("report", {
        summary: "Caddy needs a restart; I asked for your approval.",
        outcome: "proposed",
      });
      return "Proposed.";
    };
    await app.call("POST", `/api/incidents/${incident.id}/decision`, { decision: "decline" });
    // Declining leaves it open; make it escalated so the operator is asked.
    await app.handle.db.insert(timelineTable).values({
      incidentId: incident.id,
      at: new Date().toISOString(),
      kind: "escalated",
      text: "Waiting for you.",
    });
    app.agents.kick();
    await app.agents.idle();
    expect(answer).toBe(
      "Waiting for the owner's approval: Reverse proxy is set to Ask before fixing.",
    );
    const after = (await app.workspace()).incidents.find((i) => i.id === incident.id)!;
    expect(after.status).toBe("awaiting-approval");
    expect(fakeOutages.restarts()).toEqual([]);
  });

  it("is not called where autonomy is Monitor, and only once per incident", async () => {
    const app = await connected();
    let runs = 0;
    agentScript = async () => {
      runs++;
      return "Looked.";
    };
    await app.call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "media", level: "monitor" }],
    });
    await failSample(app, "plex", "down");
    expect(runs).toBe(0);
    // Plex recovers, so loosening autonomy below does not make its old incident eligible.
    await app.call("POST", "/api/demo/simulate", { serviceId: "plex", condition: "normal" });
    await app.call("POST", "/api/monitor/run");
    await app.call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "media", level: "auto" }],
    });
    await failSample(app, "jellyfin", "stuck");
    app.agents.kick();
    await app.agents.idle();
    expect(runs).toBe(1);
  });

  it("answers questions about Hearth itself with hearth_help: built, set up here, and what it can do", async () => {
    const app = await connected();
    // What hearth_help returns, as far as this test reads it.
    type Help = {
      feature: { id: string };
      where: { path: string };
      onScreen: string[];
      manual: string;
      implemented: { status: string };
      thisInstallation: { state: string; missing?: string[] };
      whatYouCanDo: { carryOut: unknown; openItForThem: string };
      found?: boolean;
      say?: string;
    };
    let nights = {} as Help;
    let unknown = {} as Help;
    let listed: string[] = [];
    let upFront: string[] = [];
    let prompt = "";
    let raid = {} as Help;
    agentScript = async ({ call, list, alwaysLoaded, prompt: p }) => {
      listed = await list();
      upFront = await alwaysLoaded();
      prompt = p;
      raid = JSON.parse(await call("hearth_help", { feature: "raid" }));
      nights = JSON.parse(
        await call("hearth_help", { question: "How do I invite friends to a movie night?" }),
      );
      unknown = JSON.parse(await call("hearth_help", { question: "Can Hearth mow my lawn?" }));
      return "The Lair: Movie nights.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "How do I invite friends to a movie night?",
    });
    expect(listed).toContain("hearth_help");
    // The feature, its real place and names, and the manual's own words.
    expect(nights.feature.id).toBe("movie-nights");
    expect(nights.where.path).toMatch(/^The Lair: Movie nights/);
    expect(nights.onScreen).toContain("Post the invitation");
    expect(nights.manual).toMatch(/^### Movie nights/);
    // Built is one thing; set up on this installation is another (no destination yet).
    expect(nights.implemented.status).toBe("working");
    expect(nights.thisInstallation.state).toBe("needs-setup");
    expect(nights.thisInstallation.missing).toContain(
      'a Discord bot destination, or any destination ticked for "New in your library" under Media announcements',
    );
    // A route Ember can use, through an approved plan (never "the owner does it" by default).
    expect(nights.whatYouCanDo.carryOut).toMatchObject({
      tools: expect.arrayContaining(["propose_job"]),
    });
    // It can offer to open it: a button the owner clicks, never navigation by itself (42.2).
    expect(nights.whatYouCanDo.openItForThem).toContain("[Open Movie nights](hearth:movie-nights)");
    expect(raid.whatYouCanDo.openItForThem).toContain("(hearth:raid)");
    // hearth_help and a few basics load for every model, not behind tool search (Ollama, 10-29).
    expect(upFront).toEqual(expect.arrayContaining(["hearth_help", "get_overview"]));
    expect(upFront.length).toBeLessThan(12);
    // The owner's question about Hearth points the AI at the feature, whatever the model.
    expect(prompt).toContain('call hearth_help with feature "movie-nights"');
    // Nothing matched: uncertainty, never "Hearth can't".
    expect(unknown.found).toBe(false);
    expect(unknown.say).toContain("does NOT mean Hearth lacks it");
  });

  it("shows the default announcement picture when none is set, without a failed request", async () => {
    const app = await connected();
    const res = await app.call("GET", "/api/media-announce/sender-picture");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/icon-192.png");
  });

  it("serves a page's How this works from the same feature list, signed in only", async () => {
    const app = await connected();
    const res = app.call("GET", "/api/help?features=movie-nights,not-a-feature,raid");
    const body = (await res).json<{
      features: { feature: { id: string }; manual: string; thisInstallation: { state: string } }[];
    }>();
    // Unknown ids are left out; known ones come with the manual and this installation's state.
    expect(body.features.map((f) => f.feature.id)).toEqual(["movie-nights", "raid"]);
    expect(body.features[0]!.manual).toMatch(/^### Movie nights/);
    expect(body.features[0]!.thisInstallation.state).toBe("needs-setup");
  });

  it("holds a conversation, typed in the app", async () => {
    const app = await connected();
    agentScript = async ({ call }) => {
      const overview = JSON.parse(await call("get_overview"));
      expect(overview.sampleData).toBe(true);
      return "Plex is up and answering. This is sample data, not your real server.";
    };
    const first = (
      await app.call("POST", "/api/agent/conversations", { text: "Plex is down, take a look?" })
    ).json<{ conversationId: string; status: string; reply: string }>();
    expect(first).toMatchObject({
      status: "answered",
      reply: "Plex is up and answering. This is sample data, not your real server.",
    });
    agentScript = async () => "Nothing changed since: still fine.";
    await app.call("POST", "/api/agent/conversations", {
      text: "And now?",
      conversationId: first.conversationId,
    });
    expect(agentPrompts[1]).toContain("Owner: Plex is down, take a look?");
    expect(agentPrompts[1]).toContain("Owner, now: And now?");
    const convo = (await app.call("GET", `/api/agent/conversations/${first.conversationId}`)).json<{
      messages: { role: string }[];
    }>();
    expect(convo.messages.map((m) => m.role)).toEqual(["you", "agent", "you", "agent"]);
  });

  it("shows live progress: only steps that really happened, written as they happen", async () => {
    const app = await connected();
    await app.call("PUT", "/api/autonomy", {
      default: "ask",
      rules: [{ id: "media", level: "ask" }],
    });
    type Convo = { id: string; messages: CaveMessage[] };
    const latest = async () => {
      const list = (await app.call("GET", "/api/agent/conversations")).json<{ id: string }[]>();
      return (await app.call("GET", `/api/agent/conversations/${list[0]!.id}`)).json<Convo>();
    };
    let midway: CaveMessage["activity"];
    agentScript = async ({ call }) => {
      await call("get_overview");
      await call("run_check", { serviceId: "jellyfin" });
      // Seen from the app while the AI is still working: what happened so far, nothing ahead.
      midway = (await latest()).messages[0]!.activity;
      await call("propose_job", {
        title: "Refresh Jellyfin",
        reason: "Playback stalls",
        steps: [{ kind: "restart-container", serviceId: "jellyfin" }],
      });
      return "Jellyfin answers. I planned a restart for you to approve.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "Jellyfin stalls, look?" });
    expect(midway!.map((a) => [a.label, a.status])).toEqual([
      ["Gathered what Hearth knows", "done"],
      ["Asking the AI to look into it", "running"],
      ["Looked over every system", "done"],
      ["Ran Jellyfin's health check", "done"],
    ]);
    expect(midway![3]).toMatchObject({ ref: "service:jellyfin", detail: expect.any(String) });

    const convo = await latest();
    const activity = convo.messages[0]!.activity!;
    expect(activity.map((a) => [a.kind, a.label, a.status])).toEqual([
      ["gather", "Gathered what Hearth knows", "done"],
      ["ai", "The AI finished looking into it", "done"],
      ["tool", "Looked over every system", "done"],
      ["tool", "Ran Jellyfin's health check", "done"],
      ["job", "Refresh Jellyfin", "waiting"],
    ]);
    const job = (await app.call("GET", "/api/jobs")).json<Job[]>()[0]!;
    expect(activity[4]!.ref).toBe(`job:${job.id}`);
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");
    expect(activity.every((a) => a.status !== "running")).toBe(true);
    expect(convo.messages[1]!.activity).toBeUndefined();
  });

  it("uses the owner's unreviewed notes as labelled leads, and the systems a question is about", async () => {
    const app = await connected();
    const now = new Date().toISOString();
    await app.handle.db.insert(draftsTable).values([
      {
        id: "d-vpn",
        sourceRef: "md:test-vpn",
        batch: "b1",
        origin: "Notes/Gluetun.md",
        anchor: "VPN server swap",
        kind: "entry",
        payload: {
          kind: "entry",
          entry: {
            kind: "note",
            title: "Gluetun VPN tunnels",
            body: "The PublicTracker indexer was blocked by Cloudflare (403) because the VPN exit IP was banned. Fixed by switching to another VPN server.",
          },
        },
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "d-other",
        sourceRef: "md:test-other",
        batch: "b1",
        origin: "Notes/Plex.md",
        anchor: "x",
        kind: "entry",
        payload: {
          kind: "entry",
          entry: { kind: "note", title: "Plex", body: "Transcoding notes." },
        },
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    agentScript = async ({ call }) => {
      const found = await call("unreviewed_notes", { query: "PublicTracker cloudflare" });
      expect(found).toContain('"unreviewed": true');
      expect(found).toContain("Gluetun VPN tunnels");
      return "Your unreviewed notes say this happened before.";
    };
    const r = (
      await app.call("POST", "/api/agent/conversations", {
        text: "I'm getting notifications about the PublicTracker indexer being down",
      })
    ).json<{ conversationId: string }>();
    const prompt = agentPrompts.at(-1)!;
    // Prowlarr is pulled in by the question's subject (indexer) without being named.
    expect(prompt).toMatch(/Prowlarr/);
    expect(prompt).toContain("UNREVIEWED note from Notes/Gluetun.md");
    expect(prompt).toContain("not approved by the owner");
    expect(prompt).not.toContain("Transcoding notes");
    const convo = (await app.call("GET", `/api/agent/conversations/${r.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(convo.messages[1]!.evidence!.some((e) => e.kind === "unreviewed")).toBe(true);
    // Reading notes never approves them.
    const rows = await app.handle.db.select().from(draftsTable);
    expect(rows.every((d) => d.status === "pending")).toBe(true);
  });

  it("writes an investigation up as a draft for review: verified records apart from the AI's account", async () => {
    const app = await connected();
    agentScript = async ({ call }) => {
      await call("run_check", { serviceId: "jellyfin" });
      return call("draft_report", {
        title: "Jellyfin check",
        problem: "Playback stalled.",
        rootCause: "Probably a slow disk; not confirmed.",
        rootCauseBasis: "inference",
        lessons: ["Check the disk first next time."],
      });
    };
    const r = (
      await app.call("POST", "/api/agent/conversations", {
        text: "Jellyfin stalls, look and write it up",
      })
    ).json<{ reply: string }>();
    expect(r.reply).toMatch(/Memory > Review/);
    const drafts = await app.handle.db.select().from(draftsTable);
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.status).toBe("pending");
    expect(d.origin).toBe("Ember report");
    const body = (d.payload as { entry: { body: string } }).entry.body;
    expect(body).toContain("## Root cause (inference by the AI, not confirmed)");
    expect(body).toContain("## What Hearth recorded (verified)");
    expect(body).toMatch(/Ran Jellyfin's health check/);
    expect(body).toContain("No change was made through Hearth.");
    expect(body).toContain("## Lessons (the AI's suggestions)");
    // Nothing went into memory itself.
    expect((await app.call("GET", "/api/memory/entries")).json<unknown[]>()).toEqual([]);
  });

  it("without an AI, says the answer came from records", async () => {
    const app = await makeApp({ scenario: "calm" });
    const r = (
      await app.call("POST", "/api/agent/conversations", { text: "How are my servers?" })
    ).json<{ conversationId: string }>();
    const convo = (await app.call("GET", `/api/agent/conversations/${r.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(convo.messages[0]!.activity!.map((a) => [a.kind, a.status])).toEqual([
      ["gather", "done"],
      ["records", "done"],
    ]);
  });

  it("personality: casual talk and brainstorming never plan or change anything, and the rules stay put", async () => {
    const app = await connected();
    // Settings shape how it talks; the rules in the system prompt are identical either way.
    expect((await app.call("GET", "/api/agent/personality")).json()).toEqual({
      enthusiasm: "warm",
      humor: "light",
      detail: "balanced",
    });
    const rulesOf = (system: string) => system.slice(system.indexOf("Rules ("));
    agentScript = async () => "Hey! All quiet here.";
    await app.call("POST", "/api/agent/conversations", { text: "hey there" });
    const before = agentRuns.at(-1)!;
    expect(before.system).toContain("This message: This message is casual conversation");
    expect(before.limits?.maxTurns).toBeUndefined();
    const put = await app.call("PUT", "/api/agent/personality", {
      enthusiasm: "calm",
      humor: "none",
      detail: "deep",
    });
    expect(put.statusCode).toBe(200);
    expect(
      (await app.call("PUT", "/api/agent/personality", { enthusiasm: "unhinged" })).statusCode,
    ).toBe(400);

    // Brainstorming: the AI tries to plan anyway, and the server refuses.
    let refused = "";
    agentScript = async ({ call }) => {
      refused = await call("propose_job", {
        title: "Stop Jellyfin at night",
        reason: "Sounds fun",
        steps: [{ kind: "stop-container", serviceId: "jellyfin" }],
      });
      const restart = await call("restart_service", { serviceId: "jellyfin", reason: "why not" });
      expect(restart).toMatch(/^Not now/);
      return "Fun idea, want me to plan it?";
    };
    const idea = (
      await app.call("POST", "/api/agent/conversations", {
        text: "What if Jellyfin restarted itself every night? That would be cool",
      })
    ).json<{ conversationId: string }>();
    expect(refused).toMatch(/exploring an idea/);
    const after = agentRuns.at(-1)!;
    expect(after.system).toContain("No jokes.");
    expect(after.system).toContain("The owner is brainstorming");
    expect(rulesOf(after.system)).toBe(rulesOf(before.system));
    expect((await app.call("GET", "/api/jobs")).json<Job[]>()).toEqual([]);

    // "yes" right after brainstorming is still brainstorming: nothing is planned.
    agentScript = async ({ call }) =>
      call("propose_job", {
        title: "Stop Jellyfin at night",
        reason: "Owner said yes",
        steps: [{ kind: "stop-container", serviceId: "jellyfin" }],
      });
    await app.call("POST", "/api/agent/conversations", {
      text: "yes",
      conversationId: idea.conversationId,
    });
    expect(agentRuns.at(-1)!.system).toContain("not approval of any plan");
    expect((await app.call("GET", "/api/jobs")).json<Job[]>()).toEqual([]);

    // "Let's build it" moves to planning: a plan is proposed, and it waits for approval.
    await app.call("POST", "/api/agent/conversations", {
      text: "OK let's build it",
      conversationId: idea.conversationId,
    });
    expect(agentRuns.at(-1)!.system).toContain("collaborative planning");
    const jobs = (await app.call("GET", "/api/jobs")).json<Job[]>();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("awaiting-approval");

    // An enthusiastic "yes do it" never approves the waiting plan.
    agentScript = async () => "Great, it is waiting for your approval on the plan.";
    await app.call("POST", "/api/agent/conversations", {
      text: "yes do it!",
      conversationId: idea.conversationId,
    });
    expect((await app.call("GET", "/api/jobs")).json<Job[]>()[0]!.status).toBe("awaiting-approval");

    // Urgent troubleshooting is focused and may plan a fix (still for approval).
    agentScript = async () => "Looking.";
    await app.call("POST", "/api/agent/conversations", {
      text: "Jellyfin is down and won't load, fix it",
    });
    expect(agentRuns.at(-1)!.system).toContain("Something is broken and the owner wants it fixed");
    expect(agentRuns.at(-1)!.limits?.maxTurns).toBeUndefined();
  });

  it("look only: 'don't change anything' refuses every plan and change, and runs read only", async () => {
    const app = await connected();
    // Full access is on: look only still wins for that message.
    (app.agents as unknown as { deps: { fullAccess: () => { on: boolean } } }).deps.fullAccess =
      () => ({ on: true });
    const tried: Record<string, string> = {};
    agentScript = async ({ call }) => {
      tried.plan = await call("propose_job", {
        title: "Raise the HD-1080p cutoff",
        reason: "Looks low",
        steps: [{ kind: "restart-container", serviceId: "jellyfin" }],
      });
      tried.restart = await call("restart_service", { serviceId: "jellyfin", reason: "x" });
      tried.app = await call("app_api", {
        serviceId: "radarr",
        method: "PUT",
        path: "/api/v3/qualityprofile/1",
        body: "{}",
      });
      tried.hearth = await call("hearth_api", {
        method: "PATCH",
        path: "/api/settings",
        body: '{"theme":"light"}',
      });
      tried.read = await call("get_overview", {});
      return "Here is what I found; nothing changed.";
    };
    const r = (
      await app.call("POST", "/api/agent/conversations", {
        text: "Check my Radarr quality settings and tell me what you find. Don't change anything.",
      })
    ).json<{ conversationId: string }>();
    for (const k of ["plan", "restart", "app", "hearth"])
      expect([k, tried[k]]).toEqual([k, expect.stringMatching(/only to look/)]);
    expect(tried.read).not.toMatch(/only to look/);
    expect((await app.call("GET", "/api/jobs")).json<Job[]>()).toEqual([]);
    const run = agentRuns.at(-1)!;
    expect(run.lookOnly).toBe(true);
    expect(run.full).toBeUndefined();
    expect(run.system).toContain("The owner asked you only to look this time");
    expect(run.system).not.toContain("Full access is on: you are a full coding agent");

    // "yes" keeps it look only; asking for the change lifts it (the plan still waits for approval).
    await app.call("POST", "/api/agent/conversations", {
      text: "yes",
      conversationId: r.conversationId,
    });
    expect(agentRuns.at(-1)!.lookOnly).toBe(true);
    agentScript = async ({ call }) =>
      call("propose_job", {
        title: "Restart Jellyfin",
        reason: "Owner asked",
        steps: [{ kind: "restart-container", serviceId: "jellyfin" }],
      });
    await app.call("POST", "/api/agent/conversations", {
      text: "OK, go ahead and plan it",
      conversationId: r.conversationId,
    });
    expect(agentRuns.at(-1)!.lookOnly).toBeUndefined();
    expect((await app.call("GET", "/api/jobs")).json<Job[]>()).toHaveLength(1);
  });

  it("lean: an everyday how-to runs light on the same model, and switches to full mode for real work (11-13)", async () => {
    const app = await connected();
    (app.agents as unknown as { deps: { fullAccess: () => { on: boolean } } }).deps.fullAccess =
      () => ({ on: true });
    agentScript = async () => "Open Settings, then Notifications.";
    const r = (
      await app.call("POST", "/api/agent/conversations", {
        text: "How do I add a new destination for alerts?",
      })
    ).json<{ conversationId: string }>();
    const light = agentRuns.at(-1)!;
    expect(light.lean).toBe(true);
    expect(light.full).toBeUndefined();
    expect(light.system).toContain("you are running light");
    // It thinks less too, so the owner is not left watching "thinking" (11-14).
    expect(light.limits?.effort).toBe("low");
    const before = agentRuns.length;

    // It needs real work: the agent says so in one word, and the same message runs in full.
    agentScript = async ({ prompt }) =>
      agentRuns.at(-1)!.lean ? "NEEDS_FULL_MODE" : `Done in full for: ${prompt.slice(-40)}`;
    await app.call("POST", "/api/agent/conversations", {
      text: "How do I get Sonarr's queue moving again?",
      conversationId: r.conversationId,
    });
    expect(agentRuns.slice(before).map((x) => Boolean(x.lean))).toEqual([true, false]);
    const full = agentRuns.at(-1)!;
    expect(full.full).toBeDefined();
    expect(full.system).not.toContain("you are running light");
    const said = JSON.stringify(
      (await app.call("GET", `/api/agent/conversations/${r.conversationId}`)).json(),
    );
    expect(said).toContain("Done in full for");
    expect(said).not.toContain("NEEDS_FULL_MODE");

    // A request to do something is never light.
    agentScript = async () => "On it.";
    await app.call("POST", "/api/agent/conversations", {
      text: "Can you restart Radarr for me?",
      conversationId: r.conversationId,
    });
    expect(agentRuns.at(-1)!.lean).toBeUndefined();
    // Real work keeps the agent's own thinking level.
    expect(agentRuns.at(-1)!.limits?.effort).toBeUndefined();
  });

  it("personality: conversation preferences are only suggested, and used once accepted", async () => {
    const app = await connected();
    agentScript = async ({ call }) =>
      call("suggest_preference", { preference: "Keep answers short" });
    const r = (
      await app.call("POST", "/api/agent/conversations", {
        text: "please keep your answers shorter from now on",
      })
    ).json<{ reply: string }>();
    expect(r.reply).toMatch(/not remembered until the owner accepts it/);
    const drafts = await app.handle.db.select().from(draftsTable);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe("pending");
    expect((await app.call("GET", "/api/memory/entries")).json<unknown[]>()).toEqual([]);
    agentScript = async () => "Sure.";
    await app.call("POST", "/api/agent/conversations", { text: "how are things?" });
    expect(agentRuns.at(-1)!.system).not.toContain("Keep answers short");

    // Once the owner accepts it, it shapes answers, as style rather than as a fact.
    const accepted = await app.call("POST", `/api/memory/imports/${drafts[0]!.id}/accept`, {});
    expect(accepted.statusCode).toBe(200);
    await app.call("POST", "/api/agent/conversations", { text: "how are things?" });
    const system = agentRuns.at(-1)!.system;
    expect(system).toContain("How the owner likes you to talk");
    expect(system).toContain("- Keep answers short");
    expect(agentPrompts.at(-1)).not.toContain("Keep answers short");
  });

  it("Secure Vault: the AI sees credential states and what they allow, never values", async () => {
    const app = await connected();
    let before = "";
    agentScript = async ({ call }) => {
      before = await call("vault_status", {});
      return "Checked.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "What credentials do you have?" });
    const sonarr = (await app.workspace()).services.find((s) => s.name === "Sonarr");
    expect(before).toContain('"state": "missing"');
    expect(agentRuns.at(-1)!.system).toContain("Secure Vault is connected to you");
    expect(agentRuns.at(-1)!.system).toContain("never ask the owner to type a secret");
    if (sonarr) {
      await app.vault.add({
        name: "Sonarr API key",
        kind: "api-key",
        tier: "automation",
        serviceId: sonarr.id,
        value: "sonarr-secret-value-987",
      });
      let after = "";
      agentScript = async ({ call }) => {
        after = await call("vault_status", { serviceId: sonarr.id });
        return "Checked.";
      };
      await app.call("POST", "/api/agent/conversations", { text: "Is Sonarr's key in?" });
      expect(after).toContain("Sonarr API key");
      // New credentials allow diagnostics, and changes you approve one by one.
      expect(after).toContain("Diagnostics, and changes you approve");
      expect(after).not.toContain("sonarr-secret-value-987");
    }
    const all = (await app.call("GET", "/api/agent/conversations")).body;
    expect(all).not.toContain("sonarr-secret-value-987");
  });

  it("asking about a selected torrent: the server reads it fresh, 'that' means it, nothing on screen is trusted", async () => {
    const app = await connected();
    const orville = createHash("sha1").update("The.Orville.S02E04.1080p.WEB.x264").digest("hex");
    let trackers = "";
    agentScript = async ({ call }) => {
      trackers = await call("qbittorrent", { serviceId: "qbittorrent", hash: orville });
      return "Nobody has the complete file.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "hey, what's up with that?",
      focus: { kind: "service", id: "qbittorrent", item: { kind: "torrent", id: orville } },
    });
    const prompt = agentPrompts.at(-1)!;
    expect(prompt).toContain('The owner selected the torrent "The.Orville.S02E04.1080p.WEB.x264"');
    expect(prompt).toContain("status stalled");
    expect(prompt).toContain("seeds 0 connected of 0 in the swarm");
    expect(prompt).toContain("Stalled: no seeders in the swarm.");
    expect(trackers).toContain("not working");
    expect(trackers).toContain('"seedsInSwarm": 0');
    // A torrent that is no longer there is said to be gone, not described from the screen.
    await app.call("POST", "/api/agent/conversations", {
      text: "and this one?",
      focus: { kind: "service", id: "qbittorrent", item: { kind: "torrent", id: "c".repeat(40) } },
    });
    expect(agentPrompts.at(-1)!).toContain("that qBittorrent no longer has (read just now)");
    // Only an identity is accepted from the browser: no names, no states, no other kinds.
    const bad = await app.call("POST", "/api/agent/conversations", {
      text: "this?",
      focus: {
        kind: "service",
        id: "qbittorrent",
        item: { kind: "torrent", id: "x", name: "lies" },
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("asking about a selected Plex stream: read fresh, 'this' means it, an ended stream is said to have ended", async () => {
    const app = await connected();
    let read = "";
    agentScript = async ({ call }) => {
      read = await call("plex", { serviceId: "plex" });
      return "The transcoder cannot keep up.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "why is this buffering?",
      focus: { kind: "service", id: "plex", item: { kind: "plex-session", id: "s-2" } },
    });
    const prompt = agentPrompts.at(-1)!;
    expect(prompt).toContain(
      'The owner selected the Plex stream of The Orville S2E3 "A Tale of Two Ships"',
    );
    expect(prompt).toContain("Sam on Chrome");
    expect(prompt).toContain("transcoder speed 0.7x (software)");
    expect(read).toContain('"decision": "transcode"');
    await app.call("POST", "/api/agent/conversations", {
      text: "and that one?",
      focus: { kind: "service", id: "plex", item: { kind: "plex-session", id: "gone-1" } },
    });
    expect(agentPrompts.at(-1)!).toContain("that has ended (read just now)");
  });

  it("resource history: off until switched on, cost shown first, and the AI says when there is none", async () => {
    const app = await connected();
    const info = (await app.call("GET", "/api/history/resources")).json<{
      enabled: boolean;
      retentionDays: number;
      estimate: { rows: number; bytes: number };
    }>();
    expect(info).toMatchObject({ enabled: false, retentionDays: 14 });
    expect(info.estimate.bytes).toBe(info.estimate.rows * 160);
    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("resource_history", { serviceId: "host" });
      return "Checked.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "Was the server busy last night?" });
    expect(answer).toMatch(/switched off, so there is no recorded CPU, memory, or disk history/);
    expect((await app.call("PUT", "/api/history/resources", { retentionDays: 9 })).statusCode).toBe(
      409,
    );
    const on = await app.call("PUT", "/api/history/resources", { enabled: true, retentionDays: 7 });
    expect(on.json()).toEqual({ enabled: true, retentionDays: 7 });
    const audit = (await app.call("GET", "/api/audit?limit=5")).json<AuditRecord[]>();
    expect(audit.some((a) => a.action === "Turned resource history on (kept 7 days)")).toBe(true);
    await app.call("POST", "/api/agent/conversations", { text: "And now?" });
    expect(answer).toMatch(/No hourly records for this machine/);
    expect(answer).toContain('"collecting": true');
  });

  it("a live read the AI asks for uses the credential through the broker, and is audited", async () => {
    const app = await connected();
    const report = (await app.call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    await app.call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings
        .filter((f) => f.sourceName === "sonarr")
        .map((f) => ({ key: f.key, name: f.name })),
    });
    const sonarr = (await app.workspace()).services.find((s) => s.name === "Sonarr")!;
    await app.vault.add({
      name: "Sonarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: sonarr.id,
      value: "sonarr-secret-value-987",
    });
    agentScript = async ({ call }) => {
      await call("app_health", { serviceId: sonarr.id, live: true });
      return "Read.";
    };
    const r = (
      await app.call("POST", "/api/agent/conversations", { text: "Check Sonarr right now" })
    ).json<{ conversationId: string }>();
    const audit = (await app.call("GET", "/api/audit?limit=10")).json<AuditRecord[]>();
    const used = audit.find((a) =>
      a.action.startsWith("Ember used Sonarr's Secure Vault credential"),
    );
    expect(used, JSON.stringify(audit.map((a) => a.action))).toMatchObject({
      actor: "agent",
      action: expect.stringMatching(/to read Sonarr's health \(read only\): (worked|failed)$/),
    });
    expect(JSON.stringify(audit)).not.toContain("sonarr-secret-value-987");
    const convo = (await app.call("GET", `/api/agent/conversations/${r.conversationId}`)).body;
    expect(convo).toContain("Read inside Sonarr now (signed in through Secure Vault)");
    expect(convo).not.toContain("sonarr-secret-value-987");
  });

  it("diagnostics: logs by time window, container configuration without values, visible steps", async () => {
    const app = await connected();
    await app.call("PUT", "/api/autonomy", { level: "diagnose" });
    // A real (fake Docker) container for the configuration read.
    const report = (await app.call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    await app.call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings
        .filter((f) => f.sourceName === "sonarr")
        .map((f) => ({ key: f.key, name: f.name })),
    });
    const sonarr = (await app.workspace()).services.find((s) => s.name === "Sonarr")!;
    let windowed = "";
    let filtered = "";
    let malformed = "";
    let config = "";
    agentScript = async ({ call }) => {
      windowed = await call("read_logs", { serviceId: sonarr.id, since: "2h" });
      filtered = await call("read_logs", {
        serviceId: sonarr.id,
        since: "2h",
        filter: "ready",
      });
      malformed = await call("read_logs", { serviceId: sonarr.id, since: "yesterday-ish" });
      config = await call("container_config", { serviceId: sonarr.id });
      await call("vault_status", {});
      return "Looked.";
    };
    const r = (
      await app.call("POST", "/api/agent/conversations", { text: "Why does Jellyfin stall?" })
    ).json<{ conversationId: string }>();
    // Each line carries its time, and the header says what window was read.
    expect(windowed).toMatch(/^\(3 lines in \d{4}-\d\d-\d\d \d\d:\d\d UTC to now, showing all\)/);
    expect(windowed).toMatch(/\n\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \[sonarr\] Ready/);
    expect(filtered).toContain('1 containing "ready"');
    expect(filtered).not.toContain("Starting up");
    expect(malformed).toMatch(/is not a time/);
    // Environment by name only; the value never reaches the AI.
    expect(config).toContain('"API_KEY"');
    expect(config).not.toContain("never-shown");
    expect(config).toContain("unless-stopped");
    // Every tool shows as a step in the conversation, including the vault check.
    const convo = (await app.call("GET", `/api/agent/conversations/${r.conversationId}`)).body;
    expect(convo).toContain("Read Sonarr's logs from a time window");
    expect(convo).toContain("Read how Sonarr's container is set up (no values)");
    expect(convo).toContain("Checked Secure Vault (names and status only, never values)");
    expect(convo).not.toContain("never-shown");
  });

  it("workspaces: the Cave opens a panel, your choices survive its updates, submit hands back exact decisions", async () => {
    const app = await connected();
    const spec = {
      title: "Duplicate Media Review",
      columns: [
        { key: "title", label: "Title" },
        { key: "file", label: "File", kind: "path" },
        { key: "size", label: "Size", kind: "bytes" },
      ],
      choices: [
        { value: "keep", label: "Keep", tone: "good" },
        { value: "discard", label: "Discard", tone: "warn" },
      ],
      items: [
        {
          id: "/media/movies/A/A.1080p.mkv",
          group: "A",
          values: { title: "A", file: "A.1080p.mkv", size: 8e9 },
        },
        {
          id: "/media/movies/A/A.720p.mp4",
          group: "A",
          values: { title: "A", file: "A.720p.mp4", size: 2e9 },
        },
        {
          id: "/media/movies/B/B.mkv",
          group: "B",
          values: { title: "B", file: "B.mkv", size: 5e9 },
        },
      ],
      suggested: { "/media/movies/A/A.1080p.mkv": "keep" },
    };
    agentScript = async ({ call }) => {
      // Values for a column it did not declare are refused, not shown.
      expect(
        await call("workspace_create", { ...spec, items: [{ id: "x", values: { nope: 1 } }] }),
      ).toMatch(/unknown column "nope"/);
      expect(await call("workspace_create", spec)).toMatch(
        /Opened the workspace "Duplicate Media Review"/,
      );
      return "The list is in the panel beside the chat.";
    };
    const r = (
      await app.call("POST", "/api/agent/conversations", { text: "Find my duplicate movies" })
    ).json<{ conversationId: string }>();
    const list = (await app.call("GET", `/api/workspaces?conversationId=${r.conversationId}`)).json<
      WorkspaceSummary[]
    >();
    expect(list).toMatchObject([
      { title: "Duplicate Media Review", items: 3, decided: 1, kind: "temporary", state: "open" },
    ]);
    const id = list[0]!.id;

    // Your choices are kept on the server as you make them; unknown choices are refused.
    const chosen = await app.call("PUT", `/api/workspaces/${id}/selections`, {
      "/media/movies/A/A.720p.mp4": "discard",
      "/media/movies/B/B.mkv": "keep",
    });
    expect(chosen.json<WorkspaceView>().selections).toEqual({
      "/media/movies/A/A.720p.mp4": "discard",
      "/media/movies/B/B.mkv": "keep",
    });
    expect(
      (
        await app.call("PUT", `/api/workspaces/${id}/selections`, {
          "/media/movies/B/B.mkv": "burn",
        })
      ).statusCode,
    ).toBe(400);

    // The Cave narrows the list as you talk: your choices on the items that stay are untouched.
    agentScript = async ({ call }) => {
      expect(
        await call("workspace_update", {
          id,
          remove: ["/media/movies/B/B.mkv"],
          upsert: [
            {
              id: "/media/movies/C/C.mkv",
              group: "C",
              values: { title: "C", file: "C.mkv", size: 1e9 },
            },
          ],
        }),
      ).toMatch(/3 items, the owner's choices kept/);
      return "Dropped B, added C.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "Drop B, it is not a duplicate",
      conversationId: r.conversationId,
    });
    let view = (await app.call("GET", `/api/workspaces/${id}`)).json<WorkspaceView>();
    expect(view.spec.items.map((i) => i.id)).toEqual([
      "/media/movies/A/A.1080p.mkv",
      "/media/movies/A/A.720p.mp4",
      "/media/movies/C/C.mkv",
    ]);
    expect(view.selections["/media/movies/A/A.720p.mp4"]).toBe("discard");

    // Minimize keeps everything.
    view = (
      await app.call("POST", `/api/workspaces/${id}/state`, { state: "minimized" })
    ).json<WorkspaceView>();
    expect(view.state).toBe("minimized");
    expect(view.selections["/media/movies/A/A.720p.mp4"]).toBe("discard");

    // Submit: exact decisions go back into the conversation, and the Cave reads them.
    let read: unknown;
    agentScript = async ({ call }) => {
      read = await call("workspace_read", { id });
      return "Here is the plan for your approval.";
    };
    const submitted = (
      await app.call("POST", `/api/workspaces/${id}/submit`)
    ).json<WorkspaceView>();
    expect(submitted.submission).toMatchObject({
      decisions: {
        "/media/movies/A/A.1080p.mkv": "keep",
        "/media/movies/A/A.720p.mp4": "discard",
      },
      counts: { keep: 1, discard: 1 },
      undecided: 1,
    });
    await vi.waitFor(() => expect(read).toBeTruthy());
    expect(String(read)).toContain('"/media/movies/A/A.720p.mp4"');
    expect(String(read)).toContain('"choiceIsYourSuggestion": true');
    const convo = (await app.call("GET", `/api/agent/conversations/${r.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    const said = convo.messages.filter((m) => m.role === "you").at(-1)!.text;
    expect(said).toContain('Submitted the workspace "Duplicate Media Review"');
    expect(said).toContain("- /media/movies/A/A.720p.mp4: Discard");
    expect(said).toContain("Submitting is not approval");

    // Closing removes only the workspace's own data.
    expect((await app.call("DELETE", `/api/workspaces/${id}`)).statusCode).toBe(204);
    expect((await app.call("GET", `/api/workspaces/${id}`)).statusCode).toBe(404);
  });

  it("workspaces: saved ones are kept, untouched temporary ones are removed after 30 days", async () => {
    const app = await connected();
    const ws = new Workspaces(app.handle);
    const spec = {
      title: "T",
      columns: [{ key: "a", label: "A" }],
      items: [{ id: "1", values: { a: "x" } }],
    };
    const temp = await ws.create({ spec });
    const kept = await ws.create({ spec });
    await app.call("POST", `/api/workspaces/${kept.id}/save`, { title: "Kept list" });
    const later = Date.now() + 31 * 86_400_000;
    expect(await ws.prune(later)).toBe(1);
    expect((await app.call("GET", `/api/workspaces/${temp.id}`)).statusCode).toBe(404);
    expect(
      (await app.call("GET", `/api/workspaces/${kept.id}`)).json<WorkspaceView>(),
    ).toMatchObject({
      kind: "saved",
      spec: { title: "Kept list" },
    });
    // Nothing to decide, nothing to submit.
    expect((await app.call("POST", `/api/workspaces/${kept.id}/submit`)).statusCode).toBe(400);
  });

  it("working files and notes: saved workspaces stay interactive, X only closes them, delete is deliberate, notes go to Memory", async () => {
    const app = await connected();
    const spec = {
      title: "Duplicate Media Review",
      description: "Two copies each.",
      columns: [
        { key: "title", label: "Title" },
        { key: "size", label: "Size", kind: "bytes" },
      ],
      choices: [
        { value: "keep", label: "Keep" },
        { value: "discard", label: "Discard" },
      ],
      items: [
        { id: "/m/A/a1.mkv", values: { title: "A 1080p", size: 8e9 } },
        { id: "/m/A/a2.mkv", values: { title: "A 720p", size: 2e9 } },
      ],
    };
    let opened = "";
    agentScript = async ({ call }) => {
      opened = await call("workspace_create", spec);
      return "In the panel.";
    };
    const r = (
      await app.call("POST", "/api/agent/conversations", { text: "Find my duplicates" })
    ).json<{ conversationId: string }>();
    const id = /id ([0-9a-f-]{36})/.exec(opened)![1]!;
    await app.call("PUT", `/api/workspaces/${id}/selections`, { "/m/A/a2.mkv": "discard" });

    // A temporary workspace cannot be "closed and kept"; that is what saving is for.
    expect(
      (await app.call("POST", `/api/workspaces/${id}/state`, { state: "closed" })).statusCode,
    ).toBe(400);

    // Saved as a working file: moved into Saved work with its data, choices, and conversation.
    const saved = (
      await app.call("POST", `/api/workspaces/${id}/save`, {
        title: "Movie duplicates",
        folder: "Media cleanup",
      })
    ).json<WorkspaceView>();
    expect(saved).toMatchObject({
      kind: "saved",
      folder: "Media cleanup",
      conversationId: r.conversationId,
      selections: { "/m/A/a2.mkv": "discard" },
      spec: { title: "Movie duplicates" },
    });
    expect(saved.savedAt).toBeTruthy();
    expect(
      (await app.call("GET", "/api/workspaces?kind=saved")).json<WorkspaceSummary[]>(),
    ).toMatchObject([
      { id, title: "Movie duplicates", folder: "Media cleanup", items: 2, decided: 1 },
    ]);

    // X on a saved one closes its view only; deleting needs the deliberate delete.
    expect(
      (
        await app.call("POST", `/api/workspaces/${id}/state`, { state: "closed" })
      ).json<WorkspaceView>().state,
    ).toBe("closed");
    const refused = await app.call("DELETE", `/api/workspaces/${id}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain("closing it keeps it");

    // Reopened: still interactive, choices intact, editable.
    const reopened = (
      await app.call("POST", `/api/workspaces/${id}/state`, { state: "open" })
    ).json<WorkspaceView>();
    expect(reopened.selections).toEqual({ "/m/A/a2.mkv": "discard" });
    await app.call("PUT", `/api/workspaces/${id}/selections`, { "/m/A/a1.mkv": "keep" });
    const renamed = (
      await app.call("PATCH", `/api/workspaces/${id}`, {
        title: "Movie dupes",
        description: "Checked 10-10",
        folder: null,
      })
    ).json<WorkspaceView>();
    expect(renamed).toMatchObject({ spec: { title: "Movie dupes", description: "Checked 10-10" } });
    expect(renamed.folder).toBeUndefined();
    expect((await app.call("PATCH", `/api/workspaces/${id}`, { title: "  " })).statusCode).toBe(
      400,
    );

    // Ember can find saved working files and read one from another conversation, read only.
    agentScript = async ({ call }) => {
      expect(await call("workspace_read", { saved: true })).toContain("Movie dupes");
      const read = await call("workspace_read", { id });
      expect(read).toContain('"/m/A/a1.mkv"');
      expect(await call("workspace_update", { id, remove: ["/m/A/a1.mkv"] })).toMatch(
        /another conversation/,
      );
      return "Found it.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "What was in my duplicates file?" });

    // Save as a note: reference in Memory with the items and choices; the workspace is unchanged.
    const note = (await app.call("POST", `/api/workspaces/${id}/note`, {})).json<{
      id: string;
      kind: string;
      title: string;
      body: string;
      links: { ref: string }[];
    }>();
    expect(note).toMatchObject({
      kind: "note",
      title: "Movie dupes",
      links: [{ ref: `workspace:${id}` }],
    });
    expect(note.body).toContain("2 items: Keep 1, Discard 1, 0 undecided");
    expect(note.body).toContain("| A 720p | 1.9 GB | Discard |");
    expect((await app.call("GET", `/api/workspaces/${id}`)).json<WorkspaceView>().kind).toBe(
      "saved",
    );

    // Deliberate delete, recorded; only the workspace goes.
    expect((await app.call("DELETE", `/api/workspaces/${id}?saved=1`)).statusCode).toBe(204);
    expect((await app.call("GET", `/api/workspaces/${id}`)).statusCode).toBe(404);
    expect((await app.call("GET", `/api/memory/entries/${note.id}`)).statusCode).toBe(200);
    expect((await app.call("GET", "/api/audit")).body).toContain(
      'Deleted the working file \\"Movie dupes\\"',
    );
  });

  it("attached images: stored here, sent only with your message, seen only in that conversation, with limits", async () => {
    const app = await connected();
    // A real (tiny) PNG: 1x1.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    ).toString("base64");
    const context = {
      mode: "panel",
      panel: "qBittorrent",
      serviceId: "qbittorrent",
      metrics: ["Download speed"],
      capturedAt: new Date().toISOString(),
      redacted: 1,
    };
    const up = await app.call("POST", "/api/attachments", {
      data: png,
      width: 1,
      height: 1,
      context,
    });
    expect(up.statusCode).toBe(200);
    const a = up.json<CaveAttachment>();
    expect(a).toMatchObject({
      mime: "image/png",
      width: 1,
      height: 1,
      context: { panel: "qBittorrent" },
    });
    // Not an image, or too big: refused.
    expect(
      (
        await app.call("POST", "/api/attachments", {
          data: Buffer.from("hello").toString("base64"),
          width: 1,
          height: 1,
          context,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/api/attachments", {
          data: Buffer.alloc(6 * 1024 * 1024, 1).toString("base64"),
          width: 1,
          height: 1,
          context,
        })
      ).statusCode,
    ).toBe(413);

    // Before it is sent, Ember cannot see it.
    let before = "";
    agentScript = async ({ call }) => {
      before = await call("view_attachment", { id: a.id });
      return "Hi.";
    };
    const other = (
      await app.call("POST", "/api/agent/conversations", { text: "hello there" })
    ).json<{
      conversationId: string;
    }>();
    expect(before).toMatch(/not sent in this conversation/);

    // Sent with a message: the prompt names it, and the Cave gets the image itself.
    let seen = "";
    agentScript = async ({ call }) => {
      seen = await call("view_attachment", { id: a.id });
      return "The download speed is flat.";
    };
    const sent = (
      await app.call("POST", "/api/agent/conversations", {
        text: "What do you see in this?",
        attachments: [a.id],
      })
    ).json<{ conversationId: string }>();
    expect(agentPrompts.at(-1)).toContain(
      `attachment ${a.id}: a whole panel, in the qBittorrent panel, showing Download speed`,
    );
    expect(agentPrompts.at(-1)).toContain("1 sensitive element(s) left out");
    expect(agentPrompts.at(-1)).toContain("Look at it with view_attachment before answering");
    expect(seen).toMatch(/^attachment .*1x1 pixels\.\[image image\/png \d+\]$/);
    const convo = (await app.call("GET", `/api/agent/conversations/${sent.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(convo.messages[0]!.attachments).toMatchObject([{ id: a.id }]);
    expect(convo.messages[1]!.evidence!.some((e) => e.ref === `attachment:${a.id}`)).toBe(true);
    // The image itself is served to the app.
    const img = await app.call("GET", `/api/attachments/${a.id}`);
    expect(img.headers["content-type"]).toBe("image/png");

    // Another conversation cannot see it; it cannot be sent twice or removed once sent.
    let elsewhere = "";
    agentScript = async ({ call }) => {
      elsewhere = await call("view_attachment", { id: a.id });
      return "Hm.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "and now?",
      conversationId: other.conversationId,
    });
    expect(elsewhere).toMatch(/not sent in this conversation/);
    expect(
      (await app.call("POST", "/api/agent/conversations", { text: "again", attachments: [a.id] }))
        .statusCode,
    ).toBe(400);
    expect((await app.call("DELETE", `/api/attachments/${a.id}`)).statusCode).toBe(400);

    // Access keys (Home Assistant, companions) cannot attach or fetch images.
    const key = (await app.call("POST", "/api/keys", { name: "HA", scopes: ["converse"] })).json<{
      key: string;
    }>().key;
    const viaKey = await app.app.inject({
      method: "POST",
      url: "/api/agent/conversations",
      headers: { authorization: `Bearer ${key}` },
      payload: { text: "look", attachments: [a.id] },
    });
    expect(viaKey.statusCode).toBe(400);
    const fetchViaKey = await app.app.inject({
      method: "GET",
      url: `/api/attachments/${a.id}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(fetchViaKey.statusCode).toBe(403);

    // A capture never sent is cleared after a day; sent ones stay with their conversation.
    const unsent = (
      await app.call("POST", "/api/attachments", { data: png, width: 1, height: 1, context })
    ).json<CaveAttachment>();
    expect(await new Attachments(app.handle).prune(Date.now() + 25 * 3_600_000)).toBe(1);
    expect((await app.call("GET", `/api/attachments/${unsent.id}`)).statusCode).toBe(404);
    expect((await app.call("GET", `/api/attachments/${a.id}`)).statusCode).toBe(200);
  });

  it("attached images without an AI: the answer says the image could not be looked at", async () => {
    const app = await connected();
    await app.call("POST", "/api/agent/disconnect", {});
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const a = (
      await app.call("POST", "/api/attachments", {
        data: png,
        width: 1,
        height: 1,
        context: { mode: "region", capturedAt: new Date().toISOString(), redacted: 0 },
      })
    ).json<CaveAttachment>();
    const r = (
      await app.call("POST", "/api/agent/conversations", {
        text: "What is this?",
        attachments: [a.id],
      })
    ).json<{ reply: string }>();
    expect(r.reply).toContain("could not be looked at: only the AI can see images");
  });

  it("findings: Ember reads them, records what it established, and the owner decides", async () => {
    const app = await connected();
    let number = 0;
    agentScript = async ({ call }) => {
      const list = await call("list_findings", {});
      expect(list).toContain("whatHearthCanSee");
      const recorded = await call("record_finding", {
        key: "jellyfin-software-transcode",
        kind: "problem",
        severity: "high",
        title: "Jellyfin transcodes every stream in software",
        summary: "All three streams were transcoded on the CPU; hardware acceleration is off.",
        why: "Streams stutter when more than one person watches.",
        nextSteps: ["Turn on hardware acceleration in Jellyfin."],
        evidence: [{ label: "Playback settings", value: "Hardware acceleration: none" }],
        services: ["jellyfin"],
      });
      number = Number(/Recorded as F-(\d+)/.exec(recorded)?.[1]);
      expect(number).toBeGreaterThan(0);
      expect(await call("update_finding", { number, action: "investigating" })).toMatch(
        /investigating/,
      );
      // Resolving needs how it was verified.
      expect(await call("update_finding", { number, action: "resolve", text: "ok" })).toMatch(
        /verified/,
      );
      const detail = await call("get_finding", { number });
      expect(detail).toContain("Hardware acceleration: none");
      return "Jellyfin is transcoding in software; I recorded it.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "Why does Jellyfin stutter?" });
    const mine = (await app.call("GET", "/api/findings"))
      .json<Finding[]>()
      .find((f) => f.number === number)!;
    expect(mine).toMatchObject({ createdBy: "ember", status: "investigating", kind: "problem" });
    // The owner's decision, through the owner's route.
    const dismissed = (
      await app.call("POST", `/api/findings/${mine.id}/dismiss`, { reason: "On purpose" })
    ).json<Finding>();
    expect(dismissed.status).toBe("dismissed");
    const briefing = (await app.call("GET", "/api/findings/briefing")).json<DashboardBriefing>();
    expect(briefing.attention.some((f) => f.id === mine.id)).toBe(false);
  });

  it("to-do: what it notices is only suggested, never twice, and 'add it to the list' saves it at once", async () => {
    const app = await connected();
    agentScript = async ({ call }) => {
      const first = await call("note_finding", {
        title: "Jellyfin keeps becoming unresponsive",
        description: "Seen while looking at something else.",
        category: "issue",
        significance: "meaningful",
        services: ["jellyfin"],
      });
      expect(first).toMatch(/suggestion #1, not on the owner's list/);
      // Said differently, it is recognised as the same thing.
      const again = await call("note_finding", {
        title: "Jellyfin unresponsive again",
        category: "issue",
        significance: "meaningful",
        services: ["jellyfin"],
      });
      expect(again).toMatch(/Already suggested as #1/);
      // Without the owner asking, nothing goes on the list.
      const refused = await call("save_todo", { number: 1 });
      expect(refused).toMatch(/^Not saved/);
      return "Prowlarr is fine. Also noticed: Jellyfin keeps hanging; want me to add it to the list?";
    };
    const first = (
      await app.call("POST", "/api/agent/conversations", { text: "Is Prowlarr working?" })
    ).json<{ conversationId: string }>();
    expect((await app.call("GET", "/api/todos")).json<TodoItem[]>()).toEqual([]);
    const suggested = (await app.call("GET", "/api/todos?suggestions=1")).json<TodoItem[]>();
    expect(suggested).toHaveLength(1);
    expect(suggested[0]).toMatchObject({ number: 1, status: "suggested", source: "agent" });
    const convo = (await app.call("GET", `/api/agent/conversations/${first.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(convo.messages[1]!.evidence!.some((e) => e.ref === `todo:${suggested[0]!.id}`)).toBe(
      true,
    );

    // "Add it to the list": saved straight away, and "it" is resolved from this conversation.
    agentScript = async ({ call }) => call("save_todo", { number: 1 });
    await app.call("POST", "/api/agent/conversations", {
      text: "Add it to the to-do list",
      conversationId: first.conversationId,
    });
    expect(agentPrompts.at(-1)).toMatch(/raised or worked on in this conversation[^]*1\. #1 issue/);
    expect(agentRuns.at(-1)!.system).toContain("save it now (save_todo), without asking again");
    const saved = (await app.call("GET", "/api/todos")).json<TodoItem[]>();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ status: "open", services: ["jellyfin"] });
    expect(saved[0]!.savedAt).toBeTruthy();

    // A casual remark grants nothing: no new items, and only the owner closes one.
    agentScript = async ({ call }) => {
      expect(await call("save_todo", { title: "Upgrade the NAS", category: "idea" })).toMatch(
        /^Not saved/,
      );
      expect(await call("update_todo", { number: 1, status: "resolved" })).toMatch(
        /only the owner closes items/,
      );
      expect(await call("update_todo", { number: 1, status: "dismissed" })).toMatch(/did not ask/);
      return "It looks fine right now.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "jellyfin seems ok today",
      conversationId: first.conversationId,
    });
    expect((await app.call("GET", "/api/todos")).json<TodoItem[]>()).toMatchObject([
      { status: "open" },
    ]);

    // "Put that on the back burner", then "mark that done": both happen, with history.
    agentScript = async ({ call }) => call("update_todo", { number: 1, status: "deferred" });
    await app.call("POST", "/api/agent/conversations", {
      text: "Put that on the back burner",
      conversationId: first.conversationId,
    });
    agentScript = async ({ call }) =>
      call("update_todo", { number: 1, status: "resolved", note: "Fixed by the update." });
    await app.call("POST", "/api/agent/conversations", {
      text: "It's fixed now, mark that done",
      conversationId: first.conversationId,
    });
    const detail = (await app.call("GET", `/api/todos/1`)).json<TodoDetail>();
    expect(detail.status).toBe("resolved");
    expect(detail.history.map((h) => [h.actor, h.kind, h.to ?? null])).toEqual([
      ["agent", "created", "suggested"],
      ["agent", "saved", "open"],
      ["agent", "status", "deferred"],
      ["agent", "status", "resolved"],
    ]);
    expect(detail.history.at(-1)!.text).toContain("Fixed by the update.");
  });

  it("to-do: the owner's own list, filters, history, and dismissed things are not raised again", async () => {
    const app = await connected();
    const made = await app.call("POST", "/api/todos", {
      category: "idea",
      title: "Dashboard for the UPS",
      priority: "low",
    });
    expect(made.statusCode).toBe(200);
    const idea = made.json<TodoItem>();
    expect(idea).toMatchObject({ number: 1, status: "open", source: "you" });
    expect(
      (await app.call("POST", "/api/todos", { category: "idea", title: "x" })).statusCode,
    ).toBe(400);
    expect(
      (await app.call("PATCH", `/api/todos/${idea.id}`, { status: "suggested" })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.call("POST", "/api/todos", {
          category: "issue",
          title: "Bad system",
          services: ["nope"],
        })
      ).statusCode,
    ).toBe(400);
    const patched = (
      await app.call("PATCH", `/api/todos/${idea.id}`, {
        priority: "high",
        status: "deferred",
        note: "After the holidays.",
      })
    ).json<TodoDetail>();
    expect(patched).toMatchObject({ priority: "high", status: "deferred" });
    expect(patched.history.map((h) => h.kind)).toEqual(["created", "edited", "status"]);
    expect((await app.call("GET", "/api/audit")).json<{ action: string }[]>()[0]!.action).toBe(
      "Marked #1 deferred",
    );

    // Something noticed and ignored is not suggested again.
    agentScript = async ({ call }) => {
      await call("note_finding", {
        title: "Kometa has been paused for weeks",
        category: "task",
        significance: "meaningful",
      });
      return "Also noticed Kometa is paused.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "How is everything?" });
    const suggestion = (await app.call("GET", "/api/todos?suggestions=1"))
      .json<TodoItem[]>()
      .find((t) => t.status === "suggested")!;
    await app.call("PATCH", `/api/todos/${suggestion.id}`, { status: "dismissed" });
    let answer = "";
    agentScript = async ({ call }) => {
      answer = await call("note_finding", {
        title: "Kometa paused for weeks",
        category: "task",
        significance: "meaningful",
      });
      return "ok";
    };
    await app.call("POST", "/api/agent/conversations", { text: "How is everything now?" });
    expect(answer).toMatch(/dismissed this before/);
    // A dismissed suggestion never reached the list.
    expect((await app.call("GET", "/api/todos")).json<TodoItem[]>().map((t) => t.number)).toEqual([
      1,
    ]);

    // Saving a suggestion from the card in the app.
    agentScript = async ({ call }) => {
      await call("note_finding", {
        title: "Backups have no offsite copy this week",
        category: "issue",
        significance: "serious",
      });
      return "Noticed something.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "Check the backups" });
    const backup = (await app.call("GET", "/api/todos?suggestions=1"))
      .json<TodoItem[]>()
      .find((t) => t.title.startsWith("Backups"))!;
    expect(backup.priority).toBe("high");
    const kept = (
      await app.call("POST", `/api/todos/${backup.id}/save`, { deferred: true })
    ).json<TodoItem>();
    expect(kept).toMatchObject({ status: "deferred" });
    expect(kept.savedAt).toBeTruthy();
  });

  it("to-do: work on an item links its plan, follows it, and saving is never approval", async () => {
    const app = await connected();
    const item = (
      await app.call("POST", "/api/todos", {
        category: "issue",
        title: "Jellyfin hangs at night",
        services: ["jellyfin"],
      })
    ).json<TodoItem>();
    agentScript = async ({ call }) => {
      await call("update_todo", { number: 1, status: "investigating", note: "Looking at logs." });
      await call("propose_job", {
        title: "Stop Jellyfin overnight",
        reason: "Test whether the hang is load related",
        todoNumber: 1,
        steps: [{ kind: "stop-container", serviceId: "jellyfin" }],
      });
      return "Planned; it needs your approval.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "Let's work on #1 now",
      focus: { kind: "todo", id: item.id },
    });
    expect(agentPrompts.at(-1)).toContain("to-do item #1 open");
    expect(agentRuns.at(-1)!.system).toContain("collaborative planning");
    let detail = (await app.call("GET", `/api/todos/${item.id}`)).json<TodoDetail>();
    expect(detail.status).toBe("waiting-approval");
    expect(detail.jobs).toMatchObject([
      { title: "Stop Jellyfin overnight", status: "awaiting-approval" },
    ]);
    const job = (await app.call("GET", "/api/jobs")).json<Job[]>()[0]!;
    expect(job.status, JSON.stringify(job.steps)).toBe("awaiting-approval");

    // A new conversation about the item gets its history and plan, so nothing is repeated.
    agentScript = async () => "Picking up where we left off.";
    await app.call("POST", "/api/agent/conversations", {
      text: "where were we with this?",
      focus: { kind: "todo", id: item.id },
    });
    expect(agentPrompts.at(-1)).toContain("Looking at logs.");
    expect(agentPrompts.at(-1)).toContain("Stop Jellyfin overnight (awaiting-approval)");

    // Declining the plan puts the item back to open, with a note.
    await app.call("POST", `/api/jobs/${job.id}/decision`, { decision: "decline" });
    await app.jobs.idle();
    await app.agents.cave!.todos!.reconcile();
    detail = (await app.call("GET", `/api/todos/${item.id}`)).json<TodoDetail>();
    expect(detail.status).toBe("open");
    expect(detail.history.some((h) => /was not carried out/.test(h.text))).toBe(true);
  });

  it("to-do: whether an issue is still happening comes from monitoring, and never closes it", async () => {
    const app = await connected();
    const item = (
      await app.call("POST", "/api/todos", {
        category: "issue",
        title: "Jellyfin drops streams",
        services: ["jellyfin"],
      })
    ).json<TodoItem>();
    expect(item.check?.state).toBe("unverified");
    await failSample(app, "jellyfin", "down");
    const now = (await app.call("GET", `/api/todos/${item.id}`)).json<TodoDetail>();
    expect(now.check?.state).toBe("active");
    expect(now.status).toBe("open");
    const idea = (
      await app.call("POST", "/api/todos", { category: "idea", title: "A wall display" })
    ).json<TodoItem>();
    expect(idea.check).toBeUndefined();
  });

  it("each project has its own ongoing conversation, separate from the main one", async () => {
    const app = await connected();
    const project = (
      await app.call("POST", "/api/projects", { name: "Improve Jellyfin" })
    ).json<ProjectDetail>();
    const main = (await app.call("GET", "/api/agent/conversations/main")).json<{ id: string }>();
    const first = (await app.call("GET", `/api/projects/${project.id}/conversation`)).json<{
      id: string;
      projectId: string;
      title: string;
      main: boolean;
    }>();
    expect(first).toMatchObject({ projectId: project.id, title: "Improve Jellyfin", main: false });
    expect(first.id).not.toBe(main.id);
    const again = (await app.call("GET", `/api/projects/${project.id}/conversation`)).json<{
      id: string;
    }>();
    expect(again.id).toBe(first.id);

    agentScript = async ({ call }) => {
      await call("propose_job", {
        title: "Check Jellyfin",
        reason: "Part of the project",
        steps: [{ kind: "run-check", serviceId: "jellyfin" }],
      });
      return "Planned.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "What's next here?",
      conversationId: first.id,
    });
    // Without anything open, the project's conversation is about the project.
    expect(agentPrompts.at(-1)).toContain("Improve Jellyfin");
    const job = (await app.call("GET", "/api/jobs")).json<Job[]>()[0]!;
    expect(job.projectId).toBe(project.id);
    const mainAfter = (await app.call("GET", "/api/agent/conversations/main")).json<{
      messages: unknown[];
    }>();
    expect(mainAfter.messages).toEqual([]);
    expect((await app.call("GET", "/api/projects/nope/conversation")).statusCode).toBe(404);
  });

  it("relays a voice conversation for Home Assistant, and announces a late answer", async () => {
    const app = await connected();
    await app.call("PUT", "/api/notifications/channels/webhook", {
      values: { url: "https://ha.example/api/webhook/x" },
    });
    await app.call("PUT", "/api/notifications/routes/agent-replies", { channels: ["webhook"] });
    const { key } = (
      await app.call("POST", "/api/keys", { name: "Home Assistant", scopes: ["read", "converse"] })
    ).json<{ key: string }>();
    agentScript = async ({ prompt }) => {
      expect(prompt).toContain("speaking to you through their voice assistant");
      await new Promise((r) => setTimeout(r, 1500));
      return "Plex had stopped. I restarted it and it is working again.";
    };
    const res = await app_inject(
      app.send,
      "POST",
      "/api/agent/conversations",
      { text: "Plex is down", source: "voice", wait: 1 },
      key,
    );
    const body = res.json<{ conversationId: string; status: string }>();
    expect(body.status).toBe("working");
    await app.agents.idle();
    await app.notifier.idle();
    const convo = (
      await app_inject(
        app.send,
        "GET",
        `/api/agent/conversations/${body.conversationId}`,
        undefined,
        key,
      )
    ).json<{
      source: string;
      messages: { role: string; text: string }[];
    }>();
    expect(convo.source).toBe("voice");
    expect(convo.messages.at(-1)?.text).toBe(
      "Plex had stopped. I restarted it and it is working again.",
    );
    expect(outbox.map((o) => `${o.channel}: ${o.message.title}: ${o.message.lines[0]}`)).toContain(
      "webhook: Your AI operator replied: Plex had stopped. I restarted it and it is working again.",
    );
  });

  it("Stop ends what Ember is working on at once, and the conversation is free again", async () => {
    const app = await connected();
    agentScript = async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return "This took far too long.";
    };
    const res = (
      await app.call("POST", "/api/agent/conversations", { text: "Do something long", wait: 1 })
    ).json<{ conversationId: string; status: string }>();
    expect(res.status).toBe("working");
    const id = res.conversationId;
    const t0 = Date.now();
    expect(
      (await app.call("POST", `/api/agent/conversations/${id}/stop`)).json<{ stopped: boolean }>(),
    ).toEqual({ stopped: true });
    await app.agents.idle();
    expect(Date.now() - t0).toBeLessThan(2500);
    const convo = (await app.call("GET", `/api/agent/conversations/${id}`)).json<{
      status: string;
      messages: { role: string; text: string }[];
    }>();
    expect(convo.status).not.toBe("working");
    expect(convo.messages.at(-1)?.text).toMatch(/^Stopped\./);
    // Nothing running: Stop says so.
    expect(
      (await app.call("POST", `/api/agent/conversations/${id}/stop`)).json<{ stopped: boolean }>(),
    ).toEqual({ stopped: false });
  });

  it("Stop frees the conversation even when the run hangs after it (11-12)", async () => {
    const app = await connected();
    agentScript = async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return "This took far too long.";
    };
    // The run hangs after Stop, as one did on the owner's server: Hearth kept saying it was
    // working, and Stop did nothing until a restart.
    const agents = app.agents as unknown as {
      stopGraceMs: number;
      activity: { finish: (...a: unknown[]) => Promise<unknown> };
    };
    agents.stopGraceMs = 200;
    const finish = agents.activity.finish.bind(agents.activity);
    const held: (() => void)[] = [];
    const release = () => held.splice(0).forEach((r) => r());
    try {
      const res = (
        await app.call("POST", "/api/agent/conversations", { text: "Do something long", wait: 1 })
      ).json<{ conversationId: string }>();
      const id = res.conversationId;
      agents.activity.finish = () =>
        new Promise((r) => {
          held.push(() => r(undefined));
        });
      expect(
        (await app.call("POST", `/api/agent/conversations/${id}/stop`)).json<{
          stopped: boolean;
        }>(),
      ).toEqual({ stopped: true });
      const read = async () =>
        (await app.call("GET", `/api/agent/conversations/${id}`)).json<{
          status: string;
          messages: { role: string; text: string }[];
        }>();
      await expect.poll(async () => (await read()).status, { timeout: 3000 }).toBe("idle");
      expect((await read()).messages.at(-1)?.text).toMatch(/^Stopped\./);
      // When the hung run ends at last, it adds nothing.
      agents.activity.finish = finish;
      release();
      await app.agents.idle();
      expect((await read()).messages.filter((m) => /^Stopped\./.test(m.text))).toHaveLength(1);
    } finally {
      agents.activity.finish = finish;
      release();
      agents.stopGraceMs = 8_000;
    }
  });

  it("an unrelated About chip is left out, and the page is told to drop it (11-13)", async () => {
    const app = await connected();
    agentScript = async () => "ok";
    const ha = (await app.workspace()).services.find((s) => /home assistant/i.test(s.name))!;
    const off = (
      await app.call("POST", "/api/agent/conversations", {
        text: "How do I plan a movie night?",
        focus: { kind: "service", id: ha.id },
      })
    ).json<{ focusDropped?: boolean }>();
    expect(off.focusDropped).toBe(true);
    expect(agentPrompts.at(-1)).not.toContain(`The owner has ${ha.name} open`);
    const on = (
      await app.call("POST", "/api/agent/conversations", {
        text: "Is this one healthy?",
        focus: { kind: "service", id: ha.id },
      })
    ).json<{ focusDropped?: boolean }>();
    expect(on.focusDropped).toBeUndefined();
    expect(agentPrompts.at(-1)).toContain(ha.name);
  });

  it("a question typed while a step hangs (a Show & Tell step waiting for the screen) is never answered Stopped (11-13)", async () => {
    const app = await connected();
    agentScript = async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return "This took far too long.";
    };
    const agents = app.agents as unknown as {
      stopGraceMs: number;
      activity: { finish: (...a: unknown[]) => Promise<unknown> };
    };
    agents.stopGraceMs = 200;
    const finish = agents.activity.finish.bind(agents.activity);
    const held: (() => void)[] = [];
    const release = () => held.splice(0).forEach((r) => r());
    try {
      const id = (
        await app.call("POST", "/api/agent/conversations", {
          text: "Show me Movie nights",
          wait: 1,
        })
      ).json<{ conversationId: string }>().conversationId;
      // The run hangs past Stop's grace (as one waiting for the screen does).
      agents.activity.finish = () =>
        new Promise((r) => {
          held.push(() => r(undefined));
        });
      // "where is the show and tell browser", typed meanwhile: a follow-up, sent twice by a
      // second Enter.
      await app.call("POST", `/api/agent/conversations/${id}/stop`, { followUp: true });
      await app.call("POST", `/api/agent/conversations/${id}/stop`, { followUp: true });
      const read = async () =>
        (await app.call("GET", `/api/agent/conversations/${id}`)).json<{
          status: string;
          messages: { role: string; text: string }[];
        }>();
      await expect.poll(async () => (await read()).status, { timeout: 3000 }).toBe("idle");
      agents.activity.finish = finish;
      release();
      await app.agents.idle();
      expect((await read()).messages.filter((m) => /^Stopped/.test(m.text))).toEqual([]);
    } finally {
      agents.activity.finish = finish;
      release();
      agents.stopGraceMs = 8_000;
    }
  });

  it("a message sent while Ember answers adds to the request: no Stopped reply, both answered together", async () => {
    const app = await connected();
    agentScript = async () => {
      await new Promise((r) => setTimeout(r, 3000));
      return "This took far too long.";
    };
    const res = (
      await app.call("POST", "/api/agent/conversations", { text: "Make my panel", wait: 1 })
    ).json<{ conversationId: string }>();
    const id = res.conversationId;
    expect(
      (await app.call("POST", `/api/agent/conversations/${id}/stop`, { followUp: true })).json<{
        stopped: boolean;
      }>(),
    ).toEqual({ stopped: true });
    await app.agents.idle();
    const before = (await app.call("GET", `/api/agent/conversations/${id}`)).json<{
      messages: { role: string; text: string }[];
    }>();
    expect(before.messages.some((m) => /^Stopped\./.test(m.text))).toBe(false);

    agentScript = async () => "Here is the panel, with search too.";
    agentPrompts.length = 0;
    await app.call("POST", "/api/agent/conversations", {
      text: "search movies and shows as well",
      conversationId: id,
      followUp: true,
      wait: 5,
    });
    await app.agents.idle();
    expect(agentPrompts.at(-1)).toContain("added this while you were still answering");
    const after = (await app.call("GET", `/api/agent/conversations/${id}`)).json<{
      messages: { role: string; text: string }[];
    }>();
    expect(after.messages.at(-1)?.text).toBe("Here is the panel, with search too.");
  });

  it("sees your rules, long work, and how fresh a memory is, and records a re-check", async () => {
    const app = await connected();
    await app.call("PUT", "/api/settings/rules", {
      doNotTouch: [{ serviceId: "jellyfin", reason: "I manage this myself" }],
      reservations: [
        { id: "r1", machine: "Gaming-PC", resource: "gpu", from: "19:00", until: "23:00" },
      ],
    });
    await app.call("POST", "/api/work", {
      title: "Voice training",
      machine: "Gaming-PC",
      progress: 30,
    });
    const note = (
      await app.call("POST", "/api/memory/entries", {
        kind: "note",
        title: "The Jellyfin microphone lives on Homeserver",
        body: "Shared over VirtualHere.",
        happenedAt: "2026-01-01",
      })
    ).json<MemoryEntry>();
    let recalled: string = "";
    let confirmed: string = "";
    agentScript = async ({ prompt, call }) => {
      expect(prompt).toMatch(/Do-not-touch list[^\n]*Jellyfin \(I manage this myself\)/);
      expect(prompt).toMatch(
        /Reserved for the owner[^\n]*The GPU on Gaming-PC, 7 PM to 11 PM every day/,
      );
      expect(prompt).toMatch(/Long work on Gaming-PC: Voice training, running 30%/);
      expect(prompt).toMatch(/STALE: last checked \d+ days ago, may be out of date/);
      recalled = await call("recall", { query: "Jellyfin microphone" });
      confirmed = await call("confirm_memory", {
        id: note.id,
        check: "VirtualHere device list on Homeserver",
        result: "Razer Seiren V3 Mini: In-use by Homeserver",
      });
      return "Checked.";
    };
    await app.call("POST", "/api/agent/conversations", {
      text: "Jellyfin microphone?",
    });
    await app.agents.idle();
    expect(recalled).toContain(note.id);
    expect(recalled).toMatch(/STALE: last checked/);
    expect(confirmed).toMatch(/confirmed just now/);
    const { entry: after, history } = (
      await app.call("GET", `/api/memory/entries/${note.id}`)
    ).json<{ entry: MemoryEntry; history: { by: string }[] }>();
    // The check is kept as a revision by the AI; what is remembered is unchanged.
    expect(history.some((h) => h.by === "ai")).toBe(true);
    expect(after.verification).toMatchObject({ check: "VirtualHere device list on Homeserver" });
    expect(after.title).toBe("The Jellyfin microphone lives on Homeserver");
  });

  it("tells you when long work stalls, through the Long work route", async () => {
    const app = await connected();
    await app.call("PUT", "/api/notifications/channels/webhook", {
      values: { url: "https://ha.example/api/webhook/x" },
    });
    // A new channel is routed to long work like everything else that needs you.
    const ws = await app.workspace();
    expect(ws.routes.find((r) => r.id === "long-work")?.channels).toContain("webhook");
    await app.notifier.announceWork([
      {
        kind: "stalled",
        work: {
          id: "w1",
          title: "Voice training",
          machine: "Gaming-PC",
          status: "stalled",
          progress: 42,
          detail: "operator: 420 of 1012",
          startedAt: "2026-10-14T01:00:00Z",
          heartbeatAt: "2026-10-14T01:20:00Z",
          stallMinutes: 10,
          reportedBy: "PC2 trainer",
        },
      },
    ]);
    expect(outbox.map((o) => `${o.channel}: ${o.message.title}: ${o.message.lines[0]}`)).toContain(
      "webhook: Voice training has gone quiet: No progress report from Gaming-PC for over 10 minutes at 42%.",
    );
  });

  it("Ember answers from gathered records, cites them, and stays within its limits", async () => {
    const app = await connected();
    agentSpend = {
      costUsd: 0.02,
      usage: {
        model: "claude-sonnet-5",
        inputTokens: 3000,
        outputTokens: 120,
        cachedTokens: 2500,
        turns: 1,
      },
    };
    agentScript = async ({ prompt, call }) => {
      // Checking something live is evidence too.
      await call("run_check", { serviceId: "jellyfin" });
      const cite = /\[(E\d+)\][^\n]*Jellyfin on/.exec(prompt)?.[1];
      return `Jellyfin is healthy right now [${cite}].`;
    };
    const res = await app.call("POST", "/api/agent/conversations", {
      text: "Is Jellyfin OK?",
    });
    const body = res.json<{ conversationId: string; reply: string; meta: CaveAnswerMeta }>();
    expect(body.meta).toMatchObject({
      mode: "ai",
      costUsd: 0.02,
      tokens: 5620,
      model: "claude-sonnet-5",
    });
    // The question arrived with what it needs, so one turn was enough.
    expect(agentPrompts[0]).toMatch(/Hearth gathered this for the question/);
    expect(agentPrompts[0]).toMatch(/Jellyfin on Obsidian/);
    // Like a War Room message: the agent's own model, no turn cap, no per-answer cap.
    expect(agentRuns[0]!.limits).toEqual({ model: "default", effort: "medium" });
    expect(agentRuns[0]!.system).toMatch(/You are Ember/);
    expect(agentRuns[0]!.system).not.toMatch(/OUT OF SCOPE/);

    const convo = (await app.call("GET", `/api/agent/conversations/${body.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    const answer = convo.messages.at(-1)!;
    expect(answer.evidence?.map((e) => [e.kind, e.ref])).toEqual([
      ["live", "service:jellyfin"],
      ["live", "service:jellyfin"],
    ]);
    expect(answer.evidence?.[1]?.label).toMatch(/^Health check of Jellyfin just now/);

    const usage = (await app.call("GET", "/api/ai/usage")).json<AiUsageReport>();
    expect(usage.today).toMatchObject({ runs: 1, questions: 1, costUsd: 0.02, tokens: 5620 });
    expect(usage.recent[0]).toMatchObject({ kind: "question", outcome: "answered" });
  });

  it("never declines a question as off-topic: every question reaches the AI", async () => {
    const app = await connected();
    const added = await app.call("POST", "/api/jurisdiction", {
      kind: "topic",
      name: "Gig Tracker",
      access: "out",
      note: "an independent app project",
    });
    expect(added.statusCode, added.body).toBe(200);
    agentScript = async () => "Here is what I found.";
    // Something the owner noted as not homelab still goes to the AI, as context.
    const gig = (
      await app.call("POST", "/api/agent/conversations", {
        text: "Work on my Gig Tracker application",
      })
    ).json<{ reply: string; meta: CaveAnswerMeta }>();
    expect(gig.meta.mode).not.toBe("refusal");
    expect(gig.reply).toBe("Here is what I found.");
    // General knowledge questions are answered like any assistant would.
    const trivia = (
      await app.call("POST", "/api/agent/conversations", {
        text: "Give me a list of all the Doctor Who Christmas specials",
      })
    ).json<{ reply: string; meta: CaveAnswerMeta }>();
    expect(trivia.meta.mode).not.toBe("refusal");
    expect(agentPrompts.length).toBe(2);
    expect(
      agentRuns.every((r) => r.system.includes("Never decline a question as off-topic.")),
    ).toBe(true);
    expect((await app.audit()).map((a) => a.action)).not.toContain(
      "Declined a request outside its jurisdiction",
    );

    // The jurisdiction is yours: an access key cannot read or change it.
    const key = (
      await app.call("POST", "/api/keys", { name: "Claude Code", scopes: ["memory", "converse"] })
    ).json<{ key: string }>().key;
    const asKey = (method: Method, url: string, body?: unknown) =>
      app.send(method, url, body, undefined, { authorization: `Bearer ${key}` });
    expect((await asKey("GET", "/api/jurisdiction")).statusCode).toBe(403);
    expect(
      (await asKey("POST", "/api/jurisdiction", { kind: "topic", name: "x", access: "in" }))
        .statusCode,
    ).toBe(403);
    const list = (await app.call("GET", "/api/jurisdiction")).json<JurisdictionEntry[]>();
    expect((await app.call("DELETE", `/api/jurisdiction/${list[0]!.id}`)).statusCode).toBe(204);
  });

  it("a failed AI run is retried once, then says so plainly (never a dump of the gathered facts); the budget falls back to records", async () => {
    const app = await connected();
    agentScript = async () => {
      throw new Error("Claude Code is not logged in");
    };
    const failed = (
      await app.call("POST", "/api/agent/conversations", { text: "Did my backups finish?" })
    ).json<{ reply: string; meta: CaveAnswerMeta; conversationId: string }>();
    expect(agentRuns).toHaveLength(2);
    expect(failed.meta).toMatchObject({
      mode: "status",
      failure: { attempts: 2, error: expect.stringMatching(/not logged in/) },
    });
    expect(failed.reply).toMatch(
      /^I couldn't finish that, even after trying again \(Claude Code is not logged in\)\./,
    );
    expect(failed.reply).not.toMatch(/watched services|Inside |^- /m);
    const convo = (
      await app.call("GET", `/api/agent/conversations/${failed.conversationId}`)
    ).json<{ messages: CaveMessage[] }>();
    expect(convo.messages[0]!.activity!.map((a) => a.label)).toContain(
      "I couldn't finish that. Retrying",
    );

    // One failure, then an answer: the owner just gets the answer.
    let tries = 0;
    agentScript = async () => {
      tries += 1;
      if (tries === 1) throw new Error("Claude Code exited with 1.");
      return "All fine.";
    };
    const retried = (
      await app.call("POST", "/api/agent/conversations", { text: "How are my servers?" })
    ).json<{ reply: string; meta: CaveAnswerMeta }>();
    expect(retried).toMatchObject({ reply: "All fine.", meta: { mode: "ai" } });
    agentRuns.length = 0;

    // A small daily budget, spent by one answer: the next comes from records.
    agentScript = async () => "All fine.";
    agentSpend = { costUsd: 0.06, usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 } };
    const ran = (await app.call("GET", "/api/ai/usage")).json<AiUsageReport>().today.runs;
    expect((await app.call("PATCH", "/api/ai/budget", { dailyRuns: ran + 1 })).statusCode).toBe(
      200,
    );
    await app.call("POST", "/api/agent/conversations", { text: "How are my servers?" });
    const after = (await app.call("POST", "/api/agent/conversations", { text: "And now?" })).json<{
      reply: string;
      meta: CaveAnswerMeta;
    }>();
    expect(after.meta.mode).toBe("records");
    // Hearth never shows money: the limit is in runs (Flint, 11-13).
    expect(after.reply).toMatch(/^Today's AI limit is reached \(\d+ of \d+ runs\)/);
    expect(after.reply).not.toContain("$");
    const report = (await app.call("GET", "/api/ai/usage")).json<AiUsageReport>();
    expect(report.state).toBe("reached");
    expect(report.level).toBe("light");
    expect(report.providers[0]).toMatchObject({ today: ran + 1, week: ran + 1 });
    expect((await app.audit()).map((a) => a.action)).toContain("Most of today's AI limit is used");
    // An old dollar limit from an earlier version goes when the limit is set or removed.
    await app.call("PATCH", "/api/ai/budget", { dailyUsd: 5 });
    expect((await app.call("GET", "/api/ai/usage")).json<AiUsageReport>().budget.dailyUsd).toBe(5);
    await app.call("PATCH", "/api/ai/budget", { dailyRuns: null });
    const cleared = (await app.call("GET", "/api/ai/usage")).json<AiUsageReport>().budget;
    expect(cleared.dailyUsd).toBeUndefined();
    expect(cleared.dailyRuns).toBeUndefined();
  });

  it("a display name for the AI: only you set it, it is audited, the AI uses it, and nothing else changes", async () => {
    const app = await connected();
    agentScript = async () => "All fine.";
    const first = (
      await app.call("POST", "/api/agent/conversations", { text: "How are my servers?" })
    ).json<{ conversationId: string }>();
    const before = (
      await app.call("GET", `/api/agent/conversations/${first.conversationId}`)
    ).json<{
      messages: CaveMessage[];
    }>();
    expect((await app.call("GET", "/api/workspace")).json<Workspace>().aiName).toBeUndefined();
    expect(agentRuns.at(-1)!.system).toMatch(/^You are Ember, the AI administrator/);

    expect((await app.call("PATCH", "/api/settings", { aiName: "  Warden " })).statusCode).toBe(
      204,
    );
    expect((await app.call("GET", "/api/workspace")).json<Workspace>().aiName).toBe("Warden");
    expect((await app.audit()).map((a) => a.action)).toContain(
      'Named your AI administrator "Warden"',
    );
    // Not a name: refused, the old one kept.
    expect((await app.call("PATCH", "/api/settings", { aiName: "<script>" })).statusCode).toBe(400);
    expect((await app.call("PATCH", "/api/settings", { aiName: "x".repeat(41) })).statusCode).toBe(
      400,
    );
    expect((await app.call("GET", "/api/workspace")).json<Workspace>().aiName).toBe("Warden");
    // An access key cannot rename it.
    const { key } = (
      await app.call("POST", "/api/keys", { name: "HA", scopes: ["read", "act", "converse"] })
    ).json<{ key: string }>();
    expect(
      (
        await app.send("PATCH", "/api/settings", { aiName: "Merlin" }, undefined, {
          authorization: `Bearer ${key}`,
        })
      ).statusCode,
    ).toBe(403);

    // The same conversation goes on; the AI introduces itself by the new name.
    await app.call("POST", "/api/agent/conversations", {
      text: "And now?",
      conversationId: first.conversationId,
    });
    expect(agentRuns.at(-1)!.system).toMatch(/^You are Warden, the AI administrator inside Hearth/);
    expect(agentRuns.at(-1)!.system).toContain(
      "the AI administrator system itself is called Ember",
    );
    const after = (await app.call("GET", `/api/agent/conversations/${first.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(after.messages).toHaveLength(before.messages.length + 2);

    // Back to its default name.
    expect((await app.call("PATCH", "/api/settings", { aiName: "" })).statusCode).toBe(204);
    expect((await app.call("GET", "/api/workspace")).json<Workspace>().aiName).toBeUndefined();
    expect((await app.audit()).map((a) => a.action)).toContain(
      "Gave your AI administrator back its default name, Ember",
    );
  });

  it("Turn on persona: off by default and nothing changes; on, each picture's persona, rules unchanged", async () => {
    const app = await connected();
    agentScript = async () => "Fine.";
    const ask = async () => {
      await app.call("POST", "/api/agent/conversations", { text: "Is everything OK?" });
      return agentRuns.at(-1)!.system;
    };
    const voice = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    const pick = async (avatar: string) =>
      expect(
        (
          await app.call("PUT", "/api/voice", {
            host: voice.host,
            sttPort: voice.sttPort,
            ttsPort: voice.ttsPort,
            active: "warden",
            profiles: voice.profiles.map((p) => (p.id === "warden" ? { ...p, avatar } : p)),
          })
        ).statusCode,
      ).toBe(204);
    await pick(EMBER_LOOKS[5]!.path);
    const today = await ask();
    expect((await app.call("GET", "/api/agent/look-persona")).json()).toEqual({ on: false });
    // Off (saved or never set): the composed prompt is exactly today's.
    expect((await app.call("PUT", "/api/agent/look-persona", { on: false })).statusCode).toBe(200);
    expect(await ask()).toBe(today);

    expect((await app.call("PUT", "/api/agent/look-persona", { on: true })).statusCode).toBe(200);
    expect((await app.audit()).map((a) => a.action)).toContain("Turned on Ember's persona");
    for (const look of EMBER_LOOKS) {
      await pick(look.path);
      const system = await ask();
      expect(system).toContain(lookPersonaInstruction(EMBER_PERSONAS[look.id]!.persona));
      // The picture's persona decides how she talks; the profile's own is not used.
      expect(system).not.toContain("Voice and character (the owner chose this profile");
      // The rules stay whole; the persona is repeated last, with its example line (11-10).
      expect(system).toContain(CAVE_RULES.trimEnd());
      expect(system.trimEnd().endsWith(personaReminder(EMBER_PERSONAS[look.id]!.persona))).toBe(
        true,
      );
      expect(system).toContain(EMBER_PERSONAS[look.id]!.preview);
    }
    // The owner's own picture: their words, or her normal personality when empty.
    await pick(AI_AVATAR_PATH);
    expect(await ask()).not.toContain("Voice and character");
    await app.call("PUT", "/api/agent/look-persona", {
      on: true,
      own: "Test persona for my picture",
    });
    expect(await ask()).toContain(lookPersonaInstruction("Test persona for my picture"));
    // Too long is refused.
    expect(
      (await app.call("PUT", "/api/agent/look-persona", { on: true, own: "x".repeat(1501) }))
        .statusCode,
    ).toBe(400);
  });

  it("voice: only you set it up and use it; profiles change the name, voice, and personality, never the rules", async () => {
    const app = await connected();
    const speech = await fakeWyoming();
    cleanup.push(() => void speech.close());
    agentScript = async () => "Plex is fine [E1].";

    // Not set up: says so, and nothing reaches a speech machine.
    const off = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    expect(off.configured).toBe(false);
    // The five archetypes are built in (Warden first); other voices are profiles the owner adds.
    expect(off.profiles.map((p) => p.name)).toEqual([
      "Warden",
      "Operator",
      "Enchantress",
      "Scholar",
      "Companion",
    ]);
    expect(off.profiles.find((p) => p.id === "companion")).toMatchObject({
      effect: "voicebox",
      avatar: "/avatars/ember-classic.webp",
    });
    const extra = [
      {
        id: "belle",
        name: "Belle",
        voice: "en_US-belle-medium",
        persona: "A warm, laid-back Southern woman from Texas.",
      },
      {
        id: "saoirse",
        name: "Saoirse",
        voice: "en_US-saoirse-medium",
        persona: "Saoirse from Cork. If the owner says only your name, reply just: Yes, love?",
        // Personality dials live on the profile, apart from its voice.
        traits: { warmth: 3 as const, playfulness: 3 as const, profanity: 2 as const },
      },
    ];
    const all = [...off.profiles, ...extra];
    expect((await app.call("POST", "/api/voice/speak", { text: "Hi" })).statusCode).toBe(400);

    const config = {
      host: "127.0.0.1",
      sttPort: speech.port,
      ttsPort: speech.port,
      profiles: all,
    };
    expect((await app.call("PUT", "/api/voice", config)).statusCode).toBe(204);
    const on = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    expect(on.stt).toEqual({ ok: true, model: "small.en" });
    // Custom voices first, then English stock voices; other languages left out.
    expect(on.tts.voices).toEqual([
      "en_US-warden-medium",
      "en_US-belle-medium",
      "en_US-lessac-high",
    ]);
    expect((await app.audit()).map((a) => a.action)).toContain(
      "Changed Ember voice: speech services at 127.0.0.1, voice profiles",
    );

    // Bad settings are refused.
    for (const bad of [
      { ...config, host: "http://evil" },
      { ...config, profiles: [{ ...off.profiles[0]!, name: "<b>" }] },
      { ...config, profiles: [{ ...off.profiles[0]!, voice: "../../etc/passwd" }] },
      { ...config, profiles: [off.profiles[0], off.profiles[0]] },
      { ...config, active: "nobody" },
      { ...config, profiles: [{ ...extra[1]!, traits: { profanity: 9 } }] },
      { ...config, profiles: [{ ...extra[1]!, traits: { menace: 1 } }] },
      // Pictures are only the built-in ones, and effects only the known ones.
      { ...config, profiles: [{ ...extra[1]!, avatar: "https://evil.example/x.webp" }] },
      { ...config, profiles: [{ ...extra[1]!, effect: "distortion" }] },
    ])
      expect((await app.call("PUT", "/api/voice", bad)).statusCode).toBeGreaterThanOrEqual(400);

    // An access key (Home Assistant, a companion) can do none of it.
    const { key } = (
      await app.call("POST", "/api/keys", { name: "HA", scopes: ["read", "act", "converse"] })
    ).json<{ key: string }>();
    const bearer = { authorization: `Bearer ${key}` };
    expect((await app.send("GET", "/api/voice", undefined, undefined, bearer)).statusCode).toBe(
      403,
    );
    expect(
      (await app.send("PUT", "/api/voice", { ...config, host: "10.0.0.9" }, undefined, bearer))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.send("POST", "/api/voice/speak", { text: "Hi" }, undefined, bearer)).statusCode,
    ).toBe(403);

    // Speech to text: raw 16 kHz PCM from the browser.
    const heard = await app.send(
      "POST",
      "/api/voice/transcribe?rate=16000",
      Buffer.alloc(32000) as unknown,
      app.cookie(),
      { "content-type": "application/octet-stream" },
    );
    expect(heard.statusCode, heard.body).toBe(200);
    expect(heard.json<{ text: string }>().text).toBe("Restart Plex please.");
    expect(speech.heard.at(-1)).toEqual({ bytes: 32000, rate: 16000 });
    const tooLong = await app.send(
      "POST",
      "/api/voice/transcribe?rate=16000",
      Buffer.alloc(16000 * 2 * 121) as unknown,
      app.cookie(),
      { "content-type": "application/octet-stream" },
    );
    expect(tooLong.statusCode).toBe(400);

    // Text to speech: plain words in the chosen profile's voice, as a WAV file.
    const said = await app.call("POST", "/api/voice/speak", {
      text: "**Plex** is fine [E1].",
      profile: "belle",
    });
    expect(said.statusCode).toBe(200);
    expect(said.headers["content-type"]).toBe("audio/wav");
    expect(said.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    expect(speech.spoken.at(-1)).toEqual({ text: "Plex is fine.", voice: "en_US-belle-medium" });
    // A profile whose voice is not on the machine says so, instead of speaking in another voice.
    const missing = await app.call("POST", "/api/voice/speak", { text: "Hi", profile: "saoirse" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ message: string }>().message).toMatch(/not on the speech machine yet/);

    // Choosing a profile: its name and personality, same conversation, same rules.
    const first = (
      await app.call("POST", "/api/agent/conversations", { text: "How is Plex?" })
    ).json<{ conversationId: string }>();
    expect(agentRuns.at(-1)!.system).not.toContain("Voice and character");
    expect(
      (
        await app.call("PUT", "/api/voice", {
          ...config,
          profiles: all,
          active: "warden",
        })
      ).statusCode,
    ).toBe(204);
    // No name saved: choosing a profile writes none, so the AI stays Ember.
    expect((await app.call("GET", "/api/workspace")).json<Workspace>().aiName).toBeUndefined();
    expect((await app.audit()).map((a) => a.action)).toContain(
      "Changed Ember voice: voice profile Warden",
    );
    await app.call("POST", "/api/agent/conversations", {
      text: "And now?",
      conversationId: first.conversationId,
      spoken: true,
    });
    const run = agentRuns.at(-1)!;
    expect(run.system).toMatch(
      /^You are Ember, the AI administrator .*\(your default name, until the owner gives you one;/,
    );
    expect(run.system).toContain("Voice and character (the owner chose this profile");
    // The Guardian's style, with no name of its own: the AI is still Ember.
    expect(run.system).toContain("An ancient dragon's calm, intelligent, deliberate presence");
    expect(run.system).not.toContain("Guardian of Ember");
    expect(run.system).not.toMatch(/Warden,|Call yourself Warden/);
    expect(run.system).toContain("Your answer is read aloud");
    expect(run.system).not.toContain("Saoirse");
    expect(run.system).not.toContain("Dials:");
    // The rules unchanged, then the profile's voice repeated last (11-10).
    expect(run.system).toContain(CAVE_RULES.trimEnd());
    expect(run.system.trimEnd()).toMatch(/The persona: An ancient dragon's calm[^]*$/);
    expect(agentPrompts.at(-1)).toContain("their words were transcribed from speech");
    const convo = (await app.call("GET", `/api/agent/conversations/${first.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(convo.messages.filter((m) => m.role === "you")).toHaveLength(2);

    // Settings saved before a built-in profile existed still show it; one removed on purpose stays gone.
    app.handle.sqlite
      .prepare("UPDATE settings SET value = ? WHERE key = 'voice_config'")
      .run(JSON.stringify({ ...config, profiles: extra, active: "belle" }));
    expect(
      (await app.call("GET", "/api/voice")).json<VoiceStatus>().profiles.map((p) => p.id),
    ).toEqual(["belle", "saoirse", "warden", "operator", "enchantress", "scholar", "companion"]);
    await app.call("PUT", "/api/voice", { ...config, profiles: extra });
    expect(
      (await app.call("GET", "/api/voice")).json<VoiceStatus>().profiles.map((p) => p.id),
    ).toEqual(["belle", "saoirse"]);

    // Switching to Saoirse brings her character and dials; switching back leaves none of it behind.
    await app.call("PUT", "/api/voice", { ...config, profiles: all, active: "saoirse" });
    await app.call("POST", "/api/agent/conversations", { text: "Hey Saoirse" });
    const saoirse = agentRuns.at(-1)!.system;
    // A profile of the owner's own changes the voice and character, not the name: still Ember.
    expect(saoirse).toMatch(/^You are Ember, the AI administrator/);
    expect(saoirse).toContain("reply just: Yes, love?");
    expect(saoirse).toContain("Dials: kindness and reassurance: plenty;");
    expect(saoirse).toContain("swearing: a fair amount");
    expect(saoirse).not.toContain("An ancient dragon's calm");
    expect(saoirse).toContain(CAVE_RULES.trimEnd());
    expect(saoirse.trimEnd()).toMatch(/The persona: [^]*swearing: a fair amount[^]*$/);
    await app.call("PUT", "/api/voice", { ...config, profiles: all, active: "belle" });
    await app.call("POST", "/api/agent/conversations", { text: "Hey Belle" });
    const belle = agentRuns.at(-1)!.system;
    expect(belle).toContain("Southern woman from Texas");
    expect(belle).not.toMatch(/Saoirse|Yes, love|Dials:/);

    // An access key cannot claim to be speaking in the app.
    await app.send(
      "POST",
      "/api/agent/conversations",
      { text: "Status?", spoken: true },
      undefined,
      bearer,
    );
    expect(agentPrompts.at(-1)).not.toContain("transcribed from speech");
  });

  it("says so when a restart interrupted an answer, instead of looking busy forever", async () => {
    const app = await connected();
    app.handle.sqlite.exec(`
      INSERT INTO conversations (id, source, title, status, created_at, updated_at)
        VALUES ('c-stuck', 'app', 'Why is Plex slow?', 'working', '2026-10-08T10:00:00Z', '2026-10-08T10:00:00Z');
    `);
    expect(await app.agents.recoverInterrupted()).toBe(1);
    const convo = (await app.call("GET", "/api/agent/conversations/c-stuck")).json<{
      status: string;
      messages: CaveMessage[];
    }>();
    expect(convo.status).toBe("idle");
    expect(convo.messages.at(-1)).toMatchObject({ role: "note" });
    expect(convo.messages.at(-1)!.text).toMatch(/restarted before this answer was ready/);
  });

  it("a plan proposed in a conversation posts its result there; a limit-stopped answer states where plans stand", async () => {
    const app = await connected();
    agentScript = async ({ call }) => {
      await call("propose_job", {
        title: "Check Jellyfin",
        reason: "Owner asked",
        steps: [
          { kind: "run-check", serviceId: "jellyfin" },
          { kind: "test-endpoint", serviceId: "jellyfin" },
        ],
      });
      return "Planned two checks.";
    };
    const first = (
      await app.call("POST", "/api/agent/conversations", { text: "Check Jellyfin for me" })
    ).json<{ conversationId: string }>();
    const job = (await app.call("GET", "/api/jobs")).json<Job[]>()[0]!;
    if (job.status === "awaiting-approval")
      await app.call("POST", `/api/jobs/${job.id}/decision`, {
        decision: "approve",
        fingerprint: job.approval!.fingerprint,
      });
    await app.jobs.idle();
    await app.agents.idle();
    const convo = async () =>
      (await app.call("GET", `/api/agent/conversations/${first.conversationId}`)).json<{
        messages: CaveMessage[];
      }>();
    // A check-only plan may finish before the answer is written: found by what it is, not where.
    const posted = (await convo()).messages.find((m) => m.meta?.mode === "status")!;
    expect(posted).toMatchObject({ role: "agent", meta: { mode: "status" } });
    expect(posted.text).toBe(
      "Plan finished. “Check Jellyfin” succeeded: 2 of 2 steps done and verified. [E1]",
    );
    expect(posted.evidence).toEqual([expect.objectContaining({ id: "E1", ref: `job:${job.id}` })]);
    // The plan's card in the chat shows how it ended (it no longer says "waiting").
    const card = (await convo()).messages[0]!.activity!.find((a) => a.kind === "job")!;
    expect(card).toMatchObject({ status: "done", detail: expect.stringMatching(/verified/) });

    // "Tell me when it's done", and the AI stops at its limit: the plan's real state, no dump.
    agentScript = async () => "";
    agentSpend = {
      text: "",
      error: "it used all 8 steps allowed for one question",
      stoppedAtLimit: true,
      stopReason: "error_max_turns",
      costUsd: 0.21,
    };
    const runsBefore = agentRuns.length;
    const done = (
      await app.call("POST", "/api/agent/conversations", {
        text: "Lmk when its done",
        conversationId: first.conversationId,
      })
    ).json<{ reply: string; meta: CaveAnswerMeta }>();
    expect(agentRuns.length - runsBefore).toBe(1); // a limit is not retried
    expect(done.reply).toBe(
      "I stopped before finishing: it used all 8 steps allowed for one question.\n\nWhere your plans stand:\n- “Check Jellyfin” succeeded: 2 of 2 steps done and verified. [E1]\n\nAsk me to carry on and I'll pick up from here.",
    );
    expect(done.meta).toMatchObject({
      mode: "status",
      failure: { stopReason: "error_max_turns", costUsd: 0.21, attempts: 1 },
    });
  });

  it("a change held from Ember's browser: approved on its own, sent once by Hearth, read back, then shown", async () => {
    // A stand-in app's settings, changed only by a PUT that really reaches it.
    const app_ = { firstDayOfWeek: 0, theme: "auto" };
    const sent: string[] = [];
    const stagedFetch = (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        sent.push(String(init?.body));
        Object.assign(app_, JSON.parse(String(init?.body)));
      }
      return new Response(JSON.stringify({ id: 1, ...app_ }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const app = await connected({ scenario: "calm", stagedFetch });
    const held = await app.staged.stage({
      serviceId: "jellyfin",
      serviceName: "jellyfin",
      origin: "http://app.test",
      method: "PUT",
      url: "http://app.test/api/config/ui/1",
      headers: { "content-type": "application/json", "x-api-key": "the-key" },
      body: JSON.stringify({ id: 1, firstDayOfWeek: 1, theme: "auto" }),
    });
    // Only what changes is shown, and never the key.
    expect(held.changes).toEqual([{ name: "First Day Of Week", before: "0", after: "1" }]);
    expect(JSON.stringify(held)).not.toContain("the-key");
    // Another change held meanwhile is not part of the plan.
    const other = await app.staged.stage({
      serviceId: "jellyfin",
      serviceName: "jellyfin",
      origin: "http://app.test",
      method: "PUT",
      url: "http://app.test/api/config/ui/1",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, firstDayOfWeek: 0, theme: "dark" }),
    });
    agentScript = async ({ call }) => {
      await call("propose_job", {
        title: "Set jellyfin's first day of the week to Monday",
        reason: "Owner asked",
        steps: [{ kind: "browser-change", serviceId: "jellyfin", params: { staged: held.id } }],
      });
      return "With your approval, Hearth sends that one change.";
    };
    const first = (
      await app.call("POST", "/api/agent/conversations", { text: "Make the week start on Monday" })
    ).json<{ conversationId: string }>();
    const job = (await app.call("GET", "/api/jobs")).json<Job[]>()[0]!;
    expect(job.status).toBe("awaiting-approval");
    expect(job.steps[0]!.change?.settings).toEqual(held.changes);
    // Approval is not execution: nothing has reached the app yet.
    expect(sent).toEqual([]);
    agentScript = async () => "I've reloaded the page: Monday, as approved.";
    await app.call("POST", `/api/jobs/${job.id}/decision`, {
      decision: "approve",
      fingerprint: job.approval!.fingerprint,
    });
    await app.jobs.idle();
    await app.agents.idle();
    await app.agents.idle();
    // Exactly the approved request, once; the other held change was not sent.
    expect(sent).toEqual([JSON.stringify({ id: 1, firstDayOfWeek: 1, theme: "auto" })]);
    expect(app_).toMatchObject({ firstDayOfWeek: 1, theme: "auto" });
    const done = (await app.call("GET", `/api/jobs/${job.id}`)).json<Job>();
    expect(done.status).toBe("succeeded");
    expect(done.steps[0]).toMatchObject({ status: "succeeded", verified: true });
    expect(app.staged.get(other.id)).toBeDefined();
    // Ember carries on by herself to show it; the owner never wrote again.
    const convo = (await app.call("GET", `/api/agent/conversations/${first.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(convo.messages.find((m) => m.role === "note")!.text).toMatch(
      /sent exactly the held change and read it back/,
    );
    expect(agentPrompts.at(-1)).toContain("carry it out without asking again");
    expect(convo.messages.filter((m) => m.role === "you")).toHaveLength(1);
    // An approval cannot be used again: the same held change is gone once sent.
    agentScript = async ({ call }) => {
      await call("propose_job", {
        title: "Again",
        reason: "x",
        steps: [{ kind: "browser-change", serviceId: "jellyfin", params: { staged: held.id } }],
      });
      return "Tried.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "Do it again" });
    const again = (await app.call("GET", "/api/jobs")).json<Job[]>()[0]!;
    expect(again.status).toBe("refused");
    expect(again.steps[0]!.policyReason).toMatch(/No held change/);
  });

  it("a restart during an answer: no failure is written, and the question is answered again after", async () => {
    const app = await connected();
    agentScript = async () => "";
    agentSpend = {
      text: "",
      error: "Claude Code exited with 143.",
      interrupted: true,
      exitCode: 143,
    };
    const stopping = app.agents.drain(5_000);
    const res = (
      await app.call("POST", "/api/agent/conversations", { text: "Is Plex up?", wait: 2 })
    ).json<{ status: string; conversationId: string }>();
    await stopping;
    await app.agents.idle();
    let convo = (await app.call("GET", `/api/agent/conversations/${res.conversationId}`)).json<{
      status: string;
      messages: CaveMessage[];
    }>();
    expect(res.status).toBe("working");
    expect(convo.status).toBe("working");
    expect(convo.messages.map((m) => m.role)).toEqual(["you"]);

    // Starting again: the same question is answered, once.
    (app.agents as unknown as { stopping: boolean }).stopping = false;
    agentSpend = {};
    agentScript = async () => "Plex is up.";
    expect(await app.agents.recoverInterrupted()).toBe(1);
    await app.agents.idle();
    convo = (await app.call("GET", `/api/agent/conversations/${res.conversationId}`)).json();
    expect(convo.messages.map((m) => [m.role, m.text])).toEqual([
      ["you", "Is Plex up?"],
      ["note", "Hearth restarted while answering this. Answering it again now."],
      ["agent", "Plex is up."],
    ]);
    expect(convo.status).toBe("idle");
  });

  it("citation ids: a tool result says its own id, and earlier answers' ids are not shown again", async () => {
    const app = await connected();
    let seen = "";
    agentScript = async ({ call }) => {
      seen = await call("get_service", { serviceId: "jellyfin" });
      return "All healthy [E1] [C1].";
    };
    const first = (
      await app.call("POST", "/api/agent/conversations", { text: "Is everything healthy?" })
    ).json<{ conversationId: string }>();
    expect(seen).toMatch(/\(cite as \[C1\]\)$/);
    agentScript = async () => "Still fine.";
    await app.call("POST", "/api/agent/conversations", {
      text: "And now?",
      conversationId: first.conversationId,
    });
    const transcript = agentPrompts.at(-1)!.split("Conversation so far:")[1]!;
    expect(transcript).toContain("You: All healthy.");
    expect(transcript).not.toMatch(/\[(E|C)\d+\]/);
  });

  it("answers from records, and says so, when no AI is connected", async () => {
    const app = await makeApp({ scenario: "calm" });
    const res = await app.call("POST", "/api/agent/conversations", {
      text: "Is everything healthy on my servers?",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; reply: string; meta: { mode: string } }>();
    expect(body.status).toBe("answered");
    expect(body.meta.mode).toBe("records");
    expect(body.reply).toMatch(
      /^No AI is connected, so this comes straight from Hearth\.\n- 32 watched services, 0 not healthy/,
    );
  });

  it("counts jobs among the changes, with a link to each", async () => {
    const app = await makeApp({ scenario: "calm" });
    const job = await app.jobs.create({
      title: "Refresh Jellyfin",
      steps: [{ kind: "run-check", serviceId: "jellyfin" }],
      requestedBy: "you",
    });
    const res = await app.call("POST", "/api/agent/conversations", {
      text: "What did you change today?",
    });
    const body = res.json<{ reply: string; conversationId: string }>();
    expect(body.reply).toMatch(/job "Refresh Jellyfin", planned by you, awaiting-approval/);
    const convo = (await app.call("GET", `/api/agent/conversations/${body.conversationId}`)).json<{
      messages: CaveMessage[];
    }>();
    expect(convo.messages.at(-1)!.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: `job:${job.id}` })]),
    );
  });
});

describe("qBittorrent control: settings, limits, category, tags, priority, force start, add", () => {
  afterEach(() => fakeOutages.restoreAll());
  const A = "c".repeat(40);
  const B = "d".repeat(40);
  const NEW = "e".repeat(40);

  function fake() {
    const prefs: Record<string, unknown> = {
      max_ratio_enabled: false,
      max_ratio: -1,
      max_seeding_time_enabled: true,
      max_seeding_time: 10080,
      max_ratio_act: 0,
      dl_limit: 0,
      up_limit: 0,
      queueing_enabled: true,
      max_active_downloads: 3,
      web_ui_username: "admin",
      listen_port: 6881,
      save_path: "/downloads",
    };
    const base = {
      tags: "",
      priority: 0,
      force_start: false,
      ratio_limit: -2,
      seeding_time_limit: -2,
      inactive_seeding_time_limit: -2,
    };
    const torrents: Record<string, Record<string, unknown>> = {
      [A]: { ...base, name: "Silo S02E01", state: "uploading", category: "tv" },
      [B]: {
        ...base,
        name: "Dune Part Two",
        state: "queuedDL",
        category: "radarr",
        tags: "keep",
        priority: 3,
      },
    };
    const categories = {
      tv: { name: "tv", savePath: "/downloads/tv" },
      radarr: { name: "radarr", savePath: "/downloads/movies" },
    };
    const calls: { path: string; body?: string }[] = [];
    const fetchImpl: Fetch = async (url, init) => {
      const u = new URL(url);
      const method = init.method ?? "GET";
      if (method === "POST") calls.push({ path: u.pathname, body: init.body });
      const reply = (status: number, data: unknown, cookie?: string) => ({
        ok: status < 400,
        status,
        json: async () => data,
        text: async () => (typeof data === "string" ? data : JSON.stringify(data)),
        headers: { get: (n: string) => (n === "set-cookie" && cookie ? cookie : null) },
      });
      const form = new URLSearchParams(init.body ?? "");
      const hs = (form.get("hashes") ?? u.searchParams.get("hashes") ?? "")
        .split("|")
        .filter(Boolean);
      switch (u.pathname) {
        case "/api/v2/auth/login":
          return reply(200, "Ok.", "SID=s; path=/");
        case "/api/v2/auth/logout":
          return reply(200, "");
        case "/api/v2/app/preferences":
          return reply(200, { ...prefs });
        case "/api/v2/app/setPreferences":
          if (form.get("json")!.includes("dl_limit")) return reply(500, "");
          Object.assign(prefs, JSON.parse(form.get("json")!));
          return reply(200, "");
        case "/api/v2/torrents/categories":
          return reply(200, categories);
        case "/api/v2/torrents/tags":
          return reply(200, ["keep"]);
        case "/api/v2/transfer/info":
          return reply(200, {
            connection_status: "connected",
            dl_info_speed: 10,
            up_info_speed: 5,
          });
        case "/api/v2/transfer/speedLimitsMode":
          return reply(200, 0);
        case "/api/v2/torrents/info":
          return reply(
            200,
            Object.entries(torrents)
              .filter(([h]) => !hs.length || hs.includes(h))
              .map(([hash, t]) => ({ hash, ...t })),
          );
      }
      if (method !== "POST") return reply(404, "");
      if (u.pathname === "/api/v2/torrents/add") {
        expect(init.body).toMatch(/name="urls"/);
        torrents[NEW] = {
          ...base,
          name: "Foundation S03E01",
          state: "metaDL",
          category: "tv",
          priority: 4,
        };
        return reply(200, "Ok.");
      }
      for (const h of hs) {
        const t = torrents[h];
        if (!t) continue;
        const tags = (form.get("tags") ?? "").split(",");
        if (u.pathname.endsWith("/setShareLimits")) {
          t.ratio_limit = Number(form.get("ratioLimit"));
          t.seeding_time_limit = Number(form.get("seedingTimeLimit"));
          t.inactive_seeding_time_limit = Number(form.get("inactiveSeedingTimeLimit") ?? -2);
        }
        if (u.pathname.endsWith("/setCategory")) t.category = form.get("category");
        if (u.pathname.endsWith("/addTags"))
          t.tags = [...new Set([...String(t.tags).split(",").filter(Boolean), ...tags])].join(",");
        if (u.pathname.endsWith("/removeTags"))
          t.tags = String(t.tags)
            .split(",")
            .filter((x) => x && !tags.includes(x))
            .join(",");
        if (u.pathname.endsWith("/setForceStart")) t.force_start = form.get("value") === "true";
        if (u.pathname.endsWith("/topPrio")) t.priority = 1;
      }
      return reply(200, "");
    };
    return { prefs, torrents, calls, fetchImpl };
  }

  async function setup() {
    const env = await realEnvironment();
    const svc = (await env.workspace()).services.find((s) => s.name === "SABnzbd")!;
    env.handle.sqlite
      .prepare("UPDATE services SET name = 'qBittorrent', image = ? WHERE id = ?")
      .run("lscr.io/linuxserver/qbittorrent:latest", svc.id);
    const qb = fake();
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      qb.fetchImpl,
      undefined,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    await env.vault.add({
      name: "qBittorrent Web UI",
      kind: "login",
      tier: "automation",
      serviceId: svc.id,
      username: "admin",
      value: "qb-password-value",
      scope: "approved-changes",
    });
    const run = async (
      steps: { kind: ActionKind; params?: Record<string, string | number | boolean> }[],
    ) => {
      const job = await jobs.create({
        title: "qb",
        steps: steps.map((s) => ({ ...s, serviceId: svc.id })),
        requestedBy: "agent",
      });
      if (job.status !== "awaiting-approval") return job;
      await jobs.decide(job.id, "approve", job.approval!.fingerprint);
      await jobs.idle();
      return jobs.get(job.id);
    };
    return { env, svc, qb, jobs, run };
  }

  it("changes global seeding settings with before and after, verified; refuses login, ports, and paths", async () => {
    const { qb, jobs, svc, run } = await setup();
    const plan = await jobs.create({
      title: "x",
      steps: [
        {
          kind: "app-qbt-set-preferences",
          serviceId: svc.id,
          params: { preferences: JSON.stringify({ max_seeding_time: 20160, max_ratio_act: 3 }) },
        },
      ],
      requestedBy: "agent",
    });
    expect(plan.status, plan.summary).toBe("awaiting-approval");
    expect(plan.steps[0]!.change!.settings).toEqual(
      expect.arrayContaining([
        { name: "Seeding time limit", before: "7 days", after: "14 days" },
        expect.objectContaining({
          name: "Warning",
          after: expect.stringMatching(/AND its downloaded files deleted/),
        }),
      ]),
    );
    expect(qb.calls.filter((c) => !c.path.startsWith("/api/v2/auth/"))).toEqual([]);
    const done = await run([
      {
        kind: "app-qbt-set-preferences",
        params: { preferences: JSON.stringify({ max_seeding_time: 20160 }) },
      },
    ]);
    expect(done.status, done.summary).toBe("succeeded");
    expect(done.steps[0]!.result).toMatch(/verified.*Seeding time limit 14 days/);
    expect(qb.prefs.max_seeding_time).toBe(20160);
    for (const key of [
      "web_ui_password",
      "listen_port",
      "save_path",
      "autorun_program",
      "proxy_ip",
    ]) {
      const refused = await jobs.create({
        title: "x",
        steps: [
          {
            kind: "app-qbt-set-preferences",
            serviceId: svc.id,
            params: { preferences: JSON.stringify({ [key]: 1 }) },
          },
        ],
        requestedBy: "you",
      });
      expect(refused.status, key).toBe("refused");
      expect(refused.summary).toMatch(/does not change those/);
    }
  });

  it("per-torrent limits, category, tags, priority, force start: planned exactly and verified", async () => {
    const { qb, run } = await setup();
    const limits = await run([
      {
        kind: "app-qbt-set-share-limits",
        params: { hashes: `${A},${B}`, seedingTimeLimit: 10080 },
      },
    ]);
    expect(limits.status, limits.summary).toBe("succeeded");
    expect(limits.steps[0]!.change!.settings[0]).toEqual({
      name: "Silo S02E01: seeding time",
      before: "the global setting",
      after: "7 days",
    });
    expect(qb.torrents[A]!.seeding_time_limit).toBe(10080);
    expect(qb.torrents[B]!.seeding_time_limit).toBe(10080);
    expect(qb.torrents[A]!.ratio_limit).toBe(-2);

    const cat = await run([
      { kind: "app-qbt-set-category", params: { hash: A, category: "radarr" } },
    ]);
    expect(cat.status, cat.summary).toBe("succeeded");
    expect(qb.torrents[A]!.category).toBe("radarr");
    const nocat = await run([
      { kind: "app-qbt-set-category", params: { hash: A, category: "nope" } },
    ]);
    expect(nocat.status).toBe("refused");
    expect(nocat.summary).toMatch(/no category "nope"/);

    const tags = await run([
      { kind: "app-qbt-set-tags", params: { hash: B, addTags: "trackerone", removeTags: "keep" } },
    ]);
    expect(tags.status, tags.summary).toBe("succeeded");
    expect(qb.torrents[B]!.tags).toBe("trackerone");

    const prio = await run([
      { kind: "app-qbt-set-priority", params: { hash: B, priority: "top" } },
    ]);
    expect(prio.status, prio.summary).toBe("succeeded");
    expect(qb.torrents[B]!.priority).toBe(1);
    const notQueued = await run([
      { kind: "app-qbt-set-priority", params: { hash: A, priority: "top" } },
    ]);
    expect(notQueued.summary).toMatch(/not in the queue/);

    const forced = await run([{ kind: "app-qbt-force-start", params: { hash: A } }]);
    expect(forced.status, forced.summary).toBe("succeeded");
    expect(qb.torrents[A]!.force_start).toBe(true);
  });

  it("puts a torrent's tags back when a later step fails", async () => {
    const { qb, run } = await setup();
    const rolled = await run([
      { kind: "app-qbt-set-tags", params: { hash: A, addTags: "trackerone" } },
      {
        kind: "app-qbt-set-preferences",
        params: { preferences: JSON.stringify({ dl_limit: 1000 }) },
      },
    ]);
    expect(rolled.status, rolled.summary).toBe("rolled-back");
    expect(qb.torrents[A]!.tags).toBe("");
    expect(qb.prefs.dl_limit).toBe(0);
  });

  it("refuses to run when a torrent changed after approval", async () => {
    const { qb, jobs, svc } = await setup();
    const job = await jobs.create({
      title: "x",
      steps: [
        {
          kind: "app-qbt-set-category",
          serviceId: svc.id,
          params: { hash: A, category: "radarr" },
        },
      ],
      requestedBy: "agent",
    });
    qb.torrents[A]!.category = "manual";
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.steps[0]!.result).toMatch(/changed since this plan was approved/);
    expect(qb.torrents[A]!.category).toBe("manual");
  });

  it("adds a magnet, verified by its hash; the read view shows settings but never the login, ports, or paths", async () => {
    const { qb, run, env, svc } = await setup();
    const magnet = `magnet:?xt=urn:btih:${NEW}&dn=Foundation.S03E01`;
    const added = await run([{ kind: "app-qbt-add", params: { urls: magnet, category: "tv" } }]);
    expect(added.status, added.summary).toBe("succeeded");
    expect(added.steps[0]!.change!.settings[0]!.after).toMatch(/magnet Foundation.S03E01/);
    expect(added.steps[0]!.result).toMatch(/Added and verified.*Foundation S03E01/);
    const again = await run([{ kind: "app-qbt-add", params: { urls: magnet } }]);
    expect(again.summary).toMatch(/already has the torrent/);

    const { QbittorrentLive } = await import("./apps/qbittorrent-live");
    const view = await new QbittorrentLive(qb.fetchImpl).settings(svc.id, "http://qb.test", {
      username: "admin",
      password: "qb-password-value",
    });
    void env;
    const body = JSON.stringify(view);
    expect(body).toMatch(/Seeding time limit/);
    expect(body).toMatch(/categories/);
    expect(body).not.toMatch(/web_ui_username|listen_port|"save_path"/);
    expect(
      qb.calls
        .filter((c) => c.path !== "/api/v2/auth/login")
        .some((c) => String(c.body).includes("qb-password-value")),
    ).toBe(false);
  });
});

describe("adding and removing systems", () => {
  afterEach(() => fakeOutages.restoreAll());

  const audit = async (call: Awaited<ReturnType<typeof makeApp>>["call"]) =>
    (await call("GET", "/api/audit?limit=50")).json<AuditRecord[]>().map((a) => a.action);

  const rescan = async (
    call: Awaited<ReturnType<typeof makeApp>>["call"],
    pick: (f: DiscoveryReport["findings"][number]) => boolean,
  ) => {
    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    const adopted = await call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings.filter(pick).map((f) => ({ key: f.key, name: f.name })),
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    return report;
  };

  it("removes a system without touching it, and hides it everywhere", async () => {
    const { call, check, workspace, runner } = await realEnvironment();
    // An open incident on it is closed as your decision.
    fakeOutages.stopContainer("sonarr", 1);
    await check();
    await check();
    let ws = await workspace();
    const sonarr = ws.services.find((s) => s.name === "Sonarr")!;
    expect(ws.incidents.some((i) => i.serviceId === sonarr.id && i.status !== "resolved")).toBe(
      true,
    );
    const restartsBefore = fakeOutages.restarts().length;
    const watched = ws.services.length;

    const removed = await call("POST", `/api/services/${sonarr.id}/remove`);
    expect(removed.statusCode, removed.body).toBe(200);
    ws = await workspace();
    expect(ws.services.some((s) => s.id === sonarr.id)).toBe(false);
    expect(ws.inactiveServices.some((s) => s.id === sonarr.id)).toBe(false);
    expect(ws.services.some((s) => s.dependsOn.includes(sonarr.id))).toBe(false);
    expect(ws.removedServices).toMatchObject([
      { id: sonarr.id, name: "Sonarr", kind: "container", address: "sonarr" },
    ]);
    expect(
      ws.incidents.filter((i) => i.serviceId === sonarr.id && i.status !== "resolved"),
    ).toEqual([]);
    expect(await audit(call)).toContain("Removed Sonarr from Hearth");

    // No longer checked, and nothing is run on it by anyone, you included.
    const summary = await check();
    expect(summary).toMatchObject({ opened: 0 });
    expect((await workspace()).services).toHaveLength(watched - 1);
    for (const requestedBy of ["you", "agent"] as const) {
      await expect(
        runner.request({ kind: "restart-container", serviceId: sonarr.id, requestedBy }),
      ).rejects.toThrow(/removed from Hearth/);
    }
    // The container itself was never restarted, started, or stopped.
    expect(fakeOutages.restarts()).toHaveLength(restartsBefore);
    expect(fakeOutages.power()).toEqual([]);

    // Pausing or retiring it is not a back door: it comes back only from Settings.
    const paused = await call("PUT", `/api/services/${sonarr.id}/lifecycle`, {
      lifecycle: "active",
    });
    expect(paused.statusCode).toBe(409);
    expect(paused.json<{ message: string }>().message).toMatch(/Bring it back from Settings/);

    // Removing twice changes nothing and records nothing new.
    await call("POST", `/api/services/${sonarr.id}/remove`);
    expect((await audit(call)).filter((a) => a === "Removed Sonarr from Hearth")).toHaveLength(1);
  });

  it("never brings a removed system back from a scan, ticked or not", async () => {
    const { call, workspace } = await realEnvironment();
    const sonarr = (await workspace()).services.find((s) => s.name === "Sonarr")!;
    await call("POST", `/api/services/${sonarr.id}/remove`);

    const report = (await call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    const finding = report.findings.find((f) => f.key === "container:sonarr")!;
    expect(finding).toMatchObject({ removed: true, selectedByDefault: false });
    expect(finding.reason).toMatch(/You removed Sonarr from Hearth/);

    // Even sent along with everything else, it stays removed.
    await rescan(call, (f) => f.sourceName !== "photos_db");
    let ws = await workspace();
    expect(ws.services.some((s) => s.id === sonarr.id)).toBe(false);
    expect(ws.removedServices.map((s) => s.id)).toEqual([sonarr.id]);

    await rescan(call, (f) => f.selectedByDefault && f.sourceName !== "photos_db");
    ws = await workspace();
    expect(ws.removedServices.map((s) => s.id)).toEqual([sonarr.id]);
    expect(ws.services.filter((s) => s.container === "sonarr")).toEqual([]);
  });

  it("brings a removed system back from Settings", async () => {
    const { call, check, workspace } = await realEnvironment();
    const sonarr = (await workspace()).services.find((s) => s.name === "Sonarr")!;
    await call("POST", `/api/services/${sonarr.id}/remove`);

    const restored = await call("POST", `/api/services/${sonarr.id}/restore`);
    expect(restored.statusCode, restored.body).toBe(200);
    await check();
    const ws = await workspace();
    expect(ws.removedServices).toEqual([]);
    expect(ws.services.find((s) => s.id === sonarr.id)).toMatchObject({
      name: "Sonarr",
      lastCheck: { status: "ok" },
    });
    expect(await audit(call)).toContain("Brought Sonarr back to Hearth");

    const again = await call("POST", `/api/services/${sonarr.id}/restore`);
    expect(again.statusCode).toBe(409);
    expect((await call("POST", "/api/services/nope/restore")).statusCode).toBe(404);
    expect((await call("POST", "/api/services/nope/remove")).statusCode).toBe(404);
  });

  it("adds a system discovery missed and watches it like any other", async () => {
    const { call, workspace } = await realEnvironment();
    const added = await call("POST", "/api/services", {
      name: "Tasterr",
      kind: "web",
      address: "192.168.1.50:3000/",
      category: "Home",
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toEqual({ id: "tasterr", name: "Tasterr" });
    let ws = await workspace();
    expect(ws.services.find((s) => s.id === "tasterr")).toMatchObject({
      name: "Tasterr",
      kind: "web",
      category: "Home",
      hostId: "testbox",
      localUrl: "http://192.168.1.50:3000",
      // Checked straight away, read only.
      lastCheck: { status: "ok" },
    });
    expect(await audit(call)).toContain("Added Tasterr to Hearth");

    // A new scan never removes a system you added, whatever is ticked.
    await rescan(call, (f) => f.selectedByDefault && f.sourceName !== "photos_db");
    ws = await workspace();
    expect(ws.services.some((s) => s.id === "tasterr")).toBe(true);

    // And it can be removed and brought back like any other.
    await call("POST", "/api/services/tasterr/remove");
    await rescan(call, (f) => f.selectedByDefault && f.sourceName !== "photos_db");
    expect((await workspace()).removedServices.map((s) => s.id)).toEqual(["tasterr"]);
    const sameAddress = await call("POST", "/api/services", {
      name: "Tasterr again",
      kind: "web",
      address: "http://192.168.1.50:3000",
      category: "Home",
    });
    expect(sameAddress.statusCode).toBe(409);
    expect(sameAddress.json<{ message: string }>().message).toMatch(/under Removed systems/);
    await call("POST", "/api/services/tasterr/restore");
    expect((await workspace()).services.some((s) => s.id === "tasterr")).toBe(true);
  });

  it("signs in to an app with no API key, keeps the session in the vault, and reads with it", async () => {
    const tasterr = fakeTasterr();
    const env = await realEnvironment({ appFetch: tasterr.fetch });
    const { call } = env;
    const added = await call("POST", "/api/services", {
      name: "Tasterr",
      kind: "web",
      address: "192.168.1.50:8220",
      category: "Media",
    });
    const id = added.json<{ id: string }>().id;
    const read = (path: string) =>
      env.agents.cave!.appApi!(
        id,
        { method: "GET", path, auth: "session" } as { method: "GET"; path: string },
        { access: "read", purpose: "test read" },
      );
    // Nothing saved yet, but Hearth knows how Tasterr signs in (from its source): Plex first,
    // then its own login. Said in the panel's words, nothing sent.
    expect((await call("GET", `/api/services/${id}/sign-in`)).json()).toEqual({
      how: "plex-pin",
      ways: ["plex-pin", "login"],
      signedIn: false,
      needsLogin: true,
    });
    await expect(read("/api/v1/home/rows")).rejects.toThrow(
      "Tasterr has no API key, so Hearth signs in to it like a browser. Sign Hearth in to Tasterr above to fill these in.",
    );

    // A Plex PIN: Hearth hands over plex.tv's Allow page and keeps polling until it is allowed.
    const pin = {
      type: "plex-pin",
      start: "/api/v1/auth/plex/pin",
      poll: "/api/v1/auth/plex/pin/poll",
      handleField: "pin_id",
      urlField: "auth_url",
    };
    expect((await call("PUT", `/api/services/${id}/sign-in`, pin)).json()).toMatchObject({
      how: "plex-pin",
      signedIn: false,
    });
    await expect(read("/api/v1/home/rows")).rejects.toThrow(/Sign Hearth in to Tasterr above/);
    const started = (await call("POST", `/api/services/${id}/sign-in`)).json<{
      waiting?: { url: string };
    }>();
    expect(started.waiting?.url).toMatch(/^https:\/\/app\.plex\.tv\/auth/);
    await vi.waitFor(
      async () =>
        expect((await call("GET", `/api/services/${id}/sign-in`)).json()).toMatchObject({
          signedIn: true,
        }),
      { timeout: 10_000, interval: 250 },
    );
    const rows = await read("/api/v1/home/rows");
    expect(rows.ok).toBe(true);
    expect(JSON.stringify(rows.body)).toContain("Because you liked Arrival");

    // Kept in the Secure Vault as a saved sign-in, its value never in the list.
    const vault = (await call("GET", "/api/vault")).json<{
      secrets: { kind: string; serviceId?: string; name: string }[];
    }>();
    expect(vault.secrets.find((s) => s.kind === "session")).toMatchObject({
      serviceId: id,
      name: "Tasterr sign-in",
    });
    expect(JSON.stringify(vault)).not.toContain("e2e-tasterr-session");

    // Tasterr forgets the session: a Plex sign-in is marked signed out, for the owner to redo.
    tasterr.signOutAll();
    await expect(read("/api/v1/home/rows")).rejects.toThrow(/signed Hearth out/);
    expect((await call("GET", `/api/services/${id}/sign-in`)).json()).toMatchObject({
      signedIn: false,
    });

    // A login recipe signs in with the app's login from the vault, and again by itself. Until
    // that login is there, the panel is told to ask for it (11-12: no "add it somewhere else").
    await call("PUT", `/api/services/${id}/sign-in`, {
      type: "login",
      path: "/api/v1/auth/local",
      format: "json",
      userField: "email",
      passField: "password",
    });
    expect((await call("GET", `/api/services/${id}/sign-in`)).json()).toMatchObject({
      how: "login",
      signedIn: false,
      needsLogin: true,
    });
    const note = (await call("GET", "/api/vault"))
      .json<{
        secrets: { kind: string; notes?: string }[];
      }>()
      .secrets.find((s) => s.kind === "session")?.notes;
    expect(note).toMatch(/^Signs in with the app's own login/);
    await call("POST", "/api/vault/secrets", {
      name: "Tasterr login",
      kind: "login",
      tier: "automation",
      serviceId: id,
      username: FAKE_TASTERR_LOGIN.email,
      value: FAKE_TASTERR_LOGIN.password,
    });
    expect((await call("GET", `/api/services/${id}/sign-in`)).json()).not.toHaveProperty(
      "needsLogin",
    );
    expect((await read("/api/v1/taste/profile")).ok).toBe(true);
    tasterr.signOutAll();
    expect((await read("/api/v1/taste/profile")).ok).toBe(true);

    // Only paths on the app itself.
    const bad = await call("PUT", `/api/services/${id}/sign-in`, {
      ...pin,
      start: "//evil.example/x",
    });
    expect(bad.statusCode).toBe(400);
  }, 30_000);

  it("a code panel's Request to an app signed in with Plex goes with that sign-in once approved (11-19)", async () => {
    // The owner's Tasterr panel: Request was refused (401) because the plan dropped auth
    // "session" and the approved step only knew API keys.
    const tasterr = fakeTasterr();
    const env = await realEnvironment({ appFetch: tasterr.fetch });
    const { call } = env;
    const id = (
      await call("POST", "/api/services", {
        name: "Tasterr",
        kind: "web",
        address: "192.168.1.52:8220",
        category: "Media",
      })
    ).json<{ id: string }>().id;
    await call("PUT", `/api/services/${id}/sign-in`, {
      type: "plex-pin",
      start: "/api/v1/auth/plex/pin",
      poll: "/api/v1/auth/plex/pin/poll",
      handleField: "pin_id",
      urlField: "auth_url",
    });
    await call("POST", `/api/services/${id}/sign-in`);
    await vi.waitFor(
      async () =>
        expect((await call("GET", `/api/services/${id}/sign-in`)).json()).toMatchObject({
          signedIn: true,
        }),
      { timeout: 10_000, interval: 250 },
    );
    const ops = new AppOperations(
      env.handle,
      env.vault,
      env.runner,
      tasterr.fetch,
      undefined,
      async () => undefined,
    );
    const jobs = new Jobs(env.handle, runnerOperations(env.handle, env.runner, ops));
    const job = await jobs.create({
      title: "Tasterr: Request this title",
      reason: "Proposed from the custom panel.",
      requestedBy: "you",
      steps: [
        {
          kind: "app-api-call",
          serviceId: id,
          params: {
            method: "POST",
            path: "/api/v1/request",
            body: '{"media_type":"movie","tmdb_id":1131943}',
            why: "Requests this title",
            auth: "session",
          },
        },
      ],
    });
    expect(job.status, JSON.stringify(job)).toBe("awaiting-approval");
    expect(job.steps[0]!.params).toMatchObject({ auth: "session" });
    expect(tasterr.requests).toEqual([]);
    await jobs.decide(job.id, "approve", job.approval!.fingerprint);
    await jobs.idle();
    const done = await jobs.get(job.id);
    expect(done.status, done.steps[0]!.result).toBe("succeeded");
    expect(tasterr.requests).toEqual([{ media_type: "movie", tmdb_id: 1131943 }]);
    expect(JSON.stringify(done)).not.toContain("e2e-tasterr-session");
  }, 30_000);

  it("Sign in with Plex on Tasterr: no password needed, kept alive, and signed in again when it ends (11-13)", async () => {
    const tasterr = fakeTasterr();
    const env = await realEnvironment({ appFetch: tasterr.fetch });
    const { call } = env;
    const added = await call("POST", "/api/services", {
      name: "Tasterr",
      kind: "web",
      address: "192.168.1.51:8220",
      category: "Media",
    });
    const id = added.json<{ id: string }>().id;
    const sessions = env.agents.cave!.sessions!;
    const read = (path: string) =>
      env.agents.cave!.appApi!(
        id,
        { method: "GET", path, auth: "session" } as { method: "GET"; path: string },
        { access: "read", purpose: "test read" },
      );
    const status = async () =>
      (await call("GET", `/api/services/${id}/sign-in`)).json<{
        signedIn: boolean;
        how?: string;
        ways?: string[];
      }>();

    // Sign in with Plex straight away: Ember set nothing up, and no Tasterr password exists.
    const started = (await call("POST", `/api/services/${id}/sign-in`, { how: "plex-pin" })).json<{
      waiting?: { url: string };
    }>();
    expect(started.waiting?.url).toMatch(/^https:\/\/app\.plex\.tv\/auth/);
    await vi.waitFor(async () => expect((await status()).signedIn).toBe(true), {
      timeout: 10_000,
      interval: 250,
    });
    expect(await status()).toMatchObject({ how: "plex-pin", ways: ["plex-pin", "login"] });
    expect((await read("/api/v1/home/rows")).ok).toBe(true);
    // The Plex sign-in never reaches the browser or the vault list.
    expect(JSON.stringify((await call("GET", "/api/vault")).json())).not.toContain(
      "e2e-tasterr-session",
    );

    // Kept alive: a light read with the session, which Tasterr renews while it is used.
    expect(await sessions.keepAlive()).toEqual({ checked: 1, signedOut: [] });

    // Tasterr ends the session and no login is saved: marked signed out, the panel asks for Plex.
    tasterr.signOutAll();
    expect(await sessions.keepAlive()).toEqual({ checked: 1, signedOut: ["Tasterr"] });
    expect(await status()).toMatchObject({ signedIn: false, how: "plex-pin" });
    expect((await call("GET", "/api/audit?limit=5")).json<{ action: string }[]>()[0]!.action).toBe(
      "Tasterr ended Hearth's Plex sign-in; it needs Sign in with Plex on its panel again",
    );
    await expect(read("/api/v1/home/rows")).rejects.toThrow(/Sign Hearth in to Tasterr above/);

    // Signed in with Plex again, then the session ends while a local login is saved too: Hearth
    // signs in again by itself, with no Allow needed.
    await call("POST", `/api/services/${id}/sign-in`, { how: "plex-pin" });
    await vi.waitFor(async () => expect((await status()).signedIn).toBe(true), {
      timeout: 10_000,
      interval: 250,
    });
    await call("POST", "/api/vault/secrets", {
      name: "Tasterr login",
      kind: "login",
      tier: "automation",
      serviceId: id,
      username: FAKE_TASTERR_LOGIN.email,
      value: FAKE_TASTERR_LOGIN.password,
    });
    tasterr.signOutAll();
    const rows = await read("/api/v1/home/rows");
    expect(rows.ok).toBe(true);
    expect(await status()).toMatchObject({ signedIn: true, how: "login" });

    // A way the app doesn't offer is refused plainly.
    const other = await call("POST", "/api/services", {
      name: "Some app",
      kind: "web",
      address: "192.168.1.52:8221",
      category: "Media",
    });
    const otherId = other.json<{ id: string }>().id;
    expect((await call("GET", `/api/services/${otherId}/sign-in`)).json()).toEqual({
      signedIn: false,
    });
    const refused = await call("POST", `/api/services/${otherId}/sign-in`, { how: "plex-pin" });
    expect(refused.statusCode).toBe(409);
  }, 40_000);

  it("links a saved key to its app by name or address, and adds an app Hearth didn't know", async () => {
    const { call, workspace } = await realEnvironment();
    const save = (body: Record<string, unknown>) =>
      call("POST", "/api/vault/secrets", { kind: "api-key", tier: "automation", ...body });
    const ws = await workspace();
    const sonarr = ws.services.find((s) => s.name === "Sonarr")!;

    // By its name: one Sonarr, so the key is Sonarr's.
    const byName = await save({ name: "Sonarr API key", value: "sonarr-key-0123456789" });
    expect(byName.statusCode, byName.body).toBe(200);
    expect(byName.json()).toMatchObject({
      serviceId: sonarr.id,
      linked: { name: "Sonarr", added: false },
    });

    // By its address, whatever the name says.
    const byAddress = await save({
      name: "Downloads key",
      value: "another-key-0123456789",
      endpoint: sonarr.localUrl,
    });
    expect(byAddress.json()).toMatchObject({ serviceId: sonarr.id, linked: { name: "Sonarr" } });

    // An app Hearth doesn't know yet: its address adds it, checked straight away, no rescan.
    const emby = await save({
      name: "Emby API key",
      value: "emby-key-0123456789",
      endpoint: "192.168.1.60:8096",
    });
    expect(emby.json()).toMatchObject({ linked: { name: "Emby", added: true } });
    const added = (await workspace()).services.find((s) => s.name === "Emby");
    expect(added).toMatchObject({ localUrl: "http://192.168.1.60:8096", category: "Media" });
    expect(emby.json<{ serviceId: string }>().serviceId).toBe(added!.id);

    // Nothing to go on: saved, not linked. And a key you linked yourself stays yours.
    const plain = await save({ name: "Router login", value: "router-0123456789" });
    expect(plain.json()).not.toHaveProperty("linked");
    expect(plain.json<{ serviceId?: string }>().serviceId).toBeUndefined();
    const mine = await save({ name: "Sonarr key", value: "x-0123456789", serviceId: added!.id });
    expect(mine.json()).toMatchObject({ serviceId: added!.id });
    expect(mine.json()).not.toHaveProperty("linked");
  });

  it("adds a container, and a later scan that finds it keeps the one you added", async () => {
    const { call, workspace } = await realEnvironment();
    // A stopped container is not ticked by default, so discovery left it out.
    const added = await call("POST", "/api/services", {
      name: "Audiobook backups",
      kind: "container",
      address: "audiobookshelf-backup",
      category: "Files & Photos",
    });
    expect(added.statusCode, added.body).toBe(201);
    const id = added.json<{ id: string }>().id;
    expect((await workspace()).services.find((s) => s.id === id)).toMatchObject({
      kind: "container",
      container: "audiobookshelf-backup",
      autonomyArea: "storage",
    });

    await rescan(call, (f) => f.sourceName !== "photos_db");
    const copies = (await workspace()).services.filter(
      (s) => s.container === "audiobookshelf-backup",
    );
    expect(copies.map((s) => s.id)).toEqual([id]);

    const twice = await call("POST", "/api/services", {
      name: "Sonarr copy",
      kind: "container",
      address: "sonarr",
      category: "Automation",
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ message: string }>().message).toMatch(
      /already watches that container as Sonarr/,
    );
  });

  it("explains what is wrong with a system it cannot add", async () => {
    const { call } = await realEnvironment();
    const tries: [Record<string, unknown>, RegExp][] = [
      [{ name: "", kind: "web", address: "nas.local", category: "Home" }, /Give it a name/],
      [
        { name: "X", kind: "container", address: "has spaces", category: "Home" },
        /exactly as Docker/,
      ],
      [{ name: "X", kind: "web", address: "", category: "Home" }, /Enter its web address/],
      [{ name: "X", kind: "web", address: "ftp://nas.local", category: "Home" }, /http:\/\//],
      [{ name: "X", kind: "web", address: "http://me:pw@nas.local", category: "Home" }, /username/],
      [{ name: "X", kind: "web", address: "nas.local", category: "Toys" }, /./],
      [
        { name: "X", kind: "web", address: "nas.local", category: "Home", hostId: "nope" },
        /machine/,
      ],
    ];
    for (const [body, why] of tries) {
      const res = await call("POST", "/api/services", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatch(why);
    }
    // Something else needs no address: it is listed, with nothing to check.
    const other = await call("POST", "/api/services", {
      name: "Garage door",
      kind: "other",
      address: "",
      category: "Home",
    });
    expect(other.statusCode, other.body).toBe(201);
  });

  it("keeps a removed system out of the AI's view", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    const report = (await app.call("POST", "/api/discovery/scan")).json<DiscoveryReport>();
    await app.call("POST", "/api/discovery/adopt", {
      reportId: report.id,
      selections: report.findings
        .filter((f) => f.selectedByDefault)
        .map((f) => ({ key: f.key, name: f.name })),
    });
    const sonarr = (await app.workspace()).services.find((s) => s.name === "Sonarr")!;
    await app.call("POST", `/api/services/${sonarr.id}/remove`);

    let seen = "";
    agentScript = async ({ call }) => {
      seen = [
        await call("list_services"),
        await call("get_overview"),
        await call("get_service", { serviceId: sonarr.id }),
      ].join("\n");
      return "ok";
    };
    await app.call("POST", "/api/agent/conversations", { text: "What do you watch?" });
    expect(seen).toContain("Prowlarr");
    expect(seen).not.toContain("Sonarr");
  });
});

describe("the AI's look and name", () => {
  const voiceConfig = async (app: Awaited<ReturnType<typeof makeApp>>) => {
    const v = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    return { host: v.host, sttPort: v.sttPort, ttsPort: v.ttsPort, profiles: v.profiles };
  };
  // A tiny real PNG (1 by 1).
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360f8cfc0f01f0005fe02fea7d6a4f30000000049454e44ae426082",
    "hex",
  ).toString("base64");

  it("lets a profile use any gallery look or your own picture, and nothing from elsewhere", async () => {
    const app = await makeApp();
    const config = await voiceConfig(app);
    const withAvatar = (avatar: string) => ({
      ...config,
      profiles: config.profiles.map((p) => (p.id === "warden" ? { ...p, avatar } : p)),
    });
    for (const ok of ["/avatars/scholar-3.webp", "/archetypes/companion.webp", "/api/ai/avatar"])
      expect((await app.call("PUT", "/api/voice", withAvatar(ok))).statusCode, ok).toBe(204);
    for (const refused of [
      "https://example.com/face.webp",
      "/avatars/../../etc/passwd.webp",
      "/avatars/scholar-3.png",
      "/api/owner/avatar",
    ]) {
      const res = await app.call("PUT", "/api/voice", withAvatar(refused));
      expect(res.statusCode, refused).toBe(400);
      expect(res.body).toMatch(/not one of Hearth's pictures/);
    }
  });

  it("ships the ten Ember pictures, and keeps the retired ones' files so no address breaks", () => {
    const pub = (p: string) => new URL(`../../web/public${p}`, import.meta.url);
    for (const l of EMBER_LOOKS) expect(fs.existsSync(pub(l.path)), l.path).toBe(true);
    for (const old of [
      "/avatars/ember.webp",
      "/archetypes/guardian.webp",
      "/avatars/scholar-3.webp",
    ])
      expect(fs.existsSync(pub(old)), old).toBe(true);
  });

  it("starts every install on Classic Ember, and shows a retired picture as Classic Ember", async () => {
    const fresh = await makeApp();
    expect((await fresh.call("GET", "/api/workspace")).json<Workspace>().aiLookStyle).toBe("ember");
    const ember = (await fresh.call("GET", "/api/voice")).json<VoiceStatus>();
    for (const id of ["warden", "operator", "enchantress", "scholar", "companion"])
      expect(ember.profiles.find((p) => p.id === id)!.avatar, id).toBe(
        "/avatars/ember-classic.webp",
      );

    // An install claimed before Hearth: migration 0048 marks it classic, exactly once.
    const handle = await freshDb();
    const old = await makeApp({ handle });
    expect(handle.sqlite.prepare("SELECT count(*) AS n FROM owner").get()).toEqual({ n: 1 });
    const sql = fs.readFileSync(
      new URL("../drizzle/0048_classic_looks_existing_installs.sql", import.meta.url),
      "utf8",
    );
    handle.sqlite.exec(sql);
    handle.sqlite.exec(sql);
    expect(await getSetting(handle.db, "ai_look_style")).toBe("classic");
    expect((await old.call("GET", "/api/workspace")).json<Workspace>().aiLookStyle).toBe("classic");
    const classic = (await old.call("GET", "/api/voice")).json<VoiceStatus>();
    // The characters' own pictures were retired (46.16): Classic Ember, with nothing saved changed.
    expect(classic.profiles.find((p) => p.id === "operator")!.avatar).toBe(
      "/avatars/ember-classic.webp",
    );
    expect(classic.profiles.find((p) => p.id === "companion")!.avatar).toBe(
      "/avatars/ember-classic.webp",
    );
    // A picture someone saved is theirs either way.
    expect(
      (
        await old.call("PUT", "/api/voice", {
          ...(await voiceConfig(old)),
          profiles: classic.profiles.map((p) =>
            p.id === "operator" ? { ...p, avatar: "/avatars/ember-cosmic.webp" } : p,
          ),
        })
      ).statusCode,
    ).toBe(204);
    const kept = (await old.call("GET", "/api/voice")).json<VoiceStatus>();
    expect(kept.profiles.find((p) => p.id === "operator")!.avatar).toBe(
      "/avatars/ember-cosmic.webp",
    );
    // A picture saved before the change stays saved; it shows as Classic Ember.
    const before = await getSetting(handle.db, "voice_config");
    await setSetting(handle.db, "voice_config", {
      ...before!,
      profiles: before!.profiles.map((p) =>
        p.id === "scholar" ? { ...p, avatar: "/avatars/scholar-3.webp" } : p,
      ),
    });
    const shown = (await old.call("GET", "/api/voice")).json<VoiceStatus>();
    expect(shown.profiles.find((p) => p.id === "scholar")!.avatar).toBe(
      "/avatars/ember-classic.webp",
    );
    expect(
      (await getSetting(handle.db, "voice_config"))!.profiles.find((p) => p.id === "scholar")!
        .avatar,
    ).toBe("/avatars/scholar-3.webp");
  });

  it("keeps your AI's own picture, checks it, and falls back to the default when removed", async () => {
    const app = await makeApp();
    expect((await app.call("GET", "/api/ai/avatar")).statusCode).toBe(404);
    expect((await app.call("PUT", "/api/ai/avatar", { data: "aGVsbG8=" })).statusCode).toBe(400);
    const big = Buffer.alloc(301 * 1024, 0xff);
    big[0] = 0xff;
    big[1] = 0xd8;
    expect(
      (await app.call("PUT", "/api/ai/avatar", { data: big.toString("base64") })).body,
    ).toMatch(/under 300 KB/);

    const put = await app.call("PUT", "/api/ai/avatar", { data: PNG });
    expect(put.statusCode, put.body).toBe(200);
    const got = await app.call("GET", "/api/ai/avatar");
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.call("GET", "/api/workspace")).json<Workspace>().aiAvatarAt).toBeTruthy();

    // Two profiles use it; removing it puts each back on its own default.
    const config = await voiceConfig(app);
    await app.call("PUT", "/api/voice", {
      ...config,
      active: "operator",
      profiles: config.profiles.map((p) =>
        p.id === "operator" || p.id === "scholar" ? { ...p, avatar: "/api/ai/avatar" } : p,
      ),
    });
    expect((await app.call("DELETE", "/api/ai/avatar")).statusCode).toBe(204);
    const after = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    // Back to the default: Classic Ember.
    expect(after.profiles.find((p) => p.id === "operator")!.avatar).toBe(
      "/avatars/ember-classic.webp",
    );
    expect(after.profiles.find((p) => p.id === "scholar")!.avatar).toBe(
      "/avatars/ember-classic.webp",
    );
    expect((await app.call("GET", "/api/ai/avatar")).statusCode).toBe(404);
    expect((await app.call("GET", "/api/workspace")).json<Workspace>().aiAvatarAt).toBeUndefined();
    expect((await app.audit()).map((a) => a.action)).toEqual(
      expect.arrayContaining(["Gave your AI its own picture", "Removed your AI's own picture"]),
    );
  });

  it("brings saved built-in personas up to date without their old names, and keeps edited ones", async () => {
    const app = await makeApp();
    const config = await voiceConfig(app);
    await app.call("PUT", "/api/voice", config);
    // As an older install saved them: the first wording named each character.
    const named = config.profiles.map((p) =>
      p.id === "warden"
        ? {
            ...p,
            persona:
              "Warden, Guardian of Ember: an ancient dragon's calm, intelligent, deliberate presence. Confident and authoritative, warm enough for long troubleshooting, with an occasional dry humor. Measured sentences; no theatrical monologues, no growling.",
          }
        : p.id === "scholar"
          ? { ...p, persona: "The Scholar, but terser: my own words." }
          : p,
    );
    app.handle.sqlite
      .prepare("UPDATE settings SET value = ? WHERE key = 'voice_config'")
      .run(JSON.stringify({ ...config, profiles: named }));
    const profiles = (await app.call("GET", "/api/voice")).json<VoiceStatus>().profiles;
    expect(profiles.find((p) => p.id === "warden")!.persona).toMatch(
      /^An ancient dragon's calm, intelligent, deliberate presence\./,
    );
    // The owner's own edit stays exactly as written.
    expect(profiles.find((p) => p.id === "scholar")!.persona).toBe(
      "The Scholar, but terser: my own words.",
    );
  });

  it("is called Ember until named, whatever the voice, and a saved name is never replaced", async () => {
    const app = await makeApp();
    const ws = async () => (await app.call("GET", "/api/workspace")).json<Workspace>();
    expect((await ws()).aiName).toBeUndefined();
    const config = await voiceConfig(app);
    for (const active of ["operator", "companion"]) {
      await app.call("PUT", "/api/voice", { ...config, active });
      // No name is written, so it stays Ember (aiDisplayName).
      expect((await ws()).aiName).toBeUndefined();
    }

    // A name the owner saved (an existing install's "Warden") stays through any profile change.
    await app.call("PATCH", "/api/settings", { aiName: "Warden" });
    await app.call("PUT", "/api/voice", { ...config, active: "enchantress" });
    expect((await ws()).aiName).toBe("Warden");
    // Clearing it goes back to Ember, and says so.
    await app.call("PATCH", "/api/settings", { aiName: "" });
    expect((await ws()).aiName).toBeUndefined();
    expect((await app.audit()).map((a) => a.action)).toContain(
      "Gave your AI administrator back its default name, Ember",
    );
  });
});

describe("getting started and Meet Ember", () => {
  type List = import("@dragon-control/core").GettingStarted;
  const list = async (app: Awaited<ReturnType<typeof makeApp>>) =>
    (await app.call("GET", "/api/getting-started")).json<List>();
  const item = (l: List, id: string) => l.items.find((i) => i.id === id);

  it("is built from the installation's real state and ticks itself as things get done", async () => {
    const env = await realEnvironment();
    let l = await list(env);
    expect(item(l, "adopt")!.done).toBe(true);
    // Each adopted app that needs a key to be read has its own step, with where to find it.
    const sonarr = (await env.workspace()).services.find((s) => s.name === "Sonarr")!;
    expect(item(l, `key:${sonarr.id}`)).toMatchObject({
      title: "Add Sonarr's key in Secure Vault",
      detail: "How to get it: Settings > General > Security > API Key",
      done: false,
    });
    expect(item(l, "notifications")!.done).toBe(false);
    expect(item(l, "operator")!.done).toBe(false);

    // A key Hearth cannot use on its own (Protected) does not count, and says why.
    const now = new Date().toISOString();
    const addKey = env.handle.sqlite.prepare(
      "INSERT INTO vault_secrets (id, name, kind, tier, service_id, ciphertext, created_at, updated_at) VALUES (?, ?, 'api-key', ?, ?, 'x', ?, ?)",
    );
    addKey.run("s0", "Sonarr API key (protected)", "protected", sonarr.id, now, now);
    l = await list(env);
    expect(item(l, `key:${sonarr.id}`)).toMatchObject({ done: false });
    expect(item(l, `key:${sonarr.id}`)!.detail).toContain("save it as Automation");

    // A key it can use, and a notification channel set up: both tick.
    addKey.run("s1", "Sonarr API key", "automation", sonarr.id, now, now);
    env.handle.sqlite.exec(
      "UPDATE notification_channels SET status = 'configured' WHERE id = (SELECT id FROM notification_channels LIMIT 1)",
    );
    l = await list(env);
    expect(item(l, `key:${sonarr.id}`)!.done).toBe(true);
    expect(item(l, "notifications")!.done).toBe(true);
  });

  it("lets the owner dismiss an item or the whole list, and bring them back", async () => {
    const app = await makeApp({ scenario: "calm" });
    // Sample data is not the owner's systems: nothing adopted, and no key steps for it.
    let l = await list(app);
    expect(item(l, "adopt")!.done).toBe(false);
    expect(l.items.some((i) => i.kind === "key")).toBe(false);

    expect(
      (await app.call("PATCH", "/api/getting-started", { dismiss: "backup-copy" })).statusCode,
    ).toBe(204);
    l = await list(app);
    expect(item(l, "backup-copy")!.dismissed).toBe(true);
    await app.call("PATCH", "/api/getting-started", { restore: "backup-copy", hidden: true });
    l = await list(app);
    expect(item(l, "backup-copy")!.dismissed).toBe(false);
    expect(l.hidden).toBe(true);
    expect((await app.call("PATCH", "/api/getting-started", { dismiss: "nope" })).statusCode).toBe(
      400,
    );
  });

  it("Meet Ember: needs the operator, introduces itself, checks up read only, and saves nothing unasked", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    const refused = await app.call("POST", "/api/agent/meet", {});
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatch(/Connect an AI service first/);
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);

    // A run that fails is not a meeting: the step stays, so it is offered again.
    agentScript = async () => {
      throw new Error("Claude Code is not signed in.");
    };
    expect((await app.call("POST", "/api/agent/meet", {})).statusCode).toBe(200);
    await app.agents.idle();
    expect(item(await list(app), "meet")!.done).toBe(false);

    const calls: string[] = [];
    agentScript = async ({ call }) => {
      for (const check of ["get_overview", "list_services", "vault_status", "backup_status"]) {
        calls.push(check);
        await call(check);
      }
      // Even if it tried, nothing is planned in this answer.
      calls.push(await call("restart_service", { serviceId: "plex", reason: "A test." }));
      return "Hello, I am Ember. Set up and healthy: ... Missing or broken: ... My top three next steps: 1. 2. 3.";
    };
    const met = await app.call("POST", "/api/agent/meet", {});
    expect(met.statusCode, met.body).toBe(200);
    await app.agents.idle();
    const run = agentRuns.at(-1)!.system;
    expect(run).toMatch(/^You are Ember, the AI administrator/);
    expect(run).toContain('This is the owner\'s first proper conversation with you ("Meet Ember")');
    expect(run).toContain("never do: change anything without the owner approving the exact plan");
    expect(run).toContain(
      "list_findings, get_overview, list_services, storage_overview, vault_status, app_health, and backup_status",
    );
    expect(calls.at(-1)).toMatch(/^Not now/);
    expect(item(await list(app), "meet")!.done).toBe(true);
    const conversationId = met.json<{ conversationId: string }>().conversationId;

    // "No thanks": the AI may try, but nothing is saved.
    let saved = "";
    agentScript = async ({ call }) => {
      saved = await call("save_todo", {
        title: "Set up notifications",
        category: "task",
        description: "x",
      });
      return "Fine.";
    };
    await app.call("POST", "/api/agent/conversations", { text: "No thanks", conversationId });
    await app.agents.idle();
    expect(saved).not.toMatch(/^Saved/);
    expect(
      (await app.call("GET", "/api/todos")).json<{ items?: unknown[] } | unknown[]>(),
    ).toSatisfy(
      (r) => (Array.isArray(r) ? r : ((r as { items?: unknown[] }).items ?? [])).length === 0,
    );

    // "Add them to my list": saved, under the usual to-do rules.
    await app.call("POST", "/api/agent/conversations", {
      text: "Add them to my list",
      conversationId,
    });
    await app.agents.idle();
    expect(saved).toMatch(/#\d+/);
  });
});

describe("any look with any voice, and what this machine can run", () => {
  const voiceConfig = async (app: Awaited<ReturnType<typeof makeApp>>) => {
    const v = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    return { host: v.host, sttPort: v.sttPort, ttsPort: v.ttsPort, profiles: v.profiles };
  };

  it("accepts any look with any voice, and keeps each built-in voice's gender", async () => {
    const app = await makeApp();
    const config = await voiceConfig(app);
    expect(config.profiles.find((p) => p.id === "scholar")!.gender).toBe("masculine");
    const withLook = (id: string, avatar: string, profiles = config.profiles) => ({
      ...config,
      profiles: profiles.map((p) => (p.id === id ? { ...p, avatar } : p)),
    });
    // The owner chooses the voice, then the appearance: no pairing is refused.
    for (const [id, look] of [
      ["scholar", "/avatars/ember-chatty.webp"],
      ["enchantress", "/avatars/ember-arcane.webp"],
      ["operator", "/avatars/ember-it.webp"],
      ["warden", "/avatars/ember-gamer.webp"],
      ["companion", "/avatars/ember-cozy.webp"],
    ]) {
      expect((await app.call("PUT", "/api/voice", withLook(id!, look!))).statusCode, look).toBe(
        204,
      );
      const saved = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
      expect(saved.profiles.find((p) => p.id === id)!.avatar, look).toBe(look);
    }
    // A client that leaves the gender out still gets each built-in voice's own.
    const bare = config.profiles.map(({ gender: _g, ...p }) => p);
    expect(
      (await app.call("PUT", "/api/voice", withLook("operator", "/avatars/scholar-2.webp", bare)))
        .statusCode,
    ).toBe(204);
    const after = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    expect(after.profiles.find((p) => p.id === "operator")!.gender).toBe("feminine");
  });

  it("says what this machine can run for voice, before anything is installed", async () => {
    const app = await makeApp();
    const v = (await app.call("GET", "/api/voice")).json<VoiceStatus>();
    expect(["none", "speak", "full", "best"]).toContain(v.machine!.level);
    expect(v.machine!.found[0]).toMatch(/processor cores?$/);
    expect(v.machine!.summary).toMatch(/Ember/);
  });
});

describe("help me build: the homelab plan", () => {
  const previous = process.env.DC_FAKE_DISCOVERY;
  beforeAll(() => {
    process.env.DC_FAKE_DISCOVERY = "1";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.DC_FAKE_DISCOVERY;
    else process.env.DC_FAKE_DISCOVERY = previous;
  });

  it("looks at the machine only when asked, saves as it goes, and ticks Getting started when finished", async () => {
    const app = await makeApp();
    const first = (await app.call("GET", "/api/plan")).json<{
      scan: HostScan | null;
      saved: null;
    }>();
    expect(first).toEqual({ saved: null, scan: null });

    const scan = (await app.call("POST", "/api/plan/scan", {})).json<HostScan>();
    expect(scan).toMatchObject({ hostname: "sample-server", platform: "linux", docker: true });
    expect(scan.disks[1]!.media).toMatchObject({ videos: 412 });
    // Sample data is never reported as apps already running on this computer.
    expect(scan.running).toEqual([]);

    const answers = { wants: ["watch", "request"], devices: ["roku"], budget: "free" };
    // Saved as they go: not finished yet, so Getting started is not ticked.
    expect((await app.call("PUT", "/api/plan", { answers })).statusCode).toBe(200);
    let gs = (await app.call("GET", "/api/getting-started")).json<GettingStarted>();
    expect(gs.items.find((i) => i.id === "plan")).toMatchObject({ done: false });

    const put = await app.call("PUT", "/api/plan", {
      answers,
      chosen: { "media-app": "plex" },
      removed: ["sonarr"],
      confirmed: true,
    });
    expect(put.statusCode, put.body).toBe(200);
    const saved = (await app.call("GET", "/api/plan")).json<{ saved: Record<string, unknown> }>();
    expect(saved.saved).toMatchObject({
      answers,
      chosen: { "media-app": "plex" },
      removed: ["sonarr"],
      confirmed: true,
      scan: { hostname: "sample-server" },
    });
    expect((await app.audit()).map((a) => a.action)).toContain("Saved your homelab plan");
    gs = (await app.call("GET", "/api/getting-started")).json<GettingStarted>();
    expect(gs.items.find((i) => i.id === "plan")).toMatchObject({ done: true });
  });

  it("keeps the account details for the plan's apps, with a chosen password only in Secure Vault", async () => {
    const app = await makeApp();
    expect((await app.call("GET", "/api/plan/accounts")).json()).toBeNull();
    const secret = "correct horse battery staple";
    const put = await app.call("PUT", "/api/plan/accounts", {
      email: "sam@example.com",
      username: "sam",
      passwords: "own",
      password: secret,
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.body).not.toContain(secret);
    const got = await app.call("GET", "/api/plan/accounts");
    expect(got.json()).toMatchObject({
      email: "sam@example.com",
      username: "sam",
      passwords: "own",
    });
    expect(got.body).not.toContain(secret);
    // In the vault as a login, never in the settings, the audit log, or the workspace.
    const secrets = await app.vault.list();
    expect(secrets).toContainEqual(
      expect.objectContaining({ name: "Homelab apps: your password", username: "sam" }),
    );
    expect(JSON.stringify(await app.audit())).not.toContain(secret);
    expect((await app.call("GET", "/api/workspace")).body).not.toContain(secret);

    // Switching to one generated password per app removes the stored one.
    await app.call("PUT", "/api/plan/accounts", {
      email: "sam@example.com",
      username: "sam",
      passwords: "generate",
    });
    const after = await app.vault.list();
    expect(after.map((x) => x.name)).not.toContain("Homelab apps: your password");

    // Checked: a real email, a sensible username, a long enough password.
    for (const bad of [
      { email: "nope", username: "sam", passwords: "generate" },
      { email: "sam@example.com", username: "a", passwords: "generate" },
      { email: "sam@example.com", username: "sam", passwords: "own", password: "short" },
      { email: "sam@example.com", username: "sam", passwords: "own" },
    ])
      expect((await app.call("PUT", "/api/plan/accounts", bad)).statusCode).toBe(400);
  });

  it("accepts only the questionnaire's own answers", async () => {
    const app = await makeApp();
    for (const answers of [
      { wants: ["mine bitcoin"], devices: [] },
      { wants: [], devices: [], quality: "8k" },
      { wants: [], devices: [], extra: 1 },
      { wants: [], devices: [], priorities: ["mine bitcoin"] },
      { wants: [], devices: [], dedicated: "maybe" },
    ])
      expect((await app.call("PUT", "/api/plan", { answers, removed: [] })).statusCode).toBe(400);
  });

  it("gives the plan to Ember as context, saying nothing in it is installed", async () => {
    const app = await makeApp({ listen: true });
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    await app.call("POST", "/api/plan/scan", {});
    await app.call("PUT", "/api/plan", {
      answers: { wants: ["photos"], devices: [], experience: "new", pace: "teach" },
      confirmed: true,
    });
    agentScript = async () => "Noted.";
    agentPrompts.length = 0;
    await app.call("POST", "/api/agent/conversations", { text: "What should I set up next?" });
    await app.agents.idle();
    const prompt = agentPrompts.join(" ");
    expect(prompt).toMatch(
      /homelab plan \(Help me build, finished .*; planned only, nothing installed by it\)\. Starter: Immich, Backups\..*brand new to this: explain simply, and want to be taught each step/,
    );
    // Every goal they stated is named, and anything not fully met comes with its reason.
    expect(prompt).toMatch(
      /What they asked for: "Keep my phone's photos safe at home" \((included|partial)\)/,
    );
  });

  it("still opens a plan saved before goals, priorities, and decisions existed", async () => {
    // The exact shape stage 1 saved (deployed 2026-10-15): no decisions, no priorities, no
    // "only a server" answer, and the old combined music-and-books wish.
    const handle = await freshDb();
    await setSetting(handle.db, "homelab_plan", {
      answers: {
        wants: ["watch", "request", "music", "books"],
        devices: ["roku"],
        experience: "new",
        budget: "free",
        existingServer: "plex",
      },
      scan: fakeHostScan([]),
      chosen: { "media-app": "plex" },
      removed: ["sonarr"],
      confirmed: true,
      savedAt: "2026-10-15T20:00:00.000Z",
    } as never);
    const app = await makeApp({ handle, listen: true });
    const got = await app.call("GET", "/api/plan");
    expect(got.statusCode).toBe(200);
    expect(got.json<{ saved: { decisions?: unknown } }>().saved.decisions).toBeUndefined();
    // Ember can still read it, with every goal and the left-out app explained.
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    agentScript = async () => "Noted.";
    agentPrompts.length = 0;
    await app.call("POST", "/api/agent/conversations", { text: "Where is my plan at?" });
    await app.agents.idle();
    const prompt = agentPrompts.join(" ");
    expect(prompt).toMatch(/What they asked for: "Watch my own movies/);
    expect(prompt).toMatch(/Read my ebooks and comics/);
    expect(prompt).toMatch(/You left out Sonarr/);
    // Saving it again (as the plan page does) upgrades it in place, keeping their choices.
    const again = await app.call("PUT", "/api/plan", {
      answers: got.json<{ saved: { answers: unknown } }>().saved.answers,
      chosen: { "media-app": "plex" },
      removed: ["sonarr"],
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      confirmed: true,
      removed: ["sonarr"],
      decisions: {},
    });
  });

  it("keeps their decisions on goals, dated here, and records an informed override", async () => {
    const app = await makeApp();
    await app.call("POST", "/api/plan/scan", {});
    const answers = { wants: ["photos", "ai"], devices: [] };
    const first = await app.call("PUT", "/api/plan", {
      answers,
      decisions: { "want:ai": "include", "want:photos": "later" },
    });
    expect(first.statusCode).toBe(200);
    const saved = first.json<{ decisions: Record<string, { choice: string; at: string }> }>();
    expect(saved.decisions["want:ai"]!.choice).toBe("include");
    expect(saved.decisions["want:ai"]!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    const audit = (await app.audit()).map((a) => a.action);
    expect(audit).toContainEqual(
      'Chose to include "Try running AI at home" in your homelab plan anyway, after seeing the risks (plan only, nothing installed)',
    );
    // Saving again keeps when they decided, and doesn't record the override twice.
    const again = await app.call("PUT", "/api/plan", {
      answers,
      decisions: { "want:ai": "include" },
    });
    expect(again.json<typeof saved>().decisions["want:ai"]!.at).toBe(
      saved.decisions["want:ai"]!.at,
    );
    expect((await app.audit()).filter((a) => a.action.startsWith("Chose to include"))).toHaveLength(
      1,
    );
    // Only the three choices, and nothing about installing.
    expect(
      (
        await app.call("PUT", "/api/plan", {
          answers,
          decisions: { "want:ai": "install-now" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("tells Ember about a wish the plan can't fully meet, so it is never taken as dropped", async () => {
    const app = await makeApp({ listen: true });
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    await app.call("POST", "/api/plan/scan", {});
    await app.call("PUT", "/api/plan", {
      answers: { wants: ["watch", "ai"], devices: [], existingServer: "emby" },
      removed: ["ollama"],
    });
    agentScript = async () => "Noted.";
    agentPrompts.length = 0;
    await app.call("POST", "/api/agent/conversations", { text: "What about my plan?" });
    await app.agents.idle();
    const prompt = agentPrompts.join(" ");
    expect(prompt).toMatch(/Not fully met, and why \(never imply these were dropped/);
    expect(prompt).toMatch(/Try running AI at home: declined\. You chose to leave out Ollama/);
    expect(prompt).toMatch(/I already use Emby: substituted\. Hearth can't set up Emby yet/);
    await app.call("PUT", "/api/plan", {
      answers: { wants: ["watch", "ai"], devices: [], existingServer: "emby" },
      removed: [],
      decisions: { "existing:emby": "accept", "want:ai": "later" },
    });
    agentPrompts.length = 0;
    await app.call("POST", "/api/agent/conversations", { text: "And now?" });
    await app.agents.idle();
    expect(agentPrompts.join(" ")).toMatch(
      /Try running AI at home: deferred \(their decision: saved for later\)/,
    );
  });
});

describe("Connect your AI (setup)", () => {
  it("the welcome resumes where it was left, even after the owner's choices are saved", async () => {
    const app = await makeApp();
    await app.call("PATCH", "/api/settings", { onboardingDone: false });
    // A choice saved on its own (the old rule) means the welcome is not needed...
    await app.call("PATCH", "/api/settings", { ownerName: "Alex" });
    expect((await app.workspace()).onboardingNeeded).toBe(false);
    // ...but once the welcome has been started, it resumes at the saved step until finished.
    expect((await app.call("PATCH", "/api/settings", { onboardingStep: "voice" })).statusCode).toBe(
      204,
    );
    let ws = await app.workspace();
    expect(ws.onboardingNeeded).toBe(true);
    expect(ws.onboardingStep).toBe("voice");
    await app.call("PATCH", "/api/settings", { onboardingDone: true });
    ws = await app.workspace();
    expect(ws.onboardingNeeded).toBe(false);
    // Only step names, never anything else.
    expect(
      (await app.call("PATCH", "/api/settings", { onboardingStep: "../etc" })).statusCode,
    ).toBe(400);
  });

  it("says which account must be signed in, and checks the program for free", async () => {
    const app = await makeApp();
    const info = (await app.call("GET", "/api/agent/setup")).json<AgentSetupInfo>();
    expect(info.runsAs).toBeTruthy();
    expect(info.claudeCommand).toBeTruthy();
    const check = (
      await app.call("POST", "/api/agent/providers/claude-code/check", {})
    ).json<AgentCheck>();
    expect(check.ok).toBe(true);
    expect(agentPrompts).toEqual([]); // no AI request for the free check
    // Services Hearth can't connect to yet are refused, not faked.
    expect((await app.call("POST", "/api/agent/providers/codex/test", {})).statusCode).toBe(400);
    expect((await app.call("POST", "/api/agent/providers/ollama/check", {})).statusCode).toBe(400);
  });

  it("a connection test proves Ember can use Hearth's tools, without connecting it", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    agentScript = async ({ call }) => {
      const overview = JSON.parse(await call("get_overview")) as { servicesTotal: number };
      return `SERVICES=${overview.servicesTotal}`;
    };
    agentSpend = { costUsd: 0.004 };
    const test = (
      await app.call("POST", "/api/agent/providers/claude-code/test", {})
    ).json<AgentConnectionTest>();
    expect(test.installed.ok).toBe(true);
    expect(test.answered?.ok).toBe(true);
    expect(test.tools?.ok, test.tools?.detail).toBe(true);
    expect(test.tools?.detail).toMatch(/reported \d+ systems?, which matches/);
    expect(test.costUsd).toBe(0.004);
    // A test is not a connection: connecting stays the owner's choice.
    const ws = await app.workspace();
    expect(ws.agents.find((a) => a.id === "claude-code")?.status).not.toBe("connected");
    // It ran with a small turn limit and Hearth's test instructions only.
    expect(agentRuns.at(-1)?.limits).toEqual({ maxTurns: 4 });
    expect(agentPrompts.at(-1)).toMatch(/^Hearth connection test\./);
  });

  it("a connection test is read only: one tool, no plans or changes, and its key ends with it", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    const settings = async () =>
      Object.fromEntries(
        (await app.handle.db.select().from(settingsTable)).map((x) => [x.key, x.value]),
      );
    const before = await settings();
    let seen: string[] = [];
    let attempt = "";
    agentScript = async ({ call, list }) => {
      seen = await list();
      // Whatever it tries beyond the overview is not there to call.
      attempt = await call("restart_service", { serviceId: "x" }).catch((e: unknown) => String(e));
      const overview = JSON.parse(await call("get_overview")) as { servicesTotal: number };
      return `SERVICES=${overview.servicesTotal}`;
    };
    const test = (
      await app.call("POST", "/api/agent/providers/claude-code/test", {})
    ).json<AgentConnectionTest>();
    expect(test.tools?.ok).toBe(true);
    expect(seen).toEqual(["get_overview"]);
    expect(attempt).toMatch(/not found|unknown tool|restart_service/i);
    // The key the test used is revoked as soon as it ends.
    const testKeys = (await app.handle.db.select().from(apiTokensTable)).filter((k) =>
      k.name.startsWith("Connection test"),
    );
    expect(testKeys).toHaveLength(1);
    expect(testKeys[0]!.revokedAt).toBeTruthy();
    // Testing, then connecting, changes which AI Ember uses and nothing else: no autonomy,
    // approvals, host access, or credentials come with it.
    expect(
      (await app.call("POST", "/api/agent/providers/claude-code/connect", {})).statusCode,
    ).toBe(204);
    const { operator_agent: operator, ...now } = await settings();
    expect(operator).toBe("claude-code");
    expect(now).toEqual(before);
    expect((await app.workspace()).operator.agentId).toBe("claude-code");
  });

  it("tells signed in apart from able to use Hearth's tools", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    agentScript = async () => "SERVICES=999";
    const wrong = (
      await app.call("POST", "/api/agent/providers/claude-code/test", {})
    ).json<AgentConnectionTest>();
    expect(wrong.answered?.ok).toBe(true);
    expect(wrong.tools?.ok).toBe(false);
    expect(wrong.tools?.detail).toMatch(/reported 999 systems, but Hearth has \d+/);
    agentScript = async () => "Hello!";
    const ignored = (
      await app.call("POST", "/api/agent/providers/claude-code/test", {})
    ).json<AgentConnectionTest>();
    expect(ignored.tools?.ok).toBe(false);
    expect(ignored.tools?.detail).toMatch(/didn't use Hearth's tools/);
  });

  it("explains a program that is installed but not signed in, and one that is not installed", async () => {
    const app = await makeApp({ scenario: "calm", listen: true });
    agentSpend = { text: "", error: "Invalid API key · Please run /login" };
    const signedOut = (
      await app.call("POST", "/api/agent/providers/claude-code/test", {})
    ).json<AgentConnectionTest>();
    expect(signedOut.installed.ok).toBe(true);
    expect(signedOut.answered?.ok).toBe(false);
    expect(signedOut.answered?.detail).toMatch(
      /installed but isn't signed in for the account Hearth runs as/,
    );
    expect(signedOut.tools).toBeUndefined();
    // Never the program's raw output beyond a short line, and never a credential.
    expect(JSON.stringify(signedOut)).not.toMatch(/Bearer|sk-ant/);

    const check = fakeAgent.check;
    fakeAgent.check = async () => ({
      ok: false,
      detail: "Claude Code is not installed on this machine, or not on its PATH.",
    });
    try {
      const missing = (
        await app.call("POST", "/api/agent/providers/claude-code/test", {})
      ).json<AgentConnectionTest>();
      expect(missing.installed.ok).toBe(false);
      expect(missing.answered).toBeUndefined();
      expect(agentPrompts.filter((p) => p.startsWith("Hearth connection test."))).toHaveLength(1);
    } finally {
      fakeAgent.check = check;
    }
  });
});

describe("signing Claude Code in from Hearth (no terminal)", () => {
  it("starts the sign-in, refuses a wrong code, accepts the right one, and signs out", async () => {
    const app = await makeApp();
    const before = (await app.call("GET", "/api/agent/claude/status")).json<{
      loggedIn: boolean;
    }>();
    expect(before.loggedIn).toBe(false);
    const started = (await app.call("POST", "/api/agent/claude/sign-in", {})).json<{
      id: string;
      url: string;
    }>();
    expect(new URL(started.url).hostname).toBe("claude.com");
    const wrong = (
      await app.call("POST", `/api/agent/claude/sign-in/${started.id}/code`, {
        code: "WRONGCODE#x",
      })
    ).json<{ ok: boolean; detail?: string }>();
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toMatch(/did not accept/);
    const right = (
      await app.call("POST", `/api/agent/claude/sign-in/${started.id}/code`, {
        code: TEST_SIGN_IN_CODE,
      })
    ).json<{ ok: boolean; status?: { loggedIn: boolean; email?: string } }>();
    expect(right).toMatchObject({ ok: true, status: { loggedIn: true } });
    // An old sign-in id is not waiting any more.
    const again = (
      await app.call("POST", `/api/agent/claude/sign-in/${started.id}/code`, {
        code: TEST_SIGN_IN_CODE,
      })
    ).json<{ ok: boolean; expired?: boolean }>();
    expect(again).toMatchObject({ ok: false, expired: true });
    const out = (await app.call("POST", "/api/agent/claude/sign-out", {})).json<{
      loggedIn: boolean;
    }>();
    expect(out.loggedIn).toBe(false);
    // Recorded, without any code or token.
    const audit = JSON.stringify((await app.call("GET", "/api/audit")).json());
    expect(audit).toMatch(/Signed Claude Code in from Hearth/);
    expect(audit).not.toContain(TEST_SIGN_IN_CODE);
  });
});

describe("one account: a PC joins your Hearth and is used through it", () => {
  const until = async (ok: () => Promise<boolean> | boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await ok())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  withPremiumPackage(
    "a new PC links with the Hearth API key from the Secure Vault, with its name and icon",
    async () => {
      const hub = await makeApp({ signedIn: false, listen: true, premium: true });
      // Not set up yet: nothing to link to.
      expect((await hub.send("GET", "/api/pcs/hello")).json()).toMatchObject({
        app: "Hearth",
        linkable: false,
      });
      const setup = await hub.send("POST", "/api/auth/setup", {
        code: (await hub.auth.setupCode())!,
        password: TEST_PASSWORD,
      });
      const owner = hub.cookieOf(setup)!;
      expect((await hub.send("GET", "/api/pcs/hello")).json()).toMatchObject({ linkable: true });
      // The key is a protected entry in the vault: revealed with you signed in (and unlocked).
      const { id } = (await hub.send("GET", "/api/vault/hearth-key", undefined, owner)).json<{
        id: string;
      }>();
      const reveal = async () =>
        (await hub.send("POST", `/api/vault/secrets/${id}/reveal`, {}, owner)).json<{
          value: string;
        }>().value;
      const key = await reveal();
      expect(key).toMatch(/^hearth_[A-Za-z0-9]{20}$/);
      // Asking again is the same entry and the same key.
      expect((await hub.send("GET", "/api/vault/hearth-key", undefined, owner)).json()).toEqual({
        id,
      });

      // A wrong key links nothing; the right one gives a one-time join link.
      expect(
        (await hub.send("POST", "/api/pcs/link", { key: "hearth_wrongwrongwrongwron" })).statusCode,
      ).toBe(401);
      await hub.send("PATCH", "/api/pcs/hub", { icon: "dragon" }, owner);
      const res = await hub.send("POST", "/api/pcs/link", { key });
      expect(res.statusCode).toBe(200);
      const linked = res.json<{ joinLink: string; taken: { icon: string }[] }>();
      // Its picker greys out the icons your other PCs use.
      expect(linked.taken.map((t) => t.icon)).toEqual(["dragon"]);
      const code = new URL(linked.joinLink).searchParams.get("code")!;
      const joined = await hub.send("POST", "/api/pcs/join", {
        code,
        name: "Home Vault",
        os: "Windows",
        version: "test",
        install: null,
        icon: "wolf",
      });
      expect(joined.statusCode).toBe(200);
      const pcs = (await hub.send("GET", "/api/pcs", undefined, owner)).json<{
        pcs: { name: string; icon: string | null }[];
      }>().pcs;
      expect(pcs[0]).toMatchObject({ name: "Home Vault", icon: "preset:wolf" });

      // Refresh: a new key; the old one stops linking new PCs, and the linked PC stays.
      expect((await hub.send("POST", "/api/vault/hearth-key/refresh", {}, owner)).json()).toEqual({
        id,
      });
      const fresh = await reveal();
      expect(fresh).not.toBe(key);
      expect((await hub.send("POST", "/api/pcs/link", { key })).statusCode).toBe(401);
      expect((await hub.send("POST", "/api/pcs/link", { key: fresh })).statusCode).toBe(200);
      expect(
        (await hub.send("GET", "/api/pcs", undefined, owner)).json<{ pcs: unknown[] }>().pcs,
      ).toHaveLength(1);
      expect(
        JSON.stringify((await hub.send("GET", "/api/audit", undefined, owner)).json()),
      ).not.toContain(fresh);
    },
  );

  withPremiumPackage(
    "joins with a link, forwards requests and sockets, shows its icon, and is removed cleanly",
    async () => {
      // Your Hearth, set up and listening.
      const hub = await makeApp({ signedIn: false, listen: true, premium: true });
      const setup = await hub.send("POST", "/api/auth/setup", {
        code: (await hub.auth.setupCode())!,
        password: TEST_PASSWORD,
      });
      const owner = hub.cookieOf(setup)!;
      const hubUrl = `http://127.0.0.1:${(hub.app.server.address() as AddressInfo).port}`;

      // A new PC, not set up, with the War Room's engine (the Claude Code stand-in).
      const pc = await makeApp({
        signedIn: false,
        listen: true,
        premium: true,
        engine: (handle, auth, dir) => {
          const e = new Engine({
            db: handle.sqlite,
            dataDir: dir,
            workspaces: path.join(dir, "projects"),
            session: (token) => auth.session(token),
            cookieName: "dc_session",
            fakeRunner: true,
          });
          e.start();
          cleanup.push(() => e.stop());
          return e;
        },
      });

      // Link another Hearth: a join link. Joining from the PC's setup page needs its setup code.
      const made = (await hub.send("POST", "/api/pcs/codes", {}, owner)).json<{ code: string }>();
      const link = `${hubUrl}/join?code=${made.code}`;
      expect(
        (await pc.send("POST", "/api/pcs/join-hub", { link, setupCode: "WRONG-CODE" })).statusCode,
      ).toBe(403);
      const joined = await pc.send("POST", "/api/pcs/join-hub", {
        link,
        setupCode: (await pc.auth.setupCode())!,
      });
      expect(joined.statusCode).toBe(200);
      // The PC is now secured (nobody can claim it) and says which Hearth it belongs to.
      expect(await pc.auth.claimed()).toBe(true);
      const status = (await pc.send("GET", "/api/auth/status")).json<{
        joinedTo: { name: string; url: string } | null;
      }>();
      expect(status.joinedTo?.url).toBe(hubUrl);
      // The link can't be used twice.
      expect(
        (
          await pc.send("POST", "/api/pcs/join", {
            code: made.code,
            name: "x",
            os: "x",
            version: "x",
            install: null,
          })
        ).statusCode,
      ).toBe(401);

      type List = {
        hub: { name: string };
        pcs: {
          id: string;
          name: string;
          online: boolean;
          icon: string | null;
          color: string | null;
        }[];
      };
      const list = async () => (await hub.send("GET", "/api/pcs", undefined, owner)).json<List>();
      await until(async () => (await list()).pcs[0]?.online === true);
      const id = (await list()).pcs[0]!.id;

      // Name and icon: its name shows under the icon in the icon's color.
      expect(
        (await hub.send("PATCH", `/api/pcs/${id}`, { name: "Gaming PC 2", icon: "wolf" }, owner))
          .statusCode,
      ).toBe(204);
      expect((await list()).pcs[0]).toMatchObject({
        name: "Gaming PC 2",
        icon: "preset:wolf",
        color: "#b05cff",
      });
      expect(
        (await hub.send("PATCH", "/api/pcs/hub", { name: "Homeserver", icon: "dragon" }, owner))
          .statusCode,
      ).toBe(204);
      expect((await list()).hub.name).toBe("Homeserver");
      // One icon per PC: the wolf is taken.
      expect(
        (await hub.send("PATCH", "/api/pcs/hub", { icon: "wolf" }, owner)).json<{
          message: string;
        }>().message,
      ).toMatch(/Gaming PC 2 already uses that icon/);

      // Requests to the PC go through your Hearth, as you; never without signing in.
      expect((await hub.send("GET", `/api/on/${id}/engine/health`)).statusCode).toBe(401);
      const health = await hub.send("GET", `/api/on/${id}/engine/health`, undefined, owner);
      expect(health.statusCode).toBe(200);
      const sent = await hub.send(
        "POST",
        `/api/on/${id}/engine/request`,
        { text: "hello from the tablet", project: "sandbox" },
        owner,
      );
      expect(sent.statusCode).toBe(200);
      await until(async () =>
        (
          await hub.send("GET", `/api/on/${id}/engine/projects/sandbox/messages`, undefined, owner)
        ).body.includes("Heard you: hello from the tablet"),
      );

      // The War Room's live connection to the PC, through your Hearth.
      const ws = new WebSocket(`${hubUrl.replace("http", "ws")}/api/on/${id}/api/engine/ws`, {
        headers: { cookie: owner, origin: hubUrl },
      });
      const hello = await new Promise<string>((resolve, reject) => {
        ws.on("message", (m) => resolve(String(m)));
        ws.on("error", reject);
      });
      expect(JSON.parse(hello)).toMatchObject({ type: "hello" });
      ws.close();

      // Remove it: the PC forgets your Hearth and is back to its own setup page.
      expect((await hub.send("DELETE", `/api/pcs/${id}`, undefined, owner)).statusCode).toBe(204);
      await until(async () => !(await pc.auth.claimed()));
      expect(
        (await pc.send("GET", "/api/auth/status")).json<{ joinedTo: unknown }>().joinedTo,
      ).toBe(null);
      expect((await list()).pcs).toHaveLength(0);
      expect(
        (await hub.send("GET", `/api/on/${id}/engine/health`, undefined, owner)).statusCode,
      ).toBe(404);
    },
    30_000,
  );
});

describe("Premium: one purchase covers every linked Hearth (the owner, 11-20)", () => {
  withPremiumPackage(
    "a PC linked to a Premium Hearth gets Premium with no code of its own, and loses it when removed",
    async () => {
      // Your Hearth has Premium (one purchase); the PC has none of its own.
      const hub = await makeApp({ signedIn: false, listen: true, premium: true });
      const owner = hub.cookieOf(
        await hub.send("POST", "/api/auth/setup", {
          code: (await hub.auth.setupCode())!,
          password: TEST_PASSWORD,
        }),
      )!;
      const hubUrl = `http://127.0.0.1:${(hub.app.server.address() as AddressInfo).port}`;
      const pc = await makeApp({ signedIn: false, listen: true, premium: false });
      const pcOwner = pc.cookieOf(
        await pc.send("POST", "/api/auth/setup", {
          code: (await pc.auth.setupCode())!,
          password: TEST_PASSWORD,
        }),
      )!;
      const has = async (a: typeof hub, who: string) =>
        (await a.send("GET", "/api/premium", undefined, who))
          .json<{ features: { feature: string; state: string }[] }>()
          .features.find((f) => f.feature === "ember_show_and_tell")?.state === "active";
      expect(await has(hub, owner)).toBe(true);
      expect(await has(pc, pcOwner)).toBe(false);

      const made = (await hub.send("POST", "/api/pcs/codes", {}, owner)).json<{ code: string }>();
      const joined = await pc.send(
        "POST",
        "/api/pcs/join-hub",
        { link: `${hubUrl}/join?code=${made.code}`, name: "Second-PC" },
        pcOwner,
      );
      expect(joined.statusCode, joined.body).toBe(200);
      const list = async () =>
        (await hub.send("GET", "/api/pcs", undefined, owner)).json<{
          pcs: { id: string; online: boolean }[];
        }>().pcs;
      const until = async (ok: () => Promise<boolean>) => {
        const end = Date.now() + 10_000;
        while (!(await ok())) {
          if (Date.now() > end) throw new Error("timed out");
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await until(async () => (await list())[0]?.online === true);
      // The link carried your Hearth's licence down: Premium on the PC, nothing redeemed there.
      await until(() => has(pc, pcOwner));

      // Removed from your Hearth: the PC goes back to free.
      const id = (await list())[0]!.id;
      expect((await hub.send("DELETE", `/api/pcs/${id}`, undefined, owner)).statusCode).toBe(204);
      await until(async () => !(await has(pc, pcOwner)));
      expect(await has(hub, owner)).toBe(true);
    },
    30_000,
  );
});

describe("one account: a PC set up on its own first joins later", () => {
  withPremiumPackage(
    "its signed-in owner joins it (no setup code), it keeps its account, and gets it back when removed",
    async () => {
      const hub = await makeApp({ signedIn: false, listen: true, premium: true });
      const hubSetup = await hub.send("POST", "/api/auth/setup", {
        code: (await hub.auth.setupCode())!,
        password: TEST_PASSWORD,
      });
      const owner = hub.cookieOf(hubSetup)!;
      const hubUrl = `http://127.0.0.1:${(hub.app.server.address() as AddressInfo).port}`;

      // A PC installed and set up on its own, with its own account.
      const pc = await makeApp({ signedIn: false, listen: true, premium: true });
      const pcSetup = await pc.send("POST", "/api/auth/setup", {
        code: (await pc.auth.setupCode())!,
        password: TEST_PASSWORD,
      });
      const pcOwner = pc.cookieOf(pcSetup)!;
      expect((await pc.send("GET", "/api/pcs/hello")).json()).toMatchObject({ linkable: true });

      const made = (await hub.send("POST", "/api/pcs/codes", {}, owner)).json<{ code: string }>();
      const link = `${hubUrl}/join?code=${made.code}`;
      // Nobody but its signed-in owner can join it.
      expect((await pc.send("POST", "/api/pcs/join-hub", { link })).statusCode).toBe(403);
      const joined = await pc.send(
        "POST",
        "/api/pcs/join-hub",
        { link, name: "Gaming-PC" },
        pcOwner,
      );
      expect(joined.statusCode, joined.body).toBe(200);
      expect(
        (await pc.send("GET", "/api/auth/status")).json<{ joinedTo: { url: string } | null }>()
          .joinedTo?.url,
      ).toBe(hubUrl);
      const list = async () =>
        (await hub.send("GET", "/api/pcs", undefined, owner)).json<{
          pcs: { id: string; name: string; online: boolean }[];
        }>().pcs;
      const until = async (ok: () => Promise<boolean>) => {
        const end = Date.now() + 10_000;
        while (!(await ok())) {
          if (Date.now() > end) throw new Error("timed out");
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      await until(async () => (await list())[0]?.online === true);
      expect((await list())[0]!.name).toBe("Gaming-PC");

      // Removed from your Hearth: it goes back to its own account, not to a setup page.
      const id = (await list())[0]!.id;
      expect((await hub.send("DELETE", `/api/pcs/${id}`, undefined, owner)).statusCode).toBe(204);
      await until(
        async () =>
          (await pc.send("GET", "/api/auth/status")).json<{ joinedTo: unknown }>().joinedTo ===
          null,
      );
      expect(await pc.auth.claimed()).toBe(true);
      expect(
        (await pc.send("POST", "/api/auth/login", { password: TEST_PASSWORD })).statusCode,
      ).toBe(204);
    },
    30_000,
  );
});

describe("copying another Hearth's layout", () => {
  it("copies Homeserver's layout here with its key, matching apps by name, and undoes it", async () => {
    // The home server: its own Hearth, set up, with Sonarr and Kavita, a Lair layout, a browser layout.
    const zh = await freshDb();
    const homeserver = await makeApp({ handle: zh, signedIn: false, listen: true });
    const setup = await homeserver.send("POST", "/api/auth/setup", {
      code: (await homeserver.auth.setupCode())!,
      password: TEST_PASSWORD,
    });
    const zOwner = homeserver.cookieOf(setup)!;
    const zUrl = `http://127.0.0.1:${(homeserver.app.server.address() as AddressInfo).port}`;
    const { id: keyId } = (
      await homeserver.send("GET", "/api/vault/hearth-key", undefined, zOwner)
    ).json<{ id: string }>();
    const key = (
      await homeserver.send("POST", `/api/vault/secrets/${keyId}/reveal`, {}, zOwner)
    ).json<{
      value: string;
    }>().value;
    const addService = async (
      app: Awaited<ReturnType<typeof makeApp>>,
      name: string,
      address: string,
      cookie?: string,
    ) => {
      const body = { name, kind: "web", address, category: "Media" };
      const res = cookie
        ? await app.send("POST", "/api/services", body, cookie)
        : await app.call("POST", "/api/services", body);
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json<{ id: string }>().id;
    };
    // Each Hearth knows its own machine (adding an app needs one).
    const machine = async (h: DbHandle, name: string) =>
      h.db.insert(hostsTable).values({
        id: name.toLowerCase(),
        name,
        role: "server",
        os: "Linux",
        address: "127.0.0.1",
        cpuModel: "x",
        cpuCores: 4,
        cpuUsagePct: 0,
        memTotalGb: 16,
        memUsedGb: 4,
        uptimeHours: 1,
        connection: "this-machine",
        docker: true,
        health: "healthy",
        lastSeenAt: "2026-11-08T00:00:00Z",
      });
    await machine(zh, "Homeserver");
    // Something else took the id "sonarr" on the home server first, so its Sonarr has another id.
    await addService(homeserver, "Sonarr!", "http://10.0.0.5:9999", zOwner);
    const zSonarr = await addService(homeserver, "Sonarr", "http://10.0.0.5:8989", zOwner);
    const zKavita = await addService(homeserver, "Kavita", "http://10.0.0.5:5000", zOwner);
    await homeserver.send(
      "POST",
      "/api/desk/layouts",
      { name: "Media", panels: `service:${zSonarr},service:${zKavita}@logs,tool:storage` },
      zOwner,
    );
    await homeserver.send(
      "PUT",
      "/api/layout/browser",
      {
        values: {
          "hearth-lair-order": JSON.stringify([
            `service:${zSonarr}`,
            `service:${zKavita}`,
            "tool:todo",
          ]),
          "hearth.home-dashboard": JSON.stringify({ clock: "24", shown: ["music", "devices"] }),
          "dc-sidebar-rail": "1",
          "something-else": "never copied",
        },
      },
      zOwner,
    );
    await setSetting(zh.db, "ai_look_style", "classic" as never);

    // Desktop-PC: another Hearth, with Sonarr under its own id, no Kavita, its own layout.
    const dh = await freshDb();
    const dv = await makeApp({ handle: dh });
    await machine(dh, "Desktop-PC");
    const dSonarr = await addService(dv, "Sonarr", "http://10.0.0.9:8989");
    expect(dSonarr).not.toBe(zSonarr);
    await dv.call("POST", "/api/desk/layouts", { name: "Mine", panels: "tool:todo" });

    // A wrong key reads nothing.
    const wrong = await dv.call("POST", "/api/layout/preview", {
      hubUrl: zUrl,
      key: "hearth_notTheRightKey12345",
      parts: ["lair"],
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json<{ message: string }>().message).toMatch(/key is not right/);

    const all = ["lair", "home", "look", "sidebar"];
    const preview = (
      await dv.call("POST", "/api/layout/preview", { hubUrl: zUrl, key, parts: all })
    ).json<{ deskLayouts: string[]; missing: string[]; hasBrowser: boolean }>();
    expect(preview).toMatchObject({
      deskLayouts: ["Media"],
      missing: ["Kavita"],
      hasBrowser: true,
    });

    const copied = await dv.call("POST", "/api/layout/copy", { hubUrl: zUrl, key, parts: all });
    expect(copied.statusCode, copied.body).toBe(200);
    const result = copied.json<{ browser: Record<string, string | null>; missing: string[] }>();
    // Sonarr is this Hearth's Sonarr; Kavita isn't here, so it is left out.
    expect(JSON.parse(result.browser["hearth-lair-order"]!)).toEqual([
      `service:${dSonarr}`,
      "tool:todo",
    ]);
    expect(result.browser["dc-sidebar-rail"]).toBe("1");
    expect(JSON.parse(result.browser["hearth.home-dashboard"]!)).toMatchObject({ clock: "24" });
    expect(result.browser).not.toHaveProperty("something-else");
    const layouts = (await dv.call("GET", "/api/desk/layouts")).json<
      { name: string; panels: string }[]
    >();
    expect(layouts.map((l) => [l.name, l.panels])).toEqual([
      ["Media", `service:${dSonarr},tool:storage`],
    ]);
    expect(await getSetting(dh.db, "ai_look_style")).toBe("classic");

    // Undo: Desktop-PC's own layout is back.
    const undone = await dv.call("POST", "/api/layout/undo", {});
    expect(undone.statusCode, undone.body).toBe(200);
    expect(
      (await dv.call("GET", "/api/desk/layouts")).json<{ name: string }[]>().map((l) => l.name),
    ).toEqual(["Mine"]);
    // Plans can never carry another Hearth's key into a copy.
    const { planRefusal } = await import("./agent/hearth-api");
    expect(planRefusal("POST", "/api/layout/copy", "{}")).toMatch(/Not even/);
  }, 30_000);
});

describe("one account: Ollama is set up once, for every PC", () => {
  const until = async (ok: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  withPremiumPackage(
    "your Hearth passes its Ollama address and model to a PC when it joins, and on each change",
    async () => {
      const engines: Engine[] = [];
      // One Ollama on the network, which both PCs reach.
      const ollama = fakeOllamaFetch();
      const withEngine = (handle: DbHandle, auth: Auth, dir: string) => {
        const e = new Engine({
          db: handle.sqlite,
          dataDir: dir,
          workspaces: path.join(dir, "projects"),
          session: (token) => auth.session(token),
          cookieName: "dc_session",
          fakeRunner: true,
          ollamaFetch: ollama,
        });
        e.start();
        cleanup.push(() => e.stop());
        engines.push(e);
        return e;
      };
      const hub = await makeApp({
        signedIn: false,
        listen: true,
        engine: withEngine,
        premium: true,
      });
      const setup = await hub.send("POST", "/api/auth/setup", {
        code: (await hub.auth.setupCode())!,
        password: TEST_PASSWORD,
      });
      const owner = hub.cookieOf(setup)!;
      const [hubEngine] = engines;
      await hubEngine!.setOllama({ url: "http://ai-box", model: "coder-ready:14b" });

      const pc = await makeApp({ signedIn: false, listen: true, engine: withEngine });
      const pcEngine = engines[1]!;
      expect(pcEngine.ollamaConfig()).toBeNull();
      const hubUrl = `http://127.0.0.1:${(hub.app.server.address() as AddressInfo).port}`;
      const made = (await hub.send("POST", "/api/pcs/codes", {}, owner)).json<{ code: string }>();
      const joined = await pc.send("POST", "/api/pcs/join-hub", {
        link: `${hubUrl}/join?code=${made.code}`,
        setupCode: (await pc.auth.setupCode())!,
      });
      expect(joined.statusCode).toBe(200);
      // Joined: the PC has the same Ollama, and its Ollama tab is ready.
      await until(() => pcEngine.ollamaConfig()?.model === "coder-ready:14b");
      expect(pcEngine.ollamaConfig()?.url).toBe("http://ai-box:11434");
      expect(pcEngine.config().engines.ollama?.enabled).toBe(true);

      // A change on your Hearth reaches the PC too.
      await hubEngine!.prepareOllama("qwen3-coder:30b");
      await until(() => pcEngine.ollamaConfig()?.model === "qwen3-coder-30b-hearth");
    },
  );

  it("an address only one computer can use is not passed on", () => {
    expect(ollamaIsLocalOnly("http://127.0.0.1:11434")).toBe(true);
    expect(ollamaIsLocalOnly("http://localhost:11434")).toBe(true);
    expect(ollamaIsLocalOnly("http://[::1]:11434")).toBe(true);
    expect(ollamaIsLocalOnly("http://192.168.1.50:11434")).toBe(false);
    expect(ollamaIsLocalOnly("http://ai-box:11434")).toBe(false);
  });
});

describe("Hearth Premium at the action boundary (docs/design/PREMIUM.md)", () => {
  it("a free Hearth keeps every free workflow; linking PCs and Show & Tell are refused plainly", async () => {
    const app = await makeApp();
    const st = (await app.call("GET", "/api/premium")).json<{
      features: { feature: string; state: string }[];
      issuer: boolean;
    }>();
    expect(st.features.map((f) => [f.feature, f.state])).toEqual([
      ["hearth_interconnectivity", "free"],
      ["ember_show_and_tell", "free"],
      ["panel_builder", "free"],
    ]);
    expect(st.issuer).toBe(false);
    // Free: signing in a phone or tablet to this Hearth (not another installation).
    expect(
      (await app.call("POST", "/api/devices/codes", { purpose: "device" })).statusCode,
    ).toBeLessThan(300);
    // Premium: adding another Hearth installation, and working on one through this Hearth.
    const add = await app.call("POST", "/api/pcs/codes", {});
    if (PREMIUM_PACKAGE) {
      expect(add.statusCode).toBe(402);
      expect(add.json()).toMatchObject({ error: "PremiumRequired" });
      expect(add.json<{ message: string }>().message).toMatch(
        /Hearth Connected.*Everything you already set up is kept/,
      );
    } else expect(add.statusCode).toBe(404); // Hearth Connected is the Premium package's.
    expect(
      (await app.send("POST", "/api/pcs/link", { key: "hearth_wrongwrongwrongwron" })).statusCode,
    ).toBe(PREMIUM_PACKAGE ? 402 : 404); // Without the package, linking doesn't exist.
    // Show & Tell can't be switched on, and reads as off; the owner's choice of speech is kept.
    // Without the package it doesn't exist (the screen reads that as off).
    const show = await app.call("PUT", "/api/show/settings", { mode: "show" });
    if (PREMIUM_PACKAGE) {
      expect(show.statusCode).toBe(402);
      expect((await app.call("PUT", "/api/show/settings", { speak: true })).statusCode).toBe(200);
      expect((await app.call("GET", "/api/show/settings")).json()).toMatchObject({
        mode: "off",
        premium: false,
        speak: true,
      });
    } else expect(show.statusCode).toBe(404);
    // A code can't be redeemed without the licence service; nothing claims success.
    const redeem = await app.call("POST", "/api/premium/redeem", {
      code: "HRTH-AAAAA-AAAAA-AAAAA-AAAAA",
    });
    expect(redeem.statusCode).toBe(409);
    expect(redeem.json<{ message: string }>().message).toMatch(/licence service/);
    // Nobody signed in (an agent key, a script) sees or changes none of it.
    expect((await app.send("GET", "/api/premium")).statusCode).toBe(401);
    expect((await app.send("POST", "/api/premium/issuer/setup", {})).statusCode).toBe(401);
  });

  withPremiumPackage(
    "a Show & Tell licence turns it on; when it is taken back the choice is kept but nothing shows",
    async () => {
      const app = await makeApp();
      await givePremium(app.handle, { features: ["ember_show_and_tell"], id: "lic-show" });
      expect((await app.call("PUT", "/api/show/settings", { mode: "teach" })).statusCode).toBe(200);
      expect((await app.call("GET", "/api/show/settings")).json()).toMatchObject({
        mode: "teach",
        premium: true,
      });
      // Linking is still not included.
      expect(await active(app, "hearth_interconnectivity")).toBe(false);
      // Revoked: reads as off (locked), the saved "teach" kept for when it comes back.
      await setSetting(app.handle.db, "premium", {
        ...(await getSetting(app.handle.db, "premium"))!,
        revoked: ["lic-show"],
      });
      expect((await app.call("GET", "/api/show/settings")).json()).toMatchObject({
        mode: "off",
        locked: true,
      });
      expect(await getSetting(app.handle.db, "show_and_tell")).toMatchObject({ mode: "teach" });
    },
  );

  it("a licence key for this installation is added, one for another is refused, a forged one too", async () => {
    const app = await makeApp();
    const { installId } = (await app.call("GET", "/api/premium")).json<{ installId: string }>();
    const make = (install: string) =>
      signLicense(
        {
          id: `k-${install.slice(0, 4)}`,
          install,
          features: ["hearth_interconnectivity"],
          kind: "complimentary",
          start: new Date(Date.now() - 1000).toISOString(),
          end: new Date(Date.now() + 86_400_000).toISOString(),
          issued: new Date().toISOString(),
        },
        TEST_SIGNER.privatePem,
      );
    const other = await app.call("POST", "/api/premium/license", {
      key: make("aaaaaaaa-0000-4000-8000-000000000000"),
    });
    expect(other.statusCode).toBe(409);
    expect(other.json<{ message: string }>().message).toMatch(/different Hearth installation/);
    const forged = make(installId).replace(/\.[^.]+$/, ".AAAA");
    expect((await app.call("POST", "/api/premium/license", { key: forged })).statusCode).toBe(409);
    const ok = await app.call("POST", "/api/premium/license", { key: make(installId) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ features: { feature: string; state: string }[] }>().features[0]).toMatchObject(
      {
        feature: "hearth_interconnectivity",
        state: "active",
      },
    );
    expect(await active(app, "hearth_interconnectivity")).toBe(true);
  });

  it("a saved signing key goes back into a Hearth that has none, or lost it; only the same key, never twice", async () => {
    const app = await makeApp();
    const saved = newSigningKey();
    const restore = (key: string) => app.call("POST", "/api/premium/issuer/restore", { key });
    // Not a key, or not this kind of key: refused plainly, nothing stored.
    const junk = await restore(
      ["-----BEGIN PRIVATE KEY-----", "not a key at all", "-----END PRIVATE KEY-----"].join("\n"),
    );
    expect(junk.statusCode).toBe(409);
    expect(junk.json<{ message: string }>().message).toMatch(/from -----BEGIN PRIVATE KEY-----/);
    const { generateKeyPairSync } = await import("node:crypto");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect((await restore(rsa)).statusCode).toBe(409);
    expect((await app.call("GET", "/api/premium/issuer")).json()).not.toHaveProperty("publicKey");
    // The saved key: same public half and key id; it issues once a release trusts it.
    const back = await restore(`  ${saved.privatePem}\n`);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toEqual({
      publicKey: saved.publicKey,
      keyId: saved.keyId,
      trusted: false,
    });
    const vault = await app.handle.db.select().from(vaultSecretsTable);
    expect(vault.find((v) => v.name === "Hearth licence signing key")?.tier).toBe("protected");
    expect(JSON.stringify(vault)).not.toContain(saved.privatePem.split("\n")[1]!);
    TEST_TRUST[saved.keyId] = saved.publicKey;
    try {
      expect((await app.call("GET", "/api/premium/issuer")).json()).toMatchObject({
        active: true,
        keyMissing: false,
      });
      // Never on top of a key it already has.
      expect((await restore(saved.privatePem)).json<{ message: string }>().message).toMatch(
        /already has a signing key/,
      );
      // The vault lost it: only that same key comes back.
      await app.handle.db.delete(vaultSecretsTable);
      expect((await app.call("GET", "/api/premium/issuer")).json()).toMatchObject({
        active: false,
        keyMissing: true,
        keyId: saved.keyId,
      });
      const other = await restore(newSigningKey().privatePem);
      expect(other.statusCode).toBe(409);
      expect(other.json<{ message: string }>().message).toMatch(
        new RegExp(`different key .* This Hearth's signing key is ${saved.keyId}`),
      );
      expect((await restore(saved.privatePem)).json()).toMatchObject({ trusted: true });
      expect((await app.call("GET", "/api/premium/issuer")).json()).toMatchObject({
        active: true,
        keyMissing: false,
      });
    } finally {
      delete TEST_TRUST[saved.keyId];
    }
    // Only the owner, confirmed recently: never a key or a session that isn't.
    expect(
      (await app.send("POST", "/api/premium/issuer/restore", { key: saved.privatePem })).statusCode,
    ).toBe(401);
  });

  it("the owner's issuer: a key Hearth trusts, a grant for this Hearth, a code, revoke and reinstate", async () => {
    const app = await makeApp();
    const made = (await app.call("POST", "/api/premium/issuer/setup", {})).json<{
      publicKey: string;
      keyId: string;
    }>();
    // Until a release trusts its key, it issues nothing.
    expect((await app.call("GET", "/api/premium/issuer")).json()).toMatchObject({ active: false });
    expect(
      (
        await app.call("POST", "/api/premium/issuer/grants", {
          recipient: "Me",
          audience: "self",
          scope: ["premium_all"],
        })
      ).statusCode,
    ).toBe(403);
    TEST_TRUST[made.keyId] = made.publicKey;
    try {
      const { installId } = (await app.call("GET", "/api/premium")).json<{ installId: string }>();
      const g = await app.call("POST", "/api/premium/issuer/grants", {
        recipient: "Me",
        audience: "self",
        scope: ["premium_all"],
        installId,
      });
      expect(g.statusCode, g.body).toBe(200);
      const grantId = g.json<{ grantId: string }>().grantId;
      const on = (await app.call("GET", "/api/premium")).json<{
        features: { state: string; kind?: string }[];
      }>();
      expect(on.features.map((f) => f.state)).toEqual(["active", "active", "active"]);
      expect(on.features[0]!.kind).toBe("complimentary");
      expect(await active(app, "hearth_interconnectivity")).toBe(true);

      // A code: the full code once, only a hint in the list afterwards.
      const code = (
        await app.call("POST", "/api/premium/issuer/codes", {
          scope: ["ember_show_and_tell"],
          audience: "creator",
          campaign: "Launch",
          maxUses: 2,
        })
      ).json<{ code: string }>().code;
      const list = (await app.call("GET", "/api/premium/issuer")).body;
      expect(list).not.toContain(code);
      expect(list).toContain(code.slice(0, 10));

      // Revoked: linking stops at once here; reinstated: back.
      await app.call("POST", `/api/premium/issuer/grants/${grantId}/revoke`, {});
      expect(await active(app, "hearth_interconnectivity")).toBe(false);
      await app.call("POST", `/api/premium/issuer/grants/${grantId}/reinstate`, {});
      expect(await active(app, "hearth_interconnectivity")).toBe(true);
      const audit = JSON.stringify(await app.audit());
      expect(audit).toMatch(/Granted Premium/);
      expect(audit).not.toContain(code);
    } finally {
      delete TEST_TRUST[made.keyId];
    }
  });
});
