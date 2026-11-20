import type { Blocker, SmartAttribute, SmartReport } from "@dragon-control/core";
import type { Elevation } from "../admin/elevation";
import type { LayoutNode } from "./center";

/**
 * Drive health from the drives themselves (SMART), read through the elevated executor's read-only
 * smart.read operation. Hearth's own account never opens a drive. Reports are cached, because a
 * SMART read is real work for a drive, and a sleeping drive is left asleep by the executor.
 */

/** The attributes that matter for a hard drive's health, by their standard ATA ids. */
const ATA_KEY: Record<number, string> = {
  5: "Reallocated sectors",
  9: "Power-on hours",
  187: "Reported uncorrectable errors",
  188: "Command timeouts",
  194: "Temperature",
  196: "Reallocation events",
  197: "Pending sectors",
  198: "Offline uncorrectable sectors",
  199: "Cable or connection (CRC) errors",
};
/** Counts where anything above zero means the surface is wearing out. */
const BAD_IF_ANY = new Set([5, 187, 197, 198]);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** smartctl's JSON (from the executor), in plain words, with the evidence for the verdict. */
export function parseSmart(device: string, raw: unknown, at: string): SmartReport {
  const j = obj(raw) ?? {};
  const messages = (
    (obj(j.smartctl)?.messages as unknown[] | undefined)?.map((m) => str(obj(m)?.string)) ?? []
  ).filter((m): m is string => Boolean(m));
  const via = str(obj(j.hearth)?.via);
  const base: SmartReport = {
    device,
    readAt: at,
    verdict: "unknown",
    attributes: [],
    reasons: [],
    ...(str(j.model_name) ? { model: str(j.model_name) } : {}),
    ...(str(j.serial_number) ? { serial: str(j.serial_number) } : {}),
    ...(str(j.firmware_version) ? { firmware: str(j.firmware_version) } : {}),
    ...(via === "sat" ? { via: "USB (SAT passthrough)" } : {}),
  };
  if (messages.some((m) => /STANDBY|SLEEP/i.test(m)))
    return {
      ...base,
      asleep: true,
      unavailable:
        "The drive is asleep. Hearth does not wake drives to read their health; it reads again once the drive is in use.",
    };
  const status = obj(j.smart_status);
  const supported = obj(j.smart_support);
  if (!status && !obj(j.ata_smart_attributes) && !obj(j.nvme_smart_health_information_log)) {
    const bridge = messages.find((m) => /USB bridge|device type|Unsupported|Unavailable/i.test(m));
    return {
      ...base,
      unavailable: bridge
        ? `This drive's ${base.via || /usb/i.test(bridge) ? "USB enclosure" : "connection"} does not pass SMART through (smartctl: "${bridge}"). The drive itself may be fine; its health cannot be read through this enclosure. Connecting it by SATA, or an enclosure that supports SAT passthrough, would show it.`
        : supported?.available === false
          ? "This drive does not support SMART."
          : `smartctl returned no health data${messages[0] ? ` ("${messages[0]}")` : ""}.`,
    };
  }

  const reasons: string[] = [];
  let verdict: SmartReport["verdict"] = status?.passed === false ? "failing" : "healthy";
  if (status?.passed === false) reasons.push("The drive's own overall health test says FAILED.");
  const attributes: SmartAttribute[] = [];
  const table = (obj(j.ata_smart_attributes)?.table as unknown[] | undefined) ?? [];
  for (const row of table.map(obj)) {
    const id = num(row?.id);
    if (id === undefined || !(id in ATA_KEY)) continue;
    const rawValue = num(obj(row?.raw)?.value) ?? 0;
    const failed = str(row?.when_failed);
    // Temperature and power-on hours pack extra data in the high bytes: use the low ones.
    const value = id === 194 ? rawValue & 0xff : id === 9 ? rawValue & 0xffffffff : rawValue;
    const bad = failed === "now" || (BAD_IF_ANY.has(id) && value > 0);
    attributes.push({
      id,
      name: ATA_KEY[id]!,
      value,
      ...(num(row?.value) !== undefined ? { normalized: num(row?.value) } : {}),
      ...(num(row?.thresh) !== undefined ? { threshold: num(row?.thresh) } : {}),
      ...(bad ? { attention: true } : {}),
    });
    if (failed === "now") {
      verdict = "failing";
      reasons.push(`${ATA_KEY[id]} is below the drive's own failure threshold.`);
    } else if (bad) {
      if (verdict === "healthy") verdict = "warning";
      reasons.push(`${ATA_KEY[id]}: ${value.toLocaleString("en-US")}.`);
    }
  }
  const nvme = obj(j.nvme_smart_health_information_log);
  if (nvme) {
    const add = (name: string, v: number | undefined, bad: boolean) => {
      if (v === undefined) return;
      attributes.push({ id: 0, name, value: v, ...(bad ? { attention: true } : {}) });
      if (bad) {
        if (verdict === "healthy") verdict = "warning";
        reasons.push(`${name}: ${v.toLocaleString("en-US")}.`);
      }
    };
    const warning = num(nvme.critical_warning);
    if (warning) {
      verdict = "failing";
      reasons.push("The drive raised a critical warning.");
    }
    add("Rated life used (%)", num(nvme.percentage_used), (num(nvme.percentage_used) ?? 0) >= 90);
    add("Spare capacity left (%)", num(nvme.available_spare), false);
    add("Media errors", num(nvme.media_errors), (num(nvme.media_errors) ?? 0) > 0);
    add("Unsafe shutdowns", num(nvme.unsafe_shutdowns), false);
  }
  if (verdict === "healthy" && status?.passed === undefined) verdict = "unknown";
  const temperatureC = num(obj(j.temperature)?.current);
  const powerOnHours = num(obj(j.power_on_time)?.hours);
  const test = latestTest(j);
  return {
    ...base,
    verdict,
    reasons,
    attributes,
    ...(temperatureC !== undefined ? { temperatureC } : {}),
    ...(powerOnHours !== undefined ? { powerOnHours } : {}),
    ...(num(j.power_cycle_count) !== undefined ? { powerCycles: num(j.power_cycle_count) } : {}),
    ...(test ? { lastSelfTest: test } : {}),
  };
}

function latestTest(j: Json): SmartReport["lastSelfTest"] {
  const ata = obj(obj(j.ata_smart_self_test_log)?.standard)?.table as unknown[] | undefined;
  const nvme = obj(j.nvme_self_test_log)?.table as unknown[] | undefined;
  const row = obj(ata?.[0] ?? nvme?.[0]);
  if (!row) return undefined;
  const kind = str(obj(row.type)?.string) ?? str(obj(row.self_test_code)?.string) ?? "Self-test";
  const result =
    str(obj(row.status)?.string) ?? str(obj(row.self_test_result)?.string) ?? "unknown";
  const hours = num(row.lifetime_hours) ?? num(row.power_on_hours);
  return {
    kind,
    result,
    passed: obj(row.status)?.passed === true || /without error|completed/i.test(result),
    ...(hours !== undefined ? { atHours: hours } : {}),
  };
}

/** Whole drives from the layout, with the mount points on them (to match Hearth's drive list). */
export function drivesOf(layout: LayoutNode[]): { device: string; mounts: string[] }[] {
  const mounts = (n: LayoutNode): string[] => [
    ...(n.mount ? [n.mount] : []),
    ...n.children.flatMap(mounts),
  ];
  return layout
    .filter((n) => n.type === "disk" && !/^(loop|ram|zram|sr)/.test(n.name))
    .map((n) => ({ device: `/dev/${n.name}`, mounts: mounts(n) }));
}

const CACHE_MS = 30 * 60_000;

export class SmartReader {
  private cache = new Map<string, { at: number; report: SmartReport }>();

  constructor(private readonly elevation?: Elevation) {}

  /** Why SMART cannot be read yet, and what would make it possible (never a dead end). */
  async blocker(): Promise<Blocker | undefined> {
    if (process.platform === "win32") return undefined;
    if (!this.elevation)
      return {
        kind: "capability",
        title: "Drive health detail needs Hearth's elevated executor.",
        detail:
          "SMART data (reallocated and pending sectors, self-tests) is read from the raw drive, which only root may open. Hearth reads it through the elevated executor's read-only smart.read operation; it is not set up here.",
      };
    const ok = await this.elevation.covers("smart.read");
    if (ok.ok) return undefined;
    return {
      kind: "capability",
      title: ok.scope
        ? "Drive health detail is off in the elevated executor."
        : "Drive health detail needs Hearth's elevated executor.",
      detail: ok.scope
        ? "The executor is installed, but its read-only smart.read operation is not switched on. On the machine: sudo bash deploy/linux/install-elevation.sh --service hearth --add-operation smart.read (look first with --dry-run). It lets the executor open whole drives read-only; Hearth's own account still never does."
        : `SMART data is read from the raw drive, which only root may open. Hearth reads it through the elevated executor's read-only smart.read operation, so its own account never gets raw disk access. ${ok.why}`,
    };
  }

  /** Each drive's report, from cache when fresh. `force` reads again (an explicit check). */
  async read(layout: LayoutNode[], force = false): Promise<SmartReport[]> {
    if (!this.elevation || (await this.blocker())) return [];
    const out: SmartReport[] = [];
    for (const d of drivesOf(layout)) {
      const hit = this.cache.get(d.device);
      if (!force && hit && Date.now() - hit.at < CACHE_MS) {
        out.push({ ...hit.report, mounts: d.mounts });
        continue;
      }
      const at = new Date().toISOString();
      const r = await this.elevation.read("smart.read", { device: d.device });
      const report: SmartReport = r.ok
        ? parseSmart(d.device, r.data, at)
        : {
            device: d.device,
            readAt: at,
            verdict: "unknown",
            attributes: [],
            reasons: [],
            unavailable: `The executor did not read this drive: ${r.result}`,
          };
      this.cache.set(d.device, { at: Date.now(), report });
      out.push({ ...report, mounts: d.mounts });
    }
    return out;
  }
}
