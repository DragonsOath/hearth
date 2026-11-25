/**
 * Watch it (Curator, the owner 11-24): a title you have, opened in the app that holds it. Plex
 * through app.plex.tv (works wherever you're signed in to Plex), Jellyfin and Emby at the
 * server's own address (its public https one when it has one).
 */

export type WatchApp = "plex" | "jellyfin" | "emby";

export interface WatchPlace {
  serviceId: string;
  /** The server's name in Hearth. */
  server: string;
  app: WatchApp;
  url: string;
  watched: boolean;
}

export function watchUrl(
  app: WatchApp,
  o: { id: string; machine?: string; base?: string },
): string | undefined {
  if (app === "plex")
    return o.machine
      ? `https://app.plex.tv/desktop/#!/server/${encodeURIComponent(o.machine)}/details?key=${encodeURIComponent(`/library/metadata/${o.id}`)}`
      : undefined;
  const base = o.base?.replace(/\/+$/, "");
  if (!base || !/^https?:\/\//i.test(base)) return undefined;
  return app === "jellyfin"
    ? `${base}/web/#/details?id=${encodeURIComponent(o.id)}`
    : `${base}/web/index.html#!/item?id=${encodeURIComponent(o.id)}`;
}

/** The address a browser opens a Jellyfin or Emby at: its public https one, else its own. */
export const browserBase = (s: { publicUrl?: string | null; localUrl?: string | null }) =>
  (s.publicUrl && /^https:\/\//i.test(s.publicUrl) ? s.publicUrl : undefined) ??
  (s.localUrl || undefined);
