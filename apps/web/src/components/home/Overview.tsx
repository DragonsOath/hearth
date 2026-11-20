import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CalendarTrouble, MiniMonth } from "./Calendar";
import { ScenesPanel } from "./Scenes";
import {
  CalendarDays,
  Camera,
  Check,
  DoorClosed,
  Droplets,
  EyeOff,
  Headphones,
  House,
  Lightbulb,
  Music,
  Pause,
  Play,
  Plus,
  Repeat,
  Settings2,
  Repeat1,
  ShieldAlert,
  ShieldCheck,
  ShoppingCart,
  Shuffle,
  SkipBack,
  SkipForward,
  Sunrise,
  Sunset,
  Thermometer,
  Umbrella,
  Tv,
  Video,
  Wind,
} from "lucide-react";
import { homePicture, useMusicVideo, useVideoOnTv, type HomeData } from "../../data/home";
import { clockParts, digitalTime, timeInWords } from "../../lib/timeWords";
import { isNight } from "../../lib/weatherScene";
import type { HomePrefs, Widget } from "./homePrefs";
import { HAS_OPTIONS, Slot } from "./Gallery";
import {
  CamerasWidget,
  ChoresWidget,
  ClimateWidget,
  CountdownWidget,
  DevicesWidget,
  DoorbellWidget,
  EnergyWidget,
  NewsWidget,
  NotesWidget,
  PeopleWidget,
  PhotosWidget,
  PlantsWidget,
  MovieNightWidget,
  RemindersWidget,
  SportsWidget,
  TravelWidget,
} from "./Widgets";
import {
  Panel,
  clockTime,
  compass,
  isSafe,
  mmss,
  songPosition,
  useNow,
  weatherOf,
  type Ctx,
} from "./parts";

/* ------------------------------------------------ time and weather ------------------------------------------------ */

export function Hero({ c, openWeather }: { c: Ctx; openWeather: () => void }) {
  const { d, prefs } = c;
  const now = useNow();
  const tz = d.place.timeZone;
  const { hour, minute } = clockParts(now, tz);
  const words = timeInWords(hour, minute);
  const cycle = prefs.clock === "24" ? "24" : "12";
  const date = now.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(tz ? { timeZone: tz } : {}),
  });
  const w = d.weather;
  const W = weatherOf(w?.condition, isNight(d.sun?.up, hour));
  const rain = w?.rainChance ?? w?.forecast[0]?.rain;
  return (
    <section className="hd-hero" aria-label="Time and weather">
      <div className="hd-time">
        <p className="hd-hello">{words.greeting}</p>
        {prefs.clock === "words" ? (
          <>
            <p
              className="hd-clock"
              data-testid="home-clock"
              aria-label={digitalTime(hour, minute, "12")}
            >
              {words.main}
            </p>
            {words.part && <p className="hd-part">{words.part}</p>}
          </>
        ) : (
          <p className="hd-clock hd-digits" data-testid="home-clock">
            {digitalTime(hour, minute, prefs.clock)}
          </p>
        )}
        <p className="hd-date">
          {date}
          {d.place.name && <span> · {d.place.name}</span>}
        </p>
      </div>
      {w ? (
        <>
          <button
            type="button"
            className="hd-now"
            onClick={openWeather}
            aria-label={`Weather: ${W.words}. Open the forecast`}
            data-testid="home-weather"
          >
            <W.icon aria-hidden />
            <span>
              <span className="hd-cond" style={{ display: "block" }}>
                {W.words}
              </span>
              <span className="hd-temp" style={{ display: "block" }}>
                {w.temperature !== undefined ? `${Math.round(w.temperature)}${w.unit}` : "–"}
              </span>
              {w.feelsLike !== undefined && (
                <span className="hd-feels" style={{ display: "block" }}>
                  Feels like {Math.round(w.feelsLike)}
                  {w.unit}
                </span>
              )}
              {(w.placeName || w.sourceName) && (
                <span className="hd-wsrc" data-testid="home-weather-source">
                  {[w.placeName, w.sourceName].filter(Boolean).join(" · ")}
                </span>
              )}
            </span>
            <span className="hd-facts">
              {w.humidity !== undefined && (
                <div>
                  <Droplets aria-hidden /> {Math.round(w.humidity)}% Humidity
                </div>
              )}
              {w.wind !== undefined && (
                <div>
                  <Wind aria-hidden /> {compass(w.windBearing)} {Math.round(w.wind)}{" "}
                  {w.windUnit ?? ""}
                </div>
              )}
              {rain !== undefined && (
                <div>
                  <Umbrella aria-hidden /> {Math.round(rain)}% Chance
                </div>
              )}
              {d.sun?.rising && (
                <div>
                  <Sunrise className="hd-sunicon" aria-hidden />
                  <span className="sr-only">Sunrise</span> {clockTime(d.sun.rising, tz, cycle)}
                </div>
              )}
              {d.sun?.setting && (
                <div>
                  <Sunset className="hd-sunicon" aria-hidden />
                  <span className="sr-only">Sunset</span> {clockTime(d.sun.setting, tz, cycle)}
                </div>
              )}
            </span>
          </button>
          <div className="hd-strips">
            {w.hourly.length > 0 && (
              <ol className="hd-strip" aria-label="The next hours" data-testid="home-hourly">
                {w.hourly.slice(0, 6).map((h, i) => {
                  const H = weatherOf(
                    h.condition,
                    i === 0
                      ? isNight(d.sun?.up, hour)
                      : isNight(undefined, clockParts(new Date(h.time), tz).hour),
                  );
                  return (
                    <li key={h.time}>
                      {i === 0
                        ? "Now"
                        : new Date(h.time).toLocaleTimeString([], {
                            hour: "numeric",
                            hourCycle: cycle === "24" ? "h23" : "h12",
                            ...(tz ? { timeZone: tz } : {}),
                          })}
                      <H.icon className={H.tone} aria-label={H.words} />
                      <b>{h.temperature !== undefined ? `${Math.round(h.temperature)}°` : "–"}</b>
                    </li>
                  );
                })}
              </ol>
            )}
            {w.forecast.length > 0 && (
              <ol className="hd-strip" aria-label="Forecast" data-testid="home-forecast">
                {w.forecast.slice(0, 5).map((f) => {
                  const F = weatherOf(f.condition);
                  return (
                    <li key={f.date}>
                      {new Date(f.date).toLocaleDateString([], {
                        weekday: "short",
                        ...(tz ? { timeZone: tz } : {}),
                      })}
                      <F.icon className={F.tone} aria-label={F.words} />
                      <b>{f.high !== undefined ? `${Math.round(f.high)}°` : "–"}</b>
                      <small>{f.low !== undefined ? `/${Math.round(f.low)}°` : ""}</small>
                    </li>
                  );
                })}
              </ol>
            )}
            {d.cities && d.cities.length > 0 && (
              <ol className="hd-cities" aria-label="Other places" data-testid="home-cities">
                {d.cities.map((x) => {
                  const X = weatherOf(x.condition);
                  return (
                    <li key={x.label}>
                      <X.icon className={X.tone} aria-label={X.words} />
                      <span className="hd-city-name">{x.label.split(",")[0]}</span>
                      <b>{x.temperature !== undefined ? `${Math.round(x.temperature)}°` : "–"}</b>
                      {x.high !== undefined && x.low !== undefined && (
                        <small>
                          {Math.round(x.high)}°/{Math.round(x.low)}°
                        </small>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </>
      ) : (
        <div className="hd-now" style={{ gridTemplateColumns: "1fr" }}>
          <p className="hd-empty">
            No weather in {d.serviceName} yet.
            {!d.tablet && (
              <>
                {" "}
                <button
                  type="button"
                  className="hd-chip"
                  onClick={() => c.connect("weather")}
                  data-testid="home-connect-weather"
                >
                  Add the weather
                </button>
              </>
            )}
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------ music ------------------------------------------------ */

export function speakerOf(c: Ctx) {
  return c.d.music.find((x) => x.entity === c.keep.speaker) ?? c.d.music[0];
}

export function Transport({ c, p }: { c: Ctx; p: HomeData["music"][number] }) {
  const { tap, busy } = c;
  const repeatNext = p.repeat === "off" ? "all" : p.repeat === "all" ? "one" : "off";
  return (
    <div className="hd-tx">
      {p.can.shuffle ? (
        <button
          type="button"
          className="hd-icon"
          aria-label="Shuffle"
          aria-pressed={Boolean(p.shuffle)}
          disabled={busy}
          onClick={() => tap({ entity: p.entity, action: "shuffle", value: !p.shuffle })}
        >
          <Shuffle />
        </button>
      ) : (
        <span className="hd-icon" />
      )}
      <button
        type="button"
        className="hd-icon"
        aria-label="Previous"
        disabled={busy || !p.can.previous}
        onClick={() => tap({ entity: p.entity, action: "previous" })}
      >
        <SkipBack fill="currentColor" />
      </button>
      <button
        type="button"
        className="hd-play"
        aria-label={p.state === "playing" ? "Pause" : "Play"}
        disabled={busy || !p.can.pause}
        onClick={() => tap({ entity: p.entity, action: p.state === "playing" ? "pause" : "play" })}
        data-testid="home-play"
      >
        {p.state === "playing" ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
      </button>
      <button
        type="button"
        className="hd-icon"
        aria-label="Next"
        disabled={busy || !p.can.next}
        onClick={() => tap({ entity: p.entity, action: "next" })}
      >
        <SkipForward fill="currentColor" />
      </button>
      {p.can.repeat ? (
        <button
          type="button"
          className="hd-icon"
          aria-label={`Repeat: ${p.repeat ?? "off"}`}
          aria-pressed={p.repeat !== undefined && p.repeat !== "off"}
          disabled={busy}
          onClick={() => tap({ entity: p.entity, action: "repeat", value: repeatNext })}
        >
          {p.repeat === "one" ? <Repeat1 /> : <Repeat />}
        </button>
      ) : (
        <span className="hd-icon" />
      )}
    </div>
  );
}

export function Progress({ p }: { p: HomeData["music"][number] }) {
  const now = useNow(p.state === "playing");
  const pos = songPosition(p, now);
  if (pos === undefined || !p.duration) return <div className="hd-prog" />;
  const pct = `${(pos / p.duration) * 100}%`;
  return (
    <div
      className="hd-prog"
      role="progressbar"
      aria-label="Song progress"
      aria-valuemin={0}
      aria-valuemax={Math.round(p.duration)}
      aria-valuenow={Math.round(pos)}
    >
      <div className="hd-bar">
        <i style={{ width: pct }} />
        <b style={{ left: pct }} />
      </div>
      {mmss(pos)} / {mmss(p.duration)}
    </div>
  );
}

/** Audio or video: only what is really playing. Hearth cannot turn a song into its video. */
export function AvSwitch({
  p,
  mode,
  setMode,
  video,
}: {
  p: HomeData["music"][number];
  /** On the now-playing card: show the poster or the song's music video in the card. */
  mode?: "audio" | "video";
  setMode?: (m: "audio" | "video") => void;
  video?: boolean;
}) {
  if (setMode) {
    const can = Boolean(video || p.video);
    return (
      <span className="hd-row" style={{ gap: 6 }} data-testid="home-av">
        <button
          type="button"
          className={`hd-pill${mode === "audio" ? " hd-on" : ""}`}
          aria-pressed={mode === "audio"}
          onClick={() => setMode("audio")}
        >
          <Headphones size={18} /> Audio
        </button>
        <button
          type="button"
          className={`hd-pill${mode === "video" ? " hd-on" : ""}`}
          style={can ? undefined : { opacity: 0.5 }}
          aria-pressed={mode === "video"}
          disabled={!can}
          title={can ? "Play the music video here" : "This song has no official music video."}
          onClick={() => setMode("video")}
          data-testid="home-av-video"
        >
          <Video size={18} /> Video
        </button>
      </span>
    );
  }
  return (
    <span className="hd-row" style={{ gap: 6 }} data-testid="home-av">
      <span className={`hd-pill${p.video ? "" : " hd-on"}`} aria-label="Audio">
        <Headphones size={18} /> Audio
      </span>
      <span
        className={`hd-pill${p.video ? " hd-on" : ""}`}
        style={p.video ? undefined : { opacity: 0.5 }}
        title={
          p.video
            ? "This is a video."
            : "No video for this: Home Assistant can't switch a song to its music video."
        }
        aria-disabled={!p.video}
      >
        <Video size={18} /> Video
      </span>
    </span>
  );
}

/**
 * The song's music video, muted (the sound comes from the speaker), started where the song is
 * and paused with it. It fits inside the card at any size.
 */
function CardVideo({
  id,
  p,
  onFail,
}: {
  id: string;
  p: HomeData["music"][number];
  onFail: () => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // YouTube refuses some videos in some players (11-06: "This video is unavailable"):
  // first the privacy-enhanced player, then YouTube's own, then the poster again.
  const [host, setHost] = useState<"www.youtube-nocookie.com" | "www.youtube.com">(
    "www.youtube-nocookie.com",
  );
  useEffect(() => {
    const heard = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      let m: { event?: string; info?: unknown } | undefined;
      try {
        m = (typeof e.data === "string" ? JSON.parse(e.data) : e.data) as typeof m;
      } catch {
        return;
      }
      if (m?.event !== "onError") return;
      if (host === "www.youtube-nocookie.com") setHost("www.youtube.com");
      else onFail();
    };
    window.addEventListener("message", heard);
    return () => window.removeEventListener("message", heard);
  }, [host, onFail]);
  // Asks the player to report its errors (YouTube's iframe API).
  const listen = () =>
    ref.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "listening", id: 1, channel: "widget" }),
      "*",
    );
  // Where the song was when the video opened (it is not restarted as the song moves on).
  const [start] = useState(() => Math.max(0, Math.floor(songPosition(p, new Date()) ?? 0)));
  const playing = p.state === "playing";
  useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "command", func: playing ? "playVideo" : "pauseVideo", args: [] }),
      "*",
    );
  }, [playing]);
  return (
    <iframe
      key={host}
      ref={ref}
      onLoad={listen}
      className="hd-media-video"
      title="Music video"
      src={`https://${host}/embed/${id}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3&disablekb=1&enablejsapi=1&start=${start}`}
      allow="autoplay; encrypted-media; picture-in-picture"
      referrerPolicy="strict-origin-when-cross-origin"
      data-testid="home-music-video"
    />
  );
}

/**
 * Now playing (11-05): the whole card is the poster, every control over it; Video plays the
 * song's music video in the card; the eye hides the controls (a tap brings them back). With no
 * video the whole poster shows, never cropped.
 */
function MusicWidget({ c }: { c: Ctx }) {
  const { d } = c;
  const p = speakerOf(c);
  const [mode, setMode] = useState<"audio" | "video">("audio");
  const [bare, setBare] = useState(false);
  const vid = useMusicVideo(p?.title, p?.artist);
  // Watch on TV: a Google Cast TV (the one playing first).
  const onTv = useVideoOnTv(d.serviceId);
  const tvs = d.music
    .filter((x) => x.cast)
    .sort((a, b) => Number(b.entity === p?.entity) - Number(a.entity === p?.entity));
  // Videos YouTube wouldn't play here: the card shows the poster for them instead.
  const [refused, setRefused] = useState<string[]>([]);
  const found = vid.data?.video ?? undefined;
  const videoId = found && !refused.includes(found) ? found : undefined;
  const showVideo = mode === "video" && Boolean(videoId);
  const fresh = p?.picture ? homePicture(p.entity, d.serviceId, p.title ?? "") : undefined;
  // Paused, the TV often drops its picture (and the song's name): the last poster stays until
  // another song plays (11-05: "when I hit pause I have no image").
  const [kept, setKept] = useState<{ entity: string; title?: string; url: string }>();
  const [broken, setBroken] = useState<string>();
  const keep =
    kept && p && kept.entity === p.entity && (!p.title || p.title === kept.title)
      ? kept
      : undefined;
  const art = fresh && fresh !== broken ? fresh : keep?.url;
  return (
    <section
      className={`hd-glass hd-w-music hd-player${p ? " hd-player-full" : ""}${bare ? " hd-bare" : ""}`}
      aria-label="Now playing"
      data-testid="home-music"
      data-mode={showVideo ? "video" : "poster"}
    >
      {!p ? (
        <div style={{ gridColumn: "1 / -1" }}>
          <div className="hd-h">
            <Music />
            Music
          </div>
          <p className="hd-empty">
            No speakers yet.{" "}
            {d.tablet
              ? "The owner connects Spotify, YouTube Music or Amazon Music in Hearth."
              : "Connect Spotify, or Music Assistant for YouTube Music, Amazon Music and more."}
          </p>
          {!d.tablet && (
            <button
              type="button"
              className="hd-chip"
              style={{ marginTop: 10 }}
              onClick={() => c.connect("music")}
              data-testid="home-connect-music"
              data-hearth-target="home:music-setup"
            >
              Connect music
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="hd-media" data-testid="home-music-media">
            {showVideo && videoId ? (
              <CardVideo
                key={`${videoId}-${p.entity}`}
                id={videoId}
                p={p}
                onFail={() => {
                  setRefused((r) => [...r, videoId]);
                  setMode("audio");
                }}
              />
            ) : art ? (
              <>
                <img className="hd-media-fill" src={art} alt="" aria-hidden="true" />
                <img
                  className="hd-media-poster"
                  src={art}
                  onLoad={() => {
                    if (art === fresh && p.picture)
                      setKept({
                        entity: p.entity,
                        ...(p.title ? { title: p.title } : {}),
                        url: art,
                      });
                  }}
                  onError={() => {
                    if (art === fresh) setBroken(fresh);
                  }}
                  alt={p.title ? `${p.title} cover` : ""}
                  data-testid="home-music-poster"
                />
              </>
            ) : (
              <div className="hd-media-none">
                <Music />
              </div>
            )}
          </div>
          {bare ? (
            <button
              type="button"
              className="hd-bare-tap"
              aria-label="Show the controls"
              onClick={() => setBare(false)}
              data-testid="home-music-show"
            />
          ) : (
            <div className="hd-over">
              <div className="hd-over-top">
                <div className="hd-np">
                  <span className="hd-lbl">
                    {p.state === "playing"
                      ? "Now Playing"
                      : p.state === "paused"
                        ? "Paused"
                        : "Speaker"}
                    {p.app ? ` · ${p.app}` : ""}
                  </span>
                  <h3 data-testid="home-now-playing">
                    {p.title ??
                      (p.state === "off"
                        ? "Off"
                        : p.state === "idle"
                          ? "Nothing playing"
                          : p.state)}
                  </h3>
                  <span className="hd-by">
                    {[p.artist, p.album].filter(Boolean).join(" · ") || p.name}
                  </span>
                </div>
                <button
                  type="button"
                  className="hd-icon hd-over-hide"
                  aria-label="Hide the controls"
                  title="Hide the controls"
                  onClick={() => setBare(true)}
                  data-testid="home-music-hide"
                >
                  <EyeOff />
                </button>
              </div>
              <div className="hd-over-bottom">
                {onTv.error && (
                  <p className="hd-empty" role="alert" style={{ color: "var(--hd-ink)" }}>
                    {onTv.error.message}
                  </p>
                )}
                <Progress p={p} />
                <Transport c={c} p={p} />
                <div className="hd-pfoot">
                  <AvSwitch p={p} mode={mode} setMode={setMode} video={Boolean(videoId)} />
                  {videoId && tvs.length > 0 && (
                    <button
                      type="button"
                      className="hd-pill"
                      disabled={onTv.isPending}
                      title={`Play the music video on ${tvs[0]!.name}, with its sound`}
                      onClick={() =>
                        onTv.mutate(
                          {
                            tv: tvs[0]!.entity,
                            videoId,
                            ...(p.state === "playing" ? { pause: p.entity } : {}),
                          },
                          { onSuccess: () => c.keep.setSpeaker(tvs[0]!.entity) },
                        )
                      }
                      data-testid="home-video-tv"
                    >
                      <Tv size={18} /> {onTv.isPending ? "Starting…" : "Watch on TV"}
                    </button>
                  )}
                  <span className="hd-r">
                    <button type="button" className="hd-chip" onClick={() => c.go("media")}>
                      {p.name}
                    </button>
                    {c.addSpeaker && (
                      <button
                        type="button"
                        className="hd-chip"
                        aria-label="Add a speaker"
                        title="Add a speaker"
                        onClick={c.addSpeaker}
                        data-testid="home-add-speaker-btn"
                      >
                        <Plus size={16} />
                      </button>
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------ today ------------------------------------------------ */

const dayKey = (iso: string, allDay: boolean, tz?: string) =>
  new Date(allDay ? `${iso}T12:00:00` : iso).toLocaleDateString(
    "en-CA",
    tz ? { timeZone: tz } : {},
  );

export function eventTime(
  e: HomeData["events"][number],
  tz: string | undefined,
  cycle: "12" | "24",
) {
  return e.allDay ? "All Day" : clockTime(e.start, tz, cycle);
}

function TodayWidget({ c }: { c: Ctx }) {
  const { d, prefs } = c;
  const tz = d.place.timeZone;
  const cycle = prefs.clock === "24" ? "24" : "12";
  const today = new Date().toLocaleDateString("en-CA", tz ? { timeZone: tz } : {});
  const list = useMemo(() => {
    const todays = d.events.filter((e) => dayKey(e.start, e.allDay, tz) === today);
    return (todays.length ? todays : d.events).slice(0, 3);
  }, [d.events, tz, today]);
  const anyToday = list.some((e) => dayKey(e.start, e.allDay, tz) === today);
  return (
    <Panel
      title="Today"
      icon={<CalendarDays />}
      testId="home-calendar"
      className="hd-w-today"
      action={
        <button type="button" className="hd-chip" onClick={() => c.go("household")}>
          View Calendar
        </button>
      }
    >
      {!d.calendars.length &&
      (d.calendarsDown || d.signInAgain?.some((s) => s.for === "calendar")) ? (
        <CalendarTrouble c={c} />
      ) : !d.calendars.length ? (
        <>
          <p className="hd-empty">
            No calendars yet.{" "}
            {d.tablet
              ? "The owner connects Google, Apple or Proton calendars in Hearth."
              : "Connect Google, Apple (iCloud) or Proton."}
          </p>
          {!d.tablet && (
            <button
              type="button"
              className="hd-chip"
              style={{ alignSelf: "flex-start" }}
              onClick={() => c.connect("calendar")}
              data-testid="home-connect-calendar"
            >
              Connect a calendar
            </button>
          )}
        </>
      ) : !list.length ? (
        <>
          <MiniMonth c={c} />
          <p className="hd-empty">Nothing on the calendar this week.</p>
        </>
      ) : (
        <div style={{ overflow: "hidden" }}>
          <MiniMonth c={c} />
          {!anyToday && <p className="hd-empty">Nothing today. Coming up:</p>}
          {list.map((e, i) => (
            <div className="hd-ev" key={`${e.title}-${i}`} data-testid="home-event">
              <span className="hd-dot" />
              <span className="hd-t">
                {anyToday
                  ? eventTime(e, tz, cycle)
                  : new Date(e.allDay ? `${e.start}T12:00:00` : e.start).toLocaleDateString([], {
                      weekday: "short",
                      ...(tz ? { timeZone: tz } : {}),
                    })}
              </span>
              <div>
                <b>{e.title}</b>
                {e.location && <span>{e.location}</span>}
                {d.calendars.length > 1 && <small>{e.calendar}</small>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------ lists ------------------------------------------------ */

export function ListsPanel({ c, full }: { c: Ctx; full?: boolean }) {
  const { d, tap, busy } = c;
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const list = d.lists.find((l) => l.entity === c.keep.list) ?? d.lists[0];
  const open = list?.items.filter((i) => !i.done) ?? [];
  const done = list?.items.filter((i) => i.done) ?? [];
  return (
    <Panel
      title="Lists"
      icon={<ShoppingCart />}
      testId={full ? "home-lists-full" : "home-lists"}
      className={full ? "" : "hd-w-lists"}
      action={
        full
          ? !d.tablet && (
              <button
                type="button"
                className="hd-chip"
                onClick={() => c.connect("lists")}
                data-testid="home-connect-lists"
              >
                <Plus size={16} /> Add a list
              </button>
            )
          : list && (
              <button
                type="button"
                className="hd-chip"
                aria-expanded={adding}
                onClick={() => setAdding(!adding)}
                data-testid="home-list-adding"
              >
                <Plus size={16} /> Add Item
              </button>
            )
      }
    >
      {!list ? (
        <>
          <p className="hd-empty">
            No lists yet.{" "}
            {d.tablet
              ? "The owner adds a grocery list or chores in Hearth."
              : "Add a grocery list and a chore list."}
          </p>
          {!d.tablet && !full && (
            <button
              type="button"
              className="hd-chip"
              style={{ alignSelf: "flex-start" }}
              onClick={() => c.connect("lists")}
              data-testid="home-connect-lists"
            >
              <Plus size={16} /> Add a list
            </button>
          )}
        </>
      ) : (
        <>
          {d.lists.length > 1 && (
            <div className="hd-ltabs" role="tablist" aria-label="Lists">
              {d.lists.map((l) => {
                const n = l.items.filter((i) => !i.done).length;
                return (
                  <button
                    key={l.entity}
                    type="button"
                    role="tab"
                    className="hd-pill"
                    aria-selected={l.entity === list.entity}
                    onClick={() => c.keep.setList(l.entity)}
                  >
                    {l.name}
                    {n ? ` (${n})` : ""}
                  </button>
                );
              })}
            </div>
          )}
          <ul className="hd-items" data-testid="home-list-items">
            {open.map((i) => (
              <li key={i.uid} data-testid="home-list-item">
                <button
                  type="button"
                  className="hd-item"
                  onClick={() => tap({ entity: list.entity, action: "complete", item: i.uid })}
                  aria-label={`Done: ${i.summary}`}
                >
                  <span className="hd-box" />
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{i.summary}</span>
                </button>
              </li>
            ))}
            {!open.length && <li className="hd-empty">All done.</li>}
            {full &&
              done.map((i) => (
                <li key={i.uid}>
                  <button
                    type="button"
                    className="hd-item hd-done"
                    onClick={() => tap({ entity: list.entity, action: "reopen", item: i.uid })}
                    aria-label={`Not done: ${i.summary}`}
                  >
                    <span className="hd-box hd-y">
                      <Check strokeWidth={3.5} />
                    </span>
                    {i.summary}
                  </button>
                </li>
              ))}
          </ul>
          {full && done.length > 0 && (
            <button
              type="button"
              className="hd-chip"
              style={{ alignSelf: "flex-start" }}
              disabled={busy}
              onClick={() =>
                done.forEach((i) => tap({ entity: list.entity, action: "remove", item: i.uid }))
              }
            >
              Clear {done.length} done
            </button>
          )}
          {(full || adding) && (
            <form
              className="hd-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim()) return;
                tap({ entity: list.entity, action: "add", value: text.trim() });
                setText("");
              }}
            >
              <input
                placeholder={`Add to ${list.name}`}
                autoFocus={!full}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-label={`Add to ${list.name}`}
                data-testid={full ? "home-list-add-full" : "home-list-add"}
              />
              <button
                type="submit"
                className="hd-pill hd-on"
                disabled={busy || !text.trim()}
                aria-label="Add"
              >
                <Plus size={18} />
              </button>
            </form>
          )}
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------ home status and scenes ------------------------------------------------ */

export function securitySummary(d: HomeData) {
  const open = d.security.filter((s) => s.kind !== "alarm" && !isSafe(s));
  const alarm = d.security.find((s) => s.kind === "alarm");
  const going = d.security.some((s) => s.state === "triggered" || s.state === "jammed");
  return { open, alarm, going };
}

function StatusWidget({ c }: { c: Ctx }) {
  const { d } = c;
  const { open, alarm, going } = securitySummary(d);
  const lights = d.rooms.flatMap((r) => r.controls).filter((x) => x.kind === "light");
  const lightsOn = lights.filter((x) => x.on);
  const heat = d.climate[0];
  const doors = d.security.filter((s) => s.kind !== "alarm");
  // An alarm that is off is normal in the daytime: only open doors or trouble are a warning.
  const secure = !open.length && !going;
  const armed = !alarm || isSafe(alarm);
  return (
    <Panel title="Home Status" icon={<House />} testId="home-status" className="hd-w-status">
      <div className="hd-statusgrid">
        <button
          type="button"
          className={`hd-secure${secure ? "" : " hd-warn"}`}
          onClick={() => c.go("security")}
          data-testid="home-secure-summary"
        >
          {secure ? <ShieldCheck strokeWidth={1.5} /> : <ShieldAlert strokeWidth={1.5} />}
          <span style={{ minWidth: 0 }}>
            <b>
              {!d.security.length
                ? "No doors or alarm"
                : going
                  ? "Check the home"
                  : !secure
                    ? `${open.length} open`
                    : armed
                      ? "Home Secure"
                      : "Doors Locked"}
            </b>
            <span>
              {!d.security.length
                ? "None in Home Assistant"
                : [
                    open.length
                      ? open.map((s) => s.name).join(", ")
                      : doors.length && armed
                        ? "Doors locked"
                        : "",
                    alarm ? `Alarm ${isSafe(alarm) ? "armed" : "off"}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
          </span>
        </button>
        <button type="button" className="hd-tile" onClick={() => c.go("rooms")}>
          <Lightbulb style={{ color: "#ffd36a" }} />
          <b>Lights</b>
          <span>{lights.length ? `${lightsOn.length} on` : "None"}</span>
        </button>
        <button type="button" className="hd-tile" onClick={() => c.go("rooms")}>
          <Thermometer style={{ color: "#ff7a5c" }} />
          <b>Climate</b>
          <span>
            {heat
              ? `${heat.current !== undefined ? `${heat.current}°` : ""} ${heat.action ?? heat.mode}`.trim()
              : "None"}
          </span>
        </button>
        <button type="button" className="hd-tile" onClick={() => c.go("security")}>
          <DoorClosed style={{ color: open.length ? "var(--hd-warn)" : "var(--hd-ok)" }} />
          <b>Doors</b>
          <span>{!doors.length ? "None" : open.length ? `${open.length} open` : "Locked"}</span>
        </button>
        <button type="button" className="hd-tile" onClick={() => c.go("security")}>
          <Camera style={{ color: "var(--hd-ok)" }} />
          <b>Cameras</b>
          <span>
            {d.cameras.length
              ? `${d.cameras.filter((x) => x.state !== "unavailable").length} online`
              : "None"}
          </span>
        </button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------ the overview ------------------------------------------------ */

export function Overview({
  c,
  openWeather,
  update,
  editing,
  setEditing,
  openGallery,
  configure,
}: {
  c: Ctx;
  openWeather: () => void;
  update: (p: Partial<HomePrefs>) => void;
  editing: boolean;
  setEditing: (on: boolean) => void;
  openGallery: () => void;
  configure: (w: Widget) => void;
}) {
  const parts: Record<Widget, (x: Ctx) => ReactNode> = {
    music: (x) => <MusicWidget c={x} />,
    today: (x) => <TodayWidget c={x} />,
    lists: (x) => <ListsPanel c={x} />,
    status: (x) => <StatusWidget c={x} />,
    scenes: (x) => <ScenesPanel c={x} />,
    devices: (x) => <DevicesWidget c={x} />,
    climate: (x) => <ClimateWidget c={x} />,
    cameras: (x) => <CamerasWidget c={x} />,
    people: (x) => <PeopleWidget c={x} />,
    doorbell: (x) => <DoorbellWidget c={x} />,
    energy: (x) => <EnergyWidget c={x} />,
    travel: (x) => <TravelWidget c={x} />,
    photos: (x) => <PhotosWidget c={x} />,
    chores: (x) => <ChoresWidget c={x} />,
    reminders: (x) => <RemindersWidget c={x} />,
    countdown: (x) => <CountdownWidget c={x} />,
    notes: (x) => <NotesWidget c={x} />,
    news: (x) => <NewsWidget c={x} />,
    sports: (x) => <SportsWidget c={x} />,
    plants: (x) => <PlantsWidget c={x} />,
    movienight: () => <MovieNightWidget />,
  };
  return (
    <>
      <Hero c={c} openWeather={openWeather} />
      {editing && (
        <div className="hd-editbar" role="status" data-testid="home-customizing">
          <span>Customizing this screen: move, resize or remove widgets, or add more.</span>
          <button type="button" className="hd-chip" onClick={openGallery}>
            <Plus aria-hidden style={{ width: 16, height: 16 }} /> Add widgets
          </button>
          <button type="button" className="hd-pill hd-on" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}
      <div className="hd-grid">
        {c.prefs.shown.map((w) => (
          <Slot
            key={w}
            w={w}
            prefs={c.prefs}
            update={update}
            editing={editing}
            configure={() => configure(w)}
          >
            {parts[w]({
              ...c,
              editing,
              ...(HAS_OPTIONS.has(w) ? { configure: () => configure(w) } : {}),
            })}
          </Slot>
        ))}
        {(editing || !c.prefs.shown.length) && (
          <button
            type="button"
            className="hd-glass hd-addtile"
            onClick={openGallery}
            data-testid="home-add-widget"
          >
            <Plus aria-hidden />
            Add widgets
          </button>
        )}
      </div>
      {!editing && (
        <div className="hd-customize">
          <button
            type="button"
            className="hd-chip"
            onClick={() => setEditing(true)}
            data-testid="home-customize"
          >
            <Settings2 aria-hidden style={{ width: 16, height: 16 }} /> Customize
          </button>
        </div>
      )}
    </>
  );
}

export { ScenesPanel };
