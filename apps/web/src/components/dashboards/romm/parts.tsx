import { useEffect, useRef, useState } from "react";
import { ExternalLink, Gamepad2, Heart } from "lucide-react";
import type { RommDashboard, RommGame } from "@dragon-control/core";
import { useWorkspace } from "../../../data/api";
import { useDashboard } from "../../../data/dashboards";
import { bytes } from "../../../lib/format";
import { keyPageHref } from "../../../lib/keyPage";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Button, Sheet, cx } from "../../ui";

/** RomM's panel pieces shared by Overview, Library and Platforms. */

export const rommUrl = (serviceId: string, path: string) =>
  `/api/services/${encodeURIComponent(serviceId)}/dashboard/romm${path}`;

/** RomM's own dashboard read (totals, platforms, recent, favourites, whether it may scan). */
export function useRomm(serviceId: string) {
  const q = useDashboard(serviceId, true, 30_000);
  const d: RommDashboard | undefined = q.data?.data?.app === "romm" ? q.data.data : undefined;
  return { q, d, sample: Boolean(q.data?.sample) };
}

/** A game's cover, through Hearth; a plain tile where RomM has none. */
export function Cover({
  serviceId,
  game,
  size = "small",
  className,
}: {
  serviceId: string;
  game: Pick<RommGame, "id" | "name" | "cover">;
  size?: "small" | "large";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!game.cover || failed)
    return (
      <div
        className={cx(
          "flex aspect-[3/4] w-full flex-col items-center justify-center gap-1 rounded-lg bg-raised p-2 text-center text-faint",
          className,
        )}
      >
        <Gamepad2 strokeWidth={1.25} className="h-7 w-7" aria-hidden />
        <span className="line-clamp-2 text-[0.7rem]">No cover</span>
      </div>
    );
  return (
    <img
      src={rommUrl(serviceId, `/games/${game.id}/cover${size === "large" ? "?size=large" : ""}`)}
      alt={`${game.name} cover`}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cx("aspect-[3/4] w-full rounded-lg bg-raised object-cover", className)}
    />
  );
}

/** One game as a card: its cover, name, platform and year. */
export function GameCard({
  serviceId,
  game,
  onOpen,
}: {
  serviceId: string;
  game: RommGame;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full min-w-0 space-y-1.5 text-left"
      data-testid="romm-game"
      data-capture-item
      data-capture-label={game.name}
    >
      <span className="relative block">
        <Cover
          serviceId={serviceId}
          game={game}
          className="group-hover:ring-2 group-hover:ring-gold/60"
        />
        {game.favorite && (
          <Heart
            aria-label="Favourite"
            className="absolute top-1.5 right-1.5 h-4 w-4 fill-gold text-gold drop-shadow"
          />
        )}
      </span>
      <span className="block truncate text-[0.82rem] text-ink" title={game.name}>
        {game.name}
      </span>
      <span className="block truncate text-[0.72rem] text-faint">
        {[game.platform, game.year].filter(Boolean).join(" · ")}
        {game.unidentified ? " · not identified" : ""}
      </span>
    </button>
  );
}

/** A link to a page of RomM itself, on its own address. */
export function InRomm({
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

export const SCANS = [
  ["quick", "Quick", "Find new games and platforms; games already in RomM stay as they are"],
  ["unmatched", "Identify again", "Try again to identify games RomM could not identify"],
  ["new_platforms", "New platforms", "Only platforms that are not in RomM yet"],
  ["update", "Update details", "Read the details and covers again for every game (slower)"],
  ["complete", "Complete", "Rescan everything and read every game's details again (slowest)"],
] as const;

/** Choose a scan (kind and platforms), then approve it: RomM is only changed after that. */
export function ScanSheet({
  serviceId,
  d,
  platformIds = [],
  onClose,
}: {
  serviceId: string;
  d: RommDashboard;
  platformIds?: number[];
  onClose: () => void;
}) {
  const act = useApproveHere(serviceId, "Proposed from RomM's panel.");
  // Once a scan is done and its pop-up closed, the dialog is finished too.
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (act.job?.status) last.current = act.job.status;
  });
  useEffect(() => {
    if (!act.open && last.current === "succeeded") onClose();
  });
  const [type, setType] = useState<(typeof SCANS)[number][0]>("quick");
  const [chosen, setChosen] = useState<number[]>(platformIds);
  return (
    <>
      <ApproveDialog c={act} />
      {!act.open && (
        <Sheet label="Scan the library" eyebrow="RomM" title="Scan the library" onClose={onClose}>
          <form
            className="space-y-4"
            data-testid="romm-scan-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.propose(
                "app-romm-control",
                {
                  op: "scan",
                  scanType: type,
                  ...(chosen.length ? { platformIds: chosen.join(",") } : {}),
                },
                "Scan RomM's library",
              );
            }}
          >
            <fieldset className="space-y-2">
              <legend className="mb-1 text-[0.8rem] text-muted">What kind of scan</legend>
              {SCANS.map(([id, label, what]) => (
                <label
                  key={id}
                  className={cx(
                    "flex cursor-pointer items-start gap-2 rounded-lg border p-2.5",
                    type === id ? "border-gold/60 bg-gold/5" : "border-line",
                  )}
                >
                  <input
                    type="radio"
                    name="scan"
                    value={id}
                    checked={type === id}
                    onChange={() => setType(id)}
                    className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
                  />
                  <span>
                    <span className="block text-[0.86rem] text-ink">{label}</span>
                    <span className="block text-[0.76rem] text-faint">{what}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-[0.8rem] text-muted">
                Platforms (none ticked: the whole library)
              </legend>
              {d.platforms.map((p) => (
                <label
                  key={p.id}
                  className="flex min-h-9 items-center gap-2 text-[0.84rem] text-ink"
                >
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.id)}
                    onChange={(e) =>
                      setChosen((now) =>
                        e.target.checked ? [...now, p.id] : now.filter((x) => x !== p.id),
                      )
                    }
                    className="h-4 w-4 accent-[var(--color-gold)]"
                  />
                  {p.name} <span className="text-faint">· {p.games} games</span>
                </label>
              ))}
            </fieldset>
            {act.error && (
              <p role="alert" className="text-[0.82rem] text-amber" data-testid="romm-scan-error">
                {act.error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button tone="primary" type="submit" disabled={act.pending}>
                {act.pending ? "Checking…" : "Scan"}
              </Button>
              <Button tone="quiet" onClick={onClose}>
                Cancel
              </Button>
            </div>
            <p className="text-[0.76rem] text-faint">
              You approve it first. A scan never deletes a game or a file.
            </p>
          </form>
        </Sheet>
      )}
    </>
  );
}

export const sizeOf = (b: number) => (b ? bytes(b) : "0 B");
