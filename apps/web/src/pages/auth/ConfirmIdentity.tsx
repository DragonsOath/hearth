import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { Button } from "../../components/ui";
import { passkeysSupported, usePasskeyLogin, usePasswordLogin } from "../../data/auth";
import { FormError } from "./AuthFrame";

/**
 * "Confirm it is you" inside the app: before sensitive steps, and to
 * unlock protected secrets. A passkey works when it can unlock the vault;
 * the password always does.
 */
export function ConfirmIdentity({
  reason,
  onConfirmed,
  canUsePasskey = true,
}: {
  reason: string;
  onConfirmed?: () => void;
  canUsePasskey?: boolean;
}) {
  const [password, setPassword] = useState("");
  const login = usePasswordLogin();
  const passkey = usePasskeyLogin();
  return (
    <div className="rounded-xl border border-gold/30 bg-bg/60 p-5">
      <p className="mb-4 text-[0.88rem] leading-relaxed text-muted">{reason}</p>
      <form
        className="flex flex-col gap-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate(password, {
            onSuccess: () => {
              setPassword("");
              onConfirmed?.();
            },
          });
        }}
      >
        <label htmlFor="confirm-identity" className="sr-only">
          Password
        </label>
        <input
          id="confirm-identity"
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="min-h-11 flex-1 rounded-lg border border-line-strong bg-panel px-3 text-[0.9rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
          required
        />
        <Button type="submit" tone="primary" disabled={login.isPending}>
          {login.isPending ? "Checking" : "Confirm"}
        </Button>
      </form>
      {canUsePasskey && passkeysSupported() && (
        <Button
          tone="quiet"
          className="mt-2"
          disabled={passkey.isPending}
          onClick={() => passkey.mutate(undefined, { onSuccess: () => onConfirmed?.() })}
        >
          <Fingerprint strokeWidth={1.25} className="h-4 w-4" />
          Use a passkey instead
        </Button>
      )}
      <FormError error={login.error ?? passkey.error} />
    </div>
  );
}
