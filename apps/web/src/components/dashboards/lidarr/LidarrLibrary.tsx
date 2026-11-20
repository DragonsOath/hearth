import { useState } from "react";
import { ArrowLeft, Disc3, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { cx } from "../../ui";
import {
  Check,
  Field,
  Guard,
  LoadError,
  Loading,
  ProposeError,
  btn,
  btnBad,
  btnGold,
  day,
  gb,
  input,
  inputAuto,
  usePropose,
  when,
} from "../radarr/common";
import { EVENT_WORDS } from "../radarr/common";
import { MONITOR, NEW_ITEMS, minutes, useLidarr, type AlbumRow, type ArtistRow } from "./data";

/**
 * Lidarr's Library tab: every artist with how much of their music is on disk; an artist's page
 * (settings, albums with monitoring and search, recent history, remove); an album's tracks and
 * files; and adding an artist through Lidarr's own search. Address: "", "artist/<id>",
 * "album/<id>", "add".
 */
export function LidarrLibrary({ serviceId, sub, onSub }: AppViewProps) {
  const [head, rest] = (sub ?? "").split("/");
  const id = rest && /^\d+$/.test(rest) ? Number(rest) : undefined;
  if (head === "artist" && id)
    return (
      <ArtistPage
        serviceId={serviceId}
        id={id}
        onBack={() => onSub?.(null)}
        onAlbum={(a) => onSub?.(`album/${a}`)}
      />
    );
  if (head === "album" && id)
    return (
      <AlbumPage
        serviceId={serviceId}
        id={id}
        onArtist={(a) => onSub?.(a ? `artist/${a}` : null)}
      />
    );
  if (head === "add") return <AddArtist serviceId={serviceId} onBack={() => onSub?.(null)} />;
  return (
    <ArtistList
      serviceId={serviceId}
      onOpen={(a) => onSub?.(`artist/${a}`)}
      onAdd={() => onSub?.("add")}
    />
  );
}

const pct = (s: { files: number; total: number }) =>
  s.total ? Math.round((s.files / s.total) * 100) : 0;

type Filter = "all" | "missing" | "complete" | "unmonitored";
type Sort = "name" | "size" | "added";

function ArtistList({
  serviceId,
  onOpen,
  onAdd,
}: {
  serviceId: string;
  onOpen: (id: number) => void;
  onAdd: () => void;
}) {
  const q = useLidarr(serviceId, "library");
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("name");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const rows = q.data.artists
    .filter((a) => !text || a.name.toLowerCase().includes(text.toLowerCase()))
    .filter((a) =>
      filter === "missing"
        ? a.monitored && a.stats.files < a.stats.total
        : filter === "complete"
          ? a.stats.total > 0 && a.stats.files >= a.stats.total
          : filter === "unmonitored"
            ? !a.monitored
            : true,
    )
    .sort((a, b) =>
      sort === "size"
        ? b.stats.size - a.stats.size
        : sort === "added"
          ? (b.added ?? "").localeCompare(a.added ?? "")
          : a.sortName.localeCompare(b.sortName),
    );
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-3" data-testid="lidarr-library">
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Find an artist"
            aria-label="Find an artist"
            className={`${input} min-w-0 flex-1 basis-48`}
            data-hearth-target="library:search"
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
            aria-label="Show"
            className={inputAuto}
            data-hearth-target="library:filter"
          >
            <option value="all">Every artist</option>
            <option value="missing">Missing music</option>
            <option value="complete">Complete</option>
            <option value="unmonitored">Not monitored</option>
          </select>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort by"
            className={inputAuto}
            data-hearth-target="library:sort"
          >
            <option value="name">Name</option>
            <option value="size">Size on disk</option>
            <option value="added">Newest added</option>
          </select>
          <button
            type="button"
            className={btnGold}
            onClick={onAdd}
            data-hearth-target="library:add"
          >
            <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add an artist
          </button>
        </div>
        <p className="text-[0.78rem] text-faint">
          {rows.length} of {q.data.artists.length} artists
        </p>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {rows.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onOpen(a.id)}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-gold/[0.04]"
                data-testid="lidarr-artist-row"
                data-hearth-target={`artist:${a.id}:open`}
              >
                <Disc3 strokeWidth={1.5} className="h-5 w-5 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.88rem] text-ink">{a.name}</span>
                  <span className="block text-[0.74rem] text-faint">
                    {a.stats.albums} albums · {gb(a.stats.size)}
                    {a.monitored ? "" : " · not monitored"}
                    {a.genres.length ? ` · ${a.genres.join(", ")}` : ""}
                  </span>
                </span>
                <Progress files={a.stats.files} total={a.stats.total} />
              </button>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="px-3 py-3 text-[0.84rem] text-muted">No artists match.</li>
          )}
        </ul>
      </div>
    </Guard>
  );
}

function Progress({ files, total }: { files: number; total: number }) {
  const p = total ? Math.round((files / total) * 100) : 0;
  return (
    <span className="flex w-36 items-center gap-2 text-[0.74rem] text-muted tabular">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
        <span
          className={cx("block h-full rounded-full", p >= 100 ? "bg-ok" : "bg-gold/80")}
          style={{ width: `${p}%` }}
        />
      </span>
      {files}/{total}
    </span>
  );
}

function ArtistPage({
  serviceId,
  id,
  onBack,
  onAlbum,
}: {
  serviceId: string;
  id: number;
  onBack: () => void;
  onAlbum: (id: number) => void;
}) {
  const q = useLidarr(serviceId, "artist", { id });
  const act = usePropose(serviceId);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const { artist: a, albums, history } = q.data;
  const command = (command: string, title: string) =>
    act.propose("app-arr-command", { command, artistId: a.id }, title);
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-4" data-testid="lidarr-artist-page">
        <button type="button" className={btn} onClick={onBack} data-hearth-target="artist:back">
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> All artists
        </button>
        <div>
          <h3 className="text-[1.1rem] text-ink">{a.name}</h3>
          <p className="text-[0.8rem] text-muted">
            {[a.disambiguation, a.type, a.status === "ended" ? "Ended" : "Active", a.path]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="mt-1 text-[0.78rem] text-faint">
            {a.stats.files} of {a.stats.total} tracks on disk ({pct(a.stats)}%), {gb(a.stats.size)}
          </p>
          {a.overview && <p className="mt-1 text-[0.8rem] text-faint">{a.overview}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btnGold}
            disabled={!act.can || act.busy}
            data-hearth-target="artist:search"
            onClick={() => command("ArtistSearch", `Search for ${a.name}'s missing albums`)}
          >
            <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search missing
          </button>
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target="artist:refresh"
            onClick={() => command("RefreshArtist", `Refresh ${a.name}`)}
          >
            <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Refresh
          </button>
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target="artist:rename"
            onClick={() => command("RenameArtist", `Rename ${a.name}'s files`)}
          >
            Rename files
          </button>
        </div>
        <ProposeError error={act.error} />
        {act.dialog}
        <ArtistSettings serviceId={serviceId} a={a} data={q.data} />
        <section className="space-y-2">
          <h4 className="eyebrow">Albums</h4>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {albums.map((al) => (
              <AlbumLine key={al.id} serviceId={serviceId} al={al} onOpen={() => onAlbum(al.id)} />
            ))}
            {albums.length === 0 && (
              <li className="px-3 py-3 text-[0.84rem] text-muted">
                No albums yet. Its metadata profile decides which kinds of release are listed.
              </li>
            )}
          </ul>
        </section>
        {history.length > 0 && (
          <section className="space-y-2">
            <h4 className="eyebrow">History</h4>
            <ul className="divide-y divide-line rounded-xl border border-line text-[0.8rem]">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap gap-x-3 px-3 py-2">
                  <span className="text-ink">{EVENT_WORDS[h.event] ?? h.event}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">
                    {h.album ? `${h.album}: ` : ""}
                    {h.release}
                  </span>
                  <span className="text-faint">{when(h.date)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <RemoveArtist serviceId={serviceId} a={a} />
      </div>
    </Guard>
  );
}

function ArtistSettings({
  serviceId,
  a,
  data,
}: {
  serviceId: string;
  a: ArtistRow;
  data: {
    profiles: { id: number; name: string }[];
    metadataProfiles: { id: number; name: string }[];
    tags: { id: number; label: string }[];
  };
}) {
  const act = usePropose(serviceId);
  const [v, setV] = useState({
    monitored: a.monitored,
    qualityProfileId: a.profileId,
    metadataProfileId: a.metadataProfileId,
    monitorNewItems: a.monitorNewItems,
    tags: a.tags,
  });
  const changes: Record<string, unknown> = {};
  if (v.monitored !== a.monitored) changes.monitored = v.monitored;
  if (v.qualityProfileId !== a.profileId) changes.qualityProfileId = v.qualityProfileId;
  if (v.metadataProfileId !== a.metadataProfileId) changes.metadataProfileId = v.metadataProfileId;
  if (v.monitorNewItems !== a.monitorNewItems) changes.monitorNewItems = v.monitorNewItems;
  if (v.tags.length !== a.tags.length || v.tags.some((t) => !a.tags.includes(t)))
    changes.tags = v.tags;
  return (
    <details className="rounded-xl border border-line p-3" data-hearth-target="artist:settings">
      <summary className="cursor-pointer text-[0.86rem] text-ink">Settings</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Check
          checked={v.monitored}
          onChange={(m) => setV((s) => ({ ...s, monitored: m }))}
          label="Monitored"
          target="artist:monitored"
        />
        <Field label="Quality profile" htmlFor={`a-q-${a.id}`}>
          <select
            id={`a-q-${a.id}`}
            value={v.qualityProfileId ?? ""}
            onChange={(e) => setV((s) => ({ ...s, qualityProfileId: Number(e.target.value) }))}
            className={input}
            data-hearth-target="artist:profile"
          >
            {data.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Metadata profile"
          hint="Which kinds of release Lidarr lists."
          htmlFor={`a-m-${a.id}`}
        >
          <select
            id={`a-m-${a.id}`}
            value={v.metadataProfileId ?? ""}
            onChange={(e) => setV((s) => ({ ...s, metadataProfileId: Number(e.target.value) }))}
            className={input}
            data-hearth-target="artist:metadata"
          >
            {data.metadataProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New albums" htmlFor={`a-n-${a.id}`}>
          <select
            id={`a-n-${a.id}`}
            value={v.monitorNewItems}
            onChange={(e) => setV((s) => ({ ...s, monitorNewItems: e.target.value }))}
            className={input}
            data-hearth-target="artist:new"
          >
            {NEW_ITEMS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {data.tags.length > 0 && (
          <Field label="Tags">
            <div className="flex flex-wrap gap-x-3">
              {data.tags.map((t) => (
                <Check
                  key={t.id}
                  checked={v.tags.includes(t.id)}
                  onChange={(on) =>
                    setV((s) => ({
                      ...s,
                      tags: on ? [...s.tags, t.id] : s.tags.filter((x) => x !== t.id),
                    }))
                  }
                  label={t.label}
                />
              ))}
            </div>
          </Field>
        )}
      </div>
      <button
        type="button"
        className={`${btnGold} mt-3`}
        disabled={!Object.keys(changes).length || !act.can || act.busy}
        data-hearth-target="artist:save"
        onClick={() =>
          act.propose(
            "app-arr-edit",
            { resource: "artist", id: a.id, changes: JSON.stringify(changes) },
            `Change ${a.name} in Lidarr`,
          )
        }
      >
        Review change
      </button>
      <ProposeError error={act.error} />
      {act.dialog}
    </details>
  );
}

function AlbumLine({
  serviceId,
  al,
  onOpen,
}: {
  serviceId: string;
  al: AlbumRow;
  onOpen: () => void;
}) {
  const act = usePropose(serviceId);
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
      data-testid="lidarr-album"
      data-hearth-target={`album:${al.id}`}
    >
      <input
        type="checkbox"
        checked={al.monitored}
        disabled={!act.can || act.busy}
        aria-label={`Monitor ${al.title}`}
        onChange={() =>
          act.propose(
            "app-arr-edit",
            { resource: "album", id: al.id, changes: JSON.stringify({ monitored: !al.monitored }) },
            `${al.monitored ? "Stop monitoring" : "Monitor"} ${al.title}`,
          )
        }
        className="h-4 w-4 accent-[var(--color-gold)]"
        data-hearth-target={`album:${al.id}:monitor`}
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
        data-hearth-target={`album:${al.id}:open`}
      >
        <span className="block truncate text-[0.86rem] text-ink hover:text-gold">{al.title}</span>
        <span className="block text-[0.74rem] text-faint">
          {[al.released ? al.released.slice(0, 4) : undefined, al.type, ...al.secondaryTypes]
            .filter(Boolean)
            .join(" · ")}
          {al.monitored ? "" : " · not monitored"}
        </span>
      </button>
      <Progress files={al.stats.files} total={al.stats.total} />
      <button
        type="button"
        className={btn}
        disabled={!act.can || act.busy}
        data-hearth-target={`album:${al.id}:search`}
        onClick={() =>
          act.propose(
            "app-arr-command",
            { command: "AlbumSearch", albumIds: String(al.id) },
            `Search for ${al.title}`,
          )
        }
      >
        <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
      </button>
      <ProposeError error={act.error} />
      {act.dialog}
    </li>
  );
}

function AlbumPage({
  serviceId,
  id,
  onArtist,
}: {
  serviceId: string;
  id: number;
  onArtist: (artistId?: number) => void;
}) {
  const q = useLidarr(serviceId, "album", { id });
  const act = usePropose(serviceId);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const { album: al, tracks } = q.data;
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-4" data-testid="lidarr-album-page">
        <button
          type="button"
          className={btn}
          onClick={() => onArtist(al.artistId)}
          data-hearth-target="album:back"
        >
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> {al.artist ?? "The artist"}
        </button>
        <div>
          <h3 className="text-[1.05rem] text-ink">{al.title}</h3>
          <p className="text-[0.8rem] text-muted">
            {[al.artist, day(al.released), al.type].filter(Boolean).join(" · ")} · {al.stats.files}{" "}
            of {al.stats.total} tracks on disk
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btnGold}
            disabled={!act.can || act.busy}
            data-hearth-target="album:search"
            onClick={() =>
              act.propose(
                "app-arr-command",
                { command: "AlbumSearch", albumIds: String(al.id) },
                `Search for ${al.title}`,
              )
            }
          >
            <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
          </button>
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target="album:monitor"
            onClick={() =>
              act.propose(
                "app-arr-edit",
                {
                  resource: "album",
                  id: al.id,
                  changes: JSON.stringify({ monitored: !al.monitored }),
                },
                `${al.monitored ? "Stop monitoring" : "Monitor"} ${al.title}`,
              )
            }
          >
            {al.monitored ? "Stop monitoring" : "Monitor"}
          </button>
        </div>
        <ProposeError error={act.error} />
        {act.dialog}
        <ol className="divide-y divide-line rounded-xl border border-line text-[0.84rem]">
          {tracks.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-x-3 px-3 py-2"
              data-testid="lidarr-track"
            >
              <span className="w-8 shrink-0 text-faint tabular">{t.number}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{t.title}</span>
              <span className="text-[0.76rem] text-faint tabular">{minutes(t.duration)}</span>
              <span className={cx("text-[0.76rem]", t.hasFile ? "text-ok" : "text-muted")}>
                {t.hasFile
                  ? `${t.quality ?? "On disk"}${t.size ? ` · ${gb(t.size)}` : ""}`
                  : "Missing"}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </Guard>
  );
}

function RemoveArtist({ serviceId, a }: { serviceId: string; a: ArtistRow }) {
  const act = usePropose(serviceId);
  const [files, setFiles] = useState(false);
  const [exclude, setExclude] = useState(false);
  return (
    <details className="rounded-xl border border-alert/30 p-3" data-hearth-target="artist:remove">
      <summary className="cursor-pointer text-[0.84rem] text-alert">Remove from Lidarr</summary>
      <div className="mt-3 space-y-2">
        <Check
          checked={files}
          onChange={setFiles}
          label={`Also delete its files (${gb(a.stats.size)})`}
          target="artist:remove:files"
        />
        <Check
          checked={exclude}
          onChange={setExclude}
          label="Stop import lists adding it again"
          target="artist:remove:exclude"
        />
        <button
          type="button"
          className={btnBad}
          disabled={!act.can || act.busy}
          data-hearth-target="artist:remove:review"
          onClick={() =>
            act.propose(
              "app-arr-delete",
              { resource: "artist", id: a.id, deleteFiles: files, addImportExclusion: exclude },
              `Remove ${a.name} from Lidarr`,
            )
          }
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Review removal
        </button>
        <ProposeError error={act.error} />
        {act.dialog}
      </div>
    </details>
  );
}

function AddArtist({ serviceId, onBack }: { serviceId: string; onBack: () => void }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<string>();
  const q = useLidarr(serviceId, "lookup", { title: term }, term.length > 0);
  const lib = useLidarr(serviceId, "library");
  const act = usePropose(serviceId);
  const [form, setForm] = useState({
    root: "",
    quality: 0,
    metadata: 0,
    monitor: "all",
    newItems: "all",
    search: false,
  });
  const choice = q.data?.results.find((r) => r.key === picked);
  const roots = lib.data?.rootFolders ?? [];
  const root = form.root || roots[0]?.path || "";
  const quality = form.quality || lib.data?.profiles[0]?.id || 0;
  const metadata = form.metadata || lib.data?.metadataProfiles[0]?.id || 0;
  return (
    <div className="space-y-3" data-testid="lidarr-add">
      <button type="button" className={btn} onClick={onBack} data-hearth-target="add:back">
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> All artists
      </button>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(text.trim());
          setPicked(undefined);
        }}
      >
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Find an artist on Lidarr's music database"
          aria-label="Find an artist"
          className={`${input} flex-1`}
          data-hearth-target="add:search"
        />
        <button type="submit" className={btn} disabled={!text.trim()} data-hearth-target="add:find">
          <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Find
        </button>
      </form>
      {q.isFetching && <Loading />}
      {q.isError && <LoadError error={q.error} />}
      {q.data && term && !choice && (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {q.data.results.length === 0 && (
            <li className="px-3 py-2 text-[0.84rem] text-muted">Nothing found.</li>
          )}
          {q.data.results.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                disabled={r.inLibrary}
                onClick={() => setPicked(r.key)}
                className="flex w-full flex-wrap items-center gap-x-3 px-3 py-2.5 text-left hover:bg-gold/[0.04] disabled:opacity-60"
                data-testid="lidarr-lookup"
                data-hearth-target={`add:pick:${r.key}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.86rem] text-ink">{r.name}</span>
                  <span className="block text-[0.74rem] text-faint">
                    {[r.disambiguation, r.type, ...r.genres].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {r.inLibrary && (
                  <span className="text-[0.76rem] text-faint">Already in Lidarr</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {choice && lib.data && (
        <div className="space-y-3 rounded-xl border border-line p-3" data-testid="lidarr-add-form">
          <p className="text-[0.9rem] text-ink">{choice.name}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Root folder" htmlFor="la-root">
              <select
                id="la-root"
                value={root}
                onChange={(e) => setForm((f) => ({ ...f, root: e.target.value }))}
                className={input}
                data-hearth-target="add:root"
              >
                {roots.map((r) => (
                  <option key={r.id} value={r.path}>
                    {r.path}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Quality profile" htmlFor="la-q">
              <select
                id="la-q"
                value={quality}
                onChange={(e) => setForm((f) => ({ ...f, quality: Number(e.target.value) }))}
                className={input}
                data-hearth-target="add:profile"
              >
                {lib.data.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Metadata profile" htmlFor="la-m">
              <select
                id="la-m"
                value={metadata}
                onChange={(e) => setForm((f) => ({ ...f, metadata: Number(e.target.value) }))}
                className={input}
                data-hearth-target="add:metadata"
              >
                {lib.data.metadataProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Monitor" htmlFor="la-mon">
              <select
                id="la-mon"
                value={form.monitor}
                onChange={(e) => setForm((f) => ({ ...f, monitor: e.target.value }))}
                className={input}
                data-hearth-target="add:monitor"
              >
                {MONITOR.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="New albums" htmlFor="la-new">
              <select
                id="la-new"
                value={form.newItems}
                onChange={(e) => setForm((f) => ({ ...f, newItems: e.target.value }))}
                className={input}
                data-hearth-target="add:new"
              >
                {NEW_ITEMS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Check
              checked={form.search}
              onChange={(v) => setForm((f) => ({ ...f, search: v }))}
              label="Search for missing albums now"
              target="add:search-now"
            />
          </div>
          <button
            type="button"
            className={btnGold}
            disabled={!act.can || act.busy || !root}
            data-hearth-target="add:review"
            onClick={() =>
              act.propose(
                "app-arr-create",
                {
                  resource: "artist",
                  body: JSON.stringify({
                    foreignArtistId: choice.key,
                    rootFolderPath: root,
                    qualityProfileId: quality,
                    metadataProfileId: metadata,
                    monitor: form.monitor,
                    monitorNewItems: form.newItems,
                    searchForMissingAlbums: form.search,
                  }),
                },
                `Add ${choice.name} to Lidarr`,
              )
            }
          >
            <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Review adding it
          </button>
          <ProposeError error={act.error} />
          {act.dialog}
        </div>
      )}
    </div>
  );
}
