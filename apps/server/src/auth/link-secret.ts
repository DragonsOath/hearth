import { APP_INTEGRATIONS, appKindOf } from "@dragon-control/core";
import type { DbHandle } from "../db/client";
import * as t from "../db/schema";
import { CATALOG } from "../discovery/catalog";
import { addManualService } from "../store/systems";

/** Which app a saved key went to: one Hearth knew, or one it added from the key's address. */
export interface SecretLink {
  serviceId: string;
  name: string;
  added: boolean;
}

/** host:port of an address, with the scheme's own port when none is typed ("emby:8096"). */
function hostPort(raw: string | null | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return undefined;
  }
}

/**
 * The app a new key belongs to when "Belongs to" was left empty (11-11: an Emby key saved in the
 * Secure Vault did nothing until a rescan). By its address first, then by its name ("Emby API
 * key"); when Hearth does not know that app yet but the key says where it is, the app is added
 * the same way Add a system does, so its panel works straight away. Nothing outside Hearth changes.
 */
export async function linkSecret(
  handle: DbHandle,
  input: { name: string; endpoint?: string | null },
  afterAdd: (serviceId: string) => Promise<void>,
): Promise<SecretLink | undefined> {
  const services = (await handle.db.select().from(t.services)).filter(
    (s) => s.lifecycle !== "removed",
  );
  const at = hostPort(input.endpoint);
  if (at) {
    const same = services.find((s) => hostPort(s.localUrl) === at);
    if (same) return { serviceId: same.id, name: same.name, added: false };
  }
  const kind = appKindOf({ name: input.name });
  if (!kind) return undefined;
  const known = services.filter(
    (s) => appKindOf({ name: s.name, image: s.image ?? undefined }) === kind,
  );
  // One of that app: it is that one. Several (a 4K Radarr and a normal one): only the address can say.
  if (known.length === 1) return { serviceId: known[0]!.id, name: known[0]!.name, added: false };
  if (known.length > 1 || !at) return undefined;
  const name = APP_INTEGRATIONS[kind].name;
  const added = await addManualService(handle, {
    name,
    kind: "web",
    address: input.endpoint!.trim(),
    category: CATALOG.find((c) => c.id === kind)?.category ?? "System",
  }).catch(() => undefined);
  if (!added) return undefined;
  await afterAdd(added.id).catch(() => undefined);
  return { serviceId: added.id, name: added.name, added: true };
}
