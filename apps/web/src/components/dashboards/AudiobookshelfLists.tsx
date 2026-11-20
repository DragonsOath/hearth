import { createContext, useContext, useState } from "react";
import { ArrowDown, ArrowUp, ListPlus, Minus, Plus } from "lucide-react";
import type {
  AudiobookshelfBook,
  AudiobookshelfDashboard as Data,
  AudiobookshelfList,
} from "@dragon-control/core";
import { cx } from "../ui";
import { ChangeCard, useConfirmedChange } from "./ConfirmedChange";

/**
 * Your Audiobookshelf lists from the panel (11-06: "create playlists, move books around,
 * take them out, including a TBR"). Every change is a plan you confirm here; Hearth makes it in
 * Audiobookshelf and reads the list back.
 */

export interface ListsContext {
  serviceId: string;
  lists: AudiobookshelfList[];
  libraries: Data["libraries"];
}
export const AbsLists = createContext<ListsContext | undefined>(undefined);

const ref = (l: { kind: string; id: string }) => `${l.kind}:${l.id}`;
const kindWord = (l: AudiobookshelfList) => (l.kind === "playlist" ? "playlist" : "collection");
const control =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-muted hover:border-gold/60 hover:text-gold disabled:opacity-50";
const field =
  "min-h-9 rounded-lg border border-line-strong bg-bg px-2 text-[0.8rem] text-ink focus-visible:border-gold";

/** Under an open book: add it to a list (or the TBR), and when it sits in one, move or take it out. */
export function BookListActions({
  book,
  inList,
}: {
  book: AudiobookshelfBook;
  /** The list this book was opened from, if it is one of yours. */
  inList?: { id: string; kind: "playlist" | "collection" };
}) {
  const ctx = useContext(AbsLists);
  const c = useConfirmedChange(ctx?.serviceId ?? "");
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  if (!ctx || !book.id) return null;
  const id = book.id;
  const name0 = book.name ?? book.title;
  const here = inList
    ? ctx.lists.find((l) => l.id === inList.id && l.kind === inList.kind)
    : undefined;
  const at = here ? here.books.findIndex((b) => b.id === id) : -1;
  const addable = ctx.lists.filter((l) => !l.books.some((b) => b.id === id));
  const tbr = ctx.lists.find((l) => l.tbr);
  const bookLibs = ctx.libraries.filter((l) => l.kind === "books");
  const libraryId = here?.libraryId || bookLibs[0]?.id || "";
  const propose = (params: Record<string, string>, title: string) =>
    void c.propose("app-audiobookshelf-control", params, title);
  return (
    <div className="space-y-2 border-t border-line pt-2" data-testid="abs-book-lists">
      <div className="flex flex-wrap items-center gap-2">
        {tbr && !tbr.books.some((b) => b.id === id) && (
          <button
            type="button"
            className={control}
            data-testid="abs-add-tbr"
            disabled={c.busy}
            onClick={() =>
              propose({ op: "list-add", list: ref(tbr), itemId: id }, `Add ${name0} to ${tbr.name}`)
            }
          >
            <Plus className="h-3.5 w-3.5" /> Add to {tbr.name}
          </button>
        )}
        {!tbr && (
          <button
            type="button"
            className={control}
            data-testid="abs-start-tbr"
            disabled={c.busy || !libraryId}
            onClick={() =>
              propose(
                { op: "list-create", newName: "TBR", libraryId, itemId: id },
                `Start a TBR playlist with ${name0}`,
              )
            }
          >
            <Plus className="h-3.5 w-3.5" /> Start a TBR list with it
          </button>
        )}
        <label className="inline-flex items-center gap-1.5 text-[0.76rem] text-muted">
          <ListPlus className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Add to a list</span>
          <select
            className={field}
            data-testid="abs-add-to"
            value=""
            disabled={c.busy}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "new") return setNaming(true);
              const l = addable.find((x) => ref(x) === v);
              if (l) propose({ op: "list-add", list: v, itemId: id }, `Add ${name0} to ${l.name}`);
            }}
          >
            <option value="">Add to a list…</option>
            {addable.map((l) => (
              <option key={ref(l)} value={ref(l)}>
                {l.name} ({kindWord(l)})
              </option>
            ))}
            <option value="new">New playlist with this book…</option>
          </select>
        </label>
      </div>
      {naming && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            propose(
              { op: "list-create", newName: name.trim(), libraryId, itemId: id },
              `Make the playlist ${name.trim()}`,
            );
            setNaming(false);
            setName("");
          }}
        >
          <input
            className={cx(field, "min-w-0 flex-1")}
            aria-label="New playlist's name"
            placeholder="Playlist name"
            maxLength={100}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="abs-new-name"
          />
          <button type="submit" className={control} disabled={!name.trim()}>
            Make it
          </button>
          <button type="button" className={control} onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      )}
      {here && at >= 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="abs-in-list">
          <span className="text-[0.74rem] text-faint">
            In {here.name}, {at + 1} of {here.books.length}:
          </span>
          <button
            type="button"
            className={control}
            aria-label={`Move ${name0} up in ${here.name}`}
            disabled={c.busy || at === 0}
            onClick={() =>
              propose(
                { op: "list-order", list: ref(here), itemId: id, direction: "up" },
                `Move ${name0} up`,
              )
            }
          >
            <ArrowUp className="h-3.5 w-3.5" /> Up
          </button>
          <button
            type="button"
            className={control}
            aria-label={`Move ${name0} down in ${here.name}`}
            disabled={c.busy || at === here.books.length - 1}
            onClick={() =>
              propose(
                { op: "list-order", list: ref(here), itemId: id, direction: "down" },
                `Move ${name0} down`,
              )
            }
          >
            <ArrowDown className="h-3.5 w-3.5" /> Down
          </button>
          <select
            className={field}
            aria-label={`Move ${name0} to another list`}
            data-testid="abs-move-to"
            value=""
            disabled={c.busy}
            onChange={(e) => {
              const l = addable.find((x) => ref(x) === e.target.value);
              if (l)
                propose(
                  { op: "list-move", list: ref(here), toList: ref(l), itemId: id },
                  `Move ${name0} to ${l.name}`,
                );
            }}
          >
            <option value="">Move to…</option>
            {addable.map((l) => (
              <option key={ref(l)} value={ref(l)}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={control}
            data-testid="abs-take-out"
            disabled={c.busy}
            onClick={() =>
              propose(
                { op: "list-remove", list: ref(here), itemId: id },
                `Take ${name0} out of ${here.name}`,
              )
            }
          >
            <Minus className="h-3.5 w-3.5" /> Take out of {here.name}
          </button>
        </div>
      )}
      <ChangeCard c={c} />
    </div>
  );
}

/** A new playlist from the lists section: its name, its library, and its first book. */
export function NewPlaylist({ books }: { books: AudiobookshelfBook[] }) {
  const ctx = useContext(AbsLists);
  const c = useConfirmedChange(ctx?.serviceId ?? "");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [first, setFirst] = useState("");
  const bookLibs = (ctx?.libraries ?? []).filter((l) => l.kind === "books");
  const [lib, setLib] = useState(bookLibs[0]?.id ?? "");
  if (!ctx) return null;
  const choices = books.filter((b, i, all) => b.id && all.findIndex((x) => x.id === b.id) === i);
  return (
    <div className="space-y-2">
      {!open ? (
        <button
          type="button"
          className={control}
          onClick={() => setOpen(true)}
          data-testid="abs-new-playlist"
        >
          <Plus className="h-3.5 w-3.5" /> New playlist
        </button>
      ) : (
        <form
          className="grid gap-2 rounded-xl border border-line bg-bg/50 p-3 @md:grid-cols-[1fr_1fr_auto]"
          data-testid="abs-new-playlist-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || !first) return;
            void c.propose(
              "app-audiobookshelf-control",
              { op: "list-create", newName: name.trim(), libraryId: lib, itemId: first },
              `Make the playlist ${name.trim()}`,
            );
            setOpen(false);
            setName("");
            setFirst("");
          }}
        >
          <input
            className={field}
            aria-label="Playlist name"
            placeholder="Name (TBR makes it your to-be-read list)"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className={field}
            aria-label="First book"
            value={first}
            onChange={(e) => setFirst(e.target.value)}
          >
            <option value="">First book…</option>
            {choices.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name ?? b.title}
              </option>
            ))}
          </select>
          {bookLibs.length > 1 && (
            <select
              className={field}
              aria-label="Library"
              value={lib}
              onChange={(e) => setLib(e.target.value)}
            >
              {bookLibs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <button type="submit" className={control} disabled={!name.trim() || !first}>
              Make it
            </button>
            <button type="button" className={control} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <p className="text-[0.72rem] text-faint @md:col-span-3">
            Audiobookshelf keeps a playlist only while it has a book in it, so it starts with one.
            Add more from any book: open it and choose Add to a list.
          </p>
        </form>
      )}
      <ChangeCard c={c} />
    </div>
  );
}
