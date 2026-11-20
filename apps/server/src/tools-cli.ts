import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, SERVER_ROOT } from "./config";
import { openDatabase, runMigrations } from "./db/client";
import { AccessKeys } from "./auth/tokens";
import { backupKey, decryptFile } from "./backup/crypto";
import { Backups, verify } from "./backup/service";
import { Memory } from "./memory/service";
import { realProbes, runDiscovery, runRemoteDiscovery } from "./discovery/scan";
import { adoptDiscovery } from "./store/adopt";
import { Jurisdiction } from "./cave/jurisdiction";
import { setServiceLifecycle } from "./store/mutations";
import { JURISDICTION_KINDS, type JurisdictionKind } from "@dragon-control/core";
import { Voice, wyomingClient } from "./voice/service";
import { VoiceAssist } from "./voice/assist";
import { Auth } from "./auth/service";
import { defaultKeyGuard } from "./auth/keyguard";
import { Vault } from "./auth/vault";
import { AppWatcher } from "./apps/service";
import { ActionRunner, REAL_VERIFY } from "./actions/service";
import { realContainerTools } from "./actions/tools";
import { realMonitorProbes } from "./monitor/probes";
import { createAdmin } from "./admin";
import { VolumeNames } from "./storage/names";
import { SmartReader } from "./storage/smart";
import { Elevation } from "./admin/elevation";
import { FileManager } from "./storage/files";
import { FileIndexer } from "./storage/file-index";
import { StorageCenterService } from "./storage/center-service";
import { Findings } from "./findings/store";
import { checkText, checkVoice, downloadVoices, runProgram, startSpeech } from "./voice/setup";

/**
 * Machine-only tools (run on the server itself):
 *
 *   pnpm backup:decrypt <backup.dcbak> <restored.db> [--key-file <backup.key>]
 *     Opens an off-machine backup with the backup key (from DC_KEY_DIR, or
 *     the copy you keep in your password manager) and checks the result.
 *
 *   pnpm backup:now
 *     Runs a backup right away (same checks as the daily one) and prints how it went.
 *
 *   pnpm discover [--adopt] [--skip key,key] [--remote <address> --name <name>]
 *     The same read-only scan as Systems > Discover, from the command line.
 *     Lists what it finds; with --adopt, adopts what the scan suggests (minus
 *     --skip), exactly like pressing Adopt. --remote checks another machine.
 *
 *   pnpm companion:key --name "Claude Code on ai-box" --out <file> [--url <address>]
 *     Creates an access key for the Claude Code companion and writes it
 *     straight into a file, so it never appears on screen or in a transcript.
 *
 *   node apps/server/dist/tools-cli.js ha-key --name "Home Assistant (Belle)" --secrets <secrets.yaml> [--secret dragon_control_auth]
 *     Creates a talk-only access key (scope: converse) for Home Assistant and writes it into
 *     Home Assistant's secrets.yaml as "<secret>: Bearer <key>" (replacing that line if present),
 *     so it never appears on screen or in a transcript. Revoke it in Settings > Access keys.
 *
 *   pnpm jurisdiction [list]
 *   pnpm jurisdiction add --kind machine|service|repository|path|domain|topic
 *                         --name "<name>" (--in | --out) [--value <v>] [--note "<limits or reason>"]
 *   pnpm jurisdiction remove <id>
 *     What Ember looks after, set from the machine itself (the same
 *     list as Settings > Ember). The AI can read it but never change it.
 *
 *   pnpm voices check [--json]
 *   pnpm voices find          (speech services on this computer and the home network)
 *   pnpm voices download [--dir <folder>] [--dry-run]
 *   pnpm voices start [--dir <folder>] [--gpu] [--dry-run]
 *     The five voice agents on this machine: what it can run (changes nothing), downloading
 *     the voices from the GitHub release with a checksum check, and starting the speech
 *     programs in Docker (Piper and Whisper). After starting, Hearth's voice points at
 *     this machine if no speech machine was set. The voices go in <data dir>/voices by default.
 *
 *   pnpm service <id> --paused|--retired|--watch [--note "<why>"]
 *     Marks a service as off on purpose (paused), replaced or removed
 *     (retired), or watched again: the same as the buttons on its page.
 */

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = loadConfig();

  if (command === "decrypt") {
    const [input, output] = args.filter(
      (a, i) => !a.startsWith("--") && args[i - 1] !== "--key-file",
    );
    if (!input || !output)
      throw new Error("Usage: decrypt <backup.dcbak> <restored.db> [--key-file <file>]");
    const keyFile = arg(args, "--key-file");
    const { readFileSync } = await import("node:fs");
    const key = keyFile
      ? Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64")
      : backupKey(config.keyDir);
    await decryptFile(input, output, key);
    const check = verify(output);
    console.log(
      check.ok
        ? `Restored ${output}: ${check.detail}`
        : `Decrypted, but the check failed: ${check.detail}`,
    );
    if (!check.ok) process.exit(1);
    return;
  }

  if (command === "backup-now") {
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const memory = new Memory(handle);
    const backups = new Backups(handle, memory, {
      dir: config.backupDir,
      copyDir: config.backupCopyDir,
      keep: config.backupKeep,
      keyDir: config.keyDir,
      offsite: config.offsiteName ? { name: config.offsiteName } : undefined,
    });
    const record = await backups.run("manual");
    handle.close();
    console.log(
      `${record.ok ? "Backed up" : "Backup FAILED"}: ${record.file ?? ""} ${record.detail}`,
    );
    if (!record.ok) process.exit(1);
    return;
  }

  if (command === "discover") {
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const remote = arg(args, "--remote");
    const report = remote
      ? await runRemoteDiscovery(realProbes, {
          address: remote,
          name: arg(args, "--name") ?? remote,
        })
      : await runDiscovery(realProbes);
    const skip = new Set((arg(args, "--skip") ?? "").split(",").filter(Boolean));
    console.log(
      `${report.host.name} (${report.host.os}, ${report.host.address}): ${report.findings.length} found in ${report.durationMs} ms` +
        (report.docker.available ? `, Docker ${report.docker.version}` : ", no Docker"),
    );
    for (const note of report.notes) console.log(`  note: ${note}`);
    for (const f of report.findings) {
      const take = f.selectedByDefault && !skip.has(f.key);
      console.log(
        `  ${take ? "[x]" : "[ ]"} ${f.name.padEnd(24)} ${f.group.padEnd(16)} ${(f.localUrl ?? "").padEnd(32)} ${f.key}`,
      );
    }
    if (args.includes("--adopt")) {
      const selections = report.findings
        .filter((f) => f.selectedByDefault && !skip.has(f.key))
        .map((f) => ({ key: f.key, name: f.name }));
      const result = await adoptDiscovery(handle, report, selections);
      await new Memory(handle).recordSystem(handle.db, {
        title: `Added ${result.services} services on ${report.host.name} to Hearth`,
        body: `From a scan of ${report.host.name} (${report.host.os}, ${report.host.address}): ${selections.map((s) => s.name).join(", ")}.`,
        machine: report.host.name,
        happenedAt: report.scannedAt,
        links: [{ label: report.host.name, ref: `host:${report.host.id}` }],
      });
      console.log(`Adopted ${result.services} services.`);
    } else {
      console.log("Dry run. Add --adopt to adopt the ticked ones.");
    }
    handle.close();
    return;
  }

  if (command === "companion-key") {
    const name = arg(args, "--name");
    const out = arg(args, "--out");
    if (!name || !out)
      throw new Error('Usage: companion-key --name "<name>" --out <file> [--url <address>]');
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const { key } = await new AccessKeys(handle).create(name, ["memory"]);
    handle.close();
    const url = arg(args, "--url") ?? `http://127.0.0.1:${config.port}`;
    writeFileSync(out, `${JSON.stringify({ url, key, name }, null, 2)}\n`, { mode: 0o600 });
    console.log(
      `Created "${name}" (Homelab memory only) and wrote it to ${out}. The key is not shown.`,
    );
    return;
  }

  if (command === "ha-key") {
    const name = arg(args, "--name");
    const secrets = arg(args, "--secrets");
    const secret = arg(args, "--secret") ?? "dragon_control_auth";
    if (!name || !secrets || !/^[a-z_][a-z0-9_]*$/.test(secret))
      throw new Error(
        'Usage: ha-key --name "<name>" --secrets <secrets.yaml> [--secret <yaml_key>]',
      );
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const { key } = await new AccessKeys(handle).create(name, ["converse"]);
    handle.close();
    const before = existsSync(secrets) ? readFileSync(secrets, "utf8") : "";
    const kept = before.split("\n").filter((l) => !l.startsWith(`${secret}:`));
    while (kept.length && kept[kept.length - 1] === "") kept.pop();
    writeFileSync(secrets, `${[...kept, `${secret}: "Bearer ${key}"`].join("\n")}\n`);
    console.log(
      `Created "${name}" (talk only) and wrote it to ${secrets} as ${secret}. The key is not shown.`,
    );
    return;
  }

  if (command === "jurisdiction") {
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const j = new Jurisdiction(handle);
    const [sub, ...rest] = args;
    if (sub === "add") {
      const kind = arg(rest, "--kind") as JurisdictionKind | undefined;
      const name = arg(rest, "--name");
      const access = rest.includes("--out") ? "out" : rest.includes("--in") ? "in" : undefined;
      if (!kind || !JURISDICTION_KINDS.includes(kind) || !name || !access) {
        throw new Error(
          `Usage: jurisdiction add --kind ${JURISDICTION_KINDS.join("|")} --name "<name>" (--in | --out) [--value <v>] [--note "<note>"]`,
        );
      }
      const e = await j.add(
        { kind, name, access, value: arg(rest, "--value"), note: arg(rest, "--note") },
        "machine",
      );
      console.log(`Added ${e.access === "in" ? "IN" : "OUT"} ${e.kind} "${e.name}" (${e.id}).`);
    } else if (sub === "remove") {
      if (!rest[0]) throw new Error("Usage: jurisdiction remove <id>");
      await j.remove(rest[0]);
      console.log("Removed.");
    } else {
      for (const e of await j.list()) {
        console.log(
          `${e.access === "in" ? "IN " : "OUT"}  ${e.kind.padEnd(10)} ${e.name}${e.value ? ` (${e.value})` : ""}${e.note ? `: ${e.note}` : ""}  [${e.id}]`,
        );
      }
    }
    handle.close();
    return;
  }

  if (command === "service") {
    const [id, ...rest] = args;
    const lifecycle = rest.includes("--paused")
      ? "paused"
      : rest.includes("--retired")
        ? "retired"
        : rest.includes("--watch")
          ? "active"
          : undefined;
    if (!id || !lifecycle)
      throw new Error('Usage: service <id> --paused|--retired|--watch [--note "<why>"]');
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const note = arg(rest, "--note");
    const { name, changed } = await setServiceLifecycle(handle, id, lifecycle, note);
    if (changed) {
      await new Memory(handle).create(
        {
          kind: "journal",
          title: lifecycle === "active" ? `Watching ${name} again` : `${name} ${lifecycle}`,
          body: note,
          basis: "stated",
          links: [{ label: name, ref: `service:${id}` }],
        },
        { source: "you" },
      );
    }
    handle.close();
    console.log(
      changed
        ? `${name}: ${lifecycle === "active" ? "watched again" : lifecycle}.`
        : `${name}: no change.`,
    );
    return;
  }

  if (command === "voices") {
    const [sub = "check"] = args;
    const dir = path.resolve(arg(args, "--dir") ?? path.join(config.dataDir, "voices"));
    const dryRun = args.includes("--dry-run");
    const deps = {
      run: runProgram,
      fetch: globalThis.fetch,
      speechDir: path.join(SERVER_ROOT, "../../deploy/speech"),
    };
    const say = (line: string) => console.log(line);
    if (sub === "check") {
      const report = await checkVoice(deps, dir, config.dataDir);
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else checkText(report).forEach(say);
      return;
    }
    if (sub === "find") {
      // The same search Hearth's voice setup runs: this computer, known machines, home network.
      const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
      await runMigrations(handle, config.migrationsDir);
      const voice = new Voice(handle);
      const assist = new VoiceAssist(handle, voice, wyomingClient, {
        dataDir: config.dataDir,
        setup: deps,
      });
      console.log(JSON.stringify(await assist.find(), null, 2));
      handle.close();
      return;
    }
    if (sub === "download") {
      if (!(await downloadVoices(deps, dir, { dryRun, say }))) process.exit(1);
      return;
    }
    if (sub === "start") {
      if (!(await startSpeech(deps, dir, { dryRun, gpu: args.includes("--gpu"), say })))
        process.exit(1);
      if (dryRun) return;
      // Point Hearth's voice here, unless a speech machine is already set.
      const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
      await runMigrations(handle, config.migrationsDir);
      const voice = new Voice(handle);
      const current = await voice.config();
      if (!current.host) {
        await voice.save({ ...current, host: "127.0.0.1" });
        say("Hearth's voice now uses this machine.");
      } else
        say(`Hearth's voice still uses ${current.host}; change it in Settings > Ember > Voice.`);
      handle.close();
      return;
    }
    throw new Error("Usage: voices check | download | start  [--dir <folder>] [--gpu] [--dry-run]");
  }

  if (command === "dashboard") {
    // What an app's live dashboard reads right now, as a short summary (for checking a real
    // install). Read only; keys stay in the vault and are never printed.
    const [serviceId] = args;
    if (!serviceId) throw new Error("Usage: dashboard <serviceId>");
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const auth = new Auth(handle, {
      dataDir: config.dataDir,
      keyGuard: defaultKeyGuard(config.keyDir),
    });
    const apps = new AppWatcher(handle, new Vault(handle, auth));
    const d = await apps.dashboard(serviceId);
    if (d.error) console.log(JSON.stringify({ serviceId, error: d.error }, null, 2));
    else if (d.data?.app === "audiobookshelf")
      // Names only: which account the shelves are for, the shelves, and what is playing.
      console.log(
        JSON.stringify(
          {
            serviceId,
            shelfUser: d.data.shelfUser,
            shelves: (d.data.shelves ?? []).map((sh) => `${sh.label}: ${sh.books.length}`),
            nowListening: d.data.nowListening
              ? {
                  book: d.data.nowListening.book.name,
                  at: `${d.data.nowListening.positionSec}s of ${d.data.nowListening.durationSec}s`,
                  chapter: d.data.nowListening.chapter
                    ? `${d.data.nowListening.chapter.number}/${d.data.nowListening.chapter.count} ${d.data.nowListening.chapter.pct}%`
                    : undefined,
                }
              : undefined,
            covers: d.data.libraries.map(
              (l) => `${l.name}: ${l.recent.filter((b) => b.cover).length}/${l.recent.length}`,
            ),
          },
          null,
          2,
        ),
      );
    else if (d.data && d.data.app !== "seerr")
      console.log(
        JSON.stringify(
          {
            serviceId,
            ...Object.fromEntries(
              Object.entries(d.data).map(([k, v]) => [
                k,
                Array.isArray(v) ? `${v.length} items` : v,
              ]),
            ),
          },
          null,
          2,
        ),
      );
    else if (d.data?.app === "seerr")
      console.log(
        JSON.stringify(
          {
            serviceId,
            version: d.data.version,
            me: d.data.me,
            region: d.data.region,
            totals: d.data.totals,
            notes: d.data.notes,
            sample: d.data.movies.slice(0, 12).map((m) => ({
              title: m.title,
              by: m.mine ? "owner" : m.requestedBy,
              stage: m.stage,
              digital: m.digital?.date ?? "not announced",
              overdueDays: m.overdueDays,
              radarr: m.radarr?.instance,
              rootFolder: m.radarr?.rootFolder,
              quality: m.radarr?.quality,
              poster: Boolean(m.poster),
            })),
          },
          null,
          2,
        ),
      );
    else console.log(JSON.stringify({ serviceId, ok: false }));
    handle.close();
    return;
  }

  if (command === "storage-check") {
    // What Storage & Files shows on this machine now: drive names, file journeys (titles,
    // steps, paths), and Recently Added counts. Read only; no keys are read into the output.
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const auth = new Auth(handle, {
      dataDir: config.dataDir,
      keyGuard: defaultKeyGuard(config.keyDir),
    });
    const names = new VolumeNames(handle);
    const files = new FileManager(
      handle,
      [config.keyDir, config.dataDir].filter(Boolean) as string[],
      names,
    );
    const center = new StorageCenterService(
      handle,
      new AppWatcher(handle, new Vault(handle, auth)),
      new Findings(handle),
      realContainerTools,
      files,
      names,
      new SmartReader(Elevation.fromEnv(process.env)),
    );
    const d = await center.read();
    const smart = await center.smart();
    const byOutcome: Record<string, number> = {};
    for (const j of d.journeys) byOutcome[j.outcome] = (byOutcome[j.outcome] ?? 0) + 1;
    const added = await new FileIndexer(handle, files).added({ days: 7 });
    console.log(
      JSON.stringify(
        {
          names: d.names,
          roots: d.roots.map((r) => `${r.label} = ${r.path}`),
          journeys: byOutcome,
          needsALook: d.journeys.filter((j) => j.attention).length,
          replacedByLaterDownload: d.journeys.filter((j) => j.replacedBy).length,
          gaps: d.journeyGaps,
          sample: d.journeys.slice(0, 6).map((j) => ({
            title: j.title,
            outcome: j.outcome,
            stoppedAt: j.stoppedAt,
            steps: j.steps.map((s) => `${s.label}:${s.state}:${s.evidence}`),
            from: j.source?.hostPath ?? j.source?.path,
            to: j.destination?.hostPath ?? j.destination?.path,
          })),
          recentlyAdded: { arrivalsThisWeek: added.total, indexed: added.indexed },
          smart: smart.blocker
            ? { blocked: smart.blocker.title }
            : smart.reports.map((r) => ({
                device: r.device,
                mounts: r.mounts,
                verdict: r.verdict,
                via: r.via,
                reasons: r.reasons,
                unavailable: r.unavailable,
              })),
        },
        null,
        2,
      ),
    );
    handle.close();
    return;
  }

  if (command === "storage-name") {
    // Name a drive for Storage & Files ("Film" for /mnt/f). Display only; the mount is untouched.
    const [mount, ...words] = args;
    if (!mount) throw new Error('Usage: storage-name <mount> "<name>" (an empty name clears it)');
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    console.log(JSON.stringify(await new VolumeNames(handle).set(mount, words.join(" ") || null)));
    handle.close();
    return;
  }

  if (command === "caddy") {
    // What the Caddy panel reads on this machine right now, as counts and states only (for
    // checking a real install): how it was read, how many sites work, and what Manage still
    // needs. Read only; no site names, addresses, or configuration are printed.
    const [serviceId] = args;
    if (!serviceId) throw new Error("Usage: caddy <serviceId>");
    const handle = openDatabase(path.join(config.dataDir, "dragon-control.db"));
    await runMigrations(handle, config.migrationsDir);
    const runner = new ActionRunner(handle, {
      probes: realMonitorProbes,
      containers: realContainerTools,
      verify: REAL_VERIFY,
      demoRestartMs: 2000,
    });
    const admin = createAdmin(handle, runner, {
      backupRoot: path.join(config.keyDir, "service-backups"),
      rules: { secretRoots: [config.keyDir] },
    });
    try {
      const p = await admin.config.caddyPanel(serviceId);
      console.log(
        JSON.stringify(
          {
            serviceId,
            readVia: p.readVia,
            sites: p.sites.length,
            working: p.sites.filter((x) => x.works && x.localUp !== false).length,
            behindSignIn: p.sites.filter((x) => x.signIn !== "none").length,
            certificates: p.certificates,
            errorsLastDay: p.errors.length,
            manage: p.manage.ok
              ? { ok: true, via: p.manage.via }
              : { ok: false, blocker: p.manage.blocker.kind, title: p.manage.blocker.title },
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const e = error as Error & { blocker?: { kind: string } };
      console.log(JSON.stringify({ serviceId, error: e.message, blocker: e.blocker?.kind }));
    }
    handle.close();
    return;
  }

  throw new Error(
    "Commands: decrypt, backup-now, discover, companion-key, jurisdiction, service, voices, dashboard, caddy, storage-name, storage-check",
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
