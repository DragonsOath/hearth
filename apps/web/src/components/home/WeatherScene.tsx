import { useEffect, useRef } from "react";
import { particleCount, type MotionLevel, type Scene } from "../../lib/weatherScene";

/**
 * The window behind the home dashboard (11-04): hills under the real sky, drawn in code so it
 * follows Home Assistant's weather and the sun. Rain streaks, drifting snow, slow clouds, fog,
 * stars, a warm sun, and a rare soft lightning bolt in a storm. It stops when the screen is
 * hidden, draws one still frame when motion is off (or the device asks for reduced motion), and
 * drops to fewer, slower particles by itself on a tablet that cannot keep up.
 */

interface Drop {
  x: number;
  y: number;
  l: number;
  v: number;
  a: number;
  s: number;
}
interface Puff {
  x: number;
  y: number;
  r: number;
  v: number;
  a: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function WeatherScene({ scene, motion }: { scene: Scene; motion: MotionLevel }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const flash = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const still = motion === "off" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let level: MotionLevel = motion;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let drops: Drop[] = [];
    let puffs: Puff[] = [];
    let stars: { x: number; y: number; r: number; p: number }[] = [];
    let beads: Drop[] = [];
    let bolt: { pts: [number, number][]; t: number } | undefined;
    let nextBolt = performance.now() + rand(3000, 7000);
    let raf = 0;
    let last = performance.now();
    let slow = 0;

    const build = () => {
      const r = c.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, level === "lite" ? 1 : 1.5);
      W = c.width = Math.max(1, Math.round(r.width * dpr));
      H = c.height = Math.max(1, Math.round(r.height * dpr));
      const snow = scene.kind === "snow";
      drops = Array.from({ length: particleCount(scene, r.width, r.height, level) }, () => ({
        x: rand(0, W),
        y: rand(0, H),
        l: snow ? rand(1.2, 3.4) : rand(10, 28),
        v: snow ? rand(0.5, 1.6) : rand(10, 20) * (scene.kind === "heavy" ? 1.25 : 1),
        a: snow ? rand(0.45, 0.9) : rand(0.12, 0.42),
        s: rand(0, Math.PI * 2),
      }));
      const clouds = Math.round(scene.cloud * (level === "lite" ? 5 : 9));
      puffs = Array.from({ length: clouds }, () => ({
        x: rand(-0.2, 1.1) * W,
        y: rand(0.02, 0.38) * H,
        r: rand(0.16, 0.34) * W,
        v: rand(0.04, 0.16) * dpr * (scene.kind === "wind" ? 4 : 1),
        a: rand(0.1, 0.22) * (scene.night ? 0.7 : 1),
      }));
      stars = scene.stars
        ? Array.from({ length: Math.round((r.width * r.height) / 5200) }, () => ({
            x: rand(0, W),
            y: rand(0, H * 0.45),
            r: rand(0.4, 1.3) * dpr,
            p: rand(0, Math.PI * 2),
          }))
        : [];
      // Drops on the glass, sliding now and then, when it rains.
      beads =
        scene.fall && scene.kind !== "snow"
          ? Array.from({ length: level === "lite" ? 14 : 34 }, () => ({
              x: rand(0, W),
              y: rand(0, H),
              l: rand(1.5, 4) * dpr,
              v: Math.random() < 0.3 ? rand(0.2, 1.2) : 0,
              a: rand(0.25, 0.55),
              s: 0,
            }))
          : [];
    };

    const makeBolt = () => {
      const pts: [number, number][] = [[W * rand(0.3, 0.7), 0]];
      let [x, y] = pts[0]!;
      while (y < H * 0.34) {
        x += rand(-24, 24) * dpr;
        y += rand(14, 30) * dpr;
        pts.push([x, y]);
      }
      return { pts, t: performance.now() };
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, W, H);
      // Stars.
      for (const s of stars) {
        const tw = still ? 0.7 : 0.55 + Math.sin(now / 900 + s.p) * 0.35;
        ctx.fillStyle = `rgba(230,238,255,${tw})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Clouds: soft puffs drifting.
      for (const p of puffs) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        const tint = scene.night ? "150,170,205" : "235,240,248";
        g.addColorStop(0, `rgba(${tint},${p.a})`);
        g.addColorStop(1, `rgba(${tint},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
        if (!still) {
          p.x += p.v;
          if (p.x - p.r > W) p.x = -p.r;
        }
      }
      // Fog: wide bands low down.
      if (scene.kind === "fog") {
        for (let i = 0; i < 3; i++) {
          const y = H * (0.45 + i * 0.12);
          const shift = still ? 0 : Math.sin(now / 9000 + i) * W * 0.05;
          const g = ctx.createLinearGradient(0, y - H * 0.1, 0, y + H * 0.1);
          g.addColorStop(0, "rgba(190,200,215,0)");
          g.addColorStop(0.5, `rgba(190,200,215,${scene.night ? 0.12 : 0.2})`);
          g.addColorStop(1, "rgba(190,200,215,0)");
          ctx.fillStyle = g;
          ctx.fillRect(shift - W * 0.1, y - H * 0.1, W * 1.2, H * 0.2);
        }
      }
      // Wind: long faint streaks.
      if (scene.kind === "wind" && !still) {
        ctx.strokeStyle = "rgba(220,230,245,0.12)";
        ctx.lineWidth = dpr;
        for (let i = 0; i < 8; i++) {
          const y = ((i * 97 + now / 30) % (H * 0.8)) + H * 0.05;
          const x = (now / 2 + i * 300 * dpr) % (W + 400 * dpr);
          ctx.beginPath();
          ctx.moveTo(x - 220 * dpr, y);
          ctx.quadraticCurveTo(x - 110 * dpr, y - 8 * dpr, x, y);
          ctx.stroke();
        }
      }
      // Rain or snow.
      if (scene.kind === "snow") {
        for (const d of drops) {
          ctx.fillStyle = `rgba(245,248,255,${d.a})`;
          ctx.beginPath();
          ctx.arc(d.x, d.y, d.l * dpr, 0, Math.PI * 2);
          ctx.fill();
          if (!still) {
            d.y += d.v * dpr;
            d.x += Math.sin(now / 1400 + d.s) * 0.5 * dpr;
            if (d.y > H) {
              d.y = -6;
              d.x = rand(0, W);
            }
          }
        }
      } else if (drops.length) {
        ctx.lineCap = "round";
        ctx.lineWidth = dpr;
        const slant = scene.kind === "heavy" || scene.kind === "storm" ? 0.2 : 0.12;
        for (const d of drops) {
          ctx.strokeStyle = `rgba(185,210,245,${d.a})`;
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - d.l * slant * dpr, d.y + d.l * dpr);
          ctx.stroke();
          if (!still) {
            d.y += d.v * dpr;
            d.x -= d.v * slant * dpr;
            if (d.y > H) {
              d.y = -30;
              d.x = rand(0, W * 1.08);
            }
          }
        }
      }
      // Drops on the glass.
      for (const b of beads) {
        const g = ctx.createRadialGradient(b.x - b.l * 0.3, b.y - b.l * 0.3, 0, b.x, b.y, b.l);
        g.addColorStop(0, `rgba(255,255,255,${b.a})`);
        g.addColorStop(1, "rgba(160,190,230,0.05)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.l, 0, Math.PI * 2);
        ctx.fill();
        if (!still && b.v) {
          b.y += b.v * dpr;
          if (b.y > H) {
            b.y = -10;
            b.x = rand(0, W);
          }
        }
      }
      // A storm's rare, soft bolt: at most every seven seconds, never a rapid flicker.
      if (scene.lightning && !still) {
        if (now > nextBolt) {
          bolt = makeBolt();
          nextBolt = now + rand(7000, 16000);
          if (flash.current) {
            flash.current.style.opacity = "1";
            window.setTimeout(() => flash.current && (flash.current.style.opacity = "0"), 180);
          }
        }
        if (bolt) {
          const age = now - bolt.t;
          if (age > 450) bolt = undefined;
          else {
            ctx.save();
            ctx.strokeStyle = `rgba(210,228,255,${0.85 * (1 - age / 450)})`;
            ctx.lineWidth = 2 * dpr;
            ctx.shadowColor = "rgba(150,190,255,0.9)";
            ctx.shadowBlur = 18 * dpr;
            ctx.beginPath();
            bolt.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
            ctx.stroke();
            ctx.restore();
          }
        }
      }
    };

    const tick = (now: number) => {
      // A slow tablet: fewer, larger frames.
      const dt = now - last;
      last = now;
      if (level === "full" && dt > 28) slow++;
      else slow = Math.max(0, slow - 1);
      if (slow > 90) {
        level = "lite";
        slow = 0;
        build();
      }
      draw(now);
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };

    build();
    if (still) draw(performance.now());
    else raf = requestAnimationFrame(tick);
    const resize = new ResizeObserver(() => {
      build();
      if (still) draw(performance.now());
    });
    resize.observe(c);
    const vis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", vis);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, [scene, motion]);

  return (
    <div
      className={`hd-scene hd-${scene.kind}${scene.night ? " hd-night" : " hd-day"}`}
      aria-hidden
      data-testid="home-scene"
      data-scene={`${scene.kind}${scene.night ? "-night" : ""}`}
    >
      <div className="hd-sky" />
      <div className="hd-sun" />
      <div className="hd-flash" ref={flash} />
      <svg className="hd-hills" viewBox="0 0 1600 400" preserveAspectRatio="none">
        <path
          className="hd-hill-far"
          d="M0 260 L180 210 L330 240 L520 150 L640 120 L700 92 L760 118 L880 170 L1010 150 L1150 200 L1320 170 L1460 220 L1600 200 L1600 400 L0 400Z"
        />
        <path
          className="hd-hill-near"
          d="M0 330 L160 290 L300 310 L470 260 L620 290 L780 250 L940 300 L1100 270 L1260 310 L1420 280 L1600 300 L1600 400 L0 400Z"
        />
      </svg>
      <div className="hd-ground" />
      <canvas ref={canvas} className="hd-fx" />
      <div className="hd-room" />
      <div className="hd-frame" />
    </div>
  );
}
