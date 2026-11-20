import type { BackupStatus, MemoryEntry, OpeningPoint, Workspace } from "@dragon-control/core";

/**
 * "What's up", before you ask: a few short points in the order a friend
 * who had been keeping an eye on things would raise them (docs/COMPANION.md
 * section 3). Built only from facts Hearth holds, so every point can
 * be checked; any AI (or none) can say them in its own words.
 *
 * 1. What needs you.
 * 2. What happened since you were last here.
 * 3. Real wins, never invented.
 * 4. Work in progress.
 * 5. At most one idea, grounded in your actual setup.
 */

export interface OpeningInput {
  ws: Pick<Workspace, "environment" | "hosts" | "services" | "incidents">;
  /** Current memories (deleted and superseded ones left out). */
  entries: MemoryEntry[];
  backups: Pick<BackupStatus, "recent" | "lastOk" | "offsite">;
  /** Import drafts waiting for review, if any. */
  imports?: { pending: number; ready: number };
  /** When the reader last looked. */
  since: string;
  now: Date;
}

const DAY = 86_400_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function ago(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

export function buildOpening(input: OpeningInput): OpeningPoint[] {
  const { ws, entries, backups, since, now } = input;
  const real = ws.environment === "real";
  const out: OpeningPoint[] = [];
  const hostName = new Map(ws.hosts.map((h) => [h.id, h.name]));

  /* 1. Needs you. */
  const waiting = ws.incidents.filter(
    (i) => i.status === "open" || i.status === "awaiting-approval",
  );
  if (waiting.length) {
    const approvals = waiting.filter((i) => i.status === "awaiting-approval").length;
    out.push({
      kind: "needs-you",
      text: `${plural(waiting.length, "thing needs", "things need")} you: ${waiting
        .slice(0, 2)
        .map((i) => i.title)
        .join(
          "; ",
        )}${waiting.length > 2 ? "; and more" : ""}.${approvals ? ` ${plural(approvals, "repair is", "repairs are")} waiting for your OK.` : ""}`,
      ref: `incident:${waiting[0]!.id}`,
    });
  }
  const last = backups.recent[0];
  if (last && !last.ok) {
    out.push({
      kind: "needs-you",
      text: `The last backup failed ${ago(last.at, now)}: ${last.detail}`,
    });
  } else if (backups.offsite?.stale) {
    out.push({
      kind: "needs-you",
      text: `No backup copy has reached ${backups.offsite.name} recently${backups.offsite.lastVerified ? ` (last confirmed ${ago(backups.offsite.lastVerified.receivedAt, now)})` : ""}. Worth checking it is on and the fetch task is running.`,
    });
  }
  const sick = ws.services.filter(
    (s) => s.health !== "healthy" && !waiting.some((i) => i.serviceId === s.id),
  );
  if (sick.length) {
    out.push({
      kind: "needs-you",
      text: `${sick
        .slice(0, 3)
        .map((s) => `${s.name} on ${hostName.get(s.hostId) ?? s.hostId}`)
        .join(", ")} ${sick.length === 1 ? "is" : "are"} not fully healthy.`,
    });
  }

  /* 2. Since you were last here. */
  const fresh = entries.filter((e) => e.createdAt > since);
  const byDragon = fresh.filter((e) => e.source === "dragon-control" && e.kind === "journal");
  for (const e of byDragon.slice(0, 2)) {
    out.push({ kind: "since", text: `Hearth: ${e.title}.`, ref: `memory:${e.id}` });
  }
  if (byDragon.length > 2) {
    out.push({
      kind: "since",
      text: `And ${byDragon.length - 2} more things Hearth handled.`,
    });
  }
  // Wins get their own point below.
  const fromOthers = fresh.filter(
    (e) => e.source !== "dragon-control" && e.source !== "import" && e.kind !== "win",
  );
  const authors = [
    ...new Set(fromOthers.map((e) => e.author ?? (e.source === "you" ? "you" : "an AI"))),
  ];
  if (fromOthers.length) {
    out.push({
      kind: "since",
      text: `${plural(fromOthers.length, "new memory", "new memories")} since you last looked, from ${authors.slice(0, 3).join(", ")}. Latest: ${fromOthers[0]!.title}.`,
      ref: `memory:${fromOthers[0]!.id}`,
    });
  }
  const resolved = ws.incidents.filter((i) => i.resolvedAt && i.resolvedAt > since);
  if (resolved.length && !byDragon.length) {
    out.push({
      kind: "since",
      text: `${plural(resolved.length, "problem was", "problems were")} resolved since you last looked: ${resolved
        .slice(0, 2)
        .map((i) => i.title)
        .join("; ")}.`,
    });
  }

  /* 3. Wins. Only real ones. */
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  for (const w of entries.filter((e) => e.kind === "win" && e.happenedAt >= weekAgo).slice(0, 2)) {
    out.push({
      kind: "win",
      text: `${w.title} (${ago(w.happenedAt, now)}).`,
      ref: `memory:${w.id}`,
    });
  }
  if (real && ws.services.length && !sick.length && !waiting.length) {
    const lastTrouble = ws.incidents
      .map((i) => i.openedAt)
      .sort()
      .at(-1);
    const quietSince = lastTrouble ?? ws.hosts.map((h) => h.lastSeenAt).sort()[0];
    const days = lastTrouble ? Math.floor((now.getTime() - Date.parse(lastTrouble)) / DAY) : 0;
    if (days >= 3) {
      out.push({
        kind: "win",
        text: `All ${ws.services.length} services healthy, with no problems for ${days} days.`,
      });
    } else if (!lastTrouble && quietSince) {
      out.push({ kind: "win", text: `All ${ws.services.length} services healthy right now.` });
    }
  }

  /* 4. In progress: the open threads touched most recently, and any that have gone quiet. */
  const open = entries
    .filter((e) => e.kind === "thread" && e.status === "open")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (open.length) {
    out.push({
      kind: "in-progress",
      text: `${plural(open.length, "open thread")}. Most recently active: ${open
        .slice(0, 3)
        .map((e) => e.title)
        .join("; ")}.`,
      ref: `memory:${open[0]!.id}`,
    });
    const monthAgo = new Date(now.getTime() - 30 * DAY).toISOString();
    const quiet = open.filter((e) => e.updatedAt < monthAgo);
    if (quiet.length >= 2) {
      out.push({
        kind: "in-progress",
        text: `${plural(quiet.length, "open thread has", "open threads have")} not moved in a month; some may be done already.`,
      });
    }
  }

  /* 5. One idea, from the setup itself. */
  const idea = ideaFor(input);
  if (idea) out.push({ kind: "idea", text: idea });
  return out;
}

function ideaFor({ ws, imports }: OpeningInput): string | undefined {
  if (imports?.pending) {
    return `${plural(imports.pending, "imported note is", "imported notes are")} waiting for your review${imports.ready ? `; ${imports.ready} of them look ready to keep in one go` : ""}. Open Memory, then Review.`;
  }
  if (ws.environment !== "real") return undefined;
  const full = ws.hosts
    .flatMap((h) => h.volumes.map((v) => ({ host: h.name, v })))
    .filter(({ v }) => v.totalTb > 0 && v.usedTb / v.totalTb >= 0.85)
    .sort((a, b) => b.v.usedTb / b.v.totalTb - a.v.usedTb / a.v.totalTb)[0];
  if (full) {
    const pct = Math.round((full.v.usedTb / full.v.totalTb) * 100);
    const free = (full.v.totalTb - full.v.usedTb) * 1000;
    return `${full.v.label} on ${full.host} is ${pct}% full (about ${Math.round(free)} GB free). Worth a look before it fills up.`;
  }
  const busy = ws.hosts.find(
    (h) => h.memory.totalGb > 0 && h.memory.usedGb / h.memory.totalGb >= 0.9,
  );
  if (busy) {
    return `${busy.name} is using ${Math.round((busy.memory.usedGb / busy.memory.totalGb) * 100)}% of its memory. If something feels slow, that is the first place to look.`;
  }
  return undefined;
}
