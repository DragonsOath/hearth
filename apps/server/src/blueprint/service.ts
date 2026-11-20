import { createHash, randomUUID } from "node:crypto";
import {
  BLUEPRINT_KEEP,
  type BlueprintCloud,
  type BlueprintConfig,
  type BlueprintImportPreview,
  type BlueprintStatus,
  type BlueprintVersion,
} from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import type { Auth, Session } from "../auth/service";
import type { Vault } from "../auth/vault";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError } from "../store/errors";
import { deleteSetting, getSetting, setSetting } from "../store/settings";
import { assemble, scanForSecrets, writeMarkdown, type AssembleSource } from "./assemble";
import { sameDiskAsSystem } from "./drive";
import {
  decryptPackage,
  encryptPackage,
  fingerprint,
  newRecoveryKey,
  PACKAGE_FORMAT,
  PackageError,
  recipientOf,
  type BlueprintPackage,
  type PackageEntry,
} from "./package";
import { lastBoundary } from "../backup/service";
import {
  cloudProblem,
  cloudWhere,
  folderStore,
  s3Store,
  webdavStore,
  writeVersion,
  type BlueprintStore,
  type CloudFetch,
  type CloudLogin,
} from "./store";

/** Where versions go, as the owner chose it: a folder, or cloud storage with its login. */
export type BlueprintTarget =
  { folder: string } | { cloud: BlueprintCloud; username: string; secret: string };

function storeFor(
  cloud: BlueprintCloud | undefined,
  folder: string,
  login: CloudLogin | undefined,
  fetch: CloudFetch | undefined,
): BlueprintStore {
  if (!cloud) return folderStore(folder);
  const opts = fetch ? { fetch } : {};
  return cloud.kind === "s3" ? s3Store(cloud, login!, opts) : webdavStore(cloud, login!, opts);
}

/**
 * The Lab Blueprint (design: the "Lab Blueprint" doc, 2026-11-11). Once a day, after Hearth's own
 * backup, it writes the lab down mechanically (no AI) and, when anything changed, puts a new dated
 * version, encrypted to the owner's recovery key, in the folder the owner chose. Setting it up,
 * changing where it goes or its key, and importing all need the owner to confirm it's them; Ember
 * can read the blueprint (it holds no secret) and add notes, nothing more.
 */

const PENDING_MS = 15 * 60_000;
const STALE_MS = 2 * 24 * 3_600_000;
const RETRY_MS = 60 * 60_000;

interface State {
  versions: BlueprintVersion[];
  lastCheck?: string;
  lastError?: { at: string; text: string };
  fingerprint?: string;
}

export interface BlueprintDeps {
  handle: DbHandle;
  auth: Pick<Auth, "automation" | "privateKeyFor" | "requireRecent">;
  vault: Pick<Vault, "list" | "use" | "add" | "removeInternal">;
  source: () => AssembleSource;
  version: string;
  host: () => string;
  clock?: () => Date;
  /** Tests: whether the destination shares the system's disk. */
  sameDisk?: (dir: string) => Promise<boolean | undefined>;
  /** Tests and previews: how cloud storage is reached (a stand-in cloud). */
  fetch?: CloudFetch;
}

export class LabBlueprint {
  private readonly clock: () => Date;
  private pendingSetup?: {
    at: number;
    destination: string;
    cloud?: BlueprintCloud;
    login?: CloudLogin;
    recipient: string;
    keyId: string;
  };
  private openImports = new Map<string, { at: number; pkg: BlueprintPackage }>();
  private running?: Promise<"written" | "unchanged">;
  private lastFailure = 0;

  constructor(private readonly d: BlueprintDeps) {
    this.clock = d.clock ?? (() => new Date());
  }

  private get db() {
    return this.d.handle.db;
  }

  private async state(): Promise<State> {
    return (await getSetting(this.db, "blueprint_state")) ?? { versions: [] };
  }

  async status(): Promise<BlueprintStatus> {
    const config = await getSetting(this.db, "blueprint_config");
    const s = await this.state();
    const notes = (await getSetting(this.db, "blueprint_notes")) ?? "";
    const imported = await getSetting(this.db, "blueprint_imported");
    // Stale: no successful check (a version written, or nothing changed) for two days.
    const stale = Boolean(
      config && this.clock().getTime() - Date.parse(s.lastCheck ?? config.setupAt) > STALE_MS,
    );
    const sameDisk = config && !config.cloud ? await this.sameDisk(config.destination) : undefined;
    return {
      ...(config
        ? {
            config: {
              destination: config.destination,
              ...(config.cloud ? { cloud: config.cloud } : {}),
              keyId: config.keyId,
              setupAt: config.setupAt,
              keep: config.keep,
            },
          }
        : {}),
      versions: s.versions,
      ...(s.lastCheck ? { lastCheck: s.lastCheck } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}),
      stale,
      ...(sameDisk !== undefined ? { sameDrive: sameDisk } : {}),
      notes,
      ...(imported
        ? {
            imported: {
              at: imported.at,
              from: imported.from,
              ...(imported.hearthVersion ? { hearthVersion: imported.hearthVersion } : {}),
              entries: imported.entries,
            },
          }
        : {}),
    };
  }

  private async sameDisk(dir: string) {
    return (this.d.sameDisk ?? sameDiskAsSystem)(dir).catch(() => undefined);
  }

  /** The folder or cloud storage versions go to; a cloud login comes from the vault each time. */
  private async store(config: {
    destination: string;
    cloud?: BlueprintCloud & { secretId: string };
  }): Promise<BlueprintStore> {
    if (!config.cloud) return folderStore(config.destination);
    const { secretId, ...cloud } = config.cloud;
    const row = (await this.d.vault.list()).find((r) => r.id === secretId);
    if (!row)
      throw new PackageError(
        "The cloud storage login is no longer in the Secure Vault. Choose Change where or key to give it again.",
      );
    const secret = await this.d.vault.use(secretId, "Lab Blueprint cloud storage", {
      actor: "dragon-control",
      audit: false,
    });
    return storeFor(
      cloud as BlueprintCloud,
      config.destination,
      { username: row.username ?? "", secret },
      this.d.fetch,
    );
  }

  /** The blueprint as it would be written now (no secret in it; the scan below makes sure). */
  async preview(): Promise<string> {
    const facts = await assemble(this.d.source());
    const markdown = writeMarkdown(facts);
    await this.scan(markdown);
    return markdown;
  }

  /** The owner's and Ember's notes, carried into every version (checked for secrets too). */
  async setNotes(text: string): Promise<void> {
    const notes = text.slice(0, 20_000);
    await this.scan(notes);
    await setSetting(this.db, "blueprint_notes", notes);
  }

  private async values(includeProtected?: Session) {
    const out: { name: string; value: string; row: Awaited<ReturnType<Vault["list"]>>[number] }[] =
      [];
    const leftOut: string[] = [];
    for (const row of await this.d.vault.list()) {
      if (
        row.tier === "protected" &&
        !(includeProtected && this.d.auth.privateKeyFor(includeProtected))
      ) {
        leftOut.push(row.name);
        continue;
      }
      const value = await this.d.vault.use(row.id, "Lab Blueprint", {
        actor: "dragon-control",
        audit: false,
        ...(includeProtected ? { unlockedSession: includeProtected } : {}),
      });
      out.push({ name: row.name, value, row });
    }
    return { out, leftOut };
  }

  /** A blueprint must never hold a vault value: one found stops the write, naming the entry. */
  private async scan(text: string) {
    const { out } = await this.values();
    const hits = scanForSecrets(text, out);
    if (hits.length)
      throw new ConflictError(
        `The blueprint would contain the value of ${hits.map((h) => `"${h}"`).join(", ")}, so nothing was written. Remove it from the notes or the app's settings Hearth reads.`,
      );
  }

  private async hmacKey(): Promise<Buffer> {
    return createHash("sha256")
      .update(await this.d.auth.automation())
      .update("lab-blueprint-fingerprint")
      .digest();
  }

  /** Writes a version when anything changed (or always, when forced). */
  run(opts: { force?: boolean; session?: Session } = {}): Promise<"written" | "unchanged"> {
    this.running ??= this.write(opts).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async write(opts: {
    force?: boolean;
    session?: Session;
  }): Promise<"written" | "unchanged"> {
    const config = await getSetting(this.db, "blueprint_config");
    if (!config) throw new ConflictError("The Lab Blueprint isn't set up yet.");
    const now = this.clock();
    const s = await this.state();
    try {
      const store = await this.store(config);
      // A folder is checked first (a drive may be unplugged); a cloud write says what's wrong itself.
      const bad = config.cloud ? undefined : await store.check();
      if (bad) throw new PackageError(bad);
      const facts = await assemble(this.d.source());
      const markdown = writeMarkdown(facts);
      const { out, leftOut } = await this.values(opts.session);
      const hits = scanForSecrets(markdown, out);
      if (hits.length)
        throw new PackageError(
          `The blueprint would contain the value of ${hits.map((h) => `"${h}"`).join(", ")}; nothing was written. Remove it from the notes or the settings Hearth reads.`,
        );
      const services = new Map(
        (
          await this.d
            .source()
            .services()
            .catch(() => [])
        ).map((x) => [x.id, x.name]),
      );
      const entries: PackageEntry[] = out.map(({ row, value }) => ({
        name: row.name,
        kind: row.kind,
        tier: row.tier,
        ...(row.serviceId && services.get(row.serviceId)
          ? { service: services.get(row.serviceId)! }
          : {}),
        ...(row.username ? { username: row.username } : {}),
        ...(row.endpoint ? { endpoint: row.endpoint } : {}),
        ...(row.category ? { category: row.category } : {}),
        ...(row.notes ? { notes: row.notes } : {}),
        tags: row.tags,
        value,
      }));
      const pkg: BlueprintPackage = {
        format: PACKAGE_FORMAT,
        writtenAt: now.toISOString(),
        hearthVersion: this.d.version,
        host: this.d.host(),
        keyId: config.keyId,
        markdown,
        facts,
        entries,
        protectedLeftOut: leftOut,
      };
      const fp = fingerprint(await this.hmacKey(), pkg);
      const newestThere = s.versions[0] ? (await store.list()).includes(s.versions[0].file) : false;
      if (!opts.force && fp === s.fingerprint && newestThere) {
        await setSetting(this.db, "blueprint_state", { ...s, lastCheck: now.toISOString() });
        return "unchanged";
      }
      const bytes = await encryptPackage(pkg, config.recipient);
      const w = await writeVersion(store, bytes, now, config.keep);
      const version: BlueprintVersion = {
        file: w.file,
        at: now.toISOString(),
        bytes: w.bytes,
        keyId: config.keyId,
        protectedIncluded: Boolean(opts.session) && leftOut.length === 0,
      };
      // The list follows the folder: versions removed (here or by hand) leave it.
      const there = new Set(await store.list());
      const versions = [version, ...s.versions.filter((v) => v.file !== w.file)].filter((v) =>
        there.has(v.file),
      );
      const { lastError: _gone, ...rest } = s;
      await setSetting(this.db, "blueprint_state", {
        ...rest,
        versions,
        lastCheck: now.toISOString(),
        fingerprint: fp,
      });
      await recordAudit(this.db, {
        actor: opts.session ? "you" : "dragon-control",
        action: `Wrote the Lab Blueprint (${entries.length} vault ${entries.length === 1 ? "entry" : "entries"}${leftOut.length ? `, ${leftOut.length} protected left out` : ""})`,
        target: config.destination,
        detail: { file: w.file, removed: w.removed },
      });
      return "written";
    } catch (e) {
      this.lastFailure = now.getTime();
      const text = e instanceof Error ? e.message : String(e);
      await setSetting(this.db, "blueprint_state", {
        ...s,
        lastError: { at: now.toISOString(), text },
      });
      throw e;
    }
  }

  /** Called every few minutes: once a day after 04:00 (Hearth's own backup runs at 03:00). */
  async tick(): Promise<void> {
    const config = await getSetting(this.db, "blueprint_config");
    if (!config) return;
    const now = this.clock();
    if (now.getTime() - this.lastFailure < RETRY_MS) return;
    const boundary = lastBoundary(now);
    boundary.setHours(4);
    if (now < boundary) boundary.setDate(boundary.getDate() - 1);
    const s = await this.state();
    if (s.lastCheck && new Date(s.lastCheck) >= boundary && !s.lastError) return;
    await this.run().catch(() => undefined);
  }

  /**
   * Step one of setting up (or changing the folder or key): check the folder and make a recovery
   * key. Nothing is saved until the owner types the key back (proof they kept it).
   */
  async startSetup(
    target: BlueprintTarget,
    session: Session,
  ): Promise<{ recoveryKey: string; keyId: string; where: string; sameDrive?: boolean }> {
    this.d.auth.requireRecent(session);
    let dest: string;
    let cloud: BlueprintCloud | undefined;
    let login: CloudLogin | undefined;
    if ("folder" in target) {
      dest = target.folder.trim();
    } else {
      const c = target.cloud;
      cloud =
        c.kind === "s3"
          ? {
              kind: "s3",
              endpoint: c.endpoint.trim().replace(/\/+$/, ""),
              bucket: c.bucket.trim(),
              ...(c.prefix?.trim() ? { prefix: c.prefix.trim().replace(/^\/+|\/+$/g, "") } : {}),
              ...(c.region?.trim() ? { region: c.region.trim() } : {}),
            }
          : { kind: "webdav", url: c.url.trim().replace(/\/+$/, "") };
      const problem = cloudProblem(cloud);
      if (problem) throw new InvalidRequestError(problem);
      if (!target.username.trim() || !target.secret)
        throw new InvalidRequestError(
          cloud.kind === "s3"
            ? "Give the access key ID and the secret key."
            : "Give the user name and password.",
        );
      login = { username: target.username.trim(), secret: target.secret };
      dest = cloudWhere(cloud);
    }
    const bad = await storeFor(cloud, dest, login, this.d.fetch).check();
    if (bad) throw new InvalidRequestError(bad);
    const key = await newRecoveryKey();
    this.pendingSetup = {
      at: this.clock().getTime(),
      destination: dest,
      ...(cloud ? { cloud, login } : {}),
      recipient: key.recipient,
      keyId: key.keyId,
    };
    const same = cloud ? undefined : await this.sameDisk(dest);
    return {
      recoveryKey: key.recoveryKey,
      keyId: key.keyId,
      where: dest,
      ...(same !== undefined ? { sameDrive: same } : {}),
    };
  }

  /** Step two: the owner types the recovery key back; then the first version is written now. */
  async confirmSetup(recoveryKey: string, session: Session): Promise<BlueprintStatus> {
    this.d.auth.requireRecent(session);
    const p = this.pendingSetup;
    if (!p || this.clock().getTime() - p.at > PENDING_MS)
      throw new ConflictError("That setup has expired. Start again: a new recovery key is made.");
    let recipient: string;
    try {
      recipient = await recipientOf(recoveryKey);
    } catch (e) {
      throw new InvalidRequestError((e as Error).message);
    }
    if (recipient !== p.recipient)
      throw new InvalidRequestError(
        "That isn't the recovery key just shown. Copy it again, in full.",
      );
    const before = await getSetting(this.db, "blueprint_config");
    // A cloud login goes into the Secure Vault, the one place Hearth keeps secrets.
    const secret =
      p.cloud && p.login
        ? await this.d.vault.add({
            name: `Lab Blueprint cloud (${p.destination})`.slice(0, 80),
            kind: "login",
            tier: "automation",
            value: p.login.secret,
            username: p.login.username,
            endpoint: p.cloud.kind === "s3" ? p.cloud.endpoint : p.cloud.url,
            notes:
              "Where the Lab Blueprint's encrypted versions are kept. Hearth added it at setup.",
            source: "lab blueprint",
            tags: ["lab-blueprint"],
          })
        : undefined;
    const config: BlueprintConfig = {
      destination: p.destination,
      ...(p.cloud && secret ? { cloud: { ...p.cloud, secretId: secret.id } } : {}),
      recipient: p.recipient,
      keyId: p.keyId,
      setupAt: this.clock().toISOString(),
      keep: BLUEPRINT_KEEP,
    };
    await setSetting(this.db, "blueprint_config", config);
    this.pendingSetup = undefined;
    // The old cloud login was Hearth's own, made for this; it goes when it's replaced.
    if (before?.cloud && before.cloud.secretId !== config.cloud?.secretId)
      await this.d.vault.removeInternal(before.cloud.secretId);
    // A new place starts a new list of versions (the old ones stay where they were).
    if (before && before.destination !== config.destination)
      await setSetting(this.db, "blueprint_state", { versions: [] });
    await recordAudit(this.db, {
      actor: "you",
      action: before
        ? `Changed the Lab Blueprint${before.destination !== config.destination ? `'s folder to ${config.destination}` : ""}${before.keyId !== config.keyId ? `${before.destination !== config.destination ? " and" : "'s"} recovery key (${before.keyId} to ${config.keyId})` : ""}`
        : `Set up the Lab Blueprint in ${config.destination}`,
      target: config.destination,
    });
    // Said to be safely stored only after a version is really written.
    await this.run({ force: true, session });
    return this.status();
  }

  /** Update now: the owner's own run, with protected entries when the vault is unlocked. */
  async updateNow(session: Session): Promise<"written" | "unchanged"> {
    // Protected entries change the fingerprint, so a version gets them without being forced.
    return this.run({ session });
  }

  /** Turns the daily blueprint off. Versions already written stay where they are. */
  async turnOff(session: Session): Promise<void> {
    this.d.auth.requireRecent(session);
    const config = await getSetting(this.db, "blueprint_config");
    await deleteSetting(this.db, "blueprint_config");
    await deleteSetting(this.db, "blueprint_state");
    if (config?.cloud) await this.d.vault.removeInternal(config.cloud.secretId);
    await recordAudit(this.db, {
      actor: "you",
      action: `Turned off the Lab Blueprint (the versions already written are kept${config?.cloud ? "; its cloud login was removed from the vault" : ""})`,
      target: config?.destination ?? "lab blueprint",
    });
  }

  private async newestFile(): Promise<{ file: string; bytes: Uint8Array }> {
    const config = await getSetting(this.db, "blueprint_config");
    if (!config) throw new ConflictError("The Lab Blueprint isn't set up yet.");
    const s = await this.state();
    const v = s.versions[0];
    if (!v) throw new ConflictError("No version has been written yet.");
    const bytes = await (await this.store(config)).get(v.file).catch(() => undefined);
    if (!bytes) throw new ConflictError(`${v.file} isn't in ${config.destination} any more.`);
    return { file: v.file, bytes };
  }

  /** Opens the newest version with the key, in memory only, and says what it holds. */
  async testKey(
    recoveryKey: string,
    session: Session,
  ): Promise<{ ok: true; file: string; writtenAt: string; apps: number; entries: number }> {
    this.d.auth.requireRecent(session);
    const { file, bytes } = await this.newestFile();
    let pkg: BlueprintPackage;
    try {
      pkg = await decryptPackage(bytes, recoveryKey);
    } catch (e) {
      throw new InvalidRequestError((e as Error).message);
    }
    return {
      ok: true,
      file,
      writtenAt: pkg.writtenAt,
      apps: pkg.facts.apps.length,
      entries: pkg.entries.length,
    };
  }

  /** Import, step one: open a package with its key and show what it holds (no values). */
  async openImport(
    bytes: Uint8Array,
    recoveryKey: string,
    session: Session,
  ): Promise<BlueprintImportPreview> {
    this.d.auth.requireRecent(session);
    let pkg: BlueprintPackage;
    try {
      pkg = await decryptPackage(bytes, recoveryKey);
    } catch (e) {
      throw new InvalidRequestError((e as Error).message);
    }
    const now = this.clock().getTime();
    for (const [k, v] of this.openImports) if (now - v.at > PENDING_MS) this.openImports.delete(k);
    const id = randomUUID();
    this.openImports.set(id, { at: now, pkg });
    return {
      id,
      writtenAt: pkg.writtenAt,
      hearthVersion: pkg.hearthVersion,
      host: pkg.host,
      apps: pkg.facts.apps.length,
      entries: pkg.entries.map((e) => ({
        name: e.name,
        kind: e.kind,
        tier: e.tier,
        ...(e.service ? { service: e.service } : {}),
      })),
      protectedLeftOut: pkg.protectedLeftOut,
    };
  }

  /**
   * Import, step two: the entries the owner chose go into this vault through its usual way in, and
   * the blueprint is kept for Ember to read. Nothing runs: Ember plans the rebuild with the owner.
   */
  async applyImport(
    id: string,
    names: string[],
    session: Session,
  ): Promise<{ added: string[]; skipped: string[] }> {
    this.d.auth.requireRecent(session);
    const open = this.openImports.get(id);
    if (!open) throw new ConflictError("That import has expired. Open the file again.");
    const pkg = open.pkg;
    const want = new Set(names);
    const have = new Set((await this.d.vault.list()).map((r) => r.name.toLowerCase()));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const e of pkg.entries) {
      if (!want.has(e.name)) continue;
      if (have.has(e.name.toLowerCase())) {
        skipped.push(e.name);
        continue;
      }
      await this.d.vault.add({
        name: e.name,
        kind: e.kind as Parameters<Vault["add"]>[0]["kind"],
        tier: e.tier,
        value: e.value,
        source: "lab blueprint",
        ...(e.username ? { username: e.username } : {}),
        ...(e.endpoint ? { endpoint: e.endpoint } : {}),
        ...(e.category ? { category: e.category } : {}),
        ...(e.notes ? { notes: e.notes } : {}),
        tags: e.tags,
      });
      added.push(e.name);
    }
    await setSetting(this.db, "blueprint_imported", {
      at: this.clock().toISOString(),
      from: pkg.host,
      ...(pkg.hearthVersion ? { hearthVersion: pkg.hearthVersion } : {}),
      entries: added.length,
      markdown: pkg.markdown,
    });
    this.openImports.delete(id);
    await recordAudit(this.db, {
      actor: "you",
      action: `Imported a Lab Blueprint from ${pkg.host} (${added.length} vault ${added.length === 1 ? "entry" : "entries"})`,
      target: "lab blueprint",
      detail: { added, skipped, writtenAt: pkg.writtenAt },
    });
    return { added, skipped };
  }

  /** The imported blueprint, for Ember to plan the rebuild from (it holds no secret). */
  async imported(): Promise<{ markdown: string; at: string; from: string } | null> {
    const i = await getSetting(this.db, "blueprint_imported");
    return i ? { markdown: i.markdown, at: i.at, from: i.from } : null;
  }
}
