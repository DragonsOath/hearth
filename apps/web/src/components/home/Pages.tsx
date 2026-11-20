import { useEffect, useRef, useState } from "react";
import {
  Camera,
  DoorClosed,
  DoorOpen,
  Fan,
  Lightbulb,
  Lock,
  LockOpen,
  Minus,
  Music,
  Plus,
  ShieldCheck,
  ShieldOff,
  Thermometer,
  ToggleRight,
  X,
} from "lucide-react";
import {
  homePicture,
  useFindWeatherPlace,
  useSetWeatherPlaces,
  useWeatherPlaces,
  type HomeData,
  type WeatherPlace,
} from "../../data/home";
import { Modal } from "../workspace/dialogs";
import { MusicLibrary } from "./MusicLibrary";
import { NowPlaying } from "./NowPlaying";
import { CalendarPage } from "./Calendar";
import { ListsPanel, ScenesPanel, speakerOf } from "./Overview";
import { Panel, SECURE_WORDS, clockTime, isSafe, weatherOf, type Ctx } from "./parts";

/* ------------------------------------------------ rooms ------------------------------------------------ */

const CONTROL_ICON: Record<string, typeof Lightbulb> = {
  light: Lightbulb,
  fan: Fan,
  switch: ToggleRight,
};

function Dimmer({ c, ctl }: { c: Ctx; ctl: HomeData["rooms"][number]["controls"][number] }) {
  const send = (v: number) => c.tap({ entity: ctl.entity, action: "brightness", value: v });
  return (
    <input
      type="range"
      min={1}
      max={100}
      defaultValue={ctl.brightness}
      key={`${ctl.entity}-${ctl.brightness}`}
      aria-label={`${ctl.name} brightness`}
      className="hd-range"
      data-swipe-ignore
      onPointerUp={(e) => send(Number(e.currentTarget.value))}
      onKeyUp={(e) => send(Number(e.currentTarget.value))}
    />
  );
}

export function Thermostat({ c, t }: { c: Ctx; t: HomeData["climate"][number] }) {
  const step = t.step ?? 0.5;
  // Keyed by Home Assistant's target, so a change from elsewhere starts it afresh.
  const [target, setTarget] = useState(t.target);
  const timer = useRef<number>(undefined);
  const nudge = (dir: 1 | -1) => {
    if (target === undefined) return;
    const next = Math.min(
      t.max ?? 100,
      Math.max(t.min ?? -50, Math.round((target + dir * step) / step) * step),
    );
    setTarget(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => c.tap({ entity: t.entity, action: "temperature", value: next }),
      600,
    );
  };
  const unit = c.d.place.tempUnit;
  return (
    <Panel
      title={t.room ? `${t.name} · ${t.room}` : t.name}
      icon={<Thermometer />}
      testId="home-climate"
    >
      <p className="hd-empty">
        {t.current !== undefined ? `It's ${t.current}${unit} inside` : "No reading"}
        {t.action ? `, ${t.action}` : ""}
      </p>
      {target !== undefined && t.mode !== "off" && (
        <div className="hd-thermo">
          <button type="button" className="hd-round" aria-label="Cooler" onClick={() => nudge(-1)}>
            <Minus />
          </button>
          <span className="hd-big" data-testid="home-climate-target">
            {target}°
          </span>
          <button type="button" className="hd-round" aria-label="Warmer" onClick={() => nudge(1)}>
            <Plus />
          </button>
        </div>
      )}
      {t.modes.length > 0 && (
        <div className="hd-row" role="group" aria-label="Mode">
          {t.modes.map((m) => (
            <button
              key={m}
              type="button"
              className="hd-pill"
              aria-pressed={t.mode === m}
              disabled={c.busy}
              onClick={() => c.tap({ entity: t.entity, action: "mode", value: m })}
            >
              {m === "heat_cool"
                ? "Heat and cool"
                : m[0]!.toUpperCase() + m.slice(1).replace(/_/g, " ")}
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function RoomsPage({ c }: { c: Ctx }) {
  const { d, tap, busy } = c;
  const current = d.rooms.find((r) => r.name === c.keep.room) ?? d.rooms[0];
  return (
    <div className="hd-cols" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <Panel title="Lights and switches" icon={<Lightbulb />} testId="home-rooms">
        {!current ? (
          <p className="hd-empty">No lights or switches in Home Assistant yet.</p>
        ) : (
          <>
            {d.rooms.length > 1 && (
              <div className="hd-ltabs" role="tablist" aria-label="Rooms">
                {d.rooms.map((r) => {
                  const on = r.controls.filter((x) => x.on).length;
                  return (
                    <button
                      key={r.name}
                      type="button"
                      role="tab"
                      className="hd-pill"
                      style={{ flex: "0 0 auto" }}
                      aria-selected={r.name === current.name}
                      onClick={() => c.keep.setRoom(r.name)}
                    >
                      {r.name}
                      {on ? ` · ${on} on` : ""}
                    </button>
                  );
                })}
              </div>
            )}
            <ul className="hd-tiles" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {current.controls.map((ctl) => {
                const Icon = CONTROL_ICON[ctl.kind] ?? ToggleRight;
                return (
                  <li key={ctl.entity} style={{ display: "grid", gap: 4 }}>
                    <button
                      type="button"
                      className="hd-tile"
                      aria-pressed={ctl.on}
                      disabled={busy}
                      onClick={() => tap({ entity: ctl.entity, action: "toggle" })}
                      data-testid="home-control"
                      data-entity={ctl.entity}
                    >
                      <Icon style={{ color: ctl.on ? "var(--hd-ember-hi)" : "var(--hd-faint)" }} />
                      <b
                        style={{
                          maxWidth: "100%",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {ctl.name}
                      </b>
                      <span>
                        {ctl.on
                          ? ctl.brightness !== undefined
                            ? `${ctl.brightness}%`
                            : "On"
                          : "Off"}
                      </span>
                    </button>
                    {ctl.kind === "light" && ctl.on && ctl.brightness !== undefined && (
                      <Dimmer c={c} ctl={ctl} />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Panel>
      <div className="hd-cols">
        {d.climate.map((t) => (
          <Thermostat key={`${t.entity}-${t.target}`} c={c} t={t} />
        ))}
        <ScenesPanel c={c} />
      </div>
    </div>
  );
}

/* ------------------------------------------------ media ------------------------------------------------ */

export function MediaPage({ c }: { c: Ctx }) {
  const { d } = c;
  const p = speakerOf(c);
  if (!p)
    return (
      <Panel title="Music" icon={<Music />} testId="home-media">
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
            style={{ alignSelf: "flex-start" }}
            onClick={() => c.connect("music")}
            data-testid="home-connect-music"
          >
            Connect music
          </button>
        )}
      </Panel>
    );
  return (
    <div className="hd-cols" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <NowPlaying c={c} p={p} />
      <MusicLibrary c={c} />
    </div>
  );
}

/* ------------------------------------------------ security ------------------------------------------------ */

export function CameraTile({
  c,
  entity,
  name,
  live,
}: {
  c: Ctx;
  entity: string;
  name: string;
  live?: boolean;
}) {
  const [bust, setBust] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setBust(Date.now()), live ? 2000 : 10_000);
    return () => window.clearInterval(t);
  }, [live]);
  return (
    <span className="hd-cam">
      {failed ? (
        <span className="hd-nopic">No picture right now</span>
      ) : (
        <img
          src={homePicture(entity, c.d.serviceId, bust)}
          alt={name}
          onError={() => setFailed(true)}
          onLoad={() => setFailed(false)}
        />
      )}
      <span>{name}</span>
    </span>
  );
}

export function SecurityPage({ c }: { c: Ctx }) {
  const { d, tap, busy, askPin } = c;
  const [open, setOpen] = useState<string>();
  const big = d.cameras.find((x) => x.entity === open);
  return (
    <div className="hd-cols">
      <Panel title="Doors and alarm" icon={<ShieldCheck />} testId="home-security">
        {!d.security.length && (
          <p className="hd-empty">No locks, garage doors or alarm in Home Assistant.</p>
        )}
        {d.security.map((s) => {
          const safe = isSafe(s);
          const Icon =
            s.kind === "lock"
              ? safe
                ? Lock
                : LockOpen
              : s.kind === "garage"
                ? safe
                  ? DoorClosed
                  : DoorOpen
                : safe
                  ? ShieldCheck
                  : ShieldOff;
          return (
            <div className="hd-sec" key={s.entity} data-testid="home-secure" data-entity={s.entity}>
              <span className={`hd-badge${safe ? "" : " hd-warn"}`}>
                <Icon />
              </span>
              <span className="hd-name">
                {s.name}
                <span data-testid="home-secure-state">{SECURE_WORDS[s.state] ?? s.state}</span>
              </span>
              {s.kind === "lock" &&
                (s.state === "locked" ? (
                  <button
                    type="button"
                    className="hd-pill"
                    disabled={busy}
                    onClick={() =>
                      askPin({ entity: s.entity, action: "unlock" }, `Unlock ${s.name}`, false)
                    }
                  >
                    <LockOpen size={18} /> Unlock
                  </button>
                ) : (
                  <button
                    type="button"
                    className="hd-pill hd-on"
                    disabled={busy}
                    onClick={() => tap({ entity: s.entity, action: "lock" })}
                  >
                    <Lock size={18} /> Lock
                  </button>
                ))}
              {s.kind === "garage" &&
                (s.state === "closed" ? (
                  <button
                    type="button"
                    className="hd-pill"
                    disabled={busy}
                    onClick={() =>
                      askPin({ entity: s.entity, action: "open" }, `Open ${s.name}`, false)
                    }
                  >
                    <DoorOpen size={18} /> Open
                  </button>
                ) : (
                  <button
                    type="button"
                    className="hd-pill hd-on"
                    disabled={busy}
                    onClick={() => tap({ entity: s.entity, action: "close" })}
                  >
                    <DoorClosed size={18} /> Close
                  </button>
                ))}
              {s.kind === "alarm" &&
                (s.state === "disarmed" ? (
                  <span className="hd-row">
                    {(["arm_home", "arm_away"] as const).map((a) => (
                      <button
                        key={a}
                        type="button"
                        className="hd-pill hd-on"
                        disabled={busy}
                        onClick={() =>
                          s.needsCode
                            ? askPin(
                                { entity: s.entity, action: a },
                                `Turn on ${s.name} (${a === "arm_home" ? "home" : "away"})`,
                                true,
                              )
                            : tap({ entity: s.entity, action: a })
                        }
                      >
                        {a === "arm_home" ? "Home" : "Away"}
                      </button>
                    ))}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="hd-pill"
                    disabled={busy}
                    onClick={() =>
                      askPin(
                        { entity: s.entity, action: "disarm" },
                        `Turn off ${s.name}`,
                        Boolean(s.needsCode),
                      )
                    }
                  >
                    <ShieldOff size={18} /> Turn off
                  </button>
                ))}
            </div>
          );
        })}
        <p className="hd-note-box">
          Opening a door or the garage and turning the alarm off ask for the unlock PIN.
        </p>
      </Panel>
      <Panel
        title="Cameras"
        icon={<Camera />}
        testId="home-cameras"
        action={
          big && (
            <button type="button" className="hd-chip" onClick={() => setOpen(undefined)}>
              <X size={16} /> All cameras
            </button>
          )
        }
      >
        {!d.cameras.length ? (
          <p className="hd-empty">No cameras in Home Assistant.</p>
        ) : big ? (
          <CameraTile c={c} entity={big.entity} name={big.name} live />
        ) : (
          <div className="hd-cams">
            {d.cameras.map((x) => (
              <button
                key={x.entity}
                type="button"
                onClick={() => setOpen(x.entity)}
                aria-label={`Open ${x.name}`}
                data-testid="home-camera"
                style={{ display: "block" }}
              >
                <CameraTile c={c} entity={x.entity} name={x.name} />
              </button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------ household ------------------------------------------------ */

export function HouseholdPage({ c }: { c: Ctx }) {
  return (
    <div className="hd-cols">
      <CalendarPage c={c} />
      <ListsPanel c={c} full />
    </div>
  );
}

/* ------------------------------------------------ the forecast ------------------------------------------------ */

/**
 * Where the weather is for (11-05: "I should be able to set a location if I'm using a
 * VPN", "multiple locations"). The first place is the main one; the others show small under
 * the forecast. With none, it is the home's location from Home Assistant.
 */
function WeatherPlaces() {
  const q = useWeatherPlaces();
  const save = useSetWeatherPlaces();
  const [text, setText] = useState("");
  const [asked, setAsked] = useState("");
  const found = useFindWeatherPlace(asked);
  if (!q.data) return null;
  const v = q.data;
  const put = (places: WeatherPlace[], source = v.source) => save.mutate({ source, places });
  return (
    <div className="hd-wplaces" data-testid="home-weather-places">
      <p className="hd-day-h">Places</p>
      {v.places.length === 0 ? (
        <p className="hd-empty">The home's location, from Home Assistant.</p>
      ) : (
        <ul>
          {v.places.map((p, i) => (
            <li key={`${p.label}-${i}`} data-testid="home-weather-place">
              <span>
                {p.label}
                {i === 0 && <small> · main</small>}
              </span>
              {i > 0 && (
                <button
                  type="button"
                  className="hd-chip"
                  onClick={() => put([p, ...v.places.filter((_, j) => j !== i)])}
                >
                  Make main
                </button>
              )}
              <button
                type="button"
                className="hd-chip"
                aria-label={`Remove ${p.label}`}
                onClick={() => put(v.places.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {v.places.length < 6 && (
        <form
          className="hd-wfind"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(text.trim());
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Town or ZIP code"
            aria-label="Add a place: town or ZIP code"
            maxLength={100}
            data-testid="home-weather-find"
          />
          <button type="submit" className="hd-chip" disabled={text.trim().length < 2}>
            Find
          </button>
        </form>
      )}
      {asked && found.data && (
        <div className="hd-row" role="group" aria-label="Places found">
          {found.data.places.length === 0 ? (
            <p className="hd-empty">Nothing found for {asked}.</p>
          ) : (
            found.data.places.map((p) => (
              <button
                key={`${p.lat},${p.lon}`}
                type="button"
                className="hd-pill"
                onClick={() => {
                  put([...v.places, p]);
                  setText("");
                  setAsked("");
                }}
                data-testid="home-weather-found"
              >
                {p.label}
              </button>
            ))
          )}
        </div>
      )}
      <label className="hd-wsrc-pick">
        <input
          type="checkbox"
          checked={v.source === "homeassistant"}
          onChange={(e) => put(v.places, e.target.checked ? "homeassistant" : "auto")}
        />
        Use Home Assistant's own weather instead
      </label>
      {save.error && (
        <p className="hd-empty" role="alert">
          {save.error.message}
        </p>
      )}
    </div>
  );
}

export function WeatherDetail({ c, onClose }: { c: Ctx; onClose: () => void }) {
  const w = c.d.weather;
  const tz = c.d.place.timeZone;
  const cycle = c.prefs.clock === "24" ? "24" : "12";
  if (!w) return null;
  return (
    <Modal title={`Weather at ${w.placeName ?? c.d.place.name}`} onCancel={onClose}>
      <div
        className="hd"
        style={{ minHeight: 0, background: "transparent", marginTop: 12 }}
        data-testid="home-weather-detail"
      >
        {w.hourly.length > 0 && (
          <>
            <p className="hd-day-h">The next hours</p>
            {w.hourly.map((h) => {
              const H = weatherOf(h.condition);
              return (
                <div
                  className="hd-ev"
                  key={h.time}
                  style={{ gridTemplateColumns: "28px 80px 1fr" }}
                >
                  <H.icon size={20} className={H.tone} />
                  <span className="hd-t">{clockTime(h.time, tz, cycle)}</span>
                  <span>
                    <b style={{ display: "inline" }}>
                      {h.temperature !== undefined ? `${Math.round(h.temperature)}°` : "–"}
                    </b>{" "}
                    {H.words}
                    {h.rain !== undefined ? ` · ${Math.round(h.rain)}% rain` : ""}
                  </span>
                </div>
              );
            })}
          </>
        )}
        <p className="hd-day-h">The next days</p>
        {w.forecast.map((f) => {
          const F = weatherOf(f.condition);
          return (
            <div className="hd-ev" key={f.date} style={{ gridTemplateColumns: "28px 80px 1fr" }}>
              <F.icon size={20} className={F.tone} />
              <span className="hd-t">
                {new Date(f.date).toLocaleDateString([], {
                  weekday: "long",
                  ...(tz ? { timeZone: tz } : {}),
                })}
              </span>
              <span>
                <b style={{ display: "inline" }}>
                  {f.high !== undefined ? `${Math.round(f.high)}°` : "–"}
                </b>
                {f.low !== undefined ? ` / ${Math.round(f.low)}°` : ""} {F.words}
                {f.rain !== undefined ? ` · ${Math.round(f.rain)}% rain` : ""}
              </span>
            </div>
          );
        })}
        <p className="hd-note-box" style={{ marginTop: 10 }}>
          {w.sourceName && w.sourceName !== "Home Assistant"
            ? `From the ${w.sourceName === "Open-Meteo" ? "Open-Meteo forecast" : w.sourceName}${w.placeName ? `, for ${w.placeName}` : ""}.`
            : `From ${w.name} in Home Assistant.`}
        </p>
        {!c.d.tablet && <WeatherPlaces />}
      </div>
    </Modal>
  );
}
