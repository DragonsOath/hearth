import { useEffect, useRef, useState } from "react";
import { Check, ArrowLeftRight, Monitor, Smartphone } from "lucide-react";
import type { PanelLook, ThemeChoice, ThemePreset } from "@dragon-control/core";
import { useUpdateSettings, useWorkspace } from "../../data/api";
import { applyTheme, DEFAULT_THEME, PRESETS, tokensFor } from "../../lib/theme";
import { isPhoneDevice } from "../../lib/media";
import { SaveNote, Section, cx } from "../ui";

/** Quick picks for your own colors (any color works through the pickers). */
const CHIPS = [
  "#e2553f",
  "#f5a623",
  "#e0c45c",
  "#3fbf7f",
  "#2fb9c4",
  "#3d8bff",
  "#8b6cf0",
  "#e05a9c",
  "#ffffff",
  "#000000",
];

/** A small picture of a theme: its background, a panel, a line of text, and its main color. */
function Swatch({ choice }: { choice: ThemeChoice }) {
  const { tokens: t } = tokensFor(choice);
  return (
    <span
      aria-hidden
      className="relative block h-16 w-full overflow-hidden rounded-lg border"
      style={{ background: t.bg, borderColor: t["line-strong"] }}
    >
      <span
        className="absolute top-2 left-2 h-11 w-[58%] rounded-md border"
        style={{ background: t.panel, borderColor: t.line }}
      >
        <span
          className="absolute top-2 left-2 h-1.5 w-[70%] rounded"
          style={{ background: t.ink, opacity: 0.85 }}
        />
        <span
          className="absolute top-5 left-2 h-1.5 w-[45%] rounded"
          style={{ background: t.muted, opacity: 0.7 }}
        />
        <span
          className="absolute bottom-2 left-2 h-1.5 w-[35%] rounded"
          style={{ background: t.gold }}
        />
      </span>
      <span
        className="absolute top-2 right-2 h-5 w-5 rounded-full"
        style={{ background: t.gold }}
      />
      <span
        className="absolute right-2 bottom-2 h-4 w-10 rounded"
        style={{ background: t.action }}
      />
    </span>
  );
}

function ColorField({
  label,
  hint,
  value,
  onChange,
  testId,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <label className="flex items-center gap-3">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-14 shrink-0 cursor-pointer rounded-lg border border-line-strong bg-transparent p-1"
          data-testid={testId}
        />
        <span className="min-w-0">
          <span className="block text-[0.9rem] text-ink">{label}</span>
          <span className="block text-[0.78rem] text-faint">{hint}</span>
        </span>
      </label>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={`${label} quick picks`}>
        {CHIPS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={`${label}: ${c}`}
            className={cx(
              "h-7 w-7 rounded-full border transition-transform hover:scale-110",
              value.toLowerCase() === c ? "border-ink ring-2 ring-gold" : "border-line-strong",
            )}
            style={{ background: c }}
          />
        ))}
      </div>
    </div>
  );
}

/** How service panels look: the plain panel, each service's own look, or Hearth's on all. */
const PANEL_LOOK_OPTIONS: { id: PanelLook; label: string; blurb: string }[] = [
  { id: "minimal", label: "Minimal", blurb: "The plain dark panel, no artwork." },
  {
    id: "service",
    label: "Service branding",
    blurb: "Each service's own colors and artwork, with Hearth's controls.",
  },
  { id: "hearth", label: "Hearth branding", blurb: "Hearth's ember look on every panel." },
];

type Target = "desktop" | "phone";

/**
 * Settings > Themes: four looks, or your own two colors; saved to your account. Desktop and
 * Phone (11-16, the owner: "have it be different than your desktop"): phones use the desktop's
 * look until you give them their own. The welcome shows it bare (without the Settings section,
 * its heading, or the Desktop and Phone switch: one look to start with).
 */
export function ThemePicker({ bare = false }: { bare?: boolean }) {
  const ws = useWorkspace();
  const save = useUpdateSettings();
  const onPhone = isPhoneDevice();
  // Opens on the desktop's look, which phones follow too until they have their own: picking a
  // theme on a phone changes it everywhere, as before, unless you choose Phone first.
  const [target, setTarget] = useState<Target>("desktop");
  const desktop = ws.data ? (ws.data.theme ?? DEFAULT_THEME) : undefined;
  const phoneOwn = ws.data?.phoneTheme;
  const saved = target === "phone" ? (phoneOwn ?? desktop) : desktop;
  const [drafts, setDrafts] = useState<Partial<Record<Target, ThemeChoice>>>({});
  const current = drafts[target] ?? saved ?? DEFAULT_THEME;
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<{ target: Target; choice: ThemeChoice } | undefined>(undefined);
  const mutate = save.mutate;
  /** The look this device shows: a change to the other one is saved, not shown here. */
  const mine: Target = onPhone ? "phone" : "desktop";
  const send = (p: { target: Target; choice: ThemeChoice }) =>
    mutate(p.target === "phone" ? { phoneTheme: p.choice } : { theme: p.choice });

  // Saved shortly after the last change (color pickers send many while you drag).
  const choose = (next: ThemeChoice) => {
    setDrafts((d) => ({ ...d, [target]: next }));
    // Shown here when it is this device's look: a phone that follows the desktop shows the
    // desktop's too.
    if (target === mine || (mine === "phone" && target === "desktop" && !phoneOwn && !drafts.phone))
      applyTheme(next);
    const flush = pending.current;
    if (flush && flush.target !== target) send(flush);
    pending.current = { target, choice: next };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const p = pending.current;
      pending.current = undefined;
      if (p) send(p);
    }, 450);
  };
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending.current) send(pending.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mutate],
  );
  /** Phones back to the desktop's look. */
  const sameAsDesktop = () => {
    window.clearTimeout(timer.current);
    pending.current = undefined;
    setDrafts((d) => ({ ...d, phone: undefined }));
    if (mine === "phone" && desktop) applyTheme(desktop);
    mutate({ phoneTheme: null });
  };
  const phoneFollows = target === "phone" && !phoneOwn && !drafts.phone;

  const custom = current.preset === "custom";
  const base = custom ? undefined : PRESETS[current.preset as Exclude<ThemePreset, "custom">];
  const primary = current.primary ?? base?.primary ?? PRESETS.hearth.primary;
  const secondary = current.secondary ?? base?.secondary ?? "#000000";
  const headings = tokensFor(current).headings;
  // The panels' look is its own choice: picking another theme keeps it.
  const keep = current.panels ? { panels: current.panels } : {};
  const panels: PanelLook = current.panels ?? "minimal";

  const presets = Object.entries(PRESETS) as [
    Exclude<ThemePreset, "custom">,
    (typeof PRESETS)["hearth"],
  ][];
  const note = <SaveNote status={save.status} error={save.error} />;
  const content = (
    <>
      <p className="mb-4 max-w-2xl text-[0.86rem] leading-relaxed text-muted">
        How Hearth looks everywhere, including the Lair and the War Room. Your colors lead; green,
        amber, and red still mean healthy, warning, and failed, and charts keep their own colors.
        {bare
          ? " Saved to your account, so your phone and tablet match."
          : " Saved to your account. Phones use the desktop's look unless you give them their own."}
      </p>
      {!bare && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div
            role="radiogroup"
            aria-label="Which look"
            className="flex rounded-lg border border-line-strong p-0.5"
            data-testid="theme-target"
          >
            {(
              [
                ["desktop", "Desktop", Monitor],
                ["phone", "Phone", Smartphone],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={target === id}
                onClick={() => setTarget(id)}
                className={cx(
                  "flex min-h-10 items-center gap-2 rounded-md px-4 text-[0.84rem]",
                  target === id ? "bg-gold/15 text-ink" : "text-muted hover:text-ink",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
                {id === mine && <span className="text-[0.72rem] text-faint">(this one)</span>}
              </button>
            ))}
          </div>
          {target === "phone" &&
            (phoneFollows ? (
              <span className="text-[0.8rem] text-faint" data-testid="theme-phone-same">
                Same as the desktop. Pick a look below to give phones their own.
              </span>
            ) : (
              <button
                type="button"
                onClick={sameAsDesktop}
                className="min-h-10 rounded-lg border border-line-strong px-3 text-[0.82rem] text-muted hover:text-ink"
                data-testid="theme-phone-reset"
              >
                Use the desktop's look on phones
              </button>
            ))}
        </div>
      )}
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        data-testid="theme-picker"
      >
        {presets.map(([id, p]) => {
          const on = current.preset === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose({ preset: id, ...keep })}
              className={cx(
                "flex min-h-11 flex-col gap-2 rounded-xl border p-2.5 text-left transition-colors",
                on ? "border-gold bg-gold/10" : "border-line hover:border-line-strong",
              )}
            >
              <Swatch choice={{ preset: id }} />
              <span className="flex items-center justify-between gap-2">
                <span className="text-[0.9rem] text-ink">{p.name}</span>
                {on && <Check className="h-4 w-4 text-gold" aria-hidden />}
              </span>
              <span className="text-[0.76rem] leading-snug text-faint">{p.blurb}</span>
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          onClick={() => choose({ preset: "custom", primary, secondary, headings, ...keep })}
          className={cx(
            "flex min-h-11 flex-col gap-2 rounded-xl border p-2.5 text-left transition-colors",
            custom ? "border-gold bg-gold/10" : "border-line hover:border-line-strong",
          )}
        >
          <Swatch choice={{ preset: "custom", primary, secondary }} />
          <span className="flex items-center justify-between gap-2">
            <span className="text-[0.9rem] text-ink">Your colors</span>
            {custom && <Check className="h-4 w-4 text-gold" aria-hidden />}
          </span>
          <span className="text-[0.76rem] leading-snug text-faint">
            Pick a main color and a secondary color; the rest follows.
          </span>
        </button>
      </div>

      {custom && (
        <div className="mt-5 rounded-xl border border-line bg-panel p-4" data-testid="theme-custom">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <ColorField
              label="Main color"
              hint="Highlights, selection, borders, and links."
              value={primary}
              onChange={(v) => choose({ ...current, primary: v, secondary })}
              testId="theme-primary"
            />
            <button
              type="button"
              onClick={() => choose({ ...current, primary: secondary, secondary: primary })}
              className="flex min-h-11 items-center gap-2 self-start rounded-lg border border-line-strong px-3 text-[0.82rem] text-muted hover:text-ink sm:mt-1"
              aria-label="Swap main and secondary colors"
            >
              <ArrowLeftRight className="h-4 w-4" aria-hidden /> Swap
            </button>
            <ColorField
              label="Secondary color"
              hint="Main buttons, titles, and page labels. A very dark color tints the backgrounds instead."
              value={secondary}
              onChange={(v) => choose({ ...current, primary, secondary: v })}
              testId="theme-secondary"
            />
          </div>
        </div>
      )}

      <div className="mt-5" data-testid="panel-look">
        <p className="mb-2 text-[0.86rem] text-muted">Service panels</p>
        <div role="radiogroup" aria-label="Service panels" className="grid gap-2 sm:grid-cols-3">
          {PANEL_LOOK_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={panels === o.id}
              onClick={() => choose({ ...current, panels: o.id })}
              className={cx(
                "flex min-h-11 flex-col gap-1 rounded-xl border p-2.5 text-left transition-colors",
                panels === o.id ? "border-gold bg-gold/10" : "border-line hover:border-line-strong",
              )}
            >
              <span className="flex items-center justify-between gap-2 text-[0.9rem] text-ink">
                {o.label}
                {panels === o.id && <Check className="h-4 w-4 text-gold" aria-hidden />}
              </span>
              <span className="text-[0.76rem] leading-snug text-faint">{o.blurb}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <span className="text-[0.86rem] text-muted">Headings</span>
        <div
          role="radiogroup"
          aria-label="Headings"
          className="flex rounded-lg border border-line-strong p-0.5"
        >
          {(["modern", "classic"] as const).map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              aria-checked={headings === h}
              onClick={() => choose({ ...current, headings: h })}
              className={cx(
                "min-h-10 rounded-md px-4 text-[0.84rem]",
                headings === h ? "bg-gold/15 text-ink" : "text-muted hover:text-ink",
                h === "classic" && "font-[Cormorant_Garamond,Georgia,serif] text-[1rem]",
              )}
            >
              {h === "modern" ? "Modern" : "Classic"}
            </button>
          ))}
        </div>
      </div>
    </>
  );
  return bare ? (
    <div>
      {content}
      <div className="mt-3">{note}</div>
    </div>
  ) : (
    <Section title="Themes" action={note}>
      {content}
    </Section>
  );
}
