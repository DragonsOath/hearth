import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, ExternalLink, RefreshCw } from "lucide-react";
import type { NotificationChannel } from "@dragon-control/core";
import { api, useConfigureChannel } from "../../data/api";
import { Button } from "../ui";
import { FormError, TextField } from "../../pages/auth/AuthFrame";

interface BotInfo {
  name: string;
  invite: string;
  channels: { id: string; name: string; server: string }[];
}

const PORTAL = "https://discord.com/developers/applications";

/**
 * Setting up your own Discord bot, step by step: Discord makes everyone create the bot on its
 * own site (a check that you are human and its terms), then Hearth does the rest: it checks the
 * token, makes the link that adds the bot to your server with the right permissions, and lists
 * your channels to pick from.
 */
export function BotSetup({
  channel,
  onClose,
  embedded,
}: {
  channel: NotificationChannel;
  onClose: () => void;
  /** Inside Change: no form or save of its own; what is typed and picked is handed up. */
  embedded?: { onValues: (values: Record<string, string>) => void };
}) {
  const configure = useConfigureChannel();
  const editing = channel.status === "configured";
  const [token, setToken] = useState("");
  const [pick, setPick] = useState(String(channel.config?.channel ?? ""));
  const look = useMutation({
    mutationFn: (t?: string) =>
      api<BotInfo>("POST", `/api/notifications/channels/${encodeURIComponent(channel.id)}/bot`, {
        ...(t ? { token: t } : {}),
      }),
  });
  const bot = look.data;
  // Already set up: read the bot with the saved token.
  const lookMutate = look.mutate;
  useEffect(() => {
    if (editing) lookMutate(undefined);
  }, [editing, lookMutate]);
  const servers = [...new Set(bot?.channels.map((c) => c.server) ?? [])];
  const onValues = embedded?.onValues;
  useEffect(() => {
    onValues?.({ ...(token ? { token } : {}), channel: pick });
  }, [onValues, token, pick]);
  const Wrap = embedded ? "div" : "form";

  const step = "mb-5 rounded-xl border border-line p-4";
  const num =
    "mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-gold/15 text-[0.78rem] font-semibold text-gold";
  return (
    <Wrap
      data-testid="bot-setup"
      {...(embedded
        ? {}
        : {
            onSubmit: (e: React.FormEvent) => {
              e.preventDefault();
              configure.mutate(
                { id: channel.id, values: { ...(token ? { token } : {}), channel: pick } },
                { onSuccess: onClose },
              );
            },
          })}
    >
      <p className="mb-5 text-[0.85rem] leading-relaxed text-muted">
        Your own bot posts movie nights with <span className="text-ink">I'm in</span> and{" "}
        <span className="text-ink">Can't make it</span> buttons, so friends answer with one tap and
        the guest list keeps itself. It takes about two minutes.
      </p>

      {!editing && (
        <div className={step}>
          <p className="mb-2 text-[0.9rem] text-ink">
            <span className={num}>1</span>Make the bot in Discord
          </p>
          <ol className="mb-3 list-decimal space-y-1 pl-9 text-[0.82rem] text-muted">
            <li>Open Discord's developer site and sign in.</li>
            <li>
              Choose <span className="text-ink">New Application</span>, name it (Hearth works), and
              accept Discord's terms.
            </li>
            <li>
              Open <span className="text-ink">Bot</span>, press{" "}
              <span className="text-ink">Reset Token</span>, then{" "}
              <span className="text-ink">Copy</span>.
            </li>
          </ol>
          <a
            href={PORTAL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[0.84rem] text-ink hover:border-gold hover:text-gold"
          >
            <ExternalLink className="h-4 w-4" aria-hidden /> Open Discord's developer site
          </a>
        </div>
      )}

      <div className={step}>
        <p className="mb-3 text-[0.9rem] text-ink">
          <span className={num}>{editing ? 1 : 2}</span>Paste the token
        </p>
        <TextField
          id="bot-token"
          label="Bot token"
          type="password"
          autoComplete="off"
          placeholder={editing ? "Saved in the vault. Leave empty to keep it." : "Paste it here"}
          hint="Kept in Hearth's vault, never shown again."
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button
          tone="outline"
          type="button"
          disabled={look.isPending || (!token && !editing)}
          onClick={() => look.mutate(token || undefined)}
          data-testid="bot-check"
        >
          <RefreshCw className={look.isPending ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
          {look.isPending ? "Checking" : "Check it"}
        </Button>
        {bot && (
          <p
            className="mt-3 flex items-center gap-1.5 text-[0.84rem] text-ok"
            data-testid="bot-name"
          >
            <Check className="h-4 w-4" aria-hidden /> Connected as {bot.name}
          </p>
        )}
        <FormError error={look.error} />
      </div>

      {bot && (
        <div className={step}>
          <p className="mb-2 text-[0.9rem] text-ink">
            <span className={num}>{editing ? 2 : 3}</span>Add it to your server
          </p>
          <p className="mb-3 text-[0.82rem] text-muted">
            Discord asks which server; the permissions are already set (post, pictures, read the
            channel). Then come back and look again.
          </p>
          <span className="flex flex-wrap gap-2">
            <a
              href={bot.invite}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="bot-invite"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-gold/60 bg-gold/10 px-3 text-[0.84rem] text-gold hover:bg-gold/20"
            >
              <ExternalLink className="h-4 w-4" aria-hidden /> Add {bot.name} to my server
            </a>
            <Button
              tone="outline"
              type="button"
              onClick={() => look.mutate(token || undefined)}
              disabled={look.isPending}
            >
              I added it, look again
            </Button>
          </span>
        </div>
      )}

      {bot && (
        <div className={step}>
          <p className="mb-3 text-[0.9rem] text-ink">
            <span className={num}>{editing ? 3 : 4}</span>Pick the channel
          </p>
          {bot.channels.length ? (
            <select
              aria-label="Channel"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              data-testid="bot-channel"
              className="min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
            >
              <option value="">Choose a channel</option>
              {servers.map((s) => (
                <optgroup key={s} label={s}>
                  {bot.channels
                    .filter((c) => c.server === s)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <p className="text-[0.84rem] text-amber">
              The bot is not in a server yet. Add it above, then look again.
            </p>
          )}
        </div>
      )}

      {!embedded && (
        <>
          <Button
            tone="primary"
            type="submit"
            className="w-full"
            disabled={configure.isPending || !pick || (!editing && !token)}
          >
            {configure.isPending ? "Saving" : editing ? "Save changes" : "Finish setting up"}
          </Button>
          <FormError error={configure.error} />
        </>
      )}
    </Wrap>
  );
}
