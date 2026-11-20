import type { HomeAssistantDashboard, StepParams } from "@dragon-control/core";
import { redactLine } from "../actions/redact";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import {
  AdminOnly,
  haGet,
  routineDetail,
  type HaEntry,
  type HaState,
  type SocketFactory,
} from "./homeassistant";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";

/**
 * Home Assistant's panel and its everyday controls. The panel reads through homeassistant.ts
 * (its fixed list of reads). Changes go through haCall below, which can only call the services
 * in HA_SERVICES and reload an integration: running or switching an automation, running a script
 * or scene, and toggling a light, switch, fan, or helper. Locks, alarms, covers (garage doors),
 * and anything else are left out on purpose, so a mistaken plan cannot open the house.
 */

/** Every service Hearth may call, by domain. */
export const HA_SERVICES = {
  automation: ["turn_on", "turn_off", "trigger"],
  script: ["turn_on"],
  scene: ["turn_on"],
  light: ["toggle"],
  switch: ["toggle"],
  fan: ["toggle"],
  input_boolean: ["toggle"],
} as const;
type Domain = keyof typeof HA_SERVICES;
const TOGGLES: Domain[] = ["light", "switch", "fan", "input_boolean"];

async function haCall(
  fetchImpl: Fetch,
  base: string,
  token: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number }> {
  const svc = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(path);
  const allowed = svc
    ? ((HA_SERVICES as Record<string, readonly string[]>)[svc[1]!] ?? []).includes(svc[2]!)
    : /^\/api\/config\/config_entries\/entry\/[A-Za-z0-9]+\/reload$/.test(path);
  if (!allowed) throw new Error(`Not a change Hearth makes in Home Assistant: ${path}`);
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(TIMEOUT_MS * 4),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.replaceAll(token, "[hidden]") : "no answer";
    throw new AppUnreachableError(`Home Assistant did not answer at ${base}: ${why}`);
  }
  if (res.status === 401) throw new AppKeyError("Home Assistant refused the access token.");
  return { ok: res.ok, status: res.status };
}

const nameOf = (s: HaState) =>
  typeof s.attributes?.friendly_name === "string" ? s.attributes.friendly_name : s.entity_id;
const domainOf = (id: string) => id.split(".")[0]!;
const WORDS: Record<string, string> = {
  setup_error: "failed to set up",
  setup_retry: "keeps retrying setup",
  failed_unload: "failed to unload",
  migration_error: "failed to migrate",
};

export async function homeAssistantDashboard(
  fetchImpl: Fetch,
  base: string,
  token: string,
): Promise<HomeAssistantDashboard> {
  const [config, states, entries] = await Promise.all([
    haGet<{ version?: string; state?: string; location_name?: string }>(
      fetchImpl,
      base,
      "/api/config",
      token,
    ),
    haGet<HaState[]>(fetchImpl, base, "/api/states", token),
    haGet<HaEntry[]>(fetchImpl, base, "/api/config/config_entries/entry", token).catch(
      (e: unknown) => {
        if (e instanceof AdminOnly) return undefined;
        throw e;
      },
    ),
  ]);
  const of = (d: string) => states.filter((s) => domainOf(s.entity_id) === d);
  const at = (s: HaState) =>
    typeof s.attributes?.last_triggered === "string" ? s.attributes.last_triggered : undefined;
  const broken = (s: HaState) => s.state === "unavailable" || s.state === "unknown";
  const unavailable = states.filter(
    (s) =>
      s.state === "unavailable" &&
      !["automation", "script", "scene"].includes(domainOf(s.entity_id)),
  );
  return {
    app: "homeassistant",
    ...(config.version ? { version: config.version } : {}),
    running: !config.state || config.state === "RUNNING",
    totals: {
      entities: states.length,
      unavailable: unavailable.length,
      automations: of("automation").length,
      automationsOn: of("automation").filter((a) => a.state === "on").length,
      integrationsFailing: entries
        ? entries.filter((e) => !e.disabled_by && WORDS[e.state ?? ""]).length
        : undefined,
    },
    automations: of("automation")
      .map((a) => ({
        entityId: a.entity_id,
        name: nameOf(a),
        on: a.state === "on",
        ...(at(a) ? { lastRan: at(a)! } : {}),
        ...(a.state === "unavailable" ? { unavailable: true } : {}),
      }))
      .sort(
        (x, y) => (y.lastRan ?? "").localeCompare(x.lastRan ?? "") || x.name.localeCompare(y.name),
      ),
    scripts: of("script").map((s) => ({
      entityId: s.entity_id,
      name: nameOf(s),
      running: s.state === "on",
      ...(at(s) ? { lastRan: at(s)! } : {}),
      ...(s.state === "unavailable" ? { unavailable: true } : {}),
    })),
    // A scene's state is when it was last turned on.
    scenes: of("scene").map((s) => ({
      entityId: s.entity_id,
      name: nameOf(s),
      ...(broken(s) ? {} : { lastRan: s.state }),
      ...(s.state === "unavailable" ? { unavailable: true } : {}),
    })),
    switches: states
      .filter(
        (s) => (TOGGLES as string[]).includes(domainOf(s.entity_id)) && s.state !== "unavailable",
      )
      .map((s) => ({
        entityId: s.entity_id,
        name: nameOf(s),
        kind: domainOf(s.entity_id),
        on: s.state === "on",
      }))
      .sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name)),
    unavailable: unavailable.slice(0, 40).map((s) => ({
      entityId: s.entity_id,
      name: nameOf(s),
      ...(s.last_changed ? { since: s.last_changed } : {}),
    })),
    integrations: (entries ?? [])
      .filter((e) => !e.disabled_by && WORDS[e.state ?? ""] && e.entry_id)
      .map((e) => ({
        entryId: e.entry_id!,
        name: e.title || e.domain,
        domain: e.domain,
        problem: `${WORDS[e.state!]}${e.reason ? `: ${redactLine(e.reason).slice(0, 200)}` : ""}`,
      })),
    ...(entries
      ? {}
      : { note: "The token's user is not an administrator, so integrations cannot be listed." }),
  };
}

export const HA_OPS = [
  "automation-on",
  "automation-off",
  "run-automation",
  "run-script",
  "run-scene",
  "toggle",
  "reload-integration",
] as const;
type Op = (typeof HA_OPS)[number];
const NEEDS: Record<Op, Domain[] | "entry"> = {
  "automation-on": ["automation"],
  "automation-off": ["automation"],
  "run-automation": ["automation"],
  "run-script": ["script"],
  "run-scene": ["scene"],
  toggle: TOGGLES,
  "reload-integration": "entry",
};

export class HomeAssistantOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    /** Home Assistant's live connection, for a routine's run history (tests pass a stand-in). */
    private readonly socket?: SocketFactory,
  ) {}

  private use<T>(
    service: { id: string; localUrl: string },
    purpose: string,
    access: "read" | "change",
    fn: (token: string) => Promise<T>,
  ) {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    service: { id: string; name: string; localUrl: string },
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as Op;
    if (!HA_OPS.includes(op)) throw new Error(`Say what to do: ${HA_OPS.join(", ")}.`);
    const d = await this.use(service, "read Home Assistant", "read", (t) =>
      homeAssistantDashboard(this.fetchImpl, service.localUrl, t),
    );
    let label: string;
    let target: { id: string; name: string; before: string };
    // Why to look before it runs (doors, alarms, web requests...); empty for lights and the TV.
    let careful: string[] = [];
    if (op === "reload-integration") {
      const e = d.integrations.find((i) => i.entryId === params?.entryId);
      if (!e) throw new Error("That integration is not failing any more.");
      label = `Reload ${e.name} (${e.domain}) in ${service.name}; it ${e.problem}`;
      target = { id: e.entryId, name: e.name, before: e.problem };
    } else {
      const id = String(params?.entityId ?? "");
      const allowed = NEEDS[op] as Domain[];
      if (!allowed.includes(domainOf(id) as Domain))
        throw new Error(`${id || "That"} cannot be used for ${op}.`);
      const all = [
        ...d.automations.map((a) => ({ id: a.entityId, name: a.name, state: a.on ? "on" : "off" })),
        ...d.scripts.map((s) => ({
          id: s.entityId,
          name: s.name,
          state: s.running ? "running" : "idle",
        })),
        ...d.scenes.map((s) => ({ id: s.entityId, name: s.name, state: "scene" })),
        ...d.switches.map((s) => ({ id: s.entityId, name: s.name, state: s.on ? "on" : "off" })),
      ];
      const e = all.find((x) => x.id === id);
      if (!e) throw new Error("Home Assistant does not have that, or it is unavailable.");
      const gone = [...d.automations, ...d.scripts, ...d.scenes].find(
        (x) => x.entityId === id && x.unavailable,
      );
      if (gone)
        throw new Error(
          `Home Assistant says ${e.name} is unavailable, so it cannot run. Open it in Home Assistant to see why.`,
        );
      if (op !== "toggle") {
        const r = await this.use(service, "read a routine in Home Assistant", "read", (t) =>
          routineDetail(service.localUrl, t, this.fetchImpl, id, this.socket, false),
        );
        if (op === "run-script" && r.needsInput?.length)
          throw new Error(
            `${e.name} needs ${r.needsInput.join(", ")} each time it runs (a voice assistant fills it in), so it cannot run from a button.`,
          );
        careful = r.careful ?? (r.steps ? [] : ["its steps could not be read"]);
      }
      if (op === "automation-on" && e.state === "on") throw new Error(`${e.name} is already on.`);
      if (op === "automation-off" && e.state === "off")
        throw new Error(`${e.name} is already off.`);
      label = {
        "automation-on": `Turn on the automation ${e.name} in ${service.name}: it runs again by itself when its triggers happen`,
        "automation-off": `Turn off the automation ${e.name} in ${service.name}: it stops running by itself until turned back on`,
        "run-automation": `Run the automation ${e.name} now in ${service.name}: its steps run straight away, without waiting for its triggers and skipping its checks (conditions)`,
        "run-script": `Run the routine ${e.name} in ${service.name} (a Home Assistant script)`,
        "run-scene": `Activate the scene ${e.name} in ${service.name}: its devices go back to how the scene saved them`,
        toggle: `Turn ${e.state === "on" ? "off" : "on"} ${e.name} in ${service.name}`,
        "reload-integration": "",
      }[op];
      target = { id, name: e.name, before: e.state };
      if (careful.length) label = `${label}. Look first: it ${careful.join(", ")}`;
    }
    return {
      ...base,
      label,
      serviceName: service.name,
      params: {
        op,
        name: target.name,
        before: target.before,
        ...(op === "reload-integration" ? { entryId: target.id } : { entityId: target.id }),
        // The panel runs everyday routines on one press; these always wait for a confirmation.
        ...(careful.length ? { careful: careful.join("; ") } : {}),
      },
      change: {
        summary: label,
        settings: [{ name: target.name, before: target.before, after: op }],
      },
    };
  }

  async run(
    step: StepRun,
    service: { id: string; name: string; localUrl: string },
  ): Promise<StepOutcome> {
    const p = step.params ?? {};
    const op = String(p.op) as Op;
    const name = String(p.name || "it");
    const id = String(p.entityId ?? "");
    const outcome = await this.use(
      service,
      `${op} in Home Assistant`,
      "change",
      async (token): Promise<StepOutcome> => {
        const base = service.localUrl;
        const read = () => homeAssistantDashboard(this.fetchImpl, base, token);
        if (op === "reload-integration") {
          const r = await haCall(
            this.fetchImpl,
            base,
            token,
            `/api/config/config_entries/entry/${String(p.entryId)}/reload`,
          );
          if (!r.ok)
            return { ok: false, result: `Home Assistant did not reload ${name} (${r.status}).` };
          await this.wait(3000);
          const d = await read();
          return d.integrations.some((i) => i.entryId === p.entryId)
            ? {
                ok: false,
                result: `Home Assistant reloaded ${name}, but it still ${d.integrations.find((i) => i.entryId === p.entryId)!.problem}.`,
              }
            : { ok: true, result: `${name} is loaded again. Home Assistant confirms it.` };
        }
        const [domain, service_] = {
          "automation-on": ["automation", "turn_on"],
          "automation-off": ["automation", "turn_off"],
          "run-automation": ["automation", "trigger"],
          "run-script": ["script", "turn_on"],
          "run-scene": ["scene", "turn_on"],
          toggle: [domainOf(id), "toggle"],
        }[op as Exclude<Op, "reload-integration">];
        const r = await haCall(this.fetchImpl, base, token, `/api/services/${domain}/${service_}`, {
          entity_id: id,
        });
        if (!r.ok) return { ok: false, result: `Home Assistant refused it (${r.status}).` };
        if (op === "run-script" || op === "run-scene" || op === "run-automation") {
          // Read back that Home Assistant recorded the run (its "last ran" moves on).
          const last = (d: Awaited<ReturnType<typeof read>>) =>
            [...d.automations, ...d.scripts, ...d.scenes].find((x) => x.entityId === id)?.lastRan;
          const startedAt = Date.now() - 2000;
          for (let i = 0; i < 5; i++) {
            const at = last(await read());
            if (at && Date.parse(at) >= startedAt)
              return {
                ok: true,
                result: `Home Assistant ran ${name} at ${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}. It confirms it.`,
              };
            await this.wait(1000);
          }
          return {
            ok: true,
            result: `Home Assistant accepted ${name}, but has not recorded the run yet. Check its devices.`,
          };
        }
        // Switching reads the state back; a slow device gets a few seconds.
        for (let i = 0; i < 5; i++) {
          const d = await read();
          const now =
            op === "toggle"
              ? d.switches.find((s) => s.entityId === id)?.on
              : d.automations.find((a) => a.entityId === id)?.on;
          const want = op === "toggle" ? p.before !== "on" : op === "automation-on";
          if (now === want)
            return {
              ok: true,
              result: `${name} is ${want ? "on" : "off"}. Home Assistant confirms it.`,
            };
          await this.wait(1000);
        }
        return {
          ok: false,
          result: `Home Assistant took it, but ${name} does not show the change yet.`,
        };
      },
    );
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${op} (${name}) in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op, ok: outcome.ok },
    });
    return outcome;
  }
}
