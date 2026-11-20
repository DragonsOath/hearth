import { useState } from "react";
import { ExternalLink, Music2, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import type { NavidromeDashboard as Data } from "@dragon-control/core";
import { useWorkspace } from "../../data/api";
import { useDashboard } from "../../data/dashboards";
import { ago } from "../../lib/format";
import { keyPageHref } from "../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import type { AppViewProps } from "../panels/registry";
import { Skeleton, cx } from "../ui";
import { MakePlaylist } from "../music/MakePlaylist";

/**
 * Navidrome from Hearth. The Overview answers "is the music library up to date, and who is
 * listening?": songs, albums and artists, the last scan, who is playing what right now, and files
 * Navidrome can no longer find, with a scan and a clean-up one tap away. People lists every user
 * with their role, when they were last on and the apps they listen with, and makes one an
 * administrator or removes them. Each change is a plan you approve; new users are made in Navidrome.
 */

const btn =
  "inline-flex min-h-8 items-center gap-1 rounded-lg border border-line-strong px-2 text-[0.74rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-40 disabled:hover:border-line-strong disabled:hover:text-muted";
const eyebrow = "mb-1 text-[0.72rem] tracking-wide text-faint uppercase";
const input =
  "min-h-8 rounded-lg border border-line bg-raised px-2 text-[0.8rem] text-ink placeholder:text-faint";
const KIND = "app-navidrome-control" as const;

function useNavidrome(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: Data | undefined = q.data?.data?.app === "navidrome" ? q.data.data : undefined;
  return { q, d };
}

function useWeb(serviceId: string) {
  const service = useWorkspace().data?.services.find((s) => s.id === serviceId);
  return (path: string) => keyPageHref(service, path);
}

function Gate({ name, q }: { name: string; q: ReturnType<typeof useNavidrome>["q"] }) {
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div className="rounded-xl border border-amber/40 p-4 text-[0.88rem]" data-testid="nd-error">
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
        {(q.data.error.kind === "needs-key" || q.data.error.kind === "rejected") && (
          <p className="mt-1 text-[0.8rem] text-faint">
            Add an administrator's username and password for Navidrome to Secure Vault, for this
            service. Navidrome locks an account for a while after a few wrong tries.
          </p>
        )}
      </div>
    );
  return null;
}

function Footer({ d, sample, serviceId }: { d: Data; sample?: boolean; serviceId: string }) {
  const web = useWeb(serviceId)("/");
  return (
    <p className="text-[0.74rem] text-faint">
      {sample ? "Sample data · " : ""}
      {d.version ? `Navidrome ${d.version} · ` : ""}live, every 30 s · {d.playlists} playlists ·{" "}
      {d.shares} shared links.{" "}
      {web && (
        <a
          href={web}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline"
        >
          Open Navidrome <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
        </a>
      )}
    </p>
  );
}

export function NavidromeDashboard({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useNavidrome(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Navidrome's panel.");
  if (!d) return <Gate name={name} q={q} />;
  const songs = d.libraries.reduce((n, l) => n + l.songs, 0);
  const albums = d.libraries.reduce((n, l) => n + l.albums, 0);
  const artists = d.libraries.reduce((n, l) => n + l.artists, 0);
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-4"
      data-testid="nd-dashboard"
      aria-label={`${name}: reading`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Songs</p>
          <p className="stat-value text-ink tabular" data-testid="nd-songs">
            {songs.toLocaleString()}
          </p>
          <p className="text-[0.74rem] text-faint">
            {albums} albums · {artists} artists
          </p>
        </div>
        <button
          type="button"
          className="stat-tile rounded-xl border border-line bg-bg/50 p-3 text-left hover:border-gold/50"
          onClick={() => onGo?.("people")}
          data-hearth-target="tab:people:open"
        >
          <p className={eyebrow}>Listening</p>
          <p
            className={cx("stat-value tabular", d.nowPlaying.length ? "text-ok" : "text-ink")}
            data-testid="nd-listening"
          >
            {d.nowPlaying.length}
          </p>
          <p className="text-[0.74rem] text-faint">of {d.users.length} people</p>
        </button>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Last scan</p>
          <p className="stat-value text-[1rem] text-ink" data-testid="nd-scan">
            {d.scan.scanning ? "Scanning…" : d.scan.lastScan ? ago(d.scan.lastScan) : "Never"}
          </p>
          <p className="text-[0.74rem] text-faint">{d.scan.files.toLocaleString()} files</p>
        </div>
        <div className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
          <p className={eyebrow}>Missing</p>
          <p
            className={cx("stat-value tabular", d.missingCount ? "text-amber" : "text-ink")}
            data-testid="nd-missing"
          >
            {d.missingCount}
          </p>
          <p className="text-[0.74rem] text-faint">files it cannot find</p>
        </div>
      </div>

      <div data-testid="nd-now">
        <p className={eyebrow}>Playing now</p>
        {d.nowPlaying.length === 0 ? (
          <p className="text-[0.84rem] text-faint">Nobody is listening right now.</p>
        ) : (
          <ul className="space-y-1.5 text-[0.84rem]">
            {d.nowPlaying.map((n, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <Music2 strokeWidth={1.5} className="h-3.5 w-3.5 self-center text-gold" />
                <span className="text-ink">{n.title}</span>
                <span className="text-muted">
                  {n.artist}
                  {n.album ? ` · ${n.album}` : ""}
                </span>
                <span className="text-faint">
                  {n.user}
                  {n.player ? ` on ${n.player}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {d.missingCount > 0 && (
        <div className="space-y-2" data-testid="nd-missing-list">
          <p className={eyebrow}>Needs a look</p>
          <p className="text-[0.84rem] text-amber">
            Navidrome can no longer find{" "}
            {d.missingCount === 1 ? "1 file" : `${d.missingCount} files`}: moved, renamed or
            deleted.
          </p>
          <ul className="space-y-0.5 text-[0.78rem] text-faint">
            {d.missing.slice(0, 8).map((m) => (
              <li key={m.id} className="break-all">
                {m.title} · {m.artist} · {m.path}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={btn}
            onClick={() => propose({ op: "forget-missing" }, `Forget the missing files in ${name}`)}
            data-testid="nd-forget"
          >
            <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Forget them
          </button>
          <p className="text-[0.74rem] text-faint">
            If a file only moved inside the library, a scan finds it again; forget only what is
            gone.
          </p>
        </div>
      )}

      <div data-hearth-target="navidrome:scan" className="space-y-1">
        <p className={eyebrow}>Library</p>
        {d.libraries.map((l) => (
          <p key={l.id} className="text-[0.82rem] text-muted">
            {l.name} · <span className="font-mono">{l.path}</span>
            {l.lastScan ? ` · scanned ${ago(l.lastScan).toLowerCase()}` : ""}
          </p>
        ))}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            disabled={d.scan.scanning}
            onClick={() => propose({ op: "scan" }, `Scan ${name}'s library`)}
            data-testid="nd-scan-now"
          >
            <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan for new music
          </button>
          <button
            type="button"
            className={btn}
            disabled={d.scan.scanning}
            onClick={() => propose({ op: "full-scan" }, `Scan ${name}'s whole library again`)}
          >
            Full scan
          </button>
        </div>
        <MakePlaylist app="Navidrome" serviceId={serviceId} serviceName={name} />
      </div>

      <Footer d={d} sample={q.data?.sample} serviceId={serviceId} />
    </section>
  );
}

export function NavidromePeople({ serviceId, name }: AppViewProps) {
  const { q, d } = useNavidrome(serviceId);
  const act = useApproveHere(serviceId, "Proposed from Navidrome's panel.");
  const [find, setFind] = useState("");
  if (!d) return <Gate name={name} q={q} />;
  const needle = find.trim().toLowerCase();
  const users = d.users.filter(
    (u) =>
      !needle || u.userName.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle),
  );
  const propose = (params: Record<string, string>, title: string) =>
    void act.propose(KIND, params, title);
  return (
    <section
      className="@container space-y-3"
      data-testid="nd-people-tab"
      aria-label={`${name}: people`}
    >
      <ApproveDialog c={act} />
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
      <input
        value={find}
        onChange={(e) => setFind(e.target.value)}
        placeholder="Find a person"
        aria-label="Find a person"
        className={cx(input, "min-h-9 w-full")}
        data-hearth-target="people:find"
      />
      <ul className="divide-y divide-line">
        {users.map((u) => {
          const playing = d.nowPlaying.find((n) => n.user === u.userName);
          const apps = d.players.filter((p) => p.user === u.userName);
          return (
            <li
              key={u.id}
              className="space-y-1.5 py-3"
              data-testid="nd-user"
              data-capture-item
              data-capture-label={u.name}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[0.9rem] text-ink">{u.name}</span>
                <span className="text-[0.74rem] text-faint">{u.userName}</span>
                {u.admin && <span className="text-[0.74rem] text-gold">administrator</span>}
                <span className="ml-auto text-[0.74rem] text-faint">
                  {playing ? (
                    <span className="text-ok">listening to {playing.title}</span>
                  ) : u.lastSeen ? (
                    `on ${ago(u.lastSeen).toLowerCase()}`
                  ) : (
                    "never signed in"
                  )}
                </span>
              </div>
              {apps.length > 0 && (
                <p className="text-[0.74rem] text-faint">
                  Listens with {apps.map((p) => p.client || p.name).join(", ")}
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    propose(
                      { op: u.admin ? "admin-off" : "admin-on", userId: u.id },
                      `${u.admin ? "Make" : "Make"} ${u.name} ${u.admin ? "an ordinary user" : "an administrator"}`,
                    )
                  }
                  data-testid="nd-admin-toggle"
                >
                  {u.admin ? (
                    <ShieldOff strokeWidth={1.5} className="h-3.5 w-3.5" />
                  ) : (
                    <ShieldCheck strokeWidth={1.5} className="h-3.5 w-3.5" />
                  )}
                  {u.admin ? "Make ordinary user" : "Make administrator"}
                </button>
                <button
                  type="button"
                  className={cx(btn, "ml-auto hover:border-alert/60 hover:text-alert")}
                  onClick={() =>
                    propose({ op: "remove-user", userId: u.id }, `Remove ${u.name} from ${name}`)
                  }
                >
                  <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[0.74rem] text-faint">
        New people and passwords are made in Navidrome (its Users page). Removing someone removes
        their playlists, stars and play counts; the music stays.
      </p>
    </section>
  );
}
