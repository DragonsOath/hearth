import { useState } from "react";
import { ExternalLink, MessageCircle } from "lucide-react";
import type { TraefikDashboard as Data, TraefikRouter } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { keyPageHref } from "../../lib/keyPage";
import { useNow } from "../home/parts";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { EmberMark } from "../ember/EmberMark";

/**
 * Traefik from Hearth, read from its own API. The Overview answers "does every site reach its
 * app?": routers Traefik refused (with its own error), apps behind a router it sees down, and
 * certificates running out. Routers lists every one with the names it answers, where it sends
 * them, TLS and middlewares. Certificates lists each with its expiry. Traefik is set up in its
 * files and container labels, not through its API: Ember can explain a fix, and a change to those
 * files goes through host administration as a protected plan.
 */

const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const DAY = 86_400_000;

function useTraefik(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "traefik" ? q.data.data : undefined;
  return { q, d };
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useTraefik>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="tr-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  return null;
}

function Expiry({ at, now }: { at: string; now: number }) {
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
  const web = keyPageHref(service, "/dashboard/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Traefik ${d.version} · ` : ""}
      {d.providers.length ? `routes from ${d.providers.join(", ")} · ` : ""}live, every 30 s · Read
      only: Traefik is set up in its files and container labels. Its routers also give Hearth&apos;s
      Open web UI addresses.{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="tr-open-webui"
        >
          Open Traefik&apos;s dashboard <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

const down = (r: TraefikRouter) => r.servers.length > 0 && r.servers.every((s) => s.up === false);

export function TraefikDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useTraefik(serviceId);
  const cave = useCave();
  const now = useNow().getTime();
  if (!d) return <Gate name={name} q={q} />;
  const refused = d.routers.filter((r) => r.status === "disabled");
  const appsDown = d.routers.filter(down);
  const expiring = d.certificates.filter((c) => Date.parse(c.expires) - now < 14 * DAY);
  const problems = [
    ...refused.map((r) => `${r.hosts[0] ?? r.name} refused: ${r.errors.join("; ")}`),
    ...appsDown.map(
      (r) =>
        `${r.hosts[0] ?? r.name}: its app at ${r.servers.map((s) => s.url).join(", ")} is down`,
    ),
  ];
  return (
    <section
      className="@container space-y-4"
      data-testid="tr-dashboard"
      aria-label={`${name}: reading`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("routers")}
          data-hearth-target="tab:routers:open"
        >
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Routers</p>
          <p className="stat-value text-ink tabular" data-testid="tr-routers">
            {d.counts.routers}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.routers.filter((r) => r.tls).length} with https
          </p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Refused</p>
          <p
            className={cx("stat-value tabular", refused.length ? "text-alert" : "text-ink")}
            data-testid="tr-refused"
          >
            {refused.length}
          </p>
          <p className="text-[0.74rem] text-faint">routers Traefik will not use</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Apps down</p>
          <p
            className={cx("stat-value tabular", appsDown.length ? "text-amber" : "text-ink")}
            data-testid="tr-down"
          >
            {appsDown.length}
          </p>
          <p className="text-[0.74rem] text-faint">behind a router</p>
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
            data-testid="tr-expiring"
          >
            {expiring.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            expiring within 2 weeks, of {d.certificates.length}
          </p>
        </button>
      </div>
      {problems.length > 0 && (
        <div
          className="rounded-xl border border-alert/40 p-3 text-[0.84rem]"
          data-testid="tr-problems"
        >
          <ul className="space-y-1">
            {refused.map((r) => (
              <li key={r.name} className="break-words">
                <span className="text-ink">{r.hosts[0] ?? r.name}</span> is refused
                <span className="block font-mono text-[0.74rem] text-alert">
                  {r.errors.join("; ")}
                </span>
              </li>
            ))}
            {appsDown.map((r) => (
              <li key={r.name} className="break-words">
                <span className="text-ink">{r.hosts[0] ?? r.name}</span>
                <span className="text-amber">
                  : Traefik sees its app ({r.servers.map((s) => s.url).join(", ")}) down
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `In ${name}: ${problems.join("; ")}. What is wrong, and what do I change in Traefik's files or labels to fix it?`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember how to fix it
            <EmberMark />
          </button>
        </div>
      )}
      <div>
        <p className={eyebrow}>Entry points</p>
        <p className="text-[0.82rem] text-muted">
          {d.entryPoints.map((e) => `${e.name} (${e.address})`).join(", ") || "none read"}
        </p>
      </div>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

export function TraefikRouters({ serviceId, name }: AppViewProps) {
  const { q, d } = useTraefik(serviceId);
  const [find, setFind] = useState("");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const list = d.routers.filter(
    (r) =>
      !needle ||
      r.name.toLowerCase().includes(needle) ||
      r.rule.toLowerCase().includes(needle) ||
      r.servers.some((s) => s.url.includes(needle)),
  );
  return (
    <section
      className="@container space-y-3"
      data-testid="tr-routers-tab"
      aria-label={`${name}: routers`}
    >
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Find a site, router or address"
        aria-label="Find a router"
        className="min-h-9 w-full rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
        data-hearth-target="routers:find"
      />
      <ul className="divide-y divide-line text-[0.84rem]">
        {list.map((r) => (
          <li
            key={r.name}
            className="py-2"
            data-testid="tr-router"
            data-status={r.status}
            data-capture-item
            data-capture-label={r.hosts[0] ?? r.name}
          >
            <div className="flex flex-wrap items-baseline gap-x-2">
              {r.hosts[0] ? (
                <a
                  href={`${r.tls ? "https" : "http"}://${r.hosts[0]}`}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all text-ink hover:text-gold"
                >
                  {r.hosts.join(", ")}
                </a>
              ) : (
                <span className="font-mono text-[0.8rem] text-ink">{r.rule}</span>
              )}
              <span className="text-[0.74rem] text-faint">{r.name}</span>
            </div>
            <p className="text-[0.74rem] text-faint">
              →{" "}
              {r.servers.length
                ? r.servers.map((s) => (
                    <span key={s.url} className={s.up === false ? "text-amber" : undefined}>
                      {s.url}
                      {s.up === false ? " (down) " : " "}
                    </span>
                  ))
                : `${r.service} `}
              · {r.entryPoints.join(", ")}
              {r.tls ? " · https" : ""}
              {r.middlewares.length ? ` · ${r.middlewares.join(", ")}` : ""}
            </p>
            {r.errors.length > 0 && (
              <p className="font-mono text-[0.74rem] text-alert">{r.errors.join("; ")}</p>
            )}
          </li>
        ))}
      </ul>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

export function TraefikCertificates({ serviceId, name }: AppViewProps) {
  const { q, d } = useTraefik(serviceId);
  const now = useNow().getTime();
  if (!d) return <Gate name={name} q={q} />;
  return (
    <section
      className="@container space-y-3"
      data-testid="tr-certificates"
      aria-label={`${name}: certificates`}
    >
      <ul className="divide-y divide-line text-[0.84rem]">
        {d.certificates
          .slice()
          .sort((a, b) => a.expires.localeCompare(b.expires))
          .map((c, i) => (
            <li key={i} className="flex flex-wrap gap-x-2 py-1.5" data-testid="tr-certificate">
              <span className="min-w-0 flex-1 break-all text-ink">{c.names.join(", ")}</span>
              <span className="text-[0.76rem]">
                <span className="text-faint">{c.issuer} · </span>
                <Expiry at={c.expires} now={now} />
              </span>
            </li>
          ))}
      </ul>
      {!d.certificates.length && (
        <p className="text-[0.82rem] text-faint">No certificates loaded.</p>
      )}
      <p className="text-[0.74rem] text-faint">
        Let&apos;s Encrypt certificates renew by themselves before they expire; one that does not
        usually means its challenge fails (Ask Ember).
      </p>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
