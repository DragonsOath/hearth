import {
  homelabMatcher,
  type ImportPayload,
  type ImportReason,
  type ImportTier,
  type ImportTriage,
} from "@dragon-control/core";

/**
 * Sorting imported drafts so the owner reviews what needs judgement and
 * accepts the rest in bulk. Nothing here decides anything: it only
 * suggests, and says why.
 *
 * - Dated history (journal entries, resolved items) is confident: it was
 *   true when written, whatever has changed since.
 * - Current-sounding records (notes, hardware, open threads, how you work)
 *   are checked against what Hearth sees now: which machine each
 *   app runs on, its operating system, and its port. A conflict means the
 *   note describes an earlier setup; accepting it saves it as history
 *   (superseded), never as current setup.
 * - Duplicates (of another draft or an existing memory) and material not
 *   about the homelab are suggested for leaving out.
 */

export interface TriageDraft {
  id: string;
  note: string;
  payload: ImportPayload;
}

export interface SystemFacts {
  /** False while Hearth shows sample data: then nothing is compared with it. */
  real: boolean;
  hosts: { id: string; name: string; os: string; lastSeenAt: string }[];
  services: { name: string; hostId: string; localUrl?: string; checkTarget?: string }[];
}

export interface TriageContext {
  system: SystemFacts;
  entries: { id: string; title: string; body: string; happenedAt: string }[];
  /** Saved sessions, by the client's own session id. */
  sessions: { id: string; sessionRef: string; title: string }[];
  /** Your project names (from memory), so text mentioning them counts as homelab. */
  projectNames: string[];
}

/* ---------- Text helpers ---------- */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const words = (s: string) =>
  new Set(
    norm(s)
      .split(" ")
      .filter((w) => w.length > 2),
  );

/** How much of the smaller set is in the larger: "X received" is contained in "X 750 GB received". */
function containment<T>(a: Set<T>, b: Set<T>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size < 3) return 0;
  let both = 0;
  for (const x of small) if (large.has(x)) both++;
  return both / small.size;
}

/** The "(progress)" or "(takeover)" tag a log adds to a title, if any. */
const tagOf = (title: string) => /\(([^)]*)\)\s*$/.exec(title)?.[1]?.toLowerCase();

/** A title's words, without the "(progress)" or "(decision)" tag a log adds. */
const titleWords = (title: string) => words(title.replace(/\s*\([^)]*\)\s*$/, ""));

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/** Overlapping five-word runs: two texts share many only when one copies the other. */
function shingles(s: string): Set<string> {
  const w = norm(s).split(" ");
  const out = new Set<string>();
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(" "));
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mention = (name: string) =>
  new RegExp(`(^|[^a-z0-9])${escape(name.toLowerCase())}($|[^a-z0-9])`);

const day = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);

function textOf(p: ImportPayload): string {
  if (p.kind === "entry") return `${p.entry.title}\n${p.entry.body ?? ""}`;
  if (p.kind === "project") return `${p.project.name}\n${p.project.summary ?? ""}`;
  return p.session.title;
}

function excerpt(sentence: string, max = 110): string {
  const s = sentence
    .replace(/\s+/g, " ")
    .replace(/[*`_#>]/g, "")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ---------- What Hearth sees ---------- */

interface App {
  name: string;
  pattern: RegExp;
  host: string;
  os: string;
  linux: boolean;
  ports: Set<number>;
  seenAt: string;
}

/**
 * Everything Hearth watches, by name. `withUrl` false includes
 * helpers without a web address (VPN tunnels, schedulers); they are only
 * used to recognise what a document is about, since their generic names
 * ("Redis") would match too much text otherwise.
 */
function appsOf(system: SystemFacts, withUrl = true): Map<string, App> {
  const apps = new Map<string, App>();
  if (!system.real) return apps;
  const hosts = new Map(system.hosts.map((h) => [h.id, h]));
  for (const s of system.services) {
    if (withUrl && !s.localUrl) continue;
    const name = s.name.replace(/\s*\(.*\)$/, "").trim();
    if (name.length < 3) continue;
    const host = hosts.get(s.hostId);
    if (!host) continue;
    const key = name.toLowerCase();
    const app = apps.get(key) ?? {
      name,
      pattern: mention(name),
      host: host.name,
      os: host.os,
      linux: !/windows/i.test(host.os),
      ports: new Set<number>(),
      seenAt: host.lastSeenAt,
    };
    const port = Number(/:(\d{2,5})(?:\/|$)/.exec(s.localUrl ?? "")?.[1]);
    if (port) app.ports.add(port);
    apps.set(key, app);
  }
  return apps;
}

const WINDOWS =
  /\bwindows\b|docker desktop|\bwsl2?\b|\b[a-z]:\\|\.exe\b|%appdata%|program files|\bnssm\b|\bpowershell\b/i;
/** Sentences about a change or the past are history, not a claim about now. */
const TRANSITION =
  /\b(migrat\w*|moved?|moving|retired?|no longer|previously|used to|formerly|was|were|old|legacy|before|until|replaced|superseded|left behind)\b/i;

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

/** Claims in the text that disagree with what Hearth sees now. */
export function conflictsWith(
  text: string,
  apps: Map<string, App>,
  machines: string[],
): { app: App; text: string }[] {
  const found = new Map<string, { app: App; text: string }>();
  const allPorts = new Map<number, string>();
  for (const a of apps.values()) for (const p of a.ports) allPorts.set(p, a.name);

  for (const sentence of sentences(text)) {
    const lower = sentence.toLowerCase();
    if (TRANSITION.test(sentence)) continue;
    for (const app of apps.values()) {
      if (found.has(app.name) || !app.pattern.test(lower)) continue;
      if (mention(app.host).test(lower)) continue; // already says where it is now

      if (app.linux && WINDOWS.test(sentence)) {
        found.set(app.name, {
          app,
          text: `Describes ${app.name} on Windows ("${excerpt(sentence)}"). Hearth sees it on ${app.host} (${app.os}).`,
        });
        continue;
      }
      const other = machines.find(
        (m) =>
          m.toLowerCase() !== app.host.toLowerCase() &&
          new RegExp(
            `\\b(on|at|runs on|hosted on|installed on)\\s+${escape(m.toLowerCase())}\\b`,
          ).test(lower),
      );
      if (other) {
        found.set(app.name, {
          app,
          text: `Says ${app.name} is on ${other} ("${excerpt(sentence)}"). Hearth sees it on ${app.host}.`,
        });
        continue;
      }
      // A port written right after the app's name, that it no longer uses.
      const at = lower.search(app.pattern);
      const near = lower.slice(at, at + app.name.length + 50);
      const port = Number(
        /(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3}|\bport)\s*:?\s*(\d{2,5})\b/.exec(
          near,
        )?.[1],
      );
      const plausible = port >= 1000 || port === 80 || port === 443;
      if (plausible && app.ports.size && !app.ports.has(port) && !allPorts.has(port)) {
        found.set(app.name, {
          app,
          text: `Says ${app.name} answers on port ${port}. Hearth sees it on ${[...app.ports].join(", ")}.`,
        });
      }
    }
  }
  return [...found.values()];
}

/* ---------- Triage ---------- */

const REMOVED = /\b(removed|retired|decommissioned|uninstalled|deleted)\b/i;

/** The service a reference document is about: "Bazarr — Subtitle Management" is about Bazarr. */
function subjectOf(title: string): string {
  return title.split(/\s+[—–-]+\s+|\s*\(|\s+&\s+|:/)[0]!.trim();
}

/** The watched app a document is about: "Gluetun" is "Gluetun VPN", "OpnForm" is "Opnform Ingress". */
function findApp(subject: string, all: Map<string, App>): App | undefined {
  const key = subject.toLowerCase().trim();
  if (key.length < 3) return undefined;
  if (all.has(key)) return all.get(key);
  return [...all.values()].find((a) => {
    const name = a.name.toLowerCase();
    return name.startsWith(`${key} `) || key.startsWith(`${name} `);
  });
}

export function triageDrafts(drafts: TriageDraft[], ctx: TriageContext): Map<string, ImportTriage> {
  const apps = appsOf(ctx.system);
  const everything = appsOf(ctx.system, false);
  const machines = [
    ...new Set([
      ...ctx.system.hosts.map((h) => h.name),
      ...drafts.flatMap((d) =>
        d.payload.kind === "entry" && d.payload.entry.machine ? [d.payload.entry.machine] : [],
      ),
      ...drafts.flatMap((d) =>
        d.payload.kind === "session" && d.payload.session.machine
          ? [d.payload.session.machine]
          : [],
      ),
    ]),
  ].filter((m) => m.length >= 3);
  const isHomelab = homelabMatcher([
    ...machines,
    ...ctx.projectNames,
    ...[...apps.values()].map((a) => a.name),
    ...drafts.flatMap((d) => (d.payload.kind === "project" ? [d.payload.project.name] : [])),
  ]);

  const out = new Map<string, ImportTriage>();
  const reasons = new Map<string, ImportReason[]>();
  const add = (id: string, r: ImportReason) => reasons.set(id, [...(reasons.get(id) ?? []), r]);

  /* Duplicates, first, since a duplicate needs no further judgement. */
  const dupOf = new Map<string, ImportTriage["duplicateOf"]>();
  const entries = drafts.filter((d) => d.payload.kind === "entry");
  const prepared = entries.map((d) => {
    const e = (d.payload as Extract<ImportPayload, { kind: "entry" }>).entry;
    return {
      d,
      title: e.title,
      titleWords: titleWords(e.title),
      tag: tagOf(e.title),
      body: e.body ?? "",
      sh: shingles(e.body ?? ""),
      at: e.happenedAt ? Date.parse(e.happenedAt) : NaN,
    };
  });
  type Comparable = {
    titleWords: Set<string>;
    tag?: string;
    body: string;
    sh: Set<string>;
    at: number;
  };
  const same = (a: Comparable, b: Comparable) => {
    const bodies = jaccard(a.sh, b.sh);
    if (a.body.length >= 200 && b.body.length >= 200 && bodies >= 0.5) return true;
    const closeInTime =
      Number.isNaN(a.at) || Number.isNaN(b.at) || Math.abs(a.at - b.at) <= 2 * 86_400_000;
    // "(takeover)" and "(progress)" on the same subject are different events.
    if (!closeInTime || (a.tag && b.tag && a.tag !== b.tag)) return false;
    const titles =
      containment(a.titleWords, b.titleWords) >= 0.99 ||
      (jaccard(a.titleWords, b.titleWords) >= 0.7 &&
        Math.min(a.titleWords.size, b.titleWords.size) >= 3);
    // Similar titles alone can be two events in one project: the texts must agree too.
    const shortText = Math.min(a.body.length, b.body.length) < 300;
    return titles && (shortText || bodies >= 0.05);
  };
  // The fuller copy wins; the rest point at it.
  const byFullness = [...prepared].sort((a, b) => b.body.length - a.body.length || b.at - a.at);
  const keepers: typeof prepared = [];
  for (const p of byFullness) {
    const twin = keepers.find((k) => same(k, p));
    if (twin) dupOf.set(p.d.id, { type: "draft", id: twin.d.id, title: twin.title });
    else keepers.push(p);
  }
  const existing = ctx.entries.map((e) => ({
    e,
    titleWords: titleWords(e.title),
    tag: tagOf(e.title),
    body: e.body,
    sh: shingles(e.body),
    at: Date.parse(e.happenedAt),
  }));
  for (const p of keepers) {
    const twin = existing.find((x) => same(x, p));
    if (twin) dupOf.set(p.d.id, { type: "entry", id: twin.e.id, title: twin.e.title });
  }
  const projectFirst = new Map<string, { id: string; name: string; len: number }>();
  for (const d of drafts) {
    if (d.payload.kind !== "project") continue;
    const key = d.payload.project.name.toLowerCase();
    const len = d.payload.project.summary?.length ?? 0;
    const first = projectFirst.get(key);
    if (!first || len > first.len) {
      if (first) dupOf.set(first.id, { type: "draft", id: d.id, title: d.payload.project.name });
      projectFirst.set(key, { id: d.id, name: d.payload.project.name, len });
    } else dupOf.set(d.id, { type: "draft", id: first.id, title: first.name });
  }
  for (const d of drafts) {
    if (d.payload.kind !== "session") continue;
    const saved = ctx.sessions.find(
      (s) => s.sessionRef === (d.payload as { session: { sessionRef: string } }).session.sessionRef,
    );
    if (saved) dupOf.set(d.id, { type: "transcript", id: saved.id, title: saved.title });
  }

  for (const d of drafts) {
    let tier: ImportTier = "review";
    let supersede: string | undefined;
    const p = d.payload;
    const duplicate = dupOf.get(d.id);
    if (duplicate) {
      add(d.id, {
        kind: "duplicate",
        text:
          duplicate.type === "draft"
            ? `Same as another draft, "${duplicate.title}", which has more detail.`
            : duplicate.type === "entry"
              ? `Already remembered as "${duplicate.title}".`
              : `This session is already saved ("${duplicate.title}").`,
      });
      out.set(d.id, { tier: "skip", reasons: reasons.get(d.id)!, duplicateOf: duplicate });
      continue;
    }

    if (p.kind === "project") {
      tier = "confident";
      add(d.id, { kind: "history", text: "A project, named after the file it came from." });
    } else if (p.kind === "session") {
      const yours = p.session.messages.filter((m) => m.role === "you");
      const about = yours.filter((m) => isHomelab(m.text)).length;
      const share = yours.length ? about / yours.length : 0;
      const pct = Math.round(share * 100);
      if (share >= 0.3) {
        tier = "confident";
        add(d.id, {
          kind: "history",
          text: `A past session, kept word for word. ${pct}% of what you said was about the homelab.`,
        });
      } else if (share >= 0.15) {
        add(d.id, {
          kind: "check",
          text: `Mixed session: only ${pct}% of what you said was about the homelab.`,
        });
      } else {
        tier = "skip";
        add(d.id, {
          kind: "unrelated",
          text: `Mostly not about the homelab (${pct}% of what you said).`,
        });
      }
    } else {
      const e = p.entry;
      const text = textOf(p);
      const when = day(e.happenedAt);
      const reference = d.note === "reference document";
      const subject = reference ? subjectOf(e.title) : "";
      const app = subject ? findApp(subject, everything) : undefined;
      // A document about a helper is checked against that helper too.
      const checked =
        app && !apps.has(app.name.toLowerCase())
          ? new Map([...apps, [app.name.toLowerCase(), { ...app, pattern: mention(subject) }]])
          : apps;
      const conflicts = conflictsWith(text, checked, machines);

      // Without a project, judge by the title, then by how much of the text is homelab.
      const lines = (e.body ?? "").split("\n").filter((l) => l.trim().length > 20);
      const share = lines.length ? lines.filter((l) => isHomelab(l)).length / lines.length : 0;
      const loose = !e.projectName && !isHomelab(e.title);
      if (loose && (!isHomelab(text) || share < 0.1)) {
        tier = "skip";
        add(d.id, {
          kind: "unrelated",
          text: isHomelab(text)
            ? `Mostly about something else: ${Math.round(share * 100)}% of it mentions the homelab.`
            : "Doesn't mention the homelab, its machines, or its apps.",
        });
      } else if (loose && share < 0.25) {
        add(d.id, {
          kind: "check",
          text: `Mixed: only ${Math.round(share * 100)}% of it mentions the homelab.`,
        });
      } else if (e.kind === "journal" || e.kind === "win") {
        if (/no date/i.test(d.note)) {
          add(d.id, {
            kind: "check",
            text: "The note gives no date, so it is dated by when the file last changed.",
          });
        } else {
          tier = "confident";
          add(d.id, {
            kind: "history",
            text: `Dated record${when ? ` from ${when}` : ""}: history stays true.`,
          });
        }
        for (const c of conflicts.slice(0, 2)) {
          add(d.id, { kind: "history", text: `Describes the setup at the time. ${c.text}` });
        }
      } else if (e.kind === "thread" && e.status === "done") {
        tier = "confident";
        add(d.id, {
          kind: "history",
          text: "Marked resolved in your notes: kept as a closed thread.",
        });
      } else {
        // Current-sounding: a note, hardware, how you work, or open work.
        if (reference && REMOVED.test(e.title)) {
          tier = "confident";
          supersede = `The note itself says ${subject || "this"} was removed.`;
          add(d.id, {
            kind: "history",
            text: `Says ${subject || "it"} was removed: saved as history, not current setup.`,
          });
        } else if (conflicts.length) {
          for (const c of conflicts.slice(0, 3)) add(d.id, { kind: "conflict", text: c.text });
          if (e.kind === "thread") {
            // The setup it mentions changed, but the problem itself may still be real.
            add(d.id, {
              kind: "check",
              text: "Mentions the earlier setup: check whether this is still open after the move.",
            });
          } else {
            supersede = conflicts[0]!.text;
            add(d.id, {
              kind: "check",
              text: "Accepting saves it as history (superseded), not current setup, unless you say it is still current.",
            });
          }
        } else if (app) {
          tier = "confident";
          add(d.id, {
            kind: "verified",
            text: `Hearth sees ${app.name} on ${app.host} (checked ${day(app.seenAt)}), and nothing in this note conflicts with that.`,
          });
        } else if (reference) {
          add(d.id, {
            kind: "unverified",
            text: `Hearth doesn't watch ${subject || "this"}, so it can't confirm this is still how it is set up.`,
          });
        } else {
          add(d.id, {
            kind: "check",
            text:
              e.kind === "thread"
                ? `Open item${when ? ` as of ${when}` : ""}: check it is still open.`
                : e.kind === "preference"
                  ? "How you work: confirm it still applies."
                  : `Describes your setup${when ? ` as of ${when}` : ""}: confirm it is still true.`,
          });
        }
      }
      const hidden = (text.match(/\[hidden/g) ?? []).length;
      if (hidden) {
        add(d.id, {
          kind: "check",
          text: `${hidden} possible ${hidden === 1 ? "secret was" : "secrets were"} replaced with [hidden].`,
        });
      }
    }
    out.set(d.id, { tier, reasons: reasons.get(d.id) ?? [], supersede });
  }
  return out;
}
