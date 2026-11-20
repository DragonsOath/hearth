import { isIP } from "node:net";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import {
  AdguardClient,
  AdguardError,
  maskAddress,
  ruleFor,
  type RawFilter,
  type RawFiltering,
  type RawStatus,
} from "./adguard";
import type { Fetch } from "./http";

/**
 * Changes to AdGuard Home, each a plan the owner approves (app-adguard-control, params.op).
 * AdGuard Home is the network's DNS, so every plan here is marked protected: approving it asks
 * the owner to confirm it is them. Each change is read back from AdGuard before it counts as done.
 *
 * What it can do: pause protection (for a time, or until turned back on) and turn it back on,
 * update the filter lists, allow or block a domain (a custom rule) and take a custom rule off,
 * add, switch on or off, or remove a filter list, add or remove a DNS rewrite, choose blocked
 * services, and switch safe browsing, parental control and safe search. Never its password, DNS
 * servers, encryption, DHCP or clients: those stay in AdGuard Home.
 */

export const ADGUARD_OPS = [
  "pause",
  "resume",
  "refresh",
  "allow",
  "block",
  "rule-remove",
  "filter-add",
  "filter-enable",
  "filter-disable",
  "filter-remove",
  "rewrite-add",
  "rewrite-remove",
  "services",
  "safety",
] as const;
export type AdguardOp = (typeof ADGUARD_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

class Refused extends Error {}

const DOMAIN = /^(?=.{3,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;
/** A rewrite's name: a domain, or a wildcard for every subdomain ("*.home"). */
const REWRITE_NAME = /^(\*\.)?[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9_])?$/;

export const PAUSE_FOR = [0, 30, 300, 1800, 3600, 7200, 86400];
export const forHow = (sec: number) =>
  sec === 0
    ? "until you turn it back on"
    : sec < 60
      ? `for ${sec} seconds`
      : sec < 3600
        ? `for ${sec / 60} minutes`
        : sec === 3600
          ? "for 1 hour"
          : `for ${sec / 3600} hours`;

const SAFETY = {
  safebrowsing: "Safe browsing (blocks known dangerous sites)",
  parental: "Parental control (blocks adult sites)",
  safesearch: "Safe search (search engines and YouTube in safe mode)",
} as const;
type Safety = keyof typeof SAFETY;

/** Downloading every list can take a while. */
const REFRESH_MS = 5 * 60_000;

export class AdguardOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (c: AdguardClient) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) =>
        fn(
          new AdguardClient(
            service.localUrl,
            { username: username ?? "", password: value },
            this.fetchImpl,
          ),
        ),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as AdguardOp;
    if (!ADGUARD_OPS.includes(op)) throw new Error(`Say what to do: ${ADGUARD_OPS.join(", ")}.`);
    return this.use(service, "plan a change in AdGuard Home", "read", (c) =>
      planAdguard(c, service.name, op, params ?? {}, base),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change AdGuard Home", "change", (c) =>
        runAdguard(c, service.name, p),
      );
    } catch (error) {
      if (!(error instanceof AdguardError) && !(error instanceof Refused)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, domain: p.domain ?? null },
    });
    return out;
  }

  /** Puts a change back when a later step of the same plan failed, or from the panel's Undo. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op) as AdguardOp;
    const reverse: Partial<Record<AdguardOp, (c: AdguardClient) => Promise<string>>> = {
      pause: async (c) => {
        await c.call("POST", "/protection", { enabled: true });
        return "Protection is back on.";
      },
      resume: async (c) => {
        await c.call("POST", "/protection", { enabled: false });
        return "Protection is paused again.";
      },
      allow: (c) => setRules(c, (r) => r.filter((x) => x !== p.rule)).then(() => "Undone."),
      block: (c) => setRules(c, (r) => r.filter((x) => x !== p.rule)).then(() => "Undone."),
      "rule-remove": (c) =>
        setRules(c, (r) => [...r, String(p.rule)]).then(() => "The rule is back."),
      "filter-enable": (c) =>
        setFilter(c, Number(p.filterId), p.allowlist === true, false).then(
          () => "The list is off again.",
        ),
      "filter-disable": (c) =>
        setFilter(c, Number(p.filterId), p.allowlist === true, true).then(
          () => "The list is on again.",
        ),
      "filter-add": async (c) => {
        await c.call("POST", "/filtering/remove_url", {
          url: String(p.body),
          whitelist: p.allowlist === true,
        });
        return "The new list is removed again.";
      },
      "filter-remove": async (c) => {
        const was = JSON.parse(String(p.body)) as { url: string; name: string };
        await c.call("POST", "/filtering/add_url", {
          name: was.name,
          url: was.url,
          whitelist: p.allowlist === true,
        });
        return "The list is back.";
      },
      "rewrite-add": async (c) => {
        await c.call("POST", "/rewrite/delete", { domain: p.domain, answer: p.answer });
        return "The rewrite is removed again.";
      },
      "rewrite-remove": async (c) => {
        await c.call("POST", "/rewrite/add", { domain: p.domain, answer: p.answer });
        return "The rewrite is back.";
      },
      services: async (c) => {
        const was = JSON.parse(String(p.body)) as { before: string[] };
        await setServices(c, was.before);
        return "Blocked services are back as they were.";
      },
      safety: async (c) => {
        await setSafety(c, String(p.setting) as Safety, p.on !== true);
        return "The switch is back as it was.";
      },
    };
    const fn = reverse[op];
    if (!fn) return undefined;
    return this.use(service, "undo a change in AdGuard Home", "change", async (c) => ({
      ok: true,
      result: await fn(c),
    }));
  }
}

const filtering = (c: AdguardClient) => c.call<RawFiltering>("GET", "/filtering/status");
const rulesNow = async (c: AdguardClient) => (await filtering(c)).user_rules ?? [];

async function setRules(c: AdguardClient, change: (rules: string[]) => string[]) {
  await c.call("POST", "/filtering/set_rules", { rules: change(await rulesNow(c)) });
}

const filterOf = (f: RawFiltering, id: number, allowlist: boolean): RawFilter | undefined =>
  ((allowlist ? f.whitelist_filters : f.filters) ?? []).find((x) => x.id === id);

async function setFilter(c: AdguardClient, id: number, allowlist: boolean, enabled: boolean) {
  const f = filterOf(await filtering(c), id, allowlist);
  if (!f) throw new Refused("That list is no longer in AdGuard Home.");
  await c.call("POST", "/filtering/set_url", {
    url: f.url,
    whitelist: allowlist,
    data: { name: f.name, url: f.url, enabled },
  });
}

const rewrites = (c: AdguardClient) =>
  c.call<{ domain: string; answer: string }[]>("GET", "/rewrite/list");
const hasRewrite = (list: { domain: string; answer: string }[], domain: string, answer: string) =>
  list.some((r) => r.domain === domain && r.answer === answer);

async function servicesNow(c: AdguardClient) {
  const r = await c.call<{ ids: string[] | null; schedule?: unknown }>(
    "GET",
    "/blocked_services/get",
  );
  return { ids: r.ids ?? [], schedule: r.schedule ?? { time_zone: "UTC" } };
}
async function setServices(c: AdguardClient, ids: string[]) {
  const now = await servicesNow(c);
  await c.call("PUT", "/blocked_services/update", { ids, schedule: now.schedule });
}

const SAFETY_STATUS: Record<Safety, string> = {
  safebrowsing: "/safebrowsing/status",
  parental: "/parental/status",
  safesearch: "/safesearch/status",
};
async function safetyOn(c: AdguardClient, s: Safety) {
  return (await c.call<{ enabled: boolean }>("GET", SAFETY_STATUS[s])).enabled;
}
async function setSafety(c: AdguardClient, s: Safety, on: boolean) {
  if (s === "safesearch") {
    // Safe search keeps its per-engine choices: only the main switch changes.
    const now = await c.call<Record<string, boolean>>("GET", "/safesearch/status");
    await c.call("PUT", "/safesearch/settings", { ...now, enabled: on });
    return;
  }
  await c.call("POST", `/${s}/${on ? "enable" : "disable"}`);
}

const domainOf = (p: StepParams) =>
  String(p.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");

export async function planAdguard(
  c: AdguardClient,
  name: string,
  op: AdguardOp,
  p: StepParams,
  base: PlannedStep,
): Promise<PlannedStep> {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams = {},
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    // AdGuard Home is the network's DNS: approving any change asks the owner to confirm it is them.
    params: { op, ...extra, protected: "yes" },
    change: { summary: label, settings: [setting] },
  });

  if (op === "pause" || op === "resume") {
    const s = await c.call<RawStatus>("GET", "/status");
    if (op === "pause") {
      if (!s.protection_enabled) throw new Error(`Protection in ${name} is already paused.`);
      const seconds = Number(p.seconds ?? 300);
      if (!PAUSE_FOR.includes(seconds))
        throw new Error(
          "Pause for 30 seconds, 5 or 30 minutes, 1, 2 or 24 hours, or until turned back on (0).",
        );
      return step(
        `Pause protection in ${name} ${forHow(seconds)}`,
        { name: "Protection", before: "on", after: `paused ${forHow(seconds)}` },
        { seconds },
      );
    }
    if (s.protection_enabled) throw new Error(`Protection in ${name} is already on.`);
    return step(`Turn protection back on in ${name}`, {
      name: "Protection",
      before: s.protection_disabled_duration
        ? `paused for ${Math.ceil(s.protection_disabled_duration / 60_000)} more minutes`
        : "paused",
      after: "on",
    });
  }

  if (op === "refresh") {
    const f = await filtering(c);
    const on = (f.filters ?? []).filter((x) => x.enabled).length;
    return step(`Update ${name}'s filter lists (download every list again)`, {
      name: "Filter lists",
      before: `${on} on`,
      after: "downloaded again",
    });
  }

  if (op === "allow" || op === "block") {
    const domain = domainOf(p);
    if (!DOMAIN.test(domain)) throw new Error("Give one domain name, like ads.example.com.");
    const rule = ruleFor(domain, op === "allow");
    const rules = await rulesNow(c);
    if (rules.includes(rule))
      throw new Error(`${domain} is already ${op === "allow" ? "allowed" : "blocked"} in ${name}.`);
    const other = ruleFor(domain, op !== "allow");
    if (rules.includes(other))
      throw new Error(
        `${name} has a rule that ${op === "allow" ? "blocks" : "allows"} ${domain}: take it off first.`,
      );
    return step(
      `${op === "allow" ? "Allow" : "Block"} ${domain} and its subdomains in ${name}`,
      {
        name: domain,
        before: "as the filters say",
        after: op === "allow" ? "always allowed" : "always blocked",
      },
      { domain, rule },
    );
  }

  if (op === "rule-remove") {
    const rule = String(p.rule ?? "");
    if (!(await rulesNow(c)).includes(rule))
      throw new Error(`${name} has no custom rule ${rule.slice(0, 120)}.`);
    return step(
      `Take the custom rule ${rule.slice(0, 120)} off ${name}`,
      { name: "Custom rule", before: rule.slice(0, 120), after: "removed" },
      { rule },
    );
  }

  if (op === "filter-add") {
    const url = String(p.body ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 2000)
      throw new Error("Give the list's http or https address.");
    const allowlist = p.allowlist === true;
    const f = await filtering(c);
    if ([...(f.filters ?? []), ...(f.whitelist_filters ?? [])].some((x) => x.url === url))
      throw new Error(`${name} already has that list.`);
    const listName =
      String(p.name ?? "")
        .trim()
        .slice(0, 80) || new URL(url).hostname;
    return step(
      `Add the ${allowlist ? "allowlist" : "blocklist"} ${listName} (${maskAddress(url)}) to ${name}`,
      { name: "Filter lists", before: "not there", after: "added, on" },
      // The address can hold a key: it rides in the body, which is not shown in plan lists.
      { body: url, name: listName, allowlist },
    );
  }

  if (op === "filter-enable" || op === "filter-disable" || op === "filter-remove") {
    const id = Number(p.filterId);
    const allowlist = p.allowlist === true;
    const f = Number.isInteger(id) ? filterOf(await filtering(c), id, allowlist) : undefined;
    if (!f) throw new Error(`${name} has no such list: read the panel's lists again.`);
    if (op === "filter-remove")
      return step(
        `Remove the list ${f.name} from ${name}`,
        { name: f.name, before: `there, ${f.rules_count ?? 0} rules`, after: "removed" },
        { filterId: id, allowlist, body: JSON.stringify({ url: f.url, name: f.name }) },
      );
    const on = op === "filter-enable";
    if (f.enabled === on) throw new Error(`That list is already ${on ? "on" : "off"}.`);
    return step(
      `Switch ${on ? "on" : "off"} the list ${f.name} in ${name}`,
      { name: f.name, before: on ? "off" : "on", after: on ? "on" : "off" },
      { filterId: id, allowlist },
    );
  }

  if (op === "rewrite-add" || op === "rewrite-remove") {
    const domain = domainOf(p);
    const answer = String(p.answer ?? "")
      .trim()
      .toLowerCase();
    if (!REWRITE_NAME.test(domain)) throw new Error("Give a name like plex.home or *.home.");
    if (!isIP(answer) && !DOMAIN.test(answer))
      throw new Error("Give the address (192.168.1.10) or name it answers with.");
    const there = hasRewrite(await rewrites(c), domain, answer);
    if (op === "rewrite-add" && there) throw new Error(`${domain} already answers ${answer}.`);
    if (op === "rewrite-remove" && !there)
      throw new Error(`${name} has no rewrite ${domain} to ${answer}.`);
    return step(
      op === "rewrite-add"
        ? `Answer ${domain} with ${answer} in ${name}`
        : `Remove the rewrite ${domain} (${answer}) from ${name}`,
      {
        name: domain,
        before: op === "rewrite-add" ? "not rewritten" : answer,
        after: op === "rewrite-add" ? answer : "removed",
      },
      { domain, answer },
    );
  }

  if (op === "services") {
    let ids: string[];
    try {
      ids = JSON.parse(String(p.body ?? "[]")) as string[];
    } catch {
      throw new Error("Say which services to block, as a list of their ids.");
    }
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !/^[\w.-]{1,40}$/.test(x)))
      throw new Error("Say which services to block, as a list of their ids.");
    const all = await c.call<{ blocked_services: { id: string; name: string }[] }>(
      "GET",
      "/blocked_services/all",
    );
    const known = new Map(all.blocked_services.map((s) => [s.id, s.name]));
    const unknown = ids.filter((x) => !known.has(x));
    if (unknown.length) throw new Error(`AdGuard Home has no service ${unknown.join(", ")}.`);
    const before = (await servicesNow(c)).ids;
    const after = [...new Set(ids)].sort();
    const added = after.filter((x) => !before.includes(x)).map((x) => known.get(x)!);
    const removed = before.filter((x) => !after.includes(x)).map((x) => known.get(x) ?? x);
    if (!added.length && !removed.length) throw new Error("That is already the blocked list.");
    const what = [
      added.length ? `block ${added.join(", ")}` : "",
      removed.length ? `stop blocking ${removed.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return step(
      `In ${name}, ${what}`.slice(0, 190),
      {
        name: "Blocked services",
        before: before.length ? before.map((x) => known.get(x) ?? x).join(", ") : "none",
        after: after.length ? after.map((x) => known.get(x)!).join(", ") : "none",
      },
      { body: JSON.stringify({ ids: after, before }) },
    );
  }

  // safety
  const setting = String(p.setting ?? "") as Safety;
  if (!(setting in SAFETY))
    throw new Error("Say which switch: safebrowsing, parental or safesearch.");
  const on = p.on === true;
  if ((await safetyOn(c, setting)) === on)
    throw new Error(`${SAFETY[setting].split(" (")[0]} is already ${on ? "on" : "off"}.`);
  return step(
    `Switch ${on ? "on" : "off"} ${SAFETY[setting].split(" (")[0]!.toLowerCase()} in ${name}`,
    { name: SAFETY[setting], before: on ? "off" : "on", after: on ? "on" : "off" },
    { setting, on },
  );
}

export async function runAdguard(
  c: AdguardClient,
  name: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as AdguardOp;
  const stale = (result: string): StepOutcome => ({ ok: false, stale: true, result });
  const done = (ok: boolean, yes: string, no: string): StepOutcome => ({
    ok,
    verified: ok,
    result: ok ? yes : no,
  });

  if (op === "pause" || op === "resume") {
    const s = await c.call<RawStatus>("GET", "/status");
    if ((op === "pause") !== s.protection_enabled)
      return stale(`Protection was already ${op === "pause" ? "paused" : "on"}; nothing changed.`);
    const seconds = Number(p.seconds ?? 0);
    await c.call("POST", "/protection", {
      enabled: op === "resume",
      ...(op === "pause" && seconds > 0 ? { duration: seconds * 1000 } : {}),
    });
    const after = await c.call<RawStatus>("GET", "/status");
    return done(
      after.protection_enabled === (op === "resume"),
      op === "pause"
        ? `Protection in ${name} is paused ${forHow(seconds)}.`
        : `Protection in ${name} is on.`,
      `${name} still reads protection as ${after.protection_enabled ? "on" : "paused"}.`,
    );
  }

  if (op === "refresh") {
    const r = await c.call<{ updated: number }>(
      "POST",
      "/filtering/refresh",
      { whitelist: false },
      REFRESH_MS,
    );
    const f = await filtering(c);
    const never = (f.filters ?? []).filter(
      (x) => x.enabled && (!x.last_updated || x.last_updated.startsWith("0001")),
    ).length;
    return {
      ok: true,
      result: `${r?.updated ?? 0} ${r?.updated === 1 ? "list" : "lists"} had changes.${never ? ` ${never} could not be downloaded.` : ""}`,
    };
  }

  if (op === "allow" || op === "block") {
    const rule = String(p.rule);
    if ((await rulesNow(c)).includes(rule))
      return stale("The rule was already there; nothing changed.");
    await setRules(c, (r) => [...r, rule]);
    return done(
      (await rulesNow(c)).includes(rule),
      `${String(p.domain)} is ${op === "allow" ? "allowed" : "blocked"} in ${name}.`,
      `${name} does not show the rule afterwards.`,
    );
  }

  if (op === "rule-remove") {
    const rule = String(p.rule);
    if (!(await rulesNow(c)).includes(rule))
      return stale("The rule was already gone; nothing changed.");
    await setRules(c, (r) => r.filter((x) => x !== rule));
    return done(
      !(await rulesNow(c)).includes(rule),
      "The rule is removed.",
      "The rule is still there.",
    );
  }

  if (op === "filter-add") {
    const url = String(p.body);
    const allowlist = p.allowlist === true;
    const f = await filtering(c);
    if ([...(f.filters ?? []), ...(f.whitelist_filters ?? [])].some((x) => x.url === url))
      return stale("The list was already there; nothing changed.");
    await c.call("POST", "/filtering/add_url", { name: String(p.name), url, whitelist: allowlist });
    const after = await filtering(c);
    const added = ((allowlist ? after.whitelist_filters : after.filters) ?? []).find(
      (x) => x.url === url,
    );
    return done(
      Boolean(added),
      `The list is in ${name}${added ? ` with ${added.rules_count ?? 0} rules` : ""}.`,
      `${name} does not show the list afterwards.`,
    );
  }

  if (op === "filter-enable" || op === "filter-disable") {
    const on = op === "filter-enable";
    const id = Number(p.filterId);
    const allowlist = p.allowlist === true;
    const f = filterOf(await filtering(c), id, allowlist);
    if (!f) return stale("That list is no longer in AdGuard Home.");
    if (f.enabled === on)
      return stale(`The list was already ${on ? "on" : "off"}; nothing changed.`);
    await setFilter(c, id, allowlist, on);
    return done(
      filterOf(await filtering(c), id, allowlist)?.enabled === on,
      `The list is ${on ? "on" : "off"}.`,
      "The list did not change.",
    );
  }

  if (op === "filter-remove") {
    const id = Number(p.filterId);
    const allowlist = p.allowlist === true;
    const was = JSON.parse(String(p.body)) as { url: string };
    const f = filterOf(await filtering(c), id, allowlist);
    if (!f) return stale("The list was already gone; nothing changed.");
    if (f.url !== was.url)
      return stale(
        "That list changed in AdGuard Home after the plan was made; nothing was removed.",
      );
    await c.call("POST", "/filtering/remove_url", { url: f.url, whitelist: allowlist });
    return done(
      !filterOf(await filtering(c), id, allowlist),
      `The list is removed from ${name}.`,
      "The list is still there.",
    );
  }

  if (op === "rewrite-add" || op === "rewrite-remove") {
    const domain = String(p.domain);
    const answer = String(p.answer);
    const add = op === "rewrite-add";
    if (hasRewrite(await rewrites(c), domain, answer) === add)
      return stale(`The rewrite was already ${add ? "there" : "gone"}; nothing changed.`);
    await c.call("POST", add ? "/rewrite/add" : "/rewrite/delete", { domain, answer });
    return done(
      hasRewrite(await rewrites(c), domain, answer) === add,
      add ? `${domain} answers ${answer}.` : `The rewrite ${domain} is removed.`,
      `${name} does not show the change afterwards.`,
    );
  }

  if (op === "services") {
    const want = JSON.parse(String(p.body)) as { ids: string[]; before: string[] };
    const now = (await servicesNow(c)).ids.slice().sort();
    if (now.join() !== want.before.slice().sort().join())
      return stale(
        "Blocked services changed in AdGuard Home after the plan was made; nothing changed.",
      );
    await setServices(c, want.ids);
    const after = (await servicesNow(c)).ids.slice().sort();
    return done(
      after.join() === want.ids.slice().sort().join(),
      `${name} blocks ${after.length ? `${after.length} ${after.length === 1 ? "service" : "services"}` : "no services"}.`,
      "Blocked services did not change as planned.",
    );
  }

  // safety
  const setting = String(p.setting) as Safety;
  const on = p.on === true;
  if ((await safetyOn(c, setting)) === on)
    return stale(`It was already ${on ? "on" : "off"}; nothing changed.`);
  await setSafety(c, setting, on);
  return done(
    (await safetyOn(c, setting)) === on,
    `${SAFETY[setting].split(" (")[0]} is ${on ? "on" : "off"}.`,
    "The switch did not change.",
  );
}
