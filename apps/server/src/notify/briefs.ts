import { randomUUID } from "node:crypto";
import {
  BRIEF_LIMIT,
  describeBrief,
  needsAttention,
  TIME_RE,
  type Brief,
  type BriefWhat,
  type DashboardBriefing,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting, setSetting, SETTING_DEFAULTS } from "../store/settings";
import type { Notifier } from "./notifier";
import type { Message } from "./providers";

/**
 * Briefs and watches (Talome Gap Plan, item 3): a server summary on a schedule, or a word when a
 * disk passes a level, a service stops answering or a machine goes offline. Set up on the
 * Notifications page or by asking Ember in plain words. They only read Hearth's own records and
 * send a message; nothing on a system is ever changed by one (that is still an approved plan).
 *
 * Checked every minute. A summary goes out once on each chosen day, from its time (up to three
 * hours late, if Hearth was down then); a watch tells you once when it trips, again when it clears,
 * and waits out quiet hours.
 */

export interface BriefView extends Brief {
  /** What it does, in one plain sentence. */
  says: string;
}

export interface BriefInput {
  name?: string;
  what: BriefWhat;
  channels?: string[];
  enabled?: boolean;
}

const LATE_MS = 3 * 60 * 60_000;
const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Ends with a full stop, once. */
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * What changed, for the summary. Short (the owner, 11-13): the newest two, then the problems that
 * cleared as one line ("3 earlier problems cleared up"), not one "Resolved:" line each.
 */
export function changeLines(changes: { text: string }[]): string[] {
  const cleared = changes.filter((c) => c.text.startsWith("Resolved: "));
  const out = changes
    .filter((c) => !c.text.startsWith("Resolved: "))
    .slice(0, 2)
    .map((c) => sentence(c.text));
  if (cleared.length === 1) out.push(sentence(cleared[0]!.text));
  else if (cleared.length > 1) out.push(`${cleared.length} earlier problems cleared up.`);
  return out;
}

export class Briefs {
  /** The home page's briefing, for summaries (wired by the app). */
  briefing?: () => Promise<DashboardBriefing>;

  constructor(
    private readonly handle: DbHandle,
    private readonly notifier: Notifier,
    private readonly localTime: () => Date = () => notifier.localNow(),
  ) {}

  private get db() {
    return this.handle.db;
  }

  private async all(): Promise<Brief[]> {
    return ((await getSetting(this.db, "briefs")) ?? []) as Brief[];
  }

  private save(list: Brief[]) {
    return setSetting(this.db, "briefs", list);
  }

  private async names() {
    const [volumes, services, hosts] = await Promise.all([
      this.db.select().from(t.volumes),
      this.db.select().from(t.services),
      this.db.select().from(t.hosts),
    ]);
    return { volumes, services, hosts };
  }

  private says(b: Brief, n: Awaited<ReturnType<Briefs["names"]>>): string {
    const w = b.what;
    return describeBrief(w, {
      ...(w.kind === "disk" && w.volumeId
        ? { volume: n.volumes.find((v) => v.id === w.volumeId)?.label ?? "that disk" }
        : {}),
      ...(w.kind === "service-down"
        ? { service: n.services.find((s) => s.id === w.serviceId)?.name ?? "that service" }
        : {}),
      ...(w.kind === "host-offline" && w.hostId
        ? { host: n.hosts.find((h) => h.id === w.hostId)?.name ?? "that machine" }
        : {}),
    });
  }

  async list(): Promise<BriefView[]> {
    const [list, n] = await Promise.all([this.all(), this.names()]);
    return list.map((b) => ({ ...b, says: this.says(b, n) }));
  }

  /** Channels a brief can go to: set up and switched on. */
  async channels() {
    const rows = await this.db.select().from(t.notificationChannels);
    return rows
      .filter((r) => r.status === "configured" && r.enabled !== false)
      .map((r) => ({ id: r.id, name: r.name }));
  }

  private async check(what: BriefWhat, channels: string[]) {
    const n = await this.names();
    if (what.kind === "summary") {
      if (!TIME_RE.test(what.time))
        throw new InvalidRequestError("Give the time as HH:MM, like 07:00.");
      if (!what.days.length) throw new InvalidRequestError("Pick at least one day.");
    }
    if (what.kind === "disk") {
      if (what.percent < 1 || what.percent > 99)
        throw new InvalidRequestError("Pick a level between 1% and 99%.");
      if (what.volumeId && !n.volumes.some((v) => v.id === what.volumeId))
        throw new NotFoundError("Hearth doesn't know that disk.");
    }
    if (what.kind === "service-down" && !n.services.some((s) => s.id === what.serviceId))
      throw new NotFoundError("Hearth doesn't know that service.");
    if (what.kind === "host-offline" && what.hostId && !n.hosts.some((h) => h.id === what.hostId))
      throw new NotFoundError("Hearth doesn't know that machine.");
    const usable = new Set((await this.channels()).map((c) => c.id));
    const bad = channels.find((c) => !usable.has(c));
    if (bad)
      throw new InvalidRequestError("That channel isn't set up. Set it up under Channels first.");
  }

  /** Where it goes when not said: wherever "Needs your attention" already goes. */
  private async defaultChannels(): Promise<string[]> {
    const route = (await this.db.select().from(t.notificationRoutes)).find(
      (r) => r.id === "needs-you",
    );
    const usable = new Set((await this.channels()).map((c) => c.id));
    return (route?.channels ?? []).filter((c) => usable.has(c));
  }

  async create(input: BriefInput, by: Brief["createdBy"]): Promise<BriefView> {
    const list = await this.all();
    if (list.length >= BRIEF_LIMIT)
      throw new InvalidRequestError(`At most ${BRIEF_LIMIT} briefs and watches.`);
    const channels = input.channels?.length ? input.channels : await this.defaultChannels();
    if (!channels.length)
      throw new InvalidRequestError(
        "Set up a channel first (Notifications, Channels): there is nowhere to send it yet.",
      );
    await this.check(input.what, channels);
    const n = await this.names();
    const brief: Brief = {
      id: randomUUID(),
      name: "",
      what: input.what,
      channels,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
      createdBy: by,
    };
    brief.name = input.name?.trim() || this.says(brief, n).replace(/\.$/, "");
    await this.save([...list, brief]);
    return { ...brief, says: this.says(brief, n) };
  }

  async update(id: string, patch: Partial<BriefInput>): Promise<BriefView> {
    const list = await this.all();
    const i = list.findIndex((b) => b.id === id);
    if (i < 0) throw new NotFoundError("No such brief.");
    const next: Brief = { ...list[i]! };
    if (patch.what) {
      next.what = patch.what;
      delete next.tripped;
      delete next.sentFor;
    }
    if (patch.channels) next.channels = patch.channels;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.name !== undefined && patch.name.trim()) next.name = patch.name.trim();
    await this.check(next.what, next.channels);
    list[i] = next;
    await this.save(list);
    return { ...next, says: this.says(next, await this.names()) };
  }

  async remove(id: string) {
    const list = await this.all();
    if (!list.some((b) => b.id === id)) throw new NotFoundError("No such brief.");
    await this.save(list.filter((b) => b.id !== id));
  }

  /* ---------- What a brief says ---------- */

  /** The summary: health, the fullest disk, what needs you, what changed, what's working. */
  async summary(): Promise<Message> {
    const n = await this.names();
    const instance = (await getSetting(this.db, "instance_name")) ?? SETTING_DEFAULTS.instance_name;
    const appUrl = await getSetting(this.db, "app_url");
    const lines: string[] = [];
    const down = n.services.filter((s) => s.health !== "healthy");
    lines.push(
      n.services.length === 0
        ? "No services are watched yet."
        : down.length === 0
          ? `All ${n.services.length} services are healthy.`
          : `${down.length} of ${n.services.length} services need a look: ${down
              .slice(0, 4)
              .map((s) => s.name)
              .join(", ")}${down.length > 4 ? " and more" : ""}.`,
    );
    const offline = n.hosts.filter((h) => h.health === "offline");
    if (offline.length) lines.push(`Offline: ${offline.map((h) => h.name).join(", ")}.`);
    const fullest = [...n.volumes]
      .filter((v) => v.totalTb > 0)
      .sort((a, b) => b.usedTb / b.totalTb - a.usedTb / a.totalTb)[0];
    if (fullest)
      lines.push(`Fullest disk: ${fullest.label}, ${pct(fullest.usedTb, fullest.totalTb)}% full.`);
    const b = this.briefing ? await this.briefing().catch(() => undefined) : undefined;
    if (b) {
      const needs = b.attention.filter(needsAttention);
      if (needs.length)
        lines.push(
          `Needs you: ${needs
            .slice(0, 3)
            .map((f) => f.title)
            .join("; ")}${b.attentionTotal > 3 ? ` (${b.attentionTotal} in all)` : ""}.`,
        );
      else lines.push("Nothing needs you.");
      lines.push(...changeLines(b.changes));
      for (const w of b.working.slice(0, 2)) lines.push(sentence(w.text));
    }
    return {
      title: `${instance}: your summary`,
      lines: lines.slice(0, 7),
      severity: "info",
      ...(appUrl ? { link: appUrl } : {}),
    };
  }

  /** What a watch sees now: the keys tripped, each with its line. */
  private async tripped(what: BriefWhat): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const n = await this.names();
    if (what.kind === "disk")
      for (const v of n.volumes) {
        if (what.volumeId && v.id !== what.volumeId) continue;
        const p = pct(v.usedTb, v.totalTb);
        if (p >= what.percent)
          out.set(v.id, `${v.label} is ${p}% full (your level is ${what.percent}%).`);
      }
    if (what.kind === "service-down") {
      const s = n.services.find((x) => x.id === what.serviceId);
      if (s && s.health === "offline") out.set(s.id, `${s.name} isn't answering.`);
    }
    if (what.kind === "host-offline")
      for (const h of n.hosts) {
        if (what.hostId && h.id !== what.hostId) continue;
        if (h.health === "offline") out.set(h.id, `${h.name} is offline.`);
      }
    return out;
  }

  private async send(b: Brief, message: Message) {
    const results = [];
    for (const c of b.channels) results.push(await this.notifier.sendTo(c, message, "brief"));
    return results;
  }

  /** Send it now (Send now, or "send me one now"): a summary, or what a watch sees. */
  async sendNow(id: string) {
    const b = (await this.all()).find((x) => x.id === id);
    if (!b) throw new NotFoundError("No such brief.");
    let message: Message;
    if (b.what.kind === "summary") message = await this.summary();
    else {
      const now = await this.tripped(b.what);
      message = {
        title: b.name,
        lines: now.size ? [...now.values()] : ["All clear: nothing is past your level right now."],
        severity: now.size ? "warning" : "info",
      };
    }
    const results = await this.send(b, message);
    return {
      sent: results.filter((r) => r.status === "sent").length,
      failed: results.filter((r) => r.status !== "sent").map((r) => r.error ?? "Not sent."),
    };
  }

  /* ---------- Every minute ---------- */

  async tick() {
    const list = await this.all();
    if (!list.length) return;
    const now = this.localTime();
    const quiet = await this.notifier.quietHours();
    let changed = false;
    for (const b of list) {
      if (!b.enabled) continue;
      if (b.what.kind === "summary") {
        const today = localDate(now);
        if (b.sentFor === today || !b.what.days.includes(now.getDay() as never)) continue;
        const [h, m] = b.what.time.split(":").map(Number) as [number, number];
        const due = new Date(now);
        due.setHours(h, m, 0, 0);
        if (now < due || now.getTime() - due.getTime() > LATE_MS) continue;
        await this.send(b, await this.summary());
        b.sentFor = today;
        b.lastSentAt = new Date().toISOString();
        changed = true;
        continue;
      }
      const seen = await this.tripped(b.what);
      const before = new Set(b.tripped ?? []);
      const fresh = [...seen.keys()].filter((k) => !before.has(k));
      const cleared = [...before].filter((k) => !seen.has(k));
      if (!fresh.length && !cleared.length) continue;
      if (quiet) continue; // waits for quiet hours to end, then says it
      const lines = [
        ...fresh.map((k) => seen.get(k)!),
        ...(cleared.length && b.what.kind !== "disk"
          ? [`Back to normal: ${cleared.length === 1 ? "it's" : "they're"} answering again.`]
          : []),
      ];
      if (fresh.length || b.what.kind !== "disk")
        await this.send(b, {
          title: b.name,
          lines,
          severity: fresh.length ? "warning" : "info",
        });
      b.tripped = [...seen.keys()];
      b.lastSentAt = new Date().toISOString();
      changed = true;
    }
    if (changed) await this.save(list);
  }
}
