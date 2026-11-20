import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import os from "node:os";
import si from "systeminformation";
import { isCoreNetworking, type JobStepInput } from "@dragon-control/core";
import { connectDocker } from "../discovery/docker-client";

/**
 * Where this machine's memory goes (the owner, 2026-11-02: "what every GB is going toward", a
 * quick win, and Ember stopping what can be stopped once you press OK). Linux and Windows.
 *
 * - Apps: every process, grouped by app (30 browser processes are one row), by resident memory.
 * - Containers: Docker's own count per container. On Linux their processes are left out of the
 *   apps, so nothing is counted twice.
 * - Hearth: Hearth itself, its voice helper and its agents (its child processes).
 * - System and other: what the system uses that no process shows (the kernel, drivers, shared).
 * - Cache: file cache the system hands back by itself when an app needs memory (Linux).
 * Resident memory counts shared pages in each process, so app rows are approximate; the total,
 * used, cache and free come from the system itself.
 *
 * Each row says whether it can be stopped from Hearth and why not when it cannot. The quick win
 * is the safe part only: Hearth's voice when it is loaded, and test or preview containers (or
 * ones you paused) that are still running. Anything else is Ember's call, as a plan you approve.
 */

export interface RawProcess {
  pid: number;
  parentPid: number;
  name: string;
  command?: string;
  /** Resident memory in KB. */
  memRss: number;
  user?: string;
  started?: string;
  /** Working folder (Linux), to name a generic script by its app. */
  cwd?: string;
}

export interface MemorySources {
  platform: NodeJS.Platform;
  self: { pid: number; user: string };
  mem(): Promise<{
    total: number;
    available: number;
    free: number;
    buffcache: number;
    swaptotal: number;
    swapused: number;
  }>;
  processes(): Promise<RawProcess[]>;
  /** Running containers with their memory (MB); undefined when Docker is not here. */
  containers(): Promise<{ id: string; name: string; image: string; memMb: number }[] | undefined>;
  /** The container a process runs in (Linux), by its full id. */
  containerOf(pid: number): Promise<string | undefined>;
  voiceLoaded(): boolean;
}

export interface MemoryService {
  id: string;
  name: string;
  image?: string | null;
  checkTarget?: string | null;
  lifecycle: string;
  stoppedAt?: string | null;
}

export type MemoryKind = "app" | "container" | "hearth" | "system" | "cache" | "free";

export interface MemoryItem {
  id: string;
  name: string;
  kind: MemoryKind;
  mb: number;
  /** Processes in an app row. */
  count?: number;
  detail?: string;
  serviceId?: string;
  /** How Hearth can stop it (a plan step), or why it cannot. */
  stop?: { step: JobStepInput; label: string };
  keep?: string;
}

export interface MemoryBreakdown {
  machine: string;
  os: "linux" | "windows" | "mac" | "other";
  at: string;
  totalMb: number;
  usedMb: number;
  cacheMb: number;
  freeMb: number;
  swap?: { totalMb: number; usedMb: number };
  items: MemoryItem[];
  quickWin: { mb: number; steps: JobStepInput[]; names: string[] };
  note: string;
}

const MB = 1048576;

/** Friendly names for common apps; others keep their own name, without ".exe". */
const FRIENDLY: Record<string, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  firefox: "Firefox",
  "firefox-esr": "Firefox",
  brave: "Brave",
  opera: "Opera",
  code: "Visual Studio Code",
  discord: "Discord",
  spotify: "Spotify",
  slack: "Slack",
  teams: "Microsoft Teams",
  "ms-teams": "Microsoft Teams",
  steam: "Steam",
  steamwebhelper: "Steam",
  obs64: "OBS Studio",
  obs: "OBS Studio",
  vlc: "VLC",
  "plex media server": "Plex Media Server",
  "plex transcoder": "Plex Media Server",
  plexmediaserver: "Plex Media Server",
  jellyfin: "Jellyfin",
  ollama: "Ollama",
  ollama_llama_server: "Ollama",
  "memory compression": "Windows memory compression",
  vmmem: "Virtual machines (WSL or Hyper-V)",
  vmmemwsl: "Virtual machines (WSL or Hyper-V)",
  "docker desktop": "Docker Desktop",
  explorer: "Windows Explorer",
  electron: "Electron app",
  python3: "Python",
  python: "Python",
  java: "Java",
  node: "Node.js",
};

/** Never closed from Hearth, each with the reason the breakdown shows. */
const KEEP: [RegExp, string][] = [
  [/^(dockerd|containerd.*|docker-proxy|runc)$/i, "Docker itself (it runs your containers)"],
  [
    /^(wrapper-[\d.]+|xfce4-.*|xfwm4|xfdesktop|xfsettingsd|xfconfd|gsd-.*|gnome-.*-daemon|evolution-.*|tracker-miner.*|ibus.*|at-spi.*|gvfs.*|xdg-.*|zeitgeist.*|mutter.*|nm-applet|blueman.*|light-locker|xss-lock|notify-osd|nemo-desktop|caja|marco|mate-.*|lxpanel|lxsession|picom|compton)$/i,
    "Part of the desktop",
  ],
  [
    /^(plex media server|plex transcoder|plexmediaserver|jellyfin.*|emby.*|ollama.*|audiobookshelf|kavita|navidrome)$/i,
    "A server your other devices use: stop it from its own page if you need to",
  ],
  [/^(msedgewebview2|webviewhost)$/i, "Part of other apps (their built-in web views)"],
  [
    /^(sshd?|ssh-agent|tailscaled?|tailscale-ipn|caddy|cloudflared|wireguard.*|wg-quick|networkmanager|proton.*vpn.*|protonvpn.*|nordvpn.*|openvpn.*|sunshine|syncthing|synctrayzor|rustdesk|anydesk|teamviewer.*|parsec.*)$/i,
    "Networking, remote access or syncing",
  ],
  [
    /^(bash|zsh|fish|sh|dash|ssh|powershell|pwsh|cmd|conhost|windowsterminal|openconsole|tmux.*|screen|claude|codex|node|hearth.*)$/i,
    "A terminal or AI session, or something it runs: close it there",
  ],
  [
    /^(systemd.*|init|kthreadd|kworker.*|dbus.*|polkitd|pipewire.*|wireplumber|pulseaudio|xorg|xwayland|gnome-shell|gdm.*|lightdm|sddm|kwin.*|plasmashell|cron|rsyslogd|journald|udisksd|upowerd|accounts-daemon|snapd|explorer|dwm|csrss|winlogon|wininit|lsass|lsaiso|services|svchost|smss|system|registry|idle|secure system|memory compression|fontdrvhost|sihost|ctfmon|runtimebroker|searchhost|searchindexer|startmenuexperiencehost|textinputhost|shellexperiencehost|applicationframehost|dllhost|taskhostw|spoolsv|wudfhost|audiodg|msmpeng|nissrv|securityhealthservice|smartscreen|lockapp|widgets|phoneexperiencehost|crossdeviceservice)$/i,
    "Part of the system",
  ],
];
const keepReason = (name: string) => KEEP.find(([re]) => re.test(base(name)))?.[1];

const TESTLIKE = /(^|[-_. ])(test|testing|dev|staging|preview|sandbox|demo)([-_. ]|$)/i;

const base = (name: string) => name.replace(/\.exe$/i, "").trim();
const friendly = (name: string) => {
  const b = base(name);
  return FRIENDLY[b.toLowerCase()] ?? b;
};
const round = (n: number) => Math.round(n);

const GENERIC = /^(index|main|server|app|run|start|cli)\.(js|mjs|cjs|py)$/i;

/** The app's name: its executable's full name from the command line, or a script's folder. */
function nameOf(p: RawProcess): string {
  const cmd = p.command ?? "";
  if (!p.name.trim()) {
    const first = cmd.trim().split(/\s+/)[0] ?? "";
    return first ? (first.split(/[\\/]/).pop() ?? first) : "Unnamed process";
  }
  if (GENERIC.test(p.name) && p.cwd) {
    const folder = p.cwd
      .split(/[\\/]/)
      .filter(
        (x) => x && !/^(app|apps|dist|src|server|bin|lib|build|current|release|out)$/i.test(x),
      )
      .pop();
    if (folder) return `${folder} (${p.name})`;
  }
  const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const full = new RegExp(`[\\\\/](${esc}[^\\\\/]*?)(?=\\s+-|\\s*$)`).exec(cmd)?.[1];
  return full && full.length <= 60 ? full : p.name;
}

export async function readMemory(
  src: MemorySources,
  services: MemoryService[],
  machine: string,
): Promise<MemoryBreakdown> {
  const [mem, procs, containers] = await Promise.all([
    src.mem(),
    src.processes().catch(() => [] as RawProcess[]),
    src.containers().catch(() => undefined),
  ]);
  const totalMb = mem.total / MB;
  const usedMb = Math.max(0, (mem.total - mem.available) / MB);
  // Windows counts its standby cache as available already; Linux reports it as buff/cache.
  const cacheMb = src.platform === "linux" ? Math.min(mem.buffcache / MB, totalMb - usedMb) : 0;
  const freeMb = Math.max(0, totalMb - usedMb - cacheMb);

  // Hearth and everything it started.
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.parentPid, [...(children.get(p.parentPid) ?? []), p.pid]);
  const hearthPids = new Set<number>([src.self.pid]);
  const walk = [src.self.pid];
  while (walk.length) {
    for (const c of children.get(walk.pop()!) ?? [])
      if (!hearthPids.has(c)) {
        hearthPids.add(c);
        walk.push(c);
      }
  }

  // Processes inside containers are counted once, as their container.
  const inContainer = new Set<number>();
  if (containers?.length && src.platform === "linux")
    await Promise.all(
      procs.map(async (p) => {
        if (hearthPids.has(p.pid)) return;
        if (await src.containerOf(p.pid).catch(() => undefined)) inContainer.add(p.pid);
      }),
    );

  const items: MemoryItem[] = [];
  const quick: { step: JobStepInput; name: string; mb: number }[] = [];

  // Hearth: itself, its voice, its agents.
  const hearth = { main: 0, voice: 0, agents: 0, n: 0 };
  for (const p of procs) {
    if (!hearthPids.has(p.pid)) continue;
    const mb = p.memRss / 1024;
    const cmd = `${p.name} ${p.command ?? ""}`;
    if (/voice|kokoro|piper|whisper|onnx/i.test(cmd)) hearth.voice += mb;
    else if (p.pid !== src.self.pid && /claude|codex|ollama|agent/i.test(cmd)) hearth.agents += mb;
    else hearth.main += mb;
  }
  items.push({
    id: "hearth",
    name: "Hearth",
    kind: "hearth",
    mb: round(hearth.main),
    keep: "Hearth itself",
  });
  if (hearth.voice >= 1 || src.voiceLoaded()) {
    const step: JobStepInput = {
      kind: "free-memory",
      serviceId: "this-host",
      params: { what: "voice" },
    };
    items.push({
      id: "hearth-voice",
      name: "Hearth voice",
      kind: "hearth",
      mb: round(hearth.voice),
      detail: "Starts again the next time you talk or play a reply",
      stop: { step, label: "Free up voice memory" },
    });
    if (hearth.voice >= 20) quick.push({ step, name: "Hearth voice", mb: hearth.voice });
  }
  if (hearth.agents >= 1)
    items.push({
      id: "hearth-agents",
      name: "Hearth agents",
      kind: "hearth",
      mb: round(hearth.agents),
      detail: "Claude Code, Codex or Ollama working for you",
      keep: "Working on something for you; they stop by themselves when done",
    });

  // Containers.
  const byContainer = (name: string) =>
    services.find((s) => s.checkTarget === `container:${name}` || s.name === name);
  for (const c of containers ?? []) {
    const svc = byContainer(c.name);
    const item: MemoryItem = {
      id: `container:${c.name}`,
      name: svc?.name ?? c.name,
      kind: "container",
      mb: round(c.memMb),
      detail: svc && svc.name !== c.name ? c.name : c.image,
      ...(svc ? { serviceId: svc.id } : {}),
    };
    if (!svc) item.keep = "Not one of the systems Hearth watches; adopt it to manage it";
    else if (isCoreNetworking(c.name, c.image) || isCoreNetworking(svc.name, svc.image))
      item.keep = "Carries other things (remote access, a VPN, DNS or Docker access)";
    else if (/hearth|dragon-control/i.test(`${c.name} ${c.image}`)) item.keep = "Hearth itself";
    else {
      const step: JobStepInput = { kind: "stop-container", serviceId: svc.id };
      item.stop = { step, label: `Stop ${svc.name}` };
      const why =
        svc.lifecycle === "paused" || svc.lifecycle === "retired"
          ? `${svc.lifecycle}, but still running`
          : TESTLIKE.test(`${c.name} ${svc.name}`)
            ? "a test or preview copy"
            : undefined;
      if (why) {
        item.detail = `${item.detail ?? ""}${item.detail ? " · " : ""}${why}`;
        if (c.memMb >= 50) quick.push({ step, name: svc.name, mb: c.memMb });
      }
    }
    items.push(item);
  }

  // Apps: every other process, grouped by app.
  const apps = new Map<
    string,
    { name: string; mb: number; pids: { pid: number; started?: string }[]; keep?: string }
  >();
  const mine = (p: RawProcess) =>
    Boolean(p.user) &&
    base(p.user!).split("\\").pop()!.toLowerCase() ===
      base(src.self.user).split("\\").pop()!.toLowerCase();
  for (const p of procs) {
    if (hearthPids.has(p.pid) || inContainer.has(p.pid) || p.memRss <= 0) continue;
    const name = friendly(nameOf(p));
    const key = name.toLowerCase();
    const a = apps.get(key) ?? { name, mb: 0, pids: [] };
    a.mb += p.memRss / 1024;
    a.pids.push({ pid: p.pid, ...(p.started ? { started: p.started } : {}) });
    if (!a.keep) {
      const why = p.pid <= 4 ? "Part of the system" : keepReason(p.name);
      if (why) a.keep = why;
      else if (!mine(p)) a.keep = "Runs as a system service or another user";
    }
    apps.set(key, a);
  }
  for (const [key, a] of apps) {
    const item: MemoryItem = {
      id: `app:${key}`,
      name: a.name,
      kind: "app",
      mb: round(a.mb),
      ...(a.pids.length > 1 ? { count: a.pids.length } : {}),
    };
    if (a.keep) item.keep = a.keep;
    else
      item.stop = {
        step: {
          kind: "free-memory",
          serviceId: "this-host",
          params: { what: "app", app: key, name: a.name, pids: JSON.stringify(a.pids) },
        },
        label: `Close ${a.name}`,
      };
    items.push(item);
  }

  const counted = items.reduce((n, i) => n + i.mb, 0);
  items.push({
    id: "system",
    name: "System and other",
    kind: "system",
    mb: round(Math.max(0, usedMb - counted)),
    detail: "The system's own memory, drivers and shared memory no app shows",
    keep: "The system's own",
  });
  if (cacheMb >= 1)
    items.push({
      id: "cache",
      name: "Cache",
      kind: "cache",
      mb: round(cacheMb),
      detail: "Recently used files kept in memory; handed back by itself when an app needs it",
      keep: "Freed by itself when needed",
    });
  items.push({ id: "free", name: "Free", kind: "free", mb: round(freeMb) });

  const order: Record<MemoryKind, number> = {
    container: 0,
    app: 0,
    hearth: 0,
    system: 1,
    cache: 2,
    free: 3,
  };
  items.sort((a, b) => order[a.kind] - order[b.kind] || b.mb - a.mb);
  quick.sort((a, b) => b.mb - a.mb);

  const os_: MemoryBreakdown["os"] =
    src.platform === "linux"
      ? "linux"
      : src.platform === "win32"
        ? "windows"
        : src.platform === "darwin"
          ? "mac"
          : "other";
  return {
    machine,
    os: os_,
    at: new Date().toISOString(),
    totalMb: round(totalMb),
    usedMb: round(usedMb),
    cacheMb: round(cacheMb),
    freeMb: round(freeMb),
    ...(mem.swaptotal > 0
      ? { swap: { totalMb: round(mem.swaptotal / MB), usedMb: round(mem.swapused / MB) } }
      : {}),
    items: items.filter((i) => i.mb >= 1 || i.kind === "free"),
    quickWin: {
      mb: round(quick.reduce((n, q) => n + q.mb, 0)),
      steps: quick.map((q) => q.step),
      names: quick.map((q) => q.name),
    },
    note: "App rows count each process's own memory, so shared memory can make them add up to a little more than what is used. Used, cache and free come from the system.",
  };
}

/* ---------- The real sources ---------- */

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 16 * MB, windowsHide: true }, (e, out) =>
      e ? reject(e) : resolve(out),
    ),
  );
}

/**
 * Windows: the session each process runs in. Apps on the desktop run in a signed-in session;
 * services in session 0. (Asking Windows for every owner takes it 20 seconds or more.)
 */
async function windowsSessions(): Promise<Map<number, number>> {
  const out = await run("tasklist", ["/fo", "csv", "/nh"]).catch(() => "");
  const sessions = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const cols = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!);
    const pid = Number(cols[1]);
    if (pid) sessions.set(pid, Number(cols[3]));
  }
  return sessions;
}

export function realMemorySources(voiceLoaded: () => boolean): MemorySources {
  const platform = process.platform;
  return {
    platform,
    self: { pid: process.pid, user: os.userInfo().username },
    mem: () => si.mem(),
    async processes() {
      const [list, sessions] = await Promise.all([
        si.processes(),
        platform === "win32" ? windowsSessions() : Promise.resolve(undefined),
      ]);
      const me = os.userInfo().username;
      const rows = list.list.map((p) => ({
        pid: p.pid,
        parentPid: p.parentPid,
        name: p.name,
        command: [p.command, p.params].filter(Boolean).join(" "),
        memRss: p.memRss,
        // Windows: a desktop session's apps are yours; session 0 is services.
        user: sessions ? (sessions.get(p.pid) ? me : "SYSTEM") : p.user,
        started: p.started,
      })) as RawProcess[];
      if (platform === "linux")
        await Promise.all(
          rows
            .filter((r) => GENERIC.test(r.name))
            .map(async (r) => {
              r.cwd = await readlink(`/proc/${r.pid}/cwd`).catch(() => undefined);
            }),
        );
      return rows;
    },
    async containers() {
      const conn = await connectDocker();
      if ("error" in conn) return undefined;
      const r = conn.reader;
      const list =
        await r.get<{ Id: string; Names?: string[]; Image?: string }[]>("/containers/json");
      const out: { id: string; name: string; image: string; memMb: number }[] = [];
      // A few at a time: each answer takes Docker a moment.
      for (let i = 0; i < list.length; i += 8)
        out.push(
          ...(await Promise.all(
            list.slice(i, i + 8).map(async (c) => {
              const s = await r
                .get<{
                  memory_stats?: {
                    usage?: number;
                    stats?: { inactive_file?: number; cache?: number };
                  };
                }>(`/containers/${c.Id}/stats?stream=false&one-shot=true`)
                .catch(() => undefined);
              const usage = s?.memory_stats?.usage ?? 0;
              const cache =
                s?.memory_stats?.stats?.inactive_file ?? s?.memory_stats?.stats?.cache ?? 0;
              return {
                id: c.Id,
                name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
                image: c.Image ?? "",
                memMb: Math.max(0, usage - cache) / MB,
              };
            }),
          )),
        );
      return out;
    },
    async containerOf(pid) {
      if (platform !== "linux") return undefined;
      const text = await readFile(`/proc/${pid}/cgroup`, "utf8");
      return /(?:docker[-/]|\/docker\/|libpod-)([0-9a-f]{64})/.exec(text)?.[1];
    },
    voiceLoaded,
  };
}
