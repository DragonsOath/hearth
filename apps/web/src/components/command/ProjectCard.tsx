import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  AlertCircle,
  BookOpen,
  Box,
  Camera,
  CheckCircle2,
  ChevronRight,
  Database,
  Film,
  Folder,
  Home,
  Music,
  Network,
  Pencil,
  Server,
  Shield,
  Sparkles,
  Swords,
  Tv,
  type LucideIcon,
  Wrench,
} from "lucide-react";
import {
  PROJECT_PHASE_LABEL,
  type ProjectIcon,
  type ProjectPhase,
  type ProjectSummary,
} from "@dragon-control/core";
import { cx } from "../ui";
import { glowOf } from "./projectGlow";
import { EditProjectDialog, type EditTarget } from "./EditProject";
import { shortAgo } from "../../lib/format";
import { warRoomProjectHref, type WarRoomProject } from "../../data/warRoomProjects";
import { PcChip, ZoneBadge, useLairWhere } from "./zones";

export const PROJECT_ICON: Record<ProjectIcon, LucideIcon> = {
  folder: Folder,
  film: Film,
  tv: Tv,
  shield: Shield,
  server: Server,
  network: Network,
  database: Database,
  box: Box,
  wrench: Wrench,
  home: Home,
  sparkles: Sparkles,
  music: Music,
  book: BookOpen,
  camera: Camera,
};

/** Each kind of project keeps a colour of its own, so the dashboard reads at a glance. */
const ICON_TINT: Record<ProjectIcon, string> = {
  folder: "var(--color-tint-gold)",
  film: "var(--color-tint-red)",
  tv: "var(--color-tint-teal)",
  shield: "var(--color-tint-gold)",
  server: "var(--color-tint-blue)",
  network: "var(--color-tint-blue)",
  database: "var(--color-tint-teal)",
  box: "var(--color-tint-violet)",
  wrench: "var(--color-tint-violet)",
  home: "var(--color-tint-teal)",
  sparkles: "var(--color-tint-gold)",
  music: "var(--color-tint-violet)",
  book: "var(--color-tint-blue)",
  camera: "var(--color-tint-red)",
};

export function tintOf(p: Pick<ProjectSummary, "icon" | "phase" | "color">): string {
  const glow = glowOf(p);
  if (glow) return glow;
  if (p.phase === "failed" || p.phase === "blocked") return "var(--color-tint-red)";
  return ICON_TINT[p.icon];
}

/** A glowing card's style: its color as --glow, read by .project-glow in index.css. */
const glowStyle = (glow: string | undefined, tint: string) => ({
  ["--tint" as string]: tint,
  ...(glow ? { ["--glow" as string]: glow } : {}),
});

const PHASE_TONE: Record<ProjectPhase, string> = {
  planned: "text-amber",
  queued: "text-muted",
  investigating: "text-gold",
  "in-progress": "text-gold",
  "awaiting-approval": "text-amber",
  blocked: "text-alert",
  completed: "text-live",
  failed: "text-alert",
  paused: "text-faint",
};

export function PhasePill({ phase }: { phase: ProjectPhase }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full bg-bg/60 px-2.5 py-0.5 text-[0.74rem]",
        PHASE_TONE[phase],
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {PROJECT_PHASE_LABEL[phase]}
    </span>
  );
}

/**
 * A card with its edit: right-click it, or the pencil (shown on hover and keyboard focus, always on
 * touch screens). The pencil sits beside the card's link, never inside it.
 */
function Editable({
  target,
  className,
  children,
}: {
  target: EditTarget;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cx("group/edit relative", className)}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
    >
      {children}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Edit ${target.name}`}
        title="Edit name, description and color"
        className="absolute top-1.5 right-1.5 flex h-8 w-8 items-center justify-center rounded-lg bg-bg/70 text-muted opacity-0 transition-opacity hover:text-gold focus-visible:opacity-100 group-hover/edit:opacity-100 [@media(hover:none)]:opacity-100"
        data-testid="project-card-edit"
      >
        <Pencil strokeWidth={1.5} className="h-4 w-4" />
      </button>
      {open && <EditProjectDialog target={target} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function ProjectCard({
  project,
  className,
  compact = false,
}: {
  project: ProjectSummary;
  className?: string;
  /** Home's command center: the same facts in less height (status beside the name). */
  compact?: boolean;
}) {
  const Icon = PROJECT_ICON[project.icon];
  const tint = tintOf(project);
  const glow = glowOf(project);
  const where = useLairWhere(project);
  const systems = project.systems
    .filter((s) => s.kind !== "host" || s.name !== where.name)
    .slice(0, 3)
    .map((s) => s.name);
  const problem = project.phase === "failed" || project.phase === "blocked";
  return (
    <Editable
      className={className}
      target={{
        kind: "lair",
        id: project.id,
        name: project.name,
        description: project.summary ?? "",
        color: project.color,
      }}
    >
      <Link
        to={`/?project=${encodeURIComponent(project.id)}`}
        style={glowStyle(glow, tint)}
        className={cx(
          "cc-card group relative flex h-full w-full flex-col rounded-xl",
          glow && "project-glow",
          compact ? "px-3 py-2.5" : "p-4",
        )}
        data-color={project.color}
        aria-label={`${project.name}, ${PROJECT_PHASE_LABEL[project.phase]}`}
        data-testid="project-card"
      >
        <div className={cx("flex gap-3", compact ? "items-center" : "items-start")}>
          <span
            className={cx(
              "flex shrink-0 items-center justify-center rounded-lg",
              compact ? "h-8 w-8" : "h-11 w-11",
            )}
            style={{ background: `color-mix(in oklab, ${tint} 18%, transparent)`, color: tint }}
          >
            <Icon strokeWidth={1.5} className={compact ? "h-[18px] w-[18px]" : "h-6 w-6"} />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cx(
                "line-clamp-1 font-medium text-ink",
                compact ? "text-[0.9rem]" : "text-[0.98rem]",
              )}
            >
              {project.name}
            </p>
            <p
              className={cx(
                "mt-0.5 leading-snug text-muted",
                compact ? "line-clamp-1 text-[0.76rem]" : "line-clamp-2 text-[0.8rem]",
              )}
            >
              {project.summary || "No summary yet."}
            </p>
          </div>
          {compact ? null : problem ? (
            <AlertCircle
              strokeWidth={1.75}
              className="h-5 w-5 shrink-0 text-alert"
              aria-label="Problem"
            />
          ) : project.phase === "completed" ? (
            <CheckCircle2
              strokeWidth={1.75}
              className="h-5 w-5 shrink-0 text-live"
              aria-label="Completed"
            />
          ) : null}
        </div>
        {!compact && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ZoneBadge zone="lair" />
            <PcChip where={where} className="text-[0.76rem] text-faint" />
            <PhasePill phase={project.phase} />
            {project.progress && (
              <span className="text-[0.74rem] text-faint tabular">
                {project.progress.done} of {project.progress.total} tasks
              </span>
            )}
          </div>
        )}
        <div
          className={cx(
            "flex items-center justify-between gap-2 text-faint",
            compact ? "mt-1.5 text-[0.74rem]" : "mt-2 text-[0.78rem]",
          )}
        >
          {compact && <ZoneBadge zone="lair" />}
          {compact && <PcChip where={where} className="max-w-[40%]" />}
          {compact && <PhasePill phase={project.phase} />}
          <span className="min-w-0 flex-1 truncate">
            {compact
              ? project.progress
                ? `${project.progress.done} of ${project.progress.total} tasks`
                : ""
              : systems.length
                ? systems.join(" · ")
                : "No systems linked"}
          </span>
          <ChevronRight
            strokeWidth={1.5}
            className="h-4 w-4 shrink-0 transition-colors group-hover:text-gold"
          />
        </div>
      </Link>
    </Editable>
  );
}

/** A War Room project on Home: opens the War Room with that project open. */
export function WarRoomProjectCard({
  project,
  className,
  compact = false,
}: {
  project: WarRoomProject;
  className?: string;
  compact?: boolean;
}) {
  const glow = glowOf(project);
  const tint = glow ?? "var(--color-tint-gold)";
  const Icon = Swords;
  return (
    <Editable
      className={className}
      target={{
        kind: "war-room",
        slug: project.slug,
        pc: project.where.pc,
        name: project.name,
        description: project.description,
        color: project.color,
      }}
    >
      <Link
        to={warRoomProjectHref(project.slug, project.where.pc)}
        style={glowStyle(glow, tint)}
        className={cx(
          "cc-card group relative flex h-full w-full flex-col rounded-xl",
          glow && "project-glow",
          compact ? "px-3 py-2.5" : "p-4",
        )}
        data-color={project.color}
        aria-label={`${project.name}, a War Room project on ${project.where.name}`}
        data-testid="war-room-project-card"
      >
        <div className={cx("flex gap-3", compact ? "items-center" : "items-start")}>
          <span
            className={cx(
              "flex shrink-0 items-center justify-center rounded-lg",
              compact ? "h-8 w-8" : "h-11 w-11",
            )}
            style={{ background: `color-mix(in oklab, ${tint} 18%, transparent)`, color: tint }}
          >
            <Icon strokeWidth={1.5} className={compact ? "h-[18px] w-[18px]" : "h-6 w-6"} />
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={cx(
                "line-clamp-1 font-medium text-ink",
                compact ? "text-[0.9rem]" : "text-[0.98rem]",
              )}
            >
              {project.name}
            </p>
            <p
              className={cx(
                "mt-0.5 leading-snug text-muted",
                compact ? "line-clamp-1 text-[0.76rem]" : "line-clamp-2 text-[0.8rem]",
              )}
            >
              {project.description || "No description yet."}
            </p>
          </div>
        </div>
        <div
          className={cx(
            "flex items-center justify-between gap-2 text-faint",
            compact ? "mt-1.5 text-[0.74rem]" : "mt-3 text-[0.78rem]",
          )}
        >
          <ZoneBadge zone="war-room" />
          <PcChip where={project.where} className="max-w-[40%]" />
          <span className="min-w-0 flex-1 truncate">
            {project.active
              ? "Working on it now"
              : project.last
                ? `Last used ${shortAgo(project.last)} ago`
                : "Not used yet"}
          </span>
          <ChevronRight
            strokeWidth={1.5}
            className="h-4 w-4 shrink-0 transition-colors group-hover:text-gold"
          />
        </div>
      </Link>
    </Editable>
  );
}
