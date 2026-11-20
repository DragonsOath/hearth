import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Check, Fingerprint } from "lucide-react";
import { Button } from "../../components/ui";
import {
  passkeysSupported,
  useAuthStatus,
  usePasskeyLogin,
  usePasswordLogin,
  useRecover,
} from "../../data/auth";
import { AuthFrame, FormError, TextField } from "./AuthFrame";

/** "Remember this device": in the gold-and-black style, a real checkbox underneath. */
function RememberDevice({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="mb-6 flex min-h-11 cursor-pointer items-start gap-3 text-[0.88rem] text-ink select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
        data-testid="remember-device"
      />
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-gold/60 bg-bg transition-colors peer-checked:bg-gold/90 peer-focus-visible:ring-2 peer-focus-visible:ring-gold/60"
      >
        {checked && <Check strokeWidth={2.5} className="h-3.5 w-3.5 text-bg" />}
      </span>
      <span>
        Remember this device
        <span className="block text-[0.78rem] text-faint">
          {checked
            ? "Stays signed in for 90 days while you use it. Sign it out any time in Settings."
            : "Signed out after 12 hours or when the browser closes. For borrowed devices."}
        </span>
      </span>
    </label>
  );
}

export function LoginPage() {
  const status = useAuthStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const passkey = usePasskeyLogin();
  const login = usePasswordLogin();
  const recover = useRecover();
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  // Remembered by default: a phone you sign in on once stays signed in.
  const [remember, setRemember] = useState(true);
  const [mode, setMode] = useState<"sign-in" | "recover">("sign-in");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");

  if (status.data && !status.data.claimed) return <Navigate to="/setup" replace />;
  if (status.data?.signedIn) return <Navigate to={from} replace />;
  const go = () => navigate(from, { replace: true });

  if (mode === "recover") {
    return (
      <AuthFrame eyebrow="Recovery" title="Use your recovery key">
        <p className="mb-6 text-[0.9rem] leading-relaxed text-muted">
          Enter the recovery key you saved when you set up Hearth, and choose a new password. Your
          secrets stay intact.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            recover.mutate({ recoveryKey, newPassword }, { onSuccess: go });
          }}
        >
          <TextField
            id="recovery-key"
            label="Recovery key"
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <TextField
            id="recover-password"
            label="New password"
            type="password"
            hint="At least 12 characters."
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
          <Button tone="primary" type="submit" className="w-full" disabled={recover.isPending}>
            {recover.isPending ? "Checking" : "Reset password and sign in"}
          </Button>
          <FormError error={recover.error} />
        </form>
        <Button tone="quiet" className="mt-4 w-full" onClick={() => setMode("sign-in")}>
          Back to sign in
        </Button>
      </AuthFrame>
    );
  }

  // This PC belongs to another Hearth: everything is used from there.
  const joined = status.data?.joinedTo;
  if (joined) {
    return (
      <AuthFrame eyebrow="Hearth" title={`This PC is part of ${joined.name}`}>
        <p className="mb-6 text-[0.9rem] leading-relaxed text-muted">
          Its projects and systems are in your Hearth. Sign in there, from any device.
          {joined.online ? "" : " (It can't reach your Hearth right now.)"}
        </p>
        <a
          href={hubHref(joined)}
          className="flex min-h-11 w-full items-center justify-center rounded-lg bg-gold px-4 text-[0.9rem] text-bg hover:bg-gold-bright"
          data-testid="open-hub"
        >
          Open your Hearth
        </a>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame eyebrow="Hearth" title="Welcome back">
      {passkeysSupported() && (
        <>
          <Button
            tone="primary"
            className="w-full"
            disabled={passkey.isPending}
            onClick={() => passkey.mutate(remember, { onSuccess: go })}
          >
            <Fingerprint strokeWidth={1.25} className="h-5 w-5" />
            {passkey.isPending ? "Waiting for your device" : "Sign in with a passkey"}
          </Button>
          <FormError error={passkey.error} />
          <div className="my-7 flex items-center gap-4 text-[0.75rem] text-faint">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate(
            { password, remember, ...(status.data?.usernameRequired ? { username } : {}) },
            { onSuccess: go },
          );
        }}
      >
        {status.data?.usernameRequired && (
          <TextField
            id="username"
            label="Name"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        )}
        <TextField
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <RememberDevice checked={remember} onChange={setRemember} />
        <Button
          tone={passkeysSupported() ? "outline" : "primary"}
          type="submit"
          className="w-full"
          disabled={login.isPending}
        >
          {login.isPending ? "Signing in" : "Sign in with password"}
        </Button>
        <FormError error={login.error} />
      </form>
      <Button tone="quiet" className="mt-4 w-full" onClick={() => setMode("recover")}>
        Forgot your password?
      </Button>
    </AuthFrame>
  );
}

/** Your Hearth's address, saying which PC this is (the window then names this PC). */
function hubHref(j: { url: string; pcId?: string }) {
  return j.pcId ? `${j.url.replace(/\/$/, "")}/?from=${encodeURIComponent(j.pcId)}` : j.url;
}
