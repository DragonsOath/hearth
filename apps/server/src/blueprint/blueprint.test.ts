import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_ROOT } from "../config";
import { openDatabase, runMigrations } from "../db/client";
import type { Session } from "../auth/service";
import type { Vault } from "../auth/vault";
import {
  assemble,
  installOrder,
  maskCompose,
  scanForSecrets,
  writeMarkdown,
  type AssembleSource,
} from "./assemble";
import { mountOf, parseMountinfo } from "./drive";
import {
  decryptPackage,
  encryptPackage,
  newRecoveryKey,
  PACKAGE_FORMAT,
  type BlueprintPackage,
} from "./package";
import { LabBlueprint } from "./service";
import { folderStore, signS3, writeVersion } from "./store";
import { FAKE_CLOUD, fakeCloud } from "./fake-cloud";

// The Lab Blueprint (the owner, 11-11): written mechanically, never holding a secret, encrypted
// to a key only the owner keeps, dated versions never overwritten, and opened only with that key.

const COMPOSE = `services:
  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    environment:
      - PUID=1000
      - TZ=America/Chicago
      - SONARR__API_KEY=0123456789abcdef0123456789abcdef
      - WEBHOOK=https://discord.com/api/webhooks/1/abcdefABCDEF1234567890abcdefXYZ
    volumes:
      - /srv/sonarr:/config
      - /mnt/media/tv:/tv
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: hunter2-very-secret
      POSTGRES_USER: app
      PGDATA: \${DATA_DIR}
`;

describe("what a blueprint may show of a compose file", () => {
  it("hides every environment value but the harmless ones, and long random strings", () => {
    const m = maskCompose(COMPOSE);
    expect(m).toContain("PUID=1000");
    expect(m).toContain("TZ=America/Chicago");
    expect(m).toContain("SONARR__API_KEY=<hidden>");
    expect(m).toContain("WEBHOOK=<hidden>");
    expect(m).toContain("POSTGRES_PASSWORD: <hidden>");
    expect(m).toContain("POSTGRES_USER: <hidden>");
    expect(m).toContain("PGDATA: ${DATA_DIR}");
    expect(m).toContain("image: lscr.io/linuxserver/sonarr:latest");
    expect(m).toContain("/srv/sonarr:/config");
    expect(m).not.toMatch(/0123456789abcdef|hunter2|abcdefABCDEF/);
  });

  it("names, never shows, a vault value found in the text", () => {
    expect(
      scanForSecrets("token is s3cr3t-value here", [{ name: "Plex token", value: "s3cr3t-value" }]),
    ).toEqual(["Plex token"]);
    expect(scanForSecrets("nothing here", [{ name: "Plex token", value: "s3cr3t-value" }])).toEqual(
      [],
    );
  });
});

function source(over: Partial<AssembleSource> = {}): AssembleSource {
  return {
    containers: async () =>
      [
        {
          name: "sonarr",
          state: "running",
          inspect: {
            Image: "sha256:1",
            Config: {
              Image: "lscr.io/linuxserver/sonarr:latest",
              Env: ["PUID=1000", "SONARR__API_KEY=0123456789abcdef0123456789abcdef"],
              Labels: {
                "com.docker.compose.project": "media",
                "com.docker.compose.service": "sonarr",
                "com.docker.compose.project.config_files": "/srv/media/compose.yaml",
                "com.docker.compose.depends_on": "gluetun:service_started:false",
              },
            },
            HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "media_default" },
            NetworkSettings: {
              Ports: { "8989/tcp": [{ HostPort: "8989" }] },
              Networks: { media_default: {} },
            },
            Mounts: [
              { Type: "bind", Source: "/srv/sonarr", Destination: "/config", RW: true },
              { Type: "bind", Source: "/mnt/media/tv", Destination: "/tv", RW: true },
            ],
          },
        },
        {
          name: "gluetun",
          state: "running",
          inspect: {
            Config: {
              Image: "qmcgaw/gluetun:latest",
              Env: ["WIREGUARD_PRIVATE_KEY=abc"],
              Labels: { "com.docker.compose.service": "gluetun" },
            },
            HostConfig: { RestartPolicy: { Name: "always" } },
            Mounts: [],
          },
        },
      ] as Awaited<ReturnType<AssembleSource["containers"]>>,
    networks: async () => [
      { name: "media_default", driver: "bridge", subnet: "172.20.0.0/16", containers: ["sonarr"] },
    ],
    host: async () => ({
      name: "home-server",
      os: "Linux 6.8",
      hearthVersion: "0.74.0",
      mounts: [{ source: "/dev/nvme0n1p2", target: "/", fsType: "ext4" }],
      interfaces: [{ name: "eth0", address: "192.168.1.10" }],
    }),
    services: async () => [
      { id: "svc-sonarr", name: "sonarr", app: "sonarr", localUrl: "http://192.168.1.10:8989" },
    ],
    vault: async () => [
      { name: "Sonarr API key", kind: "api-key", tier: "automation", serviceId: "svc-sonarr" },
    ],
    readFile: async (f) => (f === "/srv/media/compose.yaml" ? COMPOSE : undefined),
    exists: async (f) => f === "/srv/sonarr/Backups",
    notes: async () => "The VPN must be up before the downloaders.",
    now: () => new Date("2026-11-12T04:00:00Z"),
    ...over,
  };
}

describe("writing the blueprint", () => {
  it("states each app with its source, its own backups, and an install order", async () => {
    const facts = await assemble(source());
    const md = writeMarkdown(facts);
    expect(facts.installOrder[0]).toEqual(["gluetun"]);
    expect(facts.apps.find((a) => a.name === "sonarr")).toMatchObject({
      dependsOn: ["gluetun"],
      vault: ["Sonarr API key"],
      hiddenSettings: ["SONARR__API_KEY"],
      ownBackup: { verified: true },
    });
    expect(facts.apps.find((a) => a.name === "sonarr")!.mounts.map((m) => m.holds)).toEqual([
      "settings and data",
      "media or downloads",
    ]);
    expect(md).toContain("# Lab blueprint: home-server");
    expect(md).toContain("/srv/sonarr/Backups");
    expect(md).toContain("WIREGUARD_PRIVATE_KEY"); // named as left out
    expect(md).toContain("The VPN must be up before the downloaders.");
    expect(md).not.toMatch(/0123456789abcdef|hunter2/);
  });

  it("says what it couldn't read instead of guessing", async () => {
    const facts = await assemble(
      source({ readFile: async () => undefined, exists: async () => false }),
    );
    expect(facts.gaps.join(" ")).toMatch(/compose\.yaml.*could not be read/);
    expect(facts.apps.find((a) => a.name === "sonarr")!.ownBackup).toMatchObject({
      verified: false,
    });
  });

  it("puts what an app depends on before it", () => {
    const order = installOrder([
      { name: "app", image: "x", dependsOn: ["db2"] },
      { name: "db2", image: "y", dependsOn: [] },
    ] as never);
    expect(order).toEqual([["db2"], ["app"]]);
  });
});

describe("the encrypted package", () => {
  const pkg = (): BlueprintPackage => ({
    format: PACKAGE_FORMAT,
    writtenAt: "2026-11-12T04:00:00.000Z",
    hearthVersion: "0.74.0",
    host: "home-server",
    keyId: "AAAA-BBBB",
    markdown: "# Lab blueprint",
    facts: { apps: [] } as never,
    entries: [
      { name: "Plex token", kind: "token", tier: "automation", tags: [], value: "tok-123456" },
    ],
    protectedLeftOut: [],
  });

  it("opens with the recovery key only, and says so plainly when it doesn't", async () => {
    const a = await newRecoveryKey();
    const b = await newRecoveryKey();
    const bytes = await encryptPackage(pkg(), a.recipient);
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("tok-123456");
    expect((await decryptPackage(bytes, a.recoveryKey)).entries[0]!.value).toBe("tok-123456");
    await expect(decryptPackage(bytes, b.recoveryKey)).rejects.toThrow(/doesn't open that file/);
    await expect(decryptPackage(bytes, "not a key")).rejects.toThrow(/isn't a recovery key/);
    const damaged = Uint8Array.from(bytes);
    const at = damaged.length - 5;
    damaged[at] = damaged[at]! ^ 0xff;
    await expect(decryptPackage(damaged, a.recoveryKey)).rejects.toThrow(/damaged/);
  });

  it("writes dated versions, never over another, and keeps seven", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bp-"));
    writeFileSync(path.join(dir, "notes.txt"), "not ours");
    const t = new Date("2026-11-12T04:00:00Z");
    const first = await writeVersion(folderStore(dir), new Uint8Array([1]), t, 7);
    const second = await writeVersion(folderStore(dir), new Uint8Array([2]), t, 7);
    expect(second.file).not.toBe(first.file);
    expect([...readFileSync(path.join(dir, first.file))]).toEqual([1]);
    for (let i = 1; i <= 8; i++)
      await writeVersion(
        folderStore(dir),
        new Uint8Array([i]),
        new Date(t.getTime() + i * 86_400_000),
        7,
      );
    const left = readdirSync(dir);
    expect(left.filter((f) => f.endsWith(".age"))).toHaveLength(7);
    expect(left).toContain("notes.txt");
  });
});

describe("mount tables", () => {
  it("finds the mount a folder lives on", () => {
    const m = parseMountinfo(
      [
        "22 1 259:2 / / rw - ext4 /dev/nvme0n1p2 rw",
        "40 22 8:33 / /mnt/e rw - fuseblk /dev/sdc2 rw",
        "41 22 0:50 / /mnt/nas rw - cifs //nas/share rw",
      ].join("\n"),
    );
    expect(mountOf(m, "/mnt/e/Backups")?.device).toBe("8:33");
    expect(mountOf(m, "/home/me")?.mountPoint).toBe("/");
    expect(mountOf(m, "/mnt/nas/x")?.fsType).toBe("cifs");
  });
});

async function setupService() {
  const handle = openDatabase(":memory:");
  await runMigrations(handle, path.join(SERVER_ROOT, "drizzle"));
  const dir = mkdtempSync(path.join(tmpdir(), "bp-svc-"));
  const secrets = [
    {
      id: "s1",
      name: "Sonarr API key",
      kind: "api-key",
      tier: "automation",
      serviceId: "svc-sonarr",
      tags: [],
      value: "auto-value-123",
    },
    {
      id: "s2",
      name: "Router admin",
      kind: "login",
      tier: "protected",
      tags: [],
      value: "protected-value-9",
    },
  ];
  const added: string[] = [];
  const vault = {
    list: async () => secrets.map(({ value: _v, ...r }) => r),
    use: async (id: string, _p: string, o: { unlockedSession?: Session }) => {
      const s = secrets.find((x) => x.id === id)!;
      if (s.tier === "protected" && !o.unlockedSession) throw new Error("locked");
      return s.value;
    },
    add: async (input: { name: string; value: string; username?: string }) => {
      added.push(input.name);
      const id = `added-${added.length}`;
      secrets.push({
        id,
        name: input.name,
        kind: "login",
        tier: "automation",
        tags: [],
        value: input.value,
        ...(input.username ? { username: input.username } : {}),
      } as (typeof secrets)[number]);
      return { id } as never;
    },
    removeInternal: async (id: string) => {
      const i = secrets.findIndex((x) => x.id === id);
      if (i >= 0) secrets.splice(i, 1);
    },
  } as unknown as Pick<Vault, "list" | "use" | "add" | "removeInternal">;
  const cloud = fakeCloud();
  let recent = true;
  const auth = {
    automation: async () => Buffer.alloc(32, 7),
    privateKeyFor: (s: Session) => (s.id === "unlocked" ? Buffer.alloc(32) : undefined),
    requireRecent: () => {
      if (!recent) throw new Error("Confirm it's you");
    },
  };
  let now = new Date("2026-11-12T04:00:00Z");
  const bp = new LabBlueprint({
    handle,
    auth: auth as never,
    vault,
    source: () => source({ now: () => now }),
    version: "0.74.0",
    host: () => "home-server",
    clock: () => now,
    sameDisk: async () => false,
    fetch: cloud.fetch,
  });
  return {
    bp,
    dir,
    secrets,
    added,
    cloud,
    session: {
      id: "s",
      method: "password",
      verifiedAt: now.toISOString(),
      createdAt: now.toISOString(),
    } as Session,
    unlocked: {
      id: "unlocked",
      method: "password",
      verifiedAt: now.toISOString(),
      createdAt: now.toISOString(),
    } as Session,
    setRecent: (v: boolean) => (recent = v),
    advance: (h: number) => (now = new Date(now.getTime() + h * 3_600_000)),
  };
}

describe("the Lab Blueprint service", () => {
  it("is set up only once the owner types the recovery key back, then writes a first version", async () => {
    const s = await setupService();
    s.setRecent(false);
    await expect(s.bp.startSetup({ folder: s.dir }, s.session)).rejects.toThrow(/Confirm it's you/);
    s.setRecent(true);
    const { recoveryKey, keyId } = await s.bp.startSetup({ folder: s.dir }, s.session);
    const other = await newRecoveryKey();
    await expect(s.bp.confirmSetup(other.recoveryKey, s.session)).rejects.toThrow(
      /isn't the recovery key just shown/,
    );
    const st = await s.bp.confirmSetup(recoveryKey, s.session);
    expect(st.config).toMatchObject({ destination: s.dir, keyId });
    expect(st.versions).toHaveLength(1);
    expect(JSON.stringify(st)).not.toContain("AGE-SECRET-KEY");
    // The file holds the automation entry, not the protected one (nothing unlocked).
    const bytes = readFileSync(path.join(s.dir, st.versions[0]!.file));
    const pkg = await decryptPackage(bytes, recoveryKey);
    expect(pkg.entries.map((e) => e.name)).toEqual(["Sonarr API key"]);
    expect(pkg.protectedLeftOut).toEqual(["Router admin"]);
    expect(pkg.markdown).not.toContain("auto-value-123");
    expect(await s.bp.testKey(recoveryKey, s.session)).toMatchObject({ ok: true, entries: 1 });
    await expect(s.bp.testKey(other.recoveryKey, s.session)).rejects.toThrow(/doesn't open/);
  });

  it("writes a new version only when something changed, and with protected entries when unlocked", async () => {
    const s = await setupService();
    const { recoveryKey } = await s.bp.startSetup({ folder: s.dir }, s.session);
    await s.bp.confirmSetup(recoveryKey, s.session);
    s.advance(24);
    expect(await s.bp.run()).toBe("unchanged");
    s.secrets[0]!.value = "auto-value-456";
    s.advance(24);
    expect(await s.bp.run()).toBe("written");
    s.advance(1);
    expect(await s.bp.updateNow(s.unlocked)).toBe("written");
    const st = await s.bp.status();
    expect(st.versions).toHaveLength(3);
    expect(st.versions[0]!.protectedIncluded).toBe(true);
    const pkg = await decryptPackage(
      readFileSync(path.join(s.dir, st.versions[0]!.file)),
      recoveryKey,
    );
    expect(pkg.entries.map((e) => e.name).sort()).toEqual(["Router admin", "Sonarr API key"]);
  });

  it("refuses a note holding a vault value, and goes stale after two days without a good check", async () => {
    const s = await setupService();
    await expect(s.bp.setNotes("the key is auto-value-123")).rejects.toThrow(/"Sonarr API key"/);
    const { recoveryKey } = await s.bp.startSetup({ folder: s.dir }, s.session);
    await s.bp.confirmSetup(recoveryKey, s.session);
    expect((await s.bp.status()).stale).toBe(false);
    s.advance(49);
    expect((await s.bp.status()).stale).toBe(true);
  });

  it("imports the chosen entries and keeps the blueprint for Ember; existing ones are skipped", async () => {
    const s = await setupService();
    const { recoveryKey } = await s.bp.startSetup({ folder: s.dir }, s.session);
    const st = await s.bp.confirmSetup(recoveryKey, s.session);
    const bytes = readFileSync(path.join(s.dir, st.versions[0]!.file));
    const preview = await s.bp.openImport(bytes, recoveryKey, s.session);
    expect(preview.entries.map((e) => e.name)).toEqual(["Sonarr API key"]);
    expect(JSON.stringify(preview)).not.toContain("auto-value-123");
    const r = await s.bp.applyImport(preview.id, ["Sonarr API key"], s.session);
    expect(r).toEqual({ added: [], skipped: ["Sonarr API key"] }); // already in this vault
    expect((await s.bp.imported())?.markdown).toContain("# Lab blueprint: home-server");
  });
});

describe("cloud storage", () => {
  it("signs S3 requests exactly as AWS's own published examples", () => {
    const common = {
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    };
    expect(
      signS3({ ...common, path: "/test.txt", headers: { Range: "bytes=0-9" } }).authorization,
    ).toMatch(/Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
    expect(
      signS3({ ...common, path: "/", query: { "max-keys": "2", prefix: "J" } }).authorization,
    ).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  });

  it("sets up on S3-compatible storage, keeps the login in the vault, and removes it when turned off", async () => {
    const s = await setupService();
    const target = {
      cloud: {
        kind: "s3" as const,
        endpoint: "https://s3.us-west-004.backblazeb2.com",
        bucket: FAKE_CLOUD.s3.bucket,
        prefix: "hearth",
      },
      username: FAKE_CLOUD.s3.accessKey,
      secret: FAKE_CLOUD.s3.secretKey,
    };
    await expect(s.bp.startSetup({ ...target, secret: "wrong-secret" }, s.session)).rejects.toThrow(
      /turned the login down \(SignatureDoesNotMatch\)/,
    );
    await expect(
      s.bp.startSetup({ ...target, cloud: { ...target.cloud, bucket: "nope-bucket" } }, s.session),
    ).rejects.toThrow(/doesn't exist/);
    await expect(
      s.bp.startSetup(
        { ...target, cloud: { ...target.cloud, endpoint: "http://s3.example.com" } },
        s.session,
      ),
    ).rejects.toThrow(/https/);
    const { recoveryKey, where } = await s.bp.startSetup(target, s.session);
    expect(where).toBe("Backblaze B2: hearth-test/hearth");
    const st = await s.bp.confirmSetup(recoveryKey, s.session);
    expect(st.config?.destination).toBe("Backblaze B2: hearth-test/hearth");
    expect(st.sameDrive).toBeUndefined();
    expect(JSON.stringify(st)).not.toContain(FAKE_CLOUD.s3.secretKey);
    expect(s.added).toEqual(["Lab Blueprint cloud (Backblaze B2: hearth-test/hearth)"]);
    const file = st.versions[0]!.file;
    expect([...s.cloud.files.keys()]).toEqual([`s3:hearth/${file}`]);
    expect(await s.bp.testKey(recoveryKey, s.session)).toMatchObject({ ok: true, file });
    s.advance(24);
    expect(await s.bp.run()).toBe("unchanged");
    await s.bp.turnOff(s.session);
    expect(s.secrets.some((x) => x.name.startsWith("Lab Blueprint cloud"))).toBe(false);
    expect(s.cloud.files.size).toBe(1); // versions already written stay
  });

  it("sets up on WebDAV and keeps seven versions there", async () => {
    const s = await setupService();
    const target = {
      cloud: {
        kind: "webdav" as const,
        url: "https://cloud.example.com/remote.php/dav/files/me/hearth/",
      },
      username: FAKE_CLOUD.webdav.username,
      secret: FAKE_CLOUD.webdav.password,
    };
    await expect(s.bp.startSetup({ ...target, secret: "nope" }, s.session)).rejects.toThrow(
      /turned the login down/,
    );
    await expect(
      s.bp.startSetup(
        { ...target, cloud: { kind: "webdav", url: "https://cloud.example.com/dav/missing" } },
        s.session,
      ),
    ).rejects.toThrow(/doesn't exist/);
    const { recoveryKey } = await s.bp.startSetup(target, s.session);
    const st = await s.bp.confirmSetup(recoveryKey, s.session);
    expect(st.config?.destination).toBe("WebDAV: cloud.example.com/remote.php/dav/files/me/hearth");
    for (let i = 0; i < 8; i++) {
      s.advance(1);
      s.secrets[0]!.value = `auto-value-${i}`;
      expect(await s.bp.run()).toBe("written");
    }
    expect(s.cloud.files.size).toBe(7);
    expect((await s.bp.status()).versions).toHaveLength(7);
  });
});
