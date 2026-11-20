import { useState } from "react";
import { ScanLine } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { Skeleton } from "../../ui";
import { ScanSheet, sizeOf, useRomm } from "./parts";

/**
 * RomM's Platforms tab: every platform with how many games and how much space, the way into its
 * games in the Library, and scanning just that platform (an approved plan, administrators only).
 */
export function RommPlatforms({ serviceId, name, onGo }: AppViewProps) {
  const { q, d } = useRomm(serviceId);
  const [scan, setScan] = useState<number | undefined>(undefined);
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (!d)
    return (
      <p className="text-[0.86rem] text-amber">
        {name} could not be read: {q.data?.error?.message ?? q.error?.message ?? "no answer"}
      </p>
    );
  return (
    <section
      className="space-y-2"
      data-testid="romm-platforms-tab"
      aria-label={`${name}: platforms`}
    >
      <ul className="divide-y divide-line rounded-xl border border-line">
        {d.platforms.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-2 px-3 py-2.5"
            data-testid="romm-platform"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[0.88rem] text-ink">{p.name}</p>
              <p className="text-[0.76rem] text-faint">
                {p.games} game{p.games === 1 ? "" : "s"} · {sizeOf(p.sizeBytes)}
                {p.missing ? " · its folder is gone" : ""}
              </p>
            </div>
            <button
              type="button"
              className="inline-flex min-h-9 items-center rounded-lg border border-line-strong px-3 text-[0.78rem] text-muted hover:border-gold/60 hover:text-gold"
              onClick={() => onGo?.("library", `platform/${p.id}`)}
            >
              Games
            </button>
            {d.canScan && (
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.78rem] text-muted hover:border-gold/60 hover:text-gold"
                data-hearth-target="platform:scan"
                onClick={() => setScan(p.id)}
              >
                <ScanLine strokeWidth={1.5} className="h-3.5 w-3.5" /> Scan
              </button>
            )}
          </li>
        ))}
      </ul>
      {scan !== undefined && (
        <ScanSheet
          serviceId={serviceId}
          d={d}
          platformIds={[scan]}
          onClose={() => setScan(undefined)}
        />
      )}
    </section>
  );
}
