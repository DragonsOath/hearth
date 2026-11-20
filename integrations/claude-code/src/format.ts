import type { Result } from "./client";
import type { CompanionBriefing, MemoryEntry, MemorySearchHit, OpeningPoint } from "./types";

/**
 * Turns what Hearth returns into text for Claude. The first line
 * always says where it came from: LIVE (read from Hearth just now)
 * or CACHED (an older copy, because Hearth could not be reached).
 */

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};
const day = (iso: string) => iso.slice(0, 10);

function age(iso: string | undefined): string {
  if (!iso) return "unknown age";
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes old`;
  if (hours < 48) return `${Math.round(hours)} hours old`;
  return `${Math.round(hours / 24)} days old`;
}

export function provenance(result: Result<unknown>, url?: string): string {
  if (result.live) {
    return `[Hearth: LIVE. Read from ${url ?? "Hearth"} at ${when(result.at)}. Memories still carry their own basis (observed, documented, said, unverified).]`;
  }
  return result.data === undefined
    ? `[Hearth: UNREACHABLE and nothing cached on this machine. Reason: ${result.reason}. You have no homelab memory right now; say so instead of guessing.]`
    : `[Hearth: CACHED copy from ${result.at ? when(result.at) : "an unknown time"} (${age(result.at)}). Hearth could not be reached just now (${result.reason}). Nothing below was verified now: say it is from memory and may be out of date, and verify before acting. New saves are queued and sync automatically when it is back.]`;
}

/** How the briefing refers to the owner: their name if they set one, else "you". */
const who = (b: { ownerName?: string }) => b.ownerName?.trim() || "you";

const OPENING_LABEL: Record<OpeningPoint["kind"], string> = {
  "needs-you": "Needs attention",
  since: "Since last time",
  win: "Win",
  "in-progress": "In progress",
  idea: "Idea",
};

function entryLine(e: MemoryEntry, projects: Map<string, string>, owner = "you"): string {
  const bits = [
    day(e.happenedAt),
    e.projectId ? (projects.get(e.projectId) ?? e.projectId) : undefined,
    e.machine,
    e.basis === "observed"
      ? "observed"
      : e.basis === "documented"
        ? "documented"
        : e.basis === "stated"
          ? `${owner === "you" ? "you" : owner} said`
          : "unverified",
  ].filter(Boolean);
  const body = e.body
    ? ` ${e.body.replace(/\s+/g, " ").slice(0, 280)}${e.body.length > 280 ? "…" : ""}`
    : "";
  const history = e.superseded
    ? ` HISTORY, no longer how things are (${e.superseded.reason.replace(/\s+/g, " ").slice(0, 200)}).`
    : "";
  return `- ${e.title} (${bits.join(", ")}) [id ${e.id}]${history}${body}`;
}

export function briefingText(result: Result<CompanionBriefing>, url?: string): string {
  const head = provenance(result, url);
  const b = result.data;
  if (!b) return head;
  const projects = new Map(b.projects.map((p) => [p.id, p.name]));
  const owner = who(b);
  const out = [head, ""];
  if (b.ownerName) out.push(`The owner's name is ${b.ownerName}.`, "");
  if (b.sampleData) {
    out.push(
      "Note: Hearth is still showing sample data, not the owner's discovered systems, so the system numbers below are not real.",
      "",
    );
  }
  const opening = b.opening ?? [];
  if (opening.length) {
    out.push(
      "## What's up (raise briefly, in your own words, only what matters now; never add wins that are not here)",
    );
    out.push(...opening.map((p) => `- ${OPENING_LABEL[p.kind]}: ${p.text}`), "");
  }
  out.push(`## Needs ${owner === "you" ? "attention" : owner}`);
  out.push(
    b.needsYou.length
      ? b.needsYou.map((i) => `- ${i.title} (${i.severity}, since ${day(i.openedAt)})`).join("\n")
      : "- Nothing.",
  );
  out.push("", "## Systems (as Hearth monitors them)");
  out.push(
    `- ${b.system.servicesTotal} services, ${b.system.notHealthy.length} not healthy${b.system.notHealthy.length ? `: ${b.system.notHealthy.map((s) => `${s.name} on ${s.host} (${s.health})`).join(", ")}` : ""}.`,
    `- Machines: ${b.system.hosts.map((h) => `${h.name} (${h.os}, ${h.health})`).join("; ") || "none adopted yet"}.`,
    `- Backups: ${b.backups.lastFailed ? `LAST BACKUP FAILED ${when(b.backups.lastFailed.at)}: ${b.backups.lastFailed.detail}. ` : ""}${b.backups.lastOkAt ? `last good ${when(b.backups.lastOkAt)}` : "none yet"}${b.backups.offsite ? `; off-machine copy on ${b.backups.offsite.name}: ${b.backups.offsite.lastVerifiedAt ? `last confirmed ${when(b.backups.offsite.lastVerifiedAt)}` : "none confirmed yet"}${b.backups.offsite.stale ? " (OVERDUE)" : ""}, ${b.backups.offsite.waiting} waiting` : ""}.`,
  );
  out.push("", "## Recent history (NEW = written since this machine last looked)");
  out.push(
    b.recent.length
      ? b.recent
          .map((e) =>
            entryLine(e, projects, owner).replace(/^- /, e.createdAt > b.since ? "- NEW " : "- "),
          )
          .join("\n")
      : "- Nothing in the journal this week.",
  );
  out.push("", "## Open threads (unfinished work)");
  out.push(
    b.openThreads.length
      ? b.openThreads.map((e) => entryLine(e, projects, owner)).join("\n")
      : "- None.",
  );
  out.push("", "## Projects");
  out.push(
    b.projects.length
      ? b.projects
          .map(
            (p) =>
              `- ${p.name} (${p.status}; ${p.entries} memories, ${p.openThreads} open)${p.summary ? `: ${p.summary.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
          )
          .join("\n")
      : "- None recorded yet.",
  );
  if (b.howYouWork.length) {
    out.push("", `## How ${owner === "you" ? "the owner likes" : `${owner} likes`} to work`);
    out.push(
      b.howYouWork
        .map((e) => `- ${e.title}${e.body ? `: ${e.body.replace(/\s+/g, " ").slice(0, 200)}` : ""}`)
        .join("\n"),
    );
  }
  if (b.hardware.length) {
    out.push("", "## Hardware");
    out.push(b.hardware.map((e) => entryLine(e, projects, owner)).join("\n"));
  }
  if (b.recentSessions.length) {
    out.push("", "## Recent saved sessions (word for word; use recall to search them)");
    out.push(
      b.recentSessions
        .map(
          (s) =>
            `- ${s.title} (${s.client}${s.machine ? ` on ${s.machine}` : ""}, ${day(s.startedAt)}, ${s.messageCount} messages)`,
        )
        .join("\n"),
    );
  }
  out.push(
    "",
    `Memory holds ${b.counts.memories} memories and ${b.counts.transcripts} saved sessions.`,
  );
  return out.join("\n");
}

export function recallText(
  result: Result<{ hits: MemorySearchHit[]; entries: MemoryEntry[] }>,
  url?: string,
): string {
  const head = provenance(result, url);
  const data = result.data;
  if (!data) return head;
  const out = [head, ""];
  if (data.entries.length) {
    out.push("## Memories");
    for (const e of data.entries) {
      out.push(
        `### ${e.title} [id ${e.id}]`,
        `${e.kind}${e.status ? ` (${e.status})` : ""}, ${day(e.happenedAt)}, ${e.basis}${e.machine ? `, ${e.machine}` : ""}, by ${e.author ?? e.source}`,
        ...(e.superseded
          ? [
              `HISTORY: no longer how things are, so never describe it as the current setup. ${e.superseded.reason}`,
            ]
          : []),
        e.body || "(no details)",
        ...(e.verification
          ? [`Verified ${e.verification.at}: ${e.verification.check} -> ${e.verification.result}`]
          : []),
        ...(e.links.length
          ? [`Evidence: ${e.links.map((l) => `${l.label} (${l.ref})`).join(", ")}`]
          : []),
        "",
      );
    }
  }
  const sessions = data.hits.filter((h) => h.type !== "entry");
  if (sessions.length) {
    out.push("## In past conversations (matches marked [[like this]])");
    for (const h of sessions) {
      out.push(
        `- ${h.type === "transcript" ? "Session" : "App/Belle conversation"} "${h.title}", ${day(h.at)}, message ${h.seq} [${h.type} ${h.id}]: ${h.snippet}`,
      );
    }
    out.push(
      "",
      "Use read_session with the session id and message number to read the exchange around a match.",
    );
  }
  if (!data.entries.length && !sessions.length) out.push("Nothing remembered matches that.");
  return out.join("\n");
}
