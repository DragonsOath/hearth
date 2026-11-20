import type { GrabSource } from "@dragon-control/core";

/**
 * Where a download came from (11-11, the owner: "I want to see that clearly on the quick view"):
 * the indexer in bold, and the app that grabbed it ("via Radarr"). "tracker" means only the
 * torrent's tracker address named it.
 */
export function SourceBadge({ source }: { source?: GrabSource }) {
  if (!source) return null;
  const via = source.via === "tracker" ? "from its tracker" : `via ${source.via}`;
  return (
    <span
      className="shrink-0 rounded-full border border-gold/50 bg-gold/10 px-2 py-0.5 text-[0.72rem] text-ink"
      title={`Grabbed from ${source.indexer} ${via}`}
      data-testid="grab-source"
    >
      <b className="font-semibold text-gold">{source.indexer}</b>
      <span className="text-muted"> · {via}</span>
    </span>
  );
}
