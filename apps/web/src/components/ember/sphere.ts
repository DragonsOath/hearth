/**
 * The War Room's orb, from EMBER. Two looks, one per engine, cross-faded when the engine changes:
 *   ember (Claude Code): an orange particle sphere with sparks orbiting while it works;
 *   codex (Codex):       a blue wireframe lattice with drifting code glyphs and three orbit rings.
 *   ollama (Ollama):     the particle sphere in Ollama's black and white.
 * `level` (0..1) is fed by the microphone or the voice output for live motion.
 */

export type OrbState = "idle" | "listening" | "thinking" | "working" | "speaking" | "error";
export type OrbLook = "ember" | "codex" | "ollama";

const MOTION: Record<
  OrbState,
  { spin: number; noise: number; pulse: number; glow: number; label: string }
> = {
  idle: { spin: 0.0016, noise: 0.03, pulse: 0.015, glow: 0.35, label: "IDLE" },
  listening: { spin: 0.003, noise: 0.05, pulse: 0.0, glow: 0.55, label: "LISTENING" },
  thinking: { spin: 0.012, noise: 0.1, pulse: 0.04, glow: 0.6, label: "THINKING" },
  working: { spin: 0.007, noise: 0.06, pulse: 0.03, glow: 0.65, label: "WORKING" },
  speaking: { spin: 0.004, noise: 0.04, pulse: 0.0, glow: 0.7, label: "SPEAKING" },
  error: { spin: 0.002, noise: 0.18, pulse: 0.06, glow: 0.5, label: "ERROR" },
};

const PALETTE: Record<OrbLook, Record<OrbState, [number, number, number]>> = {
  ember: {
    idle: [255, 122, 26],
    listening: [79, 209, 255],
    thinking: [180, 140, 255],
    working: [255, 160, 40],
    speaking: [255, 200, 90],
    error: [255, 77, 77],
  },
  codex: {
    idle: [31, 122, 255],
    listening: [79, 216, 255],
    thinking: [130, 110, 255],
    working: [40, 160, 255],
    speaking: [120, 215, 255],
    error: [255, 77, 77],
  },
  ollama: {
    idle: [235, 235, 235],
    listening: [255, 255, 255],
    thinking: [190, 190, 190],
    working: [245, 245, 245],
    speaking: [255, 255, 255],
    error: [255, 77, 77],
  },
};

export const orbLabel = (s: OrbState) => MOTION[s].label;

const GLYPHS = "01{}<>/;=()[]#$_*+".split("");
const pick = () => GLYPHS[(Math.random() * GLYPHS.length) | 0] ?? "0";

export class Orb {
  level = 0;
  private smooth = 0;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private rotY = 0;
  private readonly rotX = 0.35;
  private t = 0;
  private state: OrbState = "idle";
  private look: OrbLook = "ember";
  private mix = 0;
  private cur = { ...MOTION.idle, color: [...PALETTE.ember.idle] as number[] };
  private raf = 0;
  private ro?: ResizeObserver;
  private readonly reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  private pts: { x: number; y: number; z: number; seed: number }[] = [];
  private orbit: { a: number; tilt: number; sp: number }[] = [];
  private glyphs: { x: number; y: number; z: number; ch: string; seed: number; flip: number }[] =
    [];
  private rings = [
    { tilt: 0.35, yaw: 0.0, sp: 0.01, nodes: 3, phase: 0 },
    { tilt: 1.15, yaw: 1.1, sp: -0.007, nodes: 2, phase: 0 },
    { tilt: 1.9, yaw: 2.3, sp: 0.005, nodes: 4, phase: 0 },
  ];

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    const N = 1400;
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.399963229728653;
      this.pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r, seed: Math.random() * 1000 });
    }
    const ORB = 90;
    this.orbit = Array.from({ length: ORB }, (_, i) => ({
      a: (i / ORB) * Math.PI * 2,
      tilt: (i % 3) * 1.05,
      sp: 0.6 + Math.random() * 0.8,
    }));
    const G = 220;
    for (let i = 0; i < G; i++) {
      const y = 1 - (i / (G - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.399963229728653;
      this.glyphs.push({
        x: Math.cos(th) * r,
        y,
        z: Math.sin(th) * r,
        ch: pick(),
        seed: Math.random() * 1000,
        flip: 40 + Math.random() * 200,
      });
    }
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.raf = requestAnimationFrame(this.frame);
  }

  set(s: OrbState) {
    this.state = MOTION[s] ? s : "idle";
  }
  get(): OrbState {
    return this.state;
  }
  setLook(l: OrbLook) {
    this.look = l;
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private project(x: number, y: number, z: number, cx: number, cy: number, R: number) {
    const cY = Math.cos(this.rotY);
    const sY = Math.sin(this.rotY);
    const cX = Math.cos(this.rotX);
    const sX = Math.sin(this.rotX);
    const x1 = x * cY - z * sY;
    const z1 = x * sY + z * cY;
    const y1 = y * cX - z1 * sX;
    const z2 = y * sX + z1 * cX;
    const persp = 1.9 / (2.6 - z2);
    return { px: cx + x1 * R * persp, py: cy + y1 * R * persp, depth: (z2 + 1) / 2 };
  }

  private drawEmber(cx: number, cy: number, R: number, rgb: number[], lv: number, alpha: number) {
    const { ctx, t, cur, state } = this;
    const [cr, cg, cb] = rgb;
    for (const p of this.pts) {
      const n =
        1 + Math.sin(p.seed + t * 0.03) * cur.noise + Math.sin(p.seed * 2 + t * 0.11) * lv * 0.22;
      const q = this.project(p.x * n, p.y * n, p.z * n, cx, cy, R);
      const size = 0.6 + q.depth * 1.5;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${(0.12 + q.depth * 0.75) * alpha})`;
      ctx.fillRect(q.px - size / 2, q.py - size / 2, size, size);
    }
    if (state === "working" || state === "thinking") {
      for (const o of this.orbit) {
        o.a += 0.012 * o.sp * (state === "thinking" ? 1.8 : 1);
        const ox = Math.cos(o.a) * R * 1.35;
        const oz = Math.sin(o.a) * R * 1.35;
        const oy = oz * Math.sin(o.tilt) * 0.5;
        const oz2 = oz * Math.cos(o.tilt);
        const d = (oz2 / (R * 1.35) + 1) / 2;
        ctx.fillStyle =
          this.look === "ollama"
            ? `rgba(255,255,255,${(0.25 + d * 0.6) * alpha})`
            : `rgba(255,${180 + Math.round(d * 60)},90,${(0.25 + d * 0.6) * alpha})`;
        ctx.beginPath();
        ctx.arc(cx + ox, cy + oy, 0.8 + d * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawCodex(cx: number, cy: number, R: number, rgb: number[], lv: number, alpha: number) {
    const { ctx, t, cur, state } = this;
    const [cr = 0, cg = 0, cb = 0] = rgb;
    const breathe = 1 + Math.sin(t * 0.03) * cur.noise * 0.5 + lv * 0.12;
    const Rr = R * 0.92 * breathe;
    ctx.lineWidth = 1;
    const seg = 40;
    const line = (fn: (u: number) => [number, number, number]) => {
      let prev: { px: number; py: number } | null = null;
      for (let i = 0; i <= seg; i++) {
        const [x, y, z] = fn(i / seg);
        const q = this.project(x, y, z, cx, cy, Rr);
        if (prev) {
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.04 + q.depth * 0.32) * alpha})`;
          ctx.beginPath();
          ctx.moveTo(prev.px, prev.py);
          ctx.lineTo(q.px, q.py);
          ctx.stroke();
        }
        prev = q;
      }
    };
    for (let m = 0; m < 10; m++) {
      const ph = (m / 10) * Math.PI;
      line((u) => {
        const a = u * Math.PI * 2;
        return [Math.cos(a) * Math.cos(ph), Math.sin(a), Math.cos(a) * Math.sin(ph)];
      });
    }
    for (let p = 1; p < 7; p++) {
      const lat = -Math.PI / 2 + (p / 7) * Math.PI;
      const y = Math.sin(lat);
      const r = Math.cos(lat);
      line((u) => {
        const a = u * Math.PI * 2;
        return [Math.cos(a) * r, y, Math.sin(a) * r];
      });
    }
    const busy = state === "working" || state === "thinking" ? 4 : 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const g of this.glyphs) {
      if ((t + g.seed) % (g.flip / busy) < 1) g.ch = pick();
      const n =
        1.02 + Math.sin(g.seed + t * 0.04) * 0.03 + lv * 0.15 * Math.sin(g.seed * 3 + t * 0.2);
      const q = this.project(g.x * n, g.y * n, g.z * n, cx, cy, Rr);
      if (q.depth < 0.35) continue;
      ctx.font = `${Math.round(7 + q.depth * 7)}px "JetBrains Mono", monospace`;
      ctx.fillStyle = `rgba(${Math.min(255, cr + 60)},${Math.min(255, cg + 40)},255,${(q.depth - 0.3) * 1.1 * alpha})`;
      ctx.fillText(g.ch, q.px, q.py);
    }
    const hr = R * (0.16 + lv * 0.08 + Math.sin(t * 0.06) * 0.01);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.004);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, hr * 2.4);
    core.addColorStop(0, `rgba(220,240,255,${0.9 * alpha})`);
    core.addColorStop(0.35, `rgba(${cr},${cg},${cb},${0.55 * alpha})`);
    core.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(0, 0, hr * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(200,230,255,${0.8 * alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      if (i) ctx.lineTo(Math.cos(a) * hr, Math.sin(a) * hr);
      else ctx.moveTo(Math.cos(a) * hr, Math.sin(a) * hr);
    }
    ctx.stroke();
    ctx.restore();
    const speed = state === "working" ? 2.2 : state === "thinking" ? 3 : 1;
    for (const ring of this.rings) {
      ring.phase += ring.sp * speed;
      const rr = R * 1.28;
      const ct = Math.cos(ring.tilt);
      const st = Math.sin(ring.tilt);
      const cyw = Math.cos(ring.yaw);
      const syw = Math.sin(ring.yaw);
      const at = (a: number) => {
        const x = Math.cos(a);
        const y = Math.sin(a) * ct;
        const z = Math.sin(a) * st;
        return this.project(x * cyw - z * syw, y, x * syw + z * cyw, cx, cy, rr);
      };
      let prev = at(0);
      for (let i = 1; i <= 64; i++) {
        const q = at((i / 64) * Math.PI * 2);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${(0.05 + q.depth * 0.25) * alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(prev.px, prev.py);
        ctx.lineTo(q.px, q.py);
        ctx.stroke();
        prev = q;
      }
      for (let k = 0; k < ring.nodes; k++) {
        const q = at(ring.phase + (k / ring.nodes) * Math.PI * 2);
        ctx.fillStyle = `rgba(190,230,255,${(0.35 + q.depth * 0.65) * alpha})`;
        ctx.beginPath();
        ctx.arc(q.px, q.py, 1.5 + q.depth * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private frame = () => {
    // Reduced motion: a slow, steady orb (a frame a few times a second, no sparks racing).
    this.t += this.reduce ? 0.25 : 1;
    const { ctx, cur } = this;
    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    const tgt = MOTION[this.state];
    const pal = PALETTE[this.look][this.state];
    cur.spin = lerp(cur.spin, tgt.spin, 0.05);
    cur.noise = lerp(cur.noise, tgt.noise, 0.05);
    cur.pulse = lerp(cur.pulse, tgt.pulse, 0.05);
    cur.glow = lerp(cur.glow, tgt.glow, 0.05);
    for (let i = 0; i < 3; i++) cur.color[i] = lerp(cur.color[i] ?? 0, pal[i] ?? 0, 0.06);
    this.mix = lerp(this.mix, this.look === "codex" ? 1 : 0, 0.06);
    this.smooth = lerp(this.smooth, this.level, 0.25);
    const lv = this.smooth;
    const t = this.t;

    ctx.clearRect(0, 0, this.w, this.h);
    const cx = this.w / 2;
    const cy = this.h / 2 - 8;
    const R = Math.min(this.w, this.h) * 0.32 * (1 + Math.sin(t * 0.05) * cur.pulse + lv * 0.18);
    const rgb = cur.color.map(Math.round);
    const [cr, cg, cb] = rgb;

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, R * 1.6));
    g.addColorStop(0, `rgba(${cr},${cg},${cb},${0.22 * cur.glow + lv * 0.25})`);
    g.addColorStop(0.45, `rgba(${cr},${cg},${cb},${0.07 * cur.glow})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R * 1.6), 0, Math.PI * 2);
    ctx.fill();

    this.rotY += cur.spin * (this.reduce ? 0.25 : 1) + lv * 0.01;
    ctx.globalCompositeOperation = "lighter";
    if (this.mix < 0.99) this.drawEmber(cx, cy, R, rgb, lv, 1 - this.mix);
    if (this.mix > 0.01) this.drawCodex(cx, cy, R, rgb, lv, this.mix);
    ctx.globalCompositeOperation = "source-over";

    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.22)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R * 1.55), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash(this.mix > 0.5 ? [8, 6, 2, 6] : [2, 10]);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R * 1.72), t * 0.004, t * 0.004 + Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.6)`;
    ctx.lineWidth = 2;
    const arc0 = -t * 0.01;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R * 1.55), arc0, arc0 + 0.6 + lv * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, R * 1.55), arc0 + Math.PI, arc0 + Math.PI + 0.35);
    ctx.stroke();
    for (let i = 0; i < 60; i++) {
      const ang = (i / 60) * Math.PI * 2;
      const r1 = R * 1.82;
      const r2 = r1 + (i % 5 === 0 ? 8 : 3);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${i % 5 === 0 ? 0.35 : 0.15})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
      ctx.stroke();
    }
    this.raf = requestAnimationFrame(this.frame);
  };
}
