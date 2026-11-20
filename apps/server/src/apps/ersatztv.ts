import type { AppReport, ErsatzDashboard, StepParams } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppUnreachableError, joinUrl, TIMEOUT_MS, worst, type Fetch } from "./http";

/**
 * ErsatzTV (its v1 API, which takes no key on your network): every channel with what is on now
 * and next (from its own XMLTV guide), who is streaming, and two controls: rebuild a channel's
 * schedule (reset its playout) and stop a channel's stream. There is no credential, so changes
 * are guarded only by the plan you confirm.
 */

async function call(
  fetchImpl: Fetch,
  base: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
) {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    throw new AppUnreachableError(
      `ErsatzTV did not answer at ${base}: ${error instanceof Error ? error.message : "no answer"}`,
    );
  }
  return res;
}

async function getJson<T>(fetchImpl: Fetch, base: string, path: string): Promise<T> {
  const r = await call(fetchImpl, base, "GET", path);
  if (!r.ok) throw new AppUnreachableError(`ErsatzTV answered ${r.status} for ${path}.`);
  return (await r.json()) as T;
}

const unescape = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** XMLTV time "20261020143000 +0000" to ISO. */
const xmltvTime = (t: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{2})(\d{2})?/.exec(t);
  return m
    ? new Date(
        `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8] ?? "00"}`,
      ).toISOString()
    : undefined;
};

/** Now and next per channel number, from the guide ErsatzTV publishes for IPTV players. */
export function guideFrom(xml: string, now = Date.now()) {
  const numberOf = new Map<string, string>();
  for (const c of xml.matchAll(/<channel id="([^"]+)">([\s\S]*?)<\/channel>/g)) {
    const names = [...c[2]!.matchAll(/<display-name>([^<]*)<\/display-name>/g)].map((x) => x[1]!);
    const num = names.find((n) => /^\d+(\.\d+)?$/.test(n));
    if (num) numberOf.set(c[1]!, num);
  }
  const out = new Map<
    string,
    { now?: { title: string; until?: string }; next?: { title: string; at?: string } }
  >();
  for (const p of xml.matchAll(
    /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)">([\s\S]*?)<\/programme>/g,
  )) {
    const num = numberOf.get(p[3]!);
    if (!num) continue;
    const start = xmltvTime(p[1]!);
    const stop = xmltvTime(p[2]!);
    const title = unescape(/<title[^>]*>([^<]*)<\/title>/.exec(p[4]!)?.[1] ?? "Something");
    const sub = /<sub-title[^>]*>([^<]*)<\/sub-title>/.exec(p[4]!)?.[1];
    const label = sub ? `${title}: ${unescape(sub)}` : title;
    const e = out.get(num) ?? {};
    const s = start ? Date.parse(start) : 0;
    const f = stop ? Date.parse(stop) : 0;
    if (s <= now && now < f) e.now = { title: label, ...(stop ? { until: stop } : {}) };
    else if (s > now && (!e.next || (e.next.at && s < Date.parse(e.next.at))))
      e.next = { title: label, ...(start ? { at: start } : {}) };
    out.set(num, e);
  }
  return out;
}

export async function ersatzDashboard(fetchImpl: Fetch, base: string): Promise<ErsatzDashboard> {
  const [version, channels, sessions, guide] = await Promise.all([
    getJson<{ appVersion?: string }>(fetchImpl, base, "/api/version").catch(
      () => ({}) as { appVersion?: string },
    ),
    getJson<
      {
        id: number;
        number: string;
        name?: string;
        ffmpegProfile?: string;
        streamingMode?: string;
      }[]
    >(fetchImpl, base, "/api/channels"),
    getJson<{ channelNumber?: string; state?: string; clients?: unknown[] }[]>(
      fetchImpl,
      base,
      "/api/sessions",
    ).catch(() => []),
    call(fetchImpl, base, "GET", "/iptv/xmltv.xml")
      .then(async (r) => (r.ok && r.text ? await r.text() : ""))
      .catch(() => ""),
  ]);
  const g = guideFrom(guide);
  const live = new Set(sessions.map((s) => String(s.channelNumber ?? "")));
  return {
    app: "ersatztv",
    ...(version.appVersion ? { version: version.appVersion.replace(/-docker.*$/, "") } : {}),
    channels: channels
      .map((c) => ({
        number: c.number,
        name: c.name ?? `Channel ${c.number}`,
        streaming: live.has(c.number),
        ...(c.ffmpegProfile ? { profile: c.ffmpegProfile } : {}),
        ...(g.get(c.number)?.now ? { now: g.get(c.number)!.now } : {}),
        ...(g.get(c.number)?.next ? { next: g.get(c.number)!.next } : {}),
      }))
      .sort((a, b) => Number(a.number) - Number(b.number)),
    streams: sessions.length,
    guideRead: guide.length > 0,
  };
}

/** The background health read: channels with nothing scheduled now are worth knowing. */
export async function readErsatz(
  base: string,
  fetchImpl: Fetch,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const d = await ersatzDashboard(fetchImpl, base);
  const empty = d.guideRead ? d.channels.filter((c) => !c.now) : [];
  const issues = empty.length
    ? [
        {
          level: "warning" as const,
          key: "empty-channels",
          text: `${empty.length} ErsatzTV channels have nothing scheduled right now: ${empty.map((c) => c.name).join(", ")}.`,
        },
      ]
    : [];
  return {
    app: "ersatztv",
    ...(d.version ? { version: d.version } : {}),
    status: worst(issues),
    issues,
    facts: [
      { label: "Channels", value: String(d.channels.length) },
      { label: "Streaming now", value: String(d.streams) },
    ],
  };
}

export const ERSATZ_OPS = ["reset-playout", "stop-stream"] as const;
type Op = (typeof ERSATZ_OPS)[number];

export class ErsatzOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly fetchImpl: Fetch,
  ) {}

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!ERSATZ_OPS.includes(op)) throw new Error(`Say what to do: ${ERSATZ_OPS.join(", ")}.`);
    const d = await ersatzDashboard(this.fetchImpl, service.localUrl);
    const c = d.channels.find((x) => x.number === String(params?.channel));
    if (!c) throw new Error("ErsatzTV does not have that channel.");
    if (op === "stop-stream" && !c.streaming) throw new Error(`Nobody is streaming ${c.name}.`);
    const label =
      op === "reset-playout"
        ? `Rebuild the schedule of channel ${c.number} (${c.name}) in ${service.name}: it starts over from its schedule now`
        : `Stop the stream of channel ${c.number} (${c.name}) in ${service.name}; anyone watching it is cut off`;
    return {
      ...base,
      label,
      serviceName: service.name,
      params: { op, channel: c.number, name: c.name },
      change: {
        summary: label,
        settings: [{ name: c.name, before: c.now?.title ?? "nothing on", after: op }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const name = String(p.name || "the channel");
    const ch = encodeURIComponent(String(p.channel ?? ""));
    const r =
      op === "reset-playout"
        ? await call(this.fetchImpl, service.localUrl, "POST", `/api/channels/${ch}/playout/reset`)
        : await call(this.fetchImpl, service.localUrl, "DELETE", `/api/session/${ch}`);
    let outcome: StepOutcome;
    if (!r.ok) outcome = { ok: false, result: `ErsatzTV refused it (${r.status}).` };
    else if (op === "reset-playout")
      outcome = { ok: true, result: `ErsatzTV is rebuilding ${name}'s schedule.` };
    else {
      const d = await ersatzDashboard(this.fetchImpl, service.localUrl);
      outcome = d.channels.find((c) => c.number === String(p.channel))?.streaming
        ? { ok: false, result: `ErsatzTV answered, but ${name} still shows a stream.` }
        : { ok: true, result: `${name}'s stream is stopped. ErsatzTV confirms it.` };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
