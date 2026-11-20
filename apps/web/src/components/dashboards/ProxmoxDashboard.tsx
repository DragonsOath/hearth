import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Camera,
  DatabaseBackup,
  ExternalLink,
  MessageCircle,
  Play,
  Power,
  RotateCw,
  Square,
} from "lucide-react";
import type { ProxmoxDashboard as Data, ProxmoxGuest } from "@dragon-control/core";
import { api, useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere, type ApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { useCave } from "../shell/cave-context";
import { useNow } from "../home/parts";
import { Skeleton, cx } from "../ui";
import { PasteKey } from "./PasteKey";
import { EmberMark } from "../ember/EmberMark";

/**
 * Proxmox VE from Hearth. The Overview answers "is everything up, and is anything filling or
 * failing?": each node's CPU, memory and disk, how many VMs and containers run, storage use,
 * failed tasks and waiting updates. VMs and containers lists every guest with its state and
 * resources, and starts, shuts down, restarts, force-stops, backs up or snapshots one, each a plan
 * you approve. Backups shows the backup jobs, the newest backup of every guest and every backup
 * file. Creating, deleting, migrating or changing a guest stays in Proxmox.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const KIND = "app-proxmox-control" as const;
const DAY = 86_400_000;

function useProxmox(serviceId: string) {
  const q = useDashboard(serviceId, true, 15_000);
  const d: Data | undefined = q.data?.data?.app === "proxmox" ? q.data.data : undefined;
  return { q, d };
}

function Gate({
  serviceId,
  name,
  q,
}: {
  serviceId: string;
  name: string;
  q: ReturnType<typeof useProxmox>["q"];
}) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
      <PasteKey
        serviceId={serviceId}
        name={name}
        where="Datacenter, then Permissions, then API Tokens, then Add, and paste it as user@realm!tokenid=secret (for example root@pam!hearth=…)"
        message={q.data.error.message}
      />
    ) : (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="px-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  return null;
}

const gib = (b: number) =>
  b >= 1024 ** 4
    ? `${(b / 1024 ** 4).toFixed(1)} TiB`
    : `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GiB`;
const uptime = (s: number) =>
  s >= 86400
    ? `${Math.floor(s / 86400)} d`
    : s >= 3600
      ? `${Math.floor(s / 3600)} h`
      : `${Math.floor(s / 60)} min`;

/** A bar that turns amber at 80% and red at 90%, as full disks and memory should. */
function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[0.74rem] text-faint">
        <span>{label}</span>
        <span className="tabular">
          {gib(used)} of {gib(total)}
        </span>
      </div>
      <div
        className="h-1.5 rounded-full bg-line"
        role="img"
        aria-label={`${label}: ${Math.round(pct)}% used`}
      >
        <div
          className={cx(
            "h-full rounded-full",
            pct >= 90 ? "bg-alert" : pct >= 80 ? "bg-amber" : "bg-ok",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const web = keyPageHref(service, "/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Proxmox VE ${d.version} · ` : ""}live, every 15 s · Not yet checked against a
      real Proxmox: tell us if anything reads wrong.{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
          data-testid="px-open-webui"
        >
          Open Proxmox <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

export function ProxmoxDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useProxmox(serviceId);
  const cave = useCave();
  const now = useNow().getTime();
  if (!d) return <Gate serviceId={serviceId} name={name} q={q} />;
  const guests = d.guests.filter((g) => !g.template);
  const running = guests.filter((g) => g.status === "running").length;
  const failed = d.tasks.filter((t) => t.ok === false && now - Date.parse(t.started) < 7 * DAY);
  const stale = guests.filter((g) => !g.lastBackup || now - Date.parse(g.lastBackup) > 7 * DAY);
  return (
    <section
      className="@container space-y-4"
      data-testid="px-dashboard"
      aria-label={`${name}: reading`}
    >
      <div className="grid gap-3 @2xl:grid-cols-2">
        {d.nodes.map((n) => (
          <div
            key={n.name}
            className={cx(
              "space-y-2 rounded-xl border p-3",
              n.online ? "border-line" : "border-alert/50",
            )}
            data-testid="px-node"
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <p className="flex-1 text-[0.95rem] text-ink">{n.name}</p>
              <span className={cx("text-[0.76rem]", n.online ? "text-ok" : "text-alert")}>
                {n.online ? `online, up ${uptime(n.uptimeSec)}` : "offline"}
              </span>
            </div>
            <div className="flex justify-between text-[0.74rem] text-faint">
              <span>CPU</span>
              <span className="tabular">
                {n.cpuPct}% of {n.cpus} cores
              </span>
            </div>
            <Meter used={n.memUsed} total={n.memTotal} label="Memory" />
            <Meter used={n.diskUsed} total={n.diskTotal} label="System disk" />
            {n.updates !== undefined && (
              <p
                className={cx("text-[0.76rem]", n.updates ? "text-amber" : "text-faint")}
                data-testid="px-updates"
              >
                {n.updates
                  ? `${n.updates} updates waiting (install them in Proxmox, then restart if asked).`
                  : "Up to date."}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("guests")}
          data-hearth-target="tab:guests:open"
        >
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Running</p>
          <p className="stat-value text-ink tabular" data-testid="px-running">
            {running} of {guests.length}
          </p>
          <p className="text-[0.74rem] text-faint">VMs and containers</p>
        </button>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("backups")}
          data-hearth-target="tab:backups:open"
        >
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Backed up this week</p>
          <p
            className={cx("stat-value tabular", stale.length ? "text-amber" : "text-ink")}
            data-testid="px-backed-up"
          >
            {guests.length - stale.length} of {guests.length}
          </p>
          <p className="text-[0.74rem] text-faint">
            {d.backupJobs.filter((j) => j.enabled).length} backup jobs on
          </p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Failed tasks</p>
          <p
            className={cx("stat-value tabular", failed.length ? "text-amber" : "text-ink")}
            data-testid="px-failed"
          >
            {failed.length}
          </p>
          <p className="text-[0.74rem] text-faint">in the last week</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Storage</p>
          <p className="stat-value text-ink tabular">{d.storage.filter((s) => s.active).length}</p>
          <p className="text-[0.74rem] text-faint">
            places,{" "}
            {d.storage.filter((s) => s.totalBytes && s.usedBytes / s.totalBytes > 0.8).length} over
            80% full
          </p>
        </div>
      </div>
      <div className="grid gap-4 @2xl:grid-cols-2">
        <div>
          <p className={eyebrow}>Storage</p>
          <div className="space-y-2" data-testid="px-storage">
            {d.storage.map((s) => (
              <div key={`${s.node}/${s.id}`}>
                <Meter
                  used={s.usedBytes}
                  total={s.totalBytes}
                  label={`${s.id}${d.nodes.length > 1 && !s.shared ? ` on ${s.node}` : ""} · ${s.type}${s.active ? "" : " · not available"}`}
                />
                <p className="text-[0.7rem] text-faint">
                  holds {s.content.join(", ") || "nothing yet"}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div>
          <p className={eyebrow}>Recent tasks</p>
          <ul className="divide-y divide-line text-[0.82rem]" data-testid="px-tasks">
            {d.tasks.slice(0, 8).map((t) => (
              <li
                key={t.upid}
                className="flex flex-wrap gap-x-2 py-1.5"
                data-ok={t.ok === undefined ? "running" : t.ok ? "yes" : "no"}
              >
                <span className="min-w-0 flex-1 text-ink">
                  {t.what}
                  {t.vmid ? ` ${t.vmid}` : ""}
                  {t.error && <span className="block text-[0.74rem] text-amber">{t.error}</span>}
                </span>
                <span
                  className={cx("text-[0.74rem]", t.ok === false ? "text-amber" : "text-faint")}
                >
                  {t.ok === undefined ? "running" : t.ok ? "OK" : "failed"} · {ago(t.started)}
                </span>
              </li>
            ))}
          </ul>
          {failed.length > 0 && (
            <button
              type="button"
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
              onClick={() =>
                cave.ask(
                  `These Proxmox tasks failed in ${name}: ${failed
                    .slice(0, 5)
                    .map((t) => `${t.what}${t.vmid ? ` ${t.vmid}` : ""} (${t.error})`)
                    .join("; ")}. Why, and how do I fix them?`,
                )
              }
            >
              <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember why
              <EmberMark />
            </button>
          )}
        </div>
      </div>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

/** One guest's snapshots, read when its row is opened. */
function Snapshots({ serviceId, guest }: { serviceId: string; guest: string }) {
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "px-snapshots", guest],
    queryFn: () =>
      api<{ name: string; at?: string; description?: string }[]>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/proxmox/snapshots?guest=${encodeURIComponent(guest)}`,
      ),
  });
  if (q.isLoading) return <p className="text-[0.76rem] text-faint">Reading snapshots…</p>;
  if (q.error) return <p className="text-[0.76rem] text-amber">{q.error.message}</p>;
  return (
    <p className="text-[0.76rem] text-faint" data-testid="px-snapshots">
      Snapshots:{" "}
      {q.data?.length
        ? q.data.map((s) => `${s.name}${s.at ? ` (${ago(s.at)})` : ""}`).join(", ")
        : "none"}
      . Rolling back to one is done in Proxmox.
    </p>
  );
}

function GuestRow({
  g,
  serviceId,
  name,
  act,
  storages,
}: {
  g: ProxmoxGuest;
  serviceId: string;
  name: string;
  act: ApproveHere;
  storages: string[];
}) {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState("");
  const [to, setTo] = useState(storages[0] ?? "");
  const who = `${g.kind === "vm" ? "VM" : "container"} ${g.vmid} (${g.name})`;
  const go = (op: string, extra: Record<string, string> = {}, title = `${op} ${who}`) =>
    void act.propose(KIND, { op, guest: g.id, ...extra }, `${title} in ${name}`);
  const running = g.status === "running";
  return (
    <li
      className="py-2"
      data-testid="px-guest"
      data-status={g.status}
      data-capture-item
      data-capture-label={g.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-hearth-target={`guest:${g.vmid}:open`}
        >
          <span className="text-[0.88rem] text-ink">
            {g.vmid} · {g.name}
          </span>
          <span className="block text-[0.74rem] text-faint">
            <span
              className={running ? "text-ok" : g.status === "paused" ? "text-amber" : undefined}
            >
              {g.status}
            </span>
            {" · "}
            {g.kind === "vm" ? "VM" : "container"} on {g.node}
            {running
              ? ` · CPU ${g.cpuPct}% of ${g.cpus} · ${gib(g.memUsed)} of ${gib(g.memTotal)} · up ${uptime(g.uptimeSec)}`
              : ` · ${g.cpus} CPUs, ${gib(g.memTotal)}`}
            {g.lock ? ` · locked (${g.lock})` : ""}
            {g.tags.length ? ` · ${g.tags.join(", ")}` : ""}
          </span>
        </button>
        {running ? (
          <button
            type="button"
            className={btn}
            onClick={() => go("shutdown", {}, "Shut down")}
            data-hearth-target={`guest:${g.vmid}:shutdown`}
          >
            <Power className="h-3.5 w-3.5" /> Shut down
          </button>
        ) : (
          <button
            type="button"
            className={btn}
            onClick={() => go("start", {}, "Start")}
            data-hearth-target={`guest:${g.vmid}:start`}
          >
            <Play className="h-3.5 w-3.5" /> Start
          </button>
        )}
      </div>
      {open && (
        <div
          className="mt-2 space-y-2 rounded-lg border border-line p-2.5"
          data-testid="px-guest-detail"
        >
          <p className="text-[0.76rem] text-faint">
            Disk {gib(g.diskTotal)} · last backup {g.lastBackup ? ago(g.lastBackup) : "none found"}
          </p>
          <div className="flex flex-wrap gap-2">
            {running && (
              <>
                <button
                  type="button"
                  className={btn}
                  onClick={() => go("reboot", {}, "Restart")}
                  data-hearth-target={`guest:${g.vmid}:reboot`}
                >
                  <RotateCw className="h-3.5 w-3.5" /> Restart
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() => go("stop", {}, "Force-stop")}
                  data-hearth-target={`guest:${g.vmid}:stop`}
                >
                  <Square className="h-3.5 w-3.5" /> Force stop
                </button>
              </>
            )}
          </div>
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => e.preventDefault()}>
            {storages.length > 1 && (
              <select
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="Back up to"
                className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink"
                data-hearth-target={`guest:${g.vmid}:backup-to`}
              >
                {storages.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={btn}
              onClick={() => go("backup", to ? { storage: to } : {}, "Back up")}
              data-hearth-target={`guest:${g.vmid}:backup`}
            >
              <DatabaseBackup className="h-3.5 w-3.5" /> Back up now
            </button>
          </form>
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => e.preventDefault()}>
            <input
              value={snap}
              onChange={(e) => setSnap(e.target.value)}
              placeholder="before-update"
              aria-label="Snapshot name"
              className="min-h-9 min-w-[9rem] flex-1 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink"
              data-hearth-target={`guest:${g.vmid}:snapshot-name`}
            />
            <button
              type="button"
              className={btn}
              onClick={() => go("snapshot", snap.trim() ? { name: snap.trim() } : {}, "Snapshot")}
              data-hearth-target={`guest:${g.vmid}:snapshot`}
            >
              <Camera className="h-3.5 w-3.5" /> Take a snapshot
            </button>
          </form>
          <Snapshots serviceId={serviceId} guest={g.id} />
        </div>
      )}
    </li>
  );
}

export function ProxmoxGuests({ serviceId, name }: AppViewProps) {
  const { q, d } = useProxmox(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Proxmox's VMs and containers tab.");
  const [show, setShow] = useState<"all" | "running" | "stopped">("all");
  const [find, setFind] = useState("");
  if (!d) return <Gate serviceId={serviceId} name={name} q={q} />;
  const storages = [
    ...new Set(d.storage.filter((s) => s.active && s.content.includes("backup")).map((s) => s.id)),
  ];
  const needle = find.trim().toLowerCase();
  const list = d.guests.filter(
    (g) =>
      !g.template &&
      (show === "all" || (show === "running" ? g.status === "running" : g.status !== "running")) &&
      (!needle ||
        g.name.toLowerCase().includes(needle) ||
        String(g.vmid).includes(needle) ||
        g.tags.some((t) => t.includes(needle))),
  );
  const templates = d.guests.filter((g) => g.template);
  return (
    <section
      className="@container space-y-3"
      data-testid="px-guests"
      aria-label={`${name}: VMs and containers`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="group">
          {(["all", "running", "stopped"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={show === s}
              onClick={() => setShow(s)}
              data-hearth-target={`guests:show-${s}`}
              className={cx(
                "min-h-8 rounded-md px-2.5 text-[0.78rem]",
                show === s ? "bg-gold/15 text-gold" : "text-muted hover:text-ink",
              )}
            >
              {s === "all" ? "All" : s === "running" ? "Running" : "Stopped"}
            </button>
          ))}
        </div>
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find by name, id or tag"
          aria-label="Find a VM or container"
          className="min-h-9 min-w-[12rem] flex-1 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
          data-hearth-target="guests:find"
        />
      </div>
      <ul className="divide-y divide-line">
        {list.map((g) => (
          <GuestRow
            key={g.id}
            g={g}
            serviceId={serviceId}
            name={name}
            act={act}
            storages={storages}
          />
        ))}
      </ul>
      {!list.length && <p className="text-[0.82rem] text-faint">None match.</p>}
      {templates.length > 0 && (
        <p className="text-[0.76rem] text-faint">
          Templates: {templates.map((t) => `${t.vmid} ${t.name}`).join(", ")} (cloned into new
          guests in Proxmox).
        </p>
      )}
      <p className="text-[0.74rem] text-faint">
        Shut down asks the guest to close cleanly; Force stop is for one that does not answer.
        Creating, deleting, migrating, consoles and hardware stay in Proxmox.
      </p>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

export function ProxmoxBackups({ serviceId, name }: AppViewProps) {
  const { q, d } = useProxmox(serviceId);
  const now = useNow().getTime();
  if (!d) return <Gate serviceId={serviceId} name={name} q={q} />;
  const guests = d.guests.filter((g) => !g.template);
  const backupTasks = d.tasks.filter((t) => t.what === "Backup");
  return (
    <section
      className="@container space-y-5"
      data-testid="px-backups"
      aria-label={`${name}: backups`}
    >
      <div>
        <p className={eyebrow}>Backup jobs</p>
        {d.backupJobs.length ? (
          <ul className="divide-y divide-line text-[0.84rem]" data-testid="px-jobs">
            {d.backupJobs.map((j) => (
              <li key={j.id} className="flex flex-wrap gap-x-2 py-1.5">
                <span className="min-w-0 flex-1 text-ink">
                  {j.guests === "all" ? "Every guest" : `Guests ${j.guests.join(", ")}`} to{" "}
                  {j.storage}
                </span>
                <span className={cx("text-[0.76rem]", j.enabled ? "text-faint" : "text-amber")}>
                  {j.enabled ? `at ${j.schedule}` : "switched off"} · {j.mode}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.82rem] text-amber">
            No backup jobs: nothing is backed up on a schedule. Add one in Proxmox (Datacenter,
            Backup).
          </p>
        )}
      </div>
      <div>
        <p className={eyebrow}>Newest backup of each guest</p>
        <ul className="divide-y divide-line text-[0.84rem]" data-testid="px-guest-backups">
          {guests.map((g) => {
            const old = !g.lastBackup || now - Date.parse(g.lastBackup) > 7 * DAY;
            return (
              <li
                key={g.id}
                className="flex flex-wrap gap-x-2 py-1.5"
                data-stale={old ? "yes" : "no"}
              >
                <span className="min-w-0 flex-1 text-ink">
                  {g.vmid} · {g.name}
                </span>
                <span className={cx("text-[0.76rem]", old ? "text-amber" : "text-faint")}>
                  {g.lastBackup ? ago(g.lastBackup) : "never backed up"}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-1 text-[0.74rem] text-faint">Back up one now from VMs and containers.</p>
      </div>
      {backupTasks.some((t) => t.ok === false) && (
        <div>
          <p className={eyebrow}>Backup runs that failed</p>
          <ul className="text-[0.82rem] text-amber">
            {backupTasks
              .filter((t) => t.ok === false)
              .map((t) => (
                <li key={t.upid}>
                  {ago(t.started)}: {t.error}
                </li>
              ))}
          </ul>
        </div>
      )}
      <div>
        <p className={eyebrow}>Backup files</p>
        <ul className="divide-y divide-line text-[0.82rem]" data-testid="px-files">
          {d.backups.slice(0, 100).map((b) => (
            <li key={b.volid} className="flex flex-wrap gap-x-2 py-1">
              <span className="min-w-0 flex-1 break-all text-ink">
                {b.vmid} · {ago(b.at)}
                {b.protected ? " · protected" : ""}
                {b.notes ? ` · ${b.notes}` : ""}
              </span>
              <span className="text-[0.74rem] text-faint">
                {gib(b.sizeBytes)} on {b.storage}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[0.74rem] text-faint">
          Restoring or deleting a backup is done in Proxmox.
        </p>
      </div>
      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}
