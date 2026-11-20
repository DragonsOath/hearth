import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api, useWorkspace } from "../../data/api";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Button, Skeleton, cx } from "../ui";

/**
 * Transmission's Settings: its speed limits (and the alternative "turtle" limits), seeding (share
 * ratio and idle limits), queue and peer settings, edited in place. Only what you changed goes into
 * one plan, each with its before and after; nothing changes until you approve it. Labels are
 * listed here and given to torrents from the Torrents tab. The RPC password, whitelist, ports, the
 * proxy, the blocklist and download folders stay in Transmission.
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
  defaultSavePath?: string;
  incompletePath?: string;
}

/** A field that only matters when its switch is on. */
const NEEDS: Record<string, string> = {
  "speed-limit-down": "speed-limit-down-enabled",
  "speed-limit-up": "speed-limit-up-enabled",
  seedRatioLimit: "seedRatioLimited",
  "idle-seeding-limit": "idle-seeding-limit-enabled",
  "download-queue-size": "download-queue-enabled",
  "seed-queue-size": "seed-queue-enabled",
  "queue-stalled-minutes": "queue-stalled-enabled",
};
const GROUPS: [string, RegExp][] = [
  ["Speed", /^speed-limit/],
  ["Alternative speed (turtle)", /^alt-speed/],
  ["Seeding", /seedRatio|idle-seeding/],
  ["Queue", /queue|start-added/],
  ["Peers and files", /^peer-limit|rename-partial/],
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
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        type="number"
        inputMode="decimal"
        step={s.type === "number" ? "0.1" : "1"}
        min={0}
        value={Number(value)}
        disabled={off}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(s.type === "int" ? Math.round(n) : n);
        }}
        aria-label={s.label}
        data-hearth-target={target}
        className={field}
      />
      <span className="w-16 text-[0.74rem] text-faint">
        {s.unit === "kB/s" ? "kB/s" : s.unit === "minutes" ? "min" : ""}
      </span>
    </span>
  );
}

export function TransmissionSettings({ serviceId, name, onGo }: AppViewProps) {
  // Under "dashboard" so a finished plan refreshes it with the rest of the panel.
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "qb-settings"],
    queryFn: () =>
      api<View>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/transmission/settings`,
      ),
    staleTime: 15_000,
  });
  const act = useApproveHere(serviceId, "Proposed from Transmission's Settings tab.");
  const [draft, setDraft] = useState<Record<string, boolean | number>>({});
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const webUi = keyPageHref(service, "/transmission/web/");
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
  return (
    <section
      className="@container space-y-4"
      aria-label={`${name} settings`}
      data-testid="tr-settings"
    >
      <ApproveDialog c={act} />
      <div className="grid gap-4 @2xl:grid-cols-2">
        {GROUPS.map(([title]) => {
          const rows = v.settings.filter(
            (s) => GROUPS.find(([, re]) => re.test(s.key))?.[0] === title,
          );
          if (!rows.length) return null;
          return (
            <fieldset
              key={title}
              className="rounded-xl border border-line p-3"
              data-testid="tr-settings-group"
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
              {title === "Alternative speed (turtle)" && (
                <p className="pt-2 text-[0.74rem] text-faint">
                  The turtle in Transmission: slower limits you can switch on when you need the
                  line.
                </p>
              )}
              {title === "Seeding" && (
                <p className="pt-2 text-[0.74rem] text-faint">
                  A torrent that reaches the ratio or idle time stops seeding; it is not removed.
                  Private trackers may ask for a ratio of 1 or more.
                </p>
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
          data-testid="tr-settings-review"
          onClick={() =>
            void act.propose(
              "app-transmission-control",
              { op: "settings", body: JSON.stringify(Object.fromEntries(changed)) },
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
      <div className="rounded-xl border border-line p-3 text-[0.82rem]" data-testid="tr-labels">
        <p className="eyebrow mb-1">Labels and folders</p>
        <p className="text-muted">
          {v.categories.length
            ? `Labels in use: ${v.categories.map((c) => c.name).join(", ")}.`
            : "No labels yet."}{" "}
          {v.incompletePath ? `Unfinished downloads go to ${v.incompletePath}, then ` : ""}
          {v.defaultSavePath
            ? `${v.incompletePath ? "move to" : "Downloads go to"} ${v.defaultSavePath}.`
            : ""}
        </p>
        <p className="mt-1 text-[0.76rem] text-faint">
          Labels are given to torrents (any word you like) from{" "}
          <button
            type="button"
            className="text-gold underline-offset-2 hover:underline"
            onClick={() => onGo?.("torrents")}
          >
            Torrents
          </button>
          .
        </p>
      </div>
      <p className="text-[0.76rem] text-faint">
        The RPC password and whitelist, ports, the proxy, the blocklist and download folders stay in
        Transmission: Sonarr and Radarr depend on the folders, and the rest protects your
        connection.{" "}
        {webUi && (
          <a
            href={webUi}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
            data-testid="tr-open-webui"
          >
            Open Transmission <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
          </a>
        )}
      </p>
    </section>
  );
}
