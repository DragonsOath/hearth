import type { StepParams } from "@dragon-control/core";
import type { PlannedStep, StepOutcome } from "../jobs/operations";
import { AppUnreachableError, type Fetch } from "./http";
import { IMMICH_ASSET, immichCall } from "./immich";

/**
 * Organizing Immich photos from Hearth, through Immich's own API only:
 *
 * - Albums: create one from chosen photos, add photos to one, or take photos out again (the undo).
 *   Big batches are split into steps of at most ALBUM_CHUNK photos, so the plan shows progress
 *   step by step. Adding is safe to repeat (Immich reports a photo already in the album as a
 *   duplicate, which counts as done); making an album is refused once one with that name exists,
 *   so a plan never adds to someone else's album.
 * - Edits: Immich's own non-destructive edits (2.5 and later): mirror and rotate are stored as a
 *   list Immich applies when it draws the photo, so the original file is never touched and
 *   removing the edits brings it back.
 *
 * Not done here, because Immich has no supported way: renaming a photo's file (its API cannot
 * change a file name), and moving files into folders directly. Files on disk follow Immich's
 * storage template; when it uses {{album}}, Immich itself moves uploaded photos into album
 * folders (never external-library files). storageLayout() reads that setting so the panel can say
 * what will happen on disk.
 */

/** Photos per album step: a plan holds 12 steps, so one plan organizes up to 6,000 photos. */
export const ALBUM_CHUNK = 500;
export const ALBUM_OPS = ["album-create", "album-add", "album-remove"] as const;
export const EDIT_OPS = ["edit", "edit-reset"] as const;

type Edit =
  | { action: "crop"; parameters: { x: number; y: number; width: number; height: number } }
  | { action: "rotate"; parameters: { angle: number } }
  | { action: "mirror"; parameters: { axis: "horizontal" | "vertical" } };

interface Album {
  id: string;
  albumName: string;
  assetCount?: number;
  /** When the album last changed (Immich's updatedAt): the panel's album tabs go newest first. */
  updatedAt?: string;
}

const idsOf = (body: unknown): string[] => {
  const raw = String(body ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(raw)];
};

/** Splits photo ids into album steps of at most ALBUM_CHUNK. */
export function chunk<T>(list: T[], size = ALBUM_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function immichAlbums(fetchImpl: Fetch, base: string, key: string): Promise<Album[]> {
  const r = await immichCall<Album[]>(fetchImpl, base, key, "GET", "/albums");
  if (!r.ok) throw new AppUnreachableError(`Immich answered ${r.status} for its albums.`);
  return (Array.isArray(r.data) ? r.data : [])
    .filter((a) => a && IMMICH_ASSET.test(a.id))
    .map((a) => ({
      id: a.id,
      albumName: a.albumName ?? "",
      assetCount: a.assetCount ?? 0,
      ...(a.updatedAt ? { updatedAt: a.updatedAt } : {}),
    }))
    .sort((a, b) => a.albumName.localeCompare(b.albumName));
}

/** Every photo id in an album, read a page at a time (to check what a step did). */
export async function albumAssetIds(
  fetchImpl: Fetch,
  base: string,
  key: string,
  albumId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const r = await immichCall<{
      assets?: { items?: { id?: string }[]; nextPage?: string | null };
    }>(fetchImpl, base, key, "POST", "/search/metadata", {
      albumIds: [albumId],
      size: 1000,
      page,
      withDeleted: false,
    });
    if (!r.ok) throw new AppUnreachableError(`Immich answered ${r.status} reading the album.`);
    for (const a of r.data?.assets?.items ?? []) if (a.id) ids.add(a.id.toLowerCase());
    if (!r.data?.assets?.nextPage) break;
  }
  return ids;
}

/** What Immich's storage template does with files on disk (admin keys only can read it). */
export async function storageLayout(
  fetchImpl: Fetch,
  base: string,
  key: string,
): Promise<{ known: boolean; enabled?: boolean; template?: string; usesAlbum?: boolean }> {
  const r = await immichCall<{ storageTemplate?: { enabled?: boolean; template?: string } }>(
    fetchImpl,
    base,
    key,
    "GET",
    "/system-config",
  ).catch(() => undefined);
  const st = r?.ok ? r.data?.storageTemplate : undefined;
  if (!st) return { known: false };
  const template = st.template ?? "";
  return {
    known: true,
    enabled: Boolean(st.enabled),
    template,
    usesAlbum: /\{\{\s*album\b/.test(template),
  };
}

/* ---------- Albums ---------- */

export async function planAlbum(
  c: { fetchImpl: Fetch; base: string; key: string; service: { name: string } },
  op: (typeof ALBUM_OPS)[number],
  params: StepParams | undefined,
  base: PlannedStep,
): Promise<PlannedStep> {
  const ids = idsOf(params?.body);
  if (!ids.length) throw new Error("Choose at least one photo.");
  if (ids.length > ALBUM_CHUNK)
    throw new Error(`One step holds at most ${ALBUM_CHUNK} photos; split them over more steps.`);
  if (ids.some((x) => !IMMICH_ASSET.test(x))) throw new Error("Those are not Immich photo ids.");
  const albums = await immichAlbums(c.fetchImpl, c.base, c.key);
  if (op === "album-create") {
    const n = `${ids.length} photo${ids.length === 1 ? "" : "s"}`;
    const name = String(params?.name ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (!name || name.length > 120) throw new Error("An album name is 1 to 120 characters.");
    if (albums.some((a) => a.albumName.toLowerCase() === name.toLowerCase()))
      throw new Error(
        `${c.service.name} already has an album called "${name}". Add the photos to it instead.`,
      );
    return {
      ...base,
      label: `Make the album "${name}" in ${c.service.name} with ${n}`,
      serviceName: c.service.name,
      params: { op, name, body: ids.join(",") },
      change: {
        summary: `New album "${name}"`,
        settings: [{ name: `Album "${name}"`, before: "not there", after: `${n} in it` }],
      },
    };
  }
  // Adding to (or taking out of) an album: an existing one by id, or one made earlier in the same
  // plan by its name.
  const byId = albums.find((a) => a.id === String(params?.albumId ?? "").toLowerCase());
  const name = String(params?.name ?? "").trim();
  if (!byId && !(op === "album-add" && name && params?.made))
    throw new Error(`${c.service.name} has no such album.`);
  const albumName = byId?.albumName ?? name;
  // Only photos not already in it are added (or only ones in it are taken out), so the step's
  // list is exactly what it changes, and undoing it puts the album back as it was.
  let keep = ids;
  let skipped = 0;
  if (byId) {
    const inside = await albumAssetIds(c.fetchImpl, c.base, c.key, byId.id);
    keep = ids.filter((x) => (op === "album-add" ? !inside.has(x) : inside.has(x)));
    skipped = ids.length - keep.length;
    if (!keep.length)
      throw new Error(
        op === "album-add"
          ? `All ${ids.length === 1 ? "of it is" : `${ids.length} are`} already in "${albumName}".`
          : `None of them are in "${albumName}".`,
      );
  }
  const n = `${keep.length} photo${keep.length === 1 ? "" : "s"}`;
  const verb = op === "album-add" ? "Add" : "Take";
  return {
    ...base,
    label: `${verb} ${n} ${op === "album-add" ? "to" : "out of"} the album "${albumName}" in ${c.service.name}`,
    serviceName: c.service.name,
    params: {
      op,
      ...(byId ? { albumId: byId.id, name: albumName.slice(0, 120) } : { name, made: true }),
      body: keep.join(","),
    },
    change: {
      summary: `${verb} ${n} ${op === "album-add" ? "to" : "out of"} "${albumName}"`,
      settings: [
        {
          name: `Album "${albumName}"`,
          before: byId ? `${byId.assetCount ?? 0} photos` : "made by the step before",
          after:
            op === "album-add"
              ? `${n} added (the photos themselves are not moved)`
              : `${n} taken out (the photos stay in ${c.service.name})`,
        },
        ...(skipped
          ? [
              {
                name: "Left as they are",
                before: `${skipped} photo${skipped === 1 ? "" : "s"}`,
                after: op === "album-add" ? "already in it" : "not in it",
              },
            ]
          : []),
      ],
    },
  };
}

export async function runAlbum(
  c: { fetchImpl: Fetch; base: string; key: string; service: { name: string } },
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as (typeof ALBUM_OPS)[number];
  const ids = idsOf(p.body);
  const call = <T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown) =>
    immichCall<T>(c.fetchImpl, c.base, c.key, method, path, body);

  if (op === "album-create") {
    const name = String(p.name);
    const albums = await immichAlbums(c.fetchImpl, c.base, c.key);
    // An album with this name appeared after planning (made in Immich, or by this plan run
    // before): nothing is added to it, so this step, and its undo, never touch an album that is
    // not its own.
    if (albums.some((a) => a.albumName.toLowerCase() === name.toLowerCase()))
      return {
        ok: false,
        stale: true,
        result: `${c.service.name} already has an album called "${name}" now; nothing was added. Add the photos to it instead.`,
      };
    const made = await call<{ id?: string }>("POST", "/albums", {
      albumName: name,
      assetIds: ids,
    });
    if (!made.ok || !made.data?.id)
      return { ok: false, result: `${c.service.name} did not make the album (${made.status}).` };
    return verifyIn(c, { id: made.data.id, albumName: name }, ids, `Made the album "${name}"`);
  }

  let albumId = String(p.albumId ?? "");
  if (!albumId) {
    const found = (await immichAlbums(c.fetchImpl, c.base, c.key)).filter(
      (a) => a.albumName.toLowerCase() === String(p.name).toLowerCase(),
    );
    if (found.length !== 1)
      return {
        ok: false,
        stale: true,
        result: `${c.service.name} has ${found.length ? "more than one" : "no"} album called "${p.name}"; nothing was added.`,
      };
    albumId = found[0]!.id;
  }
  if (op === "album-add") {
    const r = await call<{ id?: string; success?: boolean; error?: string }[]>(
      "PUT",
      `/albums/${albumId}/assets`,
      { ids },
    );
    if (!r.ok)
      return { ok: false, result: `${c.service.name} refused to add the photos (${r.status}).` };
    return verifyIn(
      c,
      { id: albumId, albumName: String(p.name ?? "the album") },
      ids,
      "Added the photos",
    );
  }
  const r = await call<unknown>("DELETE", `/albums/${albumId}/assets`, { ids });
  if (!r.ok)
    return { ok: false, result: `${c.service.name} refused to take the photos out (${r.status}).` };
  const now = await albumAssetIds(c.fetchImpl, c.base, c.key, albumId);
  const left = ids.filter((x) => now.has(x)).length;
  return left === 0
    ? {
        ok: true,
        verified: true,
        result: `Took ${ids.length} photos out of the album (read back). The photos stay in ${c.service.name}.`,
      }
    : { ok: false, result: `${left} of the photos are still in the album.` };
}

/** Reads the album back: every photo asked for must be in it. */
async function verifyIn(
  c: { fetchImpl: Fetch; base: string; key: string; service: { name: string } },
  album: { id: string; albumName: string },
  ids: string[],
  what: string,
): Promise<StepOutcome> {
  const now = await albumAssetIds(c.fetchImpl, c.base, c.key, album.id);
  const missing = ids.filter((x) => !now.has(x));
  if (!missing.length)
    return {
      ok: true,
      verified: true,
      result: `${what}: all ${ids.length} photos are in "${album.albumName}" (read back).`,
    };
  return {
    ok: false,
    result: `${what}, but ${missing.length} of ${ids.length} photos are not in "${album.albumName}" (Immich may not have found them, or this key cannot see them).`,
  };
}

/* ---------- Edits ---------- */

/**
 * The edits a flip and rotate state asks for, in Immich's own order: an existing crop first, then
 * mirrors, then the rotation (as Immich's editor sends them).
 */
export function editsFor(
  state: { rotate: number; mirrorH: boolean; mirrorV: boolean },
  keep: Edit[] = [],
): Edit[] {
  const out: Edit[] = keep.filter((e) => e.action === "crop");
  if (state.mirrorH) out.push({ action: "mirror", parameters: { axis: "horizontal" } });
  if (state.mirrorV) out.push({ action: "mirror", parameters: { axis: "vertical" } });
  const angle = ((state.rotate % 360) + 360) % 360;
  if (angle) out.push({ action: "rotate", parameters: { angle } });
  return out;
}

/** The flip and rotate state of a list of edits (the reverse of editsFor). */
export function stateOf(edits: Edit[]): { rotate: number; mirrorH: boolean; mirrorV: boolean } {
  return {
    rotate: edits.find((e) => e.action === "rotate")?.parameters.angle ?? 0,
    mirrorH: edits.some((e) => e.action === "mirror" && e.parameters.axis === "horizontal"),
    mirrorV: edits.some((e) => e.action === "mirror" && e.parameters.axis === "vertical"),
  };
}

const plain = (edits: Edit[]) =>
  JSON.stringify(edits.map(({ action, parameters }) => ({ action, parameters })));

export async function readEdits(
  fetchImpl: Fetch,
  base: string,
  key: string,
  id: string,
): Promise<Edit[] | undefined> {
  const r = await immichCall<{ edits?: (Edit & { id?: string })[] }>(
    fetchImpl,
    base,
    key,
    "GET",
    `/assets/${id}/edits`,
  );
  if (r.status === 404) return undefined;
  if (!r.ok)
    throw new AppUnreachableError(`Immich answered ${r.status} reading the photo's edits.`);
  return (r.data?.edits ?? []).map(({ action, parameters }) => ({ action, parameters }) as Edit);
}

export async function planEdit(
  c: { fetchImpl: Fetch; base: string; key: string; service: { name: string } },
  op: (typeof EDIT_OPS)[number],
  params: StepParams | undefined,
  base: PlannedStep,
): Promise<PlannedStep> {
  const id = String(params?.assetId ?? "").toLowerCase();
  if (!IMMICH_ASSET.test(id)) throw new Error("Say which photo (its Immich id).");
  const a = await immichCall<{
    type?: string;
    originalFileName?: string;
    livePhotoVideoId?: string | null;
    visibility?: string;
    isTrashed?: boolean;
  }>(c.fetchImpl, c.base, c.key, "GET", `/assets/${id}`);
  if (!a.ok || !a.data) throw new Error(`${c.service.name} has no such photo.`);
  if (a.data.type && a.data.type !== "IMAGE")
    throw new Error("Only photos can be flipped or rotated.");
  if (a.data.livePhotoVideoId) throw new Error("Immich does not edit live photos.");
  if (a.data.isTrashed || (a.data.visibility && a.data.visibility !== "timeline"))
    throw new Error("Only photos on the timeline are edited from Hearth.");
  const before = await readEdits(c.fetchImpl, c.base, c.key, id);
  if (!before)
    throw new Error(
      `This ${c.service.name} cannot edit photos (Immich 2.5 or later edits them without changing the original).`,
    );
  const name = a.data.originalFileName ?? "the photo";
  const was = stateOf(before);
  const describe = (s: { rotate: number; mirrorH: boolean; mirrorV: boolean }) =>
    [
      s.mirrorH ? "flipped left to right" : "",
      s.mirrorV ? "flipped top to bottom" : "",
      s.rotate ? `turned ${s.rotate}° clockwise` : "",
    ]
      .filter(Boolean)
      .join(", ") || "as taken";
  if (op === "edit-reset") {
    if (!before.length) throw new Error(`${name} has no edits: it already shows the original.`);
    return {
      ...base,
      label: `Show ${name} as taken again in ${c.service.name} (remove its edits)`,
      serviceName: c.service.name,
      params: { op, assetId: id, name, before: plain(before) },
      change: {
        summary: `Restore ${name}`,
        settings: [{ name, before: describe(was), after: "as taken (the original)" }],
      },
    };
  }
  const want = {
    rotate: Number(params?.rotate ?? 0),
    mirrorH: params?.mirrorH === true || params?.mirrorH === "true",
    mirrorV: params?.mirrorV === true || params?.mirrorV === "true",
  };
  if (![0, 90, 180, 270].includes(((want.rotate % 360) + 360) % 360))
    throw new Error("A photo turns in quarter turns: 0, 90, 180 or 270 degrees.");
  const edits = editsFor(want, before);
  if (plain(edits) === plain(before))
    throw new Error(`Nothing would change: ${name} already looks like this.`);
  const crop = before.some((e) => e.action === "crop");
  return {
    ...base,
    label: `Show ${name} ${describe(want)} in ${c.service.name} (the original file stays as it is)`,
    serviceName: c.service.name,
    params: {
      op,
      assetId: id,
      name,
      rotate: ((want.rotate % 360) + 360) % 360,
      mirrorH: want.mirrorH,
      mirrorV: want.mirrorV,
      before: plain(before),
    },
    change: {
      summary: `Edit ${name}`,
      settings: [
        { name, before: describe(was), after: describe(want) },
        ...(crop ? [{ name: "Its crop in Immich", before: "kept", after: "kept" }] : []),
      ],
    },
  };
}

export async function runEdit(
  c: { fetchImpl: Fetch; base: string; key: string; service: { name: string } },
  p: StepParams,
): Promise<StepOutcome> {
  const id = String(p.assetId);
  const name = String(p.name ?? "the photo");
  const before = await readEdits(c.fetchImpl, c.base, c.key, id);
  if (!before) return { ok: false, result: `${c.service.name} cannot edit photos.` };
  // Someone may have edited it in Immich since: then nothing is changed.
  if (plain(before) !== String(p.before ?? "[]"))
    return {
      ok: false,
      stale: true,
      result: `${name} was edited in ${c.service.name} since this was planned; nothing was changed.`,
    };
  const want =
    String(p.op) === "edit-reset"
      ? []
      : editsFor(
          { rotate: Number(p.rotate), mirrorH: p.mirrorH === true, mirrorV: p.mirrorV === true },
          before,
        );
  const r = want.length
    ? await immichCall<unknown>(c.fetchImpl, c.base, c.key, "PUT", `/assets/${id}/edits`, {
        edits: want,
      })
    : await immichCall<unknown>(c.fetchImpl, c.base, c.key, "DELETE", `/assets/${id}/edits`);
  if (!r.ok) return { ok: false, result: `${c.service.name} refused the edit (${r.status}).` };
  const after = await readEdits(c.fetchImpl, c.base, c.key, id);
  const ok = Boolean(after) && plain(after!) === plain(want);
  return ok
    ? {
        ok: true,
        verified: true,
        result: want.length
          ? `${name} now shows edited (read back). The original file is unchanged: Restore original brings it back.`
          : `${name} shows as taken again (read back).`,
      }
    : {
        ok: false,
        result: `${c.service.name} answered, but ${name}'s edits do not read back as approved.`,
      };
}

/**
 * Undoes an album or edit step, when a later step of the same plan failed: photos it added are
 * taken out again (an album it made, once empty, is removed; the photos stay in Immich), and an
 * edit is put back to the edits the photo had before.
 */
export async function undoOrganize(
  c: { fetchImpl: Fetch; base: string; key: string; service: { name: string } },
  p: StepParams,
): Promise<StepOutcome | undefined> {
  const op = String(p.op);
  if (op === "album-add" || op === "album-create") {
    const ids = idsOf(p.body);
    const albums = await immichAlbums(c.fetchImpl, c.base, c.key);
    const album = p.albumId
      ? albums.find((a) => a.id === String(p.albumId))
      : albums.find((a) => a.albumName.toLowerCase() === String(p.name).toLowerCase());
    if (!album) return { ok: true, result: "The album is not there, so nothing was in it." };
    const r = await immichCall<unknown>(
      c.fetchImpl,
      c.base,
      c.key,
      "DELETE",
      `/albums/${album.id}/assets`,
      { ids },
    );
    if (!r.ok) return { ok: false, result: `${c.service.name} would not take the photos out.` };
    const left = await albumAssetIds(c.fetchImpl, c.base, c.key, album.id);
    if (ids.some((x) => left.has(x)))
      return { ok: false, result: "Some of the photos are still in the album." };
    if (op === "album-create" && left.size === 0) {
      const gone = await immichCall<unknown>(
        c.fetchImpl,
        c.base,
        c.key,
        "DELETE",
        `/albums/${album.id}`,
      );
      return gone.ok
        ? { ok: true, result: `Removed the new album "${album.albumName}" (the photos stay).` }
        : {
            ok: true,
            result: `Took the photos out; the empty album "${album.albumName}" is left.`,
          };
    }
    return { ok: true, result: `Took the ${ids.length} photos out of "${album.albumName}" again.` };
  }
  if (op === "edit" || op === "edit-reset") {
    const id = String(p.assetId);
    const was = JSON.parse(String(p.before ?? "[]")) as Edit[];
    const r = was.length
      ? await immichCall<unknown>(c.fetchImpl, c.base, c.key, "PUT", `/assets/${id}/edits`, {
          edits: was,
        })
      : await immichCall<unknown>(c.fetchImpl, c.base, c.key, "DELETE", `/assets/${id}/edits`);
    return r.ok
      ? { ok: true, result: `${String(p.name ?? "The photo")} shows as it did before.` }
      : { ok: false, result: `${c.service.name} would not put the edit back.` };
  }
  return undefined;
}
