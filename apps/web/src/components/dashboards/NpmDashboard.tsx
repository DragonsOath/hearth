import { useState } from "react";
import { ExternalLink, MessageCircle, Plus, RefreshCw } from "lucide-react";
import type { NpmDashboard as Data, NpmHost } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { useNow } from "../home/parts";
import { ApproveDialog, useApproveHere, type ApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * Nginx Proxy Manager from Hearth. The Overview answers "is every site up, and is any certificate
 * running out?": sites on, sites nginx could not load (with nginx's own error), certificates
 * expiring or expired, and the latest changes. Sites lists every proxy host with where it sends
 * visitors and its certificate, and switches one on or off, changes where it forwards, adds or
 * removes one. Certificates lists each one with its expiry and the sites using it, and renews a
 * Let's Encrypt one. A reverse proxy decides who reaches what: every change is a protected plan.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const field =
  "min-h-9 min-w-[8rem] flex-1 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink";
const KIND = "app-npm-control" as const;
const DAY = 86_400_000;

function useNpm(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "npm" ? q.data.data : undefined;
  return { q, d };
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useNpm>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="npm-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add the email and password you sign in to Nginx Proxy Manager with to Secure Vault, for
            this service.
          </p>
        )}
      </div>
    );
  return null;
}

/** "in 6 days", "expired 2 days ago": amber within two weeks, red once expired. */
function Expiry({ at, now }: { at?: string; now: number }) {
  if (!at) return <span className="text-faint">no expiry known</span>;
  const left = Date.parse(at) - now;
  const days = Math.round(Math.abs(left) / DAY);
  return (
    <span className={left < 0 ? "text-alert" : left < 14 * DAY ? "text-amber" : "text-faint"}>
      {left < 0
        ? `expired ${days} days ago`
        : days === 0
          ? "expires today"
          : `expires in ${days} days`}
    </span>
  );
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const web = keyPageHref(service, "/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Nginx Proxy Manager ${d.version} · ` : ""}live, every 30 s · Every change asks
      you to confirm it is you (it decides who reaches what). Its sites also give Hearth's Open web
      UI addresses.{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="npm-open-webui"
        >
          Open Nginx Proxy Manager <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

export function NpmDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useNpm(serviceId);
  const cave = useCave();
  const now = useNow().getTime();
  if (!d) return <Gate name={name} q={q} />;
  const on = d.hosts.filter((h) => h.enabled);
  const broken = on.filter((h) => !h.online);
  const used = d.certificates.filter((c) => c.usedBy.length && c.expires);
  const expiring = used.filter((c) => Date.parse(c.expires!) - now < 14 * DAY);
  return (
    <section
      className="@container space-y-4"
      data-testid="npm-dashboard"
      aria-label={`${name}: reading`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("sites")}
          data-hearth-target="tab:sites:open"
        >
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Sites on</p>
          <p className="stat-value text-ink tabular" data-testid="npm-on">
            {on.length}
          </p>
          <p className="text-[0.74rem] text-faint">of {d.hosts.length} proxy hosts</p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Not loading</p>
          <p
            className={cx("stat-value tabular", broken.length ? "text-alert" : "text-ink")}
            data-testid="npm-broken"
          >
            {broken.length}
          </p>
          <p className="text-[0.74rem] text-faint">nginx refused their settings</p>
        </div>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("certificates")}
          data-hearth-target="tab:certificates:open"
        >
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Certificates</p>
          <p
            className={cx("stat-value tabular", expiring.length ? "text-amber" : "text-ink")}
            data-testid="npm-expiring"
          >
            {expiring.length}
          </p>
          <p className="text-[0.74rem] text-faint">in use, expiring within 2 weeks</p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Also</p>
          <p className="stat-value text-ink tabular">
            {d.redirections.length + d.streams.length + d.deadHosts.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.redirections.length} redirections, {d.streams.length} streams, {d.deadHosts.length}{" "}
            404 hosts
          </p>
        </div>
      </div>
      {broken.length > 0 && (
        <div
          className="rounded-xl border border-alert/40 p-3 text-[0.84rem]"
          data-testid="npm-broken-list"
        >
          <p className="text-ink">
            nginx could not load these sites, so visitors do not reach them:
          </p>
          <ul className="mt-1 space-y-1">
            {broken.map((h) => (
              <li key={h.id} className="break-words">
                <span className="text-ink">{h.domains[0]}</span>
                <span className="block font-mono text-[0.74rem] text-alert">{h.error}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `In ${name}, nginx could not load ${broken.map((h) => `${h.domains[0]} (${h.error})`).join("; ")}. What is wrong and how do I fix it?`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember why
            <EmberMark />
          </button>
        </div>
      )}
      <div className="grid gap-4 @2xl:grid-cols-2">
        <div>
          <p className={eyebrow}>Certificates in use</p>
          <ul className="divide-y divide-line text-[0.84rem]">
            {used
              .slice()
              .sort((a, b) => (a.expires ?? "").localeCompare(b.expires ?? ""))
              .map((c) => (
                <li key={c.id} className="flex flex-wrap gap-x-2 py-1.5">
                  <span className="min-w-0 flex-1 break-all text-ink">{c.name}</span>
                  <span className="text-[0.76rem]">
                    <Expiry at={c.expires} now={now} />
                  </span>
                </li>
              ))}
          </ul>
        </div>
        <div>
          <p className={eyebrow}>Latest changes</p>
          <ul className="divide-y divide-line text-[0.82rem]" data-testid="npm-activity">
            {d.activity.slice(0, 6).map((a, i) => (
              <li key={i} className="flex flex-wrap gap-x-2 py-1.5">
                <span className="min-w-0 flex-1 text-ink">
                  {a.who} {a.action} {a.what}
                </span>
                <span className="text-[0.74rem] text-faint">{ago(a.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

function SiteRow({
  h,
  name,
  act,
  now,
}: {
  h: NpmHost;
  name: string;
  act: ApproveHere;
  now: number;
}) {
  const [editing, setEditing] = useState(false);
  const [scheme, setScheme] = useState(h.forwardScheme);
  const [host, setHost] = useState(h.forwardHost);
  const [port, setPort] = useState(String(h.forwardPort));
  const site = h.domains[0] ?? `host ${h.id}`;
  return (
    <li
      className="py-2"
      data-testid="npm-site"
      data-enabled={h.enabled ? "yes" : "no"}
      data-online={h.online ? "yes" : "no"}
      data-capture-item
      data-capture-label={site}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <a
            href={`${h.certificate ? "https" : "http"}://${site}`}
            target="_blank"
            rel="noreferrer"
            className="break-all text-[0.88rem] text-ink hover:text-gold"
          >
            {h.domains.join(", ")}
          </a>
          <p className="text-[0.74rem] text-faint">
            → {h.forward}
            {h.certificate ? (
              <>
                {" · "}
                {h.certificate.name}, <Expiry at={h.certificate.expires} now={now} />
                {h.sslForced ? " · https only" : ""}
              </>
            ) : (
              " · no certificate (http)"
            )}
            {h.accessList ? ` · ${h.accessList}` : ""}
            {!h.enabled && " · switched off"}
          </p>
          {!h.online && h.enabled && (
            <p className="font-mono text-[0.74rem] text-alert">{h.error}</p>
          )}
        </div>
        <label className="inline-flex items-center gap-1.5 text-[0.76rem] text-muted">
          <input
            type="checkbox"
            checked={h.enabled}
            aria-label={`${site} on`}
            data-hearth-target={`site:${h.id}:toggle`}
            onChange={() =>
              void act.propose(
                KIND,
                { op: h.enabled ? "host-disable" : "host-enable", hostId: h.id },
                `Switch ${h.enabled ? "off" : "on"} ${site} in ${name}`,
              )
            }
            className="h-4 w-4"
          />
          On
        </label>
        <button
          type="button"
          className={btn}
          onClick={() => setEditing((e) => !e)}
          data-hearth-target={`site:${h.id}:edit`}
          aria-expanded={editing}
        >
          Change
        </button>
      </div>
      {editing && (
        <form
          className="mt-2 flex flex-wrap gap-2 rounded-lg border border-line p-2.5"
          onSubmit={(e) => e.preventDefault()}
          data-testid="npm-forward-form"
        >
          <select
            value={scheme}
            onChange={(e) => setScheme(e.target.value as "http" | "https")}
            aria-label="Scheme"
            className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          >
            <option>http</option>
            <option>https</option>
          </select>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            aria-label="Forward to"
            className={field}
          />
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            aria-label="Port"
            inputMode="numeric"
            className={cx(field, "max-w-[6rem] min-w-[5rem]")}
          />
          <Button
            tone="outline"
            data-hearth-target={`site:${h.id}:forward`}
            onClick={() =>
              void act.propose(
                KIND,
                {
                  op: "host-forward",
                  hostId: h.id,
                  forwardScheme: scheme,
                  forwardHost: host.trim(),
                  forwardPort: Number(port),
                },
                `Change where ${site} forwards in ${name}`,
              )
            }
          >
            Send it there
          </Button>
          <button
            type="button"
            className={btn}
            data-hearth-target={`site:${h.id}:remove`}
            onClick={() =>
              void act.propose(
                KIND,
                { op: "host-remove", hostId: h.id },
                `Remove ${site} from ${name}`,
              )
            }
          >
            Remove the site
          </button>
        </form>
      )}
    </li>
  );
}

export function NpmSites({ serviceId, name }: AppViewProps) {
  const { q, d } = useNpm(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Nginx Proxy Manager's Sites tab.");
  const now = useNow().getTime();
  const [adding, setAdding] = useState(false);
  const [domain, setDomain] = useState("");
  const [scheme, setScheme] = useState<"http" | "https">("http");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [cert, setCert] = useState("0");
  const [find, setFind] = useState("");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const list = d.hosts.filter(
    (h) => !needle || h.domains.some((x) => x.includes(needle)) || h.forward.includes(needle),
  );
  return (
    <section className="@container space-y-3" data-testid="npm-sites" aria-label={`${name}: sites`}>
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a site or address"
          aria-label="Find a site"
          className={field}
          data-hearth-target="sites:find"
        />
        <Button
          tone="outline"
          onClick={() => setAdding((a) => !a)}
          data-hearth-target="site:add"
          aria-expanded={adding}
        >
          <Plus className="h-4 w-4" /> Add a site
        </Button>
      </div>
      {adding && (
        <form
          className="flex flex-wrap gap-2 rounded-xl border border-line p-3"
          onSubmit={(e) => e.preventDefault()}
          data-testid="npm-add-form"
        >
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="sonarr.example.com"
            aria-label="Site name"
            className={cx(field, "min-w-[12rem]")}
          />
          <select
            value={scheme}
            onChange={(e) => setScheme(e.target.value as "http" | "https")}
            aria-label="Scheme"
            className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          >
            <option>http</option>
            <option>https</option>
          </select>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.10"
            aria-label="Forward to"
            className={field}
          />
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="8989"
            aria-label="Port"
            inputMode="numeric"
            className={cx(field, "max-w-[6rem] min-w-[5rem]")}
          />
          <select
            value={cert}
            onChange={(e) => setCert(e.target.value)}
            aria-label="Certificate"
            className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          >
            <option value="0">No certificate (http only)</option>
            {d.certificates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button
            tone="primary"
            disabled={!domain.trim() || !host.trim() || !port.trim()}
            data-hearth-target="site:add:review"
            onClick={() =>
              void act
                .propose(
                  KIND,
                  {
                    op: "host-add",
                    domain: domain.trim(),
                    forwardScheme: scheme,
                    forwardHost: host.trim(),
                    forwardPort: Number(port),
                    certificateId: Number(cert),
                  },
                  `Add the site ${domain.trim()} to ${name}`,
                )
                .then(() => setAdding(false))
            }
          >
            Add it
          </Button>
          <p className="w-full text-[0.74rem] text-faint">
            With a certificate, visitors are sent to https. Getting a new certificate, access lists
            and custom nginx settings stay in Nginx Proxy Manager.
          </p>
        </form>
      )}
      <ul className="divide-y divide-line">
        {list.map((h) => (
          <SiteRow key={h.id} h={h} name={name} act={act} now={now} />
        ))}
      </ul>
      {(d.redirections.length > 0 || d.streams.length > 0) && (
        <div className="text-[0.8rem] text-muted">
          <p className={eyebrow}>Redirections and streams</p>
          <ul>
            {d.redirections.map((r) => (
              <li key={`r${r.id}`}>
                {r.domains.join(", ")} → {r.to}
                {!r.enabled && " (off)"}
              </li>
            ))}
            {d.streams.map((s) => (
              <li key={`s${s.id}`}>
                port {s.incomingPort} → {s.forward}
                {!s.enabled && " (off)"}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

export function NpmCertificates({ serviceId, name }: AppViewProps) {
  const { q, d } = useNpm(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Nginx Proxy Manager's Certificates tab.");
  const now = useNow().getTime();
  if (!d) return <Gate name={name} q={q} />;
  return (
    <section
      className="@container space-y-3"
      data-testid="npm-certificates"
      aria-label={`${name}: certificates`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <ul className="divide-y divide-line text-[0.84rem]">
        {d.certificates.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center gap-2 py-2"
            data-testid="npm-certificate"
            data-capture-item
            data-capture-label={c.name}
          >
            <div className="min-w-0 flex-1">
              <p className="break-all text-ink">{c.name}</p>
              <p className="text-[0.74rem] text-faint">
                {c.domains.join(", ")} ·{" "}
                {c.provider === "letsencrypt" ? "Let's Encrypt" : "uploaded"} ·{" "}
                <Expiry at={c.expires} now={now} />
              </p>
              <p className="text-[0.74rem] text-faint">
                {c.usedBy.length ? `Used by ${c.usedBy.join(", ")}` : "Not used by any site"}
              </p>
            </div>
            {c.provider === "letsencrypt" && (
              <button
                type="button"
                className={btn}
                data-hearth-target={`certificate:${c.id}:renew`}
                onClick={() =>
                  void act.propose(
                    KIND,
                    { op: "cert-renew", certificateId: c.id },
                    `Renew ${c.name} in ${name}`,
                  )
                }
              >
                <RefreshCw className="h-3.5 w-3.5" /> Renew now
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[0.74rem] text-faint">
        Let&apos;s Encrypt certificates renew by themselves before they expire; Renew now is for one
        that did not. Uploaded certificates and their keys are replaced in Nginx Proxy Manager.
      </p>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
