import { isIP } from "node:net";
import type { StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { NpmClient, NpmError, toHost, type RawHost } from "./npm";

/**
 * Changes to Nginx Proxy Manager, each a plan the owner approves (app-npm-control, params.op). A
 * reverse proxy decides who reaches what, so every plan is marked protected: approving it asks the
 * owner to confirm it is them. Each change is read back, including whether nginx loaded it.
 *
 * What it can do: switch a proxy host on or off, change where one forwards, add a proxy host
 * (with an existing certificate), remove one, and renew a Let's Encrypt certificate. Never
 * uploading certificates or keys, access lists and their passwords, custom nginx settings,
 * streams or users: those stay in NPM.
 */

export const NPM_OPS = [
  "host-enable",
  "host-disable",
  "host-forward",
  "host-add",
  "host-remove",
  "cert-renew",
] as const;
export type NpmOp = (typeof NPM_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

class Refused extends Error {}

const DOMAIN = /^(\*\.)?(?=.{3,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9-]{2,63}$/;
const HOSTNAME = /^[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9_])?$/;

export class NpmOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (c: NpmClient) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value, username }) =>
        fn(
          new NpmClient(
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
    const op = String(params?.op ?? "") as NpmOp;
    if (!NPM_OPS.includes(op)) throw new Error(`Say what to do: ${NPM_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Nginx Proxy Manager", "read", (c) =>
      planNpm(c, service.name, op, params ?? {}, base),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Nginx Proxy Manager", "change", (c) =>
        runNpm(c, service.name, p),
      );
    } catch (error) {
      if (!(error instanceof NpmError) && !(error instanceof Refused)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, hostId: p.hostId ?? null, domain: p.domain ?? null },
    });
    return out;
  }

  /** Puts a host back as it was when a later step of the same plan failed, or from Undo. */
  async undo(step: StepRun, service: Service): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    const op = String(p.op) as NpmOp;
    const reverse: Partial<Record<NpmOp, (c: NpmClient) => Promise<string>>> = {
      "host-enable": async (c) => {
        await c.call("POST", `/nginx/proxy-hosts/${Number(p.hostId)}/disable`);
        return "The host is off again.";
      },
      "host-disable": async (c) => {
        await c.call("POST", `/nginx/proxy-hosts/${Number(p.hostId)}/enable`);
        return "The host is on again.";
      },
      "host-forward": async (c) => {
        const was = JSON.parse(String(p.body)) as { before: Record<string, unknown> };
        await c.call("PUT", `/nginx/proxy-hosts/${Number(p.hostId)}`, was.before);
        return "The host forwards where it did before.";
      },
      "host-add": async (c) => {
        const h = await hostByDomain(c, String(p.domain));
        if (h) await c.call("DELETE", `/nginx/proxy-hosts/${h.id}`);
        return "The new host is removed again.";
      },
      "host-remove": async (c) => {
        await c.call("POST", "/nginx/proxy-hosts", JSON.parse(String(p.body)) as object);
        return "The host is back (without any custom nginx settings it had).";
      },
    };
    const fn = reverse[op];
    if (!fn) return undefined;
    return this.use(service, "undo a change in Nginx Proxy Manager", "change", async (c) => ({
      ok: true,
      result: await fn(c),
    }));
  }
}

const hostById = async (c: NpmClient, id: number) =>
  (await c.call<RawHost[]>("GET", "/nginx/proxy-hosts?expand=certificate,access_list")).find(
    (h) => h.id === id,
  );
const hostByDomain = async (c: NpmClient, domain: string) =>
  (await c.call<RawHost[]>("GET", "/nginx/proxy-hosts")).find((h) =>
    h.domain_names.includes(domain),
  );

/** Where a host forwards, as asked: scheme, an address or name, and a port. */
function forwardOf(p: StepParams) {
  const scheme = p.forwardScheme === "https" ? "https" : "http";
  const host = String(p.forwardHost ?? "")
    .trim()
    .toLowerCase();
  const port = Number(p.forwardPort);
  if (!host || (!isIP(host) && !HOSTNAME.test(host)))
    throw new Error("Give the address or name to forward to, like 192.168.1.10 or radarr.");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Give the port, 1 to 65535.");
  return { forward_scheme: scheme, forward_host: host, forward_port: port };
}

export async function planNpm(
  c: NpmClient,
  name: string,
  op: NpmOp,
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
    // A reverse proxy decides who reaches what: approving any change asks the owner to confirm it is them.
    params: { op, ...extra, protected: "yes" },
    change: { summary: label, settings: [setting] },
  });

  if (op === "host-add") {
    const domain = String(p.domain ?? "")
      .trim()
      .toLowerCase();
    if (!DOMAIN.test(domain)) throw new Error("Give the site's name, like radarr.example.com.");
    const f = forwardOf(p);
    if (await hostByDomain(c, domain))
      throw new Error(`${name} already has a proxy host for ${domain}.`);
    const certId = Number(p.certificateId ?? 0);
    let certName = "";
    if (certId) {
      const certs = await c.call<{ id: number; nice_name: string }[]>("GET", "/nginx/certificates");
      const cert = certs.find((x) => x.id === certId);
      if (!cert) throw new Error(`${name} has no certificate ${certId}.`);
      certName = cert.nice_name;
    }
    const target = `${f.forward_scheme}://${f.forward_host}:${f.forward_port}`;
    return step(
      `Add the site ${domain} to ${name}, forwarding to ${target}${certName ? ` with the certificate ${certName}` : " (http only, no certificate)"}`,
      { name: domain, before: "not served", after: target },
      {
        domain,
        ...camel(f),
        certificateId: certId,
        sslForced: Boolean(certId) && p.sslForced !== false,
      },
    );
  }

  if (op === "cert-renew") {
    const id = Number(p.certificateId);
    const certs = await c.call<
      { id: number; nice_name: string; provider: string; expires_on?: string }[]
    >("GET", "/nginx/certificates");
    const cert = certs.find((x) => x.id === id);
    if (!cert) throw new Error(`${name} has no certificate ${id}.`);
    if (cert.provider !== "letsencrypt")
      throw new Error(`${cert.nice_name} was uploaded, not from Let's Encrypt: replace it in NPM.`);
    return step(
      `Renew the certificate ${cert.nice_name} in ${name} (asks Let's Encrypt)`,
      {
        name: cert.nice_name,
        before: `expires ${cert.expires_on?.slice(0, 10) ?? "?"}`,
        after: "renewed",
      },
      { certificateId: id, before: cert.expires_on ?? "" },
    );
  }

  const id = Number(p.hostId);
  const h = Number.isInteger(id) ? await hostById(c, id) : undefined;
  if (!h) throw new Error(`${name} has no such proxy host: read the panel again.`);
  const site = h.domain_names[0] ?? `host ${id}`;
  const now = toHost(h);

  if (op === "host-enable" || op === "host-disable") {
    const on = op === "host-enable";
    if (now.enabled === on) throw new Error(`${site} is already ${on ? "on" : "off"}.`);
    return step(
      `${on ? "Switch on" : "Switch off"} ${site} in ${name}${on ? "" : " (visitors get no site until it is on again)"}`,
      { name: site, before: on ? "off" : "on", after: on ? "on" : "off" },
      { hostId: id, domain: site },
    );
  }

  if (op === "host-forward") {
    const f = forwardOf(p);
    const target = `${f.forward_scheme}://${f.forward_host}:${f.forward_port}`;
    if (target === now.forward) throw new Error(`${site} already forwards to ${target}.`);
    return step(
      `Send ${site} to ${target} in ${name}`,
      { name: site, before: now.forward, after: target },
      {
        hostId: id,
        domain: site,
        ...camel(f),
        body: JSON.stringify({
          before: {
            forward_scheme: h.forward_scheme,
            forward_host: h.forward_host,
            forward_port: h.forward_port,
          },
        }),
      },
    );
  }

  // host-remove: what is needed to put it back (custom nginx settings are not kept: they can hold secrets).
  return step(
    `Remove the site ${site} from ${name} (visitors get no site there)`,
    { name: site, before: now.forward, after: "removed" },
    {
      hostId: id,
      domain: site,
      body: JSON.stringify({
        domain_names: h.domain_names,
        forward_scheme: h.forward_scheme,
        forward_host: h.forward_host,
        forward_port: h.forward_port,
        certificate_id: Number(h.certificate_id) || 0,
        ssl_forced: Boolean(h.ssl_forced),
        block_exploits: Boolean(h.block_exploits),
        allow_websocket_upgrade: Boolean(h.allow_websocket_upgrade),
        access_list_id: h.access_list_id ?? 0,
        meta: {},
        advanced_config: "",
        locations: [],
      }),
    },
  );
}

const camel = (f: { forward_scheme: string; forward_host: string; forward_port: number }) => ({
  forwardScheme: f.forward_scheme,
  forwardHost: f.forward_host,
  forwardPort: f.forward_port,
});

/** nginx's verdict on a host after a change: loaded, or the first line of its error. */
async function loaded(c: NpmClient, id: number): Promise<string | undefined> {
  const h = await hostById(c, id);
  if (!h) return "the host is gone";
  const x = toHost(h);
  return x.online ? undefined : (x.error ?? "nginx did not load it");
}

export async function runNpm(c: NpmClient, name: string, p: StepParams): Promise<StepOutcome> {
  const op = String(p.op) as NpmOp;
  const stale = (result: string): StepOutcome => ({ ok: false, stale: true, result });

  if (op === "host-add") {
    const domain = String(p.domain);
    if (await hostByDomain(c, domain))
      return stale(`${domain} was already there; nothing changed.`);
    const certId = Number(p.certificateId ?? 0);
    const made = await c.call<{ id: number }>("POST", "/nginx/proxy-hosts", {
      domain_names: [domain],
      forward_scheme: p.forwardScheme === "https" ? "https" : "http",
      forward_host: String(p.forwardHost),
      forward_port: Number(p.forwardPort),
      certificate_id: certId,
      ssl_forced: p.sslForced === true,
      block_exploits: true,
      allow_websocket_upgrade: true,
      access_list_id: 0,
      meta: {},
      advanced_config: "",
      locations: [],
    });
    const err = await loaded(c, made.id);
    return {
      ok: !err,
      verified: !err,
      result: err
        ? `${domain} was added, but nginx did not load it: ${err}`
        : `${domain} is served, forwarding to ${String(p.forwardHost)}:${String(p.forwardPort)}.`,
    };
  }

  if (op === "cert-renew") {
    const id = Number(p.certificateId);
    await c.call("POST", `/nginx/certificates/${id}/renew`);
    const certs = await c.call<{ id: number; expires_on?: string }[]>("GET", "/nginx/certificates");
    const after = certs.find((x) => x.id === id)?.expires_on ?? "";
    const ok = after > String(p.before ?? "");
    return {
      ok,
      verified: ok,
      result: ok
        ? `Renewed: it now expires ${after.slice(0, 10)}.`
        : "NPM finished, but the expiry did not move.",
    };
  }

  const id = Number(p.hostId);
  const h = await hostById(c, id);
  if (!h) return stale(`${String(p.domain)} is no longer in ${name}.`);

  if (op === "host-enable" || op === "host-disable") {
    const on = op === "host-enable";
    if (Boolean(h.enabled) === on)
      return stale(`It was already ${on ? "on" : "off"}; nothing changed.`);
    await c.call("POST", `/nginx/proxy-hosts/${id}/${on ? "enable" : "disable"}`);
    const after = await hostById(c, id);
    const ok = Boolean(after?.enabled) === on;
    const err = on && ok ? await loaded(c, id) : undefined;
    return {
      ok: ok && !err,
      verified: ok && !err,
      result: !ok
        ? "The host did not change."
        : err
          ? `It is on, but nginx did not load it: ${err}`
          : `${String(p.domain)} is ${on ? "on" : "off"}.`,
    };
  }

  if (op === "host-forward") {
    const was = JSON.parse(String(p.body)) as {
      before: { forward_scheme: string; forward_host: string; forward_port: number };
    };
    const now = `${h.forward_scheme}://${h.forward_host}:${h.forward_port}`;
    const before = `${was.before.forward_scheme}://${was.before.forward_host}:${was.before.forward_port}`;
    if (now !== before)
      return stale(`${String(p.domain)} changed in NPM after the plan was made; nothing changed.`);
    await c.call("PUT", `/nginx/proxy-hosts/${id}`, {
      forward_scheme: p.forwardScheme === "https" ? "https" : "http",
      forward_host: String(p.forwardHost),
      forward_port: Number(p.forwardPort),
    });
    const after = await hostById(c, id);
    const want = `${p.forwardScheme === "https" ? "https" : "http"}://${String(p.forwardHost)}:${Number(p.forwardPort)}`;
    const ok = after ? toHost(after).forward === want : false;
    const err = ok ? await loaded(c, id) : undefined;
    return {
      ok: ok && !err,
      verified: ok && !err,
      result: !ok
        ? "The host does not show the new address."
        : err
          ? `Changed, but nginx did not load it: ${err}`
          : `${String(p.domain)} forwards to ${want}.`,
    };
  }

  // host-remove
  await c.call("DELETE", `/nginx/proxy-hosts/${id}`);
  const gone = !(await hostById(c, id));
  return {
    ok: gone,
    verified: gone,
    result: gone ? `${String(p.domain)} is removed.` : "The host is still there.",
  };
}
