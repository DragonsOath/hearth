import { chromium, defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

// E2E runs against the production build on its own ports with throwaway
// data dirs, so it never touches the dev database or a running instance.
const port = Number(process.env.DC_E2E_PORT || 7410);
// Workers re-read this file; the stamp travels in the environment so paths agree.
const stamp = (process.env.DC_E2E_STAMP ??= String(Date.now()));
const dataDir = path.join(tmpdir(), `dragon-control-e2e-${stamp}`);
// A second, unclaimed installation for the setup and sign-in journey.
const authPort = port + 1;
const authDataDir = path.join(tmpdir(), `dragon-control-e2e-auth-${stamp}`);

// Two more unclaimed installations for the first-run welcome (onboarding.spec.ts), one each
// for the desktop and phone runs, so each is claimed fresh, the way a new owner would.
const onboardPorts = { desktop: port + 2, mobile: port + 3 };
const onboardDirs = {
  desktop: path.join(tmpdir(), `dragon-control-e2e-welcome-desktop-${stamp}`),
  mobile: path.join(tmpdir(), `dragon-control-e2e-welcome-mobile-${stamp}`),
};
process.env.DC_E2E_WELCOME_DESKTOP = `${onboardPorts.desktop}|${onboardDirs.desktop}`;
process.env.DC_E2E_WELCOME_MOBILE = `${onboardPorts.mobile}|${onboardDirs.mobile}`;

// Another PC, not set up, that joins the main installation (devices.spec.ts: one account).
const pcPort = port + 4;
const pcDir = path.join(tmpdir(), `dragon-control-e2e-pc-${stamp}`);
process.env.DC_E2E_PC = `${pcPort}|${pcDir}`;

// The setup project reads the main server's one-time setup code from here.
process.env.DC_E2E_DATA_DIR = dataDir;
process.env.DC_E2E_AUTH_DATA_DIR = authDataDir;
const OWNER_STATE = "test-results/.auth/owner.json";

const serverEnv = (p: number, dir: string) => ({
  // Diagnostics only: where a long-held database transaction started (db/tx.ts).
  ...(process.env.DC_TX_DEBUG ? { DC_TX_DEBUG: process.env.DC_TX_DEBUG } : {}),
  NODE_ENV: "production",
  DC_PORT: String(p),
  DC_DATA_DIR: dir,
  // A stand-in add-on (the Premium split): one screen in Settings > Premium, nothing else.
  // The Premium repo runs its own browser tests against this core with DC_E2E_ADDONS_DIR set to a
  // folder holding its built package (and this stand-in).
  DC_ADDONS_DIR: process.env.DC_E2E_ADDONS_DIR ?? path.resolve("tests/e2e/fixtures/addons"),
  // Discovery scans a synthetic homelab, never the machine running the tests.
  DC_FAKE_DISCOVERY: "1",
  // Tests drive checks explicitly so nothing changes underneath an assertion.
  DC_MONITOR: "off",
  // Backups run when a test asks, not on a timer.
  DC_BACKUPS: "off",
  // A scripted stand-in for Claude Code, so tests never spend real usage.
  DC_FAKE_AGENT: "1",
  // Ember's Browser opens a page these tests serve on this machine (production never opens this
  // machine's own addresses), with Playwright's own Chromium wherever no browser is installed.
  DC_TEST_BROWSER_LOCAL: "1",
  // Remote Control (/rc) in the Lair against a stand-in session, never the Claude app.
  DC_TEST_REMOTE_CONTROL: "1",
  // A visible window can be asked for (45.19), and still starts headless in tests.
  DC_BROWSER_SCREEN: "1",
  DC_TEST_BROWSER_HEADLESS: "1",
  DC_BROWSER_PATH: process.env.DC_BROWSER_PATH ?? chromium.executablePath(),
  // Hearth's voice for Home Assistant listens on any free port, never a fixed one.
  DC_VOICE_SHARE_PORT: "0",
  // A stand-in Sonarr with state, so workspace plans run through the real operations.
  DC_FAKE_APPS: "1",
  DC_FAKE_MEMORY: "1",
  // Stand-in speech services (Whisper and Piper), so voice works without the GPU machine.
  DC_FAKE_VOICE: "1",
  // A simulated machine with RAID arrays (Storage > RAID / Arrays), never this machine's drives.
  DC_FAKE_RAID: "1",
  // Your Discord bot: a stand-in that answers like Discord (no real bot or token).
  DC_FAKE_DISCORD_BOT: "1",
  // Never asks GitHub for new releases (the update notice is tested with a stand-in).
  DC_UPDATE_CHECK: "off",
  // "Link to my Hearth" finds the main test Hearth, not whatever is on this machine's network.
  DC_FAKE_FIND: `http://127.0.0.1:${port}`,
});
// Chromium's fake microphone: a test tone, with the permission already granted.
const fakeMic = {
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
};

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  // Shared servers and databases: run serially so scenarios don't collide.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    // The app's service worker is tested on its own; elsewhere it would only add caching between tests.
    serviceWorkers: "block",
  },
  projects: [
    { name: "claim", testMatch: /claim\.setup\.ts/ },
    // The Premium add-on's own browser tests (DC_E2E_PREMIUM_SPECS: its tests/e2e folder).
    ...(process.env.DC_E2E_PREMIUM_SPECS
      ? [
          {
            name: "premium",
            testDir: process.env.DC_E2E_PREMIUM_SPECS,
            testMatch: /\.spec\.ts$/,
            dependencies: ["claim"],
            use: {
              ...devices["Desktop Chrome"],
              viewport: { width: 1440, height: 900 },
              storageState: OWNER_STATE,
            },
          },
        ]
      : []),
    {
      name: "desktop",
      testMatch:
        /(smoke|addons|systems|rules|onboarding|getting-started|plan|war-room|devices|updates|zones|panels|project-colors|panel-links|panel-branding|radarr-panel|sonarr-panel|prowlarr-panel|lidarr-panel|wizarr-panel|wizarr-setup|qbittorrent-settings|seerr-panel|jellyfin-panel|plex-panel|tautulli-panel|panel-swipe|ai-picture|lair-chat|lair-remote|todo-panel|qbittorrent-torrents|sabnzbd-downloads|romm-panel|immich-photos|immich-organize|immich-files|home-dashboard|home-widgets|home-music|home-calendar|home-scenes|home-speaker|home-weather|lair-arrange|edit-projects|memory|show-free|browser|forge-pick|forge-switch|blueprint|home-rows|manual-sort|audiobook-intake|download-health|premium|model-switch|curator|curator-for-you|ai-use|briefs|settings-fold|monitoring-tabs|notify-change|notify-broken|reload-on-update|pihole-panel|adguard-panel|proxmox-panel|npm-panel|traefik-panel|portainer-panel|uptimekuma-panel|generic-panel|custom-panels-free|deluge-panel|transmission-panel|nzbget-panel|emby-panel|nextcloud-panel|paperless-panel|vaultwarden-panel|tailscale-panel|wgeasy-panel|navidrome-panel|komga-panel|gitea-panel|mealie-panel|actual-panel|authentik-panel|frigate-panel|authelia-panel|sign-in-card|sign-in-plex|speaker-names|phone-fit|ember-mark|show-pause|screen-capture|crucible).spec\.ts/,
      dependencies: ["claim"],
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        storageState: OWNER_STATE,
        ...fakeMic,
      },
    },
    {
      name: "mobile",
      testMatch:
        /(smoke|addons|systems|rules|onboarding|getting-started|plan|project-colors|panel-branding|radarr-panel|sonarr-panel|prowlarr-panel|lidarr-panel|wizarr-panel|wizarr-setup|qbittorrent-settings|seerr-panel|jellyfin-panel|plex-panel|tautulli-panel|panel-swipe|ai-picture|lair-chat|lair-remote|todo-panel|qbittorrent-torrents|sabnzbd-downloads|romm-panel|immich-photos|immich-organize|immich-files|home-dashboard|home-widgets|home-music|home-calendar|home-scenes|home-speaker|home-weather|memory|show-free|browser|forge-pick|forge-switch|home-rows|manual-sort|audiobook-intake|download-health|premium|model-switch|curator|ai-use|briefs|settings-fold|monitoring-tabs|notify-change|notify-broken|reload-on-update|pihole-panel|adguard-panel|proxmox-panel|npm-panel|traefik-panel|portainer-panel|uptimekuma-panel|generic-panel|custom-panels-free|deluge-panel|transmission-panel|nzbget-panel|emby-panel|nextcloud-panel|paperless-panel|vaultwarden-panel|tailscale-panel|wgeasy-panel|navidrome-panel|komga-panel|gitea-panel|mealie-panel|actual-panel|authentik-panel|frigate-panel|authelia-panel|sign-in-card|sign-in-plex|speaker-names|phone-fit|phone-chat-room|ember-mark|curator-for-you|show-pause|touch-picker|screen-capture|crucible).spec\.ts/,
      dependencies: ["claim"],
      use: { ...devices["Pixel 7"], storageState: OWNER_STATE, ...fakeMic },
    },
    {
      // Passkeys need a secure context and a domain name, so this uses localhost.
      name: "auth",
      testMatch: /auth\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        baseURL: `http://localhost:${authPort}`,
      },
    },
  ],
  webServer: [
    {
      command: "node apps/server/dist/index.js",
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      env: serverEnv(port, dataDir),
    },
    {
      command: "node apps/server/dist/index.js",
      url: `http://127.0.0.1:${authPort}/api/health`,
      reuseExistingServer: false,
      env: serverEnv(authPort, authDataDir),
    },
    {
      command: "node apps/server/dist/index.js",
      url: `http://127.0.0.1:${pcPort}/api/health`,
      reuseExistingServer: false,
      env: serverEnv(pcPort, pcDir),
    },
    ...(["desktop", "mobile"] as const).map((device) => ({
      command: "node apps/server/dist/index.js",
      url: `http://127.0.0.1:${onboardPorts[device]}/api/health`,
      reuseExistingServer: false,
      env: serverEnv(onboardPorts[device], onboardDirs[device]),
    })),
  ],
});
