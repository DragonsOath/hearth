import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { ArrDashboard } from "../ArrDashboard";
import { cx } from "../../ui";
import { useServarr, useRadarr } from "./data";
import {
  EVENT_WORDS,
  Guard,
  LoadError,
  Loading,
  Pager,
  ProposeError,
  SubNav,
  btnBad,
  inputAuto,
  usePropose,
  when,
} from "./common";
import { ImportFiles } from "./RadarrSizes";
import { SonarrImport } from "../sonarr/SonarrImport";
import { LidarrImport } from "../lidarr/LidarrWanted";

/**
 * Radarr's Activity tab: what is downloading now (the queue, with stuck and failed downloads and
 * their fixes, the download trail and recent imports, shared with Sonarr's panel), Radarr's whole
 * history with a filter, and the blocklist with Remove; Import files brings in files Radarr found in a
 * folder (manual import). Address: "queue", "import", "history", "blocklist".
 */

type Part = "queue" | "import" | "history" | "blocklist";
const PARTS: Part[] = ["queue", "import", "history", "blocklist"];

const EVENTS = [
  { value: "", label: "Everything" },
  { value: "1", label: "Grabbed" },
  { value: "3", label: "Imported" },
  { value: "4", label: "Download failed" },
  { value: "6", label: "File deleted" },
];
/** Lidarr numbers its history events differently. */
const LIDARR_EVENTS = [
  { value: "", label: "Everything" },
  { value: "1", label: "Grabbed" },
  { value: "8", label: "Imported" },
  { value: "4", label: "Download failed" },
  { value: "5", label: "File deleted" },
];

export function RadarrActivity({ serviceId, name, sub, onSub }: AppViewProps) {
  const w = useServarr();
  const head = (sub ?? "").split("/")[0] as Part;
  // Lidarr's queue is on its Overview (the music dashboard), so its Activity starts at Import files.
  const lidarr = w.app === "lidarr";
  const part: Part =
    PARTS.includes(head) && !(lidarr && head === "queue") ? head : lidarr ? "import" : "queue";
  return (
    <div className="space-y-3" data-testid="radarr-activity">
      <SubNav
        label="Activity"
        target="activity"
        value={part}
        onChange={(p) => onSub?.(p === (lidarr ? "import" : "queue") ? null : p)}
        options={[
          ...(lidarr ? [] : [{ value: "queue" as const, label: "Queue" }]),
          { value: "import", label: "Import files" },
          { value: "history", label: "History" },
          { value: "blocklist", label: "Blocklist" },
        ]}
      />
      {part === "queue" && (
        <ArrDashboard
          serviceId={serviceId}
          name={name}
          bare
          views={["queue", "trail", "recent"]}
          section={(sub ?? "").split("/")[1] ?? null}
          onSection={(s) => onSub?.(s === "queue" ? null : `queue/${s}`)}
        />
      )}
      {part === "import" &&
        (w.app === "sonarr" ? (
          <SonarrImport serviceId={serviceId} />
        ) : lidarr ? (
          <LidarrImport serviceId={serviceId} />
        ) : (
          <ImportFiles serviceId={serviceId} />
        ))}
      {part === "history" && <History serviceId={serviceId} />}
      {part === "blocklist" && <Blocklist serviceId={serviceId} />}
    </div>
  );
}

function History({ serviceId }: { serviceId: string }) {
  const [page, setPage] = useState(1);
  const [event, setEvent] = useState("");
  const q = useRadarr(serviceId, "history", { page, event });
  const events = useServarr().app === "lidarr" ? LIDARR_EVENTS : EVENTS;
  return (
    <div className="space-y-2" data-testid="radarr-history">
      <select
        aria-label="Show events"
        value={event}
        onChange={(e) => {
          setEvent(e.target.value);
          setPage(1);
        }}
        className={inputAuto}
        data-hearth-target="history:filter"
      >
        {events.map((e) => (
          <option key={e.value} value={e.value}>
            {e.label}
          </option>
        ))}
      </select>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <LoadError error={q.error} />
      ) : q.data.records.length === 0 ? (
        <p className="text-[0.84rem] text-muted">Nothing here.</p>
      ) : (
        <>
          <ul className="divide-y divide-line rounded-xl border border-line text-[0.8rem]">
            {q.data.records.map((h) => (
              <li key={h.id} className="px-3 py-2" data-capture-item data-capture-label={h.item}>
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className={cx("text-ink", h.event === "downloadFailed" && "text-alert")}>
                    {EVENT_WORDS[h.event] ?? h.event}
                  </span>
                  <span className="text-ink">
                    {h.item}
                    {h.year ? ` (${h.year})` : ""}
                  </span>
                  <span className="text-faint">{when(h.date)}</span>
                </p>
                <p className="break-all text-muted">
                  {[
                    h.release,
                    h.quality,
                    h.formats.length ? `${h.formats.join(", ")} (${h.score})` : "",
                    h.indexer,
                    h.client,
                    h.message,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
          <Pager
            page={q.data.page}
            pageSize={q.data.pageSize}
            total={q.data.total}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}

function Blocklist({ serviceId }: { serviceId: string }) {
  const w = useServarr();
  const [page, setPage] = useState(1);
  const q = useRadarr(serviceId, "blocklist", { page });
  const act = usePropose(serviceId);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-2" data-testid="radarr-blocklist">
        <p className="text-[0.8rem] text-muted">
          Releases {w.name} will not download again (usually after a failed download).
        </p>
        {q.data.records.length === 0 ? (
          <p className="text-[0.84rem] text-muted">The blocklist is empty.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line text-[0.8rem]">
            {q.data.records.map((b) => (
              <li key={b.id} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-ink">{b.item}</p>
                  <p className="break-all text-muted">
                    {[b.release, b.quality, b.indexer, b.message].filter(Boolean).join(" · ")}
                  </p>
                  <p className="text-faint">{when(b.date)}</p>
                </div>
                <button
                  type="button"
                  className={btnBad}
                  disabled={!act.can || act.busy}
                  data-hearth-target={`blocklist:remove:${b.id}`}
                  onClick={() =>
                    act.propose(
                      "app-arr-delete",
                      { resource: "blocklist", id: b.id },
                      `Remove ${b.release ?? "a release"} from ${w.name}'s blocklist`,
                    )
                  }
                >
                  <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
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
  );
}
