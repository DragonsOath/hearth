import { VAULT_HTML } from "./wizarr-vault";

/**
 * Ready-made designs for Wizarr's invite steps (the guide people see when they open an
 * invitation), applied from the Wizarr panel's Settings, Wizard. Each design gives every media
 * server its own steps; a color theme recolors the whole design at once, and the owner's own
 * wording replaces its headings and intro. Wizarr fills in {{ server_name }} and
 * {{ external_url }} itself. A design is HTML and CSS only: Hearth adds no script to it.
 */

export type WizarrDesignCategory = "pre_invite" | "post_invite";

export interface WizarrDesignStep {
  /** Stable id within the design. */
  id: string;
  category: WizarrDesignCategory;
  title: string;
  /** The person must click a link on it before Next works. */
  requireInteraction: boolean;
  html: string;
}

export interface WizarrDesign {
  id: string;
  name: string;
  summary: string;
  /** Where it came from, shown with it. */
  source?: { label: string; url: string };
  /** Steps per media server type, in the order Wizarr shows them (before, then after). */
  servers: Record<string, { accent: string; steps: WizarrDesignStep[] }>;
}

export interface WizarrTheme {
  id: string;
  name: string;
  /** The hue (0 to 360) the design's main color moves to; absent keeps each server's own. */
  hue?: number;
  /** Colorless: every color keeps its lightness but loses most of its color. */
  mono?: boolean;
  /** A color to show on its swatch. */
  swatch: string;
}

export const WIZARR_THEMES: WizarrTheme[] = [
  { id: "original", name: "Original", swatch: "linear-gradient(135deg,#aa5cc3,#e5a00d)" },
  { id: "ember", name: "Ember", hue: 18, swatch: "#f05a1a" },
  { id: "gold", name: "Gold", hue: 42, swatch: "#e5a00d" },
  { id: "emerald", name: "Emerald", hue: 150, swatch: "#1fb877" },
  { id: "ocean", name: "Ocean", hue: 200, swatch: "#1a9be0" },
  { id: "royal", name: "Royal", hue: 268, swatch: "#8b5cf6" },
  { id: "rose", name: "Rose", hue: 335, swatch: "#e64a8c" },
  { id: "mono", name: "Mono", mono: true, swatch: "#8a8f98" },
];

const step = (
  id: string,
  category: WizarrDesignCategory,
  title: string,
  requireInteraction = false,
): WizarrDesignStep => ({ id, category, title, requireInteraction, html: VAULT_HTML[id]! });

export const WIZARR_DESIGNS: WizarrDesign[] = [
  {
    id: "vault",
    name: "Vault",
    summary:
      "Dark cards on a soft gradient, a progress bar, the server address with a copy button, and app choices.",
    source: {
      label: "wizarr-community-extras",
      url: "https://github.com/DragonsOath/wizarr-community-extras",
    },
    servers: {
      jellyfin: {
        accent: "#aa5cc3",
        steps: [
          step("jellyfin_1_welcome", "post_invite", "Welcome"),
          step("jellyfin_2_choose_app_and_connect", "post_invite", "Choose your app and connect"),
        ],
      },
      plex: {
        accent: "#e5a00d",
        steps: [
          step("plex_2_connect_account", "pre_invite", "Connect your Plex account", true),
          step("plex_1_welcome", "post_invite", "Welcome"),
        ],
      },
      audiobookshelf: {
        accent: "#d97706",
        steps: [
          step("audiobookshelf_1_welcome", "post_invite", "Welcome"),
          step("audiobookshelf_2_get_app_and_connect", "post_invite", "Get the app and connect"),
        ],
      },
    },
  },
];

/* ---------- Color ---------- */

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};

function rgbHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number];
}

/** How far a color may sit from the theme's own hue: enough for depth, never another color. */
const SPREAD = 32;

/**
 * One color moved by the theme. Each color keeps its lightness and strength and lands near the
 * theme's hue, keeping a little of how far it sat from the design's main color (so a two-tone
 * design stays two-tone, but its dark backgrounds never turn a clashing color). Greys, white and
 * black stay.
 */
function recolor(rgb: [number, number, number], theme: WizarrTheme, accentHue: number) {
  const [h, s, l] = rgbHsl(...rgb);
  if (s < 0.08) return rgb;
  if (theme.mono) return hslRgb(h, s * 0.12, l);
  const off = ((((h - accentHue) % 360) + 540) % 360) - 180;
  const near = Math.max(-SPREAD, Math.min(SPREAD, off * 0.35));
  return hslRgb((((theme.hue! + near) % 360) + 360) % 360, s, l);
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

/** Every color written in a step, hex or rgb(), in the order it appears. */
const COLOR =
  /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)/gi;

/** One color written in the theme; a color the theme leaves alone is kept exactly as written. */
function themeColor(token: string, theme: WizarrTheme, accentHue: number): string {
  if (theme.hue === undefined && !theme.mono) return token;
  if (token.startsWith("#")) {
    const was = hexRgb(token);
    const [r, g, b] = recolor(was, theme, accentHue);
    if (r === was[0] && g === was[1] && b === was[2]) return token;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const m = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*[\d.]+\s*)?\)/i.exec(
    token,
  )!;
  const was = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  const [r, g, b] = recolor(was, theme, accentHue);
  if (r === was[0] && g === was[1] && b === was[2]) return token;
  return m[4] ? `rgba(${r},${g},${b}${m[4].replace(/\s+/g, "")})` : `rgb(${r},${g},${b})`;
}

/** The design's HTML in a theme: every hex and rgb() color in it, moved together. */
export function themeHtml(html: string, accent: string, theme: WizarrTheme): string {
  if (theme.hue === undefined && !theme.mono) return html;
  const accentHue = rgbHsl(...hexRgb(accent))[0];
  return html.replace(COLOR, (t) => themeColor(t, theme, accentHue));
}

/* ---------- Recoloring a saved step ---------- */

/**
 * A step Hearth recolored keeps a note of its colors before the theme, inside its own style (a CSS
 * comment, never shown), so a later color change starts from the same colors and Original puts
 * them back exactly. Nothing else in the step depends on it.
 */
const MARK = /\/\* hearth-colors theme=(\S+) accent=(#[0-9a-f]{3,6}) colors=([^*]*) \*\/\n?/i;

/** A step made from a design (its look can be recolored without touching anything else). */
export const isDesignStep = (html: string) => /class="vault-shell"/.test(html);

function readMark(html: string) {
  const m = MARK.exec(html);
  if (!m) return { body: html };
  return {
    body: html.replace(MARK, ""),
    mark: { theme: m[1]!, accent: m[2]!, colors: m[3]!.split("|") },
  };
}

/** The color theme a saved step is in now (Original when Hearth never recolored it). */
export function stepTheme(html: string): string {
  const t = readMark(html).mark?.theme;
  return WIZARR_THEMES.some((x) => x.id === t) ? t! : "original";
}

/** A step's main color: the one the design names, or its most used strong color. */
function mainColor(html: string): string {
  const named = /--vault-purple:\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b/i.exec(html)?.[1];
  if (named) return named;
  const count = new Map<string, number>();
  for (const t of html.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) ?? []) {
    const [, s] = rgbHsl(...hexRgb(t));
    if (s >= 0.35) count.set(t.toLowerCase(), (count.get(t.toLowerCase()) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#aa5cc3";
}

/**
 * A step, saved or from a design, in a color theme with the owner's wording: only its colors and
 * the wording they changed are rewritten; its title, layout, links and every other word stay
 * exactly as they are.
 */
export function restyleStep(
  html: string,
  themeId: string,
  wording: Partial<Record<WizarrWordingField, string>> = {},
): string {
  const { body, mark } = readMark(html);
  const now = body.match(COLOR) ?? [];
  // The note only counts while the step still has the same colors (someone may have edited them).
  const before = mark && mark.colors.length === now.length ? mark.colors : now;
  const accent = mark && before === mark.colors ? mark.accent : mainColor(body);
  const theme = WIZARR_THEMES.find((t) => t.id === themeId) ?? WIZARR_THEMES[0]!;
  const accentHue = rgbHsl(...hexRgb(accent))[0];
  let i = 0;
  let out = body.replace(COLOR, () => themeColor(before[i++]!, theme, accentHue));
  const was = stepWording(out);
  for (const [key, value] of Object.entries(wording) as [WizarrWordingField, string][]) {
    if (value === undefined) continue;
    const words = value.trim().slice(0, 400);
    // An empty field, or words left as they were, keep the step's own.
    if (!words || words === (was[key] ?? "").trim()) continue;
    out = out.replace(
      WORDING[key],
      (_m, open: string, _old: string, close: string) => `${open}${escapeText(words)}${close}`,
    );
  }
  if (theme.hue === undefined && !theme.mono) return out;
  const note = `/* hearth-colors theme=${theme.id} accent=${accent} colors=${before.join("|")} */\n`;
  return /<style[^>]*>\n?/i.test(out)
    ? out.replace(/(<style[^>]*>\n?)/i, `$1${note}`)
    : `<style>${note}</style>${out}`;
}

/* ---------- Wording ---------- */

export type WizarrWordingField = "eyebrow" | "headline" | "intro";

export const WORDING_LABELS: Record<WizarrWordingField, string> = {
  eyebrow: "Small heading",
  headline: "Headline",
  intro: "Intro",
};

const WORDING: Record<WizarrWordingField, RegExp> = {
  // The small heading over the headline: vault-eyebrow in the design, vault-who in earlier copies.
  eyebrow: /(<(?:p|span) class="vault-(?:eyebrow|who)">)([\s\S]*?)(<\/(?:p|span)>)/,
  headline: /(<h1>)([\s\S]*?)(<\/h1>)/,
  intro: /(<p class="vault-lead">)([\s\S]*?)(<\/p>)/,
};

/** The wording a step starts with, as plain text (Wizarr's fill-ins kept as they are). */
export function stepWording(html: string): Partial<Record<WizarrWordingField, string>> {
  const out: Partial<Record<WizarrWordingField, string>> = {};
  for (const [key, re] of Object.entries(WORDING) as [WizarrWordingField, RegExp][]) {
    const m = re.exec(html);
    if (m) out[key] = unescapeText(m[2]!.replace(/<[^>]*>/g, "").trim());
  }
  return out;
}

const unescapeText = (t: string) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** The owner's words as safe HTML text: nothing they type can add markup or break the design. */
export const escapeText = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One design step, in a theme, with the owner's wording where they changed it. */
export function buildDesignStep(
  design: WizarrDesign,
  server: string,
  stepId: string,
  themeId: string,
  wording: Partial<Record<WizarrWordingField, string>> = {},
): string {
  const s = design.servers[server];
  const st = s?.steps.find((x) => x.id === stepId);
  if (!s || !st) throw new Error(`The ${design.name} design has no such step for ${server}.`);
  return restyleStep(st.html, themeId, wording);
}

const themeName = (id: string) => WIZARR_THEMES.find((t) => t.id === id)?.name ?? id;
const withoutColors = (html: string) => readMark(html).body.replace(COLOR, "");

/**
 * What an edit changes in a design step, for the approval card: its colors (from one theme to
 * another) and whether anything besides the colors changed.
 */
export function stepChange(
  before: string,
  after: string,
): { colors?: [string, string]; text: boolean } {
  const from = stepTheme(before);
  const to = stepTheme(after);
  const text = withoutColors(before) !== withoutColors(after);
  return {
    ...(from !== to ? { colors: [themeName(from), themeName(to)] as [string, string] } : {}),
    // Colors edited by hand, with no theme change, still count as a change to the text.
    text: text || (from === to && before !== after),
  };
}
