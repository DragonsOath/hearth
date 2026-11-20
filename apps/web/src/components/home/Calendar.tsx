import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  Repeat,
  Trash2,
} from "lucide-react";
import {
  useCalendar,
  useCalendarChange,
  type CalendarEvent,
  type CalendarInfo,
} from "../../data/home";
import { Modal } from "../workspace/dialogs";
import { useCaveMaybe } from "../shell/cave-context";
import { Panel, clockTime, type Ctx } from "./parts";

/**
 * The calendar (11-05: "I should be able to see it in a month", "click on it, edit it",
 * "if I do it should change on the Google calendar", "have the little calendar inside of
 * here"). Month (the default), week and list views of every calendar, each in its own colour
 * with a switch to hide it; a day opens its events; an event opens to view, change or delete;
 * new events go to the calendar you pick. Changes are written to the calendar's own service
 * through Home Assistant.
 */

const COLORS = [
  "#ff8a3d",
  "#5bb6ff",
  "#7ee08a",
  "#c792ff",
  "#ffd166",
  "#ff6b9a",
  "#4fd1c5",
  "#a3b1ff",
];
export const DAY_KEY = "hd-calendar-day";

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
/** The local day an event starts on (all-day events are dates, not times). */
const startKey = (e: CalendarEvent) => (e.allDay ? e.start.slice(0, 10) : keyOf(new Date(e.start)));
/** Every local day an event covers (all-day end dates are exclusive). */
function daysOf(e: CalendarEvent): string[] {
  const first = fromKey(startKey(e));
  let last = first;
  if (e.end) {
    last = e.allDay ? fromKey(e.end.slice(0, 10)) : new Date(e.end);
    if (e.allDay) last.setDate(last.getDate() - 1);
    else if (last.getHours() === 0 && last.getMinutes() === 0) last.setMinutes(-1);
  }
  const out: string[] = [];
  const d = new Date(first);
  for (let i = 0; i < 62 && keyOf(d) <= keyOf(last); i++) {
    out.push(keyOf(d));
    d.setDate(d.getDate() + 1);
  }
  return out.length ? out : [keyOf(first)];
}

function monthGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function useEventsByDay(events: CalendarEvent[]) {
  return useMemo(() => {
    const by = new Map<string, CalendarEvent[]>();
    for (const e of events) for (const k of daysOf(e)) by.set(k, [...(by.get(k) ?? []), e]);
    for (const list of by.values())
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    return by;
  }, [events]);
}

/* ------------------------------------------------ the event window ------------------------------------------------ */

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${keyOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function EventWindow({
  c,
  calendars,
  event,
  day,
  color,
  onClose,
}: {
  c: Ctx;
  calendars: CalendarInfo[];
  event?: CalendarEvent;
  day?: string;
  color: (entity: string) => string;
  onClose: () => void;
}) {
  const change = useCalendarChange(c.d.serviceId);
  const writable = calendars.filter((x) => x.can.create);
  const cal = calendars.find((x) => x.entity === event?.entity);
  const canEdit = !event || Boolean(cal && (cal.can.update || (cal.can.create && cal.can.delete)));
  const [editing, setEditing] = useState(!event);
  const startDay = day ?? keyOf(new Date());
  const [f, setF] = useState(() => {
    if (event) {
      const endDay = event.end
        ? event.allDay
          ? (() => {
              const d = fromKey(event.end.slice(0, 10));
              d.setDate(d.getDate() - 1);
              return keyOf(d);
            })()
          : event.end
        : event.start;
      return {
        entity: event.entity,
        title: event.title,
        allDay: event.allDay,
        start: event.allDay ? event.start.slice(0, 10) : toLocalInput(event.start),
        end: event.allDay ? endDay.slice(0, 10) : toLocalInput(event.end ?? event.start),
        location: event.location ?? "",
        description: event.description ?? "",
      };
    }
    return {
      entity: writable[0]?.entity ?? "",
      title: "",
      allDay: false,
      start: `${startDay}T09:00`,
      end: `${startDay}T10:00`,
      location: "",
      description: "",
    };
  });
  const [err, setErr] = useState<string>();
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  const save = () => {
    setErr(undefined);
    // All-day: the day after the last day (that is how calendars store it); timed: with the zone.
    const endDay = (k: string) => {
      const d = fromKey(k);
      d.setDate(d.getDate() + 1);
      return keyOf(d);
    };
    const body = {
      entity: f.entity,
      title: f.title.trim() || "New event",
      allDay: f.allDay,
      start: f.allDay ? f.start.slice(0, 10) : new Date(f.start).toISOString(),
      end: f.allDay ? endDay(f.end.slice(0, 10)) : new Date(f.end).toISOString(),
      ...(f.location.trim() ? { location: f.location } : {}),
      ...(f.description.trim() ? { description: f.description } : {}),
    };
    change.mutate(
      event?.uid
        ? {
            action: "change",
            uid: event.uid,
            ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
            ...body,
          }
        : { action: "add", ...body },
      { onSuccess: onClose, onError: (e) => setErr(e.message) },
    );
  };
  const remove = () => {
    if (!event?.uid) return;
    setErr(undefined);
    change.mutate(
      {
        action: "delete",
        entity: event.entity,
        uid: event.uid,
        ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
        title: event.title,
      },
      { onSuccess: onClose, onError: (e) => setErr(e.message) },
    );
  };
  const tz = c.d.place.timeZone;
  const cycle = c.prefs.clock === "24" ? "24" : "12";
  const field =
    "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";

  return (
    <Modal
      title={event ? (editing ? "Change event" : event.title) : "New event"}
      onCancel={onClose}
    >
      <div className="mt-3 space-y-3" data-testid="home-event-window">
        {err && (
          <p className="text-[0.88rem] text-amber" role="alert">
            {err}
          </p>
        )}
        {event && !editing ? (
          <>
            <p className="flex items-center gap-2 text-[0.9rem] text-ink">
              <span className="hd-cal-swatch" style={{ background: color(event.entity) }} />
              {event.calendar}
            </p>
            <p className="text-[0.95rem] text-ink">
              {new Date(
                event.allDay ? `${event.start.slice(0, 10)}T12:00:00` : event.start,
              ).toLocaleDateString([], {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
              {event.allDay
                ? " · All day"
                : ` · ${clockTime(event.start, tz, cycle)}${event.end ? ` to ${clockTime(event.end, tz, cycle)}` : ""}`}
            </p>
            {event.repeats && (
              <p className="flex items-center gap-2 text-[0.84rem] text-muted">
                <Repeat size={14} /> Repeats. Changes here change this one only.
              </p>
            )}
            {event.location && (
              <p className="flex items-center gap-2 text-[0.88rem] text-muted">
                <MapPin size={14} /> {event.location}
              </p>
            )}
            {event.description && (
              <p className="text-[0.88rem] whitespace-pre-wrap text-muted">{event.description}</p>
            )}
            {canEdit && event.uid ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  className="hd-pill"
                  onClick={() => setEditing(true)}
                  data-testid="home-event-edit"
                >
                  Change
                </button>
                {cal?.can.delete && (
                  <button
                    type="button"
                    className="hd-pill"
                    disabled={change.isPending}
                    onClick={remove}
                    data-testid="home-event-delete"
                  >
                    <Trash2 size={16} /> Delete
                  </button>
                )}
              </div>
            ) : (
              <p className="text-[0.8rem] text-faint">
                This calendar is read-only here (a subscribed or holiday calendar).
              </p>
            )}
          </>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="block text-[0.84rem] text-muted">
              Title
              <input
                className={field}
                value={f.title}
                onChange={(e) => set("title", e.target.value)}
                autoFocus
                data-testid="home-event-title"
              />
            </label>
            {!event && (
              <label className="block text-[0.84rem] text-muted">
                Calendar
                <select
                  className={field}
                  value={f.entity}
                  onChange={(e) => set("entity", e.target.value)}
                >
                  {writable.map((x) => (
                    <option key={x.entity} value={x.entity}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex min-h-11 items-center gap-2 text-[0.88rem] text-ink">
              <input
                type="checkbox"
                checked={f.allDay}
                onChange={(e) => {
                  const all = e.target.checked;
                  setF((x) => ({
                    ...x,
                    allDay: all,
                    start: all ? x.start.slice(0, 10) : `${x.start.slice(0, 10)}T09:00`,
                    end: all ? x.end.slice(0, 10) : `${x.end.slice(0, 10)}T10:00`,
                  }));
                }}
              />
              All day
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[0.84rem] text-muted">
                Starts
                <input
                  className={field}
                  type={f.allDay ? "date" : "datetime-local"}
                  value={f.start}
                  onChange={(e) => set("start", e.target.value)}
                  required
                />
              </label>
              <label className="block text-[0.84rem] text-muted">
                Ends
                <input
                  className={field}
                  type={f.allDay ? "date" : "datetime-local"}
                  value={f.end}
                  onChange={(e) => set("end", e.target.value)}
                  required
                />
              </label>
            </div>
            <label className="block text-[0.84rem] text-muted">
              Where (optional)
              <input
                className={field}
                value={f.location}
                onChange={(e) => set("location", e.target.value)}
              />
            </label>
            <label className="block text-[0.84rem] text-muted">
              Notes (optional)
              <textarea
                className={`${field} min-h-20 py-2`}
                value={f.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className="hd-pill"
                aria-pressed
                disabled={change.isPending || !f.entity}
                data-testid="home-event-save"
              >
                {change.isPending ? "Saving..." : "Save"}
              </button>
              {event && (
                <button type="button" className="hd-pill" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              )}
            </div>
            {!writable.length && !event && (
              <p className="text-[0.8rem] text-amber">
                None of your calendars accepts new events from here.
              </p>
            )}
          </form>
        )}
      </div>
    </Modal>
  );
}

/** One event in a day of the month or week (a component of its own, so it survives a refresh mid-click). */
function Chip({
  e,
  color,
  time,
  onOpen,
}: {
  e: CalendarEvent;
  color: string;
  time?: string;
  onOpen: (e: CalendarEvent) => void;
}) {
  return (
    <button
      type="button"
      className="hd-cal-chip"
      style={{ ["--c" as string]: color }}
      onClick={(ev) => {
        ev.stopPropagation();
        onOpen(e);
      }}
      title={e.title}
      data-testid="home-cal-event"
    >
      {time && <span className="hd-cal-time">{time}</span>}
      {e.title}
    </button>
  );
}

/* ------------------------------------------------ the calendar page ------------------------------------------------ */

type View = "month" | "week" | "list";

export function CalendarPage({ c }: { c: Ctx }) {
  const [view, setView] = useState<View>("month");
  const [anchor, setAnchor] = useState(() => {
    let k: string | null;
    try {
      k = sessionStorage.getItem(DAY_KEY);
      sessionStorage.removeItem(DAY_KEY);
    } catch {
      k = null;
    }
    return k ? fromKey(k) : new Date();
  });
  const [picked, setPicked] = useState<string>(() => keyOf(anchor));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<{ event?: CalendarEvent; day?: string }>();

  // The range on screen: the six weeks of the month grid, or the week.
  const range = useMemo(() => {
    if (view === "week") {
      const s = new Date(anchor);
      s.setDate(anchor.getDate() - anchor.getDay());
      s.setHours(0, 0, 0, 0);
      const e = new Date(s);
      e.setDate(s.getDate() + 7);
      return { start: s, end: e };
    }
    const grid = monthGrid(anchor);
    const e = new Date(grid[41]!);
    e.setDate(e.getDate() + 1);
    return { start: grid[0]!, end: e };
  }, [anchor, view]);
  const q = useCalendar(c.d.serviceId, range.start.toISOString(), range.end.toISOString());
  const calendars =
    q.data?.calendars ??
    c.d.calendars.map((x) => ({ ...x, can: { create: false, delete: false, update: false } }));
  const colorOf = useMemo(() => {
    const m = new Map(calendars.map((x, i) => [x.entity, COLORS[i % COLORS.length]!]));
    return (entity: string) => m.get(entity) ?? COLORS[0]!;
  }, [calendars]);
  const events = (q.data?.events ?? []).filter((e) => !hidden.has(e.entity));
  const byDay = useEventsByDay(events);
  const today = keyOf(new Date());
  const tz = c.d.place.timeZone;
  const cycle = c.prefs.clock === "24" ? "24" : "12";

  const step = (n: number) => {
    const d = new Date(anchor);
    if (view === "week") d.setDate(d.getDate() + 7 * n);
    else d.setMonth(d.getMonth() + n, 1);
    setAnchor(d);
  };
  const title =
    view === "week"
      ? `Week of ${range.start.toLocaleDateString([], { month: "long", day: "numeric" })}`
      : anchor.toLocaleDateString([], { month: "long", year: "numeric" });

  if (!c.d.calendars.length)
    return (
      <Panel title="Calendar" icon={<CalendarDays />} testId="home-agenda">
        <CalendarTrouble c={c} />
        {!c.d.calendarsDown && !c.d.signInAgain?.some((s) => s.for === "calendar") && (
          <p className="hd-empty">No calendars yet.</p>
        )}
        {!c.d.tablet &&
          !c.d.calendarsDown &&
          !c.d.signInAgain?.some((s) => s.for === "calendar") && (
            <button
              type="button"
              className="hd-chip"
              style={{ alignSelf: "flex-start" }}
              onClick={() => c.connect("calendar")}
            >
              <Plus size={16} /> Connect a calendar
            </button>
          )}
      </Panel>
    );

  return (
    <Panel
      title="Calendar"
      icon={<CalendarDays />}
      testId="home-agenda"
      action={
        <button
          type="button"
          className="hd-chip"
          onClick={() => setOpen({ day: picked })}
          data-testid="home-event-new"
        >
          <Plus size={16} /> New event
        </button>
      }
    >
      <div className="hd-cal-bar">
        <div className="hd-row" style={{ flexWrap: "nowrap", gap: 6 }}>
          <button type="button" className="hd-icon" aria-label="Back" onClick={() => step(-1)}>
            <ChevronLeft />
          </button>
          <button type="button" className="hd-icon" aria-label="Next" onClick={() => step(1)}>
            <ChevronRight />
          </button>
          <button
            type="button"
            className="hd-chip"
            onClick={() => {
              setAnchor(new Date());
              setPicked(keyOf(new Date()));
            }}
          >
            Today
          </button>
          <h3 className="hd-cal-title">{title}</h3>
        </div>
        <div className="hd-row" role="tablist" aria-label="View">
          {(["month", "week", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              className="hd-chip"
              aria-selected={view === v}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v[0]!.toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {calendars.length > 1 && (
        <div className="hd-row" aria-label="Calendars">
          {calendars.map((x) => (
            <button
              key={x.entity}
              type="button"
              className="hd-pill hd-cal-toggle"
              aria-pressed={!hidden.has(x.entity)}
              onClick={() =>
                setHidden((h) => {
                  const n = new Set(h);
                  if (n.has(x.entity)) n.delete(x.entity);
                  else n.add(x.entity);
                  return n;
                })
              }
            >
              <span className="hd-cal-swatch" style={{ background: colorOf(x.entity) }} />
              {x.name}
            </button>
          ))}
        </div>
      )}
      {q.error && (
        <p className="hd-empty" role="alert">
          {(q.error as Error).message}
        </p>
      )}
      {view === "month" && (
        <div className="hd-cal-month" role="grid" aria-label={title} data-testid="home-cal-month">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="hd-cal-dow" role="columnheader">
              {d}
            </div>
          ))}
          {monthGrid(anchor).map((d) => {
            const k = keyOf(d);
            const list = byDay.get(k) ?? [];
            return (
              <div
                key={k}
                role="gridcell"
                tabIndex={0}
                className="hd-cal-cell"
                data-out={d.getMonth() !== anchor.getMonth() || undefined}
                data-today={k === today || undefined}
                data-picked={k === picked || undefined}
                onClick={() => setPicked(k)}
                onDoubleClick={() => setOpen({ day: k })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setPicked(k);
                }}
                data-testid="home-cal-day"
                data-day={k}
              >
                <span className="hd-cal-num">{d.getDate()}</span>
                {list.slice(0, 3).map((e, i) => (
                  <Chip
                    key={`${e.uid ?? e.title}-${i}`}
                    e={e}
                    color={colorOf(e.entity)}
                    time={e.allDay ? undefined : clockTime(e.start, tz, cycle)}
                    onOpen={(x) => setOpen({ event: x })}
                  />
                ))}
                {list.length > 3 && <span className="hd-cal-more">+{list.length - 3} more</span>}
              </div>
            );
          })}
        </div>
      )}
      {view === "week" && (
        <div className="hd-cal-week" data-testid="home-cal-week">
          {Array.from({ length: 7 }, (_, i) => {
            const d = new Date(range.start);
            d.setDate(range.start.getDate() + i);
            const k = keyOf(d);
            return (
              <div key={k} className="hd-cal-wday" data-today={k === today || undefined}>
                <button
                  type="button"
                  className="hd-cal-wday-h"
                  onClick={() => setOpen({ day: k })}
                  title="Add an event this day"
                >
                  {d.toLocaleDateString([], { weekday: "short" })} <b>{d.getDate()}</b>
                </button>
                {(byDay.get(k) ?? []).map((e, j) => (
                  <Chip
                    key={`${e.uid ?? e.title}-${j}`}
                    e={e}
                    color={colorOf(e.entity)}
                    time={e.allDay ? undefined : clockTime(e.start, tz, cycle)}
                    onOpen={(x) => setOpen({ event: x })}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
      {(view === "list" || view === "month") && (
        <div data-testid="home-cal-list">
          {(view === "month" ? [picked] : [...byDay.keys()].sort()).map((k) => {
            const list = byDay.get(k) ?? [];
            if (view === "list" && !list.length) return null;
            return (
              <div key={k}>
                <p className="hd-day-h">
                  {k === today
                    ? "Today"
                    : fromKey(k).toLocaleDateString([], {
                        weekday: "long",
                        month: "short",
                        day: "numeric",
                      })}
                  {view === "month" && (
                    <button
                      type="button"
                      className="hd-chip"
                      style={{ marginLeft: 12 }}
                      onClick={() => setOpen({ day: k })}
                    >
                      <Plus size={14} /> Add
                    </button>
                  )}
                </p>
                {!list.length && <p className="hd-empty">Nothing this day.</p>}
                {list.map((e, i) => (
                  <button
                    type="button"
                    className="hd-ev hd-ev-btn"
                    key={`${e.uid ?? e.title}-${i}`}
                    onClick={() => setOpen({ event: e })}
                  >
                    <span className="hd-dot" style={{ background: colorOf(e.entity) }} />
                    <span className="hd-t">
                      {e.allDay ? "All Day" : clockTime(e.start, tz, cycle)}
                    </span>
                    <div>
                      <b>{e.title}</b>
                      {e.location && <span>{e.location}</span>}
                      <small>{e.calendar}</small>
                    </div>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {open && (
        <EventWindow
          c={c}
          calendars={calendars}
          event={open.event}
          day={open.day}
          color={colorOf}
          onClose={() => setOpen(undefined)}
        />
      )}
    </Panel>
  );
}

/* ------------------------------------------------ the little month (Today card) ------------------------------------------------ */

/** A small month with a dot on days that have something; a day opens the calendar there. */
export function MiniMonth({ c }: { c: Ctx }) {
  const now = new Date();
  const grid = monthGrid(now);
  const q = useCalendar(
    c.d.serviceId,
    grid[0]!.toISOString(),
    new Date(grid[41]!.getTime() + 86_400_000).toISOString(),
  );
  const byDay = useEventsByDay(q.data?.events ?? []);
  const today = keyOf(now);
  return (
    <div
      className="hd-minical"
      aria-label={now.toLocaleDateString([], { month: "long", year: "numeric" })}
      data-testid="home-mini-month"
    >
      <p className="hd-minical-title">{now.toLocaleDateString([], { month: "long" })}</p>
      <div className="hd-minical-grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={`${d}${i}`} className="hd-minical-dow">
            {d}
          </span>
        ))}
        {grid.slice(0, grid[35]!.getMonth() !== now.getMonth() ? 35 : 42).map((d) => {
          const k = keyOf(d);
          const n = byDay.get(k)?.length ?? 0;
          return (
            <button
              key={k}
              type="button"
              className="hd-minical-day"
              data-out={d.getMonth() !== now.getMonth() || undefined}
              data-today={k === today || undefined}
              aria-label={`${d.toDateString()}${n ? `, ${n} event${n > 1 ? "s" : ""}` : ""}`}
              onClick={() => {
                try {
                  sessionStorage.setItem(DAY_KEY, k);
                } catch {
                  // no session storage: opens on today
                }
                c.go("household");
              }}
            >
              {d.getDate()}
              {n > 0 && <i />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * When the calendars are set up but can't be read (11-18, the owner's Google Calendar: Google
 * stopped accepting Home Assistant's sign-in, and the card said "No calendars yet"): say what is
 * wrong, sign in again in one step, or hand it to Ember. Nothing when the calendars are fine.
 */
export function CalendarTrouble({ c }: { c: Ctx }) {
  const cave = useCaveMaybe();
  const again = (c.d.signInAgain ?? []).filter((s) => s.for === "calendar");
  const down = c.d.calendarsDown ?? 0;
  if (!again.length && !down) return null;
  const names = again.map((s) => s.label).join(" and ");
  const text = again.length
    ? `${names} needs you to sign in again. Your calendars are still set up; ${
        again.length > 1 ? "they" : "it"
      } stopped accepting the old sign-in.`
    : `Home Assistant has ${down} calendar${down === 1 ? "" : "s"} it can't read right now.`;
  return (
    <div className="hd-trouble" role="status" data-testid="home-calendar-trouble">
      <p className="hd-empty">{text}</p>
      {!c.d.tablet && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {[...again, ...(c.d.calendarsDownFor ?? []).filter((s) => s.for === "calendar")].map(
            (s) => (
              <button
                key={s.handler}
                type="button"
                className="hd-chip"
                onClick={() => c.connect("calendar", s.handler)}
                data-testid="home-calendar-sign-in-again"
                data-hearth-target="home:calendar-sign-in-again"
              >
                Sign in to {s.label} again
              </button>
            ),
          )}
          {c.d.homeAddress && (
            <a
              className="hd-chip"
              href={`${c.d.homeAddress}/config/repairs`}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="home-calendar-open-repairs"
            >
              Open Home Assistant&apos;s repairs
            </a>
          )}
          {cave && (
            <button
              type="button"
              className="hd-chip"
              onClick={() =>
                cave.ask(
                  again.length
                    ? `My calendar in Hearth's Home tab is empty: Home Assistant says ${names} needs a sign-in again. Help me get it back. Start with Hearth's help on a calendar that stopped.`
                    : `My calendar in Hearth's Home tab is empty: Home Assistant has ${down} calendar${down === 1 ? "" : "s"} it can't read. Find out why and fix it. Start with Hearth's help on a calendar that stopped.`,
                )
              }
              data-testid="home-calendar-ask-ember"
            >
              Ask Ember to fix it
            </button>
          )}
        </div>
      )}
    </div>
  );
}
