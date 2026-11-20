import { useState } from "react";
import { WithWorkspace } from "../components/WithWorkspace";
import { EmptyState, Monogram, PageHeader, Segmented, Tag } from "../components/ui";
import type { Integration, Workspace } from "@dragon-control/core";

type View = Integration["status"];

const viewCopy: Record<View, { label: string; empty: string }> = {
  connected: { label: "Connected", empty: "Nothing connected yet." },
  discovered: { label: "Found on your network", empty: "Nothing waiting to be connected." },
  available: { label: "Available", empty: "Every available integration is in use." },
};

function IntegrationsContent({ ws }: { ws: Workspace }) {
  const count = (s: View) => ws.integrations.filter((i) => i.status === s).length;
  const [view, setView] = useState<View>(count("connected") ? "connected" : "available");
  const list = ws.integrations.filter((i) => i.status === view);

  return (
    <>
      <PageHeader
        eyebrow="Integrations"
        title="Integrations"
        subtitle="Integrations teach Hearth how an application works, so it can understand more than whether a container is running."
      />
      <div className="mb-8">
        <Segmented
          label="Integration view"
          value={view}
          onChange={setView}
          options={(["connected", "discovered", "available"] as View[]).map((v) => ({
            value: v,
            label: viewCopy[v].label,
            count: count(v),
          }))}
        />
      </div>

      {list.length === 0 ? (
        <EmptyState title={viewCopy[view].empty} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((i) => (
            <li
              key={i.id}
              className="flex items-start gap-4 rounded-xl border border-line bg-panel p-5"
            >
              <Monogram name={i.name} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[0.95rem] text-ink">{i.name}</p>
                  {i.status === "discovered" && <Tag tone="gold">Ready to connect</Tag>}
                  {i.instances !== undefined && (
                    <span className="text-[0.75rem] text-faint tabular">
                      {i.instances} {i.instances === 1 ? "instance" : "instances"}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[0.82rem] leading-relaxed text-muted">{i.description}</p>
                <p className="mt-2 text-[0.72rem] tracking-wide text-faint uppercase">
                  {i.category}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function IntegrationsPage() {
  return <WithWorkspace>{(ws) => <IntegrationsContent ws={ws} />}</WithWorkspace>;
}
