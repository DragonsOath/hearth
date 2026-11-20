import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ListEnd,
  ListPlus,
  Music,
  Play,
  Radio,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import {
  useMusicHome,
  useMusicLibrary,
  useMusicOpen,
  useMusicPlay,
  useMusicSearch,
  type MusicHow,
  type MusicItem,
} from "../../data/home";
import { Panel, type Ctx } from "./parts";
import { useCaveMaybe } from "../shell/cave-context";
import { EmberMark } from "../ember/EmberMark";

/**
 * The music library on the Media page (11-05: "set up like Overseerr or a Plex library,
 * with poster art", "I want my quick picks visible", "I can't go into the playlist"). Rows of
 * posters that scroll sideways: the music service's own rows (Listen again, Mixed for you, ...)
 * first, then your playlists, albums and artists. A song opens its choices (Play, Start mix,
 * Play next, Add to queue); a playlist, album or artist opens to its songs.
 */

type Go = (item: MusicItem, how: MusicHow) => void;

const canMix = (i: MusicItem) => i.kind === "track" || i.kind === "artist" || i.kind === "album";

function Poster({ item, onOpen }: { item: MusicItem; onOpen: (i: MusicItem) => void }) {
  return (
    <button
      type="button"
      className="hd-poster"
      data-kind={item.kind}
      onClick={() => onOpen(item)}
      data-testid="home-music-poster"
      title={item.name}
    >
      <span className="hd-poster-art">
        {item.image ? (
          <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <Music aria-hidden />
        )}
      </span>
      <span className="hd-poster-name">{item.name}</span>
      {item.by && <span className="hd-poster-by">{item.by}</span>}
    </button>
  );
}

function Row({
  title,
  items,
  onOpen,
  playAll,
}: {
  title: string;
  items: MusicItem[];
  onOpen: (i: MusicItem) => void;
  /** Songs only (Quick picks): play the whole row, in order. */
  playAll?: (songs: MusicItem[]) => void;
}) {
  if (!items.length) return null;
  const songs = items.filter((i) => i.kind === "track");
  return (
    <section className="hd-shelf" aria-label={title}>
      <p className="hd-shelf-title">
        {title}
        {playAll && songs.length > 1 && (
          <button
            type="button"
            className="hd-chip"
            style={{ marginLeft: 10, minHeight: 30 }}
            onClick={() => playAll(songs)}
            data-testid="home-music-play-all"
          >
            <Play size={14} /> Play all
          </button>
        )}
      </p>
      <div className="hd-shelf-scroll" data-swipe-ignore>
        {items.map((i) => (
          <Poster key={`${title}-${i.uri}`} item={i} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function Actions({ item, go, busy }: { item: MusicItem; go: Go; busy: boolean }) {
  return (
    <div className="hd-music-acts">
      <button
        type="button"
        className="hd-icon"
        aria-label={`Play ${item.name}`}
        title="Play"
        disabled={busy}
        onClick={() => go(item, "play")}
        data-testid="home-music-play"
      >
        <Play />
      </button>
      {canMix(item) && (
        <button
          type="button"
          className="hd-icon"
          aria-label={`Start a mix from ${item.name}`}
          title="Start mix"
          disabled={busy}
          onClick={() => go(item, "mix")}
          data-testid="home-music-mix"
        >
          <Radio />
        </button>
      )}
      <button
        type="button"
        className="hd-icon"
        aria-label={`Play ${item.name} next`}
        title="Play next"
        disabled={busy}
        onClick={() => go(item, "next")}
      >
        <ListPlus />
      </button>
      <button
        type="button"
        className="hd-icon"
        aria-label={`Add ${item.name} to the queue`}
        title="Add to queue"
        disabled={busy}
        onClick={() => go(item, "add")}
      >
        <ListEnd />
      </button>
    </div>
  );
}

function SongList({ items, go, busy }: { items: MusicItem[]; go: Go; busy: boolean }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((item, n) => (
        <li key={`${item.uri}-${n}`} className="hd-music-row" data-testid="home-music-item">
          <div className="hd-music-art">
            {item.image ? (
              <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
            ) : (
              <Music size={20} aria-hidden />
            )}
          </div>
          <div className="hd-music-text">
            <span className="hd-music-name">{item.name}</span>
            {(item.by || item.album) && (
              <span className="hd-music-by">
                {[item.by, item.album].filter(Boolean).join(" · ")}
              </span>
            )}
          </div>
          <Actions item={item} go={go} busy={busy} />
        </li>
      ))}
    </ul>
  );
}

/** Inside a playlist, an album or an artist: big art, Play and Start mix, then its songs. */
function Opened({
  item,
  go,
  busy,
  onBack,
  onOpen,
}: {
  item: MusicItem;
  go: Go;
  busy: boolean;
  onBack: () => void;
  onOpen: (i: MusicItem) => void;
}) {
  const q = useMusicOpen(item.uri);
  const head = q.data?.item ?? item;
  return (
    <div className="hd-music-open" data-testid="home-music-open">
      <button
        type="button"
        className="hd-chip"
        onClick={onBack}
        style={{ alignSelf: "flex-start" }}
      >
        <ArrowLeft size={16} /> Back
      </button>
      <div className="hd-music-head">
        <span className="hd-poster-art hd-music-head-art">
          {head.image ? <img src={head.image} alt="" referrerPolicy="no-referrer" /> : <Music />}
        </span>
        <div className="hd-music-text">
          <span className="hd-lbl">{head.kind}</span>
          <h3 className="hd-music-head-name">{head.name}</h3>
          {head.by && <span className="hd-music-by">{head.by}</span>}
          <div className="hd-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="hd-pill"
              disabled={busy}
              onClick={() => go(head, "play")}
              data-testid="home-music-open-play"
            >
              <Play size={18} /> Play
            </button>
            {canMix(head) && (
              <button
                type="button"
                className="hd-pill"
                disabled={busy}
                onClick={() => go(head, "mix")}
              >
                <Radio size={18} /> Start mix
              </button>
            )}
          </div>
        </div>
      </div>
      {q.isLoading && <p className="hd-empty">Loading...</p>}
      {q.error && (
        <p className="hd-empty" role="alert">
          {(q.error as Error).message}
        </p>
      )}
      {q.data && <Row title="Albums" items={q.data.albums} onOpen={onOpen} />}
      {q.data && q.data.tracks.length > 0 && <SongList items={q.data.tracks} go={go} busy={busy} />}
      {q.data && !q.data.tracks.length && !q.data.albums.length && (
        <p className="hd-empty">Nothing in here.</p>
      )}
    </div>
  );
}

/** The words Ember gets for Have Ember make a playlist: the same flow as a Home row. */
export function playlistPrompt(
  serviceId: string,
  what: string,
  count: number,
  name: string,
  where = "",
) {
  return [
    `Make me a playlist on my ${where || "music service"} through Music Assistant (Home Assistant service ${serviceId}): ${what}. About ${count} songs.`,
    name ? `Call it "${name}".` : "Suggest a name.",
    "Ask me anything you still need first, one short question at a time.",
  ].join(" ");
}

/**
 * Have Ember make a playlist (11-12, the owner: "the same way we generate a collection or row for
 * Home rows"): say the vibe, about how many, and a name; Ember picks, checks each song is real,
 * opens them in the Forge to swap, and creates it only after your yes. Only where Ember is (not
 * on a wall tablet or the standalone home screen, which have no chat and no owner's AI plan).
 */
function MakePlaylist({ serviceId, services }: { serviceId: string; services: string[] }) {
  const cave = useCaveMaybe();
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState("");
  const [what, setWhat] = useState("");
  const [count, setCount] = useState("50");
  const [name, setName] = useState("");
  if (!cave) return null;
  if (!open)
    return (
      <button
        type="button"
        className="hd-chip"
        style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 8 }}
        onClick={() => setOpen(true)}
        data-testid="home-music-make-playlist"
      >
        <Sparkles size={16} aria-hidden /> Have Ember make a playlist
      </button>
    );
  const n = Math.min(300, Math.max(5, Number(count) || 50));
  return (
    <form
      className="hd-note-box hd-form"
      style={{ gap: 10 }}
      data-testid="home-music-playlist-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!what.trim()) return;
        cave.ask(playlistPrompt(serviceId, what.trim(), n, name.trim(), where || services[0]));
        setOpen(false);
        setWhat("");
        setName("");
      }}
    >
      <label style={{ display: "grid", gap: 4 }}>
        <span>What kind of playlist?</span>
        <textarea
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          rows={2}
          placeholder="2010s rock like Muse and Cage the Elephant, a rainy-day mix, songs for a road trip"
          data-testid="home-music-playlist-what"
        />
      </label>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span>About how many songs</span>
          <input
            type="number"
            min={5}
            max={300}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            style={{ width: 110 }}
          />
        </label>
        {services.length > 1 && (
          <label style={{ display: "grid", gap: 4 }}>
            <span>Make it on</span>
            <select
              value={where || services[0]}
              onChange={(e) => setWhere(e.target.value)}
              data-testid="home-music-playlist-where"
            >
              {services.map((sv) => (
                <option key={sv}>{sv}</option>
              ))}
            </select>
          </label>
        )}
        <label style={{ display: "grid", gap: 4, flex: "1 1 200px" }}>
          <span>Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <p style={{ margin: 0, opacity: 0.8 }}>
        Ember picks the songs and opens them in the Forge so you can swap any. Nothing is made until
        you say yes.
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          type="submit"
          className="hd-chip"
          disabled={!what.trim()}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
          data-testid="home-music-playlist-go"
        >
          Ask Ember to make it <EmberMark />
        </button>
        <button type="button" className="hd-chip" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function MusicLibrary({ c }: { c: Ctx }) {
  const speakers = c.d.music.filter((m) => m.musicAssistant);
  const chosen =
    speakers.find((s) => s.entity === c.keep.speaker) ??
    speakers.find((s) => s.state === "playing") ??
    speakers[0];
  const on = Boolean(chosen);
  // After Play: if the speaker still isn't playing a few seconds later, say so (an LG TV that
  // is off takes the song and stays silent).
  const [check, setCheck] = useState<{ entity: string; name: string; at: number }>();
  const latest = useRef(speakers);
  useEffect(() => {
    latest.current = speakers;
  });
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(typed.trim()), 400);
    return () => window.clearTimeout(t);
  }, [typed]);
  const [opened, setOpened] = useState<MusicItem[]>([]);
  const [song, setSong] = useState<MusicItem>();
  const [said, setSaid] = useState<string>();
  const [only, setOnly] = useState<string>();
  const home = useMusicHome(on);
  const playlists = useMusicLibrary(c.d.serviceId, "playlist", on);
  const albums = useMusicLibrary(c.d.serviceId, "album", on);
  const artists = useMusicLibrary(c.d.serviceId, "artist", on);
  const found = useMusicSearch(c.d.serviceId, query, on);
  const play = useMusicPlay(c.d.serviceId);

  useEffect(() => {
    if (!check) return;
    const t = window.setTimeout(() => {
      const now = latest.current.find((s) => s.entity === check.entity);
      if (now?.state !== "playing")
        setSaid(
          `${check.name} didn't start playing. Is it turned on? Pick another speaker with Speakers.`,
        );
      setCheck(undefined);
    }, 12000);
    return () => window.clearTimeout(t);
  }, [check]);

  if (!chosen)
    return (
      <Panel title="Music" icon={<Music />} testId="home-music-library">
        <p className="hd-empty">
          {c.d.tablet
            ? "The owner connects Music Assistant in Hearth for YouTube Music and more."
            : "Connect Music Assistant for YouTube Music, your playlists and mixes."}
        </p>
        {!c.d.tablet && (
          <button
            type="button"
            className="hd-chip"
            style={{ alignSelf: "flex-start" }}
            onClick={() => c.connect("music")}
            data-hearth-target="home:music-setup"
          >
            Connect music
          </button>
        )}
      </Panel>
    );

  const go: Go = (item, asked) => {
    // Nothing playing: "Play next" or "Add to queue" would sit silently in the queue, so play it.
    const how =
      chosen.state !== "playing" && (asked === "next" || asked === "add") ? "play" : asked;
    setSong(undefined);
    setSaid(how === "play" || how === "mix" ? `Starting ${item.name}...` : undefined);
    play.mutate(
      { entity: chosen.entity, uri: item.uri, kind: item.kind, how, name: item.name },
      {
        onSuccess: (r) => {
          setSaid(`${r.done}: ${item.name}`);
          c.keep.setSpeaker(chosen.entity);
          if (how === "play" || how === "mix")
            setCheck({ entity: chosen.entity, name: chosen.name, at: Date.now() });
        },
        onError: (e) => setSaid(e.message),
      },
    );
  };
  const open = (i: MusicItem) => {
    if (i.kind === "track" || i.kind === "radio") setSong(i);
    else setOpened((o) => [...o, i]);
  };
  const top = opened[opened.length - 1];
  const playAll = (songs: MusicItem[]) => {
    const [first, ...rest] = songs.slice(0, 50);
    if (!first) return;
    setSaid(`Starting ${songs.length} songs...`);
    play.mutate(
      {
        entity: chosen.entity,
        uri: first.uri,
        kind: "track",
        how: "play",
        name: `${first.name} and ${rest.length} more`,
        more: rest.map((s) => s.uri),
      },
      {
        onSuccess: (r) => {
          setSaid(`${r.done}: ${songs.length} songs`);
          c.keep.setSpeaker(chosen.entity);
          setCheck({ entity: chosen.entity, name: chosen.name, at: Date.now() });
        },
        onError: (e) => setSaid(e.message),
      },
    );
  };
  const firstOf = (t: string) => (/speed dial/i.test(t) ? 0 : /quick picks/i.test(t) ? 1 : 2);
  // One chip per music service (All first); a service's chip shows just its own rows.
  const services = [
    ...new Set(
      (home.data?.rows ?? []).map((r) => r.service).filter((x): x is string => Boolean(x)),
    ),
  ];
  const several = services.length > 1;
  const rows = [...(home.data?.rows ?? [])]
    .filter((r) => !only || r.service === only)
    .map((r) => (several && !only && r.service ? { ...r, title: `${r.title} · ${r.service}` } : r))
    .sort((a, b) => firstOf(a.title) - firstOf(b.title));
  const firstRows = rows.filter((r) => firstOf(r.title) < 2);
  const otherRows = rows.filter((r) => firstOf(r.title) === 2);

  return (
    <Panel
      title="Music"
      icon={<Music />}
      testId="home-music-library"
      action={
        !c.d.tablet &&
        home.data && (
          <button
            type="button"
            className="hd-chip"
            onClick={() => c.connect(home.data.linked ? "youtube" : "music")}
            data-hearth-target={home.data.linked ? "home:youtube-account" : "home:music-setup"}
            data-testid="home-youtube-account"
          >
            {home.data.linked ? "YouTube account" : "Link Music Assistant"}
          </button>
        )
      }
    >
      <label className="hd-search">
        <Search size={18} aria-hidden />
        <input
          type="search"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setOpened([]);
          }}
          placeholder="Search songs, artists, albums, playlists"
          aria-label="Search music"
          data-testid="home-music-search"
        />
      </label>
      {!c.d.tablet && <MakePlaylist serviceId={c.d.serviceId} services={services} />}
      {/* Where it plays is chosen in the player's speaker menu above (11-11: "a drop-down"). */}
      {said && (
        <p className="hd-empty" role="status" data-testid="home-music-said">
          {said}
        </p>
      )}
      {song && (
        <div
          className="hd-music-sheet"
          role="dialog"
          aria-label={song.name}
          data-testid="home-music-sheet"
        >
          <div className="hd-music-row">
            <div className="hd-music-art">
              {song.image ? (
                <img src={song.image} alt="" referrerPolicy="no-referrer" />
              ) : (
                <Music />
              )}
            </div>
            <div className="hd-music-text">
              <span className="hd-music-name">{song.name}</span>
              {song.by && <span className="hd-music-by">{song.by}</span>}
            </div>
            <button
              type="button"
              className="hd-icon"
              aria-label="Close"
              onClick={() => setSong(undefined)}
            >
              <X />
            </button>
          </div>
          <div className="hd-row">
            <button
              type="button"
              className="hd-pill"
              disabled={play.isPending}
              onClick={() => go(song, "play")}
            >
              <Play size={18} /> Play
            </button>
            <button
              type="button"
              className="hd-pill"
              disabled={play.isPending}
              onClick={() => go(song, "mix")}
              data-testid="home-music-sheet-mix"
            >
              <Radio size={18} /> Start mix
            </button>
            <button
              type="button"
              className="hd-pill"
              disabled={play.isPending}
              onClick={() => go(song, "next")}
            >
              <ListPlus size={18} /> Play next
            </button>
            <button
              type="button"
              className="hd-pill"
              disabled={play.isPending}
              onClick={() => go(song, "add")}
            >
              <ListEnd size={18} /> Add to queue
            </button>
          </div>
        </div>
      )}
      {top ? (
        <Opened
          key={top.uri}
          item={top}
          go={go}
          busy={play.isPending}
          onBack={() => setOpened((o) => o.slice(0, -1))}
          onOpen={open}
        />
      ) : query ? (
        <>
          {found.isFetching && !found.data && <p className="hd-empty">Searching...</p>}
          {found.error && (
            <p className="hd-empty" role="alert">
              {(found.error as Error).message}
            </p>
          )}
          <Row title="Songs" items={found.data?.tracks ?? []} onOpen={open} />
          <Row title="Artists" items={found.data?.artists ?? []} onOpen={open} />
          <Row title="Albums" items={found.data?.albums ?? []} onOpen={open} />
          <Row title="Playlists" items={found.data?.playlists ?? []} onOpen={open} />
          {found.data &&
            !found.data.tracks.length &&
            !found.data.artists.length &&
            !found.data.albums.length &&
            !found.data.playlists.length && (
              <p className="hd-empty">Nothing found for "{query}".</p>
            )}
        </>
      ) : (
        <>
          {home.data && !home.data.linked && !c.d.tablet && (
            <div className="hd-note-box" data-testid="home-music-link">
              Your YouTube Music home (Listen again, Mixed for you) shows here once Hearth links to
              Music Assistant itself.{" "}
              <button type="button" className="hd-chip" onClick={() => c.connect("music")}>
                Link Music Assistant
              </button>
            </div>
          )}
          {home.data?.youtubeError && !c.d.tablet && (
            <div className="hd-note-box" role="status" data-testid="home-youtube-error">
              Your full YouTube Music home (Speed dial, Quick picks) couldn&apos;t be read:{" "}
              {home.data.youtubeError}
            </div>
          )}
          {services.length > 0 && (
            <div
              className="hd-row"
              role="group"
              aria-label="Music services"
              data-testid="home-music-services"
            >
              <button
                type="button"
                className="hd-pill"
                aria-pressed={!only}
                onClick={() => setOnly(undefined)}
              >
                All
              </button>
              {services.map((sv) => (
                <button
                  key={sv}
                  type="button"
                  className="hd-pill"
                  aria-pressed={only === sv}
                  onClick={() => setOnly(sv)}
                >
                  {sv}
                </button>
              ))}
              {!c.d.tablet && (
                <button
                  type="button"
                  className="hd-chip"
                  onClick={() => c.connect("music")}
                  data-hearth-target="home:add-music-service"
                >
                  + Add a service
                </button>
              )}
            </div>
          )}
          {/* Speed dial and Quick picks first, then your playlists, then the rest. */}
          {firstRows.map((r) => (
            <Row key={r.id} title={r.title} items={r.items} onOpen={open} playAll={playAll} />
          ))}
          {!only && (
            <Row title="Your playlists" items={playlists.data?.items ?? []} onOpen={open} />
          )}
          {otherRows.map((r) => (
            <Row key={r.id} title={r.title} items={r.items} onOpen={open} playAll={playAll} />
          ))}
          {!only && (
            <>
              <Row title="Albums" items={albums.data?.items ?? []} onOpen={open} />
              <Row title="Artists" items={artists.data?.items ?? []} onOpen={open} />
            </>
          )}
          {(home.isLoading || playlists.isLoading) && (
            <p className="hd-empty">Loading your music...</p>
          )}
        </>
      )}
    </Panel>
  );
}
