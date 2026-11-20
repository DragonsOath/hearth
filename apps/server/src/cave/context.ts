import { asc, desc, eq, gte, inArray } from "drizzle-orm";
import { searchUnreviewed, termsOf } from "./unreviewed";
import {
  APP_INTEGRATIONS,
  freshnessText,
  memoryFreshness,
  reservationActive,
  reservationText,
  minutesUntilReservation,
  recommendBuild,
  type BackupStatus,
  type CaveEvidence,
  type CaveFocus,
  type Incident,
  type MemoryEntry,
  type Service,
  type Workspace,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { getSetting } from "../store/settings";
import * as t from "../db/schema";
import type { Memory } from "../memory/service";

/**
 * What a question needs, gathered by Hearth before any AI is asked:
 * the live state of what it names, incidents and changes in the window it
 * means, backups, storage, and matching memories, each line citable as
 * [E1], [E2]... Most questions are then answered in one AI turn instead of
 * several rounds of tool calls (each of which re-reads everything so far),
 * and the same pack is the answer when no AI is available.
 */

export type Intent = "status" | "why" | "backups" | "changes" | "agents" | "storage" | "memory";

const INTENTS: [Intent, RegExp][] = [
  [
    "status",
    /\b(happening|status|how('?s| is| are)|healthy|health|okay|ok|running|working|up|down|everything)\b/,
  ],
  [
    "why",
    /\b(why|went down|go down|crash\w*|fail\w*|broke\w*|outage|stopped|restart\w*|buffer\w*|slow)\b/,
  ],
  ["backups", /\bbackups?\b/],
  ["changes", /\b(chang\w*|did you|what did|approv\w*|roll ?back|who )\b/],
  ["agents", /\b(agents?|while i was away|accomplish\w*|operator|ai)\b/],
  ["storage", /\b(disk|drive|storage|space|full|volume|memory usage|ram)\b/],
  [
    "memory",
    /\b(remember|decid\w*|why did we|plan\w*|threads?|todo|projects?|history|last time|before)\b/,
  ],
];

export function intentsOf(question: string): Set<Intent> {
  const q = question.toLowerCase();
  return new Set(INTENTS.filter(([, re]) => re.test(q)).map(([i]) => i));
}

/** The time a question is about, from its words. Defaults to the last three days. */
export function windowOf(
  question: string,
  now: Date,
  lastVisit?: string,
): { since: Date; label: string } {
  const q = question.toLowerCase();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const yesterday = new Date(startOfDay(now).getTime() - 86_400_000);
  if (/last night|overnight/.test(q)) {
    return { since: new Date(yesterday.getTime() + 18 * 3_600_000), label: "since 6 PM yesterday" };
  }
  if (/yesterday/.test(q)) return { since: yesterday, label: "since yesterday morning" };
  if (/today|this morning/.test(q)) return { since: startOfDay(now), label: "today" };
  if (/this week|past week|last week|7 days/.test(q)) {
    return { since: new Date(now.getTime() - 7 * 86_400_000), label: "in the last week" };
  }
  if (/while i was away|since i was (last )?here|since last time/.test(q) && lastVisit) {
    return { since: new Date(lastVisit), label: "since you were last here" };
  }
  return { since: new Date(now.getTime() - 3 * 86_400_000), label: "in the last three days" };
}

export interface ContextPack {
  /** For the AI: compact lines, each citable. */
  text: string;
  evidence: CaveEvidence[];
  /** The same facts as a plain answer, when no AI can be asked. */
  plain: string;
  intents: Intent[];
  /** One sentence naming what the owner has open, for the prompt. */
  focusLine?: string;
}

const MAX_CHARS = 6000;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const clip = (s: string, n = 220) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export async function gatherContext(input: {
  question: string;
  /** Earlier messages in this conversation, so a follow-up keeps its subject. */
  earlier?: string;
  ws: Workspace;
  handle: DbHandle;
  memory: Memory;
  backups: () => Promise<BackupStatus>;
  now: Date;
  lastVisit?: string;
  /** What the owner has open on screen; "this" means it unless they name something else. */
  focus?: CaveFocus;
  /** Reads an item selected inside a service, fresh (the browser only sends its identity). */
  selected?: (
    serviceId: string,
    item: NonNullable<CaveFocus["item"]>,
  ) => Promise<{ text: string; label: string } | undefined>;
}): Promise<ContextPack> {
  const { question, ws, handle, memory, now } = input;
  const about = `${input.earlier ?? ""}\n${question}`.toLowerCase();
  const intents = intentsOf(question);
  if (!intents.size) intents.add("status");
  const window = windowOf(question, now, input.lastVisit);
  const since = window.since.toISOString();
  const evidence: CaveEvidence[] = [];
  const lines: string[] = [];
  const plain: string[] = [];
  const cite = (e: Omit<CaveEvidence, "id">) => {
    const existing = evidence.find((x) => x.ref && x.ref === e.ref && x.label === e.label);
    if (existing) return existing.id;
    const id = `E${evidence.length + 1}`;
    evidence.push({ id, ...e });
    return id;
  };
  const hostName = new Map(ws.hosts.map((h) => [h.id, h.name]));
  const mentioned = (name: string) =>
    name.length >= 3 &&
    new RegExp(
      `(^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`,
    ).test(about);
  const base = (name: string) => name.replace(/\s*\(.*\)$/, "");
  const all = [...ws.services, ...ws.inactiveServices];
  const services = all.filter((s) => mentioned(base(s.name)) || mentioned(s.id));
  // Apps a question is about without naming them ("the indexer is down" is Prowlarr's business).
  for (const s of all) {
    const app = Object.values(APP_INTEGRATIONS).find(
      (a) => a.image.test(s.image ?? "") || a.image.test(s.name),
    );
    if (app && app.topics.test(about) && !services.includes(s)) services.push(s);
  }
  const hosts = ws.hosts.filter((h) => mentioned(h.name));

  /* What the owner has open: put it first, and say so plainly. */
  let focusLine: string | undefined;
  const focusLines: string[] = [];
  if (input.focus?.kind === "service") {
    const s = all.find((x) => x.id === input.focus!.id);
    if (s) {
      if (!services.includes(s)) services.unshift(s);
      focusLine = `The owner has ${s.name} open in Hearth. "This", "it", or "this service" means ${s.name} unless they name something else.`;
      const item =
        input.focus.item && input.selected
          ? await input.selected(s.id, input.focus.item).catch(() => undefined)
          : undefined;
      if (item) {
        const id = cite({
          label: item.label,
          ref: `service:${s.id}`,
          kind: "live",
          at: now.toISOString(),
        });
        focusLine = item.text;
        focusLines.push(`[${id}] ${item.text}`);
      }
    }
  } else if (input.focus?.kind === "project") {
    const p = await handle.db
      .select()
      .from(t.memoryProjects)
      .where(eq(t.memoryProjects.id, input.focus.id))
      .get();
    if (p) {
      focusLine = `The owner has the project "${p.name}" open in Hearth. "This" or "this project" means it unless they name something else.`;
      for (const r of p.related ?? []) {
        const s = r.kind === "service" ? all.find((x) => x.id === r.id) : undefined;
        if (s && !services.includes(s)) services.push(s);
        const h = r.kind === "host" ? ws.hosts.find((x) => x.id === r.id) : undefined;
        if (h && !hosts.includes(h)) hosts.push(h);
      }
      const tasks = await handle.db
        .select()
        .from(t.projectTasks)
        .where(eq(t.projectTasks.projectId, p.id))
        .orderBy(asc(t.projectTasks.seq));
      const jobs = await handle.db
        .select()
        .from(t.jobs)
        .where(eq(t.jobs.projectId, p.id))
        .orderBy(desc(t.jobs.createdAt))
        .limit(5);
      const id = cite({
        label: `Project: ${p.name}`,
        ref: `project:${p.id}`,
        kind: "record",
        at: p.updatedAt,
      });
      const done = tasks.filter((x) => x.status === "done").length;
      focusLines.push(
        `[${id}] Project "${p.name}" (${p.status}${p.phase ? `, ${p.phase}` : ""}): ${clip(p.summary || "no summary", 200)}. ${
          tasks.length
            ? `Tasks ${done} of ${tasks.length} done; left: ${tasks
                .filter((x) => x.status !== "done")
                .map((x) => `${x.title}${x.status === "blocked" ? " (blocked)" : ""}`)
                .slice(0, 8)
                .join("; ")}.`
            : "No tasks recorded."
        }${jobs.length ? ` Jobs: ${jobs.map((j) => `${j.title} (${j.status})`).join("; ")}.` : ""}`,
      );
    }
  }

  lines.push(...focusLines);
  plain.push(...focusLines.map((l) => l.replace(/^\[E\d+\] /, "")));

  /* How the systems involved connect: what they depend on, and what shares it with them
     (containers in one VPN tunnel, one database, one proxy). Problems often live there. */
  const byId = new Map(all.map((s) => [s.id, s]));
  const relatedLines: string[] = [];
  for (const s of services.slice(0, 6)) {
    const uses = s.dependsOn.map((id) => byId.get(id)).filter((x): x is Service => Boolean(x));
    const users = all.filter((o) => o.dependsOn.includes(s.id));
    const siblings = uses.flatMap((u) =>
      all.filter((o) => o.id !== s.id && o.dependsOn.includes(u.id)),
    );
    if (!uses.length && !users.length) continue;
    const id = cite({ label: `How ${s.name} connects`, ref: `service:${s.id}`, kind: "record" });
    const health = (x: Service) =>
      `${x.name} (${x.stopped ? "stopped on request" : (x.lifecycle ?? x.health)})`;
    relatedLines.push(
      `[${id}] ${s.name} depends on ${uses.length ? uses.map(health).join(", ") : "nothing recorded"}${
        siblings.length
          ? `; it shares that with ${[...new Set(siblings)].map(health).join(", ")}`
          : ""
      }${users.length ? `; ${users.map(health).join(", ")} depend on it` : ""}.`,
    );
  }
  lines.push(...relatedLines);

  /* Now: always, in one or two lines. */
  const notHealthy = ws.services.filter((s) => s.health !== "healthy");
  const open = ws.incidents.filter((i) => i.status !== "resolved");
  const lastRun = ws.monitoring.lastRunAt;
  const nowId = cite({
    label: `Live state, monitoring pass ${lastRun ? when(lastRun) : "not run yet"}`,
    kind: "live",
    at: lastRun,
  });
  const nowLine = `${ws.services.length} watched services, ${notHealthy.length} not healthy${notHealthy.length ? ` (${notHealthy.map((s) => `${s.name} on ${hostName.get(s.hostId) ?? s.hostId}: ${s.health}`).join("; ")})` : ""}; ${open.length} open incidents${open.length ? ` (${open.map((i) => `${i.title}, ${i.status}`).join("; ")})` : ""}.`;
  lines.push(
    `[${nowId}] Now: ${nowLine}${ws.environment === "demo" ? " SAMPLE DATA, not the owner's systems." : ""}`,
  );
  plain.push(nowLine);
  /* The owner's standing rules: always, because they bound every suggestion. */
  const svcName = (id: string) => all.find((s) => s.id === id)?.name ?? id;
  if (ws.rules.doNotTouch.length) {
    lines.push(
      `Do-not-touch list (only the owner changes these; never propose changes to them): ${ws.rules.doNotTouch
        .map((d) => `${svcName(d.serviceId)}${d.reason ? ` (${clip(d.reason, 80)})` : ""}`)
        .join("; ")}.`,
    );
  }
  if (ws.rules.reservations.length) {
    lines.push(
      `Reserved for the owner (do not start heavy work there then): ${ws.rules.reservations
        .map((r) => {
          const until = minutesUntilReservation(r, now);
          const state = reservationActive(r, now)
            ? "ACTIVE NOW"
            : until < 24 * 60
              ? `starts in ${until < 60 ? `${until} min` : `${Math.round(until / 60)} h`}`
              : "";
          return `${reservationText(r)}${state ? `, ${state}` : ""}`;
        })
        .join("; ")}.`,
    );
  }
  // The owner's homelab plan from "Help me build": what they want, so advice fits it. Nothing in
  // it is installed by the plan itself.
  const plan = await getSetting(handle.db, "homelab_plan");
  if (plan?.scan) {
    const built = recommendBuild(
      plan.answers,
      plan.scan,
      plan.chosen,
      plan.removed,
      plan.decisions ?? {},
    );
    const list = (starter: boolean) =>
      built.capabilities
        .filter((c) => c.starter === starter)
        .flatMap((c) => c.apps)
        .filter((a) => !plan.removed.includes(a.id))
        .map((a) => `${a.name}${a.installed ? " (already running)" : ""}`)
        .join(", ");
    const who =
      plan.answers.experience === "new"
        ? "brand new to this: explain simply"
        : plan.answers.experience === "some"
          ? "a little experienced"
          : plan.answers.experience === "experienced"
            ? "experienced"
            : "of unknown experience";
    // Every goal they stated, and those the plan does not fully meet with the reason, so a
    // missing wish is never mistaken for one they dropped (issue #16).
    const asked = built.requirements
      .filter((r) => r.source === "customer")
      .map((r) => `"${r.wording}" (${r.status}${r.priority ? `, ranked ${r.priority}` : ""})`)
      .join(", ");
    const unmet = built.requirements
      .filter((r) => r.status !== "included")
      .map(
        (r) =>
          `${r.wording}: ${r.status}${r.decision ? ` (their decision: ${r.decision === "include" ? "included anyway, knowing the risks" : r.decision === "later" ? "saved for later" : "accepted the substitute"})` : ""}. ${r.reason}${r.alternatives ? ` Other ways: ${r.alternatives.join(" ")}` : ""}`,
      )
      .join(" ");
    lines.push(
      `The owner's homelab plan (Help me build, ${plan.confirmed ? "finished" : "in progress"} ${when(plan.savedAt)}; planned only, nothing installed by it). Starter: ${list(true) || "none yet"}. Later, if they like: ${list(false) || "nothing"}.${plan.removed.length ? ` They removed: ${plan.removed.join(", ")}.` : ""}${built.warnings.length ? ` About this machine: ${built.warnings.join(" ")}` : ""} They are ${who}${plan.answers.pace === "teach" ? ", and want to be taught each step" : ""}.${asked ? ` What they asked for: ${asked}.` : ""}${unmet ? ` Not fully met, and why (never imply these were dropped; offer the trade-offs): ${unmet}` : ""}`,
    );
  }
  const longWork = await handle.db
    .select()
    .from(t.trackedWork)
    .where(inArray(t.trackedWork.status, ["running", "stalled"]));
  for (const w of longWork.slice(0, 5)) {
    const id = cite({
      label: `Long work: ${w.title}`,
      ref: `work:${w.id}`,
      kind: "live",
      at: w.heartbeatAt,
    });
    const line = `Long work on ${w.machine}: ${w.title}, ${w.status === "stalled" ? "STALLED (no report since " + when(w.heartbeatAt) + ")" : `running${w.progress !== null ? ` ${Math.round(w.progress)}%` : ""}, last report ${when(w.heartbeatAt)}`}${w.detail ? ` (${clip(w.detail, 100)})` : ""}${w.stopBy ? `, must stop by ${when(w.stopBy)}` : ""}.`;
    lines.push(`[${id}] ${line}`);
    if (w.status === "stalled" || intents.has("status")) plain.push(line);
  }

  if (ws.inactiveServices.length) {
    const off = ws.inactiveServices
      .map(
        (s) =>
          `${s.name} (${s.lifecycle}${s.lifecycleNote ? `: ${clip(s.lifecycleNote, 80)}` : ""})`,
      )
      .join("; ");
    lines.push(`Not watched on purpose: ${off}.`);
    if (services.some((s) => s.lifecycle)) plain.push(`Not watched on purpose: ${off}.`);
  }
  for (const h of hosts) {
    const id = cite({ label: `${h.name}`, ref: `host:${h.id}`, kind: "live", at: h.lastSeenAt });
    const line = `${h.name} (${h.os}): ${h.health}, memory ${h.memory.usedGb.toFixed(1)} of ${h.memory.totalGb.toFixed(0)} GB, CPU ${Math.round(h.cpu.usagePct)}%, last seen ${when(h.lastSeenAt)}.`;
    lines.push(`[${id}] ${line}`);
    plain.push(line);
  }

  /* What it names. */
  for (const s of services.slice(0, 6)) {
    const id = cite({ label: s.name, ref: `service:${s.id}`, kind: "live", at: s.lastCheck?.at });
    const state = s.lifecycle
      ? `${s.lifecycle} by the owner${s.lifecycleNote ? ` (${clip(s.lifecycleNote, 100)})` : ""}, not watched`
      : `${s.health}${s.lastCheck ? `, last check ${when(s.lastCheck.at)}: ${s.lastCheck.detail}` : ""}`;
    const line = `${s.name} on ${hostName.get(s.hostId) ?? s.hostId}${s.localUrl ? ` (${s.localUrl})` : ""}: ${state}.`;
    lines.push(`[${id}] ${line}`);
    plain.push(line);
  }

  /* Inside the apps it understands: for what it names, or any with problems. */
  for (const r of ws.apps) {
    const svc = ws.services.find((s) => s.id === r.serviceId);
    if (!svc) continue;
    const asked = services.some((s) => s.id === r.serviceId);
    if (!asked && (r.status === "ok" || !(intents.has("status") || intents.has("why")))) continue;
    const id = cite({
      label: `${svc.name} (inside the app)`,
      ref: `service:${svc.id}`,
      kind: "live",
      at: r.checkedAt,
    });
    const what =
      r.status === "needs-key" || r.status === "unreachable"
        ? `not read: ${clip(r.detail ?? r.status, 160)}`
        : r.issues.length
          ? r.issues.map((i) => clip(i.text, 140)).join(" ")
          : "no problems reported";
    const line = `Inside ${svc.name}${r.version ? ` ${r.version}` : ""}, read ${when(r.checkedAt)}: ${what}`;
    lines.push(`[${id}] ${line}`);
    plain.push(line);
  }

  /* Incidents in the window, or for what it names. */
  const named = new Set(services.map((s) => s.id));
  const relevant: Incident[] = ws.incidents.filter(
    (i) =>
      (i.serviceId && named.has(i.serviceId)) ||
      ((intents.has("why") ||
        intents.has("status") ||
        intents.has("changes") ||
        intents.has("agents")) &&
        (i.openedAt >= since || (i.resolvedAt ?? "") >= since)),
  );
  for (const i of relevant.slice(0, 6)) {
    const id = cite({ label: i.title, ref: `incident:${i.id}`, kind: "record", at: i.openedAt });
    const how =
      i.status === "resolved"
        ? `resolved ${i.resolvedAt ? when(i.resolvedAt) : ""} (${i.handledBy === "runbook" ? "fixed automatically" : i.handledBy === "agent" ? "fixed by the AI operator" : i.handledBy === "recovered" ? "recovered on its own" : `handled by ${i.handledBy}`}): ${clip(i.resolution ?? "")}`
        : `${i.status}: ${clip(i.timeline.at(-1)?.text ?? i.summary)}`;
    const line = `Incident "${i.title}", opened ${when(i.openedAt)}, ${how}`;
    lines.push(`[${id}] ${line}`);
    plain.push(line);
  }
  if (!relevant.length && (intents.has("why") || intents.has("status"))) {
    lines.push(`No incidents ${window.label}.`);
    plain.push(`No incidents ${window.label}.`);
  }

  /* Changes and who asked or approved. */
  if (intents.has("changes") || intents.has("agents") || intents.has("why")) {
    const audit = await handle.db
      .select()
      .from(t.auditLog)
      .where(gte(t.auditLog.at, since))
      .orderBy(desc(t.auditLog.id))
      .limit(10);
    const actions = await handle.db
      .select()
      .from(t.actions)
      .where(gte(t.actions.requestedAt, since))
      .orderBy(desc(t.actions.requestedAt))
      .limit(8);
    const jobs = await handle.db
      .select()
      .from(t.jobs)
      .where(gte(t.jobs.createdAt, since))
      .orderBy(desc(t.jobs.createdAt))
      .limit(5);
    for (const j of jobs) {
      const id = cite({
        label: `Job: ${j.title}`,
        ref: `job:${j.id}`,
        kind: "record",
        at: j.createdAt,
      });
      const by =
        j.requestedBy === "you" ? "you" : j.requestedBy === "agent" ? "the AI operator" : "Hearth";
      const line = `${when(j.createdAt)}: job "${clip(j.title, 80)}", planned by ${by}, ${j.status}${
        j.approvedAt ? ` (approved ${when(j.approvedAt)})` : ""
      }${j.summary ? `: ${clip(j.summary, 160)}` : ""}.`;
      lines.push(`[${id}] ${line}`);
      plain.push(line);
    }
    const svcName = new Map([...ws.services, ...ws.inactiveServices].map((s) => [s.id, s.name]));
    for (const a of actions) {
      const id = cite({
        label: `${a.kind} ${svcName.get(a.targetId) ?? a.targetId}`,
        ref: a.incidentId ? `incident:${a.incidentId}` : `service:${a.targetId}`,
        kind: "record",
        at: a.requestedAt,
      });
      const by =
        a.requestedBy === "you" ? "you" : a.requestedBy === "agent" ? "the AI operator" : "Hearth";
      const line = `${when(a.requestedAt)}: ${a.kind.replace(/-/g, " ")} on ${svcName.get(a.targetId) ?? a.targetId}, asked by ${by}, ${a.status}${a.result ? `: ${clip(a.result, 140)}` : ""}.`;
      lines.push(`[${id}] ${line}`);
      plain.push(line);
    }
    for (const a of audit) {
      const id = cite({ label: a.action, ref: "audit", kind: "record", at: a.at });
      const actor = a.actor === "you" ? "You" : a.actor === "agent" ? "The AI operator" : "Hearth";
      const line = `${when(a.at)}: ${actor}: ${a.action}.`;
      lines.push(`[${id}] ${line}`);
      plain.push(line);
    }
    if (!actions.length && !audit.length && !jobs.length) {
      lines.push(`No changes recorded ${window.label}.`);
      plain.push(`No changes recorded ${window.label}.`);
    }
  }

  if (intents.has("agents")) {
    const runs = await handle.db
      .select()
      .from(t.agentSessions)
      .where(gte(t.agentSessions.at, since))
      .orderBy(desc(t.agentSessions.at))
      .limit(5);
    for (const r of runs) {
      const id = cite({
        label: `AI run ${when(r.at)}`,
        ref: r.incidentId ? `incident:${r.incidentId}` : undefined,
        kind: "record",
        at: r.at,
      });
      const line = `${when(r.at)}: AI operator ${r.incidentId ? "investigated an incident" : "answered a question"} (${r.outcome}): ${clip(r.summary, 160)}`;
      lines.push(`[${id}] ${line}`);
      plain.push(line);
    }
  }

  if (intents.has("backups")) {
    const b = await input.backups();
    const last = b.recent[0];
    const id = cite({ label: "Backups", ref: "backups", kind: "record", at: last?.at });
    const line = [
      last
        ? `Last backup ${when(last.at)}: ${last.ok ? "verified" : `FAILED (${last.detail})`}.`
        : "No backups yet.",
      b.lastOk && last && !last.ok ? `Last good one ${when(b.lastOk.at)}.` : "",
      b.offsite
        ? `Off-machine copy on ${b.offsite.name}: ${b.offsite.lastVerified ? `last confirmed ${when(b.offsite.lastVerified.receivedAt)}` : "none confirmed yet"}${b.offsite.stale ? " (overdue)" : ""}, ${b.offsite.pending.length} waiting.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(`[${id}] ${line}`);
    plain.push(line);
  }

  if (intents.has("storage")) {
    for (const h of ws.hosts) {
      for (const v of h.volumes.filter((v) => v.totalTb > 0)) {
        const pct = Math.round((v.usedTb / v.totalTb) * 100);
        if (pct < 70 && !mentioned(v.label)) continue;
        const id = cite({ label: `${v.label} on ${h.name}`, ref: `host:${h.id}`, kind: "live" });
        const line = `${v.label} on ${h.name}: ${pct}% full, ${((v.totalTb - v.usedTb) * 1000).toFixed(0)} GB free${v.smart === "warning" ? ", drive reports a warning" : ""}.`;
        lines.push(`[${id}] ${line}`);
        plain.push(line);
      }
    }
  }

  /* Memories that match: history, decisions, open work. */
  const hits = (await memory.search(question, 12)).filter((h) => h.type === "entry").slice(0, 5);
  if (hits.length) {
    const entries = await Promise.all(hits.map((h) => memory.get(h.id).catch(() => undefined)));
    for (const e of entries.filter((x): x is MemoryEntry => Boolean(x))) {
      const id = cite({
        label: e.title,
        ref: `memory:${e.id}`,
        kind: "memory",
        at: e.happenedAt,
      });
      const fresh = memoryFreshness(e, now);
      const tags = [
        e.kind,
        e.basis,
        e.superseded ? "HISTORY, no longer current" : "",
        e.status === "open" ? "open" : "",
        // Setup facts drift; a stale one is a lead to verify, then confirm_memory records the check.
        fresh.ages && !e.superseded
          ? fresh.stale
            ? `STALE: ${freshnessText(fresh)}; verify before relying on it`
            : freshnessText(fresh)
          : "",
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `[${id}] Memory (${tags}) ${e.happenedAt.slice(0, 10)}: ${e.title}. ${clip(e.body, 200)}`,
      );
      plain.push(`Remembered (${e.happenedAt.slice(0, 10)}): ${e.title}.`);
    }
  }

  /* The owner's own notes that are still waiting for review: leads, never facts. */
  const words = [...termsOf(question), ...termsOf(input.earlier ?? "").slice(0, 4)];
  const leads = await searchUnreviewed(handle, [...new Set(words)], 3);
  for (const n of leads) {
    const id = cite({
      label: `Unreviewed note: ${n.title} (${n.origin})`,
      ref: `draft:${n.id}`,
      kind: "unreviewed",
    });
    lines.push(
      `[${id}] UNREVIEWED note from ${n.origin}, waiting in Memory > Review, not approved by the owner (a lead to verify, not a fact): ${n.title}. ${n.snippet}`,
    );
  }

  let text = lines.join("\n");
  if (text.length > MAX_CHARS)
    text = `${text.slice(0, MAX_CHARS)}\n(more is available through the tools)`;
  return { text, evidence, plain: plain.join("\n"), intents: [...intents], focusLine };
}
