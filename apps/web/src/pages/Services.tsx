import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Search } from "lucide-react";
import { WithWorkspace } from "../components/WithWorkspace";
import {
  EmptyState,
  Monogram,
  OpenLink,
  PageHeader,
  RowLink,
  Rows,
  Section,
  Segmented,
  ServiceStatus,
} from "../components/ui";
import type { Service, Workspace } from "@dragon-control/core";
import { publicHref } from "../lib/format";
import { useOpenTarget } from "../components/command/ServiceLogo";
import { AddSystem } from "../components/systems/ManageSystems";

type Filter = "all" | "attention";

function ServiceRow({ service, hostName }: { service: Service; hostName: string }) {
  const target = useOpenTarget(service);
  return (
    <RowLink
      to={`/services/${service.id}`}
      label={service.name}
      trailing={
        target ? (
          <OpenLink href={target.href} label={target.label} />
        ) : (
          <span className="w-11 shrink-0" aria-hidden="true" />
        )
      }
    >
      <Monogram name={service.name} image={service.image} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[0.95rem] text-ink">{service.name}</p>
        <p className="truncate text-[0.8rem] text-faint">
          {service.note ??
            (publicHref(service.publicUrl) ? (
              <span className="text-gold/80">{service.publicUrl}</span>
            ) : (
              hostName
            ))}
        </p>
      </div>
      <span className="hidden w-20 text-right text-[0.8rem] text-faint tabular sm:block">
        {service.responseMs ? `${service.responseMs} ms` : ""}
      </span>
      <span className="w-auto sm:w-36 sm:text-right">
        <ServiceStatus service={{ health: service.health, stopped: service.stopped }} />
      </span>
    </RowLink>
  );
}

function ServicesContent({ ws }: { ws: Workspace }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const hostNames = Object.fromEntries(ws.hosts.map((h) => [h.id, h.name]));
  // Stopped on request is off on purpose, not something that needs attention.
  const needsLook = (s: Service) => s.health !== "healthy" && !s.stopped;
  const attentionCount = ws.services.filter(needsLook).length;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = ws.services.filter(
      (s) =>
        (filter === "all" || needsLook(s)) &&
        (!q || s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q)),
    );
    const byCategory = new Map<string, Service[]>();
    for (const s of visible) byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s]);
    return [...byCategory.entries()];
  }, [ws.services, filter, query]);

  if (ws.services.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Services" title="Services" actions={<AddSystem ws={ws} />} />
        <EmptyState title="No services yet">
          Once discovery runs, everything Hearth finds on your machines appears here.
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Services"
        title="Services"
        subtitle={
          attentionCount
            ? `${ws.services.length} services. ${attentionCount} ${attentionCount === 1 ? "needs" : "need"} attention.`
            : `All ${ws.services.length} services are healthy.`
        }
        actions={<AddSystem ws={ws} />}
      />

      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          label="Filter services"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: ws.services.length },
            { value: "attention", label: "Needs attention", count: attentionCount },
          ]}
        />
        <label className="flex min-h-11 items-center gap-2 rounded-full border border-line px-4 focus-within:border-gold/50 sm:w-64">
          <Search strokeWidth={1.25} className="h-4 w-4 text-faint" />
          <span className="sr-only">Search services</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-transparent text-[0.85rem] text-ink placeholder:text-faint focus:outline-none"
          />
        </label>
      </div>

      {groups.length === 0 ? (
        <EmptyState title={filter === "attention" && !query ? "All quiet" : "No matches"}>
          {filter === "attention" && !query
            ? "Every service is healthy."
            : "Try a different name or category."}
        </EmptyState>
      ) : (
        groups.map(([category, services]) => (
          <Section key={category} title={`${category} · ${services.length}`}>
            <Rows>
              {services.map((s) => (
                <ServiceRow key={s.id} service={s} hostName={hostNames[s.hostId] ?? "Unknown"} />
              ))}
            </Rows>
          </Section>
        ))
      )}

      {ws.inactiveServices.length > 0 && (
        <Section title={`Not watched · ${ws.inactiveServices.length}`}>
          <ul className="divide-y divide-line" data-testid="not-watched">
            {ws.inactiveServices.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/services/${s.id}`}
                  className="group flex flex-col gap-1 py-4 sm:flex-row sm:items-baseline sm:gap-4"
                >
                  <span className="text-[0.95rem] text-ink group-hover:text-gold sm:w-48">
                    {s.name}
                  </span>
                  <span className="text-[0.78rem] tracking-wide text-faint sm:w-20">
                    {s.lifecycle === "retired" ? "Retired" : "Paused"}
                  </span>
                  <span className="flex-1 text-[0.85rem] text-muted">{s.lifecycleNote ?? ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

export function ServicesPage() {
  return <WithWorkspace>{(ws) => <ServicesContent ws={ws} />}</WithWorkspace>;
}
