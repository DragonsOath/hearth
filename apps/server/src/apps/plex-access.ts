import { joinUrl, type Fetch } from "./http";

/**
 * Who has access to this Plex server (the Plex panel's Manage tab), as Plex's own Manage
 * Library Access page shows it: each friend or Home member, and how many of this server's
 * libraries they can see (all, or which ones). Sharing lives in the Plex account, so it is read
 * from plex.tv with the server's own Plex token (the owner allowed exactly that, 2026-11-02);
 * the token is sent nowhere else. Read only: changes stay in Plex for now.
 *
 * plex.tv answers in XML. Only the fields shown here are kept: never email addresses, and never
 * the access keys plex.tv includes for each shared server.
 */

export const PLEX_TV = "https://plex.tv";

export class PlexAccessError extends Error {}

export interface PlexFriend {
  id: string;
  name: string;
  username?: string;
  thumb?: string;
  /** In your Plex Home (managed users and family). */
  home: boolean;
  restricted: boolean;
  /** Invited, not accepted yet. */
  pending: boolean;
  allLibraries: boolean;
  libraries: string[];
  numLibraries: number;
}

type Attrs = Record<string, string>;

/** Each element's attributes in order, with its nesting kept as a parent index. */
export function xmlElements(xml: string): { tag: string; attrs: Attrs; parent: number }[] {
  const out: { tag: string; attrs: Attrs; parent: number }[] = [];
  const stack: number[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const [, close, tag, rest, self] = m;
    if (close) {
      stack.pop();
      continue;
    }
    const attrs: Attrs = {};
    for (const a of rest!.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = unescape(a[2]!);
    out.push({ tag: tag!, attrs, parent: stack.at(-1) ?? -1 });
    if (!self) stack.push(out.length - 1);
  }
  return out;
}

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

const yes = (v?: string) => v === "1" || v === "true";

async function text(f: Fetch, url: string, token: string, clientId: string) {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await f(url, {
      method: "GET",
      headers: {
        Accept: "application/xml",
        "X-Plex-Token": token,
        "X-Plex-Client-Identifier": clientId,
        "X-Plex-Product": "Hearth",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : "no answer";
    throw new PlexAccessError(`plex.tv did not answer: ${why.replaceAll(token, "[hidden]")}`);
  }
  if (res.status === 401)
    throw new PlexAccessError("plex.tv refused the token. Link Plex again from its panel.");
  if (!res.ok) throw new PlexAccessError(`plex.tv answered ${res.status}.`);
  return res.text ? res.text() : String(await res.json());
}

/**
 * Who has access: the account's friends and Home members with this server, from plex.tv's
 * users list (how many libraries) and the server's shares (which ones).
 */
export async function readPlexAccess(
  f: Fetch,
  local: string,
  token: string,
  clientId: string,
): Promise<{ server: string; friends: PlexFriend[] }> {
  const idRes = await f(joinUrl(local, "/identity"), {
    method: "GET",
    headers: { Accept: "application/json", "X-Plex-Token": token },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  const identity = (await idRes?.json().catch(() => ({}))) as {
    MediaContainer?: { machineIdentifier?: string; friendlyName?: string };
  };
  const machine = identity?.MediaContainer?.machineIdentifier;
  if (!machine) throw new PlexAccessError("This Plex server did not say which server it is.");

  const [users, shares] = await Promise.all([
    text(f, `${PLEX_TV}/api/users/`, token, clientId),
    text(
      f,
      `${PLEX_TV}/api/servers/${encodeURIComponent(machine)}/shared_servers`,
      token,
      clientId,
    ).catch(() => ""),
  ]);

  // Which libraries each user was given on this server.
  const els = xmlElements(shares);
  const given = new Map<string, { all: boolean; titles: string[] }>();
  els.forEach((e, i) => {
    if (e.tag !== "SharedServer") return;
    const titles = els
      .filter((s) => s.parent === i && s.tag === "Section" && yes(s.attrs.shared))
      .map((s) => s.attrs.title ?? "")
      .filter(Boolean);
    given.set(e.attrs.userID ?? "", { all: yes(e.attrs.allLibraries), titles });
  });

  const u = xmlElements(users);
  const friends: PlexFriend[] = [];
  u.forEach((e, i) => {
    if (e.tag !== "User") return;
    const server = u.find(
      (s) => s.parent === i && s.tag === "Server" && s.attrs.machineIdentifier === machine,
    );
    const home = yes(e.attrs.home);
    // Only people with this server (or in your Home, who see it through it).
    if (!server && !home) return;
    const share = given.get(e.attrs.id ?? "");
    const all = share?.all ?? yes(server?.attrs.allLibraries);
    friends.push({
      id: e.attrs.id ?? "",
      name: e.attrs.title || e.attrs.username || "Someone",
      ...(e.attrs.username ? { username: e.attrs.username } : {}),
      ...(e.attrs.thumb?.startsWith("https://") ? { thumb: e.attrs.thumb } : {}),
      home,
      restricted: yes(e.attrs.restricted),
      pending: yes(server?.attrs.pending),
      allLibraries: all,
      libraries: share?.titles ?? [],
      numLibraries: Number(server?.attrs.numLibraries ?? share?.titles.length ?? 0),
    });
  });
  friends.sort((a, b) => Number(b.home) - Number(a.home) || a.name.localeCompare(b.name));
  return { server: identity.MediaContainer?.friendlyName ?? "this server", friends };
}
