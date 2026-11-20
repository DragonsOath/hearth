import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Eye,
  OctagonX,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Timer,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  SEEDING_ACTIONS,
  SEEDING_ACTION_LABEL,
  ruleCovers,
  ruleName,
  spell,
  type SeedingLogEntry,
  type SeedingRule,
  type Torrent,
  type TorrentRuleState,
} from "@dragon-control/core";
import { api } from "../../../data/api";
import { ago } from "../../../lib/format";
import { Button, Sheet, Switch, cx } from "../../ui";

/**
 * Seeding rules (docs/design/SEEDING_RULES.md, 11-11, the owner: "another tab right there next
 * to Categories ... toggle multiple indexers to one rule with an add another rule option").
 * A rule starts in preview (it says what it would do); the owner switches it to live, and then
 * Hearth acts on its own every five minutes. One switch stops every rule.
 */

interface RulesData {
  rules: SeedingRule[];
  choices: { indexers: string[]; trackers: string[] };
  log: SeedingLogEntry[];
  stopped: boolean;
  lastCheck?: string;
  unseen: number;
}

type Draft = Omit<SeedingRule, "id" | "mode"> & { id?: string; key: string };

const fresh = (): Draft => ({
  key: Math.random().toString(36).slice(2),
  indexers: [],
  trackers: [],
  days: 3,
  action: "notify",
  enabled: true,
});

const input =
  "min-h-10 w-full rounded-lg border border-line bg-panel px-3 text-[0.86rem] text-ink focus:border-gold/60 focus:outline-none";
const chip = (on: boolean) =>
  cx(
    "inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-[0.8rem] transition-colors",
    on
      ? "border-gold/70 bg-gold/15 text-gold"
      : "border-line-strong text-muted hover:border-gold/50 hover:text-ink",
  );

export function useSeedingRules(serviceId: string) {
  return useQuery({
    queryKey: ["seeding-rules", serviceId],
    queryFn: () => api<RulesData>("GET", `/api/services/${serviceId}/seeding-rules`),
  });
}

function ModeBadge({ mode }: { mode: "preview" | "live" }) {
  return mode === "live" ? (
    <span className="inline-flex items-center gap-0.5 rounded-full border border-gold/60 bg-gold/15 px-1.5 text-[0.68rem] text-gold">
      <Zap className="h-3 w-3" aria-hidden /> Live
    </span>
  ) : (
    <span className="rounded-full border border-line-strong px-1.5 text-[0.68rem] text-faint">
      Preview
    </span>
  );
}

/** The line on a torrent's card: which rule covers it, how far along, what comes next. */
export function RuleLine({ rule }: { rule?: TorrentRuleState }) {
  if (!rule) return null;
  const pct =
    rule.seedingSec !== undefined ? Math.min(100, (rule.seedingSec / rule.needSec) * 100) : 0;
  return (
    <div
      className={cx(
        "mt-2 rounded-lg border px-2.5 py-1.5 text-[0.78rem]",
        rule.met ? "border-gold/60 bg-gold/10" : "border-line",
      )}
      data-testid="qb-rule"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Timer strokeWidth={1.5} className="h-3.5 w-3.5 text-gold" aria-hidden />
        <span className="text-ink">{rule.rules[0]}</span>
        {rule.rules.length > 1 && (
          <span className="text-faint" title={rule.rules.join(", ")}>
            +{rule.rules.length - 1} more {rule.rules.length === 2 ? "rule" : "rules"}
          </span>
        )}
        <span className="text-muted">
          {rule.seedingSec !== undefined
            ? `${spell(Math.min(rule.seedingSec, rule.needSec))} of ${spell(rule.needSec)}`
            : `needs ${spell(rule.needSec)}`}
          {rule.minRatio ? ` · ratio ${rule.minRatio.toFixed(2)}` : ""}
        </span>
        <ModeBadge mode={rule.mode} />
      </p>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-line" aria-hidden>
        <i className="block h-full bg-gold" style={{ width: `${pct}%` }} />
      </span>
      <p className="mt-1 text-muted">
        {rule.note}
        {rule.dueAt && !rule.met
          ? ` About ${new Date(rule.dueAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.`
          : ""}
      </p>
    </div>
  );
}

export function SeedingRules({
  serviceId,
  torrents,
  sample,
  onClose,
}: {
  serviceId: string;
  torrents: Torrent[];
  sample: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const q = useSeedingRules(serviceId);
  const rules = q.data?.rules ?? [];
  // The owner's layout (11-11): "Add rule" holds the form, "Set rules" the rules already made.
  const [tab, setTab] = useState<"add" | "set">();
  const shown = tab ?? (q.data && !rules.length ? "add" : "set");
  const [draft, setDraft] = useState<Draft>(fresh);
  const save = useMutation({
    mutationFn: (list: Omit<SeedingRule, "mode">[]) =>
      api<{ rules: SeedingRule[] }>("PUT", `/api/services/${serviceId}/seeding-rules`, {
        rules: list,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["seeding-rules", serviceId] });
      void qc.invalidateQueries({ queryKey: ["dashboard", serviceId] });
    },
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["seeding-rules", serviceId] });
    void qc.invalidateQueries({ queryKey: ["dashboard", serviceId] });
  };
  const setMode = useMutation({
    mutationFn: (b: { rule: string; mode: "preview" | "live"; confirm?: string }) =>
      api("POST", `/api/services/${serviceId}/seeding-rules/${b.rule}/mode`, {
        mode: b.mode,
        ...(b.confirm ? { confirm: b.confirm } : {}),
      }),
    onSuccess: () => {
      setGoing(undefined);
      setWord("");
      refresh();
    },
  });
  const stop = useMutation({
    mutationFn: (stopped: boolean) =>
      api("POST", `/api/services/${serviceId}/seeding-rules/stopped`, { stopped }),
    onSuccess: refresh,
  });
  const check = useMutation({
    mutationFn: () =>
      api<{ acted: SeedingLogEntry[] }>("POST", `/api/services/${serviceId}/seeding-rules/check`),
    onSuccess: refresh,
  });
  // Opening the rules is seeing what they did: it leaves the bell.
  const unseen = q.data?.unseen ?? 0;
  useEffect(() => {
    if (unseen > 0)
      void api("POST", `/api/services/${serviceId}/seeding-rules/seen`).then(() =>
        qc.invalidateQueries({ queryKey: ["seeding-rules", serviceId] }),
      );
  }, [unseen, serviceId, qc]);
  const [going, setGoing] = useState<string>();
  const [word, setWord] = useState("");
  const stopped = Boolean(q.data?.stopped);
  const anyLive = rules.some((r) => r.mode === "live");
  const plain = (r: SeedingRule): Omit<SeedingRule, "mode"> => {
    const { mode: _m, ...rest } = r;
    return rest;
  };
  const strip = ({ key: _k, ...r }: Draft) => r;
  const saveDraft = () => {
    const next = draft.id
      ? rules.map((r) => (r.id === draft.id ? { ...strip(draft), id: r.id } : plain(r)))
      : [...rules.map(plain), strip(draft)];
    save.mutate(next as Omit<SeedingRule, "mode">[], {
      onSuccess: () => {
        setDraft(fresh());
        setTab("set");
      },
    });
  };
  const choices = q.data?.choices ?? { indexers: [], trackers: [] };
  const name = (r: Draft | SeedingRule) => ruleName({ ...r, id: r.id ?? "", mode: "preview" });

  return (
    <Sheet label="Seeding rules" eyebrow="qBittorrent" title="Seeding rules" onClose={onClose} wide>
      <div className="space-y-4" data-testid="qb-rules-sheet">
        <div className="rounded-xl border border-gold/40 bg-gold/5 p-3 text-[0.82rem]">
          <p className="flex items-center gap-1.5 font-medium text-gold">
            <Eye strokeWidth={1.5} className="h-4 w-4" aria-hidden /> New rules start in preview
          </p>
          <p className="mt-1 text-muted">
            In preview a rule only shows on each torrent what it would do. Switch it to live and
            Hearth does it by itself, checking every five minutes. Hearth counts qBittorrent&apos;s
            seeding time; your tracker can count differently or have its own rules, so check them
            before trusting a timer.
          </p>
        </div>
        {sample && (
          <p className="text-[0.82rem] text-amber">
            Sample data: the indexers and torrents here are examples.
          </p>
        )}
        {q.error && (
          <p className="text-[0.84rem] text-alert" role="alert">
            Could not read the rules: {q.error.message}
          </p>
        )}

        <div
          className="inline-flex rounded-full border border-line p-1"
          role="tablist"
          aria-label="Seeding rules"
        >
          {(
            [
              ["add", draft.id ? "Edit rule" : "Add rule"],
              ["set", "Set rules"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={shown === id}
              className={cx(
                "min-h-9 rounded-full px-4 text-[0.84rem] transition-colors",
                shown === id ? "bg-gold/15 text-gold" : "text-muted hover:text-ink",
              )}
              onClick={() => setTab(id)}
              data-testid={`qb-rules-tab-${id}`}
            >
              {label}
              {id === "set" && rules.length ? (
                <span className="ml-1.5 text-faint">{rules.length}</span>
              ) : null}
            </button>
          ))}
        </div>

        {shown === "add" ? (
          <section role="tabpanel" aria-label={draft.id ? "Edit rule" : "Add rule"}>
            <h4 className="text-[0.95rem] text-ink">
              {draft.id ? `Edit ${name(draft)}` : "Create a new rule"}
            </h4>
            {draft.id && rules.find((x) => x.id === draft.id)?.mode === "live" && (
              <p className="mt-1 text-[0.78rem] text-amber">
                This rule is live. Changing its indexers, trackers or what it does puts it back in
                preview; waiting longer keeps it live.
              </p>
            )}
            <RuleForm r={draft} choices={choices} set={(p) => setDraft((d) => ({ ...d, ...p }))} />
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  setDraft(fresh());
                  setTab("set");
                }}
              >
                Cancel
              </Button>
              <Button
                tone="primary"
                disabled={!valid(draft) || save.isPending}
                onClick={saveDraft}
                data-testid="qb-rules-save"
              >
                <Save strokeWidth={1.5} className="h-4 w-4" />
                {save.isPending ? "Saving…" : "Save rule"}
              </Button>
              {!valid(draft) && (
                <span className="text-[0.78rem] text-faint">
                  Pick at least one indexer or tracker.
                </span>
              )}
            </div>
          </section>
        ) : (
          <section role="tabpanel" aria-label="Set rules" className="space-y-3">
            {rules.length > 0 && (
              <div
                className={cx(
                  "flex flex-wrap items-center gap-2 rounded-xl border p-3",
                  stopped ? "border-amber/60 bg-amber/10" : "border-line",
                )}
              >
                <div className="min-w-0 flex-1 text-[0.82rem]">
                  <p className={stopped ? "text-amber" : "text-ink"}>
                    {stopped ? "Every rule is stopped" : "Rules are running"}
                  </p>
                  <p className="text-[0.76rem] text-faint">
                    {stopped
                      ? "Nothing acts until you start them again."
                      : q.data?.lastCheck
                        ? `Last checked ${ago(q.data.lastCheck)}.`
                        : anyLive
                          ? "Checks every five minutes."
                          : "No rule is live yet."}
                  </p>
                </div>
                {anyLive && !stopped && (
                  <Button
                    className="min-h-9 px-3"
                    disabled={check.isPending || sample}
                    onClick={() => check.mutate()}
                    data-testid="qb-rules-check"
                  >
                    <RefreshCw
                      strokeWidth={1.5}
                      className={cx("h-4 w-4", check.isPending && "animate-spin")}
                    />
                    Check now
                  </Button>
                )}
                <Button
                  tone={stopped ? "primary" : "outline"}
                  className="min-h-9 px-3"
                  disabled={stop.isPending}
                  onClick={() => stop.mutate(!stopped)}
                  data-testid="qb-rules-stop"
                >
                  <OctagonX strokeWidth={1.5} className="h-4 w-4" />
                  {stopped ? "Start the rules again" : "Stop every rule"}
                </Button>
              </div>
            )}
            {!rules.length ? (
              <p className="text-[0.84rem] text-muted">No rules yet.</p>
            ) : (
              <ul className="space-y-3">
                {rules.map((r) => {
                  const covers = torrents.filter((t) => ruleCovers(r, t)).length;
                  return (
                    <li
                      key={r.id}
                      className={cx(
                        "rounded-xl border border-line p-3",
                        !r.enabled && "opacity-70",
                      )}
                      data-testid="qb-rule-card"
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-[0.95rem] text-ink">{name(r)}</p>
                          <p className="text-[0.8rem] text-muted">
                            {r.days} {r.days === 1 ? "day" : "days"} seeding
                            {r.minRatio ? ` and ratio ${r.minRatio}` : ""} ·{" "}
                            {SEEDING_ACTION_LABEL[r.action]}
                          </p>
                          <p className="text-[0.76rem] text-faint">
                            {r.enabled ? "On" : "Off"} · covers {covers}{" "}
                            {covers === 1 ? "torrent" : "torrents"} now
                          </p>
                          <p className="mt-1">
                            <ModeBadge mode={r.mode} />
                          </p>
                        </div>
                        <Switch
                          checked={r.enabled}
                          onChange={(v) =>
                            save.mutate(
                              rules.map((x) => plain(x.id === r.id ? { ...x, enabled: v } : x)),
                            )
                          }
                          label={`${r.enabled ? "Turn off" : "Turn on"} ${name(r)}`}
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          className="min-h-9 px-3"
                          onClick={() => {
                            setDraft({ ...r, key: r.id });
                            setTab("add");
                          }}
                          data-testid="qb-rule-edit"
                        >
                          <Pencil strokeWidth={1.5} className="h-4 w-4" /> Edit rule
                        </Button>
                        <Button
                          tone="quiet"
                          className="min-h-9 px-2"
                          disabled={save.isPending}
                          onClick={() => save.mutate(rules.filter((x) => x.id !== r.id).map(plain))}
                          data-testid="qb-rule-remove"
                        >
                          <Trash2 strokeWidth={1.5} className="h-4 w-4" /> Remove rule
                        </Button>
                        {r.mode === "live" ? (
                          <Button
                            tone="quiet"
                            className="min-h-9 px-2"
                            disabled={setMode.isPending}
                            onClick={() => setMode.mutate({ rule: r.id, mode: "preview" })}
                            data-testid="qb-rule-preview"
                          >
                            <Eye strokeWidth={1.5} className="h-4 w-4" /> Back to preview
                          </Button>
                        ) : (
                          <Button
                            tone="quiet"
                            className="min-h-9 px-2 text-gold"
                            disabled={sample}
                            title={
                              sample
                                ? "Sample data: there is no real qBittorrent to act on."
                                : undefined
                            }
                            onClick={() => {
                              setGoing(going === r.id ? undefined : r.id);
                              setWord("");
                            }}
                            data-testid="qb-rule-golive"
                          >
                            <Zap strokeWidth={1.5} className="h-4 w-4" /> Go live
                          </Button>
                        )}
                      </div>
                      {going === r.id && (
                        <div
                          className={cx(
                            "mt-3 space-y-2 rounded-lg border p-3 text-[0.82rem]",
                            r.action === "delete"
                              ? "border-alert/60 bg-alert/10"
                              : "border-gold/50 bg-gold/5",
                          )}
                          data-testid="qb-rule-confirm"
                        >
                          <p className="text-ink">
                            From now on, when a torrent from{" "}
                            {[...r.indexers, ...r.trackers].join(", ")} has seeded {r.days}{" "}
                            {r.days === 1 ? "day" : "days"}
                            {r.minRatio ? ` and reached ratio ${r.minRatio}` : ""}, Hearth will{" "}
                            <b>{SEEDING_ACTION_LABEL[r.action].toLowerCase()}</b> by itself.
                          </p>
                          <p className="text-muted">
                            It checks every five minutes and acts once per torrent. Torrents it
                            can&apos;t trace to an indexer are left alone. Every action is in
                            Activity and the bell, and Stop every rule halts it at once.
                          </p>
                          {r.action === "delete" && (
                            <>
                              <p className="flex gap-1.5 text-alert">
                                <AlertTriangle
                                  strokeWidth={1.5}
                                  className="mt-0.5 h-4 w-4 shrink-0"
                                  aria-hidden
                                />
                                This erases the downloaded files, and Hearth can&apos;t undo it. It
                                skips anything Sonarr, Radarr or another media app hasn&apos;t
                                imported yet, and anything inside a media library folder.
                              </p>
                              <label className="block space-y-1">
                                <span className="text-muted">
                                  Type <b className="text-ink">delete files</b> to confirm
                                </span>
                                <input
                                  className={input}
                                  value={word}
                                  onChange={(e) => setWord(e.target.value)}
                                  data-testid="qb-rule-confirm-word"
                                />
                              </label>
                            </>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button className="min-h-9 px-3" onClick={() => setGoing(undefined)}>
                              Cancel
                            </Button>
                            <Button
                              tone="primary"
                              className="min-h-9 px-3"
                              disabled={
                                setMode.isPending ||
                                (r.action === "delete" &&
                                  word.trim().toLowerCase() !== "delete files")
                              }
                              onClick={() =>
                                setMode.mutate({
                                  rule: r.id,
                                  mode: "live",
                                  ...(r.action === "delete" ? { confirm: "delete files" } : {}),
                                })
                              }
                              data-testid="qb-rule-confirm-live"
                            >
                              <Zap strokeWidth={1.5} className="h-4 w-4" /> Yes, go live
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <Button
              className="w-full"
              onClick={() => {
                setDraft(fresh());
                setTab("add");
              }}
              data-testid="qb-rule-add"
            >
              <Plus strokeWidth={1.75} className="h-4 w-4" /> Add another rule
            </Button>
            <section aria-label="What the rules did" className="border-t border-line pt-3">
              <h4 className="mb-2 text-[0.84rem] font-medium text-ink">Activity</h4>
              {!q.data?.log.length ? (
                <p className="text-[0.8rem] text-faint">
                  Nothing yet. When a torrent&apos;s time is up, it is noted here.
                </p>
              ) : (
                <ul className="space-y-1.5 text-[0.8rem]" data-testid="qb-rules-log">
                  {q.data.log.slice(0, 30).map((e) => (
                    <li
                      key={`${e.hash}-${e.at}-${e.action}-${e.result ?? ""}`}
                      className="text-muted"
                    >
                      <span className={e.ok === false ? "text-amber" : "text-ink"}>
                        {e.mode === "preview" ? "Would: " : e.ok === false ? "Didn't: " : "Done: "}
                        {SEEDING_ACTION_LABEL[e.action].toLowerCase()}
                      </span>{" "}
                      · {e.name} · {e.rule} · {spell(e.seedingSec)} seeded, ratio{" "}
                      {e.ratio.toFixed(2)} · <span className="text-faint">{ago(e.at)}</span>
                      {e.result && e.mode === "live" && (
                        <span className="block text-[0.74rem] text-faint">{e.result}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </section>
        )}
        {(save.error ?? setMode.error ?? stop.error ?? check.error) && (
          <p className="text-[0.84rem] text-alert" role="alert">
            {(save.error ?? setMode.error ?? stop.error ?? check.error)!.message}
          </p>
        )}
      </div>
    </Sheet>
  );
}

const valid = (r: Draft) => r.indexers.length + r.trackers.length > 0 && r.days > 0;

function RuleForm({
  r,
  choices,
  set,
}: {
  r: Draft;
  choices: RulesData["choices"];
  set: (p: Partial<Draft>) => void;
}) {
  const [custom, setCustom] = useState("");
  const indexers = [...new Set([...choices.indexers, ...r.indexers])];
  const trackers = [...new Set([...choices.trackers, ...r.trackers])];
  const toggle = (list: string[], x: string) =>
    list.includes(x) ? list.filter((y) => y !== x) : [...list, x];
  return (
    <div className="mt-3 space-y-4" data-testid="qb-rule-form">
      <label className="block space-y-1">
        <span className="text-[0.8rem] text-muted">Name (optional)</span>
        <input
          className={input}
          value={r.name ?? ""}
          placeholder="Private trackers"
          maxLength={80}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>

      <fieldset>
        <legend className="mb-1.5 text-[0.8rem] text-muted">Indexers</legend>
        {indexers.length ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Indexers">
            {indexers.map((x) => (
              <button
                key={x}
                type="button"
                aria-pressed={r.indexers.includes(x)}
                className={chip(r.indexers.includes(x))}
                onClick={() => set({ indexers: toggle(r.indexers, x) })}
                data-testid="qb-rule-indexer"
              >
                {x}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[0.8rem] text-faint">
            No indexers found yet. Link Prowlarr to Hearth to list them, or add a tracker below.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-[0.8rem] text-muted">Trackers (optional)</legend>
        <p className="mb-1.5 text-[0.74rem] text-faint">
          For torrents no app grabbed. A tracker&apos;s address isn&apos;t always the indexer&apos;s
          name, so pick only ones you know.
        </p>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Trackers">
          {trackers.map((x) => (
            <button
              key={x}
              type="button"
              aria-pressed={r.trackers.includes(x)}
              className={chip(r.trackers.includes(x))}
              onClick={() => set({ trackers: toggle(r.trackers, x) })}
            >
              {x}
              {r.trackers.includes(x) && !choices.trackers.includes(x) && (
                <X className="h-3 w-3" aria-hidden />
              )}
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = custom
              .trim()
              .replace(/^https?:\/\//, "")
              .replace(/\/.*$/, "");
            if (v) set({ trackers: [...new Set([...r.trackers, v])] });
            setCustom("");
          }}
        >
          <input
            className={input}
            value={custom}
            placeholder="tracker.example.org"
            aria-label="Add a tracker address"
            onChange={(e) => setCustom(e.target.value)}
          />
          <Button type="submit" className="min-h-10 shrink-0 px-3" disabled={!custom.trim()}>
            Add
          </Button>
        </form>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-[0.8rem] text-muted">Days seeding</span>
          <input
            className={input}
            type="number"
            min={0.1}
            max={365}
            step={0.5}
            value={r.days}
            onChange={(e) => set({ days: Number(e.target.value) })}
            data-testid="qb-rule-days"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[0.8rem] text-muted">Minimum ratio (optional)</span>
          <input
            className={input}
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={r.minRatio ?? ""}
            placeholder="None"
            onChange={(e) =>
              set({ minRatio: e.target.value === "" ? undefined : Number(e.target.value) })
            }
          />
        </label>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-[0.8rem] text-muted">Then</legend>
        <div className="space-y-1.5" role="radiogroup" aria-label="What to do with the torrent">
          {SEEDING_ACTIONS.map((a) => {
            const on = r.action === a.id;
            return (
              <label
                key={a.id}
                className={cx(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5",
                  on
                    ? a.danger
                      ? "border-alert/70 bg-alert/10"
                      : "border-gold/60 bg-gold/10"
                    : "border-line hover:border-line-strong",
                )}
              >
                <input
                  type="radio"
                  name={`action-${r.key}`}
                  className="mt-1 accent-gold"
                  checked={on}
                  onChange={() => set({ action: a.id })}
                />
                <span>
                  <span
                    className={cx("block text-[0.86rem]", a.danger ? "text-alert" : "text-ink")}
                  >
                    {a.label}
                  </span>
                  <span className="block text-[0.76rem] text-muted">{a.detail}</span>
                </span>
              </label>
            );
          })}
        </div>
        {r.action === "delete" && (
          <p className="mt-2 flex gap-1.5 text-[0.78rem] text-alert" role="note">
            <AlertTriangle strokeWidth={1.5} className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            Delete erases the downloaded files. When rules can act, this one will need its own OK,
            and it will skip anything Sonarr or Radarr hasn&apos;t imported yet.
          </p>
        )}
      </fieldset>
    </div>
  );
}
