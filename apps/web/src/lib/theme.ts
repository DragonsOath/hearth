import type { ThemeChoice, ThemePreset } from "@dragon-control/core";

/**
 * Themes: the whole app is drawn from a handful of color tokens (index.css @theme),
 * so a theme is just a set of values for them, set on <html>. Four built in, or your own: pick a
 * main color and a secondary color and the rest (backgrounds, panels, lines, text, the brighter
 * and deeper shades) is worked out from those two, keeping text readable.
 */

type Tokens = Record<string, string>;

interface Preset {
  name: string;
  blurb: string;
  /** The two colors it is built around, for the swatch (and to start a custom theme from). */
  primary: string;
  secondary: string;
  headings: "classic" | "modern";
  tokens: Tokens;
}

const SERIF = '"Cormorant Garamond", "Iowan Old Style", "Palatino Linotype", Georgia, serif';
const SANS = '"Inter Variable", ui-sans-serif, system-ui, sans-serif';

export const PRESETS: Record<Exclude<ThemePreset, "custom">, Preset> = {
  // The brand: ember and flame on midnight, warm white text (docs/brand). The default for anyone
  // who hasn't chosen a theme; a theme someone chose is never replaced by it.
  hearth: {
    name: "Hearth",
    blurb: "Midnight and charcoal, lit by ember orange, with warm white text.",
    primary: "#ff8a00",
    secondary: "#1a1a1a",
    headings: "modern",
    tokens: {
      bg: "#0b0f14",
      panel: "#121418",
      raised: "#1a1a1a",
      line: "#26262a",
      "line-strong": "#3a3633",
      ink: "#f6e6d7",
      muted: "#bcaea2",
      faint: "#998d83",
      gold: "#ff8a00",
      "gold-bright": "#ffa940",
      "gold-deep": "#c86a00",
      action: "#ff5a1f",
      "action-hover": "#ff7a45",
      "action-ink": "#1a0802",
      title: "#f6e6d7",
      accent: "#ff8a00",
    },
  },
  sapphire: {
    name: "Sapphire",
    blurb: "Deep navy and bright blue, with orange for the main action.",
    primary: "#3d8bff",
    secondary: "#e2ae4a",
    headings: "modern",
    tokens: {
      bg: "#070b14",
      panel: "#0d1321",
      raised: "#131b2c",
      line: "#1d2739",
      "line-strong": "#2b3953",
      ink: "#e6ebf4",
      muted: "#9ba8bd",
      faint: "#7e8aa0",
      gold: "#3d8bff",
      "gold-bright": "#6aa7ff",
      "gold-deep": "#2562c4",
      action: "#f5a623",
      "action-hover": "#ffb94a",
      "action-ink": "#14100a",
      title: "#e2ae4a",
      accent: "#e2ae4a",
    },
  },
  "dragon-gold": {
    name: "Dragon Gold",
    blurb: "The original: warm black, ivory, and champagne gold.",
    primary: "#c9a96e",
    secondary: "#121110",
    headings: "classic",
    tokens: {
      bg: "#0b0a09",
      panel: "#121110",
      raised: "#191715",
      line: "#26221d",
      "line-strong": "#3a342c",
      ink: "#ece6da",
      muted: "#a39b8e",
      faint: "#8c8478",
      gold: "#c9a96e",
      "gold-bright": "#e0c794",
      "gold-deep": "#8c7447",
      action: "#c9a96e",
      "action-hover": "#e0c794",
      "action-ink": "#0b0a09",
      title: "#c9a96e",
      accent: "#c9a96e",
    },
  },
  ember: {
    name: "Dragonfire",
    blurb: "Charcoal and dragonfire red, with warm gold titles.",
    primary: "#e2553f",
    secondary: "#e9b872",
    headings: "modern",
    tokens: {
      bg: "#0e0807",
      panel: "#170d0b",
      raised: "#1f1310",
      line: "#2e1d19",
      "line-strong": "#463029",
      ink: "#f1e6e2",
      muted: "#b8a29b",
      faint: "#9a857e",
      gold: "#e2553f",
      "gold-bright": "#f08a76",
      "gold-deep": "#a33828",
      action: "#e2553f",
      "action-hover": "#f08a76",
      "action-ink": "#1a0805",
      title: "#e9b872",
      accent: "#e9b872",
    },
  },
  verdant: {
    name: "Verdant",
    blurb: "Forest dark and emerald green.",
    primary: "#3fbf7f",
    secondary: "#d8c27a",
    headings: "modern",
    tokens: {
      bg: "#070d0a",
      panel: "#0c1611",
      raised: "#121f18",
      line: "#1b2c23",
      "line-strong": "#2a4235",
      ink: "#e4efe8",
      muted: "#9db3a6",
      faint: "#82998b",
      gold: "#3fbf7f",
      "gold-bright": "#72d9a3",
      "gold-deep": "#2a8a5a",
      action: "#3fbf7f",
      "action-hover": "#72d9a3",
      "action-ink": "#05170d",
      title: "#d8c27a",
      accent: "#d8c27a",
    },
  },
};

export const DEFAULT_THEME: ThemeChoice = { preset: "hearth" };

/* ---------- Color math (sRGB, enough for mixing and contrast) ---------- */

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hex = (c: number[]) =>
  `#${c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
/** `amount` of a, the rest b. */
export const mix = (a: string, b: string, amount: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x.map((v, i) => v * amount + y[i]! * (1 - amount)));
};
const luminance = (h: string) => {
  const [r, g, b] = rgb(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export const contrast = (a: string, b: string) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
};

/**
 * A full palette from your two colors (they lead a coordinated palette, they are not
 * the only colors). The main color carries highlights, selection, focus, borders, and links. A
 * bright secondary is the second accent: main buttons, titles, and page labels. A very dark
 * secondary (red and black) instead tints the backgrounds, and the main color takes both roles.
 * Status colors (green, amber, red) and chart and service colors are never changed by a theme.
 */
export function derive(primary: string, secondary: string): Tokens {
  const darkSecondary = luminance(secondary) < 0.04;
  const tone = darkSecondary ? secondary : primary;
  const share = darkSecondary ? 1 : 0.35;
  const t = (into: string, amount: number) => mix(tone, into, amount * share);
  const bg = t("#05060a", 0.2);
  // Colors too dark to see on the background are lifted until they read (3:1, like focus rings).
  const readable = (c: string) => {
    for (let i = 0; i < 12 && contrast(c, bg) < 3; i++) c = mix(c, "#ffffff", 0.8);
    return c;
  };
  const main = readable(primary);
  const second = darkSecondary ? main : readable(secondary);
  const dark = "#111214";
  const light = "#ffffff";
  return {
    bg,
    panel: t("#0e1016", 0.25),
    raised: t("#151821", 0.28),
    line: t("#232838", 0.35),
    "line-strong": t("#353c50", 0.4),
    ink: t("#eef0f4", 0.08),
    muted: t("#a3abb8", 0.15),
    faint: t("#8a92a0", 0.15),
    gold: main,
    "gold-bright": mix(main, "#ffffff", 0.7),
    "gold-deep": mix(main, "#000000", 0.65),
    action: second,
    "action-hover": mix(second, "#ffffff", 0.75),
    "action-ink": contrast(second, dark) >= contrast(second, light) ? dark : light,
    title: darkSecondary ? mix(main, "#ffffff", 0.7) : second,
    accent: darkSecondary ? mix(main, "#ffffff", 0.7) : second,
  };
}

export function tokensFor(choice: ThemeChoice): { tokens: Tokens; headings: "classic" | "modern" } {
  if (choice.preset === "custom") {
    const p = choice.primary ?? PRESETS.sapphire.primary;
    const s = choice.secondary ?? "#000000";
    return { tokens: derive(p, s), headings: choice.headings ?? "modern" };
  }
  const preset = PRESETS[choice.preset] ?? PRESETS.hearth;
  return { tokens: preset.tokens, headings: choice.headings ?? preset.headings };
}

const CACHE = "dc-theme";

/** Puts a theme on the whole app, now (and remembers it on this device for the next load). */
export function applyTheme(choice: ThemeChoice) {
  const { tokens, headings } = tokensFor(choice);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) {
    if (k === "title") root.style.setProperty("--talk-title", v);
    else root.style.setProperty(`--color-${k}`, v);
  }
  root.style.setProperty("--font-display", headings === "classic" ? SERIF : SANS);
  root.dataset.theme = choice.preset;
  // How service panels look (panels/brands.tsx); the plain look unless the owner chose another.
  root.dataset.panels = choice.panels ?? "minimal";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tokens.bg!);
  try {
    localStorage.setItem(CACHE, JSON.stringify(choice));
  } catch {
    /* private mode: it is still applied from your settings */
  }
}

/** The theme this device used last, so the first paint is already right. */
export function cachedTheme(): ThemeChoice {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE) ?? "null") as ThemeChoice | null;
    if (v && typeof v.preset === "string") return v;
  } catch {
    /* fall through */
  }
  return DEFAULT_THEME;
}
