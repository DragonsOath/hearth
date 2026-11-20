import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { desc, lt } from "drizzle-orm";
import type { BackupRecord, BackupStatus } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withQueue } from "../db/tx";
import { exportMemory } from "../memory/export";
import type { Memory } from "../memory/service";
import { openIncidentFor, raise, settle } from "../monitor/engine";
import { getSetting, setSetting } from "../store/settings";
import { backupKey, decryptFile, encryptFile, sha256File } from "./crypto";

/**
 * Daily backups of the whole database (memory, history, settings, the
 * encrypted vault), each checked by opening it, plus the readable Markdown
 * export. Optionally a second copy in another folder (another drive, or a
 * folder synced to another machine). The key for background secrets lives
 * in its own folder and is deliberately not in these files.
 */

export interface BackupOptions {
  dir: string;
  copyDir?: string;
  keep: number;
  keyDir: string;
  clock?: () => Date;
  /** Checks a new backup before it is kept (replaceable in tests). */
  verify?: (file: string) => { ok: boolean; detail: string };
  /**
   * Another machine fetches encrypted copies from the outbox and leaves a
   * receipt; Hearth checks each receipt against its own fingerprint.
   */
  offsite?: { name: string };
}

/** Warn when no off-machine copy has been confirmed for this long; critical after a week. */
export const OFFSITE_WARN_HOURS = 36;
export const OFFSITE_CRITICAL_HOURS = 7 * 24;
/** Local backups: critical when none has succeeded for this long. */
export const LOCAL_CRITICAL_HOURS = 72;

const FILE = /^dragon-control-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.db$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** Local time, sortable: dragon-control-2026-10-08-031500.db */
function fileName(d: Date): string {
  return `dragon-control-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.db`;
}

/** The most recent 03:00 local time at or before now. Backups are due once after it. */
export function lastBoundary(now: Date): Date {
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0, 0);
  if (now < b) b.setDate(b.getDate() - 1);
  return b;
}

const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

export class Backups {
  private inFlight: Promise<BackupRecord> | undefined;
  private lastFailedAttempt = 0;
  private readonly clock: () => Date;

  constructor(
    private readonly handle: DbHandle,
    private readonly memory: Memory,
    private readonly opts: BackupOptions,
  ) {
    this.clock = opts.clock ?? (() => new Date());
  }

  get exportDir() {
    return path.join(this.opts.dir, "memory-export");
  }

  /** Encrypted backups waiting for the other machine. */
  get outboxDir() {
    return path.join(this.opts.dir, "offsite-outbox");
  }

  /** Where the other machine leaves a receipt for each copy it fetched and checked. */
  get receiptsDir() {
    return path.join(this.opts.dir, "offsite-receipts");
  }

  async status(): Promise<BackupStatus> {
    const recent = await this.records(10);
    const [lastOk] = (
      await this.handle.db.select().from(t.backupLog).orderBy(desc(t.backupLog.id)).limit(200)
    )
      .filter((r) => r.ok)
      .map(toRecord);
    return {
      dir: this.opts.dir,
      copyDir: this.opts.copyDir,
      exportDir: this.exportDir,
      keep: this.opts.keep,
      files: this.files(this.opts.dir),
      lastOk,
      recent,
      keyDir: this.opts.keyDir,
      offsite: this.opts.offsite ? await this.offsiteStatus() : undefined,
    };
  }

  private async offsiteStatus() {
    const { db } = this.handle;
    const pending = this.encrypted();
    const lastVerified = await getSetting(db, "offsite_last_verified");
    const lastError = await getSetting(db, "offsite_last_error");
    return {
      name: this.opts.offsite!.name,
      pending,
      lastVerified,
      lastError,
      stale: (await this.offsiteAgeHours()) >= OFFSITE_WARN_HOURS,
    };
  }

  /** Hours since the newest confirmed off-machine copy (or since copies started waiting). */
  private async offsiteAgeHours(): Promise<number> {
    const { db } = this.handle;
    const verified = await getSetting(db, "offsite_last_verified");
    const since = verified?.receivedAt ?? (await getSetting(db, "offsite_since"));
    if (!since) return 0;
    return (this.clock().getTime() - new Date(since).getTime()) / 3_600_000;
  }

  private encrypted() {
    let names: string[];
    try {
      names = readdirSync(this.outboxDir);
    } catch {
      return [];
    }
    return names
      .filter((f) => f.endsWith(".dcbak"))
      .sort()
      .map((name) => {
        const s = statSync(path.join(this.outboxDir, name));
        return { name, bytes: s.size, at: s.mtime.toISOString() };
      });
  }

  /**
   * Encrypts a checked backup into the outbox. The encrypted copy is
   * decrypted once and compared with the original before it is offered,
   * and its fingerprint (sha256) is written beside it for the receipt check.
   */
  private async queueOffsite(final: string, name: string) {
    mkdirSync(this.outboxDir, { recursive: true, mode: 0o700 });
    const key = backupKey(this.opts.keyDir);
    const encrypted = path.join(this.outboxDir, name.replace(/\.db$/, ".dcbak"));
    const partial = `${encrypted}.partial`;
    const check = `${encrypted}.check`;
    try {
      await encryptFile(final, partial, key);
      await decryptFile(partial, check, key);
      if ((await sha256File(check)) !== (await sha256File(final))) {
        throw new Error("the encrypted copy did not decrypt back to the original");
      }
      const fingerprint = await sha256File(partial);
      renameSync(partial, encrypted);
      writeFileSync(`${encrypted}.sha256`, `${fingerprint}  ${path.basename(encrypted)}\n`, {
        mode: 0o600,
      });
    } finally {
      rmSync(partial, { force: true });
      rmSync(check, { force: true });
    }
    const { db } = this.handle;
    if (!(await getSetting(db, "offsite_since"))) {
      await setSetting(db, "offsite_since", this.clock().toISOString());
    }
    // If the other machine is away for a long time, keep only the newest few waiting.
    for (const old of this.encrypted().slice(0, -this.opts.keep)) {
      rmSync(path.join(this.outboxDir, old.name), { force: true });
      rmSync(path.join(this.outboxDir, `${old.name}.sha256`), { force: true });
    }
  }

  /**
   * Reads receipts the other machine left. A copy counts only when the
   * fingerprint it reports matches the one written here; then it leaves the
   * outbox. A mismatch is recorded and the copy stays to be fetched again.
   */
  async processReceipts(): Promise<void> {
    if (!this.opts.offsite) return;
    const { db } = this.handle;
    let names: string[];
    try {
      names = readdirSync(this.receiptsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    const now = this.clock().toISOString();
    for (const name of names) {
      const file = path.join(this.receiptsDir, name);
      let receipt: { file?: string; sha256?: string; receivedAt?: string; destination?: string };
      try {
        receipt = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as typeof receipt;
      } catch (error) {
        // It may still be arriving; give it a couple of minutes before calling it unreadable.
        if (this.clock().getTime() - statSync(file).mtimeMs < 2 * 60_000) continue;
        await setSetting(db, "offsite_last_error", {
          at: now,
          detail: `A receipt from ${this.opts.offsite.name} could not be read (${name}: ${message(error)}). That copy will be fetched and confirmed again.`,
        });
        rmSync(file, { force: true });
        continue;
      }
      const backup = receipt.file && path.basename(receipt.file);
      const sidecar = backup && path.join(this.outboxDir, `${backup}.sha256`);
      if (backup && sidecar && existsSync(sidecar)) {
        const expected = readFileSync(sidecar, "utf8").split(/\s+/)[0]!.toLowerCase();
        if (receipt.sha256?.toLowerCase() === expected) {
          const previous = await getSetting(db, "offsite_last_verified");
          const receivedAt = receipt.receivedAt ?? now;
          if (!previous || backup > previous.file) {
            await setSetting(db, "offsite_last_verified", {
              file: backup,
              receivedAt,
              destination: receipt.destination ?? this.opts.offsite.name,
              checkedAt: now,
            });
          }
          rmSync(path.join(this.outboxDir, backup), { force: true });
          rmSync(sidecar, { force: true });
        } else {
          await setSetting(db, "offsite_last_error", {
            at: now,
            detail: `${this.opts.offsite.name}'s copy of ${backup} does not match the original. It will be fetched again.`,
          });
        }
      }
      rmSync(file, { force: true });
    }
  }

  /**
   * Turns backup trouble into incidents, so it reaches you through your
   * notifications like any other problem, and resolves when it recovers.
   * Only for your real systems, like all monitoring.
   */
  async checkHealth(): Promise<void> {
    const { db } = this.handle;
    if ((await getSetting(db, "environment")) !== "real") return;
    const now = this.clock();
    const at = now.toISOString();
    const status = await this.status();
    const last = status.recent[0];

    const localKey = "backup:local";
    const localOpen = await openIncidentFor(db, localKey);
    if (last && !last.ok) {
      const lastOkAge = status.lastOk
        ? (now.getTime() - new Date(status.lastOk.at).getTime()) / 3_600_000
        : Infinity;
      if (!localOpen) {
        await raise(db, {
          key: localKey,
          at,
          since: last.at,
          title: "Backups are failing",
          summary: `The last backup failed: ${last.detail}. ${
            status.lastOk
              ? `The newest good one is from ${status.lastOk.at.slice(0, 10)}.`
              : "There is no good backup yet."
          }`,
          severity: lastOkAge >= LOCAL_CRITICAL_HOURS ? "critical" : "warning",
          detectedText: `The backup at ${last.at} failed.`,
          confirmText: last.detail,
          escalateText:
            "Hearth tries again every hour. If it keeps failing, the folder or disk needs a look.",
        });
      }
    } else if (localOpen && last?.ok) {
      await settle(
        db,
        localKey,
        at,
        `Backup ${last.file} succeeded and passed its check.`,
        "Backups are working again. No action is needed.",
        "Backups are working again",
      );
    }

    if (!status.offsite) return;
    const offKey = "backup:offsite";
    const offOpen = await openIncidentFor(db, offKey);
    const hours = await this.offsiteAgeHours();
    const name = status.offsite.name;
    if (hours >= OFFSITE_WARN_HOURS) {
      if (!offOpen) {
        const days = Math.floor(hours / 24);
        await raise(db, {
          key: offKey,
          at,
          since: at,
          title: `No off-machine backup for ${days >= 2 ? `${days} days` : `${Math.round(hours)} hours`}`,
          summary: status.offsite.lastVerified
            ? `${name} last confirmed a copy at ${status.offsite.lastVerified.receivedAt}. ${status.offsite.pending.length} encrypted ${status.offsite.pending.length === 1 ? "backup is" : "backups are"} waiting. If this machine's disk failed now, the newest safe copy is that old.`
            : `${name} has not confirmed any copy yet. ${status.offsite.pending.length} encrypted ${status.offsite.pending.length === 1 ? "backup is" : "backups are"} waiting.`,
          severity: hours >= OFFSITE_CRITICAL_HOURS ? "critical" : "warning",
          detectedText: `No confirmed copy on ${name} for over ${OFFSITE_WARN_HOURS} hours.`,
          confirmText:
            status.offsite.lastError?.detail ??
            `${name} may be off, asleep, or unable to reach this machine.`,
          escalateText: `Check that ${name} is on and its scheduled backup pull is running. It catches up on its own once it can reach this machine.`,
        });
      }
    } else if (offOpen) {
      await settle(
        db,
        offKey,
        at,
        `${name} confirmed ${status.offsite.lastVerified?.file ?? "a copy"}.`,
        `${name} has an up-to-date copy again. No action is needed.`,
        "Off-machine backups caught up",
      );
    }
  }

  private async records(limit: number): Promise<BackupRecord[]> {
    return (
      await this.handle.db.select().from(t.backupLog).orderBy(desc(t.backupLog.id)).limit(limit)
    ).map(toRecord);
  }

  private files(dir: string) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      // Missing, or not a folder: there are no backups there to list.
      return [];
    }
    return names
      .filter((f) => FILE.test(f))
      .sort()
      .reverse()
      .map((name) => {
        const s = statSync(path.join(dir, name));
        return { name, bytes: s.size, at: s.mtime.toISOString() };
      });
  }

  /** True when no backup has succeeded since the last 03:00, and a failure is not being retried too soon. */
  async due(): Promise<boolean> {
    const now = this.clock();
    if (now.getTime() - this.lastFailedAttempt < RETRY_AFTER_FAILURE_MS) return false;
    const { lastOk } = await this.status();
    return !lastOk || new Date(lastOk.at) < lastBoundary(now);
  }

  /** Called every few minutes by the scheduler. */
  async tick(): Promise<void> {
    await this.processReceipts();
    if (await this.due()) await this.run("scheduled");
    await this.checkHealth();
  }

  run(reason: BackupRecord["reason"]): Promise<BackupRecord> {
    // Pressing the button twice shares one backup.
    this.inFlight ??= this.backup(reason).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async backup(reason: BackupRecord["reason"]): Promise<BackupRecord> {
    const started = this.clock();
    const t0 = Date.now();
    let file: string | undefined;
    let bytes: number | undefined;
    let copied: boolean | undefined;
    const notes: string[] = [];
    try {
      mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      let name = fileName(started);
      for (let n = 2; existsSync(path.join(this.opts.dir, name)); n++) {
        name = fileName(started).replace(/\.db$/, `-${n}.db`);
      }
      const final = path.join(this.opts.dir, name);
      const partial = `${final}.partial`;
      rmSync(partial, { force: true });
      // A consistent copy of the live database, WAL included, without stopping anything.
      await withQueue(() => {
        this.handle.sqlite.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
      });
      const check = (this.opts.verify ?? verify)(partial);
      if (!check.ok) {
        rmSync(partial, { force: true });
        throw new Error(`The new backup failed its check: ${check.detail}`);
      }
      renameSync(partial, final);
      try {
        chmodSync(final, 0o600);
      } catch {
        // Windows ignores modes.
      }
      file = name;
      bytes = statSync(final).size;
      notes.push(check.detail);

      const exported = await exportMemory(this.handle, this.memory, this.exportDir, started);
      notes.push(`readable export: ${exported.files} files`);
      this.prune(this.opts.dir);

      if (this.opts.offsite) {
        try {
          await this.queueOffsite(final, name);
          notes.push(`encrypted for ${this.opts.offsite.name}`);
        } catch (error) {
          notes.push(`not queued for ${this.opts.offsite.name}: ${message(error)}`);
          await setSetting(this.handle.db, "offsite_last_error", {
            at: started.toISOString(),
            detail: `Could not prepare the encrypted copy: ${message(error)}`,
          });
        }
      }

      if (this.opts.copyDir) {
        try {
          mkdirSync(this.opts.copyDir, { recursive: true, mode: 0o700 });
          copyFileSync(final, path.join(this.opts.copyDir, name));
          const exportCopy = path.join(this.opts.copyDir, "memory-export");
          rmSync(exportCopy, { recursive: true, force: true });
          cpSync(this.exportDir, exportCopy, { recursive: true });
          this.prune(this.opts.copyDir);
          copied = true;
        } catch (error) {
          copied = false;
          notes.push(`second copy failed: ${message(error)}`);
        }
      }
      return await this.record({
        at: started.toISOString(),
        reason,
        ok: true,
        file,
        bytes,
        durationMs: Date.now() - t0,
        detail: notes.join("; "),
        copied,
      });
    } catch (error) {
      this.lastFailedAttempt = started.getTime();
      return this.record({
        at: started.toISOString(),
        reason,
        ok: false,
        file,
        bytes,
        durationMs: Date.now() - t0,
        detail: message(error),
        copied,
      });
    }
  }

  private prune(dir: string) {
    for (const old of this.files(dir).slice(this.opts.keep)) {
      rmSync(path.join(dir, old.name), { force: true });
    }
  }

  private async record(r: Omit<BackupRecord, "id">): Promise<BackupRecord> {
    const { db } = this.handle;
    await db.insert(t.backupLog).values({
      at: r.at,
      reason: r.reason,
      ok: r.ok,
      file: r.file ?? null,
      bytes: r.bytes ?? null,
      durationMs: r.durationMs,
      detail: r.detail,
      copied: r.copied ?? null,
    });
    const [row] = await db.select().from(t.backupLog).orderBy(desc(t.backupLog.id)).limit(1);
    // Keep the log itself small.
    await db.delete(t.backupLog).where(lt(t.backupLog.id, row!.id - 500));
    return toRecord(row!);
  }
}

/** Opens a backup on its own and checks it is whole and readable. */
export function verify(file: string): { ok: boolean; detail: string } {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check;
    if (integrity !== "ok") return { ok: false, detail: `integrity check: ${integrity}` };
    const count = (table: string) =>
      Number((db!.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    return {
      ok: true,
      detail: `checked: ${count("memory_entries")} memories, ${count("memory_transcript_messages")} transcript messages, ${count("services")} services`,
    };
  } catch (error) {
    return { ok: false, detail: message(error) };
  } finally {
    db?.close();
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toRecord(row: typeof t.backupLog.$inferSelect): BackupRecord {
  return {
    id: row.id,
    at: row.at,
    reason: row.reason,
    ok: row.ok,
    file: row.file ?? undefined,
    bytes: row.bytes ?? undefined,
    durationMs: row.durationMs,
    detail: row.detail,
    copied: row.copied ?? undefined,
  };
}
