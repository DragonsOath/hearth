import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PremiumPackageState } from "@dragon-control/core";

/**
 * The Premium package, delivered (11-22, launch-critical: a redeemed code unlocked nothing, because
 * nothing ever fetched the package; docs/design/PREMIUM.md "Premium package delivery").
 *
 * When this Hearth holds a licence in force and doesn't have a package that fits it, Hearth asks
 * the licence service for one, checks its signature against the package keys built into Hearth
 * (a package signed by anyone else is refused, even from the licence service), unpacks it into
 * <data>/addons/hearth-premium and reloads itself once nothing is running (no job, no build step,
 * no answer being written). The owner never restarts anything.
 *
 * It goes online only when Premium already does (the Pledge): when a code is redeemed, and once at
 * startup when a licensed Hearth has no fitting package or Hearth itself was updated. Never on a
 * schedule.
 */

/** The keys Premium packages are signed with (Ed25519, raw public key in base64url, by key id). */
export type PackageKeys = Record<string, string>;

/**
 * The production package key (11-22). Its private half stays on the owner's workstation, outside
 * every repository and service: the licence service only passes packages on, it can't sign one.
 */
export const PACKAGE_KEYS: PackageKeys = {
  MLJ8riJppCuV: "MLJ8riJppCuVLqjcyjRsAAeTeA8qAL9cdM4nLF7YAXY",
};

/** What the licence service hands over: the package and its signed description. */
export interface PackageDelivery {
  bytes: Uint8Array;
  /** The signed description (the `.sig.json` the package was released with). */
  signed: SignedPackage;
}

export interface SignedPackage {
  v: 1;
  version: string;
  /** The add-on contract it was built for (ADDON_API). */
  api: number;
  /** SHA-256 of the package file, hex. */
  sha256: string;
  /** The id of the key that signed it. */
  key: string;
  /** Ed25519 signature of signedText(...), base64url. */
  sig: string;
}

/** Exactly what a package's signature covers. */
export const signedText = (s: Pick<SignedPackage, "version" | "api" | "sha256">) =>
  `hearth-premium-package:v1\n${s.version}\n${s.api}\n${s.sha256}`;

export class PackageError extends Error {}

const spki = (raw: string) =>
  createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(raw, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });

/** Checks a delivered package: signed by a trusted key, for this contract, and untouched. */
export function checkPackage(d: PackageDelivery, keys: PackageKeys, api: number): SignedPackage {
  const s = d.signed;
  if (
    s?.v !== 1 ||
    typeof s.version !== "string" ||
    !/^[0-9A-Za-z.+-]{1,40}$/.test(s.version) ||
    typeof s.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(s.sha256) ||
    typeof s.sig !== "string" ||
    typeof s.key !== "string"
  )
    throw new PackageError("The Premium package's description is damaged.");
  const pub = keys[s.key];
  if (!pub)
    throw new PackageError("The Premium package wasn't signed by a key this Hearth trusts.");
  const ok = verify(null, Buffer.from(signedText(s)), spki(pub), Buffer.from(s.sig, "base64url"));
  if (!ok) throw new PackageError("The Premium package's signature doesn't match: it was changed.");
  const sha = createHash("sha256").update(d.bytes).digest("hex");
  if (sha !== s.sha256)
    throw new PackageError("The Premium package didn't arrive whole (its checksum doesn't match).");
  if (s.api !== api)
    throw new PackageError(
      `The Premium package is for add-on version ${s.api}; this Hearth speaks version ${api}.`,
    );
  return s;
}

/**
 * The tar to use: Windows' own (System32, Windows 10 and later) on Windows, never another one
 * that happens to come first (Git's reads "C:" as a remote machine), else the system's.
 */
export function tarCommand(platform = process.platform): string {
  if (platform !== "win32") return "tar";
  const own = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(own) ? own : "tar";
}

/** Unpacks a .tar.gz with the system's tar (Linux, and Windows 10 and later). */
export function untar(file: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(
      tarCommand(),
      ["-xzf", file, "-C", dir, ...(process.platform === "win32" ? [] : ["--no-same-owner"])],
      { timeout: 120_000, windowsHide: true },
      (error) =>
        error ? reject(new PackageError(`Unpacking it failed: ${error.message}`)) : resolve(),
    ),
  );
}

export interface PackageDeps {
  /** <data>/addons: the package goes in its hearth-premium folder. */
  dir: string;
  /** The add-on contract this core speaks (ADDON_API). */
  api: number;
  /** This Hearth's version (a new one checks for a package that fits it, once). */
  coreVersion: string;
  keys: PackageKeys;
  /** A licence key in force here (own or a linked Hearth's), or none. */
  licence: () => Promise<string | undefined>;
  /** The licence service's delivery; undefined when the service is off. */
  fetch?: (licence: string, api: number, have?: string) => Promise<PackageDelivery | "same">;
  /** The package as loaded now (its version), if one loaded. */
  loaded: () => string | undefined;
  /** Why a package here did not load (wrong contract, broken), if one didn't. */
  skipped: () => string | undefined;
  /** Remembered across restarts: what was installed, and for which core it was last checked. */
  memory: {
    get: () => Promise<PackageMemory | undefined>;
    set: (m: PackageMemory) => Promise<void>;
  };
  /** Work a reload would cut off (jobs, build steps, an answer being written); empty: none. */
  busy: () => Promise<string[]>;
  /** Restarts this Hearth in the background (a few seconds); false when it can't by itself. */
  restart: () => boolean;
  unpack?: (file: string, dir: string) => Promise<void>;
  log: { info(msg: string): void; warn(msg: string): void };
  /** How long to wait between looks at running work (tests shorten it). */
  waitMs?: number;
}

export interface PackageMemory {
  version?: string;
  installedAt?: string;
  /** The Hearth version it last asked the service about (asks again after an update). */
  checkedFor?: string;
  /** "Welcome to Premium" is still to be shown (set when a redeem or a new package unlocks it). */
  welcome?: boolean;
}

export class PremiumPackage {
  private state: PremiumPackageState = { state: "idle" };
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly d: PackageDeps) {}

  /** Where it stands, for the page. */
  async status(): Promise<PremiumPackageState> {
    const loaded = this.d.loaded();
    if (this.state.state === "idle" && loaded) return { state: "ready", version: loaded };
    return this.state;
  }

  /** Whether "Welcome to Premium" is still to be shown. */
  async welcomePending(): Promise<boolean> {
    return Boolean((await this.d.memory.get())?.welcome);
  }

  async welcomed(): Promise<void> {
    const m = (await this.d.memory.get()) ?? {};
    await this.d.memory.set({ ...m, welcome: false });
  }

  /** A code was just redeemed (or a licence key added): get the package, now. */
  redeemed(): Promise<void> {
    return this.ensure("redeem");
  }

  /**
   * At startup: a licensed Hearth with no package that fits it, or a Hearth that was updated
   * since it last asked, asks once. Otherwise nothing goes online.
   */
  async startup(): Promise<void> {
    const licence = await this.d.licence();
    if (!licence || !this.d.fetch) return;
    const m = (await this.d.memory.get()) ?? {};
    const missing = !this.d.loaded() || Boolean(this.d.skipped());
    if (!missing && m.checkedFor === this.d.coreVersion) return;
    await this.ensure("startup");
  }

  /** Gets, checks and installs the package if needed, then reloads Hearth when nothing runs. */
  ensure(why: "redeem" | "startup"): Promise<void> {
    this.running ??= this.run(why).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(why: "redeem" | "startup"): Promise<void> {
    const licence = await this.d.licence();
    if (!licence) return;
    const loaded = this.d.loaded();
    const fits = Boolean(loaded) && !this.d.skipped();
    const memory = (await this.d.memory.get()) ?? {};
    if (!this.d.fetch) {
      if (!fits)
        this.state = {
          state: "failed",
          detail:
            "Hearth's licence service is switched off here, so the Premium package can't be fetched.",
        };
      return;
    }
    this.state = { state: "downloading" };
    let delivery: PackageDelivery | "same";
    try {
      delivery = await this.d.fetch(licence, this.d.api, fits ? loaded : undefined);
    } catch (e) {
      // A package already here keeps working; only a missing one is a problem to show.
      this.state = fits
        ? { state: "idle" }
        : {
            state: "failed",
            detail: e instanceof Error ? e.message : "The Premium package couldn't be fetched.",
          };
      if (fits && why === "redeem") await this.d.memory.set({ ...memory, welcome: true });
      return;
    }
    if (delivery === "same") {
      await this.d.memory.set({
        ...memory,
        checkedFor: this.d.coreVersion,
        ...(why === "redeem" ? { welcome: true } : {}),
      });
      this.state = { state: "idle" };
      return;
    }
    let signed: SignedPackage;
    try {
      signed = checkPackage(delivery, this.d.keys, this.d.api);
      this.state = { state: "installing", version: signed.version };
      await this.install(delivery.bytes);
    } catch (e) {
      this.d.log.warn(`Premium package refused: ${e instanceof Error ? e.message : String(e)}`);
      this.state = fits
        ? { state: "idle" }
        : {
            state: "failed",
            detail: e instanceof Error ? e.message : "The Premium package couldn't be installed.",
          };
      return;
    }
    await this.d.memory.set({
      ...memory,
      version: signed.version,
      installedAt: new Date().toISOString(),
      checkedFor: this.d.coreVersion,
      welcome: true,
    });
    this.d.log.info(`Premium package ${signed.version} installed; Hearth reloads when idle.`);
    await this.reloadWhenIdle(signed.version);
  }

  /** Unpacks into a fresh folder, then swaps it in (the old one is kept until the next swap). */
  private async install(bytes: Uint8Array): Promise<void> {
    mkdirSync(this.d.dir, { recursive: true });
    const stamp = Date.now();
    const file = path.join(this.d.dir, `.hearth-premium-${stamp}.tar.gz`);
    const staging = path.join(this.d.dir, `.hearth-premium-${stamp}`);
    writeFileSync(file, bytes);
    try {
      mkdirSync(staging);
      await (this.d.unpack ?? untar)(file, staging);
      const pkgFile = path.join(staging, "package.json");
      const pkg = existsSync(pkgFile)
        ? (JSON.parse(readFileSync(pkgFile, "utf8")) as {
            name?: string;
            hearth?: { addon?: string };
          })
        : {};
      if (pkg.name !== "hearth-premium" || !pkg.hearth?.addon)
        throw new PackageError("That isn't the Hearth Premium package.");
      const target = path.join(this.d.dir, "hearth-premium");
      const previous = path.join(this.d.dir, ".hearth-premium-previous");
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(target)) renameSync(target, previous);
      renameSync(staging, target);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    } finally {
      rmSync(file, { force: true });
    }
  }

  /** Reloads Hearth once no job, build step or answer is running; says what it waits for. */
  private async reloadWhenIdle(version: string): Promise<void> {
    const busy = await this.d.busy().catch(() => []);
    if (busy.length) {
      this.state = { state: "waiting", version, busy };
      this.timer = setTimeout(() => void this.reloadWhenIdle(version), this.d.waitMs ?? 10_000);
      this.timer.unref?.();
      return;
    }
    if (this.d.restart()) this.state = { state: "reloading", version };
    else
      this.state = {
        state: "restart-needed",
        version,
        detail: "Hearth was started by hand here, so it can't reload itself: restart it to finish.",
      };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}
