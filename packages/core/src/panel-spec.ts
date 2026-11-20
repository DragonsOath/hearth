/**
 * Custom panels (Ember Panel Builder, Phase 2, 11-10): a panel is a checked description, never
 * code. Ember writes which of Hearth's own blocks to show and which GET reads of that app's own API
 * feed them; Hearth validates it here, runs the reads through the key broker, and draws it with its
 * own components. The validator, not Ember's prompt, is what keeps a panel inside its limits.
 */

export const PANEL_SPEC_VERSION = 1;

export const PANEL_LIMITS = {
  reads: 12,
  blocks: 24,
  minRefresh: 15,
  maxRefresh: 3600,
  text: 120,
  path: 500,
  field: 120,
  columns: 8,
  items: 50,
  body: 4000,
  /** A read's answer larger than this is refused. */
  answerBytes: 1_000_000,
  /** A code panel's own page (HTML, its styles and script). */
  code: 200_000,
  actions: 12,
} as const;

export interface PanelRead {
  /** Short id the blocks name ("monitors"). */
  id: string;
  /**
   * A GET path on the app, from "/": "/api/monitors.json". In a code panel it may hold {name}
   * placeholders ("/api/v1/movie/{id}"): read on demand with the panel's values filled in.
   */
  path: string;
}

/**
 * A change a code panel may ask for (11-18, the owner: a Request button): a fixed method and a
 * path template on the same app. Each use is a plan the owner approves, with the exact request.
 */
export interface PanelAction {
  id: string;
  label: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** What it does, in plain words: shown in the plan the owner approves. */
  why: string;
}

/** Where a block's values come from: a read, and where in its answer. */
interface FromRead {
  read: string;
}
/** A list inside a read's answer ("monitors", "data.events"); empty means the answer itself. */
interface ListBlock extends FromRead {
  items?: string;
  title?: string;
}

export type PanelBlock =
  | { kind: "heading"; id: string; text: string }
  | (FromRead & { kind: "stat"; id: string; label: string; field: string; unit?: string })
  | (ListBlock & {
      kind: "status-list";
      id: string;
      name: string;
      state: string;
      /** States shown as good or bad (case-insensitive); others are neutral. */
      good?: string[];
      bad?: string[];
    })
  | (ListBlock & {
      kind: "table";
      id: string;
      columns: { label: string; field: string; format?: "text" | "number" | "bytes" | "date" }[];
      /**
       * A field holding each row's movie-database poster file ("/abc123.jpg", as Seerr, Tasterr,
       * Radarr and Sonarr give it). The list then shows as cover art, fetched by Hearth.
       */
      poster?: string;
    })
  | (ListBlock & {
      kind: "image-grid";
      id: string;
      /** A GET path on the same app, with {field} filled from each item: "/snap?id={Id}". */
      image: string;
      caption?: string;
    })
  | (ListBlock & { kind: "timeline"; id: string; at: string; text: string })
  | (ListBlock & { kind: "chart"; id: string; x: string; y: string; style: "line" | "bar" })
  | { kind: "link"; id: string; label: string; path: string }
  | {
      kind: "button";
      id: string;
      label: string;
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: string;
      /** What it does, in plain words: shown in the plan the owner approves. */
      why: string;
    };

export type PanelBlockKind = PanelBlock["kind"];
export const PANEL_BLOCK_KINDS: PanelBlockKind[] = [
  "heading",
  "stat",
  "status-list",
  "table",
  "image-grid",
  "timeline",
  "chart",
  "link",
  "button",
];

export interface PanelSpec {
  specVersion: number;
  /** "community.<app>.<name>": stable across versions. */
  id: string;
  title: string;
  /** The app's service id in Hearth: a panel reads only its own app. */
  serviceId: string;
  /** For an app Hearth has no reader for: how its vault key is sent ("header:X-Api-Key"...). */
  auth?: string;
  refreshSeconds: number;
  reads: PanelRead[];
  blocks: PanelBlock[];
  /**
   * A code panel (11-18, the owner: "like vibe coding"): Ember's own page (HTML with its styles and
   * script), drawn in a sealed frame with no network, no Hearth session and no keys. It gets this
   * panel's reads, pictures, its actions (each a plan the owner approves), links and trailers only
   * through Hearth's bridge (window.hearth). With code, blocks may be empty.
   */
  code?: string;
  actions?: PanelAction[];
}

/** Whether a read is a template, read on demand (a code panel's "/api/v1/movie/{id}"). */
export const isTemplateRead = (path: string) => /\{[A-Za-z_][\w]*\}/.test(path);

/**
 * A read or action path with a code panel's values filled in: each {name} becomes that value,
 * URL-encoded, so a value can never add a segment, another address or a query of its own.
 */
export function fillPanelPath(template: string, values: Record<string, unknown>): string {
  const out = template.replace(/\{([A-Za-z_][\w]*)\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined || v === null || typeof v === "object")
      throw new Error(`The panel did not give a value for {${k}}.`);
    return encodeURIComponent(String(v));
  });
  const p = panelPathProblem(out);
  if (p) throw new Error(`That path ${p}.`);
  return out;
}

export interface PanelIssue {
  /** Where: "spec", "read:<id>" or "block:<id>". */
  at: string;
  message: string;
}

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const SPEC_ID = /^community\.[a-z0-9][a-z0-9-]{0,39}\.[a-z0-9][a-z0-9-]{0,39}$/;
const SEGMENT = /^[A-Za-z0-9_$@-]{1,60}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** A field path: dot-separated names or indexes ("Monitor.Name", "data.0.id"). Never code. */
export function fieldProblem(path: string): string | undefined {
  if (typeof path !== "string" || !path) return "is empty";
  if (path.length > PANEL_LIMITS.field) return "is too long";
  for (const seg of path.split("."))
    if (!SEGMENT.test(seg) || FORBIDDEN.has(seg))
      return `"${path}" is not a field path (names and numbers joined by dots)`;
  return undefined;
}

/** A GET path on the app: from "/", no other host, no going up a folder. */
export function panelPathProblem(path: string): string | undefined {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
    return "must start with a single /";
  if (path.length > PANEL_LIMITS.path) return "is too long";
  if (/[\s\\]|:\/\/|@|\.\./.test(path) || [...path].some((c) => c.charCodeAt(0) < 32))
    return "may not hold spaces, backslashes, another address, @ or ..";
  return undefined;
}

/** Plain words only: no markup, no scripts. */
function textProblem(s: unknown, max: number = PANEL_LIMITS.text): string | undefined {
  if (typeof s !== "string" || !s.trim()) return "is empty";
  if (s.length > max) return `is longer than ${max} characters`;
  if (/[<>]|javascript:/i.test(s)) return "must be plain words (no markup)";
  return undefined;
}

const ALLOWED_KEYS: Record<PanelBlockKind, string[]> = {
  heading: ["text"],
  stat: ["read", "label", "field", "unit"],
  "status-list": ["read", "items", "title", "name", "state", "good", "bad"],
  table: ["read", "items", "title", "columns", "poster"],
  "image-grid": ["read", "items", "title", "image", "caption"],
  timeline: ["read", "items", "title", "at", "text"],
  chart: ["read", "items", "title", "x", "y", "style"],
  link: ["label", "path"],
  button: ["label", "method", "path", "body", "why"],
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check a spec. Returns every problem in plain words, each pointing at where it is; an empty list
 * means it may be previewed and installed. `serviceId` is the app it must be for.
 */
export function validatePanelSpec(raw: unknown, serviceId?: string): PanelIssue[] {
  const issues: PanelIssue[] = [];
  const add = (at: string, message: string) => issues.push({ at, message });
  if (!isObj(raw)) return [{ at: "spec", message: "A panel spec is a JSON object." }];
  const s = raw;
  for (const k of Object.keys(s))
    if (
      ![
        "specVersion",
        "id",
        "title",
        "serviceId",
        "auth",
        "refreshSeconds",
        "reads",
        "blocks",
        "code",
        "actions",
      ].includes(k)
    )
      add("spec", `Unknown field "${k}".`);
  if (s.specVersion !== PANEL_SPEC_VERSION)
    add("spec", `specVersion must be ${PANEL_SPEC_VERSION}.`);
  if (typeof s.id !== "string" || !SPEC_ID.test(s.id))
    add("spec", 'id must look like "community.<app>.<name>" (lowercase, dashes).');
  const tp = textProblem(s.title, 80);
  if (tp) add("spec", `title ${tp}.`);
  if (typeof s.serviceId !== "string" || !s.serviceId)
    add("spec", "serviceId must name the app's service.");
  else if (serviceId && s.serviceId !== serviceId)
    add("spec", "A panel reads only its own app: serviceId must be this app's.");
  if (s.auth !== undefined && (typeof s.auth !== "string" || s.auth.length > 80))
    add("spec", "auth must be a short text such as header:X-Api-Key.");
  if (
    typeof s.refreshSeconds !== "number" ||
    !Number.isInteger(s.refreshSeconds) ||
    s.refreshSeconds < PANEL_LIMITS.minRefresh ||
    s.refreshSeconds > PANEL_LIMITS.maxRefresh
  )
    add(
      "spec",
      `refreshSeconds must be a whole number from ${PANEL_LIMITS.minRefresh} to ${PANEL_LIMITS.maxRefresh}.`,
    );

  const readIds = new Set<string>();
  if (!Array.isArray(s.reads) || s.reads.length === 0)
    add("spec", "reads must list at least one read.");
  else {
    if (s.reads.length > PANEL_LIMITS.reads)
      add("spec", `At most ${PANEL_LIMITS.reads} reads per panel.`);
    for (const r of s.reads) {
      if (!isObj(r) || typeof r.id !== "string" || !ID.test(r.id)) {
        add("spec", "Each read needs an id: lowercase letters, numbers and dashes.");
        continue;
      }
      const at = `read:${r.id}`;
      if (readIds.has(r.id)) add(at, "Two reads have this id.");
      readIds.add(r.id);
      for (const k of Object.keys(r))
        if (k !== "id" && k !== "path") add(at, `Unknown field "${k}".`);
      const pp = panelPathProblem(
        typeof r.path === "string" ? r.path.replace(/\{[A-Za-z_]\w*\}/g, "x") : (r.path as string),
      );
      if (pp) add(at, `path ${pp}.`);
      else if (s.code === undefined && isTemplateRead(r.path as string))
        add(at, "A path with {placeholders} is for code panels only.");
    }
  }

  if (s.code !== undefined) {
    if (typeof s.code !== "string" || !s.code.trim()) add("spec", "code must be the panel's page.");
    else if (s.code.length > PANEL_LIMITS.code)
      add("spec", `code is longer than ${PANEL_LIMITS.code} characters.`);
    if (s.blocks !== undefined && !Array.isArray(s.blocks))
      add("spec", "blocks must be a list (empty for a code panel).");
  }
  if (s.actions !== undefined) {
    if (s.code === undefined) add("spec", "actions are for code panels (blocks use button).");
    if (!Array.isArray(s.actions) || s.actions.length > PANEL_LIMITS.actions)
      add("spec", `actions must be a list of at most ${PANEL_LIMITS.actions}.`);
    else {
      const ids = new Set<string>();
      for (const x of s.actions) {
        if (!isObj(x) || typeof x.id !== "string" || !ID.test(x.id)) {
          add("spec", "Each action needs an id: lowercase letters, numbers and dashes.");
          continue;
        }
        const at = `action:${x.id}`;
        if (ids.has(x.id)) add(at, "Two actions have this id.");
        ids.add(x.id);
        for (const k of Object.keys(x))
          if (!["id", "label", "method", "path", "why"].includes(k))
            add(at, `Unknown field "${k}".`);
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(x.method as string))
          add(at, "method must be POST, PUT, PATCH or DELETE.");
        const pp = panelPathProblem(
          typeof x.path === "string"
            ? x.path.replace(/\{[A-Za-z_]\w*\}/g, "x")
            : (x.path as string),
        );
        if (pp) add(at, `path ${pp}.`);
        for (const k of ["label", "why"]) {
          const tp = textProblem(x[k], k === "why" ? 200 : PANEL_LIMITS.text);
          if (tp) add(at, `${k} ${tp}.`);
        }
      }
    }
  }
  if (s.code !== undefined && Array.isArray(s.blocks) && s.blocks.length === 0) return issues;

  if (!Array.isArray(s.blocks) || s.blocks.length === 0) {
    add("spec", "blocks must list at least one block.");
    return issues;
  }
  if (s.blocks.length > PANEL_LIMITS.blocks)
    add("spec", `At most ${PANEL_LIMITS.blocks} blocks per panel.`);
  const blockIds = new Set<string>();
  for (const b of s.blocks) {
    if (!isObj(b) || typeof b.id !== "string" || !ID.test(b.id)) {
      add("spec", "Each block needs an id: lowercase letters, numbers and dashes.");
      continue;
    }
    const at = `block:${b.id}`;
    if (blockIds.has(b.id)) add(at, "Two blocks have this id.");
    blockIds.add(b.id);
    issues.push(...blockIssues(b, readIds).map((message) => ({ at, message })));
  }
  return issues;
}

/** The problems with one block (also used to mark a single block "needs an update"). */
export function blockIssues(b: Record<string, unknown>, readIds: Set<string>): string[] {
  const out: string[] = [];
  const kind = b.kind as PanelBlockKind;
  if (!PANEL_BLOCK_KINDS.includes(kind))
    return [
      `"${String(b.kind)}" is not a block Hearth has. Blocks: ${PANEL_BLOCK_KINDS.join(", ")}.`,
    ];
  for (const k of Object.keys(b))
    if (k !== "id" && k !== "kind" && !ALLOWED_KEYS[kind].includes(k))
      out.push(`Unknown field "${k}" for a ${kind} block.`);
  const text = (k: string, optional = false) => {
    if (optional && b[k] === undefined) return;
    const p = textProblem(b[k]);
    if (p) out.push(`${k} ${p}.`);
  };
  const field = (k: string, optional = false) => {
    if (optional && (b[k] === undefined || b[k] === "")) return;
    const p = fieldProblem(b[k] as string);
    if (p) out.push(`${k} ${p}.`);
  };
  const read = () => {
    if (typeof b.read !== "string" || !readIds.has(b.read))
      out.push(`read must name one of this panel's reads.`);
  };
  switch (kind) {
    case "heading":
      text("text");
      break;
    case "stat":
      read();
      text("label");
      field("field");
      text("unit", true);
      break;
    case "status-list":
      read();
      field("items", true);
      text("title", true);
      field("name");
      field("state");
      for (const k of ["good", "bad"])
        if (
          b[k] !== undefined &&
          (!Array.isArray(b[k]) ||
            (b[k] as unknown[]).length > 20 ||
            (b[k] as unknown[]).some((x) => textProblem(x, 40)))
        )
          out.push(`${k} must be a short list of state words.`);
      break;
    case "table": {
      read();
      field("items", true);
      text("title", true);
      const cols = b.columns;
      if (!Array.isArray(cols) || cols.length === 0 || cols.length > PANEL_LIMITS.columns)
        out.push(`columns must list 1 to ${PANEL_LIMITS.columns} columns.`);
      else
        for (const c of cols) {
          if (!isObj(c)) {
            out.push("Each column is { label, field }.");
            continue;
          }
          const lp = textProblem(c.label, 40);
          if (lp) out.push(`A column's label ${lp}.`);
          const fp = fieldProblem(c.field as string);
          if (fp) out.push(`A column's field ${fp}.`);
          if (
            c.format !== undefined &&
            !["text", "number", "bytes", "date"].includes(c.format as string)
          )
            out.push("A column's format is text, number, bytes or date.");
          for (const k of Object.keys(c))
            if (!["label", "field", "format"].includes(k)) out.push(`Unknown column field "${k}".`);
        }
      if (b.poster !== undefined) {
        const pp = fieldProblem(b.poster as string);
        if (pp) out.push(`poster ${pp}.`);
      }
      break;
    }
    case "image-grid": {
      read();
      field("items", true);
      text("title", true);
      field("caption", true);
      const img = typeof b.image === "string" ? b.image : "";
      const pp = panelPathProblem(img.replace(/\{[^}]*\}/g, "x"));
      if (pp) out.push(`image ${pp}.`);
      for (const m of img.matchAll(/\{([^}]*)\}/g)) {
        const fp = fieldProblem(m[1]!);
        if (fp) out.push(`image's {${m[1]}} ${fp}.`);
      }
      break;
    }
    case "timeline":
      read();
      field("items", true);
      text("title", true);
      field("at");
      field("text");
      break;
    case "chart":
      read();
      field("items", true);
      text("title", true);
      field("x");
      field("y");
      if (b.style !== "line" && b.style !== "bar") out.push("style is line or bar.");
      break;
    case "link": {
      text("label");
      const pp = panelPathProblem(b.path as string);
      if (pp) out.push(`path ${pp}.`);
      break;
    }
    case "button": {
      text("label");
      text("why");
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(b.method as string))
        out.push("method is POST, PUT, PATCH or DELETE (a button proposes a change).");
      const pp = panelPathProblem(b.path as string);
      if (pp) out.push(`path ${pp}.`);
      if (b.body !== undefined) {
        if (typeof b.body !== "string" || b.body.length > PANEL_LIMITS.body)
          out.push(`body must be text of at most ${PANEL_LIMITS.body} characters.`);
        else if (/^\s*[[{]/.test(b.body))
          try {
            JSON.parse(b.body);
          } catch {
            out.push("body looks like JSON but does not parse.");
          }
      }
      break;
    }
  }
  return out;
}

/** Read a field path out of an answer. Only own properties; never runs anything. */
export function pickField(data: unknown, path: string | undefined): unknown {
  if (!path) return data;
  let cur: unknown = data;
  for (const seg of path.split(".")) {
    if (FORBIDDEN.has(seg) || cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (seg === "length") return cur.length;
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

/** One value as plain short text (objects and lists are not shown). */
export function shownValue(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string") return v.slice(0, 200);
  return null;
}

/** What one block shows, worked out from the reads (the page only draws this). */
export type BlockView =
  | { kind: "heading"; text: string }
  | { kind: "stat"; label: string; value: string | number | null; unit?: string }
  | {
      kind: "status-list";
      title?: string;
      rows: { name: string; state: string; tone: "good" | "bad" | "neutral" }[];
    }
  | {
      kind: "table";
      title?: string;
      columns: { label: string; format: "text" | "number" | "bytes" | "date" }[];
      rows: (string | number | null)[][];
      /** Each row's poster file (or null), when the block names a poster field. */
      posters?: (string | null)[];
    }
  | { kind: "image-grid"; title?: string; images: { path: string; caption?: string }[] }
  | { kind: "timeline"; title?: string; events: { at: string; text: string }[] }
  | {
      kind: "chart";
      title?: string;
      style: "line" | "bar";
      points: { x: string; y: number }[];
    }
  | { kind: "link"; label: string; path: string }
  | {
      kind: "button";
      label: string;
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      body?: string;
      why: string;
    };

/** A block's state in a preview or on the panel. */
export interface BlockResult {
  id: string;
  /** real: drawn from a working read. not-possible: its read failed (reason says why). */
  state: "real" | "not-possible" | "needs-update";
  reason?: string;
  view?: BlockView;
}

export type ReadOutcome = { ok: true; data: unknown } | { ok: false; reason: string };

const list = (data: unknown, path?: string): unknown[] | undefined => {
  const v = pickField(data, path);
  return Array.isArray(v) ? v.slice(0, PANEL_LIMITS.items) : undefined;
};

/**
 * Work out every block from the reads' answers. A block whose read failed, or whose list is not a
 * list, says why instead of showing made-up values; one block's problem never stops the others.
 */
export function resolvePanel(spec: PanelSpec, reads: Record<string, ReadOutcome>): BlockResult[] {
  const readIds = new Set(spec.reads.map((r) => r.id));
  return spec.blocks.map((b): BlockResult => {
    const problems = blockIssues(b as unknown as Record<string, unknown>, readIds);
    if (problems.length) return { id: b.id, state: "needs-update", reason: problems[0] };
    if (b.kind === "heading") return { id: b.id, state: "real", view: b };
    if (b.kind === "link")
      return { id: b.id, state: "real", view: { kind: "link", label: b.label, path: b.path } };
    if (b.kind === "button")
      return {
        id: b.id,
        state: "real",
        view: {
          kind: "button",
          label: b.label,
          method: b.method,
          path: b.path,
          why: b.why,
          ...(b.body ? { body: b.body } : {}),
        },
      };
    const r = reads[b.read];
    if (!r) return { id: b.id, state: "not-possible", reason: "Its read has not run yet." };
    if (!r.ok) return { id: b.id, state: "not-possible", reason: r.reason };
    const title = "title" in b && b.title ? { title: b.title } : {};
    if (b.kind === "stat") {
      const value = shownValue(pickField(r.data, b.field));
      // A number that is not in the answer is never shown as real (a dash would look finished).
      if (value === null)
        return {
          id: b.id,
          state: "not-possible",
          reason: `"${b.field}" is not a number or text in the app's answer.`,
        };
      return {
        id: b.id,
        state: "real",
        view: { kind: "stat", label: b.label, value, ...(b.unit ? { unit: b.unit } : {}) },
      };
    }
    const items = list(r.data, b.items);
    if (!items)
      return {
        id: b.id,
        state: "not-possible",
        reason: `${b.items ? `"${b.items}"` : "The answer"} is not a list.`,
      };
    const str = (x: unknown, f: string) => String(shownValue(pickField(x, f)) ?? "");
    // A list whose items all lack the block's main field is a wrong path, not an empty app.
    const main =
      b.kind === "status-list"
        ? [b.name]
        : b.kind === "table"
          ? b.columns.map((c) => c.field)
          : b.kind === "timeline"
            ? [b.text]
            : b.kind === "chart"
              ? [b.y]
              : [...b.image.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
    if (
      items.length > 0 &&
      main.length > 0 &&
      items.every((x) => main.every((f) => shownValue(pickField(x, f)) === null))
    )
      return {
        id: b.id,
        state: "not-possible",
        reason: `None of the list's items has ${main.map((f) => `"${f}"`).join(" or ")}.`,
      };
    switch (b.kind) {
      case "status-list": {
        const good = (b.good ?? []).map((s) => s.toLowerCase());
        const bad = (b.bad ?? []).map((s) => s.toLowerCase());
        return {
          id: b.id,
          state: "real",
          view: {
            kind: "status-list",
            ...title,
            rows: items.map((x) => {
              const state = str(x, b.state);
              const l = state.toLowerCase();
              return {
                name: str(x, b.name),
                state,
                tone: good.includes(l) ? "good" : bad.includes(l) ? "bad" : "neutral",
              };
            }),
          },
        };
      }
      case "table":
        return {
          id: b.id,
          state: "real",
          view: {
            kind: "table",
            ...title,
            columns: b.columns.map((c) => ({ label: c.label, format: c.format ?? "text" })),
            rows: items.map((x) => b.columns.map((c) => shownValue(pickField(x, c.field)))),
            ...(b.poster
              ? {
                  posters: items.map((x) => {
                    const v = pickField(x, b.poster!);
                    return typeof v === "string" && POSTER_FILE.test(v) ? v : null;
                  }),
                }
              : {}),
          },
        };
      case "image-grid":
        return {
          id: b.id,
          state: "real",
          view: {
            kind: "image-grid",
            ...title,
            images: items.map((x) => ({
              path: b.image.replace(/\{([^}]*)\}/g, (_, f: string) =>
                encodeURIComponent(String(shownValue(pickField(x, f)) ?? "")),
              ),
              ...(b.caption ? { caption: str(x, b.caption) } : {}),
            })),
          },
        };
      case "timeline":
        return {
          id: b.id,
          state: "real",
          view: {
            kind: "timeline",
            ...title,
            events: items.map((x) => ({ at: str(x, b.at), text: str(x, b.text) })),
          },
        };
      case "chart":
        return {
          id: b.id,
          state: "real",
          view: {
            kind: "chart",
            ...title,
            style: b.style,
            points: items
              .map((x) => ({ x: str(x, b.x), y: Number(pickField(x, b.y)) }))
              .filter((p) => Number.isFinite(p.y)),
          },
        };
    }
  });
}

/** A movie-database poster file name, the only kind a table's poster field shows. */
export const POSTER_FILE = /^\/[\w-]+\.(jpg|jpeg|png|webp)$/i;

/** Whether a path is one this panel's image blocks could ask for (the image proxy's check). */
export function panelImageAllowed(spec: PanelSpec, path: string): boolean {
  if (panelPathProblem(path)) return false;
  return spec.blocks.some((b) => {
    if (b.kind !== "image-grid") return false;
    // The template's fixed text, with each {field} standing for one URL-encoded value.
    const parts = b.image.split(/\{[^}]*\}/);
    const re = new RegExp(
      `^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/?&#]*")}$`,
    );
    return re.test(path);
  });
}

/** Lifecycle words, said the same way everywhere. */
/**
 * draft: Ember's (or a loaded file's) design, not in use. installed: in use. previous: an earlier
 * install, kept to bring back. pending: Free plan, a new version waiting for its contribution to
 * be accepted; never read, and the installed panel keeps working meanwhile.
 */
export type CustomPanelStatus = "draft" | "installed" | "previous" | "pending";

export interface CustomPanelView {
  id: string;
  serviceId: string;
  status: CustomPanelStatus;
  version: number;
  spec: PanelSpec;
  /** Blocks the owner dropped from a draft (kept out when installed). */
  dropped: string[];
  /** Ember's short note on what it built and why. */
  note?: string;
  createdAt: string;
  updatedAt: string;
  installedAt?: string;
  /** Where its draft came from: Ember, a file, or a verified shared panel. */
  origin: "ember" | "file" | "shared";
}

/** A panel's submission to the Hearth project (free plan's contribution, or a donation). */
export interface PanelSubmissionView {
  version: number;
  sentAt: string;
  /** The submission service's id for it. */
  id: string;
  /** The pull request it opened, once filed. */
  url?: string;
}

/** The spec as installed: the kept blocks only. */
export function keptSpec(spec: PanelSpec, dropped: string[]): PanelSpec {
  // A code panel's page uses its reads itself: all of them stay.
  if (spec.code !== undefined) return spec;
  const blocks = spec.blocks.filter((b) => !dropped.includes(b.id));
  // Reads no kept block uses are not installed: the panel asks the app only for what it shows.
  const used = new Set(blocks.flatMap((b) => ("read" in b ? [b.read] : [])));
  return { ...spec, blocks, reads: spec.reads.filter((r) => used.has(r.id)) };
}

/** The format, for Ember (panel_builder guide). Short: Ember reads it before drafting. */
export const PANEL_SPEC_GUIDE = `A custom panel is JSON: Hearth's own blocks (below), or a code panel (further down) for anything blocks cannot draw.
{ "specVersion": 1, "id": "community.<app>.<name>", "title": "...", "serviceId": "<this app's service id>",
  "auth": "header:X-Api-Key" (only for an app Hearth has no reader for; how its vault key is sent),
  "refreshSeconds": 60 (15 to 3600),
  "reads": [ { "id": "monitors", "path": "/api/monitors.json" } ] (GET on this app only, at most 12),
  "blocks": [ at most 24 of:
    { "kind": "heading", "id": "top", "text": "Cameras" }
    { "kind": "stat", "id": "count", "read": "monitors", "label": "Cameras", "field": "monitors.length", "unit": "" }
    { "kind": "status-list", "id": "cams", "read": "monitors", "items": "monitors", "name": "Monitor.Name", "state": "Monitor.Function", "good": ["Record"], "bad": ["None"] }
    { "kind": "table", "id": "t", "read": "events", "items": "events", "columns": [ { "label": "Camera", "field": "Event.MonitorId" }, { "label": "Length", "field": "Event.Length", "format": "number" } ] }  (format: text, number, bytes, date)
    add "poster": "poster_path" to a table of movies or shows (the movie-database poster file, "/abc.jpg") and it shows as cover art with the first column as the title: use it whenever the app gives posters
    { "kind": "image-grid", "id": "snaps", "read": "monitors", "items": "monitors", "image": "/zm/snapshot?monitor={Monitor.Id}", "caption": "Monitor.Name" }
    { "kind": "timeline", "id": "ev", "read": "events", "items": "events", "at": "Event.StartTime", "text": "Event.Notes" }
    { "kind": "chart", "id": "c", "read": "disk", "items": "days", "x": "date", "y": "used", "style": "line" }
    { "kind": "link", "id": "open", "label": "Open the console", "path": "/zm/" }
    { "kind": "button", "id": "b", "label": "Start recording", "method": "PUT", "path": "/api/x", "body": "{...}", "why": "Starts recording on all cameras" } (proposes a plan the owner approves) ] }
Fields are dot paths into the read's answer ("data.0.name", "items.length"); "items" names the list (empty: the answer itself). Text is plain words: no markup.

CODE PANEL: anything the owner describes (poster folders that open details, a trailer player, a Request popup, tabs, search, layouts): add "code" (the panel's own page: HTML with <style> and <script>, at most 200000 characters) and "blocks": [].
It runs in a sealed frame: no network, no cookies or storage, no Hearth session, no keys. Everything goes through window.hearth:
  hearth.values: { readId: answer } for every read without {placeholders} (read before the page starts, again every refreshSeconds); hearth.onData(fn) calls fn(values) each time.
  await hearth.read("details", { id: 123 }): a read whose path has placeholders ("/api/v1/movie/{id}"), filled and URL-encoded by Hearth. Throws with the reason when the app refuses.
  await hearth.poster("/abc.jpg"): a movie-database poster file (as Seerr, Tasterr, Radarr, Sonarr give it) as a picture URL for <img src>.
  await hearth.act("request", { id: 123 }, { mediaType: "movie", mediaId: 123 }): one of the spec's "actions" ({ "id", "label", "method": POST|PUT|PATCH|DELETE, "path": "/api/v1/request", "why": "Requests this title" }, at most 12), with the path's placeholders filled and that JSON body. It never runs on its own: the owner sees the exact request and approves it. Resolves { proposed: true }.
  hearth.trailer("dQw4w9WgXcQ"): plays a YouTube trailer (its 11-character key, from the app's videos) in Hearth's own player over the panel, with play, pause, seek and rewind.
  hearth.open("/movie/123") opens that page of the app; hearth.open("https://...") opens a web page.
Style it with the theme's CSS variables (already set): --ink (text), --muted, --faint, --gold (accent), --bg, --panel, --raised, --line, --alert, --ok; the frame is transparent and grows to fit the page. Keep it fast: build the DOM from hearth.values, read details only when clicked.
Check it with action check (it tries every fixed read), then draft: the owner sees it live in the Forge preview and presses Apply.`;

/**
 * The rights a panel gives Dragon's Oath (11-13, the owner and Flint): the same grant as Hearth's
 * Contributor License Agreement (CLA.md, adapted from the Apache Individual CLA), in plain words,
 * so a panel submitted from inside Hearth and a pull request on GitHub give the same rights.
 * Bump the version whenever the wording changes: each acceptance records which one was agreed to.
 */
export const PANEL_DONATION_TERMS_VERSION = 2;

/** The grant itself, word for word in both agreements below. */
export const PANEL_GRANT =
  "You keep the copyright. You give Dragon's Oath a permanent, worldwide, free licence to use, copy, change, share and sublicense this panel, and to relicense it under any terms, including commercially, in free and paid versions of Hearth, with no payment to you. If it touches a patent you hold, the licence covers that too. These are the same terms as Hearth's Contributor License Agreement for code on GitHub.";

/** Donating a panel (Premium's "Donate your panel"): exactly what leaves the machine, and the grant. */
export const PANEL_DONATION_TERMS: string[] = [
  "You are donating this panel's design: its layout, its blocks and labels, and the paths it reads on the app. Nothing else.",
  "Not included: your keys and passwords, your app's address, and anything the panel has shown you (names, numbers, pictures).",
  "You made this design (with Ember's help) and have the right to give it.",
  PANEL_GRANT,
  "Dragon's Oath may merge, change or decline it, and doesn't owe you support for it. Your own panel keeps working either way.",
];
