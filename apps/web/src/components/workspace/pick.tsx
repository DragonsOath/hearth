import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Check, Minus, Plus, Search, TriangleAlert, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  fuzzyScore,
  type WorkspaceItem,
  type WorkspacePlanView,
  type WorkspaceSpec,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { useAddToPick, type LibraryTitle } from "../../data/workspaces";
import { plexArt } from "../../data/dashboards";
import { cx } from "../ui";
import { ItemBadge } from "./plan";
import { RequestMissing } from "./pickRequest";
import { CuratorPicks } from "./pickCurator";

/**
 * The Forge's pick layout (checklist 45.15): choosing a set, such as the 30 titles for a Plex
 * collection. Selected sits beside Alternatives; you search, sort, add, remove and swap, and the
 * count shows against the target. It only changes each item's choice (the same choices the table
 * uses), so what you submit is exactly what you see in Selected.
 */

type Sort = { key: string; dir: 1 | -1 } | undefined;

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a === null || a === undefined || a === "") return 1;
  if (b === null || b === undefined || b === "") return -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function PickBoard({
  workspaceId,
  spec,
  choiceOf,
  choose,
  plan,
  narrow: narrowHint,
}: {
  workspaceId: string;
  spec: WorkspaceSpec;
  choiceOf: (item: WorkspaceItem) => { value?: string; suggested: boolean };
  choose: (changes: Record<string, string | null>) => void;
  plan?: WorkspacePlanView;
  narrow: boolean;
}) {
  const layout = spec.layout!;
  // One list at a time when the board itself is narrow (a phone, a thin desk column).
  const boardRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | undefined>();
  useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = width !== undefined ? width < 560 : narrowHint;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>(undefined);
  const [side, setSide] = useState<"selected" | "alternatives">("selected");
  const [swapping, setSwapping] = useState<string | undefined>();
  const first = spec.columns[0]?.key ?? "";
  const label = (key: string) => spec.columns.find((c) => c.key === key)?.label ?? key;
  const details = layout.details ?? spec.columns.slice(1, 4).map((c) => c.key);

  const { selected, alternatives } = useMemo(() => {
    const q = search.trim().toLowerCase();
    // Forgiving on the title ("hot tube" finds "Hot Tub Time Machine"); plain on everything else.
    const match = (i: WorkspaceItem) =>
      !q ||
      `${i.id} ${Object.values(i.values).join(" ")}`.toLowerCase().includes(q) ||
      fuzzyScore(q, String(i.values[first] ?? "")) >= 0.45;
    let list = spec.items.filter(match);
    if (sort)
      list = [...list].sort((a, b) => sort.dir * compare(a.values[sort.key], b.values[sort.key]));
    const sel: WorkspaceItem[] = [];
    const alt: WorkspaceItem[] = [];
    for (const i of list) (choiceOf(i).value === layout.choice ? sel : alt).push(i);
    return { selected: sel, alternatives: alt };
  }, [spec, search, sort, choiceOf, layout.choice, first]);
  const shown = selected.length + alternatives.length;

  // The whole library (11-07): a sheet backed by a Plex searches all of it, not only the
  // titles loaded into the sheet (a sheet holds at most 2,000).
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTyped(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const library = useQuery({
    queryKey: ["home-rows-find", spec.imageService, typed],
    queryFn: () =>
      api<{ titles: LibraryTitle[]; total: number }>(
        "GET",
        `/api/home-rows/find?serviceId=${encodeURIComponent(spec.imageService!)}&q=${encodeURIComponent(typed)}&limit=20`,
      ),
    enabled: Boolean(spec.imageService) && typed.length >= 2,
    staleTime: 60_000,
  });
  const add = useAddToPick(workspaceId);
  /** A library title as one of the sheet's items: its columns filled from what Plex knows. */
  const valuesOf = (t: LibraryTitle) => {
    const v: Record<string, string | number | null> = {};
    for (const c of spec.columns) {
      const k = `${c.key} ${c.label}`.toLowerCase();
      v[c.key] =
        c.key === first || /\b(title|name|film|movie|show)\b/.test(k)
          ? t.title
          : /\byear\b/.test(k)
            ? (t.year ?? null)
            : /genre/.test(k)
              ? (t.genres ?? []).join(", ") || null
              : /rating|score/.test(k)
                ? (t.rating ?? null)
                : /\b(kind|type)\b/.test(k)
                  ? t.kind === "show"
                    ? "Show"
                    : "Movie"
                  : null;
    }
    return v;
  };

  const count = spec.items.filter((i) => choiceOf(i).value === layout.choice).length;
  const target = layout.target;
  const off = target === undefined ? 0 : count - target;
  const nameOf = (i: WorkspaceItem) => String(i.values[first] ?? i.id);

  const card = (i: WorkspaceItem, inSelected: boolean) => {
    const name = nameOf(i);
    const result = plan?.items[i.id];
    const line = details
      .map((k) => {
        const v = i.values[k];
        if (v === null || v === undefined || v === "") return undefined;
        return typeof v === "number" ? `${label(k)} ${v}` : String(v);
      })
      .filter(Boolean)
      .join(" · ");
    const swapSource = swapping === i.id;
    return (
      <li
        key={i.id}
        data-testid="pick-item"
        data-item={i.id}
        data-capture-item
        data-capture-label={name}
        className={cx(
          "flex items-start gap-2 rounded-lg border px-3 py-2 [content-visibility:auto]",
          // Solid behind the words: the window may sit on a theme's moving art.
          swapSource
            ? "border-gold/70 bg-gold/10"
            : "border-line/70 bg-panel/95 hover:border-line-strong",
        )}
      >
        {spec.imageService && i.image && (
          <img
            src={plexArt(spec.imageService, i.image)}
            alt=""
            loading="lazy"
            className="aspect-[2/3] w-10 shrink-0 rounded border border-line object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[0.86rem] text-ink">
            {i.warning && (
              <TriangleAlert
                strokeWidth={1.5}
                className="h-3.5 w-3.5 shrink-0 text-amber"
                aria-label={i.warning}
              />
            )}
            <span className="truncate">{name}</span>
          </p>
          {line && <p className="mt-0.5 line-clamp-2 text-[0.74rem] text-muted">{line}</p>}
          {result && (
            <span className="mt-1 inline-block">
              <ItemBadge status={result.status} result={result.result} />
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {inSelected ? (
            <>
              <button
                type="button"
                aria-label={swapSource ? `Cancel swapping ${name}` : `Swap ${name}`}
                aria-pressed={swapSource}
                title="Swap with an alternative"
                onClick={() => {
                  setSwapping(swapSource ? undefined : i.id);
                  if (narrow && !swapSource) setSide("alternatives");
                }}
                className={cx(
                  "flex h-8 w-8 items-center justify-center rounded-md border",
                  swapSource ? "border-gold/70 text-gold" : "border-line text-muted hover:text-ink",
                )}
              >
                <ArrowLeftRight strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                title="Remove from the selection"
                onClick={() => {
                  if (swapSource) setSwapping(undefined);
                  choose({ [i.id]: layout.other });
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted hover:border-warn/60 hover:text-warn"
              >
                <Minus strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
            </>
          ) : swapping ? (
            <button
              type="button"
              aria-label={`Swap in ${name}`}
              onClick={() => {
                choose({ [swapping]: layout.other, [i.id]: layout.choice });
                setSwapping(undefined);
                if (narrow) setSide("selected");
              }}
              className="min-h-8 rounded-md border border-gold/60 px-2 text-[0.74rem] text-gold"
            >
              Swap in
            </button>
          ) : (
            <button
              type="button"
              aria-label={`Add ${name}`}
              title="Add to the selection"
              onClick={() => choose({ [i.id]: layout.choice })}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted hover:border-ok/60 hover:text-ok"
            >
              <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </li>
    );
  };

  const column = (which: "selected" | "alternatives") => {
    const list = which === "selected" ? selected : alternatives;
    return (
      <section
        aria-label={which === "selected" ? "Selected" : "Alternatives"}
        data-testid={which === "selected" ? "pick-selected" : "pick-alternatives"}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {!narrow && (
          <h3 className="px-1 pb-1.5 text-[0.76rem] tracking-wide text-faint uppercase">
            {which === "selected"
              ? `Selected ${count}`
              : `Alternatives ${spec.items.length - count}`}
            {search && ` · ${list.length} shown`}
          </h3>
        )}
        {list.length === 0 ? (
          <p className="px-1 py-6 text-center text-[0.82rem] text-faint">
            {search
              ? spec.imageService
                ? "Not in this list. See From your library below."
                : "Nothing matches."
              : which === "selected"
                ? "Nothing selected yet."
                : "No alternatives left."}
          </p>
        ) : (
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {list.map((i) => card(i, which === "selected"))}
          </ul>
        )}
      </section>
    );
  };

  return (
    <div
      ref={boardRef}
      className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-3"
      data-testid="pick-board"
      data-narrow={narrow ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p
          data-testid="pick-count"
          role="status"
          className={cx(
            "rounded-full border px-3 py-1 text-[0.8rem] tabular-nums",
            target === undefined || off === 0 ? "border-ok/50 text-ok" : "border-warn/50 text-warn",
          )}
        >
          {target === undefined
            ? `${count} selected`
            : `${count} of ${target} selected${off < 0 ? `: ${-off} to go` : off > 0 ? `: ${off} over` : ""}`}
        </p>
        {swapping && (
          <p className="text-[0.78rem] text-gold" role="status">
            Choose an alternative to swap in for{" "}
            {nameOf(spec.items.find((i) => i.id === swapping)!)}.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="flex min-h-10 min-w-[12rem] flex-1 items-center gap-2 rounded-lg border border-line-strong bg-bg px-3 focus-within:border-gold">
          <Search strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
          <span className="sr-only">Search titles</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search or filter (title, year, genre...)"
            className="min-w-0 flex-1 bg-transparent text-[0.86rem] text-ink placeholder:text-faint focus:outline-none"
          />
        </label>
        <label className="flex min-h-10 items-center gap-2 text-[0.78rem] text-muted">
          <span>Sort</span>
          <select
            aria-label="Sort by"
            value={sort ? `${sort.key}:${sort.dir}` : ""}
            onChange={(e) => {
              const [k, d] = e.target.value.split(":");
              setSort(k ? { key: k, dir: d === "-1" ? -1 : 1 } : undefined);
            }}
            className="min-h-10 rounded-lg border border-line-strong bg-bg px-2 text-[0.8rem] text-ink"
          >
            <option value="">As listed</option>
            {spec.columns.flatMap((c) => [
              <option key={`${c.key}:1`} value={`${c.key}:1`}>
                {c.label} (low to high)
              </option>,
              <option key={`${c.key}:-1`} value={`${c.key}:-1`}>
                {c.label} (high to low)
              </option>,
            ])}
          </select>
        </label>
      </div>
      {search.trim() && (
        <p className="flex flex-wrap items-center gap-2 text-[0.78rem] text-muted" role="status">
          Showing {shown} of {spec.items.length}
          <button
            type="button"
            onClick={() => setSearch("")}
            className="inline-flex min-h-8 items-center gap-1 rounded-md border border-line px-2 text-[0.76rem] text-gold hover:border-gold/60"
            data-testid="pick-clear-search"
          >
            <X strokeWidth={1.5} className="h-3.5 w-3.5" /> Clear search
          </button>
        </p>
      )}
      {narrow && (
        <div className="flex gap-1.5" role="tablist" aria-label="Show">
          {(["selected", "alternatives"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              onClick={() => setSide(s)}
              className={cx(
                "min-h-9 flex-1 rounded-lg border text-[0.8rem] tabular-nums",
                side === s ? "border-gold/60 text-gold" : "border-line text-muted",
              )}
            >
              {s === "selected" ? `Selected ${count}` : `Alternatives ${spec.items.length - count}`}
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-[16rem] flex-1 gap-3">
        {narrow ? (
          column(side)
        ) : (
          <>
            {column("selected")}
            {column("alternatives")}
          </>
        )}
      </div>
      {spec.imageService && typed.length >= 2 && (
        <section
          aria-label="From your library"
          className="rounded-lg border border-gold/30 p-2"
          data-testid="pick-library"
        >
          <h3 className="px-1 pb-1.5 text-[0.76rem] tracking-wide text-gold uppercase">
            From your library
            {library.data ? ` · ${library.data.titles.length} found` : ""}
          </h3>
          {library.isLoading ? (
            <p className="px-1 py-3 text-[0.8rem] text-faint">Searching your library…</p>
          ) : library.isError ? (
            <p className="px-1 py-3 text-[0.8rem] text-amber" role="alert">
              {(library.error as Error).message}
            </p>
          ) : !library.data?.titles.length ? (
            <p className="px-1 py-3 text-[0.8rem] text-faint">
              Nothing in your library matches &ldquo;{typed}&rdquo;.
            </p>
          ) : (
            <ul className="grid max-h-80 gap-1.5 overflow-y-auto pr-1">
              {library.data.titles.map((t) => {
                const inList = spec.items.find((i) => i.id === t.ratingKey);
                const isSelected = inList && choiceOf(inList).value === layout.choice;
                return (
                  <li
                    key={t.ratingKey}
                    className="flex items-center gap-2 rounded-lg border border-line/70 px-2.5 py-1.5"
                    data-testid="pick-library-item"
                  >
                    {t.thumb && (
                      <img
                        src={plexArt(spec.imageService!, t.thumb)}
                        alt=""
                        loading="lazy"
                        className="aspect-[2/3] w-9 shrink-0 rounded border border-line object-cover"
                        onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.84rem] text-ink">{t.title}</span>
                      <span className="block text-[0.72rem] text-faint">
                        {[t.year, t.kind === "show" ? "Show" : "Movie"].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {isSelected ? (
                      <span className="inline-flex items-center gap-1 text-[0.74rem] text-ok">
                        <Check strokeWidth={1.75} className="h-3.5 w-3.5" /> Already selected
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={add.isPending}
                        onClick={() =>
                          inList
                            ? choose({ [inList.id]: layout.choice })
                            : add.mutate({
                                id: t.ratingKey,
                                values: valuesOf(t),
                                ...(t.thumb ? { image: t.thumb } : {}),
                              })
                        }
                        className="inline-flex min-h-8 items-center gap-1 rounded-md border border-ok/50 px-2 text-[0.76rem] text-ok hover:bg-ok/10 disabled:opacity-50"
                        aria-label={`Add ${t.title} to the selection`}
                        data-testid="pick-library-add"
                      >
                        <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
                        {inList ? "Select" : "Add"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {add.isError && (
            <p className="px-1 pt-1 text-[0.78rem] text-amber" role="alert">
              {(add.error as Error).message}
            </p>
          )}
        </section>
      )}
      {spec.imageService && typed.length >= 2 && (
        <RequestMissing workspaceId={workspaceId} typed={typed} />
      )}
      {spec.imageService && (
        <CuratorPicks workspaceId={workspaceId} spec={spec} count={count} target={target} />
      )}
    </div>
  );
}
