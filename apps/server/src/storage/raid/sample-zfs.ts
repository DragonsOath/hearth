import type { ElevatedResponse, Params } from "../../elevated/protocol";
import type { RunOut } from "./io";

/**
 * ZFS on the simulated machine (DC_FAKE_RAID): a healthy six-drive RAID-Z2 pool with one drive
 * showing checksum errors, scrubbed nine days ago. It answers zpool and zfs the way OpenZFS 2.2
 * prints them and applies approved zfs.* operations, including scrubs and rebuilds that progress
 * over time.
 */

interface Leaf {
  kname: string;
  state: "ONLINE" | "FAULTED" | "OFFLINE" | "UNAVAIL" | "REMOVED" | "AVAIL";
  read: number;
  write: number;
  cksum: number;
  /** Being rebuilt onto, replacing this one. */
  replaces?: Leaf;
}
interface Vdev {
  name: string;
  type: "mirror" | "raidz1" | "raidz2" | "raidz3" | "disk";
  leaves: Leaf[];
}
export interface SimPool {
  name: string;
  guid: string;
  vdevs: Vdev[];
  spares: Leaf[];
  scan?: { kind: "scrub" | "resilver"; started: number; durationMs: number };
  paused?: number;
  last?: { kind: "scrub" | "resilver" | "canceled"; at: number; errors: number };
  usedBytes: number;
  leafBytes: number;
  autoexpand: boolean;
  mount: string;
}

const TB = 1e12;

export interface SampleDisks {
  /** A free drive's size, or why it cannot be used. */
  claim(
    device: unknown,
    serial: unknown,
    erase: unknown,
  ): string | { kname: string; sizeBytes: number };
  /** The member is on a pool's drive now (or no longer). */
  setZfs(kname: string, on: boolean): void;
}

export class SampleZfs {
  pools: SimPool[];
  constructor(
    private readonly now: () => number,
    private readonly runMs: number,
  ) {
    const leaf = (kname: string, cksum = 0): Leaf => ({
      kname,
      state: "ONLINE",
      read: 0,
      write: 0,
      cksum,
    });
    this.pools = [
      {
        name: "tank",
        guid: "11742398420934859102",
        vdevs: [
          {
            name: "raidz2-0",
            type: "raidz2",
            leaves: [
              leaf("sdi1"),
              leaf("sdj1"),
              leaf("sdk1"),
              leaf("sdl1", 3),
              leaf("sdm1"),
              leaf("sdn1"),
            ],
          },
        ],
        spares: [],
        last: { kind: "scrub", at: now() - 9 * 86_400_000, errors: 0 },
        usedBytes: 29.3 * TB,
        leafBytes: 12 * TB,
        autoexpand: false,
        mount: "/mnt/tank",
      },
    ];
  }

  /** Scrubs and rebuilds finish when their time is up. */
  tick() {
    for (const p of this.pools) {
      if (!p.scan || this.now() - p.scan.started < p.scan.durationMs) continue;
      p.last = { kind: p.scan.kind, at: p.scan.started + p.scan.durationMs, errors: 0 };
      if (p.scan.kind === "resilver")
        for (const v of p.vdevs) for (const l of v.leaves) delete l.replaces;
      p.scan = undefined;
    }
  }

  private pct(p: SimPool) {
    if (!p.scan) return p.paused ?? 0;
    return Math.min(99.9, ((this.now() - p.scan.started) / p.scan.durationMs) * 100);
  }

  private health(p: SimPool) {
    const bad = (l: Leaf) => !["ONLINE", "AVAIL"].includes(l.state);
    const worst = Math.max(
      ...p.vdevs.map((v) => v.leaves.filter((l) => bad(l) || l.replaces).length),
    );
    return worst === 0 ? "ONLINE" : "DEGRADED";
  }

  private statusText(p: SimPool) {
    const when = (t: number) => new Date(t).toString().replace(/ GMT.*$/, "");
    let scan = "none requested";
    if (p.scan?.kind === "scrub")
      scan = `scrub in progress since ${when(p.scan.started)}\n\t${Math.round(this.pct(p) * 0.433)}T / 43.3T scanned at 1.21G/s, ${Math.round(this.pct(p) * 0.433)}T / 43.3T issued at 1.18G/s\n\t0B repaired, ${this.pct(p).toFixed(2)}% done, ${hms(p.scan.durationMs * (1 - this.pct(p) / 100) * 400)} to go`;
    else if (p.scan?.kind === "resilver")
      scan = `resilver in progress since ${when(p.scan.started)}\n\t${Math.round(this.pct(p) * 0.433)}T / 43.3T scanned at 980M/s, ${Math.round(this.pct(p) * 0.07)}T / 7.1T issued at 960M/s\n\t${Math.round(this.pct(p) * 0.07)}T resilvered, ${this.pct(p).toFixed(2)}% done, ${hms(p.scan.durationMs * (1 - this.pct(p) / 100) * 400)} to go`;
    else if (p.paused !== undefined)
      scan = `scrub paused since ${when(this.now() - 60_000)}\n\tscrub started on ${when(this.now() - 3_600_000)}\n\t0B scanned, 0B issued, 43.3T total\n\t0B repaired, ${p.paused.toFixed(2)}% done`;
    else if (p.last?.kind === "scrub")
      scan = `scrub repaired 0B in 14:02:31 with ${p.last.errors} errors on ${when(p.last.at)}`;
    else if (p.last?.kind === "resilver")
      scan = `resilvered 7.10T in 09:12:44 with 0 errors on ${when(p.last.at)}`;
    else if (p.last?.kind === "canceled") scan = `scrub canceled on ${when(p.last.at)}`;
    const row = (indent: string, name: string, state: string, l?: Leaf) =>
      `\t${indent}${name.padEnd(24 - indent.length)}${state.padEnd(10)}${l ? `${l.read}     ${l.write}     ${l.cksum}` : "0     0     0"}`;
    const lines: string[] = [row("", p.name, this.health(p))];
    for (const v of p.vdevs) {
      const vState = v.leaves.some((l) => l.state !== "ONLINE" || l.replaces)
        ? "DEGRADED"
        : "ONLINE";
      if (v.type !== "disk") lines.push(row("  ", v.name, vState));
      const ind = v.type === "disk" ? "  " : "    ";
      for (const l of v.leaves) {
        if (l.replaces) {
          lines.push(row(ind, "replacing-0", "DEGRADED"));
          const o = l.replaces;
          lines.push(`${row(`${ind}  `, `/dev/${o.kname}`, o.state, o)}`);
          lines.push(`${row(`${ind}  `, `/dev/${l.kname}`, "ONLINE", l)}  (resilvering)`);
          continue;
        }
        const name =
          l.state === "REMOVED" || l.state === "UNAVAIL" ? guidOf(l.kname) : `/dev/${l.kname}`;
        lines.push(
          `${row(ind, name, l.state, l)}${l.state === "UNAVAIL" || l.state === "REMOVED" ? `  was /dev/${l.kname}` : ""}`,
        );
      }
    }
    if (p.spares.length) {
      lines.push("\tspares");
      for (const s of p.spares) lines.push(`\t  /dev/${s.kname.padEnd(18)}${s.state}`);
    }
    const health = this.health(p);
    return [
      `  pool: ${p.name}`,
      ` state: ${health}`,
      ...(health === "DEGRADED"
        ? [
            "status: One or more devices is currently being resilvered.  The pool will",
            "\tcontinue to function, possibly in a degraded state.",
            "action: Wait for the resilver to complete.",
          ]
        : p.vdevs.some((v) => v.leaves.some((l) => l.cksum))
          ? [
              "status: One or more devices has experienced an unrecoverable error.  An",
              "\tattempt was made to correct the error.  Applications are unaffected.",
              "action: Determine if the device needs to be replaced, and clear the errors",
              "\tusing 'zpool clear' or replace the device with 'zpool replace'.",
              "   see: https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-9P",
            ]
          : []),
      `  scan: ${scan}`,
      "config:",
      "",
      "\tNAME                      STATE     READ WRITE CKSUM",
      ...lines,
      "",
      "errors: No known data errors",
      "",
    ].join("\n");
  }

  /** zpool, zfs: what the simulated machine prints. */
  run(cmd: string, args: string[]): RunOut | undefined {
    this.tick();
    const a = args.join(" ");
    if (cmd === "zpool" && args[0] === "list")
      return {
        code: 0,
        out: this.pools
          .map((p) => {
            const raw = p.vdevs.reduce((n, v) => n + v.leaves.length, 0) * p.leafBytes;
            return [
              p.name,
              raw,
              Math.round(p.usedBytes * 1.5),
              raw - Math.round(p.usedBytes * 1.5),
              this.health(p),
              p.guid,
              p.autoexpand ? "on" : "off",
              "-",
              "3",
              String(Math.round((p.usedBytes * 1.5 * 100) / raw)),
            ].join("\t");
          })
          .join("\n"),
      };
    if (cmd === "zpool" && args[0] === "status")
      return { code: 0, out: this.pools.map((p) => this.statusText(p)).join("\n") };
    if (cmd === "zfs" && args[0] === "get") {
      const p = this.pools.find((x) => x.name === args.at(-1));
      if (!p) return { code: 1, out: "dataset does not exist" };
      const usable = p.vdevs.reduce(
        (n, v) =>
          n +
          p.leafBytes *
            (v.type === "mirror"
              ? 1
              : v.type === "disk"
                ? 1
                : v.leaves.length - Number(v.type.slice(-1))),
        0,
      );
      return {
        code: 0,
        out: `used\t${p.usedBytes}\navailable\t${Math.round(usable * 0.9 - p.usedBytes)}\nmountpoint\t${p.mount}\n`,
      };
    }
    if (cmd === "zfs" && a === "version")
      return { code: 0, out: "zfs-2.2.2-0ubuntu9\nzfs-kmod-2.2.2-0ubuntu9\n" };
    return undefined;
  }

  members() {
    return this.pools.flatMap((p) => [
      ...p.vdevs.flatMap((v) =>
        v.leaves.flatMap((l) => [l.kname, ...(l.replaces ? [l.replaces.kname] : [])]),
      ),
      ...p.spares.map((s) => s.kname),
    ]);
  }

  perform(op: string, params: Params, disks: SampleDisks): ElevatedResponse {
    this.tick();
    const fail = (result: string, outcome: "refused" | "stale" = "refused"): ElevatedResponse => ({
      ok: false,
      outcome,
      result,
    });
    const done = (result: string): ElevatedResponse => ({ ok: true, outcome: "done", result });
    if (op === "zfs.create") {
      const devs = (params.devices as { device: string; serial?: string; erase?: boolean }[]) ?? [];
      const got: { kname: string; sizeBytes: number }[] = [];
      for (const d of devs) {
        const c = disks.claim(d.device, d.serial, d.erase);
        if (typeof c === "string") return fail(c);
        got.push(c);
      }
      const level = String(params.level);
      for (const g of got) disks.setZfs(g.kname, true);
      this.pools.push({
        name: String(params.name),
        guid: String(1e18 + this.pools.length * 7919),
        vdevs:
          level === "stripe"
            ? got.map((g) => ({
                name: `${g.kname}1`,
                type: "disk" as const,
                leaves: [mk(`${g.kname}1`)],
              }))
            : [
                {
                  name: `${level}-0`,
                  type: level as Vdev["type"],
                  leaves: got.map((g) => mk(`${g.kname}1`)),
                },
              ],
        spares: [],
        usedBytes: 0,
        leafBytes: Math.min(...got.map((g) => g.sizeBytes)),
        autoexpand: false,
        mount: `/mnt/${String(params.name)}`,
      });
      return done(`Created the ZFS pool ${String(params.name)}.`);
    }
    const p = this.pools.find((x) => x.name === params.pool);
    if (!p) return fail(`${String(params.pool)} is not an imported pool.`, "stale");
    const find = (dev: unknown) => {
      const k = String(dev ?? "").replace(/^\/dev\//, "");
      for (const v of p.vdevs)
        for (const l of v.leaves) if (l.kname === k || guidOf(l.kname) === k) return { v, l };
      return undefined;
    };
    if (op === "zfs.scrub") {
      if (params.action === "start") {
        if (p.scan) return fail("Busy.", "stale");
        const from = p.paused ?? 0;
        p.paused = undefined;
        p.scan = {
          kind: "scrub",
          started: this.now() - (from / 100) * this.runMs,
          durationMs: this.runMs,
        };
        return done(from ? `The scrub continues on ${p.name}.` : `A scrub started on ${p.name}.`);
      }
      if (params.action === "pause" && p.scan?.kind === "scrub") {
        p.paused = this.pct(p);
        p.scan = undefined;
        return done(`The scrub on ${p.name} is paused.`);
      }
      if (params.action === "cancel" && (p.scan?.kind === "scrub" || p.paused !== undefined)) {
        p.scan = undefined;
        p.paused = undefined;
        p.last = { kind: "canceled", at: this.now(), errors: 0 };
        return done(`The scrub on ${p.name} was stopped.`);
      }
      return fail("Not scrubbing.", "stale");
    }
    if (op === "zfs.clear") {
      for (const v of p.vdevs)
        for (const l of v.leaves) Object.assign(l, { read: 0, write: 0, cksum: 0 });
      return done(`${p.name}'s error counts were cleared.`);
    }
    if (op === "zfs.grow") return done(`${p.name} has no unused space to take.`);
    if (op !== "zfs.member") return fail(`${op} is not simulated.`);
    switch (params.action) {
      case "replace": {
        const old = find(params.replaces);
        if (!old) return fail("Not in the pool.", "stale");
        const c = disks.claim(params.device, params.serial, params.erase);
        if (typeof c === "string") return fail(c, /approved/.test(c) ? "stale" : "refused");
        if (c.sizeBytes < p.leafBytes) return fail("The new drive is too small.");
        disks.setZfs(c.kname, true);
        const i = old.v.leaves.indexOf(old.l);
        old.v.leaves[i] = { ...mk(`${c.kname}1`), replaces: old.l };
        p.scan = { kind: "resilver", started: this.now(), durationMs: this.runMs };
        p.paused = undefined;
        return done(
          `${String(params.device)} is replacing /dev/${old.l.kname}; ZFS is rebuilding onto it.`,
        );
      }
      case "add-spare": {
        const c = disks.claim(params.device, params.serial, params.erase);
        if (typeof c === "string") return fail(c);
        disks.setZfs(c.kname, true);
        p.spares.push({ ...mk(`${c.kname}1`), state: "AVAIL" });
        return done(`${String(params.device)} is a hot spare of ${p.name}.`);
      }
      case "remove-spare": {
        const k = String(params.device).replace(/^\/dev\//, "");
        const s = p.spares.find((x) => x.kname === k);
        if (!s) return fail("Not a spare.", "stale");
        p.spares = p.spares.filter((x) => x !== s);
        disks.setZfs(k.replace(/1$/, ""), false);
        return done(`The spare ${String(params.device)} was removed.`);
      }
      case "offline":
      case "online": {
        const m = find(params.device);
        if (!m) return fail("Not in the pool.", "stale");
        m.l.state = params.action === "offline" ? "OFFLINE" : "ONLINE";
        return done(`${String(params.device)} is ${m.l.state.toLowerCase()}.`);
      }
      default:
        return fail("Not available in the sample.");
    }
  }
}

function mk(kname: string): Leaf {
  return { kname, state: "ONLINE", read: 0, write: 0, cksum: 0 };
}

/** A stable made-up GUID for a missing drive. */
function guidOf(kname: string) {
  let h = 7;
  for (const c of kname) h = (h * 31 + c.charCodeAt(0)) % 1e9;
  return `${h}${"4823019".repeat(2)}`.slice(0, 19);
}

function hms(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
