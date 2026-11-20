import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Capability, CapabilityKind, CapabilityStatus, GapKind } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { recordAudit } from "../store/audit";

/**
 * Tools and capabilities (feature request 21, checklist 22.14 onward): one registry for every kind
 * of capability (utilities, packages, tools inside containers, skills, integrations, scripts).
 *
 * Phase 1 records what exists on the host and what the Ember found missing, linked to the task it
 * was doing, so the work can resume. Installing anything is a later, separately approved
 * operation (capability-install); nothing here installs, downloads, or runs new code.
 */

/** Utilities worth knowing about on a homelab host: what each is for. */
export const KNOWN_UTILITIES: { name: string; purpose: string }[] = [
  { name: "ffprobe", purpose: "Read a media file's codec, resolution, duration, and streams." },
  { name: "mediainfo", purpose: "Detailed media file information (codec, HDR, audio tracks)." },
  { name: "ffmpeg", purpose: "Media conversion and repair." },
  { name: "docker", purpose: "Docker command line (containers, Compose, networks)." },
  { name: "journalctl", purpose: "System and service logs." },
  { name: "systemctl", purpose: "System services and timers." },
  { name: "ss", purpose: "Listening ports and connections." },
  { name: "findmnt", purpose: "Mounted filesystems." },
  { name: "lsblk", purpose: "Drives and partitions." },
  { name: "du", purpose: "Disk use per folder." },
  { name: "smartctl", purpose: "Drive health (SMART)." },
  { name: "rsync", purpose: "Copying and verifying files." },
  { name: "sqlite3", purpose: "Reading app databases (read only)." },
  { name: "jq", purpose: "Reading JSON." },
  { name: "curl", purpose: "Testing web addresses." },
  { name: "nvidia-smi", purpose: "GPU state." },
];

function toCapability(r: typeof t.capabilities.$inferSelect, hostName?: string): Capability {
  return {
    id: r.id,
    ...(r.hostId ? { hostId: r.hostId } : {}),
    ...(hostName ? { hostName } : {}),
    kind: r.kind as CapabilityKind,
    name: r.name,
    status: r.status as CapabilityStatus,
    ...(r.version ? { version: r.version } : {}),
    ...(r.source ? { source: r.source } : {}),
    ...(r.location ? { location: r.location } : {}),
    ...(r.purpose ? { purpose: r.purpose } : {}),
    ...(r.gap ? { gap: r.gap as GapKind } : {}),
    ...(r.task ? { task: r.task } : {}),
    ...(r.conversationId ? { conversationId: r.conversationId } : {}),
    ...(r.jobId ? { jobId: r.jobId } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

async function onPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(path.delimiter)) {
    const full = path.join(dir, name);
    try {
      await fs.access(full, fs.constants.X_OK);
      return full;
    } catch {
      // next
    }
  }
  return undefined;
}

export class Capabilities {
  constructor(private readonly handle: DbHandle) {}

  private get db() {
    return this.handle.db;
  }

  async list(opts: { status?: CapabilityStatus } = {}): Promise<Capability[]> {
    const rows = await this.db
      .select()
      .from(t.capabilities)
      .where(opts.status ? eq(t.capabilities.status, opts.status) : undefined)
      .orderBy(desc(t.capabilities.updatedAt));
    const hosts = await this.db.select().from(t.hosts);
    return rows.map((r) => toCapability(r, hosts.find((h) => h.id === r.hostId)?.name));
  }

  /** What utilities this host has (looked up on the PATH; nothing is run). */
  async detect(hostId: string | undefined): Promise<Capability[]> {
    const now = new Date().toISOString();
    for (const u of KNOWN_UTILITIES) {
      const at = await onPath(u.name);
      const existing = await this.db
        .select()
        .from(t.capabilities)
        .where(and(eq(t.capabilities.name, u.name), eq(t.capabilities.kind, "utility")))
        .get();
      // A gap the Ember recorded stays open until the tool is really there.
      const status: CapabilityStatus = at ? "available" : "missing";
      if (existing) {
        await this.db
          .update(t.capabilities)
          .set({ status, location: at ?? null, hostId: hostId ?? null, updatedAt: now })
          .where(eq(t.capabilities.id, existing.id));
      } else {
        await this.db.insert(t.capabilities).values({
          id: randomUUID(),
          hostId: hostId ?? null,
          kind: "utility",
          name: u.name,
          status,
          source: at ? "found on this machine" : null,
          location: at ?? null,
          purpose: u.purpose,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    return this.list();
  }

  /**
   * The Ember found it cannot go on without something: recorded with the task, conversation, and
   * plan, so it can pick the work up again once the capability exists.
   */
  async recordGap(input: {
    name: string;
    kind: CapabilityKind;
    gap: GapKind;
    task: string;
    purpose?: string;
    hostId?: string;
    conversationId?: string;
    jobId?: string;
  }): Promise<Capability> {
    const now = new Date().toISOString();
    const existing = await this.db
      .select()
      .from(t.capabilities)
      .where(and(eq(t.capabilities.name, input.name), eq(t.capabilities.kind, input.kind)))
      .get();
    const values = {
      status: "missing" as const,
      gap: input.gap,
      task: input.task.slice(0, 1000),
      purpose: input.purpose?.slice(0, 500) ?? existing?.purpose ?? null,
      hostId: input.hostId ?? existing?.hostId ?? null,
      conversationId: input.conversationId ?? null,
      jobId: input.jobId ?? null,
      updatedAt: now,
    };
    let id: string;
    if (existing && existing.status !== "available" && existing.status !== "installed") {
      id = existing.id;
      await this.db.update(t.capabilities).set(values).where(eq(t.capabilities.id, id));
    } else if (existing) {
      // It exists but the Ember still could not use it (permission, credential): keep that visible.
      id = existing.id;
      await this.db
        .update(t.capabilities)
        .set({
          gap: input.gap,
          task: values.task,
          conversationId: values.conversationId,
          jobId: values.jobId,
          updatedAt: now,
        })
        .where(eq(t.capabilities.id, id));
    } else {
      id = randomUUID();
      await this.db.insert(t.capabilities).values({
        id,
        kind: input.kind,
        name: input.name.slice(0, 200),
        createdAt: now,
        ...values,
      });
    }
    await recordAudit(this.db, {
      actor: "agent",
      action: `Recorded a missing capability: ${input.name} (${input.gap})`,
      target: input.conversationId ? `conversation:${input.conversationId}` : "capabilities",
    });
    const row = await this.db.select().from(t.capabilities).where(eq(t.capabilities.id, id)).get();
    return toCapability(row!);
  }

  /** You dismiss a gap you do not want pursued (it stays in history). */
  async dismiss(id: string): Promise<void> {
    await this.db
      .update(t.capabilities)
      .set({ status: "removed", updatedAt: new Date().toISOString() })
      .where(eq(t.capabilities.id, id));
    await recordAudit(this.db, {
      actor: "you",
      action: "Dismissed a capability request",
      target: `capability:${id}`,
    });
  }
}
