import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, KeyRound, Plus, Trash2 } from "lucide-react";
import { cx } from "../../ui";
import { useServarr, useRadarr, type Connection, type TagsView } from "./data";
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
  gb,
  input,
  usePropose,
} from "./common";

/**
 * The rest of Radarr's Settings tab: tags with delay and release profiles, files and naming
 * (naming, media management, root folders), and connections (download clients, indexers,
 * notifications, import lists). Each save is one plan with the exact before and after.
 */

/**
 * A section a link points at (a health warning's "Open indexers"): scrolled into view and
 * outlined, so the person lands on the control that fixes it.
 */
function useFocused<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [active]);
  return ref;
}
const focusRing = "rounded-xl p-2 ring-2 ring-gold/60";

/* ---------- A small settings form: only what changed is proposed ---------- */

type FieldSpec =
  | { key: string; label: string; kind: "bool"; hint?: string }
  | { key: string; label: string; kind: "text" | "number"; hint?: string; mono?: boolean }
  | { key: string; label: string; kind: "select"; options: [string, string][]; hint?: string };

function SettingsForm({
  serviceId,
  resource,
  id,
  values,
  fields,
  title,
  target,
}: {
  serviceId: string;
  resource: string;
  id?: number;
  values: Record<string, unknown>;
  fields: FieldSpec[];
  title: string;
  target: string;
}) {
  const act = usePropose(serviceId);
  const shown = fields.filter((f) => f.key in values);
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(shown.map((f) => [f.key, values[f.key]])),
  );
  const changes = Object.fromEntries(
    shown.filter((f) => draft[f.key] !== values[f.key]).map((f) => [f.key, draft[f.key]]),
  );
  const dirty = Object.keys(changes).length > 0;
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  return (
    <div className="space-y-3" data-hearth-target={target}>
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map((f) =>
          f.kind === "bool" ? (
            <div key={f.key} className="sm:col-span-2">
              <Check
                checked={draft[f.key] === true}
                onChange={(v) => set(f.key, v)}
                target={`${target}:${f.key}`}
                label={
                  <span>
                    {f.label}
                    {f.hint && <span className="text-faint"> ({f.hint})</span>}
                  </span>
                }
              />
            </div>
          ) : (
            <Field key={f.key} label={f.label} hint={f.hint} htmlFor={`${target}-${f.key}`}>
              {f.kind === "select" ? (
                <select
                  id={`${target}-${f.key}`}
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={input}
                  data-hearth-target={`${target}:${f.key}`}
                >
                  {f.options.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${target}-${f.key}`}
                  type={f.kind === "number" ? "number" : "text"}
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) =>
                    set(f.key, f.kind === "number" ? Number(e.target.value) : e.target.value)
                  }
                  className={cx(input, f.kind === "text" && f.mono && "font-mono text-[0.8rem]")}
                  data-hearth-target={`${target}:${f.key}`}
                />
              )}
            </Field>
          ),
        )}
      </div>
      <button
        type="button"
        className={btnGold}
        disabled={!dirty || !act.can || act.busy}
        data-hearth-target={`${target}:save`}
        onClick={() =>
          act.propose(
            "app-arr-edit",
            { resource, ...(id !== undefined ? { id } : {}), changes: JSON.stringify(changes) },
            title,
          )
        }
      >
        Review change
      </button>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

const lines = (v: string) =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/* ---------- Tags, delay profiles, release profiles ---------- */

export function TagsSettings({ serviceId }: { serviceId: string }) {
  const w = useServarr();
  const q = useRadarr(serviceId, "tags");
  const act = usePropose(serviceId);
  const [label, setLabel] = useState("");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const d = q.data;
  const tagName = (id: number) => d.tags.find((t) => t.id === id)?.label ?? `#${id}`;
  return (
    <Guard meta={d.meta} sample={d.sample}>
      <div className="space-y-5" data-testid="radarr-tags">
        <section className="space-y-2">
          <h4 className="eyebrow">Tags</h4>
          <p className="text-[0.8rem] text-muted">
            Tags tie {w.items} to delay profiles, release profiles, indexers, download clients and
            notifications.
          </p>
          <ul className="flex flex-wrap gap-2">
            {d.tags.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 rounded-full border border-line py-0.5 pr-1 pl-3 text-[0.8rem]"
              >
                <span className="text-ink">{t.label}</span>
                <span className="text-faint">
                  {t.used} {w.items}
                  {t.other ? `, ${t.other} other` : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Remove the tag ${t.label}`}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-faint hover:text-alert disabled:opacity-40"
                  disabled={!act.can || act.busy || t.used + t.other > 0}
                  title={
                    t.used + t.other > 0 ? "In use: remove it from what uses it first" : undefined
                  }
                  data-hearth-target={`tag:${t.id}:remove`}
                  onClick={() =>
                    act.propose(
                      "app-arr-delete",
                      { resource: "tag", id: t.id },
                      `Remove the tag "${t.label}" from ${w.name}`,
                    )
                  }
                >
                  <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.propose(
                "app-arr-create",
                { resource: "tag", body: JSON.stringify({ label: label.trim().toLowerCase() }) },
                `Add the tag "${label.trim().toLowerCase()}" to ${w.name}`,
              );
              setLabel("");
            }}
          >
            <label className="sr-only" htmlFor={`newtag-${serviceId}`}>
              New tag
            </label>
            <input
              id={`newtag-${serviceId}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="New tag"
              className={cx(input, "max-w-xs")}
              data-hearth-target="tag:new"
            />
            <button type="submit" className={btn} disabled={!label.trim() || !act.can}>
              <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add
            </button>
          </form>
          <ProposeError error={act.error} />
          {act.dialog}
        </section>

        <section className="space-y-2">
          <h4 className="eyebrow">Delay profiles</h4>
          <p className="text-[0.8rem] text-muted">
            How long {w.name} waits for a better release before grabbing, per download type.
          </p>
          {d.delayProfiles.map((p) => (
            <details key={p.id} className="rounded-xl border border-line p-3">
              <summary
                className="flex cursor-pointer items-center gap-2 text-[0.84rem] text-ink"
                data-hearth-target={`delay:${p.id}:open`}
              >
                <ChevronDown strokeWidth={1.5} className="h-3.5 w-3.5 text-faint" />
                {p.isDefault
                  ? "Default"
                  : `For tags: ${p.tags.map(tagName).join(", ") || "none"}`}{" "}
                · prefers {p.preferredProtocol} · usenet {p.usenetDelay} min, torrents{" "}
                {p.torrentDelay} min
              </summary>
              <div className="mt-3">
                <SettingsForm
                  serviceId={serviceId}
                  resource="delayprofile"
                  id={p.id}
                  target={`delay:${p.id}`}
                  title={`Change a delay profile in ${w.name}`}
                  values={{
                    preferredProtocol: p.preferredProtocol,
                    enableUsenet: p.usenet,
                    enableTorrent: p.torrent,
                    usenetDelay: p.usenetDelay,
                    torrentDelay: p.torrentDelay,
                    bypassIfHighestQuality: p.bypassIfHighestQuality,
                  }}
                  fields={[
                    {
                      key: "preferredProtocol",
                      label: "Prefer",
                      kind: "select",
                      options: [
                        ["usenet", "Usenet"],
                        ["torrent", "Torrents"],
                      ],
                    },
                    { key: "enableUsenet", label: "Use Usenet", kind: "bool" },
                    { key: "enableTorrent", label: "Use torrents", kind: "bool" },
                    { key: "usenetDelay", label: "Usenet delay (minutes)", kind: "number" },
                    { key: "torrentDelay", label: "Torrent delay (minutes)", kind: "number" },
                    {
                      key: "bypassIfHighestQuality",
                      label: "Skip the wait for the best allowed quality",
                      kind: "bool",
                    },
                  ]}
                />
              </div>
            </details>
          ))}
        </section>

        <ReleaseProfiles serviceId={serviceId} d={d} tagName={tagName} />
      </div>
    </Guard>
  );
}

function ReleaseProfiles({
  serviceId,
  d,
  tagName,
}: {
  serviceId: string;
  d: TagsView;
  tagName: (id: number) => string;
}) {
  const w = useServarr();
  const act = usePropose(serviceId);
  const [name, setName] = useState("");
  return (
    <section className="space-y-2">
      <h4 className="eyebrow">Release profiles</h4>
      <p className="text-[0.8rem] text-muted">Words a release must contain, or must not.</p>
      {d.releaseProfiles.map((r) => (
        <details key={r.id} className="rounded-xl border border-line p-3">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[0.84rem] text-ink">
            <ChevronDown strokeWidth={1.5} className="h-3.5 w-3.5 text-faint" />
            {r.name || `Release profile ${r.id}`}
            {!r.enabled && <span className="text-faint">(off)</span>}
            <span className="text-faint">
              {r.required.length ? `must have ${r.required.join(", ")}` : ""}
              {r.ignored.length ? ` must not have ${r.ignored.join(", ")}` : ""}
              {r.tags.length ? ` · tags ${r.tags.map(tagName).join(", ")}` : ""}
            </span>
          </summary>
          <div className="mt-3 space-y-3">
            <ReleaseProfileForm serviceId={serviceId} r={r} />
            <button
              type="button"
              className={btnBad}
              disabled={!act.can || act.busy}
              onClick={() =>
                act.propose(
                  "app-arr-delete",
                  { resource: "releaseprofile", id: r.id },
                  `Remove the release profile "${r.name || r.id}" from ${w.name}`,
                )
              }
            >
              <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
            </button>
          </div>
        </details>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          act.propose(
            "app-arr-create",
            {
              resource: "releaseprofile",
              body: JSON.stringify({
                name: name.trim(),
                enabled: true,
                required: [],
                ignored: [],
                indexerId: 0,
                tags: [],
              }),
            },
            `Add the release profile "${name.trim()}" to ${w.name}`,
          );
          setName("");
        }}
      >
        <label className="sr-only" htmlFor={`newrp-${serviceId}`}>
          New release profile
        </label>
        <input
          id={`newrp-${serviceId}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New release profile"
          className={cx(input, "max-w-xs")}
        />
        <button type="submit" className={btn} disabled={!name.trim() || !act.can}>
          <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add
        </button>
      </form>
      <ProposeError error={act.error} />
      {act.dialog}
    </section>
  );
}

function ReleaseProfileForm({
  serviceId,
  r,
}: {
  serviceId: string;
  r: { id: number; name: string; enabled: boolean; required: string[]; ignored: string[] };
}) {
  const w = useServarr();
  const act = usePropose(serviceId);
  const [enabled, setEnabled] = useState(r.enabled);
  const [required, setRequired] = useState(r.required.join("\n"));
  const [ignored, setIgnored] = useState(r.ignored.join("\n"));
  const changes: Record<string, unknown> = {};
  if (enabled !== r.enabled) changes.enabled = enabled;
  if (lines(required).join("\n") !== r.required.join("\n")) changes.required = lines(required);
  if (lines(ignored).join("\n") !== r.ignored.join("\n")) changes.ignored = lines(ignored);
  return (
    <div className="space-y-2">
      <Check checked={enabled} onChange={setEnabled} label="On" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Must contain (one per line)" htmlFor={`req-${r.id}`}>
          <textarea
            id={`req-${r.id}`}
            value={required}
            onChange={(e) => setRequired(e.target.value)}
            rows={3}
            className={cx(input, "py-2")}
          />
        </Field>
        <Field label="Must not contain (one per line)" htmlFor={`ign-${r.id}`}>
          <textarea
            id={`ign-${r.id}`}
            value={ignored}
            onChange={(e) => setIgnored(e.target.value)}
            rows={3}
            className={cx(input, "py-2")}
          />
        </Field>
      </div>
      <button
        type="button"
        className={btnGold}
        disabled={Object.keys(changes).length === 0 || !act.can || act.busy}
        onClick={() =>
          act.propose(
            "app-arr-edit",
            { resource: "releaseprofile", id: r.id, changes: JSON.stringify(changes) },
            `Change the release profile "${r.name || r.id}" in ${w.name}`,
          )
        }
      >
        Review change
      </button>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

/* ---------- Files and naming ---------- */

/** Radarr's and Sonarr's naming and media settings; the form shows the ones the app has. */
const NAMING: FieldSpec[] = [
  {
    key: "renameEpisodes",
    label: "Rename episodes",
    kind: "bool",
    hint: "files get names from the formats below",
  },
  {
    key: "renameMovies",
    label: "Rename movies",
    kind: "bool",
    hint: "files get names from the formats below",
  },
  {
    key: "replaceIllegalCharacters",
    label: "Replace characters not allowed in file names",
    kind: "bool",
  },
  {
    key: "colonReplacementFormat",
    label: "Colons become",
    kind: "select",
    options: [
      ["delete", "Nothing (deleted)"],
      ["dash", "A dash"],
      ["spaceDash", "Space and dash"],
      ["spaceDashSpace", "Space, dash, space"],
      ["smart", "Smart (dash or space dash)"],
    ],
  },
  {
    key: "standardMovieFormat",
    label: "File name format",
    kind: "text",
    mono: true,
    hint: "for example {Movie Title} ({Release Year}) {Quality Full}",
  },
  { key: "movieFolderFormat", label: "Folder name format", kind: "text", mono: true },
  {
    key: "standardEpisodeFormat",
    label: "Episode file name format",
    kind: "text",
    mono: true,
    hint: "for example {Series Title} - S{season:00}E{episode:00} - {Episode Title}",
  },
  { key: "dailyEpisodeFormat", label: "Daily show file name format", kind: "text", mono: true },
  { key: "animeEpisodeFormat", label: "Anime file name format", kind: "text", mono: true },
  { key: "seriesFolderFormat", label: "Series folder format", kind: "text", mono: true },
  { key: "seasonFolderFormat", label: "Season folder format", kind: "text", mono: true },
  { key: "renameTracks", label: "Rename tracks", kind: "bool" },
  {
    key: "standardTrackFormat",
    label: "Track file name format",
    kind: "text",
    mono: true,
    hint: "for example {Album Title} ({Release Year})/{track:00} - {Track Title}",
  },
  {
    key: "multiDiscTrackFormat",
    label: "Multi-disc track file name format",
    kind: "text",
    mono: true,
  },
  { key: "artistFolderFormat", label: "Artist folder format", kind: "text", mono: true },
];

const MEDIA: FieldSpec[] = [
  {
    key: "autoUnmonitorPreviouslyDownloadedMovies",
    label: "Stop monitoring a movie whose file was deleted",
    kind: "bool",
  },
  {
    key: "autoUnmonitorPreviouslyDownloadedEpisodes",
    label: "Stop monitoring an episode whose file was deleted",
    kind: "bool",
  },
  {
    key: "downloadPropersAndRepacks",
    label: "Propers and repacks",
    kind: "select",
    options: [
      ["preferAndUpgrade", "Prefer and upgrade"],
      ["doNotUpgrade", "Do not upgrade automatically"],
      ["doNotPrefer", "Do not prefer"],
    ],
  },
  {
    key: "copyUsingHardlinks",
    label: "Use hardlinks instead of copying",
    kind: "bool",
    hint: "saves space when downloads and library share a drive",
  },
  { key: "importExtraFiles", label: "Import extra files", kind: "bool" },
  {
    key: "extraFileExtensions",
    label: "Extra file types",
    kind: "text",
    hint: "comma separated, e.g. srt,nfo",
  },
  { key: "deleteEmptyFolders", label: "Delete empty folders", kind: "bool" },
  {
    key: "createEmptyMovieFolders",
    label: "Create a folder for a movie before it downloads",
    kind: "bool",
  },
  {
    key: "createEmptySeriesFolders",
    label: "Create a folder for a series before it downloads",
    kind: "bool",
  },
  {
    key: "createEmptyArtistFolders",
    label: "Create a folder for an artist before it downloads",
    kind: "bool",
  },
  {
    key: "autoUnmonitorPreviouslyDownloadedTracks",
    label: "Stop monitoring tracks deleted from disk",
    kind: "bool",
  },
  {
    key: "recycleBin",
    label: "Recycle bin folder",
    kind: "text",
    hint: "deleted files go here; empty deletes for good",
  },
  { key: "recycleBinCleanupDays", label: "Empty the recycle bin after (days)", kind: "number" },
  {
    key: "minimumFreeSpaceWhenImporting",
    label: "Keep this much free when importing (MB)",
    kind: "number",
  },
  { key: "skipFreeSpaceCheckWhenImporting", label: "Skip the free space check", kind: "bool" },
  {
    key: "rescanAfterRefresh",
    label: "Rescan the folder after a refresh",
    kind: "select",
    options: [
      ["always", "Always"],
      ["afterManual", "After a refresh you start"],
      ["never", "Never"],
    ],
  },
  {
    key: "fileDate",
    label: "File date",
    kind: "select",
    options: [
      ["none", "Leave as is"],
      ["cinemas", "Cinema release date"],
      ["release", "Physical release date"],
    ],
  },
];

export function MediaSettings({ serviceId, focus }: { serviceId: string; focus?: string }) {
  const w = useServarr();
  const q = useRadarr(serviceId, "media");
  const act = usePropose(serviceId);
  const [path, setPath] = useState("");
  const roots = useFocused<HTMLElement>(focus === "rootfolders" && q.isSuccess);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const d = q.data;
  return (
    <Guard meta={d.meta} sample={d.sample}>
      <div className="space-y-5" data-testid="radarr-media">
        <section className="space-y-2">
          <h4 className="eyebrow">Naming</h4>
          <SettingsForm
            serviceId={serviceId}
            resource="naming"
            values={d.naming}
            fields={NAMING}
            title={`Change ${w.name}'s naming settings`}
            target="naming"
          />
          <p className="text-[0.76rem] text-faint">
            New names apply to files imported from now on. To rename existing files, use Rename
            files on a {w.item}.
          </p>
        </section>
        <section className="space-y-2">
          <h4 className="eyebrow">Importing and deleting</h4>
          <SettingsForm
            serviceId={serviceId}
            resource="mediamanagement"
            values={d.media}
            fields={MEDIA}
            title={`Change ${w.name}'s media management settings`}
            target="media"
          />
        </section>
        <section
          ref={roots}
          className={cx("space-y-2", focus === "rootfolders" && focusRing)}
          data-hearth-target="media:rootfolders"
        >
          <h4 className="eyebrow">Root folders</h4>
          <ul className="divide-y divide-line rounded-xl border border-line text-[0.82rem]">
            {d.rootFolders.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="break-all text-ink">{r.path}</p>
                  <p className={cx("text-faint", !r.accessible && "text-alert")}>
                    {r.accessible
                      ? `${gb(r.freeSpace)} free`
                      : `${w.name} cannot reach this folder`}
                    {r.unmapped ? ` · ${r.unmapped} folders not in ${w.name}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  className={btnBad}
                  disabled={!act.can || act.busy}
                  data-hearth-target={`root:${r.id}:remove`}
                  onClick={() =>
                    act.propose(
                      "app-arr-delete",
                      { resource: "rootfolder", id: r.id },
                      `Remove the root folder ${r.path} from ${w.name}`,
                    )
                  }
                >
                  <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.propose(
                "app-arr-create",
                { resource: "rootfolder", body: JSON.stringify({ path: path.trim() }) },
                `Add the root folder ${path.trim()} to ${w.name}`,
              );
              setPath("");
            }}
          >
            <label className="sr-only" htmlFor={`root-${serviceId}`}>
              Folder path as {w.name} sees it
            </label>
            <input
              id={`root-${serviceId}`}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={`Folder path as ${w.name} sees it, e.g. /${w.app === "radarr" ? "movies" : "tv"}`}
              data-hearth-target="root:add"
              className={cx(input, "font-mono text-[0.8rem]")}
            />
            <button
              type="submit"
              className={btn}
              disabled={!path.trim().startsWith("/") && !/^[A-Za-z]:\\/.test(path.trim())}
            >
              <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add
            </button>
          </form>
          <p className="text-[0.76rem] text-faint">
            Removing a root folder does not delete anything on disk.
          </p>
          <ProposeError error={act.error} />
          {act.dialog}
        </section>
      </div>
    </Guard>
  );
}

/* ---------- Connections ---------- */

const SWITCH_WORDS: Record<string, string> = {
  enable: "On",
  enableRss: "Use for RSS",
  enableAutomaticSearch: "Use for automatic search",
  enableInteractiveSearch: "Use for picking a release",
  enableAuto: "Add automatically",
  enabled: "On",
  removeCompletedDownloads: "Remove completed downloads",
  removeFailedDownloads: "Remove failed downloads",
  onGrab: "When a release is grabbed",
  onDownload: "When something is imported",
  onUpgrade: "When something is upgraded",
  onRename: "When files are renamed",
  onMovieAdded: "When a movie is added",
  onMovieDelete: "When a movie is deleted",
  onMovieFileDelete: "When a file is deleted",
  onSeriesAdd: "When a series is added",
  onSeriesDelete: "When a series is deleted",
  onEpisodeFileDelete: "When an episode file is deleted",
  onHealthIssue: "When it has a health issue",
  onHealthRestored: "When a health issue is fixed",
  onApplicationUpdate: "When it updates",
  onManualInteractionRequired: "When it needs you",
  redirect: "Send downloads through Prowlarr",
  includeManualGrabs: "Include grabs made in Prowlarr",
};

export function ConnectionsSettings({ serviceId, focus }: { serviceId: string; focus?: string }) {
  const w = useServarr();
  const q = useRadarr(serviceId, "connections");
  const focused = useFocused<HTMLElement>(Boolean(focus) && q.isSuccess);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-5" data-testid="radarr-connections">
        <p className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-[0.78rem] text-muted">
          <KeyRound strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
          Passwords and API keys stay hidden and are never sent through a plan. To add a new
          connection or change its password or key, do it in {w.name} for now.
        </p>
        {q.data.groups.map((g) => (
          <section
            key={g.kind}
            ref={g.kind === focus ? focused : undefined}
            className={cx("space-y-2", g.kind === focus && focusRing)}
            data-hearth-target={`connections:${g.kind}`}
          >
            <h4 className="eyebrow">{g.label}</h4>
            {!g.readable ? (
              <p className="text-[0.82rem] text-muted">{w.name} did not list these.</p>
            ) : g.items.length === 0 ? (
              <p className="text-[0.82rem] text-muted">None.</p>
            ) : (
              g.items.map((c) => (
                <ConnectionItem key={`${c.kind}-${c.id}`} serviceId={serviceId} c={c} />
              ))
            )}
          </section>
        ))}
      </div>
    </Guard>
  );
}

/**
 * One connection with its switches, priority and ordinary settings (secrets only as set or not).
 * Other panels add their own controls (`children`) whose values join the same change (`extra`).
 */
export function ConnectionItem({
  serviceId,
  c,
  extra,
  children,
  open,
}: {
  serviceId: string;
  c: Connection;
  extra?: Record<string, unknown>;
  children?: ReactNode;
  open?: boolean;
}) {
  const w = useServarr();
  const act = usePropose(serviceId);
  const [switches, setSwitches] = useState(c.switches);
  const editable = c.fields.filter(
    (f) => !f.secret && ["textbox", "number", "checkbox", "url"].includes(f.type),
  );
  const [vals, setVals] = useState<Record<string, unknown>>(
    Object.fromEntries(editable.map((f) => [f.name, f.value])),
  );
  const [priority, setPriority] = useState(c.priority);
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(switches)) if (v !== c.switches[k]) changes[k] = v;
  if (priority !== c.priority && priority !== undefined) changes.priority = priority;
  const fieldChanges = Object.fromEntries(
    editable.filter((f) => vals[f.name] !== f.value).map((f) => [f.name, vals[f.name]]),
  );
  if (Object.keys(fieldChanges).length) changes.fields = fieldChanges;
  for (const [k, v] of Object.entries(extra ?? {})) if (v !== undefined) changes[k] = v;
  const dirty = Object.keys(changes).length > 0;
  const known = Object.keys(switches).filter((k) => SWITCH_WORDS[k]);
  return (
    <details
      className="rounded-xl border border-line p-3"
      data-hearth-target={`connection:${c.kind}:${c.id}`}
      open={open}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[0.86rem]">
        <span
          className={cx("h-2 w-2 rounded-full", c.enabled ? "bg-ok" : "bg-line-strong")}
          aria-hidden
        />
        <span className="text-ink">{c.name}</span>
        <span className="text-faint">
          {c.implementation}
          {c.protocol ? ` · ${c.protocol}` : ""}
          {c.enabled ? "" : " · off"}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid gap-x-4 sm:grid-cols-2">
          {known.map((k) => (
            <Check
              key={k}
              checked={switches[k] === true}
              onChange={(v) => setSwitches((s) => ({ ...s, [k]: v }))}
              label={SWITCH_WORDS[k]}
              target={`connection:${c.kind}:${c.id}:${k}`}
            />
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {priority !== undefined && (
            <Field label="Priority" hint="Lower is used first." htmlFor={`prio-${c.kind}-${c.id}`}>
              <input
                id={`prio-${c.kind}-${c.id}`}
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className={input}
              />
            </Field>
          )}
          {editable.map((f) =>
            f.type === "checkbox" ? (
              <Check
                key={f.name}
                checked={vals[f.name] === true}
                onChange={(v) => setVals((s) => ({ ...s, [f.name]: v }))}
                label={f.label}
              />
            ) : (
              <Field
                key={f.name}
                label={f.label}
                hint={f.help}
                htmlFor={`f-${c.kind}-${c.id}-${f.name}`}
              >
                <input
                  id={`f-${c.kind}-${c.id}-${f.name}`}
                  type={f.type === "number" ? "number" : "text"}
                  value={String(vals[f.name] ?? "")}
                  onChange={(e) =>
                    setVals((s) => ({
                      ...s,
                      [f.name]: f.type === "number" ? Number(e.target.value) : e.target.value,
                    }))
                  }
                  className={input}
                />
              </Field>
            ),
          )}
          {c.fields
            .filter((f) => f.secret)
            .map((f) => (
              <Field key={f.name} label={f.label}>
                <p
                  className="flex min-h-10 items-center gap-2 text-[0.82rem] text-muted"
                  data-testid="radarr-secret-field"
                >
                  <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5" />{" "}
                  {f.set ? "Set (hidden)" : "Not set"}
                </p>
              </Field>
            ))}
        </div>
        {children}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btnGold}
            disabled={!dirty || !act.can || act.busy}
            data-hearth-target={`connection:${c.kind}:${c.id}:save`}
            onClick={() =>
              act.propose(
                "app-arr-edit",
                { resource: c.kind, id: c.id, changes: JSON.stringify(changes) },
                `Change ${c.name} in ${w.name}`,
              )
            }
          >
            Review change
          </button>
          <button
            type="button"
            className={btnBad}
            disabled={!act.can || act.busy}
            data-hearth-target={`connection:${c.kind}:${c.id}:remove`}
            onClick={() =>
              act.propose(
                "app-arr-delete",
                { resource: c.kind, id: c.id },
                `Remove ${c.name} from ${w.name}`,
              )
            }
          >
            <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
          </button>
        </div>
        <ProposeError error={act.error} />
        {act.dialog}
      </div>
    </details>
  );
}
