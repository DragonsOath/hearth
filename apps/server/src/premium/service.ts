import { createPrivateKey, randomUUID, sign } from "node:crypto";

/**
 * Hearth's licence service (services/hearth-licence, docs/design/PREMIUM.md "Licence service"):
 * redeems promo codes for any installation and says which licences were taken back. Requests
 * that change anything come only from the owner's Hearth, signed with the owner's licence key.
 */

/** Where Hearth's own licence service runs. DC_LICENCE_SERVICE overrides it ("off": none). */
export const DEFAULT_LICENCE_SERVICE = "https://licence.dragonsoath.com";

export class LicenceServiceError extends Error {}

export interface ServiceCode {
  id: string;
  hash: string;
  features: string[];
  maxUses: number;
  days?: number;
  redeemBy?: string;
  label?: string;
  active: boolean;
}

export class LicenceService {
  constructor(
    readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url.replace(/\/+$/, "")}${path}`, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new LicenceServiceError(
        "Hearth's licence service can't be reached right now. Check this computer's internet connection and try again in a minute.",
      );
    }
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok)
      throw new LicenceServiceError(
        body.error ?? `Hearth's licence service answered ${res.status}. Try again in a minute.`,
      );
    return body;
  }

  /** Redeems a code for this installation: the licence comes back signed by the service. */
  redeem(
    code: string,
    install: string,
  ): Promise<{ licence: string; licenceId: string; gifted?: boolean }> {
    return this.call("/v1/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, install }),
    });
  }

  /** The licences taken back, anywhere. */
  async revoked(): Promise<string[]> {
    return (await this.call<{ revoked: string[] }>("/v1/revoked")).revoked;
  }

  /** How many times a code was used (counted by the service). */
  codeUses(id: string): Promise<{ uses: number; maxUses: number; active: boolean }> {
    return this.call(`/v1/codes/${encodeURIComponent(id)}`);
  }

  /** A change from the owner's Hearth, signed with the owner's licence key (PKCS#8 PEM). */
  owner(privatePem: string, body: Record<string, unknown>): Promise<unknown> {
    const text = JSON.stringify({
      at: new Date(this.clock()).toISOString(),
      nonce: randomUUID(),
      ...body,
    });
    const sig = sign(
      null,
      Buffer.from(`hearth-licence-owner:${text}`),
      createPrivateKey(privatePem),
    ).toString("base64url");
    return this.call("/v1/owner", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hearth-signature": sig },
      body: text,
    });
  }
}
