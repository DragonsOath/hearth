import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { NotificationChannel } from "@dragon-control/core";
import { api, useConfigureChannel } from "../../data/api";
import { Button } from "../ui";
import { FormError } from "../../pages/auth/AuthFrame";

interface Channel {
  id: string;
  name: string;
  server: string;
}

/** Whether the official Hearth bot is offered on this Hearth. */
export function useHearthBotAvailable() {
  return (
    useQuery({
      queryKey: ["hearth-bot"],
      queryFn: () => api<{ available: boolean }>("GET", "/api/notifications/hearth-bot"),
      staleTime: 5 * 60_000,
    }).data?.available ?? false
  );
}

/**
 * The official Hearth bot, in two steps: add it to your server (Discord asks which one), then pick
 * the channel. No developer site, no token.
 */
export function HearthBotSetup({
  channel,
  onClose,
  embedded,
}: {
  channel: NotificationChannel;
  onClose: () => void;
  /** Inside Change: no form or save of its own; the channel picked is handed up. */
  embedded?: { onValues: (values: Record<string, string>) => void };
}) {
  const configure = useConfigureChannel();
  const editing = channel.status === "configured";
  const [pick, setPick] = useState(String(channel.config?.channel ?? ""));
  const invite = useMutation({
    mutationFn: () =>
      api<{ url: string }>("POST", "/api/notifications/hearth-bot", { action: "invite" }),
    onSuccess: (r) => window.open(r.url, "_blank", "noopener"),
  });
  const list = useMutation({
    mutationFn: () =>
      api<{ channels: Channel[] }>("POST", "/api/notifications/hearth-bot", { action: "channels" }),
  });
  const channels = list.data?.channels;
  const servers = [...new Set(channels?.map((c) => c.server) ?? [])];
  const onValues = embedded?.onValues;
  useEffect(() => {
    onValues?.({ channel: pick });
  }, [onValues, pick]);
  const Wrap = embedded ? "div" : "form";
  const step = "mb-5 rounded-xl border border-line p-4";
  const num =
    "mr-2 inline-grid h-6 w-6 place-items-center rounded-full bg-gold/15 text-[0.78rem] font-semibold text-gold";
  return (
    <Wrap
      data-testid="hearth-bot-setup"
      {...(embedded
        ? {}
        : {
            onSubmit: (e: React.FormEvent) => {
              e.preventDefault();
              configure.mutate(
                { id: channel.id, values: { channel: pick } },
                { onSuccess: onClose },
              );
            },
          })}
    >
      <p className="mb-5 text-[0.85rem] leading-relaxed text-muted">
        Hearth posts in your Discord server, and movie night invitations get{" "}
        <span className="text-ink">I&apos;m in</span> and{" "}
        <span className="text-ink">Can&apos;t make it</span> buttons that keep the guest list for
        you.
      </p>
      <div className={step}>
        <p className="mb-2 text-[0.9rem] text-ink">
          <span className={num}>1</span>Add Hearth to your server
        </p>
        <p className="mb-3 text-[0.82rem] text-muted">
          Discord opens and asks which server. You need to be able to manage that server.
        </p>
        <Button
          tone="outline"
          type="button"
          onClick={() => invite.mutate()}
          disabled={invite.isPending}
          data-testid="hearth-bot-invite"
        >
          <ExternalLink className="h-4 w-4" aria-hidden />
          {editing ? "Add Hearth to another server" : "Add Hearth to my server"}
        </Button>
        <FormError error={invite.error} />
      </div>
      <div className={step}>
        <p className="mb-3 text-[0.9rem] text-ink">
          <span className={num}>2</span>Pick the channel
        </p>
        {!channels ? (
          <Button
            tone="outline"
            type="button"
            onClick={() => list.mutate()}
            disabled={list.isPending}
            data-testid="hearth-bot-channels"
          >
            {list.isPending ? "Looking" : "Show my channels"}
          </Button>
        ) : channels.length ? (
          <select
            aria-label="Channel"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
          >
            <option value="">Choose a channel</option>
            {servers.map((s) => (
              <optgroup key={s} label={s}>
                {channels
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
            Hearth is not in a server yet. Add it above, then{" "}
            <button type="button" className="text-gold underline" onClick={() => list.mutate()}>
              look again
            </button>
            .
          </p>
        )}
        <FormError error={list.error} />
      </div>
      {!embedded && (
        <>
          <Button
            tone="primary"
            type="submit"
            className="w-full"
            disabled={configure.isPending || !pick}
          >
            {configure.isPending ? "Saving" : editing ? "Save changes" : "Finish setting up"}
          </Button>
          <FormError error={configure.error} />
        </>
      )}
    </Wrap>
  );
}
