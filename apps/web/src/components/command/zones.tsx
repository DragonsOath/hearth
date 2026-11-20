import { Castle, Server, Swords } from "lucide-react";
import type { ProjectSummary } from "@dragon-control/core";
import { pcLook, usePcs } from "../../data/pcs";
import type { PcBadge } from "../../data/warRoomProjects";
import { cx } from "../ui";

/**
 * The two zones a project lives in (10-30). The Lair: homelab work, done by Ember in the Lair
 * with Hearth's live tools. The War Room: building something, done by Claude Code, Codex or Ollama
 * in a project folder. Every project card says which, and which PC it is on.
 */
export type Zone = "lair" | "war-room";

export function ZoneBadge({ zone, className }: { zone: Zone; className?: string }) {
  const lair = zone === "lair";
  const Icon = lair ? Castle : Swords;
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-[0.7rem] font-semibold whitespace-nowrap",
        lair
          ? "border-tint-teal/40 bg-tint-teal/15 text-tint-teal"
          : "border-gold/40 bg-gold/15 text-gold",
        className,
      )}
      data-testid="zone-badge"
      data-zone={zone}
    >
      <Icon strokeWidth={1.75} className="h-3.5 w-3.5" aria-hidden="true" />
      {lair ? "Lair" : "War Room"}
    </span>
  );
}

/** A PC's icon and name (a plain server icon for a machine without Hearth's own icon). */
export function PcChip({ where, className }: { where: Omit<PcBadge, "pc">; className?: string }) {
  return (
    <span
      className={cx("inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap", className)}
      data-testid="pc-chip"
    >
      {where.src ? (
        <img src={where.src} alt="" className="h-4 w-4 shrink-0 rounded" />
      ) : (
        <Server
          strokeWidth={1.75}
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: where.color }}
          aria-hidden="true"
        />
      )}
      <span className="truncate">{where.name}</span>
    </span>
  );
}

/**
 * Which machine a Lair project is about: the machine linked to it, shown with that PC's icon when
 * it is one of your Hearth PCs; otherwise the PC the Lair runs on.
 */
export function useLairWhere(project: Pick<ProjectSummary, "systems">): Omit<PcBadge, "pc"> {
  const pcs = usePcs();
  const host = project.systems.find((s) => s.kind === "host" && !s.missing);
  const all = pcs.data ? [pcs.data.hub, ...pcs.data.pcs] : [];
  const name = host?.name ?? pcs.data?.hub.name ?? "This PC";
  const pc = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
  return pc ? { name, ...pcLook(pc) } : { name, src: null, color: "var(--color-muted)" };
}
