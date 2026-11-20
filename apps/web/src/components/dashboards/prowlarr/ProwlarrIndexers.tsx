import { useState } from "react";
import { ArrowLeft, FlaskConical, KeyRound, Plus, Power, RefreshCw, Search } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { cx } from "../../ui";
import { ConnectionItem } from "../radarr/RadarrSettingsMore";
import {
  Check,
  Field,
  Guard,
  LoadError,
  Loading,
  ProposeError,
  btn,
  btnGold,
  input,
  inputAuto,
  usePropose,
  when,
} from "../radarr/common";
import {
  EVENT_WORDS,
  PRIVACY,
  useProwlarr,
  type AppProfile,
  type IndexerRow,
  type TagRef,
} from "./data";

/**
 * Prowlarr's Indexers tab: every indexer with how it is doing (failing first), testing one or
 * all, switching one on or off, pushing them to the apps; an indexer's own page with its
 * settings, sync profile, tags and recent searches; and adding one from Prowlarr's definitions.
 * Address: "", "indexer/<id>", "add", "add/<definition name>".
 */
export function ProwlarrIndexers({ serviceId, sub, onSub }: AppViewProps) {
  const [head, ...rest] = (sub ?? "").split("/");
  const id = head === "indexer" && /^\d+$/.test(rest[0] ?? "") ? Number(rest[0]) : undefined;
  if (id !== undefined)
    return <IndexerPage serviceId={serviceId} id={id} onBack={() => onSub?.(null)} />;
  if (head === "add")
    return (
      <AddIndexer
        serviceId={serviceId}
        picked={rest.length ? decodeURIComponent(rest.join("/")) : undefined}
        onPick={(name) => onSub?.(name ? `add/${encodeURIComponent(name)}` : "add")}
        onBack={() => onSub?.(null)}
      />
    );
  return (
    <IndexerList
      serviceId={serviceId}
      onOpen={(i) => onSub?.(`indexer/${i}`)}
      onAdd={() => onSub?.("add")}
    />
  );
}

function IndexerList({
  serviceId,
  onOpen,
  onAdd,
}: {
  serviceId: string;
  onOpen: (id: number) => void;
  onAdd: () => void;
}) {
  const q = useProwlarr(serviceId, "indexers");
  const act = usePropose(serviceId);
  const [filter, setFilter] = useState("");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const d = q.data;
  const rows = [...d.indexers]
    .filter((i) => !filter || i.name.toLowerCase().includes(filter.toLowerCase()))
    .sort(
      (a, b) =>
        Number(b.failing) - Number(a.failing) ||
        Number(b.enabled) - Number(a.enabled) ||
        a.priority - b.priority ||
        a.name.localeCompare(b.name),
    );
  const failing = d.indexers.filter((i) => i.failing).length;
  return (
    <Guard meta={d.meta} sample={d.sample}>
      <div className="space-y-3" data-testid="prowlarr-indexers">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto text-[0.84rem] text-muted">
            {d.indexers.length} indexers, {d.indexers.filter((i) => i.enabled).length} on
            {failing ? <span className="text-alert"> · {failing} failing</span> : null}
          </p>
          <button
            type="button"
            className={btnGold}
            onClick={onAdd}
            data-hearth-target="indexers:add"
          >
            <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add an indexer
          </button>
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target="indexers:test-all"
            onClick={() =>
              act.propose("app-prowlarr-indexer", { op: "test-all" }, "Test all indexers")
            }
          >
            <FlaskConical strokeWidth={1.5} className="h-3.5 w-3.5" /> Test all
          </button>
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target="indexers:sync"
            onClick={() =>
              act.propose(
                "app-arr-command",
                { command: "ApplicationIndexerSync" },
                "Push the indexers to the apps",
              )
            }
          >
            <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Push to apps
          </button>
        </div>
        {d.indexers.length > 6 && (
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter indexers"
            aria-label="Filter indexers"
            className={input}
            data-hearth-target="indexers:filter"
          />
        )}
        <ProposeError error={act.error} />
        {act.dialog}
        {rows.length === 0 ? (
          <p className="text-[0.86rem] text-muted">
            No indexers yet. Add one from Prowlarr&apos;s list of sites.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((i) => (
              <IndexerCard
                key={i.id}
                i={i}
                profiles={d.appProfiles}
                act={act}
                onOpen={() => onOpen(i.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </Guard>
  );
}

function IndexerCard({
  i,
  profiles,
  act,
  onOpen,
}: {
  i: IndexerRow;
  profiles: AppProfile[];
  act: ReturnType<typeof usePropose>;
  onOpen: () => void;
}) {
  return (
    <li
      className={cx(
        "rounded-xl border p-3",
        i.failing ? "border-alert/50 bg-alert/[0.03]" : "border-line",
      )}
      data-testid="prowlarr-indexer-row"
      data-hearth-target={`indexer:${i.id}`}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <span
          className={cx(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            !i.enabled ? "bg-line-strong" : i.failing ? "bg-alert" : "bg-ok",
          )}
          aria-hidden
        />
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
          data-hearth-target={`indexer:${i.id}:open`}
        >
          <span className="block truncate text-[0.9rem] text-ink hover:text-gold">{i.name}</span>
          <span className="block text-[0.74rem] text-faint">
            {PRIVACY[i.privacy] ?? i.privacy} · {i.protocol} · priority {i.priority}
            {profiles.length > 1 && i.appProfileId
              ? ` · ${profiles.find((p) => p.id === i.appProfileId)?.name ?? ""}`
              : ""}
            {i.enabled ? "" : " · off"}
          </span>
          {i.failing && (
            <span className="mt-1 block text-[0.78rem] text-alert">
              {i.pausedUntil
                ? `Prowlarr paused it until ${when(i.pausedUntil)} after failures.`
                : `Failed ${when(i.lastFailure)}.`}
            </span>
          )}
        </button>
        <span className="text-[0.74rem] text-muted tabular">
          {i.queries} searches · {i.grabs} grabs this week
          {i.failedQueries ? ` · ${i.failedQueries} failed` : ""}
          {i.avgMs ? ` · ${i.avgMs} ms` : ""}
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target={`indexer:${i.id}:test`}
            onClick={() =>
              act.propose("app-prowlarr-indexer", { op: "test", indexerId: i.id }, `Test ${i.name}`)
            }
          >
            Test
          </button>
          <button
            type="button"
            className={btn}
            disabled={!act.can || act.busy}
            data-hearth-target={`indexer:${i.id}:toggle`}
            onClick={() =>
              act.propose(
                "app-prowlarr-indexer",
                { op: i.enabled ? "disable" : "enable", indexerId: i.id },
                `Turn ${i.name} ${i.enabled ? "off" : "on"}`,
              )
            }
          >
            <Power strokeWidth={1.5} className="h-3.5 w-3.5" /> {i.enabled ? "Off" : "On"}
          </button>
        </div>
      </div>
    </li>
  );
}

function TagPicker({
  tags,
  value,
  onChange,
  target,
}: {
  tags: TagRef[];
  value: number[];
  onChange: (v: number[]) => void;
  target: string;
}) {
  if (tags.length === 0)
    return <p className="text-[0.8rem] text-faint">No tags yet (Settings, Tags).</p>;
  return (
    <div className="flex flex-wrap gap-x-3">
      {tags.map((t) => (
        <Check
          key={t.id}
          checked={value.includes(t.id)}
          onChange={(on) => onChange(on ? [...value, t.id] : value.filter((x) => x !== t.id))}
          label={t.label}
          target={`${target}:tag:${t.id}`}
        />
      ))}
    </div>
  );
}

const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

function IndexerPage({
  serviceId,
  id,
  onBack,
}: {
  serviceId: string;
  id: number;
  onBack: () => void;
}) {
  const q = useProwlarr(serviceId, "indexer", { id });
  const [profile, setProfile] = useState<number>();
  const [tags, setTags] = useState<number[]>();
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const { indexer: ix, history } = q.data;
  const curTags = tags ?? ix.tags;
  const curProfile = profile ?? ix.appProfileId;
  const extra = {
    appProfileId: curProfile !== ix.appProfileId ? curProfile : undefined,
    tags: sameSet(curTags, ix.tags) ? undefined : curTags,
  };
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-4" data-testid="prowlarr-indexer-page">
        <button type="button" className={btn} onClick={onBack} data-hearth-target="indexer:back">
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> All indexers
        </button>
        <div>
          <h3 className="text-[1.05rem] text-ink">{ix.name}</h3>
          <p className="text-[0.8rem] text-muted">
            {ix.definition} · {PRIVACY[ix.privacy] ?? ix.privacy} · {ix.protocol}
            {ix.urls[0] ? ` · ${ix.urls[0]}` : ""}
          </p>
          {ix.description && <p className="mt-1 text-[0.8rem] text-faint">{ix.description}</p>}
          {ix.categories.length > 0 && (
            <p className="mt-1 text-[0.76rem] text-faint">Has: {ix.categories.join(", ")}</p>
          )}
        </div>
        <ConnectionItem serviceId={serviceId} c={ix} extra={extra} open>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Sync profile"
              hint="Which searches the apps may use it for."
              htmlFor="ix-profile"
            >
              <select
                id="ix-profile"
                value={curProfile ?? ""}
                onChange={(e) => setProfile(Number(e.target.value))}
                className={input}
                data-hearth-target={`indexer:${ix.id}:profile`}
              >
                {q.data.appProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Tags" hint="Tags pick its proxy and which apps get it.">
              <TagPicker
                tags={q.data.tags}
                value={curTags}
                onChange={setTags}
                target={`indexer:${ix.id}`}
              />
            </Field>
          </div>
        </ConnectionItem>
        <section className="space-y-2">
          <h4 className="eyebrow">Recent activity</h4>
          {history.length === 0 ? (
            <p className="text-[0.82rem] text-muted">Nothing recent.</p>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line text-[0.8rem]">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap gap-x-3 px-3 py-2">
                  <span className={h.successful ? "text-ink" : "text-alert"}>
                    {EVENT_WORDS[h.event] ?? h.event}
                    {h.successful ? "" : " (failed)"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted">
                    {h.title ?? h.query ?? ""}
                  </span>
                  <span className="text-faint">
                    {h.source ? `${h.source} · ` : ""}
                    {when(h.date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Guard>
  );
}

function AddIndexer({
  serviceId,
  picked,
  onPick,
  onBack,
}: {
  serviceId: string;
  picked?: string;
  onPick: (name?: string) => void;
  onBack: () => void;
}) {
  const [term, setTerm] = useState("");
  const [privacy, setPrivacy] = useState("");
  const [protocol, setProtocol] = useState("");
  const list = useProwlarr(serviceId, "definitions", { term, privacy, protocol }, !picked);
  if (picked)
    return <AddForm serviceId={serviceId} name={picked} onBack={() => onPick(undefined)} />;
  return (
    <div className="space-y-3" data-testid="prowlarr-add-indexer">
      <button type="button" className={btn} onClick={onBack} data-hearth-target="add:back">
        <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> All indexers
      </button>
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-0 flex-1">
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Find a site by name"
            aria-label="Find a site by name"
            className={`${input} pl-9`}
            data-hearth-target="add:search"
          />
        </label>
        <select
          value={privacy}
          onChange={(e) => setPrivacy(e.target.value)}
          aria-label="Kind of site"
          className={inputAuto}
          data-hearth-target="add:privacy"
        >
          <option value="">Any kind</option>
          <option value="public">Public</option>
          <option value="semiPrivate">Semi-private</option>
          <option value="private">Private</option>
        </select>
        <select
          value={protocol}
          onChange={(e) => setProtocol(e.target.value)}
          aria-label="Torrent or usenet"
          className={inputAuto}
          data-hearth-target="add:protocol"
        >
          <option value="">Torrent and usenet</option>
          <option value="torrent">Torrent</option>
          <option value="usenet">Usenet</option>
        </select>
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <LoadError error={list.error} />
      ) : (
        <>
          <p className="text-[0.78rem] text-faint">
            {list.data.matches} of {list.data.total} sites
            {list.data.matches > list.data.definitions.length
              ? `, showing the first ${list.data.definitions.length}: narrow the search`
              : ""}
          </p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {list.data.definitions.map((d) => (
              <li key={d.name}>
                <button
                  type="button"
                  onClick={() => onPick(d.name)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-gold/[0.04]"
                  data-testid="prowlarr-definition"
                  data-hearth-target={`add:pick:${d.name}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.86rem] text-ink">{d.name}</span>
                    {d.description && (
                      <span className="block truncate text-[0.74rem] text-faint">
                        {d.description}
                      </span>
                    )}
                  </span>
                  <span className="text-[0.74rem] text-muted">
                    {PRIVACY[d.privacy] ?? d.privacy} · {d.protocol}
                  </span>
                  {d.needsSecret && (
                    <span className="inline-flex items-center gap-1 text-[0.72rem] text-amber">
                      <KeyRound strokeWidth={1.5} className="h-3 w-3" /> Needs a login or key
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AddForm({
  serviceId,
  name,
  onBack,
}: {
  serviceId: string;
  name: string;
  onBack: () => void;
}) {
  const q = useProwlarr(serviceId, "definition", { name });
  const act = usePropose(serviceId);
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [title, setTitle] = useState<string>();
  const [profile, setProfile] = useState<number>();
  const [priority, setPriority] = useState(25);
  const [tags, setTags] = useState<number[]>([]);
  const [enable, setEnable] = useState(true);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const d = q.data.definition;
  const editable = d.fields.filter(
    (f) => !f.secret && ["textbox", "number", "checkbox", "url", "select"].includes(f.type),
  );
  const value = (f: (typeof editable)[number]) => (f.name in vals ? vals[f.name] : f.value);
  const changed = Object.fromEntries(
    editable
      .filter((f) => f.name in vals && vals[f.name] !== f.value)
      .map((f) => [f.name, vals[f.name]]),
  );
  const secrets = d.fields.filter((f) => f.secret);
  const control = (f: (typeof editable)[number]) =>
    f.type === "checkbox" ? (
      <Check
        key={f.name}
        checked={value(f) === true}
        onChange={(v) => setVals((s) => ({ ...s, [f.name]: v }))}
        label={f.label}
        target={`add:field:${f.name}`}
      />
    ) : (
      <Field key={f.name} label={f.label} hint={f.help} htmlFor={`add-${f.name}`}>
        {f.options ? (
          <select
            id={`add-${f.name}`}
            value={String(value(f) ?? "")}
            onChange={(e) => {
              const o = f.options!.find((x) => String(x.value) === e.target.value);
              setVals((s) => ({ ...s, [f.name]: o ? o.value : e.target.value }));
            }}
            className={input}
            data-hearth-target={`add:field:${f.name}`}
          >
            {f.options.map((o) => (
              <option key={String(o.value)} value={String(o.value)}>
                {o.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={`add-${f.name}`}
            type={f.type === "number" ? "number" : "text"}
            value={String(value(f) ?? "")}
            onChange={(e) =>
              setVals((s) => ({
                ...s,
                [f.name]:
                  f.type === "number"
                    ? e.target.value === ""
                      ? null
                      : Number(e.target.value)
                    : e.target.value,
              }))
            }
            className={input}
            data-hearth-target={`add:field:${f.name}`}
          />
        )}
      </Field>
    );
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-4" data-testid="prowlarr-add-form">
        <button type="button" className={btn} onClick={onBack} data-hearth-target="add:back">
          <ArrowLeft strokeWidth={1.5} className="h-3.5 w-3.5" /> Choose another site
        </button>
        <div>
          <h3 className="text-[1.05rem] text-ink">{d.name}</h3>
          <p className="text-[0.8rem] text-muted">
            {PRIVACY[d.privacy] ?? d.privacy} · {d.protocol}
            {d.language ? ` · ${d.language}` : ""}
          </p>
          {d.description && <p className="mt-1 text-[0.8rem] text-faint">{d.description}</p>}
        </div>
        {secrets.length > 0 && (
          <p className="flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/[0.05] px-3 py-2 text-[0.8rem] text-amber">
            <KeyRound strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" />
            This site can take {secrets.map((f) => f.label.toLowerCase()).join(", ")}. Hearth does
            not send logins or keys from a plan yet, so they stay empty. If the site needs one,
            Prowlarr refuses it and says why; add it in Prowlarr itself for now.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="add-name">
            <input
              id="add-name"
              value={title ?? d.name}
              onChange={(e) => setTitle(e.target.value)}
              className={input}
              data-hearth-target="add:name"
            />
          </Field>
          <Field label="Sync profile" htmlFor="add-profile">
            <select
              id="add-profile"
              value={profile ?? q.data.appProfiles[0]?.id ?? ""}
              onChange={(e) => setProfile(Number(e.target.value))}
              className={input}
              data-hearth-target="add:profile"
            >
              {q.data.appProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" hint="1 to 50, lower is used first." htmlFor="add-priority">
            <input
              id="add-priority"
              type="number"
              min={1}
              max={50}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className={input}
              data-hearth-target="add:priority"
            />
          </Field>
          <Check checked={enable} onChange={setEnable} label="Switch it on" target="add:enable" />
          {editable.filter((f) => !f.advanced).map(control)}
        </div>
        {editable.some((f) => f.advanced) && (
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-[0.84rem] text-muted">More settings</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {editable.filter((f) => f.advanced).map(control)}
            </div>
          </details>
        )}
        <Field label="Tags">
          <TagPicker tags={q.data.tags} value={tags} onChange={setTags} target="add" />
        </Field>
        <button
          type="button"
          className={btnGold}
          disabled={!act.can || act.busy}
          data-hearth-target="add:review"
          onClick={() =>
            act.propose(
              "app-arr-create",
              {
                resource: "indexer",
                body: JSON.stringify({
                  definition: d.name,
                  name: (title ?? d.name).trim(),
                  fields: changed,
                  appProfileId: profile ?? q.data.appProfiles[0]?.id,
                  priority,
                  tags,
                  enable,
                }),
              },
              `Add ${(title ?? d.name).trim()} to Prowlarr`,
            )
          }
        >
          <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Review adding it
        </button>
        <ProposeError error={act.error} />
        {act.dialog}
      </div>
    </Guard>
  );
}
