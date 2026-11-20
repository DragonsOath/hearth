import type { KomgaDashboard, StepParams } from "@dragon-control/core";
import type { CredentialBroker } from "../credentials/broker";
import type { DbHandle } from "../db/client";
import type { PlannedStep, StepOutcome, StepRun } from "../jobs/operations";
import { recordAudit } from "../store/audit";
import type { Fetch } from "./http";
import { km, KomgaError, komgaDashboard } from "./komga";

/**
 * Changes in Komga, each a plan the owner approves (app-komga-control, params.op): scan a library
 * (or deep scan it, reading every file again), analyze its books again, refresh their metadata,
 * empty its trash (forget books whose files are gone), and analyze one book it could not read.
 * Komga runs these as background tasks: a scan is read back by the book count, the rest report
 * that Komga accepted them. Library settings, users and reading lists stay in Komga.
 */

export const KOMGA_OPS = [
  "scan",
  "deep-scan",
  "analyze",
  "refresh-metadata",
  "empty-trash",
  "analyze-book",
] as const;
export type KomgaOp = (typeof KOMGA_OPS)[number];

type Service = { id: string; name: string; localUrl: string };

export class KomgaOperations {
  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly fetchImpl: Fetch,
  ) {}

  private use<T>(
    service: Service,
    purpose: string,
    access: "read" | "change",
    fn: (key: string) => Promise<T>,
  ): Promise<T> {
    return this.broker.use(
      { serviceId: service.id, purpose, access, destination: service.localUrl },
      ({ value }) => fn(value),
    );
  }

  async plan(
    service: Service,
    params: StepParams | undefined,
    base: PlannedStep,
  ): Promise<PlannedStep> {
    const op = String(params?.op ?? "") as KomgaOp;
    if (!KOMGA_OPS.includes(op)) throw new Error(`Say what to do: ${KOMGA_OPS.join(", ")}.`);
    return this.use(service, "plan a change in Komga", "read", async (key) =>
      planKomga(
        await komgaDashboard(this.fetchImpl, service.localUrl, key),
        service.name,
        op,
        params ?? {},
        base,
      ),
    );
  }

  async run(step: StepRun, service: Service): Promise<StepOutcome> {
    const p = step.params ?? {};
    let out: StepOutcome;
    try {
      out = await this.use(service, "change Komga", "change", (key) =>
        runKomga(this.fetchImpl, service.localUrl, key, p),
      );
    } catch (error) {
      if (!(error instanceof KomgaError)) throw error;
      out = { ok: false, result: error.message };
    }
    await recordAudit(this.handle.db, {
      actor: step.requestedBy,
      action: `${step.change?.summary ?? String(p.op)} in ${service.name}`,
      target: `service:${service.id}`,
      detail: { op: p.op, ok: out.ok, libraryId: p.libraryId ?? null, bookId: p.bookId ?? null },
    });
    return out;
  }

  /** Nothing here changes a setting: scans and clean-ups are not undone. */
  undo(): Promise<StepOutcome | undefined> {
    return Promise.resolve(undefined);
  }
}

const WORDS: Record<Exclude<KomgaOp, "analyze-book">, (lib: string) => string> = {
  scan: (lib) => `Scan the ${lib} library for new and changed books`,
  "deep-scan": (lib) => `Deep scan the ${lib} library (reads every file again; slower)`,
  analyze: (lib) => `Analyze every book in the ${lib} library again (pages, format, size)`,
  "refresh-metadata": (lib) =>
    `Refresh the metadata of every book in the ${lib} library from its files`,
  "empty-trash": (lib) =>
    `Empty the ${lib} library's trash (Komga forgets books whose files are gone, with their reading progress)`,
};

export function planKomga(
  d: KomgaDashboard,
  name: string,
  op: KomgaOp,
  p: StepParams,
  base: PlannedStep,
): PlannedStep {
  const step = (
    label: string,
    setting: { name: string; before: string; after: string },
    extra: StepParams,
  ): PlannedStep => ({
    ...base,
    label,
    serviceName: name,
    params: { op, ...extra },
    change: { summary: label, settings: [setting] },
  });
  if (op === "analyze-book") {
    const b = d.unreadable.find((x) => x.id === String(p.bookId ?? ""));
    if (!b) throw new Error(`${name} has no unreadable book with that id: read the panel again.`);
    return step(
      `Ask ${name} to read "${b.name}" again (after replacing or fixing its file)`,
      { name: b.name, before: "could not be read", after: "analyzed again" },
      { bookId: b.id, name: b.name },
    );
  }
  const lib = d.libraries.find((x) => x.id === String(p.libraryId ?? ""));
  if (!lib) throw new Error(`${name} has no such library: read the panel again.`);
  return step(
    `${WORDS[op](lib.name)} in ${name}`,
    { name: lib.name, before: `${lib.books} books`, after: op.replace("-", " ") },
    {
      libraryId: lib.id,
      name: lib.name,
      books: lib.books,
    },
  );
}

const PATH: Record<Exclude<KomgaOp, "analyze-book">, string> = {
  scan: "scan",
  "deep-scan": "scan?deep=true",
  analyze: "analyze",
  "refresh-metadata": "metadata/refresh",
  "empty-trash": "empty-trash",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runKomga(
  fetchImpl: Fetch,
  base: string,
  key: string,
  p: StepParams,
): Promise<StepOutcome> {
  const op = String(p.op) as KomgaOp;
  if (op === "analyze-book") {
    await km(
      fetchImpl,
      base,
      key,
      "POST",
      `/api/v1/books/${encodeURIComponent(String(p.bookId))}/analyze`,
    );
    return {
      ok: true,
      result: `Komga is reading "${String(p.name)}" again; it shows as fixed once it can open it.`,
    };
  }
  const id = String(p.libraryId);
  const libs = await km<{ id: string }[]>(fetchImpl, base, key, "GET", "/api/v1/libraries");
  if (!libs.some((l) => l.id === id))
    return { ok: false, stale: true, result: `${String(p.name)} is no longer in Komga.` };
  await km(fetchImpl, base, key, "POST", `/api/v1/libraries/${encodeURIComponent(id)}/${PATH[op]}`);
  if (op !== "scan" && op !== "deep-scan")
    return { ok: true, result: `Komga started it for ${String(p.name)}.` };
  // A scan runs in the background: new books show as Komga adds them.
  const before = Number(p.books ?? 0);
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const now =
      (
        await km<{ totalElements?: number }>(
          fetchImpl,
          base,
          key,
          "GET",
          `/api/v1/books?library_id=${encodeURIComponent(id)}&size=1`,
        )
      ).totalElements ?? 0;
    if (now !== before)
      return {
        ok: true,
        verified: true,
        result: `Komga scanned ${String(p.name)}: ${now} books (was ${before}).`,
      };
  }
  return {
    ok: true,
    result: `Komga is scanning ${String(p.name)}; new books show as it finds them.`,
  };
}
