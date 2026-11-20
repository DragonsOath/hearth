import { useState } from "react";
import { Link } from "react-router";
import { HEARTH_PREFIX } from "@dragon-control/core";
import { usePanelHref } from "../../desk/links";
import { ArrowLeft, Copy, Plus, Trash2, X } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { cx } from "../../ui";
import {
  useServarr,
  useRadarr,
  type FormatShape,
  type FormatsView,
  type ProfileShape,
} from "./data";
import {
  Check,
  Field,
  Guard,
  LoadError,
  Loading,
  ProposeError,
  SubNav,
  btn,
  btnBad,
  btnGold,
  input,
  inputAuto,
  usePropose,
} from "./common";
import { ConnectionsSettings, MediaSettings, TagsSettings } from "./RadarrSettingsMore";
import { Exclusions, QualitySizes } from "./RadarrSizes";

/**
 * Radarr's Settings tab. Quality profiles and custom formats have editors built for them
 * (refinement A); tags with delay and release profiles, media management and naming, and
 * connections follow. Every save is a plan showing the exact before and after for approval, the
 * same step Ember plans. Address: "profiles[/<id>]", "formats[/<id>]", "sizes", "tags", "media",
 * "exclusions", "connections".
 */

type Part = "profiles" | "formats" | "sizes" | "tags" | "media" | "exclusions" | "connections";
const PARTS: Part[] = [
  "profiles",
  "formats",
  "sizes",
  "tags",
  "media",
  "exclusions",
  "connections",
];

export function RadarrSettings({ serviceId, sub, onSub }: AppViewProps) {
  const [head, rest] = (sub ?? "").split("/");
  const part: Part = PARTS.includes(head as Part) ? (head as Part) : "profiles";
  const id = rest && /^\d+$/.test(rest) ? Number(rest) : undefined;
  return (
    <div className="space-y-3" data-testid="radarr-settings">
      <SubNav
        label="Settings"
        target="settings"
        value={part}
        onChange={(p) => onSub?.(p === "profiles" ? null : p)}
        options={[
          { value: "profiles", label: "Quality profiles" },
          { value: "formats", label: "Custom formats" },
          { value: "sizes", label: "Quality sizes" },
          { value: "tags", label: "Tags and delays" },
          { value: "media", label: "Files and naming" },
          { value: "exclusions", label: "Exclusions" },
          { value: "connections", label: "Connections" },
        ]}
      />
      {part === "profiles" && (
        <Profiles
          serviceId={serviceId}
          id={id}
          onOpen={(i) => onSub?.(i ? `profiles/${i}` : null)}
        />
      )}
      {part === "formats" && (
        <Formats
          serviceId={serviceId}
          id={id}
          onOpen={(i) => onSub?.(i ? `formats/${i}` : "formats")}
        />
      )}
      {part === "sizes" && <QualitySizes serviceId={serviceId} />}
      {part === "exclusions" && <Exclusions serviceId={serviceId} />}
      {part === "tags" && <TagsSettings serviceId={serviceId} />}
      {part === "media" && <MediaSettings serviceId={serviceId} focus={rest} />}
      {part === "connections" && <ConnectionsSettings serviceId={serviceId} focus={rest} />}
    </div>
  );
}

/* ---------- Quality profiles ---------- */

function Profiles({
  serviceId,
  id,
  onOpen,
}: {
  serviceId: string;
  id?: number;
  onOpen: (id?: number) => void;
}) {
  const q = useRadarr(serviceId, "profiles");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const open = id !== undefined ? q.data.profiles.find((p) => p.id === id) : undefined;
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      {open ? (
        <ProfileEditor key={open.id} serviceId={serviceId} p={open} onBack={() => onOpen()} />
      ) : (
        <ProfileList serviceId={serviceId} profiles={q.data.profiles} onOpen={onOpen} />
      )}
    </Guard>
  );
}

function ProfileList({
  serviceId,
  profiles,
  onOpen,
}: {
  serviceId: string;
  profiles: ProfileShape[];
  onOpen: (id: number) => void;
}) {
  const w = useServarr();
  const act = usePropose(serviceId);
  const [copying, setCopying] = useState<number>();
  const [name, setName] = useState("");
  return (
    <div className="space-y-2" data-testid="radarr-profiles">
      <p className="text-[0.8rem] text-muted">
        A quality profile decides which qualities {w.name} downloads for a {w.item} and when it
        stops upgrading.
      </p>
      <ul className="space-y-2">
        {profiles.map((p) => (
          <li key={p.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-start gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onOpen(p.id)}
                data-hearth-target={`profile:${p.id}`}
              >
                <p className="text-[0.92rem] text-ink hover:text-gold">{p.name}</p>
                <p className="text-[0.76rem] text-faint">
                  {p.used} {w.items} · {p.items.filter((i) => i.allowed).length} qualities allowed ·{" "}
                  {p.upgradeAllowed ? `upgrades until ${p.cutoffName ?? "?"}` : "no upgrades"}
                </p>
              </button>
              <ManagedByCrucible name={p.name} />
              <button
                type="button"
                className={btn}
                disabled={!act.can}
                data-hearth-target={`profile:${p.id}:copy`}
                onClick={() => {
                  setCopying(p.id);
                  setName(`${p.name} (copy)`);
                }}
              >
                <Copy strokeWidth={1.5} className="h-3.5 w-3.5" /> Copy
              </button>
              {p.used === 0 && (
                <button
                  type="button"
                  className={btnBad}
                  disabled={!act.can || act.busy}
                  data-hearth-target={`profile:${p.id}:remove`}
                  onClick={() =>
                    act.propose(
                      "app-arr-delete",
                      { resource: "qualityprofile", id: p.id },
                      `Remove the "${p.name}" quality profile from ${w.name}`,
                    )
                  }
                >
                  <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
                </button>
              )}
            </div>
            {copying === p.id && (
              <form
                className="mt-2 flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  act.propose(
                    "app-arr-create",
                    {
                      resource: "qualityprofile",
                      cloneFrom: p.id,
                      body: JSON.stringify({ name: name.trim() }),
                    },
                    `Add the quality profile "${name.trim()}" (a copy of ${p.name}) to ${w.name}`,
                  );
                  setCopying(undefined);
                }}
              >
                <label className="sr-only" htmlFor={`copy-${p.id}`}>
                  Name of the copy
                </label>
                <input
                  id={`copy-${p.id}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={cx(input, "flex-1")}
                />
                <button type="submit" className={btnGold} disabled={!name.trim() || act.busy}>
                  Review
                </button>
                <button type="button" className={btn} onClick={() => setCopying(undefined)}>
                  Cancel
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

function ProfileEditor({
  serviceId,
  p,
  onBack,
}: {
  serviceId: string;
  p: ProfileShape;
  onBack: () => void;
}) {
  const w = useServarr();
  const act = usePropose(serviceId);
  const [name, setName] = useState(p.name);
  const [upgrade, setUpgrade] = useState(p.upgradeAllowed);
  const [allowed, setAllowed] = useState<number[]>(
    p.items.filter((i) => i.allowed).map((i) => i.id),
  );
  const [cutoff, setCutoff] = useState(p.cutoff);
  const [minScore, setMinScore] = useState(p.minFormatScore);
  const [cutoffScore, setCutoffScore] = useState(p.cutoffFormatScore);
  const [step, setStep] = useState(p.minUpgradeFormatScore);
  const [scores, setScores] = useState<Record<number, number>>(
    Object.fromEntries(p.formatItems.map((f) => [f.format, f.score])),
  );
  // Radarr's saved profile changed (an approved plan, yours or Ember's): the form shows the new
  // values, never an old draft against values that are gone.
  const saved = JSON.stringify(p);
  const [base, setBase] = useState(saved);
  if (base !== saved) {
    setBase(saved);
    setName(p.name);
    setUpgrade(p.upgradeAllowed);
    setAllowed(p.items.filter((i) => i.allowed).map((i) => i.id));
    setCutoff(p.cutoff);
    setMinScore(p.minFormatScore);
    setCutoffScore(p.cutoffFormatScore);
    setStep(p.minUpgradeFormatScore);
    setScores(Object.fromEntries(p.formatItems.map((f) => [f.format, f.score])));
  }

  const changes: Record<string, unknown> = {};
  if (name.trim() && name.trim() !== p.name) changes.name = name.trim();
  if (upgrade !== p.upgradeAllowed) changes.upgradeAllowed = upgrade;
  const before = p.items.filter((i) => i.allowed).map((i) => i.id);
  if ([...allowed].sort().join() !== [...before].sort().join()) changes.allowedQualities = allowed;
  if (cutoff !== p.cutoff) changes.cutoff = cutoff;
  if (minScore !== p.minFormatScore) changes.minFormatScore = minScore;
  if (cutoffScore !== p.cutoffFormatScore) changes.cutoffFormatScore = cutoffScore;
  if (step !== p.minUpgradeFormatScore) changes.minUpgradeFormatScore = step;
  const changedScores = Object.fromEntries(
    p.formatItems
      .filter((f) => scores[f.format] !== f.score)
      .map((f) => [String(f.format), scores[f.format]]),
  );
  if (Object.keys(changedScores).length) changes.formatScores = changedScores;
  const dirty = Object.keys(changes).length > 0;
  const allowedItems = p.items.filter((i) => allowed.includes(i.id));
  const cutoffOk = !upgrade || allowedItems.some((i) => i.id === cutoff);

  return (
    <div className="space-y-4" data-testid="radarr-profile-editor">
      <button type="button" className={btn} onClick={onBack}>
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Quality profiles
      </button>
      <Field label="Name" htmlFor={`pname-${p.id}`}>
        <input
          id={`pname-${p.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={input}
          data-hearth-target={`profile:${p.id}:name`}
        />
      </Field>
      <p className="text-[0.78rem] text-faint">
        Used by {p.used} {w.items}. Changes apply to all of them.
      </p>

      <fieldset className="space-y-1">
        <legend className="text-[0.8rem] text-muted">Allowed qualities (best at the top)</legend>
        <div
          className="grid gap-x-4 rounded-xl border border-line p-2 sm:grid-cols-2"
          data-hearth-target={`profile:${p.id}:qualities`}
        >
          {[...p.items].reverse().map((i) => (
            <Check
              key={i.id}
              checked={allowed.includes(i.id)}
              onChange={(on) =>
                setAllowed((a) => (on ? [...a, i.id] : a.filter((x) => x !== i.id)))
              }
              label={
                <span>
                  {i.name}
                  {i.group && <span className="text-faint"> ({i.group.join(", ")})</span>}
                </span>
              }
            />
          ))}
        </div>
      </fieldset>

      <Check
        checked={upgrade}
        onChange={setUpgrade}
        target={`profile:${p.id}:upgrades`}
        label="Upgrade to better releases when they appear"
      />
      {upgrade && (
        <Field
          label="Upgrade until"
          htmlFor={`cutoff-${p.id}`}
          hint={`${w.name} stops looking for better quality once a file reaches this.`}
        >
          <select
            id={`cutoff-${p.id}`}
            value={cutoff}
            onChange={(e) => setCutoff(Number(e.target.value))}
            className={input}
            data-hearth-target={`profile:${p.id}:cutoff`}
          >
            {[...allowedItems].reverse().map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!cutoffOk && (
        <p className="text-[0.8rem] text-amber">Pick an "upgrade until" quality that is allowed.</p>
      )}

      <details
        className="rounded-xl border border-line p-3"
        open={p.formatItems.some((f) => f.score !== 0)}
      >
        <summary className="cursor-pointer text-[0.84rem] text-ink">Custom format scores</summary>
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {(
              [
                [
                  "Minimum score",
                  minScore,
                  setMinScore,
                  "A release scoring lower is never downloaded.",
                ],
                [
                  "Upgrade until score",
                  cutoffScore,
                  setCutoffScore,
                  "Upgrades stop at this score.",
                ],
                ["Minimum increase", step, setStep, "How much better an upgrade must score."],
              ] as const
            ).map(([label, v, set, hint]) => (
              <Field key={label} label={label} hint={hint}>
                <input
                  type="number"
                  value={v}
                  onChange={(e) => set(Number(e.target.value))}
                  className={input}
                  aria-label={label}
                />
              </Field>
            ))}
          </div>
          <table className="w-full text-[0.82rem]" data-hearth-target={`profile:${p.id}:scores`}>
            <thead>
              <tr className="text-left text-faint">
                <th className="py-1 font-normal">Custom format</th>
                <th className="w-28 py-1 font-normal">Score</th>
              </tr>
            </thead>
            <tbody>
              {p.formatItems.map((f) => (
                <tr key={f.format} className="border-t border-line">
                  <td className="py-1 text-ink">{f.name}</td>
                  <td className="py-1">
                    <input
                      type="number"
                      aria-label={`Score for ${f.name}`}
                      value={scores[f.format] ?? 0}
                      onChange={(e) =>
                        setScores((s) => ({ ...s, [f.format]: Number(e.target.value) }))
                      }
                      className={cx(input, "min-h-8 py-0")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!dirty || !cutoffOk || allowed.length === 0 || !act.can || act.busy}
          data-hearth-target={`profile:${p.id}:save`}
          onClick={() =>
            act.propose(
              "app-arr-edit",
              { resource: "qualityprofile", id: p.id, changes: JSON.stringify(changes) },
              `Change the "${p.name}" quality profile in ${w.name}`,
            )
          }
        >
          Review change
        </button>
        {dirty && (
          <span className="text-[0.76rem] text-faint">You approve the exact change next.</span>
        )}
      </div>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

/* ---------- Custom formats ---------- */

function Formats({
  serviceId,
  id,
  onOpen,
}: {
  serviceId: string;
  id?: number;
  onOpen: (id?: number) => void;
}) {
  const q = useRadarr(serviceId, "formats");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const open = id !== undefined ? q.data.formats.find((f) => f.id === id) : undefined;
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      {open ? (
        <FormatEditor
          key={open.id}
          serviceId={serviceId}
          f={open}
          d={q.data}
          onBack={() => onOpen()}
        />
      ) : (
        <FormatList serviceId={serviceId} d={q.data} onOpen={onOpen} />
      )}
    </Guard>
  );
}

const conditionWords = (c: FormatShape["conditions"][number]) =>
  `${c.required ? "must " : ""}${c.negate ? "not " : ""}match ${c.typeName} "${String(c.value ?? "")}"`;

function FormatList({
  serviceId,
  d,
  onOpen,
}: {
  serviceId: string;
  d: FormatsView;
  onOpen: (id: number) => void;
}) {
  const w = useServarr();
  const act = usePropose(serviceId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="space-y-3" data-testid="radarr-formats">
      <p className="text-[0.8rem] text-muted">
        Custom formats recognise things in a release (a codec, an edition, a release group). Each
        quality profile gives them a score.
      </p>
      <Preview serviceId={serviceId} />
      <ul className="space-y-2">
        {d.formats.map((f) => (
          <li
            key={f.id}
            className="flex flex-wrap items-start gap-2 rounded-xl border border-line p-3"
          >
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onOpen(f.id)}
              data-hearth-target={`format:${f.id}`}
            >
              <p className="text-[0.9rem] text-ink hover:text-gold">{f.name}</p>
              <p className="text-[0.76rem] text-faint">
                {f.conditions.map(conditionWords).join("; ") || "No conditions"}
              </p>
              <p className="text-[0.74rem] text-faint">
                {d.scores
                  .map(
                    (s) => `${s.profile}: ${s.scores.find((x) => x.format === f.id)?.score ?? 0}`,
                  )
                  .join(" · ")}
              </p>
            </button>
            <ManagedByCrucible name={f.name} />
            <button
              type="button"
              className={btnBad}
              disabled={!act.can || act.busy}
              data-hearth-target={`format:${f.id}:remove`}
              onClick={() =>
                act.propose(
                  "app-arr-delete",
                  { resource: "customformat", id: f.id },
                  `Remove the "${f.name}" custom format from ${w.name}`,
                )
              }
            >
              <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act.propose(
              "app-arr-create",
              {
                resource: "customformat",
                body: JSON.stringify({
                  name: name.trim(),
                  includeCustomFormatWhenRenaming: false,
                  specifications: [],
                }),
              },
              `Add the custom format "${name.trim()}" to ${w.name}`,
            );
            setAdding(false);
          }}
        >
          <label className="sr-only" htmlFor="new-format">
            Name
          </label>
          <input
            id="new-format"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className={cx(input, "flex-1")}
          />
          <button type="submit" className={btnGold} disabled={!name.trim()}>
            Review
          </button>
          <button type="button" className={btn} onClick={() => setAdding(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className={btn}
          disabled={!act.can}
          data-hearth-target="format:add"
          onClick={() => setAdding(true)}
        >
          <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add a custom format
        </button>
      )}
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

/** What Radarr itself makes of a release name: its custom formats and score (D13). */
function Preview({ serviceId }: { serviceId: string }) {
  const w = useServarr();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const q = useRadarr(serviceId, "parse", { title }, title.length > 0);
  return (
    <div
      className="space-y-2 rounded-xl border border-line p-3"
      data-testid="radarr-format-preview"
    >
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTitle(text.trim());
        }}
      >
        <label className="sr-only" htmlFor={`parse-${serviceId}`}>
          Release name to check
        </label>
        <input
          id={`parse-${serviceId}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Check a release name, e.g. Movie.2024.1080p.WEB-DL.x265-GROUP"
          className={cx(input, "flex-1")}
          data-hearth-target="format:preview"
        />
        <button type="submit" className={btn} disabled={!text.trim()}>
          Check
        </button>
      </form>
      {q.isFetching && <p className="text-[0.8rem] text-faint">Asking {w.name}...</p>}
      {q.isError && <LoadError error={q.error} />}
      {q.data && !q.isFetching && (
        <p className="text-[0.82rem] text-ink" data-testid="radarr-preview-result">
          {q.data.formats.length ? (
            <>
              {w.name} matches <strong>{q.data.formats.join(", ")}</strong>, score {q.data.score}.
            </>
          ) : (
            `${w.name} matches no custom format.`
          )}
          {q.data.quality && <span className="text-faint"> Quality: {q.data.quality}.</span>}
        </p>
      )}
      <p className="text-[0.74rem] text-faint">
        This is {w.name}'s own matching, for the formats as saved. A change you are editing shows
        here after you approve it.
      </p>
    </div>
  );
}

interface EditCondition {
  name: string;
  type: string;
  typeName: string;
  negate: boolean;
  required: boolean;
  value: string;
  numeric: boolean;
}

function FormatEditor({
  serviceId,
  f,
  d,
  onBack,
}: {
  serviceId: string;
  f: FormatShape;
  d: FormatsView;
  onBack: () => void;
}) {
  const w = useServarr();
  const act = usePropose(serviceId);
  const [name, setName] = useState(f.name);
  const [rename, setRename] = useState(f.includeWhenRenaming);
  const start: EditCondition[] = f.conditions.map((c) => ({
    ...c,
    value: String(c.value ?? ""),
    numeric: typeof c.value === "number",
  }));
  const [conds, setConds] = useState<EditCondition[]>(start);
  const toSpec = (c: EditCondition) => ({
    name: c.name,
    implementation: c.type,
    implementationName: c.typeName,
    negate: c.negate,
    required: c.required,
    fields: [{ name: "value", value: c.numeric ? Number(c.value) : c.value }],
  });
  const changes: Record<string, unknown> = {};
  if (name.trim() && name.trim() !== f.name) changes.name = name.trim();
  if (rename !== f.includeWhenRenaming) changes.includeCustomFormatWhenRenaming = rename;
  if (JSON.stringify(conds) !== JSON.stringify(start)) changes.specifications = conds.map(toSpec);
  const dirty = Object.keys(changes).length > 0;
  const valid = conds.every((c) => c.name.trim() && c.value.trim());
  const set = (i: number, patch: Partial<EditCondition>) =>
    setConds((all) => all.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <div className="space-y-4" data-testid="radarr-format-editor">
      <button type="button" className={btn} onClick={onBack}>
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Custom formats
      </button>
      <Field label="Name" htmlFor={`fname-${f.id}`}>
        <input
          id={`fname-${f.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={input}
          data-hearth-target={`format:${f.id}:name`}
        />
      </Field>
      <Check checked={rename} onChange={setRename} label="Include in file names when renaming" />
      <fieldset className="space-y-2" data-hearth-target={`format:${f.id}:conditions`}>
        <legend className="text-[0.8rem] text-muted">
          Conditions: a release matches when every required one and at least one other matches.
        </legend>
        {conds.map((c, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-line p-3">
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Condition type"
                value={c.type}
                onChange={(e) =>
                  set(i, {
                    type: e.target.value,
                    typeName:
                      d.conditionTypes.find((t) => t.type === e.target.value)?.name ??
                      e.target.value,
                  })
                }
                className={inputAuto}
              >
                {d.conditionTypes.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input
                aria-label="Condition name"
                value={c.name}
                onChange={(e) => set(i, { name: e.target.value })}
                placeholder="Name"
                className={cx(input, "w-40 flex-1")}
              />
              <button
                type="button"
                aria-label={`Remove condition ${c.name}`}
                className={btn}
                onClick={() => setConds((all) => all.filter((_, j) => j !== i))}
              >
                <X strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
            </div>
            <input
              aria-label="Condition value"
              value={c.value}
              onChange={(e) => set(i, { value: e.target.value })}
              placeholder={
                c.type === "ReleaseTitleSpecification"
                  ? "Regular expression, e.g. \\bx265\\b"
                  : "Value"
              }
              className={cx(input, "font-mono")}
            />
            <div className="flex flex-wrap gap-x-4">
              <Check
                checked={c.negate}
                onChange={(v) => set(i, { negate: v })}
                label="Must not match"
              />
              <Check
                checked={c.required}
                onChange={(v) => set(i, { required: v })}
                label="Required"
              />
            </div>
          </div>
        ))}
        <button
          type="button"
          className={btn}
          onClick={() =>
            setConds((all) => [
              ...all,
              {
                name: "",
                type: "ReleaseTitleSpecification",
                typeName: "Release Title",
                negate: false,
                required: false,
                value: "",
                numeric: false,
              },
            ])
          }
        >
          <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add a condition
        </button>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!dirty || !valid || !act.can || act.busy}
          data-hearth-target={`format:${f.id}:save`}
          onClick={() =>
            act.propose(
              "app-arr-edit",
              { resource: "customformat", id: f.id, changes: JSON.stringify(changes) },
              `Change the "${f.name}" custom format in ${w.name}`,
            )
          }
        >
          Review change
        </button>
        {!valid && (
          <span className="text-[0.76rem] text-amber">
            Every condition needs a name and a value.
          </span>
        )}
      </div>
      <Preview serviceId={serviceId} />
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

/** A profile or format the Crucible made: says so, with a link (its rows are changed there). */
function ManagedByCrucible({ name }: { name: string }) {
  const href = usePanelHref()("tool:crucible");
  if (!name.startsWith(HEARTH_PREFIX)) return null;
  return href ? (
    <Link
      to={href}
      className="inline-flex min-h-9 items-center rounded-full border border-gold/40 px-3 text-[0.74rem] text-gold"
      data-testid="managed-by-crucible"
    >
      Managed by The Crucible
    </Link>
  ) : (
    <span className="text-[0.74rem] text-gold">Managed by The Crucible</span>
  );
}
