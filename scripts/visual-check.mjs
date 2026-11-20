// Visual check of the command center against the reference images in
// docs/design/command-center: starts a throwaway local instance (sample data, a
// temporary data folder, a test password made up for this run only), creates a
// few sample projects, and screenshots each layout state on desktop and phone.
//   pnpm build && node scripts/visual-check.mjs [output folder]
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? path.join(root, "test-results", "visual");
mkdirSync(out, { recursive: true });
const port = 7431;
const data = mkdtempSync(path.join(os.tmpdir(), "dc-shots-"));
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
for (let i = 0; i < 60 && !existsSync(path.join(data, "setup-code.txt")); i++)
  await new Promise((r) => setTimeout(r, 250));
await new Promise((r) => setTimeout(r, 500));
const code = readFileSync(path.join(data, "setup-code.txt"), "utf8").trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1536, height: 1024 },
  serviceWorkers: "block",
});
const page = ctx.request;
const setup = await page.post(`${base}/api/auth/setup`, {
  data: { code, password: `visual-check-${Date.now()}` },
  headers: { origin: base },
});
if (!setup.ok()) throw new Error(`setup ${setup.status()} ${await setup.text()}`);
// Past the first-run welcome, so the pages below are the ones photographed.
await page.patch(`${base}/api/settings`, {
  data: { onboardingDone: true },
  headers: { origin: base },
});
await page.post(`${base}/api/demo/scenario`, {
  data: { scenario: "attention" },
  headers: { origin: base },
});
const mk = async (body) =>
  (await page.post(`${base}/api/projects`, { data: body, headers: { origin: base } })).json();
const p1 = await mk({
  name: "Audit Public Servers",
  summary: "Check external access, certificates, and security",
  icon: "shield",
  phase: "in-progress",
  related: [{ kind: "service", id: "caddy" }],
});
for (const t of [
  "Check public hostnames",
  "Verify TLS certificates",
  "Test private service restrictions",
  "Review router port forwards",
  "Generate security report",
]) {
  await page.post(`${base}/api/projects/${p1.id}/tasks`, {
    data: { title: t },
    headers: { origin: base },
  });
}
const d1 = await (await page.get(`${base}/api/projects/${p1.id}`)).json();
for (const t of d1.tasks.slice(0, 3))
  await page.patch(`${base}/api/projects/${p1.id}/tasks/${t.id}`, {
    data: { status: "done" },
    headers: { origin: base },
  });
await page.patch(`${base}/api/projects/${p1.id}/tasks/${d1.tasks[3].id}`, {
  data: { status: "doing" },
  headers: { origin: base },
});
await mk({
  name: "Improve Jellyfin",
  summary: "Build new libraries and fix slow starts",
  icon: "tv",
  phase: "planned",
  related: [{ kind: "service", id: "jellyfin" }],
});
await mk({
  name: "Fix Prowlarr indexers",
  summary: "Two indexers failing after a site move",
  icon: "film",
  phase: "investigating",
  related: [{ kind: "service", id: "prowlarr" }],
});
await mk({
  name: "Encrypted Backups",
  summary: "Verify storage, versioning, and a restore test",
  icon: "database",
  phase: "in-progress",
});
await mk({
  name: "Docker Network Maintenance",
  summary: "Apply a new address pool and restart Docker",
  icon: "box",
  phase: "blocked",
});

for (const c of [
  {
    name: "Router admin",
    kind: "login",
    tier: "protected",
    category: "Router",
    username: "admin",
    endpoint: "192.0.2.1",
    value: "example-only",
  },
  {
    name: "Prowlarr API key",
    kind: "api-key",
    tier: "automation",
    category: "Media",
    serviceId: "prowlarr",
    value: "example-only",
  },
  {
    name: "Proxy login",
    kind: "login",
    tier: "protected",
    category: "Proxies",
    username: "proxy",
    value: "example-only",
  },
]) {
  await page.post(`${base}/api/vault/secrets`, { data: c, headers: { origin: base } });
}
const shots = [
  ["01-dashboard", "/"],
  ["02-project-split", `/?project=${p1.id}`],
  ["03-service-split", "/?service=jellyfin"],
  ["04-projects", "/projects"],
  ["05-docker", "/docker"],
  ["09-vault", "/vault"],
];
const b = await browser.newContext({
  viewport: { width: 1536, height: 1024 },
  serviceWorkers: "block",
  storageState: await ctx.storageState(),
});
const p = await b.newPage();
for (const [name, url] of shots) {
  await p.goto(base + url);
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${out}/${name}.png` });
}
// Expanded chat over the dashboard.
await p.goto(base + "/");
await p.waitForTimeout(800);
await p.getByLabel("Ask about your homelab").click();
await p.waitForTimeout(600);
await p.screenshot({ path: `${out}/06-chat-expanded.png` });
// Phone.
const m = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2,
  serviceWorkers: "block",
  storageState: await ctx.storageState(),
  isMobile: true,
  hasTouch: true,
});
const mp = await m.newPage();
await mp.goto(base + "/");
await mp.waitForTimeout(1200);
await mp.screenshot({ path: `${out}/07-phone-home.png` });
await mp.goto(base + "/?service=jellyfin");
await mp.waitForTimeout(1200);
await mp.screenshot({ path: `${out}/08-phone-service.png` });
await browser.close();
server.kill();
console.log("done", out);
