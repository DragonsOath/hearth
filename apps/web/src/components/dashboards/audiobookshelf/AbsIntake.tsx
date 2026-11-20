import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, RefreshCw, Trash2 } from "lucide-react";
import type { IntakeConfig, IntakeJob, IntakeView } from "@dragon-control/core";
import { api } from "../../../data/api";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import type { AppViewProps } from "../../panels/registry";
import { Button, Skeleton, Tag, cx } from "../../ui";

/**
 * Audiobookshelf's Intake tab (the owner, 2026-11-07; his Audiobook Organizer, inside Hearth):
 * finished audiobook downloads are identified and copied into a library as Author/Title, checked
 * file by file, then Audiobookshelf scans. Sure ones go on their own; unsure ones wait here with
 * their names editable. One setup plan, proposed from your own apps.
 */

const KIND = "app-audiobookshelf-control" as const;
const STATUS: Record<IntakeJob["status"], { label: string; tone: "neutral" | "gold" | "warn" }> = {
  review: { label: "Needs you", tone: "warn" },
  ready: { label: "Importing", tone: "neutral" },
  waiting: { label: "Waiting", tone: "neutral" },
  imported: { label: "In your library", tone: "gold" },
  failed: { label: "Failed", tone: "warn" },
  skipped: { label: "Skipped", tone: "neutral" },
};
const field =
  "min-h-10 w-full rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink";

export function AbsIntake({ serviceId, name }: AppViewProps) {
  const qc = useQueryClient();
  const key = ["dashboard", serviceId, "abs-intake"];
  const url = `/api/services/${encodeURIComponent(serviceId)}/dashboard/audiobookshelf/intake`;
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<IntakeView>("GET", url),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  const check = useMutation({
    mutationFn: () => api<IntakeView>("POST", `${url}/check`),
    onSuccess: (v) => qc.setQueryData(key, v),
  });
  const act = useApproveHere(serviceId, "From Audiobookshelf's Intake tab.");
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || !q.data)
    return (
      <p className="text-[0.86rem] text-amber">
        Could not read {name}: {q.error?.message ?? "no answer"}
      </p>
    );
  const v = q.data;
  return (
    <section
      className="@container space-y-4"
      aria-label="Audiobook intake"
      data-testid="abs-intake"
    >
      <ApproveDialog c={act} />
      {v.config ? (
        <Running v={v} config={v.config} name={name} act={act} check={check} />
      ) : v.proposal ? (
        <Setup v={v} proposal={v.proposal} name={name} act={act} />
      ) : (
        <p className="text-[0.86rem] text-amber">{v.error ?? "Could not plan intake yet."}</p>
      )}
      {act.error && <p className="text-[0.8rem] text-amber">{act.error}</p>}
    </section>
  );
}

type Act = ReturnType<typeof useApproveHere>;

function Setup({
  v,
  proposal,
  name,
  act,
}: {
  v: IntakeView;
  proposal: NonNullable<IntakeView["proposal"]>;
  name: string;
  act: Act;
}) {
  const [folders, setFolders] = useState(proposal.intake);
  const [library, setLibrary] = useState(proposal.library);
  const [libraries, setLibraries] = useState(proposal.libraries);
  const [threshold, setThreshold] = useState(Math.round(proposal.threshold * 100));
  const [adding, setAdding] = useState("");
  const review = () => {
    const config: IntakeConfig = {
      ...proposal,
      intake: folders,
      libraries: libraries.map((l) => ({ ...l, folder: l.folder.trim() })),
      library,
      threshold: threshold / 100,
    };
    void act.propose(
      KIND,
      { op: "intake-setup", config: JSON.stringify(config) },
      `Import finished audiobooks into ${name}`,
    );
  };
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gold/30 p-4">
        <h3 className="font-display text-[1.25rem] text-ink">
          Bring finished audiobooks into {name}
        </h3>
        <p className="mt-1 text-[0.86rem] text-muted">
          Hearth watches the folders your audiobooks download to, works out each book&apos;s author
          and title (from its tags, your library and its name), and copies it in as Author / Title,
          checked file by file. {name} then scans. Anything Hearth is unsure of waits here for you.
          Nothing in your downloads is moved, so torrents keep seeding.
        </p>
        {!v.tags && (
          <p className="mt-2 text-[0.8rem] text-amber">
            ffprobe is not installed on this machine, so books are identified from names only and
            more of them will wait for you.
          </p>
        )}
      </div>
      <fieldset className="rounded-xl border border-line p-3">
        <legend className="eyebrow px-1">Watch these download folders</legend>
        <ul className="divide-y divide-line">
          {folders.map((f, i) => (
            <li
              key={f.folder}
              className="flex flex-wrap items-center gap-2 py-2"
              data-testid="abs-intake-folder"
            >
              <span className="min-w-0 flex-1">
                <span className="block break-all font-mono text-[0.8rem] text-ink">{f.folder}</span>
                {f.label && <span className="block text-[0.74rem] text-faint">{f.label}</span>}
              </span>
              <label className="flex items-center gap-1.5 text-[0.78rem] text-muted">
                Remove originals after
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={f.removeAfterDays}
                  onChange={(e) =>
                    setFolders((l) =>
                      l.map((x, j) =>
                        j === i
                          ? { ...x, removeAfterDays: Math.max(0, Number(e.target.value) || 0) }
                          : x,
                      ),
                    )
                  }
                  aria-label={`Days before originals in ${f.folder} are removed (0 keeps them)`}
                  className="min-h-9 w-16 rounded-lg border border-line bg-raised px-2 text-right text-[0.82rem] text-ink"
                />
                days (0 keeps them)
              </label>
              <Button
                tone="quiet"
                aria-label={`Stop watching ${f.folder}`}
                onClick={() => setFolders((l) => l.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Another folder on this machine"
            aria-label="Another download folder to watch"
            className={field}
          />
          <Button
            tone="outline"
            disabled={!adding.trim()}
            onClick={() => {
              setFolders((l) => [...l, { folder: adding.trim(), removeAfterDays: 0 }]);
              setAdding("");
            }}
          >
            <FolderPlus className="h-4 w-4" aria-hidden /> Add
          </Button>
        </div>
      </fieldset>
      <fieldset className="space-y-2 rounded-xl border border-line p-3 text-[0.84rem]">
        <legend className="eyebrow px-1">Into</legend>
        {libraries.map((l, i) => (
          <div
            key={l.id}
            className="flex flex-wrap items-center gap-2"
            data-testid="abs-intake-library"
          >
            <label className="flex min-h-10 items-center gap-2">
              <input
                type="radio"
                name="intake-library"
                className="h-4 w-4"
                checked={library === l.id}
                onChange={() => setLibrary(l.id)}
              />
              {l.name}
            </label>
            {/* Its folder on this machine: Hearth reads it from Audiobookshelf; correct it if needed. */}
            <input
              value={l.folder}
              onChange={(e) =>
                setLibraries((list) =>
                  list.map((x, j) => (j === i ? { ...x, folder: e.target.value } : x)),
                )
              }
              aria-label={`${l.name}'s folder on this machine`}
              className={cx(field, "min-w-0 flex-1 font-mono text-[0.78rem]")}
            />
          </div>
        ))}
        <p className="text-[0.76rem] text-faint">
          You can send any single release to another library when it waits for you.
        </p>
        <label className="flex flex-wrap items-center gap-2">
          Import on its own when Hearth is at least
          <input
            type="number"
            min={50}
            max={100}
            value={threshold}
            onChange={(e) =>
              setThreshold(Math.max(50, Math.min(100, Number(e.target.value) || 80)))
            }
            aria-label="How sure Hearth must be to import on its own, in percent"
            className="min-h-9 w-16 rounded-lg border border-line bg-raised px-2 text-right text-ink"
          />
          % sure
        </label>
      </fieldset>
      {proposal.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[0.78rem] text-faint">
          {proposal.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <Button
        tone="primary"
        disabled={act.busy || !folders.length || !libraries.length}
        onClick={review}
        data-testid="abs-intake-review"
      >
        Review the setup
      </Button>
    </div>
  );
}

function Running({
  v,
  config,
  name,
  act,
  check,
}: {
  v: IntakeView;
  config: IntakeConfig;
  name: string;
  act: Act;
  check: { mutate: () => void; isPending: boolean };
}) {
  const waiting = v.jobs.filter((j) => j.status === "review" || j.status === "failed");
  const rest = v.jobs.filter((j) => j.status !== "review" && j.status !== "failed");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3">
        <span
          className={cx("h-2.5 w-2.5 rounded-full", config.enabled ? "bg-live" : "bg-line-strong")}
          aria-hidden
        />
        <p className="min-w-[14rem] flex-1 text-[0.86rem] text-ink" data-testid="abs-intake-state">
          {config.enabled
            ? `Watching ${config.intake.length} folder${config.intake.length === 1 ? "" : "s"}; books at least ${Math.round(config.threshold * 100)}% sure go in on their own.`
            : "Intake is off."}
        </p>
        <Button
          tone="quiet"
          onClick={() => check.mutate()}
          disabled={check.isPending}
          data-testid="abs-intake-check"
        >
          <RefreshCw className={cx("h-4 w-4", check.isPending && "animate-spin")} aria-hidden />{" "}
          Check now
        </Button>
        {config.enabled ? (
          <Button
            tone="outline"
            disabled={act.busy}
            onClick={() =>
              void act.propose(KIND, { op: "intake-off" }, `Stop audiobook intake for ${name}`)
            }
          >
            Turn off
          </Button>
        ) : (
          <Button
            tone="primary"
            disabled={act.busy}
            onClick={() =>
              void act.propose(
                KIND,
                { op: "intake-setup", config: JSON.stringify(config) },
                `Import finished audiobooks into ${name}`,
              )
            }
          >
            Turn on again
          </Button>
        )}
      </div>
      {waiting.length > 0 && (
        <div
          className="space-y-2 rounded-xl border border-warn/40 p-3"
          data-testid="abs-intake-waiting"
        >
          <p className="eyebrow text-warn">Waiting for you ({waiting.length})</p>
          {waiting.map((j) => (
            <Waiting key={j.id} job={j} config={config} act={act} />
          ))}
        </div>
      )}
      <div className="rounded-xl border border-line p-3">
        <p className="eyebrow mb-1">Releases</p>
        {rest.length ? (
          <ul className="divide-y divide-line" data-testid="abs-intake-history">
            {rest.map((j) => (
              <li key={j.id} className="space-y-0.5 py-2.5" data-testid="abs-intake-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[0.86rem] text-ink" title={j.name}>
                    {j.books.length === 1 ? `${j.books[0]!.author}, ${j.books[0]!.title}` : j.name}
                  </span>
                  <Tag tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Tag>
                </div>
                <p className="text-[0.78rem] text-muted">{j.message}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.84rem] text-muted">
            Nothing yet. A finished release shows here a few minutes after it lands.
          </p>
        )}
      </div>
    </div>
  );
}

function Waiting({ job, config, act }: { job: IntakeJob; config: IntakeConfig; act: Act }) {
  const [books, setBooks] = useState(job.books.map((b) => ({ author: b.author, title: b.title })));
  const [library, setLibrary] = useState(job.library || config.library);
  const set = (i: number, k: "author" | "title", value: string) =>
    setBooks((l) => l.map((b, j) => (j === i ? { ...b, [k]: value } : b)));
  return (
    <div className="space-y-2 rounded-lg border border-line p-3" data-testid="abs-intake-job">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-all text-[0.86rem] text-ink">{job.name}</span>
        <Tag tone={STATUS[job.status].tone}>{STATUS[job.status].label}</Tag>
      </div>
      <p className="text-[0.78rem] text-muted">{job.message}</p>
      {job.books.map((b, i) => (
        <div key={b.source} className="grid gap-2 @md:grid-cols-[1fr_1fr_auto]">
          <input
            value={books[i]!.author}
            onChange={(e) => set(i, "author", e.target.value)}
            aria-label={`Author of ${b.title}`}
            className={field}
          />
          <input
            value={books[i]!.title}
            onChange={(e) => set(i, "title", e.target.value)}
            aria-label={`Title (${b.tracks} file${b.tracks === 1 ? "" : "s"})`}
            className={field}
          />
          <span className="self-center text-[0.74rem] text-faint" title={b.reasons.join("; ")}>
            {Math.round(b.confidence * 100)}% sure
          </span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {config.libraries.length > 1 && (
          <select
            value={library}
            onChange={(e) => setLibrary(e.target.value)}
            aria-label="Library"
            className="min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.82rem] text-ink"
          >
            {config.libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <Button
          tone="primary"
          disabled={act.busy}
          onClick={() =>
            void act.propose(
              KIND,
              { op: "intake-import", job: job.id, library, books: JSON.stringify(books) },
              `Import "${job.name}" into your audiobooks`,
            )
          }
        >
          Import
        </Button>
        <Button
          tone="quiet"
          disabled={act.busy}
          onClick={() =>
            void act.propose(KIND, { op: "intake-skip", job: job.id }, `Leave "${job.name}" out`)
          }
        >
          Skip
        </Button>
      </div>
    </div>
  );
}
