import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RotateCcw } from "lucide-react";
import {
  CHANNEL_FIELDS,
  PUBLIC_ROUTES,
  isChannelKind,
  type ChannelKind,
  type NotificationChannel,
  type NotificationRoute,
} from "@dragon-control/core";
import { api } from "../../data/api";
import { Button, Sheet, cx } from "../ui";
import { FormError, TextField } from "../../pages/auth/AuthFrame";
import { BotSetup } from "./BotSetup";
import { HearthBotSetup, useHearthBotAvailable } from "./HearthBotSetup";

/**
 * Change (the owner, 11-13): everything about a destination edited in place, in one save. "Send
 * with" switches the way it sends (Discord webhook, Telegram, the Hearth bot...) and asks only for
 * what the new way needs; the name, who reads it, quiet hours, which messages it gets and its
 * history stay. The old way, token too, is kept for Switch back until you forget it. Send test
 * tries the new settings before they are saved; the save shows in Changes and activity and can be
 * undone.
 */

export const KIND_LABELS: Record<ChannelKind, string> = {
  "hearth-bot": "Discord (Hearth bot)",
  discord: "Discord (webhook)",
  "discord-bot": "Discord (your own bot)",
  email: "Email",
  ntfy: "ntfy",
  push: "Browser push",
  telegram: "Telegram",
  webhook: "Webhook",
};

export interface ChangeState {
  previous?: ChannelKind;
  undo?: string;
}

/** Per destination: the way kept for Switch back, and when its last change was (for Undo). */
export function useChangeState() {
  return useQuery({
    queryKey: ["notify-change-state"],
    queryFn: () => api<Record<string, ChangeState>>("GET", "/api/notifications/change-state"),
    staleTime: 10_000,
  });
}

function useChannelWrite<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      for (const key of ["workspace", "audit", "notify-change-state"])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

const path = (id: string, what: string) =>
  `/api/notifications/channels/${encodeURIComponent(id)}/${what}`;

export function useUndoChange() {
  return useChannelWrite((id: string) => api("POST", path(id, "undo")));
}

/** The fields one way needs, built from the shared definitions (secrets: blank keeps the saved). */
export function KindFields({
  kind,
  values,
  set,
  saved,
}: {
  kind: ChannelKind;
  values: Record<string, string>;
  set: (key: string, value: string) => void;
  /** A secret for this way is already in the vault. */
  saved: boolean;
}) {
  return (
    <>
      {CHANNEL_FIELDS[kind].map((f) =>
        f.type === "select" ? (
          <div key={f.key} className="mb-5">
            <label htmlFor={`ch-${f.key}`} className="mb-2 block text-[0.85rem] text-muted">
              {f.label}
            </label>
            <select
              id={`ch-${f.key}`}
              value={values[f.key] ?? f.defaultValue ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
              className="min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
            >
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <TextField
            key={f.key}
            id={`ch-${f.key}`}
            label={f.label}
            type={f.type}
            placeholder={
              f.secret && saved ? "Saved in the vault. Leave empty to keep it." : f.placeholder
            }
            hint={
              f.secret
                ? `${f.hint ? `${f.hint} ` : ""}Kept in the vault, never shown again.`
                : f.hint
            }
            value={values[f.key] ?? ""}
            onChange={(e) => set(f.key, e.target.value)}
            autoComplete="off"
          />
        ),
      )}
    </>
  );
}

/** A way's non-secret settings as the form's starting values. */
function startValues(kind: ChannelKind, config: NotificationChannel["config"]) {
  return Object.fromEntries(
    CHANNEL_FIELDS[kind]
      .filter((f) => !f.secret)
      .map((f) => [f.key, String(config?.[f.key] ?? f.defaultValue ?? "")]),
  );
}

export function ChangeDestination({
  channel,
  routes,
  onClose,
}: {
  channel: NotificationChannel;
  routes: NotificationRoute[];
  onClose: () => void;
}) {
  const hearthBot = useHearthBotAvailable();
  const state = useChangeState().data?.[channel.id];
  const current = (isChannelKind(channel.kind ?? "") ? channel.kind : "discord") as ChannelKind;
  const [name, setName] = useState(channel.name);
  const [kind, setKind] = useState<ChannelKind>(current);
  // Each way's own typed values, so switching back and forth in the form loses nothing.
  const [byKind, setByKind] = useState<Partial<Record<ChannelKind, Record<string, string>>>>(
    () => ({
      [current]: startValues(current, channel.config),
    }),
  );
  const values = byKind[kind] ?? startValues(kind, undefined);
  const set = (key: string, value: string) =>
    setByKind((all) => ({ ...all, [kind]: { ...values, [key]: value } }));
  const [audience, setAudience] = useState(channel.audience ?? "private");
  const [quiet, setQuiet] = useState<"hold" | "any">(
    channel.config?.quiet === "any" ? "any" : "hold",
  );
  const [chosen, setChosen] = useState<string[]>(() =>
    routes.filter((r) => r.channels.includes(channel.id)).map((r) => r.id),
  );
  const switching = kind !== current;
  // Stable, so the bot setups hand their values up only when those change.
  const takeValues = useCallback(
    (v: Record<string, string>) => setByKind((all) => ({ ...all, [kind]: v })),
    [kind],
  );
  const embedded = useMemo(() => ({ onValues: takeValues }), [takeValues]);
  // The bot setups read the saved bot only when it is this destination's way now.
  const botChannel = useMemo(
    () => ({ ...channel, status: switching ? ("available" as const) : channel.status }),
    [channel, switching],
  );
  // A secret in the vault for the way chosen: this one's, or the one kept from before a switch.
  const saved = !switching || state?.previous === kind;
  const draft = () => ({
    name: name.trim(),
    kind,
    values,
    audience,
    quiet,
    routes: audience === "public" ? chosen.filter((r) => PUBLIC_ROUTES.includes(r)) : chosen,
  });

  const save = useChannelWrite(() => api("PUT", path(channel.id, "change"), draft()));
  const tryIt = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; error?: string }>("POST", path(channel.id, "try"), draft()),
  });
  const back = useChannelWrite(() => api("POST", path(channel.id, "switch-back")));
  const forget = useChannelWrite(() => api("DELETE", path(channel.id, "previous")));

  const kinds: ChannelKind[] = [
    ...(hearthBot || current === "hearth-bot" ? (["hearth-bot"] as const) : []),
    "discord",
    "discord-bot",
    "email",
    "ntfy",
    "telegram",
    "webhook",
  ];
  const box = "mb-6 rounded-xl border border-line p-4";

  return (
    <Sheet
      label={`Change ${channel.name}`}
      eyebrow="Notifications"
      title={`Change ${channel.name}`}
      onClose={onClose}
    >
      <form
        data-testid="change-destination"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, { onSuccess: onClose });
        }}
      >
        {state?.previous && state.previous !== current && (
          <div
            className="mb-6 rounded-xl border border-gold/40 bg-gold/5 p-4"
            data-testid="change-previous"
          >
            <p className="mb-3 text-[0.86rem] text-muted">
              Before, this sent with <span className="text-ink">{KIND_LABELS[state.previous]}</span>
              . Those settings and their token are kept, so you can go back.
            </p>
            <span className="flex flex-wrap gap-2">
              <Button
                tone="outline"
                type="button"
                onClick={() => back.mutate(undefined, { onSuccess: onClose })}
                disabled={back.isPending}
                data-testid="change-switch-back"
              >
                <RotateCcw className="h-4 w-4" aria-hidden /> Switch back to{" "}
                {KIND_LABELS[state.previous]}
              </Button>
              <Button
                tone="quiet"
                type="button"
                onClick={() => forget.mutate(undefined)}
                disabled={forget.isPending}
                data-testid="change-forget"
              >
                Forget the old settings
              </Button>
            </span>
            <FormError error={back.error ?? forget.error} />
          </div>
        )}

        <TextField
          id="change-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          required
        />

        <div className="mb-5">
          <label htmlFor="change-kind" className="mb-2 block text-[0.85rem] text-muted">
            Send with
          </label>
          <select
            id="change-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ChannelKind)}
            className="min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
                {k === current ? " (now)" : ""}
              </option>
            ))}
          </select>
          {switching && (
            <p className="mt-2 text-[0.8rem] text-faint" data-testid="change-switch-note">
              Only what {KIND_LABELS[kind]} needs is asked below. The name, who reads it, its
              messages and its history stay. Your {KIND_LABELS[current]} settings are kept, so you
              can switch back.
            </p>
          )}
        </div>

        <div className={box}>
          {kind === "hearth-bot" ? (
            <HearthBotSetup channel={botChannel} onClose={onClose} embedded={embedded} />
          ) : kind === "discord-bot" ? (
            <BotSetup channel={botChannel} onClose={onClose} embedded={embedded} />
          ) : (
            <KindFields kind={kind} values={values} set={set} saved={saved} />
          )}
        </div>

        <fieldset className="mb-6">
          <legend className="mb-2 text-[0.85rem] text-muted">Who reads it</legend>
          {(
            [
              ["private", "Just me", "Any message you choose: alerts, repairs, downloads."],
              [
                "public",
                "Friends and family",
                "Only media announcements. System alerts and anything about your servers never go there.",
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className="mb-2 flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3"
            >
              <input
                type="radio"
                name="change-audience"
                value={value}
                checked={audience === value}
                onChange={() => setAudience(value)}
                className="mt-1"
              />
              <span>
                <span className="block text-[0.9rem] text-ink">{label}</span>
                <span className="block text-[0.8rem] text-faint">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="mb-6">
          <legend className="mb-2 text-[0.85rem] text-muted">Quiet hours</legend>
          {(
            [
              ["hold", "Hold until morning", "Overnight, only urgent problems come through."],
              ["any", "Send any time", "Everything comes through, day or night."],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className="mb-2 flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3"
            >
              <input
                type="radio"
                name="change-quiet"
                value={value}
                checked={quiet === value}
                onChange={() => setQuiet(value)}
                className="mt-1"
              />
              <span>
                <span className="block text-[0.9rem] text-ink">{label}</span>
                <span className="block text-[0.8rem] text-faint">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="mb-6" data-testid="change-messages">
          <legend className="mb-2 text-[0.85rem] text-muted">Messages it gets</legend>
          <ul className="space-y-1">
            {routes.map((r) => {
              const allowed = audience === "private" || PUBLIC_ROUTES.includes(r.id);
              const on = allowed && chosen.includes(r.id);
              return (
                <li key={r.id}>
                  <label
                    className={cx(
                      "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-1 py-2",
                      !allowed && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!allowed}
                      onChange={() =>
                        setChosen((c) =>
                          c.includes(r.id) ? c.filter((x) => x !== r.id) : [...c, r.id],
                        )
                      }
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-[0.88rem] text-ink">{r.event}</span>
                      <span className="block text-[0.78rem] text-faint">
                        {allowed ? r.description : "Not for friends and family."}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button
            tone="outline"
            type="button"
            onClick={() => tryIt.mutate()}
            disabled={tryIt.isPending}
            data-testid="change-try"
          >
            {tryIt.isPending ? "Sending" : "Send test"}
          </Button>
          <span aria-live="polite" className="text-[0.82rem]">
            {tryIt.data &&
              (tryIt.data.ok ? (
                <span
                  className="inline-flex items-center gap-1 text-ok"
                  data-testid="change-try-ok"
                >
                  <Check className="h-4 w-4" aria-hidden /> Sent with these settings. Check it
                  arrived, then save.
                </span>
              ) : (
                <span className="text-bad" data-testid="change-try-failed">
                  It didn&apos;t go through: {tryIt.data.error}
                </span>
              ))}
          </span>
        </div>
        <FormError error={tryIt.error} />

        <Button
          tone="primary"
          type="submit"
          className="w-full"
          disabled={save.isPending || !name.trim()}
          data-testid="change-save"
        >
          {save.isPending ? "Saving" : "Save changes"}
        </Button>
        <p className="mt-2 text-[0.78rem] text-faint">
          One save for all of it. It shows in Changes and activity, and Undo puts it back.
        </p>
        <FormError error={save.error} />
      </form>
    </Sheet>
  );
}
