import { useState } from "react";
import { Search } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import {
  Guard,
  LoadError,
  Loading,
  Pager,
  ProposeError,
  SubNav,
  btn,
  btnGold,
  usePropose,
} from "../radarr/common";
import { airDay, useSonarr } from "./data";

/**
 * Sonarr's Wanted tab: monitored episodes that have aired with no file yet (Missing) and episodes
 * whose file is below the quality their profile upgrades until (Below cutoff). Search one, or all
 * of them at once. Opening one goes to its series in Library. Address: "missing" or "cutoff".
 */

type Part = "missing" | "cutoff";

export function SonarrWanted({ serviceId, sub, onSub, onGo }: AppViewProps) {
  const part: Part = sub === "cutoff" ? "cutoff" : "missing";
  const [page, setPage] = useState(1);
  const q = useSonarr(serviceId, part, { page });
  const act = usePropose(serviceId);
  return (
    <div className="space-y-3" data-testid="sonarr-wanted">
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
                  ? `${q.data.total} monitored episodes have aired but are not downloaded yet.`
                  : `${q.data.total} episodes have a file below the quality their profile upgrades until.`}
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
                          part === "missing" ? "MissingEpisodeSearch" : "CutoffUnmetEpisodeSearch",
                      },
                      part === "missing"
                        ? "Search for every missing episode in Sonarr"
                        : "Search for upgrades of every episode below its cutoff",
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
                {q.data.records.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-3 px-3 py-2"
                    data-testid="sonarr-wanted-episode"
                    data-capture-item
                    data-capture-label={`${e.series} ${e.code}`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => e.seriesId && onGo?.("library", `series/${e.seriesId}`)}
                      data-hearth-target={`wanted:episode:${e.id}`}
                    >
                      <span className="block truncate text-[0.88rem] text-ink hover:text-gold">
                        {e.series} <span className="text-gold">{e.code}</span>
                      </span>
                      <span className="block truncate text-[0.74rem] text-faint">
                        {[e.title, airDay(e.airDate), e.quality].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={btn}
                      disabled={!act.can || act.busy}
                      data-hearth-target={`wanted:search:${e.id}`}
                      onClick={() =>
                        act.propose(
                          "app-arr-command",
                          { command: "EpisodeSearch", episodeIds: String(e.id) },
                          `Search for ${e.series} ${e.code}`,
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
