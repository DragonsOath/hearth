import type { Fetch } from "./http";

/**
 * A stand-in Proxmox VE 9 (port 8006) for tests and safe previews (DC_FAKE_APPS=1, never in a real
 * install), answering as Proxmox's own API code describes (pve-manager, qemu-server,
 * pve-container, pve-storage): an API token that starts "root@pam!e2e=", cluster resources (one
 * node, two VMs, a container and a template), storage, backup jobs and files, tasks (one failed
 * backup), snapshots, and the start, shutdown, reboot, stop, vzdump and snapshot calls, each
 * answering with a task id whose status is then "stopped, OK".
 */

export interface FakeProxmox {
  fetch: Fetch;
  reset(): void;
  guests(): Guest[];
}

interface Guest {
  id: string;
  type: "qemu" | "lxc";
  vmid: number;
  name: string;
  status: "running" | "stopped";
  template: number;
  snapshots: string[];
}

const GB = 1024 ** 3;

export function fakeProxmox(): FakeProxmox {
  let guests: Guest[] = [];
  let backups: { volid: string; vmid: number; ctime: number; size: number }[] = [];
  let tasks: {
    upid: string;
    type: string;
    id: string;
    status: string;
    starttime: number;
    endtime: number;
  }[] = [];
  let n = 0;
  const now = () => Math.floor(Date.now() / 1000);
  const reset = () => {
    guests = [
      {
        id: "qemu/100",
        type: "qemu",
        vmid: 100,
        name: "home-assistant",
        status: "running",
        template: 0,
        snapshots: ["before-update"],
      },
      {
        id: "qemu/101",
        type: "qemu",
        vmid: 101,
        name: "windows",
        status: "stopped",
        template: 0,
        snapshots: [],
      },
      {
        id: "lxc/200",
        type: "lxc",
        vmid: 200,
        name: "media",
        status: "running",
        template: 0,
        snapshots: [],
      },
      {
        id: "qemu/9000",
        type: "qemu",
        vmid: 9000,
        name: "debian-template",
        status: "stopped",
        template: 1,
        snapshots: [],
      },
    ];
    backups = [
      {
        volid: "local:backup/vzdump-qemu-100-2026_11_06-02_00_01.vma.zst",
        vmid: 100,
        ctime: now() - 30 * 3600,
        size: 3 * GB,
      },
      {
        volid: "local:backup/vzdump-lxc-200-2026_11_06-02_10_44.tar.zst",
        vmid: 200,
        ctime: now() - 29 * 3600,
        size: 5 * GB,
      },
    ];
    tasks = [
      {
        upid: "UPID:pve:0001:vzdump::root@pam:",
        type: "vzdump",
        id: "",
        status: "job errors",
        starttime: now() - 6 * 3600,
        endtime: now() - 6 * 3600 + 400,
      },
      {
        upid: "UPID:pve:0002:qmstart:100:root@pam:",
        type: "qmstart",
        id: "100",
        status: "OK",
        starttime: now() - 50 * 3600,
        endtime: now() - 50 * 3600 + 3,
      },
    ];
    n = 10;
  };
  reset();

  const reply = (status: number, data: unknown) => ({
    ok: status < 400,
    status,
    json: async () => ({ data }),
    text: async () => JSON.stringify(status < 400 ? { data } : { data: null, message: data }),
  });
  const task = (type: string, id: string) => {
    const upid = `UPID:pve:${(n++).toString(16).padStart(8, "0")}:${type}:${id}:root@pam!e2e:`;
    tasks.unshift({ upid, type, id, status: "OK", starttime: now(), endtime: now() });
    return reply(200, upid);
  };

  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname).replace(/^\/api2\/json/, "");
    const method = init.method ?? "GET";
    const auth = (init.headers as Record<string, string>).Authorization ?? "";
    if (!auth.startsWith("PVEAPIToken=root@pam!e2e=")) return reply(401, "authentication failure");
    const form = new URLSearchParams(init.body ?? "");

    if (p === "/version") return reply(200, { version: "9.1.1", release: "9.1", repoid: "e2e" });
    if (p === "/cluster/resources") {
      const vms = guests.map((g) => ({
        id: g.id,
        type: g.type,
        node: "pve",
        vmid: g.vmid,
        name: g.name,
        status: g.status,
        template: g.template,
        cpu: g.status === "running" ? 0.05 : 0,
        maxcpu: g.type === "lxc" ? 4 : 2,
        mem: g.status === "running" ? 2 * GB : 0,
        maxmem: 4 * GB,
        maxdisk: 32 * GB,
        disk: 0,
        uptime: g.status === "running" ? 86_400 : 0,
        tags: g.vmid === 100 ? "home;critical" : "",
      }));
      if (u.searchParams.get("type") === "vm") return reply(200, vms);
      return reply(200, [
        {
          id: "node/pve",
          type: "node",
          node: "pve",
          status: "online",
          cpu: 0.184,
          maxcpu: 16,
          mem: 41 * GB,
          maxmem: 64 * GB,
          disk: 22 * GB,
          maxdisk: 94 * GB,
          uptime: 1_814_400,
        },
        ...vms,
        {
          id: "storage/pve/local",
          type: "storage",
          node: "pve",
          storage: "local",
          status: "available",
          plugintype: "dir",
          shared: 0,
          content: "iso,vztmpl,backup",
          disk: 22 * GB,
          maxdisk: 94 * GB,
        },
        {
          id: "storage/pve/local-lvm",
          type: "storage",
          node: "pve",
          storage: "local-lvm",
          status: "available",
          plugintype: "lvmthin",
          shared: 0,
          content: "images,rootdir",
          disk: 760 * GB,
          maxdisk: 800 * GB,
        },
      ]);
    }
    if (p === "/cluster/backup")
      return reply(200, [
        {
          id: "backup-nightly",
          schedule: "02:00",
          enabled: 1,
          storage: "local",
          all: 1,
          mode: "snapshot",
        },
      ]);
    if (p === "/cluster/tasks")
      return reply(
        200,
        tasks.map((t) => ({ ...t, node: "pve", user: "root@pam" })),
      );
    if (p === "/nodes/pve/apt/update")
      return reply(200, [{ Package: "pve-manager" }, { Package: "proxmox-kernel" }]);
    if (p === "/nodes/pve/storage" && u.searchParams.get("content") === "backup")
      return reply(200, [
        { storage: "local", content: "iso,vztmpl,backup", active: 1, enabled: 1 },
      ]);
    if (p === "/nodes/pve/storage/local/content")
      return reply(
        200,
        backups.map((b) => ({ ...b, content: "backup", format: "vma.zst", protected: 0 })),
      );
    const status = p.match(/^\/nodes\/pve\/tasks\/(.+)\/status$/);
    if (status) {
      const t = tasks.find((x) => x.upid === status[1]);
      return t
        ? reply(200, { status: "stopped", exitstatus: t.status })
        : reply(404, "no such task");
    }
    if (p === "/nodes/pve/vzdump" && method === "POST") {
      const g = guests.find((x) => x.vmid === Number(form.get("vmid")));
      if (!g) return reply(400, "no such guest");
      backups.unshift({
        volid: `local:backup/vzdump-${g.type}-${g.vmid}-now.vma.zst`,
        vmid: g.vmid,
        ctime: now(),
        size: 3 * GB,
      });
      return task("vzdump", String(g.vmid));
    }
    const m = p.match(
      /^\/nodes\/pve\/(qemu|lxc)\/(\d+)\/(status\/(start|shutdown|reboot|stop)|snapshot)$/,
    );
    if (m) {
      const g = guests.find((x) => x.type === m[1] && x.vmid === Number(m[2]));
      if (!g) return reply(500, `Configuration file does not exist`);
      if (m[3] === "snapshot") {
        if (method === "GET")
          return reply(200, [
            ...g.snapshots.map((s, i) => ({
              name: s,
              snaptime: now() - (i + 1) * 86_400,
              description: "",
            })),
            { name: "current", description: "You are here!" },
          ]);
        const name = form.get("snapname") ?? "";
        if (g.snapshots.includes(name)) return reply(500, `snapshot name '${name}' already used`);
        g.snapshots.unshift(name);
        return task(`${m[1] === "lxc" ? "vz" : "qm"}snapshot`, String(g.vmid));
      }
      const op = m[4]!;
      g.status = op === "shutdown" || op === "stop" ? "stopped" : "running";
      return task(`${m[1] === "lxc" ? "vz" : "qm"}${op}`, String(g.vmid));
    }
    return reply(501, `Method '${method} ${p}' not implemented`);
  };

  return { fetch: fetchImpl, reset, guests: () => guests };
}
