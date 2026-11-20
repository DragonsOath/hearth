import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api, useWorkspace } from "../../data/api";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Button, Skeleton, cx } from "../ui";

/**
 * qBittorrent's Settings: the seeding, speed, queue, connection and disk settings Hearth may
 * change, edited in place. Only what you changed goes into one plan, with each before and after
 * (and a warning when a seeding limit would remove torrents); nothing changes until you approve it.
 * Ports, proxies, the Web UI login, privacy settings and save paths stay in qBittorrent (Sonarr and
 * Radarr depend on them), linked here.
 */

interface Setting {
  key: string;
  label: string;
  value: boolean | number;
  shown: string;
  type: "bool" | "number" | "int";
  unit?: string;
  note?: string;
}
interface View {
  settings: Setting[];
  categories: { name: string; savePath?: string }[];
  tags: string[];
  transfer: { alternativeLimits: boolean };
}

/** Speeds are bytes per second in qBittorrent's API and KiB/s on its own screens. */
const SPEED = /^(alt_)?(dl|up)_limit$/;
/** A field that only matters when its switch is on. */
const NEEDS: Record<string, string> = {
  max_ratio: "max_ratio_enabled",
  max_seeding_time: "max_seeding_time_enabled",
  max_inactive_seeding_time: "max_inactive_seeding_time_enabled",
  schedule_from_hour: "scheduler_enabled",
  schedule_from_min: "scheduler_enabled",
  schedule_to_hour: "scheduler_enabled",
  schedule_to_min: "scheduler_enabled",
  scheduler_days: "scheduler_enabled",
  max_active_downloads: "queueing_enabled",
  max_active_uploads: "queueing_enabled",
  max_active_torrents: "queueing_enabled",
  dont_count_slow_torrents: "queueing_enabled",
  slow_torrent_dl_rate_threshold: "dont_count_slow_torrents",
  slow_torrent_ul_rate_threshold: "dont_count_slow_torrents",
  slow_torrent_inactive_timer: "dont_count_slow_torrents",
};
const GROUPS: [string, RegExp][] = [
  ["Speed", /_limit$|schedul/],
  ["Seeding", /ratio|seeding/],
  ["Queue", /queue|active_|slow/],
  ["Connections", /^max_(connec|uploads)/],
  ["Disk", /preallocate|incomplete/],
];
const DAYS = [
  "Every day",
  "Weekdays",
  "Weekends",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const ACTS = [
  "Stop the torrent",
  "Remove the torrent (files stay)",
  "Super seeding",
  "Remove the torrent and delete its files",
];

const field =
  "min-h-9 w-32 rounded-lg border border-line bg-raised px-2 text-right text-[0.84rem] text-ink tabular disabled:opacity-50";

function Control({
  s,
  value,
  off,
  onChange,
}: {
  s: Setting;
  value: boolean | number;
  off: boolean;
  onChange: (v: boolean | number) => void;
}) {
  const target = `setting:${s.key}`;
  if (s.type === "bool")
    return (
      <input
        type="checkbox"
        checked={Boolean(value)}
        disabled={off}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={s.label}
        data-hearth-target={target}
        className="h-4 w-4"
      />
    );
  if (s.key === "max_ratio_act" || s.key === "scheduler_days")
    return (
      <select
        value={Number(value)}
        disabled={off}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={s.label}
        data-hearth-target={target}
        className={cx(field, "w-auto text-left")}
      >
        {(s.key === "max_ratio_act" ? ACTS : DAYS).map((label, i) => (
          <option key={label} value={i}>
            {label}
          </option>
        ))}
      </select>
    );
  const speed = SPEED.test(s.key);
  const shown = speed ? Math.round(Number(value) / 1024) : Number(value);
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        inputMode="decimal"
        step={s.type === "number" ? "0.01" : "1"}
        min={-1}
        value={Number.isFinite(shown) ? shown : 0}
        disabled={off}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(speed ? Math.round(n) * 1024 : s.type === "int" ? Math.round(n) : n);
        }}
        aria-label={s.label}
        data-hearth-target={target}
        className={field}
      />
      <span className="w-16 text-[0.74rem] text-faint">
        {speed ? "KiB/s" : s.unit === "minutes" ? "min" : (s.unit ?? "")}
      </span>
    </span>
  );
}

export function QbittorrentSettings({ serviceId, name, onGo }: AppViewProps) {
  // Under "dashboard" so a finished plan refreshes it with the rest of the panel.
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "qb-settings"],
    queryFn: () =>
      api<View>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/qbittorrent/settings`,
      ),
    staleTime: 15_000,
  });
  const act = useApproveHere(serviceId, "Proposed from qBittorrent's Settings tab.");
  const [draft, setDraft] = useState<Record<string, boolean | number>>({});
  // Once qBittorrent has the new values, edits equal to them no longer count as changes.
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const webUi = keyPageHref(service, "/");
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return (
      <p className="text-[0.86rem] text-amber">
        Could not read {name}&apos;s settings: {q.error?.message ?? "no answer"}
      </p>
    );
  const v = q.data;
  const base = Object.fromEntries(v.settings.map((s) => [s.key, s.value]));
  const value = (key: string) => (key in draft ? draft[key]! : base[key]!);
  const changed = Object.entries(draft).filter(([k, x]) => base[k] !== x);
  const deleting = value("max_ratio_act") === 3;
  return (
    <section className="@container space-y-4" aria-label={`${name} settings`}>
      <ApproveDialog c={act} />
      <div className="grid gap-4 @2xl:grid-cols-2">
        {GROUPS.map(([title]) => {
          // Each setting in the first group it fits ("inactive seeding" is Seeding, not Queue).
          const rows = v.settings.filter(
            (s) => GROUPS.find(([, re]) => re.test(s.key))?.[0] === title,
          );
          if (!rows.length) return null;
          return (
            <fieldset
              key={title}
              className="rounded-xl border border-line p-3"
              data-testid="qb-settings-group"
            >
              <legend className="eyebrow px-1">{title}</legend>
              {rows.map((s) => {
                const off = Boolean(NEEDS[s.key]) && !value(NEEDS[s.key]!);
                const edited = s.key in draft && base[s.key] !== draft[s.key];
                return (
                  <div
                    key={s.key}
                    className={cx(
                      "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line py-2 last:border-0",
                      off && "opacity-60",
                    )}
                  >
                    <span className="min-w-0 flex-1 text-[0.82rem] text-muted">
                      {s.label}
                      {edited && (
                        <span className="ml-1.5 text-[0.72rem] text-gold">(was {s.shown})</span>
                      )}
                    </span>
                    <Control
                      s={s}
                      value={value(s.key)}
                      off={off}
                      onChange={(x) => setDraft((d) => ({ ...d, [s.key]: x }))}
                    />
                  </div>
                );
              })}
              {title === "Speed" && (
                <p className="pt-2 text-[0.74rem] text-faint">
                  0 means no limit. The alternative limits are{" "}
                  {v.transfer.alternativeLimits ? "on now" : "off now"}.
                </p>
              )}
              {title === "Seeding" && deleting && (
                <p className="pt-2 text-[0.78rem] text-alert" data-testid="qb-delete-warning">
                  Every torrent that reaches a limit will be removed and its files deleted,
                  automatically and permanently.
                </p>
              )}
              {title === "Connections" && (
                <p className="pt-2 text-[0.74rem] text-faint">-1 means no limit.</p>
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel/95 p-3">
        <Button
          tone="primary"
          disabled={!changed.length || act.busy}
          data-hearth-target="settings:review"
          onClick={() =>
            void act.propose(
              "app-qbt-set-preferences",
              { preferences: JSON.stringify(Object.fromEntries(changed)) },
              `Change ${changed.length === 1 ? "a setting" : `${changed.length} settings`} in ${name}`,
            )
          }
        >
          Review {changed.length || ""} change{changed.length === 1 ? "" : "s"}
        </Button>
        {changed.length > 0 && (
          <Button tone="quiet" onClick={() => setDraft({})} data-hearth-target="settings:reset">
            Undo my edits
          </Button>
        )}
        {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      </div>
      <div className="rounded-xl border border-line p-3 text-[0.82rem]">
        <p className="eyebrow mb-1">Categories and tags</p>
        <p className="text-muted">
          {v.categories.length
            ? v.categories
                .map((c) => (c.savePath ? `${c.name} (${c.savePath})` : c.name))
                .join(", ")
            : "No categories"}
          {". "}
          {v.tags.length ? `Tags: ${v.tags.join(", ")}.` : "No tags."}
        </p>
        <p className="mt-1 text-[0.76rem] text-faint">
          A torrent&apos;s own category, tags and limits are changed from its row on{" "}
          <button
            type="button"
            className="text-gold underline-offset-2 hover:underline"
            onClick={() => onGo?.("overview")}
          >
            Overview
          </button>
          .
        </p>
      </div>
      <p className="text-[0.76rem] text-faint">
        Ports, proxies, the Web UI login, privacy settings and save paths stay in qBittorrent:
        Sonarr and Radarr depend on them, and they protect your connection.{" "}
        {webUi && (
          <a
            href={webUi}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
            data-testid="qb-open-webui"
          >
            Open qBittorrent <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}
