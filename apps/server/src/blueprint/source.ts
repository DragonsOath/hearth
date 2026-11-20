import { promises as fs } from "node:fs";
import os from "node:os";
import { eq } from "drizzle-orm";
import { appKindOf } from "@dragon-control/core";
import type { InspectForConfig } from "../actions/container-config";
import type { Vault } from "../auth/vault";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { connectDocker } from "../discovery/docker-client";
import { getSetting } from "../store/settings";
import type { AssembleSource } from "./assemble";
import { fakeMachine } from "./fake";

/**
 * Where the Lab Blueprint reads this machine: Docker's own API (read only; environment values are
 * never read into the blueprint), the kernel's mount table, the operating system, Hearth's own list
 * of services and the vault's index (names only).
 */

/** Filesystems that are real drives or shares, not the kernel's own (proc, tmpfs, overlay...). */
const REAL_FS =
  /^(ext[234]|xfs|btrfs|zfs|f2fs|ntfs3?|fuseblk|vfat|exfat|nfs4?|cifs|smb3?|fuse\.rclone)$/;
/** Hearth's own throwaway containers never belong in a blueprint. */
const OURS = ["dragon-control.sandbox", "hearth.rehearsal"];
const MAX_FILE = 512 * 1024;

export function machineSource(deps: {
  handle: DbHandle;
  vault: Pick<Vault, "list">;
  version: string;
}): AssembleSource {
  const docker = async () => {
    const c = await connectDocker();
    if ("error" in c) throw new Error(c.error);
    return c.reader;
  };
  return {
    async containers() {
      const r = await docker();
      const list =
        await r.get<
          { Id: string; Names?: string[]; State?: string; Labels?: Record<string, string> }[]
        >("/containers/json?all=1");
      const out = [];
      for (const c of list) {
        if (OURS.some((l) => c.Labels?.[l] !== undefined)) continue;
        const inspect = await r.get<InspectForConfig & { Id?: string }>(`/containers/${c.Id}/json`);
        out.push({
          name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
          state: c.State ?? "unknown",
          inspect,
        });
      }
      return out;
    },
    async networks() {
      const r = await docker();
      const list = await r.get<{ Id: string; Name: string; Driver: string }[]>("/networks");
      const out = [];
      for (const n of list) {
        if (["bridge", "host", "none"].includes(n.Name)) continue;
        const full = await r
          .get<{
            IPAM?: { Config?: { Subnet?: string }[] | null };
            Containers?: Record<string, { Name?: string }> | null;
          }>(`/networks/${n.Id}`)
          .catch(() => undefined);
        const subnet = full?.IPAM?.Config?.[0]?.Subnet;
        out.push({
          name: n.Name,
          driver: n.Driver,
          ...(subnet ? { subnet } : {}),
          containers: Object.values(full?.Containers ?? {})
            .map((x) => x.Name ?? "")
            .filter(Boolean),
        });
      }
      return out;
    },
    async host() {
      let osName = `${os.type()} ${os.release()}`;
      if (process.platform === "linux") {
        const rel = await fs.readFile("/etc/os-release", "utf8").catch(() => "");
        const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(rel)?.[1];
        if (pretty) osName = `${pretty} (kernel ${os.release()})`;
      }
      const mounts =
        process.platform === "linux"
          ? parseMountinfoFull(await fs.readFile("/proc/self/mountinfo", "utf8").catch(() => ""))
          : [];
      const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
        /^(docker|br-|veth|lo)/.test(name)
          ? []
          : (addrs ?? [])
              .filter((a) => a.family === "IPv4" && !a.internal)
              .map((a) => ({ name, address: a.address })),
      );
      return { name: os.hostname(), os: osName, hearthVersion: deps.version, mounts, interfaces };
    },
    async services() {
      const rows = await deps.handle.db
        .select()
        .from(t.services)
        .where(eq(t.services.lifecycle, "active"));
      return rows
        .filter((s) => !s.checkTarget?.startsWith("demo:"))
        .map((s) => {
          const app = appKindOf(s);
          return { id: s.id, name: s.name, localUrl: s.localUrl, ...(app ? { app } : {}) };
        });
    },
    async vault() {
      return (await deps.vault.list()).map((v) => ({
        name: v.name,
        kind: v.kind,
        tier: v.tier,
        ...(v.serviceId ? { serviceId: v.serviceId } : {}),
      }));
    },
    async readFile(file) {
      const st = await fs.stat(file).catch(() => undefined);
      if (!st?.isFile() || st.size > MAX_FILE) return undefined;
      return fs.readFile(file, "utf8");
    },
    async exists(file) {
      return fs.stat(file).then(
        () => true,
        () => false,
      );
    },
    async notes() {
      return (await getSetting(deps.handle.db, "blueprint_notes")) ?? "";
    },
    now: () => new Date(),
  };
}

/** The real drives and shares, once each (Docker's and snap's internal mounts left out). */
function parseMountinfoFull(text: string) {
  const out: { source: string; target: string; fsType: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const parts = line.split(" ");
    const dash = parts.indexOf("-");
    if (dash < 6) continue;
    const target = parts[4]!.replace(/\\040/g, " ");
    const fsType = parts[dash + 1]!;
    const source = parts[dash + 2] ?? "";
    if (!REAL_FS.test(fsType)) continue;
    if (
      /^\/(var\/lib\/docker|snap|run|proc|sys)\b/.test(target) ||
      /\/docker\/.+\/(merged|overlay2)/.test(target)
    )
      continue;
    if (seen.has(target)) continue;
    seen.add(target);
    out.push({ source, target, fsType });
  }
  return out;
}

/** This machine, or (browser tests, DC_FAKE_APPS=1) a stand-in one with Hearth's real lists. */
export function blueprintSource(deps: {
  handle: DbHandle;
  vault: Pick<Vault, "list">;
  version: string;
  fake?: boolean;
}): AssembleSource {
  const real = machineSource(deps);
  return deps.fake ? fakeMachine(real.vault, real.services, real.notes) : real;
}
