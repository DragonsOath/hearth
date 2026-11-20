import { useState } from "react";
import type { BuildApp } from "@dragon-control/core";
import { usePlanAccounts, useSavePlanAccounts } from "../../data/plan";
import { Button, Tag, cx } from "../ui";
import { FormError } from "../../pages/auth/AuthFrame";

/**
 * After "Next: your apps and accounts": the apps the plan picked, each with its logo, what it does, and why
 * it was picked, then the account details they will be set up with. A password the owner chooses
 * goes straight into Secure Vault: the AI never sees it, and it is never shown back here.
 */

/** Apps with a logo in public/logos; the rest get their initial. */
const LOGOS = new Set([
  "jellyfin",
  "plex",
  "seerr",
  "radarr",
  "sonarr",
  "prowlarr",
  "qbittorrent",
  "audiobookshelf",
  "kavita",
  "immich",
  "home-assistant",
]);

const field =
  "mt-1 min-h-11 w-full rounded-lg border border-line-strong bg-bg px-3 text-[0.9rem] text-ink";

function Logo({ app }: { app: BuildApp }) {
  return (
    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-line-strong bg-bg shadow-[0_0_24px_-8px_var(--color-gold)]">
      {LOGOS.has(app.id) ? (
        <img src={`/logos/${app.id}.svg`} alt="" width={36} height={36} className="h-9 w-9" />
      ) : (
        <span className="font-display text-[1.4rem] text-gold" aria-hidden>
          {app.name.charAt(0)}
        </span>
      )}
    </span>
  );
}

const PASSWORD_CHOICES = [
  [
    "generate",
    "Make a strong, different one for each app (recommended)",
    "Safest: if one app is ever exposed, the others stay safe. You can see any of them in Secure Vault.",
  ],
  [
    "own",
    "Use one password I choose for all of them",
    "Easier to remember, but one leak opens every app.",
  ],
] as const;

export function YourHomelab({ apps, aiName }: { apps: BuildApp[]; aiName: string }) {
  const saved = usePlanAccounts();
  const save = useSavePlanAccounts();
  const [email, setEmail] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [mode, setMode] = useState<"generate" | "own" | null>(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const current = saved.data;
  const e = email ?? current?.email ?? "";
  const u = username ?? current?.username ?? "";
  const m = mode ?? current?.passwords ?? "generate";
  const mismatch = m === "own" && again.length > 0 && password !== again;
  // A password already in the vault can stay; a new one must be typed twice.
  const keepsSaved = m === "own" && current?.passwords === "own" && !password;
  const ready =
    Boolean(e && u) &&
    (m === "generate" || keepsSaved || (password.length >= 12 && password === again));

  return (
    <div data-testid="your-homelab">
      <p className="mb-5 text-[0.95rem] leading-relaxed text-ink">
        Here&apos;s what {aiName} picked for you, each one chosen for what you told it and what this
        computer can do. Building it for you isn&apos;t ready yet: for now, your plan and account
        details are kept ready for when it is.
      </p>
      <ul className="mb-8 grid gap-3 sm:grid-cols-2">
        {apps.map((a) => (
          <li
            key={a.id}
            className="flex gap-3 rounded-2xl border border-line bg-bg/40 p-4"
            data-testid={`homelab-app-${a.id}`}
          >
            <Logo app={a} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[1.02rem] text-ink">{a.name}</h3>
                {a.installed && <Tag tone="gold">Already here</Tag>}
              </div>
              <p className="mt-1 text-[0.84rem] leading-relaxed text-muted">{a.what}</p>
              <p className="mt-1.5 text-[0.82rem] leading-relaxed text-ink">
                <span className="text-faint">Why {aiName} picked it: </span>
                {a.why}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <form
        className="rounded-2xl border border-line-strong p-5"
        aria-label="Your app accounts"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!ready) return;
          save.mutate(
            {
              email: e,
              username: u,
              passwords: m,
              ...(m === "own" && password ? { password } : {}),
            },
            {
              onSuccess: () => {
                setPassword("");
                setAgain("");
                setDone(true);
              },
            },
          );
        }}
      >
        <h3 className="mb-1 text-[1.05rem] text-ink">Your accounts</h3>
        <p className="mb-4 text-[0.84rem] leading-relaxed text-muted">
          Each app needs an account. Tell {aiName} which email and username to use, and how to
          handle passwords. Passwords go straight into Secure Vault, encrypted on this computer.{" "}
          {aiName} never sees them, and they never appear in chat or logs.
        </p>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-[0.82rem] text-muted">
            Email
            <input
              type="email"
              autoComplete="email"
              value={e}
              onChange={(x) => setEmail(x.target.value)}
              className={field}
            />
          </label>
          <label className="block text-[0.82rem] text-muted">
            Username
            <input
              autoComplete="username"
              value={u}
              onChange={(x) => setUsername(x.target.value)}
              className={field}
            />
          </label>
        </div>
        <fieldset className="mb-4">
          <legend className="mb-2 text-[0.9rem] text-ink">Passwords</legend>
          {PASSWORD_CHOICES.map(([id, label, why]) => (
            <label
              key={id}
              className={cx(
                "mb-2 flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2",
                m === id ? "border-gold bg-gold/10" : "border-line",
              )}
            >
              <input
                type="radio"
                name="plan-passwords"
                checked={m === id}
                onChange={() => setMode(id)}
                className="mt-1 h-4 w-4 accent-[var(--color-gold)]"
              />
              <span className="text-[0.86rem] leading-relaxed">
                <span className="text-ink">{label}</span>
                <span className="block text-faint">{why}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {m === "own" && (
          <div className="mb-4 grid gap-3 sm:grid-cols-2">
            <label className="block text-[0.82rem] text-muted">
              Password
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(x) => setPassword(x.target.value)}
                placeholder={current?.passwords === "own" ? "Saved in Secure Vault" : ""}
                className={field}
              />
            </label>
            <label className="block text-[0.82rem] text-muted">
              Password again
              <input
                type="password"
                autoComplete="new-password"
                value={again}
                onChange={(x) => setAgain(x.target.value)}
                aria-invalid={mismatch}
                className={field}
              />
            </label>
            <p className="text-[0.78rem] text-faint sm:col-span-2">
              {mismatch ? "The two passwords don't match." : "At least 12 characters."}
            </p>
          </div>
        )}
        <Button tone="primary" type="submit" disabled={!ready || save.isPending}>
          {save.isPending ? "Saving…" : "Save my account details"}
        </Button>
        <FormError error={save.error} />
        {done && (
          <p
            role="status"
            className="mt-4 rounded-lg border border-gold/40 bg-gold/5 px-3 py-2 text-[0.86rem] leading-relaxed text-ink"
            data-testid="accounts-saved"
          >
            Saved.{" "}
            {m === "own"
              ? "Your password is in Secure Vault."
              : "A strong password for each app will be made and saved in Secure Vault as it's set up."}{" "}
            When building arrives, Hearth will create each account with these details and save every
            login and API key in Secure Vault, asking you first. Building itself isn&apos;t ready
            yet, so nothing has been installed or created.
          </p>
        )}
      </form>
    </div>
  );
}
