import { useEffect, useMemo, useRef, useState } from "react";
import { SourceBadge } from "../SourceBadge";
import { RuleLine, SeedingRules } from "./SeedingRules";
import { useQuery } from "@tanstack/react-query";
import {
  FolderTree,
  Timer,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  TORRENT_STATUS_LABEL,
  type DelugeDashboard,
  type TransmissionDashboard,
  type QbittorrentDashboard,
  type StepParams,
  type Torrent,
} from "@dragon-control/core";
import { api, useAiName } from "../../../data/api";
import { useDashboard, useTorrentDetail } from "../../../data/dashboards";
import { ago, bytes } from "../../../lib/format";
import { ApproveDialog, useApproveHere, type ApproveHere } from "../../jobs/ApproveHere";
import type { AppViewProps } from "../../panels/registry";
import { useCave } from "../../shell/cave-context";
import { Button, Sheet, Skeleton, cx } from "../../ui";
import { Field, readFiles } from "../uploads";
import {
  ClientProvider,
  DELUGE,
  QBITTORRENT,
  TRANSMISSION,
  useClient,
  type TorrentAct,
} from "./client";
import {
  Bar,
  GROUPS,
  Header,
  Meta,
  SORTS,
  STOPPED,
  StatusPill,
  categoryFolder,
  eta,
  sortBy,
  speed,
  type Group,
  type QbView,
  type Sort,
} from "./parts";

/**
 * qBittorrent's Torrents tab (checklist 46.11): everyday torrent management without opening
 * qBittorrent. Add torrents (magnet links, .torrent URLs or files), find them by name, status,
 * category, tag or tracker, and for each one: pause or resume, force start, recheck, its category
 * and tags, its files (which ones download), trackers, peers and transfer totals, and removing it,
 * keeping its files or deleting them. Every change is a plan you approve, read back afterwards.
 * Categories are created and removed here; one with torrents in it, or one Sonarr, Radarr or
 * Lidarr send downloads to, is never removed. Default and category folders never change here.
 */

const HASH = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
type Data = QbittorrentDashboard | DelugeDashboard | TransmissionDashboard;
/** Capitalised, for a label ("Category", "Label"). */
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const sel =
  "min-h-10 rounded-lg border border-line bg-panel px-3 text-[0.84rem] text-ink focus:border-gold/60 focus:outline-none";
const btn =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.82rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";

/** The client's categories (Deluge: labels), tags and default folder (as its Settings tab reads). */
function useQbView(serviceId: string, enabled: boolean) {
  const client = useClient();
  return useQuery({
    queryKey: ["dashboard", serviceId, "qb-settings"],
    queryFn: () =>
      api<QbView>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/dashboard/${client.settingsPath}`,
      ),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function QbTorrents(props: AppViewProps) {
  return (
    <ClientProvider value={QBITTORRENT}>
      <TorrentsTab {...props} />
    </ClientProvider>
  );
}

/** Deluge's Torrents tab: the same screens, with Deluge's labels, queue and plan steps. */
export function DelugeTorrents(props: AppViewProps) {
  return (
    <ClientProvider value={DELUGE}>
      <TorrentsTab {...props} />
    </ClientProvider>
  );
}

/** Transmission's Torrents tab: the same screens, with its free-text labels and queue. */
export function TransmissionTorrents(props: AppViewProps) {
  return (
    <ClientProvider value={TRANSMISSION}>
      <TorrentsTab {...props} />
    </ClientProvider>
  );
}

function TorrentsTab({ serviceId, sub: given, onSub: setGiven }: AppViewProps) {
  const client = useClient();
  // In a panel the address holds where you are; anywhere else, this tab remembers it.
  const [own, setOwn] = useState<string | null>(null);
  const sub = setGiven ? given : own;
  const onSub = setGiven ?? setOwn;
  const q = useDashboard(serviceId);
  const d = q.data?.data?.app === client.app ? (q.data.data as Data) : undefined;
  const labelsOn = !d || d.app !== "deluge" || d.labelsEnabled;
  const sample = Boolean(q.data?.sample);
  const view = useQbView(serviceId, Boolean(d) && !sample);
  const act = useApproveHere(serviceId, `Proposed from ${client.name}'s Torrents tab.`);
  // A status link from Overview ("status/stalled") picks the filter once, as it arrives.
  const linked = /^status\/(\w+)$/.exec(sub ?? "")?.[1] as Group | undefined;
  const valid = linked && GROUPS.some((x) => x.id === linked) ? linked : undefined;
  const [group, setGroup] = useState<Group>(valid ?? "all");
  const [linkedFor, setLinkedFor] = useState(sub);
  if (sub !== linkedFor) {
    setLinkedFor(sub);
    if (valid) setGroup(valid);
  }
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("*");
  const [tag, setTag] = useState<string>("*");
  const [tracker, setTracker] = useState<string>("*");
  const [sort, setSort] = useState<Sort>("attention");
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  // The address keeps the open torrent ("torrents/<hash>"), a status filter, or the Add dialog.
  const selected = sub && HASH.test(sub) ? sub : undefined;
  const adding = sub === "add";

  const categories = useMemo(() => {
    const names = new Set(view.data?.categories.map((c) => c.name) ?? []);
    for (const t of d?.torrents ?? []) if (t.category) names.add(t.category);
    return [...names].sort();
  }, [view.data, d]);
  const tags = useMemo(() => {
    const names = new Set(view.data?.tags ?? []);
    for (const t of d?.torrents ?? []) for (const x of t.tags ?? []) names.add(x);
    return [...names].sort();
  }, [view.data, d]);
  const trackers = useMemo(
    () =>
      [...new Set((d?.torrents ?? []).map((t) => t.tracker).filter(Boolean) as string[])].sort(),
    [d],
  );

  const shown = useMemo(() => {
    if (!d) return [];
    const g = GROUPS.find((x) => x.id === group)!;
    const needle = search.trim().toLowerCase();
    return d.torrents
      .filter(g.test)
      .filter((t) => category === "*" || (t.category ?? "") === category)
      .filter((t) => tag === "*" || (t.tags ?? []).includes(tag))
      .filter((t) => tracker === "*" || t.tracker === tracker)
      .filter((t) => !needle || t.name.toLowerCase().includes(needle))
      .sort(sortBy(sort));
  }, [d, group, search, category, tag, tracker, sort]);

  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {client.name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="qb-error">
        <p className="text-amber">{client.name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const filtered =
    group !== "all" || category !== "*" || tag !== "*" || tracker !== "*" || search.trim();

  return (
    <section className="@container space-y-3" aria-label="Torrents" data-testid="qb-torrents">
      <ApproveDialog c={act} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          tone="primary"
          onClick={() => onSub?.("add")}
          data-hearth-target="torrents:add"
          data-testid="qb-add"
        >
          <Plus strokeWidth={1.75} className="h-4 w-4" /> Add torrent
        </Button>
        <button
          type="button"
          className={btn}
          onClick={() => setCategoriesOpen(true)}
          data-hearth-target="torrents:categories"
          data-testid="qb-categories"
        >
          <FolderTree strokeWidth={1.5} className="h-4 w-4" /> {client.word.Many}
        </button>
        {client.app === "qbittorrent" && (
          <button
            type="button"
            className={btn}
            onClick={() => setRulesOpen(true)}
            data-hearth-target="torrents:rules"
            data-testid="qb-rules"
          >
            <Timer strokeWidth={1.5} className="h-4 w-4" /> Seeding rules
          </button>
        )}
      </div>
      <Header d={d} at={q.data!.at} sample={sample} />
      {act.error && (
        <p className="text-[0.82rem] text-amber" role="alert" data-testid="qb-action-error">
          {act.error}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {GROUPS.map((g) => {
          const n = d.torrents.filter(g.test).length;
          if (!n && g.id !== "all" && g.id !== group) return null;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => setGroup(g.id)}
              aria-pressed={group === g.id}
              className={cx(
                "min-h-9 rounded-full border px-3 text-[0.76rem] tabular",
                group === g.id
                  ? "border-gold bg-gold/10 text-gold"
                  : "border-line text-muted hover:text-ink",
                (g.id === "stalled" || g.id === "error") &&
                  n > 0 &&
                  group !== g.id &&
                  "border-amber/50 text-amber",
              )}
            >
              {g.label} {n}
            </button>
          );
        })}
      </div>
      <div className="grid gap-2 @md:grid-cols-[1fr_auto_auto_auto_auto]">
        <label className="flex min-h-10 min-w-0 items-center gap-2 rounded-lg border border-line px-3 focus-within:border-gold/60">
          <Search strokeWidth={1.5} className="h-4 w-4 text-faint" />
          <span className="sr-only">Find a torrent</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a torrent by name"
            className="min-w-0 flex-1 bg-transparent text-[0.86rem] text-ink placeholder:text-faint focus:outline-none"
            data-hearth-target="torrents:search"
          />
        </label>
        <select
          aria-label={cap(client.word.one)}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={sel}
        >
          <option value="*">{client.word.every}</option>
          <option value="">{client.word.none}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {tags.length > 0 && (
          <select
            aria-label="Tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className={sel}
          >
            <option value="*">Every tag</option>
            {tags.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
        {trackers.length > 1 && (
          <select
            aria-label="Tracker"
            value={tracker}
            onChange={(e) => setTracker(e.target.value)}
            className={sel}
          >
            <option value="*">Every tracker</option>
            {trackers.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Sort torrents"
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          className={sel}
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      {shown.length ? (
        <ul className="space-y-2">
          {shown.map((t) => (
            <Row
              key={t.hash}
              t={t}
              d={d}
              labelsOn={labelsOn}
              view={view.data}
              act={act}
              serviceId={serviceId}
              open={selected === t.hash}
              onToggle={() => onSub?.(selected === t.hash ? null : t.hash)}
            />
          ))}
        </ul>
      ) : (
        <p className="py-6 text-center text-[0.86rem] text-muted">
          {d.torrents.length
            ? filtered
              ? "No torrents match."
              : `${client.name} has no torrents.`
            : `${client.name} has no torrents. Add torrent puts one in.`}
        </p>
      )}
      {adding && (
        <AddTorrent
          serviceId={serviceId}
          labelsOn={labelsOn}
          view={view.data}
          categories={categories}
          sample={sample}
          onClose={() => onSub?.(null)}
        />
      )}
      {rulesOpen && (
        <SeedingRules
          serviceId={serviceId}
          torrents={d.torrents}
          sample={sample}
          onClose={() => setRulesOpen(false)}
        />
      )}
      {categoriesOpen && (
        <Categories
          serviceId={serviceId}
          labelsOn={labelsOn}
          view={view.data}
          d={d}
          sample={sample}
          onClose={() => setCategoriesOpen(false)}
        />
      )}
    </section>
  );
}

function Row({
  t,
  d,
  labelsOn,
  view,
  act,
  serviceId,
  open,
  onToggle,
}: {
  t: Torrent;
  d: Data;
  labelsOn: boolean;
  view?: QbView;
  act: ApproveHere;
  serviceId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const client = useClient();
  const noSeeds = t.progressPct < 100 && t.seedsInSwarm === 0 && t.status !== "metadata";
  return (
    <li
      className={cx(
        "rounded-xl border p-3 transition-colors",
        open ? "border-gold/50 bg-gold/[0.04]" : "border-line hover:border-line-strong",
      )}
      data-testid="qb-torrent"
      data-status={t.status}
      data-capture-item
      data-capture-label={t.name}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="block w-full text-left"
      >
        <div className="mb-2 flex flex-wrap items-start gap-2">
          <StatusPill t={t} label={TORRENT_STATUS_LABEL[t.status]} />
          {t.forceStart && (
            <span className="shrink-0 rounded-full border border-gold/40 px-2 py-0.5 text-[0.72rem] text-gold">
              Forced
            </span>
          )}
          {noSeeds && (
            <span className="shrink-0 rounded-full border border-alert/60 px-2 py-0.5 text-[0.72rem] text-alert">
              No seeders
            </span>
          )}
          <SourceBadge source={t.source} />
          <span className="min-w-0 basis-full text-[0.9rem] leading-snug break-words text-ink @md:basis-0 @md:flex-1">
            {t.name}
          </span>
        </div>
        <Bar t={t} />
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.78rem]">
          <Meta label="Size" value={bytes(t.sizeBytes)} />
          <Meta label="↓" value={speed(t.downSpeed)} warn={t.status === "stalled"} />
          <Meta label="↑" value={speed(t.upSpeed)} />
          {eta(t.etaSec) && <Meta label="Time left" value={eta(t.etaSec)!} />}
          <Meta
            label="Seeds"
            value={`${t.seedsConnected} (${t.seedsInSwarm} in swarm)`}
            warn={noSeeds}
          />
          <Meta label="Ratio" value={t.ratio.toFixed(2)} />
          <Meta label={cap(client.word.one)} value={t.category || "none"} />
          {t.tags?.length ? <Meta label="Tags" value={t.tags.join(", ")} /> : null}
          {t.tracker && <Meta label="Tracker" value={t.tracker} />}
        </div>
        <RuleLine rule={t.rule} />
        {t.problem && (
          <p
            className={cx("mt-2 text-[0.8rem]", t.status === "error" ? "text-alert" : "text-amber")}
          >
            {t.problem}
          </p>
        )}
      </button>
      {open && (
        <Detail t={t} d={d} labelsOn={labelsOn} view={view} act={act} serviceId={serviceId} />
      )}
    </li>
  );
}

type Part = "files" | "trackers" | "peers" | "transfer";

function Detail({
  t,
  labelsOn,
  view,
  act,
  serviceId,
}: {
  t: Torrent;
  d: Data;
  labelsOn: boolean;
  view?: QbView;
  act: ApproveHere;
  serviceId: string;
}) {
  const client = useClient();
  const aiName = useAiName();
  const cave = useCave();
  const [part, setPart] = useState<Part>("files");
  const info = useTorrentDetail(
    serviceId,
    t.hash,
    part === "files" ? "files" : part === "peers" ? "peers" : undefined,
  );
  const x = info.data;
  const asking = cave.item?.kind === "torrent" && cave.item.id === t.hash;
  const stopped = STOPPED.test(t.state);
  const propose = (what: TorrentAct, params: StepParams, title: string) => {
    const step = client.step(what, { hash: t.hash, ...params });
    void act.propose(step.kind, step.params, `${title}: ${t.name}`);
  };
  const [newCategory, setNewCategory] = useState(t.category ?? "");
  const [addTag, setAddTag] = useState("");
  const categories = useMemo(() => {
    const names = new Set(view?.categories.map((c) => c.name) ?? []);
    if (t.category) names.add(t.category);
    return [...names].sort();
  }, [view, t.category]);

  return (
    <div className="mt-3 space-y-4 border-t border-line pt-3 text-[0.8rem]" data-testid="qb-detail">
      <div className="flex flex-wrap gap-2" data-testid="qb-actions">
        <button
          type="button"
          className={btn}
          disabled={act.busy || t.status === "moving"}
          data-hearth-target="torrent:pause-resume"
          onClick={() =>
            stopped ? propose("resume", {}, "Resume") : propose("pause", {}, "Pause")
          }
        >
          {stopped ? (
            <Play strokeWidth={1.5} className="h-4 w-4" />
          ) : (
            <Pause strokeWidth={1.5} className="h-4 w-4" />
          )}
          {stopped ? "Resume" : "Pause"}
        </button>
        {client.forceStart && (
          <button
            type="button"
            className={btn}
            disabled={act.busy}
            data-hearth-target="torrent:force-start"
            title="Runs whatever the queue limits say"
            onClick={() =>
              propose(
                "force-start",
                { value: !t.forceStart },
                t.forceStart ? "Stop forcing" : "Force start",
              )
            }
          >
            <Zap strokeWidth={1.5} className="h-4 w-4" />
            {t.forceStart ? "Stop forcing" : "Force start"}
          </button>
        )}
        <button
          type="button"
          className={btn}
          disabled={act.busy || t.status === "checking" || t.status === "moving"}
          data-hearth-target="torrent:recheck"
          title="Re-verify its files on disk"
          onClick={() => propose("recheck", {}, "Recheck")}
        >
          <RefreshCw strokeWidth={1.5} className="h-4 w-4" /> Recheck
        </button>
        {client.queue && t.queuePosition !== undefined && (
          <span
            className="inline-flex items-center gap-1"
            role="group"
            aria-label={`Queue place ${t.queuePosition}`}
          >
            <span className="text-faint">Queue {t.queuePosition}</span>
            {(
              [
                ["queue-top", "Top"],
                ["queue-up", "Up"],
                ["queue-down", "Down"],
                ["queue-bottom", "Bottom"],
              ] as const
            ).map(([what, words]) => (
              <button
                key={what}
                type="button"
                className={btn}
                disabled={act.busy}
                data-hearth-target={`torrent:${what}`}
                onClick={() => propose(what, {}, `Move ${words.toLowerCase()} in the queue`)}
              >
                {words}
              </button>
            ))}
          </span>
        )}
        {!stopped && (
          <button
            type="button"
            className={btn}
            disabled={act.busy}
            title="Ask its trackers for peers again"
            onClick={() => propose("reannounce", {}, "Ask the trackers again")}
          >
            Reannounce
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            cave.selectItem({ serviceId, kind: "torrent", id: t.hash, label: t.name });
            requestAnimationFrame(() =>
              document.querySelector<HTMLTextAreaElement>('textarea[id$="-input"]')?.focus(),
            );
          }}
          className={cx(
            "inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-[0.82rem]",
            asking
              ? "border-gold bg-gold/10 text-gold"
              : "border-gold/50 text-gold hover:bg-gold/10",
          )}
          data-testid="qb-ask"
        >
          <MessageCircle strokeWidth={1.5} className="h-4 w-4" />
          {asking ? `${aiName} is looking at it` : `Ask ${aiName}`}
        </button>
      </div>

      <div className="grid gap-3 @md:grid-cols-2">
        {labelsOn ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              propose(
                "category",
                { category: newCategory },
                newCategory ? `${cap(client.word.one)} ${newCategory}` : client.word.none,
              );
            }}
          >
            <label className="text-faint" htmlFor={`qb-cat-${t.hash}`}>
              {cap(client.word.one)}
            </label>
            {client.freeLabels ? (
              <>
                <input
                  id={`qb-cat-${t.hash}`}
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  list={`qb-cats-${t.hash}`}
                  placeholder={client.word.none}
                  maxLength={60}
                  className={cx(sel, "min-w-0 flex-1")}
                  data-hearth-target="torrent:category"
                />
                <datalist id={`qb-cats-${t.hash}`}>
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            ) : (
              <select
                id={`qb-cat-${t.hash}`}
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className={cx(sel, "min-w-0 flex-1")}
                data-hearth-target="torrent:category"
              >
                <option value="">{client.word.none}</option>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <button
              type="submit"
              className={btn}
              disabled={act.busy || newCategory === (t.category ?? "")}
            >
              Change
            </button>
          </form>
        ) : (
          <p className="text-[0.78rem] text-faint" data-testid="dl-labels-off">
            Labels are off in {client.name} (its Label plugin). Turn them on from {client.word.Many}
            .
          </p>
        )}
        {client.tags && (
          <div className="flex flex-wrap items-center gap-1.5" data-hearth-target="torrent:tags">
            <span className="text-faint">Tags</span>
            {(t.tags ?? []).map((x) => (
              <span
                key={x}
                className="inline-flex min-h-8 items-center gap-1 rounded-full border border-line pr-1 pl-2.5 text-ink"
              >
                {x}
                <button
                  type="button"
                  aria-label={`Remove the tag ${x}`}
                  disabled={act.busy}
                  onClick={() => propose("tags", { removeTags: x }, `Remove the tag ${x}`)}
                  className="grid h-7 w-7 place-items-center rounded-full text-faint hover:text-alert"
                >
                  <X strokeWidth={1.5} className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
            <form
              className="flex min-w-[10rem] flex-1 gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (addTag.trim())
                  propose("tags", { addTags: addTag.trim() }, `Tag ${addTag.trim()}`);
                setAddTag("");
              }}
            >
              <label className="sr-only" htmlFor={`qb-tag-${t.hash}`}>
                Add a tag
              </label>
              <input
                id={`qb-tag-${t.hash}`}
                value={addTag}
                onChange={(e) => setAddTag(e.target.value)}
                placeholder="Add a tag"
                list={`qb-tags-${t.hash}`}
                className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-panel px-2.5 text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
              />
              <datalist id={`qb-tags-${t.hash}`}>
                {(view?.tags ?? []).map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
              <button type="submit" className={btn} disabled={act.busy || !addTag.trim()}>
                Add
              </button>
            </form>
          </div>
        )}
      </div>
      {t.autoTmm && (
        <p className="text-[0.76rem] text-faint">
          Automatic management is on for it: changing its category moves its files to that
          category&apos;s folder. The plan shows exactly where before you approve.
        </p>
      )}

      <div>
        <div role="tablist" aria-label="About this torrent" className="mb-2 flex flex-wrap gap-1">
          {(["files", "trackers", "peers", "transfer"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={part === p}
              onClick={() => setPart(p)}
              data-hearth-target={`torrent:${p}`}
              className={cx(
                "min-h-9 rounded-lg px-3 text-[0.8rem] capitalize",
                part === p ? "bg-gold/10 text-gold" : "text-muted hover:text-ink",
              )}
            >
              {p}
            </button>
          ))}
        </div>
        {info.isLoading ? (
          <Skeleton className="h-16" />
        ) : info.error ? (
          <p className="text-alert">{info.error.message}</p>
        ) : !x ? null : part === "files" ? (
          <Files hash={t.hash} name={t.name} files={x.files ?? []} act={act} />
        ) : part === "trackers" ? (
          x.trackers.length ? (
            <ul className="space-y-1" data-testid="qb-trackers">
              {x.trackers.map((tr, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-ink">{tr.host}</span>
                  <span
                    className={cx(
                      tr.status === "working"
                        ? "text-live"
                        : tr.status === "not working"
                          ? "text-alert"
                          : "text-muted",
                    )}
                  >
                    {tr.status}
                  </span>
                  {tr.seeds !== undefined && (
                    <span className="text-faint tabular">
                      {tr.seeds} seeds · {tr.leechers ?? 0} leechers
                    </span>
                  )}
                  {tr.message && <span className="text-faint">{tr.message}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No trackers reported.</p>
          )
        ) : part === "peers" ? (
          x.peerList?.length ? (
            <div className="overflow-x-auto" data-testid="qb-peers">
              <table className="w-full text-left text-[0.78rem]">
                <thead className="text-faint">
                  <tr>
                    <th className="py-1 pr-3 font-normal">Peer</th>
                    <th className="py-1 pr-3 font-normal">Client</th>
                    <th className="py-1 pr-3 font-normal">Has</th>
                    <th className="py-1 pr-3 font-normal">↓</th>
                    <th className="py-1 font-normal">↑</th>
                  </tr>
                </thead>
                <tbody>
                  {x.peerList.map((p) => (
                    <tr key={p.address} className="border-t border-line" title={p.flags}>
                      <td className="py-1 pr-3 text-ink tabular">
                        {p.address}
                        {p.country ? <span className="ml-1 text-faint">{p.country}</span> : null}
                      </td>
                      <td className="py-1 pr-3 text-muted">{p.client ?? "?"}</td>
                      <td className="py-1 pr-3 tabular">{p.progressPct}%</td>
                      <td className="py-1 pr-3 tabular">{speed(p.downSpeed)}</td>
                      <td className="py-1 tabular">{speed(p.upSpeed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-muted" data-testid="qb-peers">
              Not connected to anyone right now ({x.peers.seeds} seeds and {x.peers.leechers}{" "}
              leechers reported).
            </p>
          )
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-1" data-testid="qb-transfer">
            <Meta
              label="Downloaded"
              value={bytes(x.transfer?.downloadedBytes ?? t.downloadedBytes)}
            />
            <Meta label="Uploaded" value={bytes(x.transfer?.uploadedBytes ?? 0)} />
            <Meta label="Ratio" value={(x.transfer?.ratio ?? t.ratio).toFixed(2)} />
            {x.activeSec !== undefined && (
              <Meta label="Active" value={eta(x.activeSec) ?? "0 min"} />
            )}
            {x.seedingSec ? <Meta label="Seeding" value={eta(x.seedingSec)!} /> : null}
            {x.piecesTotal ? (
              <Meta label="Pieces" value={`${x.piecesHave ?? 0} of ${x.piecesTotal}`} />
            ) : null}
            {x.savePath && <Meta label="Saved to" value={x.savePath} />}
            {t.addedAt && <Meta label="Added" value={ago(t.addedAt)} />}
            {t.completedAt && <Meta label="Completed" value={ago(t.completedAt)} />}
            {t.lastSeenComplete && (
              <Meta label="Last complete copy seen" value={ago(t.lastSeenComplete)} />
            )}
            {x.transfer?.downLimit ? (
              <Meta label="Download limit" value={speed(x.transfer.downLimit)} />
            ) : null}
            {x.transfer?.upLimit ? (
              <Meta label="Upload limit" value={speed(x.transfer.upLimit)} />
            ) : null}
            {x.transfer?.createdBy && <Meta label="Made with" value={x.transfer.createdBy} />}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <button
          type="button"
          className={btn}
          disabled={act.busy || t.status === "moving"}
          data-hearth-target="torrent:remove"
          title={`Takes it out of ${client.name}; its files stay on disk`}
          onClick={() => propose("remove", {}, "Remove, keep its files")}
        >
          <Trash2 strokeWidth={1.5} className="h-4 w-4" /> Remove, keep files
        </button>
        <button
          type="button"
          disabled={act.busy || t.status === "moving"}
          data-hearth-target="torrent:remove-data"
          onClick={() => propose("remove-with-data", {}, "Remove and delete its files")}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-bad/50 px-3 text-[0.82rem] text-bad hover:bg-bad/10 disabled:opacity-50"
        >
          <Trash2 strokeWidth={1.5} className="h-4 w-4" /> Remove and delete files
        </button>
      </div>
    </div>
  );
}

const PRIORITY: { value: 0 | 1 | 6 | 7; label: string }[] = [
  { value: 0, label: "Do not download" },
  { value: 1, label: "Normal" },
  { value: 6, label: "High" },
  { value: 7, label: "Maximum" },
];

function Files({
  hash,
  name,
  files,
  act,
}: {
  hash: string;
  name: string;
  files: NonNullable<import("@dragon-control/core").TorrentDetail["files"]>;
  act: ApproveHere;
}) {
  const client = useClient();
  if (!files.length) return <p className="text-muted">{client.name} lists no files yet.</p>;
  return (
    <ul className="space-y-1.5" data-testid="qb-files">
      {files.map((f) => (
        <li key={f.index} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className={cx(
              "min-w-0 flex-1 break-all",
              f.priority === 0 ? "text-faint line-through" : "text-ink",
            )}
          >
            {f.name}
          </span>
          <span className="text-faint tabular">
            {bytes(f.sizeBytes)} · {f.progressPct}%
          </span>
          <select
            aria-label={`Priority of ${f.name}`}
            value={f.priority}
            disabled={act.busy}
            data-hearth-target="torrent:file-priority"
            onChange={(e) =>
              void (() => {
                const step = client.step("file-priority", {
                  hash,
                  fileIndexes: String(f.index),
                  filePriority: Number(e.target.value),
                });
                return act.propose(step.kind, step.params, `File priority: ${name}`);
              })()
            }
            className="min-h-9 rounded-lg border border-line bg-panel px-2 text-[0.78rem] text-ink"
          >
            {PRIORITY.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </li>
      ))}
    </ul>
  );
}

/** Reads chosen .torrent files as base64 for the plan (each at most 4 MB). */
function AddTorrent({
  serviceId,
  labelsOn,
  view,
  categories,
  sample,
  onClose,
}: {
  serviceId: string;
  labelsOn: boolean;
  view?: QbView;
  categories: string[];
  sample: boolean;
  onClose: () => void;
}) {
  const client = useClient();
  const act = useApproveHere(serviceId, `Added from ${client.name}'s Torrents tab.`);
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
  const [folder, setFolder] = useState("");
  const [tags, setTags] = useState("");
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const folders = useMemo(() => {
    const all = new Set<string>();
    const root = categoryFolder("", view);
    if (root) all.add(root);
    for (const c of view?.categories ?? []) {
      const f = categoryFolder(c.name, view);
      if (f) all.add(f);
    }
    return [...all];
  }, [view]);
  const where = client.folders ? folder || categoryFolder(category, view) : undefined;
  const count = links.split(/\s+/).filter(Boolean).length + files.length;
  return (
    <>
      {/* The approval pop-up shows once the plan exists; the dialog steps aside for it. */}
      <ApproveDialog c={act} />
      {!act.open && (
        <Sheet label="Add torrent" eyebrow={client.name} title="Add torrent" onClose={onClose}>
          <form
            className="space-y-4"
            data-testid="qb-add-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(undefined);
              const big = files.find((f) => f.size > 4 * 1024 * 1024);
              if (big) return setError(`${big.name} is larger than 4 MB.`);
              if (files.reduce((n, f) => n + f.size, 0) > 4 * 1024 * 1024)
                return setError("Together the files are larger than 4 MB: add them in two goes.");
              try {
                const read = await readFiles(files);
                const step = client.step("add", {
                  urls: links.trim(),
                  ...(read.length ? { files: JSON.stringify(read) } : {}),
                  category,
                  ...(folder ? { savepath: folder } : {}),
                  tags,
                  paused: stopped,
                });
                await act.propose(
                  step.kind,
                  step.params,
                  count === 1 ? "Add a torrent" : `Add ${count} torrents`,
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <Field label="Magnet links or .torrent URLs, one per line">
              <textarea
                value={links}
                onChange={(e) => setLinks(e.target.value)}
                rows={3}
                placeholder="magnet:?xt=urn:btih:..."
                className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-[0.84rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
                data-testid="qb-add-links"
              />
            </Field>
            <div>
              <input
                ref={input}
                type="file"
                accept=".torrent,application/x-bittorrent"
                multiple
                className="hidden"
                data-testid="qb-add-file"
                onChange={(e) => {
                  // Taken now: clearing the input (so the same file can be chosen again) empties
                  // its list before a later state update would read it.
                  const chosen = Array.from(e.target.files ?? []);
                  setFiles((now) => [...now, ...chosen].slice(0, 5));
                  e.target.value = "";
                }}
              />
              <button type="button" className={btn} onClick={() => input.current?.click()}>
                <Plus strokeWidth={1.5} className="h-4 w-4" /> Choose .torrent files
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
              {labelsOn && (
                <Field label={cap(client.word.one)}>
                  {client.freeLabels ? (
                    <>
                      <input
                        value={category}
                        onChange={(e) => setCategory(e.target.value)}
                        list="qb-add-cats"
                        placeholder={client.word.none}
                        maxLength={60}
                        className={cx(sel, "w-full")}
                        data-testid="qb-add-category"
                      />
                      <datalist id="qb-add-cats">
                        {categories.map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>
                    </>
                  ) : (
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      className={cx(sel, "w-full")}
                      data-testid="qb-add-category"
                    >
                      <option value="">{client.word.none}</option>
                      {categories.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              {client.folders && folders.length > 0 && (
                <Field label="Save to">
                  <select
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    className={cx(sel, "w-full")}
                    data-testid="qb-add-folder"
                  >
                    <option value="">
                      {category ? "The category's folder" : "The default folder"}
                    </option>
                    {folders.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            {client.tags && (
              <Field label="Tags (optional, comma separated)">
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  className="min-h-10 w-full rounded-lg border border-line bg-panel px-3 text-[0.84rem] text-ink focus:border-gold/60 focus:outline-none"
                />
              </Field>
            )}
            <label className="flex min-h-10 items-center gap-2 text-[0.84rem] text-ink">
              <input
                type="checkbox"
                checked={stopped}
                onChange={(e) => setStopped(e.target.checked)}
                className="h-5 w-5 accent-[var(--color-gold)]"
              />
              Add it {client.paused} (do not start downloading yet)
            </label>
            {where && <p className="text-[0.78rem] text-faint">Saves to {where}.</p>}
            {sample && (
              <p className="text-[0.78rem] text-amber">
                This is sample data: there is no real {client.name} to add to.
              </p>
            )}
            {(error ?? act.error) && (
              <p role="alert" className="text-[0.82rem] text-amber" data-testid="qb-add-error">
                {error ?? act.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" type="submit" disabled={!count || act.pending}>
                {act.pending ? "Checking…" : count > 1 ? `Add ${count} torrents` : "Add"}
              </Button>
              <Button tone="quiet" onClick={onClose}>
                Cancel
              </Button>
            </div>
            <p className="text-[0.76rem] text-faint">
              You see exactly what gets added, and where, and approve it first.
            </p>
          </form>
        </Sheet>
      )}
    </>
  );
}

function Categories({
  serviceId,
  labelsOn,
  view,
  d,
  sample,
  onClose,
}: {
  serviceId: string;
  labelsOn: boolean;
  view?: QbView;
  d: Data;
  sample: boolean;
  onClose: () => void;
}) {
  const client = useClient();
  const act = useApproveHere(serviceId, `From ${client.name}'s ${client.word.Many}.`);
  const propose = (what: TorrentAct, params: StepParams, title: string) => {
    const step = client.step(what, params);
    void act.propose(step.kind, step.params, title);
  };
  const [name, setName] = useState("");
  const list = view?.categories ?? [];
  const inUse = (c: string) => d.torrents.filter((t) => t.category === c).length;
  return (
    <>
      <ApproveDialog c={act} />
      {!act.open && (
        <Sheet
          label={client.word.Many}
          eyebrow={client.name}
          title={client.word.Many}
          onClose={onClose}
        >
          <div className="space-y-4" data-testid="qb-categories-sheet">
            {!labelsOn && (
              <div className="rounded-xl border border-line p-3 text-[0.84rem]">
                <p className="text-ink">
                  {client.name}&apos;s Label plugin is off, so torrents have no labels yet.
                </p>
                <p className="mt-1 text-[0.78rem] text-muted">
                  Labels sort torrents the way categories do in qBittorrent. Turning the plugin on
                  is a plan you approve.
                </p>
                <Button
                  tone="primary"
                  className="mt-2"
                  disabled={act.busy}
                  onClick={() => propose("labels-on", {}, `Turn on ${client.name}'s labels`)}
                  data-testid="dl-labels-on"
                >
                  Turn on labels
                </Button>
              </div>
            )}
            {sample && (
              <p className="text-[0.82rem] text-amber">
                Sample data: {client.word.many} come from a real {client.name}.
              </p>
            )}
            <ul className="divide-y divide-line rounded-xl border border-line">
              {list.map((c) => {
                const n = inUse(c.name);
                return (
                  <li
                    key={c.name}
                    className="flex flex-wrap items-center gap-2 px-3 py-2 text-[0.84rem]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-ink">{c.name}</p>
                      <p className="text-[0.76rem] break-all text-faint">
                        {client.folders || c.savePath
                          ? `${client.folders ? categoryFolder(c.name, view) : `Moves finished downloads to ${c.savePath}`} · `
                          : ""}
                        {n} torrent{n === 1 ? "" : "s"}
                      </p>
                    </div>
                    {!client.freeLabels && (
                      <button
                        type="button"
                        className={btn}
                        disabled={act.busy || n > 0}
                        title={
                          n > 0
                            ? "Torrents are in it: move them first"
                            : "Removed only if Sonarr, Radarr and Lidarr do not send downloads to it"
                        }
                        onClick={() =>
                          propose(
                            "category-remove",
                            { category: c.name },
                            `Remove the ${client.word.one} ${c.name}`,
                          )
                        }
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
              {!list.length && <li className="px-3 py-3 text-muted">No {client.word.many} yet.</li>}
            </ul>
            {labelsOn && !client.freeLabels && (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim())
                    propose(
                      "category-create",
                      { category: name.trim() },
                      `Create the ${client.word.one} ${name.trim()}`,
                    );
                }}
              >
                <label className="sr-only" htmlFor={`qb-newcat-${serviceId}`}>
                  New {client.word.one}
                </label>
                <input
                  id={`qb-newcat-${serviceId}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={`New ${client.word.one}`}
                  className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 text-[0.84rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
                  data-testid="qb-new-category"
                />
                <Button tone="primary" type="submit" disabled={!name.trim() || act.pending}>
                  Create
                </Button>
              </form>
            )}
            {act.error && (
              <p role="alert" className="text-[0.82rem] text-amber" data-testid="qb-category-error">
                {act.error}
              </p>
            )}
            <p className="text-[0.76rem] leading-relaxed text-faint">
              {client.app === "transmission"
                ? "Transmission's labels need no list: type a new one when you label a torrent, and it shows here while a torrent has it. A torrent's first label is the one Hearth shows."
                : client.app === "deluge"
                  ? "Deluge labels are lower-case letters, digits, - and _. A label with torrents is never removed: change their label first. Where a label moves finished downloads is set in Deluge itself, since Sonarr and Radarr import from those folders."
                  : "A new category saves in qBittorrent's default place for categories. qBittorrent cannot rename a category: create the new one, change each torrent's category, then remove the old one. Category folders are changed in qBittorrent itself, since Sonarr and Radarr import from them."}
            </p>
          </div>
        </Sheet>
      )}
    </>
  );
}
