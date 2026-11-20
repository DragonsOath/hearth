/**
 * The owner's standing rules for the homelab (Settings > Ember > Homelab rules): systems the AI must
 * never change, and times a machine or its GPU is reserved for the owner. The AI reads them in
 * every conversation; the policy enforces the do-not-touch list on every change.
 */

export interface DoNotTouch {
  serviceId: string;
  /** Why, in the owner's words ("paused on purpose", "I manage this myself"). */
  reason: string;
  addedAt: string;
}

export const RESERVATION_RESOURCES = ["gpu", "cpu", "machine"] as const;
export type ReservationResource = (typeof RESERVATION_RESOURCES)[number];

export const RESOURCE_TEXT: Record<ReservationResource, string> = {
  gpu: "the GPU",
  cpu: "the processor",
  machine: "the whole machine",
};

/** A daily window when a machine (or part of it) is the owner's, local time. */
export interface Reservation {
  id: string;
  /** A host's name as Hearth knows it, or any machine name ("Gaming-PC"). */
  machine: string;
  resource: ReservationResource;
  /** "19:00". When `from` is later than `until`, the window runs past midnight. */
  from: string;
  until: string;
  /** Days it applies, 0 = Sunday. Empty or absent means every day. */
  days?: number[];
  note?: string;
}

export interface HomelabRules {
  doNotTouch: DoNotTouch[];
  reservations: Reservation[];
  /** The owner's own rules for Ember, in their words (empty when they have none). */
  notes?: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const isClockTime = (s: string) => TIME.test(s);

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/**
 * Whether a reservation covers this local moment. A window that runs past midnight
 * belongs to the day it started on.
 */
export function reservationActive(r: Reservation, local: Date): boolean {
  const now = local.getHours() * 60 + local.getMinutes();
  const from = minutesOf(r.from);
  const until = minutesOf(r.until);
  const day = local.getDay();
  const onDay = (d: number) => !r.days?.length || r.days.includes(d);
  if (from === until) return onDay(day);
  if (from < until) return onDay(day) && now >= from && now < until;
  // Past midnight: the evening part today, or the morning part of a window that began yesterday.
  return (now >= from && onDay(day)) || (now < until && onDay((day + 6) % 7));
}

/** Minutes until the reservation next begins (0 while it is active), within a week. */
export function minutesUntilReservation(r: Reservation, local: Date): number {
  if (reservationActive(r, local)) return 0;
  const start = new Date(local);
  start.setSeconds(0, 0);
  for (let m = 1; m <= 7 * 24 * 60; m++) {
    const probe = new Date(start.getTime() + m * 60_000);
    if (
      probe.getHours() * 60 + probe.getMinutes() === minutesOf(r.from) &&
      reservationActive(r, probe)
    ) {
      return m;
    }
  }
  return Infinity;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h! < 12 ? "AM" : "PM";
  const hour = h! % 12 === 0 ? 12 : h! % 12;
  return m ? `${hour}:${String(m).padStart(2, "0")} ${suffix}` : `${hour} ${suffix}`;
};

/** "The GPU on Gaming-PC, 7 PM to 11 PM every day (gaming)". */
export function reservationText(r: Reservation): string {
  const days =
    !r.days?.length || r.days.length === 7
      ? "every day"
      : r.days
          .slice()
          .sort()
          .map((d) => DAY_NAMES[d])
          .join(", ");
  const span = r.from === r.until ? "all day" : `${clock(r.from)} to ${clock(r.until)}`;
  const what = RESOURCE_TEXT[r.resource];
  return `${what[0]!.toUpperCase()}${what.slice(1)} on ${r.machine}, ${span} ${days}${r.note ? ` (${r.note})` : ""}`;
}
