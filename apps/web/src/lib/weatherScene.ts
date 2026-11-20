/**
 * Which scene the home dashboard's window shows (11-04): from Home Assistant's weather
 * condition and whether the sun is up. Pure, so each condition's scene is tested.
 */

export type SceneKind =
  "clear" | "partly" | "cloudy" | "rain" | "heavy" | "storm" | "snow" | "fog" | "wind";

export interface Scene {
  kind: SceneKind;
  night: boolean;
  /** How much falls, 0 to 1 (rain or snow). */
  fall: number;
  /** How much cloud drifts across, 0 to 1. */
  cloud: number;
  /** Lightning now and then. */
  lightning: boolean;
  /** Stars show (a clear or partly cloudy night). */
  stars: boolean;
}

const KIND: Record<string, SceneKind> = {
  sunny: "clear",
  "clear-night": "clear",
  partlycloudy: "partly",
  cloudy: "cloudy",
  rainy: "rain",
  pouring: "heavy",
  "lightning-rainy": "storm",
  lightning: "storm",
  snowy: "snow",
  "snowy-rainy": "snow",
  hail: "snow",
  fog: "fog",
  windy: "wind",
  "windy-variant": "wind",
};

/** Night when Home Assistant says the sun is down; without sun.sun, by the home's clock. */
export function isNight(sunUp: boolean | undefined, hour: number): boolean {
  if (sunUp !== undefined) return !sunUp;
  return hour < 6 || hour >= 19;
}

export function sceneFor(condition: string | undefined, night: boolean): Scene {
  const kind = KIND[condition ?? ""] ?? (condition ? "cloudy" : "clear");
  const night2 = condition === "clear-night" ? true : night;
  return {
    kind,
    night: night2,
    fall:
      kind === "heavy"
        ? 1
        : kind === "storm"
          ? 0.85
          : kind === "rain"
            ? 0.55
            : kind === "snow"
              ? 0.6
              : 0,
    cloud:
      kind === "clear"
        ? 0
        : kind === "partly" || kind === "wind"
          ? 0.35
          : kind === "fog"
            ? 0.2
            : 0.8,
    lightning: kind === "storm",
    stars: night2 && (kind === "clear" || kind === "partly"),
  };
}

export type MotionLevel = "full" | "lite" | "off";

/** How many falling things for a window this size, at this quality. */
export function particleCount(scene: Scene, width: number, height: number, motion: MotionLevel) {
  if (!scene.fall) return 0;
  const per = scene.kind === "snow" ? 9000 : 2600;
  const n = Math.round(((width * height) / per) * scene.fall);
  return Math.min(motion === "lite" ? Math.round(n / 2.5) : n, 900);
}
