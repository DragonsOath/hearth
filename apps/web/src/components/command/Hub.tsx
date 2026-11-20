import { useAiName } from "../../data/api";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { ArrowRight, Plus } from "lucide-react";
import type { ProjectPhase, ProjectSummary } from "@dragon-control/core";
import { cx } from "../ui";
import { useProjects } from "../../data/projects";
import { WardenPortrait } from "../shell/DragonEmblem";
import { useCave } from "../shell/cave-context";
import { ProjectCard, WarRoomProjectCard, tintOf } from "./ProjectCard";
import { glowOf } from "./projectGlow";
import { useWarRoomProjects, type WarRoomProject } from "../../data/warRoomProjects";
import { StartProject } from "./StartProject";
import { usePhone } from "../../lib/media";

/** The command center's single-screen layout starts here (Tailwind's lg). */
const DESKTOP = "(min-width: 1024px)";

function useDesktop() {
  return useSyncExternalStore(
    (on) => {
      const m = window.matchMedia(DESKTOP);
      m.addEventListener("change", on);
      return () => m.removeEventListener("change", on);
    },
    () => window.matchMedia(DESKTOP).matches,
    () => true,
  );
}

/** The height a box has right now (0 until measured), following window resizes. */
function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setHeight(entry!.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, height] as const;
}

/**
 * The heart of Home: Ember's portrait, its name, and a real message box. Focusing it (or
 * sending) opens the one shared conversation over the page; minimizing brings the circle back
 * with nothing lost.
 */
function HubCircle({ size }: { size?: number }) {
  const aiName = useAiName();
  const cave = useCave();
  const [text, setText] = useState("");
  return (
    <div className="relative z-10 flex flex-col items-center text-center" data-testid="cave-hub">
      <button
        type="button"
        onClick={() => cave.setExpanded(true)}
        aria-label={`Open ${aiName}`}
        data-hub-core=""
        className="cc-hub rounded-full transition-transform duration-200 hover:scale-[1.02] motion-reduce:transition-none"
      >
        <WardenPortrait
          className={
            size
              ? "block"
              : "h-[250px] w-[250px] sm:h-[290px] sm:w-[290px] xl:h-[310px] xl:w-[310px]"
          }
          style={size ? { width: size, height: size } : undefined}
        />
      </button>
      {/* Clear of the round portrait, so its frame never clips the letters. */}
      <p
        className="mt-3 font-display text-[1.65rem] leading-none tracking-[0.05em] text-gold uppercase sm:text-[1.8rem]"
        data-testid="cave-hub-name"
      >
        {aiName}
      </p>
      <form
        className="mt-2.5 flex w-[260px] items-center gap-1 rounded-lg border border-gold/40 bg-bg/80 p-1 focus-within:border-gold"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) cave.ask(text.trim(), { typed: true });
          else cave.setExpanded(true);
          setText("");
        }}
      >
        <label htmlFor="hub-ask" className="sr-only">
          Ask about your homelab
        </label>
        <input
          id="hub-ask"
          autoComplete="off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          // Focusing the box opens the full conversation, where the typing continues.
          onFocus={() => cave.setExpanded(true)}
          placeholder="Ask anything…"
          className="min-h-9 min-w-0 flex-1 bg-transparent px-2 text-[0.86rem] text-ink placeholder:text-faint focus:outline-none"
        />
        <button
          type="submit"
          aria-label={`Open ${aiName}`}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gold text-bg hover:bg-gold-bright"
        >
          <ArrowRight strokeWidth={1.75} className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}

/** Start a project: first, the Lair or the War Room (10-30). */
function StartCard({ className, compact }: { className?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          "flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gold/30 p-4 text-center text-[0.86rem] text-muted transition-colors hover:border-gold/60 hover:text-gold",
          compact ? "min-h-[84px]" : "min-h-[132px]",
          className,
        )}
        data-testid="hub-start-project"
      >
        <Plus strokeWidth={1.5} className="h-5 w-5" />
        Start a project
      </button>
      {open && <StartProject onClose={() => setOpen(false)} />}
    </>
  );
}

type Line = {
  d: string;
  tint: string;
  /** The card glows in a color the owner chose: the line glows too. */
  glow: boolean;
  a: [number, number];
  b: [number, number];
};

/**
 * Lines from Ember's ring to each card's inner edge, in the card's colour (decorative). Measured
 * from where things actually are, so they land on the cards at any window size.
 */
function useConnectors(box: React.RefObject<HTMLDivElement | null>, deps: string) {
  const [lines, setLines] = useState<{ w: number; h: number; lines: Line[] }>({
    w: 0,
    h: 0,
    lines: [],
  });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const core = el.querySelector<HTMLElement>("[data-hub-core]");
      const cards = [...el.querySelectorAll<HTMLElement>("[data-hub-card]")];
      if (!core || !window.matchMedia(DESKTOP).matches) return setLines({ w: 0, h: 0, lines: [] });
      const o = el.getBoundingClientRect();
      const c = core.getBoundingClientRect();
      const cx = c.left + c.width / 2 - o.left;
      const cy = c.top + c.height / 2 - o.top + el.scrollTop;
      const r = c.width / 2 + 6;
      const out: Line[] = cards.map((card) => {
        const k = card.getBoundingClientRect();
        const left = k.left + k.width / 2 - o.left < cx;
        const bx = (left ? k.right : k.left) - o.left;
        const by = k.top + k.height / 2 - o.top + el.scrollTop;
        const angle = Math.atan2(by - cy, bx - cx);
        const ax = cx + r * Math.cos(angle);
        const ay = cy + r * Math.sin(angle);
        const bend = Math.abs(bx - ax) * 0.45;
        const d = `M${ax} ${ay} C ${ax + (left ? -bend : bend)} ${ay}, ${bx + (left ? bend : -bend)} ${by}, ${bx} ${by}`;
        return {
          d,
          tint: card.dataset.tint ?? "var(--color-gold)",
          glow: card.dataset.glow === "true",
          a: [ax, ay],
          b: [bx, by],
        };
      });
      setLines({ w: el.clientWidth, h: el.scrollHeight, lines: out });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.querySelectorAll("[data-hub-card], [data-hub-core]").forEach((n) => ro.observe(n));
    return () => ro.disconnect();
  }, [box, deps]);
  return lines;
}

function Connectors({ w, h, lines }: { w: number; h: number; lines: Line[] }) {
  if (!w || !lines.length) return null;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 hidden lg:block"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
    >
      {lines.map((l, i) => (
        <g key={i} style={{ color: l.tint }}>
          <path
            d={l.d}
            stroke="currentColor"
            strokeOpacity={l.glow ? 0.9 : 0.55}
            strokeWidth={l.glow ? 1.75 : 1.25}
            fill="none"
            style={l.glow ? { filter: "drop-shadow(0 0 4px currentColor)" } : undefined}
          />
          <circle cx={l.a[0]} cy={l.a[1]} r="3" fill="currentColor" />
          <circle cx={l.b[0]} cy={l.b[1]} r="3" fill="currentColor" />
        </g>
      ))}
    </svg>
  );
}

type Slot = { war: WarRoomProject } | { mem: ProjectSummary } | "start";

/** Lower comes first: what needs the owner, then what is being worked on, then the rest. */
const PHASE_RANK: Record<ProjectPhase, number> = {
  blocked: 0,
  failed: 0,
  "awaiting-approval": 1,
  "in-progress": 2,
  investigating: 2,
  planned: 3,
  queued: 3,
  paused: 5,
  completed: 6,
};
// A War Room project just started (no messages yet) counts as in progress, so it shows on Home
// where it was started (11-13).
const rank = (s: Exclude<Slot, "start">) =>
  "war" in s
    ? s.war.active || (s.war.created && s.war.messages === 0)
      ? 2
      : 4
    : PHASE_RANK[s.mem.phase];

/** A card's height plus the gap below it: how many fit beside Ember. */
const COMPACT_ROOM = 92;
/** The name and message box under the portrait. */
const UNDER_PORTRAIT = 128;

const slotKey = (s: Slot) =>
  s === "start" ? "start" : "war" in s ? `w:${s.war.where.pc ?? "hub"}:${s.war.slug}` : s.mem.id;
const slotTint = (s: Slot) =>
  s === "start"
    ? "var(--color-gold)"
    : "war" in s
      ? (glowOf(s.war) ?? "var(--color-tint-gold)")
      : tintOf(s.mem);

/**
 * Ember with active projects around it; the rest are a click away. Projects that need the owner
 * or are being worked on come first. On a desktop it fills exactly the height it is given: the
 * portrait, the card size and the number of cards follow the window, so Home never scrolls.
 */
export function CommandHub({ className }: { className?: string }) {
  const projects = useProjects();
  const war = useWarRoomProjects();
  const desktop = useDesktop();
  const [box, height] = useHeight<HTMLDivElement>();
  const list: ProjectSummary[] = projects.data ?? [];
  // No War Room on a phone (11-13): its projects open on a tablet or computer.
  const phone = usePhone();
  const all = [
    ...(phone ? [] : (war.data ?? [])).map((w) => ({ war: w })),
    ...list.map((m) => ({ mem: m })),
  ]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
    .map(({ s }) => s as Slot);
  const total = all.length;
  const perSide =
    desktop && height ? Math.max(1, Math.min(3, Math.floor(height / COMPACT_ROOM))) : 3;
  // Compact cards at every desktop size (10-29 picked this look).
  const compact = desktop;
  // Start a project always has a place (11-13: with every spot taken, Home had no way to start
  // one); the projects that do not fit are counted under the ring.
  const slots: Slot[] = [...all.slice(0, perSide * 2 - 1), "start"];
  const hidden = total - slots.filter((s) => s !== "start").length;
  const portrait =
    desktop && height ? Math.max(110, Math.min(330, Math.floor(height - UNDER_PORTRAIT))) : 0;
  const left = slots.filter((_, i) => i % 2 === 0);
  const right = slots.filter((_, i) => i % 2 === 1);
  const lines = useConnectors(box, `${slots.map(slotKey).join()}|${portrait}`);
  // The middle card on each side sits closer to Ember, so the cards follow the circle.
  const arc = (side: "l" | "r", i: number, n: number) =>
    desktop && n === 3 && i === 1
      ? side === "l"
        ? "lg:translate-x-10"
        : "lg:-translate-x-10"
      : "";
  const render = (side: "l" | "r") => (s: Slot, i: number, list: Slot[]) => (
    <div
      key={slotKey(s)}
      data-hub-card=""
      data-tint={slotTint(s)}
      data-glow={s !== "start" && glowOf("war" in s ? s.war : s.mem) ? "true" : undefined}
      className={cx("grid", arc(side, i, list.length))}
    >
      {s === "start" ? (
        <StartCard compact={compact} />
      ) : "war" in s ? (
        <WarRoomProjectCard project={s.war} compact={compact} />
      ) : (
        <ProjectCard project={s.mem} compact={compact} />
      )}
    </div>
  );

  return (
    <section aria-label="Active projects" className={cx("flex flex-col", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-[1.2rem] text-gold">Active projects</h2>
        <Link
          to="/projects"
          className="text-[0.82rem] text-muted hover:text-gold"
          data-testid="hub-all-projects"
        >
          {hidden > 0 ? `+${hidden} more · View all ${total}` : "View all"} →
        </Link>
      </div>
      {/* Desktop: cards on both sides of the circle, filling the height. Smaller: circle, then cards. */}
      <div
        ref={box}
        // On a computer it shows once measured, so Ember never appears at one size and jumps
        // to another.
        style={desktop && !height ? { visibility: "hidden" } : undefined}
        // A window too short for the whole composition scrolls here, never over the alerts below.
        className="relative grid items-center gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,440px)_auto_minmax(0,440px)] lg:justify-center lg:gap-14 lg:overflow-y-auto"
      >
        <Connectors {...lines} />
        <div className="order-2 grid gap-3 sm:grid-cols-2 lg:order-1 lg:grid-cols-1 lg:gap-4">
          {left.map(render("l"))}
        </div>
        <div className="order-1 flex justify-center lg:order-2">
          <HubCircle size={portrait || undefined} />
        </div>
        <div className="order-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 lg:gap-4">
          {right.map(render("r"))}
        </div>
      </div>
    </section>
  );
}
