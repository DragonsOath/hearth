import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

/**
 * Sign-in, passkeys, and the vault. Passkeys use the WebAuthn PRF
 * extension where the device supports it, so a fingerprint can also unlock
 * protected secrets; elsewhere a passkey signs you in and the password
 * unlocks.
 */

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  unlocksVault: boolean;
}

export interface AuthStatus {
  claimed: boolean;
  signedIn: boolean;
  /** "home": a paired home tablet, which opens the home dashboard only. */
  method?: "password" | "passkey" | "recovery" | "setup" | "paired" | "home";
  recentlyVerified?: boolean;
  vaultUnlockedUntil?: string;
  passkeys?: PasskeyInfo[];
  /** The password sign-in also asks for the sign-in name. */
  usernameRequired?: boolean;
  /** This page came in through the public address (internet), not home or Tailscale. */
  viaInternet?: boolean;
  /** This PC belongs to another Hearth (docs/design/ONE_ACCOUNT.md): use that one. */
  joinedTo?: { name: string; url: string; online: boolean; pcId?: string } | null;
}

export interface SignedInDevice {
  id: string;
  method: "password" | "passkey" | "recovery" | "setup" | "paired" | "home";
  device: string;
  signedInAt: string;
  lastSeenAt: string;
  expiresAt: string;
  remembered: boolean;
  viaInternet: boolean;
  current: boolean;
}

export type SecretTier = "automation" | "protected";
export type SecretKind =
  | "api-key"
  | "password"
  | "token"
  | "login"
  | "ssh-key"
  | "database"
  | "recovery"
  | "certificate"
  | "oauth-app"
  | "session"
  | "other";

export interface SecretSummary {
  /** Hearth may sign Ember's Browser in to this credential's app with it (you switch it on). */
  browserSignIn?: boolean;
  id: string;
  name: string;
  kind: SecretKind;
  tier: SecretTier;
  serviceId?: string;
  category?: string;
  username?: string;
  endpoint?: string;
  notes?: string;
  tags: string[];
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  /** What Hearth may use it for (Diagnostics only, or also changes you approve). */
  scope?: "read" | "approved-changes";
}

/** What describes a credential without being it. */
export interface SecretDetails {
  category?: string | null;
  username?: string | null;
  endpoint?: string | null;
  notes?: string | null;
  tags?: string[];
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && window.isSecureContext;
}

/* ---------- base64url <-> bytes for the PRF extension ---------- */

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64url(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type WithPrf = { extensions?: { prf?: { eval?: { first: unknown } } } };

/** The server sends the PRF salt as text; authenticators need bytes. */
function prfToBytes<T extends WithPrf>(options: T): T {
  const first = options.extensions?.prf?.eval?.first;
  if (typeof first === "string") options.extensions!.prf!.eval!.first = fromB64url(first);
  return options;
}

/** Takes the PRF secret out of the response (it is sent separately, as text). */
function takePrf(response: { clientExtensionResults: unknown }): string | undefined {
  const ext = response.clientExtensionResults as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };
  const first = ext.prf?.results?.first;
  if (ext.prf) delete ext.prf.results;
  return first ? toB64url(first) : undefined;
}

function prfEnabled(response: { clientExtensionResults: unknown }): boolean {
  return Boolean((response.clientExtensionResults as { prf?: { enabled?: boolean } }).prf?.enabled);
}

async function passkeyAssertion(credentialId?: string, remember?: boolean) {
  const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "POST",
    "/api/auth/passkey/options",
    credentialId ? { credentialId } : {},
  );
  const response = await startAuthentication({ optionsJSON: prfToBytes(options as never) });
  const prf = takePrf(response);
  return api<{ unlocked: boolean }>("POST", "/api/auth/passkey/verify", {
    response,
    prf,
    ...(remember !== undefined ? { remember } : {}),
  });
}

/* ---------- Hooks ---------- */

export function useAuthStatus() {
  return useQuery({
    queryKey: ["auth"],
    queryFn: () => api<AuthStatus>("GET", "/api/auth/status"),
    retry: false,
    staleTime: 30_000,
  });
}

function useAuthWrite<V, R = unknown>(fn: (vars: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      for (const key of ["auth", "vault", "audit"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export const useSetup = () =>
  useAuthWrite((body: { code: string; password: string }) =>
    api<{ recoveryKey: string }>("POST", "/api/auth/setup", body),
  );

/** Signs in, or (when already signed in) confirms it is you and unlocks the vault. */
export const usePasswordLogin = () =>
  useAuthWrite((input: string | { password: string; username?: string; remember?: boolean }) =>
    api("POST", "/api/auth/login", typeof input === "string" ? { password: input } : input),
  );

export const usePasskeyLogin = () =>
  useAuthWrite((remember?: boolean) => passkeyAssertion(undefined, remember));

/** A new password and sign-in name, after confirming it is you (no old password needed). */
export const useSetCredentials = () =>
  useAuthWrite((body: { username?: string; password: string }) =>
    api("POST", "/api/auth/credentials", body),
  );

export function useDevices() {
  return useQuery({
    queryKey: ["auth", "devices"],
    queryFn: () => api<{ devices: SignedInDevice[] }>("GET", "/api/auth/devices"),
  });
}

export const useSignOutDevice = () =>
  useAuthWrite((id: string) => api("DELETE", `/api/auth/devices/${encodeURIComponent(id)}`));

/** Add a device: the one-time code from its QR signs it in. */
export const usePair = () =>
  useAuthWrite((code: string) => api("POST", "/api/auth/pair", { code }));

/** Joins this PC to a Hearth you already have (from its setup page). */
export const useJoinHub = () =>
  useAuthWrite((body: { link: string; setupCode?: string; name?: string; icon?: string }) =>
    api<{ hubName: string; hubUrl: string }>("POST", "/api/pcs/join-hub", body),
  );

export const useRecover = () =>
  useAuthWrite((body: { recoveryKey: string; newPassword: string }) =>
    api("POST", "/api/auth/recover", body),
  );

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (everywhere: boolean) =>
      api("POST", everywhere ? "/api/auth/logout-all" : "/api/auth/logout", {}),
    onSettled: () => queryClient.clear(),
  });
}

export const useChangePassword = () =>
  useAuthWrite((body: { current: string; next: string }) =>
    api("POST", "/api/auth/password", body),
  );

export const useNewRecoveryKey = () =>
  useAuthWrite((password: string) =>
    api<{ recoveryKey: string }>("POST", "/api/auth/recovery-key", { password }),
  );

/**
 * Registers a passkey on this device. If the device supports PRF but did
 * not return it at creation, a second touch teaches the passkey to unlock
 * the vault.
 */
export const useAddPasskey = () =>
  useAuthWrite(async (name: string) => {
    const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
      "POST",
      "/api/auth/passkeys/options",
      {},
    );
    const response = await startRegistration({ optionsJSON: prfToBytes(options as never) });
    const prf = takePrf(response);
    const enabled = prfEnabled(response);
    const added = await api<{ id: string; unlocksVault: boolean }>("POST", "/api/auth/passkeys", {
      response,
      name,
      prf,
    });
    if (!added.unlocksVault && enabled) {
      const second = await passkeyAssertion(added.id);
      return { ...added, unlocksVault: second.unlocked };
    }
    return added;
  });

export const useRenamePasskey = () =>
  useAuthWrite(({ id, name }: { id: string; name: string }) =>
    api("PATCH", `/api/auth/passkeys/${encodeURIComponent(id)}`, { name }),
  );

export const useRemovePasskey = () =>
  useAuthWrite((id: string) => api("DELETE", `/api/auth/passkeys/${encodeURIComponent(id)}`));

/* ---------- Vault ---------- */

export function useVault() {
  return useQuery({
    queryKey: ["vault"],
    queryFn: () =>
      api<{
        /** True until you unlock: then nothing but a count is sent. */
        locked: boolean;
        count?: number;
        secrets: SecretSummary[];
        unlockedUntil?: string;
        recentlyVerified: boolean;
      }>("GET", "/api/vault"),
    retry: false,
  });
}

export const useAddSecret = () =>
  useAuthWrite(
    (
      body: {
        name: string;
        kind: SecretKind;
        tier: SecretTier;
        serviceId?: string;
        value: string;
      } & SecretDetails,
    ) =>
      api<SecretSummary & { linked?: { name: string; added: boolean } }>(
        "POST",
        "/api/vault/secrets",
        body,
      ),
  );

export const useUpdateSecret = () =>
  useAuthWrite(
    ({
      id,
      ...patch
    }: {
      id: string;
      name?: string;
      serviceId?: string | null;
      value?: string;
      browserSignIn?: boolean;
    } & SecretDetails) =>
      api("PATCH", `/api/vault/secrets/${encodeURIComponent(id)}`, patch),
  );

export const useMarkVerified = () =>
  useAuthWrite((id: string) =>
    api("POST", `/api/vault/secrets/${encodeURIComponent(id)}/verified`, {}),
  );

export const useRemoveSecret = () =>
  useAuthWrite((id: string) => api("DELETE", `/api/vault/secrets/${encodeURIComponent(id)}`));

export const useRevealSecret = () =>
  useMutation({
    mutationFn: (id: string) =>
      api<{ value: string }>("POST", `/api/vault/secrets/${encodeURIComponent(id)}/reveal`, {}),
  });

export const useLockVault = () => useAuthWrite(() => api("POST", "/api/vault/lock", {}));
