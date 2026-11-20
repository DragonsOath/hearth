import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { useHomeRowOptions, useHomeRowSearch } from "../../data/homeRows";
import { plexArt } from "../../data/dashboards";
import { ChangeCard, useConfirmedChange } from "../dashboards/ConfirmedChange";

/**
 * Add one title to a Plex collection by hand (11-10: "I downloaded Anna and the Apocalypse and
 * want it in my Christmas Favorites row, and there is no way to do that"). Type a few letters,
 * pick the title, approve: the same plan step Ember uses (collection-add), read back from the
 * collection's members. The title must be in the same library as the collection.
 */
export function AddTitleToCollection({
  serviceId,
  libraryId,
  collection,
  rowId,
}: {
  serviceId: string;
  libraryId: string;
  collection: string;
  /** One of Ember's rows of hand-picked titles: the title joins the row too, so it stays. */
  rowId?: string;
}) {
  const [q, setQ] = useState("");
  const found = useHomeRowSearch(serviceId, libraryId, q);
  const c = useConfirmedChange(serviceId);
  const titles = q.trim().length >= 2 ? (found.data?.titles ?? []) : [];
  return (
    <div className="space-y-2" data-testid="add-title">
      <p className="text-[0.72rem] font-bold tracking-wider text-muted uppercase">Add a title</p>
      <label className="flex min-h-10 items-center gap-2 rounded-lg border border-line-strong bg-raised px-2.5 focus-within:border-gold">
        <Search className="h-4 w-4 shrink-0 text-faint" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search this library…"
          aria-label={`Find a title to add to ${collection}`}
          className="min-w-0 flex-1 bg-transparent text-[0.86rem] text-ink outline-none"
          data-testid="add-title-search"
        />
      </label>
      {titles.length > 0 && (
        <ul className="max-h-56 space-y-1 overflow-y-auto" data-testid="add-title-results">
          {titles.slice(0, 8).map((t) => (
            <li key={t.ratingKey}>
              <button
                type="button"
                disabled={c.busy}
                onClick={() =>
                  void c.propose(
                    "app-plex-control",
                    rowId
                      ? { op: "home-row-apply", rowId, addTitle: t.ratingKey }
                      : { op: "collection-add", ratingKey: t.ratingKey, collection },
                    `Add ${t.title} to “${collection}”`,
                  )
                }
                className="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-line px-2 py-1 text-left hover:border-gold/60 disabled:opacity-50"
                data-testid="add-title-pick"
              >
                {t.thumb ? (
                  <img
                    src={plexArt(serviceId, t.thumb)}
                    alt=""
                    loading="lazy"
                    className="aspect-[2/3] w-7 shrink-0 rounded object-cover"
                  />
                ) : (
                  <span className="aspect-[2/3] w-7 shrink-0 rounded bg-line" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-[0.85rem] text-ink">
                  {t.title}
                  {t.year ? <span className="text-faint"> ({t.year})</span> : null}
                </span>
                <Plus className="h-4 w-4 shrink-0 text-gold" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && found.isSuccess && !titles.length && (
        <p className="text-[0.78rem] text-faint">Nothing in this library by that name.</p>
      )}
      <ChangeCard c={c} confirmLabel="Add it" />
    </div>
  );
}

/**
 * From a title in the Plex panel: put it in one of its library's collections (or a new one by
 * name). Movies and shows only; the same approved plan step as from Home rows.
 */
export function AddToCollection({
  serviceId,
  libraryId,
  ratingKey,
  title,
  propose,
  busy,
}: {
  serviceId: string;
  libraryId: string;
  ratingKey: string;
  title: string;
  propose: (step: "app-plex-control", params: Record<string, string>, label: string) => unknown;
  busy: boolean;
}) {
  const options = useHomeRowOptions(serviceId);
  const [name, setName] = useState("");
  const list = options.data?.collections[libraryId] ?? [];
  const pick = name.trim();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pick) return;
        void propose(
          "app-plex-control",
          { op: "collection-add", ratingKey, collection: pick },
          `Add ${title} to “${pick}”`,
        );
      }}
      data-testid="plex-add-to-collection"
    >
      <label className="flex min-w-0 flex-1 basis-52 flex-col gap-1 text-[0.78rem] text-muted">
        Add to a collection
        <input
          list={`collections-${libraryId}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={list[0] ? `e.g. ${list[0].title}` : "Collection name"}
          maxLength={120}
          className="min-h-10 rounded-lg border border-line-strong bg-raised px-2.5 text-[0.86rem] text-ink"
          data-testid="plex-collection-name"
        />
        <datalist id={`collections-${libraryId}`}>
          {list.map((c) => (
            <option key={c.key} value={c.title} />
          ))}
        </datalist>
      </label>
      <button
        type="submit"
        disabled={busy || !pick}
        className="mt-5 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-gold/50 px-3 text-[0.84rem] text-gold hover:bg-gold/10 disabled:opacity-50"
        data-testid="plex-collection-add"
      >
        <Plus className="h-4 w-4" aria-hidden /> Add
      </button>
      {pick && !list.some((c) => c.title.toLowerCase() === pick.toLowerCase()) && (
        <p className="w-full text-[0.76rem] text-faint">
          No collection by that name yet: adding {title} makes it.
        </p>
      )}
    </form>
  );
}
