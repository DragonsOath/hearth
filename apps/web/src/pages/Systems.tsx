import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { MemoryBreakdown } from "../components/systems/MemoryBreakdown";
import { useLocation } from "react-router";
import { WithWorkspace } from "../components/WithWorkspace";
import { EmptyState, LinkButton, Meter, PageHeader, Panel, Status, Tag } from "../components/ui";
import type { Host, Workspace } from "@dragon-control/core";
import { ago, duration, pct, tb } from "../lib/format";

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.75rem] text-faint">{label}</dt>
      <dd className="mt-1 truncate text-[0.9rem] text-ink tabular">{value}</dd>
    </div>
  );
}

function RemoteHostCard({ host, serviceCount }: { host: Host; serviceCount: number }) {
  return (
    <Panel className="p-6 sm:p-8">
      <article id={host.id} aria-label={host.name} className="scroll-mt-24">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-[2rem] leading-none text-ink">{host.name}</h2>
            <p className="mt-2 text-[0.85rem] text-muted">{host.role}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Tag>Over the network</Tag>
            <Status health={host.health} />
          </div>
        </div>
        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-6 md:grid-cols-4">
          <Fact label="Address" value={host.address} />
          <Fact label="Services" value={serviceCount ? `${serviceCount}` : "None"} />
          <Fact label="Last answered" value={ago(host.lastSeenAt)} />
          <Fact label="Connected by" value="Checks over the network" />
        </dl>
        <p className="mt-5 text-[0.8rem] leading-relaxed text-faint">
          Hearth checks this machine&apos;s apps from the outside. It cannot restart them or see its
          processor, memory, or drives.
        </p>
      </article>
    </Panel>
  );
}

function HostCard({ host, serviceCount }: { host: Host; serviceCount: number }) {
  if (host.connection === "network") {
    return <RemoteHostCard host={host} serviceCount={serviceCount} />;
  }
  const mem = pct(host.memory.usedGb, host.memory.totalGb);
  return <LocalHostCard host={host} serviceCount={serviceCount} mem={mem} />;
}

function LocalHostCard({
  host,
  serviceCount,
  mem,
}: {
  host: Host;
  serviceCount: number;
  mem: number;
}) {
  // Where the memory goes, opened from the memory meter (remembered per machine).
  const key = `hearth.memory.open.${host.id}`;
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const setOpen = (v: boolean) => {
    setOpenState(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* this visit only */
    }
  };
  return (
    <Panel className="p-6 sm:p-8">
      <article id={host.id} aria-label={host.name} className="scroll-mt-24">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-[2rem] leading-none text-ink">{host.name}</h2>
            <p className="mt-2 text-[0.85rem] text-muted">
              {host.role} · {host.os}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {host.connection === "this-machine" && <Tag tone="gold">This machine</Tag>}
            <Status health={host.health} />
          </div>
        </div>

        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <div className="mb-2 flex justify-between text-[0.78rem]">
              <span className="text-faint">Processor</span>
              <span className="text-muted tabular">{host.cpu.usagePct}%</span>
            </div>
            <Meter value={host.cpu.usagePct} label={`${host.name} processor`} />
          </div>
          <div>
            <div className="mb-2 flex justify-between text-[0.78rem]">
              <span className="text-faint">Memory</span>
              <span className="text-muted tabular">
                {host.memory.usedGb.toFixed(1)} of {host.memory.totalGb.toFixed(1)} GB
              </span>
            </div>
            <Meter value={mem} label={`${host.name} memory`} />
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="mt-2 inline-flex min-h-9 items-center gap-1 text-[0.8rem] text-gold hover:underline"
              data-testid="memory-open"
            >
              What&apos;s using memory
              <ChevronDown
                strokeWidth={1.5}
                className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
              />
            </button>
          </div>
        </div>
        {open && (
          <div className="mt-6 border-t border-line pt-6">
            <MemoryBreakdown name={host.name} pcId={host.pcId} />
          </div>
        )}

        <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-t border-line pt-6 md:grid-cols-4">
          <Fact label="Address" value={host.address} />
          <Fact label="Up for" value={duration(host.uptimeHours)} />
          <Fact label="Services" value={serviceCount ? `${serviceCount}` : "None"} />
          <Fact label="Last report" value={ago(host.lastSeenAt)} />
          <Fact label="Processor" value={`${host.cpu.cores} threads`} />
          <Fact label="Docker" value={host.docker ? "Available" : "Not installed"} />
          <Fact
            label="Connected by"
            value={host.connection === "this-machine" ? "Local access" : "Hearth agent"}
          />
          <Fact label="Storage" value={tb(host.volumes.reduce((s, v) => s + v.totalTb, 0))} />
        </dl>
      </article>
    </Panel>
  );
}

function SystemsContent({ ws }: { ws: Workspace }) {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash]);
  const attention = ws.hosts.filter((h) => h.health !== "healthy").length;
  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="Your machines"
        subtitle={
          attention
            ? `${ws.hosts.length} systems. ${attention} needs a look.`
            : `${ws.hosts.length} ${ws.hosts.length === 1 ? "system" : "systems"}, all reporting normally.${
                ws.discoveredAt ? ` Last discovered ${ago(ws.discoveredAt).toLowerCase()}.` : ""
              }`
        }
        actions={
          <LinkButton to="/discover">
            {ws.environment === "real" ? "Scan again" : "Discover this machine"}
          </LinkButton>
        }
      />
      <div className="space-y-6">
        {ws.hosts.map((host) => (
          <HostCard
            key={host.id}
            host={host}
            serviceCount={ws.services.filter((s) => s.hostId === host.id).length}
          />
        ))}
      </div>
      {ws.hosts.length === 1 && (
        <div className="mt-6">
          <EmptyState title="Add another machine">
            Watch apps on another computer, such as Plex on a Windows PC, by its network address.
            Nothing is installed there. Use <strong className="text-ink">Scan again</strong> above,
            then Another machine.
          </EmptyState>
        </div>
      )}
    </>
  );
}

export function SystemsPage() {
  return <WithWorkspace>{(ws) => <SystemsContent ws={ws} />}</WithWorkspace>;
}
