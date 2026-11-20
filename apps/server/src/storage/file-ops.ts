import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { ACTIONS, THIS_HOST, type JobStepInput } from "@dragon-control/core";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import type { Place } from "./file-index";
import { inside, type FileManager } from "./files";
import { toSegments } from "./source";
import type { Elevation } from "../admin/elevation";
import type { OperationName, Params } from "../elevated/protocol";

/**
 * File operations from the file manager: create a folder, rename, move, copy. Each one is a plan
 * step the owner approves, carried out by Hearth's own account (never elevated), and checked
 * afterwards by reading the result back.
 *
 * What it never does:
 * - delete anything, or overwrite anything (the destination must not exist);
 * - move across drives (that would be a copy and a delete): copy instead;
 * - touch secrets or settings files, or anything outside a drive or folder Hearth shows;
 * - change files inside folders a download client or Radarr, Sonarr, Lidarr or Readarr manage:
 *   those apps track files by path, so a rename there breaks their records. It says to do it in
 *   the app instead.
 */

export type FileOp = "mkdir" | "rename" | "move" | "copy";
const OPS: readonly FileOp[] = ["mkdir", "rename", "move", "copy"];

/** Apps that track files by their path: changing their folders behind their back breaks them. */
const MANAGERS = /^(radarr|sonarr|lidarr|readarr|qbittorrent|sabnzbd|transmission|deluge|nzbget)/i;
/** A name, not a path: no separators, no "..", nothing hidden from listings by its name. */
const NAME = /^(?!\.{1,2}$)[^\\/:*?"<>|\0]{1,200}$/;
const SETTINGS =
  /^(\.env(\..*)?|.*\.(env|ini|conf|cfg|config|toml|db|sqlite|sqlite3|db-wal|db-shm|kdbx|key|pem)|config\.(xml|json|ya?ml)|settings\.(json|ya?ml))$/i;

class Refuse extends Error {}

interface Target {
  rootId: string;
  rootLabel: string;
  /** Where in the root, as shown in the file manager ("Movies/Heat (1995)"). */
  relative: string;
  abs: string;
  /** In words: "Film › Movies/Heat (1995)" for a named drive, else the real path. */
  shown: string;
}

interface Resolved {
  op: FileOp;
  source?: Target & { size: number; mtimeMs: number; isDir: boolean };
  destination: Target;
  /** Plex or Jellyfin read the destination: they pick changes up on their next scan. */
  readers: string[];
}

export class FileOperations {
  private placesOf: () => Promise<Place[]> = async () => {
    throw new Refuse("Hearth has not read which folders your apps manage yet.");
  };

  private elevation?: Elevation;

  constructor(private readonly files: FileManager) {}

  /**
   * Hearth's elevated executor: where Hearth's own account may not write (drives owned by
   * another account), the approved step is carried out by the executor, inside the folders its
   * owner put in its scope. Same checks, same approval; only who writes changes.
   */
  useElevation(elevation: Elevation) {
    this.elevation = elevation;
  }

  private async executorOp(r: Resolved): Promise<OperationName> {
    return r.op === "mkdir" ? "dir.create" : r.op === "copy" ? "file.copy" : "file.rename";
  }

  /** Where the apps' library and download folders are (from their containers' mounts). */
  usePlaces(places: () => Promise<Place[]>) {
    this.placesOf = places;
  }

  private async target(rootId: unknown, relative: unknown, what: string): Promise<Target> {
    if (typeof rootId !== "string" || !rootId) throw new Refuse(`No drive was given for ${what}.`);
    const root = (await this.files.roots()).find((r) => r.id === rootId);
    if (!root) throw new Refuse("That drive or folder is not available in Hearth.");
    if (root.kind === "sample") throw new Refuse("Sample files cannot be changed.");
    const segments = toSegments(typeof relative === "string" ? relative : "");
    const abs = path.join(root.path, ...segments);
    if (!inside(abs, root.path)) throw new Refuse("Paths cannot leave the drive.");
    if (this.files.hidden(abs) || segments.some((s) => SETTINGS.test(s)))
      throw new Refuse("That holds secrets or settings, so Hearth never changes it.");
    const rel = segments.join("/");
    return {
      rootId,
      rootLabel: root.label,
      relative: rel,
      abs,
      shown: root.named ? [root.label, rel].filter(Boolean).join(" › ") : abs,
    };
  }

  private async guard(abs: string, verb: string): Promise<string[]> {
    const places = await this.placesOf();
    const owners = places.filter((p) => inside(abs, p.path) || inside(p.path, abs));
    const managers = owners.filter((p) => p.apps.some((a) => MANAGERS.test(a)));
    if (managers.length) {
      const apps = [...new Set(managers.flatMap((p) => p.apps.filter((a) => MANAGERS.test(a))))];
      throw new Refuse(
        `${apps.join(" and ")} ${apps.length > 1 ? "manage" : "manages"} ${managers[0]!.label}: ${verb} there would break ${apps.length > 1 ? "their" : "its"} records of these files. Do it in ${apps[0]} (it renames and moves its own files), or choose a folder no app manages.`,
      );
    }
    return [...new Set(owners.flatMap((p) => p.apps))];
  }

  private async resolve(params: Record<string, unknown>): Promise<Resolved> {
    const op = params.op as FileOp;
    if (!OPS.includes(op)) throw new Refuse("Choose create folder, rename, move, or copy.");
    if (op === "mkdir") {
      const name = String(params.name ?? params.newName ?? "");
      if (!NAME.test(name)) throw new Refuse("That is not a usable folder name.");
      const parent = await this.target(params.root, params.path, "the new folder");
      const destination = await this.target(
        params.root,
        [parent.relative, name].filter(Boolean).join("/"),
        "the new folder",
      );
      const readers = await this.guard(destination.abs, "adding a folder");
      return { op, destination, readers };
    }
    const source = await this.target(params.root, params.path, "the item");
    if (!source.relative) throw new Refuse("A whole drive or watched folder cannot be changed.");
    const st = await fs.lstat(source.abs).catch(() => undefined);
    if (!st) throw new Refuse(`${source.relative} is not there any more.`);
    if (st.isSymbolicLink()) throw new Refuse("Links are not followed or changed.");
    let destRel: string;
    let destRoot = params.root;
    if (op === "rename") {
      const name = String(params.name ?? params.newName ?? "");
      if (!NAME.test(name)) throw new Refuse("That is not a usable name.");
      destRel = [path.posix.dirname(source.relative), name].filter((x) => x && x !== ".").join("/");
    } else {
      destRoot = params.toRoot ?? params.root;
      destRel = [String(params.to ?? ""), path.posix.basename(source.relative)]
        .filter(Boolean)
        .join("/");
    }
    const destination = await this.target(destRoot, destRel, "the destination");
    if (inside(destination.abs, source.abs)) throw new Refuse("A folder cannot go inside itself.");
    if (op !== "copy") await this.guard(source.abs, op === "rename" ? "renaming" : "moving");
    const readers = await this.guard(
      destination.abs,
      op === "copy" ? "copying" : op === "rename" ? "renaming" : "moving",
    );
    return {
      op,
      source: { ...source, size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() },
      destination,
      readers,
    };
  }

  private async absent(t: Target) {
    if (
      await fs.lstat(t.abs).then(
        () => true,
        () => false,
      )
    )
      throw new Refuse(`${t.relative} already exists. Hearth never replaces a file or folder.`);
    const parent = path.dirname(t.abs);
    const pst = await fs.stat(parent).catch(() => undefined);
    if (!pst?.isDirectory())
      throw new Refuse(`The folder ${path.dirname(t.relative)} is not there.`);
  }

  private async sameDevice(a: string, b: string) {
    const [x, y] = await Promise.all([fs.stat(a), fs.stat(path.dirname(b))]);
    return x.dev === y.dev;
  }

  private words(r: Resolved): string {
    const where = (t: Target) => t.shown;
    switch (r.op) {
      case "mkdir":
        return `Create the folder ${where(r.destination)}`;
      case "rename":
        return `Rename ${where(r.source!)} to ${path.basename(r.destination.abs)}`;
      case "move":
        return `Move ${where(r.source!)} to ${where(r.destination)}`;
      case "copy":
        return `Copy ${where(r.source!)} to ${where(r.destination)}`;
    }
  }

  async plan(step: JobStepInput): Promise<PlannedStep> {
    const base: PlannedStep = {
      label: ACTIONS["file-manage"].describe("this machine"),
      serviceName: "This machine",
      changes: true,
      policy: "refuse",
      policyReason: "",
    };
    try {
      if (step.serviceId !== THIS_HOST)
        throw new Refuse(`Files are changed on the machine: use serviceId "${THIS_HOST}".`);
      const p = step.params ?? {};
      const r = await this.resolve(p);
      await this.absent(r.destination);
      // Said before you approve, not after: who may write there. Hearth's own account when it
      // can; otherwise the elevated executor when its scope covers the folder; otherwise no one.
      let via: "hearth" | "elevated" = "hearth";
      for (const dir of new Set([
        path.dirname(r.destination.abs),
        ...(r.source && r.op !== "copy" ? [path.dirname(r.source.abs)] : []),
      ]))
        if (!(await writable(dir))) {
          const op = await this.executorOp(r);
          const covered = this.elevation
            ? await this.elevation.covers(op, r.destination.abs)
            : { ok: false as const, why: "The elevated executor is not set up here." };
          if (covered.ok) via = "elevated";
          else
            throw new Refuse(
              `Hearth's account is not allowed to write in ${dir}, and the elevated executor cannot either: ${covered.why} Hearth does not change its own access.`,
            );
        }
      if (r.op === "move" && !(await this.sameDevice(r.source!.abs, r.destination.abs)))
        throw new Refuse(
          "That is another drive: a move there would copy and then delete the original. Copy it instead; the original stays until you decide.",
        );
      const read =
        r.readers.length > 0
          ? ` ${r.readers.join(" and ")} ${r.readers.length > 1 ? "read" : "reads"} this folder and will pick the change up on the next scan.`
          : "";
      return {
        ...base,
        label: this.words(r),
        // What was seen when planning: the step does nothing if the item changed since.
        params: {
          ...p,
          ...(r.source ? { size: r.source.size, mtimeMs: Math.round(r.source.mtimeMs) } : {}),
          via,
        },
        policy: "approve-first",
        policyReason: `Changes files on this machine ${via === "elevated" ? "through Hearth's elevated executor (this drive belongs to another account)" : "as Hearth's own account"}. Nothing is deleted or replaced.${read}`,
      };
    } catch (error) {
      return { ...base, policyReason: error instanceof Error ? error.message : String(error) };
    }
  }

  async run(step: StepRun): Promise<StepOutcome> {
    try {
      const p = step.params ?? {};
      const r = await this.resolve(p);
      if (r.source) {
        if (
          (typeof p.size === "number" && r.source.size !== p.size) ||
          (typeof p.mtimeMs === "number" && Math.round(r.source.mtimeMs) !== p.mtimeMs)
        )
          throw new Refuse(
            `${r.source.relative} changed after the plan was approved, so nothing was done.`,
          );
      }
      await this.absent(r.destination);
      const dest = r.destination.abs;
      if (p.via === "elevated") return await this.runElevated(r, step);
      if (r.op === "mkdir") {
        await fs.mkdir(dest);
        const st = await fs.stat(dest);
        if (!st.isDirectory())
          return { ok: false, result: `${r.destination.relative} was not created.` };
        return {
          ok: true,
          result: `Created ${r.destination.shown}.`,
        };
      }
      const src = r.source!;
      if (r.op === "rename" || r.op === "move") {
        if (!(await this.sameDevice(src.abs, dest)))
          throw new Refuse("That is another drive now; nothing was moved. Copy it instead.");
        await fs.rename(src.abs, dest);
        const there = await fs.lstat(dest).catch(() => undefined);
        const gone = !(await fs.lstat(src.abs).then(
          () => true,
          () => false,
        ));
        if (!there || !gone || (!src.isDir && there.size !== src.size))
          return { ok: false, result: "The item did not read back at its new place." };
        return {
          ok: true,
          result: `${r.op === "rename" ? "Renamed" : "Moved"} to ${r.destination.shown}, checked at its new place.`,
        };
      }
      // Copy: never over anything (COPYFILE_EXCL), the original untouched.
      await fs.cp(src.abs, dest, {
        recursive: src.isDir,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      const copied = await sizeOf(dest);
      const original = await sizeOf(src.abs);
      if (copied !== original)
        return {
          ok: false,
          result: `The copy is ${copied} bytes but the original is ${original}; the partial copy at ${r.destination.relative} is left for you to check (Hearth does not delete).`,
        };
      return {
        ok: true,
        result: `Copied to ${r.destination.shown} (${original.toLocaleString("en-US")} bytes, checked). The original is unchanged.`,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM")
        return {
          ok: false,
          result:
            "Hearth's account is not allowed to write there, so nothing was changed. The drive's permissions decide this; Hearth does not raise its own access.",
        };
      return {
        ok: false,
        result:
          error instanceof Refuse
            ? error.message
            : `Nothing was changed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** The approved step through the executor, which checks everything again itself. */
  private async runElevated(r: Resolved, step: StepRun): Promise<StepOutcome> {
    if (!this.elevation)
      return { ok: false, result: "The elevated executor is not set up here; nothing was done." };
    const op = await this.executorOp(r);
    const params: Params =
      op === "dir.create"
        ? await (async () => {
            // The new folder gets the same owner as the folder it is made in.
            const parent = await fs.stat(path.dirname(r.destination.abs));
            return { path: r.destination.abs, mode: 0o755, uid: parent.uid, gid: parent.gid };
          })()
        : {
            from: r.source!.abs,
            to: r.destination.abs,
            ...(r.source!.isDir ? {} : { size: r.source!.size }),
            ...(op === "file.rename" ? { mtimeMs: Math.round(r.source!.mtimeMs) } : {}),
          };
    const res = await this.elevation.perform(op, params, step);
    return {
      ok: res.ok,
      result: res.ok
        ? `${res.result} (through the elevated executor)`
        : `Nothing was changed: ${res.result}`,
    };
  }

  /** Puts a rename or move back; copies and new folders are left (Hearth does not delete). */
  async undo(step: StepRun): Promise<StepOutcome | undefined> {
    const p = step.params ?? {};
    if (p.op !== "rename" && p.op !== "move") return undefined;
    try {
      const source = await this.target(p.root, p.path, "the item");
      const rel = String(p.path ?? "");
      const destination =
        p.op === "rename"
          ? await this.target(
              p.root,
              [path.posix.dirname(rel), String(p.name ?? p.newName ?? "")]
                .filter((x) => x && x !== ".")
                .join("/"),
              "the destination",
            )
          : await this.target(
              p.toRoot ?? p.root,
              [String(p.to ?? ""), path.posix.basename(rel)].filter(Boolean).join("/"),
              "the destination",
            );
      await this.absent(source);
      await fs.rename(destination.abs, source.abs);
      return { ok: true, result: `Put back at ${source.shown}.` };
    } catch (error) {
      return { ok: false, result: error instanceof Error ? error.message : String(error) };
    }
  }
}

async function writable(dir: string): Promise<boolean> {
  return fs.access(dir, fsConstants.W_OK).then(
    () => true,
    () => false,
  );
}

async function sizeOf(p: string): Promise<number> {
  const st = await fs.lstat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const d of await fs.readdir(p)) total += await sizeOf(path.join(p, d));
  return total;
}
