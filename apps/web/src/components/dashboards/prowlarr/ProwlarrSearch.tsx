import { useState } from "react";
import { Download, ExternalLink, Search } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { cx } from "../../ui";
import {
  Check,
  Guard,
  LoadError,
  Loading,
  ProposeError,
  btn,
  btnGold,
  gb,
  input,
  inputAuto,
  usePropose,
} from "../radarr/common";
import { useProwlarr, type SearchResult } from "./data";

/**
 * Prowlarr's Search tab: one search across its indexers (all, or the ones you tick), by kind
 * (anything, movies, TV), with results by seeders, size or age; sending one to the download
 * client is a plan you approve. Download links never reach this page (they carry keys).
 */

const KINDS = [
  { value: "search", label: "Anything" },
  { value: "movie", label: "Movies" },
  { value: "tvsearch", label: "TV" },
];
type Sort = "seeders" | "size" | "age";

export function ProwlarrSearch({ serviceId }: AppViewProps) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("search");
  const [picked, setPicked] = useState<number[]>([]);
  const [sort, setSort] = useState<Sort>("seeders");
  const q = useProwlarr(serviceId, "search", {
    query,
    type,
    indexerIds: picked.join(","),
  });
  const act = usePropose(serviceId);
  if (q.isPending && !query) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const d = q.data;
  const results = [...(d?.results ?? [])].sort((a, b) =>
    sort === "seeders"
      ? (b.seeders ?? -1) - (a.seeders ?? -1)
      : sort === "size"
        ? b.size - a.size
        : (a.ageHours ?? 0) - (b.ageHours ?? 0),
  );
  const grab = (r: SearchResult) =>
    act.propose(
      "app-arr-command",
      {
        command: "GrabRelease",
        guid: r.guid,
        indexerId: r.indexerId,
        releaseTitle: r.title,
        size: r.size,
      },
      `Send ${r.title} to the download client`,
    );
  const body = (
    <div className="space-y-3" data-testid="prowlarr-search">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(text.trim());
        }}
      >
        <label className="relative min-w-0 flex-1 basis-56">
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search every indexer"
            aria-label="Search every indexer"
            className={`${input} pl-9`}
            data-hearth-target="search:query"
          />
        </label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          aria-label="What to search for"
          className={inputAuto}
          data-hearth-target="search:type"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <button type="submit" className={btnGold} data-hearth-target="search:go">
          Search
        </button>
      </form>
      {d && d.indexers.length > 1 && (
        <details className="rounded-xl border border-line px-3 py-2">
          <summary className="cursor-pointer text-[0.82rem] text-muted">
            {picked.length ? `${picked.length} indexers chosen` : "All indexers"}
          </summary>
          <div className="mt-2 flex flex-wrap gap-x-4">
            {d.indexers
              .filter((i) => i.enabled)
              .map((i) => (
                <Check
                  key={i.id}
                  checked={picked.includes(i.id)}
                  onChange={(on) =>
                    setPicked((p) => (on ? [...p, i.id] : p.filter((x) => x !== i.id)))
                  }
                  label={i.name}
                  target={`search:indexer:${i.id}`}
                />
              ))}
          </div>
        </details>
      )}
      <ProposeError error={act.error} />
      {act.dialog}
      {!query ? (
        <p className="text-[0.84rem] text-muted">
          Search all your indexers at once, then send a result to the download client.
        </p>
      ) : q.isFetching && results.length === 0 ? (
        <Loading />
      ) : results.length === 0 ? (
        <p className="text-[0.84rem] text-muted">Nothing found for &ldquo;{query}&rdquo;.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[0.78rem] text-faint">
            <span className="mr-auto">
              {results.length} results for &ldquo;{query}&rdquo;
            </span>
            <label className="flex items-center gap-1.5">
              Sort by
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className={inputAuto}
                data-hearth-target="search:sort"
              >
                <option value="seeders">Seeders</option>
                <option value="size">Size</option>
                <option value="age">Newest</option>
              </select>
            </label>
          </div>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {results.map((r) => (
              <li
                key={`${r.indexerId}-${r.guid}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
                data-testid="prowlarr-result"
              >
                <div className="min-w-0 flex-1 basis-64">
                  <p className="text-[0.84rem] break-words text-ink">{r.title}</p>
                  <p className="text-[0.74rem] text-faint">
                    {r.indexer} · {gb(r.size)}
                    {r.age !== undefined ? ` · ${r.age} days old` : ""}
                    {r.categories.length ? ` · ${r.categories.join(", ")}` : ""}
                  </p>
                </div>
                <span
                  className={cx(
                    "text-[0.78rem] tabular",
                    r.protocol === "usenet"
                      ? "text-muted"
                      : (r.seeders ?? 0) === 0
                        ? "text-alert"
                        : "text-ok",
                  )}
                >
                  {r.protocol === "usenet"
                    ? "Usenet"
                    : `${r.seeders ?? 0} seeding${r.leechers !== undefined ? `, ${r.leechers} getting` : ""}`}
                </span>
                {r.info && (
                  <a
                    href={r.info}
                    target="_blank"
                    rel="noreferrer"
                    className={btn}
                    aria-label={`${r.title} on ${r.indexer}`}
                  >
                    <ExternalLink strokeWidth={1.5} className="h-3.5 w-3.5" />
                  </a>
                )}
                <button
                  type="button"
                  className={btn}
                  disabled={!act.can || act.busy}
                  onClick={() => grab(r)}
                  data-hearth-target={`search:grab:${r.guid}`}
                >
                  <Download strokeWidth={1.5} className="h-3.5 w-3.5" /> Download
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
  return d ? (
    <Guard meta={d.meta} sample={d.sample}>
      {body}
    </Guard>
  ) : (
    body
  );
}
