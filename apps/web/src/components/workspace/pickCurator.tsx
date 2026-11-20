import { useState } from "react";
import { ChevronDown, Clock, Eye, Send, Sparkles, Undo2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecommendItem, RecommendResult, WorkspaceSpec } from "@dragon-control/core";
import { api } from "../../data/api";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { ToolImage } from "../panels/ToolImage";
import { RequestAsk, TrailerLink, saveParams, type SaveChoice } from "../dashboards/seerr/request";

/**
 * Curator inside a Forge pick sheet (11-09): a row Ember builds from your library can come up
 * short (24 Thanksgiving movies for a row of 25), and the best fits may be ones you don't have.
 * One tap asks Curator for the sheet's theme, minus everything already in the sheet; Hearth checks
 * each title against Seerr, so only real titles you don't have are shown. Request it is the same
 * as the sheet's own request: a plan you approve, and the title joins Selected once it is in Plex.
 * Seen it takes a title off for good, with Undo right there (11-10). The section collapses with
 * the arrow in its corner, and remembers that. Ember sees the sheet's title and the titles in it, nothing
 * else from your library.
 */

/** A title requested from this sheet, waiting to arrive in Plex. */
interface Awaiting {
  tmdbId: number;
}

/** "movie:123" or "tv:123" (Curator's key for Seerr titles). */
function seerrIds(i: RecommendItem): { mediaType: "movie" | "tv"; tmdbId: number } | undefined {
  const m = /^(movie|tv):(\d+)$/.exec(i.key);
  return m ? { mediaType: m[1] as "movie" | "tv", tmdbId: Number(m[2]) } : undefined;
}

/** Shows when most of the sheet's titles say they are shows; movies otherwise. */
function kindOf(spec: WorkspaceSpec): "movie" | "show" {
  const col = spec.columns.find((c) => /\b(kind|type)\b/i.test(`${c.key} ${c.label}`));
  if (!col) return /\b(shows?|series|tv)\b/i.test(spec.title) ? "show" : "movie";
  let shows = 0;
  for (const i of spec.items) if (/show|series|tv/i.test(String(i.values[col.key] ?? ""))) shows++;
  return shows > spec.items.length / 2 ? "show" : "movie";
}

export function CuratorPicks({
  workspaceId,
  spec,
  count,
  target,
}: {
  workspaceId: string;
  spec: WorkspaceSpec;
  count: number;
  target?: number;
}) {
  const qc = useQueryClient();
  const first = spec.columns[0]?.key ?? "";
  const [result, setResult] = useState<RecommendResult>();
  const [shown, setShown] = useState<RecommendItem[]>([]);
  const [asked, setAsked] = useState<number[]>([]);
  const [wide, setWide] = useState(false);
  // Titles marked Seen it here: shown as one line with Undo until the sheet closes.
  const [gone, setGone] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("hearth.forge.curator.collapsed") === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("hearth.forge.curator.collapsed", c ? "0" : "1");
      } catch {
        /* per-viewer convenience only */
      }
      return !c;
    });
  const waiting = useQuery({
    queryKey: ["forge-awaiting", workspaceId],
    queryFn: () => api<{ awaiting: Awaiting[] }>("GET", `/api/workspaces/${workspaceId}/awaiting`),
  });
  const find = useMutation({
    mutationFn: (more: boolean) =>
      api<RecommendResult>("POST", "/api/recommend", {
        kind: kindOf(spec),
        interest: `${spec.title}${spec.description ? `: ${spec.description}` : ""}`.slice(0, 300),
        exclude: [
          ...(more ? shown.map((i) => i.title) : []),
          ...spec.items.map((i) => String(i.values[first] ?? i.id).slice(0, 200)),
        ].slice(0, 200),
        show: "missing",
        ...(wide ? { wide } : {}),
      }),
    onSuccess: (r, more) => {
      setResult(r);
      setShown((s) =>
        more ? [...s, ...r.items.filter((i) => !s.some((x) => x.key === i.key))] : r.items,
      );
    },
  });
  const remember = useMutation({
    mutationFn: (i: RecommendItem) =>
      api("POST", `/api/workspaces/${workspaceId}/awaiting`, {
        ...seerrIds(i)!,
        title: i.title,
        ...(i.year ? { year: i.year } : {}),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["forge-awaiting", workspaceId] }),
  });
  const seen = useMutation({
    mutationFn: (i: RecommendItem) =>
      api("POST", "/api/recommend/seen", {
        kind: i.kind,
        title: i.title,
        ...(i.year ? { year: i.year } : {}),
      }),
    onMutate: (i) => setGone((g) => [...g, i.key]),
    onError: (_e, i) => setGone((g) => g.filter((k) => k !== i.key)),
  });
  const unseen = useMutation({
    mutationFn: (i: RecommendItem) =>
      api("POST", "/api/recommend/unseen", {
        kind: i.kind,
        title: i.title,
        ...(i.year ? { year: i.year } : {}),
      }),
    onSuccess: (_r, i) => setGone((g) => g.filter((k) => k !== i.key)),
  });
  const act = useApproveHere("", "Requested from a Forge sheet with Curator.");
  const [save, setSave] = useState<SaveChoice>({});
  // A title waiting on Request's question (quality and root folder) before the approval.
  const [ask, setAsk] = useState<RecommendItem>();
  const send = (i: RecommendItem, where?: SaveChoice) => {
    const ids = seerrIds(i)!;
    if (i.request?.kind === "plan")
      void act.propose(
        i.request.step as Parameters<typeof act.propose>[0],
        i.request.step === "app-seerr-request"
          ? { ...i.request.params, ...saveParams(where ?? save) }
          : i.request.params,
        i.request.label,
        i.request.serviceId,
      );
    setAsked((a) => [...a, ids.tmdbId]);
    remember.mutate(i);
  };
  // The Seerr the movie or show requests go to.
  const seerrReq = shown.find(
    (i) => i.request?.kind === "plan" && i.request.step === "app-seerr-request",
  );
  const seerrService = seerrReq?.request?.kind === "plan" ? seerrReq.request.serviceId : undefined;
  const awaiting = waiting.data?.awaiting ?? [];
  const isWaiting = (id: number) => awaiting.some((a) => a.tmdbId === id) || asked.includes(id);
  const short = target !== undefined && count < target;

  return (
    <section
      aria-label="Curator: not in your library"
      className="rounded-lg border border-gold/40 p-2"
      data-testid="pick-curator"
    >
      <div className="flex flex-wrap items-center gap-2 px-1">
        <ToolImage id="curator" className="h-8 w-8" />
        <p className="min-w-0 flex-1 text-[0.8rem] text-muted">
          {short
            ? `Your library has ${count} of ${target}. Curator can find good ones you don't have yet.`
            : "Curator can find good ones for this you don't have yet."}
        </p>
        <label
          className="flex min-h-9 cursor-pointer items-center gap-1.5 text-[0.78rem] text-ink"
          data-testid="pick-curator-wide"
        >
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--color-gold)]"
            checked={wide}
            onChange={(e) => setWide(e.target.checked)}
          />
          Think outside the box
        </label>
        {!result && !collapsed && (
          <button
            type="button"
            disabled={find.isPending}
            onClick={() => find.mutate(false)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-gold px-3 text-[0.8rem] font-bold text-[#1a0d05] disabled:opacity-50"
            data-testid="pick-curator-find"
          >
            <Sparkles
              strokeWidth={1.8}
              className={find.isPending ? "h-3.5 w-3.5 animate-pulse" : "h-3.5 w-3.5"}
              aria-hidden
            />
            {find.isPending
              ? wide
                ? "On it, thinking outside the box…"
                : "Curator is looking…"
              : "Find ones I don't have"}
          </button>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show Curator" : "Hide Curator"}
          title={collapsed ? "Show Curator" : "Hide Curator"}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line text-muted hover:border-gold/60 hover:text-gold"
          data-testid="pick-curator-collapse"
        >
          <ChevronDown
            strokeWidth={1.8}
            className={
              collapsed ? "h-4 w-4 -rotate-90 transition-transform" : "h-4 w-4 transition-transform"
            }
            aria-hidden
          />
        </button>
      </div>
      {!collapsed && (
        <>
          {wide && (
            <p
              className="px-1 pt-1 text-[0.78rem] text-gold"
              role="status"
              data-testid="pick-curator-wide-on"
            >
              On it: I&apos;ll look past the obvious too, for titles with the same feel and heart.
            </p>
          )}
          {result?.missingApp && (
            <p className="px-1 pt-2 text-[0.8rem] text-warn">{result.missingApp}</p>
          )}
          {shown.length > 0 && (
            <ul className="mt-2 grid gap-1.5">
              {shown.map((i) => {
                const ids = seerrIds(i);
                const mine = ids ? isWaiting(ids.tmdbId) : false;
                if (gone.includes(i.key))
                  return (
                    <li
                      key={i.key}
                      className="flex min-h-9 items-center gap-2 rounded-lg border border-dashed border-line/70 px-2.5 py-1 text-[0.8rem] text-muted"
                      data-testid="pick-curator-seen-row"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {i.title} is marked as seen and won&apos;t be suggested again.
                      </span>
                      <button
                        type="button"
                        disabled={unseen.isPending}
                        onClick={() => unseen.mutate(i)}
                        className="inline-flex min-h-8 items-center gap-1 rounded-md border border-gold/50 px-2 text-[0.76rem] text-gold hover:bg-gold/10 disabled:opacity-50"
                        data-testid="pick-curator-undo"
                      >
                        <Undo2 strokeWidth={1.6} className="h-3.5 w-3.5" aria-hidden /> Undo
                      </button>
                    </li>
                  );
                return (
                  <li
                    key={i.key}
                    className="flex items-center gap-2 rounded-lg border border-line/70 px-2.5 py-1.5"
                    data-testid="pick-curator-item"
                  >
                    {i.image && (
                      <img
                        src={i.image}
                        alt=""
                        loading="lazy"
                        className="aspect-[2/3] w-9 shrink-0 rounded border border-line object-cover"
                        onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.84rem] text-ink">
                        {i.title}
                        {i.year ? <span className="text-faint"> ({i.year})</span> : null}
                      </span>
                      {i.why && (
                        <span className="line-clamp-2 block text-[0.72rem] text-faint">
                          {i.why}
                        </span>
                      )}
                    </span>
                    {mine ? (
                      <span className="inline-flex items-center gap-1 text-[0.74rem] text-gold">
                        <Clock strokeWidth={1.75} className="h-3.5 w-3.5" /> Joins when it arrives
                      </span>
                    ) : ids ? (
                      <button
                        type="button"
                        disabled={act.busy || remember.isPending}
                        onClick={() => {
                          // Already requested by someone: only wait for it. Otherwise ask where it
                          // saves first (or say it's already in the library), then the approval.
                          if (!i.requested && i.request?.kind === "plan" && seerrService) setAsk(i);
                          else send(i);
                        }}
                        className="inline-flex min-h-8 items-center gap-1 rounded-md border border-gold/50 px-2 text-[0.76rem] text-gold hover:bg-gold/10 disabled:opacity-50"
                        aria-label={
                          i.requested ? `Add ${i.title} when it arrives` : `Request ${i.title}`
                        }
                        data-testid="pick-curator-request"
                      >
                        <Send strokeWidth={1.5} className="h-3.5 w-3.5" />
                        {i.requested ? "Add when it arrives" : "Request it"}
                      </button>
                    ) : null}
                    {ids && seerrService && (
                      <TrailerLink
                        serviceId={seerrService}
                        type={ids.mediaType}
                        tmdbId={ids.tmdbId}
                        title={i.title}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => seen.mutate(i)}
                      title="Take it off the list for good"
                      aria-label={`Seen ${i.title}`}
                      className="inline-flex min-h-8 items-center gap-1 rounded-md border border-line px-2 text-[0.76rem] text-muted hover:text-ink"
                      data-testid="pick-curator-seen"
                    >
                      <Eye strokeWidth={1.5} className="h-3.5 w-3.5" /> Seen it
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {result && !result.missingApp && (
            <div className="space-y-1 px-1 pt-2 text-[0.76rem] text-muted">
              {result.owned.length > 0 && (
                <p data-testid="pick-curator-owned">
                  Already in your library (search above to add):{" "}
                  {result.owned
                    .map((o) => (o.year ? `${o.title} (${o.year})` : o.title))
                    .join(", ")}
                  .
                </p>
              )}
              {!shown.length && <p>Nothing new this time.</p>}
              <button
                type="button"
                disabled={find.isPending}
                onClick={() => find.mutate(true)}
                className="min-h-9 rounded-md border border-line-strong px-3 text-[0.78rem] text-ink hover:border-gold/60 disabled:opacity-50"
                data-testid="pick-curator-more"
              >
                {find.isPending ? "Curator is looking…" : "More like these"}
              </button>
            </div>
          )}
          {(find.error || act.error || remember.isError) && (
            <p className="px-1 pt-1 text-[0.78rem] text-amber" role="alert">
              {(find.error as Error | null)?.message ??
                act.error ??
                (remember.error as Error | null)?.message}
            </p>
          )}
          {ask && seerrService && (
            <RequestAsk
              items={[
                {
                  serviceId: seerrService,
                  type: seerrIds(ask)!.mediaType,
                  tmdbId: seerrIds(ask)!.tmdbId,
                  title: `${ask.title}${ask.year ? ` (${ask.year})` : ""}`,
                },
              ]}
              value={save}
              onChange={setSave}
              onClose={() => setAsk(undefined)}
              onRequest={(where) => {
                const i = ask;
                setAsk(undefined);
                setSave(where);
                send(i, where);
              }}
            />
          )}
        </>
      )}
      <ApproveDialog c={act} />
    </section>
  );
}
