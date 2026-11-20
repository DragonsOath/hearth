import { useState } from "react";
import { BookOpen, CalendarClock, Headphones, HardDrive, Search, Star } from "lucide-react";
import type { BookFormat, BookItem, LibraryDashboard as Data } from "@dragon-control/core";
import { bytes } from "../../lib/format";
import { Segmented, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";

/**
 * Chaptarr's collection in its panel: what is wanted per format and whether it is on disk, the
 * books coming out (with Want it, a plan you confirm), each author, and the library folders.
 * Chaptarr keeps a record per format, so a book wanted as both an audiobook and an ebook shows
 * twice, once with each.
 */

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";
const FORMAT_WORD: Record<BookFormat, string> = { audiobook: "Audiobook", ebook: "Ebook" };
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;
export const hours = (minutes: number) =>
  minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${minutes} m`;
const day = (iso: string, year = false) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  });

function FormatTag({ format }: { format: BookFormat }) {
  const Icon = format === "audiobook" ? Headphones : BookOpen;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[0.7rem] text-muted"
      data-format={format}
    >
      <Icon strokeWidth={1.5} className="h-3 w-3" />
      {FORMAT_WORD[format]}
    </span>
  );
}

/** The tiles' Audiobooks and Ebooks: on disk out of wanted. */
export function formatTiles(d: Data) {
  return (d.collection?.formats ?? []).map((f) => ({
    label: f.format === "audiobook" ? "Audiobooks" : "Ebooks",
    value: `${f.have.toLocaleString()} / ${f.wanted.toLocaleString()}`,
    sub: `on disk of wanted · ${bytes(f.sizeBytes)}`,
    testId: `lib-format-${f.format}`,
    warn: f.have < f.wanted,
  }));
}

/** One line on the whole collection, and the folders with their free space. */
export function CollectionSummary({ d }: { d: Data }) {
  const c = d.collection;
  if (!c) return null;
  const wanted = c.formats.reduce((n, f) => n + f.wanted, 0);
  const missing = c.formats.reduce((n, f) => n + f.wanted - f.have, 0);
  const unwanted = c.formats.filter((f) => f.unwanted > 0);
  return (
    <div
      className="space-y-2 rounded-xl border border-line bg-bg/40 p-3"
      data-testid="lib-collection"
    >
      <p className="text-[0.84rem] text-muted">
        Chaptarr knows {plural(c.known, "book")} by your {plural(d.totals.people, "author")} (each
        format counted on its own). You want {wanted.toLocaleString()}
        {missing > 0 ? (
          <span className="text-amber">; {missing.toLocaleString()} not on disk yet.</span>
        ) : (
          "; every one of them is on disk."
        )}
        {unwanted.length > 0 &&
          ` ${unwanted
            .map((f) => plural(f.unwanted, f.format === "audiobook" ? "audiobook" : "ebook"))
            .join(
              " and ",
            )} on disk ${unwanted.reduce((n, f) => n + f.unwanted, 0) === 1 ? "is" : "are"} not wanted, so Chaptarr leaves ${unwanted.reduce((n, f) => n + f.unwanted, 0) === 1 ? "it" : "them"} alone.`}
      </p>
      {(d.folders ?? []).length > 0 && (
        <ul className="flex flex-wrap gap-x-5 gap-y-1" data-testid="lib-folders">
          {d.folders!.map((f) => {
            const used =
              f.totalBytes && f.freeBytes !== undefined
                ? Math.round(((f.totalBytes - f.freeBytes) / f.totalBytes) * 100)
                : undefined;
            return (
              <li key={f.path} className="flex items-center gap-1.5 text-[0.78rem] text-faint">
                <HardDrive strokeWidth={1.5} className="h-3.5 w-3.5" />
                <span className="text-ink">{f.name}</span>
                <span className="font-mono">{f.path}</span>
                {f.freeBytes !== undefined && (
                  <span className={cx(used !== undefined && used >= 90 && "text-amber")}>
                    · {bytes(f.freeBytes)} free{f.totalBytes ? ` of ${bytes(f.totalBytes)}` : ""}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function BookLine({ b }: { b: BookItem }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="break-words text-ink">{b.title}</span>
        <FormatTag format={b.format} />
      </span>
      <span className="block text-[0.74rem] text-faint">
        {[
          b.author,
          b.series,
          b.format === "audiobook" && b.narrator ? `read by ${b.narrator}` : undefined,
          b.minutes ? hours(b.minutes) : undefined,
          b.pages ? `${b.pages} pages` : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </span>
  );
}

type Filter = "all" | BookFormat | "missing";

function WantedRow({ serviceId, b }: { serviceId: string; b: BookItem }) {
  const c = useConfirmedChange(serviceId);
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid="lib-wanted"
      data-capture-item
      data-capture-label={b.title}
      data-have={b.have ? "yes" : "no"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.86rem]">
        <BookLine b={b} />
        {b.have ? (
          <span className="text-[0.76rem] text-ok">
            On disk{b.sizeBytes ? ` · ${bytes(b.sizeBytes)}` : ""}
          </span>
        ) : (
          <>
            <span className="text-[0.76rem] text-amber">Not on disk</span>
            <button
              type="button"
              className={btn}
              data-testid="lib-wanted-search"
              onClick={() =>
                void c.propose(
                  "app-chaptarr-control",
                  { op: "search", itemId: b.id },
                  `Search for ${b.title}`,
                )
              }
            >
              <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
            </button>
          </>
        )}
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

/** Every wanted book, by format, with what is on disk; find by title, author, or series. */
export function WantedList({ serviceId, d }: { serviceId: string; d: Data }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [find, setFind] = useState("");
  const [all, setAll] = useState(false);
  const list = d.wanted ?? [];
  const needle = find.trim().toLowerCase();
  const shown = list.filter(
    (b) =>
      (filter === "all" || (filter === "missing" ? !b.have : b.format === filter)) &&
      (!needle || [b.title, b.author, b.series].some((x) => x?.toLowerCase().includes(needle))),
  );
  const count = (f: Filter) =>
    list.filter((b) => (f === "missing" ? !b.have : f === "all" || b.format === f)).length;
  const page = all ? shown : shown.slice(0, 60);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Which wanted books"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: count("all") },
            { value: "audiobook", label: "Audiobooks", count: count("audiobook") },
            { value: "ebook", label: "Ebooks", count: count("ebook") },
            { value: "missing", label: "Not on disk", count: count("missing") },
          ]}
        />
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          aria-label="Find a wanted book, author, or series"
          placeholder="Find a book, author, or series"
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
        />
      </div>
      {page.length ? (
        <ul className="divide-y divide-line">
          {page.map((b) => (
            <WantedRow key={b.id} serviceId={serviceId} b={b} />
          ))}
        </ul>
      ) : (
        <p className="text-[0.86rem] text-muted">
          {list.length ? "Nothing matches." : "No books are wanted yet."}
        </p>
      )}
      {shown.length > page.length && (
        <button type="button" className={btn} onClick={() => setAll(true)}>
          Show all {shown.length.toLocaleString()}
        </button>
      )}
    </div>
  );
}

function ComingRow({ serviceId, b }: { serviceId: string; b: BookItem }) {
  const c = useConfirmedChange(serviceId);
  const want = (monitored: boolean) =>
    void c.propose(
      "app-chaptarr-control",
      { op: "monitor", itemId: b.id, monitored },
      `${monitored ? "Want" : "Stop wanting"} ${b.title}`,
    );
  return (
    <li
      className="space-y-1.5 py-2.5"
      data-testid="lib-coming"
      data-capture-item
      data-capture-label={b.title}
      data-wanted={b.wanted ? "yes" : "no"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.86rem]">
        <span className="flex w-24 shrink-0 items-center gap-1.5 text-[0.78rem] text-muted">
          <CalendarClock strokeWidth={1.5} className="h-4 w-4 text-faint" />
          {b.released ? day(b.released, true) : ""}
        </span>
        <BookLine b={b} />
        {b.wanted ? (
          <>
            <span className="inline-flex items-center gap-1 text-[0.76rem] text-ok">
              <Star strokeWidth={1.5} className="h-3.5 w-3.5" /> Wanted
            </span>
            <button
              type="button"
              className={btn}
              data-testid="lib-unwant"
              onClick={() => want(false)}
            >
              Stop wanting
            </button>
          </>
        ) : (
          <button type="button" className={btn} data-testid="lib-want" onClick={() => want(true)}>
            <Star strokeWidth={1.5} className="h-3.5 w-3.5" /> Want it
          </button>
        )}
      </div>
      <ChangeCard c={c} />
    </li>
  );
}

/** Books by your authors coming out in the next year, wanted or not. */
export function ComingList({ serviceId, d }: { serviceId: string; d: Data }) {
  const list = d.coming ?? [];
  if (!list.length)
    return (
      <p className="text-[0.86rem] text-muted">
        Nothing by your authors is due out in the next year.
      </p>
    );
  const unwanted = list.filter((b) => !b.wanted).length;
  return (
    <div>
      <p className="mb-1 text-[0.76rem] text-faint">
        {plural(list.length, "book")} due in the next year
        {unwanted
          ? `; ${unwanted} ${unwanted === 1 ? "is" : "are"} not wanted, so Chaptarr will not download ${unwanted === 1 ? "it" : "them"}. Want it adds one to your wanted list.`
          : ", all wanted."}
      </p>
      <ul className="divide-y divide-line">
        {list.map((b) => (
          <ComingRow key={b.id} serviceId={serviceId} b={b} />
        ))}
      </ul>
    </div>
  );
}

/** Each author: what is wanted per format, how much is on disk, and the next book. */
export function AuthorList({ d }: { d: Data }) {
  const [find, setFind] = useState("");
  const list = (d.authors ?? []).filter((a) =>
    a.name.toLowerCase().includes(find.trim().toLowerCase()),
  );
  return (
    <div className="space-y-2">
      {(d.authors ?? []).length > 8 && (
        <input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          aria-label="Find an author"
          placeholder="Find an author"
          className="min-h-10 w-full rounded-lg border border-line bg-raised px-3 text-[0.86rem] text-ink"
        />
      )}
      <ul className="divide-y divide-line" data-testid="lib-authors">
        {list.map((a) => {
          const wanted = (a.wanted.audiobook ?? 0) + (a.wanted.ebook ?? 0);
          const gap = wanted - a.have;
          return (
            <li
              key={a.id}
              className={cx("py-2.5 text-[0.86rem]", !a.monitored && "opacity-60")}
              data-testid="lib-author"
              data-capture-item
              data-capture-label={a.name}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-ink">{a.name}</span>
                <span className="text-[0.76rem] text-faint">
                  {a.sizeBytes ? bytes(a.sizeBytes) : "Nothing on disk"}
                </span>
              </div>
              <p className="text-[0.76rem] text-faint">
                {wanted
                  ? [
                      a.wanted.audiobook ? plural(a.wanted.audiobook, "audiobook") : undefined,
                      a.wanted.ebook ? plural(a.wanted.ebook, "ebook") : undefined,
                    ]
                      .filter(Boolean)
                      .join(" and ") + " wanted"
                  : "No books wanted"}
                {wanted > 0 &&
                  (gap > 0 ? (
                    <span className="text-amber"> · {gap} not on disk</span>
                  ) : (
                    " · all on disk"
                  ))}
                {!a.monitored && " · not followed: new books are not added"}
              </p>
              {a.next && (
                <p className="text-[0.76rem] text-muted">
                  Next: {a.next.title}, {day(a.next.on, true)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
