import type { BackupStatus, CompanionBriefing, MemoryEntry } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { loadWorkspace } from "../store/workspace";
import { buildOpening } from "./opening";
import type { Memory } from "./service";

/** Your own names, so prompts mentioning them are recognised: machines, projects, services. */
function vocabulary(
  ws: { hosts: { name: string }[]; services: { name: string }[] },
  projects: { name: string }[],
  entries: MemoryEntry[],
): string[] {
  const names = [
    ...ws.hosts.map((h) => h.name),
    ...projects.map((p) => p.name),
    // "Plex (plex-test)" is still Plex.
    ...ws.services.map((s) => s.name.replace(/\s*\(.*\)$/, "")),
    ...entries.flatMap((e) => (e.machine ? [e.machine] : [])),
  ];
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))].slice(0, 300);
}

/**
 * What the companion needs to be caught up before it answers: what needs
 * you, what happened since it last looked, what is in progress, your
 * projects and preferences, and a live summary of your systems. Built
 * fresh on every call, so everything in it is current as of `asOf`.
 */
export async function buildBriefing(
  handle: DbHandle,
  memory: Memory,
  backups: { status(): Promise<BackupStatus> },
  opts: {
    since?: string;
    demo: boolean;
    now?: Date;
    /** Import drafts waiting for review, so the opening can mention them. */
    imports?: () => Promise<{ pending: number; ready: number }>;
  },
): Promise<CompanionBriefing> {
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const windowStart = since < weekAgo ? since : weekAgo;
  const ws = await loadWorkspace(handle.db, { demo: opts.demo });
  const all = await memory.list({ limit: 2000 });
  // Superseded memories are history: they stay searchable, but never appear
  // as current setup, open work, or how things are done.
  const current = all.filter((e) => !e.superseded);
  const byKind = (kind: MemoryEntry["kind"]) => current.filter((e) => e.kind === kind);
  const projects = (await memory.projects()).filter((p) => p.status !== "done");
  const open = ws.incidents.filter((i) => i.status !== "resolved");
  const backup = await backups.status();
  const hostName = new Map(ws.hosts.map((h) => [h.id, h.name]));

  return {
    asOf: now.toISOString(),
    installation: ws.instanceName,
    ownerName: ws.ownerName,
    sampleData: ws.environment !== "real",
    needsYou: open
      .filter((i) => i.status === "open" || i.status === "awaiting-approval")
      .map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        severity: i.severity,
        openedAt: i.openedAt,
      })),
    system: {
      servicesTotal: ws.services.length,
      notHealthy: ws.services
        .filter((s) => s.health !== "healthy")
        .map((s) => ({ name: s.name, health: s.health, host: hostName.get(s.hostId) ?? s.hostId })),
      hosts: ws.hosts.map((h) => ({
        name: h.name,
        os: h.os,
        connection: h.connection,
        health: h.health,
      })),
      openIncidents: open.length,
    },
    vocabulary: vocabulary(ws, projects, all),
    opening: buildOpening({
      ws,
      entries: current,
      backups: backup,
      imports: await opts.imports?.(),
      since,
      now,
    }),
    backups: {
      lastOkAt: backup.lastOk?.at,
      lastFailed:
        backup.recent[0] && !backup.recent[0].ok
          ? { at: backup.recent[0].at, detail: backup.recent[0].detail }
          : undefined,
      offsite: backup.offsite
        ? {
            name: backup.offsite.name,
            lastVerifiedAt: backup.offsite.lastVerified?.receivedAt,
            waiting: backup.offsite.pending.length,
            stale: backup.offsite.stale,
          }
        : undefined,
    },
    since,
    // The last week at least, so a second terminal opened minutes later still sees recent
    // history; the client marks what is new since `since`.
    recent: all
      .filter(
        (e) =>
          (e.kind === "journal" || e.kind === "win") &&
          (e.happenedAt >= windowStart || e.createdAt >= since),
      )
      .slice(0, 25),
    openThreads: current.filter((e) => e.kind === "thread" && e.status === "open").slice(0, 30),
    projects,
    howYouWork: byKind("preference").slice(0, 40),
    hardware: byKind("hardware").slice(0, 40),
    recentSessions: (await memory.transcripts(5)).map((t) => ({
      id: t.id,
      title: t.title,
      client: t.client,
      machine: t.machine,
      startedAt: t.startedAt,
      messageCount: t.messageCount,
    })),
    counts: { memories: all.length, transcripts: (await memory.transcripts(100_000)).length },
  };
}
