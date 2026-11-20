import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  BellRing,
  CalendarClock,
  CalendarDays,
  Camera,
  Car,
  Check,
  Image as ImageIcon,
  Leaf,
  ListChecks,
  MessageSquareText,
  Minus,
  Music,
  Newspaper,
  Plus,
  Settings2,
  ShieldCheck,
  ShoppingCart,
  Sliders,
  Sparkles,
  Thermometer,
  Trophy,
  Users,
  X,
  Zap,
  type LucideIcon,
  Popcorn,
} from "lucide-react";
import {
  useBoard,
  useBoardChange,
  useHomeCatalog,
  usePhotos,
  type HomeData,
} from "../../data/home";
import {
  WIDGETS,
  WIDGET_INFO,
  moveWidget,
  resize,
  spanOf,
  type HomePrefs,
  type Widget,
  type WidgetInfo,
} from "./homePrefs";
import { deviceValue } from "./Widgets";

/**
 * The widget gallery (11-05): every widget a family might want, each in the dashboard's own
 * look; each screen chooses which to show, in what order and how wide. Widgets with options (the
 * Devices widget's devices, the news feeds, the photo album) set them here.
 */

export const WIDGET_ICON: Record<Widget, LucideIcon> = {
  music: Music,
  today: CalendarDays,
  lists: ShoppingCart,
  status: ShieldCheck,
  scenes: Sparkles,
  devices: Sliders,
  climate: Thermometer,
  cameras: Camera,
  people: Users,
  doorbell: BellRing,
  energy: Zap,
  travel: Car,
  photos: ImageIcon,
  chores: ListChecks,
  reminders: Bell,
  countdown: CalendarClock,
  notes: MessageSquareText,
  news: Newspaper,
  sports: Trophy,
  plants: Leaf,
  movienight: Popcorn,
};

/** Widgets with options of their own. */
export const HAS_OPTIONS = new Set<Widget>(["devices", "news", "photos"]);

/** Whether Home Assistant (or Hearth) has what the widget shows yet, in a few words. */
export function readiness(w: Widget, d: HomeData): string | undefined {
  switch (w) {
    case "music":
      return d.music.length ? undefined : "Connect a music service first";
    case "today":
      return d.calendars.length ? undefined : "Connect a calendar first";
    case "lists":
      return d.lists.length ? undefined : "Add a list first";
    case "climate":
      return d.climate.length ? undefined : "No thermostat in Home Assistant";
    case "cameras":
      return d.cameras.length ? undefined : "No cameras in Home Assistant";
    case "people":
      return d.people.length ? undefined : "Add people in Home Assistant";
    case "doorbell":
      return d.doorbells.length ? undefined : "No doorbell in Home Assistant";
    case "energy":
      return d.energy ? undefined : "Needs Home Assistant's Energy dashboard";
    case "travel":
      return d.travel.length ? undefined : "Add a Waze trip";
    case "sports":
      return d.sports.length ? undefined : "Needs TeamTracker in Home Assistant";
    case "plants":
      return d.plants.length ? undefined : "No plant sensors in Home Assistant";
    default:
      return undefined;
  }
}

/* ------------------------------------------------ the Home page grid ------------------------------------------------ */

/** One widget on the Home page: its width, and while customizing, its controls. */
export function Slot({
  w,
  prefs,
  update,
  editing,
  configure,
  children,
}: {
  w: Widget;
  prefs: HomePrefs;
  update: (p: Partial<HomePrefs>) => void;
  editing: boolean;
  configure: () => void;
  children: ReactNode;
}) {
  const span = spanOf(prefs, w);
  const i = prefs.shown.indexOf(w);
  const name = WIDGET_INFO[w].name;
  return (
    <div
      className={`hd-slot${editing ? " hd-editing" : ""}`}
      data-widget={w}
      style={{ ["--span" as string]: span, ["--span-m" as string]: span >= 7 ? 12 : 6 }}
    >
      {children}
      {editing && (
        <div className="hd-slot-bar" role="group" aria-label={`${name} layout`}>
          <button
            type="button"
            className="hd-icon"
            aria-label={`Move ${name} earlier`}
            disabled={i === 0}
            onClick={() => update({ shown: moveWidget(prefs.shown, w, -1) })}
          >
            <ArrowLeft />
          </button>
          <button
            type="button"
            className="hd-icon"
            aria-label={`Move ${name} later`}
            disabled={i === prefs.shown.length - 1}
            onClick={() => update({ shown: moveWidget(prefs.shown, w, 1) })}
          >
            <ArrowRight />
          </button>
          <button
            type="button"
            className="hd-icon"
            aria-label={`Make ${name} narrower`}
            disabled={span <= 3}
            onClick={() => update({ spans: resize(prefs, w, -1) })}
          >
            <Minus />
          </button>
          <button
            type="button"
            className="hd-icon"
            aria-label={`Make ${name} wider`}
            disabled={span >= 12}
            onClick={() => update({ spans: resize(prefs, w, 1) })}
          >
            <Plus />
          </button>
          {HAS_OPTIONS.has(w) && (
            <button
              type="button"
              className="hd-icon"
              aria-label={`${name} options`}
              onClick={configure}
            >
              <Settings2 />
            </button>
          )}
          <button
            type="button"
            className="hd-icon hd-x"
            aria-label={`Remove ${name}`}
            onClick={() => update({ shown: prefs.shown.filter((x) => x !== w) })}
          >
            <X />
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------ the gallery ------------------------------------------------ */

const GROUPS: WidgetInfo["group"][] = ["Everyday", "Home", "Family", "Extras"];

export function GallerySheet({
  d,
  prefs,
  update,
  onClose,
}: {
  d: HomeData;
  prefs: HomePrefs;
  update: (p: Partial<HomePrefs>) => void;
  onClose: () => void;
}) {
  return (
    <div className="hd-modal" role="dialog" aria-label="Add widgets" data-testid="home-gallery">
      <div className="hd-gallery">
        <div className="hd-h">
          <Sparkles />
          Widgets
          <button type="button" className="hd-chip hd-h-act" onClick={onClose}>
            Done
          </button>
        </div>
        <p className="hd-empty">
          Choose what this screen shows on its Home page. Each screen keeps its own choice.
        </p>
        {GROUPS.map((g) => (
          <section key={g}>
            <h4>{g}</h4>
            <div className="hd-cards">
              {WIDGETS.filter((w) => WIDGET_INFO[w].group === g).map((w) => {
                const Icon = WIDGET_ICON[w];
                const on = prefs.shown.includes(w);
                const note = readiness(w, d);
                return (
                  <button
                    key={w}
                    type="button"
                    className="hd-card"
                    aria-pressed={on}
                    data-testid={`home-gallery-${w}`}
                    onClick={() =>
                      update({
                        shown: on ? prefs.shown.filter((x) => x !== w) : [...prefs.shown, w],
                      })
                    }
                  >
                    <span className="hd-card-ic">
                      <Icon aria-hidden />
                    </span>
                    <span className="hd-card-t">
                      <b>{WIDGET_INFO[w].name}</b>
                      <span>{WIDGET_INFO[w].blurb}</span>
                      {note && <small>{note}</small>}
                    </span>
                    <span className={`hd-card-on${on ? " hd-y" : ""}`} aria-hidden>
                      {on ? <Check /> : <Plus />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <button
          type="button"
          className="hd-chip"
          onClick={() =>
            update({ shown: ["music", "today", "lists", "status", "scenes"], spans: {} })
          }
        >
          Back to the usual layout
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------ options ------------------------------------------------ */

function Sheet({
  title,
  testId,
  onClose,
  children,
}: {
  title: string;
  testId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="hd-modal" role="dialog" aria-label={title} data-testid={testId}>
      <div className="hd-gallery hd-narrow">
        <div className="hd-h">
          <Settings2 />
          {title}
          <button type="button" className="hd-chip hd-h-act" onClick={onClose}>
            Done
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function DevicePicker({
  service,
  prefs,
  update,
  onClose,
}: {
  service?: string;
  prefs: HomePrefs;
  update: (p: Partial<HomePrefs>) => void;
  onClose: () => void;
}) {
  const cat = useHomeCatalog(service, true);
  const [find, setFind] = useState("");
  const list = useMemo(() => {
    const f = find.trim().toLowerCase();
    return (cat.data?.catalog ?? []).filter(
      (x) =>
        !f ||
        x.name.toLowerCase().includes(f) ||
        (x.room ?? "").toLowerCase().includes(f) ||
        x.entity.includes(f),
    );
  }, [cat.data, find]);
  const chosen = new Set(prefs.devices);
  return (
    <Sheet title="Devices and Sensors" testId="home-device-picker" onClose={onClose}>
      <p className="hd-empty">
        Tick what to show. Switches, lights, fans and helper toggles can be flipped from the widget;
        sensors show their reading.
      </p>
      <input
        className="hd-find"
        aria-label="Find a device"
        placeholder="Find (name or room)"
        value={find}
        onChange={(e) => setFind(e.target.value)}
      />
      {cat.isLoading ? (
        <p className="hd-empty">Reading Home Assistant…</p>
      ) : !list.length ? (
        <p className="hd-empty">Nothing matches.</p>
      ) : (
        <ul className="hd-pick">
          {list.map((x) => {
            const on = chosen.has(x.entity);
            return (
              <li key={x.entity}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    update({
                      devices: on
                        ? prefs.devices.filter((e) => e !== x.entity)
                        : [...prefs.devices, x.entity].slice(0, 40),
                    })
                  }
                >
                  <span className={`hd-box${on ? " hd-y" : ""}`}>{on && <Check />}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {x.name}
                    <small className="hd-sub">{x.room ?? "No room"}</small>
                  </span>
                  <span className="hd-sub">{deviceValue(x)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

export function FeedsEditor({ onClose }: { onClose: () => void }) {
  const board = useBoard();
  const change = useBoardChange();
  const [url, setUrl] = useState("");
  const feeds = board.data?.feeds ?? [];
  const save = (next: { url: string; name?: string }[]) =>
    change.mutate({ op: "feeds.set", feeds: next });
  return (
    <Sheet title="News feeds" testId="home-feeds" onClose={onClose}>
      <p className="hd-empty">
        Paste an RSS or Atom link from any newspaper, blog or sports site (often under "RSS" at the
        bottom of its page). Hearth reads them every 15 minutes and shows the headlines.
      </p>
      <ul className="hd-pick">
        {feeds.map((f) => (
          <li key={f.url}>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
              {f.name ?? f.url}
            </span>
            <button
              type="button"
              className="hd-icon"
              aria-label={`Remove ${f.url}`}
              onClick={() => save(feeds.filter((x) => x.url !== f.url))}
            >
              <X />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="hd-add"
        onSubmit={(e) => {
          e.preventDefault();
          const u = url.trim();
          if (!/^https?:\/\/\S+$/i.test(u)) return;
          save([...feeds.filter((x) => x.url !== u), { url: u }].slice(0, 8));
          setUrl("");
        }}
      >
        <input
          aria-label="Feed link"
          placeholder="https://example.com/rss"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="submit" className="hd-pill">
          Add
        </button>
      </form>
      {change.error && <p className="hd-empty">{change.error.message}</p>}
    </Sheet>
  );
}

export function AlbumPicker({ onClose }: { onClose: () => void }) {
  const photos = usePhotos(true);
  const board = useBoard();
  const change = useBoardChange();
  const current = board.data?.photos?.album;
  return (
    <Sheet title="Photo frame" testId="home-album" onClose={onClose}>
      <p className="hd-empty">
        Which photos the frame shows, from {photos.data?.serviceName ?? "Immich"}. Archived, hidden
        and locked photos never show.
      </p>
      <ul className="hd-pick">
        <li>
          <button
            type="button"
            aria-pressed={!current}
            onClick={() => change.mutate({ op: "photos.set" })}
          >
            <span className={`hd-box${!current ? " hd-y" : ""}`}>{!current && <Check />}</span>
            <span style={{ flex: 1 }}>Recent photos</span>
          </button>
        </li>
        {(photos.data?.albums ?? []).map((a) => (
          <li key={a.id}>
            <button
              type="button"
              aria-pressed={current === a.id}
              onClick={() => change.mutate({ op: "photos.set", album: a.id, albumName: a.name })}
            >
              <span className={`hd-box${current === a.id ? " hd-y" : ""}`}>
                {current === a.id && <Check />}
              </span>
              <span style={{ flex: 1 }}>{a.name}</span>
              <span className="hd-sub">{a.count} photos</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
