import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  ACTIONS,
  VPN_PROVIDERS,
  recommendBuild,
  type BuildAnswers,
  type GoalDecisions,
  type HomelabBuild,
  type HomelabStep,
  type HomelabStepId,
  type HostScan,
  type JobStepInput,
  type Requester,
  type StepChange,
  type VpnProvider,
  VPN_LOGIN_PAGES,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import type { Vault } from "../auth/vault";
import type { Elevation } from "../admin/elevation";
import type { Runner } from "../admin/host";
import { applyCompose } from "../admin/protected";
import type { Jobs } from "../jobs/engine";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { getSetting, setSetting } from "../store/settings";
import {
  NETWORK,
  RECIPES,
  RECIPE_IDS,
  WIREGUARD_ONLY,
  internalHost,
  type RecipeContext,
  type RecipeId,
} from "./recipes";
import {
  SetupError,
  arrKey,
  connectDownloadClient,
  connectProwlarrApp,
  connectSeerrArr,
  setupArr,
  setupJellyfin,
  setupQbittorrent,
  setupPlexLibraries,
  setupSeerr,
  type SetupDeps,
  waitForApp,
} from "./setup";

/**
 * "Build my plan" (docs/design/BUILDER.md): the saved homelab plan, built one approved step at a
 * time. The order is fixed: Docker, then each app from Hearth's recipe with its account, then the
 * connections between them, then Tailscale. Ember proposes the next step (homelab_build); the
 * step's details come from here, never from the AI, and every step is a plan the owner approves
 * the usual way. Docker, Tailscale and the VPN are protected: approving asks them to confirm it's
 * them. Logins and keys go straight into Secure Vault; the AI never sees one.
 */

const THIS_HOST = "this-host";
const SETTING = "homelab_build" as const;

const STEP_INFO: Record<HomelabStepId, { name: string; what: string }> = {
  docker: { name: "Docker", what: "The engine every app runs in." },
  jellyfin: { name: "Jellyfin", what: "Your movies and shows, on every screen." },
  plex: { name: "Plex", what: "Your movies and shows, on every screen, with your Plex account." },
  seerr: { name: "Seerr", what: "Browse and request movies and shows." },
  radarr: { name: "Radarr", what: "Fetches the movies you ask for." },
  sonarr: { name: "Sonarr", what: "Fetches the shows you ask for." },
  prowlarr: { name: "Prowlarr", what: "Where Radarr and Sonarr search (you add the sites)." },
  qbittorrent: { name: "qBittorrent with your VPN", what: "Downloads, always through your VPN." },
  connect: {
    name: "Connect the apps",
    what: "Seerr, Radarr, Sonarr, Prowlarr and qBittorrent talk to each other.",
  },
  tailscale: { name: "Tailscale", what: "Reach your apps from anywhere, privately." },
};

interface Ledger {
  steps: Partial<
    Record<
      HomelabStepId,
      { jobId?: string; done?: string; detail?: string; confirmedByOwner?: boolean }
    >
  >;
  /** Vault ids of each app's login and API key. */
  secrets: Partial<Record<RecipeId, { login?: string; key?: string }>>;
  vpn?: { provider: VpnProvider; type: "openvpn" | "wireguard"; ids: Record<string, string> };
  tailscaleUrl?: string;
  conversationId?: string;
}

interface SavedPlan {
  answers: BuildAnswers;
  scan?: HostScan;
  chosen: Record<string, string>;
  removed: string[];
  decisions?: GoalDecisions;
}

interface Accounts {
  email: string;
  username: string;
  passwords: "generate" | "own";
  secretId?: string;
}

export interface HomelabBuildDeps {
  handle: DbHandle;
  vault: Vault;
  elevation: Elevation;
  run: Runner;
  jobs: () => Jobs | undefined;
  /** Where the apps' folders go (each app gets <root>/<app>). */
  appsRoot: string;
  /** This Hearth's release folder and service, for the one command that sets up the helper. */
  install: { dir: string; service: string; userService: boolean };
  /** Hearth starts watching the new apps (a discovery scan, adopting them). */
  adopt?: (containers: string[]) => Promise<Record<string, string>>;
  setup?: SetupDeps;
  platform?: NodeJS.Platform;
  wait?: (ms: number) => Promise<void>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

/** The plan's starter apps, as the plan page shows them in "Your homelab". */
export function planOf(saved: SavedPlan) {
  return saved.scan
    ? recommendBuild(
        saved.answers,
        saved.scan,
        saved.chosen ?? {},
        saved.removed ?? [],
        saved.decisions ?? {},
      )
    : undefined;
}

export function starterApps(
  saved: SavedPlan,
  opts: { elsewhere?: boolean } = {},
): { id: string; name: string; installed: boolean; elsewhere: boolean }[] {
  const plan = planOf(saved);
  if (!plan) return [];
  return plan.capabilities
    .filter((c) => c.starter)
    .flatMap((c) => c.apps)
    .filter((a) => !(saved.removed ?? []).includes(a.id) && (opts.elsewhere || !a.elsewhere))
    .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i)
    .map((a) => ({
      id: a.id,
      name: a.name,
      installed: Boolean(a.installed),
      elsewhere: Boolean(a.elsewhere),
    }));
}

/** The drive with their movies and shows: the one with the most videos, never the system drive. */
export function mediaDrive(scan: HostScan | undefined, home = os.homedir()): string {
  const disks = (scan?.disks ?? []).filter((d) => d.name !== "/" && !/^[A-Z]:\\?$/i.test(d.name));
  const best = [...disks].sort(
    (a, b) => (b.media?.videos ?? 0) - (a.media?.videos ?? 0) || b.freeBytes - a.freeBytes,
  )[0];
  return best?.name ?? path.join(home, "Media");
}

/** Their movies and shows folders on the drive (found by name), or the ones Hearth will make. */
export async function mediaFolders(drive: string) {
  const look = async (dir: string) =>
    (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  const top = await look(drive);
  const second = (await Promise.all(top.map(look))).flat();
  const find = (re: RegExp) => [...top, ...second].find((d) => re.test(path.basename(d)));
  const movies = find(/^(movies?|films?)$/i);
  const shows = find(/^(tv|tv[ _-]?shows?|shows?|series|television)$/i);
  return {
    movies: movies ?? path.join(drive, "Movies"),
    shows: shows ?? path.join(drive, "Shows"),
    foundMovies: Boolean(movies),
    foundShows: Boolean(shows),
    downloads: path.join(drive, "Downloads"),
  };
}

/** A port something already listens on, on this computer. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.setTimeout(1_000);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(false));
  });
}

/** The admin helper's source, for anyone checking what it can do before setting it up. */
export const HELPER_SOURCE_URL =
  "https://github.com/DragonsOath/hearth/tree/main/apps/server/src/elevated";

/** Whether an app answers on its address at all (any answer below a server error), quickly. */
async function answers(url: string, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(url, { signal: AbortSignal.timeout(3_000), redirect: "manual" });
    return r.status < 500;
  } catch {
    return false;
  }
}

/**
 * Why the VPN did not come up, from Gluetun's own log, in plain words: the provider refused the
 * login (the usual one: the account sign-in instead of the VPN's own pair), or a WireGuard key it
 * did not accept. Undefined when the log does not say.
 */
export function vpnWhy(log: string, provider?: VpnProvider): string | undefined {
  const name = provider ? VPN_PROVIDERS[provider].name : "Your VPN";
  const page = provider ? VPN_LOGIN_PAGES[provider] : undefined;
  if (/AUTH_FAILED|auth(entication)? failed/i.test(log))
    return `${name} turned down the VPN login, so qBittorrent was not started (nothing downloads without the VPN). ${name}'s VPN connections use their own username and password, a separate pair from the one you sign in to ${name} with${page ? `: ${page.where} (${page.url})` : ""}. Put that pair in "Your VPN login" on the plan page, and Hearth tries again.`;
  if (/handshake did not complete|wireguard.*(key|handshake)/i.test(log))
    return `${name} did not accept the WireGuard key, so qBittorrent was not started (nothing downloads without the VPN). Make a new WireGuard configuration in your ${name} account and put its private key in "Your VPN login" on the plan page.`;
  return undefined;
}

export class HomelabBuilder {
  constructor(private readonly d: HomelabBuildDeps) {}

  private get db() {
    return this.d.handle.db;
  }

  private async ledger(): Promise<Ledger> {
    const l = (await getSetting(this.db, SETTING)) as Ledger | undefined;
    return { steps: {}, secrets: {}, ...(l ?? {}) };
  }

  private async save(change: (l: Ledger) => void) {
    const l = await this.ledger();
    change(l);
    await setSetting(this.db, SETTING, l);
  }

  private async plan(): Promise<SavedPlan | undefined> {
    return (await getSetting(this.db, "homelab_plan")) as SavedPlan | undefined;
  }

  private async accounts(): Promise<Accounts | undefined> {
    return (await getSetting(this.db, "homelab_accounts")) as Accounts | undefined;
  }

  /** The conversation the build is talked through in (its plans are posted there). */
  async conversation(): Promise<string | undefined> {
    return (await this.ledger()).conversationId;
  }

  async setConversation(id: string) {
    await this.save((l) => {
      l.conversationId = id;
    });
  }

  private async dockerReady(): Promise<boolean> {
    const v = await this.d
      .run("docker", ["version", "--format", "{{.Server.Version}}"], 20_000)
      .catch(() => ({ code: 1, out: "" }));
    if (v.code !== 0) return false;
    const c = await this.d.run("docker", ["compose", "version", "--short"], 20_000).catch(() => ({
      code: 1,
      out: "",
    }));
    return c.code === 0;
  }

  private async dockerInstalled(): Promise<boolean> {
    return (
      (await this.d.run("docker", ["--version"], 10_000).catch(() => ({ code: 1, out: "" })))
        .code === 0
    );
  }

  /** The one command that sets up (or widens) the admin helper, for this installation. */
  async helperCommand(): Promise<string> {
    const st = await this.d.elevation.state();
    const script = path.posix.join(
      this.d.install.dir.replaceAll("\\", "/"),
      "deploy/linux/install-elevation.sh",
    );
    const ops = st.status
      ? "--add-operation build"
      : "--operations docker.install,tailscale.install";
    return `sudo bash ${JSON.stringify(script)} --service ${this.d.install.service}${this.d.install.userService ? " --user-service" : ""} ${ops}`;
  }

  /**
   * Docker or Tailscale, the first time a plan needs it and the admin helper is not set up: the
   * reason, what the helper could do, and the vendor's own commands to run once instead.
   */
  private async helperNeed(
    app: "docker" | "tailscale",
  ): Promise<{ detail: string; need: Extract<HomelabStep["need"], { kind: "helper" }> }> {
    const command = await this.helperCommand();
    const helper = {
      can: [
        "Install Docker Engine and Compose from Docker's own package repository, and let Hearth's account use Docker",
        "Install Tailscale from Tailscale's own package repository",
      ],
      source: HELPER_SOURCE_URL,
    };
    if (app === "docker") {
      const installed = await this.dockerInstalled();
      const reason = installed
        ? "Docker is on this computer, but Hearth's account can't use it yet. Giving it access needs administrator rights, which Hearth's own account doesn't have."
        : "Your plan's apps run in Docker, and Docker isn't on this computer yet. Installing it needs administrator rights, which Hearth's own account doesn't have.";
      return {
        detail: `${reason} Choose one of the two ways below, then come back.`,
        need: {
          kind: "helper",
          command,
          reason,
          helper,
          yourself: {
            commands: [
              ...(installed ? [] : ["curl -fsSL https://get.docker.com | sudo sh"]),
              "sudo usermod -aG docker $USER",
            ],
            after:
              "Then restart this computer, so Hearth's account can use Docker. Hearth sees it and moves on.",
            docs: "https://docs.docker.com/engine/install/",
          },
        },
      };
    }
    const reason =
      "Your plan includes Tailscale, for reaching Hearth away from home, and it isn't on this computer yet. Installing it needs administrator rights, which Hearth's own account doesn't have.";
    return {
      detail: `${reason} Choose one of the two ways below, then come back.`,
      need: {
        kind: "helper",
        command,
        reason,
        helper,
        yourself: {
          commands: ["curl -fsSL https://tailscale.com/install.sh | sh", "sudo tailscale up"],
          after:
            "The second command prints a link: open it and sign in to Tailscale. Hearth sees it running and moves on.",
          docs: "https://tailscale.com/kb/1031/install-linux",
        },
      },
    };
  }

  private async tailscaleState(): Promise<"running" | "needs-login" | "absent"> {
    const r = await this.d.run("tailscale", ["status", "--json"], 15_000).catch(() => ({
      code: 127,
      out: "",
    }));
    if (r.code === 127 || (!r.out && r.code !== 0)) return "absent";
    try {
      const s = JSON.parse(r.out) as { BackendState?: string };
      return s.BackendState === "Running" ? "running" : "needs-login";
    } catch {
      return "needs-login";
    }
  }

  /** Where the build stands: every step in order, what each needs, and the next one. */
  async status(): Promise<HomelabBuild> {
    const saved = await this.plan();
    const accounts = await this.accounts();
    const ledger = await this.ledger();
    const platform = this.d.platform ?? process.platform;
    const apps = saved ? starterApps(saved) : [];
    const ids = new Set(apps.map((a) => a.id));
    const installed = new Set(apps.filter((a) => a.installed).map((a) => a.id));
    const wanted: HomelabStepId[] = [];
    const recipeApps = RECIPE_IDS.filter((r) => ids.has(r));
    // Seerr signs in with the media server: Jellyfin built here, or Plex (here or elsewhere).
    const all = saved ? starterApps(saved, { elsewhere: true }) : [];
    const plexAnywhere = all.some((a) => a.id === "plex");
    const usable = recipeApps.filter((r) => r !== "seerr" || ids.has("jellyfin") || plexAnywhere);
    if (usable.length) wanted.push("docker", ...usable);
    if (
      usable.filter((r) => r !== "jellyfin" && r !== "plex").length >= 2 ||
      (ids.has("plex") && usable.length >= 1)
    )
      wanted.push("connect");
    if (ids.has("tailscale")) wanted.push("tailscale");
    const covered = new Set<string>([...usable, "tailscale"]);
    const notBuilt = apps
      .filter((a) => !covered.has(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        why:
          a.id === "seerr"
            ? "Needs a media server to sign in with (Jellyfin or Plex)."
            : "Hearth doesn't set this one up yet. Ask Ember to help you with it.",
      }));

    const blocker = !saved
      ? "There is no saved plan yet: make one first."
      : !saved.scan
        ? "The plan has no look at this computer yet."
        : !accounts
          ? "Save your account details first (Your accounts, on the plan page)."
          : platform !== "linux"
            ? "Building the plan is ready on Linux. On Windows, Hearth plans it with you, and Ember can help you set the apps up by hand for now."
            : undefined;

    const jobs = this.d.jobs();
    const docker = wanted.includes("docker") ? await this.dockerReady() : false;
    const cover = await this.d.elevation.covers("docker.install");
    const tsCover = await this.d.elevation.covers("tailscale.install");
    const ts = wanted.includes("tailscale") ? await this.tailscaleState() : "absent";
    const steps: HomelabStep[] = [];
    let earlierPending = false;
    for (const id of wanted) {
      const rec = ledger.steps[id] ?? {};
      const base = { id, ...STEP_INFO[id] };
      let step: HomelabStep | undefined;
      const job = rec.jobId && jobs ? await jobs.get(rec.jobId).catch(() => undefined) : undefined;
      const done =
        (id === "docker" && docker) ||
        (id === "tailscale" && ts === "running") ||
        (id !== "docker" && id !== "tailscale" && (Boolean(rec.done) || installed.has(id)));
      const signIn =
        done && !installed.has(id) ? await this.signInNeeded(id, ids.has("jellyfin")) : undefined;
      if (signIn)
        step = {
          ...base,
          status: "needs-you",
          detail: signIn.detail,
          need: { kind: "open-app", url: signIn.url, label: signIn.label },
        };
      else if (done)
        step = {
          ...base,
          status: "done",
          ...(rec.detail || installed.has(id)
            ? { detail: rec.detail ?? "Already on this computer." }
            : {}),
          ...(rec.confirmedByOwner ? { confirmedByOwner: true } : {}),
        };
      else if (job?.status === "awaiting-approval")
        step = {
          ...base,
          status: "awaiting-approval",
          jobId: job.id,
          detail: "Waiting for your OK.",
        };
      else if (job?.status === "running")
        step = { ...base, status: "running", jobId: job.id, detail: "Under way now." };
      else if (id === "tailscale" && job?.status === "succeeded")
        step = {
          ...base,
          status: "needs-you",
          jobId: job.id,
          detail: "Installed. Sign in to Tailscale to connect this computer.",
          need: {
            kind: "tailscale-login",
            ...(ledger.tailscaleUrl ? { url: ledger.tailscaleUrl } : {}),
          },
        };
      else if (blocker) step = { ...base, status: "waiting", detail: blocker };
      else if (id === "qbittorrent" && !ledger.vpn)
        step = {
          ...base,
          status: "needs-you",
          detail: "Add your VPN login (any time), so qBittorrent downloads only through it.",
          need: {
            kind: "vpn-login",
            ...(saved?.answers.existingVpn && saved.answers.existingVpn in VPN_PROVIDERS
              ? { provider: saved.answers.existingVpn as VpnProvider }
              : {}),
          },
        };
      else if (earlierPending)
        step = { ...base, status: "waiting", detail: "After the steps above." };
      else if ((id === "docker" && !cover.ok) || (id === "tailscale" && !tsCover.ok))
        step = {
          ...base,
          status: "needs-you",
          ...(await this.helperNeed(id === "docker" ? "docker" : "tailscale")),
        };
      else if (job && ["failed", "rolled-back", "interrupted", "refused"].includes(job.status))
        step = {
          ...base,
          status: "failed",
          jobId: job.id,
          detail: job.summary ?? job.steps.find((s) => s.result)?.result ?? "It did not finish.",
          // The app runs and answers anyway: Hearth's own check may be what failed (11-22).
          ...((RECIPE_IDS as readonly string[]).includes(id) &&
          (await answers(RECIPES[id as RecipeId].local, this.d.setup?.fetch))
            ? { answering: true }
            : {}),
        };
      else step = { ...base, status: "ready" };
      if (step.status !== "done" && id !== "tailscale") earlierPending = true;
      if (id === "docker" && step.status !== "done") earlierPending = true;
      steps.push(step);
    }
    // Each app's own address, for its Open button (Hearth opens it in its own window).
    for (const s of steps)
      if ((RECIPE_IDS as readonly string[]).includes(s.id) && s.status !== "waiting")
        s.url = `http://${os.hostname()}:${RECIPES[s.id as RecipeId].port}`;
    const next = steps.find((s) => s.status === "ready" || s.status === "failed")?.id;
    const drive = saved?.scan ? mediaDrive(saved.scan) : undefined;
    // Why downloading is or isn't set up, from the saved plan (Ember explains it when asked).
    const plan = saved ? planOf(saved) : undefined;
    const request = plan?.requirements.find((r) => r.id === "want:request");
    const downloads = {
      setUp: ids.has("qbittorrent"),
      wanted: Boolean(request),
      ...(request && !ids.has("qbittorrent") ? { why: request.reason } : {}),
      vpn: saved?.answers.existingVpn ?? "not asked",
      keepItFree: saved?.answers.budget === "free",
    };
    return {
      steps,
      downloads,
      ...(next ? { next } : {}),
      notBuilt,
      appsFolder: this.d.appsRoot,
      ...(drive ? { drive } : {}),
      ...(blocker ? { blocker } : {}),
      ...(ledger.conversationId ? { conversationId: ledger.conversationId } : {}),
      ...(accounts ? { passwords: accounts.passwords, username: accounts.username } : {}),
      done: steps.length > 0 && steps.every((s) => s.status === "done"),
    };
  }

  /** Plex's own token, once the owner signed in to the server Hearth set up (Preferences.xml). */
  async plexToken(): Promise<string | undefined> {
    const prefs = path.join(
      this.d.appsRoot,
      "plex",
      "config",
      "Library",
      "Application Support",
      "Plex Media Server",
      "Preferences.xml",
    );
    const xml = await fs.readFile(prefs, "utf8").catch(() => "");
    return /PlexOnlineToken="([^"]+)"/.exec(xml)?.[1];
  }

  /** Seerr's own settings: its API key, and whether the owner finished its first page. */
  private async seerrSettings() {
    const raw = await fs
      .readFile(path.join(this.d.appsRoot, "seerr", "config", "settings.json"), "utf8")
      .catch(() => "");
    try {
      const j = JSON.parse(raw) as {
        main?: { apiKey?: string };
        public?: { initialized?: boolean };
      };
      return { apiKey: j.main?.apiKey, initialized: Boolean(j.public?.initialized) };
    } catch {
      return { apiKey: undefined, initialized: false };
    }
  }

  /** A step that runs but waits for the owner to sign in on the app's own page. */
  private async signInNeeded(id: HomelabStepId, jellyfin: boolean) {
    if (id === "plex" && !(await this.plexToken()))
      return {
        detail:
          "Running. Open Plex and sign in with your Plex account: that makes this server yours. Then come back.",
        url: `http://${os.hostname()}:32400/web`,
        label: "Sign in to Plex",
      };
    if (id === "seerr" && !jellyfin && !(await this.seerrSettings()).initialized)
      return {
        detail:
          "Running. Open Seerr and choose Sign in with Plex, then pick your Plex server and its libraries. Then come back.",
        url: `http://${os.hostname()}:5055`,
        label: "Sign in to Seerr with Plex",
      };
    return undefined;
  }

  /**
   * The owner said yes to downloads after all (they'll get a VPN): the saved plan now includes
   * them, so the request apps join the build, and qBittorrent still waits for the VPN login.
   */
  async addDownloads() {
    const saved = (await getSetting(this.db, "homelab_plan")) as
      (SavedPlan & Record<string, unknown>) | undefined;
    if (!saved) throw new SetupError("There is no saved plan yet.");
    await setSetting(this.db, "homelab_plan", {
      ...saved,
      chosen: { ...(saved.chosen ?? {}), downloads: "yes", "vpn-needed": "get" },
    } as never);
    return this.status();
  }

  /** Proposes one step as a plan the owner approves (the next one unless another is named). */
  async propose(
    id: HomelabStepId | undefined,
    opts: { requestedBy: Requester; conversationId?: string },
  ) {
    const jobs = this.d.jobs();
    if (!jobs) throw new SetupError("Plans are not available here.");
    const st = await this.status();
    const want = id ?? st.next;
    const step = st.steps.find((s) => s.id === want);
    if (!step)
      throw new SetupError(
        want ? `"${want}" is not a step of this plan.` : (st.blocker ?? "Every step is done."),
      );
    if (step.status === "awaiting-approval" && step.jobId) return jobs.get(step.jobId);
    if (step.status !== "ready" && step.status !== "failed")
      throw new SetupError(`${step.name}: ${step.detail ?? step.status}`);
    const kind: JobStepInput["kind"] =
      want === "docker"
        ? "build-docker"
        : want === "tailscale"
          ? "build-tailscale"
          : want === "connect"
            ? "build-connect"
            : "build-app";
    const title = `Your homelab: ${want === "connect" ? "connect the apps" : want === "docker" ? "install Docker" : want === "tailscale" ? "install Tailscale" : `set up ${step.name}`}`;
    const job = await jobs.create({
      title,
      reason: `The next step of your homelab plan: ${step.what}`,
      impact:
        want === "docker"
          ? "Docker is installed and this account can use it."
          : want === "tailscale"
            ? "Tailscale is installed; you sign in to it to connect this computer."
            : want === "connect"
              ? "Your apps are connected to each other."
              : `${step.name} runs on this computer, with your account in it.`,
      steps: [{ kind, serviceId: THIS_HOST, params: kind === "build-app" ? { app: want! } : {} }],
      requestedBy: opts.requestedBy,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    });
    await this.save((l) => {
      l.steps[want!] = { ...(l.steps[want!] ?? {}), jobId: job.id };
      if (opts.conversationId && !l.conversationId) l.conversationId = opts.conversationId;
    });
    return job;
  }

  /** The VPN login for qBittorrent's VPN, straight into Secure Vault (never shown again). */
  async saveVpn(input: {
    provider: VpnProvider;
    type: "openvpn" | "wireguard";
    username?: string;
    password?: string;
    privateKey?: string;
    addresses?: string;
  }) {
    if (WIREGUARD_ONLY.includes(input.provider) && input.type !== "wireguard")
      throw new SetupError(
        `${VPN_PROVIDERS[input.provider].name} works with Hearth's VPN through WireGuard: add its WireGuard private key.`,
      );
    const values: Record<string, string> =
      input.type === "wireguard"
        ? {
            WIREGUARD_PRIVATE_KEY: input.privateKey ?? "",
            ...(input.addresses ? { WIREGUARD_ADDRESSES: input.addresses } : {}),
          }
        : { OPENVPN_USER: input.username ?? "", OPENVPN_PASSWORD: input.password ?? "" };
    if (Object.values(values).some((v) => !v.trim()))
      throw new SetupError("Fill in every field of the VPN login.");
    // A VPN's OpenVPN login is never an email address: an email is the account sign-in (often
    // filled in by the browser), which the VPN turns away. Say so now, not as a failed start.
    if (input.type === "openvpn" && input.username?.includes("@"))
      throw new SetupError(
        `That looks like your ${VPN_PROVIDERS[input.provider].name} account email. The VPN needs its own OpenVPN username and password, a separate pair shown in your ${VPN_PROVIDERS[input.provider].name} account (often on a page called OpenVPN, manual setup, or service credentials). If the boxes filled in by themselves, your browser put your saved login there: clear them and paste the OpenVPN pair.`,
      );
    const before = (await this.ledger()).vpn;
    const ids: Record<string, string> = {};
    for (const [envName, value] of Object.entries(values)) {
      const s = await this.d.vault.add({
        name: `VPN for downloads: ${envName.toLowerCase().replaceAll("_", " ")}`,
        kind: envName.includes("USER") ? "login" : "password",
        tier: "automation",
        value: value.trim(),
        category: "Homelab plan",
        notes: `${VPN_PROVIDERS[input.provider].name}, used by Hearth's VPN (Gluetun) for qBittorrent.`,
        actor: "you",
      });
      ids[envName] = s.id;
    }
    for (const id of Object.values(before?.ids ?? {}))
      await this.d.vault.removeInternal(id).catch(() => undefined);
    await this.save((l) => {
      l.vpn = { provider: input.provider, type: input.type, ids };
    });
    return { provider: input.provider, type: input.type };
  }

  /* ---------- the steps, for the job engine ---------- */

  private async context(_app?: RecipeId): Promise<RecipeContext> {
    const saved = await this.plan();
    const l = await this.ledger();
    const me = os.userInfo();
    return {
      uid: me.uid,
      gid: me.gid,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      drive: mediaDrive(saved?.scan),
      ...(l.vpn ? { vpn: { provider: l.vpn.provider, type: l.vpn.type } } : {}),
    };
  }

  async planStep(step: JobStepInput): Promise<PlannedStep> {
    const base: PlannedStep = {
      label: ACTIONS[step.kind].describe(String(step.params?.app ?? "")),
      serviceName: "This computer",
      changes: true,
      policy: "refuse",
      policyReason: "",
    };
    const refuse = (why: string): PlannedStep => ({ ...base, policyReason: why });
    if (step.serviceId !== THIS_HOST)
      return refuse(`A homelab step runs on this computer: use serviceId "${THIS_HOST}".`);
    const me = os.userInfo().username;
    if (step.kind === "build-docker" || step.kind === "build-tailscale") {
      const docker = step.kind === "build-docker";
      const cover = await this.d.elevation.covers(docker ? "docker.install" : "tailscale.install");
      if (!cover.ok) return refuse(`${cover.why} The one command: ${await this.helperCommand()}`);
      const change: StepChange = {
        summary: docker ? "Install Docker on this computer" : "Install Tailscale on this computer",
        settings: [
          {
            name: "What",
            before: docker
              ? (await this.dockerInstalled())
                ? "Installed, not usable by Hearth"
                : "Not installed"
              : "Not installed",
            after: docker
              ? "Docker Engine and Compose, from Docker's own repository (download.docker.com)"
              : "Tailscale, from its own repository (pkgs.tailscale.com)",
          },
          {
            name: "Who may use it",
            before: "",
            after: docker
              ? `${me} (Hearth's account) joins the docker group. Using Docker is close to administrator access on this computer, which is why this asks you to confirm it's you.`
              : `${me} (Hearth's account) becomes Tailscale's operator, so Hearth can give you its sign-in link. You sign in yourself.`,
          },
          {
            name: "Done by",
            before: "",
            after: "Hearth's admin helper, for this one approved step",
          },
          {
            name: "Then",
            before: "",
            after: docker
              ? "Hearth checks Docker answers it, with Compose"
              : "Hearth gets Tailscale's sign-in link for you",
          },
        ],
      };
      return {
        ...base,
        label: change.summary,
        change,
        params: { protected: "yes" },
        policy: "approve-first",
        policyReason:
          "Installs system software with administrator rights: it waits for your approval, and approving asks you to confirm it's you.",
      };
    }
    if (step.kind === "build-app") {
      const app = String(step.params?.app ?? "") as RecipeId;
      const recipe = RECIPES[app];
      if (!recipe) return refuse(`Hearth has no recipe for "${app}".`);
      if (!(await this.dockerReady()))
        return refuse("Docker is not ready for Hearth yet: install Docker first.");
      const accounts = await this.accounts();
      if (!accounts) return refuse("Save your account details first.");
      const ctx = await this.context(app);
      if (app === "qbittorrent" && !ctx.vpn) return refuse("Add your VPN login first.");
      const dir = path.join(this.d.appsRoot, app);
      const file = path.join(dir, "compose.yaml");
      const compose = recipe.compose(ctx);
      if (await exists(file)) {
        const had = await fs.readFile(file, "utf8").catch(() => "");
        if (!had.startsWith("# Set up by Hearth"))
          return refuse(`${dir} already holds something Hearth didn't make; nothing was changed.`);
      } else if (await portInUse(recipe.port))
        return refuse(
          `Something on this computer already uses port ${recipe.port}, which ${recipe.name} needs.`,
        );
      const folders = await mediaFolders(ctx.drive);
      const isProtected = recipe.protected?.(ctx) ?? false;
      const secrets = recipe.secrets?.(ctx) ?? [];
      const where: string[] = [];
      if (app === "jellyfin")
        where.push(
          `${ctx.drive} is shared with Jellyfin read only. Libraries: Movies (${folders.foundMovies ? folders.movies : `${ctx.drive}, until a Movies folder exists`}) and Shows (${folders.foundShows ? folders.shows : folders.shows + " (made empty)"}). Nothing is moved, renamed or deleted.`,
        );
      if (app === "radarr" || app === "sonarr")
        where.push(
          `New ${app === "radarr" ? "movies" : "shows"} go to ${app === "radarr" ? folders.movies : folders.shows}${(app === "radarr" ? folders.foundMovies : folders.foundShows) ? "" : " (a new, empty folder)"}. What is already there is not touched.`,
        );
      if (app === "qbittorrent")
        where.push(
          `Downloads go to ${folders.downloads} (a new folder). Every download goes through your VPN (${VPN_PROVIDERS[ctx.vpn!.provider].name}), with a kill switch: if the VPN drops, downloading stops.`,
        );
      const change: StepChange = {
        summary: `Set up ${recipe.name} from Hearth's recipe`,
        settings: [
          { name: "New folder", before: "Not there", after: dir },
          { name: "compose.yaml", before: "Not there", after: compose },
          ...(secrets.length
            ? [
                {
                  name: "From Secure Vault",
                  before: "",
                  after: `${secrets.join(", ")} (written beside it, never shown)`,
                },
              ]
            : []),
          ...where.map((w) => ({ name: "Your files", before: "", after: w })),
          {
            name: "Its address",
            before: "",
            after: `http://${os.hostname()}:${recipe.port} (on your home network)`,
          },
          ...(app === "prowlarr"
            ? [
                {
                  name: "Indexers",
                  before: "",
                  after:
                    "Prowlarr starts with none: you add the indexers you choose (sites that list what's available). Hearth never suggests any.",
                },
              ]
            : []),
          {
            name: "Your account",
            before: "",
            after:
              app === "seerr"
                ? `Signs in with your Jellyfin account (${accounts.username}); its API key goes to Secure Vault`
                : `${accounts.username}, with ${accounts.passwords === "own" ? "the password you chose" : "a strong new password"}, saved in Secure Vault with its API key`,
          },
          {
            name: "If it does not start cleanly",
            before: "",
            after:
              "Its containers are removed again; the folder stays. Your files are never touched.",
          },
        ],
      };
      return {
        ...base,
        label: change.summary,
        serviceName: recipe.name,
        change,
        params: {
          app,
          dir,
          hash: sha256(compose),
          ...(isProtected ? { protected: "yes" } : {}),
        },
        policy: "approve-first",
        policyReason: isProtected
          ? "Sets up a VPN: it waits for your approval, and approving asks you to confirm it's you."
          : "Installs an app: it waits for your approval.",
      };
    }
    if (step.kind === "build-connect") {
      const st = await this.status();
      const have = (id: HomelabStepId) => st.steps.some((s) => s.id === id && s.status === "done");
      const rows = [
        have("seerr") && have("radarr") ? "Seerr sends movie requests to Radarr" : "",
        have("seerr") && have("sonarr") ? "Seerr sends show requests to Sonarr" : "",
        have("radarr") && have("qbittorrent") ? "Radarr downloads with qBittorrent" : "",
        have("sonarr") && have("qbittorrent") ? "Sonarr downloads with qBittorrent" : "",
        have("prowlarr") && have("radarr") ? "Prowlarr gives Radarr your indexers" : "",
        have("prowlarr") && have("sonarr") ? "Prowlarr gives Sonarr your indexers" : "",
      ].filter(Boolean);
      if (!rows.length) return refuse("Set up the apps first: there is nothing to connect yet.");
      return {
        ...base,
        label: "Connect your new apps to each other",
        serviceName: "Your apps",
        change: {
          summary: "Connect your new apps to each other",
          settings: [
            ...rows.map((r) => ({ name: "Connection", before: "Not connected", after: r })),
            {
              name: "Then",
              before: "",
              after: "Hearth starts watching the new apps on its dashboard",
            },
          ],
        },
        params: {},
        policy: "approve-first",
        policyReason: "Changes your apps' settings: it waits for your approval.",
      };
    }
    if (step.kind === "build-confirm") {
      const app = String(step.params?.app ?? "") as RecipeId;
      const recipe = RECIPES[app];
      if (!recipe) return refuse(`Hearth has no recipe for "${app}".`);
      const st = (await this.status()).steps.find((s) => s.id === app);
      // Failed, or already this plan (waiting for the owner's OK, or running once approved).
      if (!st || !["failed", "awaiting-approval", "running"].includes(st.status))
        return refuse(`${recipe.name} is not a step that failed, so there is nothing to confirm.`);
      const change: StepChange = {
        summary: `You checked ${recipe.name} yourself: it works`,
        settings: [
          {
            name: "Hearth's own check",
            before: st.detail ?? "Did not pass",
            after: "Set aside: you checked it yourself",
          },
          {
            name: "This step",
            before: "Failed",
            after: "Done, noted as confirmed by you",
          },
          {
            name: "Before marking it",
            before: "",
            after: `Hearth makes sure ${recipe.name} answers at http://${os.hostname()}:${recipe.port}${
              app === "radarr" || app === "sonarr" || app === "prowlarr"
                ? ", and reads its API key from its own settings into Secure Vault"
                : ""
            }`,
          },
        ],
      };
      return {
        ...base,
        label: change.summary,
        serviceName: recipe.name,
        change,
        params: { app },
        policy: "approve-first",
        policyReason: "You say the app works: it waits for your approval, and Hearth notes it.",
      };
    }
    return refuse("Not a homelab step.");
  }

  /**
   * The owner checked a failed step's app and it works (11-22: a false failure stopped the
   * build, with no way past it). Proposed like any step and approved by the owner; Hearth never
   * marks one done on its own.
   */
  async confirm(id: HomelabStepId, opts: { requestedBy: Requester; conversationId?: string }) {
    const jobs = this.d.jobs();
    if (!jobs) throw new SetupError("Plans are not available here.");
    if (!(RECIPE_IDS as readonly string[]).includes(id))
      throw new SetupError(`"${id}" is not an app of this plan.`);
    const st = await this.status();
    const step = st.steps.find((s) => s.id === id);
    if (!step) throw new SetupError(`"${id}" is not a step of this plan.`);
    if (step.status === "awaiting-approval" && step.jobId) return jobs.get(step.jobId);
    if (step.status !== "failed")
      throw new SetupError(`${step.name} did not fail, so there is nothing to confirm.`);
    const job = await jobs.create({
      title: `Your homelab: ${step.name} works (you checked)`,
      reason: `You checked ${step.name} yourself and it works, though Hearth's own check did not pass: ${step.detail ?? "it failed"}.`,
      impact: `The build carries on from ${step.name}. Hearth notes that you confirmed it.`,
      steps: [{ kind: "build-confirm", serviceId: THIS_HOST, params: { app: id } }],
      requestedBy: opts.requestedBy,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    });
    await this.save((l) => {
      l.steps[id] = { ...(l.steps[id] ?? {}), jobId: job.id };
    });
    return job;
  }

  private async runConfirm(step: StepRun): Promise<StepOutcome> {
    const app = String(step.params?.app) as RecipeId;
    const recipe = RECIPES[app];
    const setupDeps: SetupDeps = {
      ...this.d.setup,
      ...(this.d.wait ? { wait: this.d.wait } : {}),
    };
    try {
      await waitForApp(recipe.local, setupDeps, 30_000);
    } catch {
      return {
        ok: false,
        result: `${recipe.name} does not answer at its address right now, so it was not marked done. Start it again (try the step again), then check it once more.`,
      };
    }
    let keyNote = "";
    if (app === "radarr" || app === "sonarr" || app === "prowlarr") {
      const dir = path.join(this.d.appsRoot, app);
      const key = await arrKey(path.join(dir, "config", "config.xml"), {
        ...setupDeps,
        wait: async () => undefined,
      }).catch(() => undefined);
      if (key && !(await this.secret(app, "key"))) {
        await this.keep(app, undefined, key);
        keyNote = " Its API key is now in Secure Vault.";
      } else if (key) keyNote = " Its API key is in Secure Vault.";
    }
    const at = new Date().toISOString();
    const detail = `Running at http://${os.hostname()}:${recipe.port}. You checked it and said it works (${at.slice(0, 10)}).`;
    await this.save((l) => {
      l.steps[app] = { ...(l.steps[app] ?? {}), done: at, detail, confirmedByOwner: true };
    });
    return {
      ok: true,
      result: `${recipe.name} is marked done: you checked it and it works.${keyNote}`,
    };
  }

  async runStep(step: StepRun): Promise<StepOutcome> {
    try {
      if (step.kind === "build-docker") return await this.runDocker(step);
      if (step.kind === "build-tailscale") return await this.runTailscale(step);
      if (step.kind === "build-app") return await this.runApp(step);
      if (step.kind === "build-connect") return await this.runConnect();
      if (step.kind === "build-confirm") return await this.runConfirm(step);
      return { ok: false, result: "Not a homelab step." };
    } catch (error) {
      return { ok: false, result: error instanceof Error ? error.message : String(error) };
    }
  }

  private async runDocker(step: StepRun): Promise<StepOutcome> {
    const r = await this.d.elevation.perform("docker.install", {}, step);
    if (!r.ok) return { ok: false, result: r.result };
    if (!(await this.dockerReady()))
      return {
        ok: false,
        result: `${r.result} But Docker does not answer Hearth yet; restarting this computer once fixes that.`,
      };
    await this.save((l) => {
      l.steps.docker = { ...(l.steps.docker ?? {}), done: new Date().toISOString() };
    });
    return { ok: true, result: r.result };
  }

  private async runTailscale(step: StepRun): Promise<StepOutcome> {
    const r = await this.d.elevation.perform("tailscale.install", {}, step);
    if (!r.ok) return { ok: false, result: r.result };
    const url = await this.tailscaleLoginUrl();
    await this.save((l) => {
      if (url) l.tailscaleUrl = url;
    });
    return {
      ok: true,
      result: url
        ? `${r.result} Sign in to Tailscale to connect this computer: ${url}`
        : `${r.result} Open Tailscale's sign-in from the plan page to connect this computer.`,
    };
  }

  /** `tailscale up` as Hearth's account (its operator): it prints the sign-in link and waits. */
  async tailscaleLoginUrl(): Promise<string | undefined> {
    return new Promise((resolve) => {
      let out = "";
      let done = false;
      const p = spawn("tailscale", ["up", "--timeout=15m"], { stdio: ["ignore", "pipe", "pipe"] });
      const finish = (url?: string) => {
        if (done) return;
        done = true;
        resolve(url);
      };
      const look = (d: Buffer) => {
        out += d.toString();
        const m = /https:\/\/login\.tailscale\.com\/\S+/.exec(out);
        if (m) finish(m[0]);
      };
      p.stdout.on("data", look);
      p.stderr.on("data", look);
      p.on("error", () => finish());
      p.on("exit", () => finish());
      p.unref();
      setTimeout(() => finish(), 20_000).unref();
    });
  }

  /** The login for an app: the owner's chosen password, or a new strong one. */
  private async credentials(app: RecipeId) {
    const a = (await this.accounts())!;
    let password: string;
    if (a.passwords === "own" && a.secretId)
      password = await this.d.vault.use(
        a.secretId,
        `Set up ${RECIPES[app].name} for your homelab plan`,
        {
          actor: "dragon-control",
        },
      );
    else password = randomBytes(18).toString("base64url");
    return { username: a.username, password, email: a.email };
  }

  private async keep(app: RecipeId, login?: { username: string; password: string }, key?: string) {
    const recipe = RECIPES[app];
    const before = (await this.ledger()).secrets[app] ?? {};
    const out: { login?: string; key?: string } = {};
    if (login) {
      out.login = (
        await this.d.vault.add({
          name: `${recipe.name}: your login`,
          kind: "login",
          tier: "automation",
          value: login.password,
          username: login.username,
          endpoint: `http://${os.hostname()}:${recipe.port}`,
          category: "Homelab plan",
          notes: "Made by Hearth when it set this app up for your homelab plan.",
          actor: "dragon-control",
          source: "homelab-build",
        })
      ).id;
      if (before.login) await this.d.vault.removeInternal(before.login).catch(() => undefined);
    }
    if (key) {
      out.key = (
        await this.d.vault.add({
          name: `${recipe.name}: API key`,
          kind: "api-key",
          tier: "automation",
          value: key,
          endpoint: `http://${os.hostname()}:${recipe.port}`,
          category: "Homelab plan",
          notes: "Read from the app by Hearth when it set it up for your homelab plan.",
          actor: "dragon-control",
          source: "homelab-build",
        })
      ).id;
      if (before.key) await this.d.vault.removeInternal(before.key).catch(() => undefined);
    }
    await this.save((l) => {
      l.secrets[app] = { ...(l.secrets[app] ?? {}), ...out };
    });
  }

  private async secret(app: RecipeId, which: "login" | "key"): Promise<string | undefined> {
    const id = (await this.ledger()).secrets[app]?.[which];
    return id
      ? this.d.vault.use(id, `Connect ${RECIPES[app].name} for your homelab plan`, {
          actor: "dragon-control",
        })
      : undefined;
  }

  private logs = async (container: string) =>
    (await this.d.run("docker", ["logs", "--tail", "400", container], 20_000)).out;

  private async runApp(step: StepRun): Promise<StepOutcome> {
    const app = String(step.params?.app) as RecipeId;
    const recipe = RECIPES[app];
    const ctx = await this.context(app);
    const compose = recipe.compose(ctx);
    if (sha256(compose) !== step.params?.hash)
      return {
        ok: false,
        stale: true,
        result:
          "The recipe is not the one you approved (the plan changed since); nothing was done.",
      };
    const dir = path.join(this.d.appsRoot, app);
    const file = path.join(dir, "compose.yaml");
    await fs.mkdir(path.join(dir, "config"), { recursive: true });
    if (app === "jellyfin") await fs.mkdir(path.join(dir, "cache"), { recursive: true });
    await fs.writeFile(file, compose, { mode: 0o644 });
    const secrets = recipe.secrets?.(ctx) ?? [];
    const envFile = path.join(dir, ".env");
    if (secrets.length) {
      const ids = (await this.ledger()).vpn?.ids ?? {};
      const lines: string[] = [];
      for (const name of secrets) {
        const id = ids[name];
        if (!id) {
          if (name === "WIREGUARD_ADDRESSES") continue;
          return { ok: false, result: `${name} is not in Secure Vault: add your VPN login again.` };
        }
        const v = await this.d.vault.use(id, `Start ${recipe.name} for your homelab plan`, {
          actor: "dragon-control",
        });
        // Compose reads .env values literally when single-quoted; a quote is escaped out.
        lines.push(`${name}='${v.replaceAll("'", "'\\''")}'`);
      }
      await fs.writeFile(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
      await fs.chmod(envFile, 0o600);
    }
    const folders = await mediaFolders(ctx.drive);
    await fs.mkdir(ctx.drive, { recursive: true }).catch(() => undefined);
    if (app === "radarr") await fs.mkdir(folders.movies, { recursive: true });
    if (app === "sonarr" || app === "jellyfin" || app === "plex")
      await fs.mkdir(folders.shows, { recursive: true });
    if (app === "qbittorrent") await fs.mkdir(folders.downloads, { recursive: true });
    const net = await this.d.run("docker", ["network", "inspect", NETWORK], 20_000);
    if (net.code !== 0) {
      const made = await this.d.run("docker", ["network", "create", NETWORK], 30_000);
      if (made.code !== 0)
        return {
          ok: false,
          result: `Docker could not make the ${NETWORK} network: ${made.out.slice(0, 300)}`,
        };
    }
    const up = await applyCompose(this.d.run, file, this.d.wait);
    if (!up.ok) {
      // The VPN's own words first, before its container goes: a refused login is the owner's to
      // fix and says so plainly, not as Compose's wall of text (11-22, the laptop retest).
      const vpn =
        app === "qbittorrent"
          ? vpnWhy(
              (await this.d.run("docker", ["logs", "--tail", "300", "gluetun"], 20_000)).out,
              ctx.vpn?.provider,
            )
          : undefined;
      await this.d.run("docker", ["compose", "-f", file, "down"], 120_000).catch(() => undefined);
      return {
        ok: false,
        result:
          vpn ??
          `${recipe.name} did not start cleanly (${up.detail}). Its containers were removed again; ${dir} stays.`,
      };
    }
    // Accounts, through the app's own API.
    const setupDeps: SetupDeps = {
      ...this.d.setup,
      logs: this.logs,
      ...(this.d.wait ? { wait: this.d.wait } : {}),
    };
    const rel = (p: string, root: string) =>
      path.posix.join(root, path.relative(ctx.drive, p).split(path.sep).join("/"));
    let note = "";
    if (app === "jellyfin") {
      const cred = await this.credentials(app);
      const libs = [
        {
          name: "Movies",
          type: "movies" as const,
          path: folders.foundMovies ? rel(folders.movies, "/media") : "/media",
        },
        { name: "Shows", type: "tvshows" as const, path: rel(folders.shows, "/media") },
      ];
      const r = await setupJellyfin(recipe.local, cred, libs, setupDeps);
      await this.keep(app, cred, r.apiKey);
      note = ` Libraries: ${r.libraries.join(", ")}.`;
    } else if (app === "radarr" || app === "sonarr" || app === "prowlarr") {
      const cred = await this.credentials(app);
      // Hearth reads the app's API key itself, from its own config, and keeps it and the login in
      // Secure Vault straight away: a later check that does not pass must never leave them unsaved
      // (11-22: Radarr signed in fine, but its key never reached the Vault).
      const key = await arrKey(path.join(dir, "config", "config.xml"), setupDeps);
      await this.keep(app, cred, key);
      const roots =
        app === "radarr"
          ? [rel(folders.movies, "/data")]
          : app === "sonarr"
            ? [rel(folders.shows, "/data")]
            : [];
      await setupArr(app, recipe.local, key, cred, roots, setupDeps);
      if (roots.length)
        note = ` Its library folder: ${app === "radarr" ? folders.movies : folders.shows}.`;
    } else if (app === "qbittorrent") {
      const cred = await this.credentials(app);
      await setupQbittorrent(
        recipe.local,
        "qbittorrent",
        cred,
        rel(folders.downloads, "/data"),
        setupDeps,
      );
      await this.keep(app, cred);
      note = ` Downloads go to ${folders.downloads}.`;
    } else if (app === "plex") {
      note =
        " Open it and sign in with your Plex account to make the server yours; then Hearth adds your Movies and Shows libraries.";
    } else if (app === "seerr" && !(await this.secret("jellyfin", "login"))) {
      // With Plex, the owner signs in on Seerr's own page; its API key is in its settings.
      let key: string | undefined;
      for (let i = 0; i < 40 && !key; i++) {
        key = (await this.seerrSettings()).apiKey;
        if (!key) await (this.d.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(3_000);
      }
      if (key) await this.keep(app, undefined, key);
      note = " Open it and choose Sign in with Plex, then pick your Plex server.";
    } else if (app === "seerr") {
      const jf = (await this.secret("jellyfin", "login"))!;
      const a = (await this.accounts())!;
      const r = await setupSeerr(
        recipe.local,
        { host: "jellyfin", port: 8096, username: a.username, password: jf, email: a.email },
        setupDeps,
      );
      await this.keep(app, undefined, r.apiKey);
      note = " It signs in with your Jellyfin account.";
    }
    const detail = `Running at http://${os.hostname()}:${recipe.port}.`;
    await this.save((l) => {
      l.steps[app] = { ...(l.steps[app] ?? {}), done: new Date().toISOString(), detail };
    });
    return {
      ok: true,
      result:
        app === "plex" || (app === "seerr" && !(await this.secret("jellyfin", "login")))
          ? `${recipe.name} is running at http://${os.hostname()}:${recipe.port}.${note}`
          : `${recipe.name} is set up and running at http://${os.hostname()}:${recipe.port}, with your account in it (saved in Secure Vault).${note}`,
    };
  }

  private async runConnect(): Promise<StepOutcome> {
    const st = await this.status();
    const have = (id: HomelabStepId) => st.steps.some((s) => s.id === id && s.status === "done");
    const ctx = await this.context("qbittorrent");
    const deps: SetupDeps = { ...this.d.setup, ...(this.d.wait ? { wait: this.d.wait } : {}) };
    const lines: string[] = [];
    const key = (app: RecipeId) => this.secret(app, "key");
    if (have("plex")) {
      const token = await this.plexToken();
      if (token) {
        const folders = await mediaFolders(ctx.drive);
        const rel = (p: string) =>
          path.posix.join("/media", path.relative(ctx.drive, p).split(path.sep).join("/"));
        const r = await setupPlexLibraries(
          RECIPES.plex.local,
          token,
          [
            {
              name: "Movies",
              type: "movie",
              path: folders.foundMovies ? rel(folders.movies) : "/media",
            },
            { name: "TV Shows", type: "show", path: rel(folders.shows) },
          ],
          deps,
        );
        lines.push(`Plex has your libraries: ${r.join(", ")}.`);
      }
    }
    const qbtLogin = have("qbittorrent")
      ? {
          username: (await this.accounts())!.username,
          password: (await this.secret("qbittorrent", "login"))!,
        }
      : undefined;
    for (const app of ["radarr", "sonarr"] as const) {
      if (!have(app)) continue;
      const k = (await key(app))!;
      if (qbtLogin) {
        const r = await connectDownloadClient(
          app,
          RECIPES[app].local,
          k,
          {
            host: internalHost("qbittorrent", ctx),
            port: 8080,
            ...qbtLogin,
          },
          deps,
        );
        lines.push(
          `${RECIPES[app].name} downloads with qBittorrent${r === "already" ? " (already)" : ""}.`,
        );
      }
      if (have("prowlarr")) {
        const r = await connectProwlarrApp(
          RECIPES.prowlarr.local,
          (await key("prowlarr"))!,
          {
            app: app === "radarr" ? "Radarr" : "Sonarr",
            url: `http://${app}:${RECIPES[app].port}`,
            apiKey: k,
            prowlarrUrl: "http://prowlarr:9696",
          },
          deps,
        );
        lines.push(
          `Prowlarr gives ${RECIPES[app].name} your indexers${r === "already" ? " (already)" : ""}.`,
        );
      }
      if (have("seerr")) {
        const r = await connectSeerrArr(
          RECIPES.seerr.local,
          { apiKey: (await key("seerr"))! },
          {
            kind: app,
            host: app,
            port: RECIPES[app].port,
            apiKey: k,
            local: RECIPES[app].local,
          },
          deps,
        );
        lines.push(
          `Seerr sends ${app === "radarr" ? "movie" : "show"} requests to ${RECIPES[app].name}${r === "already" ? " (already)" : ""}.`,
        );
      }
    }
    if (!lines.length) return { ok: false, result: "There was nothing to connect yet." };
    // Hearth starts watching them, and links each login and key to its app.
    let watching = "";
    if (this.d.adopt) {
      try {
        const built = RECIPE_IDS.filter(have).flatMap((a) => RECIPES[a].containers);
        const ids = await this.d.adopt(built);
        const l = await this.ledger();
        for (const [app, s] of Object.entries(l.secrets) as [
          RecipeId,
          { login?: string; key?: string },
        ][]) {
          const serviceId = ids[app === "qbittorrent" ? "qbittorrent" : app];
          if (!serviceId) continue;
          for (const id of [s.login, s.key].filter(Boolean) as string[])
            await this.d.vault.update(id, { serviceId }).catch(() => undefined);
        }
        watching = " Hearth now watches them on its dashboard.";
      } catch {
        watching =
          " Hearth could not add them to its dashboard yet: a scan in Settings, Discover does that.";
      }
    }
    await this.save((l) => {
      l.steps.connect = {
        ...(l.steps.connect ?? {}),
        done: new Date().toISOString(),
        detail: lines.join(" "),
      };
    });
    return { ok: true, result: `${lines.join(" ")}${watching}` };
  }
}

/** For the plan's needs: is this a homelab step kind. */
export const isBuildKind = (k: string) => k.startsWith("build-");

/** Where the apps go by default: a folder in the owner's home, next to Hearth's own. */
export function defaultAppsRoot(env = process.env): string {
  if (env.DC_BUILD_ROOT) return path.resolve(env.DC_BUILD_ROOT);
  return path.join(os.homedir(), "hearth-apps");
}

/** How this Hearth was installed (get.sh writes install.json beside its data). */
export function installInfo(dataDir: string, appDir: string) {
  const file = path.join(path.dirname(dataDir), "install.json");
  let service = "hearth";
  let userService = false;
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as { kind?: string; service?: string };
      service = j.service ?? service;
      userService = j.kind === "linux-user-service";
    } catch {
      // Unreadable: the defaults.
    }
  }
  return { dir: appDir, service, userService };
}
