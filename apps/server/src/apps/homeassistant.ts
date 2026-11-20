import type { AppActivity, AppConnection, AppIssue, AppReport } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import {
  carefulOf,
  routineWords,
  runsOf,
  type RoutineRun,
  type RoutineWords,
} from "./homeassistant-routines";
import {
  AppBlockedError,
  AppIncompatibleError,
  AppKeyError,
  AppUnreachableError,
  joinUrl,
  TIMEOUT_MS,
  worst,
  type Fetch,
} from "./http";

/**
 * Home Assistant, read only, with a long-lived access token from Secure Vault
 * (sent as a Bearer header to Home Assistant's own address, nowhere else).
 *
 * Read only by construction: the only requests are the GET paths and the
 * WebSocket list commands named in READ_PATHS and READ_COMMANDS below. There
 * is no code path here that calls a service, fires an event, or changes
 * configuration, whatever the token itself would allow.
 *
 * Left out on purpose: the home's location (latitude, longitude, elevation),
 * entity attributes other than a short allowlist (camera and media entities
 * carry access tokens in theirs), and the state of password-type text helpers.
 */

/** Every REST path this file may request (prefix match for the logbook). */
export const READ_PATHS = [
  "/api/config",
  "/api/states",
  "/api/config/config_entries/entry",
  "/api/error_log",
  "/api/logbook/",
  // One automation's or script's configuration, as Home Assistant's own editor reads it.
  "/api/config/automation/config/",
  "/api/config/script/config/",
] as const;
/** Every WebSocket command this file may send: registry and repair lists only. */
export const READ_COMMANDS = [
  "repairs/list_issues",
  "config/device_registry/list",
  "config/area_registry/list",
  "config/entity_registry/list",
  // Recent runs of one automation or script (its traces): when, how it ended, any error.
  "trace/list",
] as const;
type ReadCommand = (typeof READ_COMMANDS)[number];

/** The minimal WebSocket the reader needs (the global WebSocket in Node 22+). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    fn: (ev: { data?: unknown }) => void,
  ): void;
}
export type SocketFactory = (url: string) => SocketLike;

const defaultSocket: SocketFactory = (url) =>
  new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url);

/** Answered 403: the token's Home Assistant user is not an administrator. */
export class AdminOnly extends Error {}

export async function haGet<T>(
  fetchImpl: Fetch,
  base: string,
  path: string,
  token: string,
  as: "json" | "text" = "json",
): Promise<T> {
  if (!READ_PATHS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path.split("?")[0] === p))) {
    throw new Error(`Not a read Hearth makes: ${path}`);
  }
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: as === "json" ? "application/json" : "text/plain",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : "no answer";
    throw new AppUnreachableError(
      `Home Assistant did not answer at ${base}: ${why.replaceAll(token, "[hidden]")}`,
    );
  }
  if (res.status === 401) {
    throw new AppKeyError(
      "Home Assistant refused the access token. Create a new one and replace it in the vault.",
    );
  }
  if (res.status === 403) {
    // Home Assistant bans an address after repeated bad tokens with 403 too, but then every path fails.
    throw new AdminOnly(path);
  }
  if (res.status === 429) {
    throw new AppBlockedError("Home Assistant is temporarily refusing requests from Hearth.");
  }
  if (!res.ok)
    throw new AppUnreachableError(
      `Home Assistant answered ${res.status} for ${path.split("?")[0]}.`,
    );
  if (as === "text") {
    if (!res.text)
      throw new AppIncompatibleError("Home Assistant's answer could not be read as text.");
    return (await res.text()) as T;
  }
  return (await res.json()) as T;
}

/** Runs read-only WebSocket list commands; any that fail come back undefined. */
export async function haCommands(
  base: string,
  token: string,
  asked: (ReadCommand | { type: ReadCommand; [arg: string]: string | number })[],
  socket: SocketFactory = defaultSocket,
): Promise<Partial<Record<ReadCommand, unknown>>> {
  const commands = asked.map((c) => (typeof c === "string" ? c : c.type));
  for (const c of commands) {
    if (!READ_COMMANDS.includes(c)) throw new Error(`Not a read Hearth makes: ${c}`);
  }
  const url = joinUrl(base.replace(/^http/, "ws"), "/api/websocket");
  return new Promise((resolve, reject) => {
    const results: Partial<Record<ReadCommand, unknown>> = {};
    let ws: SocketLike;
    try {
      ws = socket(url);
    } catch (error) {
      reject(
        new AppUnreachableError(
          `Home Assistant's live connection could not open: ${error instanceof Error ? error.message : error}`,
        ),
      );
      return;
    }
    let pending = commands.length;
    const timer = setTimeout(() => {
      ws.close();
      resolve(results);
    }, TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      ws.close();
      resolve(results);
    };
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new AppUnreachableError("Home Assistant's live connection failed."));
    });
    ws.addEventListener("message", (ev) => {
      let msg: { type?: string; id?: number; success?: boolean; result?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      } else if (msg.type === "auth_invalid") {
        clearTimeout(timer);
        ws.close();
        reject(
          new AppKeyError(
            "Home Assistant refused the access token. Create a new one and replace it in the vault.",
          ),
        );
      } else if (msg.type === "auth_ok") {
        if (!pending) return done();
        asked.forEach((c, i) =>
          ws.send(
            JSON.stringify({ ...(typeof c === "string" ? {} : c), id: i + 1, type: commands[i] }),
          ),
        );
      } else if (msg.type === "result" && typeof msg.id === "number") {
        const command = commands[msg.id - 1];
        if (command && msg.success) results[command] = msg.result;
        if (--pending === 0) done();
      }
    });
  });
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}
export interface HaEntry {
  entry_id?: string;
  domain: string;
  title?: string;
  state?: string;
  reason?: string | null;
  disabled_by?: string | null;
}
interface HaIssue {
  domain?: string;
  issue_id?: string;
  severity?: string;
  translation_key?: string;
  ignored?: boolean;
  dismissed_version?: string | null;
  learn_more_url?: string | null;
  created?: string;
  breaks_in_ha_version?: string | null;
}

/** Attributes worth showing; everything else (pictures with tokens, raw data) is left out. */
const SAFE_ATTRIBUTES = [
  "friendly_name",
  "device_class",
  "unit_of_measurement",
  "state_class",
  "last_triggered",
  "current",
  "mode",
  "battery_level",
  "restored",
] as const;

export interface SafeEntity {
  entityId: string;
  domain: string;
  name?: string;
  state: string;
  since?: string;
  attributes?: Record<string, unknown>;
}

export function safeEntity(s: HaState): SafeEntity {
  const a = s.attributes ?? {};
  const secret = s.entity_id.startsWith("input_text.") && a.mode === "password";
  const attributes = Object.fromEntries(
    SAFE_ATTRIBUTES.filter((k) => k !== "friendly_name" && a[k] !== undefined).map((k) => [
      k,
      a[k],
    ]),
  );
  return {
    entityId: s.entity_id,
    domain: s.entity_id.split(".")[0]!,
    ...(typeof a.friendly_name === "string" ? { name: a.friendly_name } : {}),
    state: secret ? "[hidden]" : redactLine(String(s.state)).slice(0, 120),
    ...(s.last_changed ? { since: s.last_changed } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}

const BAD_ENTRY = new Set(["setup_error", "setup_retry", "failed_unload", "migration_error"]);
const ENTRY_WORDS: Record<string, string> = {
  setup_error: "failed to set up",
  setup_retry: "keeps retrying setup",
  failed_unload: "failed to unload",
  migration_error: "failed to migrate",
  not_loaded: "not loaded",
  loaded: "loaded",
};

/** The background read: version, state, integrations, repairs, and entity counts. */
export async function readHomeAssistant(
  base: string,
  token: string,
  fetchImpl: Fetch,
  socket?: SocketFactory,
): Promise<Omit<AppReport, "serviceId" | "checkedAt">> {
  const config = await haGet<{
    version?: string;
    state?: string;
    safe_mode?: boolean;
    recovery_mode?: boolean;
    components?: string[];
  }>(fetchImpl, base, "/api/config", token);
  const [states, entries, ws] = await Promise.all([
    haGet<HaState[]>(fetchImpl, base, "/api/states", token),
    haGet<HaEntry[]>(fetchImpl, base, "/api/config/config_entries/entry", token).catch(
      (e: unknown) => {
        if (e instanceof AdminOnly) return undefined;
        throw e;
      },
    ),
    haCommands(base, token, ["repairs/list_issues"], socket).catch((e: unknown) => {
      if (e instanceof AppKeyError) throw e;
      return {} as Partial<Record<ReadCommand, unknown>>;
    }),
  ]);
  const issues: AppIssue[] = [];
  if (config.state && config.state !== "RUNNING") {
    issues.push({
      level: "warning",
      key: "core:state",
      text: `Home Assistant is ${config.state.toLowerCase()}, not running normally.`,
    });
  }
  if (config.safe_mode || config.recovery_mode) {
    issues.push({
      level: "error",
      key: "core:safe-mode",
      text: `Home Assistant started in ${config.recovery_mode ? "recovery" : "safe"} mode: custom integrations or configuration did not load.`,
    });
  }
  const bad = (entries ?? []).filter((e) => !e.disabled_by && BAD_ENTRY.has(e.state ?? ""));
  for (const e of bad) {
    issues.push({
      level: e.state === "setup_retry" ? "warning" : "error",
      key: `integration:${e.entry_id ?? e.domain}`,
      text: `${e.title || e.domain} (${e.domain}) ${ENTRY_WORDS[e.state!] ?? e.state}${e.reason ? `: ${redactLine(e.reason).slice(0, 200)}` : ""}.`,
    });
  }
  const repairs = (
    (ws["repairs/list_issues"] as { issues?: HaIssue[] } | undefined)?.issues ?? []
  ).filter((i) => !i.ignored && !i.dismissed_version);
  for (const r of repairs.slice(0, 10)) {
    issues.push({
      level: r.severity === "error" || r.severity === "critical" ? "error" : "warning",
      key: `repair:${r.domain}:${r.issue_id}`,
      text: `Repair needed (${r.domain}): ${(r.translation_key ?? r.issue_id ?? "issue").replaceAll("_", " ")}${r.breaks_in_ha_version ? `, breaks in ${r.breaks_in_ha_version}` : ""}.`,
      ...(r.created ? { since: r.created } : {}),
      ...(r.learn_more_url ? { link: r.learn_more_url } : {}),
    });
  }

  const unavailable = states.filter((s) => s.state === "unavailable");
  const automations = states.filter((s) => s.entity_id.startsWith("automation."));
  const domains = new Map<string, number>();
  for (const s of states) {
    const d = s.entity_id.split(".")[0]!;
    domains.set(d, (domains.get(d) ?? 0) + 1);
  }
  const connections: AppConnection[] | undefined = entries
    ?.filter((e) => !e.disabled_by)
    .map((e) => ({
      name: `${e.title || e.domain} (${e.domain})`,
      ok: !BAD_ENTRY.has(e.state ?? ""),
      ...(e.state && e.state !== "loaded" ? { detail: ENTRY_WORDS[e.state] ?? e.state } : {}),
    }));
  const activity: AppActivity[] = automations
    .map((a) => ({ a, at: a.attributes?.last_triggered }))
    .filter((x): x is { a: HaState; at: string } => typeof x.at === "string")
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, 12)
    .map(({ a, at }) => ({
      at,
      text: `Automation ran: ${String(a.attributes?.friendly_name ?? a.entity_id)}`,
    }));

  return {
    app: "homeassistant",
    version: config.version,
    status: worst(issues),
    issues,
    facts: [
      { label: "Entities", value: String(states.length) },
      { label: "Unavailable", value: String(unavailable.length) },
      {
        label: "Automations",
        value: `${automations.length} (${automations.filter((a) => a.state === "on").length} on)`,
      },
      {
        label: "Integrations",
        value: entries
          ? `${entries.length} (${bad.length} failing)`
          : "Needs an administrator's token to list",
      },
      { label: "Repairs", value: String(repairs.length) },
    ],
    ...(connections ? { connections } : {}),
    activity,
  };
}

/** The deeper reads Ember can ask for, one section at a time. */
export type HaSection =
  | "entities"
  | "automations"
  | "routine"
  | "integrations"
  | "devices"
  | "repairs"
  | "error_log"
  | "logbook";

export interface HaQuery {
  section: HaSection;
  domain?: string;
  search?: string;
  entityId?: string;
  hours?: number;
  limit?: number;
}

export async function readHomeAssistantSection(
  base: string,
  token: string,
  fetchImpl: Fetch,
  q: HaQuery,
  socket?: SocketFactory,
): Promise<unknown> {
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const needle = q.search?.toLowerCase();
  const match = (...texts: (string | undefined | null)[]) =>
    !needle || texts.some((t) => t?.toLowerCase().includes(needle));
  const adminOnly = (what: string) =>
    `Home Assistant only shows ${what} to an administrator. The token in the vault belongs to a user who is not one.`;

  switch (q.section) {
    case "entities": {
      const states = await haGet<HaState[]>(fetchImpl, base, "/api/states", token);
      const found = states
        .filter((s) => !q.domain || s.entity_id.startsWith(`${q.domain}.`))
        .filter((s) => match(s.entity_id, String(s.attributes?.friendly_name ?? ""), s.state));
      return { total: found.length, entities: found.slice(0, limit).map(safeEntity) };
    }
    case "automations": {
      const states = await haGet<HaState[]>(fetchImpl, base, "/api/states", token);
      const found = states
        .filter((s) => /^(automation|script|scene)\./.test(s.entity_id))
        .filter((s) => !q.domain || s.entity_id.startsWith(`${q.domain}.`))
        .filter((s) => match(s.entity_id, String(s.attributes?.friendly_name ?? "")));
      return { total: found.length, items: found.slice(0, limit).map(safeEntity) };
    }
    case "routine": {
      const id = q.entityId ?? "";
      if (!/^(automation|script|scene)\.[a-z0-9_]+$/.test(id))
        return { note: "Say which automation, script, or scene (its entity id)." };
      return routineDetail(base, token, fetchImpl, id, socket);
    }
    case "integrations": {
      try {
        const entries = await haGet<HaEntry[]>(
          fetchImpl,
          base,
          "/api/config/config_entries/entry",
          token,
        );
        const found = entries.filter((e) => match(e.domain, e.title));
        return {
          total: found.length,
          integrations: found.slice(0, limit).map((e) => ({
            domain: e.domain,
            title: e.title,
            state: ENTRY_WORDS[e.state ?? ""] ?? e.state,
            ...(e.reason ? { reason: redactLine(e.reason).slice(0, 300) } : {}),
            ...(e.disabled_by ? { disabledBy: e.disabled_by } : {}),
          })),
        };
      } catch (e) {
        if (e instanceof AdminOnly) return { note: adminOnly("integrations") };
        throw e;
      }
    }
    case "devices": {
      const r = await haCommands(
        base,
        token,
        ["config/device_registry/list", "config/area_registry/list"],
        socket,
      );
      const devices = r["config/device_registry/list"] as
        | {
            id: string;
            name?: string;
            name_by_user?: string;
            manufacturer?: string;
            model?: string;
            area_id?: string;
            disabled_by?: string;
            sw_version?: string;
            via_device_id?: string;
          }[]
        | undefined;
      if (!devices) return { note: adminOnly("the device list") };
      const areas = new Map(
        (
          (r["config/area_registry/list"] as { area_id: string; name: string }[] | undefined) ?? []
        ).map((a) => [a.area_id, a.name]),
      );
      const found = devices
        .map((d) => ({
          name: d.name_by_user || d.name || "Unnamed device",
          manufacturer: d.manufacturer,
          model: d.model,
          ...(d.area_id ? { area: areas.get(d.area_id) ?? d.area_id } : {}),
          ...(d.sw_version ? { firmware: d.sw_version } : {}),
          ...(d.disabled_by ? { disabledBy: d.disabled_by } : {}),
        }))
        .filter((d) => match(d.name, d.manufacturer, d.model, d.area));
      return { total: found.length, devices: found.slice(0, limit) };
    }
    case "repairs": {
      const r = await haCommands(base, token, ["repairs/list_issues"], socket);
      const issues = (r["repairs/list_issues"] as { issues?: HaIssue[] } | undefined)?.issues;
      if (!issues) return { note: adminOnly("repairs") };
      return {
        issues: issues.map((i) => ({
          domain: i.domain,
          issue: (i.translation_key ?? i.issue_id ?? "").replaceAll("_", " "),
          severity: i.severity,
          ignored: Boolean(i.ignored || i.dismissed_version),
          ...(i.created ? { since: i.created } : {}),
          ...(i.breaks_in_ha_version ? { breaksIn: i.breaks_in_ha_version } : {}),
          ...(i.learn_more_url ? { learnMore: i.learn_more_url } : {}),
        })),
      };
    }
    case "error_log": {
      try {
        const text = await haGet<string>(fetchImpl, base, "/api/error_log", token, "text");
        const lines = text
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .filter((l) => match(l))
          .map((l) => {
            const clean = redactLine(l);
            return clean.length > 500 ? `${clean.slice(0, 500)}...` : clean;
          });
        return { total: lines.length, lines: lines.slice(-limit) };
      } catch (e) {
        if (e instanceof AdminOnly) return { note: adminOnly("its log") };
        throw e;
      }
    }
    case "logbook": {
      if (!q.entityId || !/^[a-z_]+\.[a-z0-9_]+$/.test(q.entityId)) {
        return { note: "The logbook needs one entity id, like light.kitchen." };
      }
      const hours = Math.min(168, Math.max(1, q.hours ?? 24));
      const start = new Date(Date.now() - hours * 3_600_000).toISOString();
      const rows = await haGet<
        {
          when?: string;
          name?: string;
          message?: string;
          state?: string;
          context_event_type?: string;
          context_domain?: string;
          context_service?: string;
          context_user_id?: string;
        }[]
      >(
        fetchImpl,
        base,
        `/api/logbook/${encodeURIComponent(start)}?entity=${encodeURIComponent(q.entityId)}`,
        token,
      );
      return {
        hours,
        entries: rows.slice(-limit).map((r) => ({
          at: r.when,
          ...(r.state !== undefined ? { state: r.state } : {}),
          ...(r.message ? { message: redactLine(r.message).slice(0, 200) } : {}),
          ...(r.context_domain
            ? {
                triggeredBy: `${r.context_domain}${r.context_service ? `.${r.context_service}` : ""}`,
              }
            : {}),
          ...(r.context_user_id ? { byAPerson: true } : {}),
        })),
      };
    }
  }
}

/** What a routine is and does, in plain words, with its recent runs (for the panel and Ember). */
export interface RoutineDetail extends Partial<RoutineWords> {
  entityId: string;
  name: string;
  kind: "automation" | "script" | "scene";
  state: string;
  lastRan?: string;
  runs?: RoutineRun[];
  /** Why parts are missing (the token is not an administrator's, a YAML-only automation). */
  note?: string;
}

export async function routineDetail(
  base: string,
  token: string,
  fetchImpl: Fetch,
  entityId: string,
  socket?: SocketFactory,
  /** Its recent runs too (a live connection); plans only need its steps. */
  withRuns = true,
): Promise<RoutineDetail> {
  const states = await haGet<HaState[]>(fetchImpl, base, "/api/states", token);
  const s = states.find((x) => x.entity_id === entityId);
  const names = new Map(
    states.map((x) => [
      x.entity_id,
      typeof x.attributes?.friendly_name === "string" ? x.attributes.friendly_name : x.entity_id,
    ]),
  );
  const name = (id: string) => names.get(id) ?? id;
  const kind = entityId.split(".")[0] as RoutineDetail["kind"];
  const objectId = entityId.split(".")[1]!;
  const out: RoutineDetail = {
    entityId,
    name: name(entityId),
    kind,
    state: s?.state ?? "missing",
    ...(typeof s?.attributes?.last_triggered === "string"
      ? { lastRan: s.attributes.last_triggered }
      : kind === "scene" && s && !["unknown", "unavailable"].includes(s.state)
        ? { lastRan: s.state }
        : {}),
  };
  if (!s) return { ...out, note: "Home Assistant does not have it any more." };
  if (kind === "scene") {
    const members = list(s.attributes?.entity_id).map((x) => name(String(x)));
    return {
      ...out,
      steps: members.length ? [`Sets ${members.join(", ")} the way the scene saved them`] : [],
      careful: carefulOf({
        sequence: list(s.attributes?.entity_id).map((x) => ({
          action: `${String(x).split(".")[0]}.turn_on`,
        })),
      }),
      triggers: [],
      conditions: [],
      needsInput: [],
    };
  }
  // Automations are edited by their own id (in their attributes); scripts by their object id.
  const configId = kind === "automation" ? s.attributes?.id : objectId;
  const notes: string[] = [];
  let words: RoutineWords | undefined;
  if (typeof configId === "string" && configId) {
    try {
      const config = await haGet<unknown>(
        fetchImpl,
        base,
        `/api/config/${kind}/config/${encodeURIComponent(configId)}`,
        token,
      );
      words = routineWords(config, name);
    } catch (e) {
      if (e instanceof AdminOnly)
        notes.push("Its steps need an administrator's token in the vault to read.");
      else
        notes.push("Its steps could not be read (it may be written in YAML outside the editor).");
    }
  } else notes.push("It has no editor id, so its steps cannot be read (written in YAML).");
  let runs: RoutineRun[] | undefined;
  if (withRuns)
    try {
      const r = await haCommands(
        base,
        token,
        [{ type: "trace/list", domain: kind, item_id: String(configId ?? objectId) }],
        socket,
      );
      runs = r["trace/list"] === undefined ? undefined : runsOf(r["trace/list"]);
    } catch {
      runs = undefined;
    }
  if (withRuns && runs === undefined) notes.push("Its run history could not be read.");
  return {
    ...out,
    ...(words ?? {}),
    ...(runs ? { runs } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}

const list = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
