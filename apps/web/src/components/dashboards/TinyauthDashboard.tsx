import { MessageCircle } from "lucide-react";
import { api } from "../../data/api";
import { ago } from "../../lib/format";
import { useCave } from "../shell/cave-context";
import { Skeleton, cx } from "../ui";
import { useLiveQuery } from "../panels/lifecycle";
import { TinyauthGuide } from "./tinyauth/TinyauthGuide";
import { EmberMark } from "../ember/EmberMark";

/**
 * Tinyauth from Hearth: whether it is running, and from its own log over the last day how many
 * visitors it let in, sent to the sign-in page, or refused, who signed in (and who failed to),
 * where the asks came from, and hours far busier than usual; what it does, which sites it guards
 * (from Caddy) and putting another site behind it (TinyauthGuide). Users and passwords live in its
 * users file and are never read here.
 */

interface Panel {
  available: boolean;
  reason?: string;
  at: string;
  running?: boolean;
  startedAt?: string;
  from?: string;
  to?: string;
  checks?: { allowed: number; sentToSignIn: number; refused: number };
  signIns?: { at?: string; address: string; ok: boolean }[];
  hours?: { hour: string; checks: number }[];
  bursts?: { hour: string; checks: number; mostly?: string; signedIn: boolean }[];
  addresses?: { address: string; allowed: number; sentToSignIn: number; refused: number }[];
  errors?: { at?: string; text: string }[];
}

const n = (x: number) => x.toLocaleString();
const isLocal = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1|fd)/.test(a);
const hourOf = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
  });

export function TinyauthDashboard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useLiveQuery({
    queryKey: ["dashboard", serviceId, "tinyauth"],
    queryFn: () => api<Panel>("GET", `/api/services/${serviceId}/tinyauth`),
    refetchInterval: 300_000,
  });
  const cave = useCave();
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-48" />;
  // Its log may be out of reach; what it does and which sites it guards still show.
  if (q.error || !d?.available)
    return (
      <section className="@container space-y-4" aria-label={`${name}: sign-ins`}>
        <div
          className="rounded-xl border border-amber/40 p-4 text-[0.88rem]"
          data-testid="ta-error"
        >
          <p className="text-amber">{name}&apos;s log could not be read right now.</p>
          <p className="mt-1 text-muted">{d?.reason ?? q.error?.message}</p>
        </div>
        <TinyauthGuide serviceId={serviceId} name={name} />
      </section>
    );
  const c = d.checks ?? { allowed: 0, sentToSignIn: 0, refused: 0 };
  const signIns = d.signIns ?? [];
  const failedSignIns = signIns.filter((s) => !s.ok);
  const hours = d.hours ?? [];
  const peak = Math.max(1, ...hours.map((h) => h.checks));
  const span =
    d.from && d.to
      ? Math.max(1, Math.round((Date.parse(d.to) - Date.parse(d.from)) / 3_600_000))
      : undefined;
  return (
    <section
      className="@container space-y-4"
      data-testid="ta-dashboard"
      aria-label={`${name}: sign-ins`}
    >
      <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
        {(
          [
            [
              "State",
              d.running ? "Running" : "Stopped",
              d.startedAt ? `since ${ago(d.startedAt)}` : "",
            ],
            ["Let in", n(c.allowed), "already signed in"],
            ["Sent to sign in", n(c.sentToSignIn), "not signed in yet"],
            [
              "Sign-ins",
              `${signIns.length - failedSignIns.length}`,
              failedSignIns.length ? `${failedSignIns.length} failed` : "none failed",
            ],
          ] as const
        ).map(([label, value, sub]) => (
          <div key={label} className="stat-tile rounded-xl border border-line bg-bg/50 p-3">
            <p className="text-[0.72rem] tracking-wide text-faint uppercase">{label}</p>
            <p
              className={cx(
                "stat-value text-ink tabular",
                label === "State" && (d.running ? "text-live" : "text-alert"),
              )}
              data-testid={label === "Let in" ? "ta-allowed" : undefined}
            >
              {value}
            </p>
            <p
              className={cx(
                "text-[0.74rem] text-faint",
                label === "Sign-ins" && failedSignIns.length > 0 && "text-amber",
              )}
            >
              {sub}
            </p>
          </div>
        ))}
      </div>

      <TinyauthGuide serviceId={serviceId} name={name} />

      {hours.length > 1 && (
        <div>
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Asks per hour</p>
          <div
            className="flex h-16 items-end gap-0.5"
            role="img"
            aria-label={`Asks per hour, busiest ${n(peak)}`}
            data-testid="ta-hours"
          >
            {hours.map((h) => (
              <div
                key={h.hour}
                title={`${hourOf(h.hour)}: ${n(h.checks)}`}
                className="min-w-0 flex-1 rounded-t-sm bg-gold/60"
                style={{ height: `${Math.max(4, (h.checks / peak) * 100)}%` }}
              />
            ))}
          </div>
        </div>
      )}

      {(d.bursts ?? []).length > 0 && (
        <div className="rounded-xl border border-line-strong p-3" data-testid="ta-bursts">
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Busy hours</p>
          <ul className="space-y-1 text-[0.84rem]">
            {d.bursts!.map((b) => (
              <li key={b.hour} className="break-words text-muted">
                <span className="text-ink">{hourOf(b.hour)}</span>: {n(b.checks)} asks
                {b.mostly ? `, mostly from ${b.mostly}` : ""}
                {b.signedIn
                  ? " (signed in, usually an app or phone syncing)"
                  : " (not signed in: worth a look)"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 @lg:grid-cols-2">
        <div>
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Sign-ins</p>
          {signIns.length ? (
            <ul className="divide-y divide-line text-[0.84rem]" data-testid="ta-signins">
              {signIns.map((s, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                  <span className="min-w-0 flex-1 break-words text-ink">{s.address}</span>
                  <span className={s.ok ? "text-live" : "text-alert"}>
                    {s.ok ? "Signed in" : "Wrong password"}
                  </span>
                  {s.at && <span className="text-faint">{ago(s.at)}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.86rem] text-muted">Nobody signed in during this time.</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Who asked most</p>
          <ul className="divide-y divide-line text-[0.82rem]" data-testid="ta-addresses">
            {(d.addresses ?? []).map((a) => (
              <li key={a.address} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                <span className="min-w-0 flex-1 break-words text-ink">
                  {a.address}
                  {isLocal(a.address) ? <span className="text-faint"> · at home</span> : null}
                </span>
                <span className="text-faint">
                  {a.allowed ? `${n(a.allowed)} let in` : ""}
                  {a.allowed && (a.sentToSignIn || a.refused) ? " · " : ""}
                  {a.sentToSignIn || a.refused
                    ? `${n(a.sentToSignIn + a.refused)} turned away`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {(d.errors ?? []).length > 0 && (
        <div>
          <p className="mb-1 text-[0.72rem] tracking-wide text-faint uppercase">Its own errors</p>
          <ul className="space-y-1 text-[0.8rem]">
            {d.errors!.map((e, i) => (
              <li key={i} className="break-words text-amber">
                {e.text}
                {e.at ? <span className="text-faint"> · {ago(e.at)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gold/40 px-2.5 text-[0.76rem] text-gold hover:bg-gold/10"
          onClick={() =>
            cave.ask(
              `In ${name} over the last day: ${n(c.allowed)} let in, ${n(c.sentToSignIn)} sent to sign in, ${n(c.refused)} refused, ${failedSignIns.length} failed sign-ins. Is anything here worth worrying about, and which sites does it protect?`,
            )
          }
        >
          <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember about this
          <EmberMark />
        </button>
      </div>
      <p className="text-[0.74rem] text-faint">
        from its own log{span ? `, the last ${span} hours` : ""} · checked {ago(d.at)}
      </p>
    </section>
  );
}
