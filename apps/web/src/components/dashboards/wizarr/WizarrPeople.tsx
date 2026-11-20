import { useState } from "react";
import { CalendarClock, Search, UserMinus, UserRound } from "lucide-react";
import type { WizarrDashboard } from "@dragon-control/core";
import type { AppViewProps } from "../../panels/registry";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { Skeleton, cx } from "../../ui";
import { WizarrPage, day, endingSoon, useWizarr } from "./shared";

/**
 * Wizarr's People: everyone with access through Wizarr, whose access ends soon, and what you do
 * about it: extend it, give it an end date or none, disable or enable the account, or remove it.
 * Each change is a plan you confirm here; Hearth makes it in Wizarr and reads it back. Password
 * resets stay in Wizarr (they are credentials).
 */

type User = WizarrDashboard["users"][number];
type Sort = "name" | "ending" | "newest";

const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.78rem] text-muted hover:border-gold/50 hover:text-ink disabled:opacity-50";

function Actions({
  u,
  c,
  today,
}: {
  u: User;
  c: ReturnType<typeof useApproveHere>;
  today: string;
}) {
  const [date, setDate] = useState("");
  const change = (op: string, extra: Record<string, string | number>, title: string) =>
    void c.propose("app-wizarr-user", { userId: u.id, op, ...extra }, title);
  return (
    <div
      className="mt-2 flex w-full flex-col gap-3 rounded-xl border border-line bg-bg/50 p-3"
      data-testid="wizarr-person-actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.78rem] text-faint">Extend by</span>
        {(
          [
            [7, "7 days"],
            [30, "30 days"],
            [90, "90 days"],
            [365, "1 year"],
          ] as const
        ).map(([days, label]) => (
          <button
            key={days}
            type="button"
            className={btn}
            disabled={c.busy}
            data-hearth-target={`person:${u.id}:extend:${days}`}
            onClick={() =>
              change("extend", { durationDays: days }, `Extend ${u.username}'s access`)
            }
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (date) change("end-date", { endDate: date }, `End ${u.username}'s access on ${date}`);
        }}
      >
        <label className="flex flex-wrap items-center gap-2 text-[0.78rem] text-faint">
          Ends on
          <input
            type="date"
            min={today}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-9 rounded-lg border border-line bg-raised px-2 text-[0.82rem] text-ink"
            data-hearth-target={`person:${u.id}:date`}
          />
        </label>
        <button
          type="submit"
          className={btn}
          disabled={c.busy || !date}
          data-hearth-target={`person:${u.id}:set-date`}
        >
          <CalendarClock strokeWidth={1.5} className="h-3.5 w-3.5" /> Set end date
        </button>
        {u.expires && (
          <button
            type="button"
            className={btn}
            disabled={c.busy}
            data-hearth-target={`person:${u.id}:no-end`}
            onClick={() => change("no-end", {}, `No end date for ${u.username}`)}
          >
            No end date
          </button>
        )}
      </form>
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <button
          type="button"
          className={btn}
          disabled={c.busy}
          data-hearth-target={`person:${u.id}:disable`}
          onClick={() => change("disable", {}, `Disable ${u.username}`)}
        >
          Disable account
        </button>
        <button
          type="button"
          className={btn}
          disabled={c.busy}
          data-hearth-target={`person:${u.id}:enable`}
          onClick={() => change("enable", {}, `Enable ${u.username}`)}
        >
          Enable account
        </button>
        <button
          type="button"
          className={cx(btn, "hover:border-alert/60 hover:text-alert")}
          disabled={c.busy}
          data-hearth-target={`person:${u.id}:remove`}
          onClick={() => change("remove", {}, `Remove ${u.username}`)}
        >
          <UserMinus strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
        </button>
      </div>
    </div>
  );
}

export function WizarrPeople({ serviceId, name, sub, onSub }: AppViewProps) {
  const { q, d, now } = useWizarr(serviceId);
  // The approval shows every line of the plan, including the admin-account warning.
  const c = useApproveHere(serviceId, "From Wizarr's People tab.");
  const [text, setText] = useState("");
  const [open, setOpen] = useState<number>();
  const sort: Sort = sub === "ending" || sub === "newest" ? sub : "name";
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error || q.data?.error || !d)
    return (
      <p className="text-[0.86rem] text-amber">
        {name} could not be read right now. The Overview tab says why.
      </p>
    );
  const today = new Date(now || 0).toISOString().slice(0, 10);
  const words = text.trim().toLowerCase();
  const users = d.users
    .filter((u) => !words || `${u.username} ${u.email ?? ""}`.toLowerCase().includes(words))
    .sort((a, b) =>
      sort === "ending"
        ? (a.expires ? Date.parse(a.expires) : Infinity) -
            (b.expires ? Date.parse(b.expires) : Infinity) || a.username.localeCompare(b.username)
        : sort === "newest"
          ? (b.created ?? "").localeCompare(a.created ?? "")
          : a.username.localeCompare(b.username),
    );
  return (
    <section className="@container space-y-3" aria-label={`${name} people`}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-48">
          <Search
            strokeWidth={1.5}
            className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Find someone"
            aria-label="Find someone"
            className="min-h-10 w-full rounded-lg border border-line bg-raised pr-3 pl-9 text-[0.86rem] text-ink"
            data-hearth-target="people:search"
          />
        </label>
        <label className="text-[0.78rem] text-faint">
          <span className="sr-only">Sort</span>
          <select
            value={sort}
            onChange={(e) => onSub?.(e.target.value === "name" ? null : e.target.value)}
            className="min-h-10 rounded-lg border border-line bg-raised px-2 text-[0.84rem] text-ink"
            data-hearth-target="people:sort"
          >
            <option value="name">By name</option>
            <option value="ending">Access ending first</option>
            <option value="newest">Newest first</option>
          </select>
        </label>
      </div>
      <ApproveDialog c={c} />
      {users.length === 0 ? (
        <p className="text-[0.86rem] text-muted">
          {d.users.length ? "Nobody matches." : "Nobody has joined through Wizarr yet."}
        </p>
      ) : (
        <ul className="divide-y divide-line" data-testid="wizarr-users">
          {users.map((u) => {
            const ended = u.expires ? Date.parse(u.expires) < now : false;
            return (
              <li
                key={u.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
                data-testid="wizarr-person"
                data-hearth-target={`person:${u.id}`}
                data-capture-item
                data-capture-label={u.username}
              >
                <UserRound strokeWidth={1.5} className="h-4 w-4 shrink-0 text-faint" />
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{u.username}</span>
                  <span className="block text-[0.76rem] text-faint">
                    {[u.email, u.server, u.created ? `joined ${day(u.created)}` : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span
                  className={cx(
                    "text-[0.78rem]",
                    ended ? "text-alert" : endingSoon(u.expires, now) ? "text-amber" : "text-muted",
                  )}
                  data-testid="wizarr-person-expiry"
                >
                  {u.expires ? `${ended ? "Ended" : "Ends"} ${day(u.expires)}` : "No end date"}
                </span>
                <button
                  type="button"
                  aria-expanded={open === u.id}
                  onClick={() => setOpen(open === u.id ? undefined : u.id)}
                  className={btn}
                  data-hearth-target={`person:${u.id}:open`}
                >
                  Change access
                </button>
                {open === u.id && <Actions u={u} c={c} today={today} />}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[0.76rem] text-faint">
        A password reset link is a credential, so it stays in Wizarr.{" "}
        <WizarrPage serviceId={serviceId} path="/admin" testId="wizarr-open-users">
          Open Wizarr&apos;s users
        </WizarrPage>
      </p>
    </section>
  );
}
