import { useState, type FormEvent } from "react";
import { FolderOpen } from "lucide-react";
import type { PhysicalDisk, Workspace } from "@dragon-control/core";
import { WithWorkspace } from "../components/WithWorkspace";
import {
  Button,
  Figure,
  Meter,
  PageHeader,
  Panel,
  RowLink,
  Rows,
  Section,
  Status,
  StatusDot,
  Tag,
  cx,
} from "../components/ui";
import { useAddLocation, useRefreshDisks } from "../data/api";
import { ago, hoursAsDuration, pct, storageTotals, tb, volumeHealth } from "../lib/format";

const kindLabel = {
  ssd: "Solid state",
  hdd: "Hard drive",
  nas: "Network storage",
  disk: "Local disk",
};

const diskType = { ssd: "SSD", hdd: "Hard drive", unknown: "Drive" };

const diskHealth: Record<
  PhysicalDisk["health"],
  { health: "healthy" | "attention" | "offline"; label: string }
> = {
  healthy: { health: "healthy", label: "Good" },
  warning: { health: "attention", label: "Caution" },
  failing: { health: "offline", label: "Bad" },
  unknown: { health: "attention", label: "Unknown" },
};

function WatchFolder() {
  const [path, setPath] = useState("");
  const add = useAddLocation();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (path.trim()) add.mutate({ path: path.trim() }, { onSuccess: () => setPath("") });
  };
  return (
    <form onSubmit={submit} className="mt-6">
      <label htmlFor="watch-path" className="text-[0.85rem] text-muted">
        Watch a folder
      </label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <input
          id="watch-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Folder path"
          autoComplete="off"
          spellCheck={false}
          className="min-h-11 flex-1 rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink tabular placeholder:text-faint focus:border-gold/60 focus:outline-none"
        />
        <Button type="submit" disabled={!path.trim() || add.isPending}>
          {add.isPending ? "Checking" : "Watch"}
        </Button>
      </div>
      <p className="mt-2 text-[0.78rem] text-faint" aria-live="polite">
        {add.error ? (
          <span className="text-bad">{add.error.message}</span>
        ) : (
          "Read only. Hearth lists names, sizes, and dates; it never opens, moves, or deletes anything."
        )}
      </p>
    </form>
  );
}

function WatchedFolders({ ws }: { ws: Workspace }) {
  const hostName = (id: string) => ws.hosts.find((h) => h.id === id)?.name ?? "";
  return (
    <Section title="Watched folders">
      {ws.storageLocations.length === 0 ? (
        <p className="py-2 text-[0.9rem] text-muted">
          Nothing watched yet. Add a folder such as your movies or photos to browse it here.
        </p>
      ) : (
        <Rows>
          {ws.storageLocations.map((l) => (
            <RowLink key={l.id} to={`/storage/${l.id}`} label={`Browse ${l.label}`}>
              <FolderOpen strokeWidth={1.25} className="h-5 w-5 shrink-0 text-gold" />
              <div className="min-w-0 flex-1">
                <p className="text-[0.95rem] text-ink">{l.label}</p>
                <p className="truncate text-[0.8rem] text-faint tabular">
                  {hostName(l.hostId)} · {l.path}
                </p>
              </div>
            </RowLink>
          ))}
        </Rows>
      )}
      {ws.environment === "real" ? (
        <WatchFolder />
      ) : (
        <p className="mt-4 text-[0.8rem] text-faint">
          These are sample folders. Once you discover this machine you can watch your own.
        </p>
      )}
    </Section>
  );
}

function Metric({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt className="text-[0.72rem] text-faint">{label}</dt>
      <dd className={cx("mt-1 text-[0.9rem] tabular", value ? "text-ink" : "text-faint")}>
        {value ?? "Not reported"}
      </dd>
    </div>
  );
}

function DiskCard({ disk, hostName }: { disk: PhysicalDisk; hostName: string }) {
  const h = diskHealth[disk.health];
  return (
    <li>
      <Panel className="h-full p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-display text-[1.35rem] leading-tight text-ink">
              {disk.model}
            </p>
            <p className="mt-1 text-[0.8rem] text-muted">
              {hostName} · {disk.volumes.join(", ") || "No drive letter"}
            </p>
          </div>
          <Status health={h.health} label={h.label} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Tag>{diskType[disk.type]}</Tag>
          <Tag>{disk.bus}</Tag>
          <Tag>{tb(disk.sizeTb)}</Tag>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-4">
          <Metric
            label="Temperature"
            value={
              disk.temperatureC !== undefined ? `${Math.round(disk.temperatureC)} °C` : undefined
            }
          />
          <Metric
            label="Powered on"
            value={disk.powerOnHours !== undefined ? hoursAsDuration(disk.powerOnHours) : undefined}
          />
          <Metric
            label="Life used"
            value={disk.wearPct !== undefined ? `${disk.wearPct}%` : undefined}
          />
          <Metric
            label="Errors"
            value={
              disk.readErrors !== undefined || disk.writeErrors !== undefined
                ? String((disk.readErrors ?? 0) + (disk.writeErrors ?? 0))
                : undefined
            }
          />
        </dl>
        {disk.limitation && (
          <p className="mt-4 text-[0.78rem] leading-relaxed text-faint">{disk.limitation}</p>
        )}
      </Panel>
    </li>
  );
}

function DriveHealth({ ws }: { ws: Workspace }) {
  const refresh = useRefreshDisks();
  if (ws.disks.length === 0) return null;
  const checked = ws.disks
    .map((d) => d.checkedAt)
    .sort()
    .at(-1);
  const hostName = (id: string) => ws.hosts.find((h) => h.id === id)?.name ?? "";
  return (
    <Section
      title="Drive health"
      action={
        ws.environment === "real" ? (
          <Button
            tone="quiet"
            className="min-h-9 px-0"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            {refresh.isPending ? "Checking" : "Check now"}
          </Button>
        ) : undefined
      }
    >
      <p className="-mt-1 mb-4 flex items-center gap-2 text-[0.8rem] text-faint">
        <StatusDot
          health={ws.disks.every((d) => d.health === "healthy") ? "healthy" : "attention"}
        />
        {ws.disks.length} {ws.disks.length === 1 ? "drive" : "drives"}
        {checked ? ` · checked ${ago(checked).toLowerCase()}` : ""}
        {refresh.error && <span className="text-bad"> · {refresh.error.message}</span>}
      </p>
      <ul className="grid gap-3 lg:grid-cols-2">
        {ws.disks.map((d) => (
          <DiskCard key={d.id} disk={d} hostName={hostName(d.hostId)} />
        ))}
      </ul>
    </Section>
  );
}

function StorageContent({ ws }: { ws: Workspace }) {
  const totals = storageTotals(ws.hosts);
  const hostsWithStorage = ws.hosts.filter((h) => h.volumes.length > 0);
  const filling = ws.hosts.flatMap((h) => h.volumes).filter((v) => pct(v.usedTb, v.totalTb) >= 90);

  return (
    <>
      <PageHeader
        eyebrow="Storage"
        title="Storage"
        subtitle={
          filling.length
            ? `${filling.map((v) => v.label).join(", ")} ${filling.length === 1 ? "is" : "are"} nearly full.`
            : "Capacity is comfortable everywhere."
        }
      />

      <div className="mb-14 grid grid-cols-2 gap-8 sm:grid-cols-3">
        <Figure value={totals.used.toFixed(1)} unit="TB" label="In use" />
        <Figure value={(totals.total - totals.used).toFixed(1)} unit="TB" label="Available" />
        <Figure value={totals.percent} unit="%" label="Of total capacity" />
      </div>

      <WatchedFolders ws={ws} />
      <DriveHealth ws={ws} />

      {hostsWithStorage.map((host) => (
        <Section key={host.id} title={`${host.name} · capacity`}>
          <ul className="divide-y divide-line">
            {host.volumes.map((v) => {
              const used = pct(v.usedTb, v.totalTb);
              const health =
                v.smart === "warning" ? "attention" : volumeHealth(v.usedTb, v.totalTb);
              return (
                <li key={v.id} className="py-5">
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <div className="min-w-0">
                      <span className="text-[0.95rem] text-ink">{v.label}</span>
                      <span className="ml-3 text-[0.78rem] text-faint">
                        {kindLabel[v.kind]}
                        {v.mount !== v.label ? ` · ${v.mount}` : ""}
                      </span>
                    </div>
                    <span className="text-[0.85rem] text-muted tabular">
                      {tb(v.usedTb)} of {tb(v.totalTb)}
                    </span>
                  </div>
                  <Meter value={used} label={`${host.name} ${v.label} used`} />
                  <div className="mt-2 flex justify-between text-[0.75rem]">
                    <Status
                      health={health}
                      label={health === "healthy" ? "Healthy" : "Nearly full"}
                    />
                    <span className="text-faint tabular">{used}%</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}

export function StoragePage() {
  return <WithWorkspace>{(ws) => <StorageContent ws={ws} />}</WithWorkspace>;
}
