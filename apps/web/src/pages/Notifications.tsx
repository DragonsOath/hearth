import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { api } from "../data/api";
import { WithWorkspace } from "../components/WithWorkspace";
import {
  Button,
  PageHeader,
  Rows,
  SaveNote,
  Section,
  Sheet,
  Switch,
  Tag,
  cx,
} from "../components/ui";
import {
  useAddDestination,
  useConfigureChannel,
  useRemoveChannel,
  useSetChannelEnabled,
  useSetRouteChannels,
  useTestChannel,
  useUpdateSettings,
} from "../data/api";
import {
  CHANNEL_FIELDS,
  HEARTH_NOT_IN_SERVER,
  PUBLIC_ROUTES,
  isChannelKind,
  type NotificationChannel,
  type NotificationLogEntry,
  type NotificationRoute,
  type Workspace,
} from "@dragon-control/core";
import { ago } from "../lib/format";
import { useScrollToHash } from "../lib/hashScroll";
import { MediaAnnouncements } from "../components/notify/MediaAnnouncements";
import { usePanelHref } from "../components/desk/links";
import { BotSetup } from "../components/notify/BotSetup";
import { Briefs } from "../components/notify/Briefs";
import { PushSetup } from "../components/notify/PushSetup";
import {
  ChangeDestination,
  useChangeState,
  useUndoChange,
} from "../components/notify/ChangeDestination";
import { HearthBotSetup, useHearthBotAvailable } from "../components/notify/HearthBotSetup";
import { FormError, TextField } from "./auth/AuthFrame";
import { MonitoringTabs } from "../components/shell/MonitoringTabs";

function RouteRow({
  route,
  channels,
  onToggle,
}: {
  route: NotificationRoute;
  channels: { id: string; name: string }[];
  onToggle: (channelId: string) => void;
}) {
  return (
    <li className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[0.95rem] text-ink">{route.event}</p>
        <p className="text-[0.8rem] text-faint">{route.description}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Channels for ${route.event}`}>
        {channels.length === 0 && (
          <span className="text-[0.8rem] text-faint">No channels set up</span>
        )}
        {channels.map((c) => {
          const on = route.channels.includes(c.id);
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(c.id)}
              className={cx(
                "min-h-11 rounded-full border px-4 text-[0.8rem] transition-colors duration-200",
                on
                  ? "border-gold/60 bg-gold/10 text-gold"
                  : "border-line text-faint hover:text-ink",
              )}
            >
              {c.name}
            </button>
          );
        })}
      </div>
    </li>
  );
}

/** The form for one channel, built from the shared field definitions. */
function ChannelSheet({ channel, onClose }: { channel: NotificationChannel; onClose: () => void }) {
  const configure = useConfigureChannel();
  const kind = channel.kind ?? channel.id;
  const fields = isChannelKind(kind) ? CHANNEL_FIELDS[kind] : [];
  const editing = channel.status === "configured";
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.key, String(channel.config?.[f.key] ?? f.defaultValue ?? "")]),
    ),
  );
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <Sheet
      label={`${editing ? "Change" : "Set up"} ${channel.name}`}
      eyebrow="Notifications"
      title={`${editing ? "Change" : "Set up"} ${channel.name}`}
      onClose={onClose}
    >
      {kind === "hearth-bot" ? (
        <HearthBotSetup channel={channel} onClose={onClose} />
      ) : kind === "discord-bot" ? (
        <BotSetup channel={channel} onClose={onClose} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            configure.mutate({ id: channel.id, values }, { onSuccess: onClose });
          }}
        >
          {fields.map((f) =>
            f.type === "select" ? (
              <div key={f.key} className="mb-5">
                <label htmlFor={`ch-${f.key}`} className="mb-2 block text-[0.85rem] text-muted">
                  {f.label}
                </label>
                <select
                  id={`ch-${f.key}`}
                  value={values[f.key]}
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
                  f.secret && editing
                    ? "Saved in the vault. Leave empty to keep it."
                    : f.placeholder
                }
                hint={
                  f.secret
                    ? `${f.hint ? `${f.hint} ` : ""}Kept in the vault, never shown again.`
                    : f.hint
                }
                value={values[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
                autoComplete="off"
                required={f.required && !(f.secret && editing)}
              />
            ),
          )}
          <Button tone="primary" type="submit" className="w-full" disabled={configure.isPending}>
            {configure.isPending ? "Saving" : editing ? "Save changes" : `Set up ${channel.name}`}
          </Button>
          <FormError error={configure.error} />
        </form>
      )}
    </Sheet>
  );
}

/** What a destination is called when its name is left blank. */
const DEFAULT_NAMES: Record<string, string> = {
  "hearth-bot": "Discord (Hearth bot)",
  discord: "Discord",
  "discord-bot": "Discord (my bot)",
  email: "Email",
  ntfy: "ntfy",
  telegram: "Telegram",
  webhook: "Webhook",
};

/** Adds a destination: a name, its kind, and who reads it. */
function AddDestinationSheet({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const add = useAddDestination();
  const hearthBot = useHearthBotAvailable();
  const [chosen, setKind] = useState<string>();
  // The official Hearth bot is the easy Discord choice, where it is offered.
  const kind = chosen ?? (hearthBot ? "hearth-bot" : "discord");
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<"private" | "public">("private");
  return (
    <Sheet
      label="Add a destination"
      eyebrow="Notifications"
      title="Add a destination"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // A blank name takes the kind's own name, so the box can be left as it is.
          add.mutate(
            { kind, name: name.trim() || DEFAULT_NAMES[kind] || "Notifications", audience },
            { onSuccess: (r) => onAdded(r.id) },
          );
        }}
      >
        <p className="mb-5 text-[0.85rem] leading-relaxed text-muted">
          Another place to send notifications, such as a second Discord channel. You choose what
          goes there afterwards; it starts with nothing.
        </p>
        <TextField
          id="dest-name"
          label="Name"
          placeholder={DEFAULT_NAMES[kind] ?? "For example: Movie announcements"}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="mb-5">
          <label htmlFor="dest-kind" className="mb-2 block text-[0.85rem] text-muted">
            Kind
          </label>
          <select
            id="dest-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="min-h-12 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink focus:border-gold/60 focus:outline-none"
          >
            {hearthBot && <option value="hearth-bot">Discord (Hearth bot, one click)</option>}
            <option value="discord">Discord</option>
            <option value="discord-bot">Discord (your own bot, with buttons)</option>
            <option value="email">Email</option>
            <option value="ntfy">ntfy</option>
            <option value="telegram">Telegram</option>
            <option value="webhook">Webhook</option>
          </select>
        </div>
        <fieldset className="mb-6">
          <legend className="mb-2 text-[0.85rem] text-muted">Who reads it</legend>
          {(
            [
              ["private", "Just me", "Any notification you choose: alerts, repairs, downloads."],
              [
                "public",
                "Friends and family",
                "Only media announcements. System alerts, errors, and anything about your servers never go there.",
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className="mb-2 flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3"
            >
              <input
                type="radio"
                name="audience"
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
        <Button tone="primary" type="submit" className="w-full" disabled={add.isPending}>
          {add.isPending ? "Adding" : "Add, then set it up"}
        </Button>
        <FormError error={add.error} />
      </form>
    </Sheet>
  );
}

/** Destinations nothing reaches any more, named at the top with a link to each (11-13). */
function BrokenNotice({ channels }: { channels: NotificationChannel[] }) {
  const broken = channels.filter(
    (c) => c.broken && c.status === "configured" && c.enabled !== false,
  );
  if (!broken.length) return null;
  return (
    <div
      role="status"
      className="mb-6 rounded-xl border border-warn/40 p-4 text-[0.9rem] text-ink"
      data-testid="broken-notice"
    >
      {broken.length === 1
        ? `${broken[0]!.name} stopped working, so alerts sent there are lost.`
        : `${broken.length} destinations stopped working, so alerts sent there are lost.`}{" "}
      {broken.map((c, i) => (
        <span key={c.id}>
          {i > 0 && " · "}
          <a className="text-gold underline underline-offset-2" href={`#fix-${c.id}`}>
            Fix {broken.length === 1 ? "it" : c.name}
          </a>
        </span>
      ))}
    </div>
  );
}

function ChannelRow({
  channel,
  routes,
  openSetup = false,
}: {
  channel: NotificationChannel;
  routes: NotificationRoute[];
  openSetup?: boolean;
}) {
  const test = useTestChannel();
  const undo = useUndoChange();
  const changed = useChangeState().data?.[channel.id]?.undo;
  // Undo stays offered for a day after a change (Changes and activity keeps the record).
  const [now] = useState(() => Date.now());
  const recent = changed && now - Date.parse(changed) < 86_400_000;
  const remove = useRemoveChannel();
  const setEnabled = useSetChannelEnabled();
  const [editing, setEditing] = useState(openSetup);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const configured = channel.status === "configured";
  const enabled = channel.enabled !== false;
  // Its last delivery was turned away for good (a deleted webhook): say so, and how to fix it.
  const broken = configured && enabled ? channel.broken : undefined;
  // The notice's "Fix it" link (#fix-<id>) opens this destination's Change, scrolled into view.
  useEffect(() => {
    const go = () => {
      if (window.location.hash !== `#fix-${channel.id}`) return;
      document.getElementById(`channel-${channel.id}`)?.scrollIntoView({ block: "center" });
      setEditing(true);
      history.replaceState(null, "", window.location.pathname + window.location.search);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [channel.id]);
  return (
    <li
      className="scroll-mt-24 py-4"
      id={`channel-${channel.id}`}
      data-testid={`channel-${channel.id}`}
    >
      <div className="flex min-h-12 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[0.95rem] text-ink">
            {channel.name}
            {channel.added && channel.kind && (
              <span className="text-[0.75rem] text-faint">{channel.kind}</span>
            )}
            {channel.audience === "public" && <Tag tone="gold">Friends and family</Tag>}
          </p>
          {channel.detail && <p className="text-[0.8rem] text-faint">{channel.detail}</p>}
          {broken && (
            <p className="mt-1 text-[0.82rem] text-warn" data-testid={`broken-${channel.id}`}>
              {broken.reason} Last tried {ago(broken.at)}.{" "}
              {channel.id === "push" ? (
                "Turn it on again on this device below."
              ) : broken.reason === HEARTH_NOT_IN_SERVER ? (
                <AddHearthHere />
              ) : (
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-ink"
                  onClick={() => setEditing(true)}
                  data-testid={`fix-${channel.id}`}
                >
                  Fix it
                </button>
              )}
            </p>
          )}
        </div>
        {configured ? (
          <>
            {broken ? (
              <Tag tone="warn">Broken</Tag>
            ) : enabled ? (
              <Tag tone="gold">Active</Tag>
            ) : (
              <Tag>Off</Tag>
            )}
            <Switch
              checked={enabled}
              onChange={(next) => setEnabled.mutate({ id: channel.id, enabled: next })}
              label={`${channel.name}: on or off`}
            />
            <Button tone="quiet" onClick={() => test.mutate(channel.id)} disabled={test.isPending}>
              {test.isPending ? "Sending" : "Send test"}
            </Button>
            {channel.id === "push" ? (
              <PushSetup />
            ) : (
              <Button
                tone="quiet"
                onClick={() => setEditing(true)}
                data-testid={`change-${channel.id}`}
              >
                Change
              </Button>
            )}
            {recent && channel.id !== "push" && (
              <Button
                tone="quiet"
                onClick={() => undo.mutate(channel.id)}
                disabled={undo.isPending}
                data-testid={`undo-${channel.id}`}
              >
                Undo last change
              </Button>
            )}
            {confirmRemove ? (
              <Button
                tone="quiet"
                className="text-bad hover:text-bad"
                onClick={() => remove.mutate(channel.id)}
              >
                {channel.added ? "Delete for good" : "Stop for good"}
              </Button>
            ) : (
              <Button tone="quiet" onClick={() => setConfirmRemove(true)}>
                {channel.added ? "Delete" : "Stop"}
              </Button>
            )}
          </>
        ) : channel.id === "push" ? (
          <PushSetup />
        ) : channel.supported ? (
          <>
            <Button onClick={() => setEditing(true)}>Set up</Button>
            {channel.added && (
              <Button tone="quiet" onClick={() => remove.mutate(channel.id)}>
                Delete
              </Button>
            )}
          </>
        ) : (
          <span className="text-[0.78rem] text-faint">Coming later</span>
        )}
      </div>
      <div aria-live="polite">
        {test.data && (
          <p
            className={cx("mt-2 text-[0.82rem]", test.data.ok ? "text-muted" : "text-bad")}
            data-testid="test-result"
          >
            {test.data.ok
              ? "Test sent. Check that it arrived."
              : `It did not go through: ${test.data.error}`}
          </p>
        )}
      </div>
      <FormError error={test.error ?? remove.error ?? setEnabled.error ?? undo.error} />
      {editing &&
        (configured ? (
          <ChangeDestination channel={channel} routes={routes} onClose={() => setEditing(false)} />
        ) : (
          <ChannelSheet channel={channel} onClose={() => setEditing(false)} />
        ))}
    </li>
  );
}

const eventLabel: Record<string, string> = {
  "needs-you": "Needs you",
  "auto-repaired": "Repaired",
  "repair-failed": "Repair failed",
  critical: "Critical",
  resolved: "Resolved",
  weekly: "Weekly",
  test: "Test",
};

function RecentNotifications({ ws }: { ws: Workspace }) {
  const names = new Map(ws.channels.map((c) => [c.id, c.name]));
  const list: NotificationLogEntry[] = ws.notifications.slice(0, 12);
  if (list.length === 0) {
    return (
      <p className="py-2 text-[0.9rem] text-muted">
        Nothing sent yet. Messages appear here as they go out.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line" data-testid="recent-notifications">
      {list.map((n) => (
        <li key={n.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4">
          <span className="text-[0.75rem] text-faint sm:w-24 sm:shrink-0">
            {eventLabel[n.event] ?? n.event}
          </span>
          <span className="min-w-0 flex-1 text-[0.88rem] text-ink">{n.title}</span>
          <span
            className={cx(
              "text-[0.78rem]",
              n.status === "failed" ? "text-bad" : n.status === "held" ? "text-warn" : "text-faint",
            )}
          >
            {n.status === "sent"
              ? `${names.get(n.channelId) ?? n.channelId} · ${ago(n.at).toLowerCase()}`
              : n.status === "held"
                ? `${names.get(n.channelId) ?? n.channelId} · held for the morning`
                : `${names.get(n.channelId) ?? n.channelId} · failed: ${n.error ?? "unknown"}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NotificationsContent({ ws }: { ws: Workspace }) {
  useScrollToHash();
  const setRoute = useSetRouteChannels();
  const [adding, setAdding] = useState(false);
  // A destination just added opens straight into its setup.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const updateSettings = useUpdateSettings();
  // Show the pending value while a save is in flight so toggles feel immediate.
  const routes = ws.routes.map((r) =>
    setRoute.isPending && setRoute.variables?.routeId === r.id
      ? { ...r, channels: setRoute.variables.channels }
      : r,
  );
  const quietHours =
    updateSettings.isPending && updateSettings.variables?.quietHours !== undefined
      ? updateSettings.variables.quietHours
      : ws.quietHours;
  const configured = ws.channels.filter((c) => c.status === "configured");
  const rest = ws.channels.filter((c) => c.status !== "configured");
  const ordered = [
    ...configured,
    ...rest.filter((c) => c.supported),
    ...rest.filter((c) => !c.supported),
  ];

  const toggle = (routeId: string, channelId: string) => {
    const route = routes.find((r) => r.id === routeId);
    if (!route) return;
    const channels = route.channels.includes(channelId)
      ? route.channels.filter((c) => c !== channelId)
      : [...route.channels, channelId];
    setRoute.mutate({ routeId, channels });
  };

  return (
    <>
      <MonitoringTabs />
      <PageHeader
        eyebrow="Monitoring"
        title="When to reach you"
        subtitle="Hearth writes to you only when something matters, and always says what it did and whether you need to act."
      />
      <BrokenNotice channels={ws.channels} />

      <Section title="Channels" id="channels">
        <Rows>
          {ordered.map((c) => (
            <ChannelRow key={c.id} channel={c} routes={ws.routes} openSetup={c.id === justAdded} />
          ))}
        </Rows>
        <div className="pt-4">
          <Button onClick={() => setAdding(true)} data-testid="add-destination">
            Add a destination
          </Button>
        </div>
        {adding && (
          <AddDestinationSheet
            onClose={() => setAdding(false)}
            onAdded={(id) => {
              setAdding(false);
              setJustAdded(id);
            }}
          />
        )}
      </Section>

      <Section title="What goes where">
        <ul className="divide-y divide-line">
          {routes.map((r) => (
            <RouteRow
              key={r.id}
              route={r}
              channels={configured.filter(
                (c) => c.audience !== "public" || PUBLIC_ROUTES.includes(r.id),
              )}
              onToggle={(c) => toggle(r.id, c)}
            />
          ))}
        </ul>
      </Section>

      <Section title="Briefs and watches" id="briefs">
        <Briefs ws={ws} />
      </Section>

      <Section title="Media announcements" id="media-announcements">
        <MediaAnnouncements />
      </Section>

      <Section title="Movie nights" id="movie-nights">
        <MovieNightsPointer />
      </Section>

      <Section title="Quiet hours">
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="text-[0.95rem] text-ink">Hold routine messages overnight</p>
            <p className="text-[0.8rem] text-faint">
              From 22:00 to 07:00, only critical matters come through. The rest wait for morning.
            </p>
          </div>
          <Switch
            checked={quietHours}
            onChange={(next) => updateSettings.mutate({ quietHours: next })}
            label="Quiet hours"
          />
        </div>
      </Section>

      <Section title="Recently sent">
        <RecentNotifications ws={ws} />
      </Section>

      <SaveNote
        status={setRoute.status === "idle" ? updateSettings.status : setRoute.status}
        error={setRoute.error ?? updateSettings.error}
      />
    </>
  );
}

export function NotificationsPage() {
  return <WithWorkspace>{(ws) => <NotificationsContent ws={ws} />}</WithWorkspace>;
}

/**
 * Movie nights have their own panel now (11-12); this section stays so old links still land, and
 * says where the nights went. Who gets invited is set up above, in Media announcements.
 */
function MovieNightsPointer() {
  const href = usePanelHref()("tool:movie-nights");
  return (
    <div className="space-y-3" data-testid="movie-nights-moved">
      <p className="max-w-3xl text-[0.86rem] leading-relaxed text-muted">
        Planning a night, who&apos;s coming, and changing or cancelling it are in the Movie nights
        panel. Who gets invited is the destination you chose for New in your library, above.
      </p>
      {href && (
        <Link
          to={href}
          className="inline-flex min-h-11 items-center rounded-lg border border-gold/50 px-4 text-[0.85rem] text-gold hover:bg-gold/10"
          data-testid="movie-nights-open"
        >
          Open Movie nights
        </Link>
      )}
    </div>
  );
}

/**
 * Hearth isn't in that channel's server (11-14): Discord's own add page, with the permissions
 * Hearth needs already chosen, opens in a new tab. Then Send a test.
 */
function AddHearthHere() {
  const invite = useMutation({
    mutationFn: () =>
      api<{ url: string }>("POST", "/api/notifications/hearth-bot", { action: "invite" }),
    onSuccess: (r) => window.open(r.url, "_blank", "noopener,noreferrer"),
  });
  return (
    <>
      <button
        type="button"
        className="underline underline-offset-2 hover:text-ink disabled:opacity-50"
        onClick={() => invite.mutate()}
        disabled={invite.isPending}
        data-testid="broken-add-hearth"
      >
        Add Hearth to that server
      </button>
      {invite.error && <span className="ml-2">{(invite.error as Error).message}</span>}
    </>
  );
}
