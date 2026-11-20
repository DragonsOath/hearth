import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { SourceBadge } from "../SourceBadge";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { SabHistoryPage, SabJobFile } from "@dragon-control/core";
import { NZBGET, UsenetProvider, useUsenet, type UsenetData as Data } from "./client";
import { api } from "../../../data/api";
import { useDashboard } from "../../../data/dashboards";
import { ago, bytes } from "../../../lib/format";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import type { AppViewProps } from "../../panels/registry";
import { useCave } from "../../shell/cave-context";
import { Button, Sheet, Skeleton, cx } from "../../ui";
import { ChangeCard, useConfirmedChange } from "../ConfirmedChange";
import { Field, readFiles } from "../uploads";
import { PRIORITIES, SabControls, SabWarnings, btn, sel, size, type SabOp } from "./parts";
import { EmberMark } from "../../ember/EmberMark";

/**
 * SABnzbd's and NZBGet's Downloads tab (checklist 46.11): everyday download management without
 * opening them. Add NZBs (links or .nzb files, with a category, a priority or paused, and a name), find
 * a download by name, status or category, and for each one: pause or resume, its priority, its
 * place, its category, its files, and removing it (what it downloaded stays unless you tick the
 * box). The history is searched and filtered here too, with why a download failed, retrying it, and
 * removing an entry with or without its files. Every change is a plan you approve, read back after.
 */

type Status = "all" | "downloading" | "paused" | "queued";
const STATUS: { id: Status; label: string; test: (s: string) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "downloading", label: "Downloading", test: (s) => /download|grabbing|fetching/i.test(s) },
  { id: "paused", label: "Paused", test: (s) => /paused/i.test(s) },
  {
    id: "queued",
    label: "Waiting",
    test: (s) => !/download|grabbing|fetching|paused/i.test(s),
  },
];
const input =
  "min-h-10 w-full rounded-lg border border-line bg-panel px-3 text-[0.84rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none";

/** NZBGet's Downloads tab: the same screens, with NZBGet's speed limits and plan steps. */
export function NzbgetDownloads(props: AppViewProps) {
  return (
    <UsenetProvider value={NZBGET}>
      <SabDownloads {...props} />
    </UsenetProvider>
  );
}

export function SabDownloads({ serviceId, name, sub: given, onSub: setGiven }: AppViewProps) {
  const client = useUsenet();
  // In a panel the address holds where you are; anywhere else, this tab remembers it.
  const [own, setOwn] = useState<string | null>(null);
  const sub = setGiven ? given : own;
  const onSub = setGiven ?? setOwn;
  const q = useDashboard(serviceId, true, 5_000);
  const d: Data | undefined = q.data?.data?.app === client.app ? (q.data.data as Data) : undefined;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [category, setCategory] = useState("*");
  const opened = sub && client.job.test(sub) ? sub : undefined;
  const adding = sub === "add";
  const historyLink = sub?.startsWith("history") ? sub : undefined;
  const history = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (historyLink) history.current?.scrollIntoView({ block: "start" });
  }, [historyLink]);

  const shown = useMemo(() => {
    if (!d) return [];
    const st = STATUS.find((s) => s.id === status)!;
    const needle = search.trim().toLowerCase();
    return d.queue
      .map((j, index) => ({ j, index }))
      .filter(({ j }) => st.test(j.status))
      .filter(({ j }) => category === "*" || (j.category ?? "") === category)
      .filter(({ j }) => !needle || j.name.toLowerCase().includes(needle));
  }, [d, status, category, search]);

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="sab-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const sample = Boolean(q.data?.sample);

  return (
    <section
      className="@container space-y-4"
      data-testid="sab-downloads"
      aria-label={`${name}: downloads`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          tone="primary"
          onClick={() => onSub("add")}
          data-hearth-target="downloads:add"
          data-testid="sab-add"
        >
          <Plus strokeWidth={1.75} className="h-4 w-4" /> Add NZB
        </Button>
        <p className="text-[0.8rem] text-faint" data-testid="sab-downloads-status">
          {d.status}
        </p>
        <p className="text-[0.8rem] text-faint">
          {(d.speedKbps / 1024).toFixed(1)} MB/s
          {d.sizeLeft ? ` · ${d.sizeLeft} left` : ""}
          {d.timeLeft ? ` · ${d.timeLeft}` : ""}
        </p>
      </div>
      <SabControls serviceId={serviceId} d={d} />
      <SabWarnings serviceId={serviceId} d={d} />

      <div className="space-y-2">
        <p className="text-[0.72rem] tracking-wide text-faint uppercase">
          Queue · {d.queue.length}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[12rem] flex-1">
            <span className="sr-only">Find a download by name</span>
            <Search
              strokeWidth={1.5}
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a download by name"
              className={cx(input, "pl-9")}
              data-hearth-target="downloads:search"
            />
          </label>
          {(d.categories ?? []).length > 0 && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={sel}
              aria-label="Category"
            >
              <option value="*">Every category</option>
              <option value="">No category</option>
              {(d.categories ?? []).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Downloads by status">
          {STATUS.map((s) => {
            const n = d.queue.filter((j) => s.test(j.status)).length;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={status === s.id}
                onClick={() => setStatus(s.id)}
                className={cx(
                  "min-h-9 rounded-full border px-3 text-[0.78rem]",
                  status === s.id
                    ? "border-gold bg-gold/10 text-gold"
                    : "border-line text-muted hover:border-gold/60",
                )}
              >
                {s.label} {n}
              </button>
            );
          })}
        </div>
        {shown.length ? (
          <ul className="divide-y divide-line">
            {shown.map(({ j, index }) => (
              <JobRow
                key={j.id}
                serviceId={serviceId}
                d={d}
                job={j}
                index={index}
                open={opened === j.id}
                onOpen={(on) => onSub(on ? j.id : null)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-[0.86rem] text-muted">
            {d.queue.length ? "Nothing here matches." : "Nothing is downloading."}
          </p>
        )}
      </div>

      <div ref={history}>
        <History
          serviceId={serviceId}
          d={d}
          failedFirst={historyLink === "history/failed"}
          sample={sample}
        />
      </div>

      <p className="text-[0.74rem] text-faint">
        {sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}live, every 5 s
      </p>
      {adding && (
        <AddNzb
          serviceId={serviceId}
          categories={d.categories ?? []}
          sample={sample}
          onClose={() => onSub(null)}
        />
      )}
    </section>
  );
}

type Job = Data["queue"][number];

/** One download in the queue: tap it for its controls and files. */
function JobRow({
  serviceId,
  d,
  job: j,
  index,
  open,
  onOpen,
}: {
  serviceId: string;
  d: Data;
  job: Job;
  index: number;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const client = useUsenet();
  const c = useConfirmedChange(serviceId);
  const [removing, setRemoving] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const isPaused = /paused/i.test(j.status);
  const propose = (params: Record<string, string | boolean>, title: string) =>
    void c.propose(client.kind, { nzoId: j.id, ...params }, title);
  return (
    <li
      className="space-y-2 py-2.5"
      data-testid="sab-job"
      data-capture-item
      data-capture-label={j.name}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
      >
        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="block text-[0.88rem] break-words text-ink">{j.name}</span>
          {j.source && (
            <span className="block">
              <SourceBadge source={j.source} />
            </span>
          )}
          <span
            className="block h-1.5 overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={j.progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${j.name} progress`}
          >
            <span
              className={cx("block h-full rounded-full", isPaused ? "bg-amber" : "bg-gold")}
              style={{ width: `${j.progressPct}%` }}
            />
          </span>
          <span className="block text-[0.76rem] text-faint" data-testid="sab-job-status">
            {[
              j.status,
              `${j.progressPct}%`,
              size(j.sizeMb),
              !isPaused && j.timeLeft && j.timeLeft !== "0:00:00" ? `${j.timeLeft} left` : "",
              j.category ?? "",
              j.priority && j.priority !== "Normal" ? `${j.priority} priority` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <ChevronDown
          strokeWidth={1.5}
          className={cx("mt-1 h-4 w-4 shrink-0 text-faint transition", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="space-y-3 rounded-xl border border-line p-3" data-testid="sab-job-detail">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btn}
              disabled={c.busy}
              data-testid={isPaused ? "sab-resume" : "sab-pause"}
              data-hearth-target="job:pause-resume"
              onClick={() =>
                propose(
                  { op: isPaused ? "resume" : "pause" },
                  `${isPaused ? "Resume" : "Pause"} ${j.name}`,
                )
              }
            >
              {isPaused ? (
                <Play strokeWidth={1.5} className="h-3.5 w-3.5" />
              ) : (
                <Pause strokeWidth={1.5} className="h-3.5 w-3.5" />
              )}
              {isPaused ? "Resume" : "Pause"}
            </button>
            <select
              className={sel}
              value={(j.priority ?? "Normal").toLowerCase()}
              aria-label={`Priority of ${j.name}`}
              disabled={c.busy}
              data-hearth-target="job:priority"
              onChange={(e) =>
                propose({ op: "priority", value: e.target.value }, `Priority of ${j.name}`)
              }
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0]!.toUpperCase() + p.slice(1)} priority
                </option>
              ))}
            </select>
            {index > 0 && (
              <button
                type="button"
                className={btn}
                disabled={c.busy}
                data-hearth-target="job:top"
                onClick={() => propose({ op: "move", value: "0" }, `Move ${j.name} to the top`)}
              >
                Move to top
              </button>
            )}
            {(d.categories ?? []).length > 0 && (
              <select
                className={sel}
                value={j.category ?? ""}
                aria-label={`Category of ${j.name}`}
                disabled={c.busy}
                data-hearth-target="job:category"
                onChange={(e) =>
                  propose({ op: "category", category: e.target.value }, `Category of ${j.name}`)
                }
              >
                <option value="">No category</option>
                {(d.categories ?? []).map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={cx(btn, "hover:border-alert/60 hover:text-alert")}
              data-testid="sab-remove"
              data-hearth-target="job:remove"
              onClick={() => setRemoving((v) => !v)}
            >
              <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
            </button>
          </div>
          {removing && (
            <RemoveForm
              inQueue
              deleteFiles={deleteFiles}
              setDeleteFiles={setDeleteFiles}
              onSubmit={() => {
                setRemoving(false);
                propose(
                  { op: "remove", ...(deleteFiles ? { deleteFiles: true } : {}) },
                  `Remove ${j.name}`,
                );
              }}
            />
          )}
          <ChangeCard c={c} />
          <JobFiles serviceId={serviceId} id={j.id} />
        </div>
      )}
    </li>
  );
}

/** A job's files, read while it is open. */
function JobFiles({ serviceId, id }: { serviceId: string; id: string }) {
  const client = useUsenet();
  const files = useQuery({
    queryKey: ["dashboard", serviceId, "sab-files", id],
    queryFn: () =>
      api<SabJobFile[]>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/sab/jobs/${encodeURIComponent(id)}/files`,
      ),
    refetchInterval: 5_000,
    retry: false,
  });
  return (
    <div data-hearth-target="job:files">
      <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Files</p>
      {files.isLoading ? (
        <Skeleton className="h-16" />
      ) : files.error ? (
        <p className="text-[0.8rem] text-amber">
          Its files could not be read: {files.error.message}
        </p>
      ) : files.data?.length ? (
        <ul className="space-y-1 text-[0.78rem]" data-testid="sab-files">
          {files.data.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="min-w-0 flex-1 break-all text-ink">{f.name}</span>
              <span className="text-faint">
                {[
                  size(f.sizeMb),
                  f.leftMb ? `${size(f.leftMb)} left` : f.sizeMb !== undefined ? "done" : "",
                  f.status && f.status !== "finished" ? f.status : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.8rem] text-muted">{client.name} lists no files for it yet.</p>
      )}
    </div>
  );
}

function RemoveForm({
  inQueue,
  deleteFiles,
  setDeleteFiles,
  onSubmit,
}: {
  inQueue: boolean;
  deleteFiles: boolean;
  setDeleteFiles: (v: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="flex flex-wrap items-center gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-muted">
        <input
          type="checkbox"
          checked={deleteFiles}
          onChange={(e) => setDeleteFiles(e.target.checked)}
          className="h-4 w-4 accent-[var(--color-alert)]"
        />
        Also delete what it downloaded (cannot be undone)
      </label>
      <Button tone="primary" type="submit" data-testid="sab-remove-plan">
        {inQueue ? "Remove from queue" : "Remove from history"}
      </Button>
    </form>
  );
}

/** The history: searched by name, failed only, or one category, fifty at a time. */
function History({
  serviceId,
  d,
  failedFirst,
  sample,
}: {
  serviceId: string;
  d: Data;
  failedFirst: boolean;
  sample: boolean;
}) {
  const [search, setSearch] = useState("");
  const [failed, setFailed] = useState(failedFirst);
  const [linked, setLinked] = useState(failedFirst);
  if (failedFirst !== linked) {
    setLinked(failedFirst);
    if (failedFirst) setFailed(true);
  }
  const [category, setCategory] = useState("");
  const needle = useDeferredValue(search.trim());
  const pages = useInfiniteQuery({
    queryKey: ["dashboard", serviceId, "sab-history", needle, failed, category],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({
        ...(needle ? { search: needle } : {}),
        ...(failed ? { failed: "1" } : {}),
        ...(category ? { category } : {}),
        start: String(pageParam),
      });
      return api<SabHistoryPage>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/sab/history?${p.toString()}`,
      );
    },
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, pg) => n + pg.items.length, 0);
      return last.items.length && loaded < last.total ? loaded : undefined;
    },
    refetchInterval: 15_000,
    retry: false,
  });
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;
  const failedNow = d.history.filter((h) => h.failed).length;
  return (
    <div className="space-y-2">
      <p className="text-[0.72rem] tracking-wide text-faint uppercase">
        History{pages.data ? ` · ${total}` : ""}
        {failedNow ? ` · ${failedNow} recent failed` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Find in the history</span>
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find in the history"
            className={cx(input, "pl-9")}
            data-hearth-target="history:search"
          />
        </label>
        <label className="inline-flex min-h-9 items-center gap-2 text-[0.8rem] text-muted">
          <input
            type="checkbox"
            checked={failed}
            onChange={(e) => setFailed(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-gold)]"
            data-testid="sab-failed-only"
          />
          Failed only
        </label>
        {(d.categories ?? []).length > 0 && (
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={sel}
            aria-label="History category"
          >
            <option value="">Every category</option>
            {(d.categories ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
      </div>
      {pages.isLoading ? (
        <Skeleton className="h-24" />
      ) : pages.error ? (
        <p className="text-[0.84rem] text-amber">
          The history could not be read: {pages.error.message}
        </p>
      ) : items.length ? (
        <ul className="divide-y divide-line" data-testid="sab-history">
          {items.map((h) => (
            <HistoryRow key={h.id} serviceId={serviceId} item={h} />
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">
          {needle || failed || category
            ? "Nothing in the history matches."
            : "No finished downloads yet."}
        </p>
      )}
      {pages.hasNextPage && (
        <Button
          tone="outline"
          onClick={() => void pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
        >
          {pages.isFetchingNextPage ? "Loading…" : `Show more (${total - items.length} more)`}
        </Button>
      )}
      {sample && (
        <p className="text-[0.74rem] text-faint">Sample data: the history is a short example.</p>
      )}
    </div>
  );
}

type Done = Data["history"][number];

function HistoryRow({ serviceId, item: h }: { serviceId: string; item: Done }) {
  const client = useUsenet();
  const c = useConfirmedChange(serviceId);
  const cave = useCave();
  const [removing, setRemoving] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const op = (o: SabOp, extra: Record<string, boolean> = {}, title: string) =>
    void c.propose(client.kind, { op: o, nzoId: h.id, ...extra }, title);
  return (
    <li
      className="space-y-2 py-2.5"
      data-testid="sab-done"
      data-capture-item
      data-capture-label={h.name}
    >
      <p className="flex flex-wrap items-center gap-2 text-[0.88rem]">
        <span className="min-w-0 break-words text-ink">{h.name}</span>
        <SourceBadge source={h.source} />
        <span
          className={cx(
            "fit-pill rounded-full border px-2 py-0.5 text-[0.7rem]",
            h.failed ? "border-alert/50 text-alert" : "border-live/40 text-live",
          )}
        >
          {h.failed ? "Failed" : h.status}
        </span>
      </p>
      {h.why && (
        <p className="text-[0.78rem] break-words text-alert" data-testid="sab-why">
          {h.why}
        </p>
      )}
      <p className="text-[0.76rem] text-faint">
        {[size(h.sizeMb), h.category ?? "", h.at ? ago(h.at) : ""].filter(Boolean).join(" · ")}
      </p>
      <div className="flex flex-wrap gap-2">
        {h.failed && (
          <button
            type="button"
            className={btn}
            disabled={c.busy}
            data-testid="sab-retry"
            data-hearth-target="history:retry"
            onClick={() => op("retry", {}, `Retry ${h.name}`)}
          >
            <RotateCcw strokeWidth={1.5} className="h-3.5 w-3.5" /> Retry
          </button>
        )}
        <button
          type="button"
          className={cx(btn, "hover:border-alert/60 hover:text-alert")}
          data-testid="sab-remove"
          data-hearth-target="history:remove"
          onClick={() => setRemoving((v) => !v)}
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
        </button>
        {h.failed && (
          <button
            type="button"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
            onClick={() =>
              cave.ask(
                `${client.name} failed to download ${h.name}: "${h.why ?? "no reason given"}". What does that mean, and should I retry it, or have Radarr or Sonarr search for another release?`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask why
            <EmberMark />
          </button>
        )}
      </div>
      {removing && (
        <RemoveForm
          inQueue={false}
          deleteFiles={deleteFiles}
          setDeleteFiles={setDeleteFiles}
          onSubmit={() => {
            setRemoving(false);
            op("remove-history", deleteFiles ? { deleteFiles: true } : {}, `Remove ${h.name}`);
          }}
        />
      )}
      <ChangeCard c={c} />
    </li>
  );
}

const NZB_MAX = 4 * 1024 * 1024;

/** Add NZBs: links or .nzb files, a category, a priority or paused, and a name for one. */
function AddNzb({
  serviceId,
  categories,
  sample,
  onClose,
}: {
  serviceId: string;
  categories: string[];
  sample: boolean;
  onClose: () => void;
}) {
  const client = useUsenet();
  const act = useApproveHere(serviceId, `Added from ${client.name}'s Downloads tab.`);
  // Once an add is done and its pop-up closed, the dialog is finished too. A declined or failed
  // one comes back with what was typed, to fix and try again.
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (act.job?.status) last.current = act.job.status;
  });
  useEffect(() => {
    if (!act.open && last.current === "succeeded") onClose();
  });
  const [links, setLinks] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [paused, setPaused] = useState(false);
  const [nzbName, setNzbName] = useState("");
  const [error, setError] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const count = links.split(/\s+/).filter(Boolean).length + files.length;
  return (
    <>
      {/* The approval pop-up shows once the plan exists; the dialog steps aside for it. */}
      <ApproveDialog c={act} />
      {!act.open && (
        <Sheet label="Add NZB" eyebrow={client.name} title="Add NZB" onClose={onClose}>
          <form
            className="space-y-4"
            data-testid="sab-add-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(undefined);
              const big = files.find((f) => f.size > NZB_MAX);
              if (big) return setError(`${big.name} is larger than 4 MB.`);
              if (files.reduce((n, f) => n + f.size, 0) > NZB_MAX)
                return setError("Together the files are larger than 4 MB: add them in two goes.");
              try {
                const read = await readFiles(files);
                await act.propose(
                  client.kind,
                  {
                    op: "add",
                    ...(links.trim() ? { urls: links.trim() } : {}),
                    ...(read.length ? { files: JSON.stringify(read) } : {}),
                    ...(category ? { category } : {}),
                    ...(priority && !paused ? { value: priority } : {}),
                    ...(paused ? { paused: true } : {}),
                    ...(nzbName.trim() && count === 1 ? { nzbName: nzbName.trim() } : {}),
                  },
                  count === 1 ? "Add an NZB" : `Add ${count} NZBs`,
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <Field label="NZB links, one per line">
              <textarea
                value={links}
                onChange={(e) => setLinks(e.target.value)}
                rows={3}
                placeholder="https://..."
                className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-[0.84rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
                data-testid="sab-add-links"
              />
            </Field>
            <div>
              <input
                ref={picker}
                type="file"
                accept=".nzb,.gz,.zip,application/x-nzb"
                multiple
                className="hidden"
                data-testid="sab-add-file"
                onChange={(e) => {
                  // Taken now: clearing the input empties its list before a state update reads it.
                  const chosen = Array.from(e.target.files ?? []);
                  setFiles((now) => [...now, ...chosen].slice(0, 5));
                  e.target.value = "";
                }}
              />
              <button type="button" className={btn} onClick={() => picker.current?.click()}>
                <Plus strokeWidth={1.5} className="h-4 w-4" /> Choose .nzb files
              </button>
              {files.length > 0 && (
                <ul className="mt-2 space-y-1 text-[0.8rem]">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 break-all text-ink">{f.name}</span>
                      <span className="text-faint">{bytes(f.size)}</span>
                      <button
                        type="button"
                        aria-label={`Do not add ${f.name}`}
                        onClick={() => setFiles((now) => now.filter((_, j) => j !== i))}
                        className="grid h-9 w-9 place-items-center rounded-lg text-faint hover:text-alert"
                      >
                        <X strokeWidth={1.5} className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Category">
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className={cx(sel, "min-h-10 w-full")}
                  data-testid="sab-add-category"
                >
                  <option value="">Default</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Priority">
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  disabled={paused}
                  className={cx(sel, "min-h-10 w-full")}
                  data-testid="sab-add-priority"
                >
                  <option value="">The category's priority</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p[0]!.toUpperCase() + p.slice(1)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {count === 1 && (
              <Field label={`Name in ${client.name} (optional)`}>
                <input
                  value={nzbName}
                  onChange={(e) => setNzbName(e.target.value)}
                  maxLength={200}
                  className={input}
                  data-testid="sab-add-name"
                />
              </Field>
            )}
            <label className="flex min-h-10 items-center gap-2 text-[0.84rem] text-ink">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="h-5 w-5 accent-[var(--color-gold)]"
              />
              Add it paused (do not start downloading yet)
            </label>
            {sample && (
              <p className="text-[0.78rem] text-amber">
                This is sample data: there is no real {client.name} to add to.
              </p>
            )}
            {(error ?? act.error) && (
              <p role="alert" className="text-[0.82rem] text-amber" data-testid="sab-add-error">
                {error ?? act.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" type="submit" disabled={!count || act.pending}>
                {act.pending ? "Checking…" : count > 1 ? `Add ${count} NZBs` : "Add"}
              </Button>
              <Button tone="quiet" onClick={onClose}>
                Cancel
              </Button>
            </div>
            <p className="text-[0.76rem] text-faint">
              You see exactly what gets added first, and approve it. A link's address after "?" (an
              indexer's key) is never shown in the plan.
            </p>
          </form>
        </Sheet>
      )}
    </>
  );
}
