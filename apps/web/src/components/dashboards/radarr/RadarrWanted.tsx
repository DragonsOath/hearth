import { useState } from "react";
import { Search } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { useRadarr } from "./data";
import {
  Guard,
  LoadError,
  Loading,
  Pager,
  Poster,
  ProposeError,
  SubNav,
  btn,
  btnGold,
  usePropose,
} from "./common";

/**
 * Radarr's Wanted tab: monitored movies with no file yet (Missing) and movies whose file is below
 * the quality their profile upgrades until (Below cutoff). Search one, or all of them at once.
 * Opening a movie goes to its page in Library. Address: "missing" or "cutoff".
 */

type Part = "missing" | "cutoff";

export function RadarrWanted({ serviceId, sub, onSub, onGo }: AppViewProps) {
  const part: Part = sub === "cutoff" ? "cutoff" : "missing";
  const [page, setPage] = useState(1);
  const q = useRadarr(serviceId, part, { page });
  const act = usePropose(serviceId);
  return (
    <div className="space-y-3" data-testid="radarr-wanted">
      <SubNav
        label="Wanted"
        target="wanted"
        value={part}
        onChange={(p) => {
          setPage(1);
          onSub?.(p === "missing" ? null : p);
        }}
        options={[
          { value: "missing", label: "Missing" },
          { value: "cutoff", label: "Below cutoff" },
        ]}
      />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <LoadError error={q.error} />
      ) : (
        <Guard meta={q.data.meta} sample={q.data.sample}>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[0.8rem] text-muted">
                {part === "missing"
                  ? `${q.data.total} monitored movies are released but not downloaded yet.`
                  : `${q.data.total} movies have a file below the quality their profile upgrades until.`}
              </p>
              {q.data.total > 0 && (
                <button
                  type="button"
                  className={btnGold}
                  disabled={!act.can || act.busy}
                  data-hearth-target={`wanted:${part}:search-all`}
                  onClick={() =>
                    act.propose(
                      "app-arr-command",
                      {
                        command:
                          part === "missing" ? "MissingMoviesSearch" : "CutoffUnmetMoviesSearch",
                      },
                      part === "missing"
                        ? "Search for every missing movie in Radarr"
                        : "Search for upgrades of every movie below its cutoff",
                    )
                  }
                >
                  <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search all
                </button>
              )}
            </div>
            {q.data.records.length === 0 ? (
              <p className="rounded-xl border border-line px-4 py-6 text-center text-[0.86rem] text-muted">
                {part === "missing" ? "Nothing missing." : "Everything meets its profile."}
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {q.data.records.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 px-3 py-2"
                    data-capture-item
                    data-capture-label={m.title}
                  >
                    <Poster
                      serviceId={serviceId}
                      poster={m.poster}
                      title={m.title}
                      className="h-12 w-8"
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onGo?.("library", `movie/${m.id}`)}
                      data-hearth-target={`wanted:movie:${m.id}`}
                    >
                      <span className="block truncate text-[0.88rem] text-ink hover:text-gold">
                        {m.title} <span className="text-faint">{m.year}</span>
                      </span>
                      <span className="block truncate text-[0.74rem] text-faint">
                        {[q.data.profiles.find((p) => p.id === m.profileId)?.name, m.quality]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={btn}
                      disabled={!act.can || act.busy}
                      data-hearth-target={`wanted:search:${m.id}`}
                      onClick={() =>
                        act.propose(
                          "app-arr-search",
                          { movieId: m.id },
                          `Search for ${m.title}${m.year ? ` (${m.year})` : ""}`,
                        )
                      }
                    >
                      <Search strokeWidth={1.5} className="h-3.5 w-3.5" /> Search
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Pager
              page={q.data.page}
              pageSize={q.data.pageSize}
              total={q.data.total}
              onPage={setPage}
            />
            <ProposeError error={act.error} />
            {act.dialog}
          </div>
        </Guard>
      )}
    </div>
  );
}
