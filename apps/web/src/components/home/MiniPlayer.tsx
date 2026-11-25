import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, useWorkspace } from "../../data/api";
import { homePicture, useHomeAction, type HomeData } from "../../data/home";
import { appKindOf } from "../command/Diagnostics";
import { cx } from "../ui";

/**
 * The mini player (the owner, 11-24): while music plays and the Home Assistant dashboard isn't
 * on screen, a small card follows you around Hearth with the cover, play/pause, next and back.
 * Its X stops the music outright (not just a pause). It starts in the top right corner and can be
 * dragged anywhere; where you leave it is remembered on this browser.
 */

/* ---------- is the Home Assistant dashboard on screen? ---------- */

let onScreen = 0;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());
/** The Home Assistant dashboard calls this while it is shown: the mini player steps aside. */
export function useHomeDashboardShown() {
  useEffect(() => {
    onScreen++;
    tell();
    return () => {
      onScreen--;
      tell();
    };
  }, []);
}
const useDashboardShown = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => onScreen > 0,
  );

/* ---------- where it sits ---------- */

const PLACE_KEY = "hearth.miniPlayer.place";
type Place = { x: number; y: number };
const WIDTH = 300;
const HEIGHT = 84;
const MARGIN = 12;
const clamp = (p: Place): Place => ({
  x: Math.min(Math.max(MARGIN, p.x), Math.max(MARGIN, window.innerWidth - WIDTH - MARGIN)),
  y: Math.min(Math.max(MARGIN, p.y), Math.max(MARGIN, window.innerHeight - HEIGHT - MARGIN)),
});
/** Top right, under the top bar. */
const corner = (): Place => clamp({ x: window.innerWidth - WIDTH - 16, y: 72 });
function savedPlace(): Place | undefined {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null") as Place | null;
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? clamp(p) : undefined;
  } catch {
    return undefined;
  }
}

/* ---------- which speaker ---------- */

type Player = HomeData["music"][number];
/** The speaker playing now; else the one that was, while it's paused (so it can carry on). */
function pick(music: Player[], last?: string): Player | undefined {
  const playing = music.filter((m) => m.state === "playing" && m.title && !m.video);
  return (
    playing.find((m) => m.entity === last) ??
    playing[0] ??
    music.find((m) => m.entity === last && m.state === "paused" && m.title)
  );
}

export function MiniPlayer() {
  const ws = useWorkspace().data;
  const ha = (ws?.services ?? []).some((s) => appKindOf(s) === "homeassistant");
  const shown = useDashboardShown();
  if (!ha || shown) return null;
  return <Card />;
}

function Card() {
  // Its own quiet read: "nothing playing" (never an error) when Home Assistant isn't ready.
  // Keyed under "home", so a tap's instant update and re-read cover it too.
  const q = useQuery({
    queryKey: ["home", "now-playing"],
    queryFn: () =>
      api<{ serviceId?: string; music: HomeData["music"] }>("GET", "/api/home/now-playing"),
    refetchInterval: (query) =>
      query.state.data?.music.some((m) => m.state === "playing") ? 8000 : 20_000,
    refetchOnWindowFocus: true,
  });
  const act = useHomeAction(q.data?.serviceId);
  const [last, setLast] = useState<string>();
  // Closed: hidden until something plays again (a new song or another speaker).
  const [closed, setClosed] = useState<string>();
  const p = q.data ? pick(q.data.music, last) : undefined;
  // Kept up during render (React's pattern for state that follows other state).
  if (p?.state === "playing" && p.entity !== last) setLast(p.entity);
  const key = p ? `${p.entity}|${p.title ?? ""}` : "";
  if (closed && (!p || (p.state === "playing" && closed !== key))) setClosed(undefined);

  const [place, setPlace] = useState<Place>(() => savedPlace() ?? corner());
  useEffect(() => {
    const keep = () => setPlace((pl) => clamp(pl));
    window.addEventListener("resize", keep);
    return () => window.removeEventListener("resize", keep);
  }, []);
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);

  if (!p || closed === key) return null;
  const playing = p.state === "playing";
  const tap = (action: string) => act.mutate({ entity: p.entity, action });
  const stop = () => {
    setClosed(key);
    // Speakers that can't stop are paused instead, so the music still ends.
    act.mutate({ entity: p.entity, action: "stop" }, { onError: () => tap("pause") });
  };

  return (
    <div
      role="region"
      aria-label="Now playing"
      className="fixed z-[60] flex touch-none items-center gap-3 rounded-2xl border border-line-strong bg-panel/95 p-2 pr-1 text-ink shadow-2xl backdrop-blur select-none"
      style={{ left: place.x, top: place.y, width: WIDTH, height: HEIGHT }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        drag.current = { dx: e.clientX - place.x, dy: e.clientY - place.y, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.moved = true;
        setPlace(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }));
      }}
      onPointerUp={() => {
        if (drag.current?.moved)
          try {
            localStorage.setItem(PLACE_KEY, JSON.stringify(place));
          } catch {
            /* this browser keeps nothing; it starts in the corner next time */
          }
        drag.current = null;
      }}
      data-testid="mini-player"
      title="Drag to move"
    >
      {p.picture ? (
        <img
          src={homePicture(p.entity, q.data?.serviceId, p.title)}
          alt=""
          draggable={false}
          className="h-[68px] w-[68px] shrink-0 rounded-xl object-cover"
          data-testid="mini-player-cover"
        />
      ) : (
        <span className="h-[68px] w-[68px] shrink-0 rounded-xl bg-line" />
      )}
      <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing">
        <p
          className="truncate text-[0.84rem] leading-tight text-ink"
          data-testid="mini-player-title"
        >
          {p.title}
        </p>
        <p className="truncate text-[0.74rem] text-muted">{p.artist ?? p.name}</p>
        <div className="mt-1 flex items-center gap-1">
          <Btn label="Previous" disabled={!p.can.previous} onClick={() => tap("previous")}>
            <SkipBack className="h-4 w-4" fill="currentColor" />
          </Btn>
          <Btn
            label={playing ? "Pause" : "Play"}
            disabled={!p.can.pause}
            onClick={() => tap(playing ? "pause" : "play")}
            gold
            testid="mini-player-play"
          >
            {playing ? (
              <Pause className="h-4 w-4" fill="currentColor" />
            ) : (
              <Play className="h-4 w-4" fill="currentColor" />
            )}
          </Btn>
          <Btn label="Next" disabled={!p.can.next} onClick={() => tap("next")}>
            <SkipForward className="h-4 w-4" fill="currentColor" />
          </Btn>
        </div>
      </div>
      <button
        type="button"
        aria-label="Stop the music and close"
        title="Stop the music and close"
        onClick={stop}
        className="self-start grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-line hover:text-ink"
        data-testid="mini-player-close"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function Btn({
  label,
  disabled,
  onClick,
  gold,
  testid,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  gold?: boolean;
  testid?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "grid h-8 w-8 place-items-center rounded-full disabled:opacity-40",
        gold ? "bg-gold text-bg hover:brightness-110" : "text-ink hover:bg-line",
      )}
      data-testid={testid}
    >
      {children}
    </button>
  );
}
