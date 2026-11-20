import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { SERVER_ROOT } from "../config";

/**
 * The Banner style for movie night invitations: one wide picture made here, like a streaming
 * app's banner. The title, details, time and the host's note sit on the left; the poster stands on
 * the right as a card. Behind it is the movie's own backdrop, darkened on the left so the words
 * read, or, when the movie has no backdrop, a blurred copy of its poster. Discord shows a picture
 * that is not part of the card above it, so the banner leads the post.
 *
 * Drawing uses @napi-rs/canvas (ready-made for Windows, Linux and macOS, x64 and ARM; nothing to
 * install). If it cannot load on some machine, makeBanner answers undefined and the invitation
 * falls back to the Streaming style instead of failing.
 */

export interface BannerInput {
  title: string;
  year?: number;
  /** "Action, Adventure · 2h 25m · PG-13". */
  meta: string;
  /** In the pill: "Saturday, Nov 7, 8:00 PM PST" for a movie night, "Now in Plex" for a new arrival. */
  when?: string;
  /** Along the bottom: the note, spots, where to watch (each short). */
  foot: string[];
  /** "Movie night", or a reminder's or cancellation's heading. */
  eyebrow: string;
  cancelled?: boolean;
  poster?: Buffer;
  backdrop?: Buffer;
}

export const BANNER_W = 1200;
export const BANNER_H = 600;

type Canvas = typeof import("@napi-rs/canvas");
let canvas: Promise<Canvas | undefined> | undefined;

/** Loads the drawing library and Hearth's font once; undefined when it cannot run here. */
function load(): Promise<Canvas | undefined> {
  canvas ??= (async () => {
    try {
      const c = (await import("@napi-rs/canvas")) as Canvas;
      const need = createRequire(path.join(SERVER_ROOT, "package.json"));
      for (const subset of ["latin", "latin-ext"])
        c.GlobalFonts.registerFromPath(
          need.resolve(`@fontsource-variable/inter/files/inter-${subset}-wght-normal.woff2`),
          "Hearth Banner",
        );
      return c;
    } catch {
      return undefined;
    }
  })();
  return canvas;
}

/** Hearth's flame, from the web build (absent in a bare test checkout, then left out). */
function iconPath(): string | undefined {
  for (const p of [
    path.join(SERVER_ROOT, "..", "web", "dist", "icon-192.png"),
    path.join(SERVER_ROOT, "..", "web", "public", "icon-192.png"),
  ])
    if (existsSync(p)) return p;
  return undefined;
}

const FONT = "Hearth Banner";

/** Splits a title into at most `max` lines that fit `width`, the last one shortened if needed. */
function wrap(
  ctx: import("@napi-rs/canvas").SKRSContext2D,
  text: string,
  width: number,
  max: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1]!;
  while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
  kept[max - 1] = `${last.trimEnd()}…`;
  return kept;
}

/** Shortens one line of text to fit `width`. */
function fit(ctx: import("@napi-rs/canvas").SKRSContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Draws `img` to cover the box, cropping what does not fit (like CSS object-fit: cover). */
function cover(
  ctx: import("@napi-rs/canvas").SKRSContext2D,
  img: import("@napi-rs/canvas").Image,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const s = Math.max(w / img.width, h / img.height);
  const sw = w / s;
  const sh = h / s;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function roundRect(
  ctx: import("@napi-rs/canvas").SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The banner as a PNG, or undefined when drawing is not available on this machine. */
export async function makeBanner(b: BannerInput): Promise<Buffer | undefined> {
  const c = await load();
  if (!c) return undefined;
  const cv = c.createCanvas(BANNER_W, BANNER_H);
  const ctx = cv.getContext("2d");
  const read = async (buf?: Buffer) => (buf ? c.loadImage(buf).catch(() => undefined) : undefined);
  const [poster, backdrop] = await Promise.all([read(b.poster), read(b.backdrop)]);

  // Behind everything: the backdrop, else the poster blurred and dimmed, else a dark ember glow.
  ctx.fillStyle = "#0d0a10";
  ctx.fillRect(0, 0, BANNER_W, BANNER_H);
  if (backdrop) cover(ctx, backdrop, 0, 0, BANNER_W, BANNER_H);
  else if (poster) {
    ctx.filter = "blur(38px) saturate(1.2) brightness(0.55)";
    cover(ctx, poster, -60, -60, BANNER_W + 120, BANNER_H + 120);
    ctx.filter = "none";
  } else {
    const g = ctx.createRadialGradient(840, 300, 20, 840, 300, 520);
    g.addColorStop(0, "rgba(255,122,26,0.55)");
    g.addColorStop(1, "rgba(13,10,16,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, BANNER_W, BANNER_H);
  }
  // Darker on the left (the words) and along the bottom (the line of details).
  const left = ctx.createLinearGradient(0, 0, BANNER_W, 0);
  left.addColorStop(0, "rgba(8,6,10,0.94)");
  left.addColorStop(0.36, "rgba(8,6,10,0.84)");
  left.addColorStop(0.64, "rgba(8,6,10,0.32)");
  left.addColorStop(0.82, "rgba(8,6,10,0.08)");
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, BANNER_W, BANNER_H);
  const low = ctx.createLinearGradient(0, BANNER_H, 0, BANNER_H * 0.55);
  low.addColorStop(0, "rgba(8,6,10,0.85)");
  low.addColorStop(1, "rgba(8,6,10,0)");
  ctx.fillStyle = low;
  ctx.fillRect(0, 0, BANNER_W, BANNER_H);

  // The poster as a card on the right.
  const textWidth = poster ? 640 : 1060;
  if (poster) {
    const pw = 333;
    const ph = 500;
    const px = BANNER_W - pw - 70;
    const py = 50;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.7)";
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 18;
    roundRect(ctx, px, py, pw, ph, 14);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, px, py, pw, ph, 14);
    ctx.clip();
    cover(ctx, poster, px, py, pw, ph);
    ctx.restore();
    roundRect(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, 14);
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const x = 64;
  let y = 88;
  // Eyebrow: Hearth's flame and MOVIE NIGHT, spaced out.
  const icon = iconPath();
  const flame = icon ? await c.loadImage(icon).catch(() => undefined) : undefined;
  let ex = x;
  if (flame) {
    ctx.save();
    roundRect(ctx, x, y - 26, 34, 34, 8);
    ctx.clip();
    ctx.drawImage(flame, x, y - 26, 34, 34);
    ctx.restore();
    ex += 46;
  }
  ctx.font = `700 20px "${FONT}"`;
  ctx.fillStyle = b.cancelled ? "#9ca3af" : "#ff8a1f";
  ctx.letterSpacing = "6px";
  ctx.fillText(fit(ctx, b.eyebrow.toUpperCase(), textWidth - (ex - x)), ex, y);
  ctx.letterSpacing = "0px";

  // The title, big, on up to three lines (smaller when it is long).
  let size = 74;
  ctx.font = `800 ${size}px "${FONT}"`;
  let lines = wrap(ctx, b.title, textWidth, 3);
  if (lines.length > 2) {
    size = 56;
    ctx.font = `800 ${size}px "${FONT}"`;
    lines = wrap(ctx, b.title, textWidth, 3);
  }
  y += 34;
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 24;
  for (const l of lines) {
    y += size * 1.04;
    ctx.fillText(l, x, y);
  }
  ctx.shadowBlur = 0;

  // Year and details.
  y += 44;
  ctx.font = `600 22px "${FONT}"`;
  ctx.fillStyle = "#ffffff";
  const year = b.year ? String(b.year) : "";
  ctx.fillText(year, x, y);
  const afterYear = year ? ctx.measureText(year).width : 0;
  ctx.font = `400 22px "${FONT}"`;
  ctx.fillStyle = "#d9d2cc";
  if (b.meta)
    ctx.fillText(
      fit(ctx, `${year ? "  ·  " : ""}${b.meta}`, textWidth - afterYear),
      x + afterYear,
      y,
    );

  // The time, in a pill (or that it is cancelled; or where a new arrival is).
  const pill = b.cancelled ? "Cancelled" : b.when;
  if (pill) {
    y += 34;
    ctx.font = `700 26px "${FONT}"`;
    const when = fit(ctx, pill, textWidth - 70);
    const pw = ctx.measureText(when).width + 66;
    roundRect(ctx, x, y, pw, 58, 12);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 26, y + 29, 5, 0, Math.PI * 2);
    ctx.fillStyle = b.cancelled ? "#9ca3af" : "#ff7a1a";
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(when, x + 44, y + 38);
  }

  // Along the bottom: the note first (bold), then spots and where to watch.
  const foot = b.foot.filter(Boolean);
  if (foot.length) {
    let fx = x;
    const fy = BANNER_H - 48;
    foot.forEach((f, i) => {
      ctx.font = `${i === 0 ? 700 : 400} 20px "${FONT}"`;
      ctx.fillStyle = i === 0 ? "#ffffff" : "#cfc7c0";
      const room = textWidth - (fx - x);
      if (room < 80) return;
      const t = fit(ctx, f, room);
      ctx.fillText(t, fx, fy);
      fx += ctx.measureText(t).width + 30;
    });
  }
  return cv.encode("png");
}
