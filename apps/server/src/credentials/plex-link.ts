import { randomUUID } from "node:crypto";
import { DEFAULT_CREDENTIAL_SCOPE } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import { getSetting, setSetting } from "../store/settings";
import { ConflictError, NotFoundError } from "../store/errors";
import { recordAudit } from "../store/audit";
import type { CredentialBroker } from "./broker";

/**
 * Link Plex (feature request 11, guided onboarding): Plex's own sign-in by code.
 * Started only by the owner, right after confirming it is them. Hearth asks
 * plex.tv for a one-time code, the owner approves it on plex.tv, and the token
 * plex.tv then issues is tested once against this Plex server and stored straight
 * into Secure Vault through the broker, read-only scope. The token is never
 * returned to the browser, shown, logged, or given to the AI.
 *
 * What it grants (shown to the owner before starting): the access of the Plex
 * account that approves it. Hearth's Plex reader only reads this server's
 * libraries, sessions, and activity (apps/plex-live.ts).
 */

const PLEX_TV = "https://plex.tv/api/v2";
// Sent to Plex as X-Plex-Product, which names this device in the owner's Plex account. Kept as
// it was when linked: renaming it is part of the separately approved infrastructure rename.
const PRODUCT = "Dragon Control";

type FetchLike = (
  url: string,
  init: { method?: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface Pending {
  pinId: number;
  code: string;
  expiresAt: number;
}

export class PlexLink {
  /** Only codes this server started can be checked, per service. */
  private pending = new Map<string, Pending>();

  constructor(
    private readonly handle: DbHandle,
    private readonly broker: CredentialBroker,
    private readonly service: (
      serviceId: string,
    ) => Promise<{ name: string; localUrl: string | null } | undefined>,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  private async clientId(): Promise<string> {
    let id = await getSetting(this.handle.db, "plex_client_id");
    if (!id) {
      id = `dragon-control-${randomUUID()}`;
      await setSetting(this.handle.db, "plex_client_id", id);
    }
    return id;
  }

  private async headers() {
    return {
      Accept: "application/json",
      "X-Plex-Product": PRODUCT,
      "X-Plex-Client-Identifier": await this.clientId(),
    };
  }

  async start(
    serviceId: string,
  ): Promise<{ pinId: number; code: string; authUrl: string; expiresAt: string }> {
    const svc = await this.service(serviceId);
    if (!svc) throw new NotFoundError("Not a watched Plex.");
    const res = await this.fetchImpl(`${PLEX_TV}/pins?strong=true`, {
      method: "POST",
      headers: await this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ConflictError(`plex.tv answered ${res.status}; nothing was linked.`);
    const pin = (await res.json()) as { id?: number; code?: string; expiresAt?: string };
    if (!pin.id || !pin.code)
      throw new ConflictError("plex.tv did not return a code; nothing was linked.");
    const expiresAt = pin.expiresAt ? Date.parse(pin.expiresAt) : Date.now() + 15 * 60_000;
    this.pending.set(serviceId, { pinId: pin.id, code: pin.code, expiresAt });
    await recordAudit(this.handle.db, {
      actor: "you",
      action: `Started linking Plex for ${svc.name} (approval on plex.tv)`,
      target: `service:${serviceId}`,
    });
    const clientID = encodeURIComponent(await this.clientId());
    return {
      pinId: pin.id,
      code: pin.code,
      authUrl: `https://app.plex.tv/auth#?clientID=${clientID}&code=${encodeURIComponent(pin.code)}&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Waiting, linked (token tested and stored), or expired. Never returns the token. */
  async check(
    serviceId: string,
    pinId: number,
  ): Promise<{ state: "waiting" | "linked" | "expired"; message?: string }> {
    const p = this.pending.get(serviceId);
    if (!p || p.pinId !== pinId)
      throw new NotFoundError("No Plex link in progress for this service.");
    if (Date.now() > p.expiresAt) {
      this.pending.delete(serviceId);
      return { state: "expired", message: "The code expired before it was approved. Start again." };
    }
    const res = await this.fetchImpl(`${PLEX_TV}/pins/${pinId}`, {
      headers: { ...(await this.headers()), "X-Plex-Code": p.code },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { state: "waiting" };
    const pin = (await res.json()) as { authToken?: string | null };
    if (!pin.authToken) return { state: "waiting" };
    const token = pin.authToken;
    this.pending.delete(serviceId);
    const svc = await this.service(serviceId);
    if (!svc?.localUrl)
      throw new ConflictError("Hearth does not know this Plex's address; nothing was stored.");
    // Tested once against this server before it is kept.
    const test = await this.fetchImpl(`${svc.localUrl.replace(/\/+$/, "")}/library/sections`, {
      headers: { Accept: "application/json", "X-Plex-Token": token },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    if (!test?.ok) {
      return {
        state: "expired",
        message: `plex.tv approved it, but this Plex server did not accept the token (${test ? test.status : "no answer"}): the approving account may not have access to it. Nothing was stored.`,
      };
    }
    await this.broker.storeGenerated({
      serviceId,
      kind: "api-key",
      value: token,
      workflow: "Plex linked by the owner on plex.tv",
      scope: DEFAULT_CREDENTIAL_SCOPE,
    });
    return { state: "linked" };
  }
}
