import type { SocketFactory, SocketLike } from "./homeassistant";
import type { Fetch } from "./http";

/**
 * A stand-in Home Assistant (port 8123) for tests and safe previews (DC_FAKE_APPS=1, never in a
 * real install): automations, a script, a scene, a light and a switch, an unavailable sensor, an
 * integration that keeps retrying setup (a reload fixes it), and a lock the panel must never offer.
 * For the home dashboard (11-04): the weather with a forecast, a speaker playing, a family
 * calendar, grocery and chore lists, a camera, a garage door, an alarm that asks for its own code,
 * and Home Assistant's setup flows for a list, Spotify (which needs an app first) and CalDAV.
 */

export interface FakeHomeAssistant {
  fetch: Fetch;
  /** Its live connection: run history (traces) and the registry lists. */
  socket: SocketFactory;
  reset(): void;
  home(h: {
    condition?: string;
    sunUp?: boolean;
    down?: boolean;
    ring?: boolean;
    musicAssistant?: boolean;
    livingRoom?: boolean;
    /** Google stopped accepting the calendar's sign-in: its calendar unavailable, a reauth waiting. */
    googleSignInAgain?: boolean;
    /** The same, but the waiting sign-in was thrown away: only a Reload asks for it again. */
    googleSignInLost?: boolean;
  }): void;
}

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
interface FakeState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
}
const STATES = (): FakeState[] => [
  {
    entity_id: "automation.porch_lights_at_sunset",
    state: "on",
    attributes: { friendly_name: "Porch lights at sunset", last_triggered: ago(5), id: "1001" },
  },
  {
    entity_id: "automation.vacation_mode",
    state: "off",
    attributes: { friendly_name: "Vacation mode", last_triggered: null, id: "1002" },
  },
  { entity_id: "script.movie_night", state: "off", attributes: { friendly_name: "Movie night" } },
  {
    entity_id: "script.goodnight",
    state: "off",
    attributes: { friendly_name: "Goodnight", last_triggered: ago(20) },
  },
  { entity_id: "script.leaving_home", state: "off", attributes: { friendly_name: "Leaving home" } },
  {
    entity_id: "script.ask_assistant",
    state: "off",
    attributes: { friendly_name: "Ask the assistant" },
  },
  { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } },
  {
    entity_id: "scene.good_morning",
    state: "2026-10-19T07:00:00+00:00",
    attributes: { friendly_name: "Good morning", id: "1700" },
  },
  { entity_id: "light.living_room", state: "off", attributes: { friendly_name: "Living room" } },
  { entity_id: "switch.server_fan", state: "on", attributes: { friendly_name: "Server fan" } },
  {
    entity_id: "sensor.garage_temp",
    state: "unavailable",
    attributes: { friendly_name: "Garage temperature" },
    last_changed: ago(30),
  },
  { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front door" } },
  ...HOME_STATES(),
];

/** The home dashboard's things (11-04). */
const HOME_STATES = (): FakeState[] => [
  {
    entity_id: "weather.forecast_home",
    state: "partlycloudy",
    attributes: {
      friendly_name: "Home",
      temperature: 18.4,
      temperature_unit: "°C",
      humidity: 61,
      wind_speed: 12,
      wind_speed_unit: "km/h",
      wind_bearing: 270,
      apparent_temperature: 16.9,
    },
  },
  {
    entity_id: "sun.sun",
    state: "below_horizon",
    attributes: {
      friendly_name: "Sun",
      next_rising: new Date(Date.now() + 9 * 3_600_000).toISOString(),
      next_setting: new Date(Date.now() + 20 * 3_600_000).toISOString(),
    },
  },
  {
    entity_id: "climate.living_room",
    state: "heat",
    attributes: {
      friendly_name: "Thermostat",
      hvac_modes: ["off", "heat", "cool", "auto"],
      hvac_action: "heating",
      current_temperature: 20.5,
      temperature: 21,
      min_temp: 7,
      max_temp: 30,
      target_temp_step: 0.5,
    },
  },
  {
    entity_id: "media_player.kitchen_speaker",
    state: "playing",
    attributes: {
      friendly_name: "Kitchen speaker",
      media_title: "Harbor Song",
      media_artist: "The Lighthouse Band",
      media_album_name: "Coastline",
      app_name: "Spotify",
      entity_picture: "/api/media_player_proxy/media_player.kitchen_speaker?token=fake-art-token",
      volume_level: 0.4,
      is_volume_muted: false,
      source: "Spotify",
      source_list: ["Spotify", "Radio"],
      media_content_type: "music",
      media_duration: 238,
      media_position: 92,
      media_position_updated_at: new Date().toISOString(),
      shuffle: false,
      repeat: "off",
      // pause, volume, mute, previous, next, on, off, source, play, shuffle, repeat
      supported_features: 1 | 4 | 8 | 16 | 32 | 128 | 256 | 2048 | 16384 | 32768 | 262144,
    },
  },
  // Google Calendar through Home Assistant: add and delete (1 | 2), no change in place.
  // A speaker that only reports its model (11-13: "the picker shows model numbers"): Hearth
  // calls it by its room, "Den speaker".
  {
    entity_id: "media_player.sonos_era_100",
    state: "idle",
    attributes: { friendly_name: "Sonos Era 100", supported_features: 1 | 4 | 16 | 4096 },
  },
  {
    entity_id: "calendar.family",
    state: "off",
    attributes: { friendly_name: "Family", supported_features: 3 },
  },
  { entity_id: "todo.groceries", state: "2", attributes: { friendly_name: "Groceries" } },
  { entity_id: "todo.chores", state: "1", attributes: { friendly_name: "Chores" } },
  { entity_id: "camera.front_porch", state: "idle", attributes: { friendly_name: "Front porch" } },
  {
    entity_id: "cover.garage_door",
    state: "closed",
    attributes: { friendly_name: "Garage door", device_class: "garage" },
  },
  {
    entity_id: "alarm_control_panel.home_alarm",
    state: "disarmed",
    attributes: { friendly_name: "Alarm", code_format: "number" },
  },
  // The widget gallery's things (11-05).
  {
    entity_id: "person.alex",
    state: "home",
    attributes: { friendly_name: "Alex", entity_picture: "/api/image/serve/alex/512x512" },
    last_changed: ago(3),
  },
  {
    entity_id: "person.sam",
    state: "not_home",
    attributes: { friendly_name: "Sam" },
    last_changed: ago(1),
  },
  {
    entity_id: "sensor.commute_to_work",
    state: "24",
    attributes: {
      friendly_name: "Commute to work",
      unit_of_measurement: "min",
      origin: "Home",
      destination: "Office",
      route: "Main Street",
      distance: 17.2,
    },
  },
  {
    entity_id: "event.front_door_doorbell",
    state: ago(26),
    attributes: {
      friendly_name: "Front door doorbell",
      device_class: "doorbell",
      event_type: "ring",
    },
  },
  {
    entity_id: "plant.fern",
    state: "problem",
    attributes: { friendly_name: "Fern", problem: "moisture low", moisture: 12 },
  },
  {
    entity_id: "sensor.home_team",
    state: "POST",
    attributes: {
      friendly_name: "Home team",
      league: "NFL",
      team_name: "Harbor City",
      opponent_name: "River Town",
      team_score: "24",
      opponent_score: "17",
      date: ago(30),
    },
  },
  {
    entity_id: "sensor.bin_day",
    state: "Recycling in 2 days",
    attributes: { friendly_name: "Bin day", daysTo: 2, types: ["Recycling"] },
  },
  {
    entity_id: "sensor.living_room_temperature",
    state: "21.3",
    attributes: {
      friendly_name: "Living room temperature",
      unit_of_measurement: "°C",
      device_class: "temperature",
    },
  },
  {
    entity_id: "sensor.home_power",
    state: "1430",
    attributes: { friendly_name: "Home power", unit_of_measurement: "W", device_class: "power" },
  },
  {
    entity_id: "sensor.grid_energy",
    state: "5123.4",
    attributes: {
      friendly_name: "Grid energy",
      unit_of_measurement: "kWh",
      device_class: "energy",
    },
  },
  {
    entity_id: "sensor.solar_energy",
    state: "2210.8",
    attributes: {
      friendly_name: "Solar energy",
      unit_of_measurement: "kWh",
      device_class: "energy",
    },
  },
  {
    entity_id: "input_boolean.guest_mode",
    state: "off",
    attributes: { friendly_name: "Guest mode" },
  },
];

/** A tiny picture, for speaker artwork and the camera. */
const PICTURE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const ENTRIES = () => [
  {
    entry_id: "abc123",
    domain: "zha",
    title: "Zigbee",
    state: "setup_retry",
    reason: "Could not reach the coordinator",
    disabled_by: null,
  },
  { entry_id: "def456", domain: "met", title: "Home weather", state: "loaded", disabled_by: null },
];

/** What Home Assistant's editor returns for each routine (by automation id or script name). */
const CONFIGS: Record<string, unknown> = {
  "automation/1001": {
    alias: "Porch lights at sunset",
    triggers: [{ trigger: "sun", event: "sunset" }],
    conditions: [{ condition: "state", entity_id: "switch.server_fan", state: "on" }],
    actions: [{ action: "light.turn_on", target: { entity_id: "light.living_room" } }],
  },
  "automation/1002": {
    alias: "Vacation mode",
    triggers: [{ trigger: "time", at: "20:00:00" }],
    actions: [{ action: "lock.lock", target: { entity_id: "lock.front_door" } }],
  },
  "script/movie_night": {
    alias: "Movie night",
    sequence: [{ action: "light.turn_off", target: { entity_id: "light.living_room" } }],
  },
  "script/goodnight": {
    alias: "Goodnight",
    sequence: [
      { action: "light.turn_off", target: { entity_id: "light.living_room" } },
      {
        action: "light.turn_on",
        target: { entity_id: "light.kitchen" },
        data: { brightness_pct: 50, rgb_color: [255, 0, 0] },
      },
    ],
  },
  "script/leaving_home": {
    alias: "Leaving home",
    sequence: [
      { action: "light.turn_off", target: { entity_id: "all" } },
      { action: "lock.lock", target: { entity_id: "lock.front_door" } },
    ],
  },
  "scene/1700": {
    id: "1700",
    name: "Good morning",
    entities: {
      "light.kitchen": { state: "on", brightness: 255, friendly_name: "Kitchen" },
      "cover.blinds": { state: "open" },
    },
  },
  "script/ask_assistant": {
    alias: "Ask the assistant",
    fields: { question: { required: true, selector: { text: null } } },
    sequence: [{ action: "rest_command.ask_assistant", data: { question: "{{ question }}" } }],
  },
};

export function fakeHomeAssistant(): FakeHomeAssistant {
  let states = STATES();
  let entries = ENTRIES();
  /** Google's sign-in was refused and its waiting sign-in thrown away (Reload asks again). */
  let googleLost = false;
  const TODO = () => ({
    "todo.groceries": [
      { uid: "g1", summary: "Milk", status: "needs_action" },
      { uid: "g2", summary: "Bread", status: "needs_action" },
      { uid: "g3", summary: "Eggs", status: "completed" },
    ],
    "todo.chores": [{ uid: "c1", summary: "Take out the bins", status: "needs_action" }],
  });
  let todo: Record<string, { uid: string; summary: string; status: string }[]> = TODO();
  let hasSpotifyApp = false;
  // Browser tests: Home Assistant stops answering.
  let down = false;
  let flows: Record<string, { handler: string; stage: number; reauth?: boolean }> = {};
  const callbacks: { code: string; state: string }[] = [];
  // Scripts and scenes as Home Assistant's editor keeps them (changed, added and deleted by tests).
  let configs: Record<string, unknown> = structuredClone(CONFIGS);
  // The family calendar's events (made on first read, so "today" is the test's today).
  let calEvents:
    | {
        uid: string;
        summary: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        location?: string;
        description?: string;
      }[]
    | undefined;
  // Music Assistant, once it is connected: its speaker and what was played on it.
  let musicAssistant = false;
  // A second Music Assistant speaker, only for the test that moves music between speakers.
  let livingRoomMa = false;
  const played: { entity_id: string; media_id: string; enqueue?: string; radio_mode?: boolean }[] =
    [];
  let nextFlow = 1;
  const setState = (id: string, state: string, extra: Record<string, unknown> = {}) => {
    states = states.map((x) =>
      x.entity_id === id ? { ...x, state, attributes: { ...x.attributes, ...extra } } : x,
    );
  };
  const picture = () =>
    ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
      json: async () => ({}),
      text: async () => "",
      arrayBuffer: async () =>
        PICTURE.buffer.slice(PICTURE.byteOffset, PICTURE.byteOffset + PICTURE.length),
    }) as unknown as Awaited<ReturnType<Fetch>>;
  const day = (n: number, h: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => data,
  });
  const fetchImpl: Fetch = async (url, init) => {
    if (down) throw new TypeError("fetch failed");
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    // (No token: the browser's own request.) Where a sign-in page sends the browser back (Hearth passes it on from a pasted address).
    if (method === "GET" && p === "/auth/external/callback") {
      callbacks.push({
        code: u.searchParams.get("code") ?? "",
        state: u.searchParams.get("state") ?? "",
      });
      return u.searchParams.get("state") === "bad"
        ? reply(400, { message: "Invalid state" })
        : reply(200, {});
    }
    if (!headers.Authorization?.startsWith("Bearer e2e-")) return reply(401, {});
    if (method === "GET" && p === "/api/config")
      return reply(200, { version: "2026.10.2", state: "RUNNING" });
    if (method === "GET" && p === "/api/states") return reply(200, states);
    // Reload: a Google Calendar whose sign-in Google refused asks for it again, as the real one does.
    const reloadEntry = /^\/api\/config\/config_entries\/entry\/(\w+)\/reload$/.exec(p);
    if (method === "POST" && reloadEntry?.[1] === "google0001") {
      if (googleLost) {
        googleLost = false;
        flows.reauth00000002 = { handler: "google", stage: 0, reauth: true };
      }
      return reply(200, { require_restart: false });
    }
    if (method === "GET" && p === "/api/config/config_entries/entry") {
      const google =
        googleLost || Object.values(flows).some((f) => f.reauth && f.handler === "google")
          ? [
              {
                entry_id: "google0001",
                domain: "google",
                title: "Google Calendar",
                state: "setup_error",
              },
            ]
          : [];
      const all = [
        ...entries,
        ...google,
        ...(musicAssistant
          ? [
              {
                entry_id: "ma0000001",
                domain: "music_assistant",
                title: "Music Assistant",
                state: "loaded",
              },
            ]
          : []),
      ] as { domain?: string }[];
      const d = u.searchParams.get("domain");
      return reply(200, d ? all.filter((e) => e.domain === d) : all);
    }
    // Music Assistant's actions: search, the library, and playing on its speaker.
    if (method === "POST" && p.startsWith("/api/services/music_assistant/")) {
      if (!musicAssistant) return reply(400, { message: "Service not found" });
      const b = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      const item = (kind: string, id: string, name: string, by?: string) => ({
        media_type: kind,
        uri: `ytmusic://${kind}/${id}`,
        name,
        image: "",
        ...(by
          ? { artists: [{ media_type: "artist", uri: `ytmusic://artist/${by}`, name: by }] }
          : {}),
      });
      const LIB: Record<string, unknown[]> = {
        playlist: [item("playlist", "p1", "Road Trip"), item("playlist", "p2", "Late Night")],
        album: [item("album", "a1", "Moon Palace", "Stick Figure")],
        artist: [item("artist", "r1", "Stick Figure")],
        track: [
          item("track", "t1", "Summertime Sadness", "Lana Del Rey"),
          item("track", "t2", "Beauty Queen", "Holly Macve"),
        ],
      };
      if (p.endsWith("/search")) {
        const q = String(b.name ?? "").toLowerCase();
        const has = (x: unknown) => JSON.stringify(x).toLowerCase().includes(q);
        return reply(200, {
          changed_states: [],
          service_response: {
            tracks: LIB.track!.filter(has),
            albums: LIB.album!.filter(has),
            artists: LIB.artist!.filter(has),
            playlists: LIB.playlist!.filter(has),
          },
        });
      }
      if (p.endsWith("/get_library"))
        return reply(200, {
          changed_states: [],
          service_response: { items: LIB[String(b.media_type)] ?? [] },
        });
      if (p.endsWith("/play_media")) {
        played.push(b as (typeof played)[number]);
        const t = (Object.values(LIB).flat() as { uri: string; name: string }[]).find(
          (x) => x.uri === b.media_id,
        );
        setState(String(b.entity_id), "playing", { media_title: t?.name ?? "Something" });
        return reply(200, []);
      }
      if (p.endsWith("/transfer_queue")) {
        // The queue moves: the new speaker plays what the old one did, the old one goes quiet.
        const from = states.find((x) => x.entity_id === b.source_player);
        setState(String(b.entity_id), "playing", {
          media_title: from?.attributes?.media_title ?? "Something",
        });
        setState(String(b.source_player), "idle");
        return reply(200, []);
      }
      return reply(400, { message: "Service not found" });
    }
    const config = /^\/api\/config\/(automation|script|scene)\/config\/([\w-]+)$/.exec(p);
    if (method === "GET" && config) {
      const c = configs[`${config[1]}/${config[2]}`];
      return c ? reply(200, c) : reply(404, { message: "Resource not found" });
    }
    if (method === "POST" && config && config[1] !== "automation") {
      const b = JSON.parse(String(init.body ?? "{}")) as { alias?: string; name?: string };
      configs[`${config[1]}/${config[2]}`] = b;
      const name = String(b.alias ?? b.name ?? config[2]);
      const entity = `${config[1]}.${config[2]}`;
      if (config[1] === "script" && !states.some((x) => x.entity_id === entity))
        states = [
          ...states,
          { entity_id: entity, state: "off", attributes: { friendly_name: name } },
        ];
      else if (config[1] === "script") setState(entity, "off", { friendly_name: name });
      else
        states = states.map((x) =>
          x.attributes?.id === config[2]
            ? { ...x, attributes: { ...x.attributes, friendly_name: name } }
            : x,
        );
      return reply(200, { result: "ok" });
    }
    if (method === "DELETE" && config && config[1] !== "automation") {
      if (!configs[`${config[1]}/${config[2]}`])
        return reply(404, { message: "Resource not found" });
      delete configs[`${config[1]}/${config[2]}`];
      states = states.filter((x) =>
        config[1] === "script"
          ? x.entity_id !== `script.${config[2]}`
          : x.attributes?.id !== config[2],
      );
      return reply(200, { result: "ok" });
    }
    const reload = /^\/api\/config\/config_entries\/entry\/(\w+)\/reload$/.exec(p);
    if (method === "POST" && reload) {
      entries = entries.map((e) =>
        e.entry_id === reload[1] ? { ...e, state: "loaded", reason: "" } : e,
      );
      return reply(200, { require_restart: false });
    }
    const one = /^\/api\/states\/([\w.]+)$/.exec(p);
    if (method === "GET" && one) {
      const st = states.find((x) => x.entity_id === one[1]);
      return st ? reply(200, st) : reply(404, { message: "Entity not found." });
    }
    if (method === "GET" && /^\/api\/(camera_proxy|media_player_proxy|image\/serve)\//.test(p))
      return picture();
    if (method === "GET" && p === "/api/calendars/calendar.family") {
      calEvents ??= [
        {
          uid: "ev-dentist",
          summary: "Dentist",
          start: { dateTime: day(0, 23).toISOString() },
          end: { dateTime: day(0, 23).toISOString() },
          location: "Main Street",
        },
        {
          uid: "ev-soccer",
          summary: "Soccer practice",
          start: { dateTime: day(1, 17).toISOString() },
          end: { dateTime: day(1, 18).toISOString() },
        },
        {
          uid: "ev-grandma",
          summary: "Grandma's birthday",
          start: { date: day(2, 0).toLocaleDateString("en-CA") },
          end: { date: day(3, 0).toLocaleDateString("en-CA") },
        },
      ];
      const from = Date.parse(u.searchParams.get("start") ?? "") || 0;
      const to = Date.parse(u.searchParams.get("end") ?? "") || Infinity;
      return reply(
        200,
        calEvents.filter((e) => {
          const s = Date.parse(e.start.dateTime ?? `${e.start.date}T12:00:00`);
          return s >= from - 86_400_000 && s <= to;
        }),
      );
    }
    if (method === "POST" && p === "/api/services/calendar/create_event") {
      const b = JSON.parse(String(init.body ?? "{}")) as Record<string, string>;
      calEvents ??= [];
      calEvents.push({
        uid: `ev-${calEvents.length + 1}-${Date.now()}`,
        summary: b.summary ?? "",
        start: b.start_date ? { date: b.start_date } : { dateTime: b.start_date_time },
        end: b.end_date ? { date: b.end_date } : { dateTime: b.end_date_time },
        ...(b.location ? { location: b.location } : {}),
        ...(b.description ? { description: b.description } : {}),
      });
      return reply(200, []);
    }
    const body = (): Record<string, unknown> => JSON.parse(String(init.body ?? "{}"));
    if (
      method === "POST" &&
      p === "/api/services/weather/get_forecasts" &&
      body().type === "hourly"
    )
      return reply(200, {
        changed_states: [],
        service_response: {
          "weather.forecast_home": {
            forecast: [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
              datetime: new Date(Math.floor(Date.now() / 3_600_000 + n) * 3_600_000).toISOString(),
              condition: n < 3 ? "partlycloudy" : "rainy",
              temperature: 18 - n * 0.5,
              precipitation_probability: n < 3 ? 10 : 60,
            })),
          },
        },
      });
    if (method === "POST" && p === "/api/services/weather/get_forecasts")
      return reply(200, {
        changed_states: [],
        service_response: {
          "weather.forecast_home": {
            forecast: [1, 2, 3, 4, 5].map((n) => ({
              datetime: day(n, 12).toISOString(),
              condition: n % 2 ? "sunny" : "rainy",
              temperature: 18 + n,
              templow: 9 + n,
              precipitation_probability: n % 2 ? 0 : 70,
            })),
          },
        },
      });
    if (method === "POST" && p === "/api/services/todo/get_items") {
      const ids = ([] as string[]).concat(body().entity_id as string | string[]);
      return reply(200, {
        changed_states: [],
        service_response: Object.fromEntries(ids.map((id) => [id, { items: todo[id] ?? [] }])),
      });
    }
    const todoSvc = /^\/api\/services\/todo\/(add_item|update_item|remove_item)$/.exec(p);
    if (method === "POST" && todoSvc) {
      const b = body() as { entity_id: string; item: string; status?: string };
      const list = (todo[b.entity_id] ??= []);
      if (todoSvc[1] === "add_item")
        list.push({ uid: `n${Date.now()}`, summary: b.item, status: "needs_action" });
      else if (todoSvc[1] === "update_item") {
        const it = list.find((x) => x.uid === b.item);
        if (!it) return reply(400, { message: "Unable to find to-do list item" });
        it.status = b.status ?? it.status;
      } else todo[b.entity_id] = list.filter((x) => x.uid !== b.item);
      return reply(200, []);
    }
    const homeSvc =
      /^\/api\/services\/(media_player|lock|cover|alarm_control_panel|light|climate)\/(\w+)$/.exec(
        p,
      );
    if (method === "POST" && homeSvc && homeSvc[2] !== "toggle") {
      const b = body() as Record<string, unknown> & { entity_id: string };
      const st = states.find((x) => x.entity_id === b.entity_id);
      if (!st) return reply(400, { message: "Entity not found" });
      const d = homeSvc[1]!;
      const op = homeSvc[2]!;
      if (d === "media_player") {
        if (op === "media_play_pause")
          setState(st.entity_id, st.state === "playing" ? "paused" : "playing");
        else if (op === "volume_set")
          setState(st.entity_id, st.state, { volume_level: b.volume_level });
        else if (op === "volume_mute")
          setState(st.entity_id, st.state, { is_volume_muted: b.is_volume_muted });
        else if (op === "select_source") setState(st.entity_id, st.state, { source: b.source });
        else if (op === "media_next_track")
          setState(st.entity_id, "playing", { media_title: "Second Song" });
        else if (op === "turn_off") setState(st.entity_id, "off");
        else if (op === "turn_on") setState(st.entity_id, "idle");
        else if (op === "media_pause") setState(st.entity_id, "paused");
        else if (op === "media_play") setState(st.entity_id, "playing");
        else if (op === "play_media" && b.media_content_type === "cast") {
          const m = JSON.parse(String(b.media_content_id)) as {
            app_name?: string;
            media_id?: string;
          };
          if (m.app_name !== "youtube") return reply(400, { message: "Unknown app" });
          setState(st.entity_id, "playing", {
            media_title: `YouTube video ${m.media_id}`,
            app_name: "YouTube",
          });
        } else if (op === "shuffle_set") setState(st.entity_id, st.state, { shuffle: b.shuffle });
        else if (op === "repeat_set") setState(st.entity_id, st.state, { repeat: b.repeat });
      } else if (d === "climate") {
        if (op === "set_temperature")
          setState(st.entity_id, st.state, { temperature: b.temperature });
        else if (op === "set_hvac_mode")
          setState(st.entity_id, String(b.hvac_mode), {
            hvac_action: b.hvac_mode === "off" ? "off" : "idle",
          });
      } else if (d === "lock") setState(st.entity_id, op === "unlock" ? "unlocked" : "locked");
      else if (d === "cover") setState(st.entity_id, op === "open_cover" ? "open" : "closed");
      else if (d === "light")
        setState(st.entity_id, "on", {
          brightness: Math.round((Number(b.brightness_pct ?? 100) / 100) * 255),
        });
      else {
        // The alarm asks for its own code (1234).
        if (st.attributes.code_format && b.code !== "1234")
          return reply(400, { message: "Invalid alarm code provided" });
        setState(
          st.entity_id,
          op === "alarm_disarm"
            ? "disarmed"
            : op.replace("alarm_", "armed_").replace("armed_arm_", "armed_"),
        );
      }
      return reply(200, []);
    }
    // Home Assistant's setup flows: a list, Spotify (an app first, then its sign-in), CalDAV.
    if (method === "POST" && p === "/api/config/config_entries/flow") {
      const handler = String(body().handler);
      const id = `flow${String(nextFlow++).padStart(8, "0")}`;
      // Google needs the owner's own Google app first (no app here in tests).
      if (handler === "google")
        return reply(200, { type: "abort", flow_id: id, handler, reason: "missing_credentials" });
      if (handler === "spotify" && !hasSpotifyApp)
        return reply(200, { type: "abort", flow_id: id, handler, reason: "missing_credentials" });
      flows[id] = { handler, stage: 0 };
      if (handler === "local_todo")
        return reply(200, {
          type: "form",
          flow_id: id,
          handler,
          step_id: "user",
          data_schema: [{ name: "todo_list_name", type: "string", required: true }],
          errors: {},
        });
      if (handler === "spotify")
        return reply(200, {
          type: "external",
          flow_id: id,
          handler,
          step_id: "auth",
          url: "https://accounts.spotify.com/authorize?client_id=fake",
        });
      if (handler === "music_assistant")
        return reply(200, {
          type: "form",
          flow_id: id,
          handler,
          step_id: "user",
          data_schema: [{ name: "url", type: "string", required: true }],
          errors: {},
        });
      if (handler === "caldav")
        return reply(200, {
          type: "form",
          flow_id: id,
          handler,
          step_id: "user",
          data_schema: [
            { name: "url", type: "string", required: true },
            { name: "username", type: "string", required: true },
            { name: "password", type: "string", required: true },
            { name: "verify_ssl", type: "boolean", required: false, default: true },
          ],
          errors: {},
        });
      return reply(200, { type: "abort", flow_id: id, handler, reason: "not_implemented" });
    }
    // Real Home Assistant removed this list from REST: it answers 405 (the live connection has it).
    if (method === "GET" && p === "/api/config/config_entries/flow")
      return reply(405, { message: "Method Not Allowed" });
    const flowStep = /^\/api\/config\/config_entries\/flow\/(\w+)$/.exec(p);
    const reauth = flowStep && flows[flowStep[1]!]?.reauth ? flows[flowStep[1]!]! : undefined;
    if (reauth && method === "GET")
      return reply(
        200,
        reauth.stage === 0
          ? {
              type: "form",
              flow_id: flowStep![1],
              handler: "google",
              step_id: "reauth_confirm",
              data_schema: [],
              errors: {},
            }
          : {
              type: "external",
              flow_id: flowStep![1],
              handler: "google",
              step_id: "auth",
              url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake",
            },
      );
    if (reauth && method === "POST") {
      if (reauth.stage === 0) {
        reauth.stage = 1;
        return reply(200, {
          type: "external",
          flow_id: flowStep![1],
          handler: "google",
          step_id: "auth",
          url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake",
        });
      }
      // Signed in: the calendar answers again, and the setup is finished.
      delete flows[flowStep![1]!];
      states = states.map((x) => (x.entity_id === "calendar.family" ? { ...x, state: "off" } : x));
      return reply(200, {
        type: "abort",
        flow_id: flowStep![1],
        handler: "google",
        reason: "reauth_successful",
      });
    }
    if (method === "POST" && flowStep) {
      const f = flows[flowStep[1]!];
      if (!f) return reply(404, { message: "Invalid flow specified" });
      const b = body();
      if (f.handler === "local_todo") {
        const name = String(b.todo_list_name ?? "List");
        const id = `todo.${name.toLowerCase().replace(/\W+/g, "_")}`;
        states = [...states, { entity_id: id, state: "0", attributes: { friendly_name: name } }];
        todo[id] = [];
        return reply(200, {
          type: "create_entry",
          flow_id: flowStep[1],
          handler: f.handler,
          title: name,
        });
      }
      // Music Assistant: its address, then its sign-in page, which returns a code.
      if (f.handler === "music_assistant") {
        if (f.stage === 0) {
          if (!/^https?:\/\/.+:8095$/.test(String(b.url ?? "")))
            return reply(200, {
              type: "form",
              flow_id: flowStep[1],
              handler: f.handler,
              step_id: "user",
              data_schema: [{ name: "url", type: "string", required: true }],
              errors: { base: "cannot_connect" },
            });
          f.stage = 1;
          return reply(200, {
            type: "external",
            flow_id: flowStep[1],
            handler: f.handler,
            step_id: "auth",
            url: `${String(b.url)}/login?return_url=x`,
          });
        }
        if (!b.code) return reply(400, { message: "No code" });
        musicAssistant = true;
        states = [
          ...states,
          {
            entity_id: "media_player.kitchen_speaker_ma",
            state: "idle",
            attributes: {
              friendly_name: "Kitchen speaker",
              supported_features: 1 | 16 | 32 | 16384,
              active_queue: "kitchen_ma",
            },
          },
        ];
        return reply(200, {
          type: "create_entry",
          flow_id: flowStep[1],
          handler: f.handler,
          title: "Music Assistant",
        });
      }
      if (f.handler === "caldav") {
        if (b.password !== "app-specific-pass")
          return reply(200, {
            type: "form",
            flow_id: flowStep[1],
            handler: f.handler,
            step_id: "user",
            data_schema: [
              { name: "url", type: "string", required: true },
              { name: "username", type: "string", required: true },
              { name: "password", type: "string", required: true },
            ],
            errors: { base: "invalid_auth" },
          });
        return reply(200, {
          type: "create_entry",
          flow_id: flowStep[1],
          handler: f.handler,
          title: String(b.username),
        });
      }
      // spotify, after its sign-in page
      states = [
        ...states,
        {
          entity_id: "media_player.spotify_alex",
          state: "idle",
          attributes: { friendly_name: "Spotify Alex", supported_features: 1 | 16 | 32 | 16384 },
        },
      ];
      return reply(200, {
        type: "create_entry",
        flow_id: flowStep[1],
        handler: f.handler,
        title: "Alex",
      });
    }
    const svc = /^\/api\/services\/(\w+)\/(\w+)$/.exec(p);
    if (method === "POST" && svc) {
      const id = (JSON.parse(String(init.body ?? "{}")) as { entity_id?: string }).entity_id;
      states = states.map((s) => {
        if (s.entity_id !== id) return s;
        if (svc[2] === "toggle") return { ...s, state: s.state === "on" ? "off" : "on" };
        if (svc[1] === "automation" && svc[2] === "turn_on") return { ...s, state: "on" };
        if (svc[1] === "automation" && svc[2] === "turn_off") return { ...s, state: "off" };
        if (svc[1] === "scene") return { ...s, state: new Date().toISOString() };
        runs.push({ id: s.entity_id, at: new Date().toISOString() });
        return { ...s, attributes: { ...s.attributes, last_triggered: new Date().toISOString() } };
      });
      return reply(200, []);
    }
    return reply(404, {});
  };
  // Run history, newest last: one old run that failed, plus every run made since.
  let runs: { id: string; at: string; error?: string }[] = [];
  const RUNS = () => [{ id: "script.goodnight", at: ago(20) }];
  runs = RUNS();
  const socket: SocketFactory = () => {
    const listeners: Record<string, ((ev: { data?: unknown }) => void)[]> = {};
    const emit = (type: string, data?: unknown) =>
      setTimeout(() => (listeners[type] ?? []).forEach((f) => f({ data: JSON.stringify(data) })));
    const ws: SocketLike = {
      addEventListener: (type, fn) => {
        (listeners[type] ??= []).push(fn);
        if (type === "message" && listeners.message!.length === 1)
          emit("message", { type: "auth_required" });
      },
      close: () => undefined,
      send: (raw) => {
        const m = JSON.parse(raw) as {
          type: string;
          id?: number;
          domain?: string;
          item_id?: string;
          uid?: string;
        };
        if (m.type === "auth") return emit("message", { type: "auth_ok" });
        // The setups Home Assistant started itself (its "sign in again" ones), as it lists them.
        if (m.type === "config_entries/flow/progress")
          return emit("message", {
            type: "result",
            id: m.id,
            success: true,
            result: Object.entries(flows)
              .filter(([, f]) => f.reauth)
              .map(([id, f]) => ({
                flow_id: id,
                handler: f.handler,
                step_id: "reauth_confirm",
                context: { source: "reauth" },
              })),
          });
        if (m.type === "config/area_registry/list")
          return emit("message", {
            type: "result",
            id: m.id,
            success: true,
            result: [
              { area_id: "kitchen", name: "Kitchen" },
              { area_id: "living_room", name: "Living room" },
              { area_id: "den", name: "Den" },
            ],
          });
        if (m.type === "config/device_registry/list")
          return emit("message", {
            type: "result",
            id: m.id,
            success: true,
            result: [
              {
                id: "dev-sonos-era",
                name: "Sonos Era 100",
                name_by_user: null,
                model: "Era 100",
                manufacturer: "Sonos",
                area_id: "den",
              },
            ],
          });
        if (m.type === "config/entity_registry/list")
          return emit("message", {
            type: "result",
            id: m.id,
            success: true,
            result: [
              { entity_id: "light.kitchen", area_id: "kitchen" },
              { entity_id: "light.living_room", area_id: "living_room" },
              { entity_id: "switch.server_fan", area_id: null, entity_category: null },
              { entity_id: "sensor.commute_to_work", platform: "waze_travel_time" },
              { entity_id: "calendar.family", platform: "google" },
              { entity_id: "event.front_door_doorbell", device_id: "porch" },
              { entity_id: "camera.front_porch", device_id: "porch" },
              { entity_id: "sensor.home_team", platform: "teamtracker" },
              { entity_id: "sensor.bin_day", platform: "waste_collection_schedule" },
              { entity_id: "sensor.living_room_temperature", area_id: "living_room" },
              // A Google Cast device: Watch on TV plays YouTube videos on it.
              { entity_id: "media_player.kitchen_speaker", platform: "cast" },
              {
                entity_id: "media_player.sonos_era_100",
                platform: "sonos",
                device_id: "dev-sonos-era",
              },
              ...(musicAssistant
                ? [{ entity_id: "media_player.kitchen_speaker_ma", platform: "music_assistant" }]
                : []),
              ...(livingRoomMa
                ? [{ entity_id: "media_player.living_room_ma", platform: "music_assistant" }]
                : []),
            ],
          });
        if (m.type === "energy/get_prefs")
          return emit("message", {
            type: "result",
            id: m.id,
            success: true,
            result: {
              energy_sources: [
                {
                  type: "grid",
                  flow_from: [{ stat_energy_from: "sensor.grid_energy" }],
                  stat_rate: "sensor.home_power",
                },
                { type: "solar", stat_energy_from: "sensor.solar_energy" },
              ],
            },
          });
        if (m.type === "recorder/statistic_during_period") {
          const id = (m as { statistic_id?: string }).statistic_id;
          return emit("message", {
            type: "result",
            id: m.id,
            success: true,
            result: {
              change: id === "sensor.grid_energy" ? 8.42 : id === "sensor.solar_energy" ? 6.1 : 0,
            },
          });
        }
        if (m.type === "calendar/event/delete") {
          const before = calEvents?.length ?? 0;
          calEvents = (calEvents ?? []).filter((e) => e.uid !== m.uid);
          return emit("message", {
            type: "result",
            id: m.id,
            success: calEvents.length < before,
            ...(calEvents.length < before
              ? { result: null }
              : { error: { message: "Event not found" } }),
          });
        }
        if (m.type === "application_credentials/create") {
          hasSpotifyApp = true;
          return emit("message", {
            type: "result",
            id: m.id,
            success: true,
            result: { id: "cred1" },
          });
        }
        if (m.type === "trace/list") {
          const entity = states.find(
            (s) =>
              s.entity_id.startsWith(`${m.domain}.`) &&
              (s.attributes.id === m.item_id || s.entity_id === `${m.domain}.${m.item_id}`),
          );
          const result = runs
            .filter((r) => r.id === entity?.entity_id)
            .map((r, i) => ({
              run_id: String(i),
              state: "stopped",
              script_execution: r.error ? "error" : "finished",
              ...(r.error ? { error: r.error } : {}),
              timestamp: { start: r.at, finish: r.at },
            }));
          return emit("message", { type: "result", id: m.id, success: true, result });
        }
        emit("message", { type: "result", id: m.id, success: true, result: [] });
      },
    };
    return ws;
  };
  return {
    fetch: fetchImpl,
    socket,
    reset: () => {
      states = STATES();
      entries = ENTRIES();
      runs = RUNS();
      todo = TODO();
      hasSpotifyApp = false;
      flows = {};
      down = false;
      musicAssistant = false;
      livingRoomMa = false;
      played.length = 0;
      calEvents = undefined;
      callbacks.length = 0;
      configs = structuredClone(CONFIGS);
    },
    /** Browser tests: the weather, the sun, and whether Home Assistant answers at all. */
    home: (h: {
      condition?: string;
      sunUp?: boolean;
      down?: boolean;
      ring?: boolean;
      musicAssistant?: boolean;
      /** A second Music Assistant speaker, playing, to move the music from. */
      livingRoom?: boolean;
      googleSignInAgain?: boolean;
      googleSignInLost?: boolean;
    }) => {
      if (h.googleSignInLost) {
        googleLost = true;
        states = states.map((x) =>
          x.entity_id === "calendar.family" ? { ...x, state: "unavailable" } : x,
        );
      }
      if (h.googleSignInAgain) {
        flows.reauth00000001 = { handler: "google", stage: 0, reauth: true };
        states = states.map((x) =>
          x.entity_id === "calendar.family" ? { ...x, state: "unavailable" } : x,
        );
      }
      // Browser tests: Music Assistant already connected, with its speaker.
      if (h.musicAssistant && !musicAssistant) {
        musicAssistant = true;
        states = [
          ...states,
          {
            entity_id: "media_player.kitchen_speaker_ma",
            state: "idle",
            attributes: {
              friendly_name: "Kitchen speaker",
              supported_features: 1 | 16 | 32 | 16384,
              active_queue: "kitchen_ma",
            },
          },
        ];
      }
      if (h.livingRoom && !livingRoomMa) {
        livingRoomMa = true;
        states = [
          ...states,
          {
            entity_id: "media_player.living_room_ma",
            state: "playing",
            attributes: {
              friendly_name: "Living room speaker",
              supported_features: 1 | 16 | 32 | 16384,
              active_queue: "living_room_ma",
              media_title: "Moon Palace",
            },
          },
        ];
      }
      if (h.ring) setState("event.front_door_doorbell", new Date().toISOString());
      if (h.down !== undefined) down = h.down;
      const w = states.find((s) => s.entity_id === "weather.forecast_home");
      if (w && h.condition) w.state = h.condition;
      const sun = states.find((s) => s.entity_id === "sun.sun");
      if (sun && h.sunUp !== undefined) sun.state = h.sunUp ? "above_horizon" : "below_horizon";
    },
  };
}
