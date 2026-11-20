import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FolderListing, ItemProperties, StorageLocation } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { withTransaction } from "../db/tx";
import { recordAudit } from "../store/audit";
import { ConflictError, InvalidRequestError, NotFoundError } from "../store/errors";
import { getSetting } from "../store/settings";
import { DEMO_TREES, demoSource } from "./demo-source";
import { fsSource } from "./fs-source";
import { joinRelative, toSegments, type FileSource } from "./source";

const LIST_LIMIT = 2000;
const isWindows = process.platform === "win32";

type LocationRow = typeof t.storageLocations.$inferSelect;

export function toLocation(row: LocationRow): StorageLocation {
  return {
    id: row.id,
    hostId: row.hostId,
    label: row.label,
    path: row.path,
    source: row.source,
    addedAt: row.addedAt,
  };
}

function sourceFor(location: LocationRow): FileSource {
  if (location.source === "demo") {
    const tree = location.id.replace(/^demo-/, "");
    if (!(tree in DEMO_TREES)) throw new NotFoundError("This sample location has no contents.");
    return demoSource(tree as keyof typeof DEMO_TREES, location.path);
  }
  return fsSource(location.path);
}

async function getLocation(handle: DbHandle, id: string): Promise<LocationRow> {
  const row = await handle.db
    .select()
    .from(t.storageLocations)
    .where(eq(t.storageLocations.id, id))
    .get();
  if (!row) throw new NotFoundError("That location is not being watched.");
  return row;
}

export async function browse(
  handle: DbHandle,
  id: string,
  relative?: string,
): Promise<FolderListing> {
  const location = await getLocation(handle, id);
  const segments = toSegments(relative);
  const source = sourceFor(location);
  const { entries, total } = await source.list(segments, LIST_LIMIT);
  const files = entries.filter((e) => e.kind === "file");
  return {
    locationId: id,
    path: joinRelative(segments),
    displayPath: source.displayPath(segments),
    breadcrumbs: [
      { name: location.label, path: "" },
      ...segments.map((name, i) => ({ name, path: joinRelative(segments.slice(0, i + 1)) })),
    ],
    entries,
    truncated: total > entries.length,
    totals: {
      folders: entries.length - files.length,
      files: files.length,
      fileBytes: files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0),
    },
  };
}

export async function properties(
  handle: DbHandle,
  id: string,
  relative?: string,
): Promise<ItemProperties> {
  const location = await getLocation(handle, id);
  const segments = toSegments(relative);
  const props = await sourceFor(location).properties(segments);
  return segments.length ? props : { ...props, name: location.label };
}

function samePathOrInside(child: string, parent: string) {
  const c = isWindows ? child.toLowerCase() : child;
  const p = isWindows ? parent.toLowerCase() : parent;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c === p || c.startsWith(withSep);
}

/**
 * Start watching a folder on this machine. It must exist, be a folder, and
 * live on one of the drives discovery found, so the browser can only ever
 * see storage you have deliberately brought into Hearth.
 */
export async function addLocation(
  handle: DbHandle,
  input: { path: string; label?: string },
): Promise<StorageLocation> {
  const { db } = handle;
  if ((await getSetting(db, "environment")) !== "real") {
    throw new ConflictError(
      "Watching real folders needs your own systems. Discover this machine first.",
    );
  }
  const host = (await db.select().from(t.hosts)).find((h) => h.connection === "this-machine");
  if (!host) throw new ConflictError("Discover this machine before watching its folders.");

  const raw = input.path.trim();
  if (!path.isAbsolute(raw)) {
    throw new InvalidRequestError(
      isWindows ? 'Use a full path, like "E:\\Movies".' : 'Use a full path, like "/mnt/media".',
    );
  }
  const resolved = path.resolve(raw);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat) throw new InvalidRequestError(`Nothing exists at ${resolved}.`);
  if (!stat.isDirectory()) throw new InvalidRequestError(`${resolved} is a file. Choose a folder.`);

  const volumes = await db.select().from(t.volumes).where(eq(t.volumes.hostId, host.id));
  if (!volumes.some((v) => samePathOrInside(resolved, path.resolve(v.mount)))) {
    throw new InvalidRequestError(
      `That folder is not on a drive Hearth knows about (${volumes.map((v) => v.mount).join(", ")}).`,
    );
  }

  const existing = await db.select().from(t.storageLocations);
  if (
    existing.some(
      (l) =>
        (isWindows ? l.path.toLowerCase() : l.path) ===
        (isWindows ? resolved.toLowerCase() : resolved),
    )
  ) {
    throw new ConflictError("That folder is already being watched.");
  }

  const row: LocationRow = {
    id: randomUUID(),
    hostId: host.id,
    label: input.label?.trim() || path.basename(resolved) || resolved,
    path: resolved,
    source: "fs",
    addedAt: new Date().toISOString(),
    sort: existing.length,
  };
  await withTransaction(handle, async () => {
    await db.insert(t.storageLocations).values(row);
    await recordAudit(db, {
      actor: "you",
      action: `Started watching ${resolved}`,
      target: `storage:${row.id}`,
    });
  });
  return toLocation(row);
}

/** Stops watching. Only Hearth's record is removed; the folder is untouched. */
export async function removeLocation(handle: DbHandle, id: string): Promise<void> {
  const location = await getLocation(handle, id);
  await withTransaction(handle, async () => {
    await handle.db.delete(t.storageLocations).where(eq(t.storageLocations.id, id));
    await recordAudit(handle.db, {
      actor: "you",
      action: `Stopped watching ${location.path}`,
      target: `storage:${id}`,
    });
  });
}
