/** Chaptarr's own cover cache for a book in its library (served under /api/v1, with its key). */
export const CHAPTARR_COVER =
  /^\/MediaCover\/Books\/\d+\/cover\.(?:jpg|jpeg|png|webp)(?:\?v=\d+)?$/i;

/**
 * Where Chaptarr's looked-up books keep their covers (its own proxy refuses an API key, so Hearth
 * fetches these itself, never the browser). Only these hosts, over https.
 */
const COVER_HOSTS = [
  "i.gr-assets.com",
  "images.gr-assets.com",
  "assets.hardcover.app",
  "covers.openlibrary.org",
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
];
export function remoteCover(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && COVER_HOSTS.includes(u.hostname) && !u.username && !u.port
      ? u.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/** The cover link for a Chaptarr book record, through Hearth (the Curator's cards). */
export function coverLink(
  serviceId: string,
  images: { url?: string; remoteUrl?: string; coverType?: string }[] | undefined,
): string | undefined {
  const img = images?.find((i) => i.coverType === "cover") ?? images?.[0];
  if (!img) return undefined;
  const base = `/api/services/${encodeURIComponent(serviceId)}/dashboard/book-cover`;
  if (img.url && CHAPTARR_COVER.test(img.url)) return `${base}?path=${encodeURIComponent(img.url)}`;
  const remote = remoteCover(img.remoteUrl);
  return remote ? `${base}?remote=${encodeURIComponent(remote)}` : undefined;
}
