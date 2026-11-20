import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Search, Undo2, X } from "lucide-react";
import { api } from "../../data/api";
import { ChangeCard, useConfirmedChange } from "../dashboards/ConfirmedChange";
import { Skeleton, cx } from "../ui";
import { JellyfinHomeEditor } from "./JellyfinHome";

/**
 * Home rows for Emby (11-09). Emby 4.8 and later keep each person's home rows on the server:
 * Emby's own (My Media, Continue Watching, Latest Media...), a row of one collection or playlist,
 * a row of titles picked by filters, and a row of titles you pick by hand (Hearth makes the
 * collection first, as Plex's Home rows do). Arrange them with posters, then "Save to Emby" is one
 * plan you approve (several people at once if you like), read back, with Undo. An older Emby,
 * without rows of its own, gets Jellyfin's editor (it keeps its home screen the same way).
 */

const KIND = "app-jellyfin-control";

interface Row {
  id?: string;
  type: string;
  name?: string;
  parentId?: string;
  titles?: string[];
  itemTypes?: string[];
  genreIds?: string[];
  tagIds?: string[];
  unwatched?: boolean;
  favorites?: boolean;
  sortBy?: string;
  sortOrder?: "Ascending" | "Descending";
  excluded?: string[];
  /** The editor's own handle for a row (new rows have no id yet); never sent. */
  key?: string;
  /** Hand-picked titles' names and posters, for the editor only; never sent. */
  picked?: Found[];
}
interface Home {
  rows: Row[];
  order: string[];
  media: string[];
}
interface Named {
  id: string;
  name: string;
}
interface Found {
  id: string;
  title: string;
  year?: number;
}
interface EmbyView {
  kind?: "emby";
  users: { id: string; name: string; admin: boolean }[];
  userId: string;
  home: Home;
  names: Record<string, string>;
  libraries: { id: string; name: string; type: string }[];
  sections: Named[];
  itemTypes: string[];
  sorts: string[];
  previews: Record<string, { id: string; title: string }[]>;
  collections: Named[];
  playlists: Named[];
  genres: Named[];
  tags: Named[];
}

/** What each of Emby's rows is for, in a few words. */
const ABOUT: Record<string, string> = {
  userviews: "Your libraries as tiles",
  resume: "What you started and didn't finish, and the next episode",
  resumeaudio: "Music and audiobooks you were in the middle of",
  latestmediablock: "A row per library of what just arrived",
  collections: "Every collection",
  playlists: "Every playlist",
  boxset: "One collection as a row",
  playlist: "One playlist as a row",
  items: "Titles picked by kind, genre, tag and more",
  latestmoviereleases: "Movies by release date, newest first",
  latestepisodereleases: "Episodes by air date, newest first",
  onnow: "Live TV on now (needs Emby Premiere)",
  activerecordings: "Live TV being recorded (needs Emby Premiere)",
};
/** Emby's rows any home can have once; the rest are built below. */
const BUILT_IN = [
  "userviews",
  "resume",
  "resumeaudio",
  "latestmediablock",
  "collections",
  "playlists",
  "latestmoviereleases",
  "latestepisodereleases",
  "onnow",
  "activerecordings",
];
const KINDS: { label: string; types: string[] }[] = [
  { label: "Movies", types: ["Movie"] },
  { label: "Shows", types: ["Series"] },
  { label: "Movies and shows", types: ["Movie", "Series"] },
  { label: "Episodes", types: ["Episode"] },
];
const SORT_WORDS: Record<string, string> = {
  Random: "Shuffled",
  DateCreated: "Newest added",
  PremiereDate: "Newest released",
  SortName: "A to Z",
  CommunityRating: "Best rated",
};

const iconBtn =
  "hr-lift grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-line hover:text-ink disabled:pointer-events-none disabled:opacity-30";
const chip =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.8rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-50";
const field =
  "min-h-9 w-full rounded-lg border border-line-strong bg-bg px-2.5 text-[0.84rem] text-ink";
const heading = "text-[0.75rem] tracking-[0.12em] text-gold uppercase";

/** A row as Emby gets it: the editor's own fields left out. */
const forEmby = ({ key: _k, picked: _p, ...r }: Row): Row => r;
const keyOf = (r: Row, i: number) => r.key ?? r.id ?? `row-${i}`;
const sameHome = (a: Home, b: Home) =>
  JSON.stringify({ ...a, rows: a.rows.map(forEmby) }) ===
  JSON.stringify({ ...b, rows: b.rows.map(forEmby) });

const move = <T,>(list: T[], i: number, by: number) => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

const homeUrl = (serviceId: string, q: Record<string, string | undefined>) => {
  const s = new URLSearchParams(
    Object.entries(q).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  return `/api/services/${encodeURIComponent(serviceId)}/jellyfin/home${s ? `?${s}` : ""}`;
};

function Posters({
  serviceId,
  items,
  empty,
}: {
  serviceId: string;
  items?: { id: string; title: string }[];
  empty: string;
}) {
  if (!items?.length) return <p className="text-[0.78rem] text-faint">{empty}</p>;
  return (
    <div className="hr-strip flex gap-1.5 overflow-hidden" aria-hidden>
      {items.slice(0, 7).map((p, i) => (
        <img
          key={`${p.id}-${i}`}
          src={`/api/services/${encodeURIComponent(serviceId)}/dashboard/jellyfin-poster?item=${encodeURIComponent(p.id)}`}
          alt=""
          title={p.title}
          loading="lazy"
          className="aspect-[2/3] w-12 shrink-0 rounded-md bg-line object-cover"
        />
      ))}
    </div>
  );
}

/** Home rows for an Emby server: Emby's own rows editor, or Jellyfin's for an older Emby. */
export function EmbyHomeEditor({ serviceId }: { serviceId: string }) {
  const [userId, setUserId] = useState<string>();
  const view = useQuery({
    // Under "dashboard": a finished plan refreshes it with the rest of the panel.
    queryKey: ["dashboard", serviceId, "jellyfin", "home", userId ?? ""],
    queryFn: () => api<EmbyView>("GET", homeUrl(serviceId, { id: userId })),
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (view.isLoading || (!view.data && !view.error)) return <Skeleton className="h-64" />;
  if (view.data && view.data.kind !== "emby") return <JellyfinHomeEditor serviceId={serviceId} />;
  if (view.error || !view.data)
    return (
      <p className="text-[0.9rem] text-amber" data-testid="emby-home-error">
        {view.error instanceof Error ? view.error.message : "Emby's home screen can't be read."}
      </p>
    );
  return <Editor serviceId={serviceId} v={view.data} onUser={setUserId} />;
}

function Editor({
  serviceId,
  v,
  onUser,
}: {
  serviceId: string;
  v: EmbyView;
  onUser: (id: string) => void;
}) {
  // Edits belong to what Emby had when they began: another person, or a saved change read back,
  // starts again from Emby; a plain refetch keeps the edits under way.
  const serverHome = `${v.userId}:${JSON.stringify(v.home)}`;
  const [edit, setEdit] = useState<{ key: string; home: Home; also: string[] }>();
  const [made, setMade] = useState(0);
  const change = useConfirmedChange(serviceId);
  const mine = edit?.key === serverHome ? edit : undefined;
  const draft = mine?.home ?? v.home;
  const also = mine?.also ?? [];
  const setDraft = (home: Home) => setEdit({ key: serverHome, home, also });
  const setAlso = (list: string[]) => setEdit({ key: serverHome, home: draft, also: list });
  const libs = useMemo(() => new Map(v.libraries.map((l) => [l.id, l])), [v]);
  const who = v.userId;
  const name = v.users.find((u) => u.id === who)?.name ?? "this person";
  const changed = !sameHome(draft, v.home) || also.length > 0;
  const set = (p: Partial<Home>) => setDraft({ ...draft, ...p });
  const setRow = (i: number, p: Partial<Row>) =>
    set({ rows: draft.rows.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const add = (r: Row) => {
    setMade(made + 1);
    set({ rows: [...draft.rows, { ...r, key: `new-${made + 1}` }] });
  };
  const has = new Set(draft.rows.map((r) => r.type));
  const missing = BUILT_IN.filter((t) => !has.has(t));
  const sectionName = (t: string) => v.sections.find((s) => s.id === t)?.name ?? t;
  const label = (r: Row) => r.name || (r.id && v.names[r.id]) || sectionName(r.type);
  const done = change.job?.status === "succeeded" ? change.job : undefined;
  const before = done?.steps[0]?.params?.before;
  const send = () => {
    const out = { ...draft, rows: draft.rows.map(forEmby) };
    const homes: Record<string, Home> = { [who]: out };
    for (const id of also) homes[id] = out;
    const people = [name, ...also.map((id) => v.users.find((u) => u.id === id)?.name ?? id)];
    void change.propose(
      KIND,
      { op: "home-screen", homes: JSON.stringify(homes) },
      `Emby home screen for ${people.join(", ")}`,
    );
  };
  const toggleMedia = (id: string) =>
    set({
      media: draft.media.includes(id) ? draft.media.filter((x) => x !== id) : [...draft.media, id],
    });

  return (
    <div className="@container space-y-4" data-testid="emby-home">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.8rem] text-muted">Whose home screen</span>
        {v.users.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => onUser(u.id)}
            aria-pressed={u.id === who}
            className={cx(
              "hr-lift min-h-9 rounded-full border px-3 text-[0.82rem]",
              u.id === who
                ? "border-gold bg-gold/15 text-gold-bright"
                : "border-line-strong text-muted hover:text-ink",
            )}
            data-testid="emby-home-user"
          >
            {u.name}
          </button>
        ))}
      </div>

      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label={`${name}'s home`} className="space-y-2">
          <h3 className={heading}>{name}'s home, top to bottom</h3>
          {!draft.rows.length && (
            <p className="rounded-xl border border-dashed border-line-strong p-4 text-[0.85rem] text-muted">
              Nothing on the home screen. Add a row on the right.
            </p>
          )}
          <ol className="space-y-2">
            {draft.rows.map((r, i) => {
              const l = label(r);
              const shown = draft.order.filter((id) => !(r.excluded ?? []).includes(id));
              const custom = ["boxset", "playlist", "items"].includes(r.type);
              return (
                <li
                  key={keyOf(r, i)}
                  className="hr-row rounded-xl border border-line bg-panel p-3"
                  data-testid="emby-home-row"
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      {custom ? (
                        <input
                          className="w-full bg-transparent font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
                          value={r.name ?? ""}
                          placeholder={l}
                          aria-label={`Name of ${l}`}
                          onChange={(e) => setRow(i, { name: e.target.value })}
                          data-testid="emby-home-row-name"
                        />
                      ) : (
                        <p className="font-semibold text-ink">{l}</p>
                      )}
                      <p className="text-[0.78rem] text-muted">
                        {r.titles
                          ? `${r.titles.length} ${r.titles.length === 1 ? "title" : "titles"} you picked: a new collection, then this row`
                          : r.type === "boxset"
                            ? `The collection ${v.collections.find((c) => c.id === r.parentId)?.name ?? ""}`
                            : r.type === "playlist"
                              ? `The playlist ${v.playlists.find((c) => c.id === r.parentId)?.name ?? ""}`
                              : (ABOUT[r.type] ?? "A row Emby has")}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={`Move ${l} up`}
                      disabled={i === 0}
                      onClick={() => set({ rows: move(draft.rows, i, -1) })}
                    >
                      <ArrowUp strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={`Move ${l} down`}
                      disabled={i === draft.rows.length - 1}
                      onClick={() => set({ rows: move(draft.rows, i, 1) })}
                    >
                      <ArrowDown strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={`Take ${l} off`}
                      onClick={() => set({ rows: draft.rows.filter((_, j) => j !== i) })}
                      data-testid="emby-home-remove"
                    >
                      <X strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 space-y-2">
                    {r.type === "latestmediablock" ? (
                      <>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {draft.order.map((id) => (
                            <label
                              key={id}
                              className="flex items-center gap-1.5 text-[0.76rem] text-muted"
                            >
                              <input
                                type="checkbox"
                                checked={!(r.excluded ?? []).includes(id)}
                                onChange={() =>
                                  setRow(i, {
                                    excluded: (r.excluded ?? []).includes(id)
                                      ? (r.excluded ?? []).filter((x) => x !== id)
                                      : [...(r.excluded ?? []), id],
                                  })
                                }
                                data-testid="emby-home-latest"
                              />
                              {libs.get(id)?.name ?? id}
                            </label>
                          ))}
                        </div>
                        {shown.map((id) => (
                          <div key={id}>
                            <p className="mb-1 text-[0.78rem] text-muted">
                              Latest in {libs.get(id)?.name ?? id}
                            </p>
                            <Posters
                              serviceId={serviceId}
                              items={v.previews[`latest:${id}`]}
                              empty="Nothing new yet."
                            />
                          </div>
                        ))}
                      </>
                    ) : r.type === "userviews" ? (
                      <div className="flex flex-wrap gap-1.5">
                        {draft.order
                          .filter((id) => draft.media.includes(id))
                          .map((id) => (
                            <span
                              key={id}
                              className="rounded-md border border-line-strong px-2 py-1 text-[0.75rem] text-ink"
                            >
                              {libs.get(id)?.name ?? id}
                            </span>
                          ))}
                      </div>
                    ) : r.picked ? (
                      <Posters serviceId={serviceId} items={r.picked} empty="" />
                    ) : (
                      <Posters
                        serviceId={serviceId}
                        items={r.id ? v.previews[r.id] : undefined}
                        empty={
                          r.id
                            ? `Empty for ${name} right now.`
                            : "Its posters show here once it is saved."
                        }
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-label="Change it" className="space-y-4">
          <div className="space-y-2">
            <h3 className={heading}>Add one of Emby's rows</h3>
            {missing.length ? (
              <div className="flex flex-wrap gap-2">
                {missing.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={chip}
                    onClick={() => add({ type: t })}
                    title={ABOUT[t]}
                    data-testid="emby-home-add"
                  >
                    <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> {sectionName(t)}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[0.8rem] text-muted">Every one of Emby's rows is on already.</p>
            )}
          </div>
          <BuildRow v={v} serviceId={serviceId} onAdd={add} />
          <div className="space-y-2">
            <h3 className={heading}>Libraries</h3>
            <p className="text-[0.78rem] text-muted">
              Their order is the order of My Media and the Latest rows.
            </p>
            <ul className="space-y-1.5">
              {draft.order.map((id, i) => (
                <li
                  key={id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5"
                  data-testid="emby-home-library"
                >
                  <span className="min-w-0 flex-1 text-[0.86rem] text-ink">
                    {libs.get(id)?.name ?? id}
                  </span>
                  <label className="flex items-center gap-1.5 text-[0.76rem] text-muted">
                    <input
                      type="checkbox"
                      checked={draft.media.includes(id)}
                      onChange={() => toggleMedia(id)}
                    />
                    In My Media
                  </label>
                  <button
                    type="button"
                    className={iconBtn}
                    aria-label={`Move ${libs.get(id)?.name ?? id} up`}
                    disabled={i === 0}
                    onClick={() => set({ order: move(draft.order, i, -1) })}
                  >
                    <ArrowUp strokeWidth={1.5} className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    aria-label={`Move ${libs.get(id)?.name ?? id} down`}
                    disabled={i === draft.order.length - 1}
                    onClick={() => set({ order: move(draft.order, i, 1) })}
                  >
                    <ArrowDown strokeWidth={1.5} className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {(changed || change.job || change.error) && (
        <div
          className="space-y-2 rounded-xl border border-gold/40 bg-gold/5 p-3"
          data-testid="emby-home-save"
        >
          {v.users.length > 1 && changed && !change.job && (
            <div className="flex flex-wrap items-center gap-2 text-[0.8rem] text-muted">
              <span>Give this home screen to others too:</span>
              {v.users
                .filter((u) => u.id !== who)
                .map((u) => (
                  <label key={u.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={also.includes(u.id)}
                      onChange={() =>
                        setAlso(
                          also.includes(u.id) ? also.filter((x) => x !== u.id) : [...also, u.id],
                        )
                      }
                      data-testid="emby-home-also"
                    />
                    {u.name}
                  </label>
                ))}
            </div>
          )}
          {changed && !change.job && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="hr-lift min-h-10 rounded-lg bg-gold px-4 text-[0.86rem] font-semibold text-bg disabled:opacity-50"
                onClick={send}
                disabled={change.busy}
                data-testid="emby-home-send"
              >
                Save to Emby
              </button>
              <button type="button" className={chip} onClick={() => setEdit(undefined)}>
                Start over
              </button>
            </div>
          )}
          <ChangeCard c={change} confirmLabel="Save to Emby" />
          {done && typeof before === "string" && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={chip}
                onClick={() =>
                  void change.propose(
                    KIND,
                    { op: "home-screen", homes: before },
                    "Put the Emby home screen back",
                  )
                }
                data-testid="emby-home-undo"
              >
                <Undo2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Undo
              </button>
              <button type="button" className={chip} onClick={() => void change.cancel()}>
                Done
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type Build = "collection" | "playlist" | "filter" | "pick";

/** Building a row of your own: a collection, a playlist, titles by filters, or titles you pick. */
function BuildRow({
  v,
  serviceId,
  onAdd,
}: {
  v: EmbyView;
  serviceId: string;
  onAdd: (r: Row) => void;
}) {
  const [mode, setMode] = useState<Build>("pick");
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [kind, setKind] = useState(0);
  const [genre, setGenre] = useState("");
  const [tag, setTag] = useState("");
  const [unwatched, setUnwatched] = useState(false);
  const [favorites, setFavorites] = useState(false);
  const [sortBy, setSortBy] = useState("Random");
  const [words, setWords] = useState("");
  const [asked, setAsked] = useState("");
  const [picked, setPicked] = useState<Found[]>([]);
  const found = useQuery({
    queryKey: ["dashboard", serviceId, "jellyfin", "home-find", v.userId, asked],
    queryFn: () => api<{ found: Found[] }>("GET", homeUrl(serviceId, { id: v.userId, q: asked })),
    enabled: asked.length > 1,
    retry: false,
  });
  const reset = () => {
    setName("");
    setParent("");
    setGenre("");
    setTag("");
    setUnwatched(false);
    setFavorites(false);
    setPicked([]);
    setWords("");
    setAsked("");
  };
  const tabs: { id: Build; label: string }[] = [
    { id: "pick", label: "Titles you pick" },
    { id: "filter", label: "By filters" },
    { id: "collection", label: "A collection" },
    { id: "playlist", label: "A playlist" },
  ];
  const ready =
    mode === "pick"
      ? Boolean(name.trim() && picked.length)
      : mode === "filter"
        ? true
        : Boolean(parent);
  const build = () => {
    const n = name.trim() || undefined;
    if (mode === "pick")
      onAdd({ type: "boxset", name: n, titles: picked.map((p) => p.id), picked });
    else if (mode === "filter")
      onAdd({
        type: "items",
        name: n,
        itemTypes: KINDS[kind]!.types,
        ...(genre ? { genreIds: [genre] } : {}),
        ...(tag ? { tagIds: [tag] } : {}),
        ...(unwatched ? { unwatched } : {}),
        ...(favorites ? { favorites } : {}),
        sortBy,
      });
    else onAdd({ type: mode === "collection" ? "boxset" : "playlist", name: n, parentId: parent });
    reset();
  };
  const list = mode === "collection" ? v.collections : v.playlists;
  return (
    <div
      className="space-y-2 rounded-xl border border-line bg-panel p-3"
      data-testid="emby-home-build"
    >
      <h3 className={heading}>Make a row of your own</h3>
      <div role="tablist" aria-label="Kind of row" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={mode === t.id}
            onClick={() => setMode(t.id)}
            className={cx(
              "min-h-9 rounded-lg px-2.5 text-[0.8rem]",
              mode === t.id ? "bg-line text-ink" : "text-muted hover:text-ink",
            )}
            data-testid={`emby-home-build-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label className="block text-[0.78rem] text-muted">
        Row name{mode === "pick" ? "" : " (optional)"}
        <input
          className={field}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Movie night picks"
          data-testid="emby-home-build-name"
        />
      </label>
      {mode === "pick" && (
        <div className="space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setAsked(words.trim());
            }}
          >
            <input
              className={field}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              placeholder="Find a movie or show"
              aria-label="Find a title"
              data-testid="emby-home-find"
            />
            <button type="submit" className={iconBtn} aria-label="Find">
              <Search strokeWidth={1.5} className="h-4 w-4" />
            </button>
          </form>
          {found.data?.found?.length ? (
            <ul className="space-y-1">
              {found.data.found
                .filter((f) => !picked.some((p) => p.id === f.id))
                .slice(0, 8)
                .map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[0.84rem] text-ink hover:bg-line"
                      onClick={() => setPicked([...picked, f])}
                      data-testid="emby-home-found"
                    >
                      <Plus strokeWidth={1.5} className="h-3.5 w-3.5 text-muted" />
                      {f.title}
                      {f.year ? <span className="text-muted">({f.year})</span> : null}
                    </button>
                  </li>
                ))}
            </ul>
          ) : asked && !found.isFetching ? (
            <p className="text-[0.78rem] text-faint">Nothing in Emby by that name.</p>
          ) : null}
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picked.map((p) => (
                <span
                  key={p.id}
                  className="inline-flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[0.75rem] text-ink"
                >
                  {p.title}
                  <button
                    type="button"
                    aria-label={`Leave out ${p.title}`}
                    className="text-muted hover:text-ink"
                    onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                  >
                    <X strokeWidth={1.5} className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {mode === "filter" && (
        <div className="grid gap-2 @md:grid-cols-2">
          <label className="text-[0.78rem] text-muted">
            What
            <select
              className={field}
              value={kind}
              onChange={(e) => setKind(Number(e.target.value))}
            >
              {KINDS.map((k, i) => (
                <option key={k.label} value={i}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[0.78rem] text-muted">
            Order
            <select className={field} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {v.sorts.map((s) => (
                <option key={s} value={s}>
                  {SORT_WORDS[s] ?? s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[0.78rem] text-muted">
            Genre
            <select
              className={field}
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
              data-testid="emby-home-genre"
            >
              <option value="">Any</option>
              {v.genres.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[0.78rem] text-muted">
            Tag
            <select className={field} value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">Any</option>
              {v.tags.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[0.8rem] text-muted">
            <input type="checkbox" checked={unwatched} onChange={() => setUnwatched(!unwatched)} />
            Only unwatched
          </label>
          <label className="flex items-center gap-2 text-[0.8rem] text-muted">
            <input type="checkbox" checked={favorites} onChange={() => setFavorites(!favorites)} />
            Only favorites
          </label>
        </div>
      )}
      {(mode === "collection" || mode === "playlist") &&
        (list.length ? (
          <select
            className={field}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            aria-label={mode === "collection" ? "Collection" : "Playlist"}
            data-testid="emby-home-parent"
          >
            <option value="">Choose one</option>
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-[0.78rem] text-faint">
            {mode === "collection"
              ? "No collections in Emby yet: pick titles instead, and Hearth makes one."
              : "No playlists in Emby yet."}
          </p>
        ))}
      <button
        type="button"
        className={chip}
        disabled={!ready}
        onClick={build}
        data-testid="emby-home-build-add"
      >
        <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add this row
      </button>
    </div>
  );
}
