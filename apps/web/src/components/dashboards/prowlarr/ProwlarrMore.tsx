import { useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AppViewProps } from "../../panels/registry";
import { cx } from "../../ui";
import { ConnectionItem, ConnectionsSettings } from "../radarr/RadarrSettingsMore";
import {
  Check,
  Field,
  Guard,
  LoadError,
  Loading,
  Pager,
  ProposeError,
  SubNav,
  btn,
  btnBad,
  btnGold,
  input,
  inputAuto,
  usePropose,
  when,
} from "../radarr/common";
import { EVENT_WORDS, SYNC_LEVELS, useProwlarr, type AppProfile, type AppsView } from "./data";

/**
 * Prowlarr's History tab (every search, RSS check and grab, by indexer and kind) and Settings tab:
 * Apps (the Arr apps it feeds, how each is synced, and the sync profiles that decide which
 * searches use which indexer, kept together), Connections (download clients, indexer proxies,
 * notifications; shared with Radarr and Sonarr) and Tags.
 */

export function ProwlarrHistory({ serviceId }: AppViewProps) {
  const [page, setPage] = useState(1);
  const [event, setEvent] = useState("");
  const [indexer, setIndexer] = useState("");
  const q = useProwlarr(serviceId, "history", { page, event, indexer });
  const ix = useProwlarr(serviceId, "indexers");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const names = new Map((ix.data?.indexers ?? []).map((i) => [i.id, i.name]));
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-3" data-testid="prowlarr-history">
        <div className="flex flex-wrap gap-2">
          <select
            value={event}
            onChange={(e) => {
              setEvent(e.target.value);
              setPage(1);
            }}
            aria-label="What happened"
            className={inputAuto}
            data-hearth-target="history:event"
          >
            <option value="">Everything</option>
            {Object.entries(EVENT_WORDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            value={indexer}
            onChange={(e) => {
              setIndexer(e.target.value);
              setPage(1);
            }}
            aria-label="Which indexer"
            className={inputAuto}
            data-hearth-target="history:indexer"
          >
            <option value="">Every indexer</option>
            {[...names].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {q.data.records.length === 0 ? (
          <p className="text-[0.84rem] text-muted">Nothing here.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line text-[0.82rem]">
            {q.data.records.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2"
                data-testid="prowlarr-history-row"
              >
                <span className={cx("w-20 shrink-0", h.successful ? "text-ink" : "text-alert")}>
                  {EVENT_WORDS[h.event] ?? h.event}
                </span>
                <span className="min-w-0 flex-1 break-words text-muted">
                  {h.title ?? (h.query ? `"${h.query}"` : "RSS check")}
                  {h.results !== undefined ? ` · ${h.results} results` : ""}
                  {h.successful ? "" : " · failed"}
                </span>
                <span className="text-[0.76rem] text-faint">
                  {h.indexerId !== undefined
                    ? `${names.get(h.indexerId) ?? `#${h.indexerId}`} · `
                    : ""}
                  {h.source ? `${h.source} · ` : ""}
                  {when(h.date)}
                </span>
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
      </div>
    </Guard>
  );
}

type Part = "apps" | "connections" | "tags";
const PARTS: Part[] = ["apps", "connections", "tags"];

export function ProwlarrSettings({ serviceId, sub, onSub }: AppViewProps) {
  const [head, rest] = (sub ?? "").split("/");
  const part: Part = PARTS.includes(head as Part) ? (head as Part) : "apps";
  return (
    <div className="space-y-3" data-testid="prowlarr-settings">
      <SubNav
        label="Settings"
        target="settings"
        value={part}
        onChange={(p) => onSub?.(p === "apps" ? null : p)}
        options={[
          { value: "apps", label: "Apps and sync profiles" },
          { value: "connections", label: "Connections" },
          { value: "tags", label: "Tags" },
        ]}
      />
      {part === "apps" && <AppsSettings serviceId={serviceId} />}
      {part === "connections" && <ConnectionsSettings serviceId={serviceId} focus={rest} />}
      {part === "tags" && <TagsSettings serviceId={serviceId} />}
    </div>
  );
}

function AppsSettings({ serviceId }: { serviceId: string }) {
  const q = useProwlarr(serviceId, "apps");
  const act = usePropose(serviceId);
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-5" data-testid="prowlarr-apps">
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="eyebrow mr-auto">Apps Prowlarr feeds</h4>
            <button
              type="button"
              className={btn}
              disabled={!act.can || act.busy}
              data-hearth-target="apps:sync"
              onClick={() =>
                act.propose(
                  "app-arr-command",
                  { command: "ApplicationIndexerSync" },
                  "Push the indexers to the apps",
                )
              }
            >
              <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" /> Push indexers now
            </button>
          </div>
          <ProposeError error={act.error} />
          {act.dialog}
          {q.data.apps.length === 0 ? (
            <p className="text-[0.84rem] text-muted">No apps yet.</p>
          ) : (
            q.data.apps.map((a) => <AppItem key={a.id} serviceId={serviceId} app={a} />)
          )}
          <p className="text-[0.76rem] text-faint">
            Adding an app needs that app&apos;s API key, so add it in Prowlarr for now (Settings,
            Apps). Hearth does not send keys from a plan yet.
          </p>
        </section>
        <section className="space-y-2">
          <h4 className="eyebrow">Sync profiles</h4>
          <p className="text-[0.78rem] text-faint">
            Which kinds of search an indexer is used for in the apps. Each indexer has one.
          </p>
          {q.data.appProfiles.map((p) => (
            <ProfileItem key={p.id} serviceId={serviceId} p={p} />
          ))}
          <NewProfile serviceId={serviceId} />
        </section>
      </div>
    </Guard>
  );
}

function AppItem({ serviceId, app }: { serviceId: string; app: AppsView["apps"][number] }) {
  const [level, setLevel] = useState(app.syncLevel);
  const hint = SYNC_LEVELS.find((l) => l.value === level)?.hint;
  return (
    <ConnectionItem
      serviceId={serviceId}
      c={app}
      extra={{ syncLevel: level !== app.syncLevel ? level : undefined }}
    >
      <Field label="How it is synced" hint={hint} htmlFor={`sync-${app.id}`}>
        <select
          id={`sync-${app.id}`}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className={input}
          data-hearth-target={`application:${app.id}:sync`}
        >
          {SYNC_LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </Field>
    </ConnectionItem>
  );
}

const PROFILE_FIELDS: { key: keyof AppProfile; field: string; label: string }[] = [
  { key: "rss", field: "enableRss", label: "RSS (new releases as they appear)" },
  { key: "automatic", field: "enableAutomaticSearch", label: "Automatic searches" },
  { key: "interactive", field: "enableInteractiveSearch", label: "Picking a release by hand" },
];

function ProfileItem({ serviceId, p }: { serviceId: string; p: AppProfile }) {
  const act = usePropose(serviceId);
  const [vals, setVals] = useState({
    rss: p.rss,
    automatic: p.automatic,
    interactive: p.interactive,
  });
  const [seeders, setSeeders] = useState(p.minimumSeeders);
  const changes: Record<string, unknown> = {};
  for (const f of PROFILE_FIELDS)
    if (vals[f.key as "rss"] !== p[f.key]) changes[f.field] = vals[f.key as "rss"];
  if (seeders !== p.minimumSeeders) changes.minimumSeeders = seeders;
  return (
    <div
      className="space-y-2 rounded-xl border border-line p-3"
      data-hearth-target={`appprofile:${p.id}`}
    >
      <p className="text-[0.86rem] text-ink">{p.name}</p>
      <div className="flex flex-wrap gap-x-4">
        {PROFILE_FIELDS.map((f) => (
          <Check
            key={f.key}
            checked={vals[f.key as "rss"]}
            onChange={(v) => setVals((s) => ({ ...s, [f.key]: v }))}
            label={f.label}
            target={`appprofile:${p.id}:${f.field}`}
          />
        ))}
      </div>
      <label className="flex items-center gap-2 text-[0.82rem] text-muted">
        Fewest seeders
        <input
          type="number"
          min={0}
          value={seeders}
          onChange={(e) => setSeeders(Number(e.target.value))}
          className={`${inputAuto} w-20`}
          data-hearth-target={`appprofile:${p.id}:seeders`}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnGold}
          disabled={!Object.keys(changes).length || !act.can || act.busy}
          data-hearth-target={`appprofile:${p.id}:save`}
          onClick={() =>
            act.propose(
              "app-arr-edit",
              { resource: "appprofile", id: p.id, changes: JSON.stringify(changes) },
              `Change the sync profile ${p.name}`,
            )
          }
        >
          Review change
        </button>
        <button
          type="button"
          className={btnBad}
          disabled={!act.can || act.busy}
          data-hearth-target={`appprofile:${p.id}:remove`}
          onClick={() =>
            act.propose(
              "app-arr-delete",
              { resource: "appprofile", id: p.id },
              `Remove the sync profile ${p.name}`,
            )
          }
        >
          <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
        </button>
      </div>
      <ProposeError error={act.error} />
      {act.dialog}
    </div>
  );
}

function NewProfile({ serviceId }: { serviceId: string }) {
  const act = usePropose(serviceId);
  const [name, setName] = useState("");
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        act.propose(
          "app-arr-create",
          {
            resource: "appprofile",
            body: JSON.stringify({
              name: name.trim(),
              enableRss: true,
              enableAutomaticSearch: true,
              enableInteractiveSearch: true,
              minimumSeeders: 1,
            }),
          },
          `Add the sync profile ${name.trim()}`,
        );
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New sync profile name"
        aria-label="New sync profile name"
        className={`${inputAuto} min-w-0 flex-1`}
        data-hearth-target="appprofile:new:name"
      />
      <button
        type="submit"
        className={btn}
        disabled={!name.trim() || !act.can || act.busy}
        data-hearth-target="appprofile:new:add"
      >
        <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add
      </button>
      <ProposeError error={act.error} />
      {act.dialog}
    </form>
  );
}

function TagsSettings({ serviceId }: { serviceId: string }) {
  const q = useProwlarr(serviceId, "tags");
  const act = usePropose(serviceId);
  const [label, setLabel] = useState("");
  if (q.isPending) return <Loading />;
  if (q.isError) return <LoadError error={q.error} />;
  const uses = (t: (typeof q.data.tags)[number]) =>
    [
      t.indexers && `${t.indexers} indexers`,
      t.apps && `${t.apps} apps`,
      t.proxies && `${t.proxies} proxies`,
      t.downloadClients && `${t.downloadClients} download clients`,
      t.notifications && `${t.notifications} connections`,
    ]
      .filter(Boolean)
      .join(", ") || "Not used";
  return (
    <Guard meta={q.data.meta} sample={q.data.sample}>
      <div className="space-y-3" data-testid="prowlarr-tags">
        <p className="text-[0.78rem] text-faint">
          A tag links indexers to a proxy (such as FlareSolverr) and decides which apps get them.
        </p>
        <ul className="divide-y divide-line rounded-xl border border-line text-[0.84rem]">
          {q.data.tags.map((t) => (
            <li key={t.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 text-ink">{t.label}</span>
              <span className="text-[0.76rem] text-faint">{uses(t)}</span>
              <button
                type="button"
                className={btnBad}
                disabled={!act.can || act.busy}
                data-hearth-target={`tag:${t.id}:remove`}
                onClick={() =>
                  act.propose(
                    "app-arr-delete",
                    { resource: "tag", id: t.id },
                    `Remove the tag ${t.label}`,
                  )
                }
              >
                <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {q.data.tags.length === 0 && <li className="px-3 py-2 text-muted">No tags yet.</li>}
        </ul>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            act.propose(
              "app-arr-create",
              { resource: "tag", body: JSON.stringify({ label: label.trim() }) },
              `Add the tag ${label.trim()}`,
            );
          }}
        >
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="New tag"
            aria-label="New tag"
            className={`${inputAuto} min-w-0 flex-1`}
            data-hearth-target="tag:new:label"
          />
          <button
            type="submit"
            className={btn}
            disabled={!label.trim() || !act.can || act.busy}
            data-hearth-target="tag:new:add"
          >
            <Plus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add
          </button>
        </form>
        <ProposeError error={act.error} />
        {act.dialog}
      </div>
    </Guard>
  );
}
