import { useState } from "react";
import { Library, ScanLine } from "lucide-react";
import type { RommGame } from "@dragon-control/core";
import type { AppViewProps } from "../../panels/registry";
import { Button, Skeleton } from "../../ui";
import { GameCard, InRomm, ScanSheet, sizeOf, useRomm } from "./parts";
import { RommLibrary } from "./RommLibrary";

/**
 * RomM's Overview, the way into your game library: totals, recently added and favourites with
 * their covers, the platforms (most games first), how many games RomM could not identify, and a
 * library scan (an approved plan; RomM lets only administrators scan). Every game opens on its own
 * page in the Library tab.
 */
export function RommOverview({ serviceId, name, onGo }: AppViewProps) {
  const { q, d, sample } = useRomm(serviceId);
  const [scanning, setScanning] = useState(false);
  // Outside a panel (no other tabs to open), the Library shows here.
  if (!onGo) return <RommLibrary serviceId={serviceId} name={name} />;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error)
    return (
      <p className="text-[0.88rem] text-alert">
        Could not read {name}: {q.error.message}
      </p>
    );
  if (q.data?.error)
    return (
      <div
        className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
        data-testid="romm-error"
      >
        <p className="text-amber">{name} could not be read right now.</p>
        <p className="mt-1 text-muted">{q.data.error.message}</p>
      </div>
    );
  if (!d) return null;
  const open = (g: RommGame) => onGo("library", `game/${g.id}`);
  const row = (title: string, games: RommGame[], testid: string, more: () => void) =>
    games.length > 0 && (
      <div data-testid={testid}>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">{title}</p>
          <button type="button" className="text-[0.76rem] text-gold hover:underline" onClick={more}>
            See all
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3 @md:grid-cols-6">
          {games.slice(0, 6).map((g) => (
            <GameCard key={g.id} serviceId={serviceId} game={g} onOpen={() => open(g)} />
          ))}
        </div>
      </div>
    );
  return (
    <section
      className="@container space-y-5"
      data-testid="romm-dashboard"
      aria-label={`${name} at a glance`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            ["Games", String(d.totals.games), sizeOf(d.totals.sizeBytes)],
            [
              "Platforms",
              String(d.totals.platforms),
              d.platforms[0] ? `most: ${d.platforms[0].name}` : "",
            ],
            ["Saves", String(d.totals.saves), `${d.totals.states} save states`],
            [
              "Not identified",
              String(d.unidentified),
              d.unidentified ? "no game-database details yet" : "every game identified",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className="stat-value text-ink tabular"
              data-testid={label === "Games" ? "romm-games" : undefined}
            >
              {value}
            </p>
            <p className="truncate text-[0.74rem] text-faint">{sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button tone="primary" onClick={() => onGo("library")} data-testid="romm-browse">
          <Library strokeWidth={1.75} className="h-4 w-4" /> Browse the library
        </Button>
        {d.canScan ? (
          <Button
            tone="outline"
            onClick={() => setScanning(true)}
            data-hearth-target="overview:scan"
            data-testid="romm-scan"
          >
            <ScanLine strokeWidth={1.75} className="h-4 w-4" /> Scan for new games
          </Button>
        ) : (
          <p className="text-[0.78rem] text-faint" data-testid="romm-no-scan">
            Scans need a RomM administrator's login in the vault.
          </p>
        )}
        <InRomm serviceId={serviceId} path="/">
          Open RomM
        </InRomm>
      </div>

      {row("Recently added", d.recent, "romm-recent", () => onGo("library", "order/added"))}
      {row("Favourites", d.favorites, "romm-favorites", () => onGo("library", "favorites"))}

      <div data-testid="romm-platforms">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="text-[0.72rem] tracking-wide text-faint uppercase">Platforms</p>
          <button
            type="button"
            className="text-[0.76rem] text-gold hover:underline"
            onClick={() => onGo("platforms")}
          >
            See all
          </button>
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {d.platforms.slice(0, 8).map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onGo("library", `platform/${p.id}`)}
                className="min-h-9 rounded-full border border-line px-3 text-[0.78rem] text-muted hover:border-gold/60 hover:text-gold"
              >
                {p.name} · {p.games}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {d.unidentified > 0 && d.canScan && (
        <p className="text-[0.8rem] text-muted">
          {d.unidentified} game{d.unidentified === 1 ? "" : "s"} could not be identified. A scan of
          the kind <b>Identify again</b> tries them once more.
        </p>
      )}

      <p className="text-[0.74rem] text-faint">
        {sample ? "Sample data · " : ""}
        {d.version ? `${name} ${d.version} · ` : ""}read every 30 s
      </p>
      {scanning && <ScanSheet serviceId={serviceId} d={d} onClose={() => setScanning(false)} />}
    </section>
  );
}
