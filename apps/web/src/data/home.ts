import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/** The home dashboard (11-04): what a wall tablet shows, read from Home Assistant. */
export interface HomeData {
  serviceId: string;
  serviceName: string;
  pinSet: boolean;
  /** This screen is a paired home tablet (no connecting, no PIN changes here). */
  tablet: boolean;
  place: { name: string; timeZone?: string; tempUnit: string };
  weather?: {
    entity: string;
    name: string;
    condition: string;
    temperature?: number;
    humidity?: number;
    wind?: number;
    windUnit?: string;
    windBearing?: number;
    feelsLike?: number;
    rainChance?: number;
    unit: string;
    forecast: { date: string; condition?: string; high?: number; low?: number; rain?: number }[];
    hourly: { time: string; condition?: string; temperature?: number; rain?: number }[];
    /** Where it comes from ("National Weather Service") and the place it is for. */
    sourceName?: string;
    placeName?: string;
  };
  /** More places' weather, small. */
  cities?: {
    label: string;
    condition: string;
    temperature?: number;
    high?: number;
    low?: number;
    unit: string;
  }[];
  sun?: { up: boolean; rising?: string; setting?: string };
  music: {
    entity: string;
    /** What Hearth calls it: the owner's own name for it, else a friendly name. */
    name: string;
    /** The name before any the owner gave it in Hearth (Reset name). */
    originalName?: string;
    /** What Home Assistant reports, which Music Assistant knows it by. */
    systemName?: string;
    /** The owner renamed it in Hearth. */
    renamed?: true;
    /** A Music Assistant speaker: it plays from the music library and starts mixes. */
    musicAssistant?: true;
    /** Its Music Assistant queue, for Up Next. */
    queue?: string;
    /** A Google Cast device: it can play a YouTube video itself. */
    cast?: true;
    state: string;
    title?: string;
    artist?: string;
    album?: string;
    app?: string;
    picture: boolean;
    volume?: number;
    muted?: boolean;
    source?: string;
    sources: string[];
    position?: number;
    duration?: number;
    positionAt?: string;
    shuffle?: boolean;
    repeat?: string;
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
  /** Calendars Home Assistant has but can't read right now. */
  calendarsDown?: number;
  /** Services Home Assistant is waiting for the owner to sign in to again. */
  signInAgain?: { handler: string; label: string; for: string }[];
  /** Services whose calendars can't be read with no sign-in waiting: Connect asks afresh. */
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
    needsCode?: boolean;
  }[];
  scenes: { entity: string; name: string }[];
  climate: {
    entity: string;
    name: string;
    room?: string;
    mode: string;
    modes: string[];
    action?: string;
    current?: number;
    target?: number;
    min?: number;
    max?: number;
    step?: number;
  }[];
  people: { entity: string; name: string; state: string; picture: boolean; since?: string }[];
  travel: {
    entity: string;
    name: string;
    minutes?: number;
    origin?: string;
    destination?: string;
    route?: string;
    distance?: number;
  }[];
  doorbells: { entity: string; name: string; last?: string; camera?: string }[];
  plants: { entity: string; name: string; state: string; problem?: string; moisture?: number }[];
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
  waste: { entity: string; name: string; state: string; days?: number; types?: string[] }[];
  energy?: {
    unit: "kWh";
    grid?: number;
    returned?: number;
    solar?: number;
    gas?: number;
    gasUnit?: string;
    powerNow?: number;
  };
  devices: HomeDevice[];
  catalog?: HomeDevice[];
}

export interface HomeDevice {
  entity: string;
  name: string;
  room?: string;
  kind: string;
  state: string;
  unit?: string;
  deviceClass?: string;
  toggle: boolean;
}

export function useHome(service?: string, watch: string[] = []) {
  const w = watch.join(",");
  const query = [
    service ? `service=${encodeURIComponent(service)}` : "",
    w ? `watch=${encodeURIComponent(w)}` : "",
  ]
    .filter(Boolean)
    .join("&");
  return useQuery({
    queryKey: ["home", service ?? "", w],
    queryFn: () => api<HomeData>("GET", `/api/home${query ? `?${query}` : ""}`),
    // Changing what a Devices widget shows keeps the dashboard on screen while it reads again.
    placeholderData: (previous) => previous,
    // A wall tablet keeps up with the house.
    refetchInterval: 8000,
    refetchOnWindowFocus: true,
  });
}

export const homePicture = (entity: string, service?: string, bust?: number | string) =>
  `/api/home/picture?entity=${encodeURIComponent(entity)}${service ? `&service=${encodeURIComponent(service)}` : ""}${bust ? `&t=${encodeURIComponent(String(bust))}` : ""}`;

export interface HomeTap {
  entity: string;
  action: string;
  value?: string | number | boolean;
  item?: string;
  code?: string;
  pin?: string;
}

/** A tap: done straight away, then the dashboard reads the house again. */
export function useHomeAction(service?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tap: HomeTap) =>
      api<{ done: string; state?: string }>("POST", "/api/home/action", {
        ...(service ? { service } : {}),
        ...tap,
      }),
    // Play and pause show at once (11-06: the screen took seconds to catch up, so a second
    // tap restarted the music); Home Assistant is asked again once it has had a moment.
    onMutate: (tap) => {
      if (tap.action !== "play" && tap.action !== "pause") return;
      const state = tap.action === "pause" ? "paused" : "playing";
      void qc.cancelQueries({ queryKey: ["home"] });
      qc.setQueriesData<HomeData>({ queryKey: ["home"] }, (d) =>
        d
          ? { ...d, music: d.music.map((m) => (m.entity === tap.entity ? { ...m, state } : m)) }
          : d,
      );
    },
    onSettled: (_r, _e, tap) => {
      const again = () => void qc.invalidateQueries({ queryKey: ["home"] });
      if (tap.action === "play" || tap.action === "pause") window.setTimeout(again, 1500);
      else again();
    },
  });
}

export interface FlowStep {
  notYet?: boolean;
  flowId?: string;
  type: "form" | "external" | "done" | "stopped" | "progress";
  /** Home Assistant was waiting for this sign-in again: this renews the connection. */
  renewing?: boolean;
  /** Home Assistant's address in a browser (My Home Assistant asks for it once per browser). */
  homeAddress?: string;
  handler: string;
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
}

/** Connecting a service through Home Assistant's own setup, a step at a time. */
export function useHomeConnect(service?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      step:
        | { start: string }
        | { handler: string; flowId: string; data: Record<string, unknown> }
        | { handler: string; flowId: string; callback: string }
        | { app: string; clientId: string; clientSecret: string; saveAs?: string }
        | { app: string; vaultSecret: string },
    ) =>
      api<FlowStep | { ok: true }>("POST", "/api/home/connect", {
        ...(service ? { service } : {}),
        ...step,
      }),
    onSuccess: (r) => {
      if ("type" in r && r.type === "done") void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });
}

export function useSetPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pin: string | null) => api<void>("PUT", "/api/home/pin", { pin }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["home"] }),
  });
}

/** Everything a Devices widget could show, read when choosing. */
export function useHomeCatalog(service: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["home-catalog", service ?? ""],
    queryFn: () =>
      api<HomeData>(
        "GET",
        `/api/home?catalog=1${service ? `&service=${encodeURIComponent(service)}` : ""}`,
      ),
    enabled,
    staleTime: 60_000,
  });
}

/* ---------------- the household board (Hearth keeps it, every screen shares it) ---------------- */

export interface BoardTask {
  id: string;
  title: string;
  kind: "chore" | "reminder";
  who?: string;
  stars?: number;
  schedule: { type: "week" | "every"; days?: number[]; n?: number; start?: string };
  done: string[];
  added?: string;
}
export interface HomeBoard {
  notes: { id: string; text: string; by?: string; at: string }[];
  countdowns: { id: string; title: string; date: string }[];
  tasks: BoardTask[];
  stars: Record<string, number>;
  feeds: { url: string; name?: string }[];
  photos?: { album?: string; albumName?: string };
}
export type BoardChange =
  | { op: "note.add"; text: string; by?: string }
  | { op: "note.remove"; id: string }
  | { op: "countdown.add"; title: string; date: string }
  | { op: "countdown.remove"; id: string }
  | {
      op: "task.add";
      kind: "chore" | "reminder";
      title: string;
      who?: string;
      stars?: number;
      schedule: BoardTask["schedule"];
    }
  | { op: "task.remove"; id: string }
  | { op: "task.done" | "task.undo"; id: string; on: string }
  | { op: "stars.reset"; who?: string }
  | { op: "feeds.set"; feeds: { url: string; name?: string }[] }
  | { op: "photos.set"; album?: string; albumName?: string };

export function useBoard(enabled = true) {
  return useQuery({
    queryKey: ["home-board"],
    queryFn: () => api<HomeBoard>("GET", "/api/home/board"),
    refetchInterval: 20_000,
    enabled,
  });
}

export function useBoardChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: BoardChange) => api<HomeBoard>("POST", "/api/home/board", c),
    onSuccess: (b) => {
      qc.setQueryData(["home-board"], b);
      void qc.invalidateQueries({ queryKey: ["home-news"] });
      void qc.invalidateQueries({ queryKey: ["home-photos"] });
    },
  });
}

export interface Headline {
  title: string;
  link?: string;
  source: string;
  at?: string;
}
export function useNews(enabled: boolean) {
  return useQuery({
    queryKey: ["home-news"],
    queryFn: () => api<{ items: Headline[]; problems: string[] }>("GET", "/api/home/news"),
    refetchInterval: 10 * 60_000,
    enabled,
  });
}

export interface FramePhotos {
  connected: boolean;
  serviceName?: string;
  photos: string[];
  albums: { id: string; name: string; count: number }[];
}
export function usePhotos(enabled: boolean) {
  return useQuery({
    queryKey: ["home-photos"],
    queryFn: () => api<FramePhotos>("GET", "/api/home/photos"),
    refetchInterval: 30 * 60_000,
    staleTime: 10 * 60_000,
    enabled,
  });
}
export const framePhoto = (id: string) => `/api/home/photo?id=${encodeURIComponent(id)}`;

/* The music library on the Media page (through Home Assistant's Music Assistant). */
export type MusicKind = "track" | "album" | "artist" | "playlist" | "radio";
export type MusicShelf = "playlist" | "album" | "artist" | "track" | "recent";
export type MusicHow = "play" | "mix" | "next" | "add";
export interface MusicItem {
  uri: string;
  kind: MusicKind;
  name: string;
  by?: string;
  album?: string;
  image?: string;
}

const svc = (service?: string) => (service ? `&service=${encodeURIComponent(service)}` : "");

export function useMusicLibrary(service: string | undefined, shelf: MusicShelf, enabled: boolean) {
  return useQuery({
    queryKey: ["home-music", "library", service ?? "", shelf],
    queryFn: () =>
      api<{ items: MusicItem[] }>("GET", `/api/home/music/library?shelf=${shelf}${svc(service)}`),
    enabled,
    staleTime: 60_000,
  });
}

export function useMusicSearch(service: string | undefined, q: string, enabled: boolean) {
  return useQuery({
    queryKey: ["home-music", "search", service ?? "", q],
    queryFn: () =>
      api<{
        tracks: MusicItem[];
        albums: MusicItem[];
        artists: MusicItem[];
        playlists: MusicItem[];
      }>("GET", `/api/home/music/search?q=${encodeURIComponent(q)}${svc(service)}`),
    enabled: enabled && q.length > 0,
    staleTime: 60_000,
  });
}

export function useMusicPlay(service?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: {
      entity: string;
      uri: string;
      kind: MusicKind;
      how: MusicHow;
      name?: string;
      /** Play all: the rest of a row's songs. */
      more?: string[];
    }) =>
      api<{ done: string }>("POST", "/api/home/music/play", {
        ...(service ? { service } : {}),
        ...p,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["home"] }),
  });
}

export interface MusicRow {
  id: string;
  title: string;
  /** The music service the row is from; none for the library's rows. */
  service?: string;
  items: MusicItem[];
}

/** The music service's own rows (Listen again, Mixed for you, ...) and the library's. */
export function useMusicHome(enabled: boolean) {
  return useQuery({
    queryKey: ["home-music", "home"],
    queryFn: () => api<{ rows: MusicRow[]; linked: boolean; youtube?: boolean; youtubeError?: string }>(
        "GET",
        "/api/home/music/home",
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Inside a playlist, an album or an artist. */
export function useMusicOpen(uri: string | undefined) {
  return useQuery({
    queryKey: ["home-music", "open", uri ?? ""],
    queryFn: () =>
      api<{ item?: MusicItem; tracks: MusicItem[]; albums: MusicItem[] }>(
        "GET",
        `/api/home/music/open?uri=${encodeURIComponent(uri ?? "")}`,
      ),
    enabled: Boolean(uri),
    staleTime: 5 * 60_000,
  });
}

/* The calendar page: events of every calendar for a range, and changing them. */
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
  repeats: boolean;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  description?: string;
}

export function useCalendar(service: string | undefined, start: string, end: string) {
  return useQuery({
    queryKey: ["home-calendar", service ?? "", start, end],
    queryFn: () =>
      api<{ calendars: CalendarInfo[]; events: CalendarEvent[] }>(
        "GET",
        `/api/home/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}${service ? `&service=${encodeURIComponent(service)}` : ""}`,
      ),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

type EventBody = {
  entity: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
};
export function useCalendarChange(service?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      c:
        | ({ action: "add" } & EventBody)
        | ({ action: "change"; uid: string; recurrenceId?: string } & EventBody)
        | { action: "delete"; entity: string; uid: string; recurrenceId?: string; title?: string },
    ) => api<{ done: string }>("POST", "/api/home/calendar", { ...(service ? { service } : {}), ...c }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["home-calendar"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });
}

/* The Scenes widget's editor: a scene as its devices, saving and deleting it. */
export interface SceneChoice {
  entity: string;
  name: string;
  kind: string;
  room?: string;
  dim: boolean;
  color: boolean;
}
export type SceneItem =
  | {
      kind: "device";
      ref?: string;
      entity: string;
      on: boolean;
      brightness?: number;
      color?: [number, number, number];
    }
  | { kind: "other"; ref: string; summary: string };
export interface SceneDetail {
  entity?: string;
  name: string;
  type: "script" | "scene";
  editable: boolean;
  why?: string;
  items: SceneItem[];
  choices: SceneChoice[];
}

export function useScene(service: string | undefined, entity: string | undefined) {
  return useQuery({
    queryKey: ["home-scene", service ?? "", entity ?? "new"],
    queryFn: () => {
      const q = new URLSearchParams();
      if (entity) q.set("entity", entity);
      if (service) q.set("service", service);
      return api<SceneDetail>("GET", `/api/home/scene${q.size ? `?${q}` : ""}`);
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

type SceneSaveItem =
  | { ref: string; keep: true }
  | {
      ref?: string;
      entity: string;
      on: boolean;
      brightness?: number;
      color?: [number, number, number];
    };
export function useSceneChange(service?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      c:
        | { action: "save"; entity?: string; name: string; items: SceneSaveItem[] }
        | { action: "delete"; entity: string },
    ) =>
      api<{ done: string; entity?: string }>("POST", "/api/home/scene", {
        ...(service ? { service } : {}),
        ...c,
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["home-scene"] });
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });
}

/** The song's official music video on YouTube (null when it has none). */
export function useMusicVideo(title?: string, artist?: string) {
  return useQuery({
    queryKey: ["home-music-video", title ?? "", artist ?? ""],
    queryFn: () =>
      api<{ video: string | null }>(
        "GET",
        `/api/home/music/video?title=${encodeURIComponent(title ?? "")}&artist=${encodeURIComponent(artist ?? "")}`,
      ),
    enabled: Boolean(title && artist),
    staleTime: 6 * 60 * 60_000,
    retry: false,
  });
}

/** Whether Hearth can make a page a Music Assistant speaker (it holds Music Assistant's key). */
export function useSpeakerReady() {
  return useQuery({
    queryKey: ["home-speaker"],
    queryFn: () => api<{ linked: boolean }>("GET", "/api/home/speaker"),
    staleTime: 60_000,
  });
}

/* The weather's places (the first is the main one) and source. */
export interface WeatherPlace {
  label: string;
  lat: number;
  lon: number;
}
export interface WeatherChoice {
  source: "auto" | "homeassistant";
  places: WeatherPlace[];
}
export function useWeatherPlaces(enabled = true) {
  return useQuery({
    queryKey: ["home-weather-places"],
    queryFn: () => api<WeatherChoice>("GET", "/api/home/weather/places"),
    enabled,
  });
}
export function useSetWeatherPlaces() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: WeatherChoice) => api<WeatherChoice>("POST", "/api/home/weather/places", v),
    onSuccess: (v) => {
      qc.setQueryData(["home-weather-places"], v);
      void qc.invalidateQueries({ queryKey: ["home"] });
    },
  });
}
export function useFindWeatherPlace(q: string) {
  return useQuery({
    queryKey: ["home-weather-find", q],
    queryFn: () =>
      api<{ places: WeatherPlace[] }>("GET", `/api/home/weather/find?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
    staleTime: 5 * 60_000,
  });
}

/** Watch on TV: the music video on a Google Cast TV. */
export function useVideoOnTv(service?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { tv: string; videoId: string; pause?: string }) =>
      api<{ done: string }>("POST", "/api/home/music/video-tv", {
        ...(service ? { service } : {}),
        ...p,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["home"] }),
  });
}

/** The Hearth computer as a speaker (on by itself), and turning it on or off. */
export interface HostSpeaker {
  on: boolean;
  name: string;
  state: "off" | "connecting" | "ready" | "playing" | "no-sound" | "not-linked" | "error";
  detail?: string;
}
export function useHostSpeaker(enabled = true) {
  return useQuery({
    queryKey: ["home-host-speaker"],
    queryFn: () => api<HostSpeaker>("GET", "/api/home/speaker/host"),
    enabled,
    refetchInterval: 5000,
  });
}
export function useSetHostSpeaker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { on: boolean; name?: string }) =>
      api<HostSpeaker>("POST", "/api/home/speaker/host", v),
    onSuccess: (v) => qc.setQueryData(["home-host-speaker"], v),
  });
}
