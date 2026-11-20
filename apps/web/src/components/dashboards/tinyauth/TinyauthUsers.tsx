import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, MessageCircle, Pencil, Trash2, UserPlus } from "lucide-react";
import { ApiError, api } from "../../../data/api";
import { ConfirmIdentity } from "../../../pages/auth/ConfirmIdentity";
import { ApproveDialog, useApproveHere } from "../../jobs/ApproveHere";
import { useCave } from "../../shell/cave-context";
import { Button, Skeleton, cx } from "../../ui";
import { EmberMark } from "../../ember/EmberMark";

/**
 * Tinyauth's users in its panel (checklist 46.15): who can sign in, changing a password, adding,
 * renaming and removing a user. A password is typed here only after you confirm it is you; it goes
 * once to Hearth, which scrambles it and keeps it in memory for the plan (the plan only carries a
 * reference). Every change is a protected plan you approve: Tinyauth's users file is backed up,
 * Tinyauth restarts, and a new password is proved by signing in, or the old file is put back.
 */

interface View {
  source: "file" | "environment" | "none";
  users: { username: string; twoStep: boolean }[];
  editable: boolean;
  why?: string;
}
type Form =
  | { kind: "password"; username: string }
  | { kind: "add" }
  | { kind: "rename"; username: string }
  | undefined;

const input =
  "min-h-10 w-full rounded-lg border border-line bg-panel px-3 text-[0.84rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none";
const btn =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line-strong px-2.5 text-[0.76rem] text-ink hover:border-gold hover:text-gold disabled:opacity-50";

export function TinyauthUsersCard({ serviceId, name }: { serviceId: string; name: string }) {
  const q = useQuery({
    queryKey: ["dashboard", serviceId, "tinyauth-users"],
    queryFn: () =>
      api<View>("GET", `/api/services/${encodeURIComponent(serviceId)}/tinyauth/users`),
    retry: false,
  });
  const act = useApproveHere(serviceId, "From Tinyauth's panel.");
  const cave = useCave();
  const [form, setForm] = useState<Form>();
  const v = q.data;
  return (
    <div className="space-y-3 rounded-xl border border-line p-3" data-testid="ta-users">
      <ApproveDialog c={act} />
      <p className="flex items-center gap-2 text-[0.88rem] text-ink">
        <KeyRound strokeWidth={1.5} className="h-4 w-4 text-gold" /> Users and passwords
      </p>
      {q.isLoading ? (
        <Skeleton className="h-16" />
      ) : q.error || !v ? (
        <p className="text-[0.82rem] text-amber">
          {name}&apos;s users could not be read: {q.error?.message ?? "no answer"}
        </p>
      ) : !v.editable ? (
        <div className="space-y-2">
          <p className="text-[0.82rem] text-muted" data-testid="ta-users-why">
            {v.why}
          </p>
          <button
            type="button"
            className={btn}
            onClick={() =>
              cave.ask(
                `How do I manage ${name}'s users for my setup (${v.source === "environment" ? "users set in its environment" : "no users file"})? Explain it step by step. Never ask me for a password here.`,
              )
            }
          >
            <MessageCircle strokeWidth={1.5} className="h-3.5 w-3.5" /> Ask Ember how
            <EmberMark />
          </button>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-line text-[0.84rem]" data-testid="ta-user-list">
            {v.users.map((u) => (
              <li
                key={u.username}
                className="flex flex-wrap items-center gap-2 py-2"
                data-testid="ta-user"
              >
                <span className="min-w-0 flex-1 break-all text-ink">
                  {u.username}
                  {u.twoStep && (
                    <span className="ml-2 text-[0.74rem] text-live">sign-in code on</span>
                  )}
                </span>
                <button
                  type="button"
                  className={btn}
                  data-hearth-target="tinyauth:password"
                  onClick={() => setForm({ kind: "password", username: u.username })}
                >
                  <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5" /> Change password
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() => setForm({ kind: "rename", username: u.username })}
                >
                  <Pencil strokeWidth={1.5} className="h-3.5 w-3.5" /> Rename
                </button>
                {v.users.length > 1 && (
                  <button
                    type="button"
                    className={cx(btn, "hover:border-alert/60 hover:text-alert")}
                    disabled={act.pending}
                    onClick={() =>
                      void act.propose(
                        "tinyauth-users",
                        { op: "remove", username: u.username },
                        `Remove ${u.username} from ${name}`,
                      )
                    }
                  >
                    <Trash2 strokeWidth={1.5} className="h-3.5 w-3.5" /> Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
          {!form && (
            <button type="button" className={btn} onClick={() => setForm({ kind: "add" })}>
              <UserPlus strokeWidth={1.5} className="h-3.5 w-3.5" /> Add a user
            </button>
          )}
          {form && (
            <UserForm
              key={`${form.kind}-${"username" in form ? form.username : ""}`}
              serviceId={serviceId}
              name={name}
              form={form}
              taken={v.users.map((u) => u.username)}
              onPlan={(params, title) => {
                setForm(undefined);
                void act.propose("tinyauth-users", params, title);
              }}
              onCancel={() => setForm(undefined)}
            />
          )}
          {act.error && (
            <p role="alert" className="text-[0.8rem] text-amber">
              {act.error}
            </p>
          )}
          <p className="text-[0.74rem] text-faint">
            Each change is a plan you approve after confirming it&apos;s you. {name} restarts to
            read it (its sites wait a few seconds), a new password is checked by signing in, and the
            old users file is kept as a backup.
          </p>
        </>
      )}
    </div>
  );
}

function UserForm({
  serviceId,
  name,
  form,
  taken,
  onPlan,
  onCancel,
}: {
  serviceId: string;
  name: string;
  form: NonNullable<Form>;
  taken: string[];
  onPlan: (params: Record<string, string>, title: string) => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState("username" in form ? form.username : "");
  const [newName, setNewName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const needsPassword = form.kind === "password" || form.kind === "add";

  const submit = async () => {
    setError(undefined);
    if (form.kind === "rename") {
      if (!newName.trim()) return setError("Type the new username.");
      if (taken.includes(newName.trim())) return setError(`${name} already has that user.`);
      return onPlan(
        { op: "rename", username: form.username, newName: newName.trim() },
        `Rename ${form.username} in ${name}`,
      );
    }
    if (form.kind === "add" && taken.includes(username.trim()))
      return setError(`${name} already has a user "${username.trim()}".`);
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== repeat) return setError("The two passwords are not the same.");
    setBusy(true);
    try {
      const r = await api<{ ref: string }>(
        "POST",
        `/api/services/${encodeURIComponent(serviceId)}/tinyauth/users/password`,
        { username: username.trim(), password },
      );
      setPassword("");
      setRepeat("");
      onPlan(
        { op: form.kind, username: username.trim(), secretRef: r.ref },
        form.kind === "add"
          ? `Add ${username.trim()} to ${name}`
          : `Change ${username}'s password in ${name}`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setConfirming(true);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (confirming)
    return (
      <ConfirmIdentity
        reason={`Confirm it's you before typing a password for ${name}.`}
        onConfirmed={() => {
          setConfirming(false);
          void submit();
        }}
      />
    );
  return (
    <form
      className="space-y-3 rounded-lg border border-gold/40 p-3"
      data-testid="ta-user-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-[0.84rem] text-ink">
        {form.kind === "password"
          ? `New password for ${form.username}`
          : form.kind === "add"
            ? "Add a user"
            : `Rename ${form.username}`}
      </p>
      {form.kind === "add" && (
        <label className="block text-[0.8rem] text-muted">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            className={cx(input, "mt-1")}
            data-testid="ta-new-username"
          />
        </label>
      )}
      {form.kind === "rename" && (
        <label className="block text-[0.8rem] text-muted">
          New username
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoComplete="off"
            className={cx(input, "mt-1")}
            data-testid="ta-rename"
          />
        </label>
      )}
      {needsPassword && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[0.8rem] text-muted">
            New password
            <input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className={cx(input, "mt-1")}
              data-testid="ta-password"
              data-sensitive
            />
          </label>
          <label className="block text-[0.8rem] text-muted">
            Type it again
            <input
              type={show ? "text" : "password"}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
              className={cx(input, "mt-1")}
              data-testid="ta-password-repeat"
              data-sensitive
            />
          </label>
        </div>
      )}
      {needsPassword && (
        <button type="button" className={btn} onClick={() => setShow((s) => !s)}>
          {show ? (
            <EyeOff strokeWidth={1.5} className="h-3.5 w-3.5" />
          ) : (
            <Eye strokeWidth={1.5} className="h-3.5 w-3.5" />
          )}
          {show ? "Hide" : "Show"} what I typed
        </button>
      )}
      {error && (
        <p role="alert" className="text-[0.8rem] text-amber">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" type="submit" disabled={busy} data-testid="ta-user-plan">
          {busy ? "Checking…" : "Plan it"}
        </Button>
        <Button tone="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {needsPassword && (
        <p className="text-[0.74rem] text-faint">
          Hearth scrambles it at once and keeps it only until the plan runs: never stored, shown or
          given to Ember.
        </p>
      )}
    </form>
  );
}
