/* global document, window */
// Layout check: page-level scrolling on the command center and desk.
// Starts a throwaway local instance (synthetic homelab, temporary data folder,
// a test password made up for this run only), adopts the synthetic systems,
// opens desk states, and reports document height against the window, plus
// screenshots. Fails (exit 1) when a desktop state scrolls the page.
//   pnpm build && node scripts/layout-check.mjs [output folder]
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? path.join(root, "test-results", "layout");
mkdirSync(out, { recursive: true });
const port = 7432;
const data = mkdtempSync(path.join(os.tmpdir(), "dc-layout-"));
const server = spawn(process.execPath, ["apps/server/dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    DC_PORT: String(port),
    DC_DATA_DIR: data,
    DC_KEY_DIR: data,
    DC_FAKE_DISCOVERY: "1",
    DC_MONITOR: "off",
    DC_BACKUPS: "off",
    DC_FAKE_AGENT: "1",
  },
  stdio: "ignore",
});
const base = `http://127.0.0.1:${port}`;
let failed = false;
try {
  for (let i = 0; i < 80 && !existsSync(path.join(data, "setup-code.txt")); i++)
    await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 500));
  const code = readFileSync(path.join(data, "setup-code.txt"), "utf8").trim();
  // CHROME=/usr/bin/google-chrome uses an installed Chrome instead of the bundled one.
  const browser = await chromium.launch(
    process.env.CHROME ? { executablePath: process.env.CHROME } : {},
  );
  const ctx = await browser.newContext({ serviceWorkers: "block" });
  const req = ctx.request;
  const h = { origin: base };
  const setup = await req.post(`${base}/api/auth/setup`, {
    data: { code, password: `layout-check-${Date.now()}` },
    headers: h,
  });
  if (!setup.ok()) throw new Error(`setup ${setup.status()}`);
  // Past the first-run welcome, so the pages below are the ones checked.
  await req.patch(`${base}/api/settings`, { data: { onboardingDone: true }, headers: h });
  const report = await (await req.post(`${base}/api/discovery/scan`, { headers: h })).json();
  await req.post(`${base}/api/discovery/adopt`, {
    headers: h,
    data: {
      reportId: report.id,
      selections: report.findings
        .filter((f) => f.selectedByDefault)
        .map((f) => ({ key: f.key, name: f.name })),
    },
  });
  const ws = await (await req.get(`${base}/api/workspace`)).json();
  const id = (name) => ws.services.find((s) => s.name === name)?.id;
  const svc = (n) => `service:${encodeURIComponent(id(n))}`;
  const states = [
    ["home", "/"],
    ["desk-one", `/?panels=${svc("qBittorrent")}`],
    ["desk-three", `/?panels=${[svc("qBittorrent"), svc("Sonarr"), svc("Radarr")].join(",")}`],
    ["desk-logs", `/?panels=${svc("Sonarr")}@logs`],
    ["services", "/services"],
  ];
  const sizes = [
    ["1440x900", 1440, 900, true],
    ["1280x720", 1280, 720, true],
    ["1920x1080", 1920, 1080, true],
    ["xrdp-1600x860", 1600, 860, true],
    ["phone", 412, 915, false],
  ];
  const page = await ctx.newPage();
  // A long main conversation, typed into the desk's chat like a person would.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?panels=${svc("Sonarr")}`);
  const box = page.getByLabel("Ask Dragon's Cave").first();
  for (let i = 0; i < 12; i++) {
    await box.click();
    await box.fill(`How are my servers doing, and what about Sonarr's queue? (${i + 1})`);
    await box.press("Enter");
    await page.waitForTimeout(1500);
  }
  states.push(["desk-long", `/?panels=${[svc("Sonarr"), svc("Radarr")].join(",")}`]);
  states.push(["home-long", "/"]);
  for (const [sname, w, hgt, desktop] of sizes) {
    await page.setViewportSize({ width: w, height: hgt });
    for (const [name, url] of states) {
      await page.goto(base + url);
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => ({
        doc: document.documentElement.scrollHeight,
        body: document.body.scrollHeight,
        win: window.innerHeight,
        mainOver: (() => {
          const m = document.getElementById("main");
          return m ? m.scrollHeight - m.clientHeight : 0;
        })(),
        tallest: [...document.querySelectorAll("body *")]
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter((x) => x.r.bottom > window.innerHeight + 4)
          .sort((a, b) => b.r.bottom - a.r.bottom)
          .slice(0, 3)
          .map(
            (x) =>
              `${x.e.tagName.toLowerCase()}${x.e.id ? "#" + x.e.id : ""}.${String(x.e.className).split(" ").slice(0, 4).join(".")} bottom=${Math.round(x.r.bottom)}`,
          ),
      }));
      const extra = m.doc - m.win;
      // Desktop: the page never scrolls; the desk also fits its area (other pages may scroll inside it).
      const bad = desktop && (extra > 2 || (name.startsWith("desk") && m.mainOver > 2));
      if (bad) failed = true;
      console.log(
        `${bad ? "SCROLLS" : "ok     "} ${sname.padEnd(14)} ${name.padEnd(11)} page ${m.doc}px / window ${m.win}px (+${extra}) content +${m.mainOver}${bad ? "  " + m.tallest.join(" | ") : ""}`,
      );
      await page.screenshot({ path: path.join(out, `${sname}-${name}.png`) });
    }
  }
  await browser.close();
} finally {
  server.kill();
  // The throwaway instance's data (sample systems, the made-up password) goes with it.
  await new Promise((r) => setTimeout(r, 500));
  rmSync(data, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
