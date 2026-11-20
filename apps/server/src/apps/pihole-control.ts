import { isIP } from "node:net";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import {
  maskAddress,
  PiholeError,
  PiholeSession,
  toAlias,
  toRecord,
  type RawDomain,
  type RawList,
} from "./pihole";

/**
 * Changes to Pi-hole, each a plan the owner approves (app-pihole-control, params.op). Pi-hole is
 * the network's DNS, so every plan here is marked protected: approving it asks the owner to
 * confirm it is them. Each change is read back from Pi-hole before it counts as done.
 *
 * What it can do: pause ad blocking (for a time, or until turned back on) and turn it back on,
 * update the blocklists (Pi-hole's "gravity"), allow or block a domain by name or by a pattern
 * (regex) and take one off again, add, switch on or off, or remove a blocklist, and add or remove
 * local DNS names (plex.home is 192.168.1.10) and aliases. Never Pi-hole's password, upstream DNS
 * servers, DHCP, or its other settings: those stay in Pi-hole.
 */

export const PIHOLE_OPS = [
  "pause",
  "resume",
  "gravity",
  "allow",
  "deny",
  "domain-remove",
  "list-add",
  "list-enable",
  "list-disable",
  "list-remove",
  "dns-add",
  "dns-remove",
  "alias-add",
  "alias-remove",
] as const;
export type PiholeOp = (typeof PIHOLE_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

class Refused extends Error {}

/** A domain name as Pi-hole takes it: letters, digits, - and _, with at least one dot. */
const DOMAIN = /^(?=.{3,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;

/** Pause choices, in seconds (0: until it is turned back on). */
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

/** Gravity downloads every list; a big set takes minutes. */
const GRAVITY_MS = 10 * 60_000;

export class PiholeOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (s: PiholeSession) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      async ({ value }) => fn(await PiholeSession.open(service.localUrl, value, this.fetchImpl)),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as PiholeOp;
    if (!PIHOLE_OPS.includes(op)) throw new Error(`Say what to do: ${PIHOLE_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Pi-hole", "read", (s) =>
      planPihole(s, service.name, op, params ?? {}, base),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Pi-hole", "change", (s) =>
        runPihole(s, service.name, p),
      );
    } catch (error) {
      if (!(error instanceof PiholeError) && !(error instanceof Refused)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, domain: p.domain ?? null, listId: p.listId ?? null },
    });
    return out;
  }

  /** Puts a change back when a later step of the same plan failed, or from the panel's Undo. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op) as PiholeOp;
    const reverse: Partial<Record<PiholeOp, (s: PiholeSession) => Promise<string>>> = {
      pause: async (s) => {
        await s.call("POST", "/dns/blocking", { blocking: true, timer: null });
        return "Ad blocking is back on.";
      },
      resume: async (s) => {
        await s.call("POST", "/dns/blocking", { blocking: false, timer: null });
        return "Ad blocking is paused again.";
      },
      allow: async (s) => {
        await s.call("DELETE", `/domains/allow/${kindOf(p)}/${enc(String(p.domain))}`);
        return `${String(p.domain)} is no longer allowed.`;
      },
      deny: async (s) => {
        await s.call("DELETE", `/domains/deny/${kindOf(p)}/${enc(String(p.domain))}`);
        return `${String(p.domain)} is no longer blocked.`;
      },
      "dns-add": async (s) => {
        await s.call("DELETE", `/config/dns/hosts/${enc(`${String(p.ip)} ${String(p.domain)}`)}`);
        return `${String(p.domain)} is no longer a local name.`;
      },
      "dns-remove": async (s) => {
        await s.call("PUT", `/config/dns/hosts/${enc(`${String(p.ip)} ${String(p.domain)}`)}`);
        return `${String(p.domain)} points to ${String(p.ip)} again.`;
      },
      "alias-add": async (s) => {
        await s.call(
          "DELETE",
          `/config/dns/cnameRecords/${enc(`${String(p.domain)},${String(p.target)}`)}`,
        );
        return `The alias ${String(p.domain)} is removed again.`;
      },
      "alias-remove": async (s) => {
        await s.call(
          "PUT",
          `/config/dns/cnameRecords/${enc(`${String(p.domain)},${String(p.target)}`)}`,
        );
        return `The alias ${String(p.domain)} is back.`;
      },
      "domain-remove": async (s) => {
        await s.call("POST", `/domains/${String(p.list)}/${kindOf(p)}`, {
          domain: String(p.domain),
          ...(p.comment ? { comment: String(p.comment) } : {}),
        });
        return `${String(p.domain)} is back on the ${p.list === "allow" ? "allowed" : "blocked"} list.`;
      },
      "list-enable": (s) =>
        setList(s, Number(p.listId), false).then(() => "The list is off again."),
      "list-disable": (s) => setList(s, Number(p.listId), true).then(() => "The list is on again."),
      "list-add": async (s) => {
        const type = p.listType === "allow" ? "allow" : "block";
        await s.call("DELETE", `/lists/${enc(String(p.body))}?type=${type}`);
        return "The new list is removed again.";
      },
      "list-remove": async (s) => {
        const was = JSON.parse(String(p.body)) as RawList;
        await s.call("POST", `/lists?type=${was.type}`, {
          address: was.address,
          comment: was.comment ?? null,
          enabled: was.enabled,
          groups: was.groups ?? [0],
        });
        return "The list is back.";
      },
    };
    const fn = reverse[op];
    if (!fn) return undefined;
    return this.use(service, "undo a change in Pi-hole", "change", async (s) => ({
      ok: true,
      result: await fn(s),
    }));
  }
}

const enc = (x: string) => encodeURIComponent(x);

async function listById(s: PiholeSession, id: number): Promise<RawList | undefined> {
  const { lists } = await s.call<{ lists: RawList[] }>("GET", "/lists");
  return lists.find((l) => l.id === id);
}

async function setList(s: PiholeSession, id: number, enabled: boolean) {
  const l = await listById(s, id);
  if (!l) throw new Refused("That list is no longer in Pi-hole.");
  await s.call("PUT", `/lists/${enc(l.address)}?type=${l.type}`, {
    comment: l.comment ?? null,
    enabled,
    groups: l.groups ?? [0],
  });
}

/** Exact name, or a pattern (regex) that matches many names. */
const kindOf = (p: StepParams): "exact" | "regex" => (p.match === "regex" ? "regex" : "exact");

async function domainIn(
  s: PiholeSession,
  list: "allow" | "deny",
  domain: string,
  kind: "exact" | "regex" = "exact",
) {
  const r = await s.call<{ domains: RawDomain[] }>(
    "GET",
    `/domains/${list}/${kind}/${enc(domain)}`,
  );
  return r.domains.find((d) => d.domain === domain);
}

/** A name Pi-hole answers locally: "nas" or "plex.home" (letters, digits, - and _). */
const LOCAL_NAME =
  /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

async function hostLines(s: PiholeSession) {
  return (await s.call<{ config: { dns: { hosts: string[] } } }>("GET", "/config/dns/hosts")).config
    .dns.hosts;
}
async function aliasLines(s: PiholeSession) {
  return (
    await s.call<{ config: { dns: { cnameRecords: string[] } } }>("GET", "/config/dns/cnameRecords")
  ).config.dns.cnameRecords;
}
const hasRecord = (lines: string[], name: string, ip: string) =>
  lines.flatMap(toRecord).some((r) => r.name === name && r.ip === ip);
const hasAlias = (lines: string[], name: string, target: string) =>
  lines.map(toAlias).some((a) => a.name === name && a.target === target);

const blockingNow = (s: PiholeSession) =>
  s.call<{ blocking: string; timer: number | null }>("GET", "/dns/blocking");

const gravityAt = async (s: PiholeSession) =>
  (
    await s.call<{ gravity: { domains_being_blocked: number; last_update?: number } }>(
      "GET",
      "/stats/summary",
    )
  ).gravity;

export async function planPihole(
  s: PiholeSession,
  name: string,
  op: PiholeOp,
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
    // Pi-hole is the network's DNS: approving any change asks the owner to confirm it is them.
    params: { op, ...extra, protected: "yes" },
    change: { summary: label, settings: [setting] },
  });

  if (op === "pause" || op === "resume") {
    const b = await blockingNow(s);
    if (op === "pause") {
      if (b.blocking !== "enabled") throw new Error(`Ad blocking in ${name} is already paused.`);
      const seconds = Number(p.seconds ?? 300);
      if (!PAUSE_FOR.includes(seconds))
        throw new Error(
          "Pause for 30 seconds, 5 or 30 minutes, 1, 2 or 24 hours, or until turned back on (0).",
        );
      return step(
        `Pause ad blocking in ${name} ${forHow(seconds)}`,
        { name: "Ad blocking", before: "on", after: `paused ${forHow(seconds)}` },
        { seconds },
      );
    }
    if (b.blocking === "enabled") throw new Error(`Ad blocking in ${name} is already on.`);
    return step(`Turn ad blocking back on in ${name}`, {
      name: "Ad blocking",
      before: b.timer ? `paused for ${Math.ceil(b.timer / 60)} more minutes` : "paused",
      after: "on",
    });
  }

  if (op === "gravity") {
    const g = await gravityAt(s);
    const at = g.last_update
      ? new Date(g.last_update * 1000).toISOString().slice(0, 16).replace("T", " ")
      : "never";
    return step(
      `Update ${name}'s blocklists (download every list again)`,
      {
        name: "Blocklists",
        before: `${g.domains_being_blocked} domains, updated ${at} UTC`,
        after: "downloaded again",
      },
      { before: String(g.last_update ?? 0) },
    );
  }

  if (op === "allow" || op === "deny" || op === "domain-remove") {
    const kind = kindOf(p);
    const domain =
      kind === "regex"
        ? String(p.domain ?? "").trim()
        : String(p.domain ?? "")
            .trim()
            .toLowerCase()
            .replace(/\.$/, "");
    if (kind === "exact" && !DOMAIN.test(domain))
      throw new Error("Give one domain name, like ads.example.com.");
    if (kind === "regex" && (!domain || domain.length > 200 || /[\n\r]/.test(domain)))
      throw new Error("Give one pattern (a regular expression), at most 200 characters.");
    const what = kind === "regex" ? `names matching ${domain}` : domain;
    const list: "allow" | "deny" =
      op === "domain-remove"
        ? p.list === "allow"
          ? "allow"
          : p.list === "deny"
            ? "deny"
            : (() => {
                throw new Error("Say which list to take it off: allow or deny.");
              })()
        : op;
    const there = await domainIn(s, list, domain, kind);
    const extra = { domain, ...(kind === "regex" ? { match: "regex" } : {}) };
    if (op === "domain-remove") {
      if (!there)
        throw new Error(
          `${domain} is not on ${name}'s ${list === "allow" ? "allowed" : "blocked"} list.`,
        );
      return step(
        `Take ${what} off ${name}'s ${list === "allow" ? "allowed" : "blocked"} list`,
        {
          name: domain,
          before: list === "allow" ? "always allowed" : "always blocked",
          after: "as the blocklists say",
        },
        { ...extra, list, ...(there.comment ? { comment: there.comment.slice(0, 200) } : {}) },
      );
    }
    if (there)
      throw new Error(`${domain} is already ${op === "allow" ? "allowed" : "blocked"} in ${name}.`);
    const other = await domainIn(s, op === "allow" ? "deny" : "allow", domain, kind);
    if (other)
      throw new Error(
        `${domain} is on ${name}'s ${op === "allow" ? "blocked" : "allowed"} list: take it off that list first.`,
      );
    return step(
      op === "allow" ? `Allow ${what} in ${name}` : `Block ${what} in ${name}`,
      {
        name: domain,
        before: "as the blocklists say",
        after: op === "allow" ? "always allowed" : "always blocked",
      },
      extra,
    );
  }

  if (op === "dns-add" || op === "dns-remove" || op === "alias-add" || op === "alias-remove") {
    const local = String(p.domain ?? "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    if (!LOCAL_NAME.test(local)) throw new Error("Give a name like plex.home or nas.");
    const restarts = `${name} restarts its DNS for a second to use it`;
    if (op === "dns-add" || op === "dns-remove") {
      const ip = String(p.ip ?? "").trim();
      if (!isIP(ip)) throw new Error("Give the address it points to, like 192.168.1.10.");
      const there = hasRecord(await hostLines(s), local, ip);
      if (op === "dns-add" && there) throw new Error(`${local} already points to ${ip}.`);
      if (op === "dns-remove" && !there)
        throw new Error(`${name} has no record ${local} to ${ip}.`);
      return step(
        op === "dns-add"
          ? `Point ${local} to ${ip} in ${name} (${restarts})`
          : `Remove the local name ${local} (${ip}) from ${name} (${restarts})`,
        {
          name: local,
          before: op === "dns-add" ? "not a local name" : ip,
          after: op === "dns-add" ? ip : "removed",
        },
        { domain: local, ip },
      );
    }
    const target = String(p.target ?? "")
      .trim()
      .toLowerCase()
      .replace(/\.$/, "");
    if (!LOCAL_NAME.test(target))
      throw new Error("Give the name the alias points to, like plex.home.");
    if (target === local) throw new Error("An alias cannot point to itself.");
    const there = hasAlias(await aliasLines(s), local, target);
    if (op === "alias-add" && there) throw new Error(`${local} is already an alias of ${target}.`);
    if (op === "alias-remove" && !there) throw new Error(`${name} has no alias ${local}.`);
    return step(
      op === "alias-add"
        ? `Make ${local} another name for ${target} in ${name} (${restarts})`
        : `Remove the alias ${local} from ${name} (${restarts})`,
      {
        name: local,
        before: op === "alias-add" ? "not a local name" : `alias of ${target}`,
        after: op === "alias-add" ? `alias of ${target}` : "removed",
      },
      { domain: local, target },
    );
  }

  if (op === "list-add") {
    const address = String(p.body ?? "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(address) || address.length > 2000)
      throw new Error("Give the list's http or https address.");
    const type = p.listType === "allow" ? "allow" : "block";
    const { lists } = await s.call<{ lists: RawList[] }>("GET", "/lists");
    if (lists.some((l) => l.address === address && l.type === type))
      throw new Error(`${name} already has that list.`);
    return step(
      `Add the ${type === "allow" ? "allowlist" : "blocklist"} ${maskAddress(address)} to ${name} (used from the next blocklist update)`,
      { name: "Lists", before: "not there", after: "added, on" },
      // The address can hold a key: it rides in the body, which is not shown in plan lists.
      { body: address, listType: type },
    );
  }

  // Switching on or off, or removing, a list Pi-hole has.
  const id = Number(p.listId);
  const l = Number.isInteger(id) ? await listById(s, id) : undefined;
  if (!l) throw new Error(`${name} has no such list: read the panel's list again.`);
  const shown = l.comment ? `${l.comment} (${maskAddress(l.address)})` : maskAddress(l.address);
  if (op === "list-enable" || op === "list-disable") {
    if (l.enabled === (op === "list-enable"))
      throw new Error(`That list is already ${l.enabled ? "on" : "off"}.`);
    return step(
      `Switch ${op === "list-enable" ? "on" : "off"} the list ${shown} in ${name}`,
      { name: "List", before: l.enabled ? "on" : "off", after: l.enabled ? "off" : "on" },
      { listId: id },
    );
  }
  return step(
    `Remove the list ${shown} from ${name}`,
    { name: "List", before: `there, ${l.number ?? 0} domains`, after: "removed" },
    {
      listId: id,
      body: JSON.stringify({
        address: l.address,
        type: l.type,
        comment: l.comment ?? null,
        enabled: l.enabled,
        groups: l.groups ?? [0],
      }),
    },
  );
}

export async function runPihole(
  s: PiholeSession,
  name: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as PiholeOp;

  if (op === "pause" || op === "resume") {
    const b = await blockingNow(s);
    if ((op === "pause") !== (b.blocking === "enabled"))
      return {
        ok: false,
        stale: true,
        result: `Ad blocking was already ${op === "pause" ? "paused" : "on"}; nothing changed.`,
      };
    const seconds = Number(p.seconds ?? 0);
    await s.call("POST", "/dns/blocking", {
      blocking: op === "resume",
      timer: op === "pause" && seconds > 0 ? seconds : null,
    });
    const after = await blockingNow(s);
    const ok = after.blocking === (op === "pause" ? "disabled" : "enabled");
    return {
      ok,
      verified: ok,
      result: ok
        ? op === "pause"
          ? `Ad blocking in ${name} is paused ${forHow(seconds)}.`
          : `Ad blocking in ${name} is on.`
        : `${name} still reads ad blocking as ${after.blocking}.`,
    };
  }

  if (op === "gravity") {
    const before = Number(p.before ?? 0);
    const log = await s.call<string>("POST", "/action/gravity", undefined, {
      timeoutMs: GRAVITY_MS,
      text: true,
    });
    // Pi-hole reloads its counts a moment after the update finishes: read until it has.
    let g = await gravityAt(s);
    for (let i = 0; i < 20 && (g.last_update ?? 0) <= before; i++) {
      await new Promise((r) => setTimeout(r, 500));
      g = await gravityAt(s);
    }
    const ok = (g.last_update ?? 0) > before;
    const { lists } = await s.call<{ lists: RawList[] }>("GET", "/lists");
    const failed = lists.filter((l) => l.enabled && (l.status === 3 || l.status === 4)).length;
    return {
      ok,
      verified: ok,
      result: ok
        ? `Blocklists updated: ${g.domains_being_blocked} domains.${failed ? ` ${failed} ${failed === 1 ? "list" : "lists"} could not be downloaded.` : ""}`
        : `Pi-hole did not finish the update: ${lastLine(log)}`,
    };
  }

  if (op === "allow" || op === "deny") {
    const domain = String(p.domain);
    const kind = kindOf(p);
    if (await domainIn(s, op, domain, kind))
      return {
        ok: false,
        stale: true,
        result: `${domain} was already on the list; nothing changed.`,
      };
    await s.call("POST", `/domains/${op}/${kind}`, { domain, comment: "Added from Hearth" });
    const ok = Boolean(await domainIn(s, op, domain, kind));
    return {
      ok,
      verified: ok,
      result: ok
        ? `${domain} is ${op === "allow" ? "allowed" : "blocked"} in ${name}.`
        : `${name} does not show ${domain} on the list afterwards.`,
    };
  }

  if (op === "domain-remove") {
    const domain = String(p.domain);
    const list = p.list === "allow" ? "allow" : "deny";
    const kind = kindOf(p);
    if (!(await domainIn(s, list, domain, kind)))
      return {
        ok: false,
        stale: true,
        result: `${domain} was already off the list; nothing changed.`,
      };
    await s.call("DELETE", `/domains/${list}/${kind}/${enc(domain)}`);
    const ok = !(await domainIn(s, list, domain, kind));
    return {
      ok,
      verified: ok,
      result: ok
        ? `${domain} is off ${name}'s ${list === "allow" ? "allowed" : "blocked"} list.`
        : `${domain} is still on the list.`,
    };
  }

  if (op === "dns-add" || op === "dns-remove") {
    const local = String(p.domain);
    const ip = String(p.ip);
    const add = op === "dns-add";
    if (hasRecord(await hostLines(s), local, ip) === add)
      return {
        ok: false,
        stale: true,
        result: `${local} was already ${add ? "there" : "gone"}; nothing changed.`,
      };
    await s.call(add ? "PUT" : "DELETE", `/config/dns/hosts/${enc(`${ip} ${local}`)}`);
    const ok = hasRecord(await hostLines(s), local, ip) === add;
    return {
      ok,
      verified: ok,
      result: ok
        ? add
          ? `${local} points to ${ip}.`
          : `${local} is no longer a local name.`
        : `${name} does not show the change afterwards.`,
    };
  }

  if (op === "alias-add" || op === "alias-remove") {
    const local = String(p.domain);
    const target = String(p.target);
    const add = op === "alias-add";
    if (hasAlias(await aliasLines(s), local, target) === add)
      return {
        ok: false,
        stale: true,
        result: `The alias was already ${add ? "there" : "gone"}; nothing changed.`,
      };
    await s.call(add ? "PUT" : "DELETE", `/config/dns/cnameRecords/${enc(`${local},${target}`)}`);
    const ok = hasAlias(await aliasLines(s), local, target) === add;
    return {
      ok,
      verified: ok,
      result: ok
        ? add
          ? `${local} is another name for ${target}.`
          : `The alias ${local} is removed.`
        : `${name} does not show the change afterwards.`,
    };
  }

  if (op === "list-add") {
    const address = String(p.body);
    const type = p.listType === "allow" ? "allow" : "block";
    const { lists } = await s.call<{ lists: RawList[] }>("GET", "/lists");
    if (lists.some((l) => l.address === address && l.type === type))
      return { ok: false, stale: true, result: "The list was already there; nothing changed." };
    await s.call("POST", `/lists?type=${type}`, {
      address,
      comment: "Added from Hearth",
      enabled: true,
      groups: [0],
    });
    const added = (await s.call<{ lists: RawList[] }>("GET", "/lists")).lists.find(
      (l) => l.address === address && l.type === type,
    );
    return {
      ok: Boolean(added),
      verified: Boolean(added),
      result: added
        ? `The list is in ${name}; it is used from the next blocklist update.`
        : `${name} does not show the list afterwards.`,
    };
  }

  const id = Number(p.listId);
  const l = await listById(s, id);
  if (op === "list-enable" || op === "list-disable") {
    const on = op === "list-enable";
    if (!l) return { ok: false, stale: true, result: "That list is no longer in Pi-hole." };
    if (l.enabled === on)
      return {
        ok: false,
        stale: true,
        result: `The list was already ${on ? "on" : "off"}; nothing changed.`,
      };
    await setList(s, id, on);
    const after = await listById(s, id);
    const ok = after?.enabled === on;
    return {
      ok,
      verified: ok,
      result: ok ? `The list is ${on ? "on" : "off"}.` : "The list did not change.",
    };
  }

  // list-remove
  if (!l) return { ok: false, stale: true, result: "The list was already gone; nothing changed." };
  const was = JSON.parse(String(p.body)) as { address: string; type: string };
  if (l.address !== was.address || l.type !== was.type)
    return {
      ok: false,
      stale: true,
      result: "That list changed in Pi-hole after the plan was made; nothing was removed.",
    };
  await s.call("DELETE", `/lists/${enc(l.address)}?type=${l.type}`);
  const ok = !(await listById(s, id));
  return {
    ok,
    verified: ok,
    result: ok ? `The list is removed from ${name}.` : "The list is still there.",
  };
}

const lastLine = (log: string) =>
  log
    .split("\n")
    // eslint-disable-next-line no-control-regex
    .map((l) => l.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim())
    .filter(Boolean)
    .pop()
    ?.slice(0, 200) ?? "no answer";
