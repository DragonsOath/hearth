import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cx } from "../ui";

/**
 * A media server's home screen as the server itself shows it (11-22, the owner: "just a layout
 * like what you see" on Plex's own Home): each row's name, then its posters in one line that
 * scrolls sideways, with the title and year under each. Nothing to edit here; Home rows changes it.
 */

export interface ScreenItem {
  key: string;
  title: string;
  /** The year, or an episode's "S3 · E10". */
  sub?: string;
  src?: string;
}

const TONES = [
  "bg-[#3b1d2a] text-[#ffb3c7]",
  "bg-[#1d2f4a] text-[#a9cbff]",
  "bg-[#2a2a12] text-[#f0e48a]",
  "bg-[#13322a] text-[#8fe3c4]",
  "bg-[#331f12] text-[#ffbf8f]",
  "bg-[#251a3b] text-[#cdb6ff]",
];

const W = "w-[112px] sm:w-[136px]";

function Poster({ item, tone }: { item: ScreenItem; tone: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <li className={cx(W, "shrink-0 snap-start")} data-testid="screen-poster">
      {item.src && !failed ? (
        <img
          src={item.src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="aspect-[2/3] w-full rounded-md bg-line object-cover shadow-[0_4px_14px_rgba(0,0,0,0.35)]"
        />
      ) : (
        <span
          className={cx(
            "flex aspect-[2/3] w-full items-end rounded-md p-2 text-[0.78rem] leading-tight font-bold",
            tone,
          )}
          aria-hidden
        >
          {item.title}
        </span>
      )}
      <p className="mt-1.5 truncate text-[0.8rem] font-semibold text-ink" title={item.title}>
        {item.title}
      </p>
      {item.sub && <p className="truncate text-[0.74rem] text-faint">{item.sub}</p>}
    </li>
  );
}

/** One row: its name, then posters that scroll sideways, with arrows at the ends. */
export function ScreenRow({
  title,
  items,
  loading,
  empty,
}: {
  title: string;
  items: ScreenItem[];
  loading?: boolean;
  /** Said when the row has nothing right now; without it an empty row is left out. */
  empty?: string;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const look = () => {
    const el = strip.current;
    if (!el) return;
    setEnds({
      start: el.scrollLeft <= 4,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    });
  };
  useEffect(() => {
    look();
    const el = strip.current;
    if (!el) return;
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, loading]);
  const go = (dir: -1 | 1) => {
    const el = strip.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };
  if (!loading && !items.length && !empty) return null;
  return (
    <section aria-label={title} className="space-y-2" data-testid="screen-row">
      <h3 className="text-[1rem] font-bold text-ink">{title}</h3>
      {loading ? (
        <ul className="flex gap-3 overflow-hidden" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <li
              key={i}
              className={cx(W, "aspect-[2/3] shrink-0 animate-pulse rounded-md bg-raised")}
            />
          ))}
        </ul>
      ) : !items.length ? (
        <p className="text-[0.84rem] text-faint">{empty}</p>
      ) : (
        <div className="relative">
          <ul
            ref={strip}
            onScroll={look}
            tabIndex={0}
            aria-label={`${title}, scrolls sideways`}
            className="flex snap-x gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {items.map((x, i) => (
              <Poster key={`${x.key}-${i}`} item={x} tone={TONES[i % TONES.length]!} />
            ))}
          </ul>
          {!ends.start && (
            <button
              type="button"
              onClick={() => go(-1)}
              aria-label={`Back in ${title}`}
              className="absolute top-0 left-0 grid aspect-[2/3] w-11 place-items-center rounded-l-md bg-gradient-to-r from-bg/95 to-transparent text-ink hover:text-gold"
            >
              <ChevronLeft className="h-7 w-7" />
            </button>
          )}
          {!ends.end && (
            <button
              type="button"
              onClick={() => go(1)}
              aria-label={`More of ${title}`}
              className="absolute top-0 right-0 grid aspect-[2/3] w-11 place-items-center rounded-r-md bg-gradient-to-l from-bg/95 to-transparent text-ink hover:text-gold"
            >
              <ChevronRight className="h-7 w-7" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Libraries as tiles, as Jellyfin's and Emby's My Media row shows them. */
export function ScreenTiles({ title, names }: { title: string; names: string[] }) {
  if (!names.length) return null;
  return (
    <section aria-label={title} className="space-y-2" data-testid="screen-row">
      <h3 className="text-[1rem] font-bold text-ink">{title}</h3>
      <ul
        tabIndex={0}
        aria-label={`${title}, scrolls sideways`}
        className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {names.map((n, i) => (
          <li
            key={`${n}-${i}`}
            className="grid h-[84px] w-[180px] shrink-0 place-items-center rounded-md border border-line bg-panel px-3 text-center text-[0.9rem] font-semibold text-ink"
          >
            {n}
          </li>
        ))}
      </ul>
    </section>
  );
}
