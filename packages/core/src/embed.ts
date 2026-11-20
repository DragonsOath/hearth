/**
 * Whether an app's own page may be shown inside Hearth (11-14, the owner via Flint: a basic panel
 * shows the app itself). The app decides, with its own headers, and Hearth only reads them:
 * X-Frame-Options (DENY, SAMEORIGIN) and Content-Security-Policy frame-ancestors. Hearth never
 * strips or changes them; an app that refuses gets a big Open button instead.
 */

// core is built without the DOM or Node typings, yet both runtimes (browser, Node) have URL: the
// few fields used here are declared, rather than pulling a whole environment's types into core.
interface ParsedUrl {
  origin: string;
  protocol: string;
  hostname: string;
  port: string;
}
declare const URL: new (input: string) => ParsedUrl;

export interface EmbedVerdict {
  ok: boolean;
  /** Why not, in plain words. */
  reason?: string;
}

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

/** One frame-ancestors source against Hearth's own address. */
function sourceMatches(src: string, embedder: string, target: string): boolean {
  const s = src.replace(/^'|'$/g, "").toLowerCase();
  if (s === "*") return true;
  if (s === "self") return originOf(embedder) === originOf(target);
  if (s === "none") return false;
  let e: ParsedUrl;
  try {
    e = new URL(embedder);
  } catch {
    return false;
  }
  // A scheme alone ("https:").
  if (/^[a-z][a-z0-9+.-]*:$/.test(s)) return e.protocol === s;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/.exec(s);
  if (!m) return false;
  const [, scheme, wild, host, port] = m;
  if (scheme && `${scheme}:` !== e.protocol) return false;
  if (wild ? !e.hostname.endsWith(`.${host}`) : e.hostname !== host) return false;
  const ePort = e.port || (e.protocol === "https:" ? "443" : "80");
  if (port && port !== "*" && port !== ePort) return false;
  if (!port && !scheme && e.port) return false;
  if (!port && scheme && e.port) return false;
  return true;
}

/**
 * The verdict from the app's own headers, for a page at `embedder` (Hearth's address in the
 * browser) showing `target` (the app's address).
 */
export function frameVerdict(
  headers: { xFrameOptions?: string | null; csp?: string | null },
  embedder: string,
  target: string,
): EmbedVerdict {
  if (embedder.startsWith("https:") && target.startsWith("http:"))
    return {
      ok: false,
      reason: "Hearth is open over https and the app over http, which browsers won't mix.",
    };
  // frame-ancestors wins over X-Frame-Options where both are set (browsers do the same).
  const fa = (headers.csp ?? "")
    .split(";")
    .map((d) => d.trim())
    .find((d) => /^frame-ancestors\b/i.test(d));
  if (fa) {
    const sources = fa.split(/\s+/).slice(1).filter(Boolean);
    if (sources.some((s) => sourceMatches(s, embedder, target))) return { ok: true };
    return {
      ok: false,
      reason:
        sources.length === 1 && /'none'/i.test(sources[0]!)
          ? "The app doesn't allow being shown inside other pages."
          : "The app only allows being shown inside its own pages.",
    };
  }
  const xfo = (headers.xFrameOptions ?? "").trim().toUpperCase();
  if (xfo === "DENY")
    return { ok: false, reason: "The app doesn't allow being shown inside other pages." };
  if (xfo === "SAMEORIGIN")
    return originOf(embedder) === originOf(target)
      ? { ok: true }
      : { ok: false, reason: "The app only allows being shown inside its own pages." };
  return { ok: true };
}

/**
 * Which of the app's addresses to show: the one that matches how Hearth is open (the domain over
 * https, the home address over http), so the browser shows it and keeps its sign-in.
 */
export function embedAddress(
  service: { localUrl?: string | null; publicUrl?: string | null },
  pageProtocol: string,
): string | undefined {
  const pub = service.publicUrl
    ? /^https?:\/\//.test(service.publicUrl)
      ? service.publicUrl
      : `https://${service.publicUrl}`
    : undefined;
  const local = service.localUrl ?? undefined;
  if (pageProtocol === "https:")
    return [pub, local].find((u) => u?.startsWith("https:")) ?? pub ?? local;
  return local ?? pub;
}
