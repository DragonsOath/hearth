/**
 * Home Assistant routines in plain words: what an automation waits for (its triggers), what it
 * checks first (its conditions), and what it and a script do (their steps), from the
 * configuration Home Assistant's own editor reads. Also which steps reach beyond lights and the
 * TV (doors, alarms, garage doors, heating, web requests), so those never run on one press.
 *
 * Pure functions over configuration Home Assistant already returned: nothing here reads or
 * changes anything.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Steps that only change lights, plugs, fans, the TV, helpers, or notifications. */
const EVERYDAY = new Set([
  "light",
  "switch",
  "fan",
  "media_player",
  "input_boolean",
  "input_number",
  "input_select",
  "input_text",
  "input_datetime",
  "input_button",
  "counter",
  "timer",
  "scene",
  "notify",
  "persistent_notification",
  "tts",
  "remote",
]);

/** What a step in another domain can do, in words for the confirmation. */
const CAREFUL: Record<string, string> = {
  lock: "locks or unlocks doors",
  alarm_control_panel: "arms or disarms the alarm",
  cover: "opens or closes doors, blinds, or the garage",
  garage_door: "opens or closes the garage",
  valve: "opens or closes a valve",
  climate: "changes heating or cooling",
  water_heater: "changes the water heater",
  siren: "sounds a siren",
  vacuum: "starts or stops the vacuum",
  camera: "uses a camera",
  button: "presses a device button",
  rest_command: "sends a web request",
  shell_command: "runs a command on the server",
  homeassistant: "acts on Home Assistant itself",
  hassio: "acts on Home Assistant's add-ons or backups",
  script: "runs another routine",
  automation: "switches or runs an automation",
};

const words = (id: string) =>
  (id.split(".")[1] ?? id).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Every action a configuration calls, nested ones included ("light.turn_on"). */
export function actionsIn(config: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isObj(v)) return;
    const a = v.action ?? v.service;
    if (typeof a === "string" && /^[a-z_]+\.[a-z_]+$/.test(a)) out.push(a);
    for (const [k, x] of Object.entries(v)) {
      // Triggers and conditions are not steps it takes.
      if (["trigger", "triggers", "condition", "conditions", "data", "target"].includes(k))
        continue;
      walk(x);
    }
  };
  walk(isObj(config) ? (config.sequence ?? config.actions ?? config.action) : config);
  return out;
}

/** What needs a careful look before it runs: plain words per reason, none for everyday ones. */
export function carefulOf(config: unknown): string[] {
  const why = new Set<string>();
  for (const a of actionsIn(config)) {
    const domain = a.split(".")[0]!;
    if (EVERYDAY.has(domain)) continue;
    why.add(CAREFUL[domain] ?? `uses ${domain.replace(/_/g, " ")}`);
  }
  return [...why];
}

const COLORS: [string, [number, number, number]][] = [
  ["red", [255, 0, 0]],
  ["orange", [255, 165, 0]],
  ["amber", [255, 196, 120]],
  ["yellow", [255, 255, 0]],
  ["green", [0, 255, 0]],
  ["blue", [0, 0, 255]],
  ["purple", [128, 0, 255]],
  ["pink", [255, 105, 180]],
  ["white", [255, 255, 255]],
];
function colorName(rgb: unknown): string | undefined {
  if (!Array.isArray(rgb) || rgb.length !== 3) return undefined;
  const [r, g, b] = rgb.map(Number) as [number, number, number];
  let best = COLORS[0]!;
  let d = Infinity;
  for (const c of COLORS) {
    const e = (c[1][0] - r) ** 2 + (c[1][1] - g) ** 2 + (c[1][2] - b) ** 2;
    if (e < d) [best, d] = [c, e];
  }
  return best[0];
}

function kelvinName(k: number) {
  return k < 3000 ? "warm white" : k < 4500 ? "soft white" : "daylight";
}

/** The things a step acts on, by their names where Home Assistant knows them. */
function targets(step: Obj, name: (id: string) => string): string {
  const t = isObj(step.target) ? step.target : {};
  const data = isObj(step.data) ? step.data : {};
  const ids = [...list(t.entity_id), ...list(step.entity_id), ...list(data.entity_id)].map(String);
  if (ids.includes("all")) return "everything";
  const areas = list(t.area_id).map((a) => `the ${String(a).replace(/_/g, " ")} area`);
  const devices = list(t.device_id).length ? ["a device"] : [];
  const all = [...ids.map(name), ...areas, ...devices];
  return all.length ? all.join(", ") : "";
}

function stepWords(step: unknown, name: (id: string) => string): string {
  if (!isObj(step)) return "A step Hearth cannot read";
  if (typeof step.alias === "string" && step.alias.trim()) return step.alias.trim();
  const a = step.action ?? step.service;
  if (typeof a === "string") {
    const [domain, verb = ""] = a.split(".");
    const what = targets(step, name);
    const data = isObj(step.data) ? step.data : {};
    if (domain === "light" && verb === "turn_on") {
      const bits = [
        typeof data.brightness_pct === "number" ? `${data.brightness_pct}%` : "",
        colorName(data.rgb_color) ?? "",
        typeof data.color_temp_kelvin === "number" ? kelvinName(data.color_temp_kelvin) : "",
      ].filter(Boolean);
      return `Turn on ${what || "lights"}${bits.length ? ` (${bits.join(", ")})` : ""}`;
    }
    if (verb === "turn_on") return `Turn on ${what || words(a)}`;
    if (verb === "turn_off") return `Turn off ${what || words(a)}`;
    if (verb === "toggle") return `Switch ${what || words(a)} on or off`;
    if (domain === "media_player" && verb === "select_source")
      return `${what || "TV"}: open ${String(data.source ?? "a source")
        .replace(/^com\.edde746\.plezy$/, "Plezy")
        .replace(/^com\.spectrum\.stva\.androidtv$/, "Spectrum")}`;
    if (domain === "media_player") return `${what || "TV"}: ${verb.replace(/_/g, " ")}`;
    if (domain === "scene") return `Activate the scene ${what}`;
    if (domain === "script") return `Run the routine ${what || words(a)}`;
    if (domain === "notify" || domain === "persistent_notification") return "Send a notification";
    if (domain === "tts") return "Speak a message";
    if (domain === "lock") return `${verb === "unlock" ? "Unlock" : "Lock"} ${what}`;
    if (domain === "cover") return `${verb.replace(/_cover$/, "").replace(/_/g, " ")} ${what}`;
    if (domain === "rest_command") return `Send the web request "${verb.replace(/_/g, " ")}"`;
    return `${words(a)}${what ? `: ${what}` : ""} (${a})`;
  }
  if ("delay" in step) {
    const d = step.delay;
    if (typeof d === "string") return `Wait ${d}`;
    if (isObj(d))
      return `Wait ${Object.entries(d)
        .filter(([, v]) => Number(v))
        .map(([k, v]) => `${v} ${k}`)
        .join(" ")}`;
    return "Wait";
  }
  if ("wait_template" in step || "wait_for_trigger" in step) return "Wait until something happens";
  if ("choose" in step) return "Pick one of several options";
  if ("if" in step) return "Do something only if a check passes";
  if ("repeat" in step) return "Repeat some steps";
  if ("parallel" in step) return "Do several things at once";
  if ("scene" in step) return `Activate the scene ${name(String(step.scene))}`;
  if ("stop" in step) return `Stop${typeof step.stop === "string" ? `: ${step.stop}` : ""}`;
  if ("variables" in step) return "";
  if ("condition" in step) return `Continue only if ${conditionWords(step, name)}`;
  if ("event" in step) return `Fire the event ${String(step.event)}`;
  return "A step Hearth cannot describe";
}

function triggerWords(t: unknown, name: (id: string) => string): string {
  if (!isObj(t)) return "Something Hearth cannot read";
  if (typeof t.alias === "string" && t.alias.trim()) return t.alias.trim();
  const kind = String(t.trigger ?? t.platform ?? "");
  const ids = list(t.entity_id)
    .map((x) => name(String(x)))
    .join(", ");
  switch (kind) {
    case "time":
      return `At ${list(t.at).map(String).join(", ")}`;
    case "time_pattern":
      return `Every ${t.minutes ? `${String(t.minutes).replace("/", "")} minutes` : t.hours ? `${String(t.hours).replace("/", "")} hours` : "few moments"}`;
    case "sun":
      return `At ${String(t.event ?? "sunset")}${t.offset ? ` (${String(t.offset)})` : ""}`;
    case "state":
      return `When ${ids}${t.to !== undefined ? ` becomes ${String(t.to)}` : " changes"}${t.for ? " for a while" : ""}`;
    case "numeric_state":
      return `When ${ids} goes${t.above !== undefined ? ` above ${String(t.above)}` : ""}${t.below !== undefined ? ` below ${String(t.below)}` : ""}`;
    case "homeassistant":
      return `When Home Assistant ${t.event === "shutdown" ? "shuts down" : "starts"}`;
    case "zone":
      return `When ${ids} ${t.event === "leave" ? "leaves" : "enters"} ${name(String(t.zone ?? "a zone"))}`;
    case "device":
      return `When a device ${String(t.type ?? "does something").replace(/_/g, " ")}`;
    case "webhook":
      return "When a web request (webhook) arrives";
    case "event":
      return `When the event ${String(t.event_type ?? "")} happens`;
    case "calendar":
      return `When a calendar event ${t.event === "end" ? "ends" : "starts"}`;
    case "conversation":
      return `When you say "${list(t.command).map(String).join('" or "')}"`;
    case "template":
      return "When a custom check becomes true";
    case "tag":
      return "When a tag is scanned";
    case "mqtt":
      return "When an MQTT message arrives";
    default:
      return kind ? `When ${kind.replace(/_/g, " ")} happens` : "Something Hearth cannot read";
  }
}

function conditionWords(c: unknown, name: (id: string) => string): string {
  if (typeof c === "string") return "a custom check passes";
  if (!isObj(c)) return "a check passes";
  if (typeof c.alias === "string" && c.alias.trim()) return c.alias.trim();
  const kind = String(c.condition ?? "");
  const ids = list(c.entity_id)
    .map((x) => name(String(x)))
    .join(", ");
  switch (kind) {
    case "state":
      return `${ids} is ${list(c.state).map(String).join(" or ")}`;
    case "numeric_state":
      return `${ids} is${c.above !== undefined ? ` above ${String(c.above)}` : ""}${c.below !== undefined ? ` below ${String(c.below)}` : ""}`;
    case "time": {
      const days = list(c.weekday).map(String).join(", ");
      return [
        c.after ? `after ${String(c.after)}` : "",
        c.before ? `before ${String(c.before)}` : "",
        days ? `on ${days}` : "",
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/^/, "it is ");
    }
    case "sun":
      return `it is ${c.after ? `after ${String(c.after)}` : ""}${c.before ? ` before ${String(c.before)}` : ""}`.trim();
    case "zone":
      return `${ids} is in ${name(String(c.zone ?? "a zone"))}`;
    case "and":
      return list(c.conditions)
        .map((x) => conditionWords(x, name))
        .join(" and ");
    case "or":
      return list(c.conditions)
        .map((x) => conditionWords(x, name))
        .join(" or ");
    case "not":
      return `not (${list(c.conditions)
        .map((x) => conditionWords(x, name))
        .join(", ")})`;
    case "template":
      return "a custom check passes";
    default:
      return kind ? `${kind.replace(/_/g, " ")} check passes` : "a check passes";
  }
}

export interface RoutineWords {
  triggers: string[];
  conditions: string[];
  steps: string[];
  /** Plain reasons to look before it runs; empty when it only touches everyday things. */
  careful: string[];
  /** Inputs it asks for (a question for a voice assistant script); such a routine is for voice assistants. */
  needsInput: string[];
  description?: string;
}

/** An automation's or script's configuration, as Home Assistant's editor returns it, in words. */
export function routineWords(config: unknown, name: (id: string) => string): RoutineWords {
  const c = isObj(config) ? config : {};
  const fields = isObj(c.fields) ? c.fields : {};
  return {
    triggers: list(c.triggers ?? c.trigger).map((t) => triggerWords(t, name)),
    conditions: list(c.conditions ?? c.condition).map((x) => `Only if ${conditionWords(x, name)}`),
    steps: list(c.sequence ?? c.actions ?? c.action)
      .map((s) => stepWords(s, name))
      .filter(Boolean),
    careful: carefulOf(c),
    needsInput: Object.entries(fields)
      .filter(([, f]) => isObj(f) && f.required === true)
      .map(([k]) => k),
    ...(typeof c.description === "string" && c.description.trim()
      ? { description: c.description.trim().slice(0, 400) }
      : {}),
  };
}

/** One run from Home Assistant's run history (its traces), in words. */
export interface RoutineRun {
  at: string;
  result: string;
  ok: boolean;
  error?: string;
}

const RESULT: Record<string, string> = {
  finished: "Finished",
  failed_conditions: "Did not run its steps: a check did not pass",
  failed_single: "Skipped: it was already running",
  failed_max_runs: "Skipped: too many runs at once",
  cancelled: "Cancelled",
  aborted: "Stopped partway",
  error: "Failed",
  running: "Running now",
};

export function runsOf(traces: unknown): RoutineRun[] {
  return list(traces)
    .filter(isObj)
    .map((t) => {
      const ts = isObj(t.timestamp) ? t.timestamp : {};
      const exec = String(t.script_execution ?? (t.state === "running" ? "running" : "finished"));
      const err = typeof t.error === "string" && t.error ? t.error.slice(0, 300) : undefined;
      return {
        at: String(ts.start ?? ""),
        result: RESULT[exec] ?? exec.replace(/_/g, " "),
        ok: !err && !["error", "aborted"].includes(exec),
        ...(err ? { error: err } : {}),
      };
    })
    .filter((r) => r.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);
}
