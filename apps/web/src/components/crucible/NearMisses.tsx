import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NearMissItem, NearMissReport, NearMissSettings } from "@dragon-control/core";
import { ApproveDialog, useApproveHere } from "../jobs/ApproveHere";
import { usePanelHref } from "../desk/links";
import { Button } from "../ui";
import { api } from "../../data/api";
import { ago } from "../../lib/format";

const KEY = ["crucible-near-misses"];

export function useNearMisses() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api<NearMissReport>("GET", "/api/crucible/near-misses"),
    staleTime: 60_000,
  });
}

/**
 * Near misses (the Crucible, step 8): movies missing a while, checked a few a day, and what the
 * search found. In the Crucible with its settings; in Download Health as a short list that links
 * here. Grab it anyway is a one-time plan the owner approves; the rules are not changed.
 */
export function NearMisses({ serviceId, brief }: { serviceId?: string; brief?: boolean }) {
  const q = useNearMisses();
  const qc = useQueryClient();
  const href = usePanelHref()("tool:crucible");
  const check = useMutation({
    mutationFn: () => api<NearMissReport>("POST", "/api/crucible/near-misses/check"),
    onSuccess: (d) => qc.setQueryData(KEY, d),
  });
  const r = q.data;
  if (!r) return null;
  const items = r.items.filter((i) => !serviceId || i.serviceId === serviceId);
  const blocked = items.filter((i) => i.kind === "blocked");
  if (brief) {
    if (!blocked.length) return null;
    return (
      <section className="rounded-xl border border-line p-3" data-testid="near-misses-brief">
        <h3 className="text-[0.92rem] text-ink">Held back by your own rules</h3>
        <ul className="mt-1 space-y-1 text-[0.84rem] text-muted">
          {blocked.slice(0, 5).map((i) => (
            <li key={`${i.serviceId}:${i.movieId}`}>
              <span className="text-ink">{i.title}</span>: {i.sentence}
            </li>
          ))}
        </ul>
        {href && (
          <Link to={href} className="mt-2 inline-flex min-h-11 items-center text-gold">
            Open the Crucible to grab one or change the limit
          </Link>
        )}
      </section>
    );
  }
  return (
    <section className="space-y-3" data-testid="near-misses">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[1rem] text-ink">Near misses</h3>
        <span className="text-[0.78rem] text-faint">
          {r.checkedAt ? `Checked ${ago(r.checkedAt)}` : "Not checked yet"}
        </span>
      </div>
      <p className="text-[0.84rem] text-muted">
        Movies missing a while, searched a few a day (nothing is downloaded): is there really
        nothing, or did your own rules turn every release down?
      </p>
      {items.length === 0 ? (
        <p className="text-[0.84rem] text-muted" data-testid="near-misses-empty">
          {r.checkedAt ? "Nothing to report from the last check." : "The first check runs today."}
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <Item key={`${i.serviceId}:${i.movieId}`} item={i} />
          ))}
        </ul>
      )}
      <Settings settings={r.settings} />
      <Button
        tone="quiet"
        disabled={check.isPending || r.settings.perDay === 0}
        onClick={() => check.mutate()}
        data-testid="near-misses-check"
      >
        {check.isPending ? "Checking…" : "Check now"}
      </Button>
      {check.isError && (
        <p role="alert" className="text-[0.82rem] text-bad">
          {(check.error as Error).message}
        </p>
      )}
    </section>
  );
}

function Item({ item }: { item: NearMissItem }) {
  const c = useApproveHere(item.serviceId, "Grab it anyway, from the Crucible's near misses.");
  const close = item.closest;
  return (
    <li className="rounded-xl border border-line p-3" data-testid="near-miss">
      <p className="text-[0.88rem] text-ink">{item.title}</p>
      <p className="text-[0.82rem] text-muted">{item.sentence}</p>
      {close && (
        <Button
          className="mt-2"
          disabled={c.busy}
          onClick={() =>
            void c.propose(
              "app-arr-grab",
              {
                guid: close.guid,
                indexerId: close.indexerId,
                release: close.title,
                title: item.title,
                ...(close.quality ? { quality: close.quality } : {}),
                ...(close.sizeGB !== undefined ? { sizeGB: close.sizeGB } : {}),
                ...(close.indexer ? { indexer: close.indexer } : {}),
              },
              `Grab ${item.title} anyway`,
            )
          }
          data-testid="near-miss-grab"
        >
          Grab it anyway
        </Button>
      )}
      <ApproveDialog c={c} />
    </li>
  );
}

function Settings({ settings }: { settings: NearMissSettings }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const save = useMutation({
    mutationFn: (s: Partial<NearMissSettings>) =>
      api<{ settings: NearMissSettings }>("PUT", "/api/crucible/near-misses/settings", s),
    onSuccess: (d) =>
      qc.setQueryData<NearMissReport>(KEY, (old) => (old ? { ...old, settings: d.settings } : old)),
  });
  const set = (patch: Partial<NearMissSettings>) => {
    setDraft({ ...draft, ...patch });
    save.mutate(patch);
  };
  const input = "w-16 rounded-lg border border-line bg-bg px-2 py-1 text-ink";
  return (
    <div className="space-y-2 text-[0.84rem] text-muted" data-testid="near-miss-settings">
      <label className="flex flex-wrap items-center gap-2">
        Check up to
        <input
          type="number"
          min={0}
          max={50}
          className={input}
          value={draft.perDay}
          onChange={(e) => set({ perDay: Number(e.target.value) })}
          aria-label="Movies checked a day"
          data-testid="near-miss-per-day"
        />
        movies a day (0 turns it off), missing at least
        <input
          type="number"
          min={0}
          max={365}
          className={input}
          value={draft.minDays}
          onChange={(e) => set({ minDays: Number(e.target.value) })}
          aria-label="Days missing"
        />
        days. Fewer is kinder to your indexers.
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.notify}
          onChange={(e) => set({ notify: e.target.checked })}
          data-testid="near-miss-notify"
        />
        Tell me in Needs you and the bell when one is held back by my rules
      </label>
    </div>
  );
}
