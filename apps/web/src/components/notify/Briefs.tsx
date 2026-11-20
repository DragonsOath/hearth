import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DAY_NAMES,
  type Brief,
  type BriefWhat,
  type WeekDay,
  type Workspace,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { Button, Switch } from "../ui";
import { FormError } from "../../pages/auth/AuthFrame";

/**
 * Briefs and watches (Talome Gap Plan, item 3): a server summary on a schedule, or a word when a
 * disk passes a level, a service stops answering or a machine goes offline. Ember sets them up
 * too, when asked in plain words. They only read and tell; nothing on a system is changed by one.
 */

type BriefView = Brief & { says: string };
interface BriefsReport {
  briefs: BriefView[];
  channels: { id: string; name: string }[];
}

function useBriefs() {
  return useQuery({ queryKey: ["briefs"], queryFn: () => api<BriefsReport>("GET", "/api/briefs") });
}

function useBriefChange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: { method: "POST" | "PATCH" | "DELETE"; url: string; body?: unknown }) =>
      api<unknown>(op.method, op.url, op.body),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["briefs"] }),
  });
}

const field =
  "min-h-10 rounded-lg border border-line bg-panel px-3 text-[0.9rem] text-ink focus:border-gold focus:outline-none";
const KINDS = [
  { id: "summary", label: "A server summary on a schedule" },
  { id: "disk", label: "Tell me when a disk gets full" },
  { id: "service-down", label: "Tell me if a service stops answering" },
  { id: "host-offline", label: "Tell me if a machine goes offline" },
] as const;
type Kind = (typeof KINDS)[number]["id"];

export function Briefs({ ws }: { ws: Workspace }) {
  const report = useBriefs();
  const change = useBriefChange();
  const [adding, setAdding] = useState(false);
  // Changed in place (the owner, 11-13: no delete and redo).
  const [editing, setEditing] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});
  const list = report.data?.briefs ?? [];

  return (
    <div data-testid="briefs">
      <p className="mb-4 max-w-2xl text-[0.85rem] text-muted">
        A summary every morning, or a word when something crosses a line you set. They only read and
        tell you: anything that would change a system is still a plan you approve. You can also ask
        Ember: &ldquo;Every weekday at 7, send me a server summary.&rdquo;
      </p>
      {list.length === 0 ? (
        <p className="text-[0.85rem] text-faint">None yet.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="brief-list">
          {list.map((b) =>
            editing === b.id ? (
              <li key={b.id} className="py-3">
                <AddBrief
                  ws={ws}
                  channels={report.data?.channels ?? []}
                  existing={b}
                  onDone={() => setEditing(null)}
                />
              </li>
            ) : (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-3" data-testid="brief">
                <div className="min-w-0 flex-1">
                  <p className="text-[0.95rem] text-ink">{b.name}</p>
                  <p className="text-[0.8rem] text-faint">
                    {b.says}
                    {" · "}
                    {b.channels
                      .map((c) => report.data?.channels.find((x) => x.id === c)?.name ?? c)
                      .join(", ")}
                    {b.createdBy === "ember" ? " · set up by Ember" : ""}
                  </p>
                  {sent[b.id] && (
                    <p className="text-[0.8rem] text-live" role="status">
                      {sent[b.id]}
                    </p>
                  )}
                </div>
                <Button
                  tone="outline"
                  onClick={() =>
                    api<{ sent: number; failed: string[] }>(
                      "POST",
                      `/api/briefs/${b.id}/send`,
                    ).then((r) =>
                      setSent((s) => ({
                        ...s,
                        [b.id]: r.sent
                          ? "Sent."
                          : `Not sent: ${r.failed[0] ?? "no channel answered"}`,
                      })),
                    )
                  }
                >
                  Send now
                </Button>
                <Switch
                  checked={b.enabled}
                  onChange={(on) =>
                    change.mutate({
                      method: "PATCH",
                      url: `/api/briefs/${b.id}`,
                      body: { enabled: on },
                    })
                  }
                  label={`${b.name} on`}
                />
                <Button
                  tone="outline"
                  onClick={() => setEditing(b.id)}
                  aria-label={`Change ${b.name}`}
                >
                  Change
                </Button>
                <Button
                  tone="outline"
                  onClick={() => change.mutate({ method: "DELETE", url: `/api/briefs/${b.id}` })}
                  aria-label={`Remove ${b.name}`}
                >
                  Remove
                </Button>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="pt-4">
        {adding ? (
          <AddBrief
            ws={ws}
            channels={report.data?.channels ?? []}
            onDone={() => setAdding(false)}
          />
        ) : (
          <Button onClick={() => setAdding(true)} data-testid="add-brief">
            Add a brief or watch
          </Button>
        )}
      </div>
      <FormError error={change.error} />
    </div>
  );
}

function AddBrief({
  ws,
  channels,
  existing,
  onDone,
}: {
  ws: Workspace;
  channels: { id: string; name: string }[];
  /** Changing one already there: the form starts from it and saves over it. */
  existing?: BriefView;
  onDone: () => void;
}) {
  const change = useBriefChange();
  const w = existing?.what;
  const [kind, setKind] = useState<Kind>(w?.kind ?? "summary");
  const [days, setDays] = useState<WeekDay[]>(w?.kind === "summary" ? w.days : [1, 2, 3, 4, 5]);
  const [time, setTime] = useState(w?.kind === "summary" ? w.time : "07:00");
  const [percent, setPercent] = useState(w?.kind === "disk" ? String(w.percent) : "90");
  const [volumeId, setVolumeId] = useState(w?.kind === "disk" ? (w.volumeId ?? "") : "");
  const [serviceId, setServiceId] = useState(
    w?.kind === "service-down" ? w.serviceId : (ws.services[0]?.id ?? ""),
  );
  const [hostId, setHostId] = useState(w?.kind === "host-offline" ? (w.hostId ?? "") : "");
  const [picked, setPicked] = useState<string[]>(existing?.channels ?? []);
  const volumes = ws.hosts.flatMap((h) =>
    h.volumes.map((v) => ({ id: v.id, label: `${v.label} (${h.name})` })),
  );

  const what = (): BriefWhat =>
    kind === "summary"
      ? { kind, days, time }
      : kind === "disk"
        ? { kind, percent: Math.round(Number(percent)), ...(volumeId ? { volumeId } : {}) }
        : kind === "service-down"
          ? { kind, serviceId }
          : { kind, ...(hostId ? { hostId } : {}) };

  if (!channels.length)
    return (
      <p className="text-[0.85rem] text-muted" data-testid="brief-no-channel">
        Set up a channel above first, so a brief has somewhere to go.
      </p>
    );

  return (
    <form
      className="space-y-4 rounded-xl border border-line p-4"
      data-testid="add-brief-form"
      aria-label={existing ? `Change ${existing.name}` : "Add a brief or watch"}
      onSubmit={(e) => {
        e.preventDefault();
        change.mutate(
          existing
            ? {
                method: "PATCH",
                url: `/api/briefs/${existing.id}`,
                body: { what: what(), ...(picked.length ? { channels: picked } : {}) },
              }
            : {
                method: "POST",
                url: "/api/briefs",
                body: { what: what(), ...(picked.length ? { channels: picked } : {}) },
              },
          { onSuccess: onDone },
        );
      }}
    >
      <label className="block">
        <span className="mb-1 block text-[0.82rem] text-muted">What</span>
        <select className={field} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      {kind === "summary" && (
        <div className="flex flex-wrap items-end gap-4">
          <fieldset>
            <legend className="mb-1 text-[0.82rem] text-muted">Days</legend>
            <div className="flex flex-wrap gap-1.5">
              {DAY_NAMES.map((name, d) => {
                const on = days.includes(d as WeekDay);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setDays((cur) =>
                        on ? cur.filter((x) => x !== d) : [...cur, d as WeekDay].sort(),
                      )
                    }
                    className={`min-h-10 min-w-11 rounded-lg border px-2 text-[0.85rem] ${on ? "border-gold bg-gold/10 text-ink" : "border-line text-muted"}`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label>
            <span className="mb-1 block text-[0.82rem] text-muted">Time</span>
            <input
              type="time"
              className={field}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
      )}

      {kind === "disk" && (
        <div className="flex flex-wrap gap-4">
          <label>
            <span className="mb-1 block text-[0.82rem] text-muted">Which disk</span>
            <select
              className={field}
              value={volumeId}
              onChange={(e) => setVolumeId(e.target.value)}
            >
              <option value="">Any disk</option>
              {volumes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[0.82rem] text-muted">Over (%)</span>
            <input
              className={`${field} w-24`}
              inputMode="numeric"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </label>
        </div>
      )}

      {kind === "service-down" && (
        <label className="block">
          <span className="mb-1 block text-[0.82rem] text-muted">Which service</span>
          <select
            className={field}
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
          >
            {ws.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {kind === "host-offline" && (
        <label className="block">
          <span className="mb-1 block text-[0.82rem] text-muted">Which machine</span>
          <select className={field} value={hostId} onChange={(e) => setHostId(e.target.value)}>
            <option value="">Any machine</option>
            {ws.hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset>
        <legend className="mb-1 text-[0.82rem] text-muted">
          Send to (none picked: where &ldquo;Needs your attention&rdquo; goes)
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {channels.map((c) => {
            const on = picked.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setPicked((cur) => (on ? cur.filter((x) => x !== c.id) : [...cur, c.id]))
                }
                className={`min-h-10 rounded-lg border px-3 text-[0.85rem] ${on ? "border-gold bg-gold/10 text-ink" : "border-line text-muted"}`}
              >
                {c.name}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex gap-2">
        <Button type="submit" disabled={change.isPending}>
          {existing ? "Save" : "Add"}
        </Button>
        <Button tone="outline" type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <FormError error={change.error} />
    </form>
  );
}
