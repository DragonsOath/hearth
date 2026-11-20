// Native panels Phase 0: reproducible performance baseline for the Lair's panels
// (private/docs/HEARTH_NATIVE_PANELS_ARCHITECTURE.md, section 4a).
//
//   pnpm build && node tests/perf/panels-baseline.mjs [--cold] [--idle-min 10] [--out file.json]
//
// Starts a fresh Hearth with the stand-in apps on a free port, claims it, adds Radarr, Sonarr,
// Prowlarr, Wizarr and SABnzbd stand-ins, then drives Chromium and records, per scenario:
// requests per minute by endpoint, active intervals, DOM nodes, event listeners, and JS heap after
// forced garbage collection (several collections, settled minimum, because caches and lazy
// collection make one reading noisy). Nothing here talks to a real app.
/* global window, history, dispatchEvent, PopStateEvent -- used inside page.evaluate, in the browser */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const COLD = flag("--cold");
const IDLE_MIN = Number(opt("--idle-min", "10"));
const WINDOW_S = Number(opt("--window", "60"));
const OUT = opt("--out", `perf-panels-${COLD ? "cold" : "warm"}.json`);
const PORT = Number(opt("--port", "7480"));
const WIDTH = Number(opt("--width", "1600"));
const HEIGHT = Math.round(WIDTH * 0.625);
const base = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "hearth-perf-"));

const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    DC_PORT: String(PORT),
    DC_DATA_DIR: dataDir,
    DC_FAKE_DISCOVERY: "1",
    DC_FAKE_APPS: "1",
    DC_FAKE_AGENT: "1",
    DC_FAKE_VOICE: "1",
    DC_FAKE_RAID: "1",
    DC_MONITOR: "off",
    DC_BACKUPS: "off",
    DC_UPDATE_CHECK: "off",
    DC_VOICE_SHARE_PORT: "0",
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const stop = () => {
  try {
    server.kill();
  } catch {
    // Already gone.
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
};
process.on("exit", stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    // Already gone.
  }
  await sleep(500);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  baseURL: base,
  viewport: { width: WIDTH, height: HEIGHT },
  serviceWorkers: "block",
});
const req = ctx.request;
const code = readFileSync(path.join(dataDir, "setup-code.txt"), "utf8").trim();
await req.post("/api/auth/setup", { data: { code, password: "perf owner password" } });
await req.patch("/api/settings", { data: { onboardingDone: true } });

// Stand-in apps, each with a fake key, the way the browser tests add them.
const APPS = [
  ["radarr", "Radarr", "Downloads", 7878],
  ["sonarr", "Sonarr", "Downloads", 8989],
  ["prowlarr", "Prowlarr", "Downloads", 9696],
  ["wizarr", "Wizarr", "Media", 5690],
  ["sabnzbd", "SABnzbd", "Downloads", 8080],
];
const ids = {};
for (const [key, name, category, port] of APPS) {
  const r = await req.post("/api/services", {
    data: { name, kind: "web", address: `http://10.20.30.${40 + (port % 50)}:${port}`, category },
  });
  ids[key] = (await r.json()).id;
  await req.post("/api/vault/secrets", {
    data: {
      name: `${name} perf key`,
      kind: "api-key",
      tier: "automation",
      scope: "read",
      serviceId: ids[key],
      value: `perf-${key}-key`,
    },
  });
}

// Count intervals the page keeps alive (react-query refetchInterval, panel timers).
await ctx.addInitScript(() => {
  const live = new Set();
  const si = window.setInterval,
    ci = window.clearInterval;
  window.setInterval = (...a) => {
    const id = si(...a);
    live.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    live.delete(id);
    return ci(id);
  };
  window.__liveIntervals = () => live.size;
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
if (COLD) {
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
}

let counting = null;
page.on("request", (r) => {
  if (!counting) return;
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/api/")) return;
  const k = u.pathname.replace(/\/[0-9a-f-]{8,}(?=\/|$)/g, "/:id");
  counting[k] = (counting[k] ?? 0) + 1;
});

async function metrics() {
  const heaps = [];
  for (let i = 0; i < 4; i++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(300);
    const m = Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]),
    );
    heaps.push(m.JSHeapUsedSize);
    if (i === 3) {
      return {
        heapMB: +(Math.min(...heaps) / 1048576).toFixed(2),
        nodes: m.Nodes,
        listeners: m.JSEventListeners,
        documents: m.Documents,
        intervals: await page.evaluate(() => window.__liveIntervals?.() ?? -1),
      };
    }
  }
}

/** Same-page navigation (no reload), the way the desk changes panels. */
async function show(panels, focus) {
  const q = panels.length
    ? `?panels=${encodeURIComponent(panels.join(","))}${focus ? `&focus=${encodeURIComponent(focus)}` : ""}`
    : "/";
  await page.evaluate(
    (url) => {
      history.pushState({}, "", url);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    q.startsWith("?") ? `/${q}` : q,
  );
}

async function windowed(label, seconds = WINDOW_S) {
  await sleep(3000); // let the view settle and do its first loads
  counting = {};
  await sleep(seconds * 1000);
  const reqs = counting;
  counting = null;
  const total = Object.values(reqs).reduce((a, b) => a + b, 0);
  const m = await metrics();
  const row = {
    label,
    seconds,
    requestsPerMin: +((total * 60) / seconds).toFixed(1),
    byEndpoint: reqs,
    ...m,
  };
  console.log(
    `${label.padEnd(34)} req/min ${String(row.requestsPerMin).padStart(6)}  heap ${m.heapMB} MB  nodes ${m.nodes}  listeners ${m.listeners}  intervals ${m.intervals}`,
  );
  return row;
}

const svc = (k) => `service:${ids[k]}`;
const report = {
  width: WIDTH,
  at: new Date().toISOString(),
  cold: COLD,
  windowSeconds: WINDOW_S,
  commit: process.env.PERF_COMMIT ?? null,
  scenarios: [],
  cycles: [],
  idle: [],
};

await page.goto("/");
await page.waitForLoadState("networkidle").catch(() => {});
report.scenarios.push(await windowed("home, no panels"));

await show([svc("radarr")], svc("radarr"));
await page
  .getByTestId("arr-dashboard")
  .or(page.locator("[data-testid$='-dashboard']").first())
  .waitFor({ timeout: 30000 })
  .catch(() => {});
report.scenarios.push(await windowed("1 panel (Radarr)"));

const four = ["radarr", "sonarr", "prowlarr", "wizarr"].map(svc);
await show(four, four[0]);
const slots = await page
  .locator("[data-slots]")
  .first()
  .getAttribute("data-slots")
  .catch(() => null);
report.slots = slots;
console.log(`desk shows ${slots} panel(s) side by side at ${WIDTH} px`);
report.scenarios.push(await windowed("4 panels open"));

// Covered panels: expand one so the other three are hidden behind it.
const expand = page.getByRole("button", { name: "Expand panel" }).first();
if (await expand.isVisible().catch(() => false)) {
  await expand.click();
  report.scenarios.push(await windowed("4 panels, 1 expanded (3 covered)"));
  await page
    .getByRole("button", { name: "Restore panels" })
    .first()
    .click()
    .catch(() => {});
} else
  report.scenarios.push({
    label: "4 panels, 1 expanded (3 covered)",
    skipped: "no Expand button found",
  });

const six = [...four, svc("sabnzbd"), "tool:storage"];
await show(six, six[0]);
report.scenarios.push(await windowed("6 panels (5 apps + Storage)"));

// Open/close cycles: does anything stay behind after a panel closes?
async function cycles(label, n, sets) {
  await show([]);
  await sleep(2000);
  for (const s of sets) {
    await show(s, s[0]);
    await sleep(1500);
    await show([]);
    await sleep(500);
  } // warm-up
  await sleep(2000);
  const before = await metrics();
  for (let i = 0; i < n; i++) {
    const s = sets[i % sets.length];
    await show(s, s[0]);
    await sleep(1200);
    await show([]);
    await sleep(400);
  }
  await sleep(3000);
  counting = {};
  await sleep(30000);
  const after30 = counting;
  counting = null;
  const after = await metrics();
  const row = {
    label,
    n,
    before,
    after,
    requestsPerMinAfterClose: Object.values(after30).reduce((a, b) => a + b, 0) * 2,
    byEndpointAfterClose: after30,
  };
  console.log(
    `${label.padEnd(34)} heap ${before.heapMB} -> ${after.heapMB} MB  nodes ${before.nodes} -> ${after.nodes}  listeners ${before.listeners} -> ${after.listeners}  intervals ${before.intervals} -> ${after.intervals}  req/min after ${row.requestsPerMinAfterClose}`,
  );
  return row;
}
report.cycles.push(await cycles("same panel x20", 20, [[svc("radarr")]]));
report.cycles.push(await cycles("same panel x50", 50, [[svc("radarr")]]));
const rotate = ["radarr", "sonarr", "prowlarr", "wizarr", "sabnzbd"].map((k) => [svc(k)]);
report.cycles.push(await cycles("different panels x20", 20, rotate));
report.cycles.push(await cycles("different panels x50", 50, rotate));

// After the cycles: everything closed, wait past the data cache's 5-minute lifetime, then measure.
// Separates cached data (released after expiry) from a leak (still held).
const SETTLE_MIN = Number(opt("--settle-min", "6"));
if (SETTLE_MIN > 0) {
  await show([]);
  const before = await metrics();
  await sleep(SETTLE_MIN * 60000);
  const after = await metrics();
  report.settle = { minutes: SETTLE_MIN, before, after };
  console.log(
    `closed ${SETTLE_MIN} min (cache expiry)    heap ${before.heapMB} -> ${after.heapMB} MB  nodes ${before.nodes} -> ${after.nodes}  intervals ${before.intervals} -> ${after.intervals}`,
  );
}

if (IDLE_MIN > 0) {
  await show(four, four[0]);
  for (let m = 1; m <= IDLE_MIN; m++) {
    const row = await windowed(`idle 4 panels, minute ${m}`, 57);
    report.idle.push({
      minute: m,
      requestsPerMin: row.requestsPerMin,
      heapMB: row.heapMB,
      nodes: row.nodes,
      listeners: row.listeners,
      intervals: row.intervals,
    });
  }
}

await page.screenshot({ path: OUT.replace(/\.json$/, ".png") });
writeFileSync(OUT, JSON.stringify(report, null, 1));
await browser.close();
stop();
console.log(`saved ${OUT}`);
