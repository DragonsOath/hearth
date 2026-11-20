import { and, eq, gte } from "drizzle-orm";
import * as t from "../../db/schema";
import { CLEAN_STOP_CODES } from "../../monitor/engine";
import type { ContainerInventoryItem, MonitorProbes } from "../../monitor/probes";
import type { AnalyzerChange, FindingDraft } from "../store";
import { DAY, HOUR, MIN, duration, plural, type Analyzer, clock } from "./types";

/**
 * Docker, beyond the services Hearth watches: containers nobody is watching that crashed, keep
 * restarting, or fail their health check; containers stopped so long they may be leftovers; and,
 * for watched services, being killed for running out of memory or restarted by Docker again and
 * again (from the restart history). Also notes what changed: containers added, removed, or
 * recreated from a new image.
 */

/** "Exited (137) 2 weeks ago" -> how long ago, in ms (undefined if Docker did not say). */
export function exitedAgo(statusText: string): number | undefined {
  const m = /Exited \(\d+\) (.+) ago/.exec(statusText);
  if (!m) return undefined;
  const words = m[1]!.toLowerCase();
  const n = /^(an?|about an?|less than a)\b/.test(words) ? 1 : parseInt(words, 10);
  if (Number.isNaN(n)) return undefined;
  const unit = /second/.test(words)
    ? 1000
    : /minute/.test(words)
      ? MIN
      : /hour/.test(words)
        ? HOUR
        : /day/.test(words)
          ? DAY
          : /week/.test(words)
            ? 7 * DAY
            : /month/.test(words)
              ? 30 * DAY
              : /year/.test(words)
                ? 365 * DAY
                : undefined;
  return unit === undefined ? undefined : n * unit;
}

const EXIT_MEANING: Record<number, string> = {
  1: "Exit code 1 is a general error; its logs usually say why.",
  2: "Exit code 2 usually means it was started with a wrong option.",
  125: "Exit code 125 means Docker itself could not start it.",
  126: "Exit code 126 means its command could not be run.",
  127: "Exit code 127 means its command was not found in the image.",
  134: "Exit code 134 means it aborted.",
  137: "Exit code 137 means it was killed: out of memory, or forced to stop.",
  139: "Exit code 139 means it crashed (a segmentation fault).",
};

/** Stopped longer than this, and not watched: probably a leftover. */
export const STALE_MS = 7 * DAY;

interface Memo {
  containers?: Record<string, string>;
}

export function dockerAnalyzer(probes: MonitorProbes): Analyzer {
  return {
    id: "docker.containers",
    source: "docker",
    label: "Docker containers",
    intervalMs: 5 * MIN,
    async run({ handle, now, memo, environment }) {
      // Sample data describes a pretend homelab: this machine's real containers do not belong.
      if (environment !== "real") {
        return {
          status: "off",
          note: "Looks at Docker on your real systems (not sample data).",
          drafts: [],
          covered: () => false,
        };
      }
      if (!probes.inventory) {
        return {
          status: "off",
          note: "Container inventory is not available here.",
          drafts: [],
          covered: () => false,
        };
      }
      const inv = await probes
        .inventory()
        .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      if ("error" in inv) {
        return {
          status: "unavailable",
          note: `Docker could not be read: ${inv.error}`,
          drafts: [],
          covered: () => false,
        };
      }
      const db = handle.db;
      const services = await db.select().from(t.services);
      const watched = new Map(
        services
          .filter((s) => s.lifecycle === "active" && s.checkTarget?.startsWith("container:"))
          .map((s) => [s.checkTarget!.slice("container:".length), s]),
      );
      const host = (await db.select().from(t.hosts)).find((h) => h.connection === "this-machine");
      const drafts: FindingDraft[] = [];
      const stale: { c: ContainerInventoryItem; ago: number }[] = [];
      const resource = (c: ContainerInventoryItem) => ({
        kind: "container" as const,
        name: c.name,
      });
      const evidence = (c: ContainerInventoryItem) => [
        { label: "Docker says", value: c.statusText || c.state, at: now.toISOString() },
        { label: "Image", value: c.image },
        ...(c.composeProject ? [{ label: "Compose project", value: c.composeProject }] : []),
      ];

      for (const c of inv) {
        if (watched.has(c.name)) continue;
        if (c.state === "restarting") {
          drafts.push({
            key: `docker:restarting:${c.name}`,
            kind: "problem",
            nature: "failure",
            severity: "high",
            title: `${c.name} keeps restarting`,
            summary: `Docker is restarting ${c.name} again and again (${c.statusText}). Hearth does not watch it, so nothing else will tell you.`,
            why: "A container in a restart loop is not doing its job and can wear down its own data.",
            nextSteps: [
              `Ask Ember to read ${c.name}'s logs and find the cause.`,
              "If you use it, adopt it so Hearth watches it.",
            ],
            evidence: evidence(c),
            resources: [resource(c)],
            confirmAfter: 2,
            ...(host ? { hostId: host.id } : {}),
          });
          continue;
        }
        if (c.state === "running" && c.health === "unhealthy") {
          drafts.push({
            key: `docker:unhealthy:${c.name}`,
            kind: "problem",
            nature: "degraded",
            severity: "medium",
            title: `${c.name} fails its health check`,
            summary: `${c.name} is running, but its own health check fails (${c.statusText}).`,
            why: "It is up but probably not working properly. Hearth does not watch it, so nothing else will tell you.",
            nextSteps: [`Ask Ember to read ${c.name}'s logs.`, "If you use it, adopt it."],
            evidence: evidence(c),
            resources: [resource(c)],
            confirmAfter: 2,
            ...(host ? { hostId: host.id } : {}),
          });
          continue;
        }
        if (c.state !== "stopped") continue;
        const ago = exitedAgo(c.statusText);
        if (ago !== undefined && ago >= STALE_MS) {
          stale.push({ c, ago });
          continue;
        }
        if (c.exitCode === undefined || CLEAN_STOP_CODES.has(c.exitCode)) continue;
        drafts.push({
          key: `docker:exited:${c.name}`,
          kind: "suspected",
          // Nobody watches it, so whether it should be running is not known: it may be on purpose.
          nature: "state",
          signature: `exit ${c.exitCode}`,
          severity: "medium",
          title: `${c.name} stopped with an error (exit code ${c.exitCode})`,
          summary:
            `${c.name} is not running: it ended with exit code ${c.exitCode}${ago !== undefined ? ` ${duration(ago)} ago` : ""}. ${EXIT_MEANING[c.exitCode] ?? ""}`.trim(),
          why: "If you still use it, whatever it does is not happening. Hearth does not watch it, so nothing else will tell you.",
          nextSteps: [
            `Ask Ember to read ${c.name}'s last logs and explain why it stopped.`,
            "If you no longer use it, it can be removed.",
          ],
          evidence: evidence(c),
          resources: [resource(c)],
          ...(host ? { hostId: host.id } : {}),
        });
      }

      if (stale.length) {
        stale.sort((a, b) => b.ago - a.ago);
        drafts.push({
          key: "docker:stale",
          kind: "recommendation",
          nature: "maintenance",
          // Which containers: accepting these does not hide one more being left behind.
          signature: stale
            .map(({ c }) => c.name)
            .sort()
            .join("|"),
          severity: "low",
          title: `${plural(stale.length, "container has", "containers have")} been stopped for over a week`,
          summary: `Not watched by Hearth and stopped for a while: ${stale
            .slice(0, 8)
            .map(({ c, ago }) => `${c.name} (${duration(ago)})`)
            .join(", ")}${stale.length > 8 ? ", ..." : ""}.`,
          why: "Old stopped containers keep their images and settings on disk. If they are leftovers they can go; if you still use them, they are not running.",
          nextSteps: [
            "Remove the ones you no longer use (Ember can plan it, with your approval).",
            "Adopt and start the ones you still use.",
          ],
          evidence: stale.slice(0, 12).map(({ c }) => ({
            label: c.name,
            value: `${c.statusText}, image ${c.image}`,
          })),
          resources: stale.slice(0, 12).map(({ c }) => resource(c)),
          ...(host ? { hostId: host.id } : {}),
        });
      }

      // Watched services: out-of-memory kills and Docker's own restarts, from restart history.
      const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
      const dayAgo = new Date(now.getTime() - DAY).toISOString();
      const events = await db
        .select()
        .from(t.containerEvents)
        .where(and(gte(t.containerEvents.at, weekAgo)));
      const openIncidents = new Set(
        (
          await db
            .select({ serviceId: t.incidents.serviceId })
            .from(t.incidents)
            .where(eq(t.incidents.status, "open"))
        ).map((i) => i.serviceId),
      );
      const byService = new Map<string, (typeof events)[number][]>();
      for (const e of events)
        byService.set(e.serviceId, [...(byService.get(e.serviceId) ?? []), e]);
      for (const [serviceId, list] of byService) {
        const service = services.find((s) => s.id === serviceId);
        if (!service || service.lifecycle !== "active") continue;
        const ooms = list.filter((e) => e.kind === "stop" && e.oomKilled);
        if (ooms.length) {
          drafts.push({
            key: `docker:oom:${serviceId}`,
            kind: "problem",
            nature: "degraded",
            severity: ooms.length >= 3 ? "high" : "medium",
            title: `${service.name} ran out of memory ${ooms.length === 1 ? "once" : `${ooms.length} times`} this week`,
            summary: `Docker killed ${service.name} for using too much memory ${plural(ooms.length, "time")} in the last 7 days (last ${clock(
              ooms
                .map((e) => e.at)
                .sort()
                .at(-1)!,
            )}).`,
            why: "Each kill stops it mid-work: streams drop, downloads or imports are interrupted, and repeated kills can damage its data.",
            nextSteps: [
              `Ask Ember to look at ${service.name}'s memory use and limit.`,
              "Raising its memory limit, or finding what makes it grow, usually fixes it.",
            ],
            evidence: ooms.slice(-6).map((e) => ({
              label: "Killed (out of memory)",
              value: `exit ${e.exitCode ?? "?"}`,
              at: e.at,
            })),
            resources: [{ kind: "service", id: service.id, name: service.name }],
            serviceId: service.id,
            hostId: service.hostId,
          });
        }
        const dockerStarts = list.filter(
          (e) => e.kind === "start" && e.cause === "docker" && e.at >= dayAgo,
        );
        if (dockerStarts.length >= 3 && !openIncidents.has(serviceId)) {
          drafts.push({
            key: `docker:flapping:${serviceId}`,
            kind: "suspected",
            nature: "degraded",
            severity: "medium",
            title: `${service.name} restarted on its own ${dockerStarts.length} times today`,
            summary: `Docker's restart policy brought ${service.name} back ${plural(dockerStarts.length, "time")} in the last 24 hours. Each time it recovered before Hearth's checks failed, so no incident was opened.`,
            why: "Something keeps making it crash. It looks fine between crashes, which makes this easy to miss.",
            nextSteps: [`Ask Ember to read ${service.name}'s logs around those restarts.`],
            evidence: dockerStarts.slice(-6).map((e) => ({
              label: "Restarted by Docker",
              value: `restart count ${e.restartCount ?? "?"}`,
              at: e.at,
            })),
            resources: [{ kind: "service", id: service.id, name: service.name }],
            serviceId: service.id,
            hostId: service.hostId,
          });
        }
      }

      // What changed since the last look (never on the first look: that is just the baseline).
      const previous = (memo as Memo | null)?.containers;
      const current: Record<string, string> = Object.fromEntries(
        inv.map((c) => [c.name, c.imageId ?? c.image]),
      );
      const changes: AnalyzerChange[] = [];
      if (previous) {
        for (const c of inv) {
          const was = previous[c.name];
          if (was === undefined)
            changes.push({ tone: "neutral", text: `New container: ${c.name} (${c.image})` });
          else if (was !== current[c.name])
            changes.push({
              tone: "neutral",
              text: `${c.name} was recreated from a new image (${c.image})`,
              ...(watched.get(c.name) ? { serviceId: watched.get(c.name)!.id } : {}),
            });
        }
        for (const name of Object.keys(previous))
          if (!(name in current))
            changes.push({ tone: "neutral", text: `Container removed: ${name}` });
      }

      return {
        status: "ok",
        note: `Sees ${plural(inv.length, "container")} (${inv.filter((c) => c.state === "running").length} running).`,
        drafts,
        covered: (key) => key.startsWith("docker:"),
        changes:
          changes.length > 12
            ? [{ tone: "neutral", text: `${changes.length} container changes` }]
            : changes,
        memo: { containers: current } satisfies Memo,
      };
    },
  };
}
