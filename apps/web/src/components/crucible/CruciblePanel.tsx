import { createContext, useContext, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  CRUCIBLE_PRESETS,
  CRUCIBLE_QUALITIES,
  QUALITY_WORDS,
  capFormats,
  driftedRows,
  HOLD_PROFILE,
  waitWords,
  explainStep,
  ladderWords,
  rowCounts,
  rowProfileName,
  rowSentence,
  setupFromAnswers,
  type CrucibleAnswers,
  type CrucibleLibrary,
  type CruciblePreset,
  type CrucibleRow,
  type CrucibleSetup,
  type CrucibleStep,
} from "@dragon-control/core";
import { WorkspaceFrame, type TabDef } from "../command/WorkspaceFrame";
import { appKindOf } from "../command/Diagnostics";
import { ToolImage } from "../panels/ToolImage";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { Button, cx } from "../ui";
import { NearMisses } from "./NearMisses";
import { RulesEveryday, RulesPreview } from "./CrucibleRules";
import { api, useWorkspace } from "../../data/api";

/**
 * The Crucible: Quality & Size (11-17). Quality and size for movies in plain words, for anyone:
 * start from No limits, Balanced or Storage-smart, or answer a few questions, then change any row.
 * Each row is a group of movies and a ladder, best quality first, each step with the most it may
 * cost; Save is one plan you approve (with what changes in Radarr shown first) and Undo. Hearth
 * only ever changes what it named "Hearth · ".
 */
/** Movies (Radarr) or shows (Sonarr, step 9): the same screen, its own words and rows. */
const KINDS = {
  movies: {
    tab: "movies",
    app: "radarr",
    App: "Radarr",
    one: "movie",
    many: "movies",
    Many: "Movies",
    unit: "movie",
    rows: "movies",
  },
  shows: {
    tab: "shows",
    app: "sonarr",
    App: "Sonarr",
    one: "show",
    many: "shows",
    Many: "Shows",
    unit: "episode",
    rows: "shows",
  },
} as const;
type Kind = (typeof KINDS)[keyof typeof KINDS];
const KindCtx = createContext<Kind>(KINDS.movies);
const useKind = () => useContext(KindCtx);

export function CruciblePanel({ onClose }: { onClose: () => void }) {
  const tabs: TabDef<"movies" | "shows">[] = [
    { id: "movies", label: "Movies" },
    { id: "shows", label: "Shows" },
  ];
  const [tab, setTab] = useState<"movies" | "shows">("movies");
  return (
    <WorkspaceFrame
      label="The Crucible"
      testId="crucible-panel"
      icon={<ToolImage id="crucible" />}
      title="The Crucible"
      subtitle="Quality & Size: the picture you want, at a size you're happy with."
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
      capture={{ panel: "The Crucible", tab }}
      help={["crucible"]}
    >
      <KindCtx.Provider value={KINDS[tab]}>
        <Movies key={tab} />
      </KindCtx.Provider>
    </WorkspaceFrame>
  );
}

const THIS_YEAR = new Date().getFullYear();
const field =
  "min-h-11 rounded-lg border border-line bg-bg px-3 text-[0.86rem] text-ink focus:border-gold/60 focus:outline-none";

function Movies() {
  const k = useKind();
  const ws = useWorkspace().data;
  const radarrs = (ws?.services ?? []).filter((s) => appKindOf(s) === k.app);
  const keeper = (ws?.services ?? []).find((s) =>
    /recyclarr|profilarr/i.test(`${s.name} ${s.image ?? ""}`),
  );
  const [serviceId, setServiceId] = useState<string>();
  const id = serviceId ?? radarrs[0]?.id;
  const name = radarrs.find((s) => s.id === id)?.name ?? k.App;
  const q = useQuery({
    queryKey: ["crucible", id],
    queryFn: () =>
      api<{ library: CrucibleLibrary; setup?: CrucibleSetup }>(
        "GET",
        `/api/services/${encodeURIComponent(id!)}/crucible`,
      ),
    enabled: Boolean(id),
    staleTime: 60_000,
  });

  if (!radarrs.length)
    return (
      <p className="text-[0.88rem] text-muted">
        Connect {k.App} and the Crucible sorts your {k.many} here.
      </p>
    );
  return (
    <div className="space-y-5" data-testid={`crucible-${k.tab}`}>
      {radarrs.length > 1 && (
        <label className="flex flex-wrap items-center gap-2 text-[0.84rem] text-muted">
          {k.Many} in
          <select
            className={field}
            value={id}
            onChange={(e) => setServiceId(e.target.value)}
            data-testid="crucible-app"
          >
            {radarrs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {keeper && (
        <p
          className="rounded-xl border border-line bg-bg/40 p-3 text-[0.82rem] text-muted"
          data-testid="crucible-keeper"
        >
          {/profilarr/i.test(keeper.name) ? "Profilarr" : "Recyclarr"} manages some of your
          profiles. The Crucible only adds its own (named "Hearth · ") and never touches its.
        </p>
      )}
      {q.isLoading && <p className="text-[0.84rem] text-muted">Reading {name}…</p>}
      {q.isError && (
        <p role="alert" className="text-[0.84rem] text-bad">
          {(q.error as Error).message}
        </p>
      )}
      {q.data && (
        <Workbench
          key={`${id}:${JSON.stringify(q.data.setup ?? null)}`}
          serviceId={id!}
          serviceName={name}
          library={q.data.library}
          saved={q.data.setup}
        />
      )}
      {id && k.app === "radarr" && <NearMisses serviceId={id} />}
    </div>
  );
}

/** The rows for one Radarr: starts from what was saved (a new key when that changes). */
function Workbench({
  serviceId,
  serviceName,
  library,
  saved,
}: {
  serviceId: string;
  serviceName: string;
  library: CrucibleLibrary;
  saved?: CrucibleSetup;
}) {
  // Nothing saved yet (11-18, the owner opened it and saw only the three cards): the rules open
  // straight away on the Balanced start, unsaved; the starting points stay above them.
  const [draft, setDraft] = useState<CrucibleSetup | undefined>(
    () => saved ?? CRUCIBLE_PRESETS.balanced.setup(),
  );
  const [guided, setGuided] = useState(false);
  if (guided)
    return (
      <Guided
        onDone={(s) => {
          setDraft(s);
          setGuided(false);
        }}
        onBack={() => setGuided(false)}
      />
    );
  if (!draft)
    return (
      <Start
        onPick={(p) => setDraft(CRUCIBLE_PRESETS[p].setup())}
        onGuided={() => setGuided(true)}
      />
    );
  return (
    <>
      {!saved && (
        <StartFrom
          current={draft.preset}
          onPick={(p) => setDraft(CRUCIBLE_PRESETS[p].setup())}
          onGuided={() => setGuided(true)}
        />
      )}
      <Editor
        serviceId={serviceId}
        serviceName={serviceName}
        library={library}
        saved={saved}
        draft={draft}
        setDraft={setDraft}
        onStartOver={() => {
          setDraft(undefined);
          setGuided(false);
        }}
      />
    </>
  );
}

/** Nothing saved yet: the starting points, small, above the rules they fill in. */
function StartFrom({
  current,
  onPick,
  onGuided,
}: {
  current?: string;
  onPick: (p: CruciblePreset) => void;
  onGuided: () => void;
}) {
  return (
    <div className="mb-4 space-y-2" data-testid="crucible-start">
      <p className="text-[0.86rem] text-muted">
        Nothing is saved yet: these are the Balanced rules to start from. Change any of them, or
        start from:
      </p>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(CRUCIBLE_PRESETS) as CruciblePreset[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            aria-pressed={current === p}
            title={CRUCIBLE_PRESETS[p].what}
            className={cx(
              "min-h-9 rounded-full border px-3 text-[0.8rem]",
              current === p
                ? "border-gold/60 bg-gold/10 text-gold"
                : "border-line text-muted hover:text-ink",
            )}
            data-testid="crucible-preset"
            data-preset={p}
          >
            {CRUCIBLE_PRESETS[p].name}
          </button>
        ))}
        <button
          type="button"
          onClick={onGuided}
          className="min-h-9 rounded-full border border-line px-3 text-[0.8rem] text-muted hover:text-ink"
          data-testid="crucible-guided"
        >
          Answer a few questions
        </button>
      </div>
    </div>
  );
}

function Start({
  onPick,
  onGuided,
}: {
  onPick: (p: CruciblePreset) => void;
  onGuided: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="crucible-start">
      <p className="text-[0.9rem] text-ink">
        How do you want your {useKind().many}? Pick a starting point; you can change anything after.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(CRUCIBLE_PRESETS) as CruciblePreset[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            className="rounded-xl border border-line p-3 text-left hover:border-gold/50 hover:bg-raised"
            data-testid="crucible-preset"
            data-preset={p}
          >
            <span className="block text-[0.92rem] font-semibold text-ink">
              {CRUCIBLE_PRESETS[p].name}
            </span>
            <span className="mt-1 block text-[0.8rem] text-muted">{CRUCIBLE_PRESETS[p].what}</span>
          </button>
        ))}
      </div>
      <Button onClick={onGuided} data-testid="crucible-guided">
        Not sure? Answer a few questions
      </Button>
    </div>
  );
}

function Guided({ onDone, onBack }: { onDone: (s: CrucibleSetup) => void; onBack: () => void }) {
  const [a, setA] = useState<CrucibleAnswers>({
    careAboutSpace: true,
    best: "new-releases",
    olderIs720Fine: true,
    olderYears: 15,
    episodeGB: 2.5,
  });
  const radio = <K extends keyof CrucibleAnswers>(k: K, v: CrucibleAnswers[K], label: string) => (
    <label className="flex min-h-11 items-center gap-2 text-[0.86rem] text-ink">
      <input type="radio" checked={a[k] === v} onChange={() => setA({ ...a, [k]: v })} />
      {label}
    </label>
  );
  return (
    <div className="space-y-4" data-testid="crucible-questions">
      <fieldset>
        <legend className="text-[0.9rem] text-ink">Do you care about storage space?</legend>
        {radio("careAboutSpace", true, "Yes, I'd rather not fill my drives with huge files")}
        {radio("careAboutSpace", false, "No, always the best quality, whatever the size")}
      </fieldset>
      {a.careAboutSpace && (
        <>
          <fieldset>
            <legend className="text-[0.9rem] text-ink">
              Which movies deserve the best picture (4K)?
            </legend>
            {radio("best", "new-releases", "Big new releases")}
            {radio("best", "all", "All of them")}
            {radio("best", "none", "None, 1080p is plenty")}
          </fieldset>
          <fieldset>
            <legend className="text-[0.9rem] text-ink">Is 720p fine for older movies?</legend>
            {radio("olderIs720Fine", true, "Yes, if 1080p is too big")}
            {radio("olderIs720Fine", false, "No, 1080p at least")}
            <label className="mt-1 flex flex-wrap items-center gap-2 text-[0.84rem] text-muted">
              Older means more than
              <input
                type="number"
                min={5}
                max={60}
                className={cx(field, "w-20")}
                value={a.olderYears}
                onChange={(e) => setA({ ...a, olderYears: Number(e.target.value) || 15 })}
              />
              years old
            </label>
          </fieldset>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          onClick={() => onDone(setupFromAnswers(a))}
          data-testid="crucible-questions-done"
        >
          Show me the rows
        </Button>
        <Button tone="quiet" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

function Editor({
  serviceId,
  serviceName,
  library,
  saved,
  draft,
  setDraft,
  onStartOver,
}: {
  serviceId: string;
  serviceName: string;
  library: CrucibleLibrary;
  saved?: CrucibleSetup;
  draft: CrucibleSetup;
  setDraft: (s: CrucibleSetup) => void;
  onStartOver: () => void;
}) {
  const k = useKind();
  const c = useApproveHere(serviceId, "Proposed from the Crucible.");
  const ws = useWorkspace().data;
  const seerrs = (ws?.services ?? []).filter((x) => appKindOf(x) === "seerr");
  // Seerr's search off (or back on) and the Crucible's rows told, in one plan you approve.
  const seerrSearch = (search: boolean) => {
    const seerr = {
      kind: "app-seerr-search-on-add" as const,
      params: { search, ...(k.app === "sonarr" ? { app: k.app } : {}) },
      serviceId: seerrs[0]!.id,
    };
    const apply = {
      kind: "app-crucible-apply" as const,
      params: {
        setup: JSON.stringify({ ...saved!, searchAfterSorting: !search }),
        resort: false,
        hookBase: window.location.origin,
      },
    };
    // Turning Seerr's search off: Save first (it makes the holding profile Seerr then uses).
    void c.proposeMany(
      search ? [seerr, apply] : [apply, seerr],
      search
        ? `Let ${seerrs[0]!.name} search again`
        : `Let the Crucible start ${seerrs[0]!.name}'s searches`,
    );
  };
  const [resort, setResort] = useState(false);
  const [keepTheirs, setKeepTheirs] = useState(false);
  // Everyday: rules as sentences with switches. Expert: every condition and setting of each rule.
  const [level, setLevelState] = useState<"everyday" | "expert">(() => {
    try {
      return localStorage.getItem("crucible-level") === "expert" ? "expert" : "everyday";
    } catch {
      return "everyday";
    }
  });
  const setLevel = (l: "everyday" | "expert") => {
    setLevelState(l);
    try {
      localStorage.setItem("crucible-level", l);
    } catch {
      /* private window: just for now */
    }
  };
  const counts = useMemo(
    () => rowCounts(library.titles, draft[k.rows], THIS_YEAR),
    [library.titles, draft, k.rows],
  );
  const drift = saved && !keepTheirs ? driftedRows(saved[k.rows], library, k.app === "radarr") : [];
  const rows = draft[k.rows];
  const setRows = (next: CrucibleRow[]) => setDraft({ ...draft, preset: "custom", [k.rows]: next });
  const update = (i: number, r: CrucibleRow) => setRows(rows.map((x, j) => (j === i ? r : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setRows(next);
  };
  const changed =
    JSON.stringify(saved?.[k.rows]) !== JSON.stringify(draft[k.rows]) ||
    (saved?.autoAssign !== false) !== (draft.autoAssign !== false) ||
    (saved?.smallerWins !== false) !== (draft.smallerWins !== false) ||
    (saved?.followAge !== false) !== (draft.followAge !== false);
  const waiting = library.titles.filter((t) => t.profile === HOLD_PROFILE);
  return (
    <div className="space-y-4" data-testid="crucible-editor">
      {waiting.length > 0 && (
        <p
          className="rounded-xl border border-line p-3 text-[0.84rem] text-muted"
          data-testid="crucible-waiting"
        >
          {waiting.length === 1 ? "1 request is" : `${waiting.length} requests are`} waiting for the
          Crucible:{" "}
          {waiting
            .slice(0, 3)
            .map((t) => t.title)
            .join(", ")}
          {waiting.length > 3 ? ` and ${waiting.length - 3} more` : ""}. Nothing is grabbed for{" "}
          {waiting.length === 1 ? "it" : "them"} until each gets its row; then the search starts,
          within a few minutes once Hearth is running.
        </p>
      )}
      {drift.length > 0 && (
        <div
          className="rounded-xl border border-amber/40 bg-amber/5 p-3"
          role="status"
          data-testid="crucible-drift"
        >
          <p className="text-[0.86rem] text-ink">
            {drift.join(", ")} {drift.length === 1 ? "was" : "were"} changed in {serviceName}{" "}
            itself. Keep that change, or put the Crucible's back?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button onClick={() => setKeepTheirs(true)}>Keep my change in {serviceName}</Button>
            <Button
              tone="primary"
              onClick={() =>
                void c.propose(
                  "app-crucible-apply",
                  { setup: JSON.stringify(saved), resort: false, hookBase: window.location.origin },
                  "Put the Crucible's rows back",
                )
              }
            >
              Put the Crucible's back
            </Button>
          </div>
        </div>
      )}
      <div
        className="flex flex-wrap items-center gap-2"
        role="radiogroup"
        aria-label="How much to show"
        data-testid="crucible-level"
      >
        {(
          [
            ["everyday", "Everyday"],
            ["expert", "Expert"],
          ] as const
        ).map(([l, label]) => (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={level === l}
            onClick={() => setLevel(l)}
            className={cx(
              "min-h-11 rounded-lg border px-3 text-[0.84rem]",
              level === l
                ? "border-gold/60 bg-gold/10 text-ink"
                : "border-line text-muted hover:text-ink",
            )}
            data-testid={`crucible-level-${l}`}
          >
            {label}
          </button>
        ))}
        <span className="text-[0.78rem] text-faint">
          {level === "everyday"
            ? "Your rules in plain words."
            : "Every condition and setting of each rule; the same rules as Everyday."}
        </span>
      </div>
      {level === "everyday" ? (
        <RulesEveryday
          k={k}
          rows={rows}
          setRows={setRows}
          library={library}
          serviceId={serviceId}
          serviceName={serviceName}
        />
      ) : (
        <>
          <p className="text-[0.84rem] text-muted">
            The first row that fits a {k.one} wins; the last row takes the rest. Each row tries its
            first quality, and steps down when nothing fits, so not finding 4K never means not
            getting the {k.one}.
            {k.app === "sonarr" &&
              " Sizes are per episode, and a season pack is judged per episode too. The last row's sizes are Sonarr's own size limits for every show; the other rows choose their qualities."}
          </p>
          <ol className="space-y-3">
            {rows.map((r, i) => (
              <RowCard
                key={`${r.id}-${i}`}
                row={r}
                last={i === rows.length - 1}
                count={counts.get(r.id)}
                onChange={(n) => update(i, n)}
                onUp={i > 0 ? () => move(i, -1) : undefined}
                onDown={i < rows.length - 1 ? () => move(i, 1) : undefined}
                onDelete={
                  rows.length > 1 ? () => setRows(rows.filter((_, j) => j !== i)) : undefined
                }
                genres={[...new Set(library.titles.flatMap((t) => t.genres ?? []))].sort()}
              />
            ))}
          </ol>
          <Button
            onClick={() =>
              setRows([
                ...rows.slice(0, -1),
                {
                  id: `row-${Date.now().toString(36)}`,
                  name: "New group",
                  group: { tags: [] },
                  ladder: [{ quality: "1080p", maxGB: 10 }],
                  upgrade: true,
                  waitHours: 0,
                },
                rows.at(-1)!,
              ])
            }
            data-testid="crucible-add-row"
          >
            <Plus strokeWidth={1.5} className="h-4 w-4" aria-hidden /> Add a rule
          </Button>
          <ExpertFile rows={rows} onLoad={setRows} />
        </>
      )}
      <RulesPreview k={k} rows={rows} library={library} />
      {saved && seerrs.length > 0 && (
        <div className="rounded-xl border border-line p-3" data-testid="crucible-seerr">
          {saved.searchAfterSorting ? (
            <p className="text-[0.84rem] text-muted">
              {seerrs[0]!.name} adds requested {k.many} without searching; the Crucible gives each
              its row and then starts the search.{" "}
              <button
                type="button"
                className="min-h-11 text-gold underline-offset-4 hover:underline"
                onClick={() => seerrSearch(true)}
              >
                Let {seerrs[0]!.name} search again
              </button>
            </p>
          ) : (
            <>
              <p className="text-[0.84rem] text-ink">
                {seerrs[0]!.name} searches the moment it sends a {k.one} to {serviceName}, before
                the Crucible can give it its row, so the first search can use the wrong profile.
              </p>
              <Button
                className="mt-2"
                onClick={() => seerrSearch(false)}
                data-testid="crucible-seerr-off"
              >
                Let the Crucible start {seerrs[0]!.name}'s searches
              </Button>
            </>
          )}
        </div>
      )}
      <details className="rounded-xl border border-line p-3 text-[0.82rem] text-muted">
        <summary className="cursor-pointer text-ink">
          Advanced: what this makes in {serviceName}
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {rows.map((r) => (
            <li key={r.id}>
              Quality profile "{rowProfileName(r)}":{" "}
              {k.app === "radarr"
                ? ladderWords(r)
                : ladderWords({ ...r, ladder: r.ladder.map((st) => ({ ...st, maxGB: null })) })}
            </li>
          ))}
          {k.app === "sonarr" && (
            <li>
              Sonarr's size limits (per minute of each episode) from the last row, unless Recyclarr
              or Profilarr manages them.
            </li>
          )}
          {k.app === "radarr" && draft.smallerWins !== false && (
            <li>
              Size band formats ("Hearth · Smaller 1080p (under 4 GB)" and so on), each adding 1 to
              a release's score; upgrades still need 4 more points, so these never cause one.
            </li>
          )}
          {(k.app === "radarr" ? capFormats(rows) : []).map((f) => (
            <li key={f.name}>Custom format "{f.name}", scored -10000 in the rows that cap it.</li>
          ))}
          <li>
            {k.App}'s own profiles, and any Recyclarr or Profilarr made, stay exactly as they are.
          </li>
        </ul>
      </details>
      <div className="space-y-2 border-t border-line pt-4">
        <label className="flex min-h-11 items-center gap-2 text-[0.86rem] text-ink">
          <input
            type="checkbox"
            checked={resort}
            onChange={(e) => setResort(e.target.checked)}
            data-testid="crucible-resort"
          />
          Also move the {k.many} I already have to their row (files already downloaded stay)
        </label>
        <label className="flex min-h-11 items-center gap-2 text-[0.86rem] text-ink">
          <input
            type="checkbox"
            checked={draft.autoAssign !== false}
            onChange={(e) => setDraft({ ...draft, autoAssign: e.target.checked })}
            data-testid="crucible-auto"
          />
          Give new {k.many} (and Seerr requests) their row automatically, within a few minutes
        </label>
        {k.app === "radarr" && (
          <label className="flex min-h-11 items-center gap-2 text-[0.86rem] text-ink">
            <input
              type="checkbox"
              checked={draft.smallerWins !== false}
              onChange={(e) => setDraft({ ...draft, smallerWins: e.target.checked })}
              data-testid="crucible-smaller"
            />
            When two releases are the same quality, take the smaller one
          </label>
        )}
        <label className="flex min-h-11 items-center gap-2 text-[0.86rem] text-ink">
          <input
            type="checkbox"
            checked={draft.followAge !== false}
            onChange={(e) => setDraft({ ...draft, followAge: e.target.checked })}
            data-testid="crucible-follow-age"
          />
          As {k.many} get older, move them to the rule they fit now (only ones not downloaded yet,
          or whose file already fits; nothing is replaced)
        </label>
        {draft.autoAssign === false && saved?.searchAfterSorting && (
          <p className="text-[0.8rem] text-muted" data-testid="crucible-auto-handback">
            Saving this also lets {seerrs[0]?.name ?? "Seerr"} search by itself again, and every
            request waiting for the Crucible gets its row and is searched.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            tone="primary"
            disabled={c.busy || (!changed && !resort && Boolean(saved))}
            onClick={() => {
              // Automatic sorting off while the Crucible holds Seerr's requests: Seerr gets its
              // own search back in the same plan, and waiting requests are released.
              const handBack =
                draft.autoAssign === false && saved?.searchAfterSorting && seerrs.length > 0;
              const setup = handBack ? { ...draft, searchAfterSorting: false } : draft;
              const apply = {
                kind: "app-crucible-apply" as const,
                params: { setup: JSON.stringify(setup), resort, hookBase: window.location.origin },
              };
              if (handBack)
                void c.proposeMany(
                  [
                    {
                      kind: "app-seerr-search-on-add",
                      params: { search: true, ...(k.app === "sonarr" ? { app: k.app } : {}) },
                      serviceId: seerrs[0]!.id,
                    },
                    apply,
                  ],
                  `Save the Crucible's ${k.one} rows`,
                );
              else void c.propose(apply.kind, apply.params, `Save the Crucible's ${k.one} rows`);
            }}
            data-testid="crucible-save"
          >
            Save
          </Button>
          <Button tone="quiet" onClick={onStartOver} data-testid="crucible-start-over">
            Start over
          </Button>
          <span className="text-[0.78rem] text-faint">
            You'll see exactly what changes in {serviceName} before anything does.
          </span>
        </div>
        {c.error && (
          <p role="alert" className="text-[0.82rem] text-bad">
            {c.error}
          </p>
        )}
      </div>
      <ApproveDialog c={c} />
    </div>
  );
}

function RowCard({
  row,
  last,
  count,
  onChange,
  onUp,
  onDown,
  onDelete,
  genres = [],
}: {
  row: CrucibleRow;
  last: boolean;
  genres?: string[];
  count?: { titles: number; bigger: number };
  onChange: (r: CrucibleRow) => void;
  onUp?: () => void;
  onDown?: () => void;
  onDelete?: () => void;
}) {
  const k = useKind();
  // Shows: only the last row sets sizes (Sonarr's own limits, per episode).
  const sized = k.app === "radarr" || last;
  const g = row.group;
  const setStep = (i: number, s: CrucibleStep) =>
    onChange({ ...row, ladder: row.ladder.map((x, j) => (j === i ? s : x)) });
  const icon =
    "flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-gold disabled:opacity-30";
  return (
    <li className="rounded-xl border border-line p-3" data-testid="crucible-row" data-row={row.id}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cx(field, "min-w-0 flex-1 font-semibold")}
          value={row.name}
          aria-label="Row name"
          onChange={(e) => onChange({ ...row, name: e.target.value })}
        />
        <button type="button" className={icon} disabled={!onUp} onClick={onUp} aria-label="Move up">
          <ArrowUp strokeWidth={1.5} className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={icon}
          disabled={!onDown}
          onClick={onDown}
          aria-label="Move down"
        >
          <ArrowDown strokeWidth={1.5} className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={icon}
          disabled={!onDelete}
          onClick={onDelete}
          aria-label="Delete this row"
        >
          <Trash2 strokeWidth={1.5} className="h-4 w-4" />
        </button>
      </div>
      {!last && (
        <label className="mt-1 flex min-h-11 items-center gap-2 text-[0.8rem] text-muted">
          <input
            type="checkbox"
            checked={!row.off}
            onChange={(e) => onChange({ ...row, off: e.target.checked ? undefined : true })}
          />
          On (off: kept, but no {k.one} is placed by it)
        </label>
      )}
      <p className="mt-1 text-[0.8rem] text-muted" data-testid="crucible-row-group">
        {rowSentence(row, k.app === "sonarr" ? "show" : "movie", last)}
        {count
          ? ` · ${count.titles} of your ${k.many}${count.bigger ? `, ${count.bigger} bigger than this${k.app === "sonarr" ? " per episode" : ""}` : ""}`
          : ""}
      </p>
      {!last && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.8rem] text-muted">
          <label className="flex items-center gap-1">
            Older than
            <input
              type="number"
              min={0}
              className={cx(field, "w-20")}
              value={g.olderThanYears ?? ""}
              placeholder="any"
              onChange={(e) =>
                onChange({
                  ...row,
                  group: {
                    ...g,
                    olderThanYears: e.target.value ? Number(e.target.value) : undefined,
                  },
                })
              }
            />
            years
          </label>
          <label className="flex items-center gap-1">
            Newer than
            <input
              type="number"
              min={0}
              className={cx(field, "w-20")}
              value={g.newerThanYears ?? ""}
              placeholder="any"
              onChange={(e) =>
                onChange({
                  ...row,
                  group: {
                    ...g,
                    newerThanYears: e.target.value ? Number(e.target.value) : undefined,
                  },
                })
              }
            />
            years
          </label>
          <label className="flex min-h-11 items-center gap-1">
            <input
              type="checkbox"
              checked={Boolean(g.popular)}
              onChange={(e) =>
                onChange({ ...row, group: { ...g, popular: e.target.checked || undefined } })
              }
            />
            Popular right now
          </label>
          <input
            className={cx(field, "w-56")}
            placeholder="Genres, e.g. Animation, Family"
            aria-label="Genres"
            value={(g.genres ?? []).join(", ")}
            onChange={(e) =>
              onChange({
                ...row,
                group: {
                  ...g,
                  genres: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
              })
            }
          />
          <ExpertConditions row={row} onChange={onChange} genres={genres} />
          <input
            className={cx(field, "w-44")}
            placeholder={`${k.App} tags`}
            aria-label={`${k.App} tags`}
            value={(g.tags ?? []).join(", ")}
            onChange={(e) =>
              onChange({
                ...row,
                group: {
                  ...g,
                  tags: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
              })
            }
          />
        </div>
      )}
      <ol className="mt-3 space-y-3">
        {row.ladder.map((s, i) => (
          <li key={i} className="rounded-lg bg-bg/40 p-2" data-testid="crucible-step">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[0.78rem] text-faint">{i === 0 ? "Try" : "Else"}</span>
              <select
                className={field}
                value={s.quality}
                aria-label="Quality"
                onChange={(e) =>
                  setStep(i, { ...s, quality: e.target.value as CrucibleStep["quality"] })
                }
              >
                {CRUCIBLE_QUALITIES.map((qq) => (
                  <option key={qq} value={qq}>
                    {QUALITY_WORDS[qq]}
                  </option>
                ))}
              </select>
              {sized ? (
                <>
                  <input
                    type="range"
                    min={k.app === "sonarr" ? 0.5 : 1}
                    max={
                      k.app === "sonarr"
                        ? s.quality === "2160p"
                          ? 20
                          : s.quality === "1080p"
                            ? 8
                            : 4
                        : s.quality === "2160p"
                          ? 80
                          : s.quality === "1080p"
                            ? 30
                            : 12
                    }
                    step={k.app === "sonarr" ? 0.1 : 0.5}
                    className="min-w-32 flex-1 accent-[var(--color-gold)]"
                    disabled={s.maxGB === null}
                    value={s.maxGB ?? 0}
                    aria-label="Most it may cost, in GB"
                    onChange={(e) => setStep(i, { ...s, maxGB: Number(e.target.value) })}
                  />
                  <span className="w-24 text-[0.86rem] text-ink" data-testid="crucible-step-cap">
                    {s.maxGB === null
                      ? "No limit"
                      : `up to ${s.maxGB} GB${k.app === "sonarr" ? " an episode" : ""}`}
                  </span>
                  <label className="flex min-h-11 items-center gap-1 text-[0.78rem] text-muted">
                    <input
                      type="checkbox"
                      checked={s.maxGB === null}
                      onChange={(e) =>
                        setStep(i, {
                          ...s,
                          maxGB: e.target.checked ? null : k.app === "sonarr" ? 2.5 : 10,
                        })
                      }
                    />
                    No limit
                  </label>
                </>
              ) : (
                <span className="text-[0.78rem] text-faint" data-testid="crucible-step-follows">
                  Size: as the last row
                </span>
              )}
              {row.ladder.length > 1 && (
                <button
                  type="button"
                  className="min-h-11 text-[0.78rem] text-muted underline-offset-4 hover:underline"
                  onClick={() => onChange({ ...row, ladder: row.ladder.filter((_, j) => j !== i) })}
                >
                  Remove
                </button>
              )}
            </div>
            <p className="mt-1 text-[0.76rem] text-faint" data-testid="crucible-explain">
              {sized ? explainStep(k.unit, s) : ""}
            </p>
          </li>
        ))}
      </ol>
      {row.ladder.length > 1 && (
        <label className="mt-2 flex flex-wrap items-center gap-2 text-[0.8rem] text-muted">
          Wait for {QUALITY_WORDS[row.ladder[0]!.quality]} before settling for{" "}
          {QUALITY_WORDS[row.ladder[1]!.quality]}:
          <select
            className={field}
            value={row.waitHours}
            onChange={(e) => onChange({ ...row, waitHours: Number(e.target.value) })}
            data-testid="crucible-wait"
          >
            {[0, 6, 24, 48, 168].map((h) => (
              <option key={h} value={h}>
                {waitWords(h)}
              </option>
            ))}
          </select>
          {row.waitHours > 0 && "(no wait once it turns up)"}
        </label>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {row.ladder.length < 3 && (
          <button
            type="button"
            className="min-h-11 text-[0.8rem] text-gold underline-offset-4 hover:underline"
            onClick={() => {
              const next =
                CRUCIBLE_QUALITIES.find((qq) => !row.ladder.some((x) => x.quality === qq)) ??
                "720p";
              onChange({ ...row, ladder: [...row.ladder, { quality: next, maxGB: 6 }] });
            }}
          >
            Add a lower step
          </button>
        )}
        <label className="flex min-h-11 items-center gap-2 text-[0.8rem] text-muted">
          <input
            type="checkbox"
            checked={row.upgrade}
            onChange={(e) => onChange({ ...row, upgrade: e.target.checked })}
          />
          Upgrade later if a better one that fits turns up
        </label>
      </div>
    </li>
  );
}

/** Expert: the rest of a rule's conditions, as plain fields. */
function ExpertConditions({
  row,
  onChange,
  genres,
}: {
  row: CrucibleRow;
  onChange: (r: CrucibleRow) => void;
  genres: string[];
}) {
  const g = row.group;
  const set = (patch: Partial<CrucibleRow["group"]>) => {
    const next = { ...g, ...patch };
    for (const key of Object.keys(next) as (keyof typeof next)[])
      if (next[key] === undefined || (Array.isArray(next[key]) && !(next[key] as unknown[]).length))
        delete next[key];
    onChange({ ...row, group: next });
  };
  const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const list = (v: string) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const box = (
    label: string,
    value: number | undefined,
    key: keyof CrucibleRow["group"],
    w = "w-20",
  ) => (
    <label className="flex items-center gap-1">
      {label}
      <input
        type="number"
        className={cx(field, w)}
        value={value ?? ""}
        placeholder="any"
        onChange={(e) => set({ [key]: n(e.target.value) })}
      />
    </label>
  );
  return (
    <>
      {box("Out on digital within", g.digitalWithinMonths, "digitalWithinMonths")}
      <span>months</span>
      {box("Made from", g.fromYear, "fromYear", "w-24")}
      {box("to", g.toYear, "toYear", "w-24")}
      {box("Rated from", g.minRating, "minRating")}
      {box("to", g.maxRating, "maxRating")}
      {box("Length from", g.minRuntime, "minRuntime")}
      {box("to", g.maxRuntime, "maxRuntime")}
      <span>minutes</span>
      <input
        className={cx(field, "w-56")}
        placeholder="Not these genres"
        aria-label="Not these genres"
        list="crucible-genres"
        value={(g.notGenres ?? []).join(", ")}
        onChange={(e) => set({ notGenres: list(e.target.value) })}
      />
      <input
        className={cx(field, "w-44")}
        placeholder="Original languages"
        aria-label="Original languages"
        value={(g.languages ?? []).join(", ")}
        onChange={(e) => set({ languages: list(e.target.value) })}
      />
      <datalist id="crucible-genres">
        {genres.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <label className="flex min-h-11 items-center gap-1">
        <input
          type="checkbox"
          checked={Boolean(g.any)}
          onChange={(e) => set({ any: e.target.checked || undefined })}
        />
        Any one condition is enough
      </label>
    </>
  );
}

/** Expert: your rules as a file, to keep, share, or load on another Hearth. */
function ExpertFile({ rows, onLoad }: { rows: CrucibleRow[]; onLoad: (r: CrucibleRow[]) => void }) {
  const k = useKind();
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="crucible-file">
      <Button
        onClick={() => {
          const blob = new Blob(
            [JSON.stringify({ hearthCrucible: 1, kind: k.app, rules: rows }, null, 2)],
            { type: "application/json" },
          );
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `crucible-${k.many}-rules.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }}
      >
        Save my rules as a file
      </Button>
      <label className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-3 text-[0.84rem] text-ink hover:border-gold/50">
        Load rules from a file
        <input
          type="file"
          accept="application/json,.json"
          className="sr-only"
          onChange={async (e) => {
            setError(undefined);
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const data = JSON.parse(await f.text()) as { rules?: CrucibleRow[] };
              const r = data.rules;
              if (
                !Array.isArray(r) ||
                !r.length ||
                !r.every((x) => x && typeof x.name === "string" && Array.isArray(x.ladder))
              )
                throw new Error("That file has no Crucible rules in it.");
              onLoad(r);
            } catch (err) {
              setError(err instanceof Error ? err.message : "That file couldn't be read.");
            }
            e.target.value = "";
          }}
        />
      </label>
      <span className="text-[0.78rem] text-faint">
        Loading only changes this screen until you Save.
      </span>
      {error && (
        <p role="alert" className="w-full text-[0.82rem] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
