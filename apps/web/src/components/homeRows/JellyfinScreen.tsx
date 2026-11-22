import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../../data/api";
import { Skeleton, cx } from "../ui";
import { ScreenRow, ScreenTiles, type ScreenItem } from "./HomeScreen";

/**
 * Jellyfin's and Emby's home screen as the person sees it (11-22): their rows in their order,
 * posters and all. Each person has their own, so pick whose. Read from the same place the Home
 * rows editors read, so a change saved there shows here on Refresh.
 */

type Poster = { id: string; title: string; year?: number };
interface View {
  kind?: "emby";
  users: { id: string; name: string; admin: boolean }[];
  userId: string;
  home: {
    sections?: string[];
    rows?: { id?: string; type: string; name?: string; excluded?: string[] }[];
    order: string[];
    latest?: string[];
    media: string[];
  };
  libraries: { id: string; name: string; type: string }[];
  sections: { id: string; name: string }[];
  previews: Record<string, Poster[]>;
  plugin?: { name: string; active: boolean; replacesHome?: boolean } | null;
}

interface Row {
  key: string;
  title: string;
  items?: Poster[];
  tiles?: string[];
}

/** The rows top to bottom, as the server draws them for this person. */
export function rowsOf(v: View): Row[] {
  const lib = (id: string) => v.libraries.find((l) => l.id === id)?.name ?? id;
  const named = (id: string) => v.sections.find((s) => s.id === id)?.name ?? id;
  const media = v.home.order.filter((id) => v.home.media.includes(id)).map(lib);
  const out: Row[] = [];
  if (v.kind === "emby") {
    for (const [i, r] of (v.home.rows ?? []).entries()) {
      if (r.type === "userviews") out.push({ key: `r${i}`, title: "My Media", tiles: media });
      else if (r.type === "latestmediablock")
        for (const id of v.home.order.filter((x) => !(r.excluded ?? []).includes(x)))
          out.push({
            key: `latest:${id}`,
            title: `Latest ${lib(id)}`,
            items: v.previews[`latest:${id}`] ?? [],
          });
      else
        out.push({
          key: r.id ?? `r${i}`,
          title: r.name || named(r.type),
          items: (r.id && v.previews[r.id]) || [],
        });
    }
    return out;
  }
  for (const s of v.home.sections ?? []) {
    if (s === "smalllibrarytiles" || s === "librarybuttons")
      out.push({ key: s, title: "My Media", tiles: media });
    else if (s === "resume")
      out.push({ key: s, title: "Continue Watching", items: v.previews.resume ?? [] });
    else if (s === "nextup") out.push({ key: s, title: "Next Up", items: v.previews.nextup ?? [] });
    else if (s === "latestmedia")
      for (const id of v.home.order.filter((x) => (v.home.latest ?? []).includes(x)))
        out.push({
          key: `latest:${id}`,
          title: `Recently Added in ${lib(id)}`,
          items: v.previews[`latest:${id}`] ?? [],
        });
  }
  return out;
}

export function JellyfinScreen({ serviceId }: { serviceId: string }) {
  const [userId, setUserId] = useState<string>();
  const view = useQuery({
    // The editors' own key: Refresh and a saved change read it again for both.
    queryKey: ["dashboard", serviceId, "jellyfin", "home", userId ?? ""],
    queryFn: () =>
      api<View>(
        "GET",
        `/api/services/${encodeURIComponent(serviceId)}/jellyfin/home${userId ? `?id=${encodeURIComponent(userId)}` : ""}`,
      ),
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (view.error)
    return (
      <p className="text-[0.88rem] text-amber" role="alert">
        The home screen couldn&apos;t be read: {view.error.message}
      </p>
    );
  const v = view.data;
  if (!v) return <Skeleton className="h-64" />;
  const art = (id: string) =>
    `/api/services/${encodeURIComponent(serviceId)}/dashboard/jellyfin-poster?item=${encodeURIComponent(id)}`;
  const items = (list: Poster[]): ScreenItem[] =>
    list.map((p) => ({
      key: p.id,
      title: p.title,
      ...(p.year ? { sub: String(p.year) } : {}),
      src: art(p.id),
    }));
  const rows = rowsOf(v);
  const name = v.users.find((u) => u.id === v.userId)?.name ?? "this person";
  return (
    <div className="space-y-5">
      {v.users.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Whose home">
          <span className="text-[0.8rem] text-muted">Whose home:</span>
          {v.users.map((u) => (
            <button
              key={u.id}
              type="button"
              aria-pressed={u.id === v.userId}
              onClick={() => setUserId(u.id)}
              className={cx(
                "min-h-9 rounded-full border px-3 text-[0.8rem] font-semibold",
                u.id === v.userId
                  ? "border-gold bg-gold/15 text-gold"
                  : "border-line text-muted hover:text-ink",
              )}
              data-testid="screen-user"
            >
              {u.name}
            </button>
          ))}
        </div>
      )}
      {v.plugin?.replacesHome && (
        <p className="text-[0.8rem] text-faint">
          {v.plugin.name} draws this home screen, so its own rows can look different in the app.
        </p>
      )}
      {rows.length ? (
        rows.map((r) =>
          r.tiles ? (
            <ScreenTiles key={r.key} title={r.title} names={r.tiles} />
          ) : (
            <ScreenRow
              key={r.key}
              title={r.title}
              items={items(r.items ?? [])}
              empty={`Empty for ${name} right now.`}
            />
          ),
        )
      ) : (
        <p className="text-[0.88rem] text-muted">Nothing is on {name}&apos;s home screen.</p>
      )}
    </div>
  );
}
