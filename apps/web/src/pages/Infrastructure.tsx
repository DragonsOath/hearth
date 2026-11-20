import { useState } from "react";
import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import type { Workspace } from "@dragon-control/core";
import { WithWorkspace } from "../components/WithWorkspace";
import { EmptyState, PageHeader, RowLink, Rows, Section, Segmented, cx } from "../components/ui";
import { serviceDot } from "../components/shell/Sidebar";
import { useAudit } from "../data/api";
import { ago, publicHref } from "../lib/format";
import { BackupsSection } from "./BackupsSection";

/**
 * Sidebar destinations that gather what Hearth already knows into
 * one view each: Docker (containers by machine), Network (addresses and
 * routes), Backups, and Logs (changes and activity). Read only.
 */

function DockerContent({ ws }: { ws: Workspace }) {
  const all = [...ws.services, ...ws.inactiveServices].filter((s) => s.kind === "container");
  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="Docker"
        subtitle="Containers Hearth watches, by machine. Open one to see its health, logs, and history beside Ember."
      />
      {ws.hosts.map((h) => {
        const mine = all
          .filter((s) => s.hostId === h.id)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!mine.length) return null;
        return (
          <Section key={h.id} title={`${h.name} · ${mine.length} containers`}>
            <Rows>
              {mine.map((s) => {
                const dot = serviceDot(s);
                return (
                  <RowLink key={s.id} to={`/?service=${encodeURIComponent(s.id)}`} label={s.name}>
                    <span
                      className={cx("h-2 w-2 shrink-0 rounded-full", dot.className)}
                      aria-label={dot.label}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[0.92rem] text-ink">{s.name}</p>
                      <p className="truncate font-mono text-[0.74rem] text-faint">
                        {s.container ?? "container not known"} · {s.image ?? "image not known"}
                      </p>
                    </div>
                    <span className="hidden text-[0.78rem] text-faint sm:block">
                      {s.lifecycle ? (s.lifecycle === "paused" ? "Paused" : "Retired") : dot.label}
                    </span>
                  </RowLink>
                );
              })}
            </Rows>
          </Section>
        );
      })}
      {!all.length && (
        <EmptyState title="No containers yet">
          Discover a machine to see its containers here.
        </EmptyState>
      )}
    </>
  );
}

function NetworkContent({ ws }: { ws: Workspace }) {
  const services = [...ws.services]
    .filter((s) => s.localUrl || s.publicUrl)
    .sort((a, b) => a.name.localeCompare(b.name));
  const names = new Map(ws.services.map((s) => [s.id, s.name]));
  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="Network"
        subtitle="Machines, the addresses services answer on, and which reverse proxy publishes them, as Hearth found them."
      />
      <Section title="Machines">
        <Rows>
          {ws.hosts.map((h) => (
            <RowLink key={h.id} to={`/systems#${h.id}`} label={h.name}>
              <span
                className={cx(
                  "h-2 w-2 rounded-full",
                  h.health === "healthy"
                    ? "bg-live"
                    : h.health === "attention"
                      ? "bg-amber"
                      : "bg-alert",
                )}
              />
              <span className="flex-1 text-[0.92rem] text-ink">{h.name}</span>
              <span className="font-mono text-[0.78rem] text-faint">{h.address}</span>
              <span className="hidden text-[0.78rem] text-faint sm:block">
                {h.connection === "this-machine"
                  ? "This machine"
                  : h.connection === "network"
                    ? "Checked over the network"
                    : "Agent"}
              </span>
            </RowLink>
          ))}
        </Rows>
      </Section>
      <Section title={`Addresses · ${services.length}`}>
        {/* On a phone each service is a small card, so nothing scrolls sideways (11-13). */}
        <div className="sm:overflow-x-auto">
          <table className="block w-full text-left text-[0.86rem] sm:table">
            <thead className="hidden text-[0.74rem] tracking-wide text-faint uppercase sm:table-header-group">
              <tr>
                <th className="py-2 pr-4 font-normal">Service</th>
                <th className="py-2 pr-4 font-normal">On the network</th>
                <th className="py-2 pr-4 font-normal">Public address</th>
                <th className="py-2 font-normal">Through</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-line sm:table-row-group">
              {services.map((s) => {
                const pub = publicHref(s.publicUrl);
                return (
                  <tr key={s.id} className="block py-2.5 sm:table-row sm:py-0">
                    <td className="block pr-4 sm:table-cell sm:py-2.5">
                      <Link
                        to={`/?service=${encodeURIComponent(s.id)}`}
                        className="text-ink hover:text-gold"
                      >
                        {s.name}
                      </Link>
                    </td>
                    <td className="block pr-4 font-mono text-[0.78rem] break-all text-muted sm:table-cell sm:py-2.5">
                      <span className="font-sans text-faint sm:hidden">On the network: </span>
                      {s.localUrl ?? "None"}
                    </td>
                    <td className="block pr-4 font-mono text-[0.78rem] break-all sm:table-cell sm:py-2.5">
                      <span className="font-sans text-faint sm:hidden">Public: </span>
                      {pub ? (
                        <a
                          href={pub}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 break-all text-gold hover:text-gold-bright"
                        >
                          {s.publicUrl} <ExternalLink strokeWidth={1.5} className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-faint">Not published</span>
                      )}
                    </td>
                    <td className="block text-[0.8rem] text-muted sm:table-cell sm:py-2.5">
                      <span className="text-faint sm:hidden">Through: </span>
                      {s.proxyServiceId
                        ? (names.get(s.proxyServiceId) ?? s.proxyServiceId)
                        : "Direct"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function LogsContent({ ws }: { ws: Workspace }) {
  const [view, setView] = useState<"changes" | "activity">("changes");
  const audit = useAudit(100);
  const tone = { good: "text-live", neutral: "text-faint", attention: "text-amber" };
  const who = { you: "You", "dragon-control": "Hearth", agent: "The AI" } as const;
  return (
    <>
      <PageHeader
        eyebrow="Logs"
        title="Changes and activity"
        subtitle="Every change made by you, Hearth, or the AI (the audit trail), and what monitoring noticed. Secret values never appear here."
      />
      <div className="mb-6">
        <Segmented
          label="Log view"
          value={view}
          onChange={setView}
          options={[
            { value: "changes", label: "Changes" },
            { value: "activity", label: "Activity" },
          ]}
        />
      </div>
      {view === "changes" ? (
        <ul className="divide-y divide-line" data-testid="audit-log">
          {(audit.data ?? []).map((a) => (
            <li key={a.id} className="flex flex-col gap-0.5 py-3 sm:flex-row sm:gap-4">
              <span className="w-32 shrink-0 text-[0.78rem] text-faint">{who[a.actor]}</span>
              <span className="flex-1 text-[0.9rem] text-ink">{a.action}</span>
              <span className="shrink-0 text-[0.76rem] text-faint tabular">{ago(a.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-y divide-line">
          {ws.activity.map((a) => (
            <li key={a.id} className="flex gap-4 py-3">
              <span className={cx("text-[0.65rem]", tone[a.tone])} aria-hidden="true">
                ◆
              </span>
              {a.incidentId ? (
                <Link
                  to={`/incidents/${a.incidentId}`}
                  className="flex-1 text-[0.9rem] text-ink hover:text-gold"
                >
                  {a.text}
                </Link>
              ) : (
                <span className="flex-1 text-[0.9rem] text-ink">{a.text}</span>
              )}
              <span className="text-[0.76rem] text-faint tabular">{ago(a.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DockerPage() {
  return <WithWorkspace>{(ws) => <DockerContent ws={ws} />}</WithWorkspace>;
}
export function NetworkPage() {
  return <WithWorkspace>{(ws) => <NetworkContent ws={ws} />}</WithWorkspace>;
}
export function LogsPage() {
  return <WithWorkspace>{(ws) => <LogsContent ws={ws} />}</WithWorkspace>;
}
export function BackupsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Systems"
        title="Backups"
        subtitle="Hearth's own database and memory, backed up daily, checked, and copied off this machine."
      />
      <BackupsSection />
    </>
  );
}
