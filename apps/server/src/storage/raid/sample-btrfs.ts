import type { ElevatedResponse, Params } from "../../elevated/protocol";
import type { RunOut } from "./io";

/**
 * Btrfs on the simulated Linux machine (DC_FAKE_RAID): "vault", RAID 1 over two 6 TB drives,
 * mounted at /srv/vault, scrubbed three days ago. It answers the kernel's /sys/fs/btrfs files and
 * btrfs's own reports, and applies approved btrfs.* operations (scrubs, balances and conversions,
 * adding, replacing, and removing drives) that progress over time.
 */

export const VAULT_UUID = "8f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b";

interface Fs {
  uuid: string;
  label: string;
  mount: string;
  devices: string[];
  profile: string;
  busy?: { op: "balance" | "device replace" | "device remove"; started: number; then: () => void };
  scrub?: { started: number; paused?: number; finished?: number };
  errors: Record<string, number>;
}

export class SampleBtrfs {
  fss: Fs[];
  constructor(
    private readonly now: () => number,
    private readonly runMs: number,
  ) {
    this.fss = [
      {
        uuid: VAULT_UUID,
        label: "vault",
        mount: "/srv/vault",
        devices: ["sdt", "sdu"],
        profile: "raid1",
        scrub: { started: now() - 3 * 86_400_000, finished: now() - 3 * 86_400_000 + 7_200_000 },
        errors: {},
      },
    ];
  }

  private tick() {
    for (const f of this.fss) {
      if (f.busy && this.now() - f.busy.started >= this.runMs) {
        f.busy.then();
        f.busy = undefined;
      }
      if (
        f.scrub &&
        !f.scrub.finished &&
        f.scrub.paused === undefined &&
        this.now() - f.scrub.started >= this.runMs
      )
        f.scrub.finished = f.scrub.started + this.runMs;
    }
  }

  /** Which drives are Btrfs members now (for lsblk's FSTYPE and UUID). */
  memberOf(kname: string) {
    this.tick();
    return this.fss.find((f) => f.devices.includes(kname));
  }

  files(): Record<string, string> {
    this.tick();
    const out: Record<string, string> = { "/usr/bin/btrfs": "", "/usr/sbin/mkfs.btrfs": "" };
    for (const f of this.fss) {
      const b = `/sys/fs/btrfs/${f.uuid}`;
      out[`${b}/label`] = f.label;
      out[`${b}/exclusive_operation`] = f.busy?.op ?? "none";
      out[`${b}/allocation/data/${f.profile}/total_bytes`] = "1";
      out[`${b}/allocation/metadata/${f.profile === "raid1c3" ? "raid1c3" : "raid1"}/total_bytes`] =
        "1";
      f.devices.forEach((d, i) => {
        out[`${b}/devinfo/${i + 1}/missing`] = "0";
        out[`${b}/devices/${d}`] = "";
      });
    }
    return out;
  }

  run(cmd: string, args: string[]): RunOut | undefined {
    if (cmd !== "btrfs") return undefined;
    this.tick();
    const f = this.fss.find((x) => x.mount === args.at(-1));
    if (!f) return { code: 1, out: "not a btrfs filesystem" };
    if (args[0] === "device" && args[1] === "stats")
      return {
        code: 0,
        out: f.devices
          .map((d) =>
            ["write_io", "read_io", "flush_io", "corruption", "generation"]
              .map((k) => `[/dev/${d}].${k}_errs   ${k === "corruption" ? (f.errors[d] ?? 0) : 0}`)
              .join("\n"),
          )
          .join("\n"),
      };
    if (args[0] === "scrub" && args[1] === "status") {
      const s = f.scrub;
      if (!s) return { code: 0, out: "UUID: x\n\tno stats available\n" };
      const running = !s.finished && s.paused === undefined;
      const pct = running
        ? Math.min(99, Math.round(((this.now() - s.started) / this.runMs) * 100))
        : undefined;
      return {
        code: 0,
        out: [
          `UUID:             ${f.uuid}`,
          `Scrub started:    ${new Date(s.started).toString().replace(/ GMT.*$/, "")}`,
          `Status:           ${running ? "running" : s.paused !== undefined ? "aborted" : "finished"}`,
          running ? `Bytes scrubbed:   1.20TiB  (${pct}%)` : "Duration:         2:00:00",
          "Error summary:    no errors found",
        ].join("\n"),
      };
    }
    return { code: 1, out: "not simulated" };
  }

  perform(
    op: string,
    params: Params,
    claim: (d: unknown, s: unknown, e: unknown) => string | { kname: string },
  ): ElevatedResponse {
    this.tick();
    const fail = (result: string, outcome: "refused" | "stale" = "refused"): ElevatedResponse => ({
      ok: false,
      outcome,
      result,
    });
    const done = (result: string): ElevatedResponse => ({ ok: true, outcome: "done", result });
    if (op === "btrfs.create") {
      const list = (params.devices as { device: string; serial?: string; erase?: boolean }[]) ?? [];
      const got: string[] = [];
      for (const d of list) {
        const c = claim(d.device, d.serial, d.erase);
        if (typeof c === "string") return fail(c);
        got.push(c.kname);
      }
      this.fss.push({
        uuid: `0000${this.fss.length}abc-1111-2222-3333-444455556666`,
        label: String(params.name),
        mount: "",
        devices: got,
        profile: String(params.profile),
        errors: {},
      });
      return done(`Created the Btrfs filesystem ${String(params.name)}.`);
    }
    const f = this.fss.find((x) => x.mount === params.mount);
    if (!f) return fail(`${String(params.mount)} is not a mounted Btrfs filesystem.`, "stale");
    if (op === "btrfs.scrub") {
      if (params.action === "start") {
        f.scrub = { started: this.now() };
        return done(`A scrub started on ${f.mount}.`);
      }
      if (params.action === "cancel" && f.scrub && !f.scrub.finished) {
        f.scrub.paused = this.now();
        return done("The scrub was stopped; it can resume from there.");
      }
      if (params.action === "resume" && f.scrub?.paused !== undefined) {
        f.scrub = { started: this.now() - (f.scrub.paused - f.scrub.started) };
        return done("The scrub continues.");
      }
      return fail("Nothing to do.", "stale");
    }
    if (op === "btrfs.clear") {
      f.errors = {};
      return done("Done.");
    }
    if (f.busy) return fail(`Busy (${f.busy.op}).`, "stale");
    if (op === "btrfs.balance") {
      const to = typeof params.convert === "string" ? params.convert : undefined;
      f.busy = { op: "balance", started: this.now(), then: () => (f.profile = to ?? f.profile) };
      return done(to ? `Converting to ${to}.` : "Balancing.");
    }
    if (op === "btrfs.member") {
      const dev = String(params.device ?? "").replace(/^\/dev\//, "");
      if (params.action === "add" || params.action === "replace") {
        const c = claim(params.device, params.serial, params.erase);
        if (typeof c === "string") return fail(c, /approved/.test(c) ? "stale" : "refused");
        if (params.action === "add") {
          f.devices.push(c.kname);
          return done(`${String(params.device)} joined ${f.mount}.`);
        }
        const old = String(params.replaces).replace(/^\/dev\//, "");
        f.devices.push(c.kname);
        f.busy = {
          op: "device replace",
          started: this.now(),
          then: () => (f.devices = f.devices.filter((d) => d !== old)),
        };
        return done(`${String(params.device)} is replacing ${String(params.replaces)}.`);
      }
      if (params.action === "remove") {
        if (!f.devices.includes(dev)) return fail("Not in the filesystem.", "stale");
        if (f.devices.length <= 2 && f.profile === "raid1")
          return fail("unable to go below two devices on raid1");
        f.busy = {
          op: "device remove",
          started: this.now(),
          then: () => (f.devices = f.devices.filter((d) => d !== dev)),
        };
        return done(`Removing ${String(params.device)}.`);
      }
    }
    return fail(`${op} is not simulated.`);
  }
}
