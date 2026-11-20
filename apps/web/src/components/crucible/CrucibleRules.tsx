import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, MessageCircle, Plus, Trash2, X } from "lucide-react";
import {
  CRUCIBLE_QUALITIES,
  CRUCIBLE_STATEMENTS,
  QUALITY_WORDS,
  explainStep,
  explainTitle,
  groupPhrases,
  rowCounts,
  rowFor,
  rowOverlaps,
  spaceEstimate,
  waitWords,
  type CrucibleGroup,
  type CrucibleLibrary,
  type CrucibleRow,
  type CrucibleStep,
} from "@dragon-control/core";
import { useCave } from "../shell/cave-context";
import { EmberMark } from "../ember/EmberMark";
import { Button, Switch, cx } from "../ui";
import { api } from "../../data/api";

/**
 * Your rules in plain words (11-18, the owner): each rule is a sentence with a switch, and every
 * definition in it ("older", "small", "new") is in plain sight, changed with a tap. Ember turns
 * the owner's own words into a new rule, asking what a vague word means first. Underneath it is
 * the Crucible's rows, so Expert and Everyday are two views of the same rules.
 */

export type RulesKind = {
  app: "radarr" | "sonarr";
  App: string;
  one: string;
  many: string;
  Many: string;
  unit: "movie" | "episode";
};
const kindOf = (k: RulesKind): "movie" | "show" => (k.app === "sonarr" ? "show" : "movie");
const THIS_YEAR = new Date().getFullYear();
const field =
  "min-h-11 rounded-lg border border-line bg-bg px-3 text-[0.86rem] text-ink focus:border-gold/60 focus:outline-none";
const chip =
  "inline rounded-md border border-dashed border-gold/50 px-1.5 py-0.5 text-gold decoration-gold/40 hover:bg-gold/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/60";

/** The conditions people add to a rule, in their words. */
const CONDITIONS: {
  key: keyof CrucibleGroup;
  label: string;
  make: () => Partial<CrucibleGroup>;
}[] = [
  {
    key: "digitalWithinMonths",
    label: "came out recently",
    make: () => ({ digitalWithinMonths: 6 }),
  },
  {
    key: "newerThanYears",
    label: "released in the last few years",
    make: () => ({ newerThanYears: 2 }),
  },
  { key: "olderThanYears", label: "older than some years", make: () => ({ olderThanYears: 20 }) },
  {
    key: "fromYear",
    label: "made in certain years",
    make: () => ({ fromYear: 1980, toYear: 1989 }),
  },
  { key: "genres", label: "a genre", make: () => ({ genres: ["Comedy"] }) },
  { key: "notGenres", label: "not a genre", make: () => ({ notGenres: ["Animation"] }) },
  { key: "minRating", label: "a rating", make: () => ({ minRating: 7.5 }) },
  { key: "minRuntime", label: "a length", make: () => ({ minRuntime: 150 }) },
  { key: "languages", label: "an original language", make: () => ({ languages: ["English"] }) },
  { key: "tags", label: "a tag", make: () => ({ tags: [] }) },
  { key: "popular", label: "popular right now", make: () => ({ popular: true }) },
];
/** The keys one phrase stands for (a range is one phrase). */
const KEYS_OF: Partial<Record<keyof CrucibleGroup, (keyof CrucibleGroup)[]>> = {
  fromYear: ["fromYear", "toYear"],
  toYear: ["fromYear", "toYear"],
  minRating: ["minRating", "maxRating"],
  maxRating: ["minRating", "maxRating"],
  minRuntime: ["minRuntime", "maxRuntime"],
  maxRuntime: ["minRuntime", "maxRuntime"],
};
const without = (g: CrucibleGroup, key: keyof CrucibleGroup): CrucibleGroup => {
  const next = { ...g };
  for (const k of KEYS_OF[key] ?? [key]) delete next[k];
  return next;
};

export function RulesEveryday({
  k,
  rows,
  setRows,
  library,
  serviceId,
  serviceName,
}: {
  k: RulesKind;
  rows: CrucibleRow[];
  setRows: (r: CrucibleRow[]) => void;
  library: CrucibleLibrary;
  serviceId: string;
  serviceName: string;
}) {
  const counts = useMemo(() => rowCounts(library.titles, rows, THIS_YEAR), [library.titles, rows]);
  const overlaps = useMemo(
    () => rowOverlaps(library.titles, rows, THIS_YEAR),
    [library.titles, rows],
  );
  const update = (i: number, r: CrucibleRow) => setRows(rows.map((x, j) => (j === i ? r : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setRows(next);
  };
  const addRule = (r: CrucibleRow) => {
    const taken = new Set(rows.map((x) => x.id));
    let id = r.id;
    for (let n = 2; taken.has(id); n++) id = `${r.id}-${n}`;
    setRows([...rows.slice(0, -1), { ...r, id }, rows.at(-1)!]);
  };
  const genres = useMemo(
    () => [...new Set(library.titles.flatMap((t) => t.genres ?? []))].sort(),
    [library.titles],
  );
  const languages = useMemo(
    () =>
      [...new Set(library.titles.map((t) => t.language).filter((x): x is string => !!x))].sort(),
    [library.titles],
  );
  const tags = useMemo(
    () => [...new Set(library.titles.flatMap((t) => t.tags ?? []))].sort(),
    [library.titles],
  );
  return (
    <div className="space-y-4" data-testid="crucible-rules">
      <p className="text-[0.84rem] text-muted">
        Each rule says which {k.many} get what. The first rule that fits a {k.one} wins, so drag the
        ones that matter most to the top. Tap any underlined part to change what it means.
      </p>
      <ol className="space-y-3">
        {rows.map((r, i) => (
          <RuleCard
            key={`${r.id}-${i}`}
            k={k}
            row={r}
            last={i === rows.length - 1}
            count={counts.get(r.id)?.titles}
            options={{ genres, languages, tags }}
            onChange={(n) => update(i, n)}
            onUp={i > 0 && i < rows.length - 1 ? () => move(i, -1) : undefined}
            onDown={i < rows.length - 2 ? () => move(i, 1) : undefined}
            onDelete={
              i < rows.length - 1 ? () => setRows(rows.filter((_, j) => j !== i)) : undefined
            }
          />
        ))}
      </ol>
      {overlaps.length > 0 && (
        <div
          className="space-y-1 rounded-xl border border-line bg-bg/40 p-3 text-[0.82rem] text-muted"
          data-testid="crucible-overlaps"
        >
          {overlaps.slice(0, 4).map((o) => (
            <p key={`${o.higher}|${o.lower}`}>
              {o.titles} {o.titles === 1 ? `${k.one} fits` : `${k.many} fit`} both "{o.higher}" and
              "{o.lower}". "{o.higher}" wins because it's higher.{" "}
              <button
                type="button"
                className="min-h-9 text-gold underline-offset-4 hover:underline"
                onClick={() => {
                  const a = rows.findIndex((x) => x.name === o.higher);
                  const b = rows.findIndex((x) => x.name === o.lower);
                  const next = [...rows];
                  const [moved] = next.splice(b, 1);
                  next.splice(a, 0, moved!);
                  setRows(next);
                }}
              >
                Let "{o.lower}" win instead
              </button>
            </p>
          ))}
        </div>
      )}
      <AddRule k={k} onAdd={addRule} serviceId={serviceId} serviceName={serviceName} rows={rows} />
    </div>
  );
}

function RuleCard({
  k,
  row,
  last,
  count,
  options,
  onChange,
  onUp,
  onDown,
  onDelete,
}: {
  k: RulesKind;
  row: CrucibleRow;
  last: boolean;
  count?: number;
  options: { genres: string[]; languages: string[]; tags: string[] };
  onChange: (r: CrucibleRow) => void;
  onUp?: () => void;
  onDown?: () => void;
  onDelete?: () => void;
}) {
  const kind = kindOf(k);
  const [open, setOpen] = useState<
    { what: "cond"; key: keyof CrucibleGroup } | { what: "step"; i: number } | { what: "add" }
  >();
  const phrases = groupPhrases(row.group, kind);
  const off = Boolean(row.off) && !last;
  // Shows: only the last rule sets sizes (Sonarr's own limits, per episode).
  const sized = k.app === "radarr" || last;
  const toggle = (o: typeof open) =>
    setOpen(JSON.stringify(open) === JSON.stringify(o) ? undefined : o);
  const per = k.unit === "episode" ? " an episode" : "";
  const icon =
    "flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:text-gold disabled:opacity-30";
  const head = last ? `Every other ${k.one}` : phrases.length ? k.Many : `All ${k.many}`;
  return (
    <li
      className={cx("rounded-xl border border-line p-3", off && "opacity-60")}
      data-testid="crucible-rule"
      data-row={row.id}
    >
      <div className="flex items-start gap-2">
        {!last ? (
          <Switch
            checked={!off}
            onChange={(on) => onChange({ ...row, off: on ? undefined : true })}
            label={`${row.name}: ${off ? "off" : "on"}`}
          />
        ) : (
          <span className="h-11 w-11 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <input
            className="w-full bg-transparent text-[0.8rem] font-semibold uppercase tracking-wide text-faint focus:text-ink focus:outline-none"
            value={row.name}
            aria-label="Rule name"
            onChange={(e) => onChange({ ...row, name: e.target.value })}
          />
          <p className="text-[0.95rem] leading-relaxed text-ink" data-testid="crucible-sentence">
            {head}
            {phrases.map((p, i) => (
              <span key={p.key}>
                {i > 0 ? (row.group.any ? " or " : " and ") : " "}
                <button
                  type="button"
                  className={chip}
                  onClick={() => toggle({ what: "cond", key: p.key })}
                  data-testid="crucible-chip"
                >
                  {p.text}
                </button>
              </span>
            ))}
            {!last && (
              <button
                type="button"
                className="ml-1 inline-flex h-7 w-7 translate-y-1 items-center justify-center rounded-md border border-line text-muted hover:text-gold"
                aria-label="Add a condition"
                onClick={() => toggle({ what: "add" })}
                data-testid="crucible-add-condition"
              >
                <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
            )}{" "}
            {last || !phrases.length ? (last ? "gets" : "get") : "get"}{" "}
            {row.ladder.map((s, i) => (
              <span key={i}>
                {i > 0 && ", else "}
                <button
                  type="button"
                  className={chip}
                  onClick={() => toggle({ what: "step", i })}
                  data-testid="crucible-step-chip"
                >
                  {QUALITY_WORDS[s.quality]}
                  {sized ? (s.maxGB === null ? " at any size" : ` up to ${s.maxGB} GB${per}`) : ""}
                </button>
              </span>
            ))}
            {row.ladder.length < 4 && (
              <>
                <button
                  type="button"
                  className="ml-1 inline-flex h-7 w-7 translate-y-1 items-center justify-center rounded-md border border-line text-muted hover:text-gold"
                  aria-label="Add a lower quality"
                  onClick={() => {
                    const next =
                      CRUCIBLE_QUALITIES.find((q) => !row.ladder.some((x) => x.quality === q)) ??
                      "720p";
                    onChange({
                      ...row,
                      ladder: [...row.ladder, { quality: next, maxGB: k.app === "sonarr" ? 1 : 4 }],
                    });
                    setOpen({ what: "step", i: row.ladder.length });
                  }}
                >
                  <Plus strokeWidth={1.5} className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            .
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[0.78rem] text-muted">
            {count !== undefined && (
              <span data-testid="crucible-rule-count">
                {off ? "Off" : `${count} of your ${k.many}`}
              </span>
            )}
            <button
              type="button"
              className="min-h-9 underline-offset-4 hover:text-gold hover:underline"
              onClick={() => onChange({ ...row, upgrade: !row.upgrade })}
            >
              {row.upgrade ? "Upgrades later when a better one fits" : "No upgrades later"}
            </button>
            {row.ladder.length > 1 && (
              <label className="flex items-center gap-1">
                Wait for {QUALITY_WORDS[row.ladder[0]!.quality]}:
                <select
                  className="min-h-9 rounded-md border border-line bg-bg px-1 text-[0.78rem] text-ink"
                  value={row.waitHours}
                  onChange={(e) => onChange({ ...row, waitHours: Number(e.target.value) })}
                >
                  {[0, 6, 24, 48, 168].map((h) => (
                    <option key={h} value={h}>
                      {waitWords(h)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </p>
        </div>
        <div className="flex shrink-0">
          {!last && (
            <>
              <button
                type="button"
                className={icon}
                disabled={!onUp}
                onClick={onUp}
                aria-label="Move up"
              >
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
                aria-label="Delete this rule"
              >
                <Trash2 strokeWidth={1.5} className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
      {open?.what === "cond" && (
        <ConditionEditor
          k={k}
          group={row.group}
          keyName={open.key}
          options={options}
          onChange={(g) => onChange({ ...row, group: g })}
          onRemove={() => {
            onChange({ ...row, group: without(row.group, open.key) });
            setOpen(undefined);
          }}
          onDone={() => setOpen(undefined)}
        />
      )}
      {open?.what === "add" && (
        <div
          className="mt-3 flex flex-wrap gap-2 rounded-lg bg-bg/40 p-2"
          data-testid="crucible-condition-menu"
        >
          <span className="w-full text-[0.78rem] text-faint">Only {k.many} that are...</span>
          {CONDITIONS.filter(
            (c) => !(KEYS_OF[c.key] ?? [c.key]).some((x) => row.group[x] !== undefined),
          ).map((c) => (
            <button
              key={c.key}
              type="button"
              className="min-h-9 rounded-lg border border-line px-2.5 text-[0.8rem] text-ink hover:border-gold/50"
              onClick={() => {
                onChange({ ...row, group: { ...row.group, ...c.make() } });
                setOpen({ what: "cond", key: c.key });
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {open?.what === "step" && row.ladder[open.i] && (
        <StepEditor
          k={k}
          step={row.ladder[open.i]!}
          first={open.i === 0}
          sized={sized}
          onChange={(s) =>
            onChange({ ...row, ladder: row.ladder.map((x, j) => (j === open.i ? s : x)) })
          }
          onRemove={
            row.ladder.length > 1
              ? () => {
                  onChange({ ...row, ladder: row.ladder.filter((_, j) => j !== open.i) });
                  setOpen(undefined);
                }
              : undefined
          }
          onDone={() => setOpen(undefined)}
        />
      )}
    </li>
  );
}

const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  unit,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[0.84rem] text-muted">
      {label}
      <input
        type="number"
        className={cx(field, "w-24")}
        min={min}
        max={max}
        step={step}
        value={value ?? ""}
        placeholder="any"
        onChange={(e) => onChange(num(e.target.value))}
      />
      {unit}
    </label>
  );
}

function PickList({
  values,
  options,
  onChange,
  placeholder,
}: {
  values: string[];
  options: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [typed, setTyped] = useState("");
  const add = (x: string) => {
    const v = x.trim();
    if (v && !values.some((y) => y.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setTyped("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-gold/50 bg-gold/10 pl-2.5 text-[0.82rem] text-ink"
          >
            {v}
            <button
              type="button"
              className="flex h-9 w-8 items-center justify-center text-muted hover:text-bad"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <X strokeWidth={1.5} className="h-3.5 w-3.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options
          .filter((o) => !values.includes(o))
          .slice(0, 24)
          .map((o) => (
            <button
              key={o}
              type="button"
              className="min-h-9 rounded-lg border border-line px-2.5 text-[0.8rem] text-muted hover:border-gold/50 hover:text-ink"
              onClick={() => add(o)}
            >
              {o}
            </button>
          ))}
        <input
          className={cx(field, "w-40")}
          placeholder={placeholder}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(typed);
            }
          }}
        />
      </div>
    </div>
  );
}

function ConditionEditor({
  k,
  group: g,
  keyName,
  options,
  onChange,
  onRemove,
  onDone,
}: {
  k: RulesKind;
  group: CrucibleGroup;
  keyName: keyof CrucibleGroup;
  options: { genres: string[]; languages: string[]; tags: string[] };
  onChange: (g: CrucibleGroup) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const set = (patch: Partial<CrucibleGroup>) => onChange({ ...g, ...patch });
  const key = (KEYS_OF[keyName] ?? [keyName])[0]!;
  let body: React.ReactNode;
  switch (key) {
    case "digitalWithinMonths":
      body = (
        <>
          <NumberField
            label={k.app === "sonarr" ? "Started less than" : "Out on digital less than"}
            value={g.digitalWithinMonths}
            onChange={(v) => set({ digitalWithinMonths: v ?? 0 })}
            max={120}
            unit="months ago"
          />
          <p className="w-full text-[0.76rem] text-faint">
            {k.app === "sonarr"
              ? "Counted from when the show first aired."
              : "Counted from the digital release; if there's none yet, the disc release, else the cinema release plus 3 months. Not out yet counts as new."}
          </p>
        </>
      );
      break;
    case "newerThanYears":
      body = (
        <NumberField
          label="Released in the last"
          value={g.newerThanYears}
          onChange={(v) => set({ newerThanYears: v ?? 0 })}
          max={100}
          unit="years"
        />
      );
      break;
    case "olderThanYears":
      body = (
        <NumberField
          label="Released more than"
          value={g.olderThanYears}
          onChange={(v) => set({ olderThanYears: v ?? 0 })}
          max={120}
          unit="years ago"
        />
      );
      break;
    case "fromYear":
      body = (
        <>
          <NumberField
            label="Made from"
            value={g.fromYear}
            onChange={(v) => set({ fromYear: v })}
            min={1880}
            max={2100}
          />
          <NumberField
            label="to"
            value={g.toYear}
            onChange={(v) => set({ toYear: v })}
            min={1880}
            max={2100}
          />
        </>
      );
      break;
    case "genres":
    case "notGenres":
    case "languages":
    case "tags":
      body = (
        <div className="w-full">
          <p className="mb-1 text-[0.78rem] text-faint">
            {key === "notGenres"
              ? "Leave out these genres:"
              : key === "languages"
                ? "Originally in any of these languages:"
                : key === "tags"
                  ? `Tagged with any of these ${k.App} tags:`
                  : "Any of these genres:"}
          </p>
          <PickList
            values={(g[key] as string[] | undefined) ?? []}
            options={
              key === "languages"
                ? options.languages
                : key === "tags"
                  ? options.tags
                  : options.genres
            }
            onChange={(v) => set({ [key]: v })}
            placeholder="Type one, then Enter"
          />
        </div>
      );
      break;
    case "minRating":
      body = (
        <>
          <NumberField
            label="Rated from"
            value={g.minRating}
            onChange={(v) => set({ minRating: v })}
            max={10}
            step={0.1}
          />
          <NumberField
            label="to"
            value={g.maxRating}
            onChange={(v) => set({ maxRating: v })}
            max={10}
            step={0.1}
          />
          <p className="w-full text-[0.76rem] text-faint">Out of 10: TMDB's rating, else IMDb's.</p>
        </>
      );
      break;
    case "minRuntime":
      body = (
        <>
          <NumberField
            label="At least"
            value={g.minRuntime}
            onChange={(v) => set({ minRuntime: v })}
            max={600}
            unit="minutes"
          />
          <NumberField
            label="at most"
            value={g.maxRuntime}
            onChange={(v) => set({ maxRuntime: v })}
            max={600}
            unit={`minutes${k.app === "sonarr" ? " an episode" : ""}`}
          />
        </>
      );
      break;
    default:
      body = (
        <p className="text-[0.82rem] text-muted">
          Popular right now means TMDB counts it among the most watched at the moment.
        </p>
      );
  }
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-bg/40 p-3"
      data-testid="crucible-condition-editor"
    >
      {body}
      <div className="flex w-full flex-wrap gap-2">
        <Button onClick={onDone}>Done</Button>
        <Button tone="quiet" onClick={onRemove}>
          Remove this part
        </Button>
      </div>
    </div>
  );
}

function StepEditor({
  k,
  step: s,
  first,
  sized,
  onChange,
  onRemove,
  onDone,
}: {
  k: RulesKind;
  step: CrucibleStep;
  first: boolean;
  sized: boolean;
  onChange: (s: CrucibleStep) => void;
  onRemove?: () => void;
  onDone: () => void;
}) {
  return (
    <div className="mt-3 space-y-2 rounded-lg bg-bg/40 p-3" data-testid="crucible-step-editor">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[0.84rem] text-muted">
          {first ? "Try" : "Else"}
          <select
            className={field}
            value={s.quality}
            onChange={(e) => onChange({ ...s, quality: e.target.value as CrucibleStep["quality"] })}
          >
            {CRUCIBLE_QUALITIES.map((q) => (
              <option key={q} value={q}>
                {QUALITY_WORDS[q]}
              </option>
            ))}
          </select>
        </label>
        {sized ? (
          <>
            <label className="flex items-center gap-1.5 text-[0.84rem] text-muted">
              up to
              <input
                type="number"
                className={cx(field, "w-24")}
                min={0.1}
                max={500}
                step={k.app === "sonarr" ? 0.1 : 0.5}
                disabled={s.maxGB === null}
                value={s.maxGB ?? ""}
                onChange={(e) =>
                  onChange({ ...s, maxGB: Math.max(0.1, Number(e.target.value) || 0.1) })
                }
                data-testid="crucible-step-gb"
              />
              GB{k.app === "sonarr" ? " an episode" : ""}
            </label>
            <label className="flex min-h-11 items-center gap-1.5 text-[0.84rem] text-muted">
              <input
                type="checkbox"
                checked={s.maxGB === null}
                onChange={(e) =>
                  onChange({ ...s, maxGB: e.target.checked ? null : k.app === "sonarr" ? 2.5 : 10 })
                }
              />
              Any size
            </label>
          </>
        ) : (
          <span className="text-[0.8rem] text-faint">
            Sizes for shows are set in the last rule (Sonarr's own size limits).
          </span>
        )}
      </div>
      {sized && <p className="text-[0.78rem] text-faint">{explainStep(k.unit, s)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onDone}>Done</Button>
        {onRemove && (
          <Button tone="quiet" onClick={onRemove}>
            Remove this quality
          </Button>
        )}
      </div>
    </div>
  );
}

type Suggestion = {
  id: string;
  serviceId: string;
  kind: "movie" | "show";
  row: CrucibleRow;
  note?: string;
};

/** Ready-made rules, the owner's own words through Ember, and Ember's waiting suggestions. */
function AddRule({
  k,
  onAdd,
  serviceId,
  serviceName,
  rows,
}: {
  k: RulesKind;
  onAdd: (r: CrucibleRow) => void;
  serviceId: string;
  serviceName: string;
  rows: CrucibleRow[];
}) {
  const kind = kindOf(k);
  const cave = useCave();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState("");
  const s = useQuery({
    queryKey: ["crucible-suggestions", serviceId],
    queryFn: () =>
      api<{ suggestions: Suggestion[] }>(
        "GET",
        `/api/crucible/suggestions?serviceId=${encodeURIComponent(serviceId)}`,
      ),
    refetchInterval: 5000,
  });
  const mine = (s.data?.suggestions ?? []).filter((x) => x.kind === kind);
  const dismiss = async (id: string) => {
    await api("DELETE", `/api/crucible/suggestions/${encodeURIComponent(id)}`).catch(
      () => undefined,
    );
    void qc.invalidateQueries({ queryKey: ["crucible-suggestions", serviceId] });
  };
  const ask = (wish: string) =>
    cave.ask(
      [
        `In the Crucible (Quality & Size) for ${serviceName} (service id ${serviceId}, ${k.many}), I want a new rule: "${wish}".`,
        `My rules now, first match wins: ${rows.map((r, i) => `${i + 1}. ${r.name}`).join("; ")}.`,
        "If any word in my wish is vague (old, new, recent, small, big, classic, best), ask me what it means for me before writing the rule; never assume.",
        `Then add it as a suggestion with hearth_api: POST /api/crucible/suggestions with {"serviceId":"${serviceId}","kind":"${kind}","row":{...},"note":"one line on what you understood"}.`,
        'A row is {"name":"...","group":{conditions},"ladder":[{"quality":"2160p|1080p|720p|sd","maxGB":number|null}],"upgrade":true,"waitHours":0}. Conditions (all must hold unless "any":true): digitalWithinMonths, newerThanYears, olderThanYears, fromYear, toYear, genres[], notGenres[], tags[], minRating, maxRating (0-10), minRuntime, maxRuntime (minutes), languages[], popular.',
        kind === "show"
          ? "Shows: maxGB is per episode, and only the last rule's sizes are used (Sonarr's limits)."
          : "Movies: maxGB is per movie.",
        "Don't save the Crucible or change the app: I'll see the suggestion on the screen and add it myself.",
      ].join(" "),
    );
  const fromHistory = () =>
    cave.ask(
      [
        `For the Crucible (Quality & Size) for ${serviceName} (service id ${serviceId}, ${k.many}): look at what I actually watch (my media server's watch history) and what's in the library, then suggest two to four rules that fit how I watch.`,
        "Spell out every definition (how many years is old, how many GB is small) and tell me why each rule fits me. Ask me anything you're not sure of.",
        `Add each as a suggestion with hearth_api: POST /api/crucible/suggestions with {"serviceId":"${serviceId}","kind":"${kind}","row":{...},"note":"why it fits"}. A row is {"name":"...","group":{conditions},"ladder":[{"quality":"2160p|1080p|720p|sd","maxGB":number|null}],"upgrade":true,"waitHours":0}; conditions: digitalWithinMonths, newerThanYears, olderThanYears, fromYear, toYear, genres[], notGenres[], tags[], minRating, maxRating, minRuntime, maxRuntime, languages[], popular.`,
        "Suggestions only: don't save the Crucible or change the app.",
      ].join(" "),
    );
  return (
    <div className="space-y-3">
      {mine.length > 0 && (
        <div className="space-y-2" data-testid="crucible-suggestions">
          {mine.map((x) => (
            <div key={x.id} className="rounded-xl border border-gold/40 bg-gold/5 p-3">
              <p className="flex items-center gap-1.5 text-[0.76rem] font-semibold uppercase tracking-wide text-gold">
                <EmberMark /> Ember suggests
              </p>
              <p className="mt-1 text-[0.92rem] text-ink">
                {x.row.name}:{" "}
                {groupPhrases(x.row.group, kind)
                  .map((p) => p.text)
                  .join(x.row.group.any ? " or " : " and ") || `all ${k.many}`}{" "}
                get{" "}
                {x.row.ladder
                  .map(
                    (st) =>
                      `${QUALITY_WORDS[st.quality]}${st.maxGB === null ? " at any size" : ` up to ${st.maxGB} GB`}`,
                  )
                  .join(", else ")}
                .
              </p>
              {x.note && <p className="mt-1 text-[0.8rem] text-muted">{x.note}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  tone="primary"
                  onClick={() => {
                    onAdd(x.row);
                    void dismiss(x.id);
                  }}
                  data-testid="crucible-suggestion-add"
                >
                  Add this rule
                </Button>
                <Button tone="quiet" onClick={() => void dismiss(x.id)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {!open ? (
        <Button onClick={() => setOpen(true)} data-testid="crucible-add-rule">
          <Plus strokeWidth={1.5} className="h-4 w-4" aria-hidden /> Add a rule
        </Button>
      ) : (
        <div
          className="space-y-3 rounded-xl border border-line p-3"
          data-testid="crucible-add-menu"
        >
          <div className="flex flex-wrap gap-2">
            {CRUCIBLE_STATEMENTS.filter((st) => st.kind === kind).map((st) => (
              <button
                key={st.id}
                type="button"
                className="min-h-11 rounded-lg border border-line px-3 text-left text-[0.84rem] text-ink hover:border-gold/50 hover:bg-raised"
                onClick={() => {
                  onAdd(st.make());
                  setOpen(false);
                }}
                data-testid="crucible-statement"
              >
                {st.name}
              </button>
            ))}
            <button
              type="button"
              className="min-h-11 rounded-lg border border-dashed border-line px-3 text-[0.84rem] text-muted hover:border-gold/50"
              onClick={() => {
                onAdd({
                  id: `rule-${Date.now().toString(36)}`,
                  name: "My rule",
                  group: {},
                  ladder: [{ quality: "1080p", maxGB: k.app === "sonarr" ? 2 : 8 }],
                  upgrade: true,
                  waitHours: 0,
                });
                setOpen(false);
              }}
            >
              A blank rule
            </button>
          </div>
          <div>
            <label className="text-[0.84rem] text-ink" htmlFor="crucible-words">
              Or say it in your own words
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              <input
                id="crucible-words"
                className={cx(field, "min-w-0 flex-1")}
                placeholder={
                  kind === "show"
                    ? "e.g. old sitcoms are fine at DVD quality"
                    : "e.g. I'm an 80s kid, those matter more to me"
                }
                value={words}
                onChange={(e) => setWords(e.target.value)}
                data-testid="crucible-words"
              />
              <Button
                tone="primary"
                disabled={!words.trim()}
                onClick={() => {
                  ask(words.trim());
                  setWords("");
                  setOpen(false);
                }}
                data-testid="crucible-ask-ember"
              >
                <MessageCircle strokeWidth={1.5} className="h-4 w-4" aria-hidden /> Ask Ember
              </Button>
            </div>
            <p className="mt-1 text-[0.76rem] text-faint">
              Ember asks what you mean by anything vague, then puts the rule here for you to add.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={fromHistory} data-testid="crucible-from-history">
              <EmberMark /> Suggest rules from what I watch
            </Button>
            <Button tone="quiet" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const tb = (gb: number) => (gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${Math.round(gb)} GB`);

/**
 * What the rules would do to your own library: the space now and under the rules, real titles
 * with what each gets, and "Why?" for any of them.
 */
export function RulesPreview({
  k,
  rows,
  library,
}: {
  k: RulesKind;
  rows: CrucibleRow[];
  library: CrucibleLibrary;
}) {
  const kind = kindOf(k);
  const [q, setQ] = useState("");
  const [why, setWhy] = useState<number>();
  const est = useMemo(
    () => spaceEstimate(library.titles, rows, THIS_YEAR, kind),
    [library.titles, rows, kind],
  );
  // A few real titles from each rule, so every rule shows what it does.
  const sample = useMemo(() => {
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      return library.titles.filter((t) => t.title.toLowerCase().includes(needle)).slice(0, 8);
    }
    const out: CrucibleLibrary["titles"] = [];
    for (const r of rows) {
      const mine = library.titles.filter((t) => rowFor(t, rows, THIS_YEAR) === r);
      out.push(...mine.slice(0, 2));
    }
    return out.slice(0, 10);
  }, [library.titles, rows, q]);
  if (!library.titles.length) return null;
  return (
    <section className="space-y-3 rounded-xl border border-line p-3" data-testid="crucible-preview">
      <h3 className="text-[0.92rem] font-semibold text-ink">What your {k.many} would get</h3>
      {kind === "movie" && (
        <p className="text-[0.84rem] text-muted" data-testid="crucible-space">
          Your movies take {tb(est.nowGB)} now. Under these rules they'd aim for about{" "}
          <span className="text-ink">{tb(est.rulesGB)}</span>
          {est.missing > 0 &&
            `, counting about ${tb(est.missingGB)} for the ${est.missing} not downloaded yet`}
          .{" "}
          {est.overAllowance > 0 &&
            `${est.overAllowance} ${est.overAllowance === 1 ? "is" : "are"} bigger than their rule allows; ${est.overAllowance === 1 ? "it's" : "they're"} kept as they are, nothing is deleted.`}
        </p>
      )}
      <input
        className={cx(field, "w-full")}
        placeholder={`Find one of your ${k.many} to see what it gets`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="crucible-preview-find"
      />
      <ul className="divide-y divide-line">
        {sample.map((t) => {
          const r = rowFor(t, rows, THIS_YEAR);
          const open = why === t.id;
          return (
            <li key={t.id} className="py-2" data-testid="crucible-preview-title">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1 text-[0.86rem] text-ink">
                  {t.title}
                  {t.year ? ` (${t.year})` : ""}
                  {t.sizeGB ? (
                    <span className="text-faint">
                      {" "}
                      · has {t.sizeGB} GB{kind === "show" ? " an episode" : ""}
                    </span>
                  ) : (
                    <span className="text-faint"> · not downloaded yet</span>
                  )}
                </span>
                <span className="text-[0.82rem] text-muted">
                  {r
                    ? r.ladder
                        .map(
                          (s) =>
                            `${QUALITY_WORDS[s.quality]}${s.maxGB === null || (kind === "show" && r !== rows.at(-1)) ? "" : ` ≤ ${s.maxGB} GB`}`,
                        )
                        .join(", else ")
                    : ""}
                </span>
                <button
                  type="button"
                  className="min-h-9 text-[0.8rem] text-gold underline-offset-4 hover:underline"
                  onClick={() => setWhy(open ? undefined : t.id)}
                  aria-expanded={open}
                >
                  Why?
                </button>
              </div>
              {open && (
                <ul
                  className="mt-1 list-disc space-y-0.5 pl-5 text-[0.8rem] text-muted"
                  data-testid="crucible-why"
                >
                  {explainTitle(t, rows, THIS_YEAR, kind).lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
