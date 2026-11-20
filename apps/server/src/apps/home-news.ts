import { TIMEOUT_MS, type Fetch } from "./http";

/**
 * The home dashboard's news widget (11-05): headlines from the RSS or Atom feeds the owner
 * chose (home-board.ts), fetched by Hearth, read again at most every fifteen minutes. Only each
 * headline's title, link, source and time reach the screen: never the feed's own HTML.
 */

export interface Headline {
  title: string;
  link?: string;
  source: string;
  at?: string;
}

const MAX_BYTES = 1024 * 1024;
const cache = new Map<string, { at: number; items: Headline[]; error?: string }>();

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Plain text from a feed's field: no CDATA wrapper, no tags, entities decoded. */
export function plain(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const field = (block: string, tag: string) =>
  block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"))?.[1];

/** The headlines in an RSS 2.0 or Atom document, newest first as the feed lists them. */
export function parseFeed(xml: string, fallbackName: string): Headline[] {
  const source =
    plain(field(xml.replace(/<(item|entry)[\s>][\s\S]*$/i, ""), "title")) || fallbackName;
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) ?? [];
  return blocks
    .map((b) => {
      const title = plain(field(b, "title"));
      const href =
        b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)?.[1] ??
        b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ??
        plain(field(b, "link"));
      const when = plain(field(b, "pubDate") ?? field(b, "published") ?? field(b, "updated"));
      const at = Date.parse(when);
      return {
        title: title.slice(0, 200),
        ...(href && /^https?:\/\//i.test(href) ? { link: href.slice(0, 500) } : {}),
        source: source.slice(0, 60),
        ...(Number.isFinite(at) ? { at: new Date(at).toISOString() } : {}),
      };
    })
    .filter((h) => h.title)
    .slice(0, 20);
}

async function readFeed(fetchImpl: Fetch, url: string, name: string | undefined, now: number) {
  const hit = cache.get(url);
  if (hit && now - hit.at < 15 * 60_000) return hit;
  let entry: { at: number; items: Headline[]; error?: string };
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !res.text) throw new Error(`answered ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("too large");
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new Error("not a news feed");
    entry = { at: now, items: parseFeed(text, name ?? new URL(url).hostname) };
  } catch (e) {
    entry = {
      at: now,
      items: hit?.items ?? [],
      error: `${name ?? new URL(url).hostname}: ${e instanceof Error ? e.message : "no answer"}`,
    };
  }
  cache.set(url, entry);
  return entry;
}

/** The newest headlines across the chosen feeds, and which feeds could not be read. */
export async function readNews(
  fetchImpl: Fetch,
  feeds: { url: string; name?: string }[],
  now = Date.now(),
): Promise<{ items: Headline[]; problems: string[] }> {
  const read = await Promise.all(
    feeds.slice(0, 8).map((f) => readFeed(fetchImpl, f.url, f.name, now)),
  );
  const items = read
    .flatMap((r) => r.items)
    .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0))
    .slice(0, 30);
  return { items, problems: read.flatMap((r) => (r.error ? [r.error] : [])) };
}
