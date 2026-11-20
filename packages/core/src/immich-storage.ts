/**
 * Immich's storage template, the only supported way to choose folders and file names for photos
 * in Immich: a pattern like {{y}}/{{MM}}/{{filename}} that Immich applies to the whole library.
 * Immich adds the extension itself. This file builds a pattern from a few plain choices, reads a
 * pattern back into those choices when it matches one, and previews the path Immich would give a
 * photo (the same substitutions as Immich's StorageTemplateService, for the parts Hearth offers
 * and the common date tokens).
 */

export type FolderChoice = "album" | "year" | "year-month";
export type NameChoice = "original" | "date" | "album-date";

export const FOLDER_CHOICES: { value: FolderChoice; label: string; hint: string }[] = [
  {
    value: "album",
    label: "By album",
    hint: "One folder per album; photos in no album go by year and month.",
  },
  { value: "year", label: "By year", hint: "2025, 2026..." },
  { value: "year-month", label: "By year, then month", hint: "2026/03..." },
];

export const NAME_CHOICES: { value: NameChoice; label: string; hint: string }[] = [
  { value: "original", label: "Keep the original name", hint: "IMG_0001.jpg" },
  { value: "date", label: "Date, then the original name", hint: "2026-03-02 IMG_0001.jpg" },
  {
    value: "album-date",
    label: "Album, date, then the original name",
    hint: "Utah Trip 2026-03-02 IMG_0001.jpg",
  },
];

const FOLDERS: Record<FolderChoice, string> = {
  album: "{{#if album}}{{album}}{{else}}{{y}}/{{MM}}{{/if}}",
  year: "{{y}}",
  "year-month": "{{y}}/{{MM}}",
};

const NAMES: Record<NameChoice, string> = {
  original: "{{filename}}",
  date: "{{y}}-{{MM}}-{{dd}} {{filename}}",
  "album-date": "{{#if album}}{{album}} {{/if}}{{y}}-{{MM}}-{{dd}} {{filename}}",
};

/** The pattern for a folder and a file name choice. */
export const buildTemplate = (folder: FolderChoice, name: NameChoice) =>
  `${FOLDERS[folder]}/${NAMES[name]}`;

/** The choices a pattern was built from, when it is one Hearth builds; else undefined. */
export function choicesOf(
  template: string,
): { folder: FolderChoice; name: NameChoice } | undefined {
  for (const folder of Object.keys(FOLDERS) as FolderChoice[])
    for (const name of Object.keys(NAMES) as NameChoice[])
      if (buildTemplate(folder, name) === template.trim()) return { folder, name };
  return undefined;
}

/** A photo, as the preview needs it. */
export interface TemplateSample {
  /** Its original file name, as Immich shows it ("Beach.jpeg"). */
  name: string;
  /** When it was taken (Immich's fileCreatedAt). */
  takenAt: string;
  /** Its first album, if any (the one Immich's template uses). */
  album?: string;
  /** Its owner's storage label, or their user id (Immich's folder for that person). */
  owner: string;
  assetId?: string;
  video?: boolean;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/**
 * Removes what sanitize-filename (which Immich uses) removes: path separators, reserved
 * characters, control characters, and trailing dots and spaces.
 */
export const sanitizeName = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[/?<>\\:*|"\u0000-\u001f\u0080-\u009f]/g, "")
    .replace(/^\.+$/, "")
    .replace(/[. ]+$/, "")
    .slice(0, 255);

/** Immich's extension rules: lower case, with a few spellings made one. */
export function extensionOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  const ext = (m?.[1] ?? "").toLowerCase();
  const same: Record<string, string> = {
    jpeg: "jpg",
    jpe: "jpg",
    tif: "tiff",
    "3gpp": "3gp",
    mpeg: "mpg",
    mpe: "mpg",
    m2ts: "mts",
    m2t: "mts",
  };
  return same[ext] ?? ext;
}

/**
 * The tokens a pattern can use, as Immich fills them in. Immich 3.2.4 dates a photo by its
 * fileCreatedAt in the Immich server's own time zone (its TZ setting; UTC when unset), not by the
 * photo's local time, so the date is shifted by that zone's offset (minutes east of UTC).
 */
function substitutions(s: TemplateSample, zone = "UTC"): Record<string, string> {
  const d = inZone(Date.parse(s.takenAt), zone);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const base = s.name.replace(/\.[^.]+$/, "");
  const week = (() => {
    const t = new Date(Date.UTC(y, mo, day));
    const dow = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - dow);
    const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7);
  })();
  return {
    filename: sanitizeName(base),
    ext: extensionOf(s.name),
    filetype: s.video ? "VID" : "IMG",
    filetypefull: s.video ? "VIDEO" : "IMAGE",
    assetId: s.assetId ?? "",
    assetIdShort: (s.assetId ?? "").slice(-12),
    album: s.album ? sanitizeName(s.album.replace(/\.+/g, "")) : "",
    y: String(y),
    yy: pad(y % 100),
    M: String(mo + 1),
    MM: pad(mo + 1),
    MMM: MONTHS[mo]!.slice(0, 3),
    MMMM: MONTHS[mo]!,
    d: String(day),
    dd: pad(day),
    W: String(week),
    WW: pad(week),
    h: String(h % 12 || 12),
    hh: pad(h % 12 || 12),
    H: String(h),
    HH: pad(h),
    m: String(d.getUTCMinutes()),
    mm: pad(d.getUTCMinutes()),
    s: String(d.getUTCSeconds()),
    ss: pad(d.getUTCSeconds()),
    SSS: pad(d.getUTCMilliseconds(), 3),
  };
}

/** Why a pattern cannot be used, in plain words; undefined when it can. */
export function templateProblem(template: string): string | undefined {
  const t = template.trim();
  if (!t) return "The pattern is empty.";
  if (t.length > 500) return "The pattern is too long.";
  if (!/\{\{\s*(filename|assetId|assetIdShort)\s*\}\}/.test(t))
    return "The pattern needs the file name ({{filename}}), or two photos could get the same name.";
  const opens = (t.match(/\{\{#if /g) ?? []).length;
  const closes = (t.match(/\{\{\/if\}\}/g) ?? []).length;
  if (opens !== closes) return "An {{#if}} in the pattern is not closed with {{/if}}.";
  for (const m of t.matchAll(/\{\{\s*([^}#/]+?)\s*\}\}/g)) {
    const token = m[1]!;
    if (token === "else") continue;
    if (!(token in substitutions({ name: "a.jpg", takenAt: "2026-01-01", owner: "x" })))
      if (!/^album-(startDate|endDate)-/.test(token))
        return `Hearth does not know {{${token}}}, so it cannot show where photos would go.`;
  }
  return undefined;
}

/**
 * The path Immich would give a photo, from its library folder: "library/<owner>/..." with the
 * extension added, as Immich's storage template job writes it. Album dates are left empty.
 */
export function previewPath(template: string, s: TemplateSample, zone = "UTC"): string {
  const sub = substitutions(s, zone);
  // {{#if x}}a{{else}}b{{/if}}, innermost first, as Handlebars treats an empty value as false.
  let t = template;
  for (let i = 0; i < 10 && /\{\{#if /.test(t); i++)
    t = t.replace(
      /\{\{#if\s+([\w-]+)\s*\}\}((?:(?!\{\{#if )[\s\S])*?)(?:\{\{else\}\}((?:(?!\{\{#if )[\s\S])*?))?\{\{\/if\}\}/g,
      (_m, key: string, yes: string, no?: string) => (sub[key] ? yes : (no ?? "")),
    );
  const rendered = t
    .replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, key: string) => sub[key] ?? "")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "");
  return `library/${s.owner}/${rendered}.${sub.ext}`;
}

/** Whether Immich put a file where the pattern says, allowing Immich's "+1" for a clash. */
export function pathMatches(actual: string, expected: string): boolean {
  const norm = actual.replace(/\\/g, "/");
  const i = norm.indexOf("library/");
  const rel = i >= 0 ? norm.slice(i) : norm;
  if (rel === expected) return true;
  const dot = expected.lastIndexOf(".");
  const stem = expected.slice(0, dot);
  const ext = expected.slice(dot);
  return (
    rel.startsWith(`${stem}+`) &&
    rel.endsWith(ext) &&
    /^\+\d+$/.test(rel.slice(stem.length, -ext.length))
  );
}

const formats = new Map<string, Intl.DateTimeFormat>();
/**
 * A moment as the clock reads in a time zone, returned as a Date whose UTC fields are that
 * clock (so the UTC getters above read it), the way Luxon formats it in Immich's zone.
 */
function inZone(ms: number, zone: string): Date {
  if (zone === "UTC") return new Date(ms);
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return new Date(
    Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour! % 24, +p.minute!, +p.second!, ms % 1000),
  );
}

/** Every time zone this system knows (the IANA names Immich's TZ setting takes). */
function allZones(): string[] {
  const list = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
    "timeZone",
  );
  return list?.length ? ["UTC", ...list.filter((z) => z !== "UTC")] : ["UTC"];
}

/**
 * Immich does not say which time zone it files photos in (its TZ setting; UTC when unset), but
 * once it has filed some by a dated pattern, only some zones put them where they are. Returns
 * those zones (UTC first when it fits), or undefined when no photo tells: none filed by the
 * pattern yet, the pattern has no date in it, or every zone fits.
 */
export function zonesThatFit(
  template: string,
  filed: (TemplateSample & { path: string })[],
): string[] | undefined {
  const inLibrary = filed.filter((x) => /(^|\/)library\//.test(x.path));
  if (
    !inLibrary.length ||
    !/\{\{\s*(y|yy|M{1,4}|d{1,2}|W{1,2}|h{1,2}|H{1,2})\s*\}\}/.test(template)
  )
    return undefined;
  const zones = allZones();
  const fits = zones.filter((z) =>
    inLibrary.every((x) => pathMatches(x.path, previewPath(template, x, z))),
  );
  return fits.length && fits.length < zones.length ? fits : undefined;
}

/** The different paths a photo could get across the zones that fit (one when they agree). */
export function previewPaths(template: string, s: TemplateSample, zones: string[]): string[] {
  return [...new Set(zones.map((z) => previewPath(template, s, z)))];
}
