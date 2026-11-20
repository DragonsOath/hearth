import { useState } from "react";
import { BookAudio, DatabaseBackup, RefreshCw, X } from "lucide-react";
import type { AudiobookshelfBook, AudiobookshelfDashboard as Data } from "@dragon-control/core";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { Button, Skeleton, cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";
import { AbsLists, BookListActions, NewPlaylist } from "./AudiobookshelfLists";
import { PasteKey } from "./PasteKey";
import { ScanLibraries } from "./ScanLibraries";

/**
 * Audiobookshelf from Hearth: who is listening and how far along, each library (books or
 * podcasts, how many, how many hours, how much space, what was just added with its cover and
 * details), and backups. Covers come through Hearth, so Audiobookshelf's key stays on the server.
 * Scanning a library and making a backup now are plans confirmed here.
 */

/** A book's cover through Hearth, or a plain tile with its initials when it has none. */
function Cover({
  serviceId,
  id,
  has,
  title,
  className,
}: {
  serviceId: string;
  id?: string;
  has?: boolean;
  title: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const box = cx(
    "aspect-square overflow-hidden rounded-lg border border-line bg-raised",
    className,
  );
  if (!id || !has || failed)
    return (
      <span className={cx(box, "grid place-items-center text-faint")} aria-hidden>
        <BookAudio strokeWidth={1.4} className="h-1/3 w-1/3" />
      </span>
    );
  return (
    <img
      src={`/api/services/${encodeURIComponent(serviceId)}/dashboard/abs-cover?item=${encodeURIComponent(id)}`}
      alt={`Cover of ${title}`}
      loading="lazy"
      className={cx(box, "object-cover")}
      onError={() => setFailed(true)}
      data-testid="abs-cover"
    />
  );
}

/** Everything Audiobookshelf says about one book. */
function BookDetail({
  serviceId,
  b,
  onClose,
  inList,
  inContinue,
}: {
  serviceId: string;
  b: AudiobookshelfBook;
  onClose: () => void;
  inList?: { id: string; kind: "playlist" | "collection" };
  /** It's on the Continue listening shelf, so it can be taken off (11-07). */
  inContinue?: boolean;
}) {
  const name = b.name ?? b.title;
  const off = useConfirmedChange(serviceId);
  const facts: [string, string | undefined][] = [
    ["Author", b.author],
    ["Narrator", b.narrator],
    ["Series", b.series],
    ["Published", b.year],
    ["Length", b.hours ? `${b.hours.toLocaleString()} hours` : undefined],
    ["Genres", b.genres?.join(", ")],
    ["Added", b.at ? ago(b.at) : undefined],
  ];
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-gold/40 bg-bg/70 p-3 @md:flex-row"
      data-testid="abs-book"
    >
      <Cover serviceId={serviceId} id={b.id} has={b.cover} title={name} className="w-32 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-[0.95rem] text-ink">{name}</p>
          <button
            type="button"
            aria-label="Close book details"
            className="text-muted hover:text-ink"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5 text-[0.8rem]">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className="text-ink">{v}</dd>
              </div>
            ))}
        </dl>
        {b.description && (
          <p className="text-[0.8rem] leading-relaxed text-muted">{b.description}</p>
        )}
        <BookListActions book={b} inList={inList} />
        {inContinue && b.id && (
          <button
            type="button"
            className={btn}
            data-testid="abs-continue-remove"
            onClick={() =>
              void off.propose(
                "app-audiobookshelf-control",
                { op: "continue-remove", itemId: b.id! },
                `Take ${name} out of Continue listening`,
              )
            }
          >
            <X strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove from Continue listening
          </button>
        )}
        <ChangeCard c={off} />
      </div>
    </div>
  );
}

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold";

/** 5:12:03, or 12:03 under an hour. */
function clock(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(ss)}` : `${m}:${two(ss)}`;
}

function Bar({ pct, label }: { pct: number; label: string }) {
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-line"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The book you are listening to (or listened to last), exactly where you are in it. */
function NowListening({
  serviceId,
  n,
}: {
  serviceId: string;
  n: NonNullable<Data["nowListening"]>;
}) {
  const name = n.book.name ?? n.book.title;
  const c = n.chapter;
  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-gold/40 bg-bg/60 p-3 @md:flex-row"
      data-testid="abs-now"
      aria-label="Currently listening"
    >
      <Cover
        serviceId={serviceId}
        id={n.book.id}
        has={n.book.cover}
        title={name}
        className="w-40 shrink-0 self-start"
      />
      <div className="min-w-0 flex-1 space-y-2.5">
        <p className="text-[0.72rem] tracking-wide text-faint uppercase">
          {n.live ? (
            <span className="text-live">Listening now</span>
          ) : (
            <>Currently listening{n.lastListened ? ` · last played ${ago(n.lastListened)}` : ""}</>
          )}
        </p>
        <div>
          <p className="font-display text-[1.15rem] leading-snug text-ink">{name}</p>
          <p className="text-[0.82rem] text-muted">
            {[n.book.author, n.book.narrator && `read by ${n.book.narrator}`, n.book.series]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {c && (
          <div className="space-y-1" data-testid="abs-now-chapter">
            <p className="text-[0.84rem] text-ink">
              Chapter {c.number} of {c.count}
              {c.title && !/^chapter \d+$/i.test(c.title) ? `: ${c.title}` : ""}
            </p>
            <Bar pct={c.pct} label={`${c.pct}% through the chapter`} />
            <p className="text-[0.76rem] text-faint">
              {c.pct}% through the chapter · {clock(n.positionSec - c.startSec)} of{" "}
              {clock(c.endSec - c.startSec)} · {clock(c.endSec - n.positionSec)} left in it
            </p>
          </div>
        )}
        <div className="space-y-1" data-testid="abs-now-position">
          <p className="text-[0.84rem] text-ink">
            {clock(n.positionSec)} of {clock(n.durationSec)}
          </p>
          <Bar pct={n.progressPct} label={`${n.progressPct}% through the book`} />
          <p className="text-[0.76rem] text-faint">
            {n.progressPct}% through the book · {clock(Math.max(0, n.durationSec - n.positionSec))}{" "}
            left
          </p>
        </div>
      </div>
    </section>
  );
}

type ShelfBook = AudiobookshelfBook & { progressPct?: number; lastListened?: string };

/**
 * A row of covers that scrolls sideways, like Audiobookshelf's own home page; opening one shows
 * its details under the row. In-progress books carry a progress bar.
 */
function Shelf({
  serviceId,
  label,
  books,
  testid,
  compact,
  inList,
  inContinue,
}: {
  serviceId: string;
  label: string;
  books: ShelfBook[];
  testid: string;
  compact?: boolean;
  inContinue?: boolean;
  /** This shelf is one of your lists, so its books can be moved and taken out. */
  inList?: { id: string; kind: "playlist" | "collection" };
}) {
  // Kept by id: moving a book changes its place in the row.
  const [openId, setOpenId] = useState<string>();
  const book =
    openId !== undefined ? books.find((r, i) => (r.id ?? `#${i}`) === openId) : undefined;
  return (
    <section className="space-y-2" data-testid={`${testid}-shelf`} aria-label={label}>
      <h3
        className={cx(
          compact
            ? "text-[0.72rem] tracking-wide text-faint uppercase"
            : "font-display text-[1rem] text-gold",
        )}
      >
        {label}
      </h3>
      <ul className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-2">
        {books.map((r, i) => {
          const key = r.id ?? `#${i}`;
          const on = openId === key;
          return (
            <li key={r.id ?? i} className={cx("shrink-0 snap-start", compact ? "w-28" : "w-36")}>
              <button
                type="button"
                onClick={() => setOpenId(on ? undefined : key)}
                aria-pressed={on}
                className={cx(
                  "block w-full rounded-lg p-1 text-left hover:bg-raised/60",
                  on && "bg-raised/80 ring-1 ring-gold/60",
                )}
                data-testid={testid}
              >
                <span className="relative block">
                  <Cover serviceId={serviceId} id={r.id} has={r.cover} title={r.name ?? r.title} />
                  {r.progressPct !== undefined && (
                    <span
                      className="absolute inset-x-1.5 bottom-1.5 h-1.5 overflow-hidden rounded-full bg-black/60"
                      role="progressbar"
                      aria-valuenow={r.progressPct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${r.name ?? r.title}: ${r.progressPct}% listened`}
                    >
                      <span
                        className="block h-full rounded-full bg-gold"
                        style={{ width: `${r.progressPct}%` }}
                      />
                    </span>
                  )}
                </span>
                <span className="mt-1 line-clamp-2 block text-[0.76rem] leading-snug text-ink">
                  {r.name ?? r.title}
                </span>
                {r.author && (
                  <span className="line-clamp-1 block text-[0.7rem] text-faint">{r.author}</span>
                )}
                <span className="block text-[0.68rem] text-faint">
                  {r.progressPct !== undefined
                    ? `${r.progressPct}%${r.lastListened ? ` · ${ago(r.lastListened)}` : ""}`
                    : r.at
                      ? ago(r.at)
                      : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {books.length === 0 && <p className="text-[0.8rem] text-faint">Nothing in it yet.</p>}
      {book && (
        <BookDetail
          serviceId={serviceId}
          b={book}
          inList={inList}
          inContinue={inContinue}
          onClose={() => setOpenId(undefined)}
        />
      )}
    </section>
  );
}

function LibraryCard({ serviceId, l }: { serviceId: string; l: Data["libraries"][number] }) {
  const c = useConfirmedChange(serviceId);
  return (
    <li
      className="space-y-2 rounded-xl border border-line bg-bg/50 p-3"
      data-testid="abs-library"
      data-capture-item
      data-capture-label={l.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[0.92rem] text-ink">{l.name}</span>
        <button
          type="button"
          className={btn}
          data-testid="abs-scan"
          onClick={() =>
            void c.propose(
              "app-audiobookshelf-control",
              { op: "scan-library", libraryId: l.id },
              `Scan ${l.name}`,
            )
          }
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan
        </button>
      </div>
      <p className="text-[0.78rem] text-faint">
        {l.items} {l.kind}
        {l.authors ? ` · ${l.authors} authors` : ""} · {l.hours.toLocaleString()} hours · {l.sizeGb}{" "}
        GB
      </p>
      {l.recent.length > 0 && (
        <Shelf
          serviceId={serviceId}
          label="Recently added"
          books={l.recent}
          testid="abs-recent"
          compact
        />
      )}
      <ChangeCard c={c} />
    </li>
  );
}

export function AudiobookshelfDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useDashboard(serviceId, true, 15_000);
  const backup = useConfirmedChange(serviceId);
  const d: Data | undefined = q.data?.data?.app === "audiobookshelf" ? q.data.data : undefined;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return q.data.error.kind === "needs-key" || q.data.error.kind === "rejected" ? (
      <PasteKey
        serviceId={serviceId}
        name={name}
        where="Settings (as an administrator), then API Keys, then Add API Key"
        message={q.data.error.message}
      />
    ) : (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="abs-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  // Measured from when the panel was read, not the clock at render time.
  const stale =
    !d.backups.newest ||
    Date.parse(q.data?.at ?? d.backups.newest) - Date.parse(d.backups.newest) > 7 * 86_400_000;
  const lists = d.lists ?? [];
  const shelfLists = new Set(
    (d.shelves ?? []).flatMap((sh) => (sh.list ? [`${sh.list.kind}:${sh.list.id}`] : [])),
  );
  const allBooks = [
    ...(d.shelves ?? []).flatMap((sh) => sh.books),
    ...d.libraries.flatMap((l) => l.recent),
    ...lists.flatMap((l) => l.books),
  ];
  return (
    <AbsLists.Provider value={{ serviceId, lists, libraries: d.libraries }}>
      <section
        className="@container space-y-4"
        data-testid="abs-dashboard"
        aria-label={`${name}: listening`}
      >
        <ScanLibraries
          serviceId={serviceId}
          kind="app-audiobookshelf-control"
          name={name}
          testId="abs-scan-libraries"
        />
        <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
          {(
            [
              [
                "Listening now",
                `${d.listening.length}`,
                d.online.length ? `${d.online.join(", ")} online` : "nobody online",
              ],
              [
                "Books",
                `${d.libraries.filter((l) => l.kind === "books").reduce((n, l) => n + l.items, 0)}`,
                "in book libraries",
              ],
              [
                "Hours",
                `${d.libraries.reduce((n, l) => n + l.hours, 0).toLocaleString()}`,
                "of listening",
              ],
              [
                "Last backup",
                d.backups.newest ? ago(d.backups.newest) : "never",
                `${d.backups.count} kept`,
              ],
            ] as const
          ).map(([label, value, sub]) => (
            <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
              <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
              <p
                className={cx(
                  "stat-value text-ink tabular",
                  label === "Last backup" && stale && "text-amber",
                )}
                data-testid={
                  label === "Listening now"
                    ? "abs-listening"
                    : label === "Last backup"
                      ? "abs-backup-age"
                      : undefined
                }
              >
                {value}
              </p>
              <p className="text-[0.74rem] text-faint">{sub}</p>
            </div>
          ))}
        </div>

        {d.listening.length > 0 && (
          <ul className="grid gap-3 @2xl:grid-cols-2">
            {d.listening.map((s, i) => (
              <li
                key={i}
                className="flex gap-3 rounded-xl border border-line bg-bg/50 p-3"
                data-testid="abs-session"
              >
                <Cover
                  serviceId={serviceId}
                  id={s.itemId}
                  has={Boolean(s.itemId)}
                  title={s.title}
                  className="w-16 shrink-0"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="text-[0.9rem] text-ink">{s.title}</p>
                  <p className="text-[0.78rem] text-muted">
                    <span className="text-ink">{s.user}</span>
                    {s.device ? ` · ${s.device}` : ""}
                  </p>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-line"
                    role="progressbar"
                    aria-valuenow={s.progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${s.title} progress`}
                  >
                    <div
                      className="h-full rounded-full bg-gold"
                      style={{ width: `${s.progressPct}%` }}
                    />
                  </div>
                  <p className="text-[0.76rem] text-faint">{s.progressPct}% through</p>
                </div>
              </li>
            ))}
          </ul>
        )}

        {d.nowListening && <NowListening serviceId={serviceId} n={d.nowListening} />}

        {(d.shelves ?? []).map((sh) => (
          <Shelf
            key={`${sh.kind}:${sh.label}`}
            serviceId={serviceId}
            label={sh.label}
            books={sh.books}
            testid={`abs-${sh.kind}`}
            inList={sh.list}
            inContinue={sh.kind === "continue"}
          />
        ))}
        {d.shelves && d.shelfUser && (
          <p className="-mt-2 text-[0.72rem] text-faint">
            Shelves for {d.shelfUser}, the account Hearth's key belongs to. A collection or playlist
            named TBR, To be read, Want to listen, or Up next shows as its own shelf.
          </p>
        )}

        {d.lists && (
          <section className="space-y-3" data-testid="abs-lists" aria-label="Your lists">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 flex-1 font-display text-[1rem] text-gold">Your lists</h3>
            </div>
            {lists
              .filter((l) => !shelfLists.has(`${l.kind}:${l.id}`))
              .map((l) => (
                <Shelf
                  key={`${l.kind}:${l.id}`}
                  serviceId={serviceId}
                  label={`${l.name} · ${l.kind === "playlist" ? "playlist" : "collection"}, ${l.books.length} ${l.books.length === 1 ? "book" : "books"}`}
                  books={l.books}
                  testid="abs-list-book"
                  compact
                  inList={{ id: l.id, kind: l.kind }}
                />
              ))}
            {lists.length === 0 && (
              <p className="text-[0.8rem] text-faint">
                No playlists or collections yet. Open any book and add it to a list, or start one
                here.
              </p>
            )}
            <NewPlaylist books={allBooks} />
            <p className="text-[0.72rem] text-faint">
              Open a book to add it to a list, move it up or down, move it to another list, or take
              it out. Each change is planned here first and made after you approve it.
            </p>
          </section>
        )}

        <ul className="grid gap-3">
          {d.libraries.map((l) => (
            <LibraryCard key={l.id} serviceId={serviceId} l={l} />
          ))}
        </ul>

        <div className="space-y-2">
          {stale && (
            <p className="text-[0.82rem] text-amber">
              {d.backups.newest
                ? "The newest backup is over a week old."
                : "There are no backups yet."}
            </p>
          )}
          <Button
            tone="outline"
            data-testid="abs-backup"
            onClick={() =>
              void backup.propose("app-audiobookshelf-control", { op: "backup" }, `Back up ${name}`)
            }
          >
            <DatabaseBackup className="h-4 w-4" /> Make a backup now
          </Button>
          <ChangeCard c={backup} />
        </div>
        <p className="text-[0.74rem] text-faint">
          {q.data?.sample ? "Sample data · " : ""}
          {d.version ? `${name} ${d.version} · ` : ""}live, every 15 s
        </p>
      </section>
    </AbsLists.Provider>
  );
}
