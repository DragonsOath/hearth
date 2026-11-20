import { speakerName } from "@dragon-control/core";
import { reachableAddress } from "./music-assistant-link";
import { AppKeyError, AppUnreachableError, joinUrl, TIMEOUT_MS, type Fetch } from "./http";
import type { SocketFactory, SocketLike } from "./homeassistant";

/**
 * The home dashboard (11-04): what a wall tablet shows. The time and weather, music players,
 * calendars, chore and grocery lists, lights by room, cameras, locks, garage doors and the alarm.
 *
 * The person at the screen acts directly, the way Home Assistant's own app works (11-04: a
 * tap is the decision; no approval card for a song or a grocery item). Only the actions in
 * HOME_ACTIONS below exist; anything else is refused. Opening a lock, a garage door or disarming
 * an alarm also needs the home's unlock PIN (checked by the caller, home-pin.ts). Ember never uses
 * this: its changes stay plans the owner approves.
 *
 * Connecting a service (a music service, a calendar, a list, weather) runs Home Assistant's own
 * setup flow, step by step, for the handlers in CONNECT_HANDLERS. A password or a client secret
 * the owner types passes straight to Home Assistant and is never kept, logged or shown.
 */

export interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
}

const domainOf = (id: string) => id.split(".")[0] ?? "";
const nameOf = (s: HaState) =>
  String(
    s.attributes?.friendly_name ?? s.entity_id.split(".")[1]?.replace(/_/g, " ") ?? s.entity_id,
  );

/** One request to Home Assistant with its token. */
async function ha<T>(
  fetchImpl: Fetch,
  base: string,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS * 2,
): Promise<{ ok: boolean; status: number; data: T }> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(joinUrl(base, path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.replaceAll(token, "[hidden]") : "no answer";
    throw new AppUnreachableError(`Home Assistant did not answer at ${base}: ${why}`);
  }
  if (res.status === 401)
    throw new AppKeyError(
      "Home Assistant refused the access token. Create a new one and replace it in the vault.",
    );
  const data = (await res.json().catch(() => null)) as T;
  return { ok: res.ok, status: res.status, data };
}

/** WebSocket commands the dashboard sends: registries (rooms) and an app's credentials. */
export const HOME_COMMANDS = [
  "config/area_registry/list",
  "config/entity_registry/list",
  "application_credentials/create",
  // The energy widget: Home Assistant's Energy dashboard sources and today's totals.
  "energy/get_prefs",
  // Speaker names: the device's own and owner-set names, its model and its room (11-13).
  "config/device_registry/list",
  "recorder/statistic_during_period",
  // The calendar page: deleting and changing an event (on Google Calendar and the rest).
  "calendar/event/delete",
  "calendar/event/update",
  // Its waiting "sign in again" setups: the old GET of /api/config/config_entries/flow answers 405.
  "config_entries/flow/progress",
] as const;
type HomeCommand = (typeof HOME_COMMANDS)[number];

async function wsCommands(
  socket: SocketFactory,
  base: string,
  token: string,
  asked: { type: HomeCommand; [k: string]: unknown }[],
): Promise<{ ok: boolean; result?: unknown; error?: string }[]> {
  for (const c of asked)
    if (!HOME_COMMANDS.includes(c.type)) throw new Error(`Not a command Hearth sends: ${c.type}`);
  const url = joinUrl(base.replace(/^http/, "ws"), "/api/websocket");
  return new Promise((resolve, reject) => {
    const out: { ok: boolean; result?: unknown; error?: string }[] = asked.map(() => ({
      ok: false,
      error: "no answer",
    }));
    let ws: SocketLike;
    try {
      ws = socket(url);
    } catch {
      return reject(new AppUnreachableError("Home Assistant's live connection could not open."));
    }
    let pending = asked.length;
    const timer = setTimeout(() => {
      ws.close();
      resolve(out);
    }, TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      ws.close();
      resolve(out);
    };
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new AppUnreachableError("Home Assistant's live connection failed."));
    });
    ws.addEventListener("message", (ev) => {
      let m: {
        type?: string;
        id?: number;
        success?: boolean;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "auth_required")
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (m.type === "auth_invalid") {
        clearTimeout(timer);
        ws.close();
        reject(new AppKeyError("Home Assistant refused the access token."));
      } else if (m.type === "auth_ok") {
        if (!pending) return done();
        asked.forEach((c, i) => ws.send(JSON.stringify({ ...c, id: i + 1 })));
      } else if (m.type === "result" && typeof m.id === "number") {
        out[m.id - 1] = m.success
          ? { ok: true, result: m.result }
          : { ok: false, error: m.error?.message ?? "refused" };
        if (--pending === 0) done();
      }
    });
  });
}

/* ------------------------------------------------ reading ------------------------------------------------ */

/** When an event starts, for ordering: an all-day one at the start of its day. */
const when = (e: { start: string; allDay: boolean }) =>
  Date.parse(e.allDay ? `${e.start}T00:00:00` : e.start) || 0;

export interface HomeView {
  place: { name: string; timeZone?: string; tempUnit: string };
  weather?: {
    entity: string;
    name: string;
    condition: string;
    temperature?: number;
    humidity?: number;
    wind?: number;
    windUnit?: string;
    /** Where the wind comes from, in degrees. */
    windBearing?: number;
    feelsLike?: number;
    /** The chance of rain in the coming hour, when Home Assistant has an hourly forecast. */
    rainChance?: number;
    unit: string;
    forecast: { date: string; condition?: string; high?: number; low?: number; rain?: number }[];
    hourly: { time: string; condition?: string; temperature?: number; rain?: number }[];
    /** Where the weather comes from: "National Weather Service", "Open-Meteo", Home Assistant. */
    sourceName?: string;
    /** The place it is for ("Hesperia, CA"). */
    placeName?: string;
  };
  /** More places' weather, small (11-05: "multiple locations ... make it like smaller"). */
  cities?: {
    label: string;
    condition: string;
    temperature?: number;
    high?: number;
    low?: number;
    unit: string;
  }[];
  /** The sun (Home Assistant's sun.sun), for day and night and the sunrise and sunset times. */
  sun?: { up: boolean; rising?: string; setting?: string };
  music: {
    entity: string;
    /** What Hearth calls it: the owner's own name for it, else the friendly name (speakers.ts). */
    name: string;
    /** The name before any the owner gave it in Hearth. */
    originalName: string;
    /** What Home Assistant reports, which Music Assistant knows it by. */
    systemName: string;
    /** The owner renamed it in Hearth. */
    renamed?: true;
    state: string;
    musicAssistant?: true;
    /** Its Music Assistant queue (Home Assistant's active_queue), for Up Next. */
    queue?: string;
    /** A Google Cast device: it can play a YouTube video itself (Watch on TV). */
    cast?: true;
    title?: string;
    artist?: string;
    album?: string;
    app?: string;
    picture: boolean;
    volume?: number;
    muted?: boolean;
    source?: string;
    sources: string[];
    /** Where the song is: seconds in, how long it is, and when Home Assistant read that. */
    position?: number;
    duration?: number;
    positionAt?: string;
    shuffle?: boolean;
    repeat?: string;
    /** What is playing is a video (Home Assistant's media_content_type). */
    video: boolean;
    can: {
      shuffle: boolean;
      repeat: boolean;
      pause: boolean;
      next: boolean;
      previous: boolean;
      volume: boolean;
      source: boolean;
      power: boolean;
    };
  }[];
  calendars: { entity: string; name: string }[];
  /**
   * Calendars Home Assistant has but can't read right now (11-18: a Google sign-in Google stopped
   * accepting left every calendar "unavailable", and the card said "No calendars yet").
   */
  calendarsDown?: number;
  /**
   * Services waiting for the owner to sign in again (Home Assistant's own "reauth" setups): the
   * card says so, and Connect continues that setup instead of starting a new one.
   */
  signInAgain?: { handler: string; label: string; for: string }[];
  /** Services whose calendars can't be read with no sign-in waiting: Connect can ask afresh. */
  calendarsDownFor?: { handler: string; label: string; for: string }[];
  /** Home Assistant's own address in a browser, when something there needs the owner. */
  homeAddress?: string;
  events: {
    calendar: string;
    title: string;
    start: string;
    end?: string;
    allDay: boolean;
    location?: string;
  }[];
  lists: {
    entity: string;
    name: string;
    items: { uid: string; summary: string; done: boolean; due?: string }[];
  }[];
  rooms: {
    name: string;
    controls: { entity: string; name: string; kind: string; on: boolean; brightness?: number }[];
  }[];
  cameras: { entity: string; name: string; state: string }[];
  security: {
    entity: string;
    name: string;
    kind: "lock" | "garage" | "alarm";
    state: string;
    /** For an alarm: Home Assistant asks for its own code too. */
    needsCode?: boolean;
  }[];
  scenes: { entity: string; name: string }[];
  climate: {
    entity: string;
    name: string;
    room?: string;
    mode: string;
    modes: string[];
    /** heating, cooling, idle, off (what it is doing right now). */
    action?: string;
    current?: number;
    target?: number;
    min?: number;
    max?: number;
    step?: number;
  }[];
  /** Home Assistant's people, home or away (or the zone they are in). */
  people: { entity: string; name: string; state: string; picture: boolean; since?: string }[];
  /** Travel time sensors (Waze, Google Maps, HERE): minutes to somewhere, by car. */
  travel: {
    entity: string;
    name: string;
    minutes?: number;
    origin?: string;
    destination?: string;
    route?: string;
    distance?: number;
  }[];
  /** Doorbells: when each last rang, and the camera on the same device. */
  doorbells: { entity: string; name: string; last?: string; camera?: string }[];
  /** Plants (Home Assistant's plant integration) and soil moisture sensors. */
  plants: { entity: string; name: string; state: string; problem?: string; moisture?: number }[];
  /** Sports scores (the TeamTracker integration). */
  sports: {
    entity: string;
    name: string;
    state: string;
    league?: string;
    team?: string;
    opponent?: string;
    teamScore?: string;
    opponentScore?: string;
    date?: string;
    clock?: string;
  }[];
  /** Bin collection days (the Waste Collection Schedule integration). */
  waste: { entity: string; name: string; state: string; days?: number; types?: string[] }[];
  /** Today's energy from Home Assistant's Energy dashboard, in kWh, and the power now. */
  energy?: {
    unit: "kWh";
    grid?: number;
    returned?: number;
    solar?: number;
    gas?: number;
    gasUnit?: string;
    powerNow?: number;
  };
  /** The devices and sensors this screen's Devices widget shows (asked for by entity). */
  devices: Device[];
  /** Everything a Devices widget can show, when asked (choosing what to add). */
  catalog?: Device[];
}

export interface Device {
  entity: string;
  name: string;
  room?: string;
  kind: string;
  state: string;
  unit?: string;
  deviceClass?: string;
  /** A switch, light, fan or helper toggle the widget can flip. */
  toggle: boolean;
}

/** What a Devices widget can show: sensors, and things that switch on and off. */
const DEVICE_DOMAINS = new Set([
  "sensor",
  "binary_sensor",
  "light",
  "switch",
  "fan",
  "input_boolean",
  "cover",
]);
const TOGGLES = new Set(["light", "switch", "fan", "input_boolean"]);
const TRAVEL_PLATFORMS = new Set(["waze_travel_time", "google_travel_time", "here_travel_time"]);

/** Today's energy, read again at most every five minutes (the totals move slowly). */
const energyCache = new Map<string, { at: number; value: HomeView["energy"] }>();

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// media_player supported_features bits (Home Assistant's MediaPlayerEntityFeature).
const MP = {
  PAUSE: 1,
  VOLUME_SET: 4,
  VOLUME_MUTE: 8,
  PREVIOUS: 16,
  NEXT: 32,
  TURN_ON: 128,
  TURN_OFF: 256,
  SELECT_SOURCE: 2048,
  PLAY: 16384,
  SHUFFLE_SET: 32768,
  REPEAT_SET: 262144,
};

/** Garage doors and gates among covers (their device class). */
const isGarage = (s: HaState) =>
  domainOf(s.entity_id) === "cover" &&
  ["garage", "gate"].includes(String(s.attributes?.device_class));

export async function readHome(
  fetchImpl: Fetch,
  base: string,
  token: string,
  socket: SocketFactory,
  /** The entities a Devices widget shows, and whether to list everything it could. */
  opts: { watch?: string[]; catalog?: boolean } = {},
  now = new Date(),
): Promise<HomeView> {
  const [config, statesR] = await Promise.all([
    ha<{
      location_name?: string;
      time_zone?: string;
      unit_system?: { temperature?: string };
      internal_url?: string | null;
      external_url?: string | null;
    }>(fetchImpl, base, token, "GET", "/api/config"),
    ha<HaState[]>(fetchImpl, base, token, "GET", "/api/states"),
  ]);
  if (!statesR.ok)
    throw new AppUnreachableError(`Home Assistant answered ${statesR.status} for its states.`);
  const calendarsDown = (statesR.data ?? []).filter(
    (s) => domainOf(s.entity_id) === "calendar" && s.state === "unavailable",
  ).length;
  const signInAgain = await pendingSignIns(socket, base, token);
  const states = (statesR.data ?? []).filter(
    (s) => s.state !== "unavailable" || domainOf(s.entity_id) === "lock",
  );
  const of = (d: string) => states.filter((s) => domainOf(s.entity_id) === d);
  const [reg] = await wsCommands(socket, base, token, [
    { type: "config/area_registry/list" },
    { type: "config/entity_registry/list" },
    { type: "energy/get_prefs" },
    { type: "config/device_registry/list" },
  ])
    .then((r) => [r])
    .catch(() => [[] as { ok: boolean; result?: unknown }[]]);
  const areas = new Map(
    ((reg?.[0]?.result ?? []) as { area_id: string; name: string }[]).map((a) => [
      a.area_id,
      a.name,
    ]),
  );
  const entities = new Map(
    (
      (reg?.[1]?.result ?? []) as {
        entity_id: string;
        area_id?: string | null;
        hidden_by?: string | null;
        disabled_by?: string | null;
        entity_category?: string | null;
        platform?: string;
        device_id?: string | null;
        name?: string | null;
      }[]
    ).map((e) => [e.entity_id, e]),
  );
  // Calendars down with no sign-in waiting (it was thrown away, 11-18): which service they are
  // from, so the card can still offer to sign in again (Connect reloads it to ask afresh).
  const downFor = [
    ...new Set(
      (statesR.data ?? [])
        .filter((s) => domainOf(s.entity_id) === "calendar" && s.state === "unavailable")
        .map((s) => entities.get(s.entity_id)?.platform ?? "")
        .filter((h) => CONNECT_HANDLERS[h]?.for === "calendar"),
    ),
  ]
    .filter((h) => !signInAgain.some((x) => x.handler === h))
    .map((h) => ({ handler: h, label: CONNECT_HANDLERS[h]!.label, for: "calendar" }));
  const deviceReg = new Map(
    (
      (reg?.[3]?.result ?? []) as {
        id: string;
        name?: string | null;
        name_by_user?: string | null;
        model?: string | null;
        manufacturer?: string | null;
        area_id?: string | null;
      }[]
    ).map((d) => [d.id, d]),
  );
  /** A speaker's name: what the home already calls it, never a model number or an address. */
  const speakerNameOf = (s: HaState) => {
    const e = entities.get(s.entity_id);
    const d = e?.device_id ? deviceReg.get(e.device_id) : undefined;
    return speakerName({
      entityId: s.entity_id,
      friendly: typeof s.attributes?.friendly_name === "string" ? s.attributes.friendly_name : null,
      registryName: e?.name ?? null,
      deviceNameByUser: d?.name_by_user ?? null,
      deviceName: d?.name ?? null,
      model: d?.model ?? null,
      manufacturer: d?.manufacturer ?? null,
      area: areas.get(e?.area_id ?? d?.area_id ?? "") ?? null,
    });
  };
  const shown = (s: HaState) => {
    const e = entities.get(s.entity_id);
    return !e || (!e.hidden_by && !e.disabled_by && !e.entity_category);
  };

  // Weather: Home Assistant's own forecast (the home's, first).
  const weathers = of("weather").filter(shown);
  const w = weathers.find((x) => x.entity_id === "weather.forecast_home") ?? weathers[0];
  let weather: HomeView["weather"];
  if (w) {
    const forecastOf = async (type: "daily" | "hourly") => {
      const f = await ha<{
        service_response?: Record<string, { forecast?: Record<string, unknown>[] }>;
      }>(fetchImpl, base, token, "POST", "/api/services/weather/get_forecasts?return_response", {
        entity_id: w.entity_id,
        type,
      }).catch(() => undefined);
      return f?.ok ? (f.data?.service_response?.[w.entity_id]?.forecast ?? []) : [];
    };
    // Not every weather service has an hourly forecast; then there is none, nothing made up.
    const [list, hours] = await Promise.all([forecastOf("daily"), forecastOf("hourly")]);
    const hourly = hours
      .filter((h) => Date.parse(String(h.datetime ?? "")) > now.getTime() - 60 * 60_000)
      .slice(0, 8)
      .map((h) => ({
        time: String(h.datetime ?? ""),
        condition: typeof h.condition === "string" ? h.condition : undefined,
        temperature: num(h.temperature),
        rain: num(h.precipitation_probability),
      }));
    weather = {
      entity: w.entity_id,
      name: nameOf(w),
      condition: w.state,
      temperature: num(w.attributes?.temperature),
      humidity: num(w.attributes?.humidity),
      wind: num(w.attributes?.wind_speed),
      windUnit:
        typeof w.attributes?.wind_speed_unit === "string"
          ? w.attributes.wind_speed_unit
          : undefined,
      windBearing: num(w.attributes?.wind_bearing),
      feelsLike: num(w.attributes?.apparent_temperature),
      rainChance: hourly[0]?.rain,
      hourly,
      unit: String(w.attributes?.temperature_unit ?? config.data?.unit_system?.temperature ?? "°C"),
      forecast: list.slice(0, 6).map((d) => ({
        date: String(d.datetime ?? ""),
        condition: typeof d.condition === "string" ? d.condition : undefined,
        high: num(d.temperature),
        low: num(d.templow),
        rain: num(d.precipitation_probability),
      })),
    };
  }

  const music = of("media_player")
    .filter(shown)
    .map((s) => {
      const f = Number(s.attributes?.supported_features ?? 0);
      const a = s.attributes ?? {};
      const name = speakerNameOf(s);
      return {
        entity: s.entity_id,
        name,
        // The name before any the owner gave it in Hearth (Reset name; Music Assistant's queue).
        originalName: name,
        // What Home Assistant itself reports: Music Assistant finds its queue by that name.
        systemName: nameOf(s),
        state: s.state,
        // A Music Assistant speaker: it can play from the music library and start mixes.
        ...(entities.get(s.entity_id)?.platform === "music_assistant"
          ? {
              musicAssistant: true as const,
              ...(typeof a.active_queue === "string" ? { queue: a.active_queue } : {}),
            }
          : {}),
        // A Google Cast device (an Android TV, a Chromecast): it can play a YouTube video itself.
        ...(entities.get(s.entity_id)?.platform === "cast" ? { cast: true as const } : {}),
        title: typeof a.media_title === "string" ? a.media_title : undefined,
        artist: typeof a.media_artist === "string" ? a.media_artist : undefined,
        album: typeof a.media_album_name === "string" ? a.media_album_name : undefined,
        app: typeof a.app_name === "string" ? a.app_name : undefined,
        picture: typeof a.entity_picture === "string",
        volume:
          num(a.volume_level) !== undefined ? Math.round(num(a.volume_level)! * 100) : undefined,
        muted: typeof a.is_volume_muted === "boolean" ? a.is_volume_muted : undefined,
        source: typeof a.source === "string" ? a.source : undefined,
        // An Android TV lists its internal app packages (com.android.systemui); people pick apps.
        sources: Array.isArray(a.source_list)
          ? (a.source_list as unknown[])
              .map(String)
              .filter((x) => !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){2,}$/i.test(x))
              .slice(0, 40)
          : [],
        position: num(a.media_position),
        duration: num(a.media_duration),
        positionAt:
          typeof a.media_position_updated_at === "string" ? a.media_position_updated_at : undefined,
        shuffle: typeof a.shuffle === "boolean" ? a.shuffle : undefined,
        repeat: typeof a.repeat === "string" ? a.repeat : undefined,
        video: ["video", "movie", "tvshow", "episode", "musicvideo"].includes(
          String(a.media_content_type),
        ),
        can: {
          shuffle: Boolean(f & MP.SHUFFLE_SET),
          repeat: Boolean(f & MP.REPEAT_SET),
          pause: Boolean(f & (MP.PAUSE | MP.PLAY)),
          next: Boolean(f & MP.NEXT),
          previous: Boolean(f & MP.PREVIOUS),
          volume: Boolean(f & MP.VOLUME_SET),
          source: Boolean(f & MP.SELECT_SOURCE),
          power: Boolean(f & (MP.TURN_ON | MP.TURN_OFF)),
        },
      };
    })
    // What is playing first, Music Assistant's own speaker before the device it casts to (it has
    // the song and its art, also when paused); then paused, then Music Assistant's, then the rest.
    .sort((a, b) => {
      const rank = (m: { state: string; musicAssistant?: true }) =>
        (m.state === "playing" ? 8 : m.state === "paused" ? 4 : 0) + (m.musicAssistant ? 2 : 0);
      return rank(b) - rank(a) || a.name.localeCompare(b.name);
    });

  // Calendars: the next 7 days of every calendar, in one list.
  const calendars = of("calendar").filter(shown).slice(0, 8);
  const start = new Date(now.getTime() - 60 * 60_000).toISOString();
  const end = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const events = (
    await Promise.all(
      calendars.map(async (c) => {
        const r = await ha<
          {
            summary?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            location?: string;
          }[]
        >(
          fetchImpl,
          base,
          token,
          "GET",
          `/api/calendars/${encodeURIComponent(c.entity_id)}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        ).catch(() => undefined);
        return (r?.ok && Array.isArray(r.data) ? r.data : []).map((e) => ({
          calendar: nameOf(c),
          title: String(e.summary ?? "Busy"),
          start: String(e.start?.dateTime ?? e.start?.date ?? ""),
          end: e.end?.dateTime ?? e.end?.date,
          allDay: Boolean(e.start?.date && !e.start.dateTime),
          ...(e.location ? { location: e.location } : {}),
        }));
      }),
    )
  )
    .flat()
    .filter((e) => e.start)
    .sort((a, b) => when(a) - when(b))
    .slice(0, 40);

  // To-do lists (chores, groceries): their items.
  const todos = of("todo").filter(shown).slice(0, 10);
  const items = todos.length
    ? await ha<{
        service_response?: Record<
          string,
          { items?: { uid?: string; summary?: string; status?: string; due?: string }[] }
        >;
      }>(fetchImpl, base, token, "POST", "/api/services/todo/get_items?return_response", {
        entity_id: todos.map((t) => t.entity_id),
      }).catch(() => undefined)
    : undefined;
  const lists = todos.map((t) => ({
    entity: t.entity_id,
    name: nameOf(t),
    items: (items?.data?.service_response?.[t.entity_id]?.items ?? [])
      .filter((i) => i.uid && i.summary)
      .map((i) => ({
        uid: i.uid!,
        summary: i.summary!,
        done: i.status === "completed",
        ...(i.due ? { due: i.due } : {}),
      })),
  }));

  // Lights, switches and fans, by the room Home Assistant puts them in.
  const byRoom = new Map<string, HomeView["rooms"][number]["controls"]>();
  for (const s of [...of("light"), ...of("switch"), ...of("fan")].filter(shown)) {
    const room = areas.get(entities.get(s.entity_id)?.area_id ?? "") ?? "Other";
    const b = num(s.attributes?.brightness);
    byRoom.set(room, [
      ...(byRoom.get(room) ?? []),
      {
        entity: s.entity_id,
        name: nameOf(s),
        kind: domainOf(s.entity_id),
        on: s.state === "on",
        ...(b !== undefined ? { brightness: Math.round((b / 255) * 100) } : {}),
      },
    ]);
  }
  const rooms = [...byRoom.entries()]
    .map(([name, controls]) => ({
      name,
      controls: controls.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) =>
      a.name === "Other" ? 1 : b.name === "Other" ? -1 : a.name.localeCompare(b.name),
    );

  const security: HomeView["security"] = [
    ...of("lock")
      .filter(shown)
      .map((s) => ({
        entity: s.entity_id,
        name: nameOf(s),
        kind: "lock" as const,
        state: s.state,
      })),
    ...states
      .filter(isGarage)
      .filter(shown)
      .map((s) => ({
        entity: s.entity_id,
        name: nameOf(s),
        kind: "garage" as const,
        state: s.state,
      })),
    ...of("alarm_control_panel")
      .filter(shown)
      .map((s) => ({
        entity: s.entity_id,
        name: nameOf(s),
        kind: "alarm" as const,
        state: s.state,
        needsCode: Boolean(s.attributes?.code_format),
      })),
  ];

  const sunState = states.find((s) => s.entity_id === "sun.sun");
  const areaOf = (id: string) => areas.get(entities.get(id)?.area_id ?? "");
  const climate: HomeView["climate"] = of("climate")
    .filter(shown)
    .map((s) => {
      const a = s.attributes ?? {};
      const room = areaOf(s.entity_id);
      return {
        entity: s.entity_id,
        name: nameOf(s),
        ...(room ? { room } : {}),
        mode: s.state,
        modes: Array.isArray(a.hvac_modes) ? (a.hvac_modes as unknown[]).map(String) : [],
        action: typeof a.hvac_action === "string" ? a.hvac_action : undefined,
        current: num(a.current_temperature),
        target: num(a.temperature),
        min: num(a.min_temp),
        max: num(a.max_temp),
        step: num(a.target_temp_step),
      };
    });

  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const platformOf = (id: string) => entities.get(id)?.platform;

  const people: HomeView["people"] = of("person")
    .filter(shown)
    .map((s) => ({
      entity: s.entity_id,
      name: nameOf(s),
      state: s.state,
      picture: String(s.attributes?.entity_picture ?? "").startsWith("/api/"),
      ...(s.last_changed ? { since: s.last_changed } : {}),
    }));

  const travel: HomeView["travel"] = of("sensor")
    .filter((s) => TRAVEL_PLATFORMS.has(platformOf(s.entity_id) ?? ""))
    .filter(shown)
    .map((s) => {
      const a = s.attributes ?? {};
      const minutes = Number(s.state);
      return {
        entity: s.entity_id,
        name: nameOf(s),
        ...(Number.isFinite(minutes) ? { minutes: Math.round(minutes) } : {}),
        ...(str(a.origin) ? { origin: str(a.origin) } : {}),
        ...(str(a.destination) ? { destination: str(a.destination) } : {}),
        ...(str(a.route) ? { route: str(a.route) } : {}),
        ...(num(a.distance) !== undefined ? { distance: num(a.distance) } : {}),
      };
    });

  // A doorbell: an event entity of the doorbell class (its state is when it last rang), or a
  // doorbell button sensor. Its camera is the one on the same device, when there is one.
  const deviceOf = (id: string) => entities.get(id)?.device_id ?? undefined;
  const cameraOn = (id: string) => {
    const dev = deviceOf(id);
    return dev ? of("camera").find((c) => deviceOf(c.entity_id) === dev)?.entity_id : undefined;
  };
  const doorbells: HomeView["doorbells"] = [
    ...of("event")
      .filter((s) => s.attributes?.device_class === "doorbell")
      .filter(shown)
      .map((s) => ({
        entity: s.entity_id,
        name: nameOf(s),
        ...(Date.parse(s.state) ? { last: s.state } : {}),
        ...(cameraOn(s.entity_id) ? { camera: cameraOn(s.entity_id) } : {}),
      })),
    ...of("binary_sensor")
      .filter((s) => /doorbell|ding/.test(s.entity_id))
      .filter(shown)
      .map((s) => ({
        entity: s.entity_id,
        name: nameOf(s),
        ...(s.state === "on" && s.last_changed ? { last: s.last_changed } : {}),
        ...(cameraOn(s.entity_id) ? { camera: cameraOn(s.entity_id) } : {}),
      })),
  ];

  const plants: HomeView["plants"] = [
    ...of("plant")
      .filter(shown)
      .map((s) => ({
        entity: s.entity_id,
        name: nameOf(s),
        state: s.state,
        ...(str(s.attributes?.problem) && s.attributes?.problem !== "none"
          ? { problem: str(s.attributes?.problem) }
          : {}),
        ...(num(s.attributes?.moisture) !== undefined
          ? { moisture: num(s.attributes?.moisture) }
          : {}),
      })),
    ...of("sensor")
      .filter((s) => s.attributes?.device_class === "moisture")
      .filter(shown)
      .map((s) => ({
        entity: s.entity_id,
        name: nameOf(s),
        state: s.state,
        ...(Number.isFinite(Number(s.state)) ? { moisture: Number(s.state) } : {}),
      })),
  ];

  const sports: HomeView["sports"] = of("sensor")
    .filter((s) => platformOf(s.entity_id) === "teamtracker")
    .filter(shown)
    .map((s) => {
      const a = s.attributes ?? {};
      const score = (v: unknown) =>
        typeof v === "number" || (typeof v === "string" && v) ? String(v) : undefined;
      return {
        entity: s.entity_id,
        name: nameOf(s),
        state: s.state,
        ...(str(a.league) ? { league: str(a.league) } : {}),
        ...(str(a.team_name) ? { team: str(a.team_name) } : {}),
        ...(str(a.opponent_name) ? { opponent: str(a.opponent_name) } : {}),
        ...(score(a.team_score) ? { teamScore: score(a.team_score) } : {}),
        ...(score(a.opponent_score) ? { opponentScore: score(a.opponent_score) } : {}),
        ...(str(a.date) ? { date: str(a.date) } : {}),
        ...(str(a.clock) ? { clock: str(a.clock) } : {}),
      };
    });

  const waste: HomeView["waste"] = of("sensor")
    .filter((s) => platformOf(s.entity_id) === "waste_collection_schedule")
    .filter(shown)
    .map((s) => {
      const a = s.attributes ?? {};
      const days = num(a.daysTo);
      const types = Array.isArray(a.types) ? (a.types as unknown[]).map(String) : undefined;
      return {
        entity: s.entity_id,
        name: nameOf(s),
        state: s.state,
        ...(days !== undefined ? { days } : {}),
        ...(types?.length ? { types } : {}),
      };
    });

  const deviceOfState = (s: HaState): Device => {
    const d = domainOf(s.entity_id);
    const room = areaOf(s.entity_id);
    return {
      entity: s.entity_id,
      name: nameOf(s),
      ...(room ? { room } : {}),
      kind: d,
      state: s.state,
      ...(str(s.attributes?.unit_of_measurement)
        ? { unit: str(s.attributes?.unit_of_measurement) }
        : {}),
      ...(str(s.attributes?.device_class) ? { deviceClass: str(s.attributes?.device_class) } : {}),
      toggle: TOGGLES.has(d),
    };
  };
  const canShow = (s: HaState) =>
    DEVICE_DOMAINS.has(domainOf(s.entity_id)) &&
    !(domainOf(s.entity_id) === "cover" && isGarage(s));
  const watch = new Set((opts.watch ?? []).slice(0, 40));
  const devices = states.filter((s) => watch.has(s.entity_id) && canShow(s)).map(deviceOfState);
  const catalog = opts.catalog
    ? states
        .filter(canShow)
        .filter(shown)
        .map(deviceOfState)
        // Devices with a room first, by room, then the rest.
        .sort(
          (a, b) =>
            Number(!a.room) - Number(!b.room) ||
            (a.room ?? "").localeCompare(b.room ?? "") ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 500)
    : undefined;

  const energy = await readEnergy(
    socket,
    base,
    token,
    (reg?.[2]?.ok ? reg[2].result : undefined) as EnergyPrefs | undefined,
    states,
    now,
  ).catch(() => undefined);

  return {
    people,
    travel,
    doorbells,
    plants,
    sports,
    waste,
    ...(energy ? { energy } : {}),
    devices,
    ...(catalog ? { catalog } : {}),
    ...(sunState
      ? {
          sun: {
            up: sunState.state === "above_horizon",
            ...(typeof sunState.attributes?.next_rising === "string"
              ? { rising: sunState.attributes.next_rising }
              : {}),
            ...(typeof sunState.attributes?.next_setting === "string"
              ? { setting: sunState.attributes.next_setting }
              : {}),
          },
        }
      : {}),
    climate,
    place: {
      name: config.data?.location_name ?? "Home",
      ...(config.data?.time_zone ? { timeZone: config.data.time_zone } : {}),
      tempUnit: config.data?.unit_system?.temperature ?? "°C",
    },
    ...(weather ? { weather } : {}),
    music,
    calendars: calendars.map((c) => ({ entity: c.entity_id, name: nameOf(c) })),
    ...(calendarsDown ? { calendarsDown } : {}),
    ...(signInAgain.length ? { signInAgain } : {}),
    ...(downFor.length ? { calendarsDownFor: downFor } : {}),
    ...(calendarsDown || signInAgain.length
      ? { homeAddress: browserAddress(config.data ?? {}, base) }
      : {}),
    events,
    lists,
    rooms,
    cameras: of("camera")
      .filter(shown)
      .map((s) => ({ entity: s.entity_id, name: nameOf(s), state: s.state })),
    security,
    scenes: [...of("scene"), ...of("script")]
      .filter(shown)
      .map((s) => ({ entity: s.entity_id, name: nameOf(s) }))
      .slice(0, 40),
  };
}

interface EnergyPrefs {
  energy_sources?: {
    type?: string;
    stat_energy_from?: string;
    stat_energy_to?: string;
    stat_rate?: string;
    flow_from?: { stat_energy_from?: string }[];
    flow_to?: { stat_energy_to?: string }[];
  }[];
}

/**
 * Today's totals from the Energy dashboard's own sources (statistics since midnight in Home
 * Assistant's time zone), and the power now when Home Assistant has a grid power sensor. Nothing
 * when the Energy dashboard is not set up: the widget then says so.
 */
async function readEnergy(
  socket: SocketFactory,
  base: string,
  token: string,
  prefs: EnergyPrefs | undefined,
  states: HaState[],
  now: Date,
): Promise<HomeView["energy"] | undefined> {
  const sources = prefs?.energy_sources ?? [];
  if (!sources.length) return undefined;
  const cached = energyCache.get(base);
  if (cached && now.getTime() - cached.at < 5 * 60_000) return cached.value;
  const stats: { key: "grid" | "returned" | "solar" | "gas"; id: string }[] = [];
  let rate: string | undefined;
  for (const s of sources) {
    if (s.type === "grid") {
      for (const f of s.flow_from ?? [])
        if (f.stat_energy_from) stats.push({ key: "grid", id: f.stat_energy_from });
      for (const f of s.flow_to ?? [])
        if (f.stat_energy_to) stats.push({ key: "returned", id: f.stat_energy_to });
      if (s.stat_energy_from) stats.push({ key: "grid", id: s.stat_energy_from });
      if (s.stat_energy_to) stats.push({ key: "returned", id: s.stat_energy_to });
      rate ??= s.stat_rate;
    } else if (s.type === "solar" && s.stat_energy_from)
      stats.push({ key: "solar", id: s.stat_energy_from });
    else if (s.type === "gas" && s.stat_energy_from)
      stats.push({ key: "gas", id: s.stat_energy_from });
  }
  const answers = stats.length
    ? await wsCommands(
        socket,
        base,
        token,
        stats.slice(0, 12).map((s) => ({
          type: "recorder/statistic_during_period" as const,
          statistic_id: s.id,
          calendar: { period: "day" },
          types: ["change"],
        })),
      )
    : [];
  const value: NonNullable<HomeView["energy"]> = { unit: "kWh" };
  stats.slice(0, 12).forEach((s, i) => {
    const change = num((answers[i]?.result as { change?: unknown } | undefined)?.change);
    if (change === undefined) return;
    value[s.key] = Math.round(((value[s.key] ?? 0) + change) * 10) / 10;
  });
  const gasState = states.find((x) => x.entity_id === stats.find((s) => s.key === "gas")?.id);
  if (typeof gasState?.attributes?.unit_of_measurement === "string")
    value.gasUnit = gasState.attributes.unit_of_measurement;
  const power = rate ? Number(states.find((x) => x.entity_id === rate)?.state) : NaN;
  if (Number.isFinite(power)) value.powerNow = Math.round(power);
  energyCache.set(base, { at: now.getTime(), value });
  return value;
}

/** A media player's artwork or a camera's picture, fetched with the token here (never sent on). */
export async function homePicture(
  fetchImpl: Fetch,
  base: string,
  token: string,
  entity: string,
): Promise<{ type: string; body: Buffer } | undefined> {
  const d = domainOf(entity);
  if (!/^(media_player|camera|person)\.[a-z0-9_]+$/.test(entity)) return undefined;
  let path = `/api/camera_proxy/${entity}`;
  if (d === "media_player" || d === "person") {
    const s = await ha<HaState>(fetchImpl, base, token, "GET", `/api/states/${entity}`);
    const pic = s.ok ? s.data?.attributes?.entity_picture : undefined;
    if (typeof pic !== "string") return undefined;
    // Only a picture Home Assistant serves itself (its proxy), never a link to elsewhere.
    if (!pic.startsWith("/api/")) return undefined;
    path = pic;
  }
  const res = await fetchImpl(joinUrl(base, path), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
  const type = res?.headers?.get("content-type") ?? "";
  if (!res?.ok || !type.startsWith("image/") || !res.arrayBuffer) return undefined;
  const body = Buffer.from(await res.arrayBuffer());
  return body.length > 4 * 1024 * 1024 ? undefined : { type, body };
}

/* ------------------------------------------------ acting ------------------------------------------------ */

/** Everything the dashboard can do, by domain. Anything else is refused. */
export const HOME_ACTIONS: Record<string, readonly string[]> = {
  light: ["toggle", "turn_on", "turn_off", "brightness"],
  switch: ["toggle", "turn_on", "turn_off"],
  fan: ["toggle", "turn_on", "turn_off"],
  input_boolean: ["toggle"],
  media_player: [
    "play_pause",
    "play",
    "pause",
    "next",
    "previous",
    "volume",
    "mute",
    "source",
    "power",
    "shuffle",
    "repeat",
    "move",
  ],
  climate: ["temperature", "mode"],
  todo: ["add", "complete", "reopen", "remove"],
  scene: ["activate"],
  script: ["run"],
  lock: ["lock", "unlock"],
  cover: ["close", "open"],
  alarm_control_panel: ["arm_home", "arm_away", "arm_night", "disarm"],
};

/** Opening the home: these need the unlock PIN. */
export const NEEDS_PIN = new Set(["lock.unlock", "cover.open", "alarm_control_panel.disarm"]);

export interface HomeAction {
  entity: string;
  action: string;
  /** brightness or volume 0 to 100; mute true or false; a source's name; a list item's text. */
  value?: string | number | boolean;
  /** A list item's id (complete, reopen, remove). */
  item?: string;
  /** The alarm's own code, when Home Assistant asks for one (passed on, never kept). */
  code?: string;
}

export class HomeActionError extends Error {}

/** What a tap does, checked against HOME_ACTIONS and the entity as Home Assistant has it now. */
export async function homeAct(
  fetchImpl: Fetch,
  base: string,
  token: string,
  a: HomeAction,
): Promise<{ done: string; state?: string }> {
  const d = domainOf(a.entity);
  if (!/^[a-z_]+\.[a-z0-9_]+$/.test(a.entity) || !HOME_ACTIONS[d]?.includes(a.action))
    throw new HomeActionError("The home dashboard does not do that.");
  if (d === "cover" && !["close", "open"].includes(a.action))
    throw new HomeActionError("The home dashboard does not do that.");
  const st = await ha<HaState>(fetchImpl, base, token, "GET", `/api/states/${a.entity}`);
  if (!st.ok || !st.data) throw new HomeActionError("Home Assistant does not have that any more.");
  if (d === "cover" && !isGarage(st.data))
    throw new HomeActionError("Only garage doors and gates open from the home dashboard.");
  const name = nameOf(st.data);
  let service: string;
  let data: Record<string, unknown> = { entity_id: a.entity };
  const pct = () => {
    const n = Math.round(Number(a.value));
    if (!Number.isFinite(n) || n < 0 || n > 100)
      throw new HomeActionError("A level from 0 to 100.");
    return n;
  };
  switch (`${d}.${a.action}`) {
    case "light.brightness":
      service = "light/turn_on";
      data = { ...data, brightness_pct: pct() };
      break;
    case "media_player.play_pause":
      service = "media_player/media_play_pause";
      break;
    // Said outright, so a second tap while the screen catches up never flips it back.
    case "media_player.play":
      service = "media_player/media_play";
      break;
    case "media_player.pause":
      service = "media_player/media_pause";
      break;
    case "media_player.next":
      service = "media_player/media_next_track";
      break;
    case "media_player.previous":
      service = "media_player/media_previous_track";
      break;
    case "media_player.volume":
      service = "media_player/volume_set";
      data = { ...data, volume_level: pct() / 100 };
      break;
    case "media_player.mute":
      service = "media_player/volume_mute";
      data = { ...data, is_volume_muted: a.value === true || a.value === "true" };
      break;
    case "media_player.source": {
      const list = (st.data.attributes?.source_list ?? []) as unknown[];
      if (!list.map(String).includes(String(a.value)))
        throw new HomeActionError("That speaker has no such source.");
      service = "media_player/select_source";
      data = { ...data, source: String(a.value) };
      break;
    }
    case "media_player.shuffle":
      service = "media_player/shuffle_set";
      data = { ...data, shuffle: a.value === true || a.value === "true" };
      break;
    case "media_player.repeat": {
      const mode = String(a.value);
      if (!["off", "all", "one"].includes(mode))
        throw new HomeActionError("Repeat off, all or one.");
      service = "media_player/repeat_set";
      data = { ...data, repeat: mode };
      break;
    }
    case "climate.temperature": {
      const t = Number(a.value);
      const lo = num(st.data.attributes?.min_temp) ?? -50;
      const hi = num(st.data.attributes?.max_temp) ?? 100;
      if (!Number.isFinite(t) || t < lo || t > hi)
        throw new HomeActionError(`A temperature from ${lo} to ${hi}.`);
      service = "climate/set_temperature";
      data = { ...data, temperature: t };
      break;
    }
    case "climate.mode": {
      const modes = ((st.data.attributes?.hvac_modes ?? []) as unknown[]).map(String);
      if (!modes.includes(String(a.value)))
        throw new HomeActionError("That heating has no such mode.");
      service = "climate/set_hvac_mode";
      data = { ...data, hvac_mode: String(a.value) };
      break;
    }
    case "media_player.move": {
      // Switching speakers moves what is playing (11-12, the owner expected it to, like a
      // phone's speaker picker): Music Assistant hands the queue from the old speaker to this one
      // and the old one goes quiet. The value is the speaker it moves from.
      const from = String(a.value ?? "");
      if (!/^media_player\.[a-z0-9_]+$/.test(from) || from === a.entity)
        throw new HomeActionError("Which speaker to move the music from.");
      service = "music_assistant/transfer_queue";
      data = { ...data, source_player: from, auto_play: true };
      break;
    }
    case "media_player.power":
      service = st.data.state === "off" ? "media_player/turn_on" : "media_player/turn_off";
      break;
    case "todo.add": {
      const text = String(a.value ?? "").trim();
      if (!text || text.length > 255) throw new HomeActionError("What to add (up to 255 letters).");
      service = "todo/add_item";
      data = { ...data, item: text };
      break;
    }
    case "todo.complete":
    case "todo.reopen":
      if (!a.item) throw new HomeActionError("Which item.");
      service = "todo/update_item";
      data = {
        ...data,
        item: a.item,
        status: a.action === "complete" ? "completed" : "needs_action",
      };
      break;
    case "todo.remove":
      if (!a.item) throw new HomeActionError("Which item.");
      service = "todo/remove_item";
      data = { ...data, item: a.item };
      break;
    case "scene.activate":
      service = "scene/turn_on";
      break;
    case "script.run":
      service = "script/turn_on";
      break;
    case "lock.lock":
    case "lock.unlock":
      service = `lock/${a.action}`;
      break;
    case "cover.close":
      service = "cover/close_cover";
      break;
    case "cover.open":
      service = "cover/open_cover";
      break;
    default:
      if (d === "alarm_control_panel") {
        service = `alarm_control_panel/alarm_${a.action}`;
        if (a.code) data = { ...data, code: String(a.code).slice(0, 32) };
      } else service = `${d}/${a.action}`;
  }
  const r = await ha<unknown>(fetchImpl, base, token, "POST", `/api/services/${service}`, data);
  if (!r.ok) throw new HomeActionError(`Home Assistant did not do it (${r.status}).`);
  const after = await ha<HaState>(fetchImpl, base, token, "GET", `/api/states/${a.entity}`).catch(
    () => undefined,
  );
  return {
    done: `${name}: ${a.action.replace(/_/g, " ")}`,
    ...(after?.data?.state ? { state: after.data.state } : {}),
  };
}

/* ------------------------------------------------ calendar ------------------------------------------------ */

/**
 * The calendar page (11-05: "I should be able to see it in a month", "click on it, edit it",
 * "if I do it should change on the Google calendar"). Events of every calendar for a range, and
 * adding, changing and deleting them through Home Assistant, which writes to the calendar's own
 * service (Google Calendar, CalDAV, a local calendar). A calendar that cannot change an event in
 * place (Google through Home Assistant: add and delete only) is changed by replacing the event.
 */
export interface CalendarInfo {
  entity: string;
  name: string;
  can: { create: boolean; delete: boolean; update: boolean };
}
export interface CalendarEvent {
  calendar: string;
  entity: string;
  uid?: string;
  recurrenceId?: string;
  /** One of a repeating series (changing it changes this one only). */
  repeats: boolean;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  description?: string;
}

const CAL = { CREATE: 1, DELETE: 2, UPDATE: 4 };

export async function calendarRange(
  fetchImpl: Fetch,
  base: string,
  token: string,
  start: string,
  end: string,
): Promise<{ calendars: CalendarInfo[]; events: CalendarEvent[] }> {
  const statesR = await ha<HaState[]>(fetchImpl, base, token, "GET", "/api/states");
  if (!statesR.ok)
    throw new AppUnreachableError(`Home Assistant answered ${statesR.status} for its states.`);
  const cals = (statesR.data ?? []).filter(
    (s) => s.entity_id.startsWith("calendar.") && s.state !== "unavailable",
  );
  const calendars = cals.slice(0, 20).map((c) => {
    const f = Number(c.attributes?.supported_features ?? 0);
    return {
      entity: c.entity_id,
      name: nameOf(c),
      can: {
        create: Boolean(f & CAL.CREATE),
        delete: Boolean(f & CAL.DELETE),
        update: Boolean(f & CAL.UPDATE),
      },
    };
  });
  const events = (
    await Promise.all(
      calendars.map(async (c) => {
        const r = await ha<
          {
            summary?: string;
            start?: { dateTime?: string; date?: string };
            end?: { dateTime?: string; date?: string };
            location?: string;
            description?: string;
            uid?: string;
            recurrence_id?: string;
            rrule?: string;
          }[]
        >(
          fetchImpl,
          base,
          token,
          "GET",
          `/api/calendars/${encodeURIComponent(c.entity)}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
        ).catch(() => undefined);
        return (r?.ok && Array.isArray(r.data) ? r.data : []).map((e) => ({
          calendar: c.name,
          entity: c.entity,
          ...(e.uid ? { uid: e.uid } : {}),
          ...(e.recurrence_id ? { recurrenceId: e.recurrence_id } : {}),
          repeats: Boolean(e.recurrence_id || e.rrule),
          title: String(e.summary ?? "Busy").slice(0, 300),
          start: String(e.start?.dateTime ?? e.start?.date ?? ""),
          ...(e.end?.dateTime || e.end?.date ? { end: String(e.end.dateTime ?? e.end.date) } : {}),
          allDay: Boolean(e.start?.date && !e.start.dateTime),
          ...(e.location ? { location: String(e.location).slice(0, 300) } : {}),
          ...(e.description ? { description: String(e.description).slice(0, 4000) } : {}),
        }));
      }),
    )
  )
    .flat()
    .filter((e) => e.start)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, 1500);
  return { calendars, events };
}

export interface EventInput {
  entity: string;
  title: string;
  /** YYYY-MM-DD for an all-day event, else an ISO date and time. */
  start: string;
  end: string;
  allDay: boolean;
  description?: string;
  location?: string;
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function eventData(e: EventInput) {
  if (e.allDay ? !isDay(e.start) || !isDay(e.end) : isDay(e.start) || isDay(e.end))
    throw new HomeActionError("Those dates don't match an all-day or timed event.");
  if (Date.parse(e.end) < Date.parse(e.start))
    throw new HomeActionError("It ends before it starts.");
  return {
    summary: e.title.trim().slice(0, 300) || "New event",
    ...(e.allDay
      ? { start_date: e.start, end_date: e.end }
      : { start_date_time: e.start, end_date_time: e.end }),
    ...(e.description?.trim() ? { description: e.description.trim().slice(0, 4000) } : {}),
    ...(e.location?.trim() ? { location: e.location.trim().slice(0, 300) } : {}),
  };
}

const calEntity = (entity: string) => {
  if (!/^calendar\.[a-z0-9_]+$/.test(entity))
    throw new HomeActionError("Not a calendar Hearth knows.");
};

export async function calendarCreate(fetchImpl: Fetch, base: string, token: string, e: EventInput) {
  calEntity(e.entity);
  const r = await ha<{ message?: string }>(
    fetchImpl,
    base,
    token,
    "POST",
    "/api/services/calendar/create_event",
    {
      entity_id: e.entity,
      ...eventData(e),
    },
  );
  if (!r.ok)
    throw new HomeActionError(
      `The calendar didn't take it (${r.status}${r.data?.message ? `: ${String(r.data.message).slice(0, 160)}` : ""}).`,
    );
  return { done: "Added" };
}

export async function calendarDelete(
  socket: SocketFactory,
  base: string,
  token: string,
  e: { entity: string; uid: string; recurrenceId?: string },
) {
  calEntity(e.entity);
  const [r] = await wsCommands(socket, base, token, [
    {
      type: "calendar/event/delete",
      entity_id: e.entity,
      uid: e.uid,
      ...(e.recurrenceId ? { recurrence_id: e.recurrenceId } : {}),
    },
  ]);
  if (!r?.ok)
    throw new HomeActionError(`The calendar didn't delete it (${r?.error ?? "no answer"}).`);
  return { done: "Deleted" };
}

/** Changes an event: in place where the calendar can, else by adding the new one and deleting the old. */
export async function calendarUpdate(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  e: EventInput & { uid: string; recurrenceId?: string; canUpdate: boolean },
) {
  calEntity(e.entity);
  if (e.canUpdate) {
    const d = eventData(e);
    const event = {
      summary: d.summary,
      dtstart: e.allDay ? e.start : e.start,
      dtend: e.allDay ? e.end : e.end,
      ...(d.description ? { description: d.description } : {}),
      ...(d.location ? { location: d.location } : {}),
    };
    const [r] = await wsCommands(socket, base, token, [
      {
        type: "calendar/event/update",
        entity_id: e.entity,
        uid: e.uid,
        ...(e.recurrenceId ? { recurrence_id: e.recurrenceId } : {}),
        event,
      },
    ]);
    if (!r?.ok)
      throw new HomeActionError(`The calendar didn't change it (${r?.error ?? "no answer"}).`);
    return { done: "Saved" };
  }
  await calendarCreate(fetchImpl, base, token, e);
  await calendarDelete(socket, base, token, e);
  return { done: "Saved" };
}

/* ------------------------------------------------ music library ------------------------------------------------ */

/**
 * The music library on the Media page (11-05: "I want to be able to start a mix from a
 * song"): search, the owner's playlists, albums, artists and songs, and playing any of them, all
 * through Home Assistant's own Music Assistant actions (search, get_library, play_media). No
 * other sign-in: Home Assistant holds Music Assistant's token.
 */
export type MusicKind = "track" | "album" | "artist" | "playlist" | "radio";
export interface MusicItem {
  uri: string;
  kind: MusicKind;
  name: string;
  /** The artists, joined. */
  by?: string;
  album?: string;
  image?: string;
}
export type MusicShelf = "playlist" | "album" | "artist" | "track" | "recent";

const MUSIC_KINDS = new Set<MusicKind>(["track", "album", "artist", "playlist", "radio"]);

function musicItemOf(raw: Record<string, unknown>): MusicItem | undefined {
  const uri = typeof raw.uri === "string" ? raw.uri : undefined;
  const kind = String(raw.media_type ?? "") as MusicKind;
  if (!uri || !MUSIC_KINDS.has(kind)) return undefined;
  const artists = Array.isArray(raw.artists)
    ? (raw.artists as Record<string, unknown>[]).map((a) => String(a.name ?? "")).filter(Boolean)
    : [];
  const album = raw.album as Record<string, unknown> | undefined;
  const image = typeof raw.image === "string" && raw.image ? raw.image : undefined;
  return {
    uri,
    kind,
    name: String(raw.name ?? uri).slice(0, 200),
    ...(artists.length ? { by: artists.join(", ").slice(0, 200) } : {}),
    ...(album?.name ? { album: String(album.name).slice(0, 200) } : {}),
    ...(image ? { image } : {}),
  };
}

/** Home Assistant's Music Assistant entry (its id is what the music actions ask for). */
async function musicEntry(fetchImpl: Fetch, base: string, token: string): Promise<string> {
  const r = await ha<{ entry_id: string; state?: string }[]>(
    fetchImpl,
    base,
    token,
    "GET",
    "/api/config/config_entries/entry?domain=music_assistant",
  );
  const e = (r.ok && Array.isArray(r.data) ? r.data : []).find(
    (x) => !x.state || x.state === "loaded",
  );
  if (!e)
    throw new HomeActionError(
      "Music Assistant isn't in Home Assistant yet: on the music card, Connect, then Music Assistant.",
    );
  return e.entry_id;
}

async function musicService<T>(
  fetchImpl: Fetch,
  base: string,
  token: string,
  name: "search" | "get_library",
  data: Record<string, unknown>,
): Promise<T> {
  const r = await ha<{ service_response?: T; message?: string }>(
    fetchImpl,
    base,
    token,
    "POST",
    `/api/services/music_assistant/${name}?return_response`,
    data,
  );
  if (!r.ok)
    throw new HomeActionError(
      `Music Assistant didn't answer (${r.status}${r.data?.message ? `: ${String(r.data.message).slice(0, 120)}` : ""}).`,
    );
  return (r.data?.service_response ?? {}) as T;
}

/** Search the music library and every connected music service (YouTube Music and the rest). */
export async function musicSearch(
  fetchImpl: Fetch,
  base: string,
  token: string,
  query: string,
): Promise<{
  tracks: MusicItem[];
  albums: MusicItem[];
  artists: MusicItem[];
  playlists: MusicItem[];
}> {
  const entry = await musicEntry(fetchImpl, base, token);
  const r = await musicService<Record<string, Record<string, unknown>[] | undefined>>(
    fetchImpl,
    base,
    token,
    "search",
    {
      config_entry_id: entry,
      name: query.slice(0, 200),
      media_type: ["track", "album", "artist", "playlist"],
      limit: 12,
    },
  );
  const list = (k: string) =>
    (r[k] ?? []).map(musicItemOf).filter((x): x is MusicItem => Boolean(x));
  return {
    tracks: list("tracks"),
    albums: list("albums"),
    artists: list("artists"),
    playlists: list("playlists"),
  };
}

/** One shelf of the library: playlists, albums, artists, songs, or what was played last. */
export async function musicLibrary(
  fetchImpl: Fetch,
  base: string,
  token: string,
  shelf: MusicShelf,
): Promise<MusicItem[]> {
  const entry = await musicEntry(fetchImpl, base, token);
  const r = await musicService<{ items?: Record<string, unknown>[] }>(
    fetchImpl,
    base,
    token,
    "get_library",
    {
      config_entry_id: entry,
      media_type: shelf === "recent" ? "track" : shelf,
      limit: 60,
      order_by: shelf === "recent" ? "last_played_desc" : "name",
    },
  );
  return (r.items ?? []).map(musicItemOf).filter((x): x is MusicItem => Boolean(x));
}

/** How to play it: now, as a mix (radio from it), next, or at the end of the queue. */
export type MusicHow = "play" | "mix" | "next" | "add";

/** Plays a library item on a Music Assistant speaker. */
export async function musicPlay(
  fetchImpl: Fetch,
  base: string,
  token: string,
  p: { entity: string; uri: string; kind: MusicKind; how: MusicHow; more?: string[] },
): Promise<{ done: string }> {
  if (!/^media_player\.[a-z0-9_]+$/.test(p.entity))
    throw new HomeActionError("Not a speaker Hearth knows.");
  const all = [p.uri, ...(p.more ?? [])];
  if (
    !MUSIC_KINDS.has(p.kind) ||
    all.length > 50 ||
    all.some((u) => !/^[a-z0-9_-]+:\/\//i.test(u) || u.length > 500)
  )
    throw new HomeActionError("Not something Music Assistant can play.");
  // A playlist or a mix can take Music Assistant most of a minute to gather; Home Assistant
  // answers only when it has started. Waiting that long is fine; giving up early is not.
  let r: { ok: boolean; status: number; data: { message?: string } };
  try {
    r = await ha<{ message?: string }>(
      fetchImpl,
      base,
      token,
      "POST",
      "/api/services/music_assistant/play_media",
      {
        entity_id: p.entity,
        // Play all: the songs in order, as one queue.
        media_id: all.length > 1 ? all : p.uri,
        media_type: p.kind,
        enqueue: p.how === "next" ? "next" : p.how === "add" ? "add" : "replace",
        ...(p.how === "mix" ? { radio_mode: true } : {}),
      },
      90_000,
    );
  } catch (e) {
    // Still gathering after 90 seconds: it was asked, and it carries on by itself.
    if (e instanceof AppUnreachableError && /timeout|aborted/i.test(e.message))
      return { done: "Starting (it takes Music Assistant a moment)" };
    throw e;
  }
  if (!r.ok)
    throw new HomeActionError(
      `Music Assistant didn't play it (${r.status}${r.data?.message ? `: ${String(r.data.message).slice(0, 120)}` : ""}).`,
    );
  return {
    done:
      p.how === "mix"
        ? "Mix started"
        : p.how === "next"
          ? "Plays next"
          : p.how === "add"
            ? "Added to the queue"
            : "Playing",
  };
}

/* ------------------------------------------------ connecting ------------------------------------------------ */

/**
 * The services the dashboard offers to connect, each Home Assistant's own integration. Spotify and
 * Google need an app's client id and secret first (Home Assistant's application credentials);
 * Music Assistant brings YouTube Music, Amazon Music, Apple Music, Tidal and more.
 */
export const CONNECT_HANDLERS: Record<
  string,
  {
    label: string;
    for: "music" | "calendar" | "lists" | "weather" | "travel";
    needsApp?: { url: string; redirect: string };
  }
> = {
  spotify: {
    label: "Spotify",
    for: "music",
    needsApp: {
      url: "https://developer.spotify.com/dashboard",
      redirect: "https://my.home-assistant.io/redirect/oauth",
    },
  },
  music_assistant: {
    label: "Music Assistant (YouTube Music, Amazon Music, Apple Music, Tidal and more)",
    for: "music",
  },
  google: {
    label: "Google Calendar",
    for: "calendar",
    needsApp: {
      url: "https://console.cloud.google.com/apis/credentials",
      redirect: "https://my.home-assistant.io/redirect/oauth",
    },
  },
  caldav: { label: "Apple iCloud or another CalDAV calendar", for: "calendar" },
  remote_calendar: {
    label: "A calendar link (Proton, Outlook, any .ics address)",
    for: "calendar",
  },
  local_calendar: { label: "A calendar kept in Home Assistant", for: "calendar" },
  local_todo: { label: "A list (groceries, chores)", for: "lists" },
  shopping_list: { label: "Home Assistant's shopping list", for: "lists" },
  met: {
    label: "Weather from the Norwegian Meteorological Institute (no account)",
    for: "weather",
  },
  waze_travel_time: { label: "Travel time with Waze (no account)", for: "travel" },
};

export interface FlowStep {
  flowId?: string;
  type: "form" | "external" | "done" | "stopped" | "progress";
  handler: string;
  /** Home Assistant was waiting for this sign-in again: this renews the connection. */
  renewing?: boolean;
  stepId?: string;
  fields?: {
    name: string;
    type: string;
    required: boolean;
    default?: unknown;
    options?: { value: string; label: string }[];
    secret: boolean;
  }[];
  errors?: Record<string, string>;
  url?: string;
  title?: string;
  reason?: string;
  /** The sign-in page has not reached Home Assistant yet (it is still waiting for it). */
  notYet?: boolean;
  /**
   * Home Assistant's address in a browser: a sign-in through My Home Assistant asks for it the
   * first time on each browser (11-18, the owner on a second PC).
   */
  homeAddress?: string;
}

/**
 * Home Assistant's address as a browser reaches it: its own internal or external URL when set,
 * else the one Hearth uses, unless that is only reachable from this machine or a container.
 */
export function browserAddress(
  config: { internal_url?: string | null; external_url?: string | null },
  base: string,
) {
  const local = (u: string) => {
    try {
      const h = new URL(u).hostname;
      return h === "localhost" || h.startsWith("127.") || h === "::1" || !/[.:]/.test(h);
    } catch {
      return true;
    }
  };
  const pick = [config.internal_url, config.external_url, base].find(
    (u): u is string => !!u && !local(u),
  );
  return (pick ?? base).replace(/\/+$/, "");
}

/** An external sign-in step, with the address My Home Assistant may ask for on this browser. */
async function withAddress(fetchImpl: Fetch, base: string, token: string, step: FlowStep) {
  if (step.type !== "external") return step;
  const c = await ha<{ internal_url?: string | null; external_url?: string | null }>(
    fetchImpl,
    base,
    token,
    "GET",
    "/api/config",
  ).catch(() => undefined);
  return { ...step, homeAddress: browserAddress(c?.data ?? {}, base) };
}

/**
 * A calendar service whose calendars can't be read while no sign-in waits (11-18: the waiting one
 * was thrown away when the owner finished in an old tab). Reloading it in Home Assistant makes
 * Google ask again, as Home Assistant's own Reload does. Nothing to do when it isn't set up or its
 * calendars are fine (a new connection goes on as usual).
 */
async function askAfresh(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  handler: string,
): Promise<"none" | "fixed" | "still-down" | { flow_id: string; handler: string }> {
  if (CONNECT_HANDLERS[handler]?.for !== "calendar") return "none";
  const entries = await ha<{ entry_id: string; domain: string }[]>(
    fetchImpl,
    base,
    token,
    "GET",
    `/api/config/config_entries/entry?domain=${encodeURIComponent(handler)}`,
  ).catch(() => undefined);
  const mine = (entries?.ok && Array.isArray(entries.data) ? entries.data : []).filter(
    (e) => e.domain === handler,
  );
  if (!mine.length) return "none";
  const once = { ...connectTiming };
  connectTiming.verifyTries = 1;
  const down = await calendarsStillDown(fetchImpl, socket, base, token, handler).finally(() =>
    Object.assign(connectTiming, once),
  );
  if (!down) return "none";
  for (const e of mine)
    await ha(
      fetchImpl,
      base,
      token,
      "POST",
      `/api/config/config_entries/entry/${encodeURIComponent(e.entry_id)}/reload`,
    ).catch(() => undefined);
  for (let i = 0; i < connectTiming.verifyTries; i++) {
    if (i) await new Promise((r) => setTimeout(r, connectTiming.verifyGapMs));
    const flow = (await reauthFlows(socket, base, token)).find((f) => f.handler === handler);
    if (flow) return flow;
  }
  return (await calendarsStillDown(fetchImpl, socket, base, token, handler))
    ? "still-down"
    : "fixed";
}

/** Waits between checks that a sign-in really brought a service's calendars back. */
export const connectTiming = { verifyTries: 6, verifyGapMs: 1500 };

/**
 * After Home Assistant says a calendar sign-in finished: are that service's calendars readable
 * again? Hearth said "Connected" on 11-18 while Google still refused the old sign-in, because the
 * new one had been thrown away. Answers how many of its calendars still can't be read.
 */
async function calendarsStillDown(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  handler: string,
) {
  const [reg] = await wsCommands(socket, base, token, [
    { type: "config/entity_registry/list" },
  ]).catch(() => [undefined]);
  const mine = new Set(
    (
      (reg?.ok && Array.isArray(reg.result) ? reg.result : []) as {
        entity_id: string;
        platform?: string;
      }[]
    )
      .filter((e) => e.platform === handler && e.entity_id.startsWith("calendar."))
      .map((e) => e.entity_id),
  );
  if (!mine.size) return 0;
  let down = 0;
  for (let i = 0; i < connectTiming.verifyTries; i++) {
    if (i) await new Promise((r) => setTimeout(r, connectTiming.verifyGapMs));
    const st = await ha<HaState[]>(fetchImpl, base, token, "GET", "/api/states").catch(
      () => undefined,
    );
    down = (st?.data ?? []).filter(
      (x) => mine.has(x.entity_id) && x.state === "unavailable",
    ).length;
    if (!down) return 0;
  }
  return down;
}

/** A finished calendar setup, checked: "done" only once its calendars read again. */
async function checkedDone(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  handler: string,
  step: FlowStep,
): Promise<FlowStep> {
  if (step.type !== "done" || CONNECT_HANDLERS[handler]?.for !== "calendar") return step;
  const down = await calendarsStillDown(fetchImpl, socket, base, token, handler);
  if (!down) return step;
  const label = CONNECT_HANDLERS[handler]!.label;
  return {
    handler,
    type: "stopped",
    reason: `the sign-in didn't take: ${down} ${label} calendar${down === 1 ? "" : "s"} still can't be read. Close this, then press Sign in to ${label} again (or Ask Ember to fix it)`,
  };
}

const SECRET_FIELD = /pass|secret|token|key|code/i;

function stepOf(handler: string, raw: Record<string, unknown> | null): FlowStep {
  const type = String(raw?.type ?? "");
  const base = { handler, ...(raw?.flow_id ? { flowId: String(raw.flow_id) } : {}) };
  if (type === "form") {
    const schema = (raw?.data_schema ?? []) as {
      name: string;
      type?: string;
      required?: boolean;
      default?: unknown;
      options?: unknown;
      selector?: Record<string, { options?: unknown }>;
    }[];
    return {
      ...base,
      type: "form",
      stepId: String(raw?.step_id ?? ""),
      fields: schema.map((f) => {
        const sel = f.selector ? Object.keys(f.selector)[0] : undefined;
        const rawOpts = (f.options ?? (sel ? f.selector![sel]?.options : undefined)) as unknown;
        const options = Array.isArray(rawOpts)
          ? rawOpts.map((o) =>
              Array.isArray(o)
                ? { value: String(o[0]), label: String(o[1] ?? o[0]) }
                : typeof o === "object" && o
                  ? {
                      value: String((o as { value?: unknown }).value),
                      label: String(
                        (o as { label?: unknown }).label ?? (o as { value?: unknown }).value,
                      ),
                    }
                  : { value: String(o), label: String(o) },
            )
          : rawOpts && typeof rawOpts === "object"
            ? Object.entries(rawOpts as Record<string, unknown>).map(([value, label]) => ({
                value,
                label: String(label),
              }))
            : undefined;
        return {
          name: f.name,
          type: sel ?? f.type ?? "string",
          required: Boolean(f.required),
          ...(f.default !== undefined && !SECRET_FIELD.test(f.name) ? { default: f.default } : {}),
          ...(options ? { options } : {}),
          secret:
            SECRET_FIELD.test(f.name) ||
            (sel === "text" && JSON.stringify(f.selector).includes("password")),
        };
      }),
      ...(raw?.errors && Object.keys(raw.errors as object).length
        ? { errors: raw.errors as Record<string, string> }
        : {}),
    };
  }
  if (type === "external" || type === "external_step")
    return { ...base, type: "external", url: String(raw?.url ?? "") };
  if (type === "external_done" || type === "show_progress" || type === "progress_done")
    return { ...base, type: "progress" };
  if (type === "create_entry" || (type === "abort" && raw?.reason === "reauth_successful"))
    return {
      ...base,
      type: "done",
      title: String(raw?.title ?? CONNECT_HANDLERS[handler]?.label ?? handler),
    };
  if (type === "abort" && raw?.reason === "already_configured")
    return {
      ...base,
      type: "stopped",
      reason: `${CONNECT_HANDLERS[handler]?.label ?? handler} is already connected with that account.`,
    };
  return {
    ...base,
    type: "stopped",
    reason: String(
      raw?.reason ??
        (raw as { message?: string } | null)?.message ??
        "Home Assistant stopped the setup.",
    ),
  };
}

/**
 * Home Assistant's waiting "sign in again" setups (source reauth) for services Hearth connects. Only
 * its live connection lists them: the REST GET of /api/config/config_entries/flow was removed and
 * answers 405, so reading it showed nothing waiting on a real Home Assistant (11-18).
 */
async function reauthFlows(socket: SocketFactory, base: string, token: string) {
  const [r] = await wsCommands(socket, base, token, [
    { type: "config_entries/flow/progress" },
  ]).catch(() => [undefined]);
  const list = (r?.ok && Array.isArray(r.result) ? r.result : []) as {
    flow_id: string;
    handler: string;
    context?: { source?: string };
  }[];
  return list.filter((f) => f.context?.source === "reauth" && CONNECT_HANDLERS[f.handler]);
}

export async function pendingSignIns(socket: SocketFactory, base: string, token: string) {
  const seen = new Set<string>();
  return (await reauthFlows(socket, base, token))
    .filter((f) => !seen.has(f.handler) && seen.add(f.handler))
    .map((f) => ({
      handler: f.handler,
      label: CONNECT_HANDLERS[f.handler]!.label,
      for: CONNECT_HANDLERS[f.handler]!.for,
    }));
}

/**
 * Starts Home Assistant's setup for one of CONNECT_HANDLERS. When Home Assistant is already waiting
 * for that service's sign-in again (its reauth), that setup goes on instead: a new one would be
 * thrown away as "already configured" and the old sign-in never renewed (11-18).
 */
export async function connectStart(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  handler: string,
) {
  if (!CONNECT_HANDLERS[handler]) throw new HomeActionError("Hearth does not connect that here.");
  let waiting = (await reauthFlows(socket, base, token)).find((f) => f.handler === handler);
  if (!waiting) {
    const asked = await askAfresh(fetchImpl, socket, base, token, handler);
    if (asked === "fixed")
      return { handler, type: "done", title: CONNECT_HANDLERS[handler]!.label } as FlowStep;
    if (asked === "still-down")
      return {
        handler,
        type: "stopped",
        reason: `Home Assistant still can't read ${CONNECT_HANDLERS[handler]!.label}, and it didn't ask for a sign-in. Ask Ember to fix it, or open Home Assistant's repairs`,
      } as FlowStep;
    if (asked !== "none") waiting = asked;
  }
  if (waiting) {
    let now = await ha<Record<string, unknown>>(
      fetchImpl,
      base,
      token,
      "GET",
      `/api/config/config_entries/flow/${waiting.flow_id}`,
    );
    // Its first step only asks "sign in again?" with nothing to fill in: yes, on to the sign-in.
    if (now.ok && now.data?.type === "form" && !((now.data.data_schema as unknown[]) ?? []).length)
      now = await ha<Record<string, unknown>>(
        fetchImpl,
        base,
        token,
        "POST",
        `/api/config/config_entries/flow/${waiting.flow_id}`,
        {},
      );
    if (now.ok)
      return withAddress(fetchImpl, base, token, { ...stepOf(handler, now.data), renewing: true });
  }
  const r = await ha<Record<string, unknown>>(
    fetchImpl,
    base,
    token,
    "POST",
    "/api/config/config_entries/flow",
    {
      handler,
      show_advanced_options: false,
    },
  );
  if (r.status === 403)
    throw new HomeActionError(
      "Home Assistant's token must belong to an administrator to connect services.",
    );
  return withAddress(fetchImpl, base, token, stepOf(handler, r.data));
}

/** The next step: the owner's answers to a form, or nothing after the sign-in page. */
export async function connectNext(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  handler: string,
  flowId: string,
  data: Record<string, unknown>,
) {
  if (!CONNECT_HANDLERS[handler] || !/^[a-zA-Z0-9]{8,64}$/.test(flowId))
    throw new HomeActionError("Not a setup Hearth started.");
  // "I've signed in" with nothing to give: only carry on once the service's sign-in page has
  // reached Home Assistant. Carrying on before that ends the setup (Google: no code).
  if (!Object.keys(data).length) {
    const now = await ha<Record<string, unknown>>(
      fetchImpl,
      base,
      token,
      "GET",
      `/api/config/config_entries/flow/${flowId}`,
    ).catch(() => undefined);
    if (now?.ok && (now.data?.type === "external" || now.data?.type === "external_step"))
      return withAddress(fetchImpl, base, token, { ...stepOf(handler, now.data), notYet: true });
  }
  const r = await ha<Record<string, unknown>>(
    fetchImpl,
    base,
    token,
    "POST",
    `/api/config/config_entries/flow/${flowId}`,
    data,
  );
  // The setup is gone: Home Assistant finished it on its own (its sign-in page came back to it).
  // Done, unless it is still waiting for this service's sign-in.
  if (r.status === 404) {
    const still = (await reauthFlows(socket, base, token)).some((f) => f.handler === handler);
    return still
      ? {
          handler,
          type: "stopped" as const,
          reason: `Home Assistant still needs you to sign in to ${CONNECT_HANDLERS[handler]!.label} again. Choose again to start over.`,
        }
      : checkedDone(fetchImpl, socket, base, token, handler, {
          handler,
          type: "done",
          title: CONNECT_HANDLERS[handler]!.label,
        });
  }
  return checkedDone(
    fetchImpl,
    socket,
    base,
    token,
    handler,
    await withAddress(fetchImpl, base, token, stepOf(handler, r.data)),
  );
}

/**
 * Home Assistant's Music Assistant integration, given a Music Assistant session the owner signed
 * in for: its address question answered, and its sign-in step given that session (Home Assistant
 * swaps it for its own long-lived token). Already added counts as done.
 */
export async function connectMusicAssistant(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  ma: { address: string; token: string },
): Promise<FlowStep> {
  ma = { ...ma, address: await reachableAddress(ma.address, base) };
  let step = await connectStart(fetchImpl, socket, base, token, "music_assistant");
  for (let i = 0; i < 5 && step.flowId; i++) {
    let data: Record<string, unknown>;
    if (step.type === "form") {
      if (step.errors?.base) break;
      const names = (step.fields ?? []).map((f) => f.name);
      data = names.includes("url")
        ? { url: ma.address }
        : names.includes("token")
          ? { token: ma.token }
          : {};
    } else if (step.type === "external") data = { code: ma.token };
    else if (step.type === "progress") data = {};
    else break;
    step = await connectNext(fetchImpl, socket, base, token, "music_assistant", step.flowId, data);
  }
  if (step.type === "stopped" && /already/i.test(step.reason ?? ""))
    return { handler: "music_assistant", type: "done", title: "Music Assistant" };
  return step;
}

/** Spotify and Google: the app's client id and secret, handed straight to Home Assistant. */
export async function addAppCredentials(
  socket: SocketFactory,
  base: string,
  token: string,
  domain: string,
  clientId: string,
  clientSecret: string,
) {
  if (!CONNECT_HANDLERS[domain]?.needsApp)
    throw new HomeActionError("That service does not need an app.");
  if (
    !clientId.trim() ||
    !clientSecret.trim() ||
    clientId.length > 300 ||
    clientSecret.length > 300
  )
    throw new HomeActionError("The app's client id and secret.");
  const [r] = await wsCommands(socket, base, token, [
    {
      type: "application_credentials/create",
      domain,
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      name: `Hearth: ${CONNECT_HANDLERS[domain]!.label}`,
    },
  ]);
  if (!r?.ok)
    throw new HomeActionError(
      `Home Assistant did not keep the app (${(r?.error ?? "refused").replaceAll(clientSecret, "[hidden]")}).`,
    );
}

/* ------------------------------------------------ scenes ------------------------------------------------ */

/*
 * The Scenes widget's editor (11-05: "add scenes directly from the widget ... edit them or
 * add a new one or delete one"). Most homes keep these as Home Assistant scripts (a list of
 * steps) and some as scenes (a set of device states); both open here as a list of devices,
 * each on or off with a brightness and colour where the light has them. Steps Hearth does not
 * edit (a delay, a TV input, a voice command) are shown and kept exactly as they were. New
 * scenes are saved as scripts, which run their steps in order like the ones already there.
 */

/** Devices a scene can set. */
const SCENE_DOMAINS = new Set(["light", "switch", "fan", "input_boolean", "media_player"]);
const COLOR_MODES = new Set(["hs", "xy", "rgb", "rgbw", "rgbww"]);
/** Light settings a changed step replaces (anything else it set, like a transition, is kept). */
const LIGHT_KEYS = new Set([
  "brightness_pct",
  "brightness",
  "brightness_step",
  "brightness_step_pct",
  "rgb_color",
  "rgbw_color",
  "rgbww_color",
  "hs_color",
  "xy_color",
  "color_name",
  "color_temp",
  "color_temp_kelvin",
  "kelvin",
  "entity_id",
]);

export interface SceneChoice {
  entity: string;
  name: string;
  kind: string;
  room?: string;
  /** Can be dimmed / coloured (lights only). */
  dim: boolean;
  color: boolean;
}
export interface SceneDevice {
  entity: string;
  on: boolean;
  brightness?: number;
  color?: [number, number, number];
}
export type SceneItem =
  | ({
      kind: "device";
      /** Where it came from in the saved scene (so an unchanged step is kept as it was). */
      ref?: string;
    } & SceneDevice)
  | { kind: "other"; ref: string; summary: string };
export interface SceneDetail {
  entity?: string;
  name: string;
  type: "script" | "scene";
  editable: boolean;
  /** Why it can't be changed here, when it can't. */
  why?: string;
  items: SceneItem[];
  choices: SceneChoice[];
}
export interface SceneSave {
  entity?: string;
  name: string;
  items: (({ ref?: string } & SceneDevice) | { ref: string; keep: true })[];
}

type Step = Record<string, unknown>;
type SceneConfig = {
  alias?: string;
  name?: string;
  mode?: string;
  sequence?: Step[];
  entities?: Record<string, unknown>;
  [k: string]: unknown;
};
type RegEntry = {
  entity_id: string;
  unique_id?: string;
  platform?: string;
  area_id?: string | null;
};

const rgbOf = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number")
    ? [Math.round(v[0] as number), Math.round(v[1] as number), Math.round(v[2] as number)]
    : undefined;
const pctOf = (data: Record<string, unknown>) =>
  typeof data.brightness_pct === "number"
    ? Math.round(data.brightness_pct)
    : typeof data.brightness === "number"
      ? Math.round((data.brightness / 255) * 100)
      : undefined;
const words = (s: string) => s.replace(/[._]/g, " ").trim();
const deviceKey = (d: SceneDevice) =>
  JSON.stringify([d.entity, d.on, d.brightness ?? null, d.color ?? null]);

/** One script step as a device change, when it is one Hearth edits. */
function stepAsDevice(step: Step): SceneDevice | undefined {
  const action = String(step.action ?? step.service ?? "");
  const m = /^(\w+)\.(turn_on|turn_off)$/.exec(action);
  if (!m || !SCENE_DOMAINS.has(m[1]!)) return undefined;
  if (Object.keys(step).some((k) => !["action", "service", "target", "data", "alias"].includes(k)))
    return undefined;
  const target = (step.target ?? {}) as Record<string, unknown>;
  const data = (step.data ?? {}) as Record<string, unknown>;
  if (Object.keys(target).some((k) => k !== "entity_id")) return undefined;
  const ids = [target.entity_id ?? data.entity_id].flat().filter(Boolean);
  const entity = ids[0];
  if (ids.length !== 1 || typeof entity !== "string" || domainOf(entity) !== m[1]) return undefined;
  // Templates and the like stay as they are.
  if (JSON.stringify(data).includes("{{")) return undefined;
  const on = m[2] === "turn_on";
  const brightness = on ? pctOf(data) : undefined;
  const color = on ? rgbOf(data.rgb_color) : undefined;
  return {
    entity,
    on,
    ...(brightness !== undefined ? { brightness } : {}),
    ...(color ? { color } : {}),
  };
}

/** A short line for a step Hearth keeps as it is. */
function stepSummary(step: Step, names: Map<string, string>): string {
  if (typeof step.alias === "string" && step.alias.trim()) return step.alias.trim().slice(0, 120);
  if (step.delay !== undefined) {
    const d = step.delay;
    const o = (typeof d === "object" && d ? d : {}) as Record<string, unknown>;
    const secs =
      typeof d === "number"
        ? d
        : typeof d === "string"
          ? d.split(":").reduce((a, x) => a * 60 + Number(x), 0)
          : Number(o.hours ?? 0) * 3600 + Number(o.minutes ?? 0) * 60 + Number(o.seconds ?? 0);
    return Number.isFinite(secs) ? `Waits ${secs} second${secs === 1 ? "" : "s"}` : "Waits";
  }
  const action = String(step.action ?? step.service ?? "");
  if (action) {
    const target = (step.target ?? {}) as Record<string, unknown>;
    const ids = [target.entity_id].flat().filter((x): x is string => typeof x === "string");
    const who = ids.map((x) => names.get(x) ?? x).join(", ");
    const data = (step.data ?? {}) as Record<string, unknown>;
    const what = typeof data.source === "string" ? ` to ${data.source}` : "";
    return `${words(action)}${who ? `: ${who}` : ""}${what}`.slice(0, 120);
  }
  return `A ${words(Object.keys(step)[0] ?? "")} step`.replace("A  step", "A step");
}

function choicesOf(states: HaState[], rooms: Map<string, string>) {
  const names = new Map(states.map((s) => [s.entity_id, nameOf(s)]));
  const choices: SceneChoice[] = states
    .filter((s) => SCENE_DOMAINS.has(domainOf(s.entity_id)) && s.attributes?.hidden !== true)
    .map((s) => {
      const modes = (s.attributes?.supported_color_modes as string[] | undefined) ?? [];
      const light = domainOf(s.entity_id) === "light";
      const room = rooms.get(s.entity_id);
      return {
        entity: s.entity_id,
        name: nameOf(s),
        kind: domainOf(s.entity_id),
        ...(room ? { room } : {}),
        // A light that says nothing about its modes is treated as dimmable and colourable.
        dim: light && (!modes.length || modes.some((m) => m !== "onoff")),
        color: light && (!modes.length || modes.some((m) => COLOR_MODES.has(m))),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { choices, names };
}

async function sceneContext(fetchImpl: Fetch, socket: SocketFactory, base: string, token: string) {
  const st = await ha<HaState[]>(fetchImpl, base, token, "GET", "/api/states");
  if (!st.ok || !Array.isArray(st.data))
    throw new AppUnreachableError("Home Assistant did not list its devices.");
  const [ents, areas] = await wsCommands(socket, base, token, [
    { type: "config/entity_registry/list" },
    { type: "config/area_registry/list" },
  ]).catch(() => [undefined, undefined]);
  const reg = ents?.ok && Array.isArray(ents.result) ? (ents.result as RegEntry[]) : [];
  const areaList =
    areas?.ok && Array.isArray(areas.result)
      ? (areas.result as { area_id: string; name: string }[])
      : [];
  const areaName = new Map(areaList.map((a) => [a.area_id, a.name]));
  const rooms = new Map<string, string>();
  for (const e of reg) {
    const room = e.area_id ? areaName.get(e.area_id) : undefined;
    if (room) rooms.set(e.entity_id, room);
  }
  return { states: st.data, reg, ...choicesOf(st.data, rooms) };
}

/** Where a scene or script is saved in Home Assistant, when it is saved there at all. */
function sceneHome(
  entity: string,
  states: HaState[],
  reg: RegEntry[],
): { type: "script" | "scene"; id?: string; why?: string } {
  const type = domainOf(entity);
  const s = states.find((x) => x.entity_id === entity);
  if (!s || (type !== "script" && type !== "scene"))
    throw new HomeActionError("Home Assistant has no such scene.");
  const r = reg.find((x) => x.entity_id === entity);
  if (type === "script") {
    if (r?.platform && r.platform !== "script")
      return { type, why: `It comes from ${words(r.platform)}, so change it there.` };
    return { type, id: r?.unique_id ?? entity.split(".")[1] };
  }
  const id = s.attributes?.id;
  if (typeof id === "string" || typeof id === "number") return { type, id: String(id) };
  const from =
    r?.platform && r.platform !== "homeassistant" ? `the ${words(r.platform)} app` : "a file";
  return {
    type,
    why: `This scene comes from ${from}, so it can only be run from here. Change it there, or make a new one here.`,
  };
}

const configPath = (type: "script" | "scene", id: string) => {
  if (!/^[\w-]{1,120}$/.test(id))
    throw new HomeActionError("That scene's name in Home Assistant can't be used here.");
  return `/api/config/${type}/config/${id}`;
};
const ADMIN_ONLY =
  "Home Assistant only lets an administrator change scenes. Hearth's Home Assistant token belongs to a user who isn't one.";

async function readConfig(
  fetchImpl: Fetch,
  base: string,
  token: string,
  type: "script" | "scene",
  id: string,
) {
  const r = await ha<SceneConfig>(fetchImpl, base, token, "GET", configPath(type, id));
  if (r.status === 403) throw new HomeActionError(ADMIN_ONLY);
  if (!r.ok || !r.data || typeof r.data !== "object")
    throw new HomeActionError(`Home Assistant didn't open it (${r.status}).`);
  return r.data;
}

function itemsOf(
  type: "script" | "scene",
  config: SceneConfig,
  names: Map<string, string>,
): SceneItem[] {
  if (type === "script")
    return (Array.isArray(config.sequence) ? config.sequence : []).map((step, i) => {
      const d = stepAsDevice(step);
      return d
        ? { kind: "device" as const, ref: String(i), ...d }
        : { kind: "other" as const, ref: String(i), summary: stepSummary(step, names) };
    });
  return Object.entries(config.entities ?? {}).map(([entity, raw]): SceneItem => {
    const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const state = typeof raw === "string" ? raw : String(v.state ?? "");
    if (!SCENE_DOMAINS.has(domainOf(entity)) || !["on", "off"].includes(state))
      return {
        kind: "other",
        ref: entity,
        summary: `${names.get(entity) ?? entity}: ${state || "set"}`,
      };
    const on = state === "on";
    const brightness = on ? pctOf(v) : undefined;
    const color = on ? rgbOf(v.rgb_color) : undefined;
    return {
      kind: "device",
      ref: entity,
      entity,
      on,
      ...(brightness !== undefined ? { brightness } : {}),
      ...(color ? { color } : {}),
    };
  });
}

/** A scene to view or change (or, with no entity, what a new one can use). */
export async function sceneRead(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  entity?: string,
): Promise<SceneDetail> {
  const ctx = await sceneContext(fetchImpl, socket, base, token);
  if (!entity) return { name: "", type: "script", editable: true, items: [], choices: ctx.choices };
  const where = sceneHome(entity, ctx.states, ctx.reg);
  const name = ctx.names.get(entity) ?? entity;
  if (!where.id)
    return {
      entity,
      name,
      type: where.type,
      editable: false,
      ...(where.why ? { why: where.why } : {}),
      items: [],
      choices: ctx.choices,
    };
  const config = await readConfig(fetchImpl, base, token, where.type, where.id);
  return {
    entity,
    name: String(config.alias ?? config.name ?? name),
    type: where.type,
    editable: true,
    items: itemsOf(where.type, config, ctx.names),
    choices: ctx.choices,
  };
}

/** A free script name for a new scene ("Pre bed" becomes pre_bed, then pre_bed_2). */
function newId(name: string, states: HaState[]) {
  let stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "scene";
  if (/^\d/.test(stem)) stem = `scene_${stem}`;
  const taken = new Set(states.map((x) => x.entity_id));
  let id = stem;
  for (let n = 2; taken.has(`script.${id}`); n++) id = `${stem}_${n}`;
  return id;
}

/** Saves a scene: changes one already there, or makes a new one (as a script). */
export async function sceneSave(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  s: SceneSave,
): Promise<{ done: string; entity: string }> {
  const ctx = await sceneContext(fetchImpl, socket, base, token);
  const allowed = new Map(ctx.choices.map((c) => [c.entity, c]));
  const name = s.name.trim().slice(0, 80);
  if (!name) throw new HomeActionError("Give the scene a name.");
  for (const it of s.items)
    if (!("keep" in it) && !allowed.has(it.entity))
      throw new HomeActionError(`Home Assistant has no device ${it.entity} a scene can set.`);
  if (!s.items.length) throw new HomeActionError("Add at least one device to the scene.");

  let type: "script" | "scene" = "script";
  let id: string;
  let config: SceneConfig = { mode: "single" };
  if (s.entity) {
    const where = sceneHome(s.entity, ctx.states, ctx.reg);
    if (!where.id) throw new HomeActionError(where.why ?? "This scene can't be changed here.");
    type = where.type;
    id = where.id;
    config = await readConfig(fetchImpl, base, token, type, id);
  } else id = newId(name, ctx.states);
  const before = new Map(itemsOf(type, config, ctx.names).map((x) => [x.ref, x]));
  const unchanged = (ref: string | undefined, d: SceneDevice) => {
    const prev = ref !== undefined ? before.get(ref) : undefined;
    return prev?.kind === "device" && deviceKey(prev) === deviceKey(d);
  };
  // What the device can take (no colour on a plain switch).
  const device = (it: { ref?: string } & SceneDevice): SceneDevice => {
    const c = allowed.get(it.entity)!;
    return {
      entity: it.entity,
      on: it.on,
      ...(it.on && c.dim && it.brightness !== undefined
        ? { brightness: Math.max(1, Math.min(100, Math.round(it.brightness))) }
        : {}),
      ...(it.on && c.color && it.color
        ? {
            color: it.color.map((n) => Math.max(0, Math.min(255, Math.round(n)))) as [
              number,
              number,
              number,
            ],
          }
        : {}),
    };
  };
  const changed = (ok: boolean) => {
    if (ok) return;
    throw new HomeActionError("The scene changed in Home Assistant meanwhile. Open it again.");
  };

  let body: SceneConfig;
  if (type === "script") {
    const seq = Array.isArray(config.sequence) ? config.sequence : [];
    const sequence = s.items.map((it) => {
      if ("keep" in it) {
        const kept = seq[Number(it.ref)];
        changed(Boolean(kept));
        return kept!;
      }
      const d = device(it);
      const prevStep = it.ref !== undefined ? seq[Number(it.ref)] : undefined;
      if (prevStep && unchanged(it.ref, d)) return prevStep;
      const extra = Object.fromEntries(
        Object.entries((prevStep?.data ?? {}) as Record<string, unknown>).filter(
          ([k]) => !LIGHT_KEYS.has(k),
        ),
      );
      const data = d.on
        ? {
            ...extra,
            ...(d.brightness !== undefined ? { brightness_pct: d.brightness } : {}),
            ...(d.color ? { rgb_color: d.color } : {}),
          }
        : {};
      return {
        action: `${domainOf(d.entity)}.${d.on ? "turn_on" : "turn_off"}`,
        target: { entity_id: d.entity },
        ...(Object.keys(data).length ? { data } : {}),
      };
    });
    body = { ...config, alias: name, sequence, mode: config.mode ?? "single" };
  } else {
    const was = config.entities ?? {};
    const entities: Record<string, unknown> = {};
    for (const it of s.items) {
      if ("keep" in it) {
        changed(it.ref in was);
        entities[it.ref] = was[it.ref];
        continue;
      }
      const d = device(it);
      entities[d.entity] =
        unchanged(it.ref, d) && it.ref === d.entity
          ? was[d.entity]
          : {
              state: d.on ? "on" : "off",
              ...(d.brightness !== undefined
                ? { brightness: Math.round((d.brightness / 100) * 255) }
                : {}),
              ...(d.color ? { rgb_color: d.color } : {}),
            };
    }
    body = { ...config, id, name, entities };
  }
  const r = await ha<{ message?: string }>(
    fetchImpl,
    base,
    token,
    "POST",
    configPath(type, id),
    body,
  );
  if (r.status === 403) throw new HomeActionError(ADMIN_ONLY);
  if (!r.ok)
    throw new HomeActionError(
      `Home Assistant didn't save it (${r.status}${r.data?.message ? `: ${String(r.data.message).slice(0, 160)}` : ""}).`,
    );
  return { done: s.entity ? "Saved" : "Added", entity: s.entity ?? `script.${id}` };
}

/** Deletes a scene or script that Home Assistant's editor keeps. */
export async function sceneDelete(
  fetchImpl: Fetch,
  socket: SocketFactory,
  base: string,
  token: string,
  entity: string,
): Promise<{ done: string }> {
  const ctx = await sceneContext(fetchImpl, socket, base, token);
  const where = sceneHome(entity, ctx.states, ctx.reg);
  if (!where.id) throw new HomeActionError(where.why ?? "This scene can't be deleted here.");
  const r = await ha<{ message?: string }>(
    fetchImpl,
    base,
    token,
    "DELETE",
    configPath(where.type, where.id),
  );
  if (r.status === 403) throw new HomeActionError(ADMIN_ONLY);
  if (!r.ok) throw new HomeActionError(`Home Assistant didn't delete it (${r.status}).`);
  return { done: "Deleted" };
}

/**
 * The home's coordinates from Home Assistant, for the weather service only (Hearth never shows
 * or stores them).
 */
export async function homeCoords(
  fetchImpl: Fetch,
  base: string,
  token: string,
): Promise<{ lat: number; lon: number } | undefined> {
  const r = await ha<{ latitude?: number; longitude?: number }>(
    fetchImpl,
    base,
    token,
    "GET",
    "/api/config",
  );
  const lat = num(r.data?.latitude);
  const lon = num(r.data?.longitude);
  return r.ok && lat !== undefined && lon !== undefined && (lat !== 0 || lon !== 0)
    ? { lat, lon }
    : undefined;
}

/**
 * A sign-in that ended on "This site can't be reached" (11-05): Google and the others send
 * the browser back through my.home-assistant.io, which goes to the Home Assistant address that
 * browser was told about (by default homeassistant.local, which many networks don't have). The
 * address on that dead page still carries the sign-in's one-time code and Home Assistant's own
 * check (state); pasted here, Hearth gives those two to this Home Assistant's callback, the same
 * request the browser would have made, and the setup carries on.
 */
export async function deliverSignInCallback(fetchImpl: Fetch, base: string, pasted: string) {
  let u: URL;
  try {
    u = new URL(pasted.trim());
  } catch {
    throw new HomeActionError(
      "That isn't a web address. Copy the whole address from that page's address bar.",
    );
  }
  const error = u.searchParams.get("error");
  if (error) throw new HomeActionError(`The sign-in was turned down (${error.slice(0, 80)}).`);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (u.pathname !== "/auth/external/callback" || !code || !state)
    throw new HomeActionError(
      "That isn't the address the sign-in ended on. It has /auth/external/callback?code= in it.",
    );
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(
      joinUrl(
        base,
        `/auth/external/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      ),
      { headers: { Accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) },
    );
  } catch {
    throw new AppUnreachableError(`Home Assistant did not answer at ${base}.`);
  }
  if (!res.ok)
    throw new HomeActionError(
      `Home Assistant didn't take it (${res.status}). The code may have run out: start the sign-in again.`,
    );
}

/**
 * Watch on TV (11-05: the music video "in that box... or on the TV"): a YouTube video on a
 * Google Cast TV through Home Assistant's Cast integration (its YouTube app), with its sound.
 * The music pauses first when it was playing on another speaker, so it isn't heard twice.
 */
export async function videoOnTv(
  fetchImpl: Fetch,
  base: string,
  token: string,
  socket: SocketFactory,
  p: { tv: string; videoId: string; pause?: string },
): Promise<{ done: string }> {
  if (!/^[\w-]{11}$/.test(p.videoId)) throw new HomeActionError("That isn't a YouTube video.");
  for (const e of [p.tv, p.pause])
    if (e !== undefined && !/^media_player\.[a-z0-9_]+$/.test(e))
      throw new HomeActionError("Not a speaker Hearth knows.");
  const [reg] = await wsCommands(socket, base, token, [{ type: "config/entity_registry/list" }]);
  const list =
    reg?.ok && Array.isArray(reg.result)
      ? (reg.result as { entity_id: string; platform?: string }[])
      : [];
  if (list.find((x) => x.entity_id === p.tv)?.platform !== "cast")
    throw new HomeActionError(
      "That TV can't play YouTube videos from Hearth (it isn't a Google Cast device).",
    );
  if (p.pause && p.pause !== p.tv)
    await ha(fetchImpl, base, token, "POST", "/api/services/media_player/media_pause", {
      entity_id: p.pause,
    }).catch(() => undefined);
  const r = await ha<{ message?: string }>(
    fetchImpl,
    base,
    token,
    "POST",
    "/api/services/media_player/play_media",
    {
      entity_id: p.tv,
      media_content_type: "cast",
      media_content_id: JSON.stringify({ app_name: "youtube", media_id: p.videoId }),
    },
    60_000,
  );
  if (!r.ok)
    throw new HomeActionError(
      `The TV didn't start it (${r.status}${r.data?.message ? `: ${String(r.data.message).slice(0, 120)}` : ""}).`,
    );
  return { done: "Playing the video on the TV" };
}
