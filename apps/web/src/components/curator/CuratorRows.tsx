import { useState } from "react";
import { Eye, Film } from "lucide-react";
import type { RecommendItem, RecommendRating } from "@dragon-control/core";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { useWorkspace } from "../../data/api";
import { appKindOf } from "../command/Diagnostics";
import { Rail } from "../dashboards/seerr/Rail";
import { TitleSheet } from "../dashboards/seerr/DiscoverRows";
import type { SearchResult } from "../dashboards/seerr/data";
import { OutsideMark } from "./OutsideMark";
import { RateIt } from "./RateIt";

/**
 * Movies and shows as rows of posters, the way Plex shows them (the owner, 11-24): "Missing from
 * your collection" and "In your library" (with Both, one of each). A poster opens the title's
 * full page: missing ones with Request, as in Seerr's Discover; ones you have with Watch on Plex,
 * Jellyfin or Emby.
 */
export function CuratorRows({
  items,
  seerr: given,
  requested,
  onSeen,
}: {
  items: RecommendItem[];
  seerr?: string;
  requested: (i: RecommendItem) => boolean;
  onSeen: (i: RecommendItem, rating?: RecommendRating) => void;
}) {
  // The Seerr the titles came from; else the one connected (every pick may be owned or asked
  // for already, so none carries a request to read it from).
  const ws = useWorkspace().data;
  const seerr = given ?? (ws?.services ?? []).find((s) => appKindOf(s) === "seerr")?.id;
  // The title page's requests go to this Seerr, approved like Discover's.
  const act = useApproveHere(seerr ?? "", "Requested from Curator.");
  const [open, setOpen] = useState<{ r: SearchResult; have: boolean; i: RecommendItem }>();
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
  const row = (label: string, list: RecommendItem[], testId: string) =>
    list.length > 0 && (
      <section aria-label={label} className="space-y-2" data-testid={testId}>
        <h3 className="eyebrow">
          {label} <span className="text-faint">· {list.length}</span>
        </h3>
        <Rail label={label}>
          {list.map((i) => (
            <Tile key={i.key} i={i} requested={requested(i)} onOpen={show(i)} />
          ))}
        </Rail>
      </section>
    );
  return (
    <div className="space-y-5" data-testid="recommend-results">
      {row("Missing from your collection", missing, "recommend-row-missing")}
      {row("In your library", have, "recommend-row-have")}
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
}: {
  i: RecommendItem;
  requested: boolean;
  onOpen?: () => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <li className="w-[9.5rem] shrink-0 snap-start space-y-1.5" data-testid="recommend-item">
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
