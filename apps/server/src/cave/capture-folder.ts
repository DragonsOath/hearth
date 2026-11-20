import { access, constants, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client";
import { ForbiddenAuthError } from "../auth/service";
import { deleteSetting, getSetting, setSetting } from "../store/settings";

/**
 * Where screen captures are saved (11-18, the owner: "a spot in settings where you can set where
 * those screen captures get saved"). A folder on the computer Hearth runs on; with none set, Save
 * downloads the picture in the browser as before. Hearth names each file itself, so a capture
 * only ever lands inside the chosen folder.
 */

/** The largest picture saved (the same as an attachment's, as base64). */
const MAX_BYTES = 12 * 1024 * 1024;

export class CaptureFolderError extends Error {
  readonly statusCode = 400;
}

/** A folder path as typed: trimmed, absolute, and normalised; otherwise an error to show. */
export function cleanFolder(raw: string, platform: NodeJS.Platform = process.platform): string {
  const p = raw.trim().replace(/^["']|["']$/g, "");
  const lib = platform === "win32" ? path.win32 : path.posix;
  if (!p) throw new CaptureFolderError("Type a folder path.");
  if (p.length > 500) throw new CaptureFolderError("That path is too long.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p))
    throw new CaptureFolderError("That path has a character a folder can't.");
  if (!lib.isAbsolute(p))
    throw new CaptureFolderError(
      platform === "win32"
        ? "Use the whole path, starting with the drive, like D:\\Pictures\\Hearth."
        : "Use the whole path, starting with /, like /home/you/Pictures/Hearth.",
    );
  return lib.normalize(p);
}

/** Makes the folder if it isn't there and checks Hearth may write to it. */
export async function readyFolder(folder: string): Promise<void> {
  try {
    await mkdir(folder, { recursive: true });
    const s = await stat(folder);
    if (!s.isDirectory()) throw new CaptureFolderError("That path is a file, not a folder.");
    await access(folder, constants.W_OK);
  } catch (e) {
    if (e instanceof CaptureFolderError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new CaptureFolderError(
      code === "EACCES" || code === "EPERM"
        ? "Hearth isn't allowed to write there. Pick a folder its user can write to."
        : code === "ENOENT" || code === "ENOTDIR"
          ? "That drive or folder couldn't be found or made."
          : "Hearth couldn't use that folder.",
    );
  }
}

/** A name for a new capture: the time it was taken, with a number added if it is taken. */
export function captureName(now: Date, n = 0): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `hearth-capture-${stamp}${n ? `-${n}` : ""}.png`;
}

/** Saves the picture in the folder, never over another file; returns the file's full path. */
export async function saveCapture(folder: string, png: Buffer, now = new Date()): Promise<string> {
  await readyFolder(folder);
  for (let n = 0; n < 100; n++) {
    const file = path.join(folder, captureName(now, n));
    try {
      await writeFile(file, png, { flag: "wx" });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new CaptureFolderError("Too many captures at once; try again.");
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function registerCaptureFolderRoutes(app: FastifyInstance, db: Database) {
  const owner = (request: { session?: { method?: string } | null }) => {
    if (!request.session) throw new ForbiddenAuthError("Sign in to do this.");
  };
  app.get("/api/captures/folder", async (request) => {
    owner(request);
    const kept = await getSetting(db, "capture_folder").catch(() => undefined);
    return { path: kept?.path ?? null };
  });
  app.put("/api/captures/folder", async (request) => {
    owner(request);
    const body = z
      .object({ path: z.string().max(600) })
      .strict()
      .parse(request.body);
    if (!body.path.trim()) {
      await deleteSetting(db, "capture_folder");
      return { path: null };
    }
    const folder = cleanFolder(body.path);
    await readyFolder(folder);
    await setSetting(db, "capture_folder", { path: folder });
    return { path: folder };
  });
  app.post(
    "/api/captures",
    { bodyLimit: Math.ceil(MAX_BYTES * 1.4) + 64 * 1024 },
    async (request) => {
      owner(request);
      const body = z
        .object({ data: z.string().min(1) })
        .strict()
        .parse(request.body);
      const kept = await getSetting(db, "capture_folder").catch(() => undefined);
      if (!kept?.path) throw new CaptureFolderError("No folder is set for captures.");
      const png = Buffer.from(body.data, "base64");
      if (png.length > MAX_BYTES) throw new CaptureFolderError("That picture is too big to save.");
      if (!png.subarray(0, 8).equals(PNG)) throw new CaptureFolderError("That isn't a picture.");
      return { file: await saveCapture(kept.path, png) };
    },
  );
}
