import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { PanelContribution } from "@dragon-control/core";
import type { Fetch } from "../apps/http";
import { ConflictError } from "../store/errors";
import { signReceipt, specHash, type IntakeKeys } from "./receipt";

/**
 * The panel submission service (services/panel-intake), as Hearth talks to it. It accepts a
 * contribution durably and answers at once with a signed receipt; its pull request is filed
 * afterwards, so a GitHub outage never blocks or loses a submission. Only the published file goes,
 * never a key, address or anything a panel read.
 */
/** Who the donor wants credited (both optional; a GitHub name makes them the co-author). */
export interface DonationCredit {
  name?: string;
  github?: string;
}

export interface PanelIntake {
  /**
   * A donation (Premium): the panel file, this Hearth's licence that includes Panel Builder (the
   * service checks it), and who to credit.
   */
  submit(
    file: PanelContribution,
    from: { licence?: string; credit?: DonationCredit },
  ): Promise<{ receipt: string; id: string }>;
  /** Whether its pull request is filed yet (and where). */
  status(id: string): Promise<{ status: "queued" | "filed" | "held"; url?: string }>;
  /** When the service's GitHub token expires, as GitHub reports it (the owner's 14-day warning). */
  health(): Promise<{ tokenExpiresAt?: string; tokenWorks?: boolean }>;
}

/** Said to the owner as it is (a 409): nothing was unlocked. */
export class IntakeError extends ConflictError {}

export function httpIntake(
  base: string,
  fetchImpl: Fetch = fetch as unknown as Fetch,
): PanelIntake {
  const root = base.replace(/\/$/, "");
  return {
    async submit(file, from) {
      const res = await fetchImpl(`${root}/v1/panels`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          panel: file,
          ...(from.licence ? { licence: from.licence } : {}),
          ...(from.credit?.name || from.credit?.github ? { credit: from.credit } : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      }).catch((e: unknown) => {
        throw new IntakeError(
          `The submission service could not be reached (${e instanceof Error ? e.message : String(e)}). Nothing was sent or unlocked; try again later.`,
        );
      });
      const body = (await res.json().catch(() => null)) as {
        receipt?: string;
        id?: string;
        error?: string;
      } | null;
      if (!res.ok || typeof body?.receipt !== "string" || typeof body.id !== "string")
        throw new IntakeError(
          body?.error
            ? `The submission service did not accept it: ${String(body.error).slice(0, 400)}`
            : `The submission service answered ${res.status}. Nothing was unlocked; try again later.`,
        );
      return { receipt: body.receipt.slice(0, 2000), id: body.id.slice(0, 80) };
    },
    async status(id) {
      const res = await fetchImpl(`${root}/v1/panels/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json().catch(() => null)) as { status?: string; url?: string } | null;
      const status = body?.status === "filed" || body?.status === "held" ? body.status : "queued";
      const url =
        typeof body?.url === "string" &&
        /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(body.url)
          ? body.url
          : undefined;
      return { status, ...(url ? { url } : {}) };
    },
    async health() {
      const res = await fetchImpl(`${root}/v1/status`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json().catch(() => null)) as {
        tokenExpiresAt?: unknown;
        tokenWorks?: unknown;
      } | null;
      const at = typeof body?.tokenExpiresAt === "string" ? body.tokenExpiresAt : undefined;
      return {
        ...(at && !Number.isNaN(Date.parse(at)) ? { tokenExpiresAt: at } : {}),
        ...(typeof body?.tokenWorks === "boolean" ? { tokenWorks: body.tokenWorks } : {}),
      };
    },
  };
}

/**
 * Tests only (DC_FAKE_APPS): a stand-in service that signs real receipts with its own test key.
 * It can be told to be down, to never file its pull request (GitHub down), or to answer with a
 * receipt Hearth must refuse (signed by another key, or for another panel).
 */
export function fakeIntake() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
  const keys: IntakeKeys = { [raw.slice(0, 12)]: raw };
  const stranger = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
  const received: PanelContribution[] = [];
  /** What came with each donation (the licence and the credit), in order. */
  const sentWith: { licence?: string; credit?: DonationCredit }[] = [];
  const filed = new Map<string, string>();
  let tokenExpiresAt: string | undefined;
  let mode: "ok" | "down" | "github-down" | "forged" | "wrong-panel" = "ok";
  // Browser tests run side by side: "down" for one panel id only.
  const downFor = new Set<string>();
  const intake: PanelIntake = {
    async submit(file, from) {
      if (mode === "down" || downFor.has(file.spec.id))
        throw new IntakeError(
          "The submission service answered 503. Nothing was unlocked; try again later.",
        );
      received.push(file);
      sentWith.push(from);
      const id = randomBytes(8).toString("hex");
      const hash = mode === "wrong-panel" ? "0".repeat(64) : specHash(file.spec);
      const receipt = signReceipt(
        { id, specHash: hash, at: new Date().toISOString() },
        mode === "forged" ? stranger : pem,
      );
      if (mode !== "github-down")
        filed.set(id, `https://github.com/DragonsOath/hearth/pull/${900 + received.length}`);
      return { receipt, id };
    },
    async status(id) {
      const url = filed.get(id);
      return url ? { status: "filed", url } : { status: "queued" };
    },
    async health() {
      return tokenExpiresAt ? { tokenExpiresAt, tokenWorks: true } : {};
    },
  };
  return {
    intake,
    keys,
    received,
    sentWith,
    /** When the stand-in says its GitHub token expires. */
    tokenExpires: (at: string | undefined) => {
      tokenExpiresAt = at;
    },
    /** A receipt for a spec, as the real service would sign it (shared-file tests). */
    receiptFor: (spec: PanelContribution["spec"]) =>
      signReceipt(
        {
          id: randomBytes(8).toString("hex"),
          specHash: specHash(spec),
          at: new Date().toISOString(),
        },
        pem,
      ),
    mode: (m: "ok" | "down" | "github-down" | "forged" | "wrong-panel") => {
      mode = m;
    },
    down: (specId: string, on: boolean) => {
      if (on) downFor.add(specId);
      else downFor.delete(specId);
    },
  };
}
