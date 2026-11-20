import type { ProjectColor } from "@dragon-control/core";

/**
 * The bright colors a project can glow in (PROJECT_COLORS): vivid on purpose, like the halo
 * around branded panels, and the same in every theme.
 */
export const PROJECT_GLOW: Record<ProjectColor, string> = {
  red: "#ff3b4e",
  orange: "#ff8a1e",
  yellow: "#ffd23f",
  green: "#2fe37a",
  blue: "#3b9cff",
  purple: "#b55cff",
};

/** The project's own color, when the owner chose one. */
export function glowOf(p: { color?: ProjectColor }): string | undefined {
  return p.color ? PROJECT_GLOW[p.color] : undefined;
}
