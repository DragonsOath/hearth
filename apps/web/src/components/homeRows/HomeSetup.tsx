import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, Loader2 } from "lucide-react";
import type { StepParams } from "@dragon-control/core";
import type { HomeRowsOptions } from "../../data/homeRows";
import { cx } from "../ui";

/**
 * Merge rows on Home (rebuilt 11-10; 11-11 Recently Added its own choice from the owner's words: "a drop down with all your movie
 * based libraries. Same for shows... you tap the ones you want merged. They highlight. Tap it
 * again it turns it off"). One list per kind; the libraries tapped on share one Recently Added and
 * one Recently Released row, each title once; the rest keep their own rows. A tag says whether
 * that is saved in Plex, and the rows below change as you tap. Nothing reaches Plex until the one
 * Save to Plex at the bottom.
 *
 * Plex has no setting for this (every row reads one library), so merging is combining: the other
 * libraries' folders are added to the one whose rows show (no files move) and they go to the
 * sidebar only, so their Recently Added is one row too. Plex's own Merge Recently Added (every
 * library on Home at once) is a separate choice; with it on, a duplicate Recently Added row comes
 * off by itself ("no one wants two posters in one row").
 */

type Lib = HomeRowsOptions["libraries"][number];
export type Kind = "movie" | "show";
type Row = { id: string; flags: { home: boolean } };
type Rows = Record<string, Row[]>;
export type Join = { into: string; from: string };
export interface Setup {
  /** Plex's Merge Recently Added Items (null: this Plex has no such setting). */
  merge: boolean | null;
  /** Libraries combined into another: one set of new-title rows. */
  joins: Join[];
}
/** The libraries tapped on, per kind. */
export type Picked = Record<Kind, string[]>;
export type Status = "saved" | "changed";

const KINDS: Kind[] = ["movie", "show"];
const sameJoin = (a: Join, b: Join) => a.into === b.into && a.from === b.from;
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));
const ofKind = (o: HomeRowsOptions, type: Kind) =>
  o.libraries.filter((l) => l.type === type && l.folders?.length);

/** Plex's own rows by the middle of their id ("movie.recentlyadded", or ".2" on older ones). */
export const plexKeyOf = (id: string) => {
  const p = id.split(".");
  return p[0] !== "custom" && p.length >= 2 ? p[1]! : undefined;
};
export const rowOf = (rows: Rows, lib: string, key: string) =>
  (rows[lib] ?? []).find((e) => plexKeyOf(e.id) === key);

function pairs(libraries: Lib[], whole: boolean): Join[] {
  return KINDS.flatMap((type) => {
    const list = libraries.filter((l) => l.type === type && l.folders?.length);
    return list.flatMap((into) =>
      list
        .filter(
          (from) =>
            from.id !== into.id &&
            from.folders!.every((f) => into.folders!.includes(f)) &&
            (from.visibility === "2") === whole,
        )
        .map((from) => ({ into: into.id, from: from.id })),
    );
  });
}

/** What Plex has now. */
export const setupOf = (o: HomeRowsOptions): Setup => ({
  merge: o.merge ?? null,
  joins: pairs(o.libraries, true),
});

/** Folders added before 11-09 but the other library still on Home: its titles show twice. */
export const halfJoined = (o: HomeRowsOptions) => pairs(o.libraries, false);

/** Kinds with two or more libraries: the only ones where merging means anything. */
export const kindsOf = (o: HomeRowsOptions) => KINDS.filter((t) => ofKind(o, t).length >= 2);

const kindOfLib = (o: HomeRowsOptions, id: string) =>
  o.libraries.find((l) => l.id === id)?.type as Kind | undefined;

/** The libraries merged in Plex now, per kind: the one whose rows show, then the others. */
export function pickedOf(o: HomeRowsOptions, s: Setup): Picked {
  const out: Picked = { movie: [], show: [] };
  for (const j of s.joins) {
    const t = kindOfLib(o, j.into);
    if (!t) continue;
    out[t] = [...new Set([...out[t], j.into, j.from])];
  }
  return out;
}

/** Libraries of a kind that keep their own rows on Home with this setup. */
export function onHome(o: HomeRowsOptions, base: Setup, s: Setup, type: Kind) {
  return ofKind(o, type).filter(
    (l) =>
      !s.joins.some((j) => j.from === l.id) &&
      ((l.visibility ?? "0") === "0" || base.joins.some((j) => j.from === l.id)),
  );
}

/**
 * Whose rows show for the merged libraries: the one that shows them in Plex already, else the one
 * whose folders another already reads, else the first picked in the sidebar's order.
 */
export function keeperOf(o: HomeRowsOptions, base: Setup, picked: string[]) {
  const ok = (id: string) => picked.includes(id);
  return (
    base.joins.find((j) => ok(j.into))?.into ??
    halfJoined(o).find((j) => ok(j.into) && ok(j.from))?.into ??
    o.libraries.find((l) => ok(l.id))?.id
  );
}

/**
 * The setup the choices make: who joins whom (one Recently Released row), and Plex's Merge
 * Recently Added, each its own choice (11-11, the owner: "merging needs to be an option not a
 * force").
 */
export function setupFrom(
  o: HomeRowsOptions,
  base: Setup,
  picked: Picked,
  keep: Partial<Record<Kind, string>> = {},
  merge: boolean | null = base.merge,
): Setup {
  const joins = KINDS.flatMap((t) => {
    const p = picked[t];
    if (p.length < 2) return [];
    const k = keep[t] && p.includes(keep[t]) ? keep[t] : keeperOf(o, base, p)!;
    return p.filter((x) => x !== k).map((from) => ({ into: k, from }));
  });
  return { merge: base.merge === null ? null : merge, joins };
}

/**
 * With Merge Recently Added on, every library's Recently Added shows the same titles, so only the
 * first one's stays, by itself. The libraries whose row comes off.
 */
export function extraAdded(o: HomeRowsOptions, base: Setup, s: Setup, rows: Rows) {
  if (!s.merge) return [];
  return KINDS.flatMap((type) =>
    onHome(o, base, s, type)
      .filter((l) => rowOf(rows, l.id, "recentlyadded")?.flags.home)
      .slice(1)
      .map((l) => l.id),
  );
}

export function kindStatus(
  o: HomeRowsOptions,
  base: Setup,
  picked: Picked,
  type: Kind,
  s?: Setup,
): Status {
  // Which library the rows show under counts too: moving them is a change to save.
  const under = (x: Setup) => x.joins.find((j) => kindOfLib(o, j.into) === type)?.into;
  return sameSet(picked[type], pickedOf(o, base)[type]) && (!s || under(s) === under(base))
    ? "saved"
    : "changed";
}

/**
 * The plan steps for the setup, and what the row steps must leave alone: a library being combined
 * or separated is changed by that step, and the new-title rows of the one whose rows show too.
 */
export function setupSteps(o: HomeRowsOptions, base: Setup, s: Setup) {
  // A merge that moves to another library (11-11, the owner: "fix it so it can toggle back and
  // forth"): one step, so each library changes once. Separating and combining again changed one
  // library twice, and Plex refused the second while it scanned after the first.
  const intoOf = (joins: Join[], type: Kind) =>
    joins.find((j) => kindOfLib(o, j.into) === type)?.into;
  const moves = KINDS.flatMap((type) => {
    const from = intoOf(base.joins, type);
    const into = intoOf(s.joins, type);
    if (!from || !into || from === into) return [];
    const others = s.joins.filter((j) => j.into === into).map((j) => j.from);
    const was = base.joins.filter((j) => j.into === from).map((j) => j.from);
    return [{ type, into, from, others, was }];
  });
  const moving = (j: Join) => moves.some((m) => m.type === kindOfLib(o, j.into));
  const gone = base.joins.filter((j) => !moving(j) && !s.joins.some((x) => sameJoin(j, x)));
  const added = s.joins.filter((j) => !moving(j) && !base.joins.some((x) => sameJoin(j, x)));
  const before: StepParams[] = [];
  if (s.merge !== null && s.merge !== base.merge) before.push({ op: "merge-recent", on: s.merge });
  const after: StepParams[] = [
    ...moves.map((m) => ({
      op: "move-released",
      intoId: m.into,
      fromId: m.from,
      withIds: m.others.join(","),
    })),
    // Separate first: a combine into a library that is still being separated would be refused.
    ...gone.map((j) => ({ op: "merge-released", intoId: j.into, fromId: j.from, on: false })),
    ...added.map((j) => ({ op: "merge-released", intoId: j.into, fromId: j.from, on: true })),
  ];
  const libs = new Set([
    ...[...gone, ...added].map((j) => j.from),
    ...moves.flatMap((m) => [m.into, m.from, ...m.others, ...m.was]),
  ]);
  const shows = [...added.map((j) => j.into), ...moves.map((m) => m.into)];
  const rows = new Set(
    shows.flatMap((into) =>
      ["recentlyadded", "recentlyreleased"].flatMap((k) => {
        const id = (o.rows[into] ?? []).find((h) => plexKeyOf(h.id) === k)?.id;
        return id ? [`${into}|${id}`] : [];
      }),
    ),
  );
  return {
    before,
    after,
    skip: (lib: string, id?: string) => libs.has(lib) || rows.has(`${lib}|${id}`),
  };
}

const word = (type: string) => (type === "show" ? "show" : "film");
/** "Movies’", "Anime’s". */
const poss = (n: string) => (/s$/i.test(n) ? `${n}’` : `${n}’s`);
const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

function Tag({ status, busy }: { status: Status; busy: boolean }) {
  if (busy)
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-line px-2.5 py-1 text-[0.72rem] font-bold text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Saving to Plex
      </span>
    );
  const t = {
    saved: {
      cls: "bg-live/15 text-[#a8e6bb]",
      icon: <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />,
      text: "Saved in Plex",
    },
    changed: {
      cls: "bg-[#ff7a3d]/20 text-[#ffb48f]",
      icon: <span className="h-2 w-2 rounded-full bg-[#ff7a3d]" aria-hidden />,
      text: "Changed, not saved yet",
    },
  }[status];
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.72rem] font-bold",
        t.cls,
      )}
      data-testid="home-rows-setup-status"
      data-status={status}
    >
      {t.icon}
      {t.text}
    </span>
  );
}

const FOLD_KEY = "hearth.homeRows.setupFolded";

/**
 * The owner's own Home rows in libraries this change takes off Home: Hearth makes them again in
 * the library that shows the merged rows (11-13, the owner: "recently added and recently released
 * shouldn't affect my custom Thanksgiving and Christmas rows").
 */
export function carriedOf(o: HomeRowsOptions, base: Setup, s: Setup, type: Kind) {
  const leaving = s.joins
    .filter((j) => kindOfLib(o, j.from) === type && !base.joins.some((b) => b.from === j.from))
    .map((j) => j.from);
  return leaving.flatMap((id) =>
    (o.rows[id] ?? [])
      .filter((h) => /^custom\.collection\./.test(h.id) && (h.home || h.shared))
      .map((h) => h.title),
  );
}

export function HomeSetup({
  options: o,
  base,
  setup: s,
  picked,
  busy,
  onToggle,
  onKeeper,
  onMerge,
  onDates,
  onDigital,
}: {
  options: HomeRowsOptions;
  base: Setup;
  setup: Setup;
  picked: Picked;
  busy: boolean;
  onToggle: (type: Kind, lib: string) => void;
  onKeeper: (type: Kind, lib: string) => void;
  onMerge: (on: boolean) => void;
  /** Gives the films a saved merge brought in their own added dates back (11-13). */
  onDates?: (into: string, from: string[]) => void;
  /** Recently Released by home release, not theaters (11-13): a plan to approve. */
  onDigital?: (on: boolean) => void;
}) {
  const [open, setOpen] = useState<Kind[]>([]);
  // Folds away like the old Library settings (11-11, the owner: the arrow to hide it). Remembered.
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === "1";
    } catch {
      return false;
    }
  });
  const fold = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem(FOLD_KEY, v ? "1" : "0");
    } catch {
      /* private window: just not remembered */
    }
  };
  const kinds = kindsOf(o);
  const half = halfJoined(o);
  if (!kinds.length) return null;
  const name = (id: string) => o.libraries.find((l) => l.id === id)?.title ?? "Library";
  const was = pickedOf(o, base);
  const changed =
    s.merge !== base.merge || kinds.some((k) => kindStatus(o, base, picked, k, s) === "changed");
  const summary = [
    s.merge ? "Recently Added: one merged row" : "Recently Added: separate row for each library",
    ...kinds.map((k) =>
      picked[k].length >= 2
        ? `${list(picked[k].map(name))} merged`
        : `${k === "show" ? "Shows" : "Movies"}: separate row for each library`,
    ),
  ].join(" · ");

  // Recently Added per kind (11-11, the owner: one for movies, one for shows). Plex has one
  // switch for both, so the two move together and say so.
  const addedCard = (type: Kind) =>
    s.merge !== null && ofKind(o, type).length > 0 ? (
      <div
        key={`added-${type}`}
        className="space-y-2.5 rounded-xl border border-line bg-panel/60 p-3"
        data-testid="home-rows-setup-added"
        data-kind={type}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h5 className="min-w-0 flex-1 text-[0.95rem] font-semibold text-ink">
            Recently Added{" "}
            <span className="font-normal text-muted">
              · {type === "show" ? "TV shows" : "Movies"}
            </span>
          </h5>
          <Tag status={s.merge === base.merge ? "saved" : "changed"} busy={busy} />
        </div>
        <div
          role="radiogroup"
          aria-label={`Recently Added, ${type === "show" ? "TV shows" : "Movies"}`}
          className="grid grid-cols-2 gap-1.5 rounded-xl border border-line bg-bg/60 p-1"
        >
          {[
            { on: false, text: "Separate row for each library" },
            { on: true, text: "One merged row" },
          ].map((c) => {
            const at = !!s.merge === c.on;
            return (
              <button
                key={c.text}
                type="button"
                role="radio"
                aria-checked={at}
                disabled={busy}
                onClick={() => !at && onMerge(c.on)}
                className={cx(
                  "flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 text-[0.85rem] transition-colors disabled:opacity-60",
                  at
                    ? "bg-gold/20 font-semibold text-ink ring-1 ring-gold"
                    : "text-muted hover:text-ink",
                )}
                data-testid="home-rows-setup-added-choice"
              >
                {at && <Check className="h-3.5 w-3.5 text-gold" strokeWidth={3} aria-hidden />}
                {c.text}
              </button>
            );
          })}
        </div>
        <p className="text-[0.8rem] text-muted">
          {s.merge
            ? type === "show"
              ? "All your TV libraries share one Recently Added row. Each show appears once."
              : "All your movie libraries share one Recently Added row. Each film appears once."
            : `Each ${type === "show" ? "TV" : "movie"} library on Home has its own Recently Added row.`}
        </p>
        {ofKind(o, type === "show" ? "movie" : "show").length > 0 && (
          <p className="text-[0.74rem] text-faint">
            Plex has one Recently Added switch for movies and TV, so this changes{" "}
            {type === "show" ? "Movies" : "TV shows"} too.
          </p>
        )}
        <p className="text-[0.74rem] text-faint">
          In Plex now: {base.merge ? "one merged row." : "separate row for each library."}
        </p>
      </div>
    ) : null;

  return (
    <section
      className="space-y-3 rounded-2xl border border-line-strong bg-bg/40 p-3.5"
      aria-label="Merge rows on Home"
      data-testid="home-rows-setup"
    >
      <div>
        <button
          type="button"
          onClick={() => fold(!folded)}
          aria-expanded={!folded}
          className="flex w-full items-center gap-2 text-left"
          data-testid="home-rows-setup-toggle"
        >
          <ChevronDown
            strokeWidth={1.75}
            className={cx(
              "h-4 w-4 shrink-0 text-muted transition-transform",
              folded && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block font-display text-[1.05rem] font-bold text-ink">
              Merge rows on Home
            </span>
            {folded && (
              <span
                className="block truncate text-[0.76rem] text-faint"
                data-testid="home-rows-setup-summary"
              >
                {summary}
              </span>
            )}
          </span>
          {folded && <Tag status={changed ? "changed" : "saved"} busy={busy} />}
        </button>
        {!folded && (
          <p className="mt-1 text-[0.78rem] text-faint">
            A merged row shows the titles from several libraries in one row, each title once.
            Recently Added and Recently Released are separate choices. Your rows below change as you
            tap; Plex changes only when you press Save to Plex.
          </p>
        )}
        {busy && (
          <p className="mt-1.5 text-[0.8rem] text-amber" role="status">
            Plex is saving your last change. This is locked until it finishes.
          </p>
        )}
      </div>

      {!folded && (
        <>
          {KINDS.map(addedCard)}
          {kinds.map((type) => {
            const libs = ofKind(o, type);
            const mine = picked[type];
            const merged = mine.length >= 2;
            const keeper = s.joins.find((j) => kindOfLib(o, j.into) === type)?.into;
            const own = libs.filter((l) => !(merged && mine.includes(l.id)));
            const isOpen = open.includes(type);
            const label = type === "show" ? "show libraries" : "movie libraries";
            const status = kindStatus(o, base, picked, type, s);
            const separating = was[type].filter(
              (id) => was[type].length >= 2 && !mine.includes(id),
            );
            return (
              <div
                key={type}
                className="space-y-2.5 rounded-xl border border-line bg-panel/60 p-3"
                data-testid="home-rows-setup-kind"
                data-kind={type}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h5 className="min-w-0 flex-1 text-[0.95rem] font-semibold text-ink">
                    Recently Released{" "}
                    <span className="font-normal text-muted">
                      · {type === "show" ? "TV shows" : "Movies"}
                    </span>
                  </h5>
                  <Tag status={status} busy={busy} />
                </div>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  disabled={busy}
                  onClick={() =>
                    setOpen((x) => (isOpen ? x.filter((t) => t !== type) : [...x, type]))
                  }
                  className={cx(
                    "flex min-h-12 w-full items-center gap-2 rounded-xl border px-3.5 text-left disabled:opacity-60",
                    isOpen ? "border-gold" : "border-line-strong hover:border-gold/60",
                  )}
                  data-testid="home-rows-setup-menu"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.72rem] text-faint">Merged</span>
                    <span className="block truncate text-[0.9rem] text-ink">
                      {merged ? list(mine.map(name)) : "None: separate row for each library"}
                    </span>
                  </span>
                  <ChevronDown
                    className={cx(
                      "h-4 w-4 shrink-0 text-muted transition-transform",
                      isOpen && "rotate-180",
                    )}
                    aria-hidden
                  />
                </button>
                {isOpen && (
                  <div
                    role="group"
                    aria-label={`${label} to merge`}
                    className="hr-rise space-y-1.5 rounded-xl border border-line bg-bg/60 p-2"
                    data-testid="home-rows-setup-list"
                  >
                    <p className="px-1 text-[0.74rem] text-faint">
                      Tap the libraries whose Recently Released you want in one row. Tap again to
                      take one out.
                    </p>
                    {libs.map((l) => {
                      const on = mine.includes(l.id);
                      return (
                        <button
                          key={l.id}
                          type="button"
                          aria-pressed={on}
                          disabled={busy}
                          onClick={() => onToggle(type, l.id)}
                          className={cx(
                            "flex min-h-11 w-full items-center gap-2.5 rounded-lg border px-3 text-left text-[0.88rem] transition-colors disabled:opacity-60",
                            on
                              ? "border-gold bg-gold/20 font-semibold text-ink"
                              : "border-line text-muted hover:border-gold/60 hover:text-ink",
                          )}
                          data-testid="home-rows-setup-lib"
                        >
                          <span
                            className={cx(
                              "grid h-5 w-5 shrink-0 place-items-center rounded-md border-2",
                              on ? "border-gold bg-gold text-bg" : "border-line-strong",
                            )}
                            aria-hidden
                          >
                            {on && <Check className="h-3 w-3" strokeWidth={3} />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{l.title}</span>
                          {(l.visibility ?? "0") !== "0" && !was[type].includes(l.id) && (
                            <span className="text-[0.72rem] text-faint">not on Home</span>
                          )}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setOpen((x) => x.filter((t) => t !== type))}
                      className="min-h-10 w-full rounded-lg text-[0.82rem] text-gold hover:bg-gold/10"
                    >
                      Done
                    </button>
                  </div>
                )}
                <div
                  className="space-y-1 text-[0.8rem] text-muted"
                  data-testid="home-rows-setup-what"
                >
                  {merged && keeper ? (
                    <>
                      <p className="flex items-start gap-1.5 text-ink">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" aria-hidden />
                        {list(mine.map(name))} share one Recently Released row.
                      </p>
                      <label className="flex flex-wrap items-center gap-2">
                        Rows show under
                        <select
                          value={keeper}
                          disabled={busy}
                          onChange={(e) => onKeeper(type, e.target.value)}
                          className="min-h-9 rounded-md border border-line-strong bg-panel px-2 text-[0.82rem] text-ink focus:border-gold/60"
                          data-testid="home-rows-setup-keeper"
                        >
                          {mine.map((id) => (
                            <option key={id} value={id}>
                              {name(id)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="text-[0.76rem] text-faint">
                        Plex does this by folding them into one library, so their Recently Added is
                        one row too. The others stay in your sidebar and open as before. No files
                        move.
                      </p>
                      {was[type].length >= 2 && keeper !== was[type][0] && (
                        <p className="text-[0.78rem] text-ink" data-testid="home-rows-setup-move">
                          Save to Plex moves the merged rows from {name(was[type][0]!)} to{" "}
                          {name(keeper)} in one step. Plex then rescans both, which can take a few
                          minutes.
                        </p>
                      )}
                      {carriedOf(o, base, s, type).length > 0 && (
                        <p className="text-[0.78rem] text-ink" data-testid="home-rows-setup-carry">
                          Your own rows ({list(carriedOf(o, base, s, type))}) come along to{" "}
                          {name(keeper)}: the same films, places and order, made there once Plex has
                          scanned. Every film keeps its added date, so Recently Added stays right.
                        </p>
                      )}
                    </>
                  ) : (
                    <p>Not merged: each library has its own Recently Released row.</p>
                  )}
                  {merged && own.length > 0 && (
                    <p>
                      {list(own.map((l) => l.title))}{" "}
                      {own.length === 1 ? "keeps its" : "keep their"} own Recently Released.
                    </p>
                  )}
                  <p className="text-[0.74rem] text-faint">
                    In Plex now:{" "}
                    {was[type].length >= 2
                      ? `${list(was[type].map(name))} merged, rows under ${name(was[type][0]!)}.`
                      : "nothing merged."}
                  </p>
                  {type === "movie" && onDigital && (
                    <label
                      className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border border-line px-2.5 py-2"
                      data-testid="home-rows-setup-digital"
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        className="mt-1 h-4 w-4 accent-gold"
                        checked={Boolean(o.digitalDates)}
                        disabled={busy}
                        onChange={(e) => onDigital(e.target.checked)}
                      />
                      <span>
                        <span className="block text-[0.84rem] font-semibold text-ink">
                          Go by home release, not theaters
                        </span>
                        <span className="block text-[0.74rem] text-faint">
                          A film counts as released when it came out to watch at home (digital, else
                          disc), so one just out on digital comes before a newer streaming film.
                          Off: Plex's usual release date.
                        </span>
                      </span>
                    </label>
                  )}
                  {was[type].length >= 2 && onDates && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onDates(was[type][0]!, was[type].slice(1))}
                        className="min-h-9 rounded-md border border-gold/50 px-3 text-[0.82rem] font-semibold text-gold hover:bg-gold/10 disabled:opacity-50"
                        data-testid="home-rows-setup-dates"
                      >
                        Put back the added dates
                      </button>
                      <p className="text-[0.74rem] text-faint">
                        Plex dates films merged in as added on the day of the merge, so Recently
                        Added can list them out of order. This gives each its own date back.
                      </p>
                    </div>
                  )}
                </div>
                {half
                  .filter((j) => kindOfLib(o, j.into) === type)
                  .map((j) => (
                    <p
                      key={`${j.into}-${j.from}`}
                      className="flex items-start gap-2 rounded-lg border border-gold/40 bg-gold/5 px-2.5 py-2 text-[0.8rem] text-ink"
                    >
                      <AlertTriangle
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold"
                        aria-hidden
                      />
                      {poss(name(j.from))} {word(type)}s show twice: its folders are already in{" "}
                      {name(j.into)}. Merge {name(j.into)} and {name(j.from)} to fix it.
                    </p>
                  ))}
                {separating.length > 0 && (
                  <p className="flex items-start gap-2 text-[0.78rem] text-amber">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    Taking {list(separating.filter((id) => id !== was[type][0]).map(name))} out
                    moves its folders back out of {name(was[type][0]!)}. Plex then rescans, which
                    can take a few minutes; save when nobody is watching.
                  </p>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}
