import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, LogIn } from "lucide-react";
import type { Service } from "@dragon-control/core";
import { api } from "../../data/api";
import { ago } from "../../lib/format";

type Way = "login" | "plex-pin";

/** A saved sign-in's state (server: credentials/app-session.ts). Never a session itself. */
interface SignInStatus {
  how?: Way;
  /** Every way the app offers (Tasterr: Plex and its own login). */
  ways?: Way[];
  signedIn: boolean;
  signedInAt?: string;
  waiting?: { attempt: string; url: string; since: string };
  problem?: string;
  needsLogin?: boolean;
  login?: { id: string; username: string };
}

export function useSignIn(serviceId: string) {
  return useQuery({
    queryKey: ["sign-in", serviceId],
    queryFn: () => api<SignInStatus>("GET", `/api/services/${serviceId}/sign-in`),
    // While the owner is on plex.tv, look every two seconds for the session.
    refetchInterval: (q) => (q.state.data?.waiting ? 2000 : false),
    retry: false,
  });
}

const primary =
  "inline-flex min-h-11 items-center gap-2 rounded-xl bg-gold px-4 text-[0.88rem] font-semibold text-[#1a0d05] disabled:opacity-60";
const field =
  "min-h-11 rounded-lg border border-line bg-panel px-3 text-[0.88rem] text-ink focus:border-gold/60 focus:outline-none";

/**
 * Sign in (11-11, saved sign-ins): for an app with no API key, Hearth signs in itself and keeps
 * the session in the Secure Vault. It shows every way the app offers (11-13, the owner signs in to
 * Tasterr with Plex and has no Tasterr password): Sign in with Plex opens plex.tv's own Allow page;
 * the user name and password are for a local account, and go straight into the Secure Vault.
 */
export function SignInCard({ service }: { service: Pick<Service, "id" | "name"> }) {
  const q = useSignIn(service.id);
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const start = useMutation({
    mutationFn: (how: Way) =>
      api<SignInStatus>("POST", `/api/services/${service.id}/sign-in`, { how }),
  });
  const [user, setUser] = useState<string>();
  const [pass, setPass] = useState("");
  const [showLogin, setShowLogin] = useState(false);
  // The app's own login, saved in the Secure Vault for this app (never shown again), then used.
  // A login already there (one the app refused) is replaced, not saved twice.
  const saveLogin = useMutation({
    mutationFn: async (v: { username: string; password: string; existing?: string }) => {
      if (v.existing)
        await api("PATCH", `/api/vault/secrets/${encodeURIComponent(v.existing)}`, {
          value: v.password,
          username: v.username,
        });
      else
        await api("POST", "/api/vault/secrets", {
          name: `${service.name} login`,
          kind: "login",
          tier: "automation",
          serviceId: service.id,
          value: v.password,
          username: v.username,
          scope: "read",
        });
      return api<SignInStatus>("POST", `/api/services/${service.id}/sign-in`, { how: "login" });
    },
  });
  const s = q.data;
  const signedIn = Boolean(s?.signedIn);
  // Signed in (after Allow on plex.tv too): the panel reads again with the new session.
  useEffect(() => {
    if (!signedIn) return;
    void qc.invalidateQueries({ queryKey: ["dashboard", service.id] });
    void qc.invalidateQueries({ queryKey: ["custom-panel", service.id] });
  }, [signedIn, qc, service.id]);
  const ways: Way[] = s?.ways ?? (s?.how ? [s.how] : []);
  if (!s || !ways.length) return null;

  if (s.signedIn)
    return (
      <p className="flex items-center gap-2 text-[0.78rem] text-faint" data-testid="sign-in-saved">
        <KeyRound className="h-3.5 w-3.5 text-live" aria-hidden />
        Hearth is signed in to {service.name}
        {s.signedInAt ? ` (since ${ago(s.signedInAt)})` : ""}
        {s.how === "plex-pin" ? " with Plex" : ""}. The sign-in is saved in the Secure Vault.
      </p>
    );

  const plex = ways.includes("plex-pin");
  const local = ways.includes("login");
  const done = (r: SignInStatus) => {
    qc.setQueryData(["sign-in", service.id], r);
    void qc.invalidateQueries({ queryKey: ["dashboard", service.id] });
    void qc.invalidateQueries({ queryKey: ["custom-panel", service.id] });
  };

  const press = (how: Way) => {
    setError(undefined);
    // A Plex PIN opens plex.tv in a new tab: opened now, while it is still the press, so the
    // browser does not block it, and pointed at plex.tv once Hearth has the address.
    const tab = how === "plex-pin" ? window.open("about:blank", "_blank") : null;
    start.mutate(how, {
      onSuccess: (r) => {
        if (tab && r.waiting) tab.location.href = r.waiting.url;
        else tab?.close();
        done(r);
      },
      onError: (e) => {
        tab?.close();
        setError(e instanceof Error ? e.message : String(e));
      },
    });
  };

  // The login boxes: straight away when it is the only way and none is saved, or when asked.
  const loginOpen = local && (showLogin || Boolean(error && !plex) || (!plex && s.needsLogin));

  return (
    <div
      className="space-y-3 rounded-xl border border-gold/50 bg-gold/5 p-3.5"
      data-testid="sign-in-card"
    >
      <p className="flex items-center gap-2 text-[0.95rem] font-semibold text-ink">
        <LogIn className="h-4 w-4 text-gold" aria-hidden />
        Sign Hearth in to {service.name}
      </p>
      <p className="text-[0.82rem] text-muted" data-testid="sign-in-why">
        {service.name} has no API key, so Hearth signs in like a browser would and keeps the session
        in the Secure Vault. Only Hearth uses it, and only with {service.name}.
      </p>

      {plex && (
        <div className="space-y-1.5" data-testid="sign-in-plex">
          {s.waiting ? (
            <p className="flex items-center gap-2 text-[0.84rem] text-ink" role="status">
              <Loader2 className="h-4 w-4 animate-spin text-gold" aria-hidden />
              Waiting for Allow on plex.tv.{" "}
              <a
                href={s.waiting.url}
                target="_blank"
                rel="noreferrer"
                className="text-gold underline-offset-2 hover:underline"
              >
                Open it again
              </a>
            </p>
          ) : (
            <button
              type="button"
              onClick={() => press("plex-pin")}
              disabled={start.isPending}
              className={primary}
              data-testid="sign-in-start"
            >
              {start.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Sign in with Plex
            </button>
          )}
          <p className="text-[0.78rem] text-faint">
            If you sign in to {service.name} with Plex: press it, then Allow in the Plex window. You
            do this once; Hearth keeps the session going.
          </p>
        </div>
      )}

      {local &&
        (loginOpen ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              setError(undefined);
              const username = (user ?? s.login?.username ?? "").trim();
              saveLogin.mutate(
                { username, password: pass, ...(s.login ? { existing: s.login.id } : {}) },
                {
                  onSuccess: (r) => {
                    setPass("");
                    setShowLogin(false);
                    done(r);
                    void qc.invalidateQueries({ queryKey: ["vault"] });
                  },
                  onError: (err) => {
                    setError(err instanceof Error ? err.message : String(err));
                    void qc.invalidateQueries({ queryKey: ["sign-in", service.id] });
                  },
                },
              );
            }}
            data-testid="sign-in-login"
          >
            <p className="text-[0.82rem] text-ink">
              {s.login
                ? `Give ${service.name}'s login again. It replaces the one in the Secure Vault.`
                : `${plex ? "Or, with a local account: g" : "G"}ive ${service.name}'s login once. It goes straight into the Secure Vault, and Hearth signs in again by itself when the session runs out.`}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={user ?? s.login?.username ?? ""}
                onChange={(e) => setUser(e.target.value)}
                aria-label={`${service.name} user name or email`}
                placeholder="User name or email"
                autoComplete="off"
                className={field}
              />
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                aria-label={`${service.name} password`}
                placeholder="Password"
                autoComplete="new-password"
                className={field}
              />
            </div>
            <button
              type="submit"
              disabled={!(user ?? s.login?.username ?? "").trim() || !pass || saveLogin.isPending}
              className={primary}
              data-testid="sign-in-save-login"
            >
              {saveLogin.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Save and sign in
            </button>
          </form>
        ) : s.login && !plex ? (
          <span className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => press("login")}
              disabled={start.isPending}
              className={primary}
              data-testid="sign-in-start"
            >
              {start.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setShowLogin(true)}
              className="text-[0.8rem] text-gold underline-offset-2 hover:underline"
            >
              Use a different login
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setShowLogin(true)}
            className="block text-[0.82rem] text-gold underline-offset-2 hover:underline"
            data-testid="sign-in-use-login"
          >
            {plex
              ? `I use a ${service.name} user name and password instead`
              : "Use a different login"}
          </button>
        ))}

      {(error ?? s.problem) && (
        <p className="text-[0.8rem] text-amber" role="alert">
          {error ?? s.problem}
        </p>
      )}
    </div>
  );
}
