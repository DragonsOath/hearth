import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Search, Trash2, UserRound } from "lucide-react";
import { api, useWorkspace } from "../../../data/api";
import { ago } from "../../../lib/format";
import { keyPageHref } from "../../../lib/keyPage";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";

/**
 * Tautulli's History, People, Libraries, Graphs and System tabs. Changes are plans you approve
 * (rename a person or stop recording their plays, stop recording a library, delete play records,
 * back up the database, read the lists from Plex again); Ember plans the same steps.
 * Notifications, newsletters and Tautulli's settings stay in Tautulli, linked from here.
 */

function useTautulli<T>(
  serviceId: string,
  view: string,
  q: Record<string, string | number | undefined> = {},
  enabled = true,
) {
  const params = new URLSearchParams(
    Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return useQuery({
    // Under "dashboard": a finished plan refreshes it with the rest of the panel.
    queryKey: ["dashboard", serviceId, "tautulli", view, params],
    queryFn: () =>
      api<T & { sample?: boolean }>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/tautulli/${view}${params ? `?${params}` : ""}`,
      ),
    enabled,
    staleTime: 20_000,
  });
}

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-muted hover:border-gold/50 hover:text-ink disabled:opacity-50";
const input =
  "min-h-9 rounded-lg border border-line bg-raised px-2.5 text-[0.84rem] text-ink placeholder:text-faint";

function InTautulli({
  serviceId,
  path,
  children,
}: {
  serviceId: string;
  path: string;
  children: React.ReactNode;
}) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  const href = keyPageHref(service, path);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-9 items-center gap-1.5 text-[0.8rem] text-gold underline-offset-2 hover:underline"
    >
      {children} <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
    </a>
  );
}

interface Entry {
  id: number;
  at?: string;
  who: string;
  userId?: number;
  title: string;
  type?: string;
  player?: string;
  away: boolean;
  watchedPct?: number;
  minutes?: number;
  how?: string;
}

function Pager({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 text-[0.78rem] text-muted">
      <button type="button" className={btn} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Newer
      </button>
      <span>
        Page {page} of {pages}
      </span>
      <button
        type="button"
        className={btn}
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        Older
      </button>
    </div>
  );
}

export function TautulliHistory({ serviceId, name }: AppViewProps) {
  const [page, setPage] = useState(1);
  const [userId, setUserId] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const q = useTautulli<{
    entries: Entry[];
    total: number;
    people: { id: number; name: string }[];
  }>(serviceId, "history", { page, userId, type, q: term });
  const act = useApproveHere(serviceId, "From Tautulli's History tab.");
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s history.</p>;
  const d = q.data;
  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(0, 50)));
  return (
    <section className="space-y-3" aria-label={`${name} history`}>
      <ApproveDialog c={act} />
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(search.trim());
          setPage(1);
        }}
      >
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Find a title</span>
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-faint"
          />
          <input
            className={cx(input, "w-full pl-8")}
            placeholder="Find a title"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (!e.target.value) setTerm("");
            }}
            data-hearth-target="history:search"
          />
        </label>
        <select
          className={input}
          aria-label="Person"
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            setPage(1);
          }}
          data-hearth-target="history:person"
        >
          <option value="">Everyone</option>
          {d.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className={input}
          aria-label="Kind"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Everything</option>
          <option value="movie">Movies</option>
          <option value="episode">Episodes</option>
          <option value="track">Music</option>
        </select>
      </form>
      {d.entries.length === 0 ? (
        <p className="text-[0.84rem] text-muted">
          {term || userId || type ? "Nothing matches." : "Nothing has been played yet."}
        </p>
      ) : (
        <ul
          className="divide-y divide-line"
          data-testid="tt-history"
          data-hearth-target="history:list"
        >
          {d.entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[0.86rem]"
              data-testid="tt-play"
            >
              <input
                type="checkbox"
                aria-label={`Select ${e.who}'s play of ${e.title}`}
                checked={picked.includes(e.id)}
                onChange={() => toggle(e.id)}
                data-hearth-target={`history:pick:${e.id}`}
              />
              <span className="min-w-0 flex-1">
                <span className="text-ink">{e.title}</span>
                <span className="block text-[0.76rem] text-faint">
                  {[
                    e.who,
                    e.at ? ago(e.at) : "",
                    e.player,
                    e.away ? "away from home" : "",
                    e.how,
                    e.watchedPct !== undefined ? `${e.watchedPct}% watched` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Pager page={page} pages={Math.max(1, Math.ceil(d.total / 50))} onPage={setPage} />
        {picked.length > 0 && (
          <button
            type="button"
            className={cx(btn, "hover:border-alert/60 hover:text-alert")}
            disabled={act.busy}
            data-hearth-target="history:delete"
            onClick={() =>
              void act
                .propose(
                  "app-tautulli-control",
                  { op: "delete-history", rowIds: picked.join(",") },
                  picked.length === 1
                    ? "Delete a play record"
                    : `Delete ${picked.length} play records`,
                )
                .then(() => setPicked([]))
            }
          >
            <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Delete {picked.length} selected
          </button>
        )}
      </div>
    </section>
  );
}

interface Person {
  id: number;
  name: string;
  username?: string;
  plays: number;
  hours: number;
  lastSeen?: string;
  lastPlayed?: string;
  player?: string;
}

function PersonPage({
  serviceId,
  id,
  onBack,
}: {
  serviceId: string;
  id: string;
  onBack: () => void;
}) {
  const q = useTautulli<{
    id: number;
    name: string;
    username?: string;
    keepHistory: boolean;
    allowGuest: boolean;
    watchTime: { days: number; plays: number; hours: number }[];
    players: { name: string; plays: number }[];
  }>(serviceId, "user", { id });
  const act = useApproveHere(serviceId, "From Tautulli's People tab.");
  const [name, setName] = useState<string>();
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return (
      <div className="space-y-2">
        <button type="button" className={btn} onClick={onBack}>
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> People
        </button>
        <p className="text-[0.84rem] text-amber">Tautulli does not know that person.</p>
      </div>
    );
  const u = q.data;
  const edit = (body: Record<string, unknown>, title: string) =>
    void act.propose(
      "app-tautulli-control",
      { op: "edit-user", userId: String(u.id), body: JSON.stringify(body) },
      title,
    );
  const label = (days: number) =>
    days === 0 ? "All time" : days === 1 ? "Last day" : `Last ${days} days`;
  return (
    <section className="space-y-4" aria-label={u.name} data-testid="tt-person">
      <ApproveDialog c={act} />
      <button type="button" className={btn} onClick={onBack} data-hearth-target="person:back">
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> People
      </button>
      <div>
        <h3 className="text-[1.05rem] text-ink">{u.name}</h3>
        {u.username && u.username !== u.name && (
          <p className="text-[0.78rem] text-faint">Plex: {u.username}</p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="tt-watch-time">
        {u.watchTime.map((t) => (
          <div key={t.days} className="rounded-xl border border-line bg-bg/50 p-2.5">
            <dt className="text-[0.72rem] text-faint">{label(t.days)}</dt>
            <dd className="text-[0.92rem] text-ink">
              {t.plays} {t.plays === 1 ? "play" : "plays"}
              <span className="block text-[0.74rem] text-faint">{t.hours} h</span>
            </dd>
          </div>
        ))}
      </dl>
      {u.players.length > 0 && (
        <p className="text-[0.8rem] text-muted">
          Watches on {u.players.map((p) => `${p.name} (${p.plays})`).join(", ")}
        </p>
      )}
      <div className="space-y-2 rounded-xl border border-line bg-bg/50 p-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name && name.trim() !== u.name)
              edit({ friendlyName: name.trim() }, `Rename ${u.name}`);
          }}
        >
          <label className="grid min-w-0 flex-1 gap-1 text-[0.76rem] text-faint">
            Name in Tautulli
            <input
              className={input}
              value={name ?? u.name}
              onChange={(e) => setName(e.target.value)}
              data-hearth-target="person:name"
            />
          </label>
          <Button
            tone="primary"
            type="submit"
            disabled={act.busy || !name || name.trim() === u.name || !name.trim()}
            data-hearth-target="person:rename"
          >
            Review
          </Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            disabled={act.busy}
            data-hearth-target="person:history"
            onClick={() =>
              edit(
                { keepHistory: !u.keepHistory },
                `${u.keepHistory ? "Stop recording" : "Record"} ${u.name}'s plays`,
              )
            }
          >
            {u.keepHistory ? "Stop recording their plays" : "Record their plays"}
          </button>
          <button
            type="button"
            className={btn}
            disabled={act.busy}
            data-hearth-target="person:guest"
            onClick={() =>
              edit(
                { allowGuest: !u.allowGuest },
                `${u.allowGuest ? "Remove" : "Allow"} guest access for ${u.name}`,
              )
            }
          >
            {u.allowGuest ? "Remove guest access" : "Allow guest access"}
          </button>
        </div>
        <p className="text-[0.74rem] text-faint">
          {u.keepHistory ? "Their plays are recorded." : "Their plays are not recorded."}{" "}
          {u.allowGuest ? "They can sign in to Tautulli as a guest." : ""}
        </p>
      </div>
    </section>
  );
}

export function TautulliPeople({ serviceId, name, sub, onSub }: AppViewProps) {
  const [local, setLocal] = useState<string | null>(null);
  const where = onSub ? (sub ?? null) : local;
  const go = (s: string | null) => (onSub ? onSub(s) : setLocal(s));
  const q = useTautulli<{ users: Person[] }>(serviceId, "users");
  const act = useApproveHere(serviceId, "From Tautulli's People tab.");
  const id = where?.startsWith("person/") ? where.slice(7) : undefined;
  if (id) return <PersonPage serviceId={serviceId} id={id} onBack={() => go(null)} />;
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s people.</p>;
  return (
    <section className="space-y-3" aria-label={`${name} people`}>
      <ApproveDialog c={act} />
      <ul className="divide-y divide-line" data-testid="tt-people" data-hearth-target="people:list">
        {q.data.users.map((u) => (
          <li key={u.id} data-testid="tt-person-row">
            <button
              type="button"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-left text-[0.86rem] hover:text-gold"
              onClick={() => go(`person/${u.id}`)}
              data-hearth-target={`person:${u.id}:open`}
            >
              <UserRound strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="text-ink">{u.name}</span>
                <span className="block text-[0.76rem] text-faint">
                  {[u.lastSeen ? `seen ${ago(u.lastSeen)}` : "never played", u.lastPlayed, u.player]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="text-[0.78rem] text-muted">
                {u.plays} {u.plays === 1 ? "play" : "plays"} · {u.hours} h
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={btn}
        disabled={act.busy}
        data-hearth-target="people:refresh"
        onClick={() =>
          void act.propose(
            "app-tautulli-control",
            { op: "refresh-users" },
            "Read the people from Plex again",
          )
        }
      >
        Read people from Plex again
      </button>
    </section>
  );
}

export function TautulliLibraries({ serviceId, name }: AppViewProps) {
  const q = useTautulli<{
    libraries: {
      id: number;
      name: string;
      type?: string;
      items: number;
      seasonsOrAlbums?: number;
      episodesOrTracks?: number;
      plays: number;
      hours: number;
      lastPlayed?: string;
      lastAt?: string;
      keepHistory: boolean;
    }[];
  }>(serviceId, "libraries");
  const act = useApproveHere(serviceId, "From Tautulli's Libraries tab.");
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s libraries.</p>;
  return (
    <section className="space-y-3" aria-label={`${name} libraries`}>
      <ApproveDialog c={act} />
      <ul
        className="divide-y divide-line"
        data-testid="tt-libraries"
        data-hearth-target="libraries:list"
      >
        {q.data.libraries.map((l) => (
          <li
            key={l.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
            data-testid="tt-library"
          >
            <span className="min-w-0 flex-1">
              <span className="text-ink">{l.name}</span>
              <span className="block text-[0.76rem] text-faint">
                {[
                  `${l.items.toLocaleString()} ${l.type === "show" ? "shows" : l.type === "artist" ? "artists" : "items"}`,
                  l.episodesOrTracks !== undefined
                    ? `${l.episodesOrTracks.toLocaleString()} ${l.type === "show" ? "episodes" : "tracks"}`
                    : "",
                  `${l.plays} plays · ${l.hours} h`,
                  l.lastPlayed
                    ? `last: ${l.lastPlayed}${l.lastAt ? `, ${ago(l.lastAt)}` : ""}`
                    : "",
                  l.keepHistory ? "" : "plays not recorded",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <button
              type="button"
              className={btn}
              disabled={act.busy}
              data-hearth-target={`library:${l.id}:history`}
              onClick={() =>
                void act.propose(
                  "app-tautulli-control",
                  {
                    op: "edit-library",
                    libraryId: String(l.id),
                    body: JSON.stringify({ keepHistory: !l.keepHistory }),
                  },
                  `${l.keepHistory ? "Stop recording" : "Record"} plays from ${l.name}`,
                )
              }
            >
              {l.keepHistory ? "Stop recording plays" : "Record plays"}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={btn}
        disabled={act.busy}
        data-hearth-target="libraries:refresh"
        onClick={() =>
          void act.propose(
            "app-tautulli-control",
            { op: "refresh-libraries" },
            "Read the libraries from Plex again",
          )
        }
      >
        Read libraries from Plex again
      </button>
    </section>
  );
}

/** Categorical slots 1 and 2 of the validated chart palette (dark surface). */
const SERIES: Record<string, string> = { TV: "#3987e5", Movies: "#d95926" };

export function TautulliGraphs({ serviceId, name }: AppViewProps) {
  const [days, setDays] = useState(30);
  const [hover, setHover] = useState<number>();
  const q = useTautulli<{
    days: number;
    dates: string[];
    series: { name: string; data: number[] }[];
  }>(serviceId, "graphs", { days });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s plays.</p>;
  const { dates } = q.data;
  // Stacked: every series except the total, in a fixed order (TV, Movies, then the rest).
  const parts = q.data.series.filter((s) => s.name !== "Total");
  const totals = dates.map((_, i) => parts.reduce((n, s) => n + (s.data[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const sum = totals.reduce((a, b) => a + b, 0);
  const color = (n: string, i: number) => SERIES[n] ?? ["#199e70", "#c98500"][i % 2]!;
  const day = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  return (
    <section className="space-y-3" aria-label={`${name} plays per day`}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[0.92rem] text-ink">
          Plays per day{" "}
          <span className="text-faint">
            · {sum} in {days} days
          </span>
        </h3>
        <div className="ml-auto flex gap-1" role="group" aria-label="Time range">
          {[7, 30, 90].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={days === n}
              className={cx(btn, days === n && "border-gold/60 text-ink")}
              onClick={() => setDays(n)}
              data-hearth-target={`graphs:${n}`}
            >
              {n} days
            </button>
          ))}
        </div>
      </div>
      <ul className="flex flex-wrap gap-3 text-[0.78rem] text-muted" aria-label="Legend">
        {parts.map((s, i) => (
          <li key={s.name} className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: color(s.name, i) }}
              aria-hidden
            />
            {s.name}
          </li>
        ))}
      </ul>
      <div className="relative" data-testid="tt-graph" data-hearth-target="graphs:chart">
        <div className="flex h-44 items-end gap-[2px] border-b border-line" aria-hidden>
          {dates.map((d, i) => (
            <div
              key={d}
              className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(undefined)}
            >
              <div
                className="flex w-full max-w-6 flex-col-reverse gap-[2px]"
                style={{ height: `${(totals[i]! / max) * 100}%` }}
              >
                {parts.map((s, k) =>
                  (s.data[i] ?? 0) > 0 ? (
                    <div
                      key={s.name}
                      className={cx(
                        "w-full",
                        k === parts.findLastIndex((x) => (x.data[i] ?? 0) > 0) && "rounded-t",
                      )}
                      style={{
                        flexGrow: s.data[i],
                        background: color(s.name, k),
                        opacity: hover === undefined || hover === i ? 1 : 0.55,
                      }}
                    />
                  ) : null,
                )}
              </div>
            </div>
          ))}
        </div>
        {hover !== undefined && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[0.76rem] text-ink shadow-lg"
            style={{
              left: `min(calc(${((hover + 0.5) / dates.length) * 100}% - 3rem), calc(100% - 7rem))`,
            }}
            data-testid="tt-graph-tip"
          >
            <p className="text-faint">{day(dates[hover]!)}</p>
            {parts.map((s, k) => (
              <p key={s.name} className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-sm"
                  style={{ background: color(s.name, k) }}
                  aria-hidden
                />
                {s.name}: {s.data[hover] ?? 0}
              </p>
            ))}
          </div>
        )}
        <div className="mt-1 flex justify-between text-[0.7rem] text-faint" aria-hidden>
          <span>{dates[0] ? day(dates[0]) : ""}</span>
          <span>{dates.at(-1) ? day(dates.at(-1)!) : ""}</span>
        </div>
      </div>
      <table className="sr-only">
        <caption>Plays per day, last {days} days</caption>
        <thead>
          <tr>
            <th>Day</th>
            {parts.map((s) => (
              <th key={s.name}>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((d, i) => (
            <tr key={d}>
              <td>{d}</td>
              {parts.map((s) => (
                <td key={s.name}>{s.data[i] ?? 0}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function TautulliSystem({ serviceId, name }: AppViewProps) {
  const q = useTautulli<{ lines: { at?: string; level?: string; text: string }[] }>(
    serviceId,
    "logs",
  );
  const act = useApproveHere(serviceId, "From Tautulli's System tab.");
  return (
    <section className="space-y-4" aria-label={`${name} system`}>
      <ApproveDialog c={act} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btn}
          disabled={act.busy}
          data-hearth-target="system:backup"
          onClick={() =>
            void act.propose(
              "app-tautulli-control",
              { op: "backup-db" },
              "Back up Tautulli's database",
            )
          }
        >
          Back up database
        </button>
        <InTautulli serviceId={serviceId} path="/settings">
          Notifications, newsletters and settings in Tautulli
        </InTautulli>
      </div>
      <div>
        <p className="eyebrow mb-1">Tautulli&apos;s log (keys hidden)</p>
        {q.isLoading ? (
          <Skeleton className="h-40" />
        ) : q.error || !q.data ? (
          <p className="text-[0.84rem] text-amber">Could not read {name}&apos;s log.</p>
        ) : (
          <ul
            className="max-h-96 space-y-1 overflow-auto rounded-xl border border-line bg-bg/60 p-3 font-mono text-[0.72rem] text-muted"
            data-testid="tt-log"
            data-hearth-target="system:log"
            tabIndex={0}
          >
            {q.data.lines.map((l, i) => (
              <li
                key={i}
                className={cx(
                  l.level === "ERROR" && "text-alert",
                  l.level === "WARNING" && "text-amber",
                )}
              >
                <span className="text-faint">{l.at}</span> {l.level} {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
