import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { opendir, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HostScan, VpnProvider } from "@dragon-control/core";
import { nvidiaMemory } from "../voice/machine";

/**
 * The read-only scan behind "Help me build": what this machine is and has, so the questionnaire
 * does not have to ask (processor, graphics, memory, drives, cable or Wi-Fi, Docker). Nothing is
 * changed; anything that cannot be read is left out or marked unknown, never guessed.
 */

const run = (cmd: string, args: string[]) =>
  new Promise<string | undefined>((resolve) =>
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    ),
  );

function osName(): string {
  if (process.platform === "linux") {
    try {
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync("/etc/os-release", "utf8"));
      if (pretty) return pretty[1]!;
    } catch {
      // Not every Linux has os-release.
    }
    return `Linux ${os.release()}`;
  }
  if (process.platform === "win32")
    return Number(os.release().split(".")[2]) >= 22000 ? "Windows 11" : "Windows 10";
  if (process.platform === "darwin") return `macOS ${os.release()}`;
  return `${process.platform} ${os.release()}`;
}

async function gpus(): Promise<HostScan["gpus"]> {
  const found: HostScan["gpus"] = [];
  const nvidia = await nvidiaMemory();
  if (nvidia) {
    const name = (await run("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]))
      ?.split(/\r?\n/)[0]
      ?.trim();
    found.push({ vendor: "nvidia", name: name || "NVIDIA graphics card", memoryBytes: nvidia });
  }
  if (process.platform === "linux") {
    // Each graphics device's PCI vendor: Intel 0x8086, AMD 0x1002 (NVIDIA was read above).
    const drm = "/sys/class/drm";
    const vendors = new Set<string>();
    for (const card of existsSync(drm) ? readdirSync(drm) : []) {
      if (!/^card\d+$/.test(card)) continue;
      try {
        vendors.add(readFileSync(path.join(drm, card, "device/vendor"), "utf8").trim());
      } catch {
        // A card without a PCI vendor file (virtual displays).
      }
    }
    if (vendors.has("0x8086")) found.push({ vendor: "intel", name: "Intel built-in graphics" });
    if (vendors.has("0x1002")) found.push({ vendor: "amd", name: "AMD graphics" });
  } else if (process.platform === "win32") {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_VideoController).Name",
    ]);
    for (const name of out
      ?.split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean) ?? []) {
      if (/nvidia/i.test(name)) continue;
      found.push({
        vendor: /intel/i.test(name) ? "intel" : /amd|radeon/i.test(name) ? "amd" : "other",
        name,
      });
    }
  } else if (process.platform === "darwin" && os.arch() === "arm64") {
    found.push({ vendor: "apple", name: "Apple silicon graphics" });
  }
  return found;
}

async function disks(): Promise<HostScan["disks"]> {
  const roots: string[] = [];
  if (process.platform === "win32") {
    for (const l of "CDEFGHIJKLMNOPQRSTUVWXYZ") if (existsSync(`${l}:\\`)) roots.push(`${l}:\\`);
  } else {
    // Real filesystems only: no system, temporary, container, or snap mounts.
    const skip =
      /^(proc|sysfs|tmpfs|devtmpfs|devpts|cgroup2?|overlay|squashfs|securityfs|pstore|bpf|debugfs|tracefs|mqueue|hugetlbfs|fusectl|configfs|autofs|ramfs|efivarfs|nsfs|binfmt_misc)$/;
    try {
      for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
        const [dev, mount, type] = line.split(" ");
        if (!dev || !mount || !type || skip.test(type) || !dev.startsWith("/dev/")) continue;
        if (/^\/(boot|snap|var\/lib\/docker)/.test(mount)) continue;
        roots.push(mount.replace(/\\040/g, " "));
      }
    } catch {
      roots.push("/");
    }
  }
  const out: HostScan["disks"] = [];
  for (const r of [...new Set(roots)]) {
    try {
      const s = await statfs(r);
      const total = s.blocks * s.bsize;
      if (total < 1024 ** 3) continue;
      out.push({ name: r, totalBytes: total, freeBytes: s.bavail * s.bsize });
    } catch {
      // A drive that cannot be read (an empty card reader) is left out.
    }
  }
  return out;
}

function network(): HostScan["network"] {
  const names = Object.entries(os.networkInterfaces())
    .filter(([, addrs]) => addrs?.some((a) => !a.internal && a.family === "IPv4"))
    .map(([n]) => n)
    // Virtual adapters (Docker, VPNs, WSL) are not how the machine reaches the router.
    .filter((n) => !/^(docker|br-|veth|virbr|vEthernet|tailscale|tun|wg|zt|lo)/i.test(n));
  if (names.some((n) => /^(eth|en|eno|enp|Ethernet)/i.test(n))) return "wired";
  if (names.some((n) => /^(wl|wlan|Wi-?Fi|Wireless)/i.test(n))) return "wifi";
  return "unknown";
}

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|webm)$/i;
const AUDIO = /\.(mp3|flac|m4a|m4b|aac|ogg|opus|wav)$/i;
const PHOTO = /\.(jpe?g|png|heic|webp|raw|cr2|nef|dng)$/i;
// System and program folders hold no personal media and would only slow the count down.
const SKIP_DIR =
  /^(?:\$.*|\..*|System Volume Information|Windows|Program Files.*|ProgramData|AppData|proc|sys|dev|run|usr|lib|lib64|bin|sbin|etc|var|boot|snap|node_modules)$/i;

/**
 * How many videos, songs, and photos a drive holds, counted by file name only (never opened),
 * a few folders deep, and stopped after a few seconds or files so a huge drive cannot stall the
 * scan. The point is to say "found 412 films on E:" so the plan reuses them where they are.
 */
export async function countMedia(
  root: string,
  limits = { files: 50_000, ms: 4000, depth: 5 },
): Promise<{ videos: number; audio: number; photos: number }> {
  const out = { videos: 0, audio: 0, photos: 0 };
  const until = Date.now() + limits.ms;
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > limits.depth || Date.now() > until || seen > limits.files) return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const e of handle) {
      if (Date.now() > until || ++seen > limits.files) break;
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name)) await walk(path.join(dir, e.name), depth + 1);
      } else if (VIDEO.test(e.name)) out.videos++;
      else if (AUDIO.test(e.name)) out.audio++;
      else if (PHOTO.test(e.name)) out.photos++;
    }
  };
  await walk(root, 0);
  return out;
}

/** The drive the system itself lives on: its own files are not the person's media. */
function isSystemDrive(name: string): boolean {
  if (process.platform === "win32")
    return name.toUpperCase().startsWith((process.env.SystemDrive ?? "C:").toUpperCase());
  return name === "/";
}

const VPN_NAMES: [VpnProvider, RegExp][] = [
  ["proton", /proton ?vpn/i],
  ["mullvad", /mullvad/i],
  ["nord", /nord ?vpn/i],
  ["surfshark", /surfshark/i],
  ["pia", /private internet access|\bpia\b|piactl/i],
  ["express", /express ?vpn/i],
  ["windscribe", /windscribe/i],
  ["airvpn", /airvpn|eddie/i],
];

/**
 * VPN apps installed here, by name only (the installed-programs list on Windows, the commands
 * on Linux and macOS), so the plan can reuse one instead of suggesting another. Nothing is opened.
 */
async function installedVpns(running: string[]): Promise<VpnProvider[]> {
  let names: string[] = [...running];
  if (process.platform === "win32") {
    const out = await run("powershell", [
      "-NoProfile",
      "-Command",
      "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | ForEach-Object { $_.DisplayName }",
    ]);
    names = names.concat(out?.split(/\r?\n/) ?? []);
  } else {
    for (const cmd of [
      "protonvpn",
      "protonvpn-app",
      "mullvad",
      "nordvpn",
      "piactl",
      "expressvpn",
      "windscribe",
      "eddie-cli",
    ])
      if (await run("sh", ["-c", `command -v ${cmd}`])) names.push(cmd);
  }
  return VPN_NAMES.filter(([, re]) => names.some((n) => re.test(n))).map(([id]) => id);
}

/** Scans this machine, read only. `running` comes from what Hearth already watches. */
export async function scanHost(runningApps: string[]): Promise<HostScan> {
  const [g, d, docker, vpns] = await Promise.all([
    gpus(),
    disks(),
    run("docker", ["version", "--format", "{{.Server.Version}}"]),
    installedVpns(runningApps),
  ]);
  // Media is counted on the other drives (an external drive of films), side by side.
  await Promise.all(
    d
      .filter((x) => !isSystemDrive(x.name))
      .map(async (x) => {
        x.media = await countMedia(x.name);
      }),
  );
  return {
    hostname: os.hostname(),
    freeMemoryBytes: os.freemem(),
    os: osName(),
    platform: process.platform,
    cpu: os.cpus()[0]?.model.trim() ?? "Unknown processor",
    cores: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    gpus: g,
    disks: d,
    network: network(),
    docker: Boolean(docker),
    running: runningApps,
    vpns,
  };
}

/** A made-up machine for tests and safe previews (DC_FAKE_DISCOVERY=1), never this one. */
export function fakeHostScan(runningApps: string[]): HostScan {
  const GB = 1024 ** 3;
  return {
    os: "Ubuntu 24.04 LTS",
    platform: "linux",
    cpu: "Intel Core i5-12400 (sample)",
    cores: 12,
    hostname: "sample-server",
    memoryBytes: 16 * GB,
    freeMemoryBytes: 11 * GB,
    gpus: [{ vendor: "intel", name: "Intel built-in graphics" }],
    disks: [
      { name: "/", totalBytes: 500 * GB, freeBytes: 380 * GB },
      {
        name: "/srv/media",
        totalBytes: 8000 * GB,
        freeBytes: 7200 * GB,
        media: { videos: 412, audio: 1830, photos: 0 },
      },
    ],
    network: "wired",
    docker: true,
    running: runningApps,
  };
}
