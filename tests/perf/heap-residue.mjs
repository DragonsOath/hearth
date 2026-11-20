/* global history, dispatchEvent, PopStateEvent -- used inside page.evaluate, in the browser */
// Native panels Phase 1: what stays in the page's memory after panels are opened and closed many
// times. Takes a heap snapshot after a warm-up and another after N open/close cycles plus a wait
// past the data cache's lifetime, then compares them by object kind. Also searches both snapshots
// for the stand-in apps' key values, which must never reach the browser.
//
//   pnpm build && node tests/perf/heap-residue.mjs [--cycles 140] [--settle-min 6] [--history]
//
// --history keeps one browser history entry per open/close (as the desk does in real use);
// without it the cycles replace the current entry, which separates history from panel residue.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const CYCLES = Number(opt("--cycles", "140"));
const SETTLE_MIN = Number(opt("--settle-min", "6"));
const PUSH = args.includes("--history");
const PORT = Number(opt("--port", "7485"));
const OUT = opt("--out", "heap-residue.json");
const base = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "hearth-heap-"));
const KEYS = ["radarr", "sonarr", "prowlarr", "wizarr", "sabnzbd"].map((k) => `perf-${k}-key`);

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
    // Not up yet.
  }
  await sleep(500);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1600, height: 1000 } });
const req = ctx.request;
const code = readFileSync(path.join(dataDir, "setup-code.txt"), "utf8").trim();
await req.post("/api/auth/setup", { data: { code, password: "perf owner password" } });
await req.patch("/api/settings", { data: { onboardingDone: true } });
const ids = {};
for (const [key, name, port] of [
  ["radarr", "Radarr", 7878],
  ["sonarr", "Sonarr", 8989],
  ["prowlarr", "Prowlarr", 9696],
  ["wizarr", "Wizarr", 5690],
  ["sabnzbd", "SABnzbd", 8080],
]) {
  const r = await req.post("/api/services", {
    data: {
      name,
      kind: "web",
      address: `http://10.20.30.${40 + (port % 50)}:${port}`,
      category: "Downloads",
    },
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
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("HeapProfiler.enable");

async function snapshot() {
  for (let i = 0; i < 4; i++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(300);
  }
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  return JSON.parse(chunks.join(""));
}

/** Totals by "type:name" (count and self size), plus whether any key value is in the strings. */
function summarize(snap) {
  const f = snap.snapshot.meta.node_fields;
  const types = snap.snapshot.meta.node_types[0];
  const [iT, iN, iS] = ["type", "name", "self_size"].map((x) => f.indexOf(x));
  const by = new Map();
  let total = 0;
  for (let i = 0; i < snap.nodes.length; i += f.length) {
    const type = types[snap.nodes[i + iT]];
    const rawName = snap.strings[snap.nodes[i + iN]] ?? "";
    // Group strings and code by kind, not by content.
    const name =
      type === "string" || type === "concatenated string" || type === "sliced string"
        ? ""
        : type === "code"
          ? rawName.split(" ")[0]
          : rawName.slice(0, 80);
    const k = `${type}:${name}`;
    const e = by.get(k) ?? { count: 0, size: 0 };
    e.count++;
    e.size += snap.nodes[i + iS];
    total += snap.nodes[i + iS];
    by.set(k, e);
  }
  const keysFound = KEYS.filter((key) => snap.strings.some((s) => s.includes(key)));
  return { by, total, keysFound, retainers: retainersOf(snap, ["Response", "FetchResponseData"]) };
}

/** Who holds objects of these names (two levels up), to tell app code from tooling. */
function retainersOf(snap, names) {
  const f = snap.snapshot.meta.node_fields;
  const ef = snap.snapshot.meta.edge_fields;
  const types = snap.snapshot.meta.node_types[0];
  const [iT, iN, iE] = ["type", "name", "edge_count"].map((x) => f.indexOf(x));
  const iTo = ef.indexOf("to_node");
  const label = (n) =>
    `${types[snap.nodes[n + iT]]}:${(snap.strings[snap.nodes[n + iN]] ?? "").slice(0, 60)}`;
  const parents = new Map();
  let e = 0;
  for (let n = 0; n < snap.nodes.length; n += f.length) {
    const count = snap.nodes[n + iE];
    for (let k = 0; k < count; k++, e += ef.length) {
      const to = snap.edges[e + iTo];
      if (!parents.has(to)) parents.set(to, []);
      parents.get(to).push(n);
    }
  }
  const out = {};
  for (let n = 0; n < snap.nodes.length; n += f.length) {
    const name = snap.strings[snap.nodes[n + iN]];
    if (!names.includes(name)) continue;
    for (const p of parents.get(n) ?? []) {
      const ups = (parents.get(p) ?? []).slice(0, 3).map(label).join(" | ");
      const k = `${label(p)}  <-  ${ups}`;
      out[k] = (out[k] ?? 0) + 1;
    }
  }
  // One full chain from a held object up towards the roots, edge names included.
  const iEN = ef.indexOf("name_or_index");
  const iET = ef.indexOf("type");
  const edgeTypes = snap.snapshot.meta.edge_types[0];
  const edgeName = new Map();
  e = 0;
  for (let n = 0; n < snap.nodes.length; n += f.length) {
    const count = snap.nodes[n + iE];
    for (let k = 0; k < count; k++, e += ef.length) {
      const t = edgeTypes[snap.edges[e + iET]];
      const nm =
        t === "element" || t === "hidden"
          ? `[${snap.edges[e + iEN]}]`
          : snap.strings[snap.edges[e + iEN]];
      edgeName.set(`${n}>${snap.edges[e + iTo]}`, `${t}:${nm}`);
    }
  }
  const chains = [];
  for (let n = 0; n < snap.nodes.length && chains.length < 2; n += f.length) {
    if (snap.strings[snap.nodes[n + iN]] !== "Response" || types[snap.nodes[n + iT]] !== "native")
      continue;
    const chain = [label(n)];
    let cur = n;
    const seen = new Set([n]);
    for (let d = 0; d < 9; d++) {
      const ps = (parents.get(cur) ?? []).filter((p) => !seen.has(p));
      const p = ps.find((x) => !label(x).startsWith("native:Response")) ?? ps[0];
      if (p === undefined) break;
      chain.push(`${edgeName.get(`${p}>${cur}`) ?? "?"} <- ${label(p)}`);
      seen.add(p);
      cur = p;
    }
    chains.push(chain.join(" ⟵ "));
  }
  for (const c of chains) console.log(`chain: ${c}`);
  return Object.entries(out)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 12);
}

async function show(panels) {
  const url = panels.length
    ? `/?panels=${encodeURIComponent(panels.join(","))}&focus=${encodeURIComponent(panels[0])}`
    : "/";
  await page.evaluate(
    ([u, push]) => {
      if (push) history.pushState({}, "", u);
      else history.replaceState({}, "", u);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    [url, PUSH],
  );
}

await page.goto("/");
await page.waitForLoadState("networkidle").catch(() => {});
const sets = ["radarr", "sonarr", "prowlarr", "wizarr", "sabnzbd"].map((k) => [
  `service:${ids[k]}`,
]);
for (const s of sets) {
  await show(s);
  await sleep(1500);
  await show([]);
  await sleep(500);
}
await sleep(3000);
const before = summarize(await snapshot());
for (let i = 0; i < CYCLES; i++) {
  await show(sets[i % sets.length]);
  await sleep(1200);
  await show([]);
  await sleep(400);
}
await sleep(SETTLE_MIN * 60000);
const after = summarize(await snapshot());

const rows = [];
for (const [k, a] of after.by) {
  const b = before.by.get(k) ?? { count: 0, size: 0 };
  if (a.size - b.size !== 0 || a.count - b.count !== 0)
    rows.push({ kind: k, countDelta: a.count - b.count, sizeDelta: a.size - b.size });
}
for (const [k, b] of before.by)
  if (!after.by.has(k)) rows.push({ kind: k, countDelta: -b.count, sizeDelta: -b.size });
rows.sort((x, y) => y.sizeDelta - x.sizeDelta);
const report = {
  cycles: CYCLES,
  settleMinutes: SETTLE_MIN,
  history: PUSH,
  totalMB: {
    before: +(before.total / 1048576).toFixed(2),
    after: +(after.total / 1048576).toFixed(2),
  },
  keysInBrowserMemory: { before: before.keysFound, after: after.keysFound },
  topGrowth: rows.slice(0, 40),
  topShrink: rows.slice(-10),
};
writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log(
  `heap ${report.totalMB.before} -> ${report.totalMB.after} MB after ${CYCLES} cycles (${PUSH ? "with" : "without"} history entries)`,
);
console.log(
  `stand-in key values in browser memory: before ${before.keysFound.length}, after ${after.keysFound.length}`,
);
console.log("held by:");
for (const [k, n] of after.retainers) console.log(`  ${n}x  ${k}`);
for (const r of rows.slice(0, 25))
  console.log(
    `${String(r.sizeDelta).padStart(9)} B  ${String(r.countDelta).padStart(6)}  ${r.kind}`,
  );
await browser.close();
stop();
