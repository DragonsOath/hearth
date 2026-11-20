import { OnboardingStages, type OnboardingStage } from "../../components/onboarding/Stages";
import { useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { UNAUTHORIZED_EVENT } from "../../data/api";
import { useAuthStatus } from "../../data/auth";
import { ErrorState, cx } from "../../components/ui";

/** Quiet, centred frame for setup and sign-in: the wordmark, one panel, nothing else. */
export function AuthFrame({
  eyebrow,
  title,
  children,
  wide = false,
  stage,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
  wide?: boolean;
  /** During first-run setup: which part of it this is (shown above the card). */
  stage?: OnboardingStage;
}) {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-12 sm:px-6"
    >
      <div className={cx("w-full", wide ? "max-w-xl" : "max-w-md")}>
        <div className="mb-10 flex justify-center">
          {/* The owner's logo artwork, exactly as designed (docs/brand). */}
          <img
            src="/brand/hearth-logo.webp"
            alt="Hearth, your digital home"
            width={1880}
            height={650}
            className="h-auto w-64 sm:w-72"
          />
        </div>
        {stage && <OnboardingStages current={stage} className="mb-6" />}
        <div className="rounded-2xl border border-line bg-panel p-6 sm:p-10">
          <p className="eyebrow mb-3">{eyebrow}</p>
          <h1 className="mb-6 font-display text-[2rem] leading-tight text-ink">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}

export function TextField({
  id,
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string }) {
  return (
    <div className="mb-5">
      <label htmlFor={id} className="mb-2 block text-[0.85rem] text-muted">
        {label}
      </label>
      <input
        id={id}
        className="min-h-12 w-full rounded-lg border border-line-strong bg-bg px-4 text-[0.95rem] text-ink placeholder:text-faint focus:border-gold/60 focus:outline-none"
        {...props}
      />
      {hint && <p className="mt-2 text-[0.78rem] leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

export function FormError({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-4 text-[0.85rem] leading-relaxed text-bad">
      {error.message}
    </p>
  );
}

/**
 * Everything inside the app needs an owner who is signed in. An unclaimed
 * installation goes to setup; an expired session goes to sign-in.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, error, refetch } = useAuthStatus();
  const location = useLocation();
  const queryClient = useQueryClient();

  useEffect(() => {
    const onExpired = () => void queryClient.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener(UNAUTHORIZED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onExpired);
  }, [queryClient]);

  if (error) {
    return (
      <main className="mx-auto max-w-xl px-4 py-24">
        <ErrorState message={error.message} onRetry={() => void refetch()} />
      </main>
    );
  }
  if (!data) return <div className="min-h-dvh bg-bg" aria-busy="true" />;
  if (!data.claimed) return <Navigate to={`/setup${location.search}`} replace />;
  if (!data.signedIn) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  // A home tablet has one page (the server refuses the rest anyway).
  if (data.method === "home" && !location.pathname.startsWith("/home-screen"))
    return <Navigate to="/home-screen" replace />;
  return <>{children}</>;
}
