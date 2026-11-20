import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Pencil, RefreshCw } from "lucide-react";
import {
  SORT_TYPE_LABEL,
  SORT_TYPE_PLURAL,
  SORT_TYPES,
  type ManualSortConfig,
  type ManualSortEvent,
  type ManualSortView,
  type SortType,
} from "@dragon-control/core";
import { api } from "../../../data/api";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import type { AppViewProps } from "../../panels/registry";
import { Button, Skeleton, Tag, cx } from "../../ui";

/**
 * qBittorrent's Manual downloads tab (the owner, 2026-11-07): a torrent added by hand has no
 * category, so nothing files or imports it. One setup plan (each type follows the app that already
 * handles it) switches on sorting; after that every finished manual torrent, and SABnzbd jobs with
 * no category, are sorted on their own, listed here with Undo. Anything unclear waits in Unsorted
 * for you to say what it is.
 */

const STATUS: Record<
  ManualSortEvent["status"],
  { label: string; tone: "neutral" | "gold" | "warn" }
> = {
  moving: { label: "Moving", tone: "neutral" },
  sent: { label: "Importing", tone: "neutral" },
  done: { label: "Done", tone: "gold" },
  unsorted: { label: "Needs you", tone: "warn" },
  failed: { label: "Failed", tone: "warn" },
  undone: { label: "Undone", tone: "neutral" },
};

export function QbSort({ serviceId, name }: AppViewProps) {
  const qc = useQueryClient();
  const key = ["dashboard", serviceId, "qb-sort"];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<ManualSortView>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/qbittorrent/sort`,
      ),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const check = useMutation({
    mutationFn: () =>
      api<ManualSortView>(
        "POST",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/qbittorrent/sort/check`,
      ),
    onSuccess: (v) => qc.setQueryData(key, v),
  });
  const act = useApproveHere(serviceId, "From qBittorrent's Manual downloads tab.");
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return (
      <p className="text-[0.86rem] text-amber">
        Could not read {name}: {q.error?.message ?? "no answer"}
      </p>
    );
  const v = q.data;
  return (
    <section className="@container space-y-4" aria-label="Manual downloads" data-testid="qb-sort">
      <ApproveDialog c={act} />
      {v.config ? (
        <Running v={v} config={v.config} name={name} act={act} check={check} />
      ) : v.proposal ? (
        <Setup v={v} proposal={v.proposal} name={name} act={act} />
      ) : (
        <p className="text-[0.86rem] text-amber">{v.error ?? "Could not plan sorting yet."}</p>
      )}
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
    </section>
  );
}

type Act = ReturnType<typeof useApproveHere>;

function Setup({
  v,
  proposal,
  name,
  act,
}: {
  v: ManualSortView;
  proposal: NonNullable<ManualSortView["proposal"]>;
  name: string;
  act: Act;
}) {
  const [off, setOff] = useState<Set<SortType>>(new Set());
  const [sab, setSab] = useState<string[]>(proposal.sab);
  const suggested = proposal.defaultSavePath?.suggested;
  const [moveDefault, setMoveDefault] = useState(Boolean(suggested));
  const [folder, setFolder] = useState(suggested ?? proposal.defaultSavePath?.now ?? "");
  const [existing, setExisting] = useState(false);
  // Each type's category and folders can be changed before review (11-07: "how would you
  // edit this"). Unchanged fields keep the proposal's values.
  type Edit = { category?: string; savePath?: string; rootFolder?: string };
  const [edits, setEdits] = useState<Partial<Record<SortType | "unsorted", Edit>>>({});
  const [editing, setEditing] = useState<SortType | "unsorted">();
  const patch = (k: SortType | "unsorted", e: Edit) =>
    setEdits((x) => ({ ...x, [k]: { ...x[k], ...e } }));
  const target = (t: SortType) => {
    const tg = proposal.types[t];
    return tg ? { ...tg, ...edits[t] } : undefined;
  };
  const unsorted = { ...proposal.unsorted, ...edits.unsorted };
  const review = () => {
    const types: ManualSortConfig["types"] = {};
    for (const t of SORT_TYPES) {
      const tg = target(t);
      if (tg && !off.has(t)) types[t] = tg;
    }
    const config: ManualSortConfig = { ...proposal, types, unsorted, sab };
    void act.propose(
      "app-qbt-manual-sort",
      {
        mode: "setup",
        config: JSON.stringify(config),
        ...(moveDefault && folder.trim() ? { defaultSavePath: folder.trim() } : {}),
        ...(existing ? { includeExisting: true, existingCount: proposal.existing.length } : {}),
      },
      `Sort manual downloads in ${name}`,
    );
  };
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gold/30 p-4">
        <h3 className="font-display text-[1.25rem] text-ink">Sort what you add by hand</h3>
        <p className="mt-1 text-[0.86rem] text-muted">
          A torrent you add yourself has no category, so it stays in {name}&apos;s default folder
          and nothing imports it. Switch this on and every finished one is judged by its files,
          moved to the folder for its type, and handed to the app that files that type. Your
          apps&apos; own downloads are never touched, and anything unclear waits for you.
        </p>
      </div>
      <fieldset className="rounded-xl border border-line p-3">
        <legend className="eyebrow px-1">Where each type goes</legend>
        <ul className="divide-y divide-line">
          {SORT_TYPES.map((t) => {
            const tg = target(t);
            const on = Boolean(tg) && !off.has(t);
            return (
              <li
                key={t}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
                data-testid={`qb-sort-type-${t}`}
              >
                <label className="flex min-h-11 min-w-28 items-center gap-2 text-[0.88rem] text-ink">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!tg}
                    onChange={(e) =>
                      setOff((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.delete(t);
                        else n.add(t);
                        return n;
                      })
                    }
                    className="h-4 w-4"
                  />
                  {SORT_TYPE_PLURAL[t]}
                </label>
                <span className="min-w-0 flex-1 text-[0.8rem] text-muted">
                  {tg && on ? (
                    <>
                      <code className="text-ink">{tg.category}</code>
                      {tg.create && <span className="text-faint"> (new)</span>} in {tg.savePath}
                      {tg.appName && (
                        <>
                          {" "}
                          <ArrowRight className="inline h-3.5 w-3.5" aria-hidden /> {tg.appName}
                          {tg.rootFolder && (
                            <span className="text-faint">
                              , adding new titles to {tg.rootFolder} (no search)
                            </span>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    "Unsorted, for you"
                  )}
                </span>
                {tg && on && (
                  <button
                    type="button"
                    onClick={() => setEditing(editing === t ? undefined : t)}
                    aria-expanded={editing === t}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold"
                    data-testid={`qb-sort-edit-${t}`}
                  >
                    <Pencil strokeWidth={1.5} className="h-3.5 w-3.5" /> Change
                  </button>
                )}
                {tg && on && editing === t && (
                  <TargetEdit
                    value={tg}
                    rootFolder={Boolean(proposal.types[t]?.rootFolder)}
                    onChange={(e) => patch(t, e)}
                  />
                )}
              </li>
            );
          })}
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[0.8rem] text-muted">
            <span className="min-w-0 flex-1">
              <span className="text-ink">Anything unclear:</span>{" "}
              <code className="text-ink">{unsorted.category}</code> in {unsorted.savePath}
            </span>
            <button
              type="button"
              onClick={() => setEditing(editing === "unsorted" ? undefined : "unsorted")}
              aria-expanded={editing === "unsorted"}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold"
              data-testid="qb-sort-edit-unsorted"
            >
              <Pencil strokeWidth={1.5} className="h-3.5 w-3.5" /> Change
            </button>
            {editing === "unsorted" && (
              <TargetEdit value={unsorted} onChange={(e) => patch("unsorted", e)} />
            )}
          </li>
        </ul>
      </fieldset>
      <fieldset className="space-y-2 rounded-xl border border-line p-3 text-[0.84rem]">
        <legend className="eyebrow px-1">Options</legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={moveDefault}
            onChange={(e) => setMoveDefault(e.target.checked)}
          />
          <span>
            Save new manual downloads in another folder (now{" "}
            {proposal.defaultSavePath?.now || "unknown"})
            {moveDefault && (
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                aria-label="New default folder"
                className="mt-1 block min-h-10 w-full rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
              />
            )}
            <span className="block text-[0.76rem] text-faint">
              {proposal.defaultSavePath?.relocates
                ? `${name} is set to move torrents without a category to the new folder too.`
                : "Torrents already there stay where they are."}
            </span>
          </span>
        </label>
        {v.sabServices.map((s) => (
          <label key={s.serviceId} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={sab.includes(s.serviceId)}
              onChange={(e) =>
                setSab((l) =>
                  e.target.checked ? [...l, s.serviceId] : l.filter((x) => x !== s.serviceId),
                )
              }
            />
            Also sort {s.name} jobs with no category (judged by their name)
          </label>
        ))}
        {proposal.existing.length > 0 && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={existing}
              onChange={(e) => setExisting(e.target.checked)}
            />
            Also sort the {proposal.existing.length} finished manual torrent
            {proposal.existing.length === 1 ? "" : "s"} already there
          </label>
        )}
      </fieldset>
      {proposal.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[0.78rem] text-faint">
          {proposal.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <Button tone="primary" disabled={act.busy} onClick={review} data-testid="qb-sort-review">
        Review the setup
      </Button>
    </div>
  );
}

/** One type's category, its download folder and (Radarr, Sonarr) where new titles go. */
function TargetEdit({
  value,
  rootFolder,
  onChange,
}: {
  value: { category: string; savePath: string; rootFolder?: string };
  rootFolder?: boolean;
  onChange: (e: { category?: string; savePath?: string; rootFolder?: string }) => void;
}) {
  const field =
    "mt-0.5 block min-h-10 w-full rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink focus:border-gold/60 focus:outline-none";
  return (
    <div className="grid w-full gap-2 rounded-lg border border-gold/30 bg-gold/5 p-2.5 @md:grid-cols-3">
      <label className="text-[0.76rem] text-faint">
        qBittorrent category
        <input
          value={value.category}
          onChange={(e) => onChange({ category: e.target.value })}
          className={field}
        />
      </label>
      <label className="text-[0.76rem] text-faint">
        Download folder (inside qBittorrent)
        <input
          value={value.savePath}
          onChange={(e) => onChange({ savePath: e.target.value })}
          className={field}
        />
      </label>
      {rootFolder && (
        <label className="text-[0.76rem] text-faint">
          New titles go to (the app&apos;s library folder)
          <input
            value={value.rootFolder ?? ""}
            onChange={(e) => onChange({ rootFolder: e.target.value })}
            className={field}
          />
        </label>
      )}
      <p className="text-[0.72rem] text-faint @md:col-span-3">
        A category qBittorrent already has keeps its own folder; the review says so. Nothing changes
        until you approve.
      </p>
    </div>
  );
}

function Running({
  v,
  config,
  name,
  act,
  check,
}: {
  v: ManualSortView;
  config: ManualSortConfig;
  name: string;
  act: Act;
  check: { mutate: () => void; isPending: boolean };
}) {
  const waiting = v.events.filter((e) => e.status === "unsorted");
  const rest = v.events.filter((e) => e.status !== "unsorted");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3">
        <span
          className={cx("h-2.5 w-2.5 rounded-full", config.enabled ? "bg-live" : "bg-line-strong")}
          aria-hidden
        />
        <p className="min-w-[14rem] flex-1 text-[0.86rem] text-ink" data-testid="qb-sort-state">
          {config.enabled
            ? "Sorting is on: finished manual downloads are sorted every minute."
            : "Sorting is off."}
        </p>
        <Button
          tone="quiet"
          onClick={() => check.mutate()}
          disabled={check.isPending}
          data-testid="qb-sort-check"
        >
          <RefreshCw className={cx("h-4 w-4", check.isPending && "animate-spin")} aria-hidden />{" "}
          Check now
        </Button>
        {config.enabled ? (
          <Button
            tone="outline"
            disabled={act.busy}
            onClick={() =>
              void act.propose(
                "app-qbt-manual-sort",
                { mode: "off" },
                `Stop sorting manual downloads in ${name}`,
              )
            }
          >
            Turn off
          </Button>
        ) : (
          <Button
            tone="primary"
            disabled={act.busy}
            onClick={() =>
              void act.propose(
                "app-qbt-manual-sort",
                { mode: "setup", config: JSON.stringify(config) },
                `Sort manual downloads in ${name}`,
              )
            }
          >
            Turn on again
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 text-[0.76rem] text-faint">
        {SORT_TYPES.map((t) => {
          const tg = config.types[t];
          return (
            <span key={t} className="rounded-full border border-line px-2.5 py-0.5">
              {SORT_TYPE_PLURAL[t]}:{" "}
              {tg ? `${tg.category}${tg.appName ? ` → ${tg.appName}` : ""}` : "Unsorted"}
            </span>
          );
        })}
      </div>
      {waiting.length > 0 && (
        <div className="rounded-xl border border-warn/40 p-3" data-testid="qb-sort-unsorted">
          <p className="eyebrow mb-1 text-warn">Waiting for you ({waiting.length})</p>
          <ul className="divide-y divide-line">
            {waiting.map((e) => (
              <Row key={e.id} e={e} config={config} act={act} />
            ))}
          </ul>
        </div>
      )}
      <div className="rounded-xl border border-line p-3">
        <p className="eyebrow mb-1">Sorted</p>
        {rest.length ? (
          <ul className="divide-y divide-line" data-testid="qb-sort-history">
            {rest.map((e) => (
              <Row key={e.id} e={e} config={config} act={act} />
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-muted">
            Nothing yet. The next torrent you add by hand shows here once it finishes.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ e, config, act }: { e: ManualSortEvent; config: ManualSortConfig; act: Act }) {
  const [as, setAs] = useState<SortType | "">("");
  const s = STATUS[e.status];
  const offered = SORT_TYPES.filter((t) => config.types[t]);
  return (
    <li className="space-y-1 py-2.5" data-testid="qb-sort-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[0.86rem] text-ink" title={e.name}>
          {e.name}
        </span>
        <Tag>{SORT_TYPE_LABEL[e.type]}</Tag>
        <Tag tone={s.tone}>{s.label}</Tag>
        {e.source === "sabnzbd" && <Tag>Usenet</Tag>}
      </div>
      <p className="text-[0.78rem] text-muted">
        {e.message} <span className="text-faint">({e.reason})</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {(e.status === "unsorted" || e.status === "failed") && offered.length > 0 && (
          <>
            <select
              value={as}
              onChange={(x) => setAs(x.target.value as SortType)}
              aria-label={`What is ${e.name}?`}
              className="min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.82rem] text-ink"
            >
              <option value="">It is a…</option>
              {offered.map((t) => (
                <option key={t} value={t}>
                  {SORT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <Button
              tone="outline"
              disabled={!as || act.busy}
              onClick={() =>
                as &&
                void act.propose(
                  "app-qbt-manual-sort",
                  { mode: "file", event: e.id, type: as },
                  `File "${e.name}" as ${SORT_TYPE_LABEL[as].toLowerCase()}`,
                )
              }
            >
              File it
            </Button>
          </>
        )}
        {e.status === "failed" && e.type !== "unsorted" && (
          <Button
            tone="quiet"
            disabled={act.busy}
            onClick={() =>
              void act.propose(
                "app-qbt-manual-sort",
                { mode: "retry", event: e.id },
                `Try "${e.name}" again`,
              )
            }
          >
            Try again
          </Button>
        )}
        {e.source === "qbittorrent" && e.status !== "undone" && (
          <Button
            tone="quiet"
            disabled={act.busy}
            onClick={() =>
              void act.propose(
                "app-qbt-manual-sort",
                { mode: "undo", event: e.id },
                `Put "${e.name}" back unsorted`,
              )
            }
          >
            Undo
          </Button>
        )}
      </div>
    </li>
  );
}
