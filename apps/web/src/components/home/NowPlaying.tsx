import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ListMusic,
  Music,
  Plus,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  VolumeX,
} from "lucide-react";
import { api } from "../../data/api";
import { homePicture, type HomeData } from "../../data/home";
import { AvSwitch, Transport } from "./Overview";
import { mmss, songPosition, useNow, type Ctx } from "./parts";
import { SpeakerChoice } from "./SpeakerChoice";

type Player = HomeData["music"][number];

/** Up Next from Music Assistant (server: music-assistant-api.ts musicQueue). */
interface MusicQueue {
  queueId: string;
  current?: { index: number; name: string; uri?: string; liked: boolean };
  next: {
    id: string;
    index: number;
    name: string;
    artist?: string;
    duration?: number;
    art?: string;
  }[];
  service?: string;
}

function useQueue(p: Player) {
  return useQuery({
    queryKey: ["home-music-queue", p.queue ?? p.name, p.title],
    queryFn: () =>
      api<{ linked: boolean; queue?: MusicQueue }>(
        "GET",
        `/api/home/music/queue?name=${encodeURIComponent(p.systemName ?? p.name)}${p.queue ? `&queue=${encodeURIComponent(p.queue)}` : ""}`,
      ),
    enabled: Boolean(p.musicAssistant),
    refetchInterval: p.state === "playing" ? 15_000 : false,
    retry: false,
  });
}

/**
 * Which speaker plays, as one menu (11-11, the owner: "I'd prefer the speakers to be in a
 * drop-down menu that's hidden"): the speaker's name, and under it every speaker, Add a speaker,
 * and the apps a TV or speaker offers.
 */
function SpeakerMenu({ c, p }: { c: Ctx; p: Player }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="hd-np2-spk" ref={box}>
      <button
        type="button"
        className="hd-np2-where"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
        data-testid="home-speaker-menu"
      >
        <Volume2 size={18} aria-hidden />
        <span className="hd-np2-where-name">
          {p.name}
          {p.app ? ` · ${p.app}` : ""}
        </span>
        <ChevronDown size={16} aria-hidden className={open ? "hd-flip" : undefined} />
      </button>
      {open && (
        <div
          className="hd-glass hd-np2-menu"
          role="group"
          aria-label="Speakers"
          data-testid="home-speakers"
        >
          {c.d.music.map((x) => (
            <SpeakerChoice
              key={x.entity}
              x={x}
              pressed={x.entity === p.entity}
              onPick={() => {
                // Picking another speaker while music plays moves the music there, as a phone's
                // speaker picker does; the old speaker goes quiet (Music Assistant speakers only).
                if (
                  x.entity !== p.entity &&
                  p.state === "playing" &&
                  p.musicAssistant &&
                  x.musicAssistant
                )
                  c.tap({ entity: x.entity, action: "move", value: p.entity });
                c.keep.setSpeaker(x.entity);
                setOpen(false);
              }}
              target="home:speaker"
            >
              <span>
                {x.name}
                {x.state === "playing" ? <small> · playing</small> : null}
              </span>
              {x.entity === p.entity && <Check size={16} aria-hidden />}
            </SpeakerChoice>
          ))}
          {p.can.source && p.sources.length > 0 && (
            <details>
              <summary>
                Apps on this {p.name.match(/tv/i) ? "TV" : "speaker"}
                {p.source ? ` · ${p.source}` : ""}
              </summary>
              {p.sources.slice(0, 12).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={p.source === s}
                  disabled={c.busy}
                  onClick={() => c.tap({ entity: p.entity, action: "source", value: s })}
                >
                  <span>{s}</span>
                </button>
              ))}
            </details>
          )}
          {c.addSpeaker && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                c.addSpeaker!();
              }}
              data-testid="home-add-speaker-media"
            >
              <span>
                <Plus size={14} aria-hidden /> Add a speaker
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The song's time, now and in all, either side of the bar (as the owner's picture has it). */
function SplitProgress({ p }: { p: Player }) {
  const now = useNow(p.state === "playing");
  const pos = songPosition(p, now);
  if (pos === undefined || !p.duration) return <div className="hd-prog" />;
  const pct = `${Math.min(100, (pos / p.duration) * 100)}%`;
  return (
    <div
      className="hd-prog hd-np2-prog"
      role="progressbar"
      aria-label="Song progress"
      aria-valuemin={0}
      aria-valuemax={Math.round(p.duration)}
      aria-valuenow={Math.round(pos)}
    >
      <span>{mmss(pos)}</span>
      <div className="hd-bar">
        <i style={{ width: pct }} />
        <b style={{ left: pct }} />
      </div>
      <span>{mmss(p.duration)}</span>
    </div>
  );
}

/**
 * The music page's player (11-11, the owner's picture): the poster, the song, thumbs up and down,
 * the time either side, the controls, the volume with Audio and Video, and Up Next beside it.
 * Likes and Up Next come from Music Assistant; thumbs up saves the song (YouTube Music's like when
 * it comes from there). Music Assistant has no dislike, so thumbs down takes a like back and skips.
 */
export function NowPlaying({ c, p }: { c: Ctx; p: Player }) {
  const { tap, busy, d } = c;
  const qc = useQueryClient();
  const q = useQueue(p);
  const queue = q.data?.queue;
  const art = p.picture ? homePicture(p.entity, d.serviceId, p.title ?? "") : undefined;
  const vol = useRef<number>(undefined);
  const act = useMutation({
    mutationFn: (
      body:
        | { action: "play"; queueId: string; itemId: string }
        | { action: "like" | "unlike"; uri: string },
    ) => api("POST", "/api/home/music/queue", body),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["home-music-queue"] }),
  });
  const cur = queue?.current;
  const liked = Boolean(cur?.liked);
  const canRate = Boolean(cur?.uri);
  const where = queue?.service;

  return (
    <div className="hd-np2" data-testid="home-media">
      <section className="hd-glass hd-np2-card" aria-label="Player">
        {art && <div className="hd-ambient" style={{ backgroundImage: `url("${art}")` }} />}
        <div className="hd-art hd-np2-art">{art ? <img src={art} alt="" /> : <Music />}</div>
        <div className="hd-np2-main">
          <SpeakerMenu c={c} p={p} />
          <h3 className="hd-np2-title">
            {p.title ?? (p.state === "off" ? "Off" : "Nothing playing")}
          </h3>
          <span className="hd-np2-by">{[p.artist, p.album].filter(Boolean).join(" · ")}</span>
          {canRate && (
            <div className="hd-np2-rate">
              <span className="hd-np2-thumbs" role="group" aria-label="Rate this song">
                <button
                  type="button"
                  className={`hd-np2-thumb${liked ? " hd-on" : ""}`}
                  aria-pressed={liked}
                  aria-label={liked ? "Liked: take the like back" : "Like this song"}
                  disabled={act.isPending}
                  onClick={() => act.mutate({ action: liked ? "unlike" : "like", uri: cur!.uri! })}
                  data-testid="home-like"
                >
                  <ThumbsUp size={22} fill={liked ? "currentColor" : "none"} />
                </button>
                <i aria-hidden />
                <button
                  type="button"
                  className="hd-np2-thumb"
                  aria-label="Not for me: skip it (and take the like back)"
                  title="Not for me: skips it, and takes the like back if it had one"
                  disabled={act.isPending || busy}
                  onClick={() => {
                    if (liked) act.mutate({ action: "unlike", uri: cur!.uri! });
                    tap({ entity: p.entity, action: "next" });
                  }}
                  data-testid="home-dislike"
                >
                  <ThumbsDown size={22} />
                </button>
              </span>
              {liked && (
                <span className="hd-np2-saved" data-testid="home-liked">
                  Saved{where ? ` to ${where}` : " to your library"}
                </span>
              )}
            </div>
          )}
          <SplitProgress p={p} />
          <Transport c={c} p={p} />
          <div className="hd-np2-foot">
            {p.can.volume && (
              <span className="hd-np2-vol">
                <button
                  type="button"
                  className="hd-icon"
                  aria-label={p.muted ? "Unmute" : "Mute"}
                  onClick={() => tap({ entity: p.entity, action: "mute", value: !p.muted })}
                >
                  {p.muted ? <VolumeX /> : <Volume2 />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  defaultValue={p.volume ?? 0}
                  key={`${p.entity}-${p.volume}`}
                  aria-label="Volume"
                  className="hd-range"
                  data-swipe-ignore
                  data-testid="home-volume"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    window.clearTimeout(vol.current);
                    vol.current = window.setTimeout(
                      () => tap({ entity: p.entity, action: "volume", value: v }),
                      250,
                    );
                  }}
                />
              </span>
            )}
            <AvSwitch p={p} />
          </div>
          {act.error && (
            <p className="hd-empty" role="alert">
              {act.error instanceof Error ? act.error.message : String(act.error)}
            </p>
          )}
        </div>
      </section>

      {p.musicAssistant && (
        <section className="hd-glass hd-np2-next" aria-label="Up Next" data-testid="home-up-next">
          <h4>
            <ListMusic size={22} aria-hidden /> Up Next
          </h4>
          {!queue?.next.length ? (
            <p className="hd-empty">
              {q.isLoading
                ? "Loading…"
                : q.data && !q.data.linked
                  ? "Link Music Assistant to Hearth to see what plays next."
                  : "Nothing queued after this song."}
            </p>
          ) : (
            <ol>
              {queue.next.map((t, i) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={i === 0 ? "hd-on" : undefined}
                    disabled={act.isPending}
                    onClick={() =>
                      act.mutate({ action: "play", queueId: queue.queueId, itemId: t.id })
                    }
                    aria-label={`Play ${t.name}${t.artist ? ` by ${t.artist}` : ""} now`}
                    data-testid="home-up-next-item"
                  >
                    <span className="hd-np2-n">{i + 1}</span>
                    <span className="hd-np2-thumbart">
                      {t.art ? <img src={t.art} alt="" loading="lazy" /> : <Music size={18} />}
                    </span>
                    <span className="hd-np2-t">
                      <b>{t.name}</b>
                      {t.artist && <small>{t.artist}</small>}
                    </span>
                    {t.duration ? <span className="hd-np2-d">{mmss(t.duration)}</span> : null}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
