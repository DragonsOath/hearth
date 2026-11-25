import { SeasonPacksSwitch } from "../../crucible/SeasonPacksSwitch";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Play, X } from "lucide-react";
import type { useApproveHere } from "../../jobs/ApproveHere";
import { Button, Skeleton, cx } from "../../ui";
import { useSeerrView, type SearchResult, type TitleView } from "./data";
import { TrailerPlayer, youtubeKey } from "./Trailer";

/** Requesting from Seerr's Discover (its search and its rows): each request is a plan you approve. */

export const REQUESTABLE = new Set(["not requested", "partly available", "deleted"]);
export function Seasons({
  serviceId,
  r,
  act,
  save = {},
}: {
  serviceId: string;
  r: SearchResult;
  act: ReturnType<typeof useApproveHere>;
  /** Where it is saved (SaveTo). */
  save?: SaveChoice;
}) {
  const q = useSeerrView<TitleView>(serviceId, "title", { type: "tv", id: r.tmdbId });
  const [picked, setPicked] = useState<number[] | undefined>();
  const [packFrom, setPackFrom] = useState<string>();
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (!q.data) return <p className="text-[0.8rem] text-amber">Could not read its seasons.</p>;
  const free = q.data.seasons.filter((s) => s.status === "not requested").map((s) => s.number);
  const chosen = picked ?? free;
  if (!free.length)
    return <p className="text-[0.8rem] text-muted">Every season is in the library or requested.</p>;
  return (
    <div className="mt-2 space-y-2" data-testid="seerr-seasons">
      <SeasonPacksSwitch once={{ sonarrId: packFrom, set: setPackFrom }} />
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {q.data.seasons.map((s) => {
          const open = s.status === "not requested";
          return (
            <label
              key={s.number}
              className={cx(
                "inline-flex min-h-9 items-center gap-2 text-[0.8rem]",
                open ? "text-ink" : "text-faint",
              )}
            >
              <input
                type="checkbox"
                disabled={!open}
                checked={open ? chosen.includes(s.number) : true}
                onChange={(e) =>
                  setPicked(
                    e.target.checked
                      ? [...chosen, s.number].sort((a, b) => a - b)
                      : chosen.filter((n) => n !== s.number),
                  )
                }
                data-hearth-target={`discover:${r.tmdbId}:season:${s.number}`}
              />
              {s.name}
              {!open && <span className="text-[0.72rem]">({s.status})</span>}
            </label>
          );
        })}
      </div>
      <Button
        tone="primary"
        disabled={act.busy || !chosen.length}
        data-hearth-target={`discover:${r.tmdbId}:request-seasons`}
        onClick={() => {
          const seasons = chosen.length === free.length ? undefined : chosen.join(",");
          void act.proposeMany(
            [
              {
                kind: "app-seerr-request",
                params: {
                  mediaType: "tv",
                  tmdbId: r.tmdbId,
                  ...(seasons ? { seasons } : {}),
                  ...saveParams(save),
                },
              },
              ...packSteps(
                { seasonPackFrom: packFrom },
                { mediaType: "tv", tmdbId: r.tmdbId, title: r.title, seasons: chosen.join(",") },
              ),
            ],
            `Request ${r.title}`,
          );
        }}
      >
        Request{" "}
        {chosen.length === free.length
          ? "all open seasons"
          : `${chosen.length} season${chosen.length === 1 ? "" : "s"}`}
      </Button>
    </div>
  );
}

/** Seerr's Radarr or Sonarr servers, with their root folders and quality profiles. */
interface ServersView {
  app: "radarr" | "sonarr";
  servers: {
    id: number;
    name: string;
    isDefault: boolean;
    defaultFolder?: string;
    defaultProfile?: number;
    folders: { path: string; freeBytes?: number }[];
    profiles: { id: number; name: string }[];
    note?: string;
  }[];
}

/** Where a request goes, as the plan's params (empty: Seerr's defaults). */
export type SaveChoice = {
  serverId?: number;
  rootFolder?: string;
  profileId?: number;
  /** Shows: a season pack for this request only, from this Sonarr. */
  seasonPackFrom?: string;
};

/** The season pack step that follows a show's request, when it was asked for. */
export function packSteps(
  where: SaveChoice | undefined,
  m: { mediaType?: unknown; tmdbId?: unknown; title: string; seasons?: string },
) {
  if (!where?.seasonPackFrom || m.mediaType !== "tv" || !m.tmdbId) return [];
  return [
    {
      kind: "app-sonarr-season-pack" as const,
      serviceId: where.seasonPackFrom,
      params: {
        tmdbId: Number(m.tmdbId),
        title: m.title,
        ...(m.seasons ? { seasons: m.seasons } : {}),
      },
    },
  ];
}

const tb = (b?: number) =>
  b === undefined
    ? ""
    : ` (${b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : `${Math.round(b / 1e9)} GB`})`;

/**
 * Quality profile and root folder, as Seerr's own request box offers them (the owner,
 * 2026-11-02): Seerr's defaults are chosen to start with; the approved plan says what was picked.
 */
export function SaveTo({
  serviceId,
  type,
  value,
  onChange,
}: {
  serviceId: string;
  type: "movie" | "tv";
  value: SaveChoice;
  onChange: (v: SaveChoice) => void;
}) {
  const q = useSeerrView<ServersView>(serviceId, "servers", { type }, true, 5 * 60_000);
  if (q.isLoading) return <Skeleton className="h-12" />;
  const servers = q.data?.servers ?? [];
  if (!servers.length)
    return (
      <p className="text-[0.78rem] text-faint">
        {q.error ? "Could not read where Seerr saves requests: it uses its defaults." : ""}
      </p>
    );
  const server =
    servers.find((s) => s.id === value.serverId) ?? servers.find((s) => s.isDefault) ?? servers[0]!;
  const folder = value.rootFolder ?? server.defaultFolder ?? server.folders[0]?.path ?? "";
  const profile = value.profileId ?? server.defaultProfile;
  const select =
    "mt-1 min-h-10 w-full rounded-lg border border-line-strong bg-raised px-2 text-[0.84rem] text-ink";
  const pick = (patch: SaveChoice) =>
    onChange({
      serverId: server.id,
      rootFolder: folder || undefined,
      profileId: profile,
      ...patch,
    });
  return (
    <div className="grid gap-3" data-testid="seerr-save-to">
      {servers.length > 1 && (
        <label className="text-[0.78rem] text-muted">
          {type === "tv" ? "Sonarr" : "Radarr"}
          <select
            className={select}
            value={server.id}
            onChange={(e) => onChange({ serverId: Number(e.target.value) })}
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.isDefault ? " (Default)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {server.profiles.length > 0 && (
        <label className="text-[0.78rem] text-muted">
          Quality profile
          <select
            className={select}
            value={profile ?? ""}
            onChange={(e) => pick({ profileId: Number(e.target.value) })}
            data-testid="seerr-profile"
          >
            {server.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === server.defaultProfile ? " (Default)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="text-[0.78rem] text-muted">
        Root folder
        <select
          className={select}
          value={folder}
          onChange={(e) => pick({ rootFolder: e.target.value })}
          data-testid="seerr-root-folder"
        >
          {server.folders.map((f) => (
            <option key={f.path} value={f.path}>
              {f.path}
              {tb(f.freeBytes)}
              {f.path === server.defaultFolder ? " (Default)" : ""}
            </option>
          ))}
        </select>
      </label>
      {server.note && <p className="text-[0.74rem] text-faint">{server.note}</p>}
    </div>
  );
}

/** "HD-1080p, saved to /movies": what a request will use, with Change for the full choice. */
function Where({
  servers,
  loading,
  value,
  changing,
  onChange,
}: {
  servers: ServersView["servers"];
  loading: boolean;
  value: SaveChoice;
  changing: boolean;
  onChange: () => void;
}) {
  if (loading) return <Skeleton className="mt-2 h-6" />;
  const r = resolveSave(servers, value);
  const server = servers.find((s) => s.id === r.serverId);
  const profile = server?.profiles.find((p) => p.id === r.profileId)?.name;
  const said = [profile, r.rootFolder ? `saved to ${r.rootFolder}` : ""].filter(Boolean).join(", ");
  return (
    <p
      className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[0.84rem] text-muted"
      data-testid="request-ask-where"
    >
      <span>
        {said ? `${said[0]!.toUpperCase()}${said.slice(1)}.` : "Seerr's usual quality and folder."}
      </span>
      {!changing && servers.length > 0 && (
        <button
          type="button"
          onClick={onChange}
          className="min-h-9 text-[0.82rem] text-gold underline-offset-2 hover:underline"
          data-testid="request-ask-change"
        >
          Change
        </button>
      )}
    </p>
  );
}

/** Seerr's defaults filled in, so the approval says where it goes even when nothing was changed. */
function resolveSave(servers: ServersView["servers"], value: SaveChoice): SaveChoice {
  const server =
    servers.find((s) => s.id === value.serverId) ?? servers.find((s) => s.isDefault) ?? servers[0];
  if (!server) return value;
  const rootFolder = value.rootFolder ?? server.defaultFolder ?? server.folders[0]?.path;
  const profileId = value.profileId ?? server.defaultProfile;
  return {
    serverId: server.id,
    ...(rootFolder ? { rootFolder } : {}),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(value.seasonPackFrom ? { seasonPackFrom: value.seasonPackFrom } : {}),
  };
}

/** A title to request from Seerr. */
export interface AskTitle {
  serviceId: string;
  type: "movie" | "tv";
  tmdbId: number;
  title: string;
}

/** Why a title can't be requested, in words, from Seerr's status (undefined: it can be). */
function notRequestable(t: TitleView): string | undefined {
  if (REQUESTABLE.has(t.status)) return undefined;
  const name = `${t.title}${t.year ? ` (${t.year})` : ""}`;
  if (t.status === "available") return `${name} is already in your library.`;
  if (t.status === "in your library")
    return `${name} is already in your library: ${t.library?.service ?? "Radarr"} has it downloaded, though Seerr doesn't show it.`;
  if (t.status === "requested" || t.status === "processing")
    return `${name} is already requested. It's on its way.`;
  if (t.status === "blocklisted") return `${name} is blocked in Seerr, so it can't be requested.`;
  return `${name} is already known to Seerr (${t.status}), so there's nothing to request.`;
}

/**
 * Request, asked first (the owner, 11-10: "when hitting request it's still not asking for the root
 * or quality"; "if you click on request on a movie that's already inside your library have a
 * pop-up"): pick the quality and root folder, as in Seerr's own request box, then the approval.
 * A title Seerr already has says so instead. The choice is kept for the next request.
 */
export function RequestAsk({
  items,
  value,
  onChange,
  onRequest,
  onClose,
}: {
  /** One title, or several (Request all). */
  items: AskTitle[];
  value: SaveChoice;
  onChange: (v: SaveChoice) => void;
  /** Where it saves, Seerr's defaults filled in. */
  onRequest: (save: SaveChoice) => void;
  onClose: () => void;
}) {
  const first = items[0];
  const one = items.length === 1 ? first : undefined;
  // Your defaults go unless you choose otherwise (Change).
  const [changing, setChanging] = useState(false);
  // A season pack is for this request only: the box opens with it unticked.
  useEffect(() => {
    if (value.seasonPackFrom) onChange({ ...value, seasonPackFrom: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const servers = useSeerrView<ServersView>(
    first?.serviceId ?? "",
    "servers",
    { type: first?.type },
    !!first,
    5 * 60_000,
  );
  const status = useSeerrView<TitleView>(
    one?.serviceId ?? "",
    "title",
    { type: one?.type, id: one ? String(one.tmdbId) : undefined },
    !!one,
    0,
  );
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!first) return null;
  // Read fresh each time it opens: it may have arrived since the card was drawn.
  const checking = !!one && !status.isFetchedAfterMount;
  const why = one && !checking && status.data ? notRequestable(status.data) : undefined;
  const what =
    items.length === 1
      ? first.title
      : `${items.length} ${first.type === "tv" ? "shows" : "movies"}`;
  // Over an open modal (a Forge sheet), or it would sit behind it (as the approval does).
  const modals = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => {
    try {
      return d.matches(":modal");
    } catch {
      return false;
    }
  });
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-ask-title"
        className="max-h-[85vh] w-full max-w-md overflow-auto rounded-2xl border border-gold/50 bg-panel p-4 shadow-2xl"
        data-testid="request-ask"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="eyebrow text-gold">{why ? "Already there" : "Request"}</p>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-muted hover:text-ink"
          >
            <X strokeWidth={1.5} className="h-4 w-4" />
          </button>
        </div>
        {checking ? (
          <Skeleton className="mt-3 h-24" />
        ) : why ? (
          <>
            <p
              id="request-ask-title"
              className="mt-2 flex items-start gap-2 text-[0.95rem] text-ink"
              data-testid="request-ask-have"
            >
              <CheckCircle2
                strokeWidth={1.75}
                className="mt-0.5 h-4 w-4 shrink-0 text-gold"
                aria-hidden
              />
              {why}
            </p>
            <div className="mt-4 flex justify-end">
              <Button tone="primary" onClick={onClose} data-testid="request-ask-ok">
                OK
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2 id="request-ask-title" className="mt-1 text-[1.05rem] text-ink">
              Request {what}
            </h2>
            <Where
              servers={servers.data?.servers ?? []}
              loading={servers.isLoading}
              value={value}
              changing={changing}
              onChange={() => setChanging(true)}
            />
            {changing && (
              <div className="mt-3">
                <SaveTo
                  serviceId={first.serviceId}
                  type={first.type}
                  value={value}
                  onChange={onChange}
                />
              </div>
            )}
            {items.some((x) => x.type === "tv") && (
              <div className="mt-3">
                <SeasonPacksSwitch
                  once={{
                    sonarrId: value.seasonPackFrom,
                    set: (id) => onChange({ ...value, seasonPackFrom: id }),
                  }}
                />
              </div>
            )}
            <p className="mt-3 text-[0.76rem] text-faint">
              Request sends {items.length === 1 ? "it" : "them"} to Seerr now.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button
                tone="primary"
                disabled={servers.isLoading}
                onClick={() => onRequest(resolveSave(servers.data?.servers ?? [], value))}
                data-testid="request-ask-go"
              >
                {items.length === 1 ? "Request" : `Request ${items.length}`}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    modals.at(-1) ?? document.body,
  );
}

/**
 * Watch trailer (11-10; 11-19, the owner: "the trailer plays in panel"): plays the title's
 * YouTube trailer right here, shown only when Seerr has one for that exact title. Read when the
 * card shows; nothing appears while it loads or if there is none.
 */
export function TrailerLink({
  serviceId,
  type,
  tmdbId,
  title,
  primary = false,
}: {
  serviceId: string;
  type: "movie" | "tv";
  tmdbId: number;
  title: string;
  /** The big gold button (a hero or a title's details) instead of the small one on a card. */
  primary?: boolean;
}) {
  const q = useSeerrView<TitleView>(
    serviceId,
    "title",
    { type, id: String(tmdbId) },
    true,
    30 * 60_000,
  );
  const [playing, setPlaying] = useState(false);
  const key = youtubeKey(q.data?.trailer);
  if (!key) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setPlaying(true)}
        aria-label={`Watch the trailer for ${title}`}
        className={
          primary
            ? "inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-gold px-4 text-[0.86rem] font-semibold text-bg hover:bg-gold-bright"
            : "inline-flex min-h-8 items-center gap-1 rounded-md border border-line px-2 text-[0.76rem] text-muted hover:border-gold/60 hover:text-ink"
        }
        data-testid="trailer-link"
        data-trailer={key}
      >
        <Play strokeWidth={1.75} className="h-3.5 w-3.5" aria-hidden /> Watch trailer
      </button>
      {playing && <TrailerPlayer videoKey={key} title={title} onClose={() => setPlaying(false)} />}
    </>
  );
}

/** A choice as plan params (only what was picked). */
export const saveParams = (v: SaveChoice) => ({
  ...(v.serverId !== undefined ? { serverId: v.serverId } : {}),
  ...(v.rootFolder ? { rootFolder: v.rootFolder } : {}),
  ...(v.profileId !== undefined ? { profileId: v.profileId } : {}),
});
