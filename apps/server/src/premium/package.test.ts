import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newSigningKey } from "./license";
import {
  PackageError,
  PremiumPackage,
  checkPackage,
  signedText,
  tarCommand,
  type PackageDeps,
  type PackageMemory,
  type SignedPackage,
} from "./package";
import { LicenceService } from "./service";

// The Premium package, delivered (11-22, launch-critical: a redeemed code unlocked nothing). The
// licence service hands it over only for a licence in force; Hearth installs it only when it is
// signed by a package key it trusts, then reloads itself once no job, build step or answer runs.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "hearth-pkg-"));
  dirs.push(d);
  return d;
};

const packageKey = newSigningKey();
const KEYS = { [packageKey.keyId]: packageKey.publicKey };

/** A real package archive: package.json and an entry, at the archive's root. */
function tarball(version = "1.2.0", name = "hearth-premium"): Uint8Array {
  const src = tmp();
  writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify({ name, version, hearth: { addon: "index.mjs" } }),
  );
  writeFileSync(path.join(src, "index.mjs"), "export const addon = undefined;\n");
  const file = path.join(tmp(), "p.tar.gz");
  execFileSync(tarCommand(), ["-czf", file, "-C", src, "."]);
  return new Uint8Array(readFileSync(file));
}

function signed(bytes: Uint8Array, version = "1.2.0", api = 1, pem = packageKey.privatePem) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const s = { version, api, sha256 };
  return {
    v: 1 as const,
    ...s,
    key: packageKey.keyId,
    sig: sign(null, Buffer.from(signedText(s)), createPrivateKey(pem)).toString("base64url"),
  } satisfies SignedPackage;
}

describe("checking a delivered Premium package", () => {
  it("accepts one signed by a trusted package key, for this add-on version, untouched", () => {
    const bytes = tarball();
    expect(checkPackage({ bytes, signed: signed(bytes) }, KEYS, 1).version).toBe("1.2.0");
  });

  it("refuses a changed file, another key, a changed description, or another add-on version", () => {
    const bytes = tarball();
    const good = signed(bytes);
    const changed = new Uint8Array(bytes);
    changed[20] = (changed[20] ?? 0) ^ 1;
    expect(() => checkPackage({ bytes: changed, signed: good }, KEYS, 1)).toThrow(/checksum/);
    const other = newSigningKey();
    expect(() =>
      checkPackage({ bytes, signed: signed(bytes, "1.2.0", 1, other.privatePem) }, KEYS, 1),
    ).toThrow(/signature doesn't match/);
    expect(() => checkPackage({ bytes, signed: { ...good, key: "nobody" } }, KEYS, 1)).toThrow(
      /key this Hearth trusts/,
    );
    expect(() => checkPackage({ bytes, signed: { ...good, version: "9.9.9" } }, KEYS, 1)).toThrow(
      /signature doesn't match/,
    );
    expect(() => checkPackage({ bytes, signed: signed(bytes, "1.2.0", 2) }, KEYS, 1)).toThrow(
      /add-on version 2/,
    );
    expect(() => checkPackage({ bytes, signed: good }, {}, 1)).toThrow(PackageError);
  });
});

/** The licence service (the real Worker code) in front of a stand-in GitHub. */
async function setup(opts: { release?: { bytes: Uint8Array; signed: SignedPackage } } = {}) {
  const { handle, memoryStore, signLicence, servicePublicKey } =
    await import("../../../../services/hearth-licence/src/licence");
  const serviceKey = newSigningKey();
  const store = memoryStore();
  const bytes = opts.release?.bytes ?? tarball();
  const sig = opts.release?.signed ?? signed(bytes);
  const github = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/releases?"))
      return Response.json([
        {
          tag_name: `v${sig.version}-api1`,
          draft: false,
          prerelease: false,
          assets: [
            { name: "hearth-premium.tar.gz", url: "https://gh.test/tar" },
            { name: "hearth-premium.sig.json", url: "https://gh.test/sig" },
          ],
        },
      ]);
    if (url === "https://gh.test/sig") return new Response(JSON.stringify(sig));
    if (url === "https://gh.test/tar") return new Response(bytes);
    return new Response("no", { status: 404 });
  }) as typeof fetch;
  const env = { SIGNING_KEY: serviceKey.privatePem, OWNER_KEY: "", PACKAGE_TOKEN: "t" };
  const asked: string[] = [];
  const service = new LicenceService("https://licence.test", (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    asked.push(new URL(String(input)).pathname);
    return handle(new Request(String(input), init), env, store, Date.now, github);
  }) as typeof fetch);
  const licence = await signLicence(
    {
      id: "lic-pkg-1",
      install: "install-0000-1111",
      features: ["ember_show_and_tell", "panel_builder", "hearth_interconnectivity"],
      kind: "complimentary",
      start: new Date(Date.now() - 1000).toISOString(),
      issued: new Date().toISOString(),
    },
    serviceKey.privatePem,
  );
  expect(await servicePublicKey(serviceKey.privatePem)).toBeTruthy();

  const dir = tmp();
  let memory: PackageMemory | undefined;
  let busy: string[] = [];
  const restarts: number[] = [];
  let loaded: string | undefined;
  const deps: PackageDeps = {
    dir,
    api: 1,
    coreVersion: "0.89.0",
    keys: KEYS,
    licence: async () => licence,
    fetch: (l, api, have) => service.package(l, api, have),
    loaded: () => loaded,
    skipped: () => undefined,
    memory: { get: async () => memory, set: async (m) => void (memory = m) },
    busy: async () => busy,
    restart: () => {
      restarts.push(Date.now());
      return true;
    },
    log: { info: () => undefined, warn: () => undefined },
    waitMs: 20,
  };
  return {
    pkg: new PremiumPackage(deps),
    deps,
    dir,
    store,
    asked,
    restarts,
    memory: () => memory,
    setBusy: (b: string[]) => void (busy = b),
    setLoaded: (v: string | undefined) => void (loaded = v),
  };
}

describe("a redeem gets the Premium package and reloads Hearth when nothing runs", () => {
  it("fetches, checks, installs, reloads, and asks to say Welcome to Premium", async () => {
    const t = await setup();
    await t.pkg.redeemed();
    const installed = path.join(t.dir, "hearth-premium", "package.json");
    expect(JSON.parse(readFileSync(installed, "utf8")).name).toBe("hearth-premium");
    expect(t.restarts).toHaveLength(1);
    expect(await t.pkg.status()).toEqual({ state: "reloading", version: "1.2.0" });
    expect(t.memory()).toMatchObject({ version: "1.2.0", checkedFor: "0.89.0", welcome: true });
    expect(t.asked).toEqual(["/v1/package"]);
    // After the reload: the package loaded, the welcome shows once.
    t.setLoaded("1.2.0");
    expect(await t.pkg.welcomePending()).toBe(true);
    await t.pkg.welcomed();
    expect(await t.pkg.welcomePending()).toBe(false);
  });

  it("waits for a running job or build step, then reloads", async () => {
    const t = await setup();
    t.setBusy(["a job or build step running"]);
    await t.pkg.redeemed();
    expect(await t.pkg.status()).toEqual({
      state: "waiting",
      version: "1.2.0",
      busy: ["a job or build step running"],
    });
    expect(t.restarts).toHaveLength(0);
    t.setBusy([]);
    await new Promise((r) => setTimeout(r, 80));
    expect(t.restarts).toHaveLength(1);
    expect((await t.pkg.status()).state).toBe("reloading");
    t.pkg.stop();
  });

  it("refuses a package not signed by a trusted key: nothing installed, no reload", async () => {
    const bytes = tarball();
    const forged = signed(bytes, "1.2.0", 1, newSigningKey().privatePem);
    const t = await setup({ release: { bytes, signed: forged } });
    await t.pkg.redeemed();
    expect(existsSync(path.join(t.dir, "hearth-premium"))).toBe(false);
    expect(t.restarts).toHaveLength(0);
    expect(await t.pkg.status()).toMatchObject({
      state: "failed",
      detail: expect.stringMatching(/signature doesn't match/),
    });
  });

  it("refuses something that isn't the Premium package, even signed", async () => {
    const bytes = tarball("1.2.0", "something-else");
    const t = await setup({ release: { bytes, signed: signed(bytes) } });
    await t.pkg.redeemed();
    expect(existsSync(path.join(t.dir, "hearth-premium"))).toBe(false);
    expect(t.restarts).toHaveLength(0);
  });

  it("the newest already here: nothing downloaded, no reload, the welcome still shows", async () => {
    const t = await setup();
    t.setLoaded("1.2.0");
    await t.pkg.redeemed();
    expect(t.restarts).toHaveLength(0);
    expect(await t.pkg.status()).toEqual({ state: "ready", version: "1.2.0" });
    expect(await t.pkg.welcomePending()).toBe(true);
  });

  it("a licence taken back gets no package", async () => {
    const t = await setup();
    await t.store.revoke(["lic-pkg-1"], new Date().toISOString());
    await t.pkg.redeemed();
    expect(t.restarts).toHaveLength(0);
    expect(await t.pkg.status()).toMatchObject({
      state: "failed",
      detail: expect.stringMatching(/taken back/),
    });
  });
});

describe("a Hearth that already has a licence gets the package at startup, without a code", () => {
  it("licensed with no package: fetches it once at startup", async () => {
    const t = await setup();
    await t.pkg.startup();
    expect(existsSync(path.join(t.dir, "hearth-premium", "index.mjs"))).toBe(true);
    expect(t.restarts).toHaveLength(1);
  });

  it("with its package and already checked for this Hearth version: nothing goes online", async () => {
    const t = await setup();
    t.setLoaded("1.2.0");
    await t.deps.memory.set({ version: "1.2.0", checkedFor: "0.89.0" });
    await t.pkg.startup();
    expect(t.asked).toEqual([]);
  });

  it("after a Hearth update: asks once, and the same package means no reload", async () => {
    const t = await setup();
    t.setLoaded("1.2.0");
    await t.deps.memory.set({ version: "1.2.0", checkedFor: "0.88.0" });
    await t.pkg.startup();
    expect(t.asked).toEqual(["/v1/package"]);
    expect(t.restarts).toHaveLength(0);
    expect(t.memory()?.checkedFor).toBe("0.89.0");
    await t.pkg.startup();
    expect(t.asked).toHaveLength(1);
  });

  it("no licence: never goes online", async () => {
    const t = await setup();
    const pkg = new PremiumPackage({ ...t.deps, licence: async () => undefined });
    await pkg.startup();
    expect(t.asked).toEqual([]);
    mkdirSync(path.join(t.dir, "x"));
  });
});
