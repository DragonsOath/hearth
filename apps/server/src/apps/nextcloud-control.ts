import type { NextcloudDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import {
  forgetNextcloudChecks,
  NextcloudError,
  nextcloudDashboard,
  ocs,
  sizeText,
  type NextcloudLogin,
} from "./nextcloud";

/**
 * Changes in Nextcloud, each a plan the owner approves (app-nextcloud-control, params.op): turn an
 * account off or on, set its storage quota, add it to or take it out of a group, turn an app on or
 * off, choose how background jobs run, and require a password on public links (or allow public
 * links at all). Each is read back from Nextcloud and undone by putting the old value back.
 *
 * Hearth never turns off or takes admin from the account it signs in as, never turns off the last
 * administrator, and never turns off the apps it reads through. Making and removing accounts, and
 * anything that needs a password typed, stay in Nextcloud.
 */

export const NEXTCLOUD_OPS = [
  "user-disable",
  "user-enable",
  "user-quota",
  "group-add",
  "group-remove",
  "app-enable",
  "app-disable",
  "jobs-mode",
  "setting",
] as const;
export type NextcloudOp = (typeof NEXTCLOUD_OPS)[number];

/** The sharing settings Hearth changes, with Nextcloud's own key and its default. */
export const NEXTCLOUD_SETTINGS = {
  "links-password": {
    key: "shareapi_enforce_links_password",
    label: "Require a password on public links",
    field: "linksNeedPassword",
  },
  "links-allowed": {
    key: "shareapi_allow_links",
    label: "Allow public links",
    field: "linksAllowed",
  },
} as const;
type SettingId = keyof typeof NEXTCLOUD_SETTINGS;

/** The apps Hearth reads Nextcloud through: turning one off would blind it. */
const NEEDED_APPS = new Set(["serverinfo", "provisioning_api", "settings"]);
const JOB_MODES = ["ajax", "webcron", "cron"] as const;
const MODE_WORDS: Record<(typeof JOB_MODES)[number], string> = {
  ajax: "AJAX (when someone has a page open)",
  webcron: "Webcron (an outside service calls cron.php)",
  cron: "Cron (the system runs cron.php every 5 minutes)",
};

type Service = { id: string; name: string; localUrl: string };

/** A quota as the owner writes it ("5 GB", "500 MB", "none"), in bytes; "none" is no limit. */
export function parseQuota(raw: unknown): number | "none" {
  const s = String(raw ?? "").trim();
  if (/^(none|unlimited|no limit)$/i.test(s)) return "none";
  const m = /^(\d+(?:\.\d+)?)\s*(MB|GB|TB)$/i.exec(s);
  if (!m) throw new Error('Give the quota as a size ("5 GB", "500 MB", "1 TB") or "none".');
  const n = Number(m[1]) * 1024 ** { MB: 2, GB: 3, TB: 4 }[m[2]!.toUpperCase() as "MB"];
  if (n < 1024 ** 2) throw new Error("Give a quota of at least 1 MB.");
  return Math.round(n);
}

const quotaWords = (q: number | "none") => (q === "none" ? "no limit" : sizeText(q));

export class NextcloudOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (login: NextcloudLogin) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) => fn({ username: username ?? "", password: value }),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as NextcloudOp;
    if (!NEXTCLOUD_OPS.includes(op))
      throw new Error(`Say what to do: ${NEXTCLOUD_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Nextcloud", "read", async (login) => {
      const d = await nextcloudDashboard(this.fetchImpl, service.localUrl, login);
      let enabledApps: string[] | undefined;
      if (op === "app-enable" || op === "app-disable")
        enabledApps = await appsOn(this.fetchImpl, service.localUrl, login);
      return planNextcloud(d, service.name, op, params ?? {}, base, enabledApps);
    });
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Nextcloud", "change", (login) =>
        runNextcloud(this.fetchImpl, service.localUrl, login, p),
      );
    } catch (error) {
      if (!(error instanceof NextcloudError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: {
        op: p.op,
        ok: out.ok,
        userId: p.userId ?? null,
        group: p.group ?? null,
        appId: p.appId ?? null,
        setting: p.setting ?? null,
      },
    });
    return out;
  }

  /** Puts the old value back. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const back: Partial<Record<NextcloudOp, NextcloudOp>> = {
      "user-disable": "user-enable",
      "user-enable": "user-disable",
      "group-add": "group-remove",
      "group-remove": "group-add",
      "app-enable": "app-disable",
      "app-disable": "app-enable",
    };
    const op = String(p.op) as NextcloudOp;
    const undo: StepParams | undefined = back[op]
      ? { ...p, op: back[op]! }
      : op === "user-quota" || op === "jobs-mode" || op === "setting"
        ? { ...p, value: p.before ?? "", before: p.value ?? "" }
        : undefined;
    if (!undo) return undefined;
    return this.use(service, "undo a change in Nextcloud", "change", (login) =>
      runNextcloud(this.fetchImpl, service.localUrl, login, undo),
    );
  }
}

/** The ids of the apps turned on. */
export const appsOn = (fetchImpl: Fetch, base: string, login: NextcloudLogin) =>
  ocs<{ apps?: string[] }>(
    fetchImpl,
    base,
    login,
    "GET",
    "/ocs/v2.php/cloud/apps?filter=enabled",
  ).then((d) => d?.apps ?? []);

export function planNextcloud(
  d: NextcloudDashboard,
  name: string,
  op: NextcloudOp,
  p: StepParams,
  base: PlannedStep,
  enabledApps?: string[],
): PlannedStep {
  if (d.maintenance) throw new Error(`${name} is in maintenance mode: it takes no changes now.`);
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams,
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: label, settings: [setting] },
  });

  if (op === "jobs-mode") {
    const mode = String(p.value ?? "") as (typeof JOB_MODES)[number];
    if (!JOB_MODES.includes(mode)) throw new Error(`Choose ${JOB_MODES.join(", ")}.`);
    if (mode === d.jobs.mode) throw new Error(`Background jobs already run by ${mode}.`);
    return step(
      `Run ${name}'s background jobs by ${MODE_WORDS[mode]}${mode === "ajax" ? "" : ": they stop until something calls cron.php"}`,
      { name: "Background jobs", before: d.jobs.mode, after: mode },
      { value: mode, before: d.jobs.mode },
    );
  }

  if (op === "setting") {
    const id = String(p.setting ?? "") as SettingId;
    const s = NEXTCLOUD_SETTINGS[id];
    if (!s) throw new Error(`Choose a setting: ${Object.keys(NEXTCLOUD_SETTINGS).join(", ")}.`);
    const v = String(p.value ?? "");
    if (v !== "on" && v !== "off") throw new Error('Say "on" or "off".');
    const now = d.settings[s.field] ? "on" : "off";
    if (now === v) throw new Error(`"${s.label}" is already ${v}.`);
    return step(
      `${v === "on" ? "Turn on" : "Turn off"} "${s.label}" in ${name}${id === "links-allowed" && v === "off" ? ": every existing public link stops working" : ""}${id === "links-password" && v === "on" ? " (links made before keep working without one)" : ""}`,
      { name: s.label, before: now, after: v },
      { setting: id, value: v, before: now },
    );
  }

  if (op === "app-enable" || op === "app-disable") {
    const id = String(p.appId ?? "").trim();
    if (!/^[a-z0-9_]{1,64}$/.test(id))
      throw new Error("Give the app's id (as Nextcloud lists it).");
    const on = op === "app-enable";
    const isOn = (enabledApps ?? []).includes(id);
    if (!on && NEEDED_APPS.has(id))
      throw new Error(`Hearth reads ${name} through the ${id} app: it stays on.`);
    if (isOn === on) throw new Error(`The app ${id} is already ${on ? "on" : "off"}.`);
    return step(
      `${on ? "Turn on" : "Turn off"} the app ${p.appName ? String(p.appName) : id} in ${name}`,
      { name: String(p.appName ?? id), before: isOn ? "on" : "off", after: on ? "on" : "off" },
      { appId: id, ...(p.appName ? { appName: String(p.appName) } : {}) },
    );
  }

  const userId = String(p.userId ?? "");
  const u = d.users.find((x) => x.id === userId);
  if (!u)
    throw new Error(`${name} has no account ${userId || "(none given)"}: read the panel again.`);
  const me = u.id === d.signedInAs;

  if (op === "user-disable" || op === "user-enable") {
    const on = op === "user-enable";
    if (u.enabled === on) throw new Error(`${u.name} is already ${on ? "on" : "off"}.`);
    if (!on && me)
      throw new Error(
        `Hearth signs in to ${name} as ${u.name}: turning it off would lock Hearth out.`,
      );
    if (!on && u.admin && d.users.filter((x) => x.admin && x.enabled).length <= 1)
      throw new Error(`${u.name} is the last administrator left on: it stays on.`);
    return step(
      on
        ? `Turn the account ${u.name} back on in ${name}`
        : `Turn off the account ${u.name} in ${name} (they cannot sign in or sync; their files stay)`,
      { name: u.name, before: u.enabled ? "on" : "off", after: on ? "on" : "off" },
      { userId: u.id, name: u.name },
    );
  }

  if (op === "user-quota") {
    const q = parseQuota(p.value);
    const before: number | "none" = u.quotaBytes ?? "none";
    if (q === before) throw new Error(`${u.name} already has ${quotaWords(q)}.`);
    return step(
      `Set ${u.name}'s storage in ${name} to ${quotaWords(q)}${q !== "none" && u.usedBytes > q ? ` (they already use ${sizeText(u.usedBytes)}, so they cannot add files)` : ""}`,
      { name: `${u.name}'s quota`, before: quotaWords(before), after: quotaWords(q) },
      { userId: u.id, name: u.name, value: String(q), before: String(before) },
    );
  }

  const group = String(p.group ?? "").trim();
  if (!d.groups.includes(group))
    throw new Error(`${name} has no group "${group}". Make groups in Nextcloud's Accounts page.`);
  const add = op === "group-add";
  if (u.groups.includes(group) === add)
    throw new Error(`${u.name} is ${add ? "already" : "not"} in ${group}.`);
  if (!add && group === "admin") {
    if (me) throw new Error(`Hearth signs in as ${u.name}: it stays an administrator.`);
    if (d.users.filter((x) => x.admin && x.enabled).length <= 1)
      throw new Error(`${u.name} is the last administrator: it stays one.`);
  }
  return step(
    add
      ? `Add ${u.name} to ${group} in ${name}${group === "admin" ? ": they become an administrator" : ""}`
      : `Take ${u.name} out of ${group} in ${name}${group === "admin" ? ": they stop being an administrator" : ""}`,
    { name: `${u.name} in ${group}`, before: add ? "no" : "yes", after: add ? "yes" : "no" },
    { userId: u.id, name: u.name, group },
  );
}

const enc = encodeURIComponent;

export async function runNextcloud(
  fetchImpl: Fetch,
  base: string,
  login: NextcloudLogin,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as NextcloudOp;
  const send = <T = unknown>(method: string, path: string, body?: Record<string, string>) =>
    ocs<T>(fetchImpl, base, login, method, path, body);
  const read = () => nextcloudDashboard(fetchImpl, base, login);
  const done = (ok: boolean, yes: string, no: string): StepOutcome => ({
    ok,
    verified: ok,
    result: ok ? yes : no,
  });

  if (op === "app-enable" || op === "app-disable") {
    const id = String(p.appId);
    const label = String(p.appName ?? id);
    const on = op === "app-enable";
    if ((await appsOn(fetchImpl, base, login)).includes(id) === on)
      return { ok: false, stale: true, result: `${label} was already ${on ? "on" : "off"}.` };
    await send(on ? "POST" : "DELETE", `/ocs/v2.php/cloud/apps/${enc(id)}`);
    const now = (await appsOn(fetchImpl, base, login)).includes(id);
    return done(
      now === on,
      `${label} is ${on ? "on" : "off"}.`,
      `${label} reads ${now ? "on" : "off"} afterwards.`,
    );
  }

  const before = await read();
  if (before.maintenance)
    return { ok: false, stale: true, result: "Nextcloud is in maintenance mode now." };

  if (op === "jobs-mode") {
    const mode = String(p.value);
    if (before.jobs.mode === mode)
      return { ok: false, stale: true, result: `Background jobs already run by ${mode}.` };
    await send(
      "POST",
      "/ocs/v2.php/apps/provisioning_api/api/v1/config/apps/core/backgroundjobs_mode",
      {
        value: mode,
      },
    );
    forgetNextcloudChecks();
    const now = (await read()).jobs.mode;
    return done(
      now === mode,
      `Background jobs now run by ${mode}.`,
      `Background jobs read ${now} afterwards.`,
    );
  }

  if (op === "setting") {
    const s = NEXTCLOUD_SETTINGS[String(p.setting) as SettingId];
    if (!s) return { ok: false, result: "That setting is not one Hearth changes." };
    const want = String(p.value) === "on";
    if (before.settings[s.field] === want)
      return { ok: false, stale: true, result: `"${s.label}" was already ${want ? "on" : "off"}.` };
    await send("POST", `/ocs/v2.php/apps/provisioning_api/api/v1/config/apps/core/${s.key}`, {
      value: want ? "yes" : "no",
    });
    const now = (await read()).settings[s.field];
    return done(
      now === want,
      `"${s.label}" is ${want ? "on" : "off"}.`,
      `"${s.label}" reads ${now ? "on" : "off"} afterwards.`,
    );
  }

  const id = String(p.userId);
  const u = before.users.find((x) => x.id === id);
  const label = String(p.name ?? id);
  if (!u) return { ok: false, stale: true, result: `${label} is no longer in Nextcloud.` };
  const after = async () => (await read()).users.find((x) => x.id === id);

  if (op === "user-disable" || op === "user-enable") {
    const on = op === "user-enable";
    if (u.enabled === on)
      return { ok: false, stale: true, result: `${u.name} was already ${on ? "on" : "off"}.` };
    await send("PUT", `/ocs/v2.php/cloud/users/${enc(id)}/${on ? "enable" : "disable"}`);
    const a = await after();
    return done(
      a?.enabled === on,
      on ? `${u.name} can sign in again.` : `${u.name} is off: they cannot sign in or sync.`,
      `${u.name} reads ${a?.enabled ? "on" : "off"} afterwards.`,
    );
  }

  if (op === "user-quota") {
    const want = String(p.value) === "none" ? "none" : Number(p.value);
    const was = String(p.before ?? "");
    if (was && String(u.quotaBytes ?? "none") !== was)
      return {
        ok: false,
        stale: true,
        result: `${u.name}'s quota changed since the plan (now ${u.quota}); nothing changed.`,
      };
    await send("PUT", `/ocs/v2.php/cloud/users/${enc(id)}`, { key: "quota", value: String(want) });
    const a = await after();
    const now = a?.quotaBytes ?? "none";
    return done(
      now === want,
      `${u.name}'s storage is ${quotaWords(want)}.`,
      `${u.name}'s storage reads ${a?.quota ?? "missing"} afterwards.`,
    );
  }

  const group = String(p.group);
  const add = op === "group-add";
  if (u.groups.includes(group) === add)
    return {
      ok: false,
      stale: true,
      result: `${u.name} was ${add ? "already" : "not"} in ${group}.`,
    };
  if (add) await send("POST", `/ocs/v2.php/cloud/users/${enc(id)}/groups`, { groupid: group });
  else await send("DELETE", `/ocs/v2.php/cloud/users/${enc(id)}/groups?groupid=${enc(group)}`);
  const a = await after();
  const inIt = Boolean(a?.groups.includes(group));
  return done(
    inIt === add,
    add ? `${u.name} is in ${group}.` : `${u.name} is out of ${group}.`,
    `${u.name} ${inIt ? "is" : "is not"} in ${group} afterwards.`,
  );
}
