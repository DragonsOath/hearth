import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BellRing,
  ChevronLeft,
  ChevronRight,
  Flame,
  House,
  LayoutGrid,
  Maximize2,
  Music,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  X,
} from "lucide-react";
import { Link } from "react-router";
import { homePicture, useHome, useHomeAction, usePhotos, type HomeTap } from "../../data/home";
import { lockDirection, ownsHorizontal, swipeStep, wrapIndex } from "../../lib/swipe";
import { clockParts, digitalTime, timeInWords } from "../../lib/timeWords";
import { isNight, sceneFor } from "../../lib/weatherScene";
import { Skeleton } from "../ui";
import { ConnectDialog, type ConnectFor } from "./ConnectDialog";
import { AddSpeaker, SpeakerHereBar } from "./Speakers";
import { AlbumPicker, DevicePicker, FeedsEditor, GallerySheet } from "./Gallery";
import {
  PAGES,
  PAGE_NAMES,
  useHomePrefs,
  type HomePrefs,
  type Page,
  type Widget,
} from "./homePrefs";
import { Overview, securitySummary, speakerOf } from "./Overview";
import { HouseholdPage, MediaPage, RoomsPage, SecurityPage, WeatherDetail } from "./Pages";
import { PinPad } from "./PinPad";
import { useNow, type Ctx } from "./parts";
import { CameraTile } from "./Pages";
import { Slideshow } from "./Widgets";
import { WeatherScene } from "./WeatherScene";
import { useHomeDashboardShown } from "./MiniPlayer";
import "./home.css";

/**
 * The home dashboard (11-04, redesigned from his reference on 11-05): a household command
 * centre for a wall tablet. A window on the real weather behind glowing glass panels: the time
 * written out, Home Assistant's weather and forecast, music like a media app, today's calendar,
 * lists, the home's status and scenes; then Rooms, Media, Security and Household pages, swiped or
 * tapped. Taps act straight away; opening a door, the garage or turning the alarm off asks for
 * the home's unlock PIN, checked by the server. Connecting services is for the owner, never a
 * home tablet. Everything shown comes from Home Assistant; nothing is sample data.
 */

const PAGE_ICON: Record<Page, ReactNode> = {
  home: <House />,
  rooms: <LayoutGrid />,
  media: <Music />,
  security: <ShieldCheck />,
  household: <ShoppingCart />,
};

function SettingsSheet({
  prefs,
  update,
  owner,
  connect,
  pinSet,
  onFullScreen,
  exit,
  onClose,
  onCustomize,
  onGallery,
}: {
  prefs: HomePrefs;
  update: (p: Partial<HomePrefs>) => void;
  owner: boolean;
  /** Opens Connect; with `renew`, straight into that service's sign-in again. */
  connect: (f: ConnectFor, renew?: string) => void;
  pinSet: boolean;
  onFullScreen?: () => void;
  exit?: ReactNode;
  onClose: () => void;
  onCustomize: () => void;
  onGallery: () => void;
}) {
  const seg = <K extends keyof HomePrefs>(key: K, options: [HomePrefs[K], string][]) => (
    <div className="hd-seg" role="group">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          type="button"
          className="hd-pill"
          aria-pressed={prefs[key] === v}
          onClick={() => update({ [key]: v } as Partial<HomePrefs>)}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div
      className="hd-sheet"
      role="dialog"
      aria-label="Dashboard settings"
      data-testid="home-settings"
    >
      <div className="hd-h">
        <Settings />
        Dashboard settings
        <button type="button" className="hd-chip hd-h-act" onClick={onClose}>
          Done
        </button>
      </div>
      <div>
        <h4>Clock</h4>
        {seg("clock", [
          ["words", "In words"],
          ["12", "12-hour"],
          ["24", "24-hour"],
        ])}
      </div>
      <div>
        <h4>Opens on</h4>
        {seg(
          "start",
          PAGES.map((p) => [p, PAGE_NAMES[p]] as [Page, string]),
        )}
      </div>
      <div>
        <h4>Weather animation</h4>
        {seg("motion", [
          ["full", "Full"],
          ["lite", "Light (older tablets)"],
          ["off", "Still"],
        ])}
      </div>
      <div>
        <h4>Dim when no one touches it (full screen)</h4>
        {seg("dim", [
          [5, "5 min"],
          [10, "10 min"],
          [30, "30 min"],
          [0, "Never"],
        ])}
      </div>
      <div>
        <h4>Home page widgets</h4>
        <div className="hd-seg">
          <button
            type="button"
            className="hd-pill"
            onClick={onGallery}
            data-testid="home-open-gallery"
          >
            <Sparkles size={18} /> Add widgets
          </button>
          <button type="button" className="hd-pill" onClick={onCustomize}>
            Move and resize
          </button>
        </div>
      </div>
      <div>
        <h4>When dimmed, show</h4>
        {seg("idlePhotos", [
          [false, "The time"],
          [true, "Photo frame"],
        ])}
      </div>
      <div>
        <h4>When the doorbell rings</h4>
        {seg("doorbellPopup", [
          [true, "Show its camera"],
          [false, "Do nothing"],
        ])}
      </div>
      {owner && (
        <div>
          <h4>Connect (through Home Assistant)</h4>
          <div className="hd-seg">
            <button type="button" className="hd-pill" onClick={() => connect("music")}>
              Music
            </button>
            <button type="button" className="hd-pill" onClick={() => connect("calendar")}>
              A calendar
            </button>
            <button type="button" className="hd-pill" onClick={() => connect("lists")}>
              A list
            </button>
            <button type="button" className="hd-pill" onClick={() => connect("weather")}>
              Weather
            </button>
          </div>
          <p className="hd-note-box" style={{ marginTop: 8 }} data-testid="home-owner-note">
            {pinSet
              ? "Opening doors and turning off the alarm ask for the unlock PIN."
              : "Set an unlock PIN (below the dashboard) before opening doors from here."}{" "}
            <Link to="/devices?add=home" style={{ color: "var(--hd-ember-hi)" }}>
              Pair a home tablet
            </Link>
          </p>
        </div>
      )}
      <div className="hd-seg">
        {onFullScreen && (
          <button
            type="button"
            className="hd-pill"
            onClick={onFullScreen}
            data-testid="home-full-screen"
          >
            <Maximize2 size={18} /> Full screen
          </button>
        )}
        {exit}
      </div>
    </div>
  );
}

/** Dimmed after a while untouched (full screen only); the first touch only wakes it. */
function useIdle(minutes: number, on: boolean) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!on || !minutes) return;
    let t = 0;
    const reset = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), minutes * 60_000);
    };
    const events = ["pointerdown", "keydown", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(t);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [minutes, on]);
  return [on && minutes > 0 && idle, () => setIdle(false)] as const;
}

function IdleScreen({
  tz,
  cycle,
  onWake,
  photos,
}: {
  tz?: string;
  cycle: HomePrefs["clock"];
  onWake: () => void;
  /** The photo frame's photos, when the screen shows them while dimmed. */
  photos?: string[];
}) {
  const now = useNow();
  const { hour, minute } = clockParts(now, tz);
  const w = timeInWords(hour, minute);
  // The time drifts a little each minute so nothing stays in one place for hours.
  const shift = (minute % 7) * 12;
  return (
    <div
      className="hd-idle"
      role="button"
      tabIndex={0}
      aria-label="Wake the dashboard"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onWake();
      }}
      onKeyDown={onWake}
      style={{ paddingTop: shift, paddingLeft: `calc(8cqi + ${shift}px)` }}
      data-testid="home-idle"
    >
      {photos && photos.length > 0 && <Slideshow photos={photos} every={20_000} />}
      <p className="hd-clock">{cycle === "words" ? w.main : digitalTime(hour, minute, cycle)}</p>
      {cycle === "words" && w.part && (
        <p className="hd-part" style={{ opacity: 0.6 }}>
          {w.part}
        </p>
      )}
    </div>
  );
}

export function HomeDashboard({
  service,
  onFullScreen,
  kiosk,
  exit,
}: {
  service?: string;
  onFullScreen?: () => void;
  /** Full screen (a wall tablet): fills the screen, dims when idle. */
  kiosk?: boolean;
  /** Leaving full screen (Back to Hearth, or unpair a tablet). */
  exit?: ReactNode;
}) {
  const [prefs, update] = useHomePrefs();
  // The mini player steps aside while this is on screen.
  useHomeDashboardShown();
  const q = useHome(service, prefs.devices);
  const act = useHomeAction(q.data?.serviceId ?? service);
  const [editing, setEditing] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [options, setOptions] = useState<Widget>();
  const [ring, setRing] = useState<{ name: string; camera?: string }>();
  const rings = useRef<Map<string, string | undefined>>(undefined);
  const [page, setPage] = useState<Page>(prefs.start);
  const [from, setFrom] = useState(0);
  const [note, setNote] = useState<{ text: string; bad?: boolean }>();
  const [pin, setPin] = useState<{ tap: HomeTap; label: string; alarmCode: boolean }>();
  const [connecting, setConnecting] = useState<ConnectFor>();
  const [renew, setRenew] = useState<string>();
  // Add a speaker; opened by itself when a speaker link brought this device here (?speaker=1).
  const [addingSpeaker, setAddingSpeaker] = useState(
    () => new URLSearchParams(window.location.search).get("speaker") === "1",
  );
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [list, setList] = useState<string>();
  const [room, setRoom] = useState<string>();
  // The speaker picked last is remembered on this device (11-06: music went to the idle LG TV).
  const [speaker, pickSpeaker] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem("hearth.home.speaker") ?? undefined;
    } catch {
      return undefined;
    }
  });
  const setSpeaker = (entity: string | undefined) => {
    pickSpeaker(entity);
    try {
      if (entity) localStorage.setItem("hearth.home.speaker", entity);
      else localStorage.removeItem("hearth.home.speaker");
    } catch {
      /* private window: just this visit */
    }
  };
  const [idle, wake] = useIdle(prefs.dim, Boolean(kiosk));
  const frame = usePhotos(Boolean(kiosk && prefs.idlePhotos));
  const body = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ x: number; y: number; dir?: "x" | "y"; owned: boolean }>(undefined);
  const now = useNow();

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(undefined), 4000);
    return () => window.clearTimeout(t);
  }, [note]);

  const d = q.data;

  // The doorbell: when one rings (a newer ring than this screen has seen), its camera comes up
  // over everything for a minute. The rings already there when the screen opened never pop up.
  const bells = d?.doorbells;
  useEffect(() => {
    if (!bells) return;
    const seen = rings.current;
    rings.current = new Map(bells.map((b) => [b.entity, b.last]));
    if (!seen || !prefs.doorbellPopup) return;
    const rang = bells.find(
      (b) =>
        b.last && b.last !== seen.get(b.entity) && Date.now() - Date.parse(b.last) < 3 * 60_000,
    );
    if (rang) setRing({ name: rang.name, ...(rang.camera ? { camera: rang.camera } : {}) });
  }, [bells, prefs.doorbellPopup]);
  useEffect(() => {
    if (!ring) return;
    wake();
    const t = window.setTimeout(() => setRing(undefined), 60_000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring]);

  const hour = clockParts(now, d?.place.timeZone).hour;
  const night = isNight(d?.sun?.up, hour);
  const condition = d?.weather?.condition;
  const scene = useMemo(() => sceneFor(condition, night), [condition, night]);

  const go = (p: Page) => {
    setFrom(PAGES.indexOf(p) > PAGES.indexOf(page) ? 40 : -40);
    setPage(p);
  };
  const step = (s: -1 | 1) => go(PAGES[wrapIndex(PAGES.indexOf(page), s, PAGES.length)]!);

  if (q.isLoading) return <Skeleton className="h-[720px]" />;
  if (!d)
    return (
      <p className="text-[0.95rem] text-amber" role="alert">
        {q.error?.message ?? "Could not read Home Assistant."}
      </p>
    );

  const tap = (t: HomeTap) =>
    act.mutate(t, {
      onSuccess: (r) => setNote({ text: `Done: ${r.done}` }),
      onError: (e) => setNote({ text: e.message, bad: true }),
    });
  const c: Ctx = {
    d,
    tap,
    busy: act.isPending,
    askPin: (t, label, alarmCode) => setPin({ tap: t, label, alarmCode }),
    connect: (f: ConnectFor, r?: string) => {
      setRenew(r);
      setConnecting(f);
    },
    addSpeaker: () => setAddingSpeaker(true),
    go,
    prefs,
    keep: { list, setList, room, setRoom, speaker, setSpeaker },
  };

  // The status chip: anything open or going off, else all normal; offline when Home Assistant
  // stopped answering (what is shown is then its last reading).
  const { open, going } = securitySummary(d);
  const offline = Boolean(q.error);
  const status = offline
    ? { cls: "hd-bad", text: "Home Assistant not answering" }
    : going
      ? { cls: "hd-bad", text: "Check the home" }
      : open.length
        ? {
            cls: "hd-warn",
            text: `${open[0]!.name} ${open[0]!.kind === "lock" ? "unlocked" : "open"}`,
          }
        : { cls: "", text: "All systems normal" };
  const playing = speakerOf(c);
  const showMini = playing && playing.state === "playing" && page !== "home" && page !== "media";

  return (
    <div
      className={`hd${kiosk ? " hd-kiosk" : ""}`}
      data-testid="home-dashboard"
      style={{ ["--hd-from" as string]: `${from}px` }}
    >
      <WeatherScene scene={scene} motion={prefs.motion} />
      <header className="hd-top">
        <span className="hd-brand">
          <Flame fill="currentColor" aria-hidden />
          hearth
        </span>
        <nav className="hd-tabs" role="tablist" aria-label="Pages">
          {PAGES.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={page === p}
              onClick={() => go(p)}
              data-testid={`home-page-${p}`}
              data-page={p}
            >
              {PAGE_NAMES[p]}
            </button>
          ))}
        </nav>
        <span className={`hd-status ${status.cls}`} role="status" data-testid="home-status-chip">
          <i />
          <span>{status.text}</span>
        </span>
        <button
          type="button"
          className="hd-icon"
          aria-label="Dashboard settings"
          aria-expanded={settings}
          onClick={() => setSettings(!settings)}
          data-testid="home-settings-open"
        >
          <Settings />
        </button>
      </header>
      {offline && (
        <p className="hd-banner" role="alert" data-testid="home-offline">
          Home Assistant is not answering. This is what it last said
          {q.dataUpdatedAt
            ? ` at ${new Date(q.dataUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
            : ""}
          ; taps may not work until it is back.
        </p>
      )}
      <div
        className="hd-body"
        ref={body}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          swipe.current = {
            x: e.clientX,
            y: e.clientY,
            owned: ownsHorizontal(e.target, body.current),
          };
        }}
        onPointerMove={(e) => {
          const s = swipe.current;
          if (s && !s.dir) s.dir = lockDirection(e.clientX - s.x, e.clientY - s.y);
        }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = undefined;
          if (!s || s.owned || s.dir !== "x") return;
          const st = swipeStep(e.clientX - s.x);
          if (st) step(st);
        }}
        onPointerCancel={() => (swipe.current = undefined)}
      >
        <div
          className={`hd-page hd-page-${page}`}
          key={page}
          role="tabpanel"
          aria-label={PAGE_NAMES[page]}
          data-testid={`home-${page}-page`}
        >
          {page === "home" && (
            <Overview
              c={c}
              openWeather={() => setWeatherOpen(true)}
              update={update}
              editing={editing}
              setEditing={setEditing}
              openGallery={() => setGallery(true)}
              configure={setOptions}
            />
          )}
          {page === "rooms" && <RoomsPage c={c} />}
          {page === "media" && <MediaPage c={c} />}
          {page === "security" && <SecurityPage c={c} />}
          {page === "household" && <HouseholdPage c={c} />}
        </div>
      </div>
      <footer className="hd-foot">
        {showMini && (
          <button
            type="button"
            className="hd-mini"
            onClick={() => go("media")}
            data-testid="home-mini-player"
          >
            {playing.picture ? (
              <img src={homePicture(playing.entity, d.serviceId, playing.title ?? "")} alt="" />
            ) : (
              <span className="hd-mini-art" />
            )}
            <span className="hd-mini-t">
              <b>{playing.title ?? playing.name}</b>
              <span>{playing.artist ?? playing.name}</span>
            </span>
          </button>
        )}
        <button
          type="button"
          className="hd-arrow"
          aria-label="Previous page"
          onClick={() => step(-1)}
        >
          <ChevronLeft />
        </button>
        <span className="hd-dots">
          {PAGES.map((p) => (
            <button
              key={p}
              type="button"
              className="hd-dot-btn"
              aria-label={PAGE_NAMES[p]}
              aria-current={page === p}
              onClick={() => go(p)}
            >
              <i />
            </button>
          ))}
        </span>
        <button type="button" className="hd-arrow" aria-label="Next page" onClick={() => step(1)}>
          <ChevronRight />
        </button>
      </footer>
      <nav className="hd-ptabs" role="tablist" aria-label="Pages">
        {PAGES.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={page === p}
            onClick={() => go(p)}
            data-page={p}
          >
            {PAGE_ICON[p]}
            {PAGE_NAMES[p]}
          </button>
        ))}
      </nav>
      {settings && (
        <SettingsSheet
          prefs={prefs}
          update={update}
          owner={!d.tablet}
          connect={(f) => {
            setSettings(false);
            setConnecting(f);
          }}
          pinSet={d.pinSet}
          onFullScreen={onFullScreen}
          exit={exit}
          onClose={() => setSettings(false)}
          onCustomize={() => {
            setSettings(false);
            go("home");
            setEditing(true);
          }}
          onGallery={() => {
            setSettings(false);
            go("home");
            setGallery(true);
          }}
        />
      )}
      {gallery && (
        <GallerySheet
          d={d}
          prefs={prefs}
          update={update}
          onClose={() => {
            setGallery(false);
            setEditing(true);
          }}
        />
      )}
      {options === "devices" && (
        <DevicePicker
          service={d.serviceId}
          prefs={prefs}
          update={update}
          onClose={() => setOptions(undefined)}
        />
      )}
      {options === "news" && !d.tablet && <FeedsEditor onClose={() => setOptions(undefined)} />}
      {options === "photos" && !d.tablet && <AlbumPicker onClose={() => setOptions(undefined)} />}
      {ring && (
        <div
          className="hd-modal hd-ring"
          role="alertdialog"
          aria-label={`${ring.name} is ringing`}
          data-testid="home-ring"
        >
          <div className="hd-gallery hd-narrow">
            <div className="hd-h">
              <BellRing />
              Someone's at the door
              <button
                type="button"
                className="hd-icon hd-h-act"
                aria-label="Close"
                onClick={() => setRing(undefined)}
              >
                <X />
              </button>
            </div>
            <p className="hd-empty">{ring.name} rang just now.</p>
            {ring.camera && <CameraTile c={c} entity={ring.camera} name={ring.name} live />}
          </div>
        </div>
      )}
      {note && (
        <div
          role="status"
          className={`hd-toast${note.bad ? " hd-bad" : ""}`}
          data-testid="home-note"
        >
          {note.text}
        </div>
      )}
      {idle && (
        <IdleScreen
          tz={d.place.timeZone}
          cycle={prefs.clock}
          onWake={wake}
          {...(prefs.idlePhotos && frame.data?.photos.length ? { photos: frame.data.photos } : {})}
        />
      )}
      {weatherOpen && <WeatherDetail c={c} onClose={() => setWeatherOpen(false)} />}
      {pin && (
        <PinPad
          label={pin.label}
          alarmCode={pin.alarmCode}
          pinNeeded={!pin.tap.action.startsWith("arm_")}
          onCancel={() => setPin(undefined)}
          onEnter={(p, code) => {
            const t = { ...pin.tap, ...(p ? { pin: p } : {}), ...(code ? { code } : {}) };
            setPin(undefined);
            tap(t);
          }}
        />
      )}
      <SpeakerHereBar onOpen={() => setAddingSpeaker(true)} />
      {addingSpeaker && <AddSpeaker c={c} onClose={() => setAddingSpeaker(false)} />}
      {connecting && (
        <ConnectDialog
          service={d.serviceId}
          what={connecting}
          renew={renew}
          onClose={() => {
            setConnecting(undefined);
            setRenew(undefined);
          }}
        />
      )}
    </div>
  );
}
