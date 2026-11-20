import { useCallback, useState } from "react";
import type { MotionLevel } from "../../lib/weatherScene";

/**
 * The home dashboard's settings for this screen (11-04): the clock, the page it opens on, how
 * much the weather moves, when it dims, and the Home page's widgets: which, in what order, and how
 * wide (11-05: a gallery of every widget a family might want; each screen picks its own).
 * Kept on this device, since each tablet hangs somewhere different; nothing here reaches Home
 * Assistant.
 */

export const PAGES = ["home", "rooms", "media", "security", "household"] as const;
export type Page = (typeof PAGES)[number];
export const PAGE_NAMES: Record<Page, string> = {
  home: "Home",
  rooms: "Rooms",
  media: "Media",
  security: "Security",
  household: "Household",
};

/** Every widget in the gallery, in the gallery's order. */
export const WIDGETS = [
  "music",
  "today",
  "lists",
  "status",
  "scenes",
  "devices",
  "climate",
  "cameras",
  "people",
  "doorbell",
  "energy",
  "travel",
  "photos",
  "chores",
  "reminders",
  "countdown",
  "notes",
  "news",
  "sports",
  "plants",
  "movienight",
] as const;
export type Widget = (typeof WIDGETS)[number];

export interface WidgetInfo {
  name: string;
  /** One line for the gallery. */
  blurb: string;
  group: "Everyday" | "Home" | "Family" | "Extras";
  /** Columns of twelve it takes on a wide screen. */
  span: number;
}

export const WIDGET_INFO: Record<Widget, WidgetInfo> = {
  music: {
    name: "Now Playing",
    blurb: "What's playing, with play, skip and volume.",
    group: "Everyday",
    span: 5,
  },
  today: {
    name: "Today",
    blurb: "Today's events from your calendars.",
    group: "Everyday",
    span: 4,
  },
  lists: {
    name: "Lists",
    blurb: "Groceries and to-dos, ticked off here.",
    group: "Everyday",
    span: 3,
  },
  status: {
    name: "Home Status",
    blurb: "Doors, lights, heating and cameras at a glance.",
    group: "Home",
    span: 7,
  },
  scenes: {
    name: "Scenes",
    blurb: "One tap for Movie night or Goodnight.",
    group: "Home",
    span: 5,
  },
  devices: {
    name: "Devices and Sensors",
    blurb: "Any switch, fan, plug or sensor you choose.",
    group: "Home",
    span: 4,
  },
  climate: {
    name: "Thermostat",
    blurb: "The temperature, warmer or cooler.",
    group: "Home",
    span: 4,
  },
  cameras: {
    name: "Cameras",
    blurb: "A picture from each camera, every few seconds.",
    group: "Home",
    span: 6,
  },
  people: { name: "Who's Home", blurb: "Who is home and who is out.", group: "Family", span: 4 },
  doorbell: {
    name: "Doorbell",
    blurb: "When it last rang, and the door camera.",
    group: "Home",
    span: 4,
  },
  energy: {
    name: "Energy",
    blurb: "Power now, and today's use and solar.",
    group: "Home",
    span: 4,
  },
  travel: { name: "Commute", blurb: "Drive time to work or school.", group: "Family", span: 4 },
  photos: { name: "Photo Frame", blurb: "Your own photos from Immich.", group: "Family", span: 6 },
  chores: {
    name: "Chores and Stars",
    blurb: "Repeating chores, with stars for who did them.",
    group: "Family",
    span: 4,
  },
  reminders: {
    name: "Reminders",
    blurb: "Bin day, watering the plants, anything that repeats.",
    group: "Family",
    span: 4,
  },
  countdown: {
    name: "Countdowns",
    blurb: "Days until the holiday or the birthday.",
    group: "Family",
    span: 4,
  },
  notes: { name: "Message Board", blurb: "Quick notes for the family.", group: "Family", span: 4 },
  news: {
    name: "News",
    blurb: "Headlines from the news feeds you choose.",
    group: "Extras",
    span: 6,
  },
  sports: {
    name: "Scores",
    blurb: "Your team's game, from Home Assistant.",
    group: "Extras",
    span: 4,
  },
  plants: { name: "Plants", blurb: "Which plants need water.", group: "Extras", span: 4 },
  movienight: {
    name: "Movie Night",
    blurb: "The next movie night: what, when, and who's coming.",
    group: "Family",
    span: 4,
  },
};
/** The old name lookup, for places that only need the name. */
export const WIDGET_NAMES = Object.fromEntries(
  WIDGETS.map((w) => [w, WIDGET_INFO[w].name]),
) as Record<Widget, string>;

/** What a new screen shows (the first five, the dashboard as it was). */
export const DEFAULT_SHOWN: Widget[] = ["music", "today", "lists", "status", "scenes"];
/** The widths a widget can be: from a quarter of the screen to all of it. */
export const SPANS = [3, 4, 5, 6, 7, 8, 12] as const;

export interface HomePrefs {
  clock: "words" | "12" | "24";
  start: Page;
  motion: MotionLevel;
  /** Minutes without a touch before a full-screen dashboard dims; 0 never. */
  dim: number;
  /** The Home page's widgets, in order. */
  shown: Widget[];
  /** Widths set by hand (columns of twelve). */
  spans: Partial<Record<Widget, number>>;
  /** The devices and sensors the Devices widget shows (Home Assistant entity ids). */
  devices: string[];
  /** When dimmed, show the photo frame instead of the clock. */
  idlePhotos: boolean;
  /** When the doorbell rings, show its camera over everything. */
  doorbellPopup: boolean;
}

export const DEFAULT_PREFS: HomePrefs = {
  clock: "words",
  start: "home",
  motion: "full",
  dim: 10,
  shown: [...DEFAULT_SHOWN],
  spans: {},
  devices: [],
  idlePhotos: false,
  doorbellPopup: true,
};

const KEY = "hearth.home-dashboard";
const isWidget = (w: unknown): w is Widget => (WIDGETS as readonly unknown[]).includes(w);

/** What was saved, checked field by field (an old or broken value falls back to the default). */
export function readPrefs(raw: string | null): HomePrefs {
  let v: Partial<HomePrefs> & { order?: unknown; hidden?: unknown };
  try {
    v = raw ? (JSON.parse(raw) as typeof v) : {};
  } catch {
    v = {};
  }
  let shown: Widget[];
  if (Array.isArray(v.shown)) shown = [...new Set(v.shown.filter(isWidget))];
  else if (Array.isArray(v.order)) {
    // Saved before the gallery (11-04): the five in their order, less the hidden ones.
    const hidden = Array.isArray(v.hidden) ? v.hidden : [];
    shown = [...new Set([...v.order.filter(isWidget), ...DEFAULT_SHOWN])].filter(
      (w) => !hidden.includes(w),
    );
  } else shown = [...DEFAULT_SHOWN];
  const spans: Partial<Record<Widget, number>> = {};
  if (v.spans && typeof v.spans === "object")
    for (const [w, n] of Object.entries(v.spans))
      if (isWidget(w) && (SPANS as readonly number[]).includes(Number(n))) spans[w] = Number(n);
  return {
    clock: v.clock === "12" || v.clock === "24" ? v.clock : "words",
    start: (PAGES as readonly string[]).includes(v.start ?? "") ? (v.start as Page) : "home",
    motion: v.motion === "lite" || v.motion === "off" ? v.motion : "full",
    dim: [0, 5, 10, 30].includes(Number(v.dim)) ? Number(v.dim) : 10,
    shown,
    spans,
    devices: Array.isArray(v.devices)
      ? v.devices
          .filter((e) => typeof e === "string" && /^[a-z_]+\.[a-z0-9_]+$/.test(e))
          .slice(0, 40)
      : [],
    idlePhotos: v.idlePhotos === true,
    doorbellPopup: v.doorbellPopup !== false,
  };
}

export function useHomePrefs() {
  const [prefs, setPrefs] = useState<HomePrefs>(() => {
    try {
      return readPrefs(window.localStorage.getItem(KEY));
    } catch {
      return DEFAULT_PREFS;
    }
  });
  const update = useCallback((change: Partial<HomePrefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...change };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private browsing: it lasts until the page reloads.
      }
      return next;
    });
  }, []);
  return [prefs, update] as const;
}

/** Moving a widget one place earlier (-1) or later (1) on the Home page. */
export function moveWidget(order: Widget[], w: Widget, step: -1 | 1): Widget[] {
  const i = order.indexOf(w);
  const j = i + step;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** A widget's width now. */
export const spanOf = (p: HomePrefs, w: Widget) => p.spans[w] ?? WIDGET_INFO[w].span;

/** One step wider (1) or narrower (-1). */
export function resize(p: HomePrefs, w: Widget, step: -1 | 1): Partial<Record<Widget, number>> {
  const i = SPANS.indexOf(spanOf(p, w) as (typeof SPANS)[number]);
  const at = i < 0 ? SPANS.indexOf(4) : i;
  const n = SPANS[Math.min(SPANS.length - 1, Math.max(0, at + step))]!;
  return { ...p.spans, [w]: n };
}
