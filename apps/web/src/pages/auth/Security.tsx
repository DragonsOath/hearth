import { useState } from "react";
import { useNavigate } from "react-router";
import { Fingerprint } from "lucide-react";
import { Button, Section, Sheet, Tag } from "../../components/ui";
import { ApiError } from "../../data/api";
import {
  passkeysSupported,
  useAddPasskey,
  useAuthStatus,
  useChangePassword,
  useNewRecoveryKey,
  useDevices,
  useRemovePasskey,
  useSetCredentials,
  useSignOut,
  useSignOutDevice,
  type PasskeyInfo,
} from "../../data/auth";
import { ago } from "../../lib/format";
import { FormError, TextField } from "./AuthFrame";
import { ConfirmIdentity } from "./ConfirmIdentity";
import { RecoveryKeyPanel } from "./RecoveryKey";
import { defaultPasskeyName } from "./Setup";

function PasskeyRow({ passkey }: { passkey: PasskeyInfo }) {
  const remove = useRemovePasskey();
  const [confirming, setConfirming] = useState(false);
  const needsYou = remove.error instanceof ApiError && remove.error.status === 403;
  return (
    <li className="py-4" data-testid="passkey-row">
      <div className="flex flex-wrap items-center gap-3">
        <Fingerprint strokeWidth={1.25} className="h-5 w-5 text-gold" />
        <div className="min-w-0 flex-1">
          <p className="text-[0.92rem] text-ink">{passkey.name}</p>
          <p className="text-[0.78rem] text-faint">
            Added {ago(passkey.createdAt).toLowerCase()}
            {passkey.lastUsedAt ? ` · used ${ago(passkey.lastUsedAt).toLowerCase()}` : ""}
          </p>
        </div>
        <Tag tone={passkey.unlocksVault ? "gold" : "neutral"}>
          {passkey.unlocksVault ? "Signs in and unlocks" : "Signs in"}
        </Tag>
        {confirming ? (
          <Button
            tone="quiet"
            className="text-bad hover:text-bad"
            onClick={() => remove.mutate(passkey.id)}
          >
            Remove for good
          </Button>
        ) : (
          <Button tone="quiet" onClick={() => setConfirming(true)}>
            Remove
          </Button>
        )}
      </div>
      {needsYou && (
        <div className="mt-3">
          <ConfirmIdentity
            reason="Confirm it is you to remove this passkey."
            onConfirmed={() => remove.mutate(passkey.id)}
          />
        </div>
      )}
    </li>
  );
}

function Passkeys({ passkeys }: { passkeys: PasskeyInfo[] }) {
  const add = useAddPasskey();
  const needsYou = add.error instanceof ApiError && add.error.status === 403;
  return (
    <div className="py-5">
      <p className="text-[0.95rem] text-ink">Passkeys</p>
      <p className="mb-3 text-[0.8rem] leading-relaxed text-faint">
        Fingerprint, face, or Windows Hello on each device you use. Where the device supports it, a
        passkey also unlocks protected secrets.
      </p>
      {passkeys.length > 0 && (
        <ul className="divide-y divide-line">
          {passkeys.map((p) => (
            <PasskeyRow key={p.id} passkey={p} />
          ))}
        </ul>
      )}
      {passkeysSupported() ? (
        <Button
          className="mt-3"
          onClick={() => add.mutate(defaultPasskeyName())}
          disabled={add.isPending}
        >
          <Fingerprint strokeWidth={1.25} className="h-4 w-4" />
          {add.isPending ? "Waiting for your device" : "Add a passkey on this device"}
        </Button>
      ) : (
        <p className="mt-3 text-[0.8rem] text-faint">
          Passkeys need a secure connection (https), such as your Tailscale address.
        </p>
      )}
      {add.data && (
        <p role="status" className="mt-3 text-[0.82rem] text-muted">
          Passkey added.{" "}
          {add.data.unlocksVault
            ? "It can also unlock protected secrets."
            : "It signs you in; this device cannot use it to unlock protected secrets."}
        </p>
      )}
      {needsYou ? (
        <div className="mt-3">
          <ConfirmIdentity
            reason="Confirm your password to add a passkey."
            canUsePasskey={false}
            onConfirmed={() => add.mutate(defaultPasskeyName())}
          />
        </div>
      ) : (
        <FormError error={add.error} />
      )}
    </div>
  );
}

function ChangePassword() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  return (
    <form
      className="py-5"
      onSubmit={(e) => {
        e.preventDefault();
        change.mutate(
          { current, next },
          {
            onSuccess: () => {
              setCurrent("");
              setNext("");
            },
          },
        );
      }}
    >
      <p className="mb-3 text-[0.95rem] text-ink">Password</p>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <TextField
          id="current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <TextField
          id="next-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={change.isPending}>
        {change.isPending ? "Changing" : "Change password"}
      </Button>
      {change.isSuccess && (
        <p role="status" className="mt-3 text-[0.82rem] text-muted">
          Password changed.
        </p>
      )}
      <FormError error={change.error} />
    </form>
  );
}

/**
 * A sign-in name and a new password without the old one: your passkey confirms it is you and
 * unlocks the vault key, which the new password then protects (nothing in the vault is lost).
 */
function SetCredentials() {
  const { data } = useAuthStatus();
  const save = useSetCredentials();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [open, setOpen] = useState(false);
  // The server only reports an unlock time while the vault key is unlocked in this session.
  const unlocked = Boolean(data?.recentlyVerified) && Boolean(data?.vaultUnlockedUntil);
  return (
    <div className="py-5" data-testid="set-credentials">
      <p className="text-[0.95rem] text-ink">Sign-in name and new password</p>
      <p className="mb-3 text-[0.8rem] leading-relaxed text-faint">
        For signing in from another device without your old password: confirm with your passkey,
        then choose them. With a name set, the password sign-in asks for both.
      </p>
      {!open ? (
        <Button onClick={() => setOpen(true)}>Set name and password</Button>
      ) : !unlocked ? (
        <ConfirmIdentity reason="Confirm it is you with your passkey first. It unlocks the vault key your new password will protect." />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              { username, password },
              {
                onSuccess: () => {
                  setPassword("");
                  setOpen(false);
                },
              },
            );
          }}
        >
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField
              id="set-username"
              label="Name"
              autoComplete="username"
              autoCapitalize="none"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <TextField
              id="set-password"
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="At least 12 characters."
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button type="submit" tone="primary" disabled={save.isPending}>
            {save.isPending ? "Saving" : "Save name and password"}
          </Button>
        </form>
      )}
      {save.isSuccess && (
        <p role="status" className="mt-3 text-[0.82rem] text-muted">
          Saved. Sign in with the name and the new password from now on.
        </p>
      )}
      <FormError error={save.error} />
    </div>
  );
}

/** Every signed-in device, recognisable, each with its own sign-out. */
export function Devices() {
  const q = useDevices();
  const out = useSignOutDevice();
  const devices = q.data?.devices ?? [];
  return (
    <div className="py-5" data-testid="devices">
      <p className="text-[0.95rem] text-ink">Signed-in devices</p>
      <p className="mb-3 text-[0.8rem] leading-relaxed text-faint">
        Remembered devices stay signed in for 90 days while used; the others end after 12 hours.
        Sign out anything you do not recognise.
      </p>
      <ul className="divide-y divide-line">
        {devices.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[0.86rem]"
          >
            <span className="min-w-0 flex-1">
              <span className="text-ink">{d.device}</span>
              {d.current && (
                <span className="ml-2 inline-block">
                  <Tag tone="gold">This device</Tag>
                </span>
              )}
              <span className="block text-[0.76rem] text-faint">
                {d.viaInternet ? "From the internet" : "Home network or Tailscale"} · signed in{" "}
                {ago(d.signedInAt).toLowerCase()} with{" "}
                {d.method === "passkey"
                  ? "a passkey"
                  : d.method === "password"
                    ? "the password"
                    : d.method === "paired"
                      ? "a code from Add a device"
                      : d.method}
                {" · "}
                {d.remembered ? "remembered" : "not remembered"} · last used{" "}
                {ago(d.lastSeenAt).toLowerCase()}
              </span>
            </span>
            {!d.current && (
              <Button tone="quiet" disabled={out.isPending} onClick={() => out.mutate(d.id)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <FormError error={out.error ?? q.error} />
    </div>
  );
}

function RecoveryKeySection() {
  const replace = useNewRecoveryKey();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  return (
    <div className="py-5">
      <p className="text-[0.95rem] text-ink">Recovery key</p>
      <p className="mb-3 text-[0.8rem] leading-relaxed text-faint">
        Lost it, or think someone saw it? Make a new one. The old key stops working at once.
      </p>
      {asking ? (
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            replace.mutate(password, { onSuccess: () => setPassword("") });
          }}
        >
          <label htmlFor="recovery-confirm" className="sr-only">
            Password
          </label>
          <input
            id="recovery-confirm"
            type="password"
            placeholder="Your password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-h-11 flex-1 rounded-lg border border-line-strong bg-panel px-3 text-[0.9rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
            required
          />
          <Button type="submit" disabled={replace.isPending}>
            Make a new recovery key
          </Button>
        </form>
      ) : (
        <Button onClick={() => setAsking(true)}>Replace recovery key</Button>
      )}
      <FormError error={replace.error} />
      {replace.data && (
        <Sheet
          label="New recovery key"
          eyebrow="Recovery key"
          title="Your new recovery key"
          onClose={() => {
            replace.reset();
            setAsking(false);
          }}
        >
          <RecoveryKeyPanel
            recoveryKey={replace.data.recoveryKey}
            doneLabel="Done"
            onDone={() => {
              replace.reset();
              setAsking(false);
            }}
          />
        </Sheet>
      )}
    </div>
  );
}

export function SecuritySettings() {
  const { data } = useAuthStatus();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const out = (everywhere: boolean) =>
    signOut.mutate(everywhere, { onSettled: () => navigate("/login", { replace: true }) });
  return (
    <Section title="Security">
      <div className="divide-y divide-line">
        <Passkeys passkeys={data?.passkeys ?? []} />
        <SetCredentials />
        <ChangePassword />
        <RecoveryKeySection />
        <Devices />
        <div className="flex flex-wrap gap-3 py-5">
          <Button onClick={() => out(false)}>Sign out</Button>
          <Button tone="quiet" onClick={() => out(true)}>
            Sign out on every device
          </Button>
        </div>
      </div>
    </Section>
  );
}
