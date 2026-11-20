import type { MemoryHooks } from "./memory-ops";
import type { MemorySources, RawProcess } from "./memory";

/**
 * A stand-in machine for the memory breakdown (DC_FAKE_MEMORY=1, tests): 16 GB with a browser,
 * a chat app, the system, Hearth with its voice loaded, and two containers. Closing apps and
 * freeing the voice change it, so a plan can be approved and read back without touching the
 * real machine.
 */
export function fakeMemory() {
  const GB = 1024 * 1024 * 1024;
  const self = 4242;
  const procs = (): RawProcess[] => [
    { pid: 1, parentPid: 0, name: "systemd", memRss: 12_000, user: "root" },
    { pid: 900, parentPid: 1, name: "sshd", memRss: 8_000, user: "root" },
    { pid: self, parentPid: 1, name: "node", memRss: 420_000, user: "owner" },
    {
      pid: 4300,
      parentPid: self,
      name: "python",
      command: "voice kokoro",
      memRss: 0,
      user: "owner",
    },
    { pid: 5001, parentPid: 1, name: "chrome", memRss: 1_200_000, user: "owner", started: "a" },
    { pid: 5002, parentPid: 5001, name: "chrome", memRss: 900_000, user: "owner", started: "b" },
    { pid: 5100, parentPid: 1, name: "Discord", memRss: 650_000, user: "owner", started: "c" },
  ];
  let voice = true;
  const closed = new Set<number>();
  const sources = (): MemorySources => ({
    platform: "linux",
    self: { pid: self, user: "owner" },
    mem: async () => {
      const used =
        (6 - (closed.has(5001) ? 2.0 : 0) - (closed.has(5100) ? 0.62 : 0) - (voice ? 0 : 0.9)) * GB;
      return {
        total: 16 * GB,
        available: 16 * GB - used,
        free: 4 * GB,
        buffcache: 6 * GB,
        swaptotal: 2 * GB,
        swapused: 0,
      };
    },
    processes: async () =>
      procs()
        .filter((p) => !closed.has(p.pid))
        .map((p) => (p.pid === 4300 ? { ...p, memRss: voice ? 920_000 : 0 } : p)),
    containers: async () => [
      { id: "a".repeat(64), name: "media-server", image: "jellyfin/jellyfin", memMb: 1400 },
      { id: "b".repeat(64), name: "proxy", image: "caddy:2", memMb: 60 },
    ],
    containerOf: async () => undefined,
    voiceLoaded: () => voice,
  });
  const hooks: MemoryHooks = {
    voiceLoaded: () => voice,
    releaseVoice: () => {
      voice = false;
    },
  };
  const close = async (pids: number[]) => {
    for (const p of pids) closed.add(p);
  };
  return {
    sources,
    hooks,
    close,
    reset: () => {
      voice = true;
      closed.clear();
    },
  };
}
