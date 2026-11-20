import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbHandle } from "../db/client";
import { getSetting, setSetting } from "../store/settings";

/**
 * The home dashboard's household board (11-05): what the family keeps on the wall that Home
 * Assistant has no place for. Notes for each other, countdowns, chores that repeat (with stars for
 * whoever did them), reminders like bin day, the news feeds to show, and the photo frame's album.
 * Kept by Hearth, shared by every screen in the house.
 *
 * Anyone at a screen (a paired home tablet too) may add a note or tick a chore off. Choosing the
 * news feeds and the photo album is the owner's: Hearth fetches those addresses itself.
 */

export interface Schedule {
  /** "week": on these weekdays (0 Sunday to 6 Saturday). "every": every n days from start. */
  type: "week" | "every";
  days?: number[];
  n?: number;
  /** YYYY-MM-DD, the first day. */
  start?: string;
}

export interface BoardTask {
  id: string;
  title: string;
  /** A chore is someone's, with stars; a reminder is for the house. */
  kind: "chore" | "reminder";
  who?: string;
  stars?: number;
  schedule: Schedule;
  /** The days it was done, YYYY-MM-DD, newest first (the last 20). */
  done: string[];
  /** When it was put on the board. */
  added?: string;
}

export interface HomeBoard {
  notes: { id: string; text: string; by?: string; at: string }[];
  countdowns: { id: string; title: string; date: string }[];
  tasks: BoardTask[];
  /** Stars earned, by person. */
  stars: Record<string, number>;
  feeds: { url: string; name?: string }[];
  /** The photo frame: an Immich album, or all recent photos. */
  photos?: { album?: string; albumName?: string };
}

const EMPTY: HomeBoard = { notes: [], countdowns: [], tasks: [], stars: {}, feeds: [] };

export class BoardError extends Error {}

export async function readBoard(handle: DbHandle): Promise<HomeBoard> {
  return { ...EMPTY, ...((await getSetting(handle.db, "home_board")) ?? {}) };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-12-25.");
const words = (max: number) => z.string().trim().min(1).max(max);
const schedule = z
  .object({
    type: z.enum(["week", "every"]),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    n: z.number().int().min(1).max(365).optional(),
    start: day.optional(),
  })
  .strict()
  .refine((s) => (s.type === "week" ? Boolean(s.days?.length) : Boolean(s.n)), {
    message: "Which days, or how often.",
  });

export const BoardChange = z.discriminatedUnion("op", [
  z.object({ op: z.literal("note.add"), text: words(280), by: words(40).optional() }).strict(),
  z.object({ op: z.literal("note.remove"), id: z.string().max(64) }).strict(),
  z.object({ op: z.literal("countdown.add"), title: words(60), date: day }).strict(),
  z.object({ op: z.literal("countdown.remove"), id: z.string().max(64) }).strict(),
  z
    .object({
      op: z.literal("task.add"),
      kind: z.enum(["chore", "reminder"]),
      title: words(80),
      who: words(40).optional(),
      stars: z.number().int().min(0).max(10).optional(),
      schedule,
    })
    .strict(),
  z.object({ op: z.literal("task.remove"), id: z.string().max(64) }).strict(),
  z.object({ op: z.literal("task.done"), id: z.string().max(64), on: day }).strict(),
  z.object({ op: z.literal("task.undo"), id: z.string().max(64), on: day }).strict(),
  z.object({ op: z.literal("stars.reset"), who: words(40).optional() }).strict(),
  z
    .object({
      op: z.literal("feeds.set"),
      feeds: z
        .array(z.object({ url: z.string().url().max(500), name: words(60).optional() }).strict())
        .max(8),
    })
    .strict(),
  z
    .object({
      op: z.literal("photos.set"),
      album: z.string().max(64).optional(),
      albumName: words(120).optional(),
    })
    .strict(),
]);
export type BoardChange = z.infer<typeof BoardChange>;

/** Changes only the owner makes (they decide what Hearth fetches). */
export const OWNER_ONLY = new Set(["feeds.set", "photos.set"]);

const LIMITS = { notes: 30, countdowns: 20, tasks: 60 };

// Two screens changing the board at once: one after the other, so neither change is lost.
let queue: Promise<unknown> = Promise.resolve();

/** One change to the board; returns the board after it. */
export function changeBoard(handle: DbHandle, change: BoardChange): Promise<HomeBoard> {
  const run = queue.then(() => applyChange(handle, change));
  queue = run.catch(() => undefined);
  return run;
}

async function applyChange(handle: DbHandle, change: BoardChange): Promise<HomeBoard> {
  const b = await readBoard(handle);
  const now = new Date().toISOString();
  switch (change.op) {
    case "note.add":
      if (b.notes.length >= LIMITS.notes) throw new BoardError("The board is full: remove a note.");
      b.notes = [
        { id: randomUUID(), text: change.text, ...(change.by ? { by: change.by } : {}), at: now },
        ...b.notes,
      ];
      break;
    case "note.remove":
      b.notes = b.notes.filter((n) => n.id !== change.id);
      break;
    case "countdown.add":
      if (b.countdowns.length >= LIMITS.countdowns)
        throw new BoardError("That's a lot of countdowns: remove one first.");
      b.countdowns = [
        ...b.countdowns,
        { id: randomUUID(), title: change.title, date: change.date },
      ].sort((x, y) => x.date.localeCompare(y.date));
      break;
    case "countdown.remove":
      b.countdowns = b.countdowns.filter((c) => c.id !== change.id);
      break;
    case "task.add":
      if (b.tasks.length >= LIMITS.tasks)
        throw new BoardError("Too many chores: remove one first.");
      b.tasks = [
        ...b.tasks,
        {
          id: randomUUID(),
          kind: change.kind,
          title: change.title,
          ...(change.who ? { who: change.who } : {}),
          ...(change.kind === "chore" ? { stars: change.stars ?? 1 } : {}),
          schedule: change.schedule,
          done: [],
          added: now,
        },
      ];
      break;
    case "task.remove":
      b.tasks = b.tasks.filter((t) => t.id !== change.id);
      break;
    case "task.done":
    case "task.undo": {
      const t = b.tasks.find((x) => x.id === change.id);
      if (!t) throw new BoardError("That chore is not on the board any more.");
      const had = t.done.includes(change.on);
      if (change.op === "task.done" && !had) {
        t.done = [change.on, ...t.done].sort().reverse().slice(0, 20);
        if (t.kind === "chore" && t.who && t.stars)
          b.stars[t.who] = (b.stars[t.who] ?? 0) + t.stars;
      }
      if (change.op === "task.undo" && had) {
        t.done = t.done.filter((d) => d !== change.on);
        if (t.kind === "chore" && t.who && t.stars)
          b.stars[t.who] = Math.max(0, (b.stars[t.who] ?? 0) - t.stars);
      }
      break;
    }
    case "stars.reset":
      if (change.who) delete b.stars[change.who];
      else b.stars = {};
      break;
    case "feeds.set":
      for (const f of change.feeds)
        if (!/^https?:\/\//i.test(f.url))
          throw new BoardError("A news feed is an http(s) address.");
      b.feeds = change.feeds;
      break;
    case "photos.set":
      b.photos = change.album
        ? { album: change.album, ...(change.albumName ? { albumName: change.albumName } : {}) }
        : {};
      break;
  }
  await setSetting(handle.db, "home_board", b);
  return b;
}
