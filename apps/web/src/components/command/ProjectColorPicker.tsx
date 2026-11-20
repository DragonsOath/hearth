import { Check } from "lucide-react";
import { PROJECT_COLORS, type ProjectColor } from "@dragon-control/core";
import { cx } from "../ui";
import { PROJECT_GLOW } from "./projectGlow";

/** The colors' names as the owner reads them. */
export const PROJECT_COLOR_NAME: Record<ProjectColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

/**
 * A project's color: the card on Home glows in it. "No color" keeps the plain card. Each choice
 * shows the glowing dot it gives, with its name, so the colors are never told apart by hue alone.
 */
export function ProjectColorPicker({
  value,
  onChange,
}: {
  value: ProjectColor | undefined;
  onChange: (color: ProjectColor | undefined) => void;
}) {
  const option = (color: ProjectColor | undefined) => {
    const on = value === color;
    const glow = color ? PROJECT_GLOW[color] : undefined;
    return (
      <button
        key={color ?? "none"}
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => onChange(color)}
        className={cx(
          "flex min-h-11 items-center gap-2 rounded-full border px-3 text-[0.84rem] transition-colors",
          on ? "text-ink" : "border-line text-muted hover:text-ink",
        )}
        style={
          on && glow
            ? {
                borderColor: glow,
                background: `color-mix(in oklab, ${glow} 18%, transparent)`,
                boxShadow: `0 0 14px color-mix(in oklab, ${glow} 45%, transparent)`,
              }
            : on
              ? { borderColor: "var(--color-gold)" }
              : undefined
        }
        data-testid={`project-color-${color ?? "none"}`}
      >
        <span
          aria-hidden="true"
          className={cx(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
            !glow && "border border-line-strong",
          )}
          style={glow ? { background: glow, boxShadow: `0 0 8px ${glow}` } : undefined}
        >
          {on && <Check strokeWidth={3} className="h-3 w-3 text-bg" />}
        </span>
        {color ? PROJECT_COLOR_NAME[color] : "No color"}
      </button>
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label="Color"
      className="flex flex-wrap gap-2"
      data-testid="project-color"
    >
      {option(undefined)}
      {PROJECT_COLORS.map((c) => option(c))}
    </div>
  );
}
