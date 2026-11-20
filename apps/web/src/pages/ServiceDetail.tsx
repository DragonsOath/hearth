import { Link, useNavigate, useParams } from "react-router";
import { ChevronLeft } from "lucide-react";
import { WithWorkspace } from "../components/WithWorkspace";
import {
  Button,
  EmptyState,
  OpenLink,
  Panel,
  RowLink,
  Rows,
  Section,
  Status,
  StatusDot,
  Tag,
  ServiceStatus,
} from "../components/ui";
import { autonomyLabels } from "./Autonomy";
import type { AppReport, Health, Service, Workspace } from "@dragon-control/core";
import { ago, publicHref } from "../lib/format";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../data/api";
import {
  useCheckApp,
  useRunChecks,
  useServiceLifecycle,
  useSimulate,
  type PracticeCondition,
} from "../data/api";
import { RecentActions, ServiceActions } from "./ServiceActions";
import { ServiceLogo } from "../components/command/ServiceLogo";
import { RemoveSystem } from "../components/systems/ManageSystems";

export function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <Link
      to={to}
      className="-ml-1 mb-8 inline-flex min-h-11 items-center gap-1 text-[0.82rem] text-muted transition-colors hover:text-gold"
    >
      <ChevronLeft strokeWidth={1.25} className="h-4 w-4" />
      {children}
    </Link>
  );
}

const checkTone = { ok: "healthy", slow: "attention", failing: "offline" } as const;

export function LastCheck({ service }: { service: Service }) {
  const c = service.lastCheck;
  if (!c)
    return (
      <p className="text-[0.85rem] text-muted">Not checked yet. The first check runs shortly.</p>
    );
  return (
    <div data-testid="last-check">
      <p className="flex items-start gap-2 text-[0.88rem] leading-relaxed text-ink">
        <StatusDot health={checkTone[c.status]} className="mt-2" />
        <span>
          {service.name} {c.detail}.
        </span>
      </p>
      <p className="mt-1 pl-3.5 text-[0.75rem] text-faint">
        Checked {ago(c.at).toLowerCase()}
        {c.status === "failing" && c.consecutiveFailures > 0
          ? ` · failed ${c.consecutiveFailures} ${c.consecutiveFailures === 1 ? "time" : "times"} in a row`
          : ""}
      </p>
    </div>
  );
}

function Practice({
  service,
  simulated,
  threshold,
}: {
  service: Service;
  simulated: boolean;
  threshold: number;
}) {
  const sim = useSimulate();
  const run = useRunChecks();
  const set = (condition: PracticeCondition) =>
    sim.mutate(
      { serviceId: service.id, condition },
      // Breaking a dependency affects two services, so check everything.
      { onSuccess: () => run.mutate(condition === "upstream" ? undefined : service.id) },
    );
  return (
    <Panel className="border-dashed p-6">
      <p className="eyebrow mb-2">Practice</p>
      <p className="mb-4 text-[0.8rem] leading-relaxed text-muted">
        Sample data only. Make {service.name} fail and watch Hearth notice, confirm, and respond as
        its autonomy allows ({autonomyLabels[service.autonomy].title}).{" "}
        {threshold === 1
          ? "An incident opens on the first failed check."
          : `It takes ${threshold} failed checks in a row to open an incident.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => set("down")} disabled={sim.isPending}>
          Make it fail
        </Button>
        <Button onClick={() => set("stuck")} disabled={sim.isPending}>
          Fail so a restart won't help
        </Button>
        <Button onClick={() => set("slow")} disabled={sim.isPending}>
          Slow it down
        </Button>
        {service.dependsOn.length > 0 && (
          <Button onClick={() => set("upstream")} disabled={sim.isPending}>
            Break what it depends on
          </Button>
        )}
        {simulated && (
          <Button tone="quiet" onClick={() => set("normal")} disabled={sim.isPending}>
            Back to normal
          </Button>
        )}
      </div>
    </Panel>
  );
}

const APP_STATUS: Record<AppReport["status"], { label: string; health: Health }> = {
  ok: { label: "No problems reported", health: "healthy" },
  attention: { label: "Worth a look", health: "attention" },
  failing: { label: "Problems inside the app", health: "offline" },
  unreachable: { label: "Could not be read", health: "attention" },
  "needs-key": { label: "Needs its API key", health: "attention" },
};

/** What Hearth read inside the app itself (M9), read only. */
export function InsideTheApp({ report, name }: { report: AppReport; name: string }) {
  const check = useCheckApp();
  const status = APP_STATUS[report.status];
  return (
    <Section title={`Inside ${name}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3" data-testid="app-health">
        <Status health={status.health} label={status.label} />
        <span className="text-[0.8rem] text-faint">read {ago(report.checkedAt)}</span>
      </div>
      {report.detail && (
        <p className="mb-4 text-[0.88rem] leading-relaxed text-muted">{report.detail}</p>
      )}
      {report.issues.length > 0 && (
        <ul className="mb-4 space-y-2" aria-label="Problems reported">
          {report.issues.map((issue) => (
            <li key={issue.key} className="flex gap-3 text-[0.9rem] leading-relaxed text-ink">
              <StatusDot health={issue.level === "error" ? "offline" : "attention"} />
              <span>
                {issue.text}
                {issue.link && (
                  <>
                    {" "}
                    <a
                      href={issue.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-gold underline decoration-gold/40 underline-offset-2 hover:text-gold-bright"
                    >
                      Help
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <dl className="divide-y divide-line">
        {report.version && <Fact label="Version" value={report.version} mono />}
        {report.facts.map((f) => (
          <Fact key={f.label} label={f.label} value={f.value} mono />
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={check.isPending} onClick={() => check.mutate(report.serviceId)}>
          {check.isPending ? "Reading" : "Read it now"}
        </Button>
        <span className="text-[0.78rem] text-faint">
          Read only. Problems inside the app are never answered with a restart.
        </span>
      </div>
    </Section>
  );
}

export function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 py-3">
      <dt className="text-[0.85rem] text-faint">{label}</dt>
      <dd className={`truncate text-right text-[0.88rem] text-ink ${mono ? "tabular" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function AddressRow({
  label,
  via,
  address,
  href,
  serviceName,
}: {
  label: string;
  via?: { id: string; name: string };
  address: string;
  href?: string;
  serviceName: string;
}) {
  return (
    <li className="flex min-h-16 items-center gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[0.78rem] text-faint">
          {label}
          {via && (
            <>
              {" · via "}
              <Link
                to={`/services/${via.id}`}
                className="text-muted underline decoration-line-strong underline-offset-4 hover:text-gold hover:decoration-gold"
              >
                {via.name}
              </Link>
            </>
          )}
        </p>
        <p className="mt-0.5 truncate text-[0.95rem] text-ink tabular">{address}</p>
      </div>
      {href && (
        <OpenLink
          href={href}
          label={`Open ${serviceName} at ${address}`}
          className="border border-line-strong px-4 text-[0.82rem] text-ink hover:border-gold"
        >
          Open
        </OpenLink>
      )}
    </li>
  );
}

/**
 * The address through your reverse proxy ("radarr.example.com"), set or changed by hand when
 * Hearth did not find it in the proxy. Only Hearth's record changes; the proxy is not touched.
 */
function ProxyAddressEditor({ service }: { service: Service }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(service.publicUrl ?? "");
  const [error, setError] = useState<string>();
  const save = async (next: string | null) => {
    setError(undefined);
    try {
      await api("PUT", `/api/services/${encodeURIComponent(service.id)}/web-address`, {
        publicUrl: next ? next.replace(/^https?:\/\//, "").replace(/\/+$/, "") : null,
      });
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ["workspace"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (!editing)
    return (
      <li className="flex flex-wrap items-center gap-2 py-3 text-[0.82rem]">
        <span className="min-w-0 flex-1 text-muted">
          {service.publicUrl
            ? "Wrong address? Change it here."
            : "Reached through your reverse proxy? Add its address so Open goes there."}
        </span>
        <button
          type="button"
          className="text-gold hover:underline"
          onClick={() => {
            setValue(service.publicUrl ?? "");
            setEditing(true);
          }}
          data-testid="proxy-address-edit"
        >
          {service.publicUrl ? "Change address" : "Add proxy address"}
        </button>
      </li>
    );
  return (
    <li className="py-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save(value.trim() || null);
        }}
      >
        <label className="sr-only" htmlFor={`proxy-${service.id}`}>
          Address through your reverse proxy
        </label>
        <input
          id={`proxy-${service.id}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Proxy address"
          autoFocus
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line-strong bg-raised px-3 text-[0.88rem] text-ink"
          data-testid="proxy-address-input"
        />
        <button
          type="submit"
          className="min-h-10 rounded-lg border border-gold px-3 text-[0.84rem] text-gold"
          data-testid="proxy-address-save"
        >
          Save
        </button>
        {service.publicUrl && (
          <button
            type="button"
            className="min-h-10 px-2 text-[0.84rem] text-muted hover:text-ink"
            onClick={() => void save(null)}
            data-testid="proxy-address-remove"
          >
            Remove
          </button>
        )}
        <button
          type="button"
          className="min-h-10 px-2 text-[0.84rem] text-muted hover:text-ink"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </form>
      {error && <p className="mt-1 text-[0.8rem] text-amber">{error}</p>}
    </li>
  );
}

function Addresses({ service, ws }: { service: Service; ws: Workspace }) {
  const proxy = ws.services.find((s) => s.id === service.proxyServiceId);
  if (!service.publicUrl && !service.localUrl) {
    return (
      <Section title="Addresses">
        <p className="py-2 text-[0.9rem] text-muted">
          No web address. Other services talk to {service.name} directly; there is nothing to open
          in a browser.
        </p>
        <ul>
          <ProxyAddressEditor service={service} />
        </ul>
      </Section>
    );
  }
  return (
    <Section title="Addresses">
      <ul className="divide-y divide-line">
        {service.publicUrl && (
          <AddressRow
            label={publicHref(service.publicUrl) ? "Public" : "Publishes"}
            via={proxy ? { id: proxy.id, name: proxy.name } : undefined}
            address={service.publicUrl}
            href={publicHref(service.publicUrl)}
            serviceName={service.name}
          />
        )}
        {service.localUrl && (
          <AddressRow
            label="On your network"
            address={service.localUrl.replace(/^https?:\/\//, "")}
            href={service.localUrl}
            serviceName={service.name}
          />
        )}
        <ProxyAddressEditor service={service} />
      </ul>
    </Section>
  );
}

/**
 * Whether Hearth watches this service. Off on purpose is not a
 * failure: paused or retired services are never checked or restarted.
 */
export function Watching({ service }: { service: Service }) {
  const save = useServiceLifecycle();
  const [choice, setChoice] = useState<"paused" | "retired" | null>(null);
  const [note, setNote] = useState("");
  if (service.lifecycle) {
    return (
      <div data-testid="lifecycle">
        <p className="text-[0.9rem] text-ink">
          {service.lifecycle === "retired" ? "Retired" : "Paused"}
          {service.lifecycleAt ? ` ${ago(service.lifecycleAt).toLowerCase()}` : ""}
        </p>
        <p className="mt-1 text-[0.82rem] leading-relaxed text-muted">
          {service.lifecycleNote ??
            (service.lifecycle === "retired"
              ? "Replaced or removed; kept for history."
              : "Off on purpose for now.")}{" "}
          Hearth does not check it or start it again.
        </p>
        <Button
          className="mt-4"
          disabled={save.isPending}
          onClick={() => save.mutate({ id: service.id, lifecycle: "active" })}
        >
          Watch it again
        </Button>
      </div>
    );
  }
  return (
    <div data-testid="lifecycle">
      <p className="text-[0.82rem] leading-relaxed text-muted">
        Turned it off on purpose? Tell Hearth, so it is not treated as a failure.
      </p>
      {choice ? (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { id: service.id, lifecycle: choice, note },
              { onSuccess: () => setChoice(null) },
            );
          }}
        >
          <label htmlFor="lifecycle-note" className="mb-2 block text-[0.82rem] text-muted">
            {choice === "retired" ? "What replaced it, or why it went" : "Why it is off (optional)"}
          </label>
          <input
            id="lifecycle-note"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reason (optional)"
            className="min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="submit" tone="primary" disabled={save.isPending}>
              {choice === "retired" ? "Retire it" : "Pause watching"}
            </Button>
            <Button tone="quiet" onClick={() => setChoice(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => setChoice("paused")}>Pause watching</Button>
          <Button tone="quiet" onClick={() => setChoice("retired")}>
            Retire
          </Button>
        </div>
      )}
    </div>
  );
}

function ServiceDetailContent({ ws, id }: { ws: Workspace; id: string }) {
  const navigate = useNavigate();
  const service =
    ws.services.find((s) => s.id === id) ?? ws.inactiveServices.find((s) => s.id === id);
  if (!service) {
    return (
      <>
        <BackLink to="/services">Services</BackLink>
        <EmptyState title="Service not found">It may have been removed or renamed.</EmptyState>
      </>
    );
  }
  const host = ws.hosts.find((h) => h.id === service.hostId);
  const dependsOn = ws.services.filter((s) => service.dependsOn.includes(s.id));
  const usedBy = ws.services.filter((s) => s.dependsOn.includes(service.id));
  const incidents = ws.incidents.filter((i) => i.serviceId === service.id);
  const appReport = ws.apps.find((r) => r.serviceId === service.id);

  return (
    <>
      <BackLink to="/services">Services</BackLink>
      <header className="mb-12 flex items-start gap-5">
        <ServiceLogo service={service} className="h-14 w-14 text-[1.35rem]" />
        <div className="min-w-0">
          <h1 className="font-display text-[2.4rem] leading-none text-ink sm:text-[3rem]">
            {service.name}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <ServiceStatus service={service} />
            <Tag>{service.category}</Tag>
          </div>
        </div>
      </header>

      <div className="grid gap-12 lg:grid-cols-[1fr_300px]">
        <div>
          <Addresses service={service} ws={ws} />

          <Section title="Details">
            <dl className="divide-y divide-line">
              <Fact label="Runs on" value={host?.name ?? "Unknown"} />
              <Fact label="Version" value={service.version ?? "Unknown"} mono />
              {service.image && <Fact label="Image" value={service.image} mono />}
              {service.responseMs && (
                <Fact label="Response time" value={`${service.responseMs} ms`} mono />
              )}
              <Fact
                label="Availability, 30 days"
                value={
                  service.uptimePct === undefined ? "Measuring" : `${service.uptimePct.toFixed(1)}%`
                }
                mono
              />
              <Fact label="Autonomy" value={autonomyLabels[service.autonomy].title} />
            </dl>
          </Section>

          {(dependsOn.length > 0 || usedBy.length > 0) && (
            <Section title="Relationships">
              <Rows>
                {dependsOn.map((d) => (
                  <RowLink key={d.id} to={`/services/${d.id}`} label={`Depends on ${d.name}`}>
                    <StatusDot health={d.health} />
                    <span className="flex-1 text-[0.9rem] text-ink">{d.name}</span>
                    <span className="text-[0.78rem] text-faint">Depends on</span>
                  </RowLink>
                ))}
                {usedBy.map((d) => (
                  <RowLink key={d.id} to={`/services/${d.id}`} label={`Used by ${d.name}`}>
                    <StatusDot health={d.health} />
                    <span className="flex-1 text-[0.9rem] text-ink">{d.name}</span>
                    <span className="text-[0.78rem] text-faint">Used by</span>
                  </RowLink>
                ))}
              </Rows>
            </Section>
          )}

          {appReport && <InsideTheApp report={appReport} name={service.name} />}

          <RecentActions service={service} ws={ws} />

          <Section title="Incidents">
            {incidents.length === 0 ? (
              <p className="py-2 text-[0.9rem] text-muted">No incidents on record.</p>
            ) : (
              <Rows>
                {incidents.map((i) => (
                  <RowLink key={i.id} to={`/incidents/${i.id}`} label={i.title}>
                    <StatusDot health={i.status === "resolved" ? "healthy" : "attention"} />
                    <span className="flex-1 text-[0.9rem] text-ink">{i.title}</span>
                    <span className="text-[0.78rem] text-faint">{ago(i.openedAt)}</span>
                  </RowLink>
                ))}
              </Rows>
            )}
          </Section>
        </div>

        <aside className="space-y-4">
          <Panel className="p-6">
            <p className="eyebrow mb-4">Monitoring</p>
            {!service.lifecycle && <LastCheck service={service} />}
            <ServiceActions service={service} ws={ws} />
          </Panel>
          <Panel className="p-6">
            <p className="eyebrow mb-4">Watching</p>
            <Watching service={service} />
          </Panel>
          <Panel className="p-6">
            <p className="eyebrow mb-4">Remove</p>
            <RemoveSystem service={service} onRemoved={() => navigate("/services")} />
          </Panel>
          {ws.environment === "demo" && (
            <Practice
              service={service}
              simulated={ws.monitoring.simulated.includes(service.id)}
              threshold={ws.monitoring.failureThreshold}
            />
          )}
        </aside>
      </div>
    </>
  );
}

export function ServiceDetailPage() {
  const { id = "" } = useParams();
  return <WithWorkspace>{(ws) => <ServiceDetailContent ws={ws} id={id} />}</WithWorkspace>;
}
