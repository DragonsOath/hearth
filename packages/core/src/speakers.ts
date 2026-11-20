/**
 * Speaker names (11-13, the owner: the speaker picker showed model numbers and IP addresses).
 * A speaker is called what the home already calls it, in this order: the name the owner gave it in
 * Home Assistant, the device's name the owner set there, the name its own system reports (Music
 * Assistant, Sonos, Cast) when that is a real name, then its room ("Kitchen speaker"). The owner
 * can still rename it in Hearth; that name wins everywhere Hearth shows the speaker.
 */

export interface SpeakerFacts {
  entityId: string;
  /** What Home Assistant reports (friendly_name). */
  friendly?: string | null;
  /** The entity's own name, set by the owner in Home Assistant. */
  registryName?: string | null;
  /** The device's name, set by the owner in Home Assistant. */
  deviceNameByUser?: string | null;
  /** The device's name as its integration reports it. */
  deviceName?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  /** The Home Assistant area (room) it is in. */
  area?: string | null;
}

const IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const MAC = /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i;
/** A serial or product code: letters and digits together, no spaces, six or more ("SRS-XB33"). */
const CODE = /^(?=.*\d)[a-z0-9][a-z0-9_-]{4,}$/i;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A name that is really a model number, an address or an id, not something a person would say. */
export function looksLikeMachineName(
  name: string | null | undefined,
  facts: Pick<SpeakerFacts, "model" | "manufacturer" | "entityId"> = { entityId: "" },
): boolean {
  const n = (name ?? "").trim();
  if (!n) return true;
  if (IP.test(n) || MAC.test(n)) return true;
  if (/^media_player\./i.test(n) || /_/.test(n) || CODE.test(n.replace(/\s+/g, ""))) return true;
  const sq = squash(n);
  const model = squash(facts.model ?? "");
  const maker = squash(facts.manufacturer ?? "");
  // Just the model, or the maker and the model ("Sonos Era 100", "Google Nest Mini").
  if (model && (sq === model || sq === maker + model || sq === model + maker)) return true;
  // The entity's own id, spaced out ("media player 2").
  const id = squash(facts.entityId.split(".")[1] ?? "");
  return Boolean(id && sq === id && /\d/.test(sq));
}

const tidy = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** What to call a speaker (before any name the owner gave it in Hearth). */
export function speakerName(f: SpeakerFacts): string {
  const owned = tidy(f.registryName) || tidy(f.deviceNameByUser);
  if (owned) return owned;
  for (const n of [f.friendly, f.deviceName].map(tidy))
    if (n && !looksLikeMachineName(n, f)) return n;
  const area = tidy(f.area);
  if (area) return `${area} speaker`;
  // Nothing better: what it reports, without an address in it.
  const plain = tidy(
    (f.friendly ?? "")
      .replace(IP, "")
      .replace(MAC, "")
      .replace(/[()[\]]/g, ""),
  );
  return plain || tidy(f.entityId.split(".")[1]?.replace(/_/g, " ")) || f.entityId;
}
