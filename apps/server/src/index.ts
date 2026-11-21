import { fakeApps } from "./apps/fake-apps";
import { keyImportOperations } from "./credentials/import-step";
import { realSetupDeps, VoiceAssist } from "./voice/assist";
import { Jobs } from "./jobs/engine";
import { runnerOperations } from "./jobs/operations";
import { AppOperations } from "./apps/operations";
import { RestartLog } from "./monitor/restarts";
import { homedir, hostname } from "node:os";
import { APP_VERSION } from "@dragon-control/core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildApp, memoryOperations } from "./app";
import { mediaWatcherFor } from "./media/watcher";
import { movieNightsFor } from "./media/nights";
import { DiscordGateway } from "./notify/discord-bot";
import { HearthBotLink } from "./notify/hearth-bot";
import { loadConfig, SERVER_ROOT } from "./config";
import { openDatabase, runMigrations } from "./db/client";
import { ensureInstallIdentity } from "./db/meta";
import { ensureInitialEnvironment } from "./demo/seed";
import { fakeProbes } from "./discovery/fake";
import { realProbes } from "./discovery/scan";
import { fakeContainerTools, fakeMonitorProbes } from "./monitor/fake";
import { ActionRunner, REAL_VERIFY } from "./actions/service";
import { realContainerTools } from "./actions/tools";
import { defaultKeyGuard } from "./auth/keyguard";
import { Auth } from "./auth/service";
import { Vault } from "./auth/vault";
import { ensureNotificationCatalog } from "./notify/catalog";
import { Notifier } from "./notify/notifier";
import { Work } from "./work/service";
import { Watches } from "./watches/engine";
import { Briefs } from "./notify/briefs";
import { MovieReleases } from "./watches/movie-release";
import type { Fetch } from "./apps/http";
import { ensureAgentCatalog } from "./agent/catalog";
import {
  claudeCodeProvider,
  codexProvider,
  ollamaProvider,
  scriptedProvider,
} from "./agent/providers";
import { ClaudeSignIn, fakeClaudeSignIn } from "./agent/claude-signin";
import { Agents } from "./agent/service";
import { LairRemotes } from "./agent/lair-remote";
import { AccessKeys } from "./auth/tokens";
import { realMonitorProbes } from "./monitor/probes";
import { startMonitor } from "./monitor/scheduler";
import { ResourceHistory } from "./monitor/history";
import { readHostCounters } from "./monitor/host-counters";
import { AppWatcher } from "./apps/service";
import { createAdmin, hostDocsRoot, serviceBackupRoot } from "./admin";
import { Elevation } from "./admin/elevation";
import { FileOperations } from "./storage/file-ops";
import { RaidService } from "./storage/raid/service";
import { FileManager } from "./storage/files";
import { VolumeNames } from "./storage/names";
import { Memory } from "./memory/service";
import { Backups } from "./backup/service";
import { FakeVoicePack, VoicePack } from "./voice/pack";
import { Voice } from "./voice/service";
import { fakeSpeechClient } from "./voice/fake";
import { createFindingsEngine } from "./findings";
import { Engine } from "./engine/service";
import { fakeOllamaFetch, ollamaEnv } from "./engine/ollama";
import { findBinary } from "./engine/runners";
import { homelabTick, ownerHomelabRules } from "./engine/homelab";
import { getSetting, setSetting } from "./store/settings";
import { thisPcName } from "./pcs/member";
import { LabBlueprint } from "./blueprint/service";
import { blueprintSource } from "./blueprint/source";
import { fakeCloud } from "./blueprint/fake-cloud";
import { releaseVersion } from "./pcs/install";
import { SESSION_COOKIE } from "./auth/routes";
import { StagedChanges, browserChangeOperations } from "./browser/staged";
import { logRequest } from "./log-redact";

async function main() {
  const config = loadConfig();
  const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
  await runMigrations(handle, config.migrationsDir);
  const identity = await ensureInstallIdentity(handle.db);

  // The installers set DC_FIRST_START=empty: an installed Hearth starts on the owner's own
  // computer, not on sample data (11-20 blind test: "SAMPLE DATA" on a fresh install). Sample
  // data stays a choice in Settings; development and the tests still start on it.
  await ensureInitialEnvironment(handle, {
    demo: config.demo && process.env.DC_FIRST_START !== "empty",
  });

  const fake = process.env.DC_FAKE_DISCOVERY === "1";
  const monitorProbes = fake ? fakeMonitorProbes : realMonitorProbes;
  const runner = new ActionRunner(handle, {
    probes: monitorProbes,
    containers: fake ? fakeContainerTools : realContainerTools,
    verify: fake ? { intervalMs: 300, attempts: 3 } : REAL_VERIFY,
    demoRestartMs: fake ? 300 : 2000,
  });
  const auth = new Auth(handle, {
    dataDir: config.dataDir,
    keyGuard: defaultKeyGuard(config.keyDir),
  });
  const vault = new Vault(handle, auth);
  await auth.pruneSessions();
  await ensureNotificationCatalog(handle.db);
  const notifier = new Notifier(handle, vault, {
    defaultPicture: async () =>
      (await readFile(path.join(config.webDir, "icon-512.png")).catch(() => undefined))?.toString(
        "base64",
      ),
  });
  const work = new Work(handle);
  await ensureAgentCatalog(handle.db);
  const keys = new AccessKeys(handle);
  const engineRef: { current?: Engine } = {};
  const agents = new Agents(handle, runner, keys, {
    // Browser tests use a scripted stand-in so they never spend Claude usage.
    providers: {
      "claude-code": process.env.DC_FAKE_AGENT === "1" ? scriptedProvider() : claudeCodeProvider(),
      // Codex: only while Full access is on (its shell can't be switched off).
      codex:
        process.env.DC_FAKE_AGENT === "1"
          ? scriptedProvider("codex")
          : codexProvider(findBinary("codex", config.codexBinary) ?? "codex"),
      // Ollama: Claude Code on a free local model, set up in Settings (the War Room's engine
      // keeps the address and model, so both rooms use the same one).
      ollama:
        process.env.DC_FAKE_AGENT === "1"
          ? scriptedProvider("ollama")
          : ollamaProvider({
              env: () => {
                const c = engineRef.current?.ollamaConfig();
                return c?.model ? ollamaEnv(c) : null;
              },
              model: () => engineRef.current?.ollamaConfig()?.model ?? null,
              check: async () => {
                const e = engineRef.current;
                const st = e ? await e.ollamaStatus() : null;
                const m = st?.models.find((x) => x.name === st.model);
                if (!st?.reachable)
                  return { ok: false, detail: st?.problem ?? "Ollama isn't set up yet." };
                if (!m)
                  return {
                    ok: false,
                    detail: "Choose a model for Ollama first: Settings, Ember, Ollama.",
                  };
                return { ok: true, detail: `Ollama ${st.version ?? ""} with ${m.name}.`.trim() };
              },
            }),
    },
    claudeSignIn: process.env.DC_FAKE_AGENT === "1" ? fakeClaudeSignIn() : new ClaudeSignIn(),
    // The agent reaches Hearth on loopback, whatever address the UI is served on.
    mcpUrl: () => `http://127.0.0.1:${config.port}/api/mcp`,
    probes: monitorProbes,
    demo: config.demo,
    // The War Room's Full access switch unboxes the Lair's Ember too (the engine is made below).
    // The Lair works in its own notebook folder (the old Homelab project's, when there is one).
    fullAccess: () => {
      const e = engineRef.current;
      if (!e) return { on: false };
      let cwd: string | undefined;
      try {
        cwd = e.projects.lairFolder();
      } catch {
        cwd = undefined;
      }
      return { on: e.queue.fullAccess, ask: e.queue.askLevel, ...(cwd ? { cwd } : {}) };
    },
    // The live snapshot of the machines, for the Lair (refreshed every two minutes below).
    homelabSnapshot: () => engineRef.current?.projects.homelabNotes ?? "",
    lairFolder: () => {
      try {
        return engineRef.current?.projects.lairFolder();
      } catch {
        return undefined;
      }
    },
  });
  agents.onReply = (id) => void notifier.announceReply(id);
  const memory = new Memory(handle);
  runner.memory = memory;
  const backups = new Backups(handle, memory, {
    dir: config.backupDir,
    copyDir: config.backupCopyDir,
    keep: config.backupKeep,
    keyDir: config.keyDir,
    offsite: config.offsiteName ? { name: config.offsiteName } : undefined,
  });
  runner.onChange = () => {
    notifier.kick();
    agents.kick();
  };

  // Browser tests only: a stand-in Sonarr with state (never set in a real install).
  const stand = process.env.DC_FAKE_APPS === "1" ? fakeApps() : undefined;
  const apps = new AppWatcher(handle, vault, stand?.fetch, stand?.socket);
  const briefs = new Briefs(handle, notifier);
  const watches = new Watches(
    handle,
    new MovieReleases(handle, apps.broker, stand?.fetch ?? (fetch as unknown as Fetch)),
    notifier,
  );
  // Media announcements: what arrived in Plex or Jellyfin, to the destinations the owner chose.
  const media = mediaWatcherFor(handle, apps, notifier);
  const nights = movieNightsFor(handle, media, notifier);
  const history = new ResourceHistory(handle, {
    containers: runner.containerTools,
    host: readHostCounters,
  });
  const restarts = new RestartLog(handle, runner.containerTools);
  // Findings: what the analyzers see across Docker, storage, apps, and the machines.
  // RAID / Arrays: arrays read from the kernel's files; changes are approved plan steps.
  const raidOps = RaidService.fromEnv(
    handle,
    process.env,
    () => thisPcName(config.dataDir),
    config.dataDir,
  );
  // The Lab Blueprint: a daily, encrypted write-up of the lab for rebuilding it (blueprint/).
  const blueprintVersion = releaseVersion() ?? APP_VERSION;
  const blueprint = new LabBlueprint({
    handle,
    auth,
    vault,
    source: () =>
      blueprintSource({ handle, vault, version: blueprintVersion, fake: Boolean(stand) }),
    version: blueprintVersion,
    host: () => hostname(),
    // Safe previews reach a stand-in cloud, never a real one.
    ...(stand ? { fetch: fakeCloud().fetch } : {}),
  });
  const findings = createFindingsEngine(handle, {
    probes: monitorProbes,
    containers: runner.containerTools,
    backups,
    raid: () => raidOps.report(),
    seeding: () => apps.seedingUnseen(),
    blueprint: () => blueprint.status(),
  });
  // Host administration (feature request 21): off until the owner switches it on per host.
  // File operations from the file manager: approved plan steps, never on Hearth's own data.
  const fileOps = new FileOperations(
    new FileManager(handle, [config.keyDir, config.dataDir], new VolumeNames(handle)),
  );
  const admin = createAdmin(handle, runner, {
    backupRoot: serviceBackupRoot(process.env, config.dataDir),
    docsRoot: hostDocsRoot(process.env, config.dataDir),
    rules: {
      // Hearth's own database, keys, and encrypted backups: never shown to the Ember.
      // Also Claude Code's own sign-in for this account (its credentials live there).
      secretRoots: [
        config.dataDir,
        config.keyDir,
        config.backupDir,
        path.join(homedir(), ".claude"),
      ],
      // Its own code: readable for diagnosis, never changed through the Ember.
      // Its own code, and the backup ledger (backups are never changed or deleted by the Ember).
      protectedRoots: [path.resolve(process.cwd()), serviceBackupRoot(process.env, config.dataDir)],
    },
    memory,
    // Only when the owner installed it (deploy/linux/install-elevation.sh sets DC_ELEVATION=1).
    elevation: Elevation.fromEnv(process.env),
  });
  // Browser tests use stand-in speech services so they never need the GPU machine.
  const voice =
    process.env.DC_FAKE_VOICE === "1"
      ? new Voice(handle, {
          defaultHost: "speech.test",
          client: fakeSpeechClient,
          pack: new FakeVoicePack(),
        })
      : new Voice(handle, {
          defaultHost: config.voiceHost,
          // Standard voice: downloaded into the data folder the first time it is needed.
          pack: new VoicePack(path.join(config.dataDir, "voice-pack")),
          // The plain voice is used instead; say why so a missing ffmpeg is noticed.
          onEffectError: (error) =>
            console.warn(
              "Hearth: voice effect skipped:",
              error instanceof Error ? error.message : error,
            ),
        });
  // Browser tests: one stand-in speech machine to find, and an install that only reports steps.
  const voiceAssist =
    process.env.DC_FAKE_VOICE === "1"
      ? new VoiceAssist(handle, voice, fakeSpeechClient, {
          dataDir: config.dataDir,
          setup: realSetupDeps(SERVER_ROOT),
          candidates: async () => [{ host: "speech.test", name: "Speech machine (test)" }],
          install: async (say) => {
            say("Downloading the voices", "en_US-warden-medium.onnx: downloaded and checked");
            await new Promise((r) => setTimeout(r, 400));
            say("Starting the speech programs", "Piper (speaking) and Whisper (listening).");
            await new Promise((r) => setTimeout(r, 400));
            return { host: "speech.test" };
          },
        })
      : undefined;
  // The engine: Claude Code and Codex working in project folders on this machine. Tests use a
  // stand-in for Claude Code and keep their projects inside the test's data folder.
  const fakeAgent = process.env.DC_FAKE_AGENT === "1";
  const engine = new Engine({
    db: handle.sqlite,
    dataDir: config.dataDir,
    workspaces:
      config.engineWorkspaces ??
      (fakeAgent ? path.join(config.dataDir, "engine-projects") : undefined),
    session: (cookie) => auth.session(cookie),
    cookieName: SESSION_COOKIE,
    claudeBinary: config.claudeBinary,
    codexBinary: config.codexBinary,
    fakeRunner: fakeAgent,
    ...(fakeAgent ? { ollamaFetch: fakeOllamaFetch() } : {}),
    pcName: () => thisPcName(config.dataDir),
  });
  engine.start();
  engineRef.current = engine;
  // Remote Control (/rc) in the Lair, on the engine's terminals and Claude Code (11-04).
  // Browser tests only: a stand-in session (the stand-in agent has no Claude app to connect to).
  const fakeRc = fakeAgent && process.env.DC_TEST_REMOTE_CONTROL === "1";
  if (fakeRc) process.env.FAKE_RC_TRANSCRIPTS = path.join(config.dataDir, "rc-transcripts");
  agents.remote = new LairRemotes({
    terminals: () => engine.terminals,
    binary: () =>
      fakeRc
        ? process.execPath
        : fakeAgent
          ? undefined
          : (engine.engines["claude-code"]?.binary ?? undefined),
    ...(fakeRc
      ? {
          launch: [path.join(SERVER_ROOT, "src", "agent", "fake-remote-control.cjs")],
          transcripts: path.join(config.dataDir, "rc-transcripts"),
        }
      : {}),
    pcName: () => thisPcName(config.dataDir),
    setup: (id) => agents.remoteSetup(id),
    say: (id, role, text, from) => agents.remoteSay(id, role, text, from),
    setting: async (key, fallback) => engine.store.setting(key, fallback),
    setSetting: async (key, value) => engine.store.setSetting(key, value),
  });
  void agents.remote.restore().catch(() => undefined);
  // /login in the War Room uses the Lair's sign-in (one at a time, the same Claude Code).
  engine.chatLogin = agents.login;
  // The War Room gets the Lair's tools (app_api, the homelab's state, plans), per run.
  engine.hearthTools = (name) => agents.toolSession(name);

  // Freeing memory on this machine (the stand-in machine in tests).
  const memoryOps = memoryOperations(handle);
  const stagedChanges = new StagedChanges();
  const app = await buildApp({
    handle,
    config,
    engine,
    ...(voiceAssist ? { voiceAssist } : {}),
    // Tests and demos can scan a synthetic homelab instead of this machine.
    probes: process.env.DC_FAKE_DISCOVERY === "1" ? fakeProbes : realProbes,
    monitorProbes,
    runner,
    voice,
    auth,
    vault,
    notifier,
    keys,
    agents,
    memory,
    backups,
    blueprint,
    apps,
    history,
    restarts,
    findings,
    admin,
    work,
    watches,
    briefs,
    media,
    nights,
    ...(stand
      ? {
          fakeApps: stand,
          jobs: new Jobs(
            handle,
            runnerOperations(
              handle,
              runner,
              new AppOperations(
                handle,
                vault,
                runner,
                stand.fetch,
                memory,
                async () => undefined,
                stand.socket,
              ),
              admin.config,
              keyImportOperations(handle, vault, runner.containerTools, apps),
              fileOps,
              raidOps,
              undefined,
              undefined,
              memoryOps,
              browserChangeOperations(handle, stagedChanges),
            ),
          ),
        }
      : {}),
    stagedChanges,
    memoryOps,
    fileOps,
    raidOps,
    logger: {
      level: "info",
      // Sign-in answers (code, token, state...) never land in the journal.
      serializers: { req: logRequest },
      ...(config.mode === "development"
        ? { transport: { target: "pino-pretty", options: { ignore: "pid,hostname" } } }
        : {}),
    },
  });

  const monitor =
    process.env.DC_MONITOR === "off"
      ? undefined
      : startMonitor(
          handle,
          monitorProbes,
          app.log,
          runner,
          notifier,
          apps,
          history,
          restarts,
          findings,
        );

  // Daily backups: checked every 10 minutes, due once after 03:00 local time
  // (or right away when the last one is older than that). DC_BACKUPS=off disables.
  const backupTick = () =>
    void backups.tick().catch((error: unknown) => app.log.error({ err: error }, "backup failed"));
  const backupTimers =
    process.env.DC_BACKUPS === "off"
      ? []
      : [setTimeout(backupTick, 2 * 60_000), setInterval(backupTick, 10 * 60_000)];

  // The Lab Blueprint: checked every 10 minutes, due once a day after 04:00 (after the backup).
  const blueprintTick = () =>
    void blueprint
      .tick()
      .catch((error: unknown) => app.log.error({ err: error }, "lab blueprint failed"));
  const blueprintTimers =
    process.env.DC_BACKUPS === "off"
      ? []
      : [setTimeout(blueprintTick, 3 * 60_000), setInterval(blueprintTick, 10 * 60_000)];

  // Long work: every minute, mark work that stopped reporting as stalled and tell the owner once
  // about anything stalled, failed, overdue, or finished.
  const workTick = () =>
    void work
      .sweep()
      .then((alerts) => notifier.announceWork(alerts))
      .catch((error: unknown) => app.log.error({ err: error }, "long work check failed"));
  const workTimer = setInterval(workTick, 60_000);

  // Manual downloads: every minute, sort finished torrents and Usenet jobs added with no category
  // (only once their setup plan was approved). Off with the rest of the timers (DC_MONITOR=off).
  const sortTick = () =>
    void apps.sorter
      .tick()
      .catch((error: unknown) => app.log.error({ err: error }, "manual download sorting failed"));
  const sortTimer = process.env.DC_MONITOR === "off" ? undefined : setInterval(sortTick, 60_000);
  // Download Health: every five minutes, stuck and failing downloads are looked at (no changes).
  const healthTick = () =>
    void apps.health
      .check()
      .catch((error: unknown) => app.log.error({ err: error }, "download health check failed"));
  const healthTimer =
    process.env.DC_MONITOR === "off" ? undefined : setInterval(healthTick, 5 * 60_000);
  // Seeding rules: every five minutes, live rules act on torrents whose time is up (only rules
  // the owner switched to live, and never while the rules are stopped).
  const seedingTick = () =>
    void apps
      .seedingTick()
      .catch((error: unknown) => app.log.error({ err: error }, "seeding rules check failed"));
  const seedingTimer =
    process.env.DC_MONITOR === "off" ? undefined : setInterval(seedingTick, 5 * 60_000);
  // Audiobook intake: every two minutes, finished audiobook releases are judged and sure ones
  // imported (only once its setup plan was approved).
  apps.intakeMounts = (c) => runner.containerTools.mounts(c);
  const intakeTick = () =>
    void apps.intake
      .tick()
      .catch((error: unknown) => app.log.error({ err: error }, "audiobook intake failed"));
  const intakeTimer =
    process.env.DC_MONITOR === "off" ? undefined : setInterval(intakeTick, 2 * 60_000);

  // Release watch: every minute, check the requested movies that are due (each knows when), and
  // look for new requests every half hour. Off with the rest of the timers (DC_MONITOR=off).
  const watchTick = () =>
    void watches
      .tick()
      .catch((error: unknown) => app.log.error({ err: error }, "release watch failed"));
  const watchTimer = process.env.DC_MONITOR === "off" ? undefined : setInterval(watchTick, 60_000);
  // Briefs and watches: every minute, summaries that are due and watches that tripped or cleared.
  const briefTick = () =>
    void briefs.tick().catch((error: unknown) => app.log.error({ err: error }, "briefs failed"));
  const briefTimer = process.env.DC_MONITOR === "off" ? undefined : setInterval(briefTick, 60_000);

  // RAID: consistency checks on the schedules the owner approved (Storage > RAID / Arrays).
  const raidTick = () =>
    void raidOps
      .tick()
      .then((said) => said.forEach((m) => app.log.info(m)))
      .catch((error: unknown) => app.log.error({ err: error }, "scheduled RAID check failed"));
  const raidTimer =
    process.env.DC_MONITOR === "off" ? undefined : setInterval(raidTick, 10 * 60_000);
  // Media announcements: every 5 minutes, read each Plex and Jellyfin for new arrivals and send
  // what is due. Off with the rest of the timers (DC_MONITOR=off).
  const mediaTick = () =>
    void media
      .tick()
      .catch((error: unknown) => app.log.error({ err: error }, "media announcements failed"));
  const mediaTimers =
    process.env.DC_MONITOR === "off"
      ? []
      : [setTimeout(mediaTick, 60_000), setInterval(mediaTick, 5 * 60_000)];
  // Movie night reminders: checked every minute, so "when it starts" is on time.
  const nightsTick = () =>
    void nights
      .tick()
      .catch((error: unknown) => app.log.error({ err: error }, "movie night reminders failed"));
  if (process.env.DC_MONITOR !== "off") mediaTimers.push(setInterval(nightsTick, 60_000));
  // Your Discord bot: kept connected so friends' RSVP buttons reach the movie night.
  const bots = new DiscordGateway(
    (press) => nights.rsvp(press.customId, press.name),
    (msg) => app.log.info(msg),
  );
  // The official Hearth bot: one socket to its relay, while one of its destinations is set up.
  const hearthBot = new HearthBotLink(
    (press) => nights.rsvp(press.customId, press.name),
    (msg) => app.log.info(msg),
  );
  const syncBots = () => {
    void notifier
      .botTokens()
      .then((tokens) => bots.sync(tokens))
      .catch((error: unknown) => app.log.error({ err: error }, "Discord bot connection failed"));
    void notifier
      .hearthBotCred()
      .then((cred) => hearthBot.sync(cred))
      .catch((error: unknown) => app.log.error({ err: error }, "Hearth bot connection failed"));
  };
  if (process.env.DC_MONITOR !== "off") {
    notifier.onBotsChanged = syncBots;
    syncBots();
  }

  // The live snapshot of the homelab for the Lair, kept fresh. The owner's own additions to the
  // old Homelab project's brief become their homelab rules for Ember, once (10-30).
  if ((await getSetting(handle.db, "lair_rules")) === undefined) {
    const old = engine.projects.hearthsHomelab();
    const rules = old ? ownerHomelabRules(engine.projects.get(old).description) : "";
    await setSetting(handle.db, "lair_rules", rules);
  }
  const homelabRun = () => homelabTick(handle, engine.projects, engine.accountPcs);
  engine.beforeOpen = homelabRun;
  const homelabCheck = () =>
    void homelabRun().catch((error: unknown) =>
      app.log.error({ err: error }, "homelab check failed"),
    );
  const homelabTimers = [setTimeout(homelabCheck, 5_000), setInterval(homelabCheck, 2 * 60_000)];

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    // Never hang a restart: whatever is still open after this is cut off (systemd would wait
    // 90 seconds, and Hearth looks gone the whole time).
    setTimeout(() => process.exit(0), 70_000).unref();
    // The War Room's live connections, terminals and Remote Control sessions end now; left open,
    // they keep the server from closing.
    // Before the engine's terminals close, so Lair sessions that were on come back after.
    agents.remote?.stopAll();
    engine.stop();
    await monitor?.stop();
    for (const timer of backupTimers) clearTimeout(timer);
    for (const timer of blueprintTimers) clearTimeout(timer);
    clearInterval(workTimer);
    for (const timer of homelabTimers) clearTimeout(timer);
    if (watchTimer) clearInterval(watchTimer);
    if (briefTimer) clearInterval(briefTimer);
    if (sortTimer) clearInterval(sortTimer);
    if (seedingTimer) clearInterval(seedingTimer);
    if (intakeTimer) clearInterval(intakeTimer);
    if (healthTimer) clearInterval(healthTimer);
    if (raidTimer) clearInterval(raidTimer);
    for (const t of mediaTimers) clearTimeout(t);
    bots.stop();
    hearthBot.stop();
    await watches.idle();
    await runner.idle();
    await notifier.idle();
    // An answer being written may finish (up to a minute); one still running then is answered
    // again after the restart (the unit's KillMode=mixed lets the AI process outlive the signal).
    await agents.drain(60_000);
    app.server.closeAllConnections();
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5_000))]);
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      dataDir: config.dataDir,
      installId: identity.installId,
      mode: config.mode,
      demo: config.demo,
    },
    "Hearth is running",
  );
  const code = await auth.setupCode();
  if (code) {
    // Only someone who can see this log (or the installer) can claim the installation.
    app.log.warn(
      { setupCode: code },
      `Hearth is not set up yet. Open http://localhost:${config.port}/setup?code=${code} to secure it.`,
    );
  }
}

main().catch((error) => {
  console.error("Hearth failed to start:", error);
  process.exit(1);
});
