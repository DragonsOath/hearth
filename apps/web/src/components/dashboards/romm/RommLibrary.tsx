import { useDeferredValue, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Heart, MessageCircle, Search } from "lucide-react";
import type { RommGameDetail, RommGamesPage } from "@dragon-control/core";
import { api } from "../../../data/api";
import type { AppViewProps } from "../../panels/registry";
import { useCave } from "../../shell/cave-context";
import { Button, Skeleton, cx } from "../../ui";
import { ChangeCard, useConfirmedChange } from "../ConfirmedChange";
import { Cover, GameCard, InRomm, rommUrl, sizeOf, useRomm } from "./parts";
import { EmberMark } from "../../ember/EmberMark";

/**
 * RomM's Library tab (checklist 46.12): every game as a cover, found by name, platform, genre or
 * favourites, in the order you pick, fifty at a time. A game opens on its own page: cover, platform,
 * year, regions, genres, who made it, its description and files, and making it a favourite (a plan
 * you confirm). Playing and downloading stay in RomM (Open in RomM).
 */

const ORDERS = [
  ["name", "Name"],
  ["added", "Recently added"],
  ["released", "Release date"],
  ["size", "Largest first"],
] as const;
type Order = (typeof ORDERS)[number][0];
const input =
  "min-h-10 w-full rounded-lg border border-line bg-panel px-3 text-[0.84rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none";
const sel =
  "min-h-10 rounded-lg border border-line bg-panel px-3 text-[0.84rem] text-ink focus:border-gold/60 focus:outline-none";

export function RommLibrary({ serviceId, name, sub: given, onSub: setGiven }: AppViewProps) {
  // In a panel the address holds where you are; anywhere else, this tab remembers it.
  const [own, setOwn] = useState<string | null>(null);
  const sub = setGiven ? given : own;
  const onSub = setGiven ?? setOwn;
  const { d } = useRomm(serviceId);
  const gameId = /^game\/(\d+)$/.exec(sub ?? "")?.[1];
  // A link from Overview picks a filter once, as it arrives.
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState(0);
  const [genre, setGenre] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [order, setOrder] = useState<Order>("name");
  const [linked, setLinked] = useState<string | null | undefined>(undefined);
  if (sub !== linked) {
    setLinked(sub);
    const plat = /^platform\/(\d+)$/.exec(sub ?? "")?.[1];
    if (plat) setPlatform(Number(plat));
    if (sub === "favorites") setFavorites(true);
    if (sub === "order/added") setOrder("added");
  }
  const needle = useDeferredValue(search.trim());
  const pages = useInfiniteQuery({
    queryKey: ["dashboard", serviceId, "romm-games", needle, platform, genre, favorites, order],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({
        ...(needle ? { search: needle } : {}),
        ...(platform ? { platform: String(platform) } : {}),
        ...(genre ? { genre } : {}),
        ...(favorites ? { favorites: "1" } : {}),
        order,
        offset: String(pageParam),
      });
      return api<RommGamesPage>("GET", rommUrl(serviceId, `/games?${p.toString()}`));
    },
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, pg) => n + pg.items.length, 0);
      return last.items.length && loaded < last.total ? loaded : undefined;
    },
    retry: false,
  });
  if (gameId)
    return (
      <GamePage serviceId={serviceId} id={Number(gameId)} onBack={() => onSub(null)} name={name} />
    );
  const items = pages.data?.pages.flatMap((p) => p.items) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;
  const genres = pages.data?.pages[0]?.genres ?? [];
  return (
    <section
      className="@container space-y-3"
      data-testid="romm-library"
      aria-label={`${name}: library`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">Find a game by name</span>
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a game by name"
            className={cx(input, "pl-9")}
            data-hearth-target="library:search"
          />
        </label>
        <select
          value={platform}
          onChange={(e) => setPlatform(Number(e.target.value))}
          className={sel}
          aria-label="Platform"
          data-hearth-target="library:platform"
        >
          <option value={0}>Every platform</option>
          {(d?.platforms ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.games})
            </option>
          ))}
        </select>
        {genres.length > 0 && (
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            className={sel}
            aria-label="Genre"
          >
            <option value="">Every genre</option>
            {genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
        <select
          value={order}
          onChange={(e) => setOrder(e.target.value as Order)}
          className={sel}
          aria-label="Order"
        >
          {ORDERS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={favorites}
          onClick={() => setFavorites((v) => !v)}
          className={cx(
            "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-[0.8rem]",
            favorites
              ? "border-gold bg-gold/10 text-gold"
              : "border-line text-muted hover:border-gold/60",
          )}
          data-testid="romm-favorites-only"
        >
          <Heart strokeWidth={1.5} className={cx("h-4 w-4", favorites && "fill-gold")} /> Favourites
        </button>
      </div>
      <p className="text-[0.76rem] text-faint" data-testid="romm-count">
        {pages.data ? `${total} game${total === 1 ? "" : "s"}` : ""}
      </p>
      {pages.isLoading ? (
        <Skeleton className="h-64" />
      ) : pages.error ? (
        <p className="text-[0.86rem] text-amber">
          The library could not be read: {pages.error.message}
        </p>
      ) : items.length ? (
        <div className="grid grid-cols-3 gap-3 @md:grid-cols-5 @2xl:grid-cols-7">
          {items.map((g) => (
            <GameCard
              key={g.id}
              serviceId={serviceId}
              game={g}
              onOpen={() => onSub(`game/${g.id}`)}
            />
          ))}
        </div>
      ) : (
        <p className="text-[0.86rem] text-muted">
          {needle || platform || genre || favorites ? "No game matches." : "No games yet."}
        </p>
      )}
      {pages.hasNextPage && (
        <Button
          tone="outline"
          onClick={() => void pages.fetchNextPage()}
          disabled={pages.isFetchingNextPage}
        >
          {pages.isFetchingNextPage ? "Loading…" : `Show more (${total - items.length} more)`}
        </Button>
      )}
    </section>
  );
}

function GamePage({
  serviceId,
  id,
  name,
  onBack,
}: {
  serviceId: string;
  id: number;
  name: string;
  onBack: () => void;
}) {
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "romm-game", id],
    queryFn: () => api<RommGameDetail>("GET", rommUrl(serviceId, `/games/${id}`)),
    retry: false,
  });
  const fav = useConfirmedChange(serviceId);
  const cave = useCave();
  const g = q.data;
  return (
    <section
      className="@container space-y-4"
      data-testid="romm-game-page"
      aria-label={g ? g.name : "A game"}
    >
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-9 items-center gap-1.5 text-[0.82rem] text-muted hover:text-gold"
      >
        <ArrowLeft strokeWidth={1.5} className="h-4 w-4" /> Library
      </button>
      {q.isLoading ? (
        <Skeleton className="h-64" />
      ) : q.error || !g ? (
        <p className="text-[0.86rem] text-amber">
          This game could not be read: {q.error?.message ?? "not found"}
        </p>
      ) : (
        <div className="grid gap-4 @md:grid-cols-[minmax(0,14rem)_1fr]">
          <div className="mx-auto w-full max-w-[14rem]">
            <Cover serviceId={serviceId} game={g} size="large" />
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <h3 className="text-[1.15rem] text-ink" data-testid="romm-game-name">
                {g.name}
              </h3>
              <p className="text-[0.82rem] text-muted">
                {[g.platform, g.year, g.regions?.join(", ")].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                tone={g.favorite ? "outline" : "primary"}
                disabled={fav.busy}
                data-hearth-target="game:favorite"
                data-testid="romm-favorite"
                onClick={() =>
                  void fav.propose(
                    "app-romm-control",
                    { op: g.favorite ? "unfavorite" : "favorite", romId: g.id },
                    g.favorite ? `Take ${g.name} out of favourites` : `Add ${g.name} to favourites`,
                  )
                }
              >
                <Heart
                  strokeWidth={1.5}
                  className={cx("h-4 w-4", g.favorite && "fill-gold text-gold")}
                />
                {g.favorite ? "Favourite" : "Add to favourites"}
              </Button>
              <InRomm serviceId={serviceId} path={g.path}>
                Open in RomM (play, download)
              </InRomm>
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
                onClick={() =>
                  cave.ask(
                    `Tell me about ${g.name} (${g.platform}${g.year ? `, ${g.year}` : ""}) in my RomM library.`,
                  )
                }
              >
                <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember
                <EmberMark />
              </button>
            </div>
            <ChangeCard c={fav} />
            {g.unidentified && (
              <p className="text-[0.8rem] text-amber">
                RomM could not identify this game, so it has no details from a game database yet.
              </p>
            )}
            {g.summary && <p className="text-[0.86rem] leading-relaxed text-muted">{g.summary}</p>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.82rem]">
              {(
                [
                  ["Genres", g.genres.join(", ")],
                  ["Developer", g.developers.join(", ")],
                  ["Publisher", g.publishers.join(", ")],
                  ["Series", g.franchises.join(", ")],
                  ["Players", g.playerCount ?? ""],
                  ["Languages", g.languages.join(", ")],
                  ["Rating", g.rating ? `${g.rating} / 100` : ""],
                  ["Size", g.sizeBytes ? sizeOf(g.sizeBytes) : ""],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-faint">{k}</dt>
                    <dd className="min-w-0 break-words text-ink">{v}</dd>
                  </div>
                ))}
            </dl>
            <div>
              <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">
                Files · {g.files.length}
              </p>
              <ul className="space-y-1 text-[0.8rem]" data-testid="romm-files">
                {g.files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex flex-wrap gap-x-2">
                    <span className="min-w-0 flex-1 break-all text-ink">{f.name}</span>
                    <span className="text-faint">{sizeOf(f.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      <p className="text-[0.74rem] text-faint">{name}</p>
    </section>
  );
}
