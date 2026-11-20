import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "./client";

const realMigrations = path.join(SERVER_ROOT, "drizzle");
const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** A copy of the migrations folder containing only the first `count` migrations. */
function migrationsUpTo(count: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dc-mig-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(realMigrations, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

function scalar(handle: ReturnType<typeof openDatabase>, sql: string): unknown {
  const row = handle.sqlite.prepare(sql).get() as Record<string, unknown>;
  return Object.values(row)[0];
}

describe("migrations", () => {
  it("upgrades an M2 database without losing rows that reference rebuilt tables", async () => {
    const handle = openDatabase(":memory:");
    cleanup.push(() => handle.close());
    await runMigrations(handle, migrationsUpTo(2)); // the M2 schema

    handle.sqlite.exec(`
      INSERT INTO hosts (id, name, role, os, address, cpu_model, cpu_cores, cpu_usage_pct,
        mem_total_gb, mem_used_gb, uptime_hours, connection, docker, health, last_seen_at)
        VALUES ('h1', 'Host', 'Server', 'Linux', '10.0.0.1', 'CPU', 4, 1, 8, 1, 1, 'agent', 1, 'healthy', '2026-01-01T00:00:00Z');
      INSERT INTO services (id, name, category, host_id, kind, local_url, health, uptime_pct, autonomy_area)
        VALUES ('web', 'Web', 'Media', 'h1', 'container', 'http://10.0.0.1:80', 'healthy', 99.9, 'media'),
               ('proxy', 'Proxy', 'Network', 'h1', 'container', 'http://10.0.0.1:443', 'healthy', 99.9, 'proxy');
      INSERT INTO service_dependencies (service_id, depends_on_id) VALUES ('web', 'proxy');
      INSERT INTO incidents (id, title, severity, status, opened_at, summary, handled_by, service_id)
        VALUES ('i1', 'Down', 'warning', 'resolved', '2026-01-01T00:00:00Z', 'x', 'runbook', 'web');
    `);

    await runMigrations(handle, realMigrations); // upgrade to current

    expect(scalar(handle, "SELECT count(*) FROM services")).toBe(2);
    expect(scalar(handle, "SELECT count(*) FROM service_dependencies")).toBe(1);
    expect(scalar(handle, "SELECT service_id FROM incidents WHERE id = 'i1'")).toBe("web");
    expect(scalar(handle, "SELECT local_url FROM services WHERE id = 'web'")).toBe(
      "http://10.0.0.1:80",
    );
    expect(scalar(handle, "SELECT proxy_service_id FROM services WHERE id = 'web'")).toBeNull();
    // Enforcement is back on after migrating.
    expect(scalar(handle, "PRAGMA foreign_keys")).toBe(1);
  });

  it("keeps agent sessions through the M7 rebuild of their table", async () => {
    const handle = openDatabase(":memory:");
    cleanup.push(() => handle.close());
    await runMigrations(handle, migrationsUpTo(11)); // just before M7
    handle.sqlite.exec(`
      INSERT INTO agent_sessions (id, at, incident_id, summary, outcome)
        VALUES ('s1', '2026-01-01T00:00:00Z', 'inc-1', 'Restarted FlareSolverr', 'resolved');
    `);
    await runMigrations(handle, realMigrations);
    expect(scalar(handle, "SELECT summary FROM agent_sessions WHERE id = 's1'")).toBe(
      "Restarted FlareSolverr",
    );
    expect(scalar(handle, "SELECT conversation_id FROM agent_sessions WHERE id = 's1'")).toBeNull();
  });

  it("makes conversations from before the memory existed searchable", async () => {
    const handle = openDatabase(":memory:");
    cleanup.push(() => handle.close());
    await runMigrations(handle, migrationsUpTo(12)); // just before the homelab memory
    handle.sqlite.exec(`
      INSERT INTO conversations (id, source, title, status, created_at, updated_at)
        VALUES ('c1', 'voice', 'Plex', 'idle', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
      INSERT INTO conversation_messages (conversation_id, role, text, at)
        VALUES ('c1', 'you', 'Plex keeps buffering on the tablet', '2026-10-01T00:00:00Z');
    `);
    await runMigrations(handle, realMigrations);
    expect(
      scalar(handle, "SELECT ref FROM memory_search WHERE memory_search MATCH 'buffering'"),
    ).toBe("c1:1");
  });

  it("is a no-op when already up to date", async () => {
    const handle = openDatabase(":memory:");
    cleanup.push(() => handle.close());
    await runMigrations(handle, realMigrations);
    await expect(runMigrations(handle, realMigrations)).resolves.toBeUndefined();
  });
  it("marks installs claimed before the welcome existed as already through it", async () => {
    const journal = JSON.parse(
      readFileSync(path.join(realMigrations, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    const before = journal.entries.findIndex((e) => e.tag === "0046_onboarding_existing_installs");
    expect(before).toBeGreaterThan(0);
    const owner = `INSERT INTO owner (id, password_hash, recovery_hash, created_at, password_changed_at)
      VALUES (1, 'x', 'y', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;

    // An owner already there: marked done, so the welcome is never pushed on them.
    const claimed = openDatabase(":memory:");
    cleanup.push(() => claimed.close());
    await runMigrations(claimed, migrationsUpTo(before));
    claimed.sqlite.exec(owner);
    await runMigrations(claimed, realMigrations);
    const done = scalar(claimed, "SELECT value FROM settings WHERE key = 'onboarding_done_at'");
    expect(JSON.parse(String(done))).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A brand new installation: nothing set, so its owner is welcomed after claiming it.
    const fresh = openDatabase(":memory:");
    cleanup.push(() => fresh.close());
    await runMigrations(fresh, realMigrations);
    expect(scalar(fresh, "SELECT count(*) FROM settings WHERE key = 'onboarding_done_at'")).toBe(0);
  });
});
