import type { StepParams, TautulliDashboard, TautulliStream } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";

/**
 * Tautulli (who is watching Plex) through its API (/api/v2?apikey=...&cmd=...): what is playing
 * now and how (direct or converted, and why), this week's top people and titles, recent history;
 * and stopping a stream, a plan step you confirm, checked by reading the activity again.
 */

/** One call to Tautulli's API; its key goes in the query, so it is kept out of any message. */
export async function tautulliCmd<T>(
  fetchImpl: Fetch,
  base: string,
  key: string,
  cmd: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const q = new URLSearchParams({
    apikey: key,
    cmd,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, `/api/v2?${q.toString()}`), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS * 2),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.replaceAll(key, "[hidden]") : "no answer";
    throw new AppUnreachableError(`Tautulli did not answer at ${base}: ${why}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new AppKeyError("Tautulli refused the API key.");
  if (!res.ok) throw new AppUnreachableError(`Tautulli answered ${res.status} for ${cmd}.`);
  const body = (await res.json()) as { response?: { result?: string; message?: string; data?: T } };
  if (body.response?.result !== "success") {
    if (/api ?key/i.test(body.response?.message ?? ""))
      throw new AppKeyError("Tautulli refused the API key.");
    throw new AppUnreachableError(`Tautulli said: ${body.response?.message ?? "an error"}.`);
  }
  return body.response.data as T;
}

interface RawSession {
  session_id?: string;
  friendly_name?: string;
  user?: string;
  full_title?: string;
  title?: string;
  grandparent_title?: string;
  year?: string | number;
  media_type?: string;
  thumb?: string;
  grandparent_thumb?: string;
  progress_percent?: string | number;
  state?: string;
  player?: string;
  product?: string;
  stream_video_full_resolution?: string;
  video_full_resolution?: string;
  transcode_decision?: string;
  video_decision?: string;
  audio_decision?: string;
  subtitle_decision?: string;
  video_codec?: string;
  stream_video_codec?: string;
  audio_codec?: string;
  stream_audio_codec?: string;
  container?: string;
  stream_container?: string;
  bandwidth?: string | number;
  location?: string;
  transcode_hw_encoding?: string | number;
}

const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));

/** Why Plex is converting a stream, from what changed between the file and what is sent. */
export function whyConverted(s: RawSession): string | undefined {
  if ((s.transcode_decision ?? "direct play") === "direct play") return undefined;
  const parts: string[] = [];
  if (s.video_decision === "transcode") {
    const res =
      s.video_full_resolution &&
      s.stream_video_full_resolution &&
      s.video_full_resolution !== s.stream_video_full_resolution
        ? ` from ${s.video_full_resolution} to ${s.stream_video_full_resolution}`
        : "";
    const codec =
      s.video_codec && s.stream_video_codec && s.video_codec !== s.stream_video_codec
        ? ` (${s.video_codec} to ${s.stream_video_codec})`
        : "";
    parts.push(`video converted${res}${codec}`);
  }
  if (s.audio_decision === "transcode")
    parts.push(
      `audio converted${s.audio_codec && s.stream_audio_codec ? ` (${s.audio_codec} to ${s.stream_audio_codec})` : ""}`,
    );
  if (s.subtitle_decision === "burn") parts.push("subtitles burned in");
  if (!parts.length && s.container && s.stream_container && s.container !== s.stream_container)
    parts.push(`repackaged (${s.container} to ${s.stream_container}), picture and sound untouched`);
  if (!parts.length) return undefined;
  const text = parts.join("; ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}${num(s.transcode_hw_encoding) ? ", on the graphics card" : ""}.`;
}

function toStream(s: RawSession): TautulliStream {
  const episode = s.media_type === "episode";
  return {
    sessionId: s.session_id ?? "",
    user: s.friendly_name ?? s.user ?? "Someone",
    title: s.full_title ?? s.title ?? "Something",
    ...(num(s.year) ? { year: num(s.year) } : {}),
    mediaType: s.media_type ?? "video",
    ...((episode ? s.grandparent_thumb : s.thumb)
      ? { thumb: episode ? s.grandparent_thumb : s.thumb }
      : {}),
    progressPct: Math.round(num(s.progress_percent) ?? 0),
    state: s.state ?? "playing",
    player: [s.player, s.product].filter(Boolean).join(" · ") || "a player",
    ...((s.stream_video_full_resolution ?? s.video_full_resolution)
      ? { quality: s.stream_video_full_resolution ?? s.video_full_resolution }
      : {}),
    decision: s.transcode_decision ?? "direct play",
    ...(whyConverted(s) ? { why: whyConverted(s) } : {}),
    ...(num(s.bandwidth) !== undefined ? { bandwidthKbps: num(s.bandwidth) } : {}),
    location: s.location === "wan" ? "wan" : "lan",
  };
}

/** Everything the Tautulli panel shows, read now. */
export async function tautulliDashboard(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<TautulliDashboard> {
  const cmd = <T>(c: string, p?: Record<string, string | number>) =>
    tautulliCmd<T>(fetchImpl, base, key, c, p);
  type Stat = {
    stat_id?: string;
    rows?: { title?: string; friendly_name?: string; total_plays?: number | string }[];
  };
  const [info, activity, stats, history] = await Promise.all([
    cmd<{ tautulli_version?: string }>("get_tautulli_info").catch(() => ({
      tautulli_version: undefined,
    })),
    cmd<{
      sessions?: RawSession[];
      total_bandwidth?: number | string;
      wan_bandwidth?: number | string;
    }>("get_activity"),
    cmd<Stat[]>("get_home_stats", { time_range: 7, stats_count: 5 }).catch(() => [] as Stat[]),
    cmd<{
      data?: {
        friendly_name?: string;
        full_title?: string;
        date?: number;
        percent_complete?: number;
        player?: string;
      }[];
    }>("get_history", { length: 15 }).catch(() => ({ data: [] })),
  ]);
  const streams = (activity.sessions ?? []).map(toStream);
  const rows = (id: string) => stats.find((s) => s.stat_id === id)?.rows ?? [];
  return {
    app: "tautulli",
    ...(info.tautulli_version ? { version: info.tautulli_version.replace(/^v/, "") } : {}),
    totals: {
      streams: streams.length,
      transcoding: streams.filter((s) => s.decision === "transcode").length,
      bandwidthKbps: num(activity.total_bandwidth) ?? 0,
      remoteKbps: num(activity.wan_bandwidth) ?? 0,
    },
    streams,
    top: {
      users: rows("top_users").map((r) => ({
        name: r.friendly_name ?? "Someone",
        plays: Number(r.total_plays ?? 0),
      })),
      movies: rows("top_movies").map((r) => ({
        title: r.title ?? "A movie",
        plays: Number(r.total_plays ?? 0),
      })),
      shows: rows("top_tv").map((r) => ({
        title: r.title ?? "A show",
        plays: Number(r.total_plays ?? 0),
      })),
    },
    history: (history.data ?? []).map((h) => ({
      user: h.friendly_name ?? "Someone",
      title: h.full_title ?? "Something",
      ...(h.date ? { at: new Date(h.date * 1000).toISOString() } : {}),
      ...(h.percent_complete !== undefined ? { watchedPct: h.percent_complete } : {}),
      ...(h.player ? { player: h.player } : {}),
    })),
  };
}

/** A Plex picture through Tautulli (pms_image_proxy), for the panel: only Plex artwork paths. */
export const PLEX_IMAGE = /^\/library\/metadata\/\d+\/(thumb|art)\/\d+$/;

/** Stopping one stream: planned from who and what is playing now, checked by reading again. */
export class TautulliOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  private async session(service: { id: string; localUrl: string }, id: string) {
    const a = await this.use(service, "read who is watching", "read", (key) =>
      tautulliCmd<{ sessions?: RawSession[] }>(
        this.fetchImpl,
        service.localUrl,
        key,
        "get_activity",
      ),
    );
    const s = (a.sessions ?? []).find((x) => x.session_id === id);
    return s ? toStream(s) : undefined;
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const id = typeof params?.sessionId === "string" ? params.sessionId : "";
    if (!id) throw new Error("Say which stream (sessionId).");
    const s = await this.session(service, id);
    if (!s) throw new Error("That stream has already ended.");
    const message = typeof params?.message === "string" ? params.message.trim().slice(0, 200) : "";
    return {
      ...base,
      label: `Stop ${s.user}'s stream of ${s.title} on ${s.player}${message ? ` with the message "${message}"` : ""}`,
      serviceName: service.name,
      params: { sessionId: id, user: s.user, title: s.title, ...(message ? { message } : {}) },
      change: {
        summary: `Stop ${s.user}'s stream`,
        settings: [{ name: `${s.user}: ${s.title}`, before: s.state, after: "stopped" }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const id = String(step.params?.sessionId ?? "");
    const who = `${step.params?.user ?? "Someone"}'s stream of ${step.params?.title ?? "it"}`;
    if (!(await this.session(service, id)))
      return { ok: true, stale: true, result: `${who} had already ended.` };
    await this.use(service, "stop a stream", "change", (key) =>
      tautulliCmd(this.fetchImpl, service.localUrl, key, "terminate_session", {
        session_id: id,
        ...(typeof step.params?.message === "string" ? { message: step.params.message } : {}),
      }),
    );
    let gone = false;
    for (let i = 0; i < 5 && !gone; i++) {
      await this.wait(3_000);
      gone = !(await this.session(service, id));
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `Stopped ${who} (through ${service.name})`,
      target: `service:${service.id}`,
      detail: { verified: gone },
    });
    return gone
      ? { ok: true, result: `Stopped ${who}; it is no longer playing.` }
      : { ok: false, result: `Plex was asked to stop ${who}, but it is still listed as playing.` };
  }
}
