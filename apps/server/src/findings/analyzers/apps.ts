import { and, eq, ne } from "drizzle-orm";
import type {
  AppIssue,
  AppQueueItem,
  FindingEvidence,
  FindingKind,
  FindingNature,
  FindingResource,
  FindingSeverity,
} from "@dragon-control/core";
import * as t from "../../db/schema";
import { APP_INTERVAL_MS } from "../../apps/service";
import type { FindingDraft, AnalyzerChange } from "../store";
import { plural, type Analyzer } from "./types";

/**
 * What the apps themselves report (Sonarr's health page, Prowlarr's failing indexers,
 * SABnzbd's failed downloads, Home Assistant's repairs...), from the reads Hearth already
 * makes every few minutes. Each issue becomes a finding with a reason and a next step. An
 * error the app reports once is suspected; repeated, it is confirmed (and the incident Hearth
 * opens for it is linked). Apps Hearth cannot read are one honest "cannot see" finding, never
 * treated as healthy.
 */

interface Rule {
  kind: FindingKind;
  nature: FindingNature;
  severity: FindingSeverity;
  why: (app: string) => string;
  next: (app: string) => string[];
}

const INVESTIGATE = (app: string) => `Ask Ember to look into it inside ${app}.`;

/** First match wins. Tested against the issue key and its text. */
const RULES: { test: RegExp; rule: Rule }[] = [
  {
    test: /update|new version|is available for download/i,
    rule: {
      nature: "maintenance",
      kind: "recommendation",
      severity: "low",
      why: (a) =>
        `A newer version of ${a} is available. Updates bring fixes, and sometimes changes worth reading about first.`,
      next: (a) => [`Read ${a}'s release notes, then update it when convenient.`],
    },
  },
  {
    test: /regrab/i,
    rule: {
      nature: "degraded",
      kind: "problem",
      severity: "high",
      why: () =>
        "Each repeat downloads the same thing again, wasting bandwidth and space, and notifies you every time.",
      next: (a) => [
        INVESTIGATE(a),
        "Usually a quality profile or custom format keeps preferring a different release.",
      ],
    },
  },
  {
    test: /indexersearch|indexerrss|no indexers|indexers? (are )?(not )?available.*search/i,
    rule: {
      nature: "failure",
      kind: "problem",
      severity: "high",
      why: (a) =>
        `Without indexers that can search or watch for new releases, ${a} cannot find anything new.`,
      next: (a) => [INVESTIGATE(a), "Check the indexers in Prowlarr."],
    },
  },
  {
    test: /indexer/i,
    rule: {
      nature: "degraded",
      kind: "problem",
      severity: "medium",
      why: () =>
        "Searches skip indexers that are failing, so some releases may never be found or arrive late.",
      next: (a) => [
        INVESTIGATE(a),
        "Test the indexer; it may be down, blocked, or need a new key.",
      ],
    },
  },
  {
    test: /removescompleted|remove completed/i,
    rule: {
      nature: "risk",
      kind: "problem",
      severity: "medium",
      why: (a) =>
        `The download client may delete a finished download before ${a} imports it, so items can go missing from your library.`,
      next: () => [
        "Change the download client so it keeps completed downloads until they are imported. Ember can plan that setting change with your approval.",
      ],
    },
  },
  {
    test: /downloadclient|download client/i,
    rule: {
      nature: "failure",
      kind: "problem",
      severity: "high",
      why: (a) => `${a} cannot hand downloads to the download client, so nothing new will arrive.`,
      next: (a) => [INVESTIGATE(a), "Check that the download client is running and reachable."],
    },
  },
  {
    test: /rootfolder|root folder/i,
    rule: {
      nature: "failure",
      kind: "problem",
      severity: "high",
      why: (a) =>
        `${a} cannot find one of its library folders, so finished downloads cannot be imported.`,
      next: (a) => [INVESTIGATE(a), "Check that the drive holding the library is mounted."],
    },
  },
  {
    test: /importlist|import list/i,
    rule: {
      nature: "degraded",
      kind: "problem",
      severity: "medium",
      why: () =>
        "Lists it follows (watchlists, collections) are failing, so new additions from them are not picked up.",
      next: (a) => [INVESTIGATE(a), "The list's service may be down or need signing in again."],
    },
  },
  {
    test: /remotepath|importmechanism|import/i,
    rule: {
      nature: "failure",
      kind: "problem",
      severity: "high",
      why: () => "Finished downloads may not be imported into your library.",
      next: (a) => [INVESTIGATE(a)],
    },
  },
  {
    test: /mount|read.?only|disk ?space|free space/i,
    rule: {
      nature: "failure",
      kind: "problem",
      severity: "high",
      why: (a) => `${a} cannot write where it needs to, so imports and downloads will fail.`,
      next: (a) => [INVESTIGATE(a), "Check the drive's free space and how it is mounted."],
    },
  },
  {
    test: /auth|api ?key/i,
    rule: {
      nature: "risk",
      kind: "recommendation",
      severity: "medium",
      why: (a) => `Anyone who can reach ${a} may be able to control it.`,
      next: (a) => [`Turn on authentication in ${a}'s settings.`],
    },
  },
  {
    test: /queue:stuck/i,
    rule: {
      nature: "degraded",
      kind: "problem",
      severity: "medium",
      why: () => "Those downloads will not reach your library until the problem is fixed.",
      next: (a) => [INVESTIGATE(a), `Open ${a}'s queue to see each item's message.`],
    },
  },
  {
    test: /queue:paused/i,
    rule: {
      nature: "state",
      kind: "suspected",
      severity: "medium",
      why: () => "While the queue is paused nothing downloads. It may have been paused on purpose.",
      next: (a) => [`If it was not paused on purpose, resume the queue in ${a}.`],
    },
  },
  {
    // An app's own scheduled task (Jellyfin's Generate Trickplay Images, Merge Episodes...), not
    // a download (11-11: these cards said "Failed downloads will not arrive").
    test: /^task:/i,
    rule: {
      nature: "maintenance",
      kind: "problem",
      severity: "low",
      why: (a) =>
        `One of ${a}'s own scheduled jobs didn't finish. Playback and downloads aren't affected; what the job does (thumbnails, merging versions, library tidying) waits until it runs again.`,
      next: (a) => [
        `Open ${a}'s Scheduled tasks to see the error and run it again.`,
        INVESTIGATE(a),
      ],
    },
  },
  {
    test: /history:failed|torrents:error|failed/i,
    rule: {
      nature: "degraded",
      kind: "problem",
      severity: "medium",
      why: () => "Failed downloads will not arrive unless they are retried or replaced.",
      next: (a) => [INVESTIGATE(a)],
    },
  },
  {
    test: /^connection$|firewalled|disconnected/i,
    rule: {
      nature: "failure",
      kind: "problem",
      severity: "high",
      why: (a) => `${a} has no working connection, so downloads stall.`,
      next: (a) => [INVESTIGATE(a), "Check the VPN it depends on."],
    },
  },
  {
    test: /^repair:/i,
    rule: {
      nature: "maintenance",
      kind: "recommendation",
      severity: "medium",
      why: (a) => `${a} itself says this needs fixing.`,
      next: (a) => [`Open Repairs in ${a}.`],
    },
  },
  {
    test: /^integration:|safe-mode|core:state/i,
    rule: {
      nature: "failure",
      kind: "problem",
      severity: "medium",
      why: () => "Devices and automations that rely on it will not work until it loads.",
      next: (a) => [INVESTIGATE(a)],
    },
  },
  {
    test: /throttled/i,
    rule: {
      nature: "degraded",
      kind: "observation",
      severity: "low",
      why: () => "Subtitles from those providers are delayed until the limit lifts.",
      next: () => ["Usually clears on its own."],
    },
  },
  {
    test: /duplicates/i,
    rule: {
      nature: "maintenance",
      kind: "recommendation",
      severity: "low",
      why: () => "Extra copies take space and can be a sign of repeated downloads.",
      next: () => ["If they are not on purpose, Ember can plan removing the extra copies."],
    },
  },
];

/** Live per-stream notes change every minute: not findings. */
const SKIP = /^session:/;

export function classify(issue: AppIssue): Rule {
  const hay = `${issue.key} ${issue.text}`;
  const match = RULES.find((r) => r.test.test(hay));
  if (match) return match.rule;
  return issue.level === "error"
    ? {
        kind: "problem",
        nature: "failure",
        severity: "high",
        why: (a) => `${a} reports an error itself; it usually needs attention inside the app.`,
        next: (a) => [INVESTIGATE(a)],
      }
    : {
        kind: "problem",
        nature: "degraded",
        severity: "medium",
        why: (a) => `${a} reports this itself; it usually needs attention inside the app.`,
        next: (a) => [INVESTIGATE(a)],
      };
}

function titleOf(name: string, text: string): string {
  const first = text.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "");
  const t = `${name}: ${first}`;
  return t.length > 110 ? `${t.slice(0, 107)}...` : t;
}

/** What the app's own report names: the items, indexers, or clients involved. */
interface Specifics {
  title?: string;
  summary?: string;
  evidence: FindingEvidence[];
  resources: FindingResource[];
  next?: string[];
}

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * Pulls the specifics out of an app's report, so a finding names what is affected instead of
 * counting it: the stuck downloads with the app's reason for each, the failing indexers, the
 * download client. Falls back to the app's own words when there is nothing more to say.
 */
export function specificsOf(name: string, issue: AppIssue, queue: AppQueueItem[]): Specifics {
  if (issue.key === "queue:stuck" && queue.length) {
    const items = queue.slice(0, 8);
    const imports = items.filter((q) => /import/i.test(`${q.status} ${q.problem}`));
    // Download Health's words for the same problem (the owner, 11-13: "the same words everywhere"):
    // a finished download the app couldn't bring in "didn't import"; a failed one "failed".
    const failed = items.filter(
      (q) => !imports.includes(q) && /fail/i.test(`${q.status} ${q.problem}`),
    );
    const one = (q: AppQueueItem) =>
      imports.includes(q)
        ? "didn't import"
        : failed.includes(q)
          ? "failed to download"
          : "is stalled";
    const many =
      imports.length === items.length
        ? `${items.length} downloads didn't import`
        : failed.length === items.length
          ? `${items.length} downloads failed`
          : `${items.length} downloads need you (${[
              imports.length && `${imports.length} didn't import`,
              failed.length && `${failed.length} failed`,
              items.length - imports.length - failed.length &&
                `${items.length - imports.length - failed.length} stalled`,
            ]
              .filter(Boolean)
              .join(", ")})`;
    return {
      title:
        items.length === 1 ? `${name}: "${items[0]!.title}" ${one(items[0]!)}` : `${name}: ${many}`,
      summary: items.map((q) => `${q.title}: ${q.status}. ${name} says: ${q.problem}`).join(" "),
      evidence: items.map((q) => ({
        label: q.title,
        value: `${q.status}${q.via ? ` via ${q.via}` : ""}. ${q.problem}`,
      })),
      resources: items.map((q) => ({ kind: "item" as const, name: q.title })),
      next: [
        imports.length
          ? `Ask Ember to read ${name}'s queue and import ${imports.length === 1 ? `"${imports[0]!.title}"` : "them"}: it shows each file and where it would go, and imports only once you approve.`
          : `Ask Ember to read ${name}'s queue: it can remove a stuck item or search for another release, once you approve.`,
      ],
    };
  }
  // Prowlarr names one indexer per report ("Indexer Alpha is failing; Prowlarr paused it").
  const one = issue.key.startsWith("indexer:")
    ? /^Indexer (.+?) is\b/.exec(issue.text)?.[1]
    : undefined;
  const indexers =
    one ?? (/indexer/i.test(issue.key) ? /:\s*([^.]+)\.?$/.exec(issue.text)?.[1] : undefined);
  if (indexers) {
    const names = indexers
      .split(/,\s*/)
      .map((n) => n.trim())
      .filter(Boolean)
      .slice(0, 8);
    return {
      evidence: names.map((n) => ({ label: "Indexer", value: n })),
      resources: names.map((n) => ({ kind: "item" as const, name: `Indexer ${n}` })),
      next: [
        `Ask Ember to test ${list(names)} with Prowlarr's own test (it changes nothing), then fix or switch off what fails, with your approval.`,
      ],
    };
  }
  const client = /download client (\S+)/i.exec(issue.text)?.[1];
  if (client) {
    return {
      evidence: [{ label: "Download client", value: client }],
      resources: [{ kind: "item" as const, name: client }],
    };
  }
  return { evidence: [], resources: [] };
}

/** A read older than this is not evidence of anything now. */
const FRESH_MS = APP_INTERVAL_MS * 3;

export function appsAnalyzer(): Analyzer {
  return {
    id: "app.health",
    source: "app",
    label: "Inside your apps",
    intervalMs: 0,
    async run({ handle, now, memo }) {
      const db = handle.db;
      const rows = await db.select().from(t.appHealth);
      const services = new Map(
        (await db.select().from(t.services).where(eq(t.services.lifecycle, "active"))).map((s) => [
          s.id,
          s,
        ]),
      );
      // An open incident on the service covers the errors the app reports: they are the same
      // trouble, shown once (the incident Hearth opened for the app's errors, if there is one).
      const open = await db
        .select({
          id: t.incidents.id,
          key: t.incidents.monitorKey,
          serviceId: t.incidents.serviceId,
        })
        .from(t.incidents)
        .where(and(ne(t.incidents.status, "resolved")));
      const openAppIncidents = new Map<string, string>();
      for (const i of open) if (i.serviceId) openAppIncidents.set(i.serviceId, i.id);
      for (const i of open)
        if (i.key?.startsWith("app:")) openAppIncidents.set(i.key.slice(4), i.id);
      const drafts: FindingDraft[] = [];
      /** Per-app issue drafts, grouped below when several apps report the same thing. */
      const issues: {
        issueKey: string;
        name: string;
        text: string;
        draft: FindingDraft;
        /** Health messages can be shared by several apps; queue items are each app's own. */
        groupable: boolean;
      }[] = [];
      const covered = new Set<string>();
      const unreadable: { name: string; why: string; kind: "key" | "reach" }[] = [];
      const versions: Record<string, string> = {};
      const before = ((memo as { versions?: Record<string, string> } | null)?.versions ??
        {}) as Record<string, string>;
      const changes: AnalyzerChange[] = [];

      for (const row of rows) {
        const service = services.get(row.serviceId);
        if (!service) continue;
        const name = service.name;
        if (row.status === "needs-key") {
          unreadable.push({ name, why: row.detail ?? "needs its key", kind: "key" });
          continue;
        }
        if (row.status === "unreachable") {
          unreadable.push({ name, why: row.detail ?? "did not answer", kind: "reach" });
          continue;
        }
        if (now.getTime() - Date.parse(row.checkedAt) > FRESH_MS) continue;
        covered.add(`app:${row.serviceId}:`);
        if (row.version) {
          versions[row.serviceId] = row.version;
          const was = before[row.serviceId];
          if (was && was !== row.version && !/sample/.test(row.version)) {
            changes.push({
              tone: "neutral",
              text: `${name} was updated to ${row.version} (was ${was})`,
              serviceId: row.serviceId,
            });
          }
        }
        const incidentId = openAppIncidents.get(row.serviceId);
        const queue = ((row.details as { queue?: AppQueueItem[] } | null)?.queue ?? []).filter(
          (q) => q.problem,
        );
        for (const issue of row.issues as AppIssue[]) {
          if (SKIP.test(issue.key)) continue;
          const rule = classify(issue);
          // An error it has reported only once is suspected until it repeats.
          const kind =
            rule.kind === "problem" &&
            issue.level === "error" &&
            !incidentId &&
            row.failingChecks < 2
              ? "suspected"
              : rule.kind;
          const sp = specificsOf(name, issue, queue);
          issues.push({
            issueKey: issue.key,
            name,
            text: issue.text,
            groupable: issue.key.startsWith("health:"),
            draft: {
              key: `app:${row.serviceId}:${issue.key}`,
              kind,
              nature: rule.nature,
              severity: rule.severity,
              // The same items (or the same message) is the same condition.
              signature: sp.resources.length
                ? sp.resources
                    .map((r) => r.name)
                    .sort()
                    .join("|")
                : issue.text,
              title: sp.title ?? titleOf(name, issue.text),
              summary: sp.summary ?? issue.text,
              why: rule.why(name),
              nextSteps: [...(sp.next ?? []), ...rule.next(name)].slice(0, 4),
              evidence: [
                {
                  label: "Reported by",
                  value: `${name}${row.version ? ` ${row.version}` : ""}`,
                  at: row.checkedAt,
                },
                ...(issue.since ? [{ label: "Since", value: issue.since }] : []),
                ...sp.evidence,
                ...(issue.link ? [{ label: "The app's help page", value: issue.link }] : []),
              ],
              resources: [{ kind: "service", id: service.id, name }, ...sp.resources],
              serviceId: service.id,
              hostId: service.hostId,
              ...(incidentId && issue.level === "error" ? { incidentId } : {}),
            },
          });
        }
      }

      // The same report from several apps (one download client setting seen by Sonarr, Radarr,
      // and Lidarr) is one cause: one finding naming them all, not three.
      const groups = new Map<string, typeof issues>();
      for (const i of issues) {
        const same = i.groupable
          ? `${i.issueKey}|${i.text.split(i.name).join("{app}")}`
          : `${i.draft.key}`;
        groups.set(same, [...(groups.get(same) ?? []), i]);
      }
      for (const group of groups.values()) {
        if (group.length === 1) {
          drafts.push(group[0]!.draft);
          continue;
        }
        const names = group.map((g) => g.name);
        const all = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        const first = group[0]!;
        const rule = classify({ level: "warning", key: first.issueKey, text: first.text });
        const text = first.text.split(first.name).join(all);
        drafts.push({
          ...first.draft,
          key: `app:shared:${first.issueKey}`,
          signature: names.slice().sort().join("|"),
          title: titleOf(all, text),
          summary: text,
          why: rule.why(all),
          // Every app's own evidence, labelled with the app, so nothing specific is lost.
          evidence: group.flatMap((g) =>
            g.draft.evidence.map((e) =>
              e.label === "Reported by" ? e : { ...e, label: `${g.name}: ${e.label}` },
            ),
          ),
          // The apps first, then what they share (the download client, the indexers).
          resources: [
            ...new Map(
              group
                .flatMap((g) => g.draft.resources)
                .sort((a, b) => Number(a.kind !== "service") - Number(b.kind !== "service"))
                .map((r) => [`${r.kind}:${r.name}`, r]),
            ).values(),
          ],
          nextSteps: [...new Set([...first.draft.nextSteps.slice(0, 1), ...rule.next(all)])].slice(
            0,
            4,
          ),
          serviceId: undefined,
          incidentId: undefined,
        });
      }

      if (unreadable.length) {
        const keys = unreadable.filter((u) => u.kind === "key");
        const reach = unreadable.filter((u) => u.kind === "reach");
        drafts.push({
          key: "app:access",
          kind: "recommendation",
          nature: "visibility",
          signature: unreadable
            .map((u) => u.name)
            .sort()
            .join("|"),
          severity: keys.length + reach.length >= 3 ? "medium" : "low",
          title: `Hearth cannot see inside ${plural(unreadable.length, "app")}`,
          summary: [
            keys.length ? `Missing keys: ${keys.map((u) => u.name).join(", ")}.` : "",
            reach.length ? `Not answering Hearth: ${reach.map((u) => u.name).join(", ")}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
          why: "Without reading inside them, Hearth cannot see their own problems (failing indexers, stuck downloads), so those will not show here.",
          nextSteps: [
            ...(keys.length
              ? ["Import their keys with Find my keys (Discover), or add them in Secure Vault."]
              : []),
            ...(reach.length ? ["Check the address Hearth has for each of them."] : []),
          ],
          evidence: unreadable.map((u) => ({ label: u.name, value: u.why })),
          resources: [],
        });
      }
      const readable = rows.filter((r) => services.has(r.serviceId)).length - unreadable.length;
      return {
        status: unreadable.length ? (readable > 0 ? "partial" : "unavailable") : "ok",
        note: rows.length
          ? `Reads ${readable} of ${readable + unreadable.length} apps${unreadable.length ? `; cannot read ${unreadable.map((u) => u.name).join(", ")}` : ""}.`
          : "No apps Hearth knows how to read are adopted yet.",
        drafts,
        covered: (key) => {
          if (key === "app:access") return true;
          // A shared report is only known to be gone when every app could be read.
          if (key.startsWith("app:shared:")) return unreadable.length === 0 && covered.size > 0;
          // Read just now, or no longer adopted (nothing left to find there).
          return (
            [...covered].some((p) => key.startsWith(p)) || !services.has(key.split(":")[1] ?? "")
          );
        },
        changes,
        memo: { versions: { ...before, ...versions } },
      };
    },
  };
}
