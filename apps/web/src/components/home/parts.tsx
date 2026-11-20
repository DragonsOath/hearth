import { useEffect, useState, type ReactNode } from "react";
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  CloudDrizzle,
  Moon,
  Sun,
  Wind,
  type LucideIcon,
} from "lucide-react";
import type { HomeData, HomeTap } from "../../data/home";
import type { HomePrefs, Page } from "./homePrefs";
import type { ConnectFor } from "./ConnectDialog";

/** What every part of the home dashboard is handed. */
export interface Ctx {
  d: HomeData;
  tap: (t: HomeTap) => void;
  busy: boolean;
  askPin: (t: HomeTap, label: string, alarmCode: boolean) => void;
  /** Opens Connect; with `renew`, straight into that service's sign-in again. */
  connect: (f: ConnectFor, renew?: string) => void;
  /** Opens Add a speaker (this device, another computer, the speakers already known). */
  addSpeaker?: () => void;
  go: (p: Page) => void;
  prefs: HomePrefs;
  /** The Home page is being customized (widgets show their remove buttons). */
  editing?: boolean;
  /** Opens this widget's options (devices, feeds, album), when it has them. */
  configure?: () => void;
  /** The choices that last while moving between pages. */
  keep: {
    list?: string;
    setList: (e: string) => void;
    room?: string;
    setRoom: (r: string) => void;
    speaker?: string;
    setSpeaker: (e: string) => void;
  };
}

const WEATHER: Record<string, { icon: LucideIcon; words: string; tone?: string }> = {
  sunny: { icon: Sun, words: "Sunny", tone: "hd-wx-sun" },
  "clear-night": { icon: Moon, words: "Clear", tone: "hd-wx-cool" },
  partlycloudy: { icon: CloudSun, words: "Partly cloudy", tone: "hd-wx-sun" },
  cloudy: { icon: Cloud, words: "Cloudy", tone: "hd-wx-cool" },
  rainy: { icon: CloudRain, words: "Rain", tone: "hd-wx-cool" },
  pouring: { icon: CloudRain, words: "Heavy rain", tone: "hd-wx-cool" },
  snowy: { icon: CloudSnow, words: "Snow", tone: "hd-wx-cool" },
  "snowy-rainy": { icon: CloudSnow, words: "Sleet", tone: "hd-wx-cool" },
  lightning: { icon: CloudLightning, words: "Thunder", tone: "hd-wx-bolt" },
  "lightning-rainy": { icon: CloudLightning, words: "Thunderstorms", tone: "hd-wx-bolt" },
  fog: { icon: CloudFog, words: "Fog", tone: "hd-wx-cool" },
  windy: { icon: Wind, words: "Windy", tone: "hd-wx-cool" },
  "windy-variant": { icon: Wind, words: "Windy", tone: "hd-wx-cool" },
  hail: { icon: CloudSnow, words: "Hail", tone: "hd-wx-cool" },
  exceptional: { icon: CloudDrizzle, words: "Unusual weather", tone: "hd-wx-cool" },
};
/** The icon and words for a condition; after dark, a moon instead of the sun. */
export const weatherOf = (c?: string, night = false) => {
  if (night && c === "sunny") return { icon: Moon, words: "Clear", tone: "hd-wx-cool" };
  if (night && c === "partlycloudy")
    return { icon: CloudMoon, words: "Partly cloudy", tone: "hd-wx-cool" };
  return WEATHER[c ?? ""] ?? { icon: Cloud, words: c ?? "", tone: "hd-wx-cool" };
};

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Where the wind comes from, as a compass point. */
export const compass = (deg?: number) =>
  deg === undefined ? "" : COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** The time now, ticking (each second when asked, else every fifteen). */
export function useNow(everySecond = false) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), everySecond ? 1000 : 15_000);
    return () => window.clearInterval(t);
  }, [everySecond]);
  return now;
}

export const clockTime = (iso: string | undefined, tz: string | undefined, cycle: "12" | "24") =>
  iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
        hourCycle: cycle === "24" ? "h23" : "h12",
        ...(tz ? { timeZone: tz } : {}),
      })
    : "";

/** Seconds as 3:58. */
export const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Where the song is now: Home Assistant's last reading moved on by the time since. */
export function songPosition(p: HomeData["music"][number], now: Date) {
  if (p.position === undefined || !p.duration) return undefined;
  const since =
    p.state === "playing" && p.positionAt ? (now.getTime() - Date.parse(p.positionAt)) / 1000 : 0;
  return Math.min(p.duration, Math.max(0, p.position + Math.max(0, since)));
}

export function Panel({
  title,
  icon,
  action,
  children,
  className,
  testId,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId: string;
}) {
  return (
    <section className={`hd-glass ${className ?? ""}`} aria-label={title} data-testid={testId}>
      <div className="hd-h">
        {icon}
        <h3 style={{ fontSize: "inherit", fontWeight: "inherit" }}>{title}</h3>
        {action && <span className="hd-h-act">{action}</span>}
      </div>
      {children}
    </section>
  );
}

/** Locked, closed or armed: the home is shut. */
export const isSafe = (s: { state: string }) =>
  s.state === "locked" || s.state === "closed" || s.state.startsWith("armed");

export const SECURE_WORDS: Record<string, string> = {
  locked: "Locked",
  unlocked: "Unlocked",
  locking: "Locking",
  unlocking: "Unlocking",
  jammed: "Jammed",
  open: "Open",
  closed: "Closed",
  opening: "Opening",
  closing: "Closing",
  disarmed: "Off",
  armed_home: "On (home)",
  armed_away: "On (away)",
  armed_night: "On (night)",
  triggered: "Going off",
  pending: "Starting",
  arming: "Turning on",
  unavailable: "Not answering",
};
