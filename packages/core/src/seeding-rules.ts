/**
 * Seeding rules (docs/design/SEEDING_RULES.md, 11-11): the owner's own rules for torrents from
 * the indexers they pick ("TrackerOne and TrackerTwo: 3 days seeding, then remove"). Pure: the
 * server hands in the torrents (with where each came from) and the rules; these decide which rule
 * applies, how far along each torrent is, and what would happen next.
 *
 * A rule starts in preview (it says what it would do). It acts only once the owner switches it
 * to live, and one switch stops every rule.
 */

import type { Torrent } from "./dashboards";

/** What a rule does when a torrent has seeded long enough, least to most destructive. */
export type SeedingAction = "notify" | "pause" | "remove" | "delete";

export const SEEDING_ACTIONS: {
  id: SeedingAction;
  label: string;
  detail: string;
  danger?: boolean;
}[] = [
  { id: "notify", label: "Tell me", detail: "A note in the bell. The torrent keeps seeding." },
  { id: "pause", label: "Stop seeding", detail: "Pauses it. It stays in qBittorrent." },
  {
    id: "remove",
    label: "Remove the torrent, keep the files",
    detail: "Takes it out of qBittorrent. Everything it downloaded stays on disk.",
  },
  {
    id: "delete",
    label: "Delete the torrent and its files",
    detail: "Takes it out of qBittorrent and erases what it downloaded.",
    danger: true,
  },
];

export const SEEDING_ACTION_LABEL: Record<SeedingAction, string> = Object.fromEntries(
  SEEDING_ACTIONS.map((a) => [a.id, a.label]),
) as Record<SeedingAction, string>;

export interface SeedingRule {
  id: string;
  /** The owner's name for it; the indexers' names when blank. */
  name?: string;
  /** Indexer names, as Prowlarr and the *arr apps call them ("TrackerOne"). */
  indexers: string[];
  /** Tracker host names typed in by hand ("trackerone.example"), for torrents no app grabbed. */
  trackers: string[];
  /** Days of qBittorrent's seeding time. */
  days: number;
  /** Also wait for this upload ratio, when set. */
  minRatio?: number;
  action: SeedingAction;
  /** "preview" says what it would do; "live" acts (not available in stage 1). */
  mode: "preview" | "live";
  enabled: boolean;
}

/** One line of the rules' activity: what a rule did, or in preview would have done. */
export interface SeedingLogEntry {
  at: string;
  hash: string;
  name: string;
  rule: string;
  action: SeedingAction;
  mode: "preview" | "live";
  /** Seeding time and ratio when it was noted. */
  seedingSec: number;
  ratio: number;
  /** Live actions: whether it worked, and what qBittorrent or Hearth said. */
  ok?: boolean;
  result?: string;
}

/** What Hearth keeps between checks, per qBittorrent (survives restarts). */
export interface SeedingRunState {
  /** The owner's switch that stops every rule at once. */
  stopped?: boolean;
  /** Done (or given up on) per torrent, rule and action. */
  done: Record<string, string>;
  /** Failed tries per torrent, rule and action; it stops after three. */
  tries: Record<string, number>;
  /** Live actions the owner hasn't seen yet (the bell). */
  unseen: SeedingLogEntry[];
  lastCheck?: string;
}

/** Where a torrent stands against the rules that cover it. */
export interface TorrentRuleState {
  ruleId: string;
  /** Every rule covering it, by name, the deciding one first. */
  rules: string[];
  /** The requirement in force: the most days and highest ratio of all its rules. */
  needSec: number;
  minRatio?: number;
  /** The least destructive action of all its rules. */
  action: SeedingAction;
  mode: "preview" | "live";
  /** qBittorrent's seeding time so far, when it reports one. */
  seedingSec?: number;
  /** Both the time and the ratio are met. */
  met: boolean;
  /** When the time will be met if it keeps seeding (estimate). */
  dueAt?: string;
  /** In plain words: where it is and what happens next. */
  note: string;
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const ORDER: SeedingAction[] = ["notify", "pause", "remove", "delete"];

export const ruleName = (r: SeedingRule) =>
  r.name?.trim() || [...r.indexers, ...r.trackers].join(", ") || "Untitled rule";

/** A rule covers a torrent by the indexer that grabbed it, or by a tracker host it names. */
export function ruleCovers(r: SeedingRule, t: Pick<Torrent, "source" | "tracker">): boolean {
  if (!r.enabled) return false;
  const ix = t.source?.indexer ? loose(t.source.indexer) : "";
  if (ix && r.indexers.some((x) => loose(x) === ix)) return true;
  const host = t.tracker?.toLowerCase();
  return Boolean(
    host &&
    r.trackers.some((d) => {
      const want = d
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");
      return want && (host === want || host.endsWith(`.${want}`));
    }),
  );
}

/** How long, in plain words ("2 d 4 h", "35 min"). */
export function spell(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

export function ruleStateOf(
  t: Torrent,
  rules: SeedingRule[],
  now = Date.now(),
  stopped = false,
): TorrentRuleState | undefined {
  const hits = rules.filter((r) => ruleCovers(r, t));
  if (!hits.length) return undefined;
  const needSec = Math.max(...hits.map((r) => r.days * 86400));
  const ratios = hits.map((r) => r.minRatio).filter((x): x is number => x !== undefined && x > 0);
  const minRatio = ratios.length ? Math.max(...ratios) : undefined;
  const action = ORDER[Math.min(...hits.map((r) => ORDER.indexOf(r.action)))]!;
  // The deciding rule: the one asking for the most time, then the least destructive.
  const lead = [...hits].sort(
    (a, b) => b.days - a.days || ORDER.indexOf(a.action) - ORDER.indexOf(b.action),
  )[0]!;
  // Live only when every rule covering it is (the safest reading), and not while stopped.
  const mode = !stopped && hits.every((r) => r.mode === "live") ? "live" : "preview";
  const base = {
    ruleId: lead.id,
    rules: [lead, ...hits.filter((r) => r !== lead)].map(ruleName),
    needSec,
    ...(minRatio !== undefined ? { minRatio } : {}),
    action,
    mode,
  } as const;
  const verb = mode === "preview" ? "Would" : "Will";
  const doing: Record<SeedingAction, string> = {
    notify: "tell you",
    pause: "stop seeding",
    remove: "remove the torrent (files kept)",
    delete: "delete the torrent and its files",
  };

  if (t.progressPct < 100)
    return {
      ...base,
      met: false,
      note: "Still downloading. The seeding clock starts when it finishes.",
    };
  if (t.seedingSec === undefined)
    return {
      ...base,
      met: false,
      note: "qBittorrent hasn't reported its seeding time yet, so nothing happens.",
    };
  const timeMet = t.seedingSec >= needSec;
  const ratioMet = minRatio === undefined || t.ratio >= minRatio;
  const seeding = t.status === "seeding";
  if (timeMet && ratioMet)
    return {
      ...base,
      seedingSec: t.seedingSec,
      met: true,
      note: `Your rule's time is up. ${verb} ${doing[action]}.`,
    };
  const left = needSec - t.seedingSec;
  const due = !timeMet && seeding ? new Date(now + left * 1000).toISOString() : undefined;
  const parts = [
    timeMet ? "Time done" : `${spell(left)} of seeding left`,
    !ratioMet ? `ratio ${t.ratio.toFixed(2)} of ${minRatio!.toFixed(2)}` : "",
    !seeding && !timeMet ? "paused, so the clock isn't running" : "",
  ].filter(Boolean);
  return {
    ...base,
    seedingSec: t.seedingSec,
    met: false,
    ...(due ? { dueAt: due } : {}),
    note: `${parts.join(", ")}. Then ${verb.toLowerCase()} ${doing[action]}.`,
  };
}

/** Cleans a rule from the page; throws a plain-words message when it can't be saved. */
export function checkRule(r: Partial<SeedingRule>): SeedingRule {
  const indexers = [...new Set((r.indexers ?? []).map((x) => x.trim()).filter(Boolean))];
  const trackers = [...new Set((r.trackers ?? []).map((x) => x.trim()).filter(Boolean))];
  if (!indexers.length && !trackers.length)
    throw new Error("Pick at least one indexer or tracker.");
  const days = Number(r.days);
  if (!Number.isFinite(days) || days <= 0 || days > 365)
    throw new Error("Days seeding should be between 0 and 365.");
  const minRatio =
    r.minRatio === undefined || r.minRatio === null || (r.minRatio as unknown) === ""
      ? undefined
      : Number(r.minRatio);
  if (minRatio !== undefined && (!Number.isFinite(minRatio) || minRatio < 0 || minRatio > 100))
    throw new Error("Minimum ratio should be a number from 0 to 100.");
  const action = ORDER.includes(r.action as SeedingAction) ? (r.action as SeedingAction) : "notify";
  return {
    id: r.id || `rule-${Math.random().toString(36).slice(2, 10)}`,
    ...(r.name?.trim() ? { name: r.name.trim().slice(0, 80) } : {}),
    indexers,
    trackers,
    days: Math.round(days * 100) / 100,
    ...(minRatio ? { minRatio } : {}),
    action,
    // Saved rules start in preview; going live is its own step (the owner's OK).
    mode: "preview",
    enabled: r.enabled !== false,
  };
}
