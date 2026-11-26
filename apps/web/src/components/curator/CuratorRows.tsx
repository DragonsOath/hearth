import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Eye, Film, X } from "lucide-react";
import type { RecommendItem, RecommendRating } from "@dragon-control/core";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { useWorkspace } from "../../data/api";
import { appKindOf } from "../command/Diagnostics";
import { Rail } from "../dashboards/seerr/Rail";
import { TitleSheet } from "../dashboards/seerr/DiscoverRows";
import type { SearchResult } from "../dashboards/seerr/data";
import { OutsideMark } from "./OutsideMark";
import { RateIt } from "./RateIt";

/** Each row shows this many; See all opens every one (the owner, 11-25: "maybe only show 10"). */
const PREVIEW = 10;

/**
 * Movies and shows as rows of posters, the way Plex shows them (the owner, 11-24): "Missing from
 * your collection" and "In your library" (with Both, one of each). A poster opens the title's
 * full page: missing ones with Request, as in Seerr's Discover; ones you have with Watch on Plex,
 * Jellyfin or Emby. No set number of titles: each row shows the first 10, and See all
 * opens every one, with More like these at the end for the next ones Ember finds.
 */
export function CuratorRows({
  items,
  seerr: given,
  requested,
  onSeen,
  onMore,
  finding,
}: {
  items: RecommendItem[];
  seerr?: string;
  requested: (i: RecommendItem) => boolean;
  onSeen: (i: RecommendItem, rating?: RecommendRating) => void;
  /** More like these: asks Ember for the next titles that fit. */
  onMore?: () => void;
  finding?: boolean;
}) {
  // The Seerr the titles came from; else the one connected (every pick may be owned or asked
  // for already, so none carries a request to read it from).
  const ws = useWorkspace().data;
  const seerr = given ?? (ws?.services ?? []).find((s) => appKindOf(s) === "seerr")?.id;
  // The title page's requests go to this Seerr, approved like Discover's.
  const act = useApproveHere(seerr ?? "", "Requested from Curator.");
  const [open, setOpen] = useState<{ r: SearchResult; have: boolean; i: RecommendItem }>();
  const [all, setAll] = useState<{ label: string; have: boolean }>();
  const missing = items.filter((i) => !i.have);
  const have = items.filter((i) => i.have);
  const show = (i: RecommendItem) =>
    seerr && i.tmdbId
      ? () =>
          setOpen({
            i,
            have: Boolean(i.have),
            r: {
              tmdbId: i.tmdbId!,
              mediaType: i.mediaType ?? (i.kind === "show" ? "tv" : "movie"),
              title: i.title,
              ...(i.year ? { year: i.year } : {}),
              overview: i.why,
              status: i.have
                ? "available"
                : requested(i)
                  ? "requested"
                  : i.partial
                    ? "partly available"
                    : "not requested",
            },
          })
      : undefined;
  const row = (label: string, list: RecommendItem[], testId: string, owned: boolean) =>
    list.length > 0 && (
      <section aria-label={label} className="space-y-2" data-testid={testId}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="eyebrow">
            {label} <span className="text-faint">· {list.length}</span>
          </h3>
          <button
            type="button"
            onClick={() => setAll({ label, have: owned })}
            className="inline-flex min-h-10 items-center gap-1 rounded-lg px-2 text-[0.84rem] text-gold hover:underline"
            data-testid="recommend-see-all"
          >
            See all <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <Rail label={label}>
          {list.slice(0, PREVIEW).map((i) => (
            <Tile key={i.key} i={i} requested={requested(i)} onOpen={show(i)} />
          ))}
          {list.length > PREVIEW && (
            <li className="w-[9.5rem] shrink-0 snap-start">
              <button
                type="button"
                onClick={() => setAll({ label, have: owned })}
                className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-1 rounded-lg border border-line-strong bg-raised text-ink transition hover:border-gold"
                data-testid="recommend-see-all-tile"
              >
                <span className="font-display text-[1.4rem]">+{list.length - PREVIEW}</span>
                <span className="text-[0.82rem] text-gold">See all</span>
              </button>
            </li>
          )}
        </Rail>
      </section>
    );
  const allList = all ? (all.have ? have : missing) : [];
  return (
    <div className="space-y-5" data-testid="recommend-results">
      {row("Missing from your collection", missing, "recommend-row-missing", false)}
      {row("In your library", have, "recommend-row-have", true)}
      {all && (
        <SeeAll
          label={all.label}
          count={allList.length}
          onClose={() => setAll(undefined)}
          more={
            onMore && (
              <button
                type="button"
                disabled={finding}
                onClick={onMore}
                className="min-h-11 w-full rounded-lg border border-line-strong px-4 text-[0.88rem] text-ink hover:border-gold/60 disabled:opacity-50"
                data-testid="recommend-all-more"
              >
                {finding ? "Ember is looking for more…" : "More like these"}
              </button>
            )
          }
        >
          {allList.map((i) => (
            <Tile key={i.key} i={i} requested={requested(i)} onOpen={show(i)} fill />
          ))}
        </SeeAll>
      )}
      {open && seerr && (
        <TitleSheet
          key={`${open.r.mediaType}:${open.r.tmdbId}`}
          serviceId={seerr}
          r={open.r}
          have={open.have}
          extra={
            <SeenIt
              key={open.i.key}
              onDone={(rating) => {
                onSeen(open.i, rating);
                setOpen(undefined);
              }}
            />
          }
          act={act}
          onClose={() => setOpen(undefined)}
        />
      )}
      <ApproveDialog c={act} />
    </div>
  );
}

function Tile({
  i,
  requested,
  onOpen,
  fill,
}: {
  i: RecommendItem;
  requested: boolean;
  onOpen?: () => void;
  /** In See all: as wide as its column. */
  fill?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <li
      className={fill ? "min-w-0 space-y-1.5" : "w-[9.5rem] shrink-0 snap-start space-y-1.5"}
      data-testid="recommend-item"
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        aria-label={`${i.title}${i.year ? ` (${i.year})` : ""}: open`}
        className="relative block aspect-[2/3] w-full overflow-hidden rounded-lg border border-line bg-raised transition hover:border-gold focus-visible:border-gold disabled:cursor-default"
        data-testid="recommend-open-title"
      >
        {i.image && !broken ? (
          <img
            src={i.image}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full items-center justify-center text-faint">
            <Film strokeWidth={1.4} className="h-8 w-8" aria-hidden />
          </span>
        )}
        {(i.have || requested || i.partial) && (
          <span
            className="absolute top-1.5 left-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[0.66rem] text-white"
            data-testid={
              i.have ? "recommend-have" : requested ? "recommend-requested" : "recommend-partial"
            }
          >
            {i.have ? "In your library" : requested ? "Requested" : "Some seasons"}
          </span>
        )}
      </button>
      <div className="flex items-start gap-1">
        {i.outside && <OutsideMark />}
        <p className="line-clamp-2 text-[0.82rem] leading-tight font-semibold text-ink">
          {i.title}
          {i.year ? <span className="font-normal text-muted"> ({i.year})</span> : null}
        </p>
      </div>
      {i.why && <p className="line-clamp-3 text-[0.74rem] leading-snug text-muted">{i.why}</p>}
    </li>
  );
}

/** Seen it, in the title's page (11-24): How was it? stars, a reaction, a note; all optional. */
function SeenIt({ onDone }: { onDone: (rating?: RecommendRating) => void }) {
  const [rating, setRating] = useState<RecommendRating>();
  return rating ? (
    <div className="w-full">
      <RateIt word="Seen it" value={rating} onChange={setRating} onDone={onDone} />
    </div>
  ) : (
    <button
      type="button"
      onClick={() => setRating({})}
      title="Take it off the list for good, and say how it was if you like"
      className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong px-4 text-[0.88rem] text-ink hover:border-gold"
      data-testid="recommend-seen"
    >
      <Eye strokeWidth={1.6} className="h-4 w-4" aria-hidden /> Seen it
    </button>
  );
}

/**
 * See all (the owner, 11-25): a big pop-up box like the title page, every poster in rows of five
 * (fewer on a phone), about four rows in view, scrolling down inside the box, and More like
 * these at the end.
 */
function SeeAll({
  label,
  count,
  onClose,
  more,
  children,
}: {
  label: string;
  count: number;
  onClose: () => void;
  more?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
      className="m-auto max-h-[92vh] w-[min(76rem,calc(100vw-1.5rem))] max-w-none overflow-clip rounded-2xl border border-line-strong bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm"
      data-testid="recommend-all"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => ref.current?.close()}
        className="absolute top-3 right-3 z-30 grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white shadow-lg hover:bg-gold hover:text-bg"
        data-testid="close-pinned"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="max-h-[92vh] space-y-4 overflow-y-auto p-6" data-testid="window-scroll">
        <div className="pr-10">
          <p className="eyebrow mb-1">Curator</p>
          <p className="font-display text-[1.5rem] leading-tight text-ink">
            {label} <span className="text-muted">· {count}</span>
          </p>
        </div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
          {children}
        </ul>
        {more}
      </div>
    </dialog>
  );
}
