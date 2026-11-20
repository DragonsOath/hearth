import type { PanelBlock, PanelSpec } from "./panel-spec";

/**
 * Contributing a custom panel to the Hearth project (Ember Panel Builder, 11-10 review).
 *
 * - The published file is built here, deterministically, from the panel spec alone: the same code
 *   makes the preview the owner approves, the file Hearth sends, and the file the submission
 *   service commits. Nothing from the install (its name for the app, addresses, keys, the data a
 *   panel showed) is in it.
 * - contributionProblems() is the same check on both sides. It is a backstop, not the privacy
 *   guarantee: the guarantee is that a spec cannot hold data (validatePanelSpec), and that the owner
 *   reviews every published text before an explicit approval.
 * - panelChange() decides, by fixed rules and never by Ember, whether a new version is a minor
 *   adjustment of a panel the owner may already use (free) or new reusable functionality (on Free,
 *   it follows the contribution workflow).
 */

/** Stable JSON: object keys sorted at every level, so equal panels give equal text and hashes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/**
 * A container image as published: its repository path only. A private registry's host
 * ("registry.home.lan:5000/zm"), the tag and the digest are dropped.
 */
export function canonicalImage(image: string | null | undefined): string | undefined {
  if (!image) return undefined;
  let s = image.trim().replace(/@sha256:[a-f0-9]+$/i, "");
  const parts = s.split("/");
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) parts.shift();
  s = parts.join("/").replace(/:[^/]*$/, "");
  return /^[a-z0-9][a-z0-9._/-]{0,120}$/.test(s) ? s : undefined;
}

/** The app part of a panel id ("community.zoneminder.cameras" gives "zoneminder"). */
export const appSlugOf = (spec: Pick<PanelSpec, "id">) => spec.id.split(".")[1] ?? "app";

/** What a contribution publishes: the design only. */
export interface PanelContribution {
  format: "hearth-panel";
  formatVersion: 1;
  app: { name: string; image?: string };
  spec: Omit<PanelSpec, "serviceId"> & { serviceId: "" };
  readme: string;
  /** The contribution agreement accepted (absent on a plain saved copy). */
  terms?: { version: number; acceptedAt: string };
}

/** The short description, generated from the spec (never free text from the install). */
export function panelReadme(spec: PanelSpec | PanelContribution["spec"]): string {
  const kinds = [...new Set(spec.blocks.map((b) => b.kind))].join(", ");
  return [
    `${spec.title}: a custom panel for ${appSlugOf(spec)}, made with Ember Panel Builder.`,
    `Blocks: ${spec.blocks.length} (${kinds}).`,
    `Reads (GET, every ${spec.refreshSeconds} s): ${spec.reads.map((r) => r.path.split("?")[0]).join(", ")}.`,
    ...(spec.auth ? [`Key sent as: ${spec.auth}.`] : []),
    ...spec.blocks
      .filter((b): b is Extract<PanelBlock, { kind: "button" }> => b.kind === "button")
      .map((b) => `Button "${b.label}": proposes a plan the owner approves.`),
  ].join("\n");
}

/** The exact file a contribution publishes. */
export function contributionFile(
  spec: PanelSpec,
  image: string | null | undefined,
  terms?: { version: number; acceptedAt: string },
): PanelContribution {
  const img = canonicalImage(image);
  const { serviceId: _drop, ...rest } = spec;
  const clean = { ...rest, serviceId: "" as const };
  return {
    format: "hearth-panel",
    formatVersion: 1,
    app: { name: appSlugOf(spec), ...(img ? { image: img } : {}) },
    spec: clean,
    readme: panelReadme(clean),
    ...(terms ? { terms: { version: terms.version, acceptedAt: terms.acceptedAt } } : {}),
  };
}

/** Every piece of text a contribution publishes, with where it is (shown in the preview). */
export function publishedTexts(c: Pick<PanelContribution, "app" | "spec">): {
  where: string;
  text: string;
}[] {
  const out: { where: string; text: string }[] = [];
  const add = (where: string, text: unknown) => {
    if (typeof text === "string" && text !== "") out.push({ where, text });
  };
  add("App", c.app.name);
  add("Container image", c.app.image);
  add("Panel id", c.spec.id);
  add("Panel title", c.spec.title);
  add("Key sent as", c.spec.auth);
  for (const r of c.spec.reads) add(`Read "${r.id}"`, r.path);
  for (const b of c.spec.blocks) {
    const at = `Block "${b.id}" (${b.kind})`;
    for (const [k, v] of Object.entries(b)) {
      if (k === "id" || k === "kind" || k === "read") continue;
      if (typeof v === "string") add(`${at} ${k}`, v);
      else if (Array.isArray(v))
        v.forEach((x, i) => {
          if (typeof x === "string") add(`${at} ${k} ${i + 1}`, x);
          else if (x && typeof x === "object")
            for (const [ck, cv] of Object.entries(x)) add(`${at} ${k} ${i + 1} ${ck}`, cv);
        });
    }
  }
  return out;
}

const RULES: [RegExp, string][] = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "an IP address"],
  [/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){4,7}\b/i, "an IPv6 address"],
  [/\b[a-z][a-z0-9+.-]*:\/\//i, "a web address"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, "an email address"],
  [
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lan|local|home|internal|localdomain|arpa|corp|intranet|ts\.net)\b/i,
    "a local network name",
  ],
  [
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|net|org|io|dev|app|me|co|uk|de|nl|fr|ca|au|us|xyz|cloud|site|online|tech|duckdns\.org)\b/i,
    "a domain name",
  ],
  [/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i, "a hardware (MAC) address"],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    "an id from your setup (a UUID)",
  ],
  [
    /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/,
    "what looks like a key or token",
  ],
  [/\b[0-9a-f]{16,}\b/i, "what looks like a key, token or id"],
  [/\+?\d[\d ().-]{8,}\d/, "a phone number or long number"],
  [
    /[?&](?:api_?key|apikey|token|access_token|auth|key|password|passwd|pass|secret|sig|signature|session|sid)=/i,
    "a key or password in a path",
  ],
  [
    /"(?:api_?key|apikey|token|password|passwd|secret|authorization|cookie)"\s*:/i,
    "a key or password in a button's body",
  ],
  [/[@#]/, "@ or # (on GitHub these mention people or link issues)"],
  [/`/, "a backtick"],
];

/**
 * Deterministic privacy and safety checks on everything a contribution publishes. Each problem
 * names where it is, so the owner (or Ember) can fix it. A backstop only: the owner's review of
 * the full preview is what decides.
 */
export function contributionProblems(c: Pick<PanelContribution, "app" | "spec">): {
  where: string;
  problem: string;
}[] {
  const out: { where: string; problem: string }[] = [];
  for (const { where, text } of publishedTexts(c)) {
    // A read path may hold @ in neither form; other rules apply to every text.
    const hit = RULES.find(([re]) => re.test(text));
    if (hit) out.push({ where, problem: `holds ${hit[1]}` });
    else if (/^\/.*\/(\d{5,})(?:[/?]|$)/.test(text))
      out.push({ where, problem: "holds a long number that may be an id from your setup" });
  }
  return out;
}

/* ---------------- Minor or substantial (the Free plan's rule) ---------------- */

type Sig = string;

/** What a block does, apart from its words: the data it reads and how. */
function signature(b: PanelBlock, spec: Pick<PanelSpec, "reads">): Sig {
  const path = "read" in b ? (spec.reads.find((r) => r.id === b.read)?.path ?? "?") : "";
  switch (b.kind) {
    case "heading":
      return "heading";
    case "stat":
      return `stat|${path}|${b.field}`;
    case "status-list":
      return `status-list|${path}|${b.items ?? ""}|${b.name}|${b.state}`;
    case "table":
      return `table|${path}|${b.items ?? ""}`;
    case "image-grid":
      return `image-grid|${path}|${b.items ?? ""}|${b.image}|${b.caption ?? ""}`;
    case "timeline":
      return `timeline|${path}|${b.items ?? ""}|${b.at}|${b.text}`;
    case "chart":
      return `chart|${path}|${b.items ?? ""}|${b.x}|${b.y}`;
    case "link":
      return `link|${b.path}`;
    case "button":
      return `button|${b.method}|${b.path}|${b.body ?? ""}`;
  }
}

export type PanelChange = "same" | "minor" | "substantial";

/**
 * How a new version differs from a panel the owner may already use. Minor: the same data, read
 * the same way, with changes only to wording, order, refresh, colours of states, chart style,
 * fewer blocks or fewer table columns. Substantial: anything that reads something new, reads it
 * differently, sends its key differently, or adds a block or button the base does not have.
 */
export function panelChange(
  base: PanelSpec,
  next: PanelSpec,
): { change: PanelChange; reasons: string[] } {
  const strip = (s: PanelSpec) => canonicalJson({ ...s, serviceId: "" });
  if (strip(base) === strip(next)) return { change: "same", reasons: [] };
  const reasons: string[] = [];
  if ((base.auth ?? "") !== (next.auth ?? "")) reasons.push("it sends the app's key differently");
  for (const b of next.blocks) {
    const sig = signature(b, next);
    const match = base.blocks.filter((x) => signature(x, base) === sig);
    if (!match.length) {
      reasons.push(`block "${b.id}" (${b.kind}) is new, or reads differently`);
      continue;
    }
    if (b.kind === "table") {
      const fields = new Set(
        match.flatMap((x) => (x.kind === "table" ? x.columns.map((c) => c.field) : [])),
      );
      const extra = b.columns.filter((c) => !fields.has(c.field)).map((c) => c.field);
      if (extra.length) reasons.push(`table "${b.id}" shows new columns (${extra.join(", ")})`);
    }
  }
  return { change: reasons.length ? "substantial" : "minor", reasons };
}

/* ---------------- Receipts: proof a contribution was accepted ---------------- */

/**
 * The submission service signs a receipt for each contribution it accepts (Ed25519, like Hearth's
 * licences). It binds the receipt to the exact published spec by its hash, so:
 * - Hearth unlocks a Free panel only on a genuine receipt for that very spec (a stand-in service
 *   or an edited answer does not unlock anything);
 * - a shared panel file counts as shared only when it carries a receipt that matches its spec. A
 *   panel someone saved without submitting it carries none, so loading it back skips nothing.
 */
export const RECEIPT_PREFIX = "HEARTHR1";

export interface PanelReceiptPayload {
  v: 1;
  /** The submission's id. */
  id: string;
  /** sha-256 (hex) of canonicalJson(the published spec, serviceId ""). */
  specHash: string;
  /** When the service accepted it. */
  at: string;
  /** Which service key signed it. */
  key: string;
}

/** The published spec's canonical text, the input of its hash (both sides hash this). */
export const specHashInput = (spec: PanelSpec | PanelContribution["spec"]) =>
  canonicalJson({ ...spec, serviceId: "" });

/** A shared panel file: the contribution plus the receipt that proves it was accepted. */
export interface SharedPanelFile extends PanelContribution {
  accepted?: string;
}

/**
 * A loaded panel file, for this app: its spec with this install's service id and the receipt it
 * carries (checked by the server), or why it cannot be used.
 */
export function readPanelFile(
  raw: unknown,
  serviceId: string,
): { spec: PanelSpec; receipt?: string } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { error: "This is not a Hearth panel file." };
  const f = raw as Partial<SharedPanelFile>;
  if (f.format !== "hearth-panel") return { error: "This is not a Hearth panel file." };
  if (f.formatVersion !== 1)
    return { error: "This panel file is from a newer Hearth. Update Hearth to load it." };
  if (!f.spec || typeof f.spec !== "object") return { error: "The panel file has no panel in it." };
  return {
    spec: { ...(f.spec as PanelSpec), serviceId },
    ...(typeof f.accepted === "string" && f.accepted.length < 2000 ? { receipt: f.accepted } : {}),
  };
}
