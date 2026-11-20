import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  Download,
  HardDrive,
  MessageCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import {
  RAID_TECH_NAME,
  raidTolerance,
  raidUsableBytes,
  type RaidAction,
  type RaidActionId,
  type RaidArray,
  type RaidCandidate,
  type RaidCreateOption,
  type RaidMember,
  type RaidReport,
  type RaidTech,
  type StepParams,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { onPc, useStoragePc } from "./pc";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "../dashboards/ConfirmedChange";
import { useLiveQuery } from "../panels/lifecycle";
import { EmberMark } from "../ember/EmberMark";

/**
 * Storage > RAID / Arrays: every array or pool on the machine, whatever manages it (Linux software
 * RAID, ZFS, Storage Spaces, SnapRAID...), read now, with what it can and cannot do, and guided
 * changes. A change is a plan you confirm in place (the exact host, array, and drives, by model and
 * serial); Hearth checks again, the elevated executor checks the drive itself, does it, and reads
 * it back. Nothing is erased, failed, or created without that confirmation.
 */

const HOST = "this-host";

const size = (b?: number) =>
  b === undefined
    ? "…"
    : b >= 1e12
      ? `${(b / 1e12).toFixed(b >= 1e13 ? 0 : 1)} TB`
      : b >= 1e9
        ? `${Math.round(b / 1e9)} GB`
        : `${Math.round(b / 1e6)} MB`;
const eta = (m: number) =>
  m < 90 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
const levelName = (l?: string) =>
  !l ? "unknown" : l === "linear" ? "Linear" : /^raid\d+$/.test(l) ? `RAID ${l.slice(4)}` : l;
/** A drive as people know it: "Disk 2" on Windows (as Disk Management says), the path on Linux. */
const driveLabel = (d: string) =>
  /^\\\\\.\\PHYSICALDRIVE\d+$/.test(d)
    ? `Disk ${/(\d+)$/.exec(d)![1]}`
    : d.startsWith("disk:")
      ? "Disk (not connected)"
      : d;
const levelOf = (a: RaidArray) => a.levelText ?? levelName(a.level);
/** What a check is called for this technology. */
const checkNoun = (t: RaidTech) =>
  t === "zfs" || t === "btrfs" ? "Scrub" : t === "snapraid" ? "Sync" : "Check";

const HEALTH_TONE: Record<string, string> = {
  healthy: "border-live/40 text-live",
  checking: "border-live/40 text-live",
  resyncing: "border-amber/40 text-amber",
  rebuilding: "border-amber/40 text-amber",
  reshaping: "border-amber/40 text-amber",
  degraded: "border-alert/50 text-alert",
  failed: "border-alert/60 text-alert",
  inactive: "border-alert/50 text-alert",
  unknown: "border-line-strong text-muted",
};
const ROLE_TONE: Record<RaidMember["role"], string> = {
  active: "text-live",
  "write-mostly": "text-live",
  data: "text-live",
  parity: "text-live",
  spare: "text-muted",
  cache: "text-muted",
  log: "text-muted",
  rebuilding: "text-amber",
  replacing: "text-amber",
  offline: "text-amber",
  retired: "text-amber",
  faulty: "text-alert",
  missing: "text-alert",
};
const ROLE_WORDS: Record<RaidMember["role"], string> = {
  active: "Active",
  "write-mostly": "Active (write-mostly)",
  spare: "Hot spare",
  rebuilding: "Rebuilding",
  replacing: "Taking over",
  faulty: "Failed",
  missing: "Missing",
  offline: "Offline",
  retired: "Retired",
  data: "Data",
  parity: "Parity",
  cache: "Read cache",
  log: "Write log",
};
const STATUS_WORDS: Record<RaidAction["status"], string> = {
  available: "Available",
  blocked: "Needs something first",
  unsupported: "Not supported",
  running: "Running now",
};
const SYNC_WORDS: Record<string, string> = {
  resync: "Bringing members into step",
  recover: "Rebuilding",
  check: "Checking",
  repair: "Repairing",
  reshape: "Reshaping",
  scrub: "Scrubbing",
  resilver: "Rebuilding (resilver)",
  balance: "Balancing",
  sync: "Syncing parity",
  optimize: "Optimizing",
};

function Pill({ tone, children, testId }: { tone: string; children: ReactNode; testId?: string }) {
  return (
    <span
      className={cx("rounded-full border px-2 py-0.5 text-[0.72rem] whitespace-nowrap", tone)}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function Ask({ q, label = "Ask Ember" }: { q: string; label?: string }) {
  const cave = useCave();
  return (
    <button
      type="button"
      onClick={() => cave.ask(q)}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
    >
      <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> {label}
      <EmberMark />
    </button>
  );
}

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";

/** Whether changes can run for this technology here, and if not, why. */
const readyFor = (r: RaidReport, t: RaidTech) =>
  r.changes.byTech?.[t] ?? { ready: r.changes.ready, why: r.changes.why };

export function RaidTab({ layout }: { layout?: ReactNode }) {
  // The PC chosen at the top of Storage & Files ("" is this one).
  const pc = useStoragePc();
  const q = useLiveQuery({
    queryKey: ["raid", pc],
    queryFn: () => api<RaidReport>("GET", onPc(pc, "/api/storage-center/raid")),
    // Fast while something runs, so progress moves; slow otherwise.
    refetchInterval: (query) =>
      query.state.data?.arrays.some((a) => a.sync && !a.sync.paused) ? 4000 : 30_000,
  });
  const r = q.data;
  const here = !pc;
  // The technologies with arrays here whose changes cannot run yet, each with why (once).
  const off = r
    ? [...new Set(r.arrays.map((a) => a.tech))]
        .map((t) => ({ t, s: readyFor(r, t) }))
        .filter((x) => !x.s.ready)
    : [];
  const whys = [...new Set(off.map((x) => x.s.why).filter(Boolean))] as string[];
  return (
    <div className="space-y-5" data-testid="storage-volumes">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.84rem] text-muted">
          {r ? (
            <>
              Arrays and pools on <span className="text-ink">{r.host}</span>, read{" "}
              {ago(r.at).toLowerCase()}
              {r.sample ? " (sample data)" : ""}.
            </>
          ) : (
            "Reading arrays…"
          )}
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btn}
            onClick={() => void q.refetch()}
            data-testid="raid-refresh"
          >
            <RefreshCw className={cx("h-3.5 w-3.5", q.isFetching && "animate-spin")} /> Read again
          </button>
        </span>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-48" />
      ) : q.error || !r ? (
        <div
          className="rounded-xl border border-amber/40 p-4 text-[0.86rem]"
          data-testid="raid-error"
        >
          <p className="text-amber">Arrays could not be read{pc ? " on that machine" : ""}.</p>
          <p className="mt-1 text-muted">
            {q.error?.message ?? "No answer."}{" "}
            {pc ? "It may be offline or on an older Hearth (update it)." : ""}
          </p>
        </div>
      ) : (
        <>
          {off.length > 0 && (
            <div
              className="rounded-xl border border-amber/40 p-3 text-[0.84rem]"
              data-testid="raid-changes-off"
            >
              <p className="text-amber">
                Hearth can read{" "}
                {off.length === 1 && r.arrays.every((a) => a.tech === off[0]!.t)
                  ? "these"
                  : `the ${off.map((x) => RAID_TECH_NAME[x.t]).join(" and ")}`}{" "}
                arrays, but cannot change them here yet.
              </p>
              {whys.map((w) => (
                <p key={w} className="mt-1 text-muted">
                  {w}
                </p>
              ))}
              <div className="mt-2">
                <Ask
                  q={`Hearth's RAID tab says changes cannot run on ${r.host}: "${whys.join(" ")}". Walk me through setting that up safely.`}
                  label="Ask Ember to help set it up"
                />
              </div>
            </div>
          )}
          {!here && (
            <p className="text-[0.78rem] text-faint">
              Changes to another machine's arrays are made from that machine's Hearth.
            </p>
          )}

          {r.arrays.length ? (
            <ul className="space-y-3">
              {r.arrays.map((a) => (
                <li key={a.id}>
                  <ArrayCard a={a} r={r} here={here} onChanged={() => void q.refetch()} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-line p-4" data-testid="storage-no-arrays">
              <p className="text-[0.88rem] text-ink">No RAID arrays or pools on {r.host}.</p>
              <p className="mt-1 text-[0.84rem] text-muted">
                Each drive stands on its own, so a drive failure takes its files offline until they
                are restored from a backup.
                {r.tech.some((t) => t.support === "detect")
                  ? " Some storage here is detected but not read yet (see below)."
                  : ""}
              </p>
            </div>
          )}

          {here && <CreateArray r={r} />}

          <Candidates r={r} />

          {r.schedules.length > 0 && (
            <div>
              <Eyebrow>Scheduled checks</Eyebrow>
              <ul className="space-y-1 text-[0.82rem]" data-testid="raid-schedules">
                {r.schedules.map((s, i) => (
                  <li key={i} className="text-muted">
                    <span className="text-ink">{s.by === "hearth" ? "Hearth" : "The system"}:</span>{" "}
                    {s.text}
                    {s.next ? ` Next ${new Date(s.next).toLocaleString()}.` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details data-testid="storage-array-checks">
            <summary className="cursor-pointer text-[0.78rem] text-muted">
              How Hearth looked, technology by technology
            </summary>
            <ul className="mt-1 space-y-1 text-[0.78rem] text-faint">
              {r.tech.map((t) => (
                <li key={t.tech}>
                  <span className="text-ink">{RAID_TECH_NAME[t.tech] ?? t.tech}</span>: {t.seen} ·{" "}
                  {t.support === "manage"
                    ? `read and managed through approved plans (${t.verified === "live" ? "tested on real arrays" : t.verified === "loopback" ? "tested on throwaway test arrays" : "tested against sample data"})`
                    : t.support === "read"
                      ? "read only: managed in its own app"
                      : t.support === "detect"
                        ? "detected only: management not offered"
                        : "not present here"}
                  {t.tools?.length
                    ? ` · ${t.tools.map((x) => `${x.name} ${x.present ? "installed" : "not installed"}`).join(", ")}`
                    : ""}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[0.76rem] text-faint">
              Hardware RAID controllers and LVM RAID: management not offered (each needs its own
              vendor tool or care by hand).
            </p>
          </details>

          <p className="text-[0.78rem] text-faint" data-testid="raid-backup-note">
            {r.backups.text} Redundancy (RAID, parity, mirrors) is not a backup: deleted or damaged
            files are deleted or damaged on every copy.
          </p>

          {layout && (
            <details>
              <summary className="cursor-pointer text-[0.78rem] text-muted">
                Drives, partitions, filesystems
              </summary>
              <div className="mt-2">{layout}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-[0.72rem] tracking-wide text-faint uppercase">{children}</p>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg/50 p-2.5">
      <p className="text-[0.68rem] tracking-wide text-faint uppercase">{label}</p>
      <p className="text-[1.05rem] text-ink tabular">{value}</p>
      {sub && <p className="text-[0.72rem] text-faint">{sub}</p>}
    </div>
  );
}

function ArrayCard({
  a,
  r,
  here,
  onChanged,
}: {
  a: RaidArray;
  r: RaidReport;
  here: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(a.health !== "healthy" || r.arrays.length === 1);
  const act = (id: RaidActionId) => a.actions.find((x) => x.id === id);
  const s = a.sync;
  const used =
    a.usedBytes && a.sizeBytes ? Math.round((a.usedBytes / a.sizeBytes) * 100) : undefined;
  const what = a.tech === "mdadm" ? "RAID array" : `${RAID_TECH_NAME[a.tech]} pool`;
  return (
    <section
      className={cx(
        "rounded-xl border",
        a.health === "healthy" || a.health === "checking" ? "border-line" : "border-amber/50",
      )}
      data-testid="raid-array"
      data-array={a.name}
      data-tech={a.tech}
      data-health={a.health}
      data-capture-item
      data-capture-label={`${a.name} ${a.health}`}
    >
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <HardDrive strokeWidth={1.5} className="h-5 w-5 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="text-[0.96rem] text-ink">{a.name}</span>{" "}
          <span className="text-[0.78rem] text-faint">
            {a.tech === "mdadm" ? a.device : RAID_TECH_NAME[a.tech]} · {levelOf(a)} ·{" "}
            {size(a.sizeBytes)} usable
            {a.mount ? ` · ${a.mount}` : ""}
          </span>
        </span>
        <Pill tone={HEALTH_TONE[a.health] ?? HEALTH_TONE.unknown!} testId="raid-health">
          {a.health === "healthy" ? "Healthy" : a.health[0]!.toUpperCase() + a.health.slice(1)}
          {s && !s.paused && s.progressPct !== undefined ? ` ${s.progressPct}%` : ""}
        </Pill>
        <ChevronDown
          className={cx("h-4 w-4 text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {s && (
        <div className="px-3 pb-2" data-testid="raid-sync">
          <div
            className="h-1.5 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-label={`${a.name} ${s.action}`}
            aria-valuenow={s.progressPct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cx(
                "h-full rounded-full transition-[width] duration-700",
                ["check", "repair", "scrub", "sync", "optimize"].includes(s.action)
                  ? "bg-gold"
                  : "bg-amber",
              )}
              style={{ width: `${s.progressPct ?? 0}%` }}
            />
          </div>
          <p className="mt-1 text-[0.76rem] text-faint">
            {s.paused
              ? `${checkNoun(a.tech)} paused at ${s.progressPct ?? 0}%.`
              : `${SYNC_WORDS[s.action] ?? s.action}: ${s.progressPct ?? 0}%${s.speedKiBs ? ` at ${Math.round(s.speedKiBs / 1024)} MB/s` : ""}${s.etaMinutes !== undefined ? `, about ${eta(s.etaMinutes)} left` : ""}.`}
          </p>
        </div>
      )}

      {open && (
        <div className="space-y-4 border-t border-line p-3">
          <p className="text-[0.84rem] text-muted">{a.healthText}</p>
          {a.managedElsewhere && (
            <p className="text-[0.84rem] text-muted" data-testid="raid-managed-elsewhere">
              {a.managedElsewhere.text}{" "}
              {a.managedElsewhere.url && (
                <a
                  href={a.managedElsewhere.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-gold underline"
                >
                  Open it
                </a>
              )}
            </p>
          )}
          {a.warnings.length > 0 && (
            <ul className="space-y-1" data-testid="raid-warnings">
              {a.warnings.map((w, i) => (
                <li key={i} className="flex gap-2 text-[0.82rem] text-amber">
                  <AlertTriangle strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" /> {w}
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
            <Stat
              label="Usable"
              value={size(a.sizeBytes)}
              sub={used !== undefined ? `${used}% used` : a.mount ? undefined : "not mounted"}
            />
            <Stat
              label="Raw"
              value={size(a.rawBytes)}
              sub={`${a.raidDevices ?? a.members.length} drives`}
            />
            <Stat
              label="Members"
              value={`${a.counts.active} active`}
              sub={[
                a.counts.failed && `${a.counts.failed} failed`,
                a.counts.missing && `${a.counts.missing} missing`,
                `${a.counts.spare} spare`,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            <Stat
              label="Can lose"
              value={
                a.canLose === undefined ? "?" : `${a.canLose} drive${a.canLose === 1 ? "" : "s"}`
              }
              sub="before data is lost"
            />
          </div>
          {a.lastCheck && (
            <p className="text-[0.8rem] text-muted" data-testid="raid-last-check">
              {a.lastCheck.text}
            </p>
          )}

          <Members a={a} here={here} r={r} />

          <ActionGroups a={a} r={r} here={here} onChanged={onChanged} />

          {a.notes && a.notes.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[0.78rem] text-muted">
                What {RAID_TECH_NAME[a.tech]} itself says
              </summary>
              <ul className="mt-1 space-y-1 text-[0.78rem] text-faint">
                {a.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex flex-wrap gap-2">
            {a.health !== "healthy" && (
              <Ask
                q={`My ${what} ${a.name} (${levelOf(a)}) on ${r.host} is ${a.health}. Look at it with storage_raid, tell me why, what the risks are, and plan the fix.`}
                label={`Why is it ${a.health}?`}
              />
            )}
            <Ask
              q={`Look at my ${what} ${a.name} on ${r.host} with storage_raid and tell me how it is doing and anything I should do.`}
              label="Ask Ember about it"
            />
            <button
              type="button"
              className={btn}
              onClick={() => download(a, r)}
              data-testid="raid-export"
            >
              <Download className="h-3.5 w-3.5" /> Recovery info
            </button>
          </div>
          <p className="text-[0.74rem] text-faint">
            {[
              a.uuid && `${a.tech === "mdadm" ? "UUID" : "ID"} ${a.uuid}`,
              a.toolVersion && `${RAID_TECH_NAME[a.tech]} ${a.toolVersion}`,
              a.metadata && `metadata ${a.metadata}`,
              a.chunkKiB && `chunk ${a.chunkKiB} KiB`,
              a.tech !== "mdadm" && a.layout,
              a.bitmap && `bitmap ${a.bitmap === "none" ? "none" : "internal"}`,
              a.inConfig !== undefined && (a.inConfig ? "in mdadm.conf" : "not in mdadm.conf"),
              a.mismatches !== undefined && `${a.mismatches} mismatches at the last check`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {act("identify") && (
            <p className="text-[0.74rem] text-faint">{act("identify")!.reason}</p>
          )}
        </div>
      )}
    </section>
  );
}

function memberDetail(m: RaidMember, tech: RaidTech) {
  if (!m.device) return "This slot has no drive: the array runs without its protection.";
  return [
    m.model,
    m.serial && `serial ${m.serial}`,
    m.sizeBytes && size(m.sizeBytes),
    m.transport?.toUpperCase(),
    m.freeBytes !== undefined && tech === "snapraid" && `${size(m.freeBytes)} free`,
    tech === "mdadm"
      ? m.errors && `${m.errors} corrected read errors`
      : m.errorCounts &&
        Object.entries(m.errorCounts)
          .filter(([, n]) => n)
          .map(([k, n]) => `${n} ${k} errors`)
          .join(", "),
    tech !== "mdadm" &&
      tech !== "snapraid" &&
      m.stateText &&
      !/^(ONLINE|Healthy, OK, Auto-Select)$/.test(m.stateText) &&
      m.stateText,
    tech === "snapraid" && m.path,
  ]
    .filter(Boolean)
    .join(" · ");
}

function Members({ a, r, here }: { a: RaidArray; r: RaidReport; here: boolean }) {
  // Grouped when the technology has groups (ZFS vdevs, a SnapRAID array's data and parity).
  const names = [...new Set(a.members.map((m) => m.group ?? ""))];
  const grouped = names.length > 1 || (names[0] && a.tech !== "storage-spaces");
  const info = (n: string) => a.groups?.find((g) => g.name === n);
  return (
    <div>
      <Eyebrow>{a.tech === "mdadm" ? "Members" : "Drives"}</Eyebrow>
      <ul className="divide-y divide-line rounded-xl border border-line" data-testid="raid-members">
        {names.map((n) => (
          <li key={n || "all"}>
            {grouped && n && (
              <p className="flex flex-wrap gap-x-2 bg-bg/40 px-2.5 py-1.5 text-[0.76rem] text-faint">
                <span className="text-ink">{n}</span>
                {info(n)?.level && <span>{levelName(info(n)!.level)}</span>}
                {info(n)?.stateText && <span>{info(n)!.stateText}</span>}
              </p>
            )}
            <ul className="divide-y divide-line">
              {a.members
                .filter((m) => (m.group ?? "") === n)
                .map((m, i) => (
                  <li
                    key={m.device ?? `missing-${i}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5 text-[0.84rem]"
                    data-testid="raid-member"
                    data-role={m.role}
                    data-device={m.device}
                  >
                    {a.tech === "mdadm" && (
                      <span className="w-8 shrink-0 text-[0.74rem] text-faint tabular">
                        {m.slot !== undefined ? `#${m.slot}` : "–"}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">
                        {m.name && a.tech === "snapraid" ? `${m.name} · ` : ""}
                        {m.device ? driveLabel(m.device) : "Missing member"}
                      </span>
                      <span className="block text-[0.74rem] text-faint">
                        {memberDetail(m, a.tech)}
                      </span>
                    </span>
                    <span className={cx("text-[0.78rem]", ROLE_TONE[m.role])}>
                      {ROLE_WORDS[m.role]}
                    </span>
                    {here && <MemberActions a={a} m={m} r={r} />}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The changes made from a member's own row, by technology. */
function MemberActions({ a, m, r }: { a: RaidArray; m: RaidMember; r: RaidReport }) {
  const c = useConfirmedChange(HOST);
  const [guide, setGuide] = useState(false);
  if (!m.device) return null;
  const act = (id: RaidActionId) => a.actions.find((x) => x.id === id);
  const plan = (params: StepParams, title: string) =>
    void c.propose("storage-raid", { arrayId: a.id, ...params }, title);
  const button = (
    id: RaidActionId,
    label: string,
    params: StepParams,
    title: string,
    testId?: string,
  ) => {
    const x = act(id);
    if (!x) return null;
    return (
      <button
        type="button"
        className={btn}
        disabled={x.status !== "available"}
        title={x.status !== "available" ? x.reason : x.risk}
        data-testid={testId}
        onClick={() => plan(params, title)}
      >
        {label}
      </button>
    );
  };
  const failedish = ["faulty", "missing", "offline"].includes(m.role);
  const replace = act("replace");
  const mdFailed = a.tech === "mdadm" && m.role === "faulty";
  const add = act("add-disk");
  const canReplace =
    a.tech === "mdadm"
      ? (m.role === "active" || m.role === "write-mostly") && replace
      : ["active", "faulty", "missing", "offline", "retired"].includes(m.role) &&
        replace &&
        a.tech !== "snapraid";
  const inMirror =
    a.tech === "zfs" &&
    /^mirror-/.test(m.group ?? "") &&
    a.members.filter((x) => x.group === m.group).length > 1;
  return (
    <span className="flex w-full flex-wrap gap-2 sm:w-auto">
      {a.tech === "mdadm" && (m.role === "faulty" || m.role === "spare") && (
        <button
          type="button"
          className={btn}
          data-testid="raid-remove"
          onClick={() =>
            plan({ action: "remove", device: m.device! }, `Remove ${m.device} from ${a.name}`)
          }
        >
          Remove
        </button>
      )}
      {mdFailed && add?.status === "available" && (
        <button
          type="button"
          className={btn}
          onClick={() => setGuide(!guide)}
          data-testid="raid-replace-failed"
        >
          Replace…
        </button>
      )}
      {canReplace && (
        <button
          type="button"
          className={btn}
          disabled={replace!.status !== "available"}
          title={replace!.status !== "available" ? replace!.reason : undefined}
          onClick={() => setGuide(!guide)}
          data-testid={failedish ? "raid-replace-failed" : "raid-replace"}
        >
          Replace…
        </button>
      )}
      {a.tech === "mdadm" &&
        (m.role === "active" || m.role === "write-mostly") &&
        button(
          "mark-failed",
          "Mark failed",
          { action: "mark-failed", device: m.device },
          `Mark ${m.device} failed in ${a.name}`,
          "raid-mark-failed",
        )}
      {a.tech === "zfs" && (
        <>
          {m.role === "active" &&
            m.group !== "cache" &&
            button(
              "mark-failed",
              "Take offline",
              { action: "mark-failed", device: m.device },
              `Take ${m.device} offline in ${a.name}`,
              "raid-mark-failed",
            )}
          {m.role === "offline" &&
            button(
              "re-add",
              "Bring online",
              { action: "re-add", device: m.device },
              `Bring ${m.device} back online in ${a.name}`,
              "raid-online",
            )}
          {m.role === "spare" &&
            button(
              "remove-spare",
              "Remove",
              { action: "remove-spare", device: m.device },
              `Remove the spare ${m.device} from ${a.name}`,
              "raid-remove",
            )}
          {inMirror &&
            m.role === "active" &&
            button(
              "remove",
              "Detach",
              { action: "remove", device: m.device },
              `Detach ${m.device} from its mirror in ${a.name}`,
              "raid-detach",
            )}
        </>
      )}
      {a.tech === "storage-spaces" && (
        <>
          {m.role === "active" &&
            button(
              "mark-failed",
              "Retire",
              { action: "mark-failed", device: m.device },
              `Retire ${m.serial ?? m.device} in ${a.name}`,
              "raid-mark-failed",
            )}
          {m.role === "retired" &&
            button(
              "re-add",
              "Put back",
              { action: "re-add", device: m.device },
              `Put ${m.serial ?? m.device} back in use in ${a.name}`,
              "raid-online",
            )}
          {["retired", "missing", "spare"].includes(m.role) &&
            button(
              "remove",
              "Remove",
              { action: "remove", device: m.device },
              `Remove ${m.serial ?? m.device} from ${a.name}`,
              "raid-remove",
            )}
        </>
      )}
      {a.tech === "snapraid" &&
        m.role === "data" &&
        button(
          "fix",
          "Rebuild from parity…",
          { action: "fix", disk: m.name ?? "" },
          `Rebuild ${m.name ?? m.device}'s files from parity`,
          "raid-fix",
        )}
      {guide && (
        <span className="w-full">
          <DrivePicker
            a={a}
            r={r}
            min={
              a.tech === "mdadm" ? a.memberSizeBytes : a.tech === "zfs" ? m.sizeBytes : undefined
            }
            wholeOnly={a.tech === "zfs" || a.tech === "storage-spaces"}
            intro={replaceIntro(a, m)}
            onPick={(d, erase) =>
              mdFailed
                ? plan(
                    { action: "add-disk", device: d.device, ...(erase ? { erase: true } : {}) },
                    `Rebuild ${a.name} onto ${d.device}`,
                  )
                : plan(
                    {
                      action: "replace",
                      device: d.device,
                      replaces: m.device!,
                      ...(erase ? { erase: true } : {}),
                    },
                    `Replace ${m.device} with ${d.device} in ${a.name}`,
                  )
            }
          />
        </span>
      )}
      <span className="w-full empty:hidden">
        <RaidChange c={c} />
      </span>
    </span>
  );
}

function replaceIntro(a: RaidArray, m: RaidMember) {
  const who = `${m.device}${m.serial ? ` (serial ${m.serial})` : ""}`;
  if (a.tech === "mdadm")
    return m.role === "faulty"
      ? `Replacing failed ${who}: the new drive is added and rebuilt from the others; then remove the failed one and take it out of the machine (match the serial on its label).`
      : `Replacing working ${who}: the new drive is copied while the old one stays in, so protection is kept throughout. When it finishes, the old one is marked failed for removal.`;
  if (a.tech === "zfs")
    return ["faulty", "missing", "offline"].includes(m.role)
      ? `Replacing ${who}: ZFS rebuilds (resilvers) the new drive from the others. Then take the old one out (match the serial on its label).`
      : `Replacing working ${who}: ZFS copies it to the new drive while it stays in the pool, so protection is kept throughout, then lets it go.`;
  return `Replacing ${who}: the new drive joins the pool, the old one is retired, and Windows repairs the space onto the new one. Remove the old one once the repair finishes.`;
}

/**
 * The plan waiting for your OK: the exact host, array and drives, and what it risks (which
 * drives it erases, what cannot be undone), shown before Confirm. Then the outcome.
 */
function RaidChange({ c }: { c: ReturnType<typeof useConfirmedChange> }) {
  const step = c.job?.steps[0];
  return (
    <div className="space-y-1.5">
      {c.job?.status === "awaiting-approval" && step && (
        <div
          className="rounded-lg border border-line p-2 text-[0.8rem]"
          data-testid="raid-plan-details"
        >
          <p
            className={
              /ERASES|cannot be undone/i.test(step.policyReason) ? "text-alert" : "text-muted"
            }
          >
            {step.policyReason}
          </p>
          <p className="mt-1 text-faint">Checked afterwards: {step.verify}</p>
          <p className="text-faint">Undo: {step.rollback}</p>
        </div>
      )}
      <ChangeCard c={c} />
    </div>
  );
}

/** Choose a free drive: only ones big enough; one with data asks you to type its serial first. */
function DrivePicker({
  a,
  r,
  min,
  wholeOnly,
  intro,
  onPick,
}: {
  a?: RaidArray;
  r: RaidReport;
  min?: number;
  /** ZFS and Storage Spaces take whole drives, not partitions. */
  wholeOnly?: boolean;
  intro?: string;
  onPick: (c: RaidCandidate, erase: boolean) => void;
}) {
  const options = r.candidates.filter(
    (c) =>
      c.state !== "excluded" &&
      (!min || (c.sizeBytes ?? 0) >= min) &&
      (!wholeOnly || c.kind === "disk"),
  );
  const [pick, setPick] = useState<string>();
  const [typed, setTyped] = useState("");
  const c = options.find((x) => x.device === pick);
  const needsErase = c?.state === "has-data";
  const confirmed =
    !needsErase ||
    (c?.serial ? typed.trim() === c.serial.slice(-4) : typed.trim().toUpperCase() === "ERASE");
  return (
    <div
      className="mt-2 space-y-2 rounded-xl border border-line p-3 text-[0.84rem]"
      data-testid="raid-drive-picker"
    >
      {intro && <p className="text-muted">{intro}</p>}
      {options.length ? (
        <fieldset className="space-y-1.5">
          <legend className="sr-only">Choose a drive</legend>
          {options.map((o) => (
            <label key={o.device} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name={`pick-${a?.id ?? "new"}`}
                value={o.device}
                checked={pick === o.device}
                onChange={() => {
                  setPick(o.device);
                  setTyped("");
                }}
                className="mt-1"
              />
              <span>
                <span className="text-ink">{driveLabel(o.device)}</span>{" "}
                <span className="text-faint">
                  {[o.model, o.serial && `serial ${o.serial}`, size(o.sizeBytes)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {o.state === "has-data" && (
                  <span className="block text-[0.78rem] text-amber">{o.reason}</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-amber">
          No free drive {min ? `of at least ${size(min)} ` : ""}is connected. Drives holding the
          system, in use, or already in an array or pool are never offered.
        </p>
      )}
      {needsErase && (
        <label className="block text-[0.82rem] text-amber">
          {c?.device} holds data that would be erased. To confirm it is this drive, type{" "}
          {c?.serial ? `the last 4 characters of its serial (${c.serial})` : "ERASE"}:
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="mt-1 block w-40 rounded-lg border border-line-strong bg-transparent px-2 py-1 text-ink"
            data-testid="raid-erase-confirm"
            aria-label="Confirm erasing"
          />
        </label>
      )}
      <Button
        tone="primary"
        disabled={!c || !confirmed}
        onClick={() => c && onPick(c, Boolean(needsErase))}
        data-testid="raid-plan"
      >
        Plan it
      </Button>
    </div>
  );
}

const GROUPS: { title: string; ids: RaidActionId[] }[] = [
  {
    title: "Maintenance",
    ids: [
      "sync",
      "check",
      "repair",
      "fix",
      "pause-check",
      "resume-check",
      "cancel-check",
      "clear-errors",
      "rebalance",
      "diff",
      "speed",
      "schedule-check",
    ],
  },
  {
    title: "Members",
    ids: ["add-disk", "add-spare", "remove-spare", "re-add", "replace", "mark-failed", "remove"],
  },
  { title: "Capacity", ids: ["grow-devices", "grow-size", "grow-filesystem", "change-level"] },
  { title: "Configuration", ids: ["save-config"] },
];

/** SnapRAID's differences since the last sync: read on request, nothing changed. */
function SnapDiff() {
  const [go, setGo] = useState(false);
  const pc = useStoragePc();
  const q = useQuery({
    queryKey: ["snapraid-diff", pc],
    queryFn: () =>
      api<{ ok: boolean; text: string; files?: string[] }>(
        "GET",
        onPc(pc, "/api/storage-center/raid/snapraid-diff"),
      ),
    enabled: go,
    staleTime: 60_000,
  });
  return (
    <div className="mt-2 text-[0.8rem]" data-testid="raid-snapraid-diff">
      {!go ? (
        <button
          type="button"
          className={btn}
          onClick={() => setGo(true)}
          data-testid="raid-diff-run"
        >
          Show the changes
        </button>
      ) : q.isFetching ? (
        <p className="text-faint">SnapRAID is comparing the drives with its last sync…</p>
      ) : q.data ? (
        <>
          <p className={q.data.ok ? "text-muted" : "text-amber"}>{q.data.text}</p>
          {q.data.files && q.data.files.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-auto font-mono text-[0.72rem] text-faint">
              {q.data.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-amber">{q.error?.message ?? "No answer."}</p>
      )}
    </div>
  );
}

/** Actions planned with one click (no choices to make). */
const INLINE: RaidActionId[] = [
  "check",
  "repair",
  "pause-check",
  "resume-check",
  "cancel-check",
  "grow-size",
  "grow-filesystem",
  "save-config",
  "clear-errors",
  "rebalance",
  "sync",
];

/** Actions made from a member's own row, so they are not repeated here while available. */
function memberOnly(tech: RaidTech): RaidActionId[] {
  if (tech === "mdadm") return ["replace", "mark-failed", "remove"];
  if (tech === "snapraid") return ["fix"];
  return ["replace", "mark-failed", "remove", "re-add", "remove-spare"];
}
function withDrive(tech: RaidTech): RaidActionId[] {
  return tech === "mdadm"
    ? ["add-disk", "add-spare", "re-add", "grow-devices"]
    : ["add-spare", "grow-devices"];
}

function ActionGroups({
  a,
  r,
  here,
  onChanged,
}: {
  a: RaidArray;
  r: RaidReport;
  here: boolean;
  onChanged: () => void;
}) {
  const own = memberOnly(a.tech);
  return (
    <div className="space-y-3" data-testid="raid-actions">
      {GROUPS.map((g) => {
        const list = g.ids
          .map((id) => a.actions.find((x) => x.id === id))
          .filter((x): x is RaidAction => Boolean(x))
          .filter((x) => !own.includes(x.id) || x.status !== "available");
        if (!list.length) return null;
        return (
          <div key={g.title}>
            <Eyebrow>{g.title}</Eyebrow>
            <ul className="space-y-1.5">
              {list.map((x) => (
                <ActionRow key={x.id} a={a} r={r} x={x} here={here} onChanged={onChanged} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** What a Btrfs filesystem can be converted to, in words. */
const BTRFS_PROFILES: [string, string][] = [
  ["raid1", "RAID 1 (two copies)"],
  ["raid1c3", "RAID 1C3 (three copies, 3+ drives)"],
  ["raid1c4", "RAID 1C4 (four copies, 4+ drives)"],
  ["raid10", "RAID 10 (two copies, striped, 4+ drives)"],
  ["single", "Single (no redundancy)"],
];

/** How often each technology's schedule can run. */
function scheduleOptions(t: RaidTech): [string, string][] {
  return t === "snapraid"
    ? [
        ["daily", "Every night (02:00)"],
        ["weekly", "Weekly (Sunday, 02:00)"],
      ]
    : [
        ["monthly", "Monthly (first Sunday, 02:00)"],
        ["weekly", "Weekly (Sunday, 02:00)"],
      ];
}

function ActionRow({
  a,
  r,
  x,
  here,
}: {
  a: RaidArray;
  r: RaidReport;
  x: RaidAction;
  here: boolean;
  onChanged: () => void;
}) {
  const c = useConfirmedChange(HOST);
  const [open, setOpen] = useState(false);
  const [minKiB, setMin] = useState(a.speedLimit?.minKiBs ?? 1000);
  const [maxKiB, setMax] = useState(a.speedLimit?.maxKiBs ?? 200000);
  const options = scheduleOptions(a.tech);
  const [every, setEvery] = useState<string>(options[0]![0]);
  const [profile, setProfile] = useState<string>(a.level === "btrfs-raid1c3" ? "raid1" : "raid1c3");
  const plan = (params: StepParams, title: string) =>
    void c.propose("storage-raid", { arrayId: a.id, action: x.id, ...params }, title);
  const can = here && x.status === "available";
  const mine = memberOnly(a.tech).includes(x.id);
  const noun = checkNoun(a.tech).toLowerCase();
  return (
    <li
      className="rounded-lg border border-line p-2.5"
      data-testid="raid-action"
      data-action={x.id}
      data-status={x.status}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 text-[0.86rem] text-ink">{x.label}</span>
        <span
          className={cx(
            "text-[0.74rem]",
            x.status === "available"
              ? "text-live"
              : x.status === "running"
                ? "text-gold"
                : x.status === "blocked"
                  ? "text-amber"
                  : "text-faint",
          )}
        >
          {STATUS_WORDS[x.status]}
        </span>
        {can &&
          !mine &&
          x.id !== "diff" &&
          (INLINE.includes(x.id) ? (
            <button
              type="button"
              className={btn}
              data-testid={`raid-do-${x.id}`}
              onClick={() => plan({}, `${x.label}: ${a.name}`)}
            >
              Plan…
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              data-testid={`raid-open-${x.id}`}
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              {open ? "Close" : "Set up…"}
            </button>
          ))}
      </div>
      {(x.reason || (x.status === "available" && x.risk)) && (
        <p className="mt-1 text-[0.78rem] text-muted">
          {x.reason}
          {x.status === "available" && x.risk ? `${x.reason ? " " : ""}${x.risk}` : ""}
          {x.irreversible ? " Cannot be undone." : ""}
        </p>
      )}
      {open && withDrive(a.tech).includes(x.id) && (
        <DrivePicker
          a={a}
          r={r}
          {...(a.tech === "mdadm" && a.memberSizeBytes ? { min: a.memberSizeBytes } : {})}
          wholeOnly={a.tech === "zfs" || a.tech === "storage-spaces"}
          onPick={(d, erase) =>
            plan(
              { device: d.device, ...(erase ? { erase: true } : {}) },
              `${x.label}: ${a.name} with ${d.device}`,
            )
          }
        />
      )}
      {open && x.id === "grow-devices" && a.tech === "mdadm" && a.counts.spare > 0 && (
        <button
          type="button"
          className={cx(btn, "mt-2")}
          onClick={() => plan({}, `Grow ${a.name} using its spare`)}
        >
          Use the spare already in it
        </button>
      )}
      {x.id === "diff" && here && <SnapDiff />}
      {open && x.id === "change-level" && a.tech === "btrfs" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.82rem]">
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="rounded-lg border border-line-strong bg-transparent px-2 py-1"
            aria-label="Convert to"
          >
            {BTRFS_PROFILES.filter(([v]) => `btrfs-${v}` !== a.level).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={btn}
            data-testid="raid-convert"
            onClick={() => plan({ profile }, `Convert ${a.name} to ${profile}`)}
          >
            Plan…
          </button>
        </div>
      )}
      {open && x.id === "speed" && (
        <div className="mt-2 flex flex-wrap items-end gap-3 text-[0.82rem]">
          <label>
            At least (MB/s)
            <input
              type="number"
              min={1}
              className="mt-1 block w-28 rounded-lg border border-line-strong bg-transparent px-2 py-1"
              value={Math.round(minKiB / 1024)}
              onChange={(e) => setMin(Math.max(100, Number(e.target.value) * 1024))}
            />
          </label>
          <label>
            At most (MB/s)
            <input
              type="number"
              min={1}
              className="mt-1 block w-28 rounded-lg border border-line-strong bg-transparent px-2 py-1"
              value={Math.round(maxKiB / 1024)}
              onChange={(e) => setMax(Math.max(100, Number(e.target.value) * 1024))}
            />
          </label>
          <button
            type="button"
            className={btn}
            onClick={() =>
              plan({ minKiBs: minKiB, maxKiBs: maxKiB }, `Set ${a.name}'s rebuild speed`)
            }
          >
            Plan…
          </button>
          <button
            type="button"
            className={btn}
            onClick={() =>
              plan(
                { minKiBs: "system", maxKiBs: "system" },
                `Use the system's rebuild speed for ${a.name}`,
              )
            }
          >
            Back to the system's
          </button>
        </div>
      )}
      {open && x.id === "schedule-check" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.82rem]">
          <select
            value={every}
            onChange={(e) => setEvery(e.target.value)}
            className="rounded-lg border border-line-strong bg-transparent px-2 py-1"
            aria-label="How often"
          >
            {options.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
            <option value="off">Off</option>
          </select>
          <button
            type="button"
            className={btn}
            data-testid="raid-schedule"
            onClick={() => plan({ every }, `Schedule ${noun}s of ${a.name}: ${every}`)}
          >
            Plan…
          </button>
          {r.schedules.some(
            (s) =>
              s.by === "system" &&
              (!s.arrayId || s.arrayId === a.id) &&
              (a.tech === "zfs" ? /scrub/i.test(s.text) : /check/i.test(s.text)),
          ) && (
            <span className="text-faint">
              The system already {a.tech === "zfs" ? "scrubs pools" : "checks arrays"} on its own;
              Hearth's schedule is in addition.
            </span>
          )}
        </div>
      )}
      <div className="mt-2 empty:hidden">
        <RaidChange c={c} />
      </div>
    </li>
  );
}

/** A new array or pool: which technology, which drives, which layout, its name. */
function CreateArray({ r }: { r: RaidReport }) {
  const options = r.create ?? [];
  const [open, setOpen] = useState(false);
  const [tech, setTech] = useState<RaidTech | undefined>(options[0]?.tech);
  const option: RaidCreateOption | undefined = options.find((o) => o.tech === tech) ?? options[0];
  const whole = option?.tech === "zfs" || option?.tech === "storage-spaces";
  const free = r.candidates.filter((c) => c.state !== "excluded" && (!whole || c.kind === "disk"));
  const [chosen, setChosen] = useState<string[]>([]);
  const [level, setLevel] = useState<string>(option?.levels[0]?.id ?? "raid1");
  const [name, setName] = useState("");
  const [mkfs, setMkfs] = useState(true);
  const [fs, setFs] = useState("ntfs");
  const [typed, setTyped] = useState("");
  const c = useConfirmedChange(HOST);
  if (!option || (!r.candidates.some((x) => x.state !== "excluded") && !open)) return null;
  const picked = free.filter((x) => chosen.includes(x.device));
  const withData = picked.filter((x) => x.state === "has-data");
  const sizes = picked.map((x) => x.sizeBytes ?? 0);
  const levels = option.levels.map((l) => ({
    ...l,
    ok: picked.length >= l.min,
    usable: raidUsableBytes(l.id, sizes),
    lose: raidTolerance(l.id, picked.length) ?? l.tolerance,
  }));
  const ready0 = readyFor(r, option.tech);
  const lv = option.levels.find((l) => l.id === level) ?? option.levels[0]!;
  const namePattern =
    option.tech === "zfs"
      ? /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/
      : option.tech === "storage-spaces"
        ? /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/
        : /^[A-Za-z0-9_-]{1,32}$/;
  const ready =
    picked.length >= lv.min &&
    namePattern.test(name) &&
    (!withData.length || typed.trim().toUpperCase() === "ERASE");
  const switchTo = (t: RaidTech) => {
    const o = options.find((x) => x.tech === t);
    setTech(t);
    setLevel(o?.levels[0]?.id ?? "");
    setChosen([]);
  };
  return (
    <section className="rounded-xl border border-line" data-testid="raid-create">
      <button
        type="button"
        className="flex w-full items-center gap-2 p-3 text-left text-[0.9rem] text-ink"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <Plus className="h-4 w-4 text-gold" /> Create a new array or pool
        <span className="ml-auto text-[0.76rem] text-faint">
          {free.length} free drive{free.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line p-3 text-[0.84rem]">
          <p className="text-muted">
            An array joins drives so one (or more) can fail without losing data.{" "}
            <span className="text-ink">RAID is not a backup:</span> a deleted, overwritten, or
            encrypted file is gone from every drive at once, and a fire or theft takes them all.
            Keep a copy elsewhere too.
          </p>
          {!ready0.ready && <p className="text-amber">{ready0.why}</p>}
          {options.length > 1 && (
            <fieldset>
              <legend className="mb-1 text-[0.76rem] text-faint uppercase">Kind</legend>
              <div className="flex flex-wrap gap-2">
                {options.map((o) => (
                  <label
                    key={o.tech}
                    className={cx(
                      "flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5",
                      option.tech === o.tech ? "border-gold/60" : "border-line",
                    )}
                  >
                    <input
                      type="radio"
                      name="raid-tech"
                      checked={option.tech === o.tech}
                      onChange={() => switchTo(o.tech)}
                      data-testid={`raid-create-tech-${o.tech}`}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <fieldset>
            <legend className="mb-1 text-[0.76rem] text-faint uppercase">
              1. Drives (every one is erased{whole ? "; whole drives only" : ""})
            </legend>
            {free.map((x) => (
              <label key={x.device} className="flex cursor-pointer items-start gap-2 py-0.5">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={chosen.includes(x.device)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked
                        ? [...chosen, x.device]
                        : chosen.filter((d) => d !== x.device),
                    )
                  }
                  data-testid="raid-create-drive"
                />
                <span>
                  <span className="text-ink">{driveLabel(x.device)}</span>{" "}
                  <span className="text-faint">
                    {[x.model, x.serial && `serial ${x.serial}`, size(x.sizeBytes)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {x.state === "has-data" && (
                    <span className="block text-[0.78rem] text-amber">{x.reason}</span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-[0.76rem] text-faint uppercase">2. Layout</legend>
            <div className="grid gap-1.5 @md:grid-cols-2">
              {levels.map((o) => (
                <label
                  key={o.id}
                  className={cx(
                    "flex cursor-pointer gap-2 rounded-lg border p-2",
                    level === o.id ? "border-gold/60" : "border-line",
                    !o.ok && "opacity-50",
                  )}
                >
                  <input
                    type="radio"
                    name="raid-level"
                    checked={level === o.id}
                    disabled={!o.ok}
                    onChange={() => setLevel(o.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-ink">{o.label}</span>{" "}
                    <span className="text-faint">needs {o.min}+</span>
                    <span className="block text-[0.78rem] text-muted">
                      {o.words}
                      {o.ok
                        ? ` ${size(o.usable)} usable; survives ${o.lose} drive failure${o.lose === 1 ? "" : "s"}.`
                        : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block">
            <span className="text-[0.76rem] text-faint uppercase">3. Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={option.tech === "zfs" ? "tank" : "media"}
              className="mt-1 block w-48 rounded-lg border border-line-strong bg-transparent px-2 py-1"
              data-testid="raid-create-name"
            />
          </label>
          {option.tech === "mdadm" && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={mkfs} onChange={(e) => setMkfs(e.target.checked)} />{" "}
              Also make an empty ext4 filesystem on it (mounting it is a separate step)
            </label>
          )}
          {option.filesystems && option.tech !== "mdadm" && (
            <label className="flex flex-wrap items-center gap-2">
              Filesystem
              <select
                value={fs}
                onChange={(e) => setFs(e.target.value)}
                className="rounded-lg border border-line-strong bg-transparent px-2 py-1"
              >
                {option.filesystems.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {option.note && <p className="text-[0.8rem] text-faint">{option.note}</p>}
          {picked.length > 0 && (
            <p
              className="rounded-lg border border-alert/40 p-2 text-alert"
              data-testid="raid-create-erase"
            >
              Erases everything on{" "}
              {picked.map((x) => `${x.device}${x.serial ? ` (${x.serial})` : ""}`).join(", ")}.
              {withData.length
                ? ` ${withData.map((x) => `${x.device}: ${x.reason ?? "holds data"}`).join(" ")}`
                : ""}
            </p>
          )}
          {withData.length > 0 && (
            <label className="block text-amber">
              Some of these hold data. Type ERASE to confirm:
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="mt-1 block w-40 rounded-lg border border-line-strong bg-transparent px-2 py-1 text-ink"
                aria-label="Type ERASE"
              />
            </label>
          )}
          <Button
            tone="primary"
            disabled={!ready || !ready0.ready}
            data-testid="raid-create-plan"
            onClick={() =>
              void c.propose(
                "storage-raid",
                {
                  action: "create",
                  tech: option.tech,
                  level: lv.id,
                  name,
                  devices: picked.map((x) => x.device).join(","),
                  ...(withData.length
                    ? { eraseDevices: withData.map((x) => x.device).join(",") }
                    : {}),
                  ...(option.tech === "mdadm" ? { mkfs: mkfs ? "ext4" : "none" } : {}),
                  ...(option.tech === "storage-spaces" ? { fs } : {}),
                },
                `Create ${lv.label} "${name}"`,
              )
            }
          >
            Plan it
          </Button>
          <RaidChange c={c} />
        </div>
      )}
    </section>
  );
}

function Candidates({ r }: { r: RaidReport }) {
  if (!r.candidates.length) return null;
  return (
    <details data-testid="raid-candidates">
      <summary className="cursor-pointer text-[0.78rem] text-muted">
        Drives Hearth could use for arrays (
        {r.candidates.filter((c) => c.state !== "excluded").length} free of {r.candidates.length})
      </summary>
      <ul className="mt-1 space-y-1 text-[0.8rem]">
        {r.candidates.map((c) => (
          <li key={c.device} className="flex flex-wrap gap-x-2">
            <span className="text-ink">{driveLabel(c.device)}</span>
            <span className="text-faint">
              {[c.model, c.serial && `serial ${c.serial}`, size(c.sizeBytes)]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span
              className={
                c.state === "usable"
                  ? "text-live"
                  : c.state === "has-data"
                    ? "text-amber"
                    : "text-faint"
              }
            >
              {c.state === "usable" ? "free" : c.state === "has-data" ? "holds data" : "not usable"}
              {c.reason ? `: ${c.reason}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** How to find and bring the array back by hand, by technology. */
function recoveryLines(a: RaidArray): string[] {
  if (a.tech === "zfs")
    return [
      `Import it on any machine with ZFS (as root): zpool import ${a.name}`,
      `If it was not exported cleanly: zpool import -f ${a.name}`,
      `Its state, and any damaged files: zpool status -v ${a.name}`,
    ];
  if (a.tech === "storage-spaces")
    return [
      `In PowerShell as administrator: Get-StoragePool -FriendlyName "${a.name}" | Get-VirtualDisk`,
      `A detached space comes back with: Get-VirtualDisk | Where-Object OperationalStatus -eq Detached | Connect-VirtualDisk`,
      `The drives can move to another Windows PC together; the pool appears there on its own.`,
    ];
  if (a.tech === "snapraid")
    return [
      `Its configuration is snapraid.conf; keep a copy of it and of a content file.`,
      `A lost drive: mount an empty drive where it was, then: snapraid -d <name> -l fix.log fix`,
      `What changed since the last sync: snapraid diff`,
    ];
  const hex = a.uuid?.replace(/[^0-9a-f]/gi, "");
  return [
    hex && hex.length === 32
      ? `mdadm.conf line: ARRAY ${a.device} metadata=${a.metadata ?? "1.2"} UUID=${hex.match(/.{8}/g)!.join(":")}`
      : "",
    `Reassemble by hand (as root): mdadm --assemble ${a.device} ${a.members
      .filter((m) => m.device && m.role !== "faulty")
      .map((m) => m.device)
      .join(" ")}`,
    `Its details (as root): mdadm --detail ${a.device}`,
  ];
}

/** A text file with what you need to rebuild or reassemble the array by hand. */
function download(a: RaidArray, r: RaidReport) {
  const lines = [
    `Hearth RAID recovery information`,
    `Machine: ${r.host}`,
    `Read: ${r.at}`,
    ``,
    `${RAID_TECH_NAME[a.tech]}: ${a.name}${a.device && a.device !== a.name ? ` (${a.device})` : ""}`,
    `Layout: ${levelOf(a)}${a.layout ? `, ${a.layout}` : ""}${a.chunkKiB ? `, chunk ${a.chunkKiB} KiB` : ""}`,
    ...(a.metadata ? [`Metadata: ${a.metadata}`] : []),
    `ID: ${a.uuid ?? "unknown"}`,
    `Health: ${a.health}. ${a.healthText}`,
    `Drives (${a.members.length}):`,
    ...a.members.map(
      (m) =>
        `  ${m.group ? `${m.group}: ` : m.slot !== undefined ? `slot ${m.slot}: ` : ""}${m.device ?? "missing"} ${m.role}${m.model ? ` ${m.model}` : ""}${m.serial ? ` serial ${m.serial}` : ""}`,
    ),
    ``,
    ...recoveryLines(a),
    ``,
    `RAID is not a backup. Keep this file somewhere other than this machine.`,
  ].filter((l) => l !== undefined);
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const el = document.createElement("a");
  el.href = url;
  el.download = `raid-${r.host}-${a.name}.txt`;
  el.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
