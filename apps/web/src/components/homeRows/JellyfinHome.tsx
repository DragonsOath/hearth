import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Undo2, X } from "lucide-react";
import { api } from "../../data/api";
import { ChangeCard, useConfirmedChange } from "../dashboards/ConfirmedChange";
import { Skeleton, cx } from "../ui";

/**
 * Home rows for Jellyfin (11-08). Jellyfin builds each person's home screen from its own
 * sections (My Media, Continue Watching, Next Up, Recently Added...), their library order, and
 * which libraries get a Recently Added row. Here: pick whose home it is, arrange it with posters
 * as it will look, and "Save to Jellyfin" is one plan you approve (several people at once if you
 * like), read back, with Undo. Rows of your own collections need the Home Screen Sections plugin.
 */

const KIND = "app-jellyfin-control";

interface Home {
  sections: string[];
  order: string[];
  latest: string[];
  media: string[];
  hideWatched: boolean;
}
interface HomeView {
  users: { id: string; name: string; admin: boolean }[];
  userId: string;
  home: Home;
  libraries: { id: string; name: string; type: string }[];
  sections: { id: string; name: string }[];
  slots: number;
  previews: Record<string, { id: string; title: string }[]>;
  /** Home Screen Sections; replacesHome: it is switched on and draws the home screen itself. */
  plugin: { name: string; active: boolean; replacesHome?: boolean } | null;
}

/** What each of Jellyfin's sections is for, in a few words. */
const ABOUT: Record<string, string> = {
  smalllibrarytiles: "Your libraries as big tiles",
  librarybuttons: "Your libraries as small buttons",
  resume: "What you started and didn't finish",
  resumeaudio: "Music and audiobooks you were in the middle of",
  resumebook: "Books you were reading",
  nextup: "The next episode of shows you watch",
  latestmedia: "A row per library of what just arrived",
  activerecordings: "Live TV being recorded now",
  livetv: "Live TV channels and guide",
};

const iconBtn =
  "hr-lift grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-line hover:text-ink disabled:pointer-events-none disabled:opacity-30";
const chip =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.8rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-50";

const same = (a: Home, b: Home) =>
  a.sections.join() === b.sections.join() &&
  a.order.join() === b.order.join() &&
  [...a.latest].sort().join() === [...b.latest].sort().join() &&
  [...a.media].sort().join() === [...b.media].sort().join() &&
  a.hideWatched === b.hideWatched;

const move = <T,>(list: T[], i: number, by: number) => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

function useHomeView(serviceId: string, userId: string | undefined) {
  return useQuery({
    // Under "dashboard": a finished plan refreshes it with the rest of the panel.
    queryKey: ["dashboard", serviceId, "jellyfin", "home", userId ?? ""],
    queryFn: () =>
      api<HomeView>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/jellyfin/home${userId ? `?id=${encodeURIComponent(userId)}` : ""}`,
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

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

export function JellyfinHomeEditor({ serviceId }: { serviceId: string }) {
  const [userId, setUserId] = useState<string>();
  const view = useHomeView(serviceId, userId);
  const v = view.data;
  // Edits belong to what Jellyfin had when they began: another person, or a saved change read
  // back, starts again from Jellyfin; a plain refetch keeps the edits under way.
  const [edit, setEdit] = useState<{ key: string; home: Home; also: string[] }>();
  const change = useConfirmedChange(serviceId);
  const who = v?.userId;
  const serverHome = v ? `${v.userId}:${JSON.stringify(v.home)}` : "";
  const mine = edit?.key === serverHome ? edit : undefined;
  const draft = mine?.home ?? v?.home;
  const also = mine?.also ?? [];
  const setDraft = (home: Home) => setEdit({ key: serverHome, home, also });
  const setAlso = (list: string[]) =>
    draft && setEdit({ key: serverHome, home: draft, also: list });
  const libs = useMemo(() => new Map((v?.libraries ?? []).map((l) => [l.id, l])), [v]);
  if (view.isLoading || (!v && !view.error)) return <Skeleton className="h-64" />;
  if (view.error || !v || !draft)
    return (
      <p className="text-[0.9rem] text-amber" data-testid="jf-home-error">
        {view.error instanceof Error ? view.error.message : "Jellyfin's home screen can't be read."}
      </p>
    );
  const changed = !same(draft, v.home) || also.length > 0;
  const name = v.users.find((u) => u.id === who)?.name ?? "this person";
  const set = (p: Partial<Home>) => setDraft({ ...draft, ...p });
  const toggle = (key: "latest" | "media", id: string) =>
    set({
      [key]: draft[key].includes(id) ? draft[key].filter((x) => x !== id) : [...draft[key], id],
    });
  const missing = v.sections.filter((s) => !draft.sections.includes(s.id));
  const done = change.job?.status === "succeeded" ? change.job : undefined;
  const before = done?.steps[0]?.params?.before;
  const send = () => {
    const homes: Record<string, Home> = { [who!]: draft };
    for (const id of also) homes[id] = draft;
    const people = [name, ...also.map((id) => v.users.find((u) => u.id === id)?.name ?? id)];
    void change.propose(
      KIND,
      { op: "home-screen", homes: JSON.stringify(homes) },
      `Jellyfin home screen for ${people.join(", ")}`,
    );
  };
  return (
    <div className="@container space-y-4" data-testid="jf-home">
      {v.plugin?.replacesHome && (
        <p
          className="rounded-xl border border-amber/50 bg-amber/10 p-3 text-[0.84rem] text-ink"
          data-testid="jf-home-hss-on"
        >
          {v.plugin.name} is switched on in Jellyfin, so it draws the home screen instead of
          Jellyfin&apos;s own sections: changes here won&apos;t show until it is off (Jellyfin,
          Dashboard, Plugins, {v.plugin.name}).
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.8rem] text-muted">Whose home screen</span>
        {v.users.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => setUserId(u.id)}
            aria-pressed={u.id === who}
            className={cx(
              "hr-lift min-h-9 rounded-full border px-3 text-[0.82rem]",
              u.id === who
                ? "border-gold bg-gold/15 text-gold-bright"
                : "border-line-strong text-muted hover:text-ink",
            )}
            data-testid="jf-home-user"
          >
            {u.name}
          </button>
        ))}
      </div>

      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-label={`${name}'s home`} className="space-y-2">
          <h3 className="text-[0.75rem] tracking-[0.12em] text-gold uppercase">
            {name}'s home, top to bottom
          </h3>
          {!draft.sections.length && (
            <p className="rounded-xl border border-dashed border-line-strong p-4 text-[0.85rem] text-muted">
              Nothing on the home screen. Add a section on the right.
            </p>
          )}
          <ol className="space-y-2">
            {draft.sections.map((s, i) => {
              const label = v.sections.find((x) => x.id === s)?.name ?? s;
              const shown = draft.order.filter((id) => draft.latest.includes(id));
              return (
                <li
                  key={s}
                  className="hr-row rounded-xl border border-line bg-panel p-3"
                  data-testid="jf-home-section"
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink">{label}</p>
                      <p className="text-[0.78rem] text-muted">{ABOUT[s]}</p>
                    </div>
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={`Move ${label} up`}
                      disabled={i === 0}
                      onClick={() => set({ sections: move(draft.sections, i, -1) })}
                    >
                      <ArrowUp strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={`Move ${label} down`}
                      disabled={i === draft.sections.length - 1}
                      onClick={() => set({ sections: move(draft.sections, i, 1) })}
                    >
                      <ArrowDown strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      className={iconBtn}
                      aria-label={`Take ${label} off`}
                      onClick={() => set({ sections: draft.sections.filter((x) => x !== s) })}
                      data-testid="jf-home-remove"
                    >
                      <X strokeWidth={1.5} className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 space-y-2">
                    {s === "latestmedia" ? (
                      shown.length ? (
                        shown.map((id) => (
                          <div key={id}>
                            <p className="mb-1 text-[0.78rem] text-muted">
                              Recently Added in {libs.get(id)?.name ?? id}
                            </p>
                            <Posters
                              serviceId={serviceId}
                              items={v.previews[`latest:${id}`]}
                              empty="Nothing new yet."
                            />
                          </div>
                        ))
                      ) : (
                        <p className="text-[0.78rem] text-faint">
                          No library has a Recently Added row: turn one on under Libraries.
                        </p>
                      )
                    ) : s === "smalllibrarytiles" || s === "librarybuttons" ? (
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
                    ) : s === "resume" || s === "nextup" ? (
                      <Posters
                        serviceId={serviceId}
                        items={v.previews[s]}
                        empty={`Empty for ${name} right now; it fills as they watch.`}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <section aria-label="Change it" className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-[0.75rem] tracking-[0.12em] text-gold uppercase">Add a section</h3>
            {missing.length ? (
              <div className="flex flex-wrap gap-2">
                {missing.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={chip}
                    disabled={draft.sections.length >= v.slots}
                    onClick={() => set({ sections: [...draft.sections, s.id] })}
                    title={ABOUT[s.id]}
                    data-testid="jf-home-add"
                  >
                    <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> {s.name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[0.8rem] text-muted">Every Jellyfin section is on already.</p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-[0.75rem] tracking-[0.12em] text-gold uppercase">Libraries</h3>
            <p className="text-[0.78rem] text-muted">
              Their order is the order of the Recently Added rows and My Media.
            </p>
            <ul className="space-y-1.5">
              {draft.order.map((id, i) => (
                <li
                  key={id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-2.5 py-1.5"
                  data-testid="jf-home-library"
                >
                  <span className="min-w-0 flex-1 text-[0.86rem] text-ink">
                    {libs.get(id)?.name ?? id}
                  </span>
                  <label className="flex items-center gap-1.5 text-[0.76rem] text-muted">
                    <input
                      type="checkbox"
                      checked={draft.latest.includes(id)}
                      onChange={() => toggle("latest", id)}
                      data-testid="jf-home-latest"
                    />
                    Recently Added row
                  </label>
                  <label className="flex items-center gap-1.5 text-[0.76rem] text-muted">
                    <input
                      type="checkbox"
                      checked={draft.media.includes(id)}
                      onChange={() => toggle("media", id)}
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
            <label className="flex items-center gap-2 text-[0.82rem] text-muted">
              <input
                type="checkbox"
                checked={draft.hideWatched}
                onChange={() => set({ hideWatched: !draft.hideWatched })}
              />
              Leave watched titles out of Recently Added
            </label>
          </div>

          <div
            className="rounded-xl border border-line bg-panel p-3 text-[0.8rem] text-muted"
            data-testid="jf-home-plugin"
          >
            <p className="font-semibold text-ink">Rows of your own collections</p>
            <p className="mt-1">
              Jellyfin shows only its own sections. A row of one collection, like "80s horror",
              needs two community plugins: Home Screen Sections
              {v.plugin
                ? ` (installed${v.plugin.active ? "" : ", turned off"})`
                : " (not installed)"}{" "}
              and Collection Sections. Hearth will set those rows up in a later update.
            </p>
          </div>
        </section>
      </div>

      {(changed || change.job || change.error) && (
        <div
          className="space-y-2 rounded-xl border border-gold/40 bg-gold/5 p-3"
          data-testid="jf-home-save"
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
                data-testid="jf-home-send"
              >
                Save to Jellyfin
              </button>
              <button
                type="button"
                className={chip}
                onClick={() => {
                  setEdit(undefined);
                }}
              >
                Start over
              </button>
            </div>
          )}
          <ChangeCard c={change} confirmLabel="Save to Jellyfin" />
          {done && typeof before === "string" && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={chip}
                onClick={() =>
                  void change.propose(
                    KIND,
                    { op: "home-screen", homes: before },
                    "Put the Jellyfin home screen back",
                  )
                }
                data-testid="jf-home-undo"
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
