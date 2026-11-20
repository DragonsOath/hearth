import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Bell,
  BellRing,
  CalendarClock,
  Camera,
  Car,
  Check,
  DoorOpen,
  Droplets,
  Flame,
  Gauge,
  Image as ImageIcon,
  Leaf,
  ListChecks,
  MessageSquareText,
  Newspaper,
  Plus,
  Power,
  Recycle,
  Settings2,
  Sliders,
  Star,
  Sun,
  Thermometer,
  Trash2,
  Trophy,
  Users,
  X,
  Zap,
  Popcorn,
} from "lucide-react";
import {
  framePhoto,
  homePicture,
  useBoard,
  useBoardChange,
  useNews,
  usePhotos,
  type BoardTask,
  type HomeDevice,
} from "../../data/home";
import { daysBetween, scheduleWords, standing, todayIn, WEEKDAYS } from "../../lib/board";
import { CameraTile, Thermostat } from "./Pages";
import { Panel, clockTime, useNow, type Ctx } from "./parts";
import { useQuery } from "@tanstack/react-query";
import type { MovieNight } from "@dragon-control/core";
import { api } from "../../data/api";

/**
 * The widget gallery's widgets (11-05). Each shows only what is real: Home Assistant's own
 * readings, or the household board Hearth keeps. When there is nothing yet, a widget says what
 * would fill it, and how, instead of showing made-up data.
 */

/* ------------------------------------------------ helpers ------------------------------------------------ */

const ago = (iso: string | undefined, now: Date) => {
  if (!iso) return "";
  const mins = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

/** A button to set a widget up (on its options), shown on an empty widget. */
function SetUp({ c, label }: { c: Ctx; label: string }) {
  return (
    <button type="button" className="hd-chip" onClick={() => c.configure?.()}>
      <Settings2 aria-hidden style={{ width: 16, height: 16 }} /> {label}
    </button>
  );
}

const ON_WORDS: Record<string, [string, string]> = {
  door: ["Open", "Closed"],
  garage_door: ["Open", "Closed"],
  window: ["Open", "Closed"],
  opening: ["Open", "Closed"],
  motion: ["Motion", "Clear"],
  occupancy: ["Occupied", "Clear"],
  presence: ["Home", "Away"],
  moisture: ["Wet", "Dry"],
  smoke: ["Smoke!", "Clear"],
  gas: ["Gas!", "Clear"],
  problem: ["Problem", "OK"],
  battery: ["Low", "OK"],
  connectivity: ["Connected", "Offline"],
  plug: ["Plugged in", "Unplugged"],
  power: ["On", "Off"],
};

/** A device's reading in words: "21.3 °C", "Open", "On". */
export function deviceValue(x: HomeDevice) {
  if (x.state === "unavailable" || x.state === "unknown") return "Not answering";
  if (x.kind === "binary_sensor") {
    const w = ON_WORDS[x.deviceClass ?? ""] ?? ["On", "Off"];
    return x.state === "on" ? w[0] : w[1];
  }
  if (x.kind === "cover") return x.state[0]!.toUpperCase() + x.state.slice(1);
  if (["light", "switch", "fan", "input_boolean"].includes(x.kind))
    return x.state === "on" ? "On" : "Off";
  const n = Number(x.state);
  if (Number.isFinite(n)) {
    const shown = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
    return `${shown}${x.unit ? (x.unit === "%" || x.unit.startsWith("°") ? x.unit : ` ${x.unit}`) : ""}`;
  }
  return x.state;
}

const deviceIcon = (x: HomeDevice) => {
  const dc = x.deviceClass ?? "";
  if (dc === "temperature") return Thermometer;
  if (dc === "humidity" || dc === "moisture") return Droplets;
  if (dc === "power" || dc === "energy") return Zap;
  if (["door", "window", "opening", "garage_door"].includes(dc)) return DoorOpen;
  if (x.kind === "light") return Sun;
  if (x.toggle) return Power;
  return Gauge;
};

/* ------------------------------------------------ Home Assistant widgets ------------------------------------------------ */

export function DevicesWidget({ c }: { c: Ctx }) {
  const { d, prefs, tap, busy } = c;
  // In the order chosen; anything Home Assistant no longer has is left out.
  const list = prefs.devices
    .map((e) => d.devices.find((x) => x.entity === e))
    .filter((x): x is HomeDevice => Boolean(x));
  return (
    <Panel
      title="Devices and Sensors"
      icon={<Sliders />}
      testId="home-devices"
      action={
        c.configure && list.length ? (
          <button type="button" className="hd-chip" onClick={c.configure}>
            Choose
          </button>
        ) : undefined
      }
    >
      {!prefs.devices.length ? (
        <>
          <p className="hd-empty">Pick any switches, fans, plugs or sensors to keep here.</p>
          <SetUp c={c} label="Choose devices" />
        </>
      ) : (
        <ul className="hd-devs">
          {list.map((x) => {
            const Icon = deviceIcon(x);
            const on = x.state === "on";
            return (
              <li key={x.entity} data-testid="home-device">
                <Icon aria-hidden className={on ? "hd-lit" : undefined} />
                <span className="hd-dev-n">
                  {x.name}
                  {x.room && <small>{x.room}</small>}
                </span>
                {x.toggle ? (
                  <button
                    type="button"
                    className="hd-pill"
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => tap({ entity: x.entity, action: "toggle" })}
                  >
                    {on ? "On" : "Off"}
                  </button>
                ) : (
                  <b>{deviceValue(x)}</b>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function ClimateWidget({ c }: { c: Ctx }) {
  const t = c.d.climate[0];
  if (!t)
    return (
      <Panel title="Thermostat" icon={<Thermometer />} testId="home-climate">
        <p className="hd-empty">
          No thermostat in Home Assistant. A smart thermostat (Nest, Ecobee, Honeywell and others)
          shows here once it is added in Home Assistant.
        </p>
      </Panel>
    );
  return <Thermostat key={`${t.entity}-${t.target}`} c={c} t={t} />;
}

export function CamerasWidget({ c }: { c: Ctx }) {
  const cams = c.d.cameras;
  return (
    <Panel title="Cameras" icon={<Camera />} testId="home-cameras-widget">
      {!cams.length ? (
        <p className="hd-empty">No cameras in Home Assistant yet.</p>
      ) : (
        <button
          type="button"
          className="hd-cams"
          onClick={() => c.go("security")}
          aria-label="Open the cameras"
          style={{ display: "grid", textAlign: "left" }}
        >
          {cams.slice(0, 4).map((x) => (
            <CameraTile key={x.entity} c={c} entity={x.entity} name={x.name} />
          ))}
        </button>
      )}
    </Panel>
  );
}

const PLACE: Record<string, string> = { home: "Home", not_home: "Away", unknown: "Unknown" };

export function PeopleWidget({ c }: { c: Ctx }) {
  const now = useNow();
  const { d } = c;
  return (
    <Panel title="Who's Home" icon={<Users />} testId="home-people">
      {!d.people.length ? (
        <p className="hd-empty">
          No people in Home Assistant. Add each person there (Settings, People) with their phone's
          Home Assistant app, and they show here.
        </p>
      ) : (
        <ul className="hd-people">
          {d.people.map((p) => {
            const home = p.state === "home";
            return (
              <li key={p.entity} className={home ? "hd-home" : undefined}>
                <span className="hd-face">
                  {p.picture ? (
                    <img src={homePicture(p.entity, d.serviceId)} alt="" />
                  ) : (
                    p.name.slice(0, 1)
                  )}
                </span>
                <span>
                  <b>{p.name}</b>
                  <small>
                    {PLACE[p.state] ?? p.state}
                    {p.since ? ` · ${ago(p.since, now)}` : ""}
                  </small>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function DoorbellWidget({ c }: { c: Ctx }) {
  const now = useNow();
  const bell = c.d.doorbells[0];
  return (
    <Panel title="Doorbell" icon={<BellRing />} testId="home-doorbell">
      {!bell ? (
        <p className="hd-empty">
          No doorbell in Home Assistant. A video doorbell (Ring, Nest, Reolink, UniFi and others)
          shows here once it is added there.
        </p>
      ) : (
        <>
          <p className="hd-empty">
            {bell.name}: {bell.last ? `rang ${ago(bell.last, now)}` : "no ring yet"}
          </p>
          {bell.camera && <CameraTile c={c} entity={bell.camera} name={bell.name} />}
        </>
      )}
    </Panel>
  );
}

export function EnergyWidget({ c }: { c: Ctx }) {
  const e = c.d.energy;
  const kw = (w: number) => (Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${w} W`);
  return (
    <Panel title="Energy" icon={<Zap />} testId="home-energy">
      {!e ? (
        <p className="hd-empty">
          Set up Home Assistant's Energy dashboard (Settings, Dashboards, Energy) with your meter or
          smart plugs, and today's use shows here.
        </p>
      ) : (
        <>
          {e.powerNow !== undefined && (
            <p className="hd-stat">
              <b>{kw(e.powerNow)}</b> <span>right now</span>
            </p>
          )}
          <div className="hd-facts2">
            {e.grid !== undefined && (
              <span>
                <Zap aria-hidden /> {e.grid} kWh used today
              </span>
            )}
            {e.solar !== undefined && (
              <span>
                <Sun aria-hidden /> {e.solar} kWh from solar
              </span>
            )}
            {e.returned !== undefined && (
              <span>
                <Power aria-hidden /> {e.returned} kWh sent back
              </span>
            )}
            {e.gas !== undefined && (
              <span>
                <Flame aria-hidden /> {e.gas} {e.gasUnit ?? ""} gas
              </span>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

export function TravelWidget({ c }: { c: Ctx }) {
  const { d } = c;
  return (
    <Panel title="Commute" icon={<Car />} testId="home-travel">
      {!d.travel.length ? (
        <>
          <p className="hd-empty">
            Drive times come from Home Assistant's Waze or Google Maps travel time. Add one for each
            trip, like home to work.
          </p>
          {!d.tablet && (
            <button type="button" className="hd-chip" onClick={() => c.connect("travel")}>
              <Plus aria-hidden style={{ width: 16, height: 16 }} /> Add a trip with Waze
            </button>
          )}
        </>
      ) : (
        <ul className="hd-trips">
          {d.travel.map((t) => (
            <li key={t.entity}>
              <b>{t.minutes !== undefined ? `${t.minutes} min` : "–"}</b>
              <span>
                {t.destination ? `to ${t.destination}` : t.name}
                {t.route && <small>via {t.route}</small>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function SportsWidget({ c }: { c: Ctx }) {
  const { d, prefs } = c;
  const cycle = prefs.clock === "24" ? "24" : "12";
  return (
    <Panel title="Scores" icon={<Trophy />} testId="home-sports">
      {!d.sports.length ? (
        <p className="hd-empty">
          Follow a team with Home Assistant's TeamTracker (installed through HACS). Its games and
          scores show here.
        </p>
      ) : (
        <ul className="hd-scores">
          {d.sports.slice(0, 4).map((g) => (
            <li key={g.entity}>
              <small>{g.league ?? g.name}</small>
              <span>
                <b>{g.team ?? g.name}</b> {g.teamScore ?? ""}
              </span>
              <span>
                <b>{g.opponent ?? ""}</b> {g.opponentScore ?? ""}
              </span>
              <small>
                {g.state === "IN"
                  ? `Live${g.clock ? ` · ${g.clock}` : ""}`
                  : g.state === "POST"
                    ? "Final"
                    : g.state === "PRE" && g.date
                      ? `${new Date(g.date).toLocaleDateString([], { weekday: "short" })} ${clockTime(g.date, d.place.timeZone, cycle)}`
                      : g.state === "BYE"
                        ? "No game this week"
                        : ""}
              </small>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function PlantsWidget({ c }: { c: Ctx }) {
  const { d } = c;
  return (
    <Panel title="Plants" icon={<Leaf />} testId="home-plants">
      {!d.plants.length ? (
        <p className="hd-empty">
          Plant sensors (Xiaomi Mi Flora and others) show here once they are in Home Assistant.
        </p>
      ) : (
        <ul className="hd-devs">
          {d.plants.map((p) => {
            const thirsty = Boolean(p.problem) || p.state === "problem";
            return (
              <li key={p.entity}>
                <Leaf aria-hidden className={thirsty ? "hd-warn-ic" : "hd-ok-ic"} />
                <span className="hd-dev-n">
                  {p.name}
                  {p.problem && <small>{p.problem[0]!.toUpperCase() + p.problem.slice(1)}</small>}
                </span>
                <b>
                  {p.moisture !== undefined
                    ? `${Math.round(p.moisture)}%`
                    : thirsty
                      ? "Needs care"
                      : "OK"}
                </b>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The next movie night (11-12): what, when, and who's coming, from Hearth's Movie nights. Read
 * only: planning and changing a night happen in the Movie nights panel.
 */
export function MovieNightWidget() {
  const q = useQuery({
    queryKey: ["movie-nights"],
    queryFn: () => api<{ nights: MovieNight[] }>("GET", "/api/movie-nights"),
    refetchInterval: 60_000,
  });
  const now = useNow().getTime();
  const next = (q.data?.nights ?? [])
    .filter((n) => n.status === "scheduled" && Date.parse(n.startsAt) > now - 3 * 3600_000)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const when = next
    ? new Date(next.startsAt).toLocaleString(undefined, {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
        ...(Date.parse(next.startsAt) - now > 6 * 86400_000
          ? { month: "short", day: "numeric" }
          : {}),
      })
    : "";
  return (
    <Panel title="Movie Night" icon={<Popcorn />} testId="home-movienight">
      {!next ? (
        <p className="hd-empty">
          {q.isError
            ? "Movie nights could not be read just now."
            : "No movie night planned. Plan one in Hearth's Movie nights panel."}
        </p>
      ) : (
        <div className="space-y-1.5" data-testid="home-movienight-next">
          <p className="text-[1.15rem] font-semibold">{next.title}</p>
          <p className="text-[0.95rem] opacity-85">{when}</p>
          <p className="text-[0.9rem] opacity-75">
            {next.guests.length
              ? `Coming: ${next.guests.join(", ")}`
              : "Nobody has said they're coming yet"}
            {next.spots ? ` · ${Math.max(0, next.spots - next.guests.length)} spots left` : ""}
          </p>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------ Hearth's household board ------------------------------------------------ */

/** Weekday pills or "every n days", for a new chore or reminder. */
function ScheduleInput({
  value,
  onChange,
}: {
  value: BoardTask["schedule"];
  onChange: (s: BoardTask["schedule"]) => void;
}) {
  return (
    <div className="hd-row" role="group" aria-label="When">
      {WEEKDAYS.map((w, i) => (
        <button
          key={w}
          type="button"
          className="hd-pill hd-sm"
          aria-pressed={value.type === "week" && Boolean(value.days?.includes(i))}
          onClick={() => {
            const days = value.type === "week" ? (value.days ?? []) : [];
            const next = days.includes(i) ? days.filter((x) => x !== i) : [...days, i];
            onChange({ type: "week", days: next.sort() });
          }}
        >
          {w}
        </button>
      ))}
      <button
        type="button"
        className="hd-pill hd-sm"
        aria-pressed={value.type === "every" && value.n === 1}
        onClick={() => onChange({ type: "every", n: 1 })}
      >
        Daily
      </button>
    </div>
  );
}

function TaskList({ c, kind }: { c: Ctx; kind: "chore" | "reminder" }) {
  const board = useBoard();
  const change = useBoardChange();
  const today = todayIn(c.d.place.timeZone);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [who, setWho] = useState("");
  const [stars, setStars] = useState(1);
  const [schedule, setSchedule] = useState<BoardTask["schedule"]>({ type: "every", n: 1 });
  const tasks = (board.data?.tasks ?? [])
    .filter((t) => t.kind === kind)
    .map((t) => ({
      t,
      s: standing(t, today, t.added ? todayIn(c.d.place.timeZone, new Date(t.added)) : undefined),
    }))
    // What needs doing first, then what is done, then what is coming up.
    .sort(
      (a, b) =>
        ["late", "due", "done", "later"].indexOf(a.s.state) -
          ["late", "due", "done", "later"].indexOf(b.s.state) ||
        (a.s.next ?? "").localeCompare(b.s.next ?? ""),
    );
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (schedule.type === "week" && !schedule.days?.length) return;
    change.mutate(
      {
        op: "task.add",
        kind,
        title: title.trim(),
        ...(who.trim() ? { who: who.trim() } : {}),
        ...(kind === "chore" ? { stars } : {}),
        schedule: schedule.type === "every" ? { ...schedule, start: today } : schedule,
      },
      {
        onSuccess: () => {
          setTitle("");
          setAdding(false);
        },
      },
    );
  };
  const words = (s: ReturnType<typeof standing>) =>
    s.state === "done"
      ? "Done today"
      : s.state === "due"
        ? "Today"
        : s.state === "late"
          ? "Late"
          : s.next
            ? daysBetween(today, s.next) === 1
              ? "Tomorrow"
              : new Date(`${s.next}T12:00:00`).toLocaleDateString([], { weekday: "long" })
            : "";
  return (
    <>
      {kind === "chore" && board.data && Object.keys(board.data.stars).length > 0 && (
        <div className="hd-row" aria-label="Stars">
          {Object.entries(board.data.stars).map(([p, n]) => (
            <span key={p} className="hd-star" data-testid="home-stars">
              <Star aria-hidden /> {p} {n}
            </span>
          ))}
        </div>
      )}
      {kind === "reminder" &&
        c.d.waste.map((w) => (
          <p key={w.entity} className="hd-due">
            <Recycle aria-hidden /> {w.state}
          </p>
        ))}
      {!tasks.length && !adding && (
        <p className="hd-empty">
          {kind === "chore"
            ? "Add chores that repeat, like the dishes on weekdays. Whoever ticks one off gets its stars."
            : "Add things that repeat, like bins out on Tuesdays or watering the plants."}
        </p>
      )}
      <ul className="hd-items">
        {tasks.map(({ t, s }) => (
          <li key={t.id} className={`hd-item${s.state === "done" ? " hd-done" : ""}`}>
            <button
              type="button"
              className="hd-item"
              style={{ border: 0, flex: 1 }}
              disabled={s.state === "later" || change.isPending}
              aria-label={`${s.state === "done" ? "Not done" : "Done"}: ${t.title}`}
              onClick={() =>
                change.mutate({
                  op: s.state === "done" ? "task.undo" : "task.done",
                  id: t.id,
                  on: today,
                })
              }
            >
              <span className={`hd-box${s.state === "done" ? " hd-y" : ""}`}>
                {s.state === "done" && <Check />}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {t.title}
                <small className="hd-sub">
                  {[t.who, scheduleWords(t.schedule), t.stars ? `${t.stars}★` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <span className={`hd-when hd-${s.state}`}>{words(s)}</span>
            </button>
            {c.editing && (
              <button
                type="button"
                className="hd-icon"
                aria-label={`Remove ${t.title}`}
                onClick={() => change.mutate({ op: "task.remove", id: t.id })}
              >
                <Trash2 />
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form className="hd-form" onSubmit={add}>
          <input
            aria-label={kind === "chore" ? "Chore" : "Reminder"}
            placeholder={kind === "chore" ? "Empty the dishwasher" : "Bins out"}
            value={title}
            maxLength={80}
            onChange={(e) => setTitle(e.target.value)}
          />
          {kind === "chore" && (
            <div className="hd-row">
              <input
                aria-label="Whose"
                placeholder="Whose (a name)"
                value={who}
                maxLength={40}
                onChange={(e) => setWho(e.target.value)}
              />
              <label className="hd-row" style={{ gap: 6 }}>
                Stars
                <select value={stars} onChange={(e) => setStars(Number(e.target.value))}>
                  {[0, 1, 2, 3, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <ScheduleInput value={schedule} onChange={setSchedule} />
          <div className="hd-row">
            <button type="submit" className="hd-pill hd-on" disabled={change.isPending}>
              Add
            </button>
            <button type="button" className="hd-chip" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="hd-chip" onClick={() => setAdding(true)}>
          <Plus aria-hidden style={{ width: 16, height: 16 }} />{" "}
          {kind === "chore" ? "Add a chore" : "Add a reminder"}
        </button>
      )}
      {change.error && <p className="hd-empty">{change.error.message}</p>}
    </>
  );
}

export function ChoresWidget({ c }: { c: Ctx }) {
  return (
    <Panel title="Chores and Stars" icon={<ListChecks />} testId="home-chores">
      <TaskList c={c} kind="chore" />
    </Panel>
  );
}

export function RemindersWidget({ c }: { c: Ctx }) {
  return (
    <Panel title="Reminders" icon={<Bell />} testId="home-reminders">
      <TaskList c={c} kind="reminder" />
    </Panel>
  );
}

export function CountdownWidget({ c }: { c: Ctx }) {
  const board = useBoard();
  const change = useBoardChange();
  const today = todayIn(c.d.place.timeZone);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const list = (board.data?.countdowns ?? []).filter((x) => daysBetween(today, x.date) >= 0);
  return (
    <Panel title="Countdowns" icon={<CalendarClock />} testId="home-countdown">
      {!list.length && !adding && (
        <p className="hd-empty">Count down to a holiday, a birthday or a trip.</p>
      )}
      <ul className="hd-counts">
        {list.map((x) => {
          const n = daysBetween(today, x.date);
          return (
            <li key={x.id}>
              <b>{n === 0 ? "Today" : n}</b>
              <span>
                {n === 0 ? "" : n === 1 ? "day until " : "days until "}
                {x.title}
              </span>
              {c.editing && (
                <button
                  type="button"
                  className="hd-icon"
                  aria-label={`Remove ${x.title}`}
                  onClick={() => change.mutate({ op: "countdown.remove", id: x.id })}
                >
                  <X />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {adding ? (
        <form
          className="hd-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !date) return;
            change.mutate(
              { op: "countdown.add", title: title.trim(), date },
              {
                onSuccess: () => {
                  setTitle("");
                  setDate("");
                  setAdding(false);
                },
              },
            );
          }}
        >
          <input
            aria-label="What"
            placeholder="Summer vacation"
            value={title}
            maxLength={60}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            aria-label="Date"
            type="date"
            value={date}
            min={today}
            onChange={(e) => setDate(e.target.value)}
          />
          <div className="hd-row">
            <button type="submit" className="hd-pill hd-on">
              Add
            </button>
            <button type="button" className="hd-chip" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="hd-chip" onClick={() => setAdding(true)}>
          <Plus aria-hidden style={{ width: 16, height: 16 }} /> Add a countdown
        </button>
      )}
    </Panel>
  );
}

export function NotesWidget(_props: { c: Ctx }) {
  const now = useNow();
  const board = useBoard();
  const change = useBoardChange();
  const [text, setText] = useState("");
  const notes = board.data?.notes ?? [];
  return (
    <Panel title="Message Board" icon={<MessageSquareText />} testId="home-notes">
      {!notes.length && <p className="hd-empty">Leave a note for the family.</p>}
      <ul className="hd-notes">
        {notes.map((n) => (
          <li key={n.id} data-testid="home-note-item">
            <span>{n.text}</span>
            <small>
              {n.by ? `${n.by} · ` : ""}
              {ago(n.at, now)}
            </small>
            <button
              type="button"
              className="hd-icon"
              aria-label={`Remove the note: ${n.text}`}
              onClick={() => change.mutate({ op: "note.remove", id: n.id })}
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
          if (!text.trim()) return;
          change.mutate({ op: "note.add", text: text.trim() }, { onSuccess: () => setText("") });
        }}
      >
        <input
          aria-label="New note"
          placeholder="Write a note"
          value={text}
          maxLength={280}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="hd-pill" aria-label="Post the note">
          <Plus aria-hidden />
        </button>
      </form>
    </Panel>
  );
}

export function NewsWidget({ c }: { c: Ctx }) {
  const board = useBoard();
  const has = Boolean(board.data?.feeds.length);
  const news = useNews(has);
  const now = useNow();
  return (
    <Panel
      title="News"
      icon={<Newspaper />}
      testId="home-news"
      action={
        has && c.configure && !c.d.tablet ? (
          <button type="button" className="hd-chip" onClick={c.configure}>
            Feeds
          </button>
        ) : undefined
      }
    >
      {!has ? (
        <>
          <p className="hd-empty">
            {c.d.tablet
              ? "No news feeds yet. Choose them from Hearth, in the Home Assistant panel's Home tab."
              : "Choose news feeds (RSS or Atom links, from your newspaper or any site) to show their headlines here."}
          </p>
          {!c.d.tablet && <SetUp c={c} label="Choose feeds" />}
        </>
      ) : (
        <ul className="hd-news">
          {(news.data?.items ?? []).slice(0, 8).map((h, i) => (
            <li key={`${h.title}-${i}`} data-testid="home-headline">
              <span>{h.title}</span>
              <small>
                {h.source}
                {h.at ? ` · ${ago(h.at, now)}` : ""}
              </small>
            </li>
          ))}
          {news.data && !news.data.items.length && (
            <li className="hd-empty">
              {news.data.problems.length
                ? `Could not read ${news.data.problems.join("; ")}`
                : "No headlines right now."}
            </li>
          )}
        </ul>
      )}
    </Panel>
  );
}

/** The photo frame's slideshow: a photo every 15 seconds, fading across. */
export function Slideshow({ photos, every = 15_000 }: { photos: string[]; every?: number }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (photos.length < 2) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % photos.length), every);
    return () => window.clearInterval(t);
  }, [photos.length, every]);
  const shown = useMemo(() => photos[i % Math.max(1, photos.length)], [photos, i]);
  if (!shown) return null;
  return (
    <div className="hd-frame-pic">
      <img key={shown} src={framePhoto(shown)} alt="A photo from Immich" />
    </div>
  );
}

export function PhotosWidget({ c }: { c: Ctx }) {
  const photos = usePhotos(true);
  const board = useBoard();
  const p = photos.data;
  return (
    <Panel
      title={board.data?.photos?.albumName ?? "Photo Frame"}
      icon={<ImageIcon />}
      testId="home-photos"
      className="hd-w-photo"
      action={
        p?.connected && c.configure && !c.d.tablet ? (
          <button type="button" className="hd-chip" onClick={c.configure}>
            Album
          </button>
        ) : undefined
      }
    >
      {photos.isLoading ? (
        <p className="hd-empty">Finding photos…</p>
      ) : !p?.connected ? (
        <p className="hd-empty">
          The photo frame shows your own photos from Immich. Add Immich to Hearth, with its key, and
          they show here.
        </p>
      ) : !p.photos.length ? (
        <p className="hd-empty">No photos in {board.data?.photos?.albumName ?? "Immich"} yet.</p>
      ) : (
        <Slideshow photos={p.photos} />
      )}
    </Panel>
  );
}
